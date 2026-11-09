//! Server-hosted raids. Every room is one persistent instance of a map with
//! its own authoritative `Game`. Clients never host.
//!
//! Each room runs as two decoupled tasks on separate thread pools (see `sim.rs`):
//!
//! * **Game loop** (`room-sim-*`): 60 Hz physics only. It copies the resulting
//!   state into a [`Frame`] and hands it off without ever waiting on players,
//!   the database or the dashboard.
//! * **State provider** (`room-pub-*`): takes the latest frame, computes
//!   deltas/snapshots, serializes them and sends them to players. It also
//!   settles finished raids (stash writes run on a blocking thread). If it falls
//!   behind it skips to the newest frame; raid results are queued separately
//!   so a skipped frame can never lose one.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Mutex};

use crate::db::Database;
use crate::delta::{DeltaTracker, World};
use crate::game::Game;
use crate::gear::{MapDef, MAPS};
use crate::sim;
use crate::types::{Bullet, DropPickup, Placeable, Player, RaidOutcome, Zombie};

pub type ClientSender = mpsc::Sender<String>;

/// Where a join without a room id lands: the public Outskirts raid.
pub const OPEN_ROOM_ID: &str = "outskirts";
/// Default room cap; override with `BOXHEAD_MAX_ROOMS`.
pub const MAX_ROOMS: usize = 256;
/// Each client only gets enemies, bullets, drops and deployables this close
/// to them (a 1920×1080 screen reaches about 1,100 units from its centre).
pub const VIEW_RANGE: f64 = 1500.0;
/// State goes out every other game tick (30 Hz); clients interpolate between.
pub const SEND_EVERY: u64 = 2;
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
    pub ammo_availability: HashMap<String, bool>,
    pub crate_availability: HashMap<String, bool>,
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

/// Matchmaking pool. Players only meet others in the same pool: everyone who
/// signed in with Steam, everyone on Bluesky, everyone on email or Google, and
/// everyone (from any platform) who turned cross-platform play on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Pool { Steam, Bluesky, Direct, Cross }

impl Pool {
    pub const ALL: [Pool; 4] = [Pool::Steam, Pool::Bluesky, Pool::Direct, Pool::Cross];

    /// The pool for a session's sign-in platform and the account's cross-play setting.
    pub fn for_player(platform: &str, crossplay: bool) -> Pool {
        if crossplay { return Pool::Cross; }
        match platform { "steam" => Pool::Steam, "bluesky" => Pool::Bluesky, _ => Pool::Direct }
    }

    pub fn id(self) -> &'static str {
        match self { Pool::Steam => "steam", Pool::Bluesky => "bluesky", Pool::Direct => "direct", Pool::Cross => "cross" }
    }

    pub fn label(self) -> &'static str {
        match self { Pool::Steam => "Steam", Pool::Bluesky => "Bluesky", Pool::Direct => "Email & Google", Pool::Cross => "Cross-platform" }
    }

    pub fn json(self) -> serde_json::Value {
        serde_json::json!({ "id": self.id(), "label": self.label() })
    }
}

/// The id of a map's always-on raid in one pool.
pub fn official_room_id(map: &str, pool: Pool) -> String {
    format!("{map}-{}", pool.id())
}

pub fn sanitize_room_name(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect::<String>()
        .trim().chars().take(24).collect()
}

pub struct Room {
    pub id: String,
    pub name: String,
    /// Only players in this matchmaking pool can join.
    pub pool: Pool,
    /// Permanent rooms always exist; player-created rooms expire when empty.
    pub permanent: bool,
    pub map: &'static MapDef,
    pub game: Mutex<Game>,
    /// One diff baseline per connected client (each sees only what's near them).
    pub trackers: Mutex<HashMap<String, DeltaTracker>>,
    pub clients: Mutex<HashMap<String, ClientSender>>,
    pub pending_snapshots: Mutex<HashSet<String>>,
    /// Player id -> stash profile, for settling their raid.
    pub raid_profiles: Mutex<HashMap<String, String>>,
    /// Finished raids handed from the game loop to the state provider.
    outcomes: std::sync::Mutex<Vec<RaidOutcome>>,
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
    raids_settled: AtomicU64,
    created_at: Instant,
}

impl Room {
    pub fn new(id: String, name: String, pool: Pool, permanent: bool, map: &'static MapDef) -> Self {
        let game = Game::new(map);
        let stats = RoomStats::from_game(&game);
        Self {
            id, name, pool, permanent, map,
            game: Mutex::new(game),
            trackers: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            pending_snapshots: Mutex::new(HashSet::new()),
            raid_profiles: Mutex::new(HashMap::new()),
            outcomes: std::sync::Mutex::new(Vec::new()),
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
            raids_settled: AtomicU64::new(0),
            created_at: Instant::now(),
        }
    }

    pub fn stats(&self) -> RoomStats { self.stats.lock().unwrap().clone() }

