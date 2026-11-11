//! Pure aggregation logic: turns raw ops samples from many game servers into
//! the dashboard overview (thread load, room health, fleet totals).

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadSample {
    pub name: String,
    pub busy_ns: u64,
    pub ticks: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLoad {
    pub name: String,
    /// Fraction of wall time spent ticking rooms, 0.0..=1.0.
    pub utilization: f64,
    pub ticks_per_sec: f64,
}

/// Game threads (`simThreads`) followed by state-provider threads (`publishThreads`).
pub fn parse_threads(status: &Value) -> Vec<ThreadSample> {
    ["simThreads", "publishThreads"].iter()
        .flat_map(|key| status[*key].as_array().cloned().unwrap_or_default())
        .map(|t| ThreadSample {
            name: t["name"].as_str().unwrap_or_default().to_string(),
            busy_ns: t["busyNs"].as_u64().unwrap_or(0),
            ticks: t["ticks"].as_u64().unwrap_or(0),
        })
        .collect()
}

/// Load per thread between two samples of the same server process.
/// Returns `None` if there is no usable previous sample (first poll, or the
/// server restarted so its counters went backwards).
pub fn thread_load(prev_uptime_ms: u64, prev: &[ThreadSample], uptime_ms: u64, cur: &[ThreadSample]) -> Option<Vec<ThreadLoad>> {
    if uptime_ms <= prev_uptime_ms { return None; }
    let wall_ns = (uptime_ms - prev_uptime_ms) as f64 * 1e6;
    cur.iter().map(|t| {
        let before = prev.iter().find(|p| p.name == t.name);
        let (busy0, ticks0) = before.map(|p| (p.busy_ns, p.ticks)).unwrap_or((0, 0));
        if t.busy_ns < busy0 || t.ticks < ticks0 { return None; }
        Some(ThreadLoad {
            name: t.name.clone(),
            utilization: ((t.busy_ns - busy0) as f64 / wall_ns).clamp(0.0, 1.0),
            ticks_per_sec: (t.ticks - ticks0) as f64 / (wall_ns / 1e9),
        })
    }).collect()
}

/// ok | warn (avg above half the budget) | over (a recent tick blew the budget) | idle
pub fn room_health(room: &Value) -> &'static str {
    if room["connected"].as_u64().unwrap_or(0) == 0 { return "idle"; }
    let budget = room["tick"]["budgetUs"].as_u64().unwrap_or(16_667);
    let max = room["tick"]["maxUs"].as_u64().unwrap_or(0);
    let avg = room["tick"]["avgUs"].as_u64().unwrap_or(0);
    if max > budget { "over" } else if avg * 2 > budget { "warn" } else { "ok" }
}

/// What the dashboard knows about one game server.
#[derive(Default)]
pub struct ServerView {
    pub url: String,
    pub status: Option<Value>,
    pub up: bool,
    pub last_error: Option<String>,
    pub last_ok_ms: Option<u64>,
    pub threads: Vec<ThreadLoad>,
    prev: Option<(u64, Vec<ThreadSample>)>,
}

impl ServerView {
    pub fn new(url: String) -> Self { Self { url, ..Default::default() } }

    pub fn record_success(&mut self, status: Value, now_ms: u64) {
        let uptime = status["uptimeMs"].as_u64().unwrap_or(0);
        let samples = parse_threads(&status);
        let load = self.prev.as_ref().and_then(|(prev_uptime, prev)| thread_load(*prev_uptime, prev, uptime, &samples));
        self.threads = load.unwrap_or_else(|| samples.iter().map(|t| ThreadLoad {
            name: t.name.clone(), utilization: 0.0, ticks_per_sec: 0.0,
        }).collect());
        self.prev = Some((uptime, samples));
        self.status = Some(status);
        self.up = true;
        self.last_error = None;
        self.last_ok_ms = Some(now_ms);
    }

    pub fn record_failure(&mut self, error: String) {
        // Keep the last status for context, but flag the server as down.
        self.up = false;
        self.last_error = Some(error);
        self.prev = None;
    }

