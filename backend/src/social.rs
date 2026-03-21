use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};

/// Bluesky session from createSession API
#[derive(Deserialize, Debug)]
pub struct BskySession {
    pub did: String,
    pub handle: String,
    #[serde(rename = "accessJwt")]
    pub access_jwt: String,
}

/// A logged-in user
#[derive(Clone, Debug, Serialize)]
pub struct AuthUser {
    pub did: String,
    pub handle: String,
    pub display_name: String,
}

/// Friend with online status
#[derive(Serialize)]
pub struct FriendStatus {
    pub handle: String,
    pub did: String,
    pub online: bool,
}

/// Manages auth sessions and friend lists
pub struct SocialState {
    /// game_token -> AuthUser
    pub sessions: HashMap<String, AuthUser>,
    /// did -> set of friend DIDs
    pub friends: HashMap<String, HashSet<String>>,
    /// did -> handle (reverse lookup cache)
    pub handle_to_did: HashMap<String, String>,
    /// player_id (game) -> did
    pub player_to_did: HashMap<String, String>,
    /// did -> player_id (reverse)
    pub did_to_player: HashMap<String, String>,
}

impl SocialState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            friends: HashMap::new(),
            handle_to_did: HashMap::new(),
            player_to_did: HashMap::new(),
            did_to_player: HashMap::new(),
        }
    }

    pub fn add_session(&mut self, token: &str, user: AuthUser) {
        self.handle_to_did.insert(user.handle.clone(), user.did.clone());
        self.sessions.insert(token.to_string(), user);
    }

    pub fn get_user(&self, token: &str) -> Option<&AuthUser> {
        self.sessions.get(token)
    }

    pub fn link_player(&mut self, player_id: &str, did: &str) {
        self.player_to_did.insert(player_id.to_string(), did.to_string());
        self.did_to_player.insert(did.to_string(), player_id.to_string());
    }

    pub fn unlink_player(&mut self, player_id: &str) {
        if let Some(did) = self.player_to_did.remove(player_id) {
            self.did_to_player.remove(&did);
        }
    }

    pub fn is_online(&self, did: &str) -> bool {
        self.did_to_player.contains_key(did)
    }

    pub fn add_friend(&mut self, user_did: &str, friend_did: &str) {
        self.friends.entry(user_did.to_string()).or_default().insert(friend_did.to_string());
        // Bidirectional
        self.friends.entry(friend_did.to_string()).or_default().insert(user_did.to_string());
    }

    pub fn remove_friend(&mut self, user_did: &str, friend_did: &str) {
        if let Some(set) = self.friends.get_mut(user_did) {
            set.remove(friend_did);
        }
        if let Some(set) = self.friends.get_mut(friend_did) {
            set.remove(user_did);
        }
    }

    pub fn get_friends(&self, user_did: &str) -> Vec<FriendStatus> {
        let empty = HashSet::new();
        let friend_dids = self.friends.get(user_did).unwrap_or(&empty);
        friend_dids.iter().map(|did| {
            let handle = self.handle_to_did.iter()
                .find(|(_, d)| *d == did)
                .map(|(h, _)| h.clone())
                .unwrap_or_else(|| did[..16.min(did.len())].to_string());
            FriendStatus {
                handle,
                did: did.clone(),
                online: self.is_online(did),
            }
        }).collect()
    }
}

/// Call Bluesky createSession API
pub async fn bsky_login(handle: &str, password: &str) -> Result<BskySession, String> {
    let client = reqwest::Client::new();
    let res = client
        .post("https://bsky.social/xrpc/com.atproto.server.createSession")
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

/// Resolve a handle to a DID via Bluesky API
pub async fn resolve_handle(handle: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle={}",
        handle
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