    fn map_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.map.id, "name": self.map.name, "tier": self.map.tier,
            "minGearScore": self.map.min_gear_score, "threat": self.map.threat(), "entryFee": self.map.entry_fee,
        })
    }

    /// Full operational view of the room for the ops dashboard.
    /// Never touches the game lock: reads stats cached by the game loop.
    pub async fn ops_snapshot(&self) -> serde_json::Value {
        let RoomStats { players, alive, zombies, bullets, paused, host_id } = self.stats();
        let connected = self.clients.lock().await.len();
        let m = self.metrics.lock().unwrap();
        let p = self.publish_metrics.lock().unwrap();
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "pool": self.pool.id(),
            "permanent": self.permanent,
            "map": self.map.name,
            "tier": self.map.tier,
            "connected": connected,
            "players": players,
            "alive": alive,
            "zombies": zombies,
            "bullets": bullets,
            "paused": paused,
            "hostId": host_id,
            "raidsSettled": self.raids_settled.load(Ordering::Relaxed),
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

    /// Lobby-browser view. `viewer` is the viewer's pool (None when signed out).
    pub async fn summary(&self, viewer: Option<Pool>) -> serde_json::Value {
        let RoomStats { paused, .. } = self.stats();
        let players = self.clients.lock().await.len();
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "pool": self.pool.json(),
            "permanent": self.permanent,
            "players": players,
            "paused": paused,
            "map": self.map_json(),
            "canJoin": viewer == Some(self.pool),
        })
    }

    /// Operator restart: clear and restock the world and resync every client.
    /// Players stay in their raids.
    pub async fn restart(&self) {
        {
            let mut game = self.game.lock().await;
            game.reset_world();
            *self.stats.lock().unwrap() = RoomStats::from_game(&game);
        }
        self.trackers.lock().await.clear();
        let clients = self.clients.lock().await;
        self.pending_snapshots.lock().await.extend(clients.keys().cloned());
    }

    /// Run one game tick and publish it inline. The live server runs these two
    /// halves on separate pools (see `spawn_room_loops`); this keeps tests simple.
    #[cfg(test)]
    pub async fn tick(&self, db: &Arc<Database>) {
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
        let paused = game.is_paused();
        if !paused {
            let tick = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| game.update(1.0 / 60.0)));
            if tick.is_err() {
                // Keep the room alive: clear the world (players keep their raids) and carry on.
                eprintln!("Room {} panicked during a tick; resetting its world", self.id);
                game.reset_world();
            }
        }
        let finished = game.take_outcomes();
        let frame = Frame {
            seq: self.next_seq.fetch_add(1, Ordering::Relaxed) + 1,
            players: game.players().clone(),
            zombies: game.zombies().to_vec(),
            bullets: game.bullets().to_vec(),
            placeables: game.placeables().to_vec(),
            drops: game.drops(),
            ammo_availability: game.ammo_availability().iter().map(|a| (a.id.clone(), a.available)).collect(),
            crate_availability: game.crate_availability().iter().map(|a| (a.id.clone(), a.available)).collect(),
            paused,
            host_id: game.host_id().map(str::to_owned),
        };
        let stats = RoomStats::from_game(&game);
        drop(game);
        *self.stats.lock().unwrap() = stats;
        if !finished.is_empty() { self.outcomes.lock().unwrap().extend(finished); }

        let elapsed = started.elapsed();
        let thread = sim::record_tick(elapsed);
        self.metrics.lock().unwrap().record(elapsed, 0, thread, Instant::now());
        Some(Arc::new(frame))
    }

    /// State-provider half: settle finished raids, then diff, serialize and send
    /// one frame. Runs off the game threads.
    pub async fn publish_frame(&self, frame: &Frame, db: &Arc<Database>) {
        let started = Instant::now();
        let previous = self.last_published_seq.swap(frame.seq, Ordering::Relaxed);
        if previous != 0 && frame.seq > previous + 1 {
            self.skipped_frames.fetch_add(frame.seq - previous - 1, Ordering::Relaxed);
        }
        self.settle_outcomes(db).await;
        let dropped = self.publish(frame).await;
        let elapsed = started.elapsed();
        let thread = sim::record_tick(elapsed);
        self.publish_metrics.lock().unwrap().record(elapsed, dropped, thread, Instant::now());
    }

    /// A player's connection closed. If that ended a raid still in progress, it
    /// is abandoned and returned with the stash profile so the caller can settle
    /// it. If the game loop already ended the raid (killed, extracted, out of
    /// time) the profile is left for `settle_outcomes`, which is what records it.
    pub async fn leave(&self, player_id: &str) -> Option<Departure> {
        let (abandoned, acted) = {
            let mut game = self.game.lock().await;
            let acted = game.has_acted(player_id);
            (game.abandon(player_id), acted)
        };
        self.clients.lock().await.remove(player_id);
        self.pending_snapshots.lock().await.remove(player_id);
        let outcome = abandoned?;
        let profile = self.raid_profiles.lock().await.remove(player_id)?;
        Some(if acted { Departure::Abandoned(outcome, profile) } else { Departure::NeverPlayed(profile) })
    }

    /// Save each finished raid to its stash and tell the player how it went.
    /// The player is detached from the room first so no more deltas reach them;
    /// dropping their sender then closes the connection after the result is sent.
    pub(crate) async fn settle_outcomes(&self, db: &Arc<Database>) {
        let finished = std::mem::take(&mut *self.outcomes.lock().unwrap());
        for outcome in finished {
            let profile = self.raid_profiles.lock().await.remove(&outcome.player_id);
            let tx = self.clients.lock().await.remove(&outcome.player_id);
            self.pending_snapshots.lock().await.remove(&outcome.player_id);
            self.raids_settled.fetch_add(1, Ordering::Relaxed);
            let db = db.clone();
            let map = self.map.name;
            let room_id = self.id.clone();
            tokio::spawn(async move {
                let settlement = match profile {
                    Some(profile) => settle_with_retry(db, profile, room_id, outcome.clone()).await,
                    None => { eprintln!("Finished raid for player {} has no stash profile", outcome.player_id); None }
                };
                let msg = serde_json::json!({ "type": "raidEnd", "map": map, "outcome": outcome, "settlement": settlement }).to_string();
                if let Some(tx) = tx {
                    let _ = tokio::time::timeout(Duration::from_secs(5), tx.send(msg)).await;
                }
            });
        }
    }

    /// Returns the number of deltas dropped for clients that were behind.
    async fn publish(&self, frame: &Frame) -> u64 {
        let room_status = serde_json::json!({
            "type": "room", "hostId": frame.host_id, "paused": frame.paused,
            "roomId": self.id, "roomName": self.name, "pool": self.pool.id(),
        }).to_string();

        let room_changed = {
            let mut previous = self.last_room_status.lock().await;
            let changed = *previous != room_status;
            *previous = room_status.clone();
            changed
        };
        if room_changed {
            self.pending_snapshots.lock().await.extend(frame.players.keys().cloned());
        }

        let snapshot_ids: Vec<String> = self.pending_snapshots.lock().await.drain().collect();
        let regular = frame.seq % SEND_EVERY == 0 && !frame.paused;
        if !room_changed && snapshot_ids.is_empty() && !regular {
            return 0;
        }

        // Adaptive broadcast: deltas are droppable; status + snapshots must arrive.
        let mut dropped = 0;
        let mut retry = Vec::new();
        let clients = self.clients.lock().await;
        let mut trackers = self.trackers.lock().await;
        trackers.retain(|id, _| clients.contains_key(id));
        for (id, tx) in clients.iter() {
            let needs_snapshot = snapshot_ids.contains(id);
            if !(room_changed || needs_snapshot || regular) { continue; }
            // What this player can see: everything near them (or everything, if
            // they have no body in the raid).
            let center = frame.players.get(id).map(|p| (p.pos.x, p.pos.y));
            let near = |x: f64, y: f64| center.is_none_or(|(cx, cy)| (x - cx).abs() < VIEW_RANGE && (y - cy).abs() < VIEW_RANGE);
            let zombies: Vec<Zombie> = frame.zombies.iter().filter(|z| near(z.pos.x, z.pos.y)).cloned().collect();
            let bullets: Vec<Bullet> = frame.bullets.iter().filter(|b| near(b.pos.x, b.pos.y)).cloned().collect();
            let placeables: Vec<Placeable> = frame.placeables.iter().filter(|p| near(p.pos.x, p.pos.y)).cloned().collect();
            let drops: Vec<DropPickup> = frame.drops.iter().filter(|d| near(d.pos.x, d.pos.y)).cloned().collect();
            let world = World {
                players: &frame.players, zombies: &zombies, bullets: &bullets, placeables: &placeables,
                drops: &drops, ammo: &frame.ammo_availability, crates: &frame.crate_availability,
            };
            let tracker = trackers.entry(id.clone()).or_insert_with(DeltaTracker::new);
            if room_changed || needs_snapshot {
                // Never wait on a player: if their queue is full the resync is
                // retried next frame, so one stalled connection can't hold up the room.
                let mut must_send = vec![room_status.clone()];
                if needs_snapshot { must_send.push(serde_json::to_string(&tracker.snapshot(&world, frame.seq)).unwrap()); }
                for msg in must_send {
                    if tx.try_send(msg).is_err() {
                        retry.push(id.clone());
                        break;
                    }
                }
            } else {
                let delta = serde_json::to_string(&tracker.compute_delta(&world, frame.seq)).unwrap();
                if tx.try_send(delta).is_err() {
                    // Deltas build on each other, so a dropped one would leave this
                    // client out of sync for good: send it a fresh snapshot instead.
                    dropped += 1;
                    retry.push(id.clone());
                }
            }
        }
        drop(trackers);
        drop(clients);
        if !retry.is_empty() {
            self.slow_client_retries.fetch_add(retry.len() as u64, Ordering::Relaxed);
            self.pending_snapshots.lock().await.extend(retry);
        }
        dropped
    }
}

