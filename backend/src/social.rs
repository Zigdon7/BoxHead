use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Bluesky session from createSession API
#[derive(Deserialize, Debug)]
pub struct BskySession {
    pub did: String,
    pub handle: String,
    #[serde(rename = "accessJwt")]
    pub access_jwt: String,
}

/// Friend with online status (returned to frontend)
#[derive(Serialize)]
pub struct FriendStatus {
    pub user_id: String,
    pub display_name: String,
    pub handle: String,
    pub online: bool,
}

/// Google user info from token exchange
#[derive(Deserialize, Debug)]
pub struct GoogleUserInfo {
    pub sub: String,
    pub email: String,
    #[serde(default)]
    pub name: String,
}

/// Runtime online-presence tracking only.
/// All persistence (sessions, friends, accounts) is in db.rs.
pub struct SocialState {
    /// player_id (game websocket) -> internal user_id
    pub player_to_user: HashMap<String, String>,
    /// user_id -> player_id (reverse, for online status)
    pub user_to_player: HashMap<String, String>,
}

impl SocialState {
    pub fn new() -> Self {
        Self {
            player_to_user: HashMap::new(),
            user_to_player: HashMap::new(),
        }
    }

    pub fn link_player(&mut self, player_id: &str, user_id: &str) {
        self.player_to_user.insert(player_id.to_string(), user_id.to_string());
        self.user_to_player.insert(user_id.to_string(), player_id.to_string());
    }

    pub fn unlink_player(&mut self, player_id: &str) {
        if let Some(user_id) = self.player_to_user.remove(player_id) {
            self.user_to_player.remove(&user_id);
        }
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        self.user_to_player.contains_key(user_id)
    }
}

/// Determine the PDS service URL for a given handle.
/// Handles on zigdon.tech use the self-hosted PDS; everything else uses bsky.social.
fn pds_url_for_handle(handle: &str) -> &'static str {
    if handle.ends_with(".oge.social") || handle == "oge.social" {
        "https://pds.oge.social"
    } else {
        "https://bsky.social"
    }
}

/// Call AT Proto createSession API against the appropriate PDS
pub async fn bsky_login(handle: &str, password: &str) -> Result<BskySession, String> {
    let pds = pds_url_for_handle(handle);
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/xrpc/com.atproto.server.createSession", pds))
        .json(&serde_json::json!({
            "identifier": handle,
            "password": password,
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Bluesky auth failed ({}): {}", status, body));
    }

    res.json::<BskySession>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

/// Resolve a handle to a DID via the appropriate PDS
pub async fn resolve_handle(handle: &str) -> Result<String, String> {
    let pds = pds_url_for_handle(handle);
    let client = reqwest::Client::new();
    let url = format!(
        "{}/xrpc/com.atproto.identity.resolveHandle?handle={}",
        pds, handle
    );
    let res = client.get(&url).send().await
        .map_err(|e| format!("Network error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Handle '{}' not found", handle));
    }

    #[derive(Deserialize)]
    struct ResolveResponse {
        did: String,
    }

    let data: ResolveResponse = res.json().await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    Ok(data.did)
}

/// Exchange Google OAuth authorization code for user info.
pub async fn google_token_exchange(
    code: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<GoogleUserInfo, String> {
    let client = reqwest::Client::new();

    // Exchange auth code for tokens
    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !token_res.status().is_success() {
        let body = token_res.text().await.unwrap_or_default();
        return Err(format!("Google token exchange failed: {}", body));
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
    }

    let tokens: TokenResponse = token_res.json().await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    // Use access token to get user info
    let userinfo_res = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !userinfo_res.status().is_success() {
        let body = userinfo_res.text().await.unwrap_or_default();
        return Err(format!("Failed to get Google user info: {}", body));
    }

    userinfo_res.json::<GoogleUserInfo>().await
        .map_err(|e| format!("Failed to parse user info: {}", e))
}

/// Ask Steam to confirm an OpenID 2.0 sign-in assertion really came from it.
pub async fn steam_verify(params: &HashMap<String, String>) -> Result<(), String> {
    let mut form: Vec<(String, String)> = params.iter()
        .filter(|(k, _)| k.starts_with("openid."))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, v) in form.iter_mut() {
        if k == "openid.mode" { *v = "check_authentication".into(); }
    }
    let res = reqwest::Client::new()
        .post("https://steamcommunity.com/openid/login")
        .form(&form)
        .send().await
        .map_err(|e| format!("Couldn't reach Steam: {e}"))?;
    let body = res.text().await.map_err(|e| format!("Couldn't read Steam's reply: {e}"))?;
    if body.lines().any(|l| l.trim() == "is_valid:true") { Ok(()) } else { Err("Steam didn't confirm this sign-in.".into()) }
}

/// The Steam persona name: via the Web API when STEAM_API_KEY is set, else the public profile.
pub async fn steam_persona(steam_id: &str) -> Option<String> {
    let client = reqwest::Client::new();
    if let Some(key) = std::env::var("STEAM_API_KEY").ok().filter(|k| !k.trim().is_empty()) {
        let url = format!("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={key}&steamids={steam_id}");
        if let Ok(res) = client.get(&url).send().await {
            if let Ok(v) = res.json::<serde_json::Value>().await {
                if let Some(name) = v["response"]["players"][0]["personaname"].as_str() { return Some(name.to_string()); }
            }
        }
    }
    let xml = client.get(format!("https://steamcommunity.com/profiles/{steam_id}/?xml=1")).send().await.ok()?.text().await.ok()?;
    let start = xml.find("<steamID><![CDATA[")? + "<steamID><![CDATA[".len();
    let end = xml[start..].find("]]>")? + start;
    let name = xml[start..end].trim();
    (!name.is_empty()).then(|| name.chars().take(32).collect())
}
