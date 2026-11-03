//! Server-hosted rooms. Every room owns its own authoritative `Game` and is
//! simulated by a dedicated 60 Hz task on the server — clients never host.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};

use crate::db::Database;
use crate::delta::DeltaTracker;
use crate::game::Game;

pub type ClientSender = mpsc::Sender<String>;

pub const OPEN_ROOM_ID: &str = "open";
pub const VERIFIED_ROOM_ID: &str = "verified";
pub const MAX_ROOMS: usize = 32;
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
}

impl Room {
    fn new(id: String, name: String, verified_only: bool, permanent: bool) -> Self {
        Self {
            id, name, verified_only, permanent,
            game: Mutex::new(Game::new()),
            delta_tracker: Mutex::new(DeltaTracker::new()),
            clients: Mutex::new(HashMap::new()),
            pending_snapshots: Mutex::new(HashSet::new()),
            wave_profiles: Mutex::new(HashMap::new()),
            last_room_status: Mutex::new(String::new()),
            empty_since: Mutex::new(Some(Instant::now())),
        }
    }

    pub async fn summary(&self, player_verified: bool) -> serde_json::Value {
        let game = self.game.lock().await;
        let (wave, game_over, paused) = (game.wave(), game.is_game_over(), game.is_paused());
        drop(game);
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
        self.game.lock().await.reset_at_wave(requested, unlocked);
        *self.delta_tracker.lock().await = DeltaTracker::new();
        let clients = self.clients.lock().await;
        self.pending_snapshots.lock().await.extend(clients.keys().cloned());
    }

    /// One server-side simulation + broadcast step.
    pub async fn tick(&self, db: &Database) {
        if self.clients.lock().await.is_empty() {
            return;
        }

        // --- Physics step (every tick, 60 Hz) ---
        let mut game = self.game.lock().await;
        let game_finished = game.is_game_over();
        let room_paused = game.is_paused();
        let room_status = serde_json::json!({
            "type": "room", "hostId": game.host_id(), "paused": room_paused,
            "roomId": self.id, "roomName": self.name, "verifiedOnly": self.verified_only,
        }).to_string();
        if !game_finished && !room_paused {
            game.update(1.0 / 60.0);
        }

        // Snapshot state for network
        let players = game.players().clone();
        let zombies = game.zombies().to_vec();
        let bullets = game.bullets().to_vec();
        let placeables = game.placeables().to_vec();
        let drops = game.drops();
        let wave = game.wave();
        let wave_kills = game.wave_kills();
        let wave_target = game.wave_target();
        let wave_break_timer = game.wave_break_timer();
        let ammo_availability: HashMap<String, bool> = game.ammo_availability().iter()
            .map(|a| (a.id.clone(), a.available)).collect();
        let game_over = game.is_game_over();
        drop(game);

        // Persist only when a connected browser reaches a new wave, not every tick.
        {
            let mut profiles = self.wave_profiles.lock().await;
            for (profile, recorded_wave) in profiles.values_mut() {
                if wave > *recorded_wave {
                    db.record_wave(profile, wave);
                    *recorded_wave = wave;
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
            self.pending_snapshots.lock().await.extend(players.keys().cloned());
        }

        // --- Delta computation ---
        let mut dt = self.delta_tracker.lock().await;
        let delta = dt.compute_delta(
            &players, &zombies, &bullets, &placeables, &drops,
            wave, wave_kills, wave_target, wave_break_timer, &ammo_availability, game_over,
        );
        let delta_str = serde_json::to_string(&delta).unwrap();

        let snapshot_ids: Vec<String> = {
            let mut pending = self.pending_snapshots.lock().await;
            pending.drain().collect()
        };
        let snapshot_str = if !snapshot_ids.is_empty() {
            let snapshot = dt.build_snapshot(
                &players, &zombies, &bullets, &placeables, &drops,
                wave, wave_kills, wave_target, wave_break_timer, &ammo_availability, game_over,
            );
            Some(serde_json::to_string(&snapshot).unwrap())
        } else {
            None
        };
        drop(dt);

        // --- Adaptive broadcast: try_send skips slow clients ---
        let clients = self.clients.lock().await;
        for (id, tx) in clients.iter() {
            let needs_snapshot = snapshot_ids.contains(id);
            if room_changed || needs_snapshot {
                // Host/pause changes must not be lost like disposable physics deltas.
                let _ = tx.send(room_status.clone()).await;
            }
            if needs_snapshot {
                if let Some(ref ss) = snapshot_str {
                    let _ = tx.send(ss.clone()).await;
                }
            } else if !game_finished && !room_paused {
                let _ = tx.try_send(delta_str.clone());
            }
        }
    }
}

pub struct RoomRegistry {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    db: Arc<Database>,
    empty_ttl: Duration,
}

impl RoomRegistry {
    pub fn new(db: Arc<Database>, empty_ttl: Duration) -> Arc<Self> {
        Arc::new(Self { rooms: Mutex::new(HashMap::new()), db, empty_ttl })
    }

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
        spawn_room_loop(Arc::downgrade(&room), self.db.clone());
        room
    }

    pub async fn create(&self, name: &str, verified_only: bool) -> Result<Arc<Room>, String> {
        let name = sanitize_room_name(name);
        if name.is_empty() {
            return Err("Room name required".into());
        }
        if self.rooms.lock().await.len() >= MAX_ROOMS {
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

/// Each room is simulated on its own server task, stopping once the room is gone.
fn spawn_room_loop(room: Weak<Room>, db: Arc<Database>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(16));
        loop {
            interval.tick().await;
            let Some(room) = room.upgrade() else { break };
            room.tick(&db).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(ttl: Duration) -> Arc<RoomRegistry> {
        RoomRegistry::new(Arc::new(Database::open(":memory:").unwrap()), ttl)
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
        let registry = registry(EMPTY_ROOM_TTL);
        registry.start().await;
        for i in 0..MAX_ROOMS - 2 {
            registry.create(&format!("Room {i}"), false).await.unwrap();
        }
        assert_eq!(registry.all().await.len(), MAX_ROOMS);
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
}
