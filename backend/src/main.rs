mod types;
mod gear;
mod map;
mod spatial_grid;
mod navigation;
mod game;
mod delta;
mod social;
mod db;
mod rooms;
mod sim;
mod ops;
mod progression;
mod ratelimit;
mod mail;
mod auth;
mod buildinfo;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{State, Query, Path},
    response::{IntoResponse, Html},
    routing::{get, post},
    Json,
};
use futures::{SinkExt, StreamExt};
use tower_http::services::ServeDir;
use tokio::sync::mpsc;

use crate::types::*;
use crate::social::SocialState;
use crate::db::Database;
use crate::rooms::{Pool, RegistryConfig, RoomRegistry, OPEN_ROOM_ID};
use crate::sim::SimRuntime;

// Bounded channel: capacity = a few ticks of headroom.
// If a client falls behind, we skip deltas rather than buffer indefinitely.
const CLIENT_CHANNEL_CAPACITY: usize = 16;

struct AppState {
    rooms: Arc<RoomRegistry>,
    social: Mutex<SocialState>,
    db: Arc<Database>,
    google_client_id: String,
    google_client_secret: String,
    /// Steam sign-in attempts in flight: nonce -> (account to link to, if any; when it started).
    steam_logins: std::sync::Mutex<HashMap<String, (Option<String>, std::time::Instant)>>,
    limiter: Arc<ratelimit::RateLimiter>,
    mailer: mail::Mailer,
}

/// PvP (raidable operators, base raids) is off until it is built: `BOXHEAD_PVP=1` turns it on.
fn pvp_enabled() -> bool {
    static PVP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *PVP.get_or_init(|| std::env::var("BOXHEAD_PVP").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "on")))
}

#[tokio::main]
async fn main() {
    let build = buildinfo::get();
    println!("BoxHead server {}", build.label());
    let db_path = std::env::var("BOXHEAD_DB").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "boxhead.db".to_string());
    let db = Arc::new(Database::open(&db_path)
        .unwrap_or_else(|e| panic!("Failed to open database {db_path}: {e}")));
    // A raid interrupted by a restart is voided: everyone gets their loadout back.
    let voided = db.void_stale_raids();
    if voided > 0 { println!("Voided {voided} raid(s) interrupted by the last shutdown"); }

    let google_client_id = std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default();
    let google_client_secret = std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default();

    // Room game loops run in parallel on a dedicated simulation pool. Each room's
    // state provider (diff + serialize + send) runs on a separate publish pool, so
    // network work never lands on a game thread. Both are separate from the
    // runtime serving HTTP and WebSockets.
    let sim = Arc::new(SimRuntime::new(sim::THREAD_PREFIX, sim::threads_from_env()).expect("Failed to start simulation threads"));
    let publish = Arc::new(SimRuntime::new(sim::PUBLISH_PREFIX, sim::publish_threads_from_env()).expect("Failed to start state provider threads"));
    println!("Simulation pool: {} threads · State provider pool: {} threads", sim.size(), publish.size());
    let rooms = RoomRegistry::new(db.clone(), RegistryConfig {
        empty_ttl: rooms::empty_room_ttl_from_env(),
        max_rooms: rooms::max_rooms_from_env(),
        sim: sim.handle(),
        publish: publish.handle(),
    });
    rooms.start().await;

    let state = Arc::new(AppState {
        rooms,
        social: Mutex::new(SocialState::new()),
        db,
        google_client_id,
        google_client_secret,
        steam_logins: std::sync::Mutex::new(HashMap::new()),
        limiter: Arc::new(ratelimit::RateLimiter::from_env()),
        mailer: mail::Mailer::from_env(),
    });
    match std::env::var("BASE_URL") {
        Ok(base) => println!("Public address: {}", base.trim_end_matches('/')),
        Err(_) => println!("WARNING: BASE_URL is not set, so email and Steam links follow each request's Host header. Set it before letting the public in."),
    }
    if !pvp_enabled() { println!("PvP is off: new operators are Safe (set BOXHEAD_PVP=1 to allow Raidable)"); }
    if !build.notice.is_empty() { println!("Home screen notice: {}", build.notice); }
    if !build.feedback_url.is_empty() { println!("Feedback link: {}", build.feedback_url); }

    // Periodic cleanup: expired sessions, refilled rate-limit buckets.
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
        loop {
            interval.tick().await;
            let db = cleanup_state.db.clone();
            let _ = tokio::task::spawn_blocking(move || db.delete_expired_sessions()).await;
            cleanup_state.limiter.prune();
        }
    });

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    start_ops_api(&port, state.rooms.clone(), sim.clone(), publish.clone()).await;
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".to_string());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/ws/presence", get(presence_handler))
        .route("/api/rooms", get(rooms_list).post(rooms_create))
        .route("/api/matchmaking/crossplay", post(crossplay_set))
        .route("/api/hideout", get(hideout))
        .route("/api/hideout/{action}", post(hideout_action))
        .route("/api/maps", get(maps_list))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/email/register", post(auth::register))
        .route("/api/auth/email/login", post(auth::login))
        .route("/api/auth/email/confirm", get(auth::confirm))
        .route("/api/auth/email/resend", post(auth::resend))
        .route("/api/auth/password/forgot", post(auth::forgot))
        .route("/api/auth/password/reset", post(auth::reset))
        .route("/api/account/delete", post(auth::delete_account))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/steam/start", get(steam_start))
        .route("/api/auth/steam/callback", get(steam_callback))
        .route("/api/config", get(api_config))
        .route("/healthz", get(healthz))
        .route("/api/friends", get(friends_list))
        .route("/api/friends/add", post(friends_add))
        .route("/api/friends/remove", post(friends_remove))
        .fallback_service(ServeDir::new(static_dir))
        .layer(axum::middleware::from_fn_with_state(state.limiter.clone(), ratelimit::middleware))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();
    println!("Server listening on port {}", port);
    // Game traffic is many small messages: send them immediately (no Nagle delay).
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|tcp| { let _ = tcp.set_nodelay(true); });
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
}

