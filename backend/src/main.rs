mod types;
mod map;
mod spatial_grid;
mod game;
mod delta;
mod social;
mod db;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::{IntoResponse, Html},
    routing::{get, post},
    Json,
};
use futures::{SinkExt, StreamExt};
use tower_http::services::ServeDir;
use tokio::sync::mpsc;

use crate::types::*;
use crate::game::Game;
use crate::delta::DeltaTracker;
use crate::social::SocialState;
use crate::db::Database;

// Bounded channel: capacity = a few ticks of headroom.
// If a client falls behind, we skip deltas rather than buffer indefinitely.
const CLIENT_CHANNEL_CAPACITY: usize = 4;

type ClientSender = mpsc::Sender<String>;

struct AppState {
    game: Mutex<Game>,
    delta_tracker: Mutex<DeltaTracker>,
    clients: Mutex<HashMap<String, ClientSender>>,
    pending_snapshots: Mutex<HashSet<String>>,
    social: Mutex<SocialState>,
    db: Database,
    google_client_id: String,
    google_client_secret: String,
}

#[tokio::main]
async fn main() {
    let db = Database::open("boxhead.db")
        .expect("Failed to open database");

    let google_client_id = std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default();
    let google_client_secret = std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default();

    let state = Arc::new(AppState {
        game: Mutex::new(Game::new()),
        delta_tracker: Mutex::new(DeltaTracker::new()),
        clients: Mutex::new(HashMap::new()),
        pending_snapshots: Mutex::new(HashSet::new()),
        social: Mutex::new(SocialState::new()),
        db,
        google_client_id,
        google_client_secret,
    });

    // Periodic session cleanup (every hour)
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            cleanup_state.db.delete_expired_sessions();
        }
    });

    // 60 Hz physics + adaptive-rate network broadcast (up to 60 Hz per client)
    let tick_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(16));
        loop {
            interval.tick().await;
            tick(&tick_state).await;
        }
    });

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".to_string());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/admin", get(admin_panel))
        .route("/admin/restart", post(admin_restart))
        .route("/admin/status", get(admin_status))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/email/register", post(email_register))
        .route("/api/auth/email/login", post(email_login))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/api/auth/me", get(auth_me))
        .route("/api/config", get(api_config))
        .route("/api/friends", get(friends_list))
        .route("/api/friends/add", post(friends_add))
        .route("/api/friends/remove", post(friends_remove))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();
    println!("Server listening on port {}", port);
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let player_id = uuid::Uuid::new_v4().to_string()[..8].to_string();

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Wait for join message with player name and optional auth token
    let (player_name, auth_token) = loop {
        match ws_receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                let text_str: &str = &text;
                if let Ok(msg) = serde_json::from_str::<ClientMessage>(text_str) {
                    if msg.msg_type == "join" {
                        let name = msg.name.unwrap_or_default();
                        let name = name.trim().chars().take(16).collect::<String>();
                        let name = if name.is_empty() { format!("Player_{}", &player_id[..4]) } else { name };
                        break (name, msg.token);
                    }
                }
            }
            Some(Ok(_)) => continue,
            _ => return,
        }
    };

    // Link player to auth identity if they have a valid session
    if let Some(ref token) = auth_token {
        if let Some(user_id) = state.db.validate_session(token) {
            let mut social = state.social.lock().await;
            social.link_player(&player_id, &user_id);
        }
    }

    // Bounded channel — drops deltas for slow clients instead of buffering
    let (tx, mut rx) = mpsc::channel::<String>(CLIENT_CHANNEL_CAPACITY);

    // Add player to game
    {
        let mut game = state.game.lock().await;
        game.add_player(&player_id, &player_name);

        // Send init payload
        let init = InitPayload {
            msg_type: "init".to_string(),
            id: player_id.clone(),
            walls: game.walls().to_vec(),
            map_width: game.map_dimensions().0,
            map_height: game.map_dimensions().1,
            ammo_spawn_points: game.ammo_spawn_points(),
        };
        let init_str = serde_json::to_string(&init).unwrap();
        let _ = ws_sender.send(Message::Text(init_str.into())).await;
    }

    // Register client sender
    {
        let mut clients = state.clients.lock().await;
        clients.insert(player_id.clone(), tx);
    }

    // Queue snapshot
    {
        let mut pending = state.pending_snapshots.lock().await;
        pending.insert(player_id.clone());
    }

    let pid_send = player_id.clone();
    let pid_recv = player_id.clone();
    let state_recv = state.clone();

    // Task: forward channel messages to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: receive messages from WebSocket
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            if let Message::Text(text) = msg {
                let text_str: &str = &text;
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(text_str) {
                    if client_msg.msg_type == "input" {
                        if let Some(input) = client_msg.input {
                            let mut game = state_recv.game.lock().await;
                            game.handle_input(&pid_recv, input);
                        }
                    }
                }
            }
        }
        pid_recv
    });

    // Wait for either task to finish (client disconnected)
    let pid_cleanup = tokio::select! {
        _ = send_task => pid_send.clone(),
        result = recv_task => result.unwrap_or(pid_send.clone()),
    };

    // Cleanup
    {
        let mut game = state.game.lock().await;
        game.remove_player(&pid_cleanup);
    }
    {
        let mut clients = state.clients.lock().await;
        clients.remove(&pid_cleanup);
    }
    {
        let mut pending = state.pending_snapshots.lock().await;
        pending.remove(&pid_cleanup);
    }
    {
        let mut social = state.social.lock().await;
        social.unlink_player(&pid_cleanup);
    }
}

