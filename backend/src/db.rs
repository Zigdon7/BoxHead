use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::sync::Mutex;

use crate::gear::{self, Item, ItemKind, Loadout, MapDef, Rarity, Slot};
use crate::progression::{self as prog, Facility, Perk, Perks, RelocationReward, FACILITIES};
use crate::types::RaidOutcome;

#[cfg(test)]
#[path = "economy_tests.rs"]
mod economy_tests;

/// An item in someone's stash, and the loadout slot it's equipped in (if any).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StashItem {
    #[serde(flatten)]
    pub item: Item,
    pub slot: Option<Slot>,
    /// A sealed item marked to come along on the next raid, to decrypt it there.
    pub carry: bool,
    pub overflow: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Operator {
    /// The operator's key (its stash profile).
    pub id: String,
    /// Public identity, independent of legacy profiles that contain account IDs.
    pub friend_id: String,
    pub name: String,
    /// Chosen at creation: raidable operators can run PvP and their Homefront
    /// can be raided; safe ones can't, and their Homefront stops at the safe tier.
    pub raidable: bool,
    /// Homefront tier, 1 to 4.
    pub tier: u32,
    pub cash: u32,
    pub raids: u32,
    pub extracts: u32,
    pub deaths: u32,
    /// Room id of the raid this operator is deployed in, if any.
    pub in_raid: Option<String>,
    pub items: Vec<StashItem>,
}

impl Operator {
    pub fn loadout(&self) -> Loadout {
        let mut l = Loadout::default();
        for s in &self.items { if let Some(slot) = s.slot { l.set(slot, Some(s.item.clone())); } }
        l
    }
}

/// What extracting added to the stash.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RaidSettlement {
    pub cash_earned: u32,
    /// The loadout was insured, so a lost raid returned it.
    pub insured: bool,
    pub items_kept: u32,
    /// Compatibility field for older clients; new settlements never auto-sell.
    pub items_auto_sold: u32,
    /// Overflow awaiting the player's explicit keep/sell selection.
    pub items_pending: u32,
    pub cash: u32,
    /// Extra cash from Operations rank, perks and the season boost (already in `cash_earned`).
    #[serde(default)]
    pub bonus_cash: u32,
    /// The map raided and its Operations progress after this raid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<OpsProgress>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpsProgress {
    pub map: String,
    pub xp_gained: u32,
    pub xp: u32,
    pub rank: u32,
    pub ranked_up: bool,
    /// XP needed for the next rank (None at the top).
    pub next: Option<u32>,
}

/// A row in the account's operator list.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OperatorSummary {
    pub id: String,
    pub name: String,
    pub raidable: bool,
    pub tier: u32,
    pub cash: u32,
    pub gear_score: u32,
    pub in_raid: bool,
    pub active: bool,
}

/// Account-wide Legacy: earned by relocating operators at the end of a season.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub legacy_earned: u32,
    pub legacy_available: u32,
    pub stash_bonus: u32,
    pub relocations: u32,
    /// Season id of the last relocation.
    pub last_relocation: Option<String>,
    /// Head-start boost level and the season it applies to.
    pub boost_level: u32,
    pub boost_season: Option<String>,
    pub perks: Perks,
    pub badges: Vec<Badge>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Badge {
    pub season: String,
    pub operator: String,
    pub value: u32,
}

/// Everything about an operator's Homefront and account that changes its numbers.
#[derive(Clone, Debug, Default)]
pub struct OperatorContext {
    pub account: Option<String>,
    pub raidable: bool,
    pub tier: u32,
    pub facilities: [u32; 4],
    pub produced_at: i64,
    pub perks: Perks,
    pub account_stash_bonus: u32,
    /// The season boost, if it applies to the current season.
    pub boost_level: u32,
}

impl OperatorContext {
    pub fn facility(&self, f: Facility) -> u32 { self.facilities[FACILITIES.iter().position(|&x| x == f).unwrap()] }
    pub fn stash_capacity(&self) -> usize {
        gear::STASH_CAPACITY + (prog::storage_bonus(self.facility(Facility::Storage)) + self.account_stash_bonus + self.perks.stash_bonus()) as usize
    }
    pub fn insurance_rate(&self) -> f64 { prog::insurance_rate(self.facility(Facility::Office), self.perks.broker) }
    pub fn armory_powers(&self) -> &'static [u32] { prog::armory_powers(self.facility(Facility::Armory)) }
    pub fn raid_boost(&self) -> gear::RaidBoost {
        gear::RaidBoost { max_health: self.perks.health_bonus(), damage: self.perks.damage_mult() - 1.0 }
    }
    pub fn workshop_stored(&self, now: i64) -> u32 {
        prog::workshop_stored(self.facility(Facility::Workshop), now - self.produced_at)
    }
}

/// The login error for both an unknown email and a wrong password.
pub const WRONG_LOGIN: &str = "Wrong email or password";

/// Tokens in links are stored hashed, so a leaked database can't be used to sign in.
fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

pub struct Database {
    conn: Mutex<Connection>,
}

pub struct UserRow {
    pub id: String,
    pub display_name: String,
}

pub struct FriendRow {
    pub user_id: String,
}

