//! Dedicated worker thread pools, isolated from the networking runtime.
//!
//! * `room-sim-N`: room game loops (physics only).
//! * `room-pub-N`: per-room state providers that diff, serialize and send
//!   game state to players, so network work never runs on a game thread.
//!
//! Each worker records how much time it spends on room work so the ops
//! dashboard can show per-thread load.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

pub const THREAD_PREFIX: &str = "room-sim";
pub const PUBLISH_PREFIX: &str = "room-pub";

#[derive(Default)]
pub struct ThreadStats {
    pub name: String,
    busy_ns: AtomicU64,
    ticks: AtomicU64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub name: String,
    pub busy_ns: u64,
    pub ticks: u64,
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<ThreadStats>>> = const { RefCell::new(None) };
}

/// Charge `elapsed` of room work to the current pool thread.
/// Returns the thread's name (or a best-effort name off the pool, e.g. in tests).
pub fn record_tick(elapsed: Duration) -> String {
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some(stats) => {
            stats.busy_ns.fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
            stats.ticks.fetch_add(1, Ordering::Relaxed);
            stats.name.clone()
        }
        None => std::thread::current().name().unwrap_or("unnamed").to_string(),
    })
}

fn cpus() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// Game threads: `BOXHEAD_SIM_THREADS`, defaulting to the CPU count.
pub fn threads_from_env() -> usize {
    parse_threads(std::env::var("BOXHEAD_SIM_THREADS").ok(), cpus())
}

/// State-provider threads: `BOXHEAD_PUBLISH_THREADS`, defaulting to half the CPUs (min 2).
pub fn publish_threads_from_env() -> usize {
    parse_threads(std::env::var("BOXHEAD_PUBLISH_THREADS").ok(), (cpus() / 2).max(2))
}

fn parse_threads(raw: Option<String>, default: usize) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
        .clamp(1, 256)
}

pub struct SimRuntime {
    runtime: Option<tokio::runtime::Runtime>,
    threads: Arc<Mutex<Vec<Arc<ThreadStats>>>>,
    size: usize,
}

impl SimRuntime {
    /// A pool of `size` worker threads named `{prefix}-0..`.
    pub fn new(prefix: &'static str, size: usize) -> std::io::Result<Self> {
        let threads: Arc<Mutex<Vec<Arc<ThreadStats>>>> = Arc::default();
        let next = Arc::new(AtomicU64::new(0));
        let registry = threads.clone();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(size)
            .thread_name_fn(move || format!("{prefix}-{}", next.fetch_add(1, Ordering::Relaxed)))
            .on_thread_start(move || {
                let thread = std::thread::current();
                let name = thread.name().unwrap_or_default();
                // Blocking-pool threads share the name prefix; only track workers once.
                let stats = {
                    let mut all = registry.lock().unwrap();
                    match all.iter().find(|s| s.name == name) {
                        Some(existing) => existing.clone(),
                        None => {
                            let stats = Arc::new(ThreadStats { name: name.to_string(), ..Default::default() });
                            all.push(stats.clone());
                            stats
                        }
                    }
                };
                CURRENT.with(|current| *current.borrow_mut() = Some(stats));
            })
            .enable_all()
            .build()?;
        Ok(Self { runtime: Some(runtime), threads, size })
    }

    pub fn handle(&self) -> tokio::runtime::Handle {
        self.runtime.as_ref().expect("runtime alive").handle().clone()
    }

    pub fn size(&self) -> usize { self.size }

    pub fn snapshot(&self) -> Vec<ThreadSnapshot> {
        let mut out: Vec<_> = self.threads.lock().unwrap().iter().map(|s| ThreadSnapshot {
            name: s.name.clone(),
            busy_ns: s.busy_ns.load(Ordering::Relaxed),
            ticks: s.ticks.load(Ordering::Relaxed),
        }).collect();
        out.sort_by_key(|s| s.name.rsplit('-').next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(u32::MAX));
        out
    }
}

impl Drop for SimRuntime {
    fn drop(&mut self) {
        // Safe to call from inside another runtime (unlike a plain drop).
        if let Some(rt) = self.runtime.take() { rt.shutdown_background(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_count_parsing() {
        assert_eq!(parse_threads(Some("3".into()), 8), 3);
        assert_eq!(parse_threads(Some("1000".into()), 8), 256);
        assert_eq!(parse_threads(Some("0".into()), 8), 8);
        assert_eq!(parse_threads(Some("lots".into()), 8), 8);
        assert_eq!(parse_threads(None, 0), 1);
        assert!(publish_threads_from_env() >= 1);
    }

    #[tokio::test]
    async fn work_is_charged_to_named_sim_threads() {
        let sim = SimRuntime::new(THREAD_PREFIX, 2).unwrap();
        let names = sim.handle().spawn(async {
            record_tick(Duration::from_millis(3))
        }).await.unwrap();
        assert!(names.starts_with(THREAD_PREFIX), "{names}");
        let snap = sim.snapshot();
        let total_ticks: u64 = snap.iter().map(|s| s.ticks).sum();
        let total_busy: u64 = snap.iter().map(|s| s.busy_ns).sum();
        assert_eq!(total_ticks, 1);
        assert_eq!(total_busy, 3_000_000);
    }

    #[tokio::test]
    async fn pools_are_independent() {
        let sim = SimRuntime::new(THREAD_PREFIX, 1).unwrap();
        let publish = SimRuntime::new(PUBLISH_PREFIX, 1).unwrap();
        let on_pub = publish.handle().spawn(async { record_tick(Duration::from_millis(1)) }).await.unwrap();
        assert_eq!(on_pub, "room-pub-0");
        assert_eq!(publish.snapshot()[0].ticks, 1);
        assert!(sim.snapshot().iter().all(|t| t.ticks == 0), "publisher work is not charged to game threads");
    }

    #[test]
    fn work_off_the_pool_is_not_charged() {
        let name = record_tick(Duration::from_millis(1));
        assert!(!name.starts_with(THREAD_PREFIX));
    }
}
