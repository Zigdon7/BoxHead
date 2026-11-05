mod types;
mod map;
mod spatial_grid;
mod game;
mod delta;
mod social;
mod db;
mod rooms;
mod sim;
mod ops;

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
use crate::rooms::{RegistryConfig, RoomRegistry, OPEN_ROOM_ID};
use crate::sim::SimRuntime;

// Bounded channel: capacity = a few ticks of headroom.
// If a client falls behind, we skip deltas rather than buffer indefinitely.
const CLIENT_CHANNEL_CAPACITY: usize = 4;

struct AppState {
    rooms: Arc<RoomRegistry>,
    social: Mutex<SocialState>,
    db: Arc<Database>,
    google_client_id: String,
    google_client_secret: String,
}

#[tokio::main]
async fn main() {
    let db = Arc::new(Database::open("boxhead.db")
        .expect("Failed to open database"));

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

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    start_ops_api(&port, state.rooms.clone(), sim.clone(), publish.clone()).await;
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".to_string());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/rooms", get(rooms_list).post(rooms_create))
        .route("/api/rooms/{id}/replay", post(room_replay))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/email/register", post(email_register))
        .route("/api/auth/email/login", post(email_login))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/api/auth/me", get(auth_me))
        .route("/api/config", get(api_config))
        .route("/api/progress", get(wave_progress))
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
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn send_join_error(ws_sender: &mut futures::stream::SplitSink<WebSocket, Message>, error: &str) {
    let msg = serde_json::json!({ "type": "joinError", "error": error }).to_string();
    let _ = ws_sender.send(Message::Text(msg.into())).await;
    let _ = ws_sender.send(Message::Close(None)).await;
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let player_id = uuid::Uuid::new_v4().to_string()[..8].to_string();

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Wait for join message with player name, target room and optional auth token
    let (player_name, auth_token, profile_id, starting_wave, room_id) = loop {
        match ws_receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                let text_str: &str = &text;
                if let Ok(msg) = serde_json::from_str::<ClientMessage>(text_str) {
                    if msg.msg_type == "join" {
                        let name = msg.name.unwrap_or_default();
                        let name = name.trim().chars().take(16).collect::<String>();
                        let name = if name.is_empty() { format!("Player_{}", &player_id[..4]) } else { name };
                        let room_id = msg.room_id.unwrap_or_else(|| OPEN_ROOM_ID.to_string());
                        break (name, msg.token, msg.profile_id, msg.starting_wave.unwrap_or(1), room_id);
                    }
                }
            }
            Some(Ok(_)) => continue,
            _ => return,
        }
    };

    // Verification comes from the server-side session, never from the client.
    let user_id = auth_token.as_deref().and_then(|t| state.db.validate_session(t));
    let verified = user_id.as_deref().is_some_and(|id| state.db.is_verified(id));

    let Some(room) = state.rooms.get(&room_id).await else {
        send_join_error(&mut ws_sender, "That room no longer exists.").await;
        return;
    };
    if !rooms::can_join(room.verified_only, verified) {
        send_join_error(&mut ws_sender, "This room is for signed-in accounts only. Sign in to join.").await;
        return;
    }

    let profile_id = profile_id
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let unlocked_wave = state.db.highest_wave(&profile_id);

    // Bounded channel — drops deltas for slow clients instead of buffering
    let (tx, mut rx) = mpsc::channel::<String>(CLIENT_CHANNEL_CAPACITY);

    // The first player chooses the new round; late joiners keep its current wave.
    let joined_game;
    {
        let mut game = room.game.lock().await;
        if game.start_empty_round(starting_wave, unlocked_wave) {
            *room.delta_tracker.lock().await = delta::DeltaTracker::new();
        }
        let game_over = game.is_game_over();
        let wave = game.wave();

        if !game_over {
            game.add_player(&player_id, &player_name);
            state.db.record_wave(&profile_id, wave);
            room.wave_profiles.lock().await.insert(player_id.clone(), (profile_id.clone(), wave));
            room.clients.lock().await.insert(player_id.clone(), tx);
            joined_game = true;
        } else {
            joined_game = false;
        }

        // Send init payload — always includes current game_over / wave so the
        // client can immediately show the right screen without waiting for a snapshot.
        let init = InitPayload {
            msg_type: "init".to_string(),
            id: player_id.clone(),
            walls: game.walls().to_vec(),
            map_width: game.map_dimensions().0,
            map_height: game.map_dimensions().1,
            ammo_spawn_points: game.ammo_spawn_points(),
            game_over,
            wave,
        };
        let init_str = serde_json::to_string(&init).unwrap();
        let _ = ws_sender.send(Message::Text(init_str.into())).await;
    }

    // If the game is over, don't register this socket as a game client — we
    // already told them the state.  They'll reconnect when the game restarts.
    if !joined_game {
        return;
    }

    // Link player to auth identity for friends' online presence
    if let Some(ref user_id) = user_id {
        state.social.lock().await.link_player(&player_id, user_id);
    }

    room.pending_snapshots.lock().await.insert(player_id.clone());

    let pid_send = player_id.clone();
    let pid_recv = player_id.clone();
    let room_recv = room.clone();

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
        pid_recv
    });

    // Wait for either task to finish (client disconnected)
    let pid_cleanup = tokio::select! {
        _ = send_task => pid_send.clone(),
        result = recv_task => result.unwrap_or(pid_send.clone()),
    };

    // Cleanup
    room.wave_profiles.lock().await.remove(&pid_cleanup);
    room.game.lock().await.remove_player(&pid_cleanup);
    room.clients.lock().await.remove(&pid_cleanup);
    room.pending_snapshots.lock().await.remove(&pid_cleanup);
    state.social.lock().await.unlink_player(&pid_cleanup);
}

