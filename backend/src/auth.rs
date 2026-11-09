//! Email accounts: sign-up with confirmation, sign-in, password reset, and
//! account deletion. Slow work (bcrypt, SQLite) runs off the async threads.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::{ratelimit, AppState};

/// Shortest password accepted for new passwords.
pub const MIN_PASSWORD: usize = 8;
const CONFIRM_TTL: i64 = 3 * 24 * 3600;
const RESET_TTL: i64 = 3600;

fn fail(error: impl Into<String>) -> Json<Value> {
    Json(json!({ "ok": false, "error": error.into() }))
}

/// Run blocking database work on the blocking pool.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

fn normalize_email(raw: &str) -> String { raw.trim().to_lowercase() }

fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else { return false };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        && email.len() <= 128 && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The address links in emails point at: BASE_URL, or the request's own host.
fn site(headers: &HeaderMap) -> String { crate::site_origin(headers) }

async fn send_confirmation(state: &AppState, headers: &HeaderMap, user: &str, email: &str) -> Result<(), String> {
    let (db, u) = (state.db.clone(), user.to_string());
    let token = blocking(move || db.issue_auth_token(&u, "confirm", CONFIRM_TTL)).await.unwrap_or_else(|| Err("Server error".into()))?;
    let link = format!("{}/api/auth/email/confirm?token={token}", site(headers));
    state.mailer.send(email, "Confirm your BoxHead account",
        &format!("Welcome to BoxHead.\n\nConfirm your email to start deploying:\n{link}\n\nThe link works for 3 days. If you didn't sign up, ignore this email.\n")).await
}

fn session_reply(token: &str, user_id: &str, email: &str, unconfirmed: bool) -> Json<Value> {
    Json(json!({
        "ok": true, "token": token, "user_id": user_id, "handle": email, "display_name": email,
        "verified": !unconfirmed, "emailUnconfirmed": unconfirmed.then_some(email),
    }))
}

