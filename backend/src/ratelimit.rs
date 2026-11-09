//! In-memory rate limiting (token buckets keyed by client IP or account).
//!
//! One game server is one process, so per-process buckets are enough. Behind a
//! reverse proxy set `BOXHEAD_TRUST_PROXY=1` so the client IP comes from
//! `X-Forwarded-For` instead of the proxy's own address. Only one proxy hop is
//! supported: the proxy must append the client address it saw.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// A limit: up to `burst` requests at once, refilling `per_hour` an hour.
#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub name: &'static str,
    pub burst: f64,
    pub per_hour: f64,
}

impl Rule {
    const fn new(name: &'static str, burst: u32, per_hour: u32) -> Self {
        Rule { name, burst: burst as f64, per_hour: per_hour as f64 }
    }
}

pub const REGISTER: Rule = Rule::new("register", 10, 20);
pub const LOGIN: Rule = Rule::new("login", 10, 120);
/// Failed password attempts against one email, from anywhere.
pub const LOGIN_EMAIL: Rule = Rule::new("login-email", 10, 40);
pub const MAIL: Rule = Rule::new("mail", 5, 10);
pub const RESET: Rule = Rule::new("reset", 10, 30);
pub const HOST: Rule = Rule::new("host", 10, 120);
pub const FRIENDS: Rule = Rule::new("friends", 20, 60);
pub const JOIN: Rule = Rule::new("join", 30, 600);
pub const HIDEOUT: Rule = Rule::new("hideout", 60, 36_000);
pub const API: Rule = Rule::new("api", 120, 72_000);

/// The rule a request falls under, by method and path. None = not limited.
pub fn rule_for(method: &Method, path: &str) -> Option<Rule> {
    let post = method == Method::POST;
    Some(match path {
        "/api/auth/email/register" if post => REGISTER,
        "/api/auth/email/login" | "/api/auth/login" if post => LOGIN,
        "/api/auth/email/resend" | "/api/auth/password/forgot" if post => MAIL,
        "/api/auth/password/reset" if post => RESET,
        "/api/rooms" if post => HOST,
        "/api/friends/add" => FRIENDS,
        "/ws" => JOIN,
        p if p.starts_with("/api/hideout") => HIDEOUT,
        p if p.starts_with("/api/") => API,
        _ => return None,
    })
}

struct Bucket { tokens: f64, at: Instant }

pub struct RateLimiter {
    enabled: bool,
    trust_proxy: bool,
    buckets: Mutex<HashMap<(&'static str, String), Bucket>>,
}

impl RateLimiter {
    pub fn new(enabled: bool, trust_proxy: bool) -> Self {
        RateLimiter { enabled, trust_proxy, buckets: Mutex::new(HashMap::new()) }
    }

    /// `BOXHEAD_RATE_LIMIT=off` disables limits (load tests); `BOXHEAD_TRUST_PROXY=1`
    /// reads the client IP from `X-Forwarded-For`.
    pub fn from_env() -> Self {
        let off = std::env::var("BOXHEAD_RATE_LIMIT").is_ok_and(|v| matches!(v.trim(), "off" | "0" | "false"));
        let proxy = std::env::var("BOXHEAD_TRUST_PROXY").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
        if off { println!("Rate limiting is OFF (BOXHEAD_RATE_LIMIT=off)"); }
        Self::new(!off, proxy)
    }

    /// Take one token. Err carries the seconds until the next one.
    pub fn check(&self, rule: Rule, key: &str) -> Result<(), u64> {
        self.check_at(rule, key, Instant::now())
    }