/// Serve the internal ops API (for the dashboard service) on its own,
/// localhost-by-default address. Disabled unless `BOXHEAD_OPS_TOKEN` is set.
async fn start_ops_api(port: &str, rooms: Arc<RoomRegistry>, sim: Arc<SimRuntime>, publish: Arc<SimRuntime>) {
    let token = std::env::var("BOXHEAD_OPS_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        println!("Ops API disabled (set BOXHEAD_OPS_TOKEN to enable the dashboard)");
        return;
    }
    let addr = std::env::var("BOXHEAD_OPS_ADDR").unwrap_or_else(|_| ops::DEFAULT_OPS_ADDR.to_string());
    let server_id = std::env::var("BOXHEAD_SERVER_ID").unwrap_or_else(|_| format!("game-{port}"));
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) => panic!("Could not bind ops API on {addr}: {e}"),
    };
    println!("Ops API listening on {addr} as {server_id}");
    let app = ops::router(ops::OpsState::new(token.trim().to_string(), server_id, rooms, sim, publish));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Client messages are tiny (join, input, pause); refuse anything large.
    ws.max_message_size(16 * 1024).on_upgrade(move |socket| handle_socket(socket, state))
}

async fn send_join_error(ws_sender: &mut futures::stream::SplitSink<WebSocket, Message>, error: &str) {
    let msg = serde_json::json!({ "type": "joinError", "error": error }).to_string();
    let _ = ws_sender.send(Message::Text(msg.into())).await;
    let _ = ws_sender.send(Message::Close(None)).await;
}

