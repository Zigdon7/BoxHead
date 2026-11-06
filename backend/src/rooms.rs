//! Server-hosted rooms. Every room owns its own authoritative `Game`. Clients never host.
//!
//! Each room runs as two decoupled tasks on separate thread pools (see `sim.rs`):
//!
//! * **Game loop** (`room-sim-*`): 60 Hz physics only. It copies the resulting
//!   state into a [`Frame`] and hands it off without ever waiting on players,
//!   the database or the dashboard.
//! * **State provider** (`room-pub-*`): takes the latest frame, computes
//!   deltas/snapshots, serializes them and sends them to players, and records
//!   wave progress. If it falls behind it skips straight to the newest frame
//!   instead of slowing the game down.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Mutex};

use crate::db::Database;
use crate::delta::DeltaTracker;
use crate::game::Game;
use crate::sim;
use crate::types::{Bullet, DropPickup, Placeable, Player, Zombie};

pub type ClientSender = mpsc::Sender<String>;

pub const OPEN_ROOM_ID: &str = "open";
pub const VERIFIED_ROOM_ID: &str = "verified";
/// Default room cap; override with `BOXHEAD_MAX_ROOMS`.
pub const MAX_ROOMS: usize = 256;
/// 60 Hz frame budget for one room tick.
pub const TICK_BUDGET: Duration = Duration::from_micros(16_667);
const MAX_WINDOW: Duration = Duration::from_secs(5);

/// Game state copied out by the game loop for the state provider.
pub struct Frame {
    pub seq: u64,
    pub players: HashMap<String, Player>,
    pub zombies: Vec<Zombie>,
    pub bullets: Vec<Bullet>,
    pub placeables: Vec<Placeable>,
    pub drops: Vec<DropPickup>,
    pub wave: u32,
    pub wave_kills: u32,
    pub wave_target: u32,
    pub wave_break_timer: f64,
    pub ammo_availability: HashMap<String, bool>,
    pub game_over: bool,
    /// The round was already over before this tick (no deltas are sent).
    pub was_finished: bool,
    pub paused: bool,
    pub host_id: Option<String>,
}

/// Cheap, lock-free-to-the-game summary for the room list and ops dashboard.
#[derive(Clone, Debug, Default)]
pub struct RoomStats {
    pub players: usize,
    pub alive: usize,
    pub zombies: usize,
    pub bullets: usize,
    pub wave: u32,
    pub game_over: bool,
    pub paused: bool,
    pub host_id: Option<String>,
}

impl RoomStats {
    fn from_game(game: &Game) -> Self {
        Self {
            players: game.players().len(),
            alive: game.players().values().filter(|p| p.health > 0.0).count(),
            zombies: game.zombies().len(),
            bullets: game.bullets().len(),
            wave: game.wave(),
            game_over: game.is_game_over(),
            paused: game.is_paused(),
            host_id: game.host_id().map(str::to_owned),
        }
    }
}

pub fn max_rooms_from_env() -> usize {
    std::env::var("BOXHEAD_MAX_ROOMS").ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&n| n >= 2)
        .unwrap_or(MAX_ROOMS)
}

/// Rolling tick statistics for one room, read by the ops API.
#[derive(Debug)]
pub struct TickMetrics {
    pub ticks: u64,
    pub total_ns: u64,
    pub ewma_ns: f64,
    window_max_ns: u64,
    prev_window_max_ns: u64,
    window_started: Instant,
    pub overruns: u64,
    pub dropped_deltas: u64,
    pub last_thread: String,
}

impl Default for TickMetrics {
    fn default() -> Self {
        Self {
            ticks: 0, total_ns: 0, ewma_ns: 0.0, window_max_ns: 0, prev_window_max_ns: 0,
            window_started: Instant::now(), overruns: 0, dropped_deltas: 0, last_thread: String::new(),
        }
    }
}

impl TickMetrics {
    pub fn record(&mut self, elapsed: Duration, dropped: u64, thread: String, now: Instant) {
        let ns = elapsed.as_nanos() as u64;
        self.ewma_ns = if self.ticks == 0 { ns as f64 } else { self.ewma_ns * 0.95 + ns as f64 * 0.05 };
        self.ticks += 1;
        self.total_ns += ns;
        if elapsed > TICK_BUDGET { self.overruns += 1; }
        self.dropped_deltas += dropped;
        self.last_thread = thread;
        if now.saturating_duration_since(self.window_started) >= MAX_WINDOW {
            self.prev_window_max_ns = self.window_max_ns;
            self.window_max_ns = 0;
            self.window_started = now;
        }
        self.window_max_ns = self.window_max_ns.max(ns);
    }

    /// Worst tick over roughly the last 5-10 seconds.
    pub fn recent_max_ns(&self) -> u64 { self.window_max_ns.max(self.prev_window_max_ns) }
}
/// Player-created rooms are shut down after being empty this long (default).
pub const EMPTY_ROOM_TTL: Duration = Duration::from_secs(90);

/// TTL for empty rooms, overridable with `BOXHEAD_EMPTY_ROOM_TTL_SECS`.
pub fn empty_room_ttl_from_env() -> Duration {
    parse_ttl(std::env::var("BOXHEAD_EMPTY_ROOM_TTL_SECS").ok())
}

fn parse_ttl(raw: Option<String>) -> Duration {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(EMPTY_ROOM_TTL)
}

