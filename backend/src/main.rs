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
    response::IntoResponse,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use tower_http::services::ServeDir;
use tokio::sync::mpsc;

use crate::types::*;
use crate::game::Game;
use crate::delta::DeltaTracker;

type ClientSender = mpsc::UnboundedSender<String>;

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

    // Game tick loop (20 Hz)
    let tick_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
        loop {
            interval.tick().await;
            tick(&tick_state).await;
        }
    });

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".to_string());

    let app = Router::new()
        .route("/ws", get(ws_handler))
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

    // Create channel for sending messages to this client
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Add player to game
    {
        let mut game = state.game.lock().await;
        game.add_player(&player_id);

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
    let (delta_str, snapshot_str, snapshot_ids) = {
        let mut game = state.game.lock().await;
        game.update(1.0 / 20.0); // 20 Hz fixed timestep

        let players = game.players().clone();
        let zombies = game.zombies().to_vec();
        let bullets = game.bullets().to_vec();
        let drops = game.drops();
        let wave = game.wave();
        let ammo_avail_vec = game.ammo_availability();
        let ammo_availability: HashMap<String, bool> = ammo_avail_vec.iter()
            .map(|a| (a.id.clone(), a.available)).collect();
        let game_over = game.is_game_over();

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

        (delta_str, snapshot_str, snapshot_ids)
    };

    // Clear pending snapshots
    if !snapshot_ids.is_empty() {
        let mut pending = state.pending_snapshots.lock().await;
        for id in &snapshot_ids {
            pending.remove(id);
        }
    }

    // Broadcast
    let clients = state.clients.lock().await;
    for (id, tx) in clients.iter() {
        if snapshot_ids.contains(id) {
            if let Some(ref ss) = snapshot_str {
                let _ = tx.send(ss.clone());
            }
        } else {
            let _ = tx.send(delta_str.clone());
        }
    }
}