    fn check_at(&self, rule: Rule, key: &str, now: Instant) -> Result<(), u64> {
        if !self.enabled { return Ok(()); }
        let mut buckets = self.buckets.lock().unwrap();
        let bucket = buckets.entry((rule.name, key.to_string())).or_insert(Bucket { tokens: rule.burst, at: now });
        let per_sec = rule.per_hour / 3600.0;
        bucket.tokens = (bucket.tokens + now.saturating_duration_since(bucket.at).as_secs_f64() * per_sec).min(rule.burst);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - bucket.tokens) / per_sec).ceil().max(1.0) as u64)
        }
    }

    /// Forget buckets that have refilled completely.
    pub fn prune(&self) {
        let now = Instant::now();
        self.buckets.lock().unwrap().retain(|_, b| now.saturating_duration_since(b.at) < Duration::from_secs(3600));
    }

    /// The client's IP: the connection's peer, or behind a trusted proxy the last
    /// `X-Forwarded-For` entry (the one our proxy added; earlier ones are client-supplied).
    pub fn client_ip(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
        if self.trust_proxy {
            let forwarded = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit(',').next()).map(str::trim)
                .and_then(|v| v.parse::<IpAddr>().ok());
            if let Some(ip) = forwarded { return ip.to_string(); }
        }
        peer.map(|p| p.ip().to_string()).unwrap_or_else(|| "unknown".into())
    }
}

/// The reply for a request over its limit.
pub fn too_many(retry_secs: u64) -> Response {
    let wait = if retry_secs >= 90 { format!("{} minutes", retry_secs.div_ceil(60)) } else { format!("{retry_secs} seconds") };
    let mut res = (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({
        "ok": false, "rateLimited": true, "error": format!("Too many attempts. Try again in {wait}."),
    }))).into_response();
    if let Ok(v) = retry_secs.to_string().parse() { res.headers_mut().insert("retry-after", v); }
    res
}

/// Middleware: limit each request by its route's rule and the client IP.
pub async fn middleware(State(limiter): State<std::sync::Arc<RateLimiter>>, req: Request, next: Next) -> Response {
    if let Some(rule) = rule_for(req.method(), req.uri().path()) {
        let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        let ip = limiter.client_ip(req.headers(), peer);
        if let Err(retry) = limiter.check(rule, &ip) { return too_many(retry); }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_allows_its_burst_then_refills_over_time() {
        let l = RateLimiter::new(true, false);
        let t0 = Instant::now();
        for _ in 0..10 { assert!(l.check_at(REGISTER, "1.2.3.4", t0).is_ok()); }
        let wait = l.check_at(REGISTER, "1.2.3.4", t0).unwrap_err();
        assert_eq!(wait, 180, "20 an hour = one every 3 minutes");
        assert!(l.check_at(REGISTER, "5.6.7.8", t0).is_ok(), "other clients have their own bucket");
        assert!(l.check_at(LOGIN, "1.2.3.4", t0).is_ok(), "and other rules too");
        assert!(l.check_at(REGISTER, "1.2.3.4", t0 + Duration::from_secs(181)).is_ok());
        assert!(l.check_at(REGISTER, "1.2.3.4", t0 + Duration::from_secs(182)).is_err());
    }

    #[test]
    fn disabled_limiter_allows_everything() {
        let l = RateLimiter::new(false, false);
        for _ in 0..1000 { assert!(l.check(REGISTER, "x").is_ok()); }
    }

    #[test]
    fn routes_map_to_rules() {
        assert_eq!(rule_for(&Method::POST, "/api/auth/email/register").unwrap().name, "register");
        assert_eq!(rule_for(&Method::POST, "/api/rooms").unwrap().name, "host");
        assert_eq!(rule_for(&Method::GET, "/api/rooms").unwrap().name, "api");
        assert_eq!(rule_for(&Method::POST, "/api/hideout/sell").unwrap().name, "hideout");
        assert_eq!(rule_for(&Method::GET, "/ws").unwrap().name, "join");
        assert!(rule_for(&Method::GET, "/assets/game.js").is_none());
    }

    #[test]
    fn forwarded_ips_are_only_trusted_behind_a_proxy() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "6.6.6.6, 203.0.113.9".parse().unwrap());
        let peer = Some("10.0.0.1:5000".parse().unwrap());
        assert_eq!(RateLimiter::new(true, false).client_ip(&h, peer), "10.0.0.1");
        assert_eq!(RateLimiter::new(true, true).client_ip(&h, peer), "203.0.113.9");
        h.insert("x-forwarded-for", "garbage".parse().unwrap());
        assert_eq!(RateLimiter::new(true, true).client_ip(&h, peer), "10.0.0.1");
    }
}
