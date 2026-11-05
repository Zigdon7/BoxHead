//! BoxHead ops dashboard — a separate service that watches every game server's
//! parallel room-simulation threads through their internal ops API.
//!
//! Env:
//!   GAME_SERVERS        comma-separated ops API base URLs (default http://127.0.0.1:3901)
//!   BOXHEAD_OPS_TOKEN   bearer token shared with the game servers (required)
//!   DASHBOARD_ADDR      listen address (default 127.0.0.1:3900)
//!   DASHBOARD_PASSWORD  HTTP Basic password; required to listen on a non-loopback address
//!   DASHBOARD_POLL_MS   poll interval (default 1000)

mod model;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use tokio::sync::RwLock;

use model::ServerView;

const PAGE: &str = include_str!("page.html");
/// Custom header the dashboard page sends with actions. Cross-site forms can't
/// set it, so a malicious page can't make the browser trigger restarts (CSRF).
const ACTION_HEADER: &str = "x-dashboard-action";

struct Config {
    servers: Vec<String>,
    token: String,
    addr: SocketAddr,
    password: Option<String>,
    poll: Duration,
}

struct AppState {
    config: Config,
    http: reqwest::Client,
    servers: RwLock<Vec<ServerView>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn parse_servers(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Refuse to expose the dashboard beyond localhost without a password.
fn check_exposure(addr: &SocketAddr, password: Option<&str>) -> Result<(), String> {
    if addr.ip().is_loopback() || password.is_some_and(|p| !p.is_empty()) {
        Ok(())
    } else {
        Err(format!("Refusing to listen on {addr} without DASHBOARD_PASSWORD"))
    }
}

fn load_config() -> Result<Config, String> {
    let token = std::env::var("BOXHEAD_OPS_TOKEN").unwrap_or_default().trim().to_string();
    if token.is_empty() {
        return Err("BOXHEAD_OPS_TOKEN is required (the same token the game servers use)".into());
    }
    let servers = parse_servers(&std::env::var("GAME_SERVERS").unwrap_or_else(|_| "http://127.0.0.1:3901".into()));
    if servers.is_empty() { return Err("GAME_SERVERS is empty".into()); }
    let addr: SocketAddr = std::env::var("DASHBOARD_ADDR").unwrap_or_else(|_| "127.0.0.1:3900".into())
        .parse().map_err(|e| format!("Bad DASHBOARD_ADDR: {e}"))?;
    let password = std::env::var("DASHBOARD_PASSWORD").ok().filter(|p| !p.is_empty());
    check_exposure(&addr, password.as_deref())?;
    let poll_ms = std::env::var("DASHBOARD_POLL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1000u64).max(100);
    Ok(Config { servers, token, addr, password, poll: Duration::from_millis(poll_ms) })
}

#[tokio::main]
async fn main() {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => { eprintln!("dashboard: {e}"); std::process::exit(2); }
    };
    let http = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
    let servers = RwLock::new(config.servers.iter().cloned().map(ServerView::new).collect());
    let addr = config.addr;
    let state = Arc::new(AppState { config, http, servers });

    let poller = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(poller.config.poll);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            poll_all(&poller).await;
        }
    });

    let app = Router::new()
        .route("/", get(|| async { Html(PAGE) }))
        .route("/api/overview", get(overview))
        .route("/api/servers/{index}/rooms/{id}/restart", post(restart_room))
        .route("/api/servers/{index}/restart-all", post(restart_all))
        .layer(middleware::from_fn_with_state(state.clone(), basic_auth))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(addr).await
        .unwrap_or_else(|e| { eprintln!("dashboard: cannot bind {addr}: {e}"); std::process::exit(2) });
    println!("Dashboard on http://{addr} watching {} game server(s)", state.config.servers.len());
    axum::serve(listener, app).await.unwrap();
}

async fn poll_all(state: &AppState) {
    let fetches = state.config.servers.iter().map(|url| {
        let request = state.http.get(format!("{url}/ops/v1/status")).bearer_auth(&state.config.token);
        async move {
            let res = request.send().await.map_err(|e| e.to_string())?;
            if !res.status().is_success() { return Err(format!("HTTP {}", res.status())); }
            res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
        }
    });
    let results = futures::future::join_all(fetches).await;
    let now = now_ms();
    let mut servers = state.servers.write().await;
    for (view, result) in servers.iter_mut().zip(results) {
        match result {
            Ok(status) => view.record_success(status, now),
            Err(error) => view.record_failure(error),
        }
    }
}