/// Verified accounts may enter any room; everyone else only open rooms.
pub fn can_join(room_verified_only: bool, player_verified: bool) -> bool {
    player_verified || !room_verified_only
}

pub fn sanitize_room_name(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect::<String>()
        .trim().chars().take(24).collect()
}

pub struct Room {
    pub id: String,
    pub name: String,
    pub verified_only: bool,
    /// Permanent rooms always exist; player-created rooms expire when empty.
    pub permanent: bool,
    pub game: Mutex<Game>,
    pub delta_tracker: Mutex<DeltaTracker>,
    pub clients: Mutex<HashMap<String, ClientSender>>,
    pub pending_snapshots: Mutex<HashSet<String>>,
    pub wave_profiles: Mutex<HashMap<String, (String, u32)>>,
    last_room_status: Mutex<String>,
    empty_since: Mutex<Option<Instant>>,
    /// Game-loop (physics) timing.
    pub metrics: std::sync::Mutex<TickMetrics>,
    /// State-provider (diff + serialize + send) timing.
    pub publish_metrics: std::sync::Mutex<TickMetrics>,
    pub stats: std::sync::Mutex<RoomStats>,
    frames: watch::Sender<Option<Arc<Frame>>>,
    next_seq: AtomicU64,
    last_published_seq: AtomicU64,
    skipped_frames: AtomicU64,
    slow_client_retries: AtomicU64,
    created_at: Instant,
}

impl Room {
    fn new(id: String, name: String, verified_only: bool, permanent: bool) -> Self {
        let game = Game::new();
        let stats = RoomStats::from_game(&game);
        Self {
            id, name, verified_only, permanent,
            game: Mutex::new(game),
            delta_tracker: Mutex::new(DeltaTracker::new()),
            clients: Mutex::new(HashMap::new()),
            pending_snapshots: Mutex::new(HashSet::new()),
            wave_profiles: Mutex::new(HashMap::new()),
            last_room_status: Mutex::new(String::new()),
            empty_since: Mutex::new(Some(Instant::now())),
            metrics: std::sync::Mutex::new(TickMetrics::default()),
            publish_metrics: std::sync::Mutex::new(TickMetrics::default()),
            stats: std::sync::Mutex::new(stats),
            frames: watch::channel(None).0,
            next_seq: AtomicU64::new(0),
            last_published_seq: AtomicU64::new(0),
            skipped_frames: AtomicU64::new(0),
            slow_client_retries: AtomicU64::new(0),
            created_at: Instant::now(),
        }
    }

    pub fn stats(&self) -> RoomStats { self.stats.lock().unwrap().clone() }