/// What a disconnect means for the player's stash.
pub enum Departure {
    /// They left a raid they were playing: it's lost.
    Abandoned(RaidOutcome, String),
    /// They dropped before sending a single input: void the raid, refund the fee.
    NeverPlayed(String),
}

/// Settle a raid on a blocking thread, retrying a few times so a transient
/// SQLite error doesn't leave the operator stuck in a raid.
pub async fn settle_with_retry(db: Arc<Database>, profile: String, room_id: String, outcome: RaidOutcome) -> Option<crate::db::RaidSettlement> {
    for attempt in 0..4u64 {
        let (db2, p, r, o) = (db.clone(), profile.clone(), room_id.clone(), outcome.clone());
        match tokio::task::spawn_blocking(move || db2.finish_raid_in(&p, Some(&r), &o)).await {
            Ok(Ok(s)) => return Some(s),
            Ok(Err(e)) if e.starts_with("Not in a raid") || e.starts_with("Deployed in") => {
                eprintln!("Raid for {profile} was already settled or belongs elsewhere: {e}");
                return None;
            }
            Ok(Err(e)) => eprintln!("Could not settle the raid for {profile} (attempt {}): {e}", attempt + 1),
            Err(e) => eprintln!("Raid settlement for {profile} panicked (attempt {}): {e}", attempt + 1),
        }
        tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
    }
    None
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

    /// Start the background reaper. Call once at startup. The always-on raids
    /// (one per map per pool) open on demand: see [`Self::ensure_official`].
    pub async fn start(self: &Arc<Self>) {

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

    /// Open the always-on raid for every map in this pool, if not already open.
    /// They don't count toward the room limit and are never reaped.
    pub async fn ensure_official(&self, pool: Pool) {
        let missing: Vec<&'static MapDef> = {
            let rooms = self.rooms.lock().await;
            MAPS.iter().filter(|m| !rooms.contains_key(&official_room_id(m.id, pool))).collect()
        };
        for map in missing {
            let id = official_room_id(map.id, pool);
            // Re-check under the lock so two concurrent callers don't both start a room.
            if self.rooms.lock().await.contains_key(&id) { continue; }
            self.insert(Room::new(id, map.name.to_string(), pool, true, map)).await;
        }
    }

    /// Find the room a player asked for. A bare map id ("outskirts") means that
    /// map's always-on raid in the player's own pool.
    pub async fn resolve(&self, room_id: &str, pool: Pool) -> Option<Arc<Room>> {
        if MAPS.iter().any(|m| m.id == room_id) {
            self.ensure_official(pool).await;
            return self.get(&official_room_id(room_id, pool)).await;
        }
        self.get(room_id).await
    }

    /// Every room in one pool, opening its always-on raids first.
    pub async fn in_pool(&self, pool: Pool) -> Vec<Arc<Room>> {
        self.ensure_official(pool).await;
        self.all().await.into_iter().filter(|r| r.pool == pool).collect()
    }

    pub async fn create(&self, name: &str, pool: Pool, map: &'static MapDef) -> Result<Arc<Room>, String> {
        let name = sanitize_room_name(name);
        if name.is_empty() {
            return Err("Room name required".into());
        }
        if self.rooms.lock().await.len() >= self.max_rooms {
            return Err("Server room limit reached — try again later".into());
        }
        let id = uuid::Uuid::new_v4().to_string()[..8].to_string();
        Ok(self.insert(Room::new(id, name, pool, false, map)).await)
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Room>> {
        self.rooms.lock().await.get(id).cloned()
    }

    pub async fn all(&self) -> Vec<Arc<Room>> {
        let mut rooms: Vec<_> = self.rooms.lock().await.values().cloned().collect();
        rooms.sort_by(|a, b| a.map.tier.cmp(&b.map.tier)
            .then(b.permanent.cmp(&a.permanent))
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
    use crate::game::test_support::kit;
    use crate::gear::default_map;

    fn memdb() -> Arc<Database> { Arc::new(Database::open(":memory:").unwrap()) }

    fn registry(ttl: Duration) -> Arc<RoomRegistry> {
        registry_with(ttl, MAX_ROOMS, tokio::runtime::Handle::current())
    }

    fn registry_with(empty_ttl: Duration, max_rooms: usize, sim: tokio::runtime::Handle) -> Arc<RoomRegistry> {
        let publish = tokio::runtime::Handle::current();
        RoomRegistry::new(memdb(), RegistryConfig { empty_ttl, max_rooms, sim, publish })
    }

    fn pools(sim_threads: usize, publish_threads: usize) -> (crate::sim::SimRuntime, crate::sim::SimRuntime, Arc<RoomRegistry>) {
        let sim = crate::sim::SimRuntime::new(crate::sim::THREAD_PREFIX, sim_threads).unwrap();
        let publish = crate::sim::SimRuntime::new(crate::sim::PUBLISH_PREFIX, publish_threads).unwrap();
        let registry = RoomRegistry::new(memdb(), RegistryConfig {
            empty_ttl: EMPTY_ROOM_TTL, max_rooms: MAX_ROOMS, sim: sim.handle(), publish: publish.handle(),
        });
        (sim, publish, registry)
    }

    fn room(id: &str, name: &str) -> Room {
        Room::new(id.into(), name.into(), Pool::Direct, false, default_map())
    }

    /// Simulate a connected client: register a channel and a player in the room.
    async fn connect(room: &Room, id: &str) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(64);
        room.game.lock().await.add_player(id, id, &kit(5, 5, 5));
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
    fn players_are_pooled_by_platform_unless_they_opt_into_crossplay() {
        assert_eq!(Pool::for_player("steam", false), Pool::Steam);
        assert_eq!(Pool::for_player("bluesky", false), Pool::Bluesky);
        assert_eq!(Pool::for_player("direct", false), Pool::Direct);
        assert_eq!(Pool::for_player("google", false), Pool::Direct);
        for platform in ["steam", "bluesky", "direct"] { assert_eq!(Pool::for_player(platform, true), Pool::Cross); }
        assert_eq!(official_room_id("outskirts", Pool::Steam), "outskirts-steam");
    }

    #[test]
    fn room_names_are_trimmed_and_bounded() {
        assert_eq!(sanitize_room_name("  Night\nShift  "), "NightShift");
        assert_eq!(sanitize_room_name(&"x".repeat(40)).len(), 24);
        assert_eq!(sanitize_room_name("   "), "");
        assert_eq!(sanitize_room_name("\u{0007}\t\r\n"), "");
        assert_eq!(sanitize_room_name(&"🧟".repeat(30)).chars().count(), 24);
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
    async fn each_pool_gets_its_own_always_on_raid_per_map() {
        let registry = registry(EMPTY_ROOM_TTL);
        registry.start().await;
        assert_eq!(registry.all().await.len(), 0, "pools open on demand");
        let steam = registry.in_pool(Pool::Steam).await;
        assert_eq!(steam.len(), MAPS.len());
        for map in &MAPS {
            let open = registry.get(&official_room_id(map.id, Pool::Steam)).await.unwrap();
            assert!(open.pool == Pool::Steam && open.permanent && open.map.id == map.id && open.name == map.name);
        }
        registry.in_pool(Pool::Steam).await;
        assert_eq!(registry.all().await.len(), MAPS.len(), "opening a pool twice adds nothing");
        // A bare map id resolves to that map's raid in the asker's pool.
        let blue = registry.resolve(OPEN_ROOM_ID, Pool::Bluesky).await.unwrap();
        assert_eq!((blue.id.as_str(), blue.pool), ("outskirts-bluesky", Pool::Bluesky));
        assert_eq!(registry.resolve("outskirts-steam", Pool::Bluesky).await.unwrap().pool, Pool::Steam, "explicit ids are not rewritten");
        assert!(registry.resolve("nope", Pool::Steam).await.is_none());
        assert!(registry.in_pool(Pool::Cross).await.iter().all(|r| r.pool == Pool::Cross));
    }

    #[tokio::test]
    async fn create_validates_names_and_picks_the_map() {
        let registry = registry(EMPTY_ROOM_TTL);
        let a = registry.create("  Squad  ", Pool::Steam, &MAPS[2]).await.unwrap();
        let b = registry.create("Squad", Pool::Cross, &MAPS[0]).await.unwrap();
        assert_eq!(a.name, "Squad");
        assert_eq!(a.map.id, "quarantine");
        assert!(a.pool == Pool::Steam && b.pool == Pool::Cross && !a.permanent);
        assert_ne!(a.id, b.id);
        assert!(registry.create(" ", Pool::Steam, &MAPS[0]).await.is_err());
    }

    #[tokio::test]
    async fn create_enforces_room_limit() {
        let registry = registry_with(EMPTY_ROOM_TTL, MAPS.len() + 2, tokio::runtime::Handle::current());
        registry.start().await;
        registry.ensure_official(Pool::Direct).await;
        registry.create("One", Pool::Direct, &MAPS[0]).await.unwrap();
        registry.create("Two", Pool::Direct, &MAPS[0]).await.unwrap();
        let err = registry.create("One too many", Pool::Direct, &MAPS[0]).await.err().unwrap();
        assert!(err.contains("limit"), "{err}");
    }

    #[tokio::test]
    async fn listing_orders_by_map_tier_then_official_first() {
        let registry = registry(EMPTY_ROOM_TTL);
        registry.start().await;
        registry.create("alpha", Pool::Direct, &MAPS[1]).await.unwrap();
        let rooms = registry.in_pool(Pool::Direct).await;
        let tiers: Vec<u32> = rooms.iter().map(|r| r.map.tier).collect();
        assert!(tiers.windows(2).all(|w| w[0] <= w[1]));
        let rust: Vec<_> = rooms.iter().filter(|r| r.map.tier == 2).map(|r| r.name.clone()).collect();
        assert_eq!(rust, ["Rust Yard", "alpha"]);
    }

    #[tokio::test]
    async fn summary_reports_map_gate_and_join_permission() {
        let r = Room::new("v".into(), "Vets".into(), Pool::Steam, false, &MAPS[1]);
        assert_eq!(r.summary(None).await["canJoin"], false);
        assert_eq!(r.summary(Some(Pool::Bluesky)).await["canJoin"], false);
        assert_eq!(r.summary(Some(Pool::Cross)).await["canJoin"], false);
        assert_eq!(r.summary(Some(Pool::Steam)).await["canJoin"], true);
        let s = r.summary(Some(Pool::Steam)).await;
        assert_eq!(s["pool"]["label"], "Steam");
        assert_eq!(s["map"]["id"], "rustyard");
        assert_eq!(s["map"]["minGearScore"], 20);
        assert_eq!(s["players"], 0);
        let _a = connect(&r, "a").await;
        assert_eq!(r.summary(None).await["players"], 1);
    }

    // ---- Reaping ----

    #[tokio::test]
    async fn empty_player_rooms_expire_after_ttl_but_not_before() {
        let ttl = Duration::from_secs(90);
        let registry = registry(ttl);
        let room = registry.create("Temp", Pool::Direct, default_map()).await.unwrap();
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
        for pool in Pool::ALL { registry.ensure_official(pool).await; }
        registry.reap_empty_rooms(Instant::now() + Duration::from_secs(3600)).await;
        assert_eq!(registry.all().await.len(), MAPS.len() * Pool::ALL.len());
    }

    #[tokio::test]
    async fn occupied_rooms_survive_and_their_empty_timer_restarts_on_leave() {
        let ttl = Duration::from_secs(90);
        let registry = registry(ttl);
        let room = registry.create("Party", Pool::Direct, default_map()).await.unwrap();
        let _rx = connect(&room, "p1").await;
        let t0 = Instant::now();
        registry.reap_empty_rooms(t0 + ttl * 10).await;
        assert!(registry.get(&room.id).await.is_some(), "occupied room kept");
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
        let room = registry.create("Doomed", Pool::Direct, default_map()).await.unwrap();
        let weak = Arc::downgrade(&room);
        drop(room);
        registry.reap_empty_rooms(Instant::now() + Duration::from_secs(5)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(weak.upgrade().is_none());
    }

    // ---- Server-side simulation ----

    #[tokio::test]
    async fn tick_sends_room_status_and_snapshot_to_new_clients_then_deltas() {
        let db = memdb();
        let room = room("r1", "Alpha");
        let mut rx = connect(&room, "p1").await;
        room.tick(&db).await;
        let first = drain(&mut rx);
        assert_eq!(first[0]["type"], "room");
        assert_eq!(first[0]["roomId"], "r1");
        assert_eq!(first[0]["hostId"], "p1");
        assert_eq!(first[1]["type"], "snapshot");
        assert!(first[1]["players"]["p1"]["backpackCapacity"].is_number());
        assert!(first[1]["crates"].as_array().is_some_and(|c| !c.is_empty()));
        room.tick(&db).await;
        room.tick(&db).await;
        let second = drain(&mut rx);
        assert_eq!(second.len(), 1, "state goes out at 30 Hz: one delta per two ticks");
        assert_eq!(second[0]["type"], "delta");
    }

    #[tokio::test]
    async fn tick_is_a_no_op_for_empty_rooms() {
        let db = memdb();
        let room = room("r1", "Idle");
        room.tick(&db).await;
        assert!(room.last_room_status.lock().await.is_empty(), "nothing simulated or broadcast");
        assert_eq!(room.metrics.lock().unwrap().ticks, 0);
    }

    #[tokio::test]
    async fn rooms_are_isolated_from_each_other() {
        let db = memdb();
        let a = room("a", "A");
        let b = room("b", "B");
        let mut rx_a = connect(&a, "alice").await;
        let mut rx_b = connect(&b, "bob").await;
        a.tick(&db).await;
        b.tick(&db).await;
        let snap_a = drain(&mut rx_a).into_iter().find(|m| m["type"] == "snapshot").unwrap();
        let snap_b = drain(&mut rx_b).into_iter().find(|m| m["type"] == "snapshot").unwrap();
        assert!(snap_a["players"]["alice"].is_object() && snap_a["players"]["bob"].is_null());
        assert!(snap_b["players"]["bob"].is_object() && snap_b["players"]["alice"].is_null());
        assert!(a.game.lock().await.set_paused("alice", true));
        assert!(!b.game.lock().await.is_paused());
    }

    #[tokio::test]
    async fn pause_change_is_broadcast_to_the_room() {
        let db = memdb();
        let room = room("r", "R");
        let mut rx = connect(&room, "host").await;
        room.tick(&db).await;
        drain(&mut rx);
        room.game.lock().await.set_paused("host", true);
        room.tick(&db).await;
        let msgs = drain(&mut rx);
        assert_eq!(msgs[0]["type"], "room");
        assert_eq!(msgs[0]["paused"], true);
        room.tick(&db).await;
        assert!(drain(&mut rx).is_empty(), "no droppable deltas while paused");
    }

    #[tokio::test]
    async fn restart_resyncs_every_connected_client() {
        let db = memdb();
        let room = room("r", "R");
        let mut rx1 = connect(&room, "p1").await;
        let mut rx2 = connect(&room, "p2").await;
        room.tick(&db).await;
        drain(&mut rx1);
        drain(&mut rx2);
        room.restart().await;
        room.tick(&db).await;
        for rx in [&mut rx1, &mut rx2] {
            assert!(drain(rx).iter().any(|m| m["type"] == "snapshot"));
        }
        assert!(room.game.lock().await.players().contains_key("p1"), "players keep raiding");
    }

    async fn recv_raid_end(rx: &mut mpsc::Receiver<String>) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
                Ok(Some(msg)) => {
                    let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
                    if v["type"] == "raidEnd" { return v; }
                }
                Ok(None) => break,
                Err(_) => {}
            }
        }
        panic!("no raidEnd message");
    }

    #[tokio::test]
    async fn a_finished_raid_is_saved_reported_and_disconnects_the_player() {
        let db = memdb();
        let room = room("r", "R");
        let profile = "guest:test".to_string();
        let loadout = db.begin_raid(&profile, "r", 0).unwrap();
        let (tx, mut rx) = mpsc::channel(64);
        room.game.lock().await.add_player("p1", "P1", &loadout);
        room.clients.lock().await.insert("p1".into(), tx);
        room.raid_profiles.lock().await.insert("p1".into(), profile.clone());
        room.tick(&db).await;

        room.game.lock().await.down_all_players();
        for _ in 0..(crate::map::BLEEDOUT_ALONE * 60.0) as usize + 5 { room.tick(&db).await; }
        let end = recv_raid_end(&mut rx).await;
        assert_eq!(end["outcome"]["result"], "killed");
        assert_eq!(end["settlement"]["cashEarned"], 0);
        assert!(room.clients.lock().await.is_empty(), "the player was detached from the room");
        // The sender is dropped once the result is out, which ends the connection.
        while rx.recv().await.is_some() {}
        let op = db.operator(&profile).unwrap();
        assert!(op.in_raid.is_none());
        assert_eq!(op.deaths, 1);
        assert_eq!(op.loadout().gear_score(), 0, "the loadout was lost");
        assert_eq!(room.ops_snapshot().await["raidsSettled"], 1);
    }

    #[tokio::test]
    async fn raid_results_survive_skipped_frames() {
        let db = memdb();
        let room = room("r", "R");
        let profile = "guest:skip".to_string();
        let loadout = db.begin_raid(&profile, "r", 0).unwrap();
        let (tx, mut rx) = mpsc::channel(64);
        room.game.lock().await.add_player("p1", "P1", &loadout);
        room.clients.lock().await.insert("p1".into(), tx);
        room.raid_profiles.lock().await.insert("p1".into(), profile.clone());
        let _bystander = connect(&room, "p2").await;
        {
            let mut game = room.game.lock().await;
            let e = game.layout().extracts[0].clone();
            game.clear_zombies();
            game.player_mut("p1").pos = crate::types::Vector2 { x: e.x, y: e.y };
            game.player_mut("p1").bounty = 77.0;
        }
        // Run the game loop alone, then publish only the latest frame.
        let mut latest = None;
        for _ in 0..(crate::map::EXTRACT_TIME * 60.0) as usize + 10 { latest = room.sim_tick().await; }
        room.publish_frame(latest.as_ref().unwrap(), &db).await;
        let end = recv_raid_end(&mut rx).await;
        assert_eq!(end["outcome"]["result"], "extracted");
        assert_eq!(end["settlement"]["cashEarned"], 77);
        assert_eq!(db.operator(&profile).unwrap().extracts, 1);
    }

    #[tokio::test]
    async fn a_raid_that_ends_just_before_a_disconnect_is_still_settled() {
        let db = memdb();
        let room = room("r", "R");
        let profile = "guest:race".to_string();
        let loadout = db.begin_raid(&profile, "r", 0).unwrap();
        let (tx, _rx) = mpsc::channel(64);
        room.game.lock().await.add_player("p1", "P1", &loadout);
        room.clients.lock().await.insert("p1".into(), tx);
        room.raid_profiles.lock().await.insert("p1".into(), profile.clone());
        room.game.lock().await.down_all_players();
        // The game loop ends the raid...
        for _ in 0..(crate::map::BLEEDOUT_ALONE * 60.0) as usize + 5 { room.sim_tick().await; }
        assert!(!room.game.lock().await.players().contains_key("p1"));
        // ...the socket closes before the state provider runs...
        assert!(room.leave("p1").await.is_none(), "not an abandon: the raid already ended");
        // ...and the state provider still records the death.
        let frame = room.sim_tick().await;
        let _ = frame; // the room is empty now, so no frame
        room.settle_outcomes(&db).await;
        let op = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let op = db.operator(&profile).unwrap();
                if op.in_raid.is_none() { break op; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("raid was never settled: the operator is stuck in_raid");
        assert_eq!(op.deaths, 1);
        assert_eq!(op.loadout().gear_score(), 0);
    }

    #[tokio::test]
    async fn leaving_mid_raid_hands_back_the_abandoned_raid_once() {
        let room = room("r", "R");
        let _rx = connect(&room, "p1").await;
        room.raid_profiles.lock().await.insert("p1".into(), "guest:x".into());
        // Dropping before ever sending input voids the raid instead.
        let Some(Departure::NeverPlayed(profile)) = room.leave("p1").await else { panic!("expected a void") };
        assert_eq!(profile, "guest:x");
        let _rx = connect(&room, "p1").await;
        room.raid_profiles.lock().await.insert("p1".into(), "guest:x".into());
        room.game.lock().await.handle_input("p1", crate::game::test_support::idle_input());
        let Some(Departure::Abandoned(o, profile)) = room.leave("p1").await else { panic!("expected an abandon") };
        assert_eq!(o.result, crate::types::RaidResult::Abandoned);
        assert_eq!(profile, "guest:x");
        assert!(room.leave("p1").await.is_none());
        assert!(room.clients.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_client_that_misses_a_delta_gets_a_fresh_snapshot() {
        let db = memdb();
        let room = room("r", "R");
        let mut rx = connect(&room, "p1").await;
        room.tick(&db).await;
        drain(&mut rx);
        let tx = room.clients.lock().await["p1"].clone();
        while tx.try_send("backlog".into()).is_ok() {}
        room.tick(&db).await; // this delta is dropped
        room.tick(&db).await;
        while rx.try_recv().is_ok() {}
        room.tick(&db).await;
        room.tick(&db).await;
        assert!(drain(&mut rx).iter().any(|m| m["type"] == "snapshot"), "resynced after a dropped delta");
    }

    #[tokio::test]
    async fn each_client_only_gets_what_is_near_them() {
        let db = memdb();
        let room = room("r", "R");
        let mut rx = connect(&room, "p1").await;
        let (x, y) = {
            let mut game = room.game.lock().await;
            game.clear_zombies();
            let p = game.players()["p1"].pos.clone();
            game.push_zombie(crate::game::test_support::enemy("near", crate::types::ZombieType::Zombie, p.x + 200.0, p.y, 50.0, 0.0));
            game.push_zombie(crate::game::test_support::enemy("far", crate::types::ZombieType::Zombie, (p.x + VIEW_RANGE + 600.0).min(4000.0), p.y, 50.0, 0.0));
            (p.x, p.y)
        };
        room.tick(&db).await;
        let snap = drain(&mut rx).into_iter().find(|m| m["type"] == "snapshot").unwrap();
        let ids: Vec<&str> = snap["zombies"].as_array().unwrap().iter().map(|z| z["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"near"));
        let far_x = (x + VIEW_RANGE + 600.0).min(4000.0);
        if (far_x - x).abs() > VIEW_RANGE { assert!(!ids.contains(&"far"), "far enemies aren't sent: {ids:?}"); }
        let _ = y;
    }

    #[tokio::test]
    async fn ticks_keep_increasing_across_a_restart() {
        let db = memdb();
        let room = room("r", "R");
        let mut rx = connect(&room, "p1").await;
        for _ in 0..6 { room.tick(&db).await; }
        let before = drain(&mut rx).iter().filter_map(|m| m["tick"].as_u64()).max().unwrap();
        room.restart().await;
        room.tick(&db).await;
        let snap = drain(&mut rx).into_iter().find(|m| m["type"] == "snapshot").unwrap();
        assert!(snap["tick"].as_u64().unwrap() > before, "a client can tell new state from old");
    }

    /// Bandwidth check (run with `cargo test --release bandwidth -- --ignored --nocapture`).
    #[tokio::test]
    #[ignore]
    async fn bandwidth_per_player_on_the_biggest_map() {
        let db = memdb();
        let room = Room::new("bw".into(), "BW".into(), Pool::Direct, false, &MAPS[3]);
        let mut rxs = Vec::new();
        for i in 0..6 { rxs.push(connect(&room, &format!("p{i}")).await); }
        {
            let mut game = room.game.lock().await;
            let base = game.players()["p0"].pos.clone();
            for i in 0..6 { game.player_mut(&format!("p{i}")).pos = crate::types::Vector2 { x: base.x + i as f64 * 40.0, y: base.y }; }
            for i in 0..220 {
                let a = i as f64 * 0.37;
                let r = 200.0 + (i % 20) as f64 * 60.0;
                game.push_zombie(crate::game::test_support::enemy(&format!("z{i}"), crate::types::ZombieType::Zombie, base.x + a.cos() * r, base.y + a.sin() * r, 1e6, 40.0));
            }
        }
        let mut input = crate::game::test_support::idle_input();
        input.shooting = true;
        for _ in 0..60 {
            { let mut game = room.game.lock().await; for i in 0..6 { game.player_mut(&format!("p{i}")).health = 1e6; } }
            room.tick(&db).await;
        }
        for rx in &mut rxs { drain(rx); }
        let mut bytes = 0usize;
        let mut msgs = 0usize;
        for _ in 0..600 {
            {
                let mut game = room.game.lock().await;
                for i in 0..6 { let id = format!("p{i}"); game.player_mut(&id).health = 1e6; game.handle_input(&id, input.clone()); }
            }
            room.tick(&db).await;
            while let Ok(m) = rxs[0].try_recv() { bytes += m.len(); msgs += 1; }
        }
        let secs = 10.0;
        println!("player 0: {msgs} messages, {:.1} KB/s, {:.1} KB/message", bytes as f64 / 1024.0 / secs, bytes as f64 / 1024.0 / msgs.max(1) as f64);
    }

    // ---- Metrics & parallel simulation ----

    #[test]
    fn tick_metrics_track_average_max_and_overruns() {
        let mut m = TickMetrics::default();
        let t0 = Instant::now();
        m.record(Duration::from_millis(2), 0, "room-sim-0".into(), t0);
        m.record(Duration::from_millis(20), 3, "room-sim-1".into(), t0);
        assert_eq!(m.ticks, 2);
        assert_eq!(m.overruns, 1);
        assert_eq!(m.dropped_deltas, 3);
        assert_eq!(m.last_thread, "room-sim-1");
        assert_eq!(m.recent_max_ns(), 20_000_000);
        m.record(Duration::from_millis(1), 0, "room-sim-0".into(), t0 + MAX_WINDOW);
        m.record(Duration::from_millis(1), 0, "room-sim-0".into(), t0 + MAX_WINDOW * 2);
        assert_eq!(m.recent_max_ns(), 1_000_000);
    }

    #[tokio::test]
    async fn ops_snapshot_reports_room_and_tick_health() {
        let db = memdb();
        let room = Room::new("r".into(), "Ops".into(), Pool::Direct, false, &MAPS[3]);
        let _rx = connect(&room, "p1").await;
        room.tick(&db).await;
        room.tick(&db).await;
        let s = room.ops_snapshot().await;
        assert_eq!(s["name"], "Ops");
        assert_eq!(s["map"], "Black Site");
        assert_eq!(s["tier"], 4);
        assert_eq!(s["connected"], 1);
        assert_eq!(s["hostId"], "p1");
        assert_eq!(s["tick"]["count"], 2);
        assert_eq!(s["tick"]["budgetUs"], 16_667);
    }

    #[tokio::test]
    async fn room_loops_run_on_the_sim_pool_in_parallel() {
        let (sim, publish, registry) = pools(4, 2);
        let mut rooms = Vec::new();
        let mut receivers = Vec::new();
        for i in 0..12 {
            let room = registry.create(&format!("Load {i}"), Pool::Direct, &MAPS[i % MAPS.len()]).await.unwrap();
            receivers.push(connect(&room, &format!("p{i}")).await);
            rooms.push(room);
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
        for room in &rooms {
            let m = room.metrics.lock().unwrap();
            assert!(m.ticks >= 10, "{} only ticked {} times", room.name, m.ticks);
            assert!(m.last_thread.starts_with(crate::sim::THREAD_PREFIX), "ran on {}", m.last_thread);
        }
        assert!(sim.snapshot().iter().filter(|t| t.ticks > 0).count() >= 2);
        for room in &rooms {
            let p = room.publish_metrics.lock().unwrap();
            assert!(p.ticks >= 10, "{} published {} frames", room.name, p.ticks);
            assert!(p.last_thread.starts_with(crate::sim::PUBLISH_PREFIX));
        }
        assert!(publish.snapshot().iter().any(|t| t.ticks > 0));
        drop(receivers);
    }

    #[tokio::test]
    async fn a_stalled_player_never_slows_the_game_loop_or_other_players() {
        let (_sim, _publish, registry) = pools(2, 2);
        let room = registry.create("Laggy", Pool::Direct, default_map()).await.unwrap();
        let (stuck_tx, _stuck_rx) = mpsc::channel(1);
        room.game.lock().await.add_player("stuck", "stuck", &kit(5, 5, 5));
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
        assert!(received >= 20, "healthy player kept receiving updates, got {received}");
        assert!(room.slow_client_retries.load(Ordering::Relaxed) >= 1);
    }

    #[tokio::test]
    async fn a_slow_state_provider_skips_frames_instead_of_delaying_the_game() {
        let db = memdb();
        let room = room("r", "R");
        let mut rx = connect(&room, "p1").await;
        let mut latest = None;
        for _ in 0..5 { latest = room.sim_tick().await; }
        room.publish_frame(latest.as_ref().unwrap(), &db).await;
        let first = room.sim_tick().await.unwrap();
        room.publish_frame(&first, &db).await;
        assert_eq!(room.metrics.lock().unwrap().ticks, 6);
        assert_eq!(room.publish_metrics.lock().unwrap().ticks, 2);
        assert_eq!(room.skipped_frames.load(Ordering::Relaxed), 0);
        for _ in 0..3 { latest = room.sim_tick().await; }
        room.publish_frame(latest.as_ref().unwrap(), &db).await;
        assert_eq!(room.skipped_frames.load(Ordering::Relaxed), 2);
        assert!(drain(&mut rx).iter().any(|m| m["type"] == "snapshot"));
    }

    #[tokio::test]
    async fn room_list_and_ops_read_cached_stats_without_the_game_lock() {
        let db = memdb();
        let room = room("r", "R");
        let _rx = connect(&room, "p1").await;
        room.tick(&db).await;
        let held = room.game.lock().await;
        let summary = tokio::time::timeout(Duration::from_millis(200), room.summary(None)).await
            .expect("room list must not wait for the game lock");
        let ops = tokio::time::timeout(Duration::from_millis(200), room.ops_snapshot()).await
            .expect("ops status must not wait for the game lock");
        drop(held);
        assert_eq!(summary["players"], 1);
        assert_eq!(ops["players"], 1);
        assert_eq!(ops["publish"]["count"], 1);
    }
}