    pub fn to_json(&self, index: usize, now_ms: u64) -> Value {
        let status = self.status.clone().unwrap_or(Value::Null);
        let rooms: Vec<Value> = status["rooms"].as_array().cloned().unwrap_or_default().into_iter().map(|mut r| {
            r["health"] = json!(room_health(&r));
            r
        }).collect();
        json!({
            "index": index,
            "url": self.url,
            "up": self.up,
            "lastError": self.last_error,
            "lastOkAgoMs": self.last_ok_ms.map(|t| now_ms.saturating_sub(t)),
            "serverId": status["serverId"],
            "version": status["version"],
            "build": status["build"],
            "uptimeMs": status["uptimeMs"],
            "simThreadCount": status["simThreadCount"],
            "publishThreadCount": status["publishThreadCount"],
            "roomLimit": status["roomLimit"],
            "totals": status["totals"],
            "threads": self.threads,
            "rooms": rooms,
        })
    }
}

pub fn overview(servers: &[ServerView], now_ms: u64, poll_ms: u64) -> Value {
    let views: Vec<Value> = servers.iter().enumerate().map(|(i, s)| s.to_json(i, now_ms)).collect();
    let up: Vec<&Value> = views.iter().filter(|v| v["up"] == true).collect();
    let sum = |key: &str| up.iter().map(|v| v["totals"][key].as_u64().unwrap_or(0)).sum::<u64>();
    let all_threads = up.iter().flat_map(|v| v["threads"].as_array().cloned().unwrap_or_default());
    let threads: Vec<Value> = all_threads.collect();
    let is_game = |t: &&Value| t["name"].as_str().is_some_and(|n| n.starts_with("room-sim"));
    let hottest = threads.iter().filter(is_game).map(|t| t["utilization"].as_f64().unwrap_or(0.0)).fold(0.0, f64::max);
    let hottest_publish = threads.iter().filter(|t| !is_game(t)).map(|t| t["utilization"].as_f64().unwrap_or(0.0)).fold(0.0, f64::max);
    let rooms_over = up.iter().flat_map(|v| v["rooms"].as_array().cloned().unwrap_or_default())
        .filter(|r| r["health"] == "over").count();
    json!({
        "generatedAtMs": now_ms,
        "pollMs": poll_ms,
        "totals": {
            "servers": views.len(),
            "serversUp": up.len(),
            "rooms": sum("rooms"),
            "connected": sum("connected"),
            "players": sum("players"),
            "zombies": sum("zombies"),
            "simThreads": threads.iter().filter(is_game).count(),
            "publishThreads": threads.iter().filter(|t| !is_game(t)).count(),
            "hottestThreadUtilization": hottest,
            "hottestPublishUtilization": hottest_publish,
            "roomsOverBudget": rooms_over,
        },
        "servers": views,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str, busy_ns: u64, ticks: u64) -> ThreadSample { ThreadSample { name: name.into(), busy_ns, ticks } }

    #[test]
    fn utilization_is_busy_time_over_wall_time() {
        let prev = vec![t("room-sim-0", 0, 0), t("room-sim-1", 1_000_000_000, 60)];
        let cur = vec![t("room-sim-0", 250_000_000, 120), t("room-sim-1", 1_000_000_000, 60)];
        let load = thread_load(1_000, &prev, 2_000, &cur).unwrap();
        assert!((load[0].utilization - 0.25).abs() < 1e-9);
        assert!((load[0].ticks_per_sec - 120.0).abs() < 1e-9);
        assert_eq!(load[1].utilization, 0.0);
    }

    #[test]
    fn new_threads_count_from_zero_and_utilization_is_clamped() {
        let load = thread_load(0, &[], 1_000, &[t("room-sim-3", 5_000_000_000, 10)]).unwrap();
        assert_eq!(load[0].utilization, 1.0);
    }

    #[test]
    fn restarted_server_resets_the_baseline() {
        let prev = vec![t("room-sim-0", 9_000_000_000, 900)];
        assert!(thread_load(60_000, &prev, 1_000, &[t("room-sim-0", 1, 1)]).is_none(), "uptime went backwards");
        assert!(thread_load(1_000, &prev, 2_000, &[t("room-sim-0", 1, 1)]).is_none(), "counters went backwards");
        assert!(thread_load(1_000, &prev, 1_000, &prev).is_none(), "no elapsed time");
    }

    #[test]
    fn game_and_state_provider_threads_are_both_tracked() {
        let status = json!({
            "uptimeMs": 1_000,
            "simThreads": [{ "name": "room-sim-0", "busyNs": 1, "ticks": 1 }],
            "publishThreads": [{ "name": "room-pub-0", "busyNs": 2, "ticks": 2 }],
            "totals": {}, "rooms": [],
        });
        let names: Vec<_> = parse_threads(&status).into_iter().map(|t| t.name).collect();
        assert_eq!(names, ["room-sim-0", "room-pub-0"]);

        let mut view = ServerView::new("http://a".into());
        view.record_success(status.clone(), 0);
        let mut later = status.clone();
        later["uptimeMs"] = json!(2_000);
        later["simThreads"][0]["busyNs"] = json!(100_000_000);
        later["publishThreads"][0]["busyNs"] = json!(300_000_000);
        view.record_success(later, 1);
        let o = overview(&[view], 2, 1_000);
        assert_eq!(o["totals"]["simThreads"], 1);
        assert_eq!(o["totals"]["publishThreads"], 1);
        assert!((o["totals"]["hottestThreadUtilization"].as_f64().unwrap() - 0.1).abs() < 1e-6);
        assert!((o["totals"]["hottestPublishUtilization"].as_f64().unwrap() - 0.3).abs() < 1e-6);
    }

    #[test]
    fn room_health_classification() {
        let room = |connected: u64, avg: u64, max: u64| json!({ "connected": connected, "tick": { "avgUs": avg, "maxUs": max, "budgetUs": 16_667 } });
        assert_eq!(room_health(&room(0, 0, 0)), "idle");
        assert_eq!(room_health(&room(3, 400, 2_000)), "ok");
        assert_eq!(room_health(&room(3, 9_000, 12_000)), "warn");
        assert_eq!(room_health(&room(3, 400, 30_000)), "over");
    }

    fn status(uptime: u64, busy: u64, rooms: Value) -> Value {
        json!({
            "serverId": "game-1", "uptimeMs": uptime, "simThreadCount": 1,
            "simThreads": [{ "name": "room-sim-0", "busyNs": busy, "ticks": uptime / 16 }],
            "totals": { "rooms": rooms.as_array().unwrap().len(), "connected": 2, "players": 2, "zombies": 5 },
            "rooms": rooms,
        })
    }

    #[test]
    fn server_view_tracks_samples_and_outages() {
        let mut view = ServerView::new("http://a".into());
        view.record_success(status(1_000, 0, json!([])), 10);
        assert!(view.up);
        assert_eq!(view.threads[0].utilization, 0.0, "first sample has no baseline");
        view.record_success(status(2_000, 500_000_000, json!([])), 20);
        assert!((view.threads[0].utilization - 0.5).abs() < 1e-9);

        view.record_failure("connection refused".into());
        let j = view.to_json(0, 1_020);
        assert_eq!(j["up"], false);
        assert_eq!(j["lastError"], "connection refused");
        assert_eq!(j["lastOkAgoMs"], 1_000);
        assert_eq!(j["serverId"], "game-1", "last known status kept for context");
    }

    #[test]
    fn overview_sums_only_live_servers() {
        let busy_room = json!({ "id": "r", "connected": 2, "tick": { "avgUs": 100, "maxUs": 40_000, "budgetUs": 16_667 } });
        let mut a = ServerView::new("http://a".into());
        a.record_success(status(1_000, 0, json!([busy_room])), 0);
        let mut b = ServerView::new("http://b".into());
        b.record_success(status(1_000, 0, json!([])), 0);
        b.record_failure("timeout".into());
        let c = ServerView::new("http://c".into()); // never reached

        let o = overview(&[a, b, c], 5, 1_000);
        assert_eq!(o["totals"]["servers"], 3);
        assert_eq!(o["totals"]["serversUp"], 1);
        assert_eq!(o["totals"]["rooms"], 1);
        assert_eq!(o["totals"]["players"], 2);
        assert_eq!(o["totals"]["roomsOverBudget"], 1);
        assert_eq!(o["servers"][0]["rooms"][0]["health"], "over");
        assert_eq!(o["servers"][2]["up"], false);
    }
}