    /// Full operational view of the room for the ops dashboard.
    /// Never touches the game lock: reads stats cached by the game loop.
    pub async fn ops_snapshot(&self) -> serde_json::Value {
        let RoomStats { players, alive, zombies, bullets, wave, game_over, paused, host_id } = self.stats();
        let connected = self.clients.lock().await.len();
        let m = self.metrics.lock().unwrap();
        let p = self.publish_metrics.lock().unwrap();
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "verifiedOnly": self.verified_only,
            "permanent": self.permanent,
            "connected": connected,
            "players": players,
            "alive": alive,
            "zombies": zombies,
            "bullets": bullets,
            "wave": wave,
            "gameOver": game_over,
            "paused": paused,
            "hostId": host_id,
            "uptimeMs": self.created_at.elapsed().as_millis() as u64,
            "tick": {
                "count": m.ticks,
                "avgUs": (m.ewma_ns / 1000.0).round() as u64,
                "maxUs": m.recent_max_ns() / 1000,
                "budgetUs": TICK_BUDGET.as_micros() as u64,
                "overruns": m.overruns,
                "droppedDeltas": p.dropped_deltas,
                "lastThread": m.last_thread,
            },
            "publish": {
                "count": p.ticks,
                "avgUs": (p.ewma_ns / 1000.0).round() as u64,
                "maxUs": p.recent_max_ns() / 1000,
                "droppedDeltas": p.dropped_deltas,
                "skippedFrames": self.skipped_frames.load(Ordering::Relaxed),
                "slowClientRetries": self.slow_client_retries.load(Ordering::Relaxed),
                "lastThread": p.last_thread,
            },
        })
    }

    pub async fn summary(&self, player_verified: bool) -> serde_json::Value {
        let RoomStats { wave, game_over, paused, .. } = self.stats();
        let players = self.clients.lock().await.len();
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "verifiedOnly": self.verified_only,
            "permanent": self.permanent,
            "players": players,
            "wave": wave,
            "gameOver": game_over,
            "paused": paused,
            "canJoin": can_join(self.verified_only, player_verified),
        })
    }

    /// Restart this room's round and resync every connected client.
    pub async fn restart(&self, requested: u32, unlocked: u32) {
        {
            let mut game = self.game.lock().await;
            game.reset_at_wave(requested, unlocked);
            *self.stats.lock().unwrap() = RoomStats::from_game(&game);
        }
        *self.delta_tracker.lock().await = DeltaTracker::new();
        let clients = self.clients.lock().await;
        self.pending_snapshots.lock().await.extend(clients.keys().cloned());
    }

    /// Run one game tick and publish it inline. The live server runs these two
    /// halves on separate pools (see `spawn_room_loops`); this keeps tests simple.
    pub async fn tick(&self, db: &Database) {
        if let Some(frame) = self.sim_tick().await {
            self.publish_frame(&frame, db).await;
        }
    }

    /// Game-thread half: physics plus copying state out. Never awaits players,
    /// the database or the network. Returns `None` for idle (empty) rooms.
    pub async fn sim_tick(&self) -> Option<Arc<Frame>> {
        if self.clients.lock().await.is_empty() {
            return None;
        }
        let started = Instant::now();
        let mut game = self.game.lock().await;
        let was_finished = game.is_game_over();
        let paused = game.is_paused();
        if !was_finished && !paused {
            game.update(1.0 / 60.0);
        }
        let frame = Frame {
            seq: self.next_seq.fetch_add(1, Ordering::Relaxed) + 1,
            players: game.players().clone(),
            zombies: game.zombies().to_vec(),
            bullets: game.bullets().to_vec(),
            placeables: game.placeables().to_vec(),
            drops: game.drops(),
            wave: game.wave(),
            wave_kills: game.wave_kills(),
            wave_target: game.wave_target(),
            wave_break_timer: game.wave_break_timer(),
            ammo_availability: game.ammo_availability().iter().map(|a| (a.id.clone(), a.available)).collect(),
            game_over: game.is_game_over(),
            was_finished,
            paused,
            host_id: game.host_id().map(str::to_owned),
        };
        let stats = RoomStats::from_game(&game);
        drop(game);
        *self.stats.lock().unwrap() = stats;

        let elapsed = started.elapsed();
        let thread = sim::record_tick(elapsed);
        self.metrics.lock().unwrap().record(elapsed, 0, thread, Instant::now());
        Some(Arc::new(frame))
    }

    /// State-provider half: diff, serialize and send one frame, and persist
    /// wave progress. Runs off the game threads.
    pub async fn publish_frame(&self, frame: &Frame, db: &Database) {
        let started = Instant::now();
        let previous = self.last_published_seq.swap(frame.seq, Ordering::Relaxed);
        if previous != 0 && frame.seq > previous + 1 {
            self.skipped_frames.fetch_add(frame.seq - previous - 1, Ordering::Relaxed);
        }
        let dropped = self.publish(frame, db).await;
        let elapsed = started.elapsed();
        let thread = sim::record_tick(elapsed);
        self.publish_metrics.lock().unwrap().record(elapsed, dropped, thread, Instant::now());
    }

    /// Returns the number of deltas dropped for clients that were behind.
    async fn publish(&self, frame: &Frame, db: &Database) -> u64 {
        let room_status = serde_json::json!({
            "type": "room", "hostId": frame.host_id, "paused": frame.paused,
            "roomId": self.id, "roomName": self.name, "verifiedOnly": self.verified_only,
        }).to_string();

        // Persist only when a connected browser reaches a new wave, not every tick.
        {
            let mut profiles = self.wave_profiles.lock().await;
            for (profile, recorded_wave) in profiles.values_mut() {
                if frame.wave > *recorded_wave {
                    db.record_wave(profile, frame.wave);
                    *recorded_wave = frame.wave;
                }
            }
        }

        let room_changed = {
            let mut previous = self.last_room_status.lock().await;
            let changed = *previous != room_status;
            *previous = room_status.clone();
            changed
        };
        if room_changed {
            self.pending_snapshots.lock().await.extend(frame.players.keys().cloned());
        }

        // --- Delta computation ---
        let mut dt = self.delta_tracker.lock().await;
        let delta = dt.compute_delta(
            &frame.players, &frame.zombies, &frame.bullets, &frame.placeables, &frame.drops,
            frame.wave, frame.wave_kills, frame.wave_target, frame.wave_break_timer,
            &frame.ammo_availability, frame.game_over,
        );
        // The delta that ends the round is the last one clients get, so it can't be
        // lost like an ordinary delta. It is computed against the last *published*
        // frame, so it still carries `gameOver` even if the frame where the round
        // ended was skipped by the latest-wins hand-off.
        let ends_round = delta.game_over == Some(true);
        let delta_str = serde_json::to_string(&delta).unwrap();

        let snapshot_ids: Vec<String> = {
            let mut pending = self.pending_snapshots.lock().await;
            pending.drain().collect()
        };
        let snapshot_str = if !snapshot_ids.is_empty() {
            let snapshot = dt.build_snapshot(
                &frame.players, &frame.zombies, &frame.bullets, &frame.placeables, &frame.drops,
                frame.wave, frame.wave_kills, frame.wave_target, frame.wave_break_timer,
                &frame.ammo_availability, frame.game_over,
            );
            Some(serde_json::to_string(&snapshot).unwrap())
        } else {
            None
        };
        drop(dt);

        // --- Adaptive broadcast: deltas are droppable; status + snapshots must arrive ---
        let mut dropped = 0;
        let mut retry = Vec::new();
        let clients = self.clients.lock().await;
        for (id, tx) in clients.iter() {
            let needs_snapshot = snapshot_ids.contains(id);
            if room_changed || needs_snapshot {
                // Host/pause changes and snapshots must not be lost like disposable
                // deltas, but we never wait on a player: if their queue is full the
                // resync is retried next frame, so one stalled connection can't
                // hold up the room or anyone else in it.
                let mut must_send = vec![room_status.clone()];
                if needs_snapshot { must_send.extend(snapshot_str.clone()); }
                for msg in must_send {
                    if tx.try_send(msg).is_err() {
                        retry.push(id.clone());
                        break;
                    }
                }
            } else if (!frame.was_finished || ends_round) && !frame.paused && tx.try_send(delta_str.clone()).is_err() {
                // A full queue drops ordinary deltas; the round-ending one falls back
                // to a snapshot (which carries gameOver), retried until it fits.
                if ends_round { retry.push(id.clone()); } else { dropped += 1; }
            }
        }
        drop(clients);
        if !retry.is_empty() {
            self.slow_client_retries.fetch_add(retry.len() as u64, Ordering::Relaxed);
            self.pending_snapshots.lock().await.extend(retry);
        }
        dropped
    }
}