/// Signed-in browser presence remains connected in the menus and hideout.
async fn presence_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.max_message_size(4096).on_upgrade(move |mut socket| async move {
        let first = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = first else { return };
        let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else { return };
        if message.msg_type != "presence" { return; }
        let token = message.token.unwrap_or_default();
        let (db, t) = (state.db.clone(), token.clone());
        let user = tokio::task::spawn_blocking(move || db.validate_session(&t)).await.ok().flatten();
        let Some(user) = user else {
            let _ = socket.send(Message::Text(serde_json::json!({"type": "presence", "ok": false}).to_string().into())).await;
            return;
        };
        let connection = format!("presence:{}", uuid::Uuid::new_v4());
        state.social.lock().await.link_account(&connection, &user);
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(20));
        let mut last_pong = tokio::time::Instant::now();
        loop {
            tokio::select! {
                next = socket.next() => {
                    match next {
                        Some(Ok(Message::Pong(_))) => last_pong = tokio::time::Instant::now(),
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
                _ = heartbeat.tick() => {
                    if last_pong.elapsed() > std::time::Duration::from_secs(45) { break; }
                    let (db, t) = (state.db.clone(), token.clone());
                    let valid = tokio::task::spawn_blocking(move || db.validate_session(&t)).await.ok().flatten().as_deref() == Some(user.as_str());
                    let reply = Message::Text(serde_json::json!({"type": "presence", "ok": valid}).to_string().into());
                    if !matches!(tokio::time::timeout(std::time::Duration::from_secs(5), socket.send(reply)).await, Ok(Ok(()))) || !valid { break; }
                    if !matches!(tokio::time::timeout(std::time::Duration::from_secs(5), socket.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
                }
            }
        }
        state.social.lock().await.unlink_player(&connection);
    })
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let player_id = uuid::Uuid::new_v4().to_string()[..8].to_string();

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Wait for the join message: target raid and account identity.
    // A socket that never says which raid it wants is dropped after 10 seconds.
    let join_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let (auth_token, room_id, insure) = loop {
        let next = match tokio::time::timeout_at(join_deadline, ws_receiver.next()).await {
            Ok(next) => next,
            Err(_) => return,
        };
        match next {
            Some(Ok(Message::Text(text))) => {
                let text_str: &str = &text;
                if let Ok(msg) = serde_json::from_str::<ClientMessage>(text_str) {
                    if msg.msg_type == "join" {
                        let room_id = msg.room_id.unwrap_or_else(|| OPEN_ROOM_ID.to_string());
                        break (msg.token, room_id, msg.insure.unwrap_or(false));
                    }
                }
            }
            Some(Ok(_)) => continue,
            _ => return,
        }
    };

    // Verification comes from the server-side session, never from the client.
    // (SQLite work runs on a blocking thread, never on the async runtime.)
    let (matchmaking, profile_key) = {
        let (db, token) = (state.db.clone(), auth_token.clone());
        tokio::task::spawn_blocking(move || {
            let mm = token.as_deref().and_then(|t| db.session_matchmaking(t));
            let key = db.profile_key(token.as_deref());
            (mm, key)
        }).await.unwrap_or((None, None))
    };
    let user_id = matchmaking.as_ref().map(|(id, _, _)| id.clone());
    let pool = matchmaking.as_ref().map(|(_, platform, cross)| Pool::for_player(platform, *cross));

    // Only signed-in accounts can drop in, and only as one of their operators.
    if user_id.is_none() {
        send_join_error(&mut ws_sender, "Sign in to play. Your stash lives on your account.").await;
        return;
    }
    if let Some(why) = auth::email_gate(&state, user_id.as_deref().unwrap_or_default()).await {
        send_join_error(&mut ws_sender, &why).await;
        return;
    }
    if profile_key.is_none() {
        send_join_error(&mut ws_sender, "Create an operator in the hideout before you deploy.").await;
        return;
    }
    let Some(pool) = pool else { return };
    let Some(room) = state.rooms.resolve(&room_id, pool).await else {
        send_join_error(&mut ws_sender, "That raid no longer exists.").await;
        return;
    };
    if room.pool != pool {
        send_join_error(&mut ws_sender, &pool_mismatch(room.pool, pool)).await;
        return;
    }
    let Some(profile) = profile_key else { return };
    // Gear score gate + lock the loadout into this raid (blocking DB work off the async thread).
    let begin = {
        let (db, profile, room_id, map) = (state.db.clone(), profile.clone(), room.id.clone(), room.map);
        tokio::task::spawn_blocking(move || db.deploy_named(&profile, &room_id, map, insure)).await
            .unwrap_or_else(|_| Err("Server error".into()))
    };
    let (loadout, player_name) = match begin {
        Ok(loadout) => loadout,
        Err(e) => { send_join_error(&mut ws_sender, &e).await; return; }
    };
    // Sealed items brought from the stash to decrypt in this raid.
    let carried = {
        let (db, profile) = (state.db.clone(), profile.clone());
        tokio::task::spawn_blocking(move || db.raid_carry(&profile)).await.unwrap_or_default()
    };

    // Bounded channel — drops deltas for slow clients instead of buffering
    let (tx, mut rx) = mpsc::channel::<String>(CLIENT_CHANNEL_CAPACITY);
    let init_str = {
        let mut game = room.game.lock().await;
        game.add_player_carrying(&player_id, &player_name, &loadout, carried);
        room.raid_profiles.lock().await.insert(player_id.clone(), profile.clone());
        let layout = game.layout();
        let init = InitPayload {
            msg_type: "init".to_string(),
            id: player_id.clone(),
            map: game.map_info(),
            walls: layout.walls.clone(),
            map_width: layout.width,
            map_height: layout.height,
            ammo_spawn_points: game.ammo_spawn_points(),
            extracts: layout.extracts.clone(),
            crates: layout.crates.clone(),
            nests: layout.nests.clone(),
            uplinks: layout.uplinks.clone(),
        };
        serde_json::to_string(&init).unwrap()
    };
    // Mark the snapshot as owed before the client can receive anything, so its
    // first state message is always a full snapshot, never a partial delta.
    room.pending_snapshots.lock().await.insert(player_id.clone());
    // Queue init first so it reaches the socket before any delta or snapshot.
    // Nothing is sent on the socket while the game lock is held, so a client
    // that stops reading can never stall the room's game loop.
    let _ = tx.try_send(init_str);
    room.clients.lock().await.insert(player_id.clone(), tx);

    if let Some(ref user_id) = user_id {
        state.social.lock().await.link_player(&player_id, user_id, &profile);
    }

    let pid_send = player_id.clone();
    let pid_recv = player_id.clone();
    let room_recv = room.clone();

    // Forward channel messages to the WebSocket. The channel closes when the
    // room drops this player's sender (after their raid result is sent).
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_sender.send(Message::Close(None)).await;
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            if let Message::Text(text) = msg {
                let text_str: &str = &text;
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(text_str) {
                    if client_msg.msg_type == "pause" {
                        if let Some(paused) = client_msg.paused {
                            room_recv.game.lock().await.set_paused(&pid_recv, paused);
                        }
                    } else if client_msg.msg_type == "input" {
                        if let Some(input) = client_msg.input {
                            room_recv.game.lock().await.handle_input(&pid_recv, input);
                        }
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => { recv_task.abort(); }
        _ = &mut recv_task => {}
    }

    // Leaving mid-raid forfeits it. If the raid already ended the game has no
    // record of the player and the room has settled it.
    let departure = room.leave(&pid_send).await;
    state.social.lock().await.unlink_player(&pid_send);
    match departure {
        Some(rooms::Departure::Abandoned(outcome, profile)) => {
            rooms::settle_with_retry(state.db.clone(), profile, room.id.clone(), outcome).await;
        }
        Some(rooms::Departure::NeverPlayed(profile)) => {
            // Your gear is safe and unused insurance is paid back, but the entry fee
            // isn't refunded: the snapshot you received already showed the whole raid.
            let (db, room_id) = (state.db.clone(), room.id.clone());
            let _ = tokio::task::spawn_blocking(move || db.void_raid(&profile, &room_id, false)).await;
        }
        None => {}
    }
    // Let the forwarder flush a final raid result if one is in flight.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), send_task).await;
}

// --- Rooms API ---

async fn rooms_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let mm = session_pool(&state, params.get("token").map(String::as_str).unwrap_or("")).await;
    let pool = mm.as_ref().map(|m| m.pool);
    // Signed-out visitors can look at the cross-platform raids but not join.
    let mut rooms = Vec::new();
    for room in state.rooms.in_pool(pool.unwrap_or(Pool::Cross)).await {
        rooms.push(room.summary(pool).await);
    }
    Json(serde_json::json!({
        "ok": true,
        "verified": mm.is_some(),
        "rooms": rooms,
        "matchmaking": mm.map(|m| m.json()),
    }))
}

/// How one signed-in session matchmakes.
struct SessionPool { user_id: String, platform: Pool, crossplay: bool, pool: Pool }

impl SessionPool {
    fn json(&self) -> serde_json::Value {
        serde_json::json!({ "platform": self.platform.json(), "crossplay": self.crossplay, "pool": self.pool.json() })
    }
}

async fn session_pool(state: &Arc<AppState>, token: &str) -> Option<SessionPool> {
    let (db, token) = (state.db.clone(), token.to_string());
    let (user_id, platform, crossplay) = tokio::task::spawn_blocking(move || db.session_matchmaking(&token)).await.ok()??;
    Some(SessionPool {
        user_id,
        platform: Pool::for_player(&platform, false),
        crossplay,
        pool: Pool::for_player(&platform, crossplay),
    })
}

/// Why a player can't join a raid in another matchmaking pool, and how to fix it.
fn pool_mismatch(room: Pool, player: Pool) -> String {
    match (room, player) {
        (Pool::Cross, _) => "That raid is cross-platform. Turn on cross-platform play to join it.".into(),
        (_, Pool::Cross) => format!("That raid is for {} players only. Turn off cross-platform play to join it.", room.label()),
        _ => format!("That raid is for {} players only. Turn on cross-platform play to meet players from other platforms.", room.label()),
    }
}

/// Turn cross-platform matchmaking on or off for the signed-in account.
async fn crossplay_set(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let token = body["token"].as_str().unwrap_or("");
    let Some(mm) = session_pool(&state, token).await else {
        return Json(serde_json::json!({ "ok": false, "error": "Sign in to change matchmaking" }));
    };
    let Some(on) = body["enabled"].as_bool() else {
        return Json(serde_json::json!({ "ok": false, "error": "Say whether cross-platform play is on" }));
    };
    let (db, user) = (state.db.clone(), mm.user_id.clone());
    if let Err(e) = tokio::task::spawn_blocking(move || db.set_crossplay(&user, on)).await.unwrap_or_else(|_| Err("Server error".into())) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    let mm = SessionPool { pool: if on { Pool::Cross } else { mm.platform }, crossplay: on, ..mm };
    Json(serde_json::json!({ "ok": true, "matchmaking": mm.json() }))
}

async fn rooms_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(mm) = session_pool(&state, body["token"].as_str().unwrap_or("")).await else {
        return Json(serde_json::json!({ "ok": false, "error": "Sign in to host a lobby" }));
    };
    if let Some(why) = auth::email_gate(&state, &mm.user_id).await {
        return Json(serde_json::json!({ "ok": false, "error": why }));
    }
    let Some(map) = body["map"].as_str().map_or(Some(gear::default_map()), gear::map_by_id) else {
        return Json(serde_json::json!({ "ok": false, "error": "Unknown map" }));
    };
    // A hosted lobby is in its host's pool: only players who matchmake with them can join.
    match state.rooms.create(body["name"].as_str().unwrap_or(""), mm.pool, map).await {
        Ok(room) => Json(serde_json::json!({ "ok": true, "room": room.summary(Some(mm.pool)).await })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// --- Hideout API (stash, loadout, trader, maps) ---

fn maps_json(gear_score: u32, operations: &[serde_json::Value]) -> serde_json::Value {
    serde_json::Value::Array(gear::MAPS.iter().map(|m| {
        let ops = operations.iter().find(|o| o["map"] == m.id);
        serde_json::json!({
        "id": m.id, "name": m.name, "tier": m.tier, "minGearScore": m.min_gear_score,
        "threat": m.threat(), "blurb": m.blurb, "raidSecs": m.raid_secs,
        "lootPower": [m.loot_power.0, m.loot_power.1], "width": m.width(), "height": m.height(),
        "enemyHealth": m.enemy_health, "enemyDamage": m.enemy_damage, "eliteChance": m.elite_chance,
        "entryFee": ops.map_or(serde_json::json!(m.entry_fee), |o| o["entryFee"].clone()),
        "baseEntryFee": m.entry_fee,
        "opsRank": ops.map_or(serde_json::json!(0), |o| o["rank"].clone()),
        "unlocked": gear::can_deploy(m, gear_score),
    })}).collect())
}

fn operator_json(db: &Database, profile: &str, now: i64) -> serde_json::Value {
    let Some(op) = db.operator(profile) else { return serde_json::Value::Null };
    let ctx = db.context(profile, now);
    let mut loadout = op.loadout();
    loadout.boost = ctx.raid_boost();
    let gs = loadout.gear_score();
    let stash: Vec<&gear::Item> = op.items.iter().filter(|s| s.slot.is_none()).map(|s| &s.item).collect();
    let cap = progression::tier_cap(op.raidable);
    let next_tier = progression::tier_cost(op.tier + 1).filter(|c| c.tier <= cap);
    let tier_items = db.tier_valuables(profile);
    let facilities: Vec<serde_json::Value> = progression::FACILITIES.iter().map(|&f| {
        let level = ctx.facility(f);
        // Levels past this operator's top tier can never be built, so they aren't offered.
        let next = (level < cap).then_some(level + 1);
        serde_json::json!({
            "id": f.as_str(), "name": f.label(), "level": level, "maxLevel": op.tier,
            "effect": f.effect(level),
            "next": next.map(|n| serde_json::json!({ "level": n, "cost": f.cost(n), "effect": f.effect(n), "needsTier": n > op.tier })),
        })
    }).collect();
    let operations: Vec<serde_json::Value> = db.operations(profile).into_iter().map(|(m, xp)| {
        let rank = progression::ops_rank(xp);
        serde_json::json!({
            "map": m.id, "name": m.name, "xp": xp, "rank": rank, "maxRank": progression::MAX_OPS_RANK,
            "next": progression::ops_next(xp), "prev": rank.checked_sub(1).map_or(0, |r| progression::OPS_THRESHOLDS[r as usize]),
            "entryFee": progression::ops_fee(m, rank), "baseEntryFee": m.entry_fee,
            "bountyBonus": progression::ops_bounty_bonus(rank),
        })
    }).collect();
    serde_json::json!({
        "id": op.id, "friendId": op.friend_id, "name": op.name, "raidable": op.raidable,
        "carryCapacity": loadout.pack.as_ref().map_or(gear::NO_PACK_CAPACITY, |p| gear::pack_capacity(p.power)),
        "cash": op.cash, "raids": op.raids, "extracts": op.extracts, "deaths": op.deaths,
        "inRaid": op.in_raid.is_some(),
        "gearScore": gs,
        "loadout": loadout,
        "boost": { "maxHealth": loadout.boost.max_health, "damage": loadout.boost.damage },
        "stash": stash,
        "carry": op.items.iter().filter(|s| s.carry).map(|s| s.item.id.clone()).collect::<Vec<_>>(),
        "stashCapacity": ctx.stash_capacity(),
        "insuranceCost": gear::insurance_cost_at(&loadout, ctx.insurance_rate()),
        "insuranceRate": ctx.insurance_rate(),
        "offers": gear::trader_offers_with(ctx.armory_powers()),
        "maps": maps_json(gs, &operations),
        "operations": operations,
        "homefront": {
            "tier": op.tier, "maxTier": cap, "topTier": progression::MAX_TIER, "safeTier": progression::SAFE_TIER_CAP,
            "next": next_tier.map(|c| serde_json::json!({
                "tier": c.tier, "cash": c.cash, "valuables": c.valuables, "minRarity": c.min_rarity,
                "have": tier_items.len(), "uses": tier_items,
            })),
            "facilities": facilities,
            "workshop": {
                "stored": ctx.workshop_stored(now),
                "perHour": progression::workshop_rate(ctx.facility(progression::Facility::Workshop)),
                "capacity": progression::workshop_rate(ctx.facility(progression::Facility::Workshop)) * progression::WORKSHOP_HOURS,
            },
        },
    })
}

/// The hideout: the account (operators, season, Legacy) and the active operator.
fn hideout_json(db: &Database, user: &str) -> serde_json::Value {
    let now = db::now_secs();
    let season = progression::season_at(now);
    let account = db.account_state(user);
    let active = db.active_operator(user);
    let operator = active.as_deref().map_or(serde_json::Value::Null, |p| operator_json(db, p, now));
    let perks: Vec<serde_json::Value> = progression::PERKS.iter().map(|&p| serde_json::json!({
        "id": p.as_str(), "name": p.label(), "perRank": p.per_rank(), "rank": account.perks.get(p), "maxRank": progression::PERK_MAX_RANK,
    })).collect();
    let mut out = serde_json::json!({
        "ok": true,
        "account": true,
        "accountId": user,
        "operators": db.operator_summaries(user),
        "maxOperators": progression::MAX_OPERATORS,
        "needsOperator": active.is_none(),
        "season": {
            "id": season.id, "name": season.name, "endsAt": season.ends_at,
            "relocationOpensAt": season.relocation_opens_at, "relocationOpen": season.relocation_open(now),
            "now": now,
        },
        "legacy": {
            "earned": account.legacy_earned, "available": account.legacy_available, "cap": progression::LEGACY_CAP,
            "stashBonus": account.stash_bonus, "stashBonusCap": progression::STASH_BONUS_CAP,
            "relocations": account.relocations, "lastRelocation": account.last_relocation,
            "boostLevel": if account.boost_season.as_deref() == Some(season.id.as_str()) { account.boost_level } else { 0 },
            "badges": account.badges, "perks": perks,
        },
        "relocation": {
            "minTier": progression::RELOCATION_MIN_TIER,
            "blocker": db.relocation_blocker(user, now),
            "reward": db.relocation_preview(user, now),
        },
        "operator": operator.clone(),
    });
    // The active operator's fields also sit at the top level, where the
    // hideout screens have always read them.
    if let (Some(top), Some(op)) = (out.as_object_mut(), operator.as_object()) {
        for (k, v) in op { if !top.contains_key(k) { top.insert(k.clone(), v.clone()); } }
    }
    if active.is_none() {
        // No operator yet: empty defaults, so every screen still renders.
        let defaults = serde_json::json!({
            "cash": 0, "raids": 0, "extracts": 0, "deaths": 0, "inRaid": false, "gearScore": 0,
            "loadout": gear::Loadout::default(), "stash": [], "carry": [], "carryCapacity": 0,
            "stashCapacity": gear::STASH_CAPACITY, "insuranceCost": 0, "offers": [], "operations": [],
            "maps": maps_json(0, &[]),
        });
        if let (Some(top), Some(d)) = (out.as_object_mut(), defaults.as_object()) {
            for (k, v) in d { top.insert(k.clone(), v.clone()); }
        }
    }
    out["pvpEnabled"] = pvp_enabled().into();
    out
}

fn request_user(state: &AppState, token: Option<&str>) -> Result<String, Json<serde_json::Value>> {
    token.filter(|t| !t.is_empty()).and_then(|t| state.db.validate_session(t))
        .ok_or_else(|| Json(serde_json::json!({ "ok": false, "signedOut": true, "error": "Sign in to open your hideout" })))
}

async fn hideout(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let user = match request_user(&state, params.get("token").map(String::as_str)) {
        Ok(u) => u,
        Err(e) => return e,
    };
    let db = state.db.clone();
    Json(tokio::task::spawn_blocking(move || hideout_json(&db, &user)).await.unwrap_or_default())
}

/// POST /api/hideout/{action}: equip, unequip, sell or buy. Replies with the new hideout state.
async fn hideout_action(
    State(state): State<Arc<AppState>>,
    Path(action): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let user = match request_user(&state, body["token"].as_str()) {
        Ok(u) => u,
        Err(e) => return e,
    };
    let db = state.db.clone();
    Json(tokio::task::spawn_blocking(move || {
        let now = db::now_secs();
        let slot = body["slot"].as_str().and_then(gear::Slot::parse);
        let item = body["itemId"].as_str().unwrap_or("");
        // Account actions work with or without an operator.
        let account_result = match action.as_str() {
            "createOperator" => Some(match body["raidable"].as_bool().unwrap_or(false) {
                true if !pvp_enabled() => Err("Raidable operators arrive with PvP. For now every new operator is Safe.".into()),
                raidable => db.create_operator(&user, body["name"].as_str().unwrap_or(""), raidable, now).map(|_| ()),
            }),
            "switchOperator" => Some(db.switch_operator(&user, body["operatorId"].as_str().unwrap_or(""))),
            "deleteOperator" => Some(if body["confirm"].as_bool() == Some(true) {
                db.delete_operator(&user, body["operatorId"].as_str().unwrap_or("")).map(|_| ())
            } else { Err("Confirm the deletion".into()) }),
            "relocate" => Some(if body["confirm"].as_bool() == Some(true) { db.relocate(&user, now).map(|_| ()) } else { Err("Confirm the retirement".into()) }),
            "buyPerk" => Some(match body["perk"].as_str().and_then(progression::Perk::parse) {
                Some(perk) => db.buy_perk(&user, perk).map(|_| ()),
                None => Err("Unknown perk".into()),
            }),
            _ => None,
        };
        let result = if let Some(r) = account_result { r } else {
        let Some(profile) = db.active_operator(&user) else {
            let mut state = hideout_json(&db, &user);
            state["ok"] = false.into();
            state["error"] = "Create an operator first.".into();
            return state;
        };
        match (action.as_str(), slot) {
            ("upgradeTier", _) => db.upgrade_tier(&profile).map(|_| ()),
            ("upgradeFacility", _) => match body["facility"].as_str().and_then(progression::Facility::parse) {
                Some(f) => db.upgrade_facility(&profile, f, now).map(|_| ()),
                None => Err("Unknown facility".into()),
            },
            ("collectWorkshop", _) => db.collect_workshop(&profile, now).map(|_| ()),
            ("equip", Some(slot)) => db.equip(&profile, item, slot),
            ("unequip", Some(slot)) => db.unequip(&profile, slot),
            ("sell", _) => db.sell(&profile, item).map(|_| ()),
            ("buy", _) => db.buy(&profile, body["offerId"].as_str().unwrap_or("")).map(|_| ()),
            ("sellMany", _) => {
                let ids: Vec<String> = body["itemIds"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                db.sell_many(&profile, &ids).map(|_| ())
            }
            ("carry", _) => db.set_carry(&profile, item, body["carry"].as_bool().unwrap_or(true)),
            ("equip" | "unequip", None) => Err("Pick a slot: primary, secondary, armor or pack".into()),
            _ => Err("Unknown action".into()),
        }
        };
        match result {
            Ok(()) => hideout_json(&db, &user),
            Err(e) => {
                let mut state = hideout_json(&db, &user);
                state["ok"] = false.into();
                state["error"] = e.into();
                state
            }
        }
    }).await.unwrap_or_default())
}

/// GET /healthz: 200 when the server and its database answer (for uptime checks).
async fn healthz(State(state): State<Arc<AppState>>) -> axum::response::Response {
    let db = state.db.clone();
    match tokio::task::spawn_blocking(move || db.ping()).await {
        Ok(true) => "ok".into_response(),
        _ => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "database unavailable").into_response(),
    }
}

async fn maps_list() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "maps": maps_json(0, &[]) }))
}

// --- Config API ---

async fn api_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let build = buildinfo::get();
    Json(serde_json::json!({
        "google_client_id": state.google_client_id,
        "pvp": pvp_enabled(),
        "minPassword": auth::MIN_PASSWORD,
        "version": buildinfo::VERSION,
        "build": build.build,
        "feedbackUrl": build.feedback_url,
        "notice": build.notice,
    }))
}