async fn tick(state: &AppState) {
    // Skip ticking entirely if no players connected
    {
        let clients = state.clients.lock().await;
        if clients.is_empty() {
            return;
        }
    }

    // --- Physics step (every tick, 60 Hz) ---
    let mut game = state.game.lock().await;
    let paused = game.is_game_over();
    if !paused {
        game.update(1.0 / 60.0);
    }

    // Snapshot state for network
    let players = game.players().clone();
    let zombies = game.zombies().to_vec();
    let bullets = game.bullets().to_vec();
    let drops = game.drops();
    let wave = game.wave();
    let ammo_avail_vec = game.ammo_availability();
    let ammo_availability: HashMap<String, bool> = ammo_avail_vec.iter()
        .map(|a| (a.id.clone(), a.available)).collect();
    let game_over = game.is_game_over();
    drop(game);

    // --- Delta computation ---
    let mut dt = state.delta_tracker.lock().await;
    let delta = dt.compute_delta(&players, &zombies, &bullets, &drops, wave, &ammo_availability, game_over);
    let delta_str = serde_json::to_string(&delta).unwrap();

    let pending = state.pending_snapshots.lock().await;
    let snapshot_ids: Vec<String> = pending.iter().cloned().collect();

    let snapshot_str = if !snapshot_ids.is_empty() {
        let snapshot = dt.build_snapshot(&players, &zombies, &bullets, &drops, wave, &ammo_availability, game_over);
        Some(serde_json::to_string(&snapshot).unwrap())
    } else {
        None
    };
    drop(dt);
    drop(pending);

    if !snapshot_ids.is_empty() {
        let mut pending = state.pending_snapshots.lock().await;
        for id in &snapshot_ids {
            pending.remove(id);
        }
    }

    // --- Adaptive broadcast: try_send skips slow clients ---
    let clients = state.clients.lock().await;
    for (id, tx) in clients.iter() {
        if snapshot_ids.contains(id) {
            // Snapshots are critical — use blocking send
            if let Some(ref ss) = snapshot_str {
                let _ = tx.send(ss.clone()).await;
            }
        } else if !paused {
            // Deltas are droppable — skip if client channel is full
            // Don't spam deltas when paused (nothing is changing)
            let _ = tx.try_send(delta_str.clone());
        }
    }
}

// --- Admin panel ---