pub struct RegistryConfig {
    pub empty_ttl: Duration,
    pub max_rooms: usize,
    /// Runtime the room game loops are spawned on (the sim thread pool).
    pub sim: tokio::runtime::Handle,
    /// Runtime the per-room state providers run on (the publish thread pool).
    pub publish: tokio::runtime::Handle,
}

pub struct RoomRegistry {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    db: Arc<Database>,
    empty_ttl: Duration,
    max_rooms: usize,
    sim: tokio::runtime::Handle,
    publish: tokio::runtime::Handle,
}

impl RoomRegistry {
    pub fn new(db: Arc<Database>, config: RegistryConfig) -> Arc<Self> {
        Arc::new(Self {
            rooms: Mutex::new(HashMap::new()), db,
            empty_ttl: config.empty_ttl, max_rooms: config.max_rooms, sim: config.sim, publish: config.publish,
        })
    }

    pub fn max_rooms(&self) -> usize { self.max_rooms }
    pub fn empty_ttl(&self) -> Duration { self.empty_ttl }

    /// Create the always-on rooms and the background reaper. Call once at startup.
    pub async fn start(self: &Arc<Self>) {
        self.insert(Room::new(OPEN_ROOM_ID.into(), "Open Arena".into(), false, true)).await;
        self.insert(Room::new(VERIFIED_ROOM_ID.into(), "Verified Arena".into(), true, true)).await;

        let registry = Arc::downgrade(self);
        tokio::spawn(async move {
            let period = Duration::from_secs(10).min(registry.upgrade().map(|r| r.empty_ttl).unwrap_or_default())
                .max(Duration::from_millis(250));
            let mut interval = tokio::time::interval(period);
            loop {
                interval.tick().await;
                let Some(registry) = registry.upgrade() else { break };
                registry.reap_empty_rooms(Instant::now()).await;
            }
        });
    }

    async fn insert(&self, room: Room) -> Arc<Room> {
        let room = Arc::new(room);
        self.rooms.lock().await.insert(room.id.clone(), room.clone());
        spawn_room_loops(&self.sim, &self.publish, &room, self.db.clone());
        room
    }

    pub async fn create(&self, name: &str, verified_only: bool) -> Result<Arc<Room>, String> {
        let name = sanitize_room_name(name);
        if name.is_empty() {
            return Err("Room name required".into());
        }
        if self.rooms.lock().await.len() >= self.max_rooms {
            return Err("Server room limit reached — try again later".into());
        }
        let id = uuid::Uuid::new_v4().to_string()[..8].to_string();
        Ok(self.insert(Room::new(id, name, verified_only, false)).await)
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Room>> {
        self.rooms.lock().await.get(id).cloned()
    }

    pub async fn all(&self) -> Vec<Arc<Room>> {
        let mut rooms: Vec<_> = self.rooms.lock().await.values().cloned().collect();
        rooms.sort_by(|a, b| b.permanent.cmp(&a.permanent)
            .then(a.verified_only.cmp(&b.verified_only))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        rooms
    }

    /// Remove player-created rooms that have been empty for `empty_ttl` as of `now`.
    pub async fn reap_empty_rooms(&self, now: Instant) {
        let mut rooms = self.rooms.lock().await;
        let mut expired = Vec::new();
        for room in rooms.values() {
            if room.permanent { continue; }
            let empty = room.clients.lock().await.is_empty();
            let mut since = room.empty_since.lock().await;
            match (empty, *since) {
                (false, _) => *since = None,
                (true, None) => *since = Some(now),
                (true, Some(t)) if now.saturating_duration_since(t) >= self.empty_ttl => expired.push(room.id.clone()),
                _ => {}
            }
        }
        // Dropping the last Arc ends the room's simulation task.
        for id in expired { rooms.remove(&id); }
    }
}

/// Start a room's game loop (sim pool) and state provider (publish pool).
/// Both stop on their own once the room is removed.
fn spawn_room_loops(sim: &tokio::runtime::Handle, publish: &tokio::runtime::Handle, room: &Arc<Room>, db: Arc<Database>) {
    let weak: Weak<Room> = Arc::downgrade(room);
    sim.spawn({
        let weak = weak.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_millis(16));
            loop {
                interval.tick().await;
                let Some(room) = weak.upgrade() else { break };
                if let Some(frame) = room.sim_tick().await {
                    // Latest-wins hand-off: never waits for the state provider.
                    room.frames.send_replace(Some(frame));
                }
            }
        }
    });