// --- Auth & Friends API ---

async fn auth_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let handle = body["handle"].as_str().unwrap_or("");
    let password = body["password"].as_str().unwrap_or("");

    if handle.is_empty() || password.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "Handle and app password required" }));
    }

    match social::bsky_login(handle, password).await {
        Ok(session) => {
            // Signed in already: attach this Bluesky identity to that account.
            if let Some(user_id) = body["token"].as_str().filter(|t| !t.is_empty()).and_then(|t| state.db.validate_session(t)) {
                return Json(match state.db.link_account(&user_id, "bluesky", &session.did, &session.handle) {
                    Ok(()) => serde_json::json!({ "ok": true, "linked": "bluesky", "handle": session.handle }),
                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                });
            }
            // Find or create internal user account linked to this Bluesky DID
            let user_id = match state.db.find_or_create_user(
                "bluesky",
                &session.did,
                &session.handle,
                &session.handle,
            ) {
                Ok(id) => id,
                Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
            };

            let token = match state.db.create_session(&user_id, "bluesky") {
                Ok(t) => t,
                Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
            };

            Json(serde_json::json!({
                "ok": true,
                "token": token,
                "user_id": user_id,
                "handle": session.handle,
                "display_name": session.handle,
                "verified": true,
            }))
        }
        Err(e) => {
            Json(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

/// Google OAuth callback — receives auth code, exchanges for user info,
/// creates/finds user, creates session, returns HTML that messages the opener.
async fn google_callback(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Html<String> {
    let code = match params.get("code") {
        Some(c) => c.clone(),
        None => {
            return Html("<html><body><script>window.close();</script>Error: no code</body></html>".to_string());
        }
    };

    if state.google_client_id.is_empty() || state.google_client_secret.is_empty() {
        return Html("<html><body><script>window.close();</script>Error: Google OAuth not configured</body></html>".to_string());
    }

    // Build redirect_uri from the request (same as what the frontend used)
    let redirect_uri = params.get("redirect_uri").cloned()
        .unwrap_or_else(|| format!("{}/api/auth/google/callback",
            std::env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:3001".to_string())
        ));

    let result = social::google_token_exchange(
        &code,
        &state.google_client_id,
        &state.google_client_secret,
        &redirect_uri,
    ).await;

    match result {
        Ok(info) => {
            let display_name = if info.name.is_empty() { info.email.clone() } else { info.name.clone() };
            let db = state.db.clone();
            let payload = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
                let user_id = db.find_or_create_user("google", &info.sub, &info.email, &display_name)?;
                let token = db.create_session(&user_id, "direct")?;
                Ok(serde_json::json!({ "ok": true, "token": token, "user_id": user_id, "handle": info.email, "display_name": display_name, "verified": true }))
            }).await.unwrap_or_else(|_| Err("Server error".into()));
            match payload {
                Ok(p) => Html(auth_popup_html("google-auth", &p)),
                Err(e) => Html(auth_popup_html("google-auth", &serde_json::json!({ "ok": false, "error": e }))),
            }
        }
        Err(e) => Html(auth_popup_html("google-auth", &serde_json::json!({ "ok": false, "error": e }))),
    }
}

/// Get current user info from session token
async fn auth_me(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");

    let (db, t) = (state.db.clone(), token.to_string());
    let info = tokio::task::spawn_blocking(move || {
        let user_id = db.validate_session(&t)?;
        let user = db.get_user(&user_id)?;
        let handle = db.get_user_handle(&user_id).unwrap_or_default();
        let linked: Vec<serde_json::Value> = db.linked_accounts(&user_id).into_iter()
            .map(|(provider, handle)| serde_json::json!({ "provider": provider, "handle": handle })).collect();
        let unconfirmed = db.unconfirmed_email(&user_id);
        let email = db.account_email(&user_id).map(|(e, _)| e);
        Some(serde_json::json!({
            "ok": true,
            "user_id": user.id,
            "display_name": user.display_name,
            "handle": handle,
            "verified": unconfirmed.is_none(),
            "linked": linked,
            "email": email,
            "emailUnconfirmed": unconfirmed,
        }))
    }).await.ok().flatten();
    let Some(mut info) = info else {
        return Json(serde_json::json!({ "ok": false, "error": "Not authenticated" }));
    };
    info["matchmaking"] = session_pool(&state, token).await.map(|m| m.json()).into();
    Json(info)
}

// --- Steam (OpenID 2.0) ---

const STEAM_OPENID: &str = "https://steamcommunity.com/openid/login";

/// The site's own origin, for Steam's return address: BASE_URL if set, else the request's Host.
fn site_origin(headers: &axum::http::HeaderMap) -> String {
    if let Ok(base) = std::env::var("BASE_URL") { return base.trim_end_matches('/').to_string(); }
    let host = headers.get(axum::http::header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost:3001");
    format!("http://{host}")
}

/// GET /api/auth/steam/start[?link=<session>]: send the browser to Steam's sign-in page.
/// With a session token the Steam identity is linked to that account instead.
async fn steam_start(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    let link_to = match params.get("link").filter(|t| !t.is_empty()) {
        Some(token) => match state.db.validate_session(token) {
            Some(user) => Some(user),
            None => return Html(auth_popup_html("steam-auth", &serde_json::json!({ "ok": false, "error": "Your session expired. Sign in again." }))).into_response(),
        },
        None => None,
    };
    let nonce = uuid::Uuid::new_v4().to_string();
    {
        let mut logins = state.steam_logins.lock().unwrap();
        logins.retain(|_, (_, at)| at.elapsed() < std::time::Duration::from_secs(600));
        logins.insert(nonce.clone(), (link_to, std::time::Instant::now()));
    }
    let origin = site_origin(&headers);
    let return_to = format!("{origin}/api/auth/steam/callback?nonce={nonce}");
    let query = [
        ("openid.ns", "http://specs.openid.net/auth/2.0"),
        ("openid.mode", "checkid_setup"),
        ("openid.return_to", return_to.as_str()),
        ("openid.realm", origin.as_str()),
        ("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select"),
        ("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select"),
    ];
    let url = reqwest::Url::parse_with_params(STEAM_OPENID, &query).expect("valid Steam URL");
    axum::response::Redirect::to(url.as_str()).into_response()
}

/// Steam sends the browser back here. Verify the assertion with Steam, then
/// sign in (or link) the account that owns this SteamID.
async fn steam_callback(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Html<String> {
    let fail = |e: &str| Html(auth_popup_html("steam-auth", &serde_json::json!({ "ok": false, "error": e })));
    let Some(nonce) = params.get("nonce") else { return fail("Steam sign-in didn't come from this site.") };
    let Some((link_to, _)) = state.steam_logins.lock().unwrap().remove(nonce) else {
        return fail("That Steam sign-in expired. Try again.");
    };
    if params.get("openid.mode").map(String::as_str) != Some("id_res") { return fail("Steam sign-in was cancelled."); }
    let expected_return = format!("{}/api/auth/steam/callback?nonce={nonce}", site_origin(&headers));
    if params.get("openid.return_to") != Some(&expected_return) || params.get("openid.op_endpoint").map(String::as_str) != Some(STEAM_OPENID) {
        return fail("Steam sign-in didn't match this site.");
    }
    let steam_id = match params.get("openid.claimed_id").and_then(|c| c.strip_prefix("https://steamcommunity.com/openid/id/")) {
        Some(id) if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) => id.to_string(),
        _ => return fail("Steam didn't say which account signed in."),
    };
    if let Err(e) = social::steam_verify(&params).await { return fail(&e); }
    let name = social::steam_persona(&steam_id).await.unwrap_or_else(|| format!("Steam {}", &steam_id[steam_id.len().saturating_sub(4)..]));

    let db = state.db.clone();
    let payload = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        if let Some(user_id) = link_to {
            db.link_account(&user_id, "steam", &steam_id, &name)?;
            return Ok(serde_json::json!({ "ok": true, "linked": "steam", "handle": name }));
        }
        let user_id = db.find_or_create_user("steam", &steam_id, &name, &name)?;
        let token = db.create_session(&user_id, "steam")?;
        Ok(serde_json::json!({ "ok": true, "token": token, "user_id": user_id, "handle": name, "display_name": name, "verified": true }))
    }).await.unwrap_or_else(|_| Err("Server error".into()));
    match payload {
        Ok(p) => Html(auth_popup_html("steam-auth", &p)),
        Err(e) => fail(&e),
    }
}

/// A page that hands a sign-in result back to the game window (popup), or
/// stores it and returns to the game when opened in the same tab.
fn auth_popup_html(kind: &str, payload: &serde_json::Value) -> String {
    let mut msg = payload.clone();
    msg["type"] = kind.into();
    // JSON inside a script: escape '<' so the payload can never close the tag.
    let json = msg.to_string().replace('<', "\\u003c");
    let ok = payload["ok"].as_bool().unwrap_or(false);
    let text = if ok { "Signed in! This window will close automatically.".to_string() } else { format!("Sign-in failed: {}", payload["error"].as_str().unwrap_or("unknown error")) };
    let text = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>BoxHead sign-in</title></head>
<body style="background:#0b0d12;color:#e7e9ee;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>{text}</p>
<script>
const msg = {json};
if (window.opener) {{
  window.opener.postMessage(msg, window.location.origin);
  setTimeout(() => window.close(), msg.ok ? 600 : 3000);
}} else {{
  try {{ localStorage.setItem('boxhead_pending_auth', JSON.stringify(msg)); }} catch (e) {{}}
  setTimeout(() => {{ window.location.href = '/'; }}, msg.ok ? 300 : 3000);
}}
</script></body></html>"#)
}

async fn friends_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let token = params.get("token").cloned().unwrap_or_default();
    let presence = state.social.lock().await.clone();
    let db = state.db.clone();
    Json(tokio::task::spawn_blocking(move || {
        let Some(user) = db.validate_session(&token) else {
            return serde_json::json!({"ok": false, "error": "Not authenticated"});
        };
        let identity = |owner: &str| {
            let id = presence.raid_operator(owner).map(String::from).or_else(|| db.active_operator(owner))?;
            let op = db.operator(&id)?;
            Some(social::OperatorIdentity { id: op.friend_id, name: op.name })
        };
        let activity = |owner: &str, online: bool| {
            if !online { "offline" } else if presence.raid_operator(owner).is_some() { "raid" } else { "hideout" }
        };
        let mut friends: Vec<social::FriendStatus> = db.get_friends(&user).into_iter().map(|f| {
            let online = presence.is_online(&f.user_id);
            social::FriendStatus::Account {
                operator: if online { identity(&f.user_id) } else { None },
                activity: activity(&f.user_id, online), online, id: f.user_id,
            }
        }).collect();
        for f in db.get_operator_friends(&user) {
            let online = presence.is_online(&f.account) && identity(&f.account).is_some_and(|op| op.id == f.id);
            friends.push(social::FriendStatus::Operator {
                activity: activity(&f.account, online), online, id: f.id, name: f.name,
            });
        }
        serde_json::json!({"ok": true, "friends": friends, "identity": {"accountId": user, "operator": identity(&user)}})
    }).await.unwrap_or_else(|_| serde_json::json!({"ok": false, "error": "Could not load friends"})))
}