/// POST /api/auth/email/register {email, password}
pub async fn register(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
    let email = normalize_email(body["email"].as_str().unwrap_or(""));
    let password = body["password"].as_str().unwrap_or("").to_string();
    if !valid_email(&email) { return fail("Enter a valid email address"); }
    if password.chars().count() < MIN_PASSWORD { return fail(format!("Password must be at least {MIN_PASSWORD} characters")); }
    let (db, e) = (state.db.clone(), email.clone());
    let made = blocking(move || {
        let user = db.register_email_user(&e, &password)?;
        let token = db.create_session(&user, "direct")?;
        Ok::<_, String>((user, token))
    }).await.unwrap_or_else(|| Err("Server error".into()));
    let (user, token) = match made {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    // The account exists either way; a failed send can be retried with "Resend".
    let mut reply = session_reply(&token, &user, &email, true);
    if let Err(e) = send_confirmation(&state, &headers, &user, &email).await { reply.0["mailError"] = e.into(); }
    reply
}

/// POST /api/auth/email/login {email, password}
pub async fn login(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let email = normalize_email(body["email"].as_str().unwrap_or(""));
    let password = body["password"].as_str().unwrap_or("").to_string();
    if email.is_empty() || password.is_empty() { return fail("Email and password required").into_response(); }
    // Per-email limit on top of the per-IP one, against guessing from many addresses.
    if let Err(retry) = state.limiter.check(ratelimit::LOGIN_EMAIL, &email) { return ratelimit::too_many(retry); }
    let (db, e) = (state.db.clone(), email.clone());
    let result = blocking(move || {
        let user = db.verify_email_login(&e, &password)?;
        let token = db.create_session(&user, "direct")?;
        let unconfirmed = db.unconfirmed_email(&user).is_some();
        Ok::<_, String>((user, token, unconfirmed))
    }).await.unwrap_or_else(|| Err("Server error".into()));
    match result {
        Ok((user, token, unconfirmed)) => session_reply(&token, &user, &email, unconfirmed).into_response(),
        Err(e) => fail(e).into_response(),
    }
}

/// GET /api/auth/email/confirm?token=... (the link in the email). Back to the game either way.
pub async fn confirm(State(state): State<Arc<AppState>>, Query(q): Query<std::collections::HashMap<String, String>>) -> Redirect {
    let token = q.get("token").cloned().unwrap_or_default();
    let db = state.db.clone();
    let ok = blocking(move || db.take_auth_token(&token, "confirm").is_some_and(|user| db.confirm_email(&user).is_ok()))
        .await.unwrap_or(false);
    Redirect::to(if ok { "/?email=confirmed" } else { "/?email=expired" })
}

/// POST /api/auth/email/resend {token}: send the confirmation link again.
pub async fn resend(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let token = body["token"].as_str().unwrap_or("").to_string();
    let db = state.db.clone();
    let Some((user, email)) = blocking(move || {
        let user = db.validate_session(&token)?;
        let email = db.unconfirmed_email(&user);
        Some((user, email))
    }).await.flatten() else { return fail("Sign in first").into_response() };
    let Some(email) = email else { return Json(json!({ "ok": true, "alreadyConfirmed": true })).into_response() };
    if let Err(retry) = state.limiter.check(ratelimit::MAIL, &format!("user:{user}")) { return ratelimit::too_many(retry); }
    match send_confirmation(&state, &headers, &user, &email).await {
        Ok(()) => Json(json!({ "ok": true, "sentTo": email })).into_response(),
        Err(e) => fail(e).into_response(),
    }
}

/// POST /api/auth/password/forgot {email}. Always answers the same way, so it
/// never reveals whether an email has an account.
pub async fn forgot(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let email = normalize_email(body["email"].as_str().unwrap_or(""));
    if !valid_email(&email) { return fail("Enter the email you signed up with").into_response(); }
    let reply = Json(json!({ "ok": true, "message": "If an account uses that email, a reset link is on its way. It works for one hour." }));
    // Limit per address too, so nobody can flood someone's inbox.
    if state.limiter.check(ratelimit::MAIL, &format!("email:{email}")).is_err() { return reply.into_response(); }
    let (db, e) = (state.db.clone(), email.clone());
    let token = blocking(move || db.user_by_email(&e).map(|user| db.issue_auth_token(&user, "reset", RESET_TTL))).await.flatten();
    if let Some(Ok(token)) = token {
        let link = format!("{}/?reset={token}", site(&headers));
        let _ = state.mailer.send(&email, "Reset your BoxHead password",
            &format!("Someone asked to reset the password for this BoxHead account.\n\nChoose a new password:\n{link}\n\nThe link works for one hour. If it wasn't you, ignore this email; your password stays the same.\n")).await;
    }
    reply.into_response()
}

/// POST /api/auth/password/reset {token, password}: set a new password from the
/// emailed link. Signs out every other device and signs this one in.
pub async fn reset(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let token = body["token"].as_str().unwrap_or("").to_string();
    let password = body["password"].as_str().unwrap_or("").to_string();
    if password.chars().count() < MIN_PASSWORD { return fail(format!("Password must be at least {MIN_PASSWORD} characters")); }
    let db = state.db.clone();
    let result = blocking(move || {
        let user = db.take_auth_token(&token, "reset").ok_or("That reset link has expired or was already used. Ask for a new one.")?;
        db.reset_password(&user, &password)?;
        let session = db.create_session(&user, "direct")?;
        let email = db.account_email(&user).map(|(e, _)| e).unwrap_or_default();
        Ok::<_, String>((user, session, email))
    }).await.unwrap_or_else(|| Err("Server error".into()));
    match result {
        Ok((user, session, email)) => session_reply(&session, &user, &email, false),
        Err(e) => fail(e),
    }
}

/// POST /api/account/delete {token, confirm: "DELETE"}: delete the account and everything on it.
pub async fn delete_account(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    if body["confirm"].as_str() != Some("DELETE") { return fail("Type DELETE to confirm"); }
    let token = body["token"].as_str().unwrap_or("").to_string();
    let db = state.db.clone();
    let result = blocking(move || {
        let user = db.validate_session(&token).ok_or("Sign in first")?;
        db.delete_account(&user).map(|_| user)
    }).await.unwrap_or_else(|| Err("Server error".into()));
    match result {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => fail(e),
    }
}

/// Why this account can't deploy or host yet, if it can't.
pub async fn email_gate(state: &AppState, user: &str) -> Option<String> {
    let (db, u) = (state.db.clone(), user.to_string());
    let email = blocking(move || db.unconfirmed_email(&u)).await.flatten()?;
    Some(format!("Confirm your email to deploy. We sent a link to {email}: check your inbox, or resend it from the home screen."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation_and_normalising() {
        assert_eq!(normalize_email("  Me@Example.COM "), "me@example.com");
        for good in ["a@b.co", "first.last+tag@mail.example.org"] { assert!(valid_email(good), "{good}"); }
        for bad in ["", "nope", "@b.co", "a@", "a@b", "a@.co", "a@b.", "a b@c.co", &format!("{}@b.co", "x".repeat(130))] {
            assert!(!valid_email(bad), "{bad}");
        }
    }
}