    let mut frames = room.frames.subscribe();
    publish.spawn(async move {
        // Ends when the room (and so the frame sender) is dropped.
        while frames.changed().await.is_ok() {
            let Some(frame) = frames.borrow_and_update().clone() else { continue };
            let Some(room) = weak.upgrade() else { break };
            room.publish_frame(&frame, &db).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(ttl: Duration) -> Arc<RoomRegistry> {
        registry_with(ttl, MAX_ROOMS, tokio::runtime::Handle::current())
    }

    fn registry_with(empty_ttl: Duration, max_rooms: usize, sim: tokio::runtime::Handle) -> Arc<RoomRegistry> {
        let publish = tokio::runtime::Handle::current();
        RoomRegistry::new(Arc::new(Database::open(":memory:").unwrap()), RegistryConfig { empty_ttl, max_rooms, sim, publish })
    }

    fn pools(sim_threads: usize, publish_threads: usize) -> (crate::sim::SimRuntime, crate::sim::SimRuntime, Arc<RoomRegistry>) {
        let sim = crate::sim::SimRuntime::new(crate::sim::THREAD_PREFIX, sim_threads).unwrap();
        let publish = crate::sim::SimRuntime::new(crate::sim::PUBLISH_PREFIX, publish_threads).unwrap();
        let registry = RoomRegistry::new(Arc::new(Database::open(":memory:").unwrap()), RegistryConfig {
            empty_ttl: EMPTY_ROOM_TTL, max_rooms: MAX_ROOMS, sim: sim.handle(), publish: publish.handle(),
        });
        (sim, publish, registry)
    }

    /// Simulate a connected client: register a channel and a player in the room.
    async fn connect(room: &Room, id: &str) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(64);
        room.game.lock().await.add_player(id, id);
        room.clients.lock().await.insert(id.to_string(), tx);
        room.pending_snapshots.lock().await.insert(id.to_string());
        rx
    }

    async fn disconnect(room: &Room, id: &str) {
        room.game.lock().await.remove_player(id);
        room.clients.lock().await.remove(id);
    }

    fn drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv() { out.push(serde_json::from_str(&msg).unwrap()); }
        out
    }

    // ---- Join rules ----

    #[test]
    fn verified_players_can_join_everything_unverified_only_open_rooms() {
        assert!(can_join(false, true));
        assert!(can_join(true, true));
        assert!(can_join(false, false));
        assert!(!can_join(true, false));
    }

    // ---- Room names ----

    #[test]
    fn room_names_are_trimmed_and_bounded() {
        assert_eq!(sanitize_room_name("  Night\nShift  "), "NightShift");
        assert_eq!(sanitize_room_name(&"x".repeat(40)).len(), 24);
        assert_eq!(sanitize_room_name("   "), "");
        assert_eq!(sanitize_room_name("\u{0007}\t\r\n"), "");
    }

    #[test]
    fn room_names_count_characters_not_bytes() {
        let name = sanitize_room_name(&"🧟".repeat(30));
        assert_eq!(name.chars().count(), 24);
        assert_eq!(sanitize_room_name("<b>Ünïcode</b>"), "<b>Ünïcode</b>", "names are stored raw; the UI renders them as text");
    }

    #[test]
    fn ttl_override_parses_seconds_and_falls_back_to_default() {
        assert_eq!(parse_ttl(None), EMPTY_ROOM_TTL);
        assert_eq!(parse_ttl(Some("5".into())), Duration::from_secs(5));
        assert_eq!(parse_ttl(Some("soon".into())), EMPTY_ROOM_TTL);
        assert_eq!(parse_ttl(Some("-1".into())), EMPTY_ROOM_TTL);
    }

    // ---- Registry ----

    #[tokio::test]
    async fn registry_starts_with_open_and_verified_rooms() {
        let registry = registry(EMPTY_ROOM_TTL);
        registry.start().await;
        let open = registry.get(OPEN_ROOM_ID).await.unwrap();
        let verified = registry.get(VERIFIED_ROOM_ID).await.unwrap();
        assert!(!open.verified_only && open.permanent);
        assert!(verified.verified_only && verified.permanent);
        assert_eq!(registry.all().await.len(), 2);
    }

    #[tokio::test]
    async fn create_validates_names_and_assigns_unique_ids() {
        let registry = registry(EMPTY_ROOM_TTL);
        let a = registry.create("  Squad  ", true).await.unwrap();
        let b = registry.create("Squad", false).await.unwrap();
        assert_eq!(a.name, "Squad");
        assert!(a.verified_only && !b.verified_only);
        assert!(!a.permanent);
        assert_ne!(a.id, b.id, "duplicate names are allowed but ids are unique");
        assert!(registry.create(" ", false).await.is_err());
        assert!(registry.create("", false).await.is_err());
        assert!(registry.get("does-not-exist").await.is_none());
    }

    #[tokio::test]
    async fn create_enforces_room_limit() {
        let registry = registry_with(EMPTY_ROOM_TTL, 6, tokio::runtime::Handle::current());
        registry.start().await;
        for i in 0..4 {
            registry.create(&format!("Room {i}"), false).await.unwrap();
        }
        assert_eq!(registry.all().await.len(), 6);
        let err = registry.create("One too many", false).await.err().unwrap();
        assert!(err.contains("limit"), "{err}");
    }

    #[tokio::test]
    async fn listing_puts_official_rooms_first_then_open_then_alphabetical() {
        let registry = registry(EMPTY_ROOM_TTL);
        registry.start().await;
        registry.create("zulu", true).await.unwrap();
        registry.create("Alpha", false).await.unwrap();
        registry.create("bravo", false).await.unwrap();
        let names: Vec<_> = registry.all().await.iter().map(|r| r.name.clone()).collect();
        assert_eq!(names, ["Open Arena", "Verified Arena", "Alpha", "bravo", "zulu"]);
    }

    // ---- Summaries ----

    #[tokio::test]
    async fn summary_reports_join_permission_per_caller() {
        let registry = registry(EMPTY_ROOM_TTL);
        let locked = registry.create("Vets", true).await.unwrap();
        let open = registry.create("Randos", false).await.unwrap();
        assert_eq!(locked.summary(false).await["canJoin"], false);
        assert_eq!(locked.summary(true).await["canJoin"], true);
        assert_eq!(open.summary(false).await["canJoin"], true);
        let s = open.summary(false).await;
        assert_eq!(s["name"], "Randos");
        assert_eq!(s["verifiedOnly"], false);
        assert_eq!(s["players"], 0);
        assert_eq!(s["wave"], 1);
        assert_eq!(s["gameOver"], false);
        assert_eq!(s["paused"], false);
    }

    #[tokio::test]
    async fn summary_counts_connected_players() {
        let registry = registry(EMPTY_ROOM_TTL);
        let room = registry.create("Busy", false).await.unwrap();
        let _a = connect(&room, "a").await;
        let _b = connect(&room, "b").await;
        assert_eq!(room.summary(false).await["players"], 2);
        disconnect(&room, "a").await;
        assert_eq!(room.summary(false).await["players"], 1);
    }

    // ---- Reaping ----

    #[tokio::test]
    async fn empty_player_rooms_expire_after_ttl_but_not_before() {
        let ttl = Duration::from_secs(90);
        let registry = registry(ttl);
        let room = registry.create("Temp", false).await.unwrap();
        let id = room.id.clone();
        drop(room);
        let t0 = Instant::now();
        registry.reap_empty_rooms(t0 + ttl - Duration::from_secs(1)).await;
        assert!(registry.get(&id).await.is_some(), "kept before ttl");
        registry.reap_empty_rooms(t0 + ttl + Duration::from_secs(1)).await;
        assert!(registry.get(&id).await.is_none(), "removed after ttl");
    }

    #[tokio::test]
    async fn permanent_rooms_are_never_reaped() {
        let registry = registry(Duration::from_secs(1));
        registry.start().await;
        registry.reap_empty_rooms(Instant::now() + Duration::from_secs(3600)).await;
        assert!(registry.get(OPEN_ROOM_ID).await.is_some());
        assert!(registry.get(VERIFIED_ROOM_ID).await.is_some());
    }

    #[tokio::test]
    async fn occupied_rooms_survive_and_their_empty_timer_restarts_on_leave() {
        let ttl = Duration::from_secs(90);
        let registry = registry(ttl);
        let room = registry.create("Party", false).await.unwrap();
        let _rx = connect(&room, "p1").await;
        let t0 = Instant::now();
        registry.reap_empty_rooms(t0 + ttl * 10).await;
        assert!(registry.get(&room.id).await.is_some(), "occupied room kept");

        // Leaves at t1: the room is first seen empty then, so it lasts until t1 + ttl.
        disconnect(&room, "p1").await;
        let t1 = t0 + ttl * 10;
        registry.reap_empty_rooms(t1).await;
        registry.reap_empty_rooms(t1 + ttl - Duration::from_secs(1)).await;
        assert!(registry.get(&room.id).await.is_some(), "fresh timer after leaving");
        registry.reap_empty_rooms(t1 + ttl).await;
        assert!(registry.get(&room.id).await.is_none());
    }

    #[tokio::test]
    async fn removing_a_room_stops_its_simulation_task() {
        let registry = registry(Duration::from_secs(1));
        let room = registry.create("Doomed", false).await.unwrap();
        let weak = Arc::downgrade(&room);
        drop(room);
        registry.reap_empty_rooms(Instant::now() + Duration::from_secs(5)).await;
        // The tick task only holds a Weak, so nothing keeps the room alive.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(weak.upgrade().is_none());
    }

    // ---- Server-side simulation ----

    #[tokio::test]
    async fn tick_sends_room_status_and_snapshot_to_new_clients_then_deltas() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r1".into(), "Alpha".into(), true, false);
        let mut rx = connect(&room, "p1").await;

        room.tick(&db).await;
        let first = drain(&mut rx);
        assert_eq!(first[0]["type"], "room");
        assert_eq!(first[0]["roomId"], "r1");
        assert_eq!(first[0]["roomName"], "Alpha");
        assert_eq!(first[0]["verifiedOnly"], true);
        assert_eq!(first[0]["hostId"], "p1");
        assert_eq!(first[1]["type"], "snapshot");
        assert!(first[1]["players"]["p1"].is_object());

        room.tick(&db).await;
        let second = drain(&mut rx);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["type"], "delta");
    }

    #[tokio::test]
    async fn tick_is_a_no_op_for_empty_rooms() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r1".into(), "Idle".into(), false, false);
        room.tick(&db).await;
        assert!(room.last_room_status.lock().await.is_empty(), "nothing simulated or broadcast");
    }

    #[tokio::test]
    async fn rooms_are_isolated_from_each_other() {
        let db = Database::open(":memory:").unwrap();
        let a = Room::new("a".into(), "A".into(), false, false);
        let b = Room::new("b".into(), "B".into(), false, false);
        let mut rx_a = connect(&a, "alice").await;
        let mut rx_b = connect(&b, "bob").await;
        a.tick(&db).await;
        b.tick(&db).await;
        let snap_a = drain(&mut rx_a).into_iter().find(|m| m["type"] == "snapshot").unwrap();
        let snap_b = drain(&mut rx_b).into_iter().find(|m| m["type"] == "snapshot").unwrap();
        assert!(snap_a["players"]["alice"].is_object() && snap_a["players"]["bob"].is_null());
        assert!(snap_b["players"]["bob"].is_object() && snap_b["players"]["alice"].is_null());

        // Pausing one room leaves the other running.
        assert!(a.game.lock().await.set_paused("alice", true));
        assert!(a.game.lock().await.is_paused());
        assert!(!b.game.lock().await.is_paused());
    }

    #[tokio::test]
    async fn pause_change_is_broadcast_to_the_room() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "R".into(), false, false);
        let mut rx = connect(&room, "host").await;
        room.tick(&db).await;
        drain(&mut rx);
        room.game.lock().await.set_paused("host", true);
        room.tick(&db).await;
        let msgs = drain(&mut rx);
        assert_eq!(msgs[0]["type"], "room");
        assert_eq!(msgs[0]["paused"], true);
        // While paused, no droppable deltas are sent after the resync.
        room.tick(&db).await;
        assert!(drain(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn restart_resyncs_every_connected_client() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "R".into(), false, false);
        let mut rx1 = connect(&room, "p1").await;
        let mut rx2 = connect(&room, "p2").await;
        room.tick(&db).await;
        drain(&mut rx1);
        drain(&mut rx2);
        room.restart(1, 1).await;
        room.tick(&db).await;
        for rx in [&mut rx1, &mut rx2] {
            assert!(drain(rx).iter().any(|m| m["type"] == "snapshot"));
        }
    }

    #[tokio::test]
    async fn round_end_reaches_clients_even_when_its_frame_is_skipped() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "R".into(), false, false);
        let mut rx = connect(&room, "p1").await;
        room.tick(&db).await;
        drain(&mut rx);

        room.game.lock().await.kill_all_players();
        let ending = room.sim_tick().await.unwrap();
        assert!(ending.game_over && !ending.was_finished, "this frame ends the round");
        // Under load the latest-wins hand-off skips that frame: the state provider
        // only ever sees the next one, simulated after the round was already over.
        let after = room.sim_tick().await.unwrap();
        assert!(after.was_finished);
        room.publish_frame(&after, &db).await;
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|m| m["gameOver"] == true), "client never learned the round ended: {msgs:?}");

        // Once the client knows, the finished round stays quiet.
        room.tick(&db).await;
        assert!(drain(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn round_end_is_resent_when_the_client_queue_was_full() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "R".into(), false, false);
        let mut rx = connect(&room, "p1").await;
        room.tick(&db).await;
        drain(&mut rx);

        // A momentarily backed-up connection: the round-ending delta can't be queued.
        let tx = room.clients.lock().await["p1"].clone();
        while tx.try_send("backlog".into()).is_ok() {}
        room.game.lock().await.kill_all_players();
        room.tick(&db).await;

        // The client works through its backlog; the round is over, so no deltas follow.
        while rx.try_recv().is_ok() {}
        room.tick(&db).await;
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|m| m["type"] == "snapshot" && m["gameOver"] == true),
            "client must be resynced into the game-over state: {msgs:?}");
    }

    #[tokio::test]
    async fn reaching_a_new_wave_is_persisted_for_connected_profiles() {
        let db = Database::open(":memory:").unwrap();
        let profile = uuid::Uuid::new_v4().to_string();
        let room = Room::new("r".into(), "R".into(), false, false);
        let _rx = connect(&room, "p1").await;
        room.wave_profiles.lock().await.insert("p1".into(), (profile.clone(), 1));
        room.game.lock().await.reset_at_wave(3, 3);
        room.tick(&db).await;
        assert_eq!(db.highest_wave(&profile), 3);
        assert_eq!(room.wave_profiles.lock().await["p1"].1, 3);
    }

    // ---- Metrics & parallel simulation ----

    #[test]
    fn tick_metrics_track_average_max_and_overruns() {
        let mut m = TickMetrics::default();
        let t0 = Instant::now();
        m.record(Duration::from_millis(2), 0, "room-sim-0".into(), t0);
        m.record(Duration::from_millis(20), 3, "room-sim-1".into(), t0);
        assert_eq!(m.ticks, 2);
        assert_eq!(m.overruns, 1, "only the 20ms tick is over the 16.7ms budget");
        assert_eq!(m.dropped_deltas, 3);
        assert_eq!(m.last_thread, "room-sim-1");
        assert_eq!(m.recent_max_ns(), 20_000_000);
        assert!(m.ewma_ns > 2_000_000.0 && m.ewma_ns < 20_000_000.0);
        // Two windows later the old spike has aged out.
        m.record(Duration::from_millis(1), 0, "room-sim-0".into(), t0 + MAX_WINDOW);
        m.record(Duration::from_millis(1), 0, "room-sim-0".into(), t0 + MAX_WINDOW * 2);
        assert_eq!(m.recent_max_ns(), 1_000_000);
    }

    #[tokio::test]
    async fn idle_rooms_record_no_ticks() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "Idle".into(), false, false);
        room.tick(&db).await;
        assert_eq!(room.metrics.lock().unwrap().ticks, 0);
    }

    #[tokio::test]
    async fn ops_snapshot_reports_room_and_tick_health() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "Ops".into(), true, false);
        let _rx = connect(&room, "p1").await;
        room.tick(&db).await;
        room.tick(&db).await;
        let s = room.ops_snapshot().await;
        assert_eq!(s["name"], "Ops");
        assert_eq!(s["verifiedOnly"], true);
        assert_eq!(s["connected"], 1);
        assert_eq!(s["players"], 1);
        assert_eq!(s["hostId"], "p1");
        assert_eq!(s["tick"]["count"], 2);
        assert_eq!(s["tick"]["budgetUs"], 16_667);
        assert!(s["tick"]["lastThread"].as_str().is_some());
    }

    #[tokio::test]
    async fn room_loops_run_on_the_sim_pool_in_parallel() {
        let (sim, publish, registry) = pools(4, 2);
        let mut rooms = Vec::new();
        let mut receivers = Vec::new();
        for i in 0..12 {
            let room = registry.create(&format!("Load {i}"), false).await.unwrap();
            receivers.push(connect(&room, &format!("p{i}")).await);
            rooms.push(room);
        }
        tokio::time::sleep(Duration::from_millis(600)).await;

        for room in &rooms {
            let m = room.metrics.lock().unwrap();
            assert!(m.ticks >= 10, "{} only ticked {} times", room.name, m.ticks);
            assert!(m.last_thread.starts_with(crate::sim::THREAD_PREFIX), "ran on {}", m.last_thread);
        }
        let busy_threads = sim.snapshot().iter().filter(|t| t.ticks > 0).count();
        assert!(busy_threads >= 2, "expected work spread over several sim threads, got {busy_threads}");
        for room in &rooms {
            let p = room.publish_metrics.lock().unwrap();
            assert!(p.ticks >= 10, "{} published {} frames", room.name, p.ticks);
            assert!(p.last_thread.starts_with(crate::sim::PUBLISH_PREFIX), "published on {}", p.last_thread);
        }
        assert!(publish.snapshot().iter().any(|t| t.ticks > 0));
        drop(receivers);
    }

    #[tokio::test]
    async fn a_stalled_player_never_slows_the_game_loop_or_other_players() {
        let (_sim, _publish, registry) = pools(2, 2);
        let room = registry.create("Laggy", false).await.unwrap();
        // A player whose connection never drains: a 1-slot channel nobody reads.
        let (stuck_tx, _stuck_rx) = mpsc::channel(1);
        room.game.lock().await.add_player("stuck", "stuck");
        room.clients.lock().await.insert("stuck".into(), stuck_tx);
        room.pending_snapshots.lock().await.insert("stuck".into());
        let mut healthy = connect(&room, "healthy").await;

        let mut received = 0;
        let deadline = Instant::now() + Duration::from_millis(800);
        while Instant::now() < deadline {
            while healthy.try_recv().is_ok() { received += 1; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let sim_ticks = room.metrics.lock().unwrap().ticks;
        assert!(sim_ticks >= 35, "game loop must keep ~60 Hz regardless of players, got {sim_ticks}");
        assert!(room.metrics.lock().unwrap().overruns == 0, "game ticks never wait on the network");
        assert!(received >= 20, "healthy player kept receiving updates, got {received}");
        assert!(room.slow_client_retries.load(Ordering::Relaxed) >= 1, "stalled player was retried, not waited on");
    }

    #[tokio::test]
    async fn a_slow_state_provider_skips_frames_instead_of_delaying_the_game() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "R".into(), false, false);
        let mut rx = connect(&room, "p1").await;
        // Five game ticks happen before the provider gets a turn.
        let mut latest = None;
        for _ in 0..5 { latest = room.sim_tick().await; }
        room.publish_frame(latest.as_ref().unwrap(), &db).await;
        let first = room.sim_tick().await.unwrap();
        room.publish_frame(&first, &db).await;
        assert_eq!(room.metrics.lock().unwrap().ticks, 6);
        assert_eq!(room.publish_metrics.lock().unwrap().ticks, 2);
        assert_eq!(room.skipped_frames.load(Ordering::Relaxed), 0, "first publish has no baseline; 5 -> 6 is contiguous");
        for _ in 0..3 { latest = room.sim_tick().await; }
        room.publish_frame(latest.as_ref().unwrap(), &db).await;
        assert_eq!(room.skipped_frames.load(Ordering::Relaxed), 2);
        assert!(drain(&mut rx).iter().any(|m| m["type"] == "snapshot"));
    }

    #[tokio::test]
    async fn room_list_and_ops_read_cached_stats_without_the_game_lock() {
        let db = Database::open(":memory:").unwrap();
        let room = Room::new("r".into(), "R".into(), false, false);
        let _rx = connect(&room, "p1").await;
        room.tick(&db).await;
        let held = room.game.lock().await; // the game loop is mid-tick
        let summary = tokio::time::timeout(Duration::from_millis(200), room.summary(false)).await
            .expect("room list must not wait for the game lock");
        let ops = tokio::time::timeout(Duration::from_millis(200), room.ops_snapshot()).await
            .expect("ops status must not wait for the game lock");
        drop(held);
        assert_eq!(summary["wave"], 1);
        assert_eq!(ops["players"], 1);
        assert_eq!(ops["hostId"], "p1");
        assert_eq!(ops["publish"]["count"], 1);
    }
}
