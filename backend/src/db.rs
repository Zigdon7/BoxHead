use rusqlite::{Connection, params};
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

pub struct UserRow {
    pub id: String,
    pub display_name: String,
}

pub struct FriendRow {
    pub user_id: String,
    pub display_name: String,
    pub provider_handle: Option<String>,
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS linked_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL REFERENCES users(id),
                provider TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                provider_handle TEXT,
                UNIQUE(provider, provider_id)
            );

            CREATE TABLE IF NOT EXISTS email_credentials (
                user_id TEXT NOT NULL REFERENCES users(id),
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS friends (
                user_id TEXT NOT NULL REFERENCES users(id),
                friend_id TEXT NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, friend_id)
            );
        ").map_err(|e| format!("Failed to create schema: {}", e))?;

        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Find existing user by provider+provider_id, or create a new one.
    /// Returns the internal user_id.
    pub fn find_or_create_user(
        &self,
        provider: &str,
        provider_id: &str,
        provider_handle: &str,
        display_name: &str,
    ) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();

        // Check if this provider account already exists
        let existing: Option<String> = conn
            .query_row(
                "SELECT user_id FROM linked_accounts WHERE provider = ?1 AND provider_id = ?2",
                params![provider, provider_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(user_id) = existing {
            // Update handle in case it changed
            let _ = conn.execute(
                "UPDATE linked_accounts SET provider_handle = ?1 WHERE provider = ?2 AND provider_id = ?3",
                params![provider_handle, provider, provider_id],
            );
            return Ok(user_id);
        }

        // Create new user
        let user_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, display_name) VALUES (?1, ?2)",
            params![user_id, display_name],
        ).map_err(|e| format!("Failed to create user: {}", e))?;

        conn.execute(
            "INSERT INTO linked_accounts (user_id, provider, provider_id, provider_handle) VALUES (?1, ?2, ?3, ?4)",
            params![user_id, provider, provider_id, provider_handle],
        ).map_err(|e| format!("Failed to link account: {}", e))?;

        Ok(user_id)
    }

    /// Create a session token for a user. Returns the token.
    pub fn create_session(&self, user_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, datetime('now', '+30 days'))",
            params![token, user_id],
        ).map_err(|e| format!("Failed to create session: {}", e))?;
        Ok(token)
    }

    /// Validate a session token. Returns user_id if valid.
    pub fn validate_session(&self, token: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT user_id FROM sessions WHERE token = ?1 AND expires_at > datetime('now')",
            params![token],
            |row| row.get(0),
        ).ok()
    }

    /// Get user info by ID.
    pub fn get_user(&self, user_id: &str) -> Option<UserRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, display_name FROM users WHERE id = ?1",
            params![user_id],
            |row| Ok(UserRow {
                id: row.get(0)?,
                display_name: row.get(1)?,
            }),
        ).ok()
    }

    /// Get display handle for a user (first linked account handle found).
    pub fn get_user_handle(&self, user_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT provider_handle FROM linked_accounts WHERE user_id = ?1 LIMIT 1",
            params![user_id],
            |row| row.get(0),
        ).ok()
    }

    /// Add bidirectional friendship.
    pub fn add_friend(&self, user_id: &str, friend_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?1, ?2)",
            params![user_id, friend_id],
        ).map_err(|e| format!("Failed to add friend: {}", e))?;
        conn.execute(
            "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?1, ?2)",
            params![friend_id, user_id],
        ).map_err(|e| format!("Failed to add friend: {}", e))?;
        Ok(())
    }

    /// Remove bidirectional friendship.
    pub fn remove_friend(&self, user_id: &str, friend_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM friends WHERE user_id = ?1 AND friend_id = ?2",
            params![user_id, friend_id],
        ).map_err(|e| format!("Failed to remove friend: {}", e))?;
        conn.execute(
            "DELETE FROM friends WHERE user_id = ?1 AND friend_id = ?2",
            params![friend_id, user_id],
        ).map_err(|e| format!("Failed to remove friend: {}", e))?;
        Ok(())
    }

    /// Get friends list for a user.
    pub fn get_friends(&self, user_id: &str) -> Vec<FriendRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT u.id, u.display_name, la.provider_handle
             FROM friends f
             JOIN users u ON u.id = f.friend_id
             LEFT JOIN linked_accounts la ON la.user_id = f.friend_id
             WHERE f.user_id = ?1
             GROUP BY u.id"
        ).unwrap();

        stmt.query_map(params![user_id], |row| {
            Ok(FriendRow {
                user_id: row.get(0)?,
                display_name: row.get(1)?,
                provider_handle: row.get(2)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Find a user by provider handle (e.g., Bluesky handle or Google email).
    pub fn find_user_by_provider(
        &self,
        provider: &str,
        provider_id: &str,
    ) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT user_id FROM linked_accounts WHERE provider = ?1 AND provider_id = ?2",
            params![provider, provider_id],
            |row| row.get(0),
        ).ok()
    }

    /// Register a new email user. Returns user_id.
    pub fn register_email_user(&self, email: &str, password: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();

        // Check if email already exists
        let existing: Option<String> = conn
            .query_row(
                "SELECT user_id FROM email_credentials WHERE email = ?1",
                params![email],
                |row| row.get(0),
            )
            .ok();

        if existing.is_some() {
            return Err("Email already registered".to_string());
        }

        let hash = bcrypt::hash(password, 10)
            .map_err(|e| format!("Failed to hash password: {}", e))?;

        let user_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, display_name) VALUES (?1, ?2)",
            params![user_id, email],
        ).map_err(|e| format!("Failed to create user: {}", e))?;

        conn.execute(
            "INSERT INTO linked_accounts (user_id, provider, provider_id, provider_handle) VALUES (?1, 'email', ?2, ?2)",
            params![user_id, email],
        ).map_err(|e| format!("Failed to link account: {}", e))?;

        conn.execute(
            "INSERT INTO email_credentials (user_id, email, password_hash) VALUES (?1, ?2, ?3)",
            params![user_id, email, hash],
        ).map_err(|e| format!("Failed to store credentials: {}", e))?;

        Ok(user_id)
    }

    /// Verify email + password. Returns user_id if valid.
    pub fn verify_email_login(&self, email: &str, password: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();

        let row: Result<(String, String), _> = conn.query_row(
            "SELECT user_id, password_hash FROM email_credentials WHERE email = ?1",
            params![email],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );

        match row {
            Ok((user_id, hash)) => {
                if bcrypt::verify(password, &hash).unwrap_or(false) {
                    Ok(user_id)
                } else {
                    Err("Invalid password".to_string())
                }
            }
            Err(_) => Err("Email not found".to_string()),
        }
    }

    /// Clean up expired sessions.
    pub fn delete_expired_sessions(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')", []);
    }
}
