mod types;
mod map;
mod spatial_grid;
mod game;
mod delta;

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

// Bounded channel: capacity = a few ticks of headroom.
// If a client falls behind, we skip deltas rather than buffer indefinitely.
const CLIENT_CHANNEL_CAPACITY: usize = 4;

type ClientSender = mpsc::Sender<String>;

struct AppState {
    game: Mutex<Game>,
    delta_tracker: Mutex<DeltaTracker>,
    clients: Mutex<HashMap<String, ClientSender>>,
    pending_snapshots: Mutex<HashSet<String>>,
}

#[tokio::main]
async fn main() {
    let state = Arc::new(AppState {
        game: Mutex::new(Game::new()),
        delta_tracker: Mutex::new(DeltaTracker::new()),
        clients: Mutex::new(HashMap::new()),
        pending_snapshots: Mutex::new(HashSet::new()),
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

    // Wait for join message with player name
    let player_name = loop {
        match ws_receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                let text_str: &str = &text;
                if let Ok(msg) = serde_json::from_str::<ClientMessage>(text_str) {
                    if msg.msg_type == "join" {
                        let name = msg.name.unwrap_or_default();
                        // Sanitize: limit length, trim whitespace
                        let name = name.trim().chars().take(16).collect::<String>();
                        break if name.is_empty() { format!("Player_{}", &player_id[..4]) } else { name };
                    }
                }
            }
            Some(Ok(_)) => continue,
            _ => return, // disconnected before joining
        }
    };

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