// --- Rooms API ---

async fn rooms_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let verified = state.db.session_is_verified(params.get("token").map(String::as_str));
    let mut rooms = Vec::new();
    for room in state.rooms.all().await {
        rooms.push(room.summary(verified).await);
    }
    Json(serde_json::json!({ "ok": true, "verified": verified, "rooms": rooms }))
}

async fn rooms_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let verified = state.db.session_is_verified(body["token"].as_str());
    let verified_only = body["verifiedOnly"].as_bool().unwrap_or(false);
    if verified_only && !verified {
        return Json(serde_json::json!({ "ok": false, "error": "Only verified accounts can create verified rooms" }));
    }
    match state.rooms.create(body["name"].as_str().unwrap_or(""), verified_only).await {
        Ok(room) => Json(serde_json::json!({ "ok": true, "room": room.summary(verified).await })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// "Play again" after a squad is overrun. Same access rules as joining, and it
/// only restarts rounds that have actually ended. Operator restarts live in the
/// ops API used by the dashboard service.
async fn room_replay(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(room) = state.rooms.get(&id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "Room not found" }));
    };
    let verified = state.db.session_is_verified(body["token"].as_str());
    if !rooms::can_join(room.verified_only, verified) {
        return Json(serde_json::json!({ "ok": false, "error": "Verified accounts only" }));
    }
    if !room.game.lock().await.is_game_over() {
        return Json(serde_json::json!({ "ok": false, "error": "Round is still active" }));
    }
    let requested = body["startingWave"].as_u64().unwrap_or(1).clamp(1, 999) as u32;
    let unlocked = body["profileId"].as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .map(|id| state.db.highest_wave(id)).unwrap_or(1);
    room.restart(requested, unlocked).await;
    Json(serde_json::json!({ "ok": true }))
}

// --- Config API ---

async fn wave_progress(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let highest = params.get("profileId")
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .map(|id| state.db.highest_wave(id)).unwrap_or(1);
    Json(serde_json::json!({ "highestWave": highest }))
}

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
                "verified": true,
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
                "verified": state.db.is_verified(&user_id),
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
                "verified": state.db.is_verified(&user_id),
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
        display_name: '{}',
        verified: true
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
        "verified": state.db.is_verified(&user.id),
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