pub struct OperatorFriendRow {
    pub id: String,
    pub name: String,
    pub account: String,
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path)
            .map_err(|e| format!("Failed to open database: {}", e))?;
        // WAL + synchronous=NORMAL: commits append to the log without an fsync each
        // (durable across crashes of the process; a power cut can lose the last few).
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;")
            .map_err(|e| format!("Failed to configure database: {}", e))?;

        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS operators (
                profile TEXT PRIMARY KEY,
                cash INTEGER NOT NULL DEFAULT 0,
                raids INTEGER NOT NULL DEFAULT 0,
                extracts INTEGER NOT NULL DEFAULT 0,
                deaths INTEGER NOT NULL DEFAULT 0,
                in_raid TEXT,
                insured INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                profile TEXT NOT NULL,
                kind TEXT NOT NULL,
                rarity TEXT NOT NULL,
                power INTEGER NOT NULL,
                name TEXT NOT NULL,
                slot TEXT
            );
            CREATE INDEX IF NOT EXISTS items_by_profile ON items(profile);

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
        // Databases created before insurance existed get the column added (fails harmlessly if present).
        let _ = conn.execute("ALTER TABLE operators ADD COLUMN insured INTEGER NOT NULL DEFAULT 0", []);
        // carry: 0 = stays home, 1 = bring on the next raid, 2 = in the raid right now.
        let _ = conn.execute("ALTER TABLE items ADD COLUMN carry INTEGER NOT NULL DEFAULT 0", []);
        for column in ["protected INTEGER NOT NULL DEFAULT 0", "origin_tier INTEGER NOT NULL DEFAULT 0", "overflow INTEGER NOT NULL DEFAULT 0"] {
            let _ = conn.execute(&format!("ALTER TABLE items ADD COLUMN {column}"), []);
        }
        // Operators belong to accounts; several per account, each with a Homefront.
        for column in [
            "account TEXT", "name TEXT NOT NULL DEFAULT 'Operator 1'", "raidable INTEGER NOT NULL DEFAULT 0",
            "created_at INTEGER NOT NULL DEFAULT 0", "tier INTEGER NOT NULL DEFAULT 1",
            "produced_at INTEGER NOT NULL DEFAULT 0", "raid_map TEXT",
            // What the current raid cost, so a voided raid can pay it back.
            "raid_fee INTEGER NOT NULL DEFAULT 0", "raid_premium INTEGER NOT NULL DEFAULT 0",
            "friend_id TEXT", "material_investment INTEGER NOT NULL DEFAULT 0",
        ] {
            let _ = conn.execute(&format!("ALTER TABLE operators ADD COLUMN {column}"), []);
        }
        // Older single-operator profiles contained their account's ID. Give
        // every operator an independent public ID before exposing friendships.
        let missing: Vec<String> = conn.prepare("SELECT profile FROM operators WHERE friend_id IS NULL")
            .and_then(|mut s| s.query_map([], |r| r.get(0)).map(|rows| rows.flatten().collect())).map_err(|e| e.to_string())?;
        for profile in missing {
            let id = format!("op:{}", uuid::Uuid::new_v4());
            conn.execute("UPDATE operators SET friend_id = ?1 WHERE profile = ?2", params![id, profile]).map_err(|e| e.to_string())?;
        }
        conn.execute_batch("
            CREATE INDEX IF NOT EXISTS operators_by_account ON operators(account);
            CREATE UNIQUE INDEX IF NOT EXISTS operators_by_friend_id ON operators(friend_id);
            CREATE TABLE IF NOT EXISTS operator_friends (
                profile TEXT NOT NULL,
                friend_profile TEXT NOT NULL,
                PRIMARY KEY (profile, friend_profile)
            );
            CREATE INDEX IF NOT EXISTS operator_friends_by_target ON operator_friends(friend_profile);
            CREATE TABLE IF NOT EXISTS facilities (
                profile TEXT NOT NULL,
                facility TEXT NOT NULL,
                level INTEGER NOT NULL,
                PRIMARY KEY (profile, facility)
            );
            CREATE TABLE IF NOT EXISTS operations (
                profile TEXT NOT NULL,
                map TEXT NOT NULL,
                xp INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (profile, map)
            );
            CREATE TABLE IF NOT EXISTS accounts (
                user_id TEXT PRIMARY KEY,
                active_operator TEXT,
                legacy_earned INTEGER NOT NULL DEFAULT 0,
                stash_bonus INTEGER NOT NULL DEFAULT 0,
                relocations INTEGER NOT NULL DEFAULT 0,
                last_relocation TEXT,
                boost_level INTEGER NOT NULL DEFAULT 0,
                boost_season TEXT
            );
            CREATE TABLE IF NOT EXISTS account_perks (
                user_id TEXT NOT NULL,
                perk TEXT NOT NULL,
                rank INTEGER NOT NULL,
                PRIMARY KEY (user_id, perk)
            );
            CREATE TABLE IF NOT EXISTS account_badges (
                user_id TEXT NOT NULL,
                season TEXT NOT NULL,
                operator TEXT NOT NULL,
                value INTEGER NOT NULL,
                PRIMARY KEY (user_id, season)
            );
            -- Operators from before accounts could hold several were keyed by the account.
            UPDATE operators SET account = substr(profile, 6) WHERE account IS NULL AND profile LIKE 'user:%';
        ").map_err(|e| format!("Failed to create progression schema: {}", e))?;
        let _ = conn.execute("ALTER TABLE operations ADD COLUMN requisition INTEGER NOT NULL DEFAULT 0", []);
        // Matchmaking: the platform a session signed in with, and the account's cross-platform opt-in.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN platform TEXT NOT NULL DEFAULT 'direct'", []);
        let _ = conn.execute("ALTER TABLE accounts ADD COLUMN crossplay INTEGER NOT NULL DEFAULT 0", []);
        // Email confirmation. Accounts from before it existed count as confirmed.
        let _ = conn.execute("ALTER TABLE email_credentials ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 1", []);
        conn.execute_batch("
            -- One-time links (confirm email, reset password). Only a hash of the token is stored.
            CREATE TABLE IF NOT EXISTS auth_tokens (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
        ").map_err(|e| format!("Failed to create auth schema: {}", e))?;

        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---------- Operators, stash and raids ----------

    fn insert_item(conn: &Connection, profile: &str, item: &Item, slot: Option<Slot>) -> rusqlite::Result<usize> {
        conn.execute(
            "INSERT INTO items (id, profile, kind, rarity, power, name, slot, protected, origin_tier) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![item.id, profile, item.kind.as_str(), item.rarity.as_str(), item.power, item.name, slot.map(|s| s.as_str()), item.protected, item.origin_tier],
        )
    }

    /// Create a new operator with the starter kit, if this profile has none.
    pub fn ensure_operator(&self, profile: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let created = tx.execute("INSERT OR IGNORE INTO operators (profile, cash, friend_id) VALUES (?1, ?2, ?3)", params![profile, gear::STARTING_CASH, format!("op:{}", uuid::Uuid::new_v4())])
            .map_err(|e| e.to_string())?;
        if created > 0 {
            for (item, slot) in gear::starter_kit() { Self::insert_item(&tx, profile, &item, slot).map_err(|e| e.to_string())?; }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn operator(&self, profile: &str) -> Option<Operator> {
        let conn = self.conn.lock().unwrap();
        Self::load_operator(&conn, profile)
    }

    fn load_operator(conn: &Connection, profile: &str) -> Option<Operator> {
        let (cash, raids, extracts, deaths, in_raid, name, raidable, tier, friend_id) = conn.query_row(
            "SELECT cash, raids, extracts, deaths, in_raid, name, raidable, tier, friend_id FROM operators WHERE profile = ?1", params![profile],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, String>(5)?, r.get::<_, i32>(6)? != 0, r.get::<_, u32>(7)?, r.get(8)?)),
        ).optional().ok()??;
        let mut stmt = conn.prepare("SELECT id, kind, rarity, power, name, slot, carry, protected, origin_tier, overflow FROM items WHERE profile = ?1 ORDER BY slot IS NULL, power DESC, name").ok()?;
        let rows = stmt.query_map(params![profile], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, u32>(3)?, r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, i32>(6)?, r.get::<_, bool>(7)?, r.get::<_, u32>(8)?, r.get::<_, bool>(9)?))
        }).ok()?;
        let items = rows.filter_map(|r| r.ok()).filter_map(|(id, kind, rarity, power, name, slot, carry, protected, origin_tier, overflow)| {
            let (kind, rarity) = (ItemKind::parse(&kind)?, Rarity::parse(&rarity)?);
            let value = gear::sell_value(kind, rarity, power);
            Some(StashItem { item: Item { id, kind, rarity, power, name, value, protected, origin_tier }, slot: slot.as_deref().and_then(Slot::parse), carry: carry != 0, overflow })
        }).collect();
        Some(Operator { id: profile.to_string(), friend_id, name, raidable, tier, cash, raids, extracts, deaths, in_raid, items })
    }

    fn not_in_raid(conn: &Connection, profile: &str) -> Result<(), String> {
        let in_raid: Option<String> = conn.query_row("SELECT in_raid FROM operators WHERE profile = ?1", params![profile], |r| r.get(0))
            .map_err(|_| "No operator for this profile".to_string())?;
        if in_raid.is_some() { Err("You're in a raid. Finish it before changing your gear.".into()) } else { Ok(()) }
    }

    fn stash_size(conn: &Connection, profile: &str) -> Result<usize, String> {
        conn.query_row("SELECT COUNT(*) FROM items WHERE profile = ?1 AND slot IS NULL AND overflow = 0", params![profile], |r| r.get(0)).map_err(|e| e.to_string())
    }

    fn cash_of(conn: &Connection, profile: &str) -> Result<u32, String> {
        conn.query_row("SELECT cash FROM operators WHERE profile = ?1", params![profile], |r| r.get(0)).map_err(|e| e.to_string())
    }

    /// Equip a stash item in a slot, moving whatever was there back to the stash.
    pub fn equip(&self, profile: &str, item_id: &str, slot: Slot) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let (kind, current): (String, Option<String>) = tx.query_row("SELECT kind, slot FROM items WHERE id = ?1 AND profile = ?2 AND overflow = 0", params![item_id, profile], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| "Item not found".to_string())?;
        let kind = ItemKind::parse(&kind).ok_or("Unknown item")?;
        if !kind.fits(slot) { return Err(format!("A {} can't go in the {} slot", kind.label(), slot.as_str())); }
        if current.as_deref() == Some(slot.as_str()) { return Ok(()); }
        let occupied: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM items WHERE profile = ?1 AND slot = ?2)", params![profile, slot.as_str()], |r| r.get(0)).map_err(|e| e.to_string())?;
        // Moving an equipped item to another slot sends that slot's item to the stash.
        if current.is_some() && occupied && Self::stash_size(&tx, profile)? >= Self::context_in(&tx, profile, 0).stash_capacity() {
            return Err("Your stash is full. Sell something first.".into());
        }
        tx.execute("UPDATE items SET slot = NULL WHERE profile = ?1 AND slot = ?2", params![profile, slot.as_str()]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE items SET slot = ?1 WHERE id = ?2", params![slot.as_str(), item_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn unequip(&self, profile: &str, slot: Slot) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        if Self::stash_size(&tx, profile)? >= Self::context_in(&tx, profile, 0).stash_capacity() { return Err("Your stash is full. Sell something first.".into()); }
        tx.execute("UPDATE items SET slot = NULL WHERE profile = ?1 AND slot = ?2", params![profile, slot.as_str()]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Sell an item to the trader. Returns the new cash balance.
    pub fn sell(&self, profile: &str, item_id: &str) -> Result<u32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let (kind, rarity, power): (String, String, u32) = tx.query_row(
            "SELECT kind, rarity, power FROM items WHERE id = ?1 AND profile = ?2", params![item_id, profile],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|_| "Item not found".to_string())?;
        Self::unprotected(&tx, profile, item_id)?;
        let value = gear::sell_value(ItemKind::parse(&kind).ok_or("Unknown item")?, Rarity::parse(&rarity).ok_or("Unknown item")?, power);
        tx.execute("DELETE FROM items WHERE id = ?1", params![item_id]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE operators SET cash = cash + ?1 WHERE profile = ?2", params![value, profile]).map_err(|e| e.to_string())?;
        let cash = Self::cash_of(&tx, profile)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(cash)
    }

    /// Sell several stash items at once. Returns the new cash balance.
    pub fn sell_many(&self, profile: &str, item_ids: &[String]) -> Result<u32, String> {
        if item_ids.is_empty() { return Err("Pick something to sell".into()); }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let mut total = 0u32;
        for id in item_ids {
            Self::unprotected(&tx, profile, id)?;
            let (kind, rarity, power, slot): (String, String, u32, Option<String>) = tx.query_row(
                "SELECT kind, rarity, power, slot FROM items WHERE id = ?1 AND profile = ?2", params![id, profile],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ).map_err(|_| "Item not found".to_string())?;
            if slot.is_some() { return Err("Unequip gear before bulk-selling it".into()); }
            total += gear::sell_value(ItemKind::parse(&kind).ok_or("Unknown item")?, Rarity::parse(&rarity).ok_or("Unknown item")?, power);
            tx.execute("DELETE FROM items WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE operators SET cash = cash + ?1 WHERE profile = ?2", params![total, profile]).map_err(|e| e.to_string())?;
        let cash = Self::cash_of(&tx, profile)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(cash)
    }

    /// Mark (or unmark) a sealed stash item to come along on the next raid,
    /// where it can be decrypted. It takes a pack slot and is lost if you are.
    pub fn set_carry(&self, profile: &str, item_id: &str, carry: bool) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let (kind, slot): (String, Option<String>) = tx.query_row("SELECT kind, slot FROM items WHERE id = ?1 AND profile = ?2 AND overflow = 0", params![item_id, profile], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| "Item not found".to_string())?;
        if ItemKind::parse(&kind) != Some(ItemKind::Encrypted) || slot.is_some() {
            return Err("Only encrypted items can be brought along to decrypt".into());
        }
        if carry {
            let op = Self::load_operator(&tx, profile).ok_or("No operator")?;
            let room = op.loadout().pack.as_ref().map_or(gear::NO_PACK_CAPACITY, |p| gear::pack_capacity(p.power)) as usize;
            let already = op.items.iter().filter(|s| s.carry && s.item.id != item_id).count();
            if already >= room { return Err(format!("Your pack only has room for {room}.")); }
        }
        tx.execute("UPDATE items SET carry = ?1 WHERE id = ?2", params![carry as i32, item_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// The sealed items that went into the current raid.
    pub fn raid_carry(&self, profile: &str) -> Vec<Item> {
        self.operator(profile).map_or_else(Vec::new, |op| {
            let conn = self.conn.lock().unwrap();
            let in_raid: Vec<String> = conn.prepare("SELECT id FROM items WHERE profile = ?1 AND carry = 2").and_then(|mut s| {
                s.query_map(params![profile], |r| r.get(0)).map(|rows| rows.filter_map(|r| r.ok()).collect())
            }).unwrap_or_default();
            op.items.into_iter().filter(|s| in_raid.contains(&s.item.id)).map(|s| s.item).collect()
        })
    }

    fn unprotected(conn: &Connection, profile: &str, id: &str) -> Result<(), String> {
        let protected: bool = conn.query_row("SELECT protected FROM items WHERE profile = ?1 AND id = ?2", params![profile,id], |r| r.get(0))
            .map_err(|_| "Item not found".to_string())?;
        if protected { Err("Unprotect this item before selling or consuming it.".into()) } else { Ok(()) }
    }

    pub fn protect_item(&self, profile: &str, id: &str, protected: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        Self::not_in_raid(&conn, profile)?;
        let changed = conn.execute("UPDATE items SET protected = ?1 WHERE profile = ?2 AND id = ?3", params![protected,profile,id]).map_err(|e| e.to_string())?;
        if changed == 0 { Err("Item not found".into()) } else { Ok(()) }
    }

    /// Select overflow to retain; the previewed remainder is sold atomically.
    pub fn resolve_overflow(&self, profile: &str, expected: &[String], keep: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let op = Self::load_operator(&tx, profile).ok_or("No operator")?;
        let overflow: Vec<_> = op.items.iter().filter(|s| s.overflow).collect();
        let preview: std::collections::HashSet<_> = expected.iter().collect();
        if preview.len() != expected.len() || preview.len() != overflow.len()
            || overflow.iter().any(|s| !preview.contains(&s.item.id)) {
            return Err("Your overflow changed. Review the current items before confirming.".into());
        }
        let ids: std::collections::HashSet<_> = keep.iter().collect();
        if ids.len() != keep.len() || ids.iter().any(|id| !overflow.iter().any(|s| s.item.id == **id)) { return Err("Invalid overflow selection".into()); }
        let capacity = Self::context_in(&tx, profile, 0).stash_capacity();
        if Self::stash_size(&tx, profile)? + keep.len() > capacity { return Err("Make room in your stash for the selected items first.".into()); }
        let mut sold = 0;
        for item in overflow {
            if keep.contains(&item.item.id) {
                tx.execute("UPDATE items SET overflow = 0 WHERE id = ?1", params![item.item.id]).map_err(|e| e.to_string())?;
            } else {
                Self::unprotected(&tx, profile, &item.item.id)?;
                sold += item.item.value;
                tx.execute("DELETE FROM items WHERE id = ?1", params![item.item.id]).map_err(|e| e.to_string())?;
            }
        }
        tx.execute("UPDATE operators SET cash = cash + ?1 WHERE profile = ?2", params![sold,profile]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn requisition_balance(&self, profile: &str, map: &str) -> u32 {
        self.conn.lock().unwrap().query_row("SELECT requisition FROM operations WHERE profile = ?1 AND map = ?2", params![profile,map], |r| r.get(0)).unwrap_or(0)
    }

    pub fn requisition(&self, profile: &str, map: &'static MapDef, kind: ItemKind) -> Result<Item, String> {
        if !kind.is_gear() { return Err("Choose a weapon, armor or pack.".into()); }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let ctx = Self::context_in(&tx, profile, 0);
        if ctx.facility(Facility::Armory) == 0 { return Err("Build Armory level 1 to request targeted gear.".into()); }
        let op = Self::load_operator(&tx, profile).ok_or("No operator")?;
        if op.items.iter().any(|s| s.overflow) || Self::stash_size(&tx, profile)? >= ctx.stash_capacity() { return Err("Resolve overflow and make a stash slot first.".into()); }
        let changed = tx.execute("UPDATE operations SET requisition = requisition - ?1 WHERE profile = ?2 AND map = ?3 AND requisition >= ?1", params![prog::REQUISITION_COST, profile, map.id]).map_err(|e| e.to_string())?;
        if changed == 0 { return Err(format!("Earn {} requisition credits by extracting with activity on {}.", prog::REQUISITION_COST, map.name)); }
        let mut item = Item::new(kind, Rarity::Rare, map.loot_power.1 + 6, None);
        item.origin_tier = map.tier;
        item.protected = true;
        Self::insert_item(&tx, profile, &item, None).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(item)
    }

    /// Buy a trader offer into the stash. Returns the new item.
    pub fn buy(&self, profile: &str, offer_id: &str) -> Result<Item, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let ctx = Self::context_in(&tx, profile, 0);
        let offer = gear::find_offer(offer_id, ctx.armory_powers()).ok_or("That offer doesn't exist")?;
        let cash = Self::cash_of(&tx, profile)?;
        if cash < offer.price { return Err(format!("You need ${} more", offer.price - cash)); }
        if Self::stash_size(&tx, profile)? >= ctx.stash_capacity() { return Err("Your stash is full. Sell something first.".into()); }
        let item = Item::new(offer.kind, offer.rarity, offer.power, Some(offer.name.clone()));
        Self::insert_item(&tx, profile, &item, None).map_err(|e| e.to_string())?;
        tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2", params![offer.price, profile]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(item)
    }

    /// Deploy: check the gear score against the map and lock the loadout into
    /// the raid. Fails if the operator is already in a raid.
    #[cfg(test)]
    pub fn begin_raid(&self, profile: &str, room_id: &str, min_gear_score: u32) -> Result<Loadout, String> {
        self.begin_raid_paying(profile, room_id, min_gear_score, 0, false)
    }

    /// Deploy, paying the map's entry fee (kept even if the raid is lost) and,
    /// if asked, insurance on the loadout.
    #[cfg(test)]
    pub fn begin_raid_paying(&self, profile: &str, room_id: &str, min_gear_score: u32, fee: u32, insure: bool) -> Result<Loadout, String> {
        self.begin(profile, room_id, min_gear_score, Some(fee), insure, None, now_secs()).map(|(loadout, _)| loadout)
    }

    /// Deploy to a map: its gear-score gate, its entry fee less the operator's
    /// Operations discount, and the operator's Homefront and Legacy bonuses.
    #[cfg(test)]
    pub fn deploy(&self, profile: &str, room_id: &str, map: &'static MapDef, insure: bool) -> Result<Loadout, String> {
        self.deploy_named(profile, room_id, map, insure).map(|(loadout, _)| loadout)
    }

    /// Return the stored callsign from the same transaction that locks the kit.
    pub fn deploy_named(&self, profile: &str, room_id: &str, map: &'static MapDef, insure: bool) -> Result<(Loadout, String), String> {
        self.begin(profile, room_id, map.min_gear_score, None, insure, Some(map), now_secs())
    }

    #[allow(clippy::too_many_arguments)]
    fn begin(&self, profile: &str, room_id: &str, min_gear_score: u32, fee: Option<u32>, insure: bool, map: Option<&'static MapDef>, now: i64) -> Result<(Loadout, String), String> {
        self.ensure_operator(profile)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let op = Self::load_operator(&tx, profile).ok_or("No operator for this profile")?;
        if op.items.iter().any(|s| s.overflow) { return Err("Review your extraction overflow in the stash before deploying.".into()); }
        if op.in_raid.is_some() { return Err("You're already deployed in another raid.".into()); }
        let ctx = Self::context_in(&tx, profile, now);
        if let Some(account) = &ctx.account {
            let busy: Option<String> = tx.query_row("SELECT name FROM operators WHERE account = ?1 AND profile != ?2 AND in_raid IS NOT NULL LIMIT 1",
                params![account, profile], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            if let Some(name) = busy { return Err(format!("{name} is already deployed. One operator per account at a time.")); }
        }
        let mut loadout = op.loadout();
        loadout.boost = ctx.raid_boost();
        let gs = loadout.gear_score();
        if gs < min_gear_score {
            return Err(format!("Gear score {gs} is too low: this map needs {min_gear_score}."));
        }
        let fee = fee.unwrap_or_else(|| map.map_or(0, |m| prog::ops_fee(m, prog::ops_rank(Self::ops_xp_in(&tx, profile, m.id)))));
        let premium = if insure { gear::insurance_cost_at(&loadout, ctx.insurance_rate()) } else { 0 };
        if op.cash < fee + premium {
            return Err(if premium > 0 {
                format!("Entry fee ${fee} plus insurance ${premium} is more than your ${}.", op.cash)
            } else {
                format!("This map's entry fee is ${fee}. You have ${}.", op.cash)
            });
        }
        tx.execute("UPDATE operators SET in_raid = ?1, cash = cash - ?3, insured = ?4, raid_map = ?5, raid_fee = ?6, raid_premium = ?7 WHERE profile = ?2",
            params![room_id, profile, fee + premium, (premium > 0) as i32, map.map(|m| m.id), fee, premium]).map_err(|e| e.to_string())?;
        // Sealed items marked to come along go into the pack, as many as fit.
        let room = loadout.pack.as_ref().map_or(gear::NO_PACK_CAPACITY, |p| gear::pack_capacity(p.power));
        tx.execute("UPDATE items SET carry = 2 WHERE id IN (SELECT id FROM items WHERE profile = ?1 AND carry = 1 AND slot IS NULL LIMIT ?2)",
            params![profile, room]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((loadout, op.name))
    }

    /// Settle a finished raid. Extracting keeps the loadout, banks the bounty and
    /// stores the loot (selling whatever doesn't fit). Anything else loses the
    /// equipped gear. A profile that isn't in a raid is left untouched.
    pub fn finish_raid(&self, profile: &str, outcome: &RaidOutcome) -> Result<RaidSettlement, String> {
        self.finish_raid_in(profile, None, outcome)
    }

    /// Settle a raid, checking it's the raid this profile is deployed in.
    pub fn finish_raid_in(&self, profile: &str, room_id: Option<&str>, outcome: &RaidOutcome) -> Result<RaidSettlement, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let in_raid: Option<String> = tx.query_row("SELECT in_raid FROM operators WHERE profile = ?1", params![profile], |r| r.get(0))
            .optional().map_err(|e| e.to_string())?.flatten();
        match (&in_raid, room_id) {
            (None, _) => return Err("Not in a raid".into()),
            (Some(r), Some(want)) if r != want => return Err(format!("Deployed in {r}, not {want}")),
            _ => {}
        }
        let mut settlement = RaidSettlement::default();
        let ctx = Self::context_in(&tx, profile, now_secs());
        let raid_map: Option<String> = tx.query_row("SELECT raid_map FROM operators WHERE profile = ?1", params![profile], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let map = raid_map.as_deref().and_then(gear::map_by_id);
        let old_xp = map.map_or(0, |m| Self::ops_xp_in(&tx, profile, m.id));
        // Items carried in are now part of the raid's loot (or lost with it).
        tx.execute("DELETE FROM items WHERE profile = ?1 AND carry = 2", params![profile]).map_err(|e| e.to_string())?;
        if outcome.result.kept_gear() {
            let mut stash = Self::stash_size(&tx, profile)?;
            let bonus = map.map_or(0.0, |_| prog::ops_bounty_bonus(prog::ops_rank(old_xp)))
                + ctx.perks.bounty_bonus() + prog::boost_bounty_bonus(ctx.boost_level);
            settlement.bonus_cash = (outcome.bounty as f64 * bonus).round() as u32;
            settlement.cash_earned = outcome.bounty + settlement.bonus_cash;
            let capacity = ctx.stash_capacity();
            for item in &outcome.loot {
                let mut fresh = item.clone();
                fresh.id = uuid::Uuid::new_v4().to_string();
                Self::insert_item(&tx, profile, &fresh, None).map_err(|e| e.to_string())?;
                if stash < capacity {
                    stash += 1;
                    settlement.items_kept += 1;
                } else {
                    tx.execute("UPDATE items SET overflow = 1 WHERE id = ?1", params![fresh.id]).map_err(|e| e.to_string())?;
                    settlement.items_pending += 1;
                }
            }
            tx.execute("UPDATE operators SET cash = cash + ?1, extracts = extracts + 1 WHERE profile = ?2", params![settlement.cash_earned, profile]).map_err(|e| e.to_string())?;
        } else {
            let insured: bool = tx.query_row("SELECT insured FROM operators WHERE profile = ?1", params![profile], |r| r.get::<_, i32>(0)).map_err(|e| e.to_string())? != 0;
            settlement.insured = insured;
            if !insured {
                tx.execute("DELETE FROM items WHERE profile = ?1 AND slot IS NOT NULL", params![profile]).map_err(|e| e.to_string())?;
            }
            tx.execute("UPDATE operators SET deaths = deaths + 1 WHERE profile = ?1", params![profile]).map_err(|e| e.to_string())?;
        }
        if let Some(m) = map {
            let gained = prog::ops_xp_for(outcome.result.kept_gear(), outcome.kills, &outcome.activity, ctx.boost_level);
            let xp = old_xp + gained;
            tx.execute("INSERT INTO operations (profile, map, xp) VALUES (?1, ?2, ?3) ON CONFLICT(profile, map) DO UPDATE SET xp = ?3",
                params![profile, m.id, xp]).map_err(|e| e.to_string())?;
            if outcome.result.kept_gear() {
                let credits = prog::activity_points(outcome.kills, &outcome.activity);
                tx.execute("UPDATE operations SET requisition = requisition + ?1 WHERE profile = ?2 AND map = ?3",
                    params![credits, profile, m.id]).map_err(|e| e.to_string())?;
            }
            settlement.ops = Some(OpsProgress {
                map: m.id.to_string(), xp_gained: gained, xp, rank: prog::ops_rank(xp),
                ranked_up: prog::ops_rank(xp) > prog::ops_rank(old_xp), next: prog::ops_next(xp),
            });
        }
        tx.execute("UPDATE operators SET raids = raids + 1, in_raid = NULL, insured = 0, raid_map = NULL, raid_fee = 0, raid_premium = 0 WHERE profile = ?1", params![profile]).map_err(|e| e.to_string())?;
        settlement.cash = Self::cash_of(&tx, profile)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(settlement)
    }

    /// Void one raid that never really started (the player dropped before
    /// playing): the loadout stays and the insurance premium comes back, since
    /// it insured nothing. The entry fee comes back only if `refund_fee`.
    pub fn void_raid(&self, profile: &str, room_id: &str, refund_fee: bool) -> bool {
        let conn = self.conn.lock().unwrap();
        let voided = conn.execute(
            "UPDATE operators SET cash = cash + raid_premium + CASE WHEN ?3 THEN raid_fee ELSE 0 END,
                in_raid = NULL, insured = 0, raid_map = NULL, raid_fee = 0, raid_premium = 0
             WHERE profile = ?1 AND in_raid = ?2", params![profile, room_id, refund_fee]).map(|n| n > 0).unwrap_or(false);
        if voided { let _ = conn.execute("UPDATE items SET carry = 1 WHERE profile = ?1 AND carry = 2", params![profile]); }
        voided
    }

    /// Raids interrupted by a server restart are voided: gear goes back to the
    /// stash, and the entry fee and insurance premium are paid back.
    pub fn void_stale_raids(&self) -> usize {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE items SET carry = 1 WHERE carry = 2", []);
        conn.execute(
            "UPDATE operators SET cash = cash + raid_fee + raid_premium,
                in_raid = NULL, insured = 0, raid_map = NULL, raid_fee = 0, raid_premium = 0
             WHERE in_raid IS NOT NULL", []).unwrap_or(0)
    }

    /// Stash identity: the signed-in account's active operator. There is no
    /// guest play, and an account without an operator has no stash yet.
    pub fn profile_key(&self, token: Option<&str>) -> Option<String> {
        let user = token.filter(|t| !t.is_empty()).and_then(|t| self.validate_session(t))?;
        self.active_operator(&user)
    }

    // ---------- Accounts, operators and Homefront ----------

    fn ops_xp_in(conn: &Connection, profile: &str, map: &str) -> u32 {
        conn.query_row("SELECT xp FROM operations WHERE profile = ?1 AND map = ?2", params![profile, map], |r| r.get(0)).unwrap_or(0)
    }

    fn perks_in(conn: &Connection, user: &str) -> Perks {
        let mut perks = Perks::default();
        if let Ok(mut stmt) = conn.prepare("SELECT perk, rank FROM account_perks WHERE user_id = ?1") {
            if let Ok(rows) = stmt.query_map(params![user], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))) {
                for (perk, rank) in rows.flatten() { if let Some(p) = Perk::parse(&perk) { perks.set(p, rank); } }
            }
        }
        perks
    }

    /// The Homefront, perks and boosts that shape an operator's numbers.
    /// Operators with no account (tests) just get the base Homefront.
    pub fn context_in(conn: &Connection, profile: &str, now: i64) -> OperatorContext {
        let mut ctx = OperatorContext { tier: 1, ..Default::default() };
        if let Ok((account, raidable, tier, produced_at)) = conn.query_row(
            "SELECT account, raidable, tier, produced_at FROM operators WHERE profile = ?1", params![profile],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i32>(1)? != 0, r.get::<_, u32>(2)?, r.get::<_, i64>(3)?)),
        ) {
            (ctx.account, ctx.raidable, ctx.tier, ctx.produced_at) = (account, raidable, tier, produced_at);
        }
        if let Ok(mut stmt) = conn.prepare("SELECT facility, level FROM facilities WHERE profile = ?1") {
            if let Ok(rows) = stmt.query_map(params![profile], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))) {
                for (f, level) in rows.flatten() {
                    if let Some(i) = FACILITIES.iter().position(|x| x.as_str() == f) { ctx.facilities[i] = level; }
                }
            }
        }
        if let Some(user) = ctx.account.clone() {
            ctx.perks = Self::perks_in(conn, &user);
            let season = prog::season_at(now).id;
            if let Ok((bonus, level, boost_season)) = conn.query_row(
                "SELECT stash_bonus, boost_level, boost_season FROM accounts WHERE user_id = ?1", params![user],
                |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?, r.get::<_, Option<String>>(2)?)),
            ) {
                ctx.account_stash_bonus = bonus;
                if boost_season.as_deref() == Some(season.as_str()) { ctx.boost_level = level; }
            }
        }
        ctx
    }

    pub fn context(&self, profile: &str, now: i64) -> OperatorContext {
        let conn = self.conn.lock().unwrap();
        Self::context_in(&conn, profile, now)
    }

    /// Operations XP per map, in map order.
    pub fn operations(&self, profile: &str) -> Vec<(&'static MapDef, u32)> {
        let conn = self.conn.lock().unwrap();
        gear::MAPS.iter().map(|m| (m, Self::ops_xp_in(&conn, profile, m.id))).collect()
    }

    fn account_operator_ids(conn: &Connection, user: &str) -> Vec<String> {
        conn.prepare("SELECT profile FROM operators WHERE account = ?1 ORDER BY created_at, rowid")
            .and_then(|mut s| s.query_map(params![user], |r| r.get(0)).map(|rows| rows.flatten().collect()))
            .unwrap_or_default()
    }

    fn active_in(conn: &Connection, user: &str) -> Option<String> {
        let ids = Self::account_operator_ids(conn, user);
        let chosen: Option<String> = conn.query_row("SELECT active_operator FROM accounts WHERE user_id = ?1", params![user], |r| r.get(0)).ok().flatten();
        chosen.filter(|c| ids.contains(c)).or_else(|| ids.into_iter().next())
    }

    /// The operator the account is playing, if it has any.
    pub fn active_operator(&self, user: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        Self::active_in(&conn, user)
    }

    pub fn operator_summaries(&self, user: &str) -> Vec<OperatorSummary> {
        let ids = { let conn = self.conn.lock().unwrap(); Self::account_operator_ids(&conn, user) };
        let active = self.active_operator(user);
        ids.into_iter().filter_map(|id| {
            let op = self.operator(&id)?;
            Some(OperatorSummary {
                gear_score: op.loadout().gear_score(), in_raid: op.in_raid.is_some(), active: active.as_deref() == Some(id.as_str()),
                id, name: op.name, raidable: op.raidable, tier: op.tier, cash: op.cash,
            })
        }).collect()
    }

    /// Create an operator on an account and make it the active one. Whether it
    /// allows raids is fixed for its whole life.
    pub fn create_operator(&self, user: &str, name: &str, raidable: bool, now: i64) -> Result<String, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let count = Self::account_operator_ids(&tx, user).len();
        if count >= prog::MAX_OPERATORS {
            return Err(format!("An account can have {} operators. Retire or delete one to make room.", prog::MAX_OPERATORS));
        }
        // The new operator becomes the active one, which can't change mid-raid.
        let deployed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operators WHERE account = ?1 AND in_raid IS NOT NULL)", params![user], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if deployed { return Err("Finish your raid before creating another operator.".into()); }
        let name = prog::clean_operator_name(name, count + 1)?;
        let profile = format!("op:{}", uuid::Uuid::new_v4());
        tx.execute("INSERT INTO operators (profile, friend_id, cash, account, name, raidable, created_at, produced_at) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![profile, gear::STARTING_CASH, user, name, raidable as i32, now]).map_err(|e| e.to_string())?;
        for (item, slot) in gear::starter_kit() { Self::insert_item(&tx, &profile, &item, slot).map_err(|e| e.to_string())?; }
        Self::set_active_in(&tx, user, &profile)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(profile)
    }

    fn set_active_in(conn: &Connection, user: &str, profile: &str) -> Result<(), String> {
        conn.execute("INSERT INTO accounts (user_id, active_operator) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET active_operator = ?2",
            params![user, profile]).map(|_| ()).map_err(|e| e.to_string())
    }

    /// Switch which operator the account plays. Not while one is deployed.
    pub fn switch_operator(&self, user: &str, profile: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if !Self::account_operator_ids(&tx, user).iter().any(|id| id == profile) { return Err("That operator isn't on your account".into()); }
        if let Some(current) = Self::active_in(&tx, user) { Self::not_in_raid(&tx, &current)?; }
        Self::set_active_in(&tx, user, profile)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Delete one operator and everything it owns, for nothing in return (unlike
    /// retiring). Frees its slot. Returns the operator's name.
    pub fn delete_operator(&self, user: &str, profile: &str) -> Result<String, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if !Self::account_operator_ids(&tx, user).iter().any(|id| id == profile) { return Err("That operator isn't on your account".into()); }
        Self::not_in_raid(&tx, profile).map_err(|_| "That operator is in a raid. Finish it first.".to_string())?;
        let name: String = tx.query_row("SELECT name FROM operators WHERE profile = ?1", params![profile], |r| r.get(0)).map_err(|e| e.to_string())?;
        Self::remove_operator_friends(&tx, profile)?;
        for table in ["items", "facilities", "operations", "operators"] {
            tx.execute(&format!("DELETE FROM {table} WHERE profile = ?1"), params![profile]).map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE accounts SET active_operator = NULL WHERE user_id = ?1 AND active_operator = ?2", params![user, profile]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(name)
    }

    /// Raise the Homefront one tier, paying cash and valuables from the stash.
    pub fn upgrade_tier(&self, profile: &str) -> Result<u32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let ctx = Self::context_in(&tx, profile, 0);
        let next = ctx.tier + 1;
        if next > prog::tier_cap(ctx.raidable) {
            return Err(if ctx.raidable || ctx.tier >= prog::MAX_TIER { "Your Homefront is at its top tier.".into() }
                else { format!("Tier {} is the safe tier: only operators that allow raids can build past it.", prog::SAFE_TIER_CAP) });
        }
        let cost = prog::tier_cost(next).ok_or("No higher tier")?;
        let cash = Self::cash_of(&tx, profile)?;
        if cash < cost.cash { return Err(format!("Tier {next} costs ${}. You need ${} more.", cost.cash, cost.cash - cash)); }
        let picked = Self::pick_valuables(&tx, profile, cost.valuables, cost.min_rarity);
        if picked.len() < cost.valuables as usize {
            return Err(format!("Tier {next} needs {} {}-or-better valuables in your stash.", cost.valuables, cost.min_rarity.label()));
        }
        let op = Self::load_operator(&tx, profile).ok_or("No operator")?;
        let materials: u32 = op.items.iter().filter(|s| picked.contains(&s.item.id)).map(|s| s.item.value).sum();
        tx.execute("UPDATE operators SET material_investment = material_investment + ?1 WHERE profile = ?2", params![materials, profile]).map_err(|e| e.to_string())?;
        for id in &picked { tx.execute("DELETE FROM items WHERE id = ?1", params![id]).map_err(|e| e.to_string())?; }
        tx.execute("UPDATE operators SET cash = cash - ?1, tier = ?2 WHERE profile = ?3", params![cost.cash, next, profile]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(next)
    }

    /// The cheapest stash valuables at or above a rarity (not marked to carry).
    fn pick_valuables(conn: &Connection, profile: &str, count: u32, min_rarity: Rarity) -> Vec<String> {
        let Some(op) = Self::load_operator(conn, profile) else { return Vec::new() };
        let mut ok: Vec<&StashItem> = op.items.iter()
            .filter(|s| s.slot.is_none() && !s.carry && !s.overflow && !s.item.protected && s.item.kind == ItemKind::Valuable && s.item.rarity >= min_rarity).collect();
        ok.sort_by_key(|s| s.item.value);
        ok.into_iter().take(count as usize).map(|s| s.item.id.clone()).collect()
    }

    /// Which valuables the next tier upgrade would use (to show before buying).
    pub fn tier_valuables(&self, profile: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let tier: u32 = conn.query_row("SELECT tier FROM operators WHERE profile = ?1", params![profile], |r| r.get(0)).unwrap_or(1);
        prog::tier_cost(tier + 1).map_or_else(Vec::new, |c| Self::pick_valuables(&conn, profile, c.valuables, c.min_rarity))
    }

    /// Raise a facility one level (no higher than the Homefront tier).
    pub fn upgrade_facility(&self, profile: &str, facility: Facility, now: i64) -> Result<u32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let ctx = Self::context_in(&tx, profile, now);
        let level = ctx.facility(facility) + 1;
        if level > ctx.tier { return Err(format!("Raise your Homefront to tier {level} first.")); }
        let cost = facility.cost(level);
        let cash = Self::cash_of(&tx, profile)?;
        if cash < cost { return Err(format!("{} level {level} costs ${cost}. You need ${} more.", facility.label(), cost - cash)); }
        if facility == Facility::Workshop {
            // Bank what the old level made, then start the new level's clock.
            let made = ctx.workshop_stored(now);
            tx.execute("UPDATE operators SET cash = cash + ?1, produced_at = ?2 WHERE profile = ?3", params![made, now, profile]).map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO facilities (profile, facility, level) VALUES (?1, ?2, ?3) ON CONFLICT(profile, facility) DO UPDATE SET level = ?3",
            params![profile, facility.as_str(), level]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2", params![cost, profile]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(level)
    }

    /// Collect the Workshop's cash. Returns how much was collected.
    pub fn collect_workshop(&self, profile: &str, now: i64) -> Result<u32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::not_in_raid(&tx, profile)?;
        let ctx = Self::context_in(&tx, profile, now);
        let rate = prog::workshop_rate(ctx.facility(Facility::Workshop));
        if rate == 0 { return Ok(0); }
        let made = ctx.workshop_stored(now);
        if made > 0 {
            let seconds_per_dollar = 3600 / rate as i64;
            let elapsed = (now - ctx.produced_at).max(0);
            let collected_at = if elapsed >= prog::WORKSHOP_HOURS as i64 * 3600 {
                now - elapsed % seconds_per_dollar
            } else { ctx.produced_at + made as i64 * seconds_per_dollar };
            tx.execute("UPDATE operators SET cash = cash + ?1, produced_at = ?2 WHERE profile = ?3", params![made, collected_at, profile]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(made)
    }

    pub fn account_state(&self, user: &str) -> AccountState {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.query_row(
            "SELECT legacy_earned, stash_bonus, relocations, last_relocation, boost_level, boost_season FROM accounts WHERE user_id = ?1", params![user],
            |r| Ok(AccountState {
                legacy_earned: r.get(0)?, stash_bonus: r.get(1)?, relocations: r.get(2)?, last_relocation: r.get(3)?,
                boost_level: r.get(4)?, boost_season: r.get(5)?, ..Default::default()
            }),
        ).unwrap_or_default();
        st.perks = Self::perks_in(&conn, user);
        st.legacy_available = st.legacy_earned.saturating_sub(st.perks.spent());
        st.badges = conn.prepare("SELECT season, operator, value FROM account_badges WHERE user_id = ?1 ORDER BY season")
            .and_then(|mut s| s.query_map(params![user], |r| Ok(Badge { season: r.get(0)?, operator: r.get(1)?, value: r.get(2)? })).map(|rows| rows.flatten().collect()))
            .unwrap_or_default();
        st
    }

    fn investment_in(conn: &Connection, profile: &str) -> u32 {
        let ctx = Self::context_in(conn, profile, 0);
        let materials: u32 = conn.query_row("SELECT material_investment FROM operators WHERE profile = ?1", params![profile], |r| r.get(0)).unwrap_or(0);
        materials + (2..=ctx.tier).filter_map(prog::tier_cost).map(|c| c.cash).sum::<u32>()
            + FACILITIES.iter().map(|&f| (1..=ctx.facility(f)).map(|l| f.cost(l)).sum::<u32>()).sum::<u32>()
    }

    fn value_in(conn: &Connection, profile: &str) -> u32 {
        Self::load_operator(conn, profile).map_or(0, |op| op.cash + op.items.iter().map(|s| s.item.value).sum::<u32>() + Self::investment_in(conn, profile))
    }

    pub fn investment_value(&self, profile: &str) -> u32 {
        Self::investment_in(&self.conn.lock().unwrap(), profile)
    }

    /// What an operator is worth if it relocated now: cash plus the sale value
    /// of everything it owns.
    pub fn operator_value(&self, profile: &str) -> u32 {
        let conn = self.conn.lock().unwrap();
        Self::value_in(&conn, profile)
    }

    /// Why the account's active operator can't relocate right now, if it can't.
    pub fn relocation_blocker(&self, user: &str, now: i64) -> Option<String> {
        let season = prog::season_at(now);
        let Some(profile) = self.active_operator(user) else { return Some("Create an operator first.".into()) };
        let op = self.operator(&profile)?;
        let st = self.account_state(user);
        if st.last_relocation.as_deref() == Some(season.id.as_str()) { return Some("Your account already retired an operator this season.".into()); }
        if op.in_raid.is_some() { return Some("Finish the raid first.".into()); }
        if op.tier < prog::RELOCATION_MIN_TIER { return Some(format!("Raise {}'s Homefront to tier {} first.", op.name, prog::RELOCATION_MIN_TIER)); }
        if !season.relocation_open(now) { return Some("Retiring opens in the last four weeks of the season.".into()); }
        None
    }

    /// What relocating the active operator would earn now.
    pub fn relocation_preview(&self, user: &str, now: i64) -> Option<RelocationReward> {
        let profile = self.active_operator(user)?;
        let st = self.account_state(user);
        let prev = prog::season_at(prog::season_at(now).starts_at - 1).id;
        Some(prog::relocation_reward(self.operator_value(&profile), st.legacy_earned, st.stash_bonus, st.boost_level,
            st.last_relocation.as_deref() == Some(prev.as_str())))
    }

    /// Retire the active operator for Legacy. Everything it owns is gone; the
    /// account keeps the Legacy points, stash space, badge and next-season boost.
    pub fn relocate(&self, user: &str, now: i64) -> Result<RelocationReward, String> {
        if let Some(why) = self.relocation_blocker(user, now) { return Err(why); }
        let profile = self.active_operator(user).ok_or("Create an operator first.")?;
        let name = self.operator(&profile).map(|o| o.name).unwrap_or_default();
        let season = prog::season_at(now);
        let next = prog::next_season(now);
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // Re-check inside the transaction: a raid may have started since, or a
        // second request may have retired an operator a moment ago.
        Self::not_in_raid(&tx, &profile)?;
        if Self::active_in(&tx, user).as_deref() != Some(profile.as_str()) { return Err("Your active operator changed. Try again.".into()); }
        tx.execute("INSERT OR IGNORE INTO accounts (user_id) VALUES (?1)", params![user]).map_err(|e| e.to_string())?;
        let last: Option<String> = tx.query_row("SELECT last_relocation FROM accounts WHERE user_id = ?1", params![user], |r| r.get(0)).map_err(|e| e.to_string())?;
        if last.as_deref() == Some(season.id.as_str()) { return Err("Your account already retired an operator this season.".into()); }
        let (earned, stash, boost): (u32,u32,u32) = tx.query_row("SELECT legacy_earned, stash_bonus, boost_level FROM accounts WHERE user_id = ?1", params![user], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e| e.to_string())?;
        let previous = prog::season_at(season.starts_at - 1).id;
        let reward = prog::relocation_reward(Self::value_in(&tx, &profile), earned, stash, boost, last.as_deref() == Some(previous.as_str()));
        tx.execute(
            "UPDATE accounts SET legacy_earned = legacy_earned + ?2, stash_bonus = stash_bonus + ?3, relocations = relocations + 1,
                last_relocation = ?4, boost_level = ?5, boost_season = ?6, active_operator = NULL WHERE user_id = ?1",
            params![user, reward.legacy_points, reward.stash_slots, season.id, reward.boost_level, next.id],
        ).map_err(|e| e.to_string())?;
        tx.execute("INSERT OR REPLACE INTO account_badges (user_id, season, operator, value) VALUES (?1, ?2, ?3, ?4)",
            params![user, season.id, name, reward.value]).map_err(|e| e.to_string())?;
        Self::remove_operator_friends(&tx, &profile)?;
        for table in ["items", "facilities", "operations", "operators"] {
            tx.execute(&format!("DELETE FROM {table} WHERE profile = ?1"), params![profile]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(reward)
    }

    /// Spend a Legacy point on a perk rank. Perks apply to every operator.
    pub fn buy_perk(&self, user: &str, perk: Perk) -> Result<u32, String> {
        // One lock for the check and the write, so two requests can't spend the same point.
        let conn = self.conn.lock().unwrap();
        let earned: u32 = conn.query_row("SELECT legacy_earned FROM accounts WHERE user_id = ?1", params![user], |r| r.get(0)).unwrap_or(0);
        let perks = Self::perks_in(&conn, user);
        if earned <= perks.spent() { return Err("No Legacy points to spend. Retire an operator to earn them.".into()); }
        let rank = perks.get(perk) + 1;
        if rank > prog::PERK_MAX_RANK { return Err(format!("{} is already at level {}.", perk.label(), prog::PERK_MAX_RANK)); }
        conn.execute("INSERT INTO account_perks (user_id, perk, rank) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, perk) DO UPDATE SET rank = ?3",
            params![user, perk.as_str(), rank]).map_err(|e| e.to_string())?;
        Ok(rank)
    }

    /// Refund all spent points, charging the active operator once. No active raid may change bonuses.
    pub fn respec(&self, user: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let active: String = tx.query_row("SELECT active_operator FROM accounts WHERE user_id = ?1", params![user], |r| r.get(0)).map_err(|_| "Create an operator first.".to_string())?;
        let perks = Self::perks_in(&tx, user);
        if perks.spent() == 0 { return Err("No allocated Legacy points to reset.".into()); }
        for id in Self::account_operator_ids(&tx, user) {
            Self::not_in_raid(&tx, &id)?;
            let mut ctx = Self::context_in(&tx, &id, 0);
            ctx.perks = Perks::default();
            if Self::stash_size(&tx, &id)? > ctx.stash_capacity() { return Err("Make room in every operator's stash before removing Packrat.".into()); }
        }
        let changed = tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2 AND account = ?3 AND cash >= ?1", params![prog::RESPEC_COST,active,user]).map_err(|e| e.to_string())?;
        if changed == 0 { return Err(format!("The active operator needs ${} to reset Legacy perks.", prog::RESPEC_COST)); }
        tx.execute("DELETE FROM account_perks WHERE user_id = ?1", params![user]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Attach a provider identity (Steam, Bluesky, ...) to an existing account.
    /// Fails if that identity already belongs to a different account.
    pub fn link_account(&self, user_id: &str, provider: &str, provider_id: &str, provider_handle: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let owner: Option<String> = conn.query_row(
            "SELECT user_id FROM linked_accounts WHERE provider = ?1 AND provider_id = ?2", params![provider, provider_id], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        match owner {
            Some(owner) if owner != user_id => Err(format!("That {} account is already linked to a different BoxHead account.", provider_label(provider))),
            Some(_) => {
                conn.execute("UPDATE linked_accounts SET provider_handle = ?1 WHERE provider = ?2 AND provider_id = ?3", params![provider_handle, provider, provider_id]).map_err(|e| e.to_string())?;
                Ok(())
            }
            None => {
                let has_provider: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM linked_accounts WHERE user_id = ?1 AND provider = ?2)", params![user_id, provider], |r| r.get(0)).map_err(|e| e.to_string())?;
                if has_provider { return Err(format!("This account already has a {} account linked.", provider_label(provider))); }
                conn.execute("INSERT INTO linked_accounts (user_id, provider, provider_id, provider_handle) VALUES (?1, ?2, ?3, ?4)", params![user_id, provider, provider_id, provider_handle]).map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }

    /// Every identity linked to an account: (provider, handle).
    pub fn linked_accounts(&self, user_id: &str) -> Vec<(String, String)> {
        let conn = self.conn.lock().unwrap();
        conn.prepare("SELECT provider, COALESCE(provider_handle, '') FROM linked_accounts WHERE user_id = ?1 ORDER BY id").and_then(|mut s| {
            s.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.filter_map(|r| r.ok()).collect())
        }).unwrap_or_default()
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

    /// Create a session token for a user. `platform` is what they signed in with
    /// ("steam", "bluesky", or "direct" for email and Google); it picks their
    /// matchmaking pool. Returns the token.
    pub fn create_session(&self, user_id: &str, platform: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at, platform) VALUES (?1, ?2, datetime('now', '+30 days'), ?3)",
            params![token, user_id, platform],
        ).map_err(|e| format!("Failed to create session: {}", e))?;
        Ok(token)
    }

    /// Who a session belongs to and how it matchmakes: (user id, platform, cross-platform on).
    pub fn session_matchmaking(&self, token: &str) -> Option<(String, String, bool)> {
        if token.is_empty() { return None; }
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT s.user_id, s.platform, COALESCE(a.crossplay, 0) FROM sessions s
             LEFT JOIN accounts a ON a.user_id = s.user_id
             WHERE s.token = ?1 AND s.expires_at > datetime('now')",
            params![token],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, bool>(2)?)),
        ).ok()
    }

    /// Turn cross-platform matchmaking on or off for every operator on the account.
    pub fn set_crossplay(&self, user_id: &str, on: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO accounts (user_id, crossplay) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET crossplay = ?2",
            params![user_id, on],
        ).map_err(|e| e.to_string())?;
        Ok(())
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

    /// An account is verified once it exists and any email sign-in on it is confirmed
    /// (or it also signs in through Steam, Bluesky or Google).
    #[cfg(test)]
    pub fn is_verified(&self, user_id: &str) -> bool {
        let exists = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE id = ?1)",
                params![user_id],
                |row| row.get::<_, bool>(0),
            ).unwrap_or(false)
        };
        exists && self.unconfirmed_email(user_id).is_none()
    }

    /// Verification status for a session token; invalid or missing tokens are unverified.
    #[cfg(test)]
    pub fn session_is_verified(&self, token: Option<&str>) -> bool {
        token.filter(|t| !t.is_empty())
            .and_then(|t| self.validate_session(t))
            .is_some_and(|user_id| self.is_verified(&user_id))
    }

    /// Add bidirectional friendship.
    pub fn add_friend(&self, user_id: &str, friend_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if user_id == friend_id { return Err("Cannot add yourself".into()); }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id = ?1)", params![friend_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !exists { return Err("Account ID not found".into()); }
        tx.execute(
            "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?1, ?2)",
            params![user_id, friend_id],
        ).map_err(|e| format!("Failed to add friend: {}", e))?;
        tx.execute(
            "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?1, ?2)",
            params![friend_id, user_id],
        ).map_err(|e| format!("Failed to add friend: {}", e))?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Remove bidirectional friendship.
    pub fn remove_friend(&self, user_id: &str, friend_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM friends WHERE user_id = ?1 AND friend_id = ?2",
            params![user_id, friend_id],
        ).map_err(|e| format!("Failed to remove friend: {}", e))?;
        tx.execute(
            "DELETE FROM friends WHERE user_id = ?1 AND friend_id = ?2",
            params![friend_id, user_id],
        ).map_err(|e| format!("Failed to remove friend: {}", e))?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Get friends list for a user.
    pub fn get_friends(&self, user_id: &str) -> Vec<FriendRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT u.id
             FROM friends f
             JOIN users u ON u.id = f.friend_id
             WHERE f.user_id = ?1"
        ).unwrap();

        stmt.query_map(params![user_id], |row| {
            Ok(FriendRow {
                user_id: row.get(0)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Operator friends belong to the active operator, never the whole account.
    pub fn get_operator_friends(&self, user: &str) -> Vec<OperatorFriendRow> {
        let conn = self.conn.lock().unwrap();
        let Some(profile) = Self::active_in(&conn, user) else { return Vec::new() };
        let mut stmt = conn.prepare("SELECT o.friend_id, o.name, o.account FROM operator_friends f
            JOIN operators o ON o.profile = f.friend_profile WHERE f.profile = ?1").unwrap();
        stmt.query_map(params![profile], |r| Ok(OperatorFriendRow {
            id: r.get(0)?, name: r.get(1)?, account: r.get(2)?,
        })).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn change_operator_friend(&self, user: &str, target: &str, add: bool) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let profile = Self::active_in(&tx, user).ok_or("Create an operator first")?;
        let found: Option<(String, String)> = tx.query_row("SELECT profile, account FROM operators WHERE friend_id = ?1", params![target], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional().map_err(|e| e.to_string())?;
        let (target, owner) = found.ok_or("Operator ID not found")?;
        if add {
            if owner == user { return Err("Cannot add an operator on your own account".into()); }
            tx.execute("INSERT OR IGNORE INTO operator_friends (profile, friend_profile) VALUES (?1, ?2), (?2, ?1)", params![profile, target])
                .map_err(|e| e.to_string())?;
        } else {
            tx.execute("DELETE FROM operator_friends WHERE (profile = ?1 AND friend_profile = ?2) OR (profile = ?2 AND friend_profile = ?1)", params![profile, target])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    fn remove_operator_friends(conn: &Connection, profile: &str) -> Result<(), String> {
        conn.execute("DELETE FROM operator_friends WHERE profile = ?1 OR friend_profile = ?1", params![profile])
            .map_err(|e| e.to_string())?;
        Ok(())
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
        // Hash before taking the connection lock: bcrypt takes ~50-100 ms.
        let hash = bcrypt::hash(password, 10).map_err(|e| format!("Failed to hash password: {}", e))?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let existing: Option<String> = tx
            .query_row("SELECT user_id FROM email_credentials WHERE email = ?1", params![email], |row| row.get(0))
            .ok();
        if existing.is_some() {
            return Err("Email already registered".to_string());
        }
        let user_id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO users (id, display_name) VALUES (?1, ?2)", params![user_id, email])
            .map_err(|e| format!("Failed to create user: {}", e))?;
        tx.execute(
            "INSERT INTO linked_accounts (user_id, provider, provider_id, provider_handle) VALUES (?1, 'email', ?2, ?2)",
            params![user_id, email],
        ).map_err(|e| format!("Failed to link account: {}", e))?;
        tx.execute(
            "INSERT INTO email_credentials (user_id, email, password_hash, confirmed) VALUES (?1, ?2, ?3, 0)",
            params![user_id, email, hash],
        ).map_err(|e| format!("Failed to store credentials: {}", e))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(user_id)
    }

    /// Verify email + password. Returns user_id if valid.
    pub fn verify_email_login(&self, email: &str, password: &str) -> Result<String, String> {
        let row: Option<(String, String)> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT user_id, password_hash FROM email_credentials WHERE email = ?1",
                params![email],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok()
        };
        // Verify outside the lock so logins never stall raid settlement. One message
        // for both failures, so the form never reveals which emails have accounts.
        match row {
            Some((user_id, hash)) if bcrypt::verify(password, &hash).unwrap_or(false) => Ok(user_id),
            _ => Err(WRONG_LOGIN.to_string()),
        }
    }

    // ---------- Email confirmation, password reset, account deletion ----------

    /// Issue a one-time token for `kind` ("confirm" or "reset"), replacing older
    /// ones of the same kind. Returns the token to put in the link.
    pub fn issue_auth_token(&self, user_id: &str, kind: &str, ttl_secs: i64) -> Result<String, String> {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM auth_tokens WHERE (user_id = ?1 AND kind = ?2) OR expires_at < ?3", params![user_id, kind, now_secs()])
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![token_hash(&token), user_id, kind, now_secs() + ttl_secs]).map_err(|e| e.to_string())?;
        Ok(token)
    }

    /// Use up a one-time token. Returns its account if it was valid and unexpired.
    pub fn take_auth_token(&self, token: &str, kind: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        let hash = token_hash(token);
        let user: Option<String> = conn.query_row(
            "SELECT user_id FROM auth_tokens WHERE token_hash = ?1 AND kind = ?2 AND expires_at >= ?3",
            params![hash, kind, now_secs()], |r| r.get(0)).ok();
        if user.is_some() { let _ = conn.execute("DELETE FROM auth_tokens WHERE token_hash = ?1", params![hash]); }
        user
    }

    /// The account's sign-in email and whether it is confirmed.
    pub fn account_email(&self, user_id: &str) -> Option<(String, bool)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT email, confirmed FROM email_credentials WHERE user_id = ?1", params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?))).ok()
    }

    /// The account that signs in with this email, if any.
    pub fn user_by_email(&self, email: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT user_id FROM email_credentials WHERE email = ?1", params![email], |r| r.get(0)).ok()
    }

    pub fn confirm_email(&self, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE email_credentials SET confirmed = 1 WHERE user_id = ?1", params![user_id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The unconfirmed email holding this account back, if any. Accounts that also
    /// sign in through Steam, Bluesky or Google are already proven and never wait.
    pub fn unconfirmed_email(&self, user_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        let (email, confirmed): (String, bool) = conn.query_row(
            "SELECT email, confirmed FROM email_credentials WHERE user_id = ?1", params![user_id], |r| Ok((r.get(0)?, r.get(1)?))).ok()?;
        if confirmed { return None; }
        let other: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM linked_accounts WHERE user_id = ?1 AND provider IN ('steam', 'bluesky', 'google'))",
            params![user_id], |r| r.get(0)).unwrap_or(false);
        (!other).then_some(email)
    }

    /// Set a new password and sign the account out everywhere. Proving you can read
    /// the inbox (the reset link) also confirms the email.
    pub fn reset_password(&self, user_id: &str, password: &str) -> Result<(), String> {
        let hash = bcrypt::hash(password, 10).map_err(|e| format!("Failed to hash password: {}", e))?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let n = tx.execute("UPDATE email_credentials SET password_hash = ?1, confirmed = 1 WHERE user_id = ?2", params![hash, user_id])
            .map_err(|e| e.to_string())?;
        if n == 0 { return Err("This account doesn't use a password.".into()); }
        tx.execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM auth_tokens WHERE user_id = ?1 AND kind = 'reset'", params![user_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Delete an account and everything it owns: operators, stash, Homefront,
    /// Legacy, friends, linked sign-ins and sessions. Refused mid-raid.
    pub fn delete_account(&self, user_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id = ?1)", params![user_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !exists { return Err("Account not found".into()); }
        let deployed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operators WHERE account = ?1 AND in_raid IS NOT NULL)", params![user_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if deployed { return Err("One of your operators is in a raid. Finish it first.".into()); }
        for table in ["items", "facilities", "operations"] {
            tx.execute(&format!("DELETE FROM {table} WHERE profile IN (SELECT profile FROM operators WHERE account = ?1)"), params![user_id])
                .map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM operator_friends WHERE profile IN (SELECT profile FROM operators WHERE account = ?1) OR friend_profile IN (SELECT profile FROM operators WHERE account = ?1)", params![user_id]).map_err(|e| e.to_string())?;
        for sql in [
            "DELETE FROM operators WHERE account = ?1",
            "DELETE FROM accounts WHERE user_id = ?1",
            "DELETE FROM account_perks WHERE user_id = ?1",
            "DELETE FROM account_badges WHERE user_id = ?1",
            "DELETE FROM friends WHERE user_id = ?1 OR friend_id = ?1",
            "DELETE FROM sessions WHERE user_id = ?1",
            "DELETE FROM auth_tokens WHERE user_id = ?1",
            "DELETE FROM email_credentials WHERE user_id = ?1",
            "DELETE FROM linked_accounts WHERE user_id = ?1",
            "DELETE FROM users WHERE id = ?1",
        ] {
            tx.execute(sql, params![user_id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Whether the database answers a trivial query.
    pub fn ping(&self) -> bool {
        self.conn.lock().unwrap().query_row("SELECT 1", [], |r| r.get::<_, i32>(0)).is_ok()
    }

    /// Clean up expired sessions.
    pub fn delete_expired_sessions(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')", []);
    }
}

fn provider_label(provider: &str) -> &str {
    match provider { "steam" => "Steam", "bluesky" => "Bluesky", "google" => "Google", "email" => "email", other => other }
}

#[cfg(test)]
mod stash_tests {
    use super::*;
    use crate::types::RaidResult;

    #[test]
    fn operator_friends_are_separate_from_accounts_and_follow_only_the_selected_operator() {
        let db = Database::open(":memory:").unwrap();
        let a = account(&db);
        let b = account(&db);
        let first = db.create_operator(&a, "Ghost", false, 1).unwrap();
        let friend = db.create_operator(&b, "Rook", false, 2).unwrap();
        let friend_id = db.operator(&friend).unwrap().friend_id;
        db.add_friend(&a, &b).unwrap();
        db.change_operator_friend(&a, &friend_id, true).unwrap();
        assert_eq!(db.get_operator_friends(&a)[0].name, "Rook");
        assert_eq!(db.get_operator_friends(&b)[0].name, "Ghost");
        assert!(db.change_operator_friend(&a, &db.operator(&first).unwrap().friend_id, true).is_err());
        assert!(db.change_operator_friend(&a, "op:missing", true).is_err());
        let second = db.create_operator(&a, "Sable", false, 3).unwrap();
        assert!(db.get_operator_friends(&a).is_empty());
        assert_eq!(db.get_friends(&a)[0].user_id, b);
        db.switch_operator(&a, &first).unwrap();
        assert_eq!(db.get_operator_friends(&a).len(), 1);
        db.remove_friend(&a, &b).unwrap();
        assert_eq!(db.get_operator_friends(&a).len(), 1);
        db.delete_operator(&a, &first).unwrap();
        assert!(db.get_operator_friends(&b).is_empty());
        assert_eq!(db.active_operator(&a), Some(second));
    }

    #[test]
    fn legacy_operator_friend_ids_do_not_expose_the_account_and_survive_reopening() {
        let path = std::env::temp_dir().join(format!("boxhead-social-{}.db", uuid::Uuid::new_v4()));
        let (user, public_id) = {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            let user = account(&db);
            let legacy = format!("user:{user}");
            db.ensure_operator(&legacy).unwrap();
            db.conn.lock().unwrap().execute("UPDATE operators SET friend_id = NULL WHERE profile = ?1", params![legacy]).unwrap();
            drop(db);
            let db = Database::open(path.to_str().unwrap()).unwrap();
            let public_id = db.operator(&legacy).unwrap().friend_id;
            assert!(!public_id.contains(&user));
            assert!(public_id.starts_with("op:"));
            (user, public_id)
        };
        let db = Database::open(path.to_str().unwrap()).unwrap();
        assert_eq!(db.operator(&format!("user:{user}")).unwrap().friend_id, public_id);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    fn outcome(result: RaidResult, loot: Vec<Item>, bounty: u32) -> RaidOutcome {
        RaidOutcome { player_id: "p".into(), name: "P".into(), result, extract_name: None, killed_by: None, loot, lost: Vec::new(), bounty, kills: 3, activity: crate::types::RaidActivity::default(), max_combo: 2, survived_secs: 60.0 }
    }

    #[test]
    fn new_operators_get_the_starter_kit_once() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("guest:a").unwrap();
        db.ensure_operator("guest:a").unwrap();
        let op = db.operator("guest:a").unwrap();
        assert_eq!(op.cash, gear::STARTING_CASH);
        assert_eq!(op.items.len(), 3);
        assert_eq!(op.loadout().gear_score(), 3);
        assert!(db.operator("guest:b").is_none());
    }

    #[test]
    fn extracting_keeps_gear_banks_bounty_and_stores_loot() {
        let db = Database::open(":memory:").unwrap();
        let loadout = db.begin_raid("p", "outskirts", 0).unwrap();
        assert!(db.begin_raid("p", "outskirts", 0).is_err(), "one raid at a time");
        assert!(db.sell("p", &loadout.primary.unwrap().id).is_err(), "gear is locked while deployed");
        let loot = vec![Item::new(ItemKind::Shotgun, Rarity::Rare, 22, None)];
        let s = db.finish_raid("p", &outcome(RaidResult::Extracted, loot, 300)).unwrap();
        assert_eq!((s.cash_earned, s.items_kept, s.items_auto_sold), (300, 1, 0));
        let op = db.operator("p").unwrap();
        assert_eq!(op.cash, gear::STARTING_CASH + 300);
        assert_eq!(op.items.len(), 4);
        assert_eq!((op.raids, op.extracts, op.deaths, op.in_raid.clone()), (1, 1, 0, None));
        assert!(db.finish_raid("p", &outcome(RaidResult::Extracted, vec![], 999)).is_err(), "settled only once");
    }

    #[test]
    fn dying_loses_only_the_equipped_loadout() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        db.buy("p", "uzi-8").unwrap();
        db.begin_raid("p", "outskirts", 0).unwrap();
        db.finish_raid("p", &outcome(RaidResult::Killed, vec![Item::new(ItemKind::Armor, Rarity::Epic, 30, None)], 500)).unwrap();
        let op = db.operator("p").unwrap();
        assert_eq!(op.items.len(), 1, "only the unequipped Uzi survives");
        assert_eq!(op.items[0].item.kind, ItemKind::Uzi);
        assert_eq!(op.loadout().gear_score(), 0);
        assert_eq!(op.deaths, 1);
        // With nothing equipped you can still raid the first map with a loaner.
        assert!(db.begin_raid("p", "outskirts", 0).is_ok());
    }

    #[test]
    fn entry_fees_are_charged_and_refunded_when_a_raid_is_voided() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        db.begin_raid_paying("p", "r1", 0, 150, false).unwrap();
        assert_eq!(db.operator("p").unwrap().cash, gear::STARTING_CASH - 150);
        assert!(!db.void_raid("p", "other", true), "only the raid you're in");
        assert!(db.void_raid("p", "r1", true));
        let op = db.operator("p").unwrap();
        assert_eq!(op.cash, gear::STARTING_CASH);
        assert!(op.in_raid.is_none());
        assert!(db.begin_raid_paying("p", "r1", 0, 99_999, false).unwrap_err().contains("entry fee"));
    }

    #[test]
    fn insurance_returns_the_loadout_but_not_the_pack() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        let before = db.operator("p").unwrap();
        let premium = gear::insurance_cost(&before.loadout());
        assert!(premium > 0);
        db.begin_raid_paying("p", "r", 0, 0, true).unwrap();
        assert_eq!(db.operator("p").unwrap().cash, gear::STARTING_CASH - premium);
        let s = db.finish_raid_in("p", Some("r"), &outcome(RaidResult::Killed, vec![], 0)).unwrap();
        assert!(s.insured);
        let after = db.operator("p").unwrap();
        assert_eq!(after.loadout().gear_score(), before.loadout().gear_score(), "insured gear came back");
        assert_eq!(after.deaths, 1);
        // Insurance covers one raid only.
        db.begin_raid("p", "r", 0).unwrap();
        db.finish_raid_in("p", Some("r"), &outcome(RaidResult::Killed, vec![], 0)).unwrap();
        assert_eq!(db.operator("p").unwrap().loadout().gear_score(), 0);
    }

    #[test]
    fn settlement_must_match_the_raid() {
        let db = Database::open(":memory:").unwrap();
        db.begin_raid("p", "r1", 0).unwrap();
        assert!(db.finish_raid_in("p", Some("r2"), &outcome(RaidResult::Extracted, vec![], 10)).is_err());
        assert!(db.finish_raid_in("p", Some("r1"), &outcome(RaidResult::Extracted, vec![], 10)).is_ok());
    }

    #[test]
    fn gear_score_gates_deployment() {
        let db = Database::open(":memory:").unwrap();
        let err = db.begin_raid("p", "rustyard", 20).unwrap_err();
        assert!(err.contains("Gear score 3"), "{err}");
        assert!(db.operator("p").unwrap().in_raid.is_none(), "a refused deploy doesn't lock the stash");
    }

    #[test]
    fn equip_sell_and_buy_follow_the_rules() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        let uzi = db.buy("p", "uzi-8").unwrap();
        assert!(db.equip("p", &uzi.id, Slot::Armor).is_err(), "guns don't go in the armor slot");
        db.equip("p", &uzi.id, Slot::Secondary).unwrap();
        assert_eq!(db.operator("p").unwrap().loadout().secondary.unwrap().id, uzi.id);
        let cash = db.sell("p", &uzi.id).unwrap();
        assert_eq!(cash, gear::STARTING_CASH - gear::find_offer("uzi-8", &[]).unwrap().price + uzi.value);
        assert!(db.buy("p", "rocketLauncher-24").unwrap_err().contains("more"));
        assert!(db.buy("p", "nope").is_err());
        db.unequip("p", Slot::Armor).unwrap();
        assert!(db.operator("p").unwrap().loadout().armor.is_none());
    }

    #[test]
    fn a_full_stash_requires_a_review_before_overflow_sales() {
        let db = Database::open(":memory:").unwrap();
        db.begin_raid("p", "outskirts", 0).unwrap();
        let loot: Vec<Item> = (0..gear::STASH_CAPACITY + 2).map(|_| Item::new(ItemKind::Valuable, Rarity::Common, 5, Some("Junk".into()))).collect();
        let worth = loot[0].value;
        let s = db.finish_raid("p", &outcome(RaidResult::Extracted, loot, 0)).unwrap();
        assert_eq!(s.items_kept as usize, gear::STASH_CAPACITY);
        assert_eq!(s.items_auto_sold, 0);
        assert_eq!(s.items_pending, 2);
        assert_eq!(s.cash_earned, 0);
        let pending: Vec<String> = db.operator("p").unwrap().items.iter().filter(|s| s.overflow).map(|s| s.item.id.clone()).collect();
        assert!(db.begin_raid("p", "r", 0).is_err());
        assert!(db.resolve_overflow("p", &[], &[]).is_err(), "stale preview cannot sell new loot");
        db.resolve_overflow("p", &pending, &[]).unwrap();
        assert_eq!(db.operator("p").unwrap().cash, s.cash + worth * 2);
        assert!(db.resolve_overflow("p", &pending, &[]).is_err(), "no repeated payout");
    }

    #[test]
    fn stale_raids_are_voided_and_stashes_survive_reopen() {
        let path = std::env::temp_dir().join(format!("boxhead-stash-test-{}.db", uuid::Uuid::new_v4()));
        {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            db.begin_raid("p", "outskirts", 0).unwrap();
        }
        {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            assert_eq!(db.void_stale_raids(), 1);
            let op = db.operator("p").unwrap();
            assert!(op.in_raid.is_none());
            assert_eq!(op.items.len(), 3, "a voided raid keeps the loadout");
            // A restart is the server's fault: the fee and the premium come back too.
            db.begin_raid_paying("p", "rustyard", 0, 150, true).unwrap();
            assert!(db.operator("p").unwrap().cash < gear::STARTING_CASH - 150);
        }
        {
            let db = Database::open(path.to_str().unwrap()).unwrap();
            assert_eq!(db.void_stale_raids(), 1);
            assert_eq!(db.operator("p").unwrap().cash, gear::STARTING_CASH);
            assert_eq!(db.void_stale_raids(), 0);
            // Insurance from the voided raid doesn't leak into the next one.
            db.begin_raid("p", "r", 0).unwrap();
            assert!(!db.finish_raid("p", &outcome(RaidResult::Killed, vec![], 0)).unwrap().insured);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn only_signed_in_accounts_have_a_stash() {
        let db = Database::open(":memory:").unwrap();
        let user = db.register_email_user("a@example.com", "secret1").unwrap();
        let token = db.create_session(&user, "direct").unwrap();
        assert_eq!(db.profile_key(Some(&token)), None, "no operator yet: nothing to deploy");
        let op = db.create_operator(&user, "Ghost", false, 0).unwrap();
        assert_eq!(db.profile_key(Some(&token)), Some(op));
        assert_eq!(db.profile_key(Some("bogus")), None);
        assert_eq!(db.profile_key(Some("")), None);
        assert_eq!(db.profile_key(None), None);
    }

    // ---------- Operators, Homefront, Operations, relocation ----------

    const NOV_9: i64 = 1_794_225_600; // 2026-11-09, before the relocation window
    const DEC_20: i64 = 1_797_768_000; // 2026-12-20, inside it

    fn account(db: &Database) -> String { db.register_email_user(&format!("{}@x.io", uuid::Uuid::new_v4()), "secret1").unwrap() }

    fn give(db: &Database, profile: &str, cash: u32, valuables: &[(Rarity, u32)]) {
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE operators SET cash = ?1 WHERE profile = ?2", params![cash, profile]).unwrap();
        for &(rarity, power) in valuables {
            Database::insert_item(&conn, profile, &Item::new(ItemKind::Valuable, rarity, power, Some("Gold Watch".into())), None).unwrap();
        }
    }

    fn reach_tier(db: &Database, profile: &str, tier: u32) {
        for t in 2..=tier {
            let c = prog::tier_cost(t).unwrap();
            give(db, profile, c.cash, &vec![(c.min_rarity, 20); c.valuables as usize]);
            db.upgrade_tier(profile).unwrap();
        }
    }

    #[test]
    fn an_account_holds_several_operators_and_switches_between_them() {
        let db = Database::open(":memory:").unwrap();
        let user = account(&db);
        assert!(db.active_operator(&user).is_none());
        let a = db.create_operator(&user, "Alpha", false, 1).unwrap();
        let b = db.create_operator(&user, "Bravo", true, 2).unwrap();
        assert_eq!(db.active_operator(&user).as_deref(), Some(b.as_str()), "a new operator becomes active");
        db.create_operator(&user, "", false, 3).unwrap();
        assert!(db.create_operator(&user, "Delta", false, 4).is_err(), "three per account");
        let list = db.operator_summaries(&user);
        assert_eq!(list.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Alpha", "Bravo", "Operator 3"]);
        assert!(!list[0].raidable && list[1].raidable);
        // Each operator has its own stash and starter kit.
        assert_eq!(db.operator(&a).unwrap().items.len(), 3);
        db.switch_operator(&user, &a).unwrap();
        assert_eq!(db.active_operator(&user).as_deref(), Some(a.as_str()));
        assert!(db.switch_operator(&account(&db), &a).is_err(), "not someone else's operator");
        // Only one operator per account can be deployed at a time.
        db.deploy(&a, "r1", &gear::MAPS[0], false).unwrap();
        assert!(db.switch_operator(&user, &b).is_err(), "can't switch away mid-raid");
        let err = db.deploy(&b, "r2", &gear::MAPS[0], false).unwrap_err();
        assert!(err.contains("Alpha is already deployed"), "{err}");
    }

    #[test]
    fn old_single_operator_accounts_carry_over() {
        let path = std::env::temp_dir().join(format!("boxhead-migrate-{}.db", uuid::Uuid::new_v4()));
        let path = path.to_str().unwrap();
        let user = {
            let db = Database::open(path).unwrap();
            let user = account(&db);
            db.ensure_operator(&format!("user:{user}")).unwrap();
            db.conn.lock().unwrap().execute("UPDATE operators SET account = NULL", []).unwrap();
            user
        };
        let db = Database::open(path).unwrap();
        assert_eq!(db.active_operator(&user), Some(format!("user:{user}")));
        assert_eq!(db.operator_summaries(&user)[0].name, "Operator 1");
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn homefront_tiers_cost_cash_and_valuables_and_safe_operators_stop_at_the_safe_tier() {
        let db = Database::open(":memory:").unwrap();
        let user = account(&db);
        let safe = db.create_operator(&user, "Safe", false, 0).unwrap();
        let cost = prog::tier_cost(2).unwrap();
        give(&db, &safe, cost.cash, &[(Rarity::Common, 50)]);
        assert!(db.upgrade_tier(&safe).unwrap_err().contains("valuables"), "common valuables don't count");
        give(&db, &safe, cost.cash, &[(Rarity::Common, 50), (Rarity::Rare, 5), (Rarity::Uncommon, 5), (Rarity::Epic, 5)]);
        assert_eq!(db.upgrade_tier(&safe).unwrap(), 2);
        let op = db.operator(&safe).unwrap();
        assert_eq!(op.cash, 0);
        let left: Vec<Rarity> = op.items.iter().filter(|s| s.item.kind == ItemKind::Valuable).map(|s| s.item.rarity).collect();
        assert!(left.contains(&Rarity::Common) && left.contains(&Rarity::Epic) && left.len() == 3, "the cheapest qualifying valuables were used: {left:?}");
        let c3 = prog::tier_cost(3).unwrap();
        give(&db, &safe, c3.cash, &vec![(c3.min_rarity, 20); 3]);
        db.upgrade_tier(&safe).unwrap();
        let c4 = prog::tier_cost(4).unwrap();
        give(&db, &safe, c4.cash, &vec![(c4.min_rarity, 20); 3]);
        assert!(db.upgrade_tier(&safe).unwrap_err().contains("safe tier"));

        let raider = db.create_operator(&user, "Raider", true, 0).unwrap();
        reach_tier(&db, &raider, 4);
        assert_eq!(db.operator(&raider).unwrap().tier, 4, "raidable operators build past the safe tier");
    }

    #[test]
    fn facilities_follow_the_tier_and_change_the_numbers() {
        let db = Database::open(":memory:").unwrap();
        let user = account(&db);
        let op = db.create_operator(&user, "Builder", true, 0).unwrap();
        give(&db, &op, 100_000, &[]);
        assert_eq!(db.context(&op, 0).stash_capacity(), gear::STASH_CAPACITY);
        db.upgrade_facility(&op, Facility::Storage, 0).unwrap();
        assert!(db.upgrade_facility(&op, Facility::Storage, 0).unwrap_err().contains("tier 2"));
        assert_eq!(db.context(&op, 0).stash_capacity(), gear::STASH_CAPACITY + 10);
        db.upgrade_facility(&op, Facility::Armory, 0).unwrap();
        assert!(db.buy(&op, "shotgun-28").is_ok(), "the Armory stocks power 28");
        assert!(db.buy(&op, "shotgun-32").is_err(), "but not 32 at level 1");
        db.upgrade_facility(&op, Facility::Office, 0).unwrap();
        assert!(db.context(&op, 0).insurance_rate() < prog::BASE_INSURANCE_RATE);
        let cash = db.operator(&op).unwrap().cash;
        db.upgrade_facility(&op, Facility::Workshop, 1_000).unwrap();
        assert_eq!(db.operator(&op).unwrap().cash, cash - Facility::Workshop.cost(1));
        assert_eq!(db.collect_workshop(&op, 1_000 + 2 * 3600).unwrap(), 2 * prog::workshop_rate(1));
        assert_eq!(db.collect_workshop(&op, 1_000 + 2 * 3600).unwrap(), 0, "collected already");
        assert_eq!(db.collect_workshop(&db.create_operator(&user, "Idle", false, 0).unwrap(), 99_999).unwrap(), 0);
    }

    #[test]
    fn operations_ranks_grow_by_raiding_a_map_and_cut_its_fee() {
        let db = Database::open(":memory:").unwrap();
        let user = account(&db);
        let op = db.create_operator(&user, "Runner", false, 0).unwrap();
        let rusty = &gear::MAPS[1];
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE items SET power = 40 WHERE profile = ?1", params![op]).unwrap();
            conn.execute("INSERT INTO operations (profile, map, xp) VALUES (?1, 'rustyard', 144)", params![op]).unwrap();
        }
        give(&db, &op, 10_000, &[]);
        db.deploy(&op, "r", rusty, false).unwrap();
        assert_eq!(db.operator(&op).unwrap().cash, 10_000 - rusty.entry_fee, "rank 0 pays full price");
        let s = db.finish_raid(&op, &outcome(RaidResult::Extracted, vec![], 1000)).unwrap();
        let ops = s.ops.unwrap();
        assert_eq!((ops.map.as_str(), ops.rank, ops.ranked_up), ("rustyard", 1, true));
        assert_eq!(s.bonus_cash, 0, "the bonus uses the rank you deployed with");
        assert_eq!(s.cash_earned, 1000);
        let before = db.operator(&op).unwrap().cash;
        db.deploy(&op, "r", rusty, false).unwrap();
        assert_eq!(before - db.operator(&op).unwrap().cash, prog::ops_fee(rusty, 1));
        let s = db.finish_raid(&op, &outcome(RaidResult::Extracted, vec![], 1000)).unwrap();
        assert_eq!(s.bonus_cash, 40, "rank 1: +4% bounty");
    }

    #[test]
    fn relocation_is_optional_seasonal_and_pays_out_capped_legacy() {
        let db = Database::open(":memory:").unwrap();
        let user = account(&db);
        let op = db.create_operator(&user, "Veteran", false, 0).unwrap();
        assert!(db.relocation_blocker(&user, DEC_20).unwrap().contains("tier 3"));
        reach_tier(&db, &op, 3);
        give(&db, &op, 25_000, &[]);
        assert!(db.relocation_blocker(&user, NOV_9).unwrap().contains("last four weeks"));
        assert!(db.relocate(&user, NOV_9).is_err());
        assert!(db.relocation_blocker(&user, DEC_20).is_none());
        let reward = db.relocate(&user, DEC_20).unwrap();
        assert_eq!((reward.legacy_points, reward.stash_slots, reward.boost_level), (2, prog::STASH_BONUS_PER_RELOCATION, 1));
        assert!(db.operator(&op).is_none(), "the operator is retired");
        assert!(db.active_operator(&user).is_none());
        let st = db.account_state(&user);
        assert_eq!((st.legacy_earned, st.legacy_available, st.relocations), (2, 2, 1));
        assert_eq!(st.badges.len(), 1);
        assert_eq!(st.badges[0].season, "2026-Q4");

        // Once per account per season.
        let next = db.create_operator(&user, "Rookie", true, DEC_20).unwrap();
        reach_tier(&db, &next, 3);
        assert!(db.relocation_blocker(&user, DEC_20).unwrap().contains("already retired"));

        // Legacy follows the account to every operator.
        db.buy_perk(&user, Perk::Packrat).unwrap();
        db.buy_perk(&user, Perk::Firepower).unwrap();
        assert!(db.buy_perk(&user, Perk::Vitality).unwrap_err().contains("No Legacy"));
        let ctx = db.context(&next, DEC_20);
        assert_eq!(ctx.stash_capacity(), gear::STASH_CAPACITY + 5 + 5 + prog::storage_bonus(0) as usize);
        assert!(ctx.raid_boost().damage > 0.0);
        assert_eq!(ctx.boost_level, 0, "the head-start boost is for next season");
        assert_eq!(db.context(&next, DEC_20 + 30 * 86_400).boost_level, 1, "and applies in it");
        let loadout = db.deploy(&next, "r", &gear::MAPS[0], false).unwrap();
        assert!(loadout.boost.damage > 0.0, "perks ride into the raid");
    }

    #[test]
    fn steam_and_bluesky_link_to_one_account_id() {
        let db = Database::open(":memory:").unwrap();
        let user = db.find_or_create_user("steam", "76561190000000001", "Gabe", "Gabe").unwrap();
        db.link_account(&user, "bluesky", "did:plc:abc", "gabe.bsky.social").unwrap();
        // Signing in with either identity lands on the same account.
        assert_eq!(db.find_or_create_user("bluesky", "did:plc:abc", "gabe.bsky.social", "gabe").unwrap(), user);
        assert_eq!(db.find_or_create_user("steam", "76561190000000001", "Gabe N", "Gabe N").unwrap(), user);
        let linked = db.linked_accounts(&user);
        assert_eq!(linked.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["steam", "bluesky"]);
        assert_eq!(linked[0].1, "Gabe N", "handles stay fresh");
        // An identity can't be moved onto a second account.
        let other = db.register_email_user("b@example.com", "secret1").unwrap();
        assert!(db.link_account(&other, "steam", "76561190000000001", "Gabe").unwrap_err().contains("different"));
        db.link_account(&user, "steam", "76561190000000001", "Gabe").unwrap();
        assert!(db.link_account(&user, "steam", "76561190000000002", "Alt").unwrap_err().contains("already has"));
    }

    #[test]
    fn sealed_items_can_be_carried_into_a_raid_and_come_back_decrypted() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        let mut rng = rand::rng();
        let sealed = gear::seal(&mut rng, &Item::new(ItemKind::Uzi, Rarity::Rare, 20, None));
        db.finish_raid("p", &outcome(RaidResult::Extracted, vec![], 0)).unwrap_err();
        db.begin_raid("p", "r", 0).unwrap();
        db.finish_raid("p", &outcome(RaidResult::Extracted, vec![sealed], 0)).unwrap();
        let stashed = db.operator("p").unwrap().items.into_iter().find(|s| s.item.kind == ItemKind::Encrypted).unwrap();
        assert!(db.set_carry("p", &db.operator("p").unwrap().loadout().primary.unwrap().id, true).is_err(), "only sealed items");
        db.set_carry("p", &stashed.item.id, true).unwrap();
        db.begin_raid("p", "r", 0).unwrap();
        let carried = db.raid_carry("p");
        assert_eq!(carried.len(), 1);
        assert!(db.set_carry("p", &stashed.item.id, false).is_err(), "locked while deployed");
        // Decrypted in the raid and extracted: the sealed original is replaced by what was inside.
        let opened = gear::decrypt(&mut rng, &carried[0]);
        db.finish_raid("p", &outcome(RaidResult::Extracted, vec![opened.clone()], 0)).unwrap();
        let op = db.operator("p").unwrap();
        assert!(op.items.iter().all(|s| s.item.kind != ItemKind::Encrypted));
        assert!(op.items.iter().any(|s| s.item.name == opened.name && s.item.power == opened.power));
        // A voided raid puts carried items back.
        let again = gear::seal(&mut rng, &opened);
        db.begin_raid("p", "r", 0).unwrap();
        db.finish_raid("p", &outcome(RaidResult::Extracted, vec![again], 0)).unwrap();
        let id = db.operator("p").unwrap().items.into_iter().find(|s| s.item.kind == ItemKind::Encrypted).unwrap().item.id;
        db.set_carry("p", &id, true).unwrap();
        db.begin_raid("p", "r", 0).unwrap();
        assert!(db.void_raid("p", "r", false));
        assert!(db.operator("p").unwrap().items.iter().any(|s| s.item.id == id && s.carry));
        // Dying loses them.
        db.begin_raid("p", "r", 0).unwrap();
        db.finish_raid("p", &outcome(RaidResult::Killed, vec![], 0)).unwrap();
        assert!(db.operator("p").unwrap().items.iter().all(|s| s.item.id != id));
    }

    #[test]
    fn bulk_selling_pays_for_everything_at_once() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        let a = db.buy("p", "pistol-8").unwrap();
        let b = db.buy("p", "pistol-8").unwrap();
        let before = db.operator("p").unwrap().cash;
        let cash = db.sell_many("p", &[a.id.clone(), b.id.clone()]).unwrap();
        assert_eq!(cash, before + a.value + b.value);
        let equipped = db.operator("p").unwrap().loadout().primary.unwrap().id;
        assert!(db.sell_many("p", &[equipped]).is_err(), "equipped gear isn't bulk-sold");
    }

    #[test]
    fn accounts_are_verified_once_their_email_is_confirmed() {
        let db = Database::open(":memory:").unwrap();
        let email_user = db.register_email_user("a@example.com", "secret1").unwrap();
        let google_user = db.find_or_create_user("google", "sub-1", "g@example.com", "G").unwrap();
        assert!(!db.is_verified(&email_user) && db.is_verified(&google_user));
        assert!(!db.is_verified("no-such-user"));
        let token = db.create_session(&email_user, "direct").unwrap();
        assert!(!db.session_is_verified(Some(&token)));
        db.confirm_email(&email_user).unwrap();
        assert!(db.session_is_verified(Some(&token)));
        assert!(!db.session_is_verified(Some("bogus")) && !db.session_is_verified(Some("")) && !db.session_is_verified(None));
    }

    #[test]
    fn new_email_accounts_must_confirm_and_tokens_work_once() {
        let db = Database::open(":memory:").unwrap();
        let user = db.register_email_user("new@example.com", "secret1").unwrap();
        assert_eq!(db.unconfirmed_email(&user).as_deref(), Some("new@example.com"));
        assert!(!db.is_verified(&user));
        let token = db.issue_auth_token(&user, "confirm", 3600).unwrap();
        assert_eq!(db.take_auth_token(&token, "reset"), None, "kinds don't mix");
        assert_eq!(db.take_auth_token(&token, "confirm").as_deref(), Some(user.as_str()));
        assert_eq!(db.take_auth_token(&token, "confirm"), None, "one use only");
        db.confirm_email(&user).unwrap();
        assert!(db.unconfirmed_email(&user).is_none() && db.is_verified(&user));
        // A newer link replaces the old one; expired links don't work.
        let old = db.issue_auth_token(&user, "reset", 3600).unwrap();
        let new = db.issue_auth_token(&user, "reset", 3600).unwrap();
        assert_eq!(db.take_auth_token(&old, "reset"), None);
        assert!(db.take_auth_token(&new, "reset").is_some());
        let stale = db.issue_auth_token(&user, "reset", -1).unwrap();
        assert_eq!(db.take_auth_token(&stale, "reset"), None);
    }

    #[test]
    fn linking_another_sign_in_skips_email_confirmation() {
        let db = Database::open(":memory:").unwrap();
        let user = db.register_email_user("x@example.com", "secret1").unwrap();
        db.link_account(&user, "steam", "765", "Gabe").unwrap();
        assert!(db.unconfirmed_email(&user).is_none());
        assert_eq!(db.account_email(&user), Some(("x@example.com".into(), false)));
    }

    #[test]
    fn logins_do_not_reveal_which_emails_exist() {
        let db = Database::open(":memory:").unwrap();
        db.register_email_user("a@example.com", "secret1").unwrap();
        assert_eq!(db.verify_email_login("a@example.com", "nope").unwrap_err(), WRONG_LOGIN);
        assert_eq!(db.verify_email_login("ghost@example.com", "nope").unwrap_err(), WRONG_LOGIN);
    }

    #[test]
    fn a_password_reset_signs_out_everywhere_and_confirms_the_email() {
        let db = Database::open(":memory:").unwrap();
        let user = db.register_email_user("r@example.com", "secret1").unwrap();
        let session = db.create_session(&user, "direct").unwrap();
        db.reset_password(&user, "brand-new-pw").unwrap();
        assert_eq!(db.validate_session(&session), None);
        assert!(db.verify_email_login("r@example.com", "secret1").is_err());
        assert_eq!(db.verify_email_login("r@example.com", "brand-new-pw").unwrap(), user);
        assert!(db.unconfirmed_email(&user).is_none());
        let steam = db.find_or_create_user("steam", "1", "S", "S").unwrap();
        assert!(db.reset_password(&steam, "whatever1").is_err(), "no password to reset");
    }

    #[test]
    fn deleting_an_account_removes_everything_it_owns() {
        let db = Database::open(":memory:").unwrap();
        let user = db.register_email_user("d@example.com", "secret1").unwrap();
        let friend = db.register_email_user("f@example.com", "secret1").unwrap();
        db.link_account(&user, "steam", "42", "Del").unwrap();
        db.add_friend(&user, &friend).unwrap();
        let session = db.create_session(&user, "direct").unwrap();
        let op = db.create_operator(&user, "Ghost", false, 0).unwrap();
        db.deploy(&op, "outskirts-direct", crate::gear::default_map(), false).unwrap();
        assert!(db.delete_account(&user).unwrap_err().contains("in a raid"));
        assert!(db.void_raid(&op, "outskirts-direct", false));
        db.delete_account(&user).unwrap();
        assert_eq!(db.validate_session(&session), None);
        assert!(db.get_user(&user).is_none() && db.operator(&op).is_none());
        assert!(db.user_by_email("d@example.com").is_none());
        assert!(db.get_friends(&friend).is_empty(), "gone from friends' lists too");
        // The email and the Steam identity are free to use again.
        db.register_email_user("d@example.com", "secret1").unwrap();
        assert_ne!(db.find_or_create_user("steam", "42", "Del", "Del").unwrap(), user);
        let conn = db.conn.lock().unwrap();
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE profile = ?1", params![op], |r| r.get(0)).unwrap();
        assert_eq!(items, 0);
    }

    #[test]
    fn sessions_remember_their_platform_and_accounts_opt_into_crossplay() {
        let db = Database::open(":memory:").unwrap();
        let user = db.find_or_create_user("steam", "765", "Gabe", "Gabe").unwrap();
        let steam = db.create_session(&user, "steam").unwrap();
        let web = db.create_session(&user, "direct").unwrap();
        assert_eq!(db.session_matchmaking(&steam), Some((user.clone(), "steam".into(), false)));
        assert_eq!(db.session_matchmaking(&web).unwrap().1, "direct", "the same account can sign in on another platform");
        db.set_crossplay(&user, true).unwrap();
        assert!(db.session_matchmaking(&steam).unwrap().2 && db.session_matchmaking(&web).unwrap().2, "cross-play is per account");
        db.set_crossplay(&user, false).unwrap();
        assert!(!db.session_matchmaking(&steam).unwrap().2);
        assert_eq!(db.session_matchmaking("bogus"), None);
        assert_eq!(db.session_matchmaking(""), None);
    }

    #[test]
    fn a_never_played_raid_returns_the_premium_but_keeps_the_fee() {
        let db = Database::open(":memory:").unwrap();
        db.ensure_operator("p").unwrap();
        let premium = gear::insurance_cost(&db.operator("p").unwrap().loadout());
        db.begin_raid_paying("p", "r", 0, 100, true).unwrap();
        assert_eq!(db.operator("p").unwrap().cash, gear::STARTING_CASH - 100 - premium);
        assert!(db.void_raid("p", "r", false));
        assert_eq!(db.operator("p").unwrap().cash, gear::STARTING_CASH - 100, "the premium insured nothing, so it comes back");
        assert!(!db.void_raid("p", "r", true), "a raid is voided once");
    }

    #[test]
    fn operators_can_be_deleted_but_not_mid_raid_or_by_someone_else() {
        let db = Database::open(":memory:").unwrap();
        let (user, other) = (account(&db), account(&db));
        let a = db.create_operator(&user, "Alpha", false, 0).unwrap();
        let b = db.create_operator(&user, "Bravo", false, 0).unwrap();
        db.upgrade_facility(&b, Facility::Storage, 0).unwrap();
        assert!(db.delete_operator(&other, &a).is_err(), "not your operator");
        db.begin_raid(&b, "r", 0).unwrap();
        assert!(db.delete_operator(&user, &b).unwrap_err().contains("in a raid"));
        assert!(db.create_operator(&user, "Charlie", false, 0).unwrap_err().contains("Finish your raid"));
        assert!(db.void_raid(&b, "r", true));
        assert_eq!(db.delete_operator(&user, &b).unwrap(), "Bravo");
        assert!(db.operator(&b).is_none());
        assert_eq!(db.active_operator(&user).as_deref(), Some(a.as_str()), "the remaining operator takes over");
        assert_eq!(db.delete_operator(&user, &a).unwrap(), "Alpha");
        assert!(db.active_operator(&user).is_none());
        let conn = db.conn.lock().unwrap();
        for table in ["items", "facilities", "operations", "operators"] {
            let n: u32 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table} is empty");
        }
    }
}