async fn basic_auth(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let Some(password) = state.config.password.as_deref() else { return next.run(request).await };
    let ok = request.headers().get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .and_then(|raw| String::from_utf8(raw).ok())
        .is_some_and(|creds| creds.split_once(':').is_some_and(|(_, p)| p == password));
    if ok {
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, [("www-authenticate", "Basic realm=\"BoxHead ops\"")], "auth required").into_response()
    }
}

async fn overview(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let servers = state.servers.read().await;
    Json(model::overview(&servers, now_ms(), state.config.poll.as_millis() as u64))
}

fn require_action_header(headers: &HeaderMap) -> Result<(), Response> {
    if headers.get(ACTION_HEADER).is_some_and(|v| v == "1") {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, Json(serde_json::json!({ "ok": false, "error": "missing action header" }))).into_response())
    }
}

/// Parse an optional JSON action body. Only called after the action header
/// check, so the CSRF guard never depends on body parsing.
fn action_body(body: &Bytes) -> serde_json::Value {
    serde_json::from_slice::<serde_json::Value>(body).ok()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

async fn forward(state: &AppState, index: usize, path: &str, payload: serde_json::Value) -> Response {
    let Some(base) = state.config.servers.get(index) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "ok": false, "error": "unknown server" }))).into_response();
    };
    let result = state.http.post(format!("{base}{path}")).bearer_auth(&state.config.token).json(&payload).send().await;
    match result {
        Ok(res) => {
            let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = res.json::<serde_json::Value>().await.unwrap_or(serde_json::json!({ "ok": false }));
            (status, Json(body)).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "ok": false, "error": e.to_string() }))).into_response(),
    }
}

async fn restart_room(
    State(state): State<Arc<AppState>>,
    Path((index, id)): Path<(usize, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(denied) = require_action_header(&headers) { return denied; }
    // Room ids are server-generated hex/ascii; reject anything that could alter the path.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": "bad room id" }))).into_response();
    }
    forward(&state, index, &format!("/ops/v1/rooms/{id}/restart"), action_body(&body)).await
}

async fn restart_all(
    State(state): State<Arc<AppState>>,
    Path(index): Path<usize>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(denied) = require_action_header(&headers) { return denied; }
    forward(&state, index, "/ops/v1/restart-all", action_body(&body)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_list_parsing() {
        assert_eq!(parse_servers(" http://a:1/ , ,http://b:2"), vec!["http://a:1", "http://b:2"]);
        assert!(parse_servers(" , ").is_empty());
    }

    #[test]
    fn public_bind_requires_a_password() {
        let local: SocketAddr = "127.0.0.1:3900".parse().unwrap();
        let public: SocketAddr = "0.0.0.0:3900".parse().unwrap();
        assert!(check_exposure(&local, None).is_ok());
        assert!(check_exposure(&public, None).is_err());
        assert!(check_exposure(&public, Some("")).is_err());
        assert!(check_exposure(&public, Some("hunter2")).is_ok());
    }

    #[test]
    fn action_bodies_default_to_an_empty_object() {
        assert_eq!(action_body(&Bytes::from_static(b"")), serde_json::json!({}));
        assert_eq!(action_body(&Bytes::from_static(b"a=1")), serde_json::json!({}));
        assert_eq!(action_body(&Bytes::from_static(b"[1]")), serde_json::json!({}));
        assert_eq!(action_body(&Bytes::from_static(br#"{"startingWave":4}"#)), serde_json::json!({ "startingWave": 4 }));
    }

    #[test]
    fn actions_need_the_csrf_header() {
        let mut headers = HeaderMap::new();
        assert!(require_action_header(&headers).is_err());
        headers.insert(ACTION_HEADER, "0".parse().unwrap());
        assert!(require_action_header(&headers).is_err());
        headers.insert(ACTION_HEADER, "1".parse().unwrap());
        assert!(require_action_header(&headers).is_ok());
    }
}
