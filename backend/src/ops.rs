//! Internal ops API consumed by the separate dashboard service.
//!
//! It listens on its own address (default 127.0.0.1:3901, never the public game
//! port) and every request needs `Authorization: Bearer <BOXHEAD_OPS_TOKEN>`.
//! Without a token configured the API is not started at all.

use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use crate::rooms::RoomRegistry;
use crate::sim::SimRuntime;

pub const DEFAULT_OPS_ADDR: &str = "127.0.0.1:3901";

pub struct OpsState {
    pub token: String,
    pub server_id: String,
    pub rooms: Arc<RoomRegistry>,
    pub sim: Arc<SimRuntime>,
    pub publish: Arc<SimRuntime>,
    pub started: Instant,
    pub started_unix_ms: u64,
}

impl OpsState {
    pub fn new(token: String, server_id: String, rooms: Arc<RoomRegistry>, sim: Arc<SimRuntime>, publish: Arc<SimRuntime>) -> Arc<Self> {
        let started_unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Arc::new(Self { token, server_id, rooms, sim, publish, started: Instant::now(), started_unix_ms })
    }
}

pub fn router(state: Arc<OpsState>) -> Router {
    Router::new()
        .route("/ops/v1/status", get(status))
        .route("/ops/v1/rooms/{id}/restart", post(restart_room))
        .route("/ops/v1/restart-all", post(restart_all))
        .with_state(state)
}

/// Compare without short-circuiting on the first differing byte.
pub fn token_matches(expected: &str, provided: &str) -> bool {
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (*a.get(i).unwrap_or(&0) ^ *b.get(i).unwrap_or(&0)) as usize;
    }
    !expected.is_empty() && diff == 0
}

fn authorized(state: &OpsState, headers: &HeaderMap) -> Result<(), Response> {
    let provided = headers.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if token_matches(&state.token, provided) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "ok": false, "error": "unauthorized" }))).into_response())
    }
}

async fn status(State(state): State<Arc<OpsState>>, headers: HeaderMap) -> Response {
    if let Err(denied) = authorized(&state, &headers) { return denied; }
    let mut rooms = Vec::new();
    let (mut connected, mut players, mut zombies) = (0u64, 0u64, 0u64);
    for room in state.rooms.all().await {
        let snap = room.ops_snapshot().await;
        connected += snap["connected"].as_u64().unwrap_or(0);
        players += snap["players"].as_u64().unwrap_or(0);
        zombies += snap["zombies"].as_u64().unwrap_or(0);
        rooms.push(snap);
    }
    Json(serde_json::json!({
        "ok": true,
        "serverId": state.server_id,
        "version": env!("CARGO_PKG_VERSION"),
        "startedAtMs": state.started_unix_ms,
        "uptimeMs": state.started.elapsed().as_millis() as u64,
        "simThreadCount": state.sim.size(),
        "simThreads": state.sim.snapshot(),
        "publishThreadCount": state.publish.size(),
        "publishThreads": state.publish.snapshot(),
        "roomLimit": state.rooms.max_rooms(),
        "emptyRoomTtlSecs": state.rooms.empty_ttl().as_secs(),
        "totals": { "rooms": rooms.len(), "connected": connected, "players": players, "zombies": zombies },
        "rooms": rooms,
    })).into_response()
}

fn starting_wave(body: &Option<Json<serde_json::Value>>) -> u32 {
    body.as_ref().and_then(|b| b["startingWave"].as_u64()).map(|w| w.clamp(1, 999) as u32).unwrap_or(1)
}

async fn restart_room(
    State(state): State<Arc<OpsState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if let Err(denied) = authorized(&state, &headers) { return denied; }
    let Some(room) = state.rooms.get(&id).await else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "ok": false, "error": "Room not found" }))).into_response();
    };
    // Operators may pick any wave; the player unlock check does not apply.
    let wave = starting_wave(&body);
    room.restart(wave, wave).await;
    Json(serde_json::json!({ "ok": true, "roomId": id, "startingWave": wave })).into_response()
}

async fn restart_all(
    State(state): State<Arc<OpsState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if let Err(denied) = authorized(&state, &headers) { return denied; }
    let wave = starting_wave(&body);
    let rooms = state.rooms.all().await;
    for room in &rooms { room.restart(wave, wave).await; }
    Json(serde_json::json!({ "ok": true, "restarted": rooms.len(), "startingWave": wave })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison() {
        assert!(token_matches("s3cret", "s3cret"));
        assert!(!token_matches("s3cret", "s3cre"));
        assert!(!token_matches("s3cret", "s3cret!"));
        assert!(!token_matches("s3cret", "S3CRET"));
        assert!(!token_matches("s3cret", ""));
        assert!(!token_matches("", ""), "an empty configured token never authorizes");
    }

    #[test]
    fn starting_wave_is_clamped() {
        assert_eq!(starting_wave(&None), 1);
        assert_eq!(starting_wave(&Some(Json(serde_json::json!({ "startingWave": 7 })))), 7);
        assert_eq!(starting_wave(&Some(Json(serde_json::json!({ "startingWave": 0 })))), 1);
        assert_eq!(starting_wave(&Some(Json(serde_json::json!({ "startingWave": 5000 })))), 999);
    }
}