async fn admin_panel() -> Html<&'static str> {
    Html(r#"<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BoxHead Admin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 20px; }
  h1 { font-size: 28px; margin-bottom: 30px; color: #fff; }
  .card { background: #16213e; border-radius: 12px; padding: 24px; width: 100%; max-width: 500px; margin-bottom: 20px; }
  .card h2 { font-size: 16px; color: #8888aa; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; }
  .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1a1a3e; }
  .stat:last-child { border-bottom: none; }
  .stat-label { color: #8888aa; }
  .stat-value { font-weight: bold; }
  .stat-value.alive { color: #4caf50; }
  .stat-value.dead { color: #e53935; }
  .stat-value.wave { color: #ffb400; }
  button { background: #e53935; color: #fff; border: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; transition: background 0.2s; }
  button:hover { background: #c62828; }
  button:disabled { background: #555; cursor: not-allowed; }
  button.success { background: #4caf50; }
  .msg { text-align: center; margin-top: 12px; font-size: 14px; min-height: 20px; }
</style>
</head><body>
<h1>BoxHead Admin</h1>
<div class="card" id="status-card"><h2>Server Status</h2><div id="status">Loading...</div></div>
<div class="card">
  <h2>Actions</h2>
  <button id="restart-btn" onclick="restart()">Restart Game</button>
  <div class="msg" id="msg"></div>
</div>
<script>
async function refreshStatus() {
  try {
    const r = await fetch('/admin/status');
    const s = await r.json();
    const gameState = s.game_over ? '<span class="dead">GAME OVER (paused)</span>'
      : s.connected === 0 ? '<span class="dead">IDLE (no players)</span>'
      : '<span class="alive">RUNNING</span>';
    document.getElementById('status').innerHTML =
      '<div class="stat"><span class="stat-label">Connected</span><span class="stat-value">' + s.connected + '</span></div>' +
      '<div class="stat"><span class="stat-label">Players</span><span class="stat-value">' + s.players + '</span></div>' +
      '<div class="stat"><span class="stat-label">Alive</span><span class="stat-value alive">' + s.alive + '</span></div>' +
      '<div class="stat"><span class="stat-label">Wave</span><span class="stat-value wave">' + s.wave + '</span></div>' +
      '<div class="stat"><span class="stat-label">Zombies</span><span class="stat-value">' + s.zombies + '</span></div>' +
      '<div class="stat"><span class="stat-label">State</span><span class="stat-value">' + gameState + '</span></div>';
  } catch (e) { document.getElementById('status').textContent = 'Error fetching status'; }
}
async function restart() {
  const btn = document.getElementById('restart-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/admin/restart', { method: 'POST' });
    const d = await r.json();
    document.getElementById('msg').textContent = d.message;
    btn.classList.add('success');
    btn.textContent = 'Restarted!';
    setTimeout(() => { btn.classList.remove('success'); btn.textContent = 'Restart Game'; btn.disabled = false; document.getElementById('msg').textContent = ''; }, 2000);
    refreshStatus();
  } catch (e) { document.getElementById('msg').textContent = 'Failed to restart'; btn.disabled = false; }
}
refreshStatus();
setInterval(refreshStatus, 2000);
</script>
</body></html>"#)
}

async fn admin_restart(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut game = state.game.lock().await;
    game.reset();
    drop(game);

    let mut dt = state.delta_tracker.lock().await;
    *dt = DeltaTracker::new();
    drop(dt);

    // Queue fresh snapshots for all connected clients
    let clients = state.clients.lock().await;
    let mut pending = state.pending_snapshots.lock().await;
    for id in clients.keys() {
        pending.insert(id.clone());
    }

    Json(serde_json::json!({ "message": "Game restarted", "ok": true }))
}

async fn admin_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let game = state.game.lock().await;
    let players = game.players().len();
    let alive = game.players().values().filter(|p| p.health > 0.0).count();
    let zombies = game.zombies().len();
    let wave = game.wave();
    let game_over = game.is_game_over();
    drop(game);

    let clients = state.clients.lock().await;
    let connected = clients.len();

    Json(serde_json::json!({
        "players": players,
        "connected": connected,
        "alive": alive,
        "zombies": zombies,
        "wave": wave,
        "game_over": game_over,
    }))
}

// --- Config API ---

async fn api_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "google_client_id": state.google_client_id,
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

            let token = match state.db.create_session(&user_id) {
                Ok(t) => t,
                Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
            };

            Json(serde_json::json!({
                "ok": true,
                "token": token,
                "user_id": user_id,
                "handle": session.handle,
                "display_name": session.handle,
            }))
        }
        Err(e) => {
            Json(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

async fn email_register(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let email = body["email"].as_str().unwrap_or("").trim().to_lowercase();
    let password = body["password"].as_str().unwrap_or("");

    if email.is_empty() || !email.contains('@') {
        return Json(serde_json::json!({ "ok": false, "error": "Valid email required" }));
    }
    if password.len() < 6 {
        return Json(serde_json::json!({ "ok": false, "error": "Password must be at least 6 characters" }));
    }

    match state.db.register_email_user(&email, password) {
        Ok(user_id) => {
            let token = match state.db.create_session(&user_id) {
                Ok(t) => t,
                Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
            };
            Json(serde_json::json!({
                "ok": true,
                "token": token,
                "user_id": user_id,
                "handle": email,
                "display_name": email,
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn email_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let email = body["email"].as_str().unwrap_or("").trim().to_lowercase();
    let password = body["password"].as_str().unwrap_or("");

    if email.is_empty() || password.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "Email and password required" }));
    }

    match state.db.verify_email_login(&email, password) {
        Ok(user_id) => {
            let token = match state.db.create_session(&user_id) {
                Ok(t) => t,
                Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
            };
            Json(serde_json::json!({
                "ok": true,
                "token": token,
                "user_id": user_id,
                "handle": email,
                "display_name": email,
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
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
            let user_id = match state.db.find_or_create_user(
                "google",
                &info.sub,
                &info.email,
                &display_name,
            ) {
                Ok(id) => id,
                Err(e) => {
                    return Html(format!("<html><body><script>window.close();</script>Error: {}</body></html>", e));
                }
            };

            let token = match state.db.create_session(&user_id) {
                Ok(t) => t,
                Err(e) => {
                    return Html(format!("<html><body><script>window.close();</script>Error: {}</body></html>", e));
                }
            };

            // Return HTML that posts the result back to the opener window and closes
            Html(format!(r#"<!DOCTYPE html>
<html><body>
<p>Signed in! This window will close automatically.</p>
<script>
if (window.opener) {{
    window.opener.postMessage({{
        type: 'google-auth',
        ok: true,
        token: '{}',
        user_id: '{}',
        handle: '{}',
        display_name: '{}'
    }}, window.location.origin);
}}
setTimeout(() => window.close(), 1000);
</script>
</body></html>"#,
                token,
                user_id,
                info.email.replace('\'', "\\'"),
                display_name.replace('\'', "\\'"),
            ))
        }
        Err(e) => {
            Html(format!(r#"<!DOCTYPE html>
<html><body>
<p>Login failed: {}</p>
<script>
if (window.opener) {{
    window.opener.postMessage({{ type: 'google-auth', ok: false, error: '{}' }}, window.location.origin);
}}
setTimeout(() => window.close(), 3000);
</script>
</body></html>"#,
                e,
                e.replace('\'', "\\'"),
            ))
        }
    }
}

/// Get current user info from session token
async fn auth_me(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");

    let user_id = match state.db.validate_session(token) {
        Some(id) => id,
        None => return Json(serde_json::json!({ "ok": false, "error": "Not authenticated" })),
    };

    let user = match state.db.get_user(&user_id) {
        Some(u) => u,
        None => return Json(serde_json::json!({ "ok": false, "error": "User not found" })),
    };

    let handle = state.db.get_user_handle(&user_id).unwrap_or_default();

    Json(serde_json::json!({
        "ok": true,
        "user_id": user.id,
        "display_name": user.display_name,
        "handle": handle,
    }))
}

async fn friends_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");

    let user_id = match state.db.validate_session(token) {
        Some(id) => id,
        None => return Json(serde_json::json!({ "ok": false, "error": "Not authenticated" })),
    };

    let friend_rows = state.db.get_friends(&user_id);
    let social = state.social.lock().await;

    let friends: Vec<social::FriendStatus> = friend_rows.into_iter().map(|f| {
        social::FriendStatus {
            user_id: f.user_id.clone(),
            display_name: f.display_name.clone(),
            handle: f.provider_handle.unwrap_or_else(|| f.display_name.clone()),
            online: social.is_online(&f.user_id),
        }
    }).collect();

    Json(serde_json::json!({ "ok": true, "friends": friends }))
}

async fn friends_add(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let token = body["token"].as_str().unwrap_or("");
    let friend_handle = body["handle"].as_str().unwrap_or("");

    if friend_handle.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "Friend handle required" }));
    }

    let user_id = match state.db.validate_session(token) {
        Some(id) => id,
        None => return Json(serde_json::json!({ "ok": false, "error": "Not authenticated" })),
    };

    // Try to resolve as a Bluesky handle first
    match social::resolve_handle(friend_handle).await {
        Ok(friend_did) => {
            // Find or create a user for this Bluesky account
            let friend_user_id = match state.db.find_or_create_user(
                "bluesky",
                &friend_did,
                friend_handle,
                friend_handle,
            ) {
                Ok(id) => id,
                Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
            };

            if friend_user_id == user_id {
                return Json(serde_json::json!({ "ok": false, "error": "Cannot add yourself" }));
            }

            match state.db.add_friend(&user_id, &friend_user_id) {
                Ok(_) => Json(serde_json::json!({
                    "ok": true,
                    "user_id": friend_user_id,
                    "handle": friend_handle,
                })),
                Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
            }
        }
        Err(e) => {
            Json(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

async fn friends_remove(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let token = body["token"].as_str().unwrap_or("");
    let friend_user_id = body["user_id"].as_str().unwrap_or("");

    let user_id = match state.db.validate_session(token) {
        Some(id) => id,
        None => return Json(serde_json::json!({ "ok": false, "error": "Not authenticated" })),
    };

    match state.db.remove_friend(&user_id, friend_user_id) {
        Ok(_) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}
