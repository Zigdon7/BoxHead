use rusqlite::{Connection, params};
use std::sync::Mutex;
use serde::Serialize;

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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LevelProgress {
    pub wave: u32,
    pub clears: u32,
    pub best_score: f64,
    pub best_kills: u32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSummary {
    pub highest_wave: u32,
    pub highest_cleared: u32,
    pub unlocked_wave: u32,
    pub levels: Vec<LevelProgress>,
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let mut conn = Connection::open(path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS wave_progress (
                profile_id TEXT PRIMARY KEY,
                highest_wave INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS level_progress (
                profile_id TEXT NOT NULL,
                wave INTEGER NOT NULL,
                clears INTEGER NOT NULL DEFAULT 1,
                best_score REAL NOT NULL DEFAULT 0,
                best_kills INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (profile_id, wave)
            );

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

        // Preserve legacy checkpoint access without inventing historical clears.
        let columns: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info(wave_progress)").map_err(|e| e.to_string())?;
            let rows = statement.query_map([], |row| row.get(1)).map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        if !columns.iter().any(|name| name == "highest_cleared") {
            transaction.execute_batch("ALTER TABLE wave_progress ADD COLUMN highest_cleared INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| e.to_string())?;
        }
        if !columns.iter().any(|name| name == "unlocked_wave") {
            transaction.execute_batch("ALTER TABLE wave_progress ADD COLUMN unlocked_wave INTEGER NOT NULL DEFAULT 1;
                UPDATE wave_progress SET unlocked_wave = MAX(1, highest_wave);")
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn highest_wave(&self, profile_id: &str) -> u32 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT highest_wave FROM wave_progress WHERE profile_id = ?1",
            params![profile_id], |row| row.get(0)).unwrap_or(1)
    }

    pub fn record_wave(&self, profile_id: &str, wave: u32) {
        let conn = self.conn.lock().unwrap();
        if let Err(error) = conn.execute(
            "INSERT INTO wave_progress (profile_id, highest_wave) VALUES (?1, ?2)
             ON CONFLICT(profile_id) DO UPDATE SET highest_wave = MAX(highest_wave, excluded.highest_wave)",
            params![profile_id, wave],
        ) { eprintln!("Could not save wave progress: {}", error); }
    }

    pub fn unlocked_wave(&self, profile_id: &str) -> u32 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT unlocked_wave FROM wave_progress WHERE profile_id = ?1",
            params![profile_id], |row| row.get(0)).unwrap_or(1)
    }

    pub fn progress(&self, profile_id: &str) -> ProgressSummary {
        let conn = self.conn.lock().unwrap();
        let (highest_wave, highest_cleared, unlocked_wave) = conn.query_row(
            "SELECT highest_wave, highest_cleared, unlocked_wave FROM wave_progress WHERE profile_id = ?1",
            params![profile_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap_or((1, 0, 1));
        let mut statement = conn.prepare("SELECT wave, clears, best_score, best_kills FROM level_progress
            WHERE profile_id = ?1 ORDER BY wave").unwrap();
        let levels = statement.query_map(params![profile_id], |row| Ok(LevelProgress {
            wave: row.get(0)?, clears: row.get(1)?, best_score: row.get(2)?, best_kills: row.get(3)?,
        })).unwrap().filter_map(Result::ok).collect();
        ProgressSummary { highest_wave, highest_cleared, unlocked_wave, levels }
    }

    pub fn record_clear(&self, profile_id: &str, wave: u32, score: f64, kills: u32) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        transaction.execute("INSERT INTO wave_progress (profile_id, highest_wave, highest_cleared) VALUES (?1, ?2, ?2)
            ON CONFLICT(profile_id) DO UPDATE SET highest_wave = MAX(highest_wave, excluded.highest_wave),
            highest_cleared = MAX(highest_cleared, excluded.highest_cleared)", params![profile_id, wave])
            .map_err(|e| e.to_string())?;
        transaction.execute("INSERT INTO level_progress (profile_id, wave, best_score, best_kills) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(profile_id, wave) DO UPDATE SET clears = clears + 1,
            best_score = MAX(best_score, excluded.best_score), best_kills = MAX(best_kills, excluded.best_kills)",
            params![profile_id, wave, score, kills]).map_err(|e| e.to_string())?;
        let mut unlocked: u32 = transaction.query_row("SELECT unlocked_wave FROM wave_progress WHERE profile_id = ?1",
            params![profile_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        // A high-wave squad clear is recorded, but cannot leapfrog an unfinished route.
        while unlocked < u32::MAX && transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM level_progress WHERE profile_id = ?1 AND wave = ?2)",
            params![profile_id, unlocked], |row| row.get::<_, bool>(0)).map_err(|e| e.to_string())? {
            unlocked += 1;
        }
        transaction.execute("UPDATE wave_progress SET unlocked_wave = ?2 WHERE profile_id = ?1", params![profile_id, unlocked])
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
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

#[cfg(test)]
mod wave_progress_tests {
    use super::*;

    #[test]
    fn wave_unlocks_are_monotonic_and_profile_specific() {
        let db = Database::open(":memory:").unwrap();
        assert_eq!(db.highest_wave("new-browser"), 1);
        db.record_wave("first", 8);
        db.record_wave("first", 3);
        db.record_wave("second", 4);
        assert_eq!(db.highest_wave("first"), 8);
        assert_eq!(db.highest_wave("second"), 4);
    }

    #[test]
    fn wave_unlocks_survive_database_reopen() {
        let path = std::env::temp_dir().join(format!("boxhead-progress-test-{}.db", uuid::Uuid::new_v4()));
        {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            db.record_wave("browser", 6);
        }
        {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            assert_eq!(db.highest_wave("browser"), 6);
        }
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod campaign_progress_tests {
    use super::*;

    #[test]
    fn visiting_a_high_wave_does_not_unlock_checkpoints() {
        let db = Database::open(":memory:").unwrap();
        db.record_wave("guest", 25);
        assert_eq!(db.progress("guest").highest_wave, 25);
        assert_eq!(db.unlocked_wave("guest"), 1);
        assert_eq!(db.progress("guest").highest_cleared, 0);
    }

    #[test]
    fn clears_unlock_sequentially_without_leapfrogging_gaps() {
        let db = Database::open(":memory:").unwrap();
        db.record_clear("guest", 3, 50.0, 2).unwrap();
        assert_eq!(db.unlocked_wave("guest"), 1);
        db.record_clear("guest", 1, 100.0, 12).unwrap();
        assert_eq!(db.unlocked_wave("guest"), 2);
        db.record_clear("guest", 2, 150.0, 24).unwrap();
        assert_eq!(db.unlocked_wave("guest"), 4);
        assert_eq!(db.progress("guest").highest_cleared, 3);
        assert_eq!(db.unlocked_wave("other"), 1);
    }

    #[test]
    fn replay_tracks_best_per_wave_stats_without_summing_scores() {
        let db = Database::open(":memory:").unwrap();
        db.record_clear("guest", 1, 200.0, 10).unwrap();
        db.record_clear("guest", 1, 75.0, 12).unwrap();
        let progress = db.progress("guest");
        assert_eq!(progress.levels.len(), 1);
        assert_eq!(progress.levels[0].clears, 2);
        assert_eq!(progress.levels[0].best_score, 200.0);
        assert_eq!(progress.levels[0].best_kills, 12);
        assert_eq!(progress.unlocked_wave, 2);
    }

    #[test]
    fn migration_preserves_legacy_access_without_fabricating_clears() {
        let path = std::env::temp_dir().join(format!("boxhead-legacy-{}.db", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE wave_progress (profile_id TEXT PRIMARY KEY, highest_wave INTEGER NOT NULL DEFAULT 1);
                INSERT INTO wave_progress VALUES ('old-player', 8);").unwrap();
        }
        for _ in 0..2 {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            let progress = db.progress("old-player");
            assert_eq!(progress.unlocked_wave, 8);
            assert_eq!(progress.highest_cleared, 0);
            assert!(progress.levels.is_empty());
            db.record_wave("old-player", 20);
        }
        {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            db.record_clear("old-player", 8, 500.0, 50).unwrap();
            assert_eq!(db.unlocked_wave("old-player"), 9);
        }
        std::fs::remove_file(path).unwrap();
    }
}