async fn friends_add(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    change_friend(state, body, true).await
}

async fn friends_remove(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    change_friend(state, body, false).await
}

async fn change_friend(state: Arc<AppState>, body: serde_json::Value, add: bool) -> Json<serde_json::Value> {
    let db = state.db.clone();
    Json(tokio::task::spawn_blocking(move || {
        let Some(user) = db.validate_session(body["token"].as_str().unwrap_or("")) else {
            return serde_json::json!({"ok": false, "error": "Not authenticated"});
        };
        let id = body["id"].as_str().or_else(|| body["user_id"].as_str()).or_else(|| body["handle"].as_str()).unwrap_or("").trim();
        if id.is_empty() { return serde_json::json!({"ok": false, "error": "Enter an account ID or operator ID"}); }
        let kind = body["kind"].as_str().unwrap_or("account");
        let result = match kind {
            "account" if add => db.add_friend(&user, id),
            "account" => db.remove_friend(&user, id),
            "operator" => db.change_operator_friend(&user, id, add),
            _ => Err("Choose account or operator friendship".into()),
        };
        match result {
            Ok(()) => serde_json::json!({"ok": true}),
            Err(e) => serde_json::json!({"ok": false, "error": e}),
        }
    }).await.unwrap_or_else(|_| serde_json::json!({"ok": false, "error": "Could not update friends"})))
}
