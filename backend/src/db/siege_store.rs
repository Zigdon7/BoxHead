//! Bases and base raids in the database: each operator's layout, what they
//! own, their three waves, who they scouted, and the log of raids fought.
//! The rules and the fight itself are in [`crate::siege`].

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::Database;
use crate::siege::{self, Counts, Kind, Layout, Plan, Replay, Snapshot, WAVES};

pub(super) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS bases (
        profile TEXT PRIMARY KEY,
        layout TEXT NOT NULL,
        owned TEXT NOT NULL DEFAULT '{}',
        waves TEXT NOT NULL DEFAULT '[]',
        shield_until INTEGER NOT NULL DEFAULT 0,
        target TEXT,
        scout_streak INTEGER NOT NULL DEFAULT 0,
        last_waves TEXT NOT NULL DEFAULT '[]',
        last_seen_defense_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS base_raids (
        id TEXT PRIMARY KEY,
        attacker TEXT NOT NULL,
        defender TEXT NOT NULL,
        attacker_name TEXT NOT NULL,
        defender_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        plan TEXT NOT NULL,
        sim_version INTEGER NOT NULL,
        hq_damage REAL NOT NULL,
        destroyed INTEGER NOT NULL,
        loot INTEGER NOT NULL,
        sent TEXT NOT NULL,
        lost TEXT NOT NULL,
        attacker_account TEXT NOT NULL DEFAULT '',
        defender_account TEXT NOT NULL DEFAULT '',
        attacker_payout INTEGER NOT NULL DEFAULT 0,
        contract_bonus INTEGER NOT NULL DEFAULT 0,
        salvage INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS base_raids_by_attacker ON base_raids(attacker, created_at);
    CREATE INDEX IF NOT EXISTS base_raids_by_defender ON base_raids(defender, created_at);
";

/// Create tables and add new columns to databases created before this version.
pub(super) fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(|e| format!("Failed to create base schema: {e}"))?;
    for col in [
        "scout_streak INTEGER NOT NULL DEFAULT 0",
        "last_waves TEXT NOT NULL DEFAULT '[]'",
        "last_seen_defense_at INTEGER NOT NULL DEFAULT 0",
    ] {
        let _ = conn.execute(&format!("ALTER TABLE bases ADD COLUMN {col}"), []);
    }
    for col in [
        "attacker_account TEXT NOT NULL DEFAULT ''",
        "defender_account TEXT NOT NULL DEFAULT ''",
        "attacker_payout INTEGER NOT NULL DEFAULT 0",
        "contract_bonus INTEGER NOT NULL DEFAULT 0",
        "salvage INTEGER NOT NULL DEFAULT 0",
    ] {
        let _ = conn.execute(&format!("ALTER TABLE base_raids ADD COLUMN {col}"), []);
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS base_raids_pair ON base_raids(attacker_account, defender_account, created_at);",
    ).map_err(|e| format!("Failed to create base index: {e}"))?;
    Ok(())
}

/// One operator's base, as stored. An operator that never built one has the
/// default: an HQ on the west side and nothing else.
#[derive(Clone, Debug, Default)]
struct BaseRow {
    layout: Layout,
    owned: Counts,
    waves: [Counts; WAVES],
    shield_until: i64,
    target: Option<String>,
    scout_streak: u32,
    last_waves: [Counts; WAVES],
    last_seen_defense_at: i64,
}

/// The base someone scouted: all an attacker knows before sending soldiers in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TargetView {
    pub name: String,
    pub tier: u32,
    pub site: siege::Site,
    pub hq: usize,
    pub entrances: [usize; WAVES],
    /// The most cash this raid could take from the defender (before the fencing burn).
    pub loot_pool: u32,
    pub hq_hp: u32,
}

/// One line of the raid log.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RaidLog {
    pub id: String,
    pub at: i64,
    /// The other operator's name.
    pub opponent: String,
    pub hq_damage: f64,
    pub destroyed: bool,
    /// Cash taken from the defender.
    pub loot: u32,
    /// Total cash received by the attacker (net stolen after burn + contract bonus).
    pub payout: u32,
    /// System contract bonus earned for destroying a defended HQ.
    pub contract_bonus: u32,
    /// Cash salvaged by the defender from dead attackers when the HQ survived.
    pub salvage: u32,
    pub sent: Counts,
    pub lost: Counts,
    /// False once the simulation has changed since the raid was fought.
    pub replayable: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaseState {
    pub name: String,
    pub tier: u32,
    pub raidable: bool,
    pub cash: u32,
    pub layout: Layout,
    pub owned: Counts,
    pub waves: [Counts; WAVES],
    pub shield_until: i64,
    /// Cash a raid on this base could take right now (liquid cash + uncollected Workshop).
    pub at_risk: u32,
    /// Uncollected Workshop cash included in `at_risk`.
    pub workshop_at_risk: u32,
    /// Cost of the next scout action ($0 first, escalating on re-scouts).
    pub scout_fee: u32,
    /// Incoming raids that occurred since the player last viewed the Log tab.
    pub unread_defenses: u32,
    /// Wave template before casualties, if any soldiers can be refilled.
    pub refill_waves: [Counts; WAVES],
    /// Cash needed to buy back missing troops for `refill_waves`.
    pub refill_cost: u32,
    pub target: Option<TargetView>,
    pub attacks: Vec<RaidLog>,
    pub defenses: Vec<RaidLog>,
}

/// What a finished raid did, for the attacker.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RaidReport {
    pub id: String,
    pub defender: String,
    /// Cash lost by the defender.
    pub loot: u32,
    /// Total cash credited to the attacker (net stolen + contract bonus).
    pub payout: u32,
    pub contract_bonus: u32,
    pub salvage: u32,
    pub replay: Replay,
}

fn sql(e: rusqlite::Error) -> String { e.to_string() }

impl Database {
    fn base_row(conn: &Connection, profile: &str) -> BaseRow {
        conn.query_row(
            "SELECT layout, owned, waves, shield_until, target, scout_streak, last_waves, last_seen_defense_at FROM bases WHERE profile = ?1",
            params![profile],
            |r| Ok((
                r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, u32>(5)?,
                r.get::<_, String>(6)?, r.get::<_, i64>(7)?,
            )),
        ).optional().ok().flatten().map_or_else(BaseRow::default, |(layout, owned, waves, shield_until, target, scout_streak, last_waves, last_seen_defense_at)| BaseRow {
            layout: serde_json::from_str(&layout).unwrap_or_default(),
            owned: serde_json::from_str(&owned).unwrap_or_default(),
            waves: serde_json::from_str(&waves).unwrap_or_default(),
            shield_until, target, scout_streak,
            last_waves: serde_json::from_str(&last_waves).unwrap_or_default(),
            last_seen_defense_at,
        })
    }

    fn write_base(conn: &Connection, profile: &str, row: &BaseRow) -> Result<(), String> {
        let json = |v: serde_json::Result<String>| v.map_err(|e| e.to_string());
        conn.execute(
            "INSERT INTO bases (profile, layout, owned, waves, shield_until, target, scout_streak, last_waves, last_seen_defense_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(profile) DO UPDATE SET layout = ?2, owned = ?3, waves = ?4, shield_until = ?5, target = ?6,
             scout_streak = ?7, last_waves = ?8, last_seen_defense_at = ?9",
            params![
                profile, json(serde_json::to_string(&row.layout))?, json(serde_json::to_string(&row.owned))?,
                json(serde_json::to_string(&row.waves))?, row.shield_until, row.target,
                row.scout_streak, json(serde_json::to_string(&row.last_waves))?, row.last_seen_defense_at,
            ],
        ).map(|_| ()).map_err(sql)
    }

    /// (name, tier, raidable, cash, account) of an operator.
    fn base_owner(conn: &Connection, profile: &str) -> Option<(String, u32, bool, u32, Option<String>)> {
        conn.query_row("SELECT name, tier, raidable, cash, account FROM operators WHERE profile = ?1", params![profile],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i32>(2)? != 0, r.get(3)?, r.get(4)?))).optional().ok().flatten()
    }

    /// Uncollected Workshop cash exposed to base raids.
    fn workshop_exposed(conn: &Connection, profile: &str, now: i64) -> u32 {
        Self::context_in(conn, profile, now).workshop_stored(now)
    }

    /// True when `attacker_account` already raided `defender_account` within the pair cooldown.
    fn pair_on_cooldown(conn: &Connection, attacker_account: &str, defender_account: &str, now: i64) -> bool {
        let cutoff = now - siege::PAIR_COOLDOWN_SECS;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM base_raids WHERE attacker_account = ?1 AND defender_account = ?2 AND created_at > ?3)",
            params![attacker_account, defender_account, cutoff],
            |r| r.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    /// The scouted base, if it can still be raided by `attacker_account` at `attacker_tier`.
    fn target_view(conn: &Connection, attacker_account: Option<&str>, attacker_tier: u32, target: &str, now: i64) -> Option<TargetView> {
        let (name, tier, raidable, cash, account) = Self::base_owner(conn, target)?;
        let row = Self::base_row(conn, target);
        let def_account = account.as_deref()?;
        if !raidable || Some(def_account) == attacker_account || row.shield_until > now { return None; }
        if tier.abs_diff(attacker_tier) > siege::MAX_TIER_GAP { return None; }
        if let Some(att_acc) = attacker_account {
            if Self::pair_on_cooldown(conn, att_acc, def_account, now) { return None; }
        }
        let exposed = cash.saturating_add(Self::workshop_exposed(conn, target, now));
        let site = row.layout.site;
        Some(TargetView { name, tier, site, hq: site.hq(), entrances: site.entrances(), loot_pool: siege::loot_pool(exposed), hq_hp: siege::hq_hp(tier) })
    }

    fn raid_logs(conn: &Connection, profile: &str, attacking: bool) -> Vec<RaidLog> {
        let (mine, theirs) = if attacking { ("attacker", "defender_name") } else { ("defender", "attacker_name") };
        let query = format!(
            "SELECT id, created_at, {theirs}, hq_damage, destroyed, loot, sent, lost, sim_version, attacker_payout, contract_bonus, salvage
             FROM base_raids WHERE {mine} = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2"
        );
        conn.prepare(&query).and_then(|mut s| s.query_map(params![profile, siege::LOG_KEEP], |r| {
            let loot: u32 = r.get(5)?;
            let payout: u32 = r.get(9)?;
            Ok(RaidLog {
                id: r.get(0)?, at: r.get(1)?, opponent: r.get(2)?, hq_damage: r.get(3)?, destroyed: r.get::<_, i32>(4)? != 0,
                loot, payout: if payout > 0 || loot == 0 { payout } else { loot },
                contract_bonus: r.get(10)?, salvage: r.get(11)?,
                sent: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                lost: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
                replayable: r.get::<_, u32>(8)? == siege::SIM_VERSION,
            })
        }).map(|rows| rows.flatten().collect())).unwrap_or_default()
    }

    /// Count of incoming raids newer than `last_seen_defense_at`.
    pub(super) fn unread_base_defenses_in(conn: &Connection, profile: &str) -> u32 {
        let seen = Self::base_row(conn, profile).last_seen_defense_at;
        conn.query_row(
            "SELECT COUNT(*) FROM base_raids WHERE defender = ?1 AND created_at > ?2",
            params![profile, seen], |r| r.get(0),
        ).unwrap_or(0)
    }

    /// Value of permanent owned base structures (for seasonal retirement valuation).
    pub(super) fn base_structure_investment(conn: &Connection, profile: &str) -> u32 {
        siege::structure_value(&Self::base_row(conn, profile).owned)
    }

    fn refill_info(row: &BaseRow, tier: u32) -> ([Counts; WAVES], u32) {
        let has_template = row.last_waves.iter().any(|w| w.total() > 0);
        if !has_template || row.last_waves == row.waves || siege::validate_waves(&row.last_waves, tier).is_err() {
            return ([Counts::default(); WAVES], 0);
        }
        let placed = row.layout.placed();
        let needed = row.last_waves.iter().fold(placed, |acc, w| acc.plus(w));
        (row.last_waves, needed.cost_beyond(&row.owned))
    }

    /// Everything the Base screen shows for one operator.
    pub fn base_state(&self, profile: &str, now: i64) -> Option<BaseState> {
        let conn = self.conn.lock().unwrap();
        let (name, tier, raidable, cash, account) = Self::base_owner(&conn, profile)?;
        let row = Self::base_row(&conn, profile);
        let workshop = Self::workshop_exposed(&conn, profile, now);
        let target = row.target.as_deref().and_then(|t| Self::target_view(&conn, account.as_deref(), tier, t, now));
        let (refill_waves, refill_cost) = Self::refill_info(&row, tier);
        Some(BaseState {
            name, tier, raidable, cash,
            at_risk: if raidable { siege::loot_pool(cash.saturating_add(workshop)) } else { 0 },
            workshop_at_risk: if raidable { workshop } else { 0 },
            scout_fee: siege::scout_fee(row.scout_streak),
            unread_defenses: Self::unread_base_defenses_in(&conn, profile),
            refill_waves, refill_cost,
            layout: row.layout, owned: row.owned, waves: row.waves, shield_until: row.shield_until, target,
            attacks: Self::raid_logs(&conn, profile, true), defenses: Self::raid_logs(&conn, profile, false),
        })
    }

    /// Save a new layout and/or new waves, buying whatever they need that the
    /// operator doesn't own yet. Pieces taken off the map stay owned. Returns
    /// what was spent.
    pub fn save_base(&self, profile: &str, layout: Option<Layout>, waves: Option<[Counts; WAVES]>) -> Result<u32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        let (_, tier, _, cash, _) = Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut row = Self::base_row(&tx, profile);
        if let Some(layout) = layout { row.layout = layout; }
        if let Some(waves) = waves {
            row.waves = waves;
            row.last_waves = waves;
        }
        let placed = row.layout.validate(tier)?;
        siege::validate_waves(&row.waves, tier)?;
        let needed = row.waves.iter().fold(placed, |acc, w| acc.plus(w));
        let cost = needed.cost_beyond(&row.owned);
        if cash < cost { return Err(format!("That costs ${cost}. You need ${} more.", cost - cash)); }
        for k in siege::KINDS { row.owned.set(k, row.owned.get(k).max(needed.get(k))); }
        Self::write_base(&tx, profile, &row)?;
        tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2", params![cost, profile]).map_err(sql)?;
        tx.commit().map_err(sql)?;
        Ok(cost)
    }

    /// Restore the saved pre-casualty wave template in one click, buying only missing soldiers.
    pub fn refill_waves(&self, profile: &str) -> Result<u32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        let (_, tier, _, cash, _) = Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut row = Self::base_row(&tx, profile);
        if row.last_waves.iter().all(|w| w.total() == 0) || row.last_waves == row.waves {
            return Err("No lost troops to refill.".into());
        }
        siege::validate_waves(&row.last_waves, tier)?;
        let placed = row.layout.placed();
        let needed = row.last_waves.iter().fold(placed, |acc, w| acc.plus(w));
        let cost = needed.cost_beyond(&row.owned);
        if cash < cost { return Err(format!("Refilling costs ${cost}. You need ${} more.", cost - cash)); }
        for k in siege::SOLDIERS { row.owned.set(k, row.owned.get(k).max(needed.get(k))); }
        row.waves = row.last_waves;
        Self::write_base(&tx, profile, &row)?;
        tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2", params![cost, profile]).map_err(sql)?;
        tx.commit().map_err(sql)?;
        Ok(cost)
    }

    /// Sell `count` spare owned base pieces or reserve soldiers for 50% cash refund.
    pub fn sell_base_spare(&self, profile: &str, kind: Kind, count: u32) -> Result<u32, String> {
        if count == 0 { return Err("Choose at least one to sell.".into()); }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut row = Self::base_row(&tx, profile);
        let used = row.waves.iter().fold(row.layout.placed(), |acc, w| acc.plus(w));
        let spare = row.owned.get(kind).saturating_sub(used.get(kind));
        if count > spare { return Err(format!("You only have {spare} spare {} to sell.", kind.label().to_lowercase())); }
        row.owned.set(kind, row.owned.get(kind) - count);
        let refund = siege::sell_refund(kind, count);
        Self::write_base(&tx, profile, &row)?;
        tx.execute("UPDATE operators SET cash = cash + ?1 WHERE profile = ?2", params![refund, profile]).map_err(sql)?;
        tx.commit().map_err(sql)?;
        Ok(refund)
    }

    /// Mark incoming defense raid notifications as read.
    pub fn ack_base_defenses(&self, profile: &str, now: i64) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut row = Self::base_row(&tx, profile);
        let latest: i64 = tx.query_row(
            "SELECT COALESCE(MAX(created_at), 0) FROM base_raids WHERE defender = ?1",
            params![profile], |r| r.get(0),
        ).unwrap_or(0);
        row.last_seen_defense_at = row.last_seen_defense_at.max(now).max(latest);
        Self::write_base(&tx, profile, &row)?;
        tx.commit().map_err(sql)?;
        Ok(())
    }

    /// Run a raid against the operator's own base and change nothing. The
    /// layout may be a draft that hasn't been saved (or paid for), and the
    /// soldiers don't have to be owned: only the tier's limits apply.
    pub fn practice_raid(&self, profile: &str, layout: Option<Layout>, plan: &Plan) -> Result<Replay, String> {
        let (tier, layout) = {
            let conn = self.conn.lock().unwrap();
            let (_, tier, ..) = Self::base_owner(&conn, profile).ok_or("No operator for this profile")?;
            (tier, layout.unwrap_or_else(|| Self::base_row(&conn, profile).layout))
        };
        layout.validate(tier)?;
        siege::validate_waves(&plan.waves, tier)?;
        siege::validate_entrances(&plan.entrances)?;
        if plan.sent().total() == 0 { return Err("Put at least one soldier in a wave.".into()); }
        Ok(siege::simulate(&Snapshot { layout, tier }, plan).replay(false))
    }

    /// Why this operator can't raid bases right now, if it can't.
    fn raid_blocker(conn: &Connection, profile: &str) -> Result<(String, Option<String>), String> {
        let (name, _, raidable, _, account) = Self::base_owner(conn, profile).ok_or("No operator for this profile")?;
        if !raidable { return Err(format!("{name} is a Safe operator. Only Raidable operators can raid bases or be raided.")); }
        Ok((name, account))
    }

    /// Pick a base to raid: another account's Raidable operator within ±1 tier,
    /// not on 24h pair cooldown, no shield, and at least MIN_TARGET_CASH exposed
    /// (liquid cash + uncollected Workshop). First scout is free; re-scouts charge
    /// an escalating fee.
    pub fn scout_base(&self, profile: &str, now: i64) -> Result<(TargetView, u32), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        let (_, account) = Self::raid_blocker(&tx, profile)?;
        let account = account.ok_or("Sign in to raid bases")?;
        let (_, tier, _, cash, _) = Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut row = Self::base_row(&tx, profile);
        let fee = siege::scout_fee(row.scout_streak);
        if cash < fee {
            return Err(format!("Scouting another base costs ${fee}. You need ${} more.", fee - cash));
        }
        let pair_cutoff = now - siege::PAIR_COOLDOWN_SECS;
        // Prefer someone other than the base already on the table; hard cap at ±1 tier and 24h pair cooldown.
        let candidates: Vec<(String, u32)> = tx.prepare(
            "SELECT o.profile, o.cash FROM operators o LEFT JOIN bases b ON b.profile = o.profile
             WHERE o.raidable = 1 AND o.account IS NOT NULL AND o.account != ?1
               AND COALESCE(b.shield_until, 0) <= ?2
               AND ABS(CAST(o.tier AS INTEGER) - ?3) <= ?4
               AND NOT EXISTS (
                   SELECT 1 FROM base_raids r
                   WHERE r.attacker_account = ?1 AND r.defender_account = o.account AND r.created_at > ?5
               )
             ORDER BY o.profile = COALESCE(?6, ''), RANDOM()"
        ).and_then(|mut s| s.query_map(
            params![account, now, tier, siege::MAX_TIER_GAP, pair_cutoff, row.target],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map(|rows| rows.flatten().collect())).map_err(sql)?;

        let found = candidates.into_iter().find(|(p, c)| {
            c.saturating_add(Self::workshop_exposed(&tx, p, now)) >= siege::MIN_TARGET_CASH
        }).map(|(p, _)| p);

        let Some(found) = found else {
            return Err("No bases to raid right now: everyone within one tier is shielded, on cooldown or broke. Try again later.".into());
        };
        let view = Self::target_view(&tx, Some(&account), tier, &found, now).ok_or("That base just became unavailable. Scout again.")?;
        if fee > 0 {
            tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2", params![fee, profile]).map_err(sql)?;
        }
        row.target = Some(found);
        row.scout_streak = row.scout_streak.saturating_add(1);
        Self::write_base(&tx, profile, &row)?;
        tx.commit().map_err(sql)?;
        Ok((view, fee))
    }

    /// Send the saved waves at the scouted base. The fight is settled here and
    /// now: cash moves (with fencing burn, contract bonus, and defender salvage),
    /// dead soldiers are gone, the defender gets a shield, and a 24h pair cooldown starts.
    pub fn launch_base_raid(&self, profile: &str, entrances: [u8; WAVES], now: i64) -> Result<RaidReport, String> {
        siege::validate_entrances(&entrances)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        let (attacker_name, account) = Self::raid_blocker(&tx, profile)?;
        let attacker_account = account.ok_or("Sign in to raid bases")?;
        let (_, attacker_tier, ..) = Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut mine = Self::base_row(&tx, profile);
        let target = mine.target.clone().ok_or("Scout a base first.")?;
        if Self::target_view(&tx, Some(&attacker_account), attacker_tier, &target, now).is_none() {
            mine.target = None;
            Self::write_base(&tx, profile, &mine)?;
            tx.commit().map_err(sql)?;
            return Err("That base is no longer open to raids. Scout another.".into());
        }
        let (defender_name, tier, _, defender_cash, defender_account) = Self::base_owner(&tx, &target).ok_or("That base is gone. Scout another.")?;
        let defender_account = defender_account.unwrap_or_default();
        let mut theirs = Self::base_row(&tx, &target);
        let plan = Plan { waves: mine.waves, entrances };
        if plan.sent().total() == 0 { return Err("Your waves are empty. Add soldiers on the Army tab first.".into()); }

        let snapshot = Snapshot { layout: theirs.layout.clone(), tier };
        let battle = siege::simulate(&snapshot, &plan);
        let outcome = &battle.outcome;
        let workshop = Self::workshop_exposed(&tx, &target, now);
        let exposed = defender_cash.saturating_add(workshop);
        let loot = siege::loot_for(exposed, outcome.hq_damage, outcome.destroyed);
        let net_stolen = siege::attacker_loot(loot);
        let contract = siege::contract_bonus(&theirs.layout, tier, outcome.destroyed);
        let payout = net_stolen.saturating_add(contract);
        let salvage = siege::defender_salvage(&outcome.lost, outcome.destroyed);

        // Remember pre-casualty waves for 1-click Refill, then deduct dead soldiers.
        mine.last_waves = mine.waves;
        for (wave, lost) in mine.waves.iter_mut().zip(battle.lost_by_wave()) {
            for (k, n) in lost.iter() {
                wave.set(k, wave.get(k).saturating_sub(n));
                mine.owned.set(k, mine.owned.get(k).saturating_sub(n));
            }
        }
        mine.target = None;
        mine.scout_streak = 0;
        mine.shield_until = 0;
        theirs.shield_until = now + siege::SHIELD_SECS;
        Self::write_base(&tx, profile, &mine)?;
        Self::write_base(&tx, &target, &theirs)?;

        // Deduct defender's loss from liquid cash first, sweeping uncollected Workshop if needed,
        // then credit any defense salvage bounty.
        if loot <= defender_cash {
            tx.execute("UPDATE operators SET cash = cash - ?1 + ?2 WHERE profile = ?3", params![loot, salvage, target]).map_err(sql)?;
        } else {
            let new_cash = exposed.saturating_sub(loot).saturating_add(salvage);
            tx.execute("UPDATE operators SET cash = ?1, produced_at = ?2 WHERE profile = ?3", params![new_cash, now, target]).map_err(sql)?;
        }
        tx.execute("UPDATE operators SET cash = cash + ?1 WHERE profile = ?2", params![payout, profile]).map_err(sql)?;

        let id = uuid::Uuid::new_v4().to_string();
        let json = |v: serde_json::Result<String>| v.map_err(|e| e.to_string());
        tx.execute(
            "INSERT INTO base_raids (id, attacker, defender, attacker_name, defender_name, created_at, snapshot, plan, sim_version, hq_damage, destroyed, loot, sent, lost, attacker_account, defender_account, attacker_payout, contract_bonus, salvage)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                id, profile, target, attacker_name, defender_name, now, json(serde_json::to_string(&snapshot))?, json(serde_json::to_string(&plan))?,
                siege::SIM_VERSION, outcome.hq_damage, outcome.destroyed as i32, loot,
                json(serde_json::to_string(&outcome.sent))?, json(serde_json::to_string(&outcome.lost))?,
                attacker_account, defender_account, payout, contract, salvage,
            ],
        ).map_err(sql)?;
        // Keep each side's log short.
        for (column, who) in [("attacker", profile), ("defender", target.as_str())] {
            tx.execute(&format!(
                "DELETE FROM base_raids WHERE id IN (SELECT id FROM base_raids WHERE {column} = ?1 ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?2)"),
                params![who, siege::LOG_KEEP]).map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
        Ok(RaidReport { id, defender: defender_name, loot, payout, contract_bonus: contract, salvage, replay: battle.replay(true) })
    }

    /// Play a logged raid back. The attacker sees it through the fog they had;
    /// the defender sees their whole base.
    pub fn base_replay(&self, profile: &str, raid_id: &str) -> Result<Replay, String> {
        let (attacker, defender, snapshot, plan, version) = {
            let conn = self.conn.lock().unwrap();
            conn.query_row("SELECT attacker, defender, snapshot, plan, sim_version FROM base_raids WHERE id = ?1", params![raid_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, u32>(4)?)))
                .optional().map_err(sql)?.ok_or("That raid isn't in your log.")?
        };
        if attacker != profile && defender != profile { return Err("That raid isn't in your log.".into()); }
        if version != siege::SIM_VERSION { return Err("That raid was fought under older rules and can't be replayed.".into()); }
        let snapshot: Snapshot = serde_json::from_str(&snapshot).map_err(|e| e.to_string())?;
        let plan: Plan = serde_json::from_str(&plan).map_err(|e| e.to_string())?;
        Ok(siege::simulate(&snapshot, &plan).replay(attacker == profile))
    }

    /// Forget an operator's base and every raid it fought, on either side.
    pub(super) fn remove_base_data(conn: &Connection, profile: &str) -> Result<(), String> {
        conn.execute("DELETE FROM bases WHERE profile = ?1", params![profile]).map_err(sql)?;
        conn.execute("UPDATE bases SET target = NULL WHERE target = ?1", params![profile]).map_err(sql)?;
        conn.execute("DELETE FROM base_raids WHERE attacker = ?1 OR defender = ?1", params![profile]).map_err(sql)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::siege::{Kind, Piece, Site};

    fn account(db: &Database) -> String { db.register_email_user(&format!("{}@x.io", uuid::Uuid::new_v4()), "secret12").unwrap() }
    fn operator(db: &Database, name: &str, raidable: bool, cash: u32) -> (String, String) {
        let user = account(db);
        let profile = db.create_operator(&user, name, raidable, NOW).unwrap();
        db.conn.lock().unwrap().execute("UPDATE operators SET cash = ?1 WHERE profile = ?2", params![cash, profile]).unwrap();
        (user, profile)
    }
    fn cash(db: &Database, profile: &str) -> u32 { db.operator(profile).unwrap().cash }
    fn squad(pairs: &[(Kind, u32)]) -> Counts {
        let mut c = Counts::default();
        for &(k, n) in pairs { c.set(k, n); }
        c
    }
    fn layout(pieces: &[(Kind, u8, u8)]) -> Layout {
        Layout { site: Site::West, pieces: pieces.iter().map(|&(kind, x, y)| Piece { kind, x, y }).collect() }
    }
    const NOW: i64 = 1_794_225_600;

    #[test]
    fn saving_buys_what_is_missing_and_keeps_what_is_removed() {
        let db = Database::open(":memory:").unwrap();
        let (_, me) = operator(&db, "Mason", false, 1_000);
        let fresh = db.base_state(&me, NOW).unwrap();
        assert_eq!((fresh.layout.clone(), fresh.owned.total(), fresh.cash), (Layout::default(), 0, 1_000));

        let spent = db.save_base(&me, Some(layout(&[(Kind::Wall, 5, 5), (Kind::Wall, 5, 6), (Kind::Turret, 4, 8)])), None).unwrap();
        assert_eq!(spent, 2 * Kind::Wall.price() + Kind::Turret.price());
        assert_eq!(cash(&db, &me), 1_000 - spent);
        // Taking a wall off the map keeps it; putting it back is free.
        assert_eq!(db.save_base(&me, Some(layout(&[(Kind::Wall, 5, 5), (Kind::Turret, 4, 8)])), None).unwrap(), 0);
        assert_eq!(db.save_base(&me, Some(layout(&[(Kind::Wall, 9, 9), (Kind::Wall, 9, 10), (Kind::Turret, 4, 8)])), None).unwrap(), 0);
        assert_eq!(db.base_state(&me, NOW).unwrap().owned.get(Kind::Wall), 2);
        // Owned structures count toward seasonal retirement value.
        let val = db.operator_value(&me);
        assert!(val >= cash(&db, &me) + spent, "base structures preserve retirement value");

        // Garrison soldiers and wave soldiers both come out of what's owned.
        let waves = [squad(&[(Kind::Rifleman, 2)]), Counts::default(), Counts::default()];
        assert_eq!(db.save_base(&me, None, Some(waves)).unwrap(), 2 * Kind::Rifleman.price());
        let posted = layout(&[(Kind::Turret, 4, 8), (Kind::Rifleman, 3, 8)]);
        assert_eq!(db.save_base(&me, Some(posted), None).unwrap(), Kind::Rifleman.price(), "the third rifleman is new");

        // Selling spare pieces refunds 50% cash and cannot sell placed/assigned items.
        assert_eq!(db.sell_base_spare(&me, Kind::Wall, 2).unwrap(), 25);
        assert!(db.sell_base_spare(&me, Kind::Turret, 1).is_err(), "placed turret is not spare");

        // Too poor, off the rules, or walled off: nothing changes.
        let before = (cash(&db, &me), db.base_state(&me, NOW).unwrap().layout);
        assert!(db.save_base(&me, Some(layout(&[(Kind::Turret, 4, 8), (Kind::Turret, 4, 10), (Kind::Turret, 4, 6)])), None).unwrap_err().contains("holds 2"));
        assert!(db.save_base(&me, None, Some([squad(&[(Kind::Heavy, 3)]); 3])).unwrap_err().contains("need $"));
        assert!(db.save_base(&me, None, Some([squad(&[(Kind::Rifleman, 9)]); 3])).unwrap_err().contains("supply"));
        assert_eq!((cash(&db, &me), db.base_state(&me, NOW).unwrap().layout), before);
    }

    #[test]
    fn practice_changes_nothing_and_shows_the_whole_base() {
        let db = Database::open(":memory:").unwrap();
        let (_, me) = operator(&db, "Mason", false, 300);
        let draft = layout(&[(Kind::Turret, 4, 8), (Kind::Mine, 12, 8)]);
        let plan = Plan { waves: [squad(&[(Kind::Rifleman, 4)]); 3], entrances: [1, 1, 1] };
        let replay = db.practice_raid(&me, Some(draft), &plan).unwrap();
        assert!(!replay.fog);
        assert_eq!((replay.defenses.len(), replay.mines.len()), (1, 1), "an unsaved, unpaid draft can be tested");
        assert_eq!(cash(&db, &me), 300);
        assert_eq!(db.base_state(&me, NOW).unwrap().layout, Layout::default());
        assert!(db.practice_raid(&me, None, &Plan::default()).unwrap_err().contains("at least one soldier"));
        let big = Plan { waves: [squad(&[(Kind::Rifleman, 30)]); 3], entrances: [0, 0, 0] };
        assert!(db.practice_raid(&me, None, &big).unwrap_err().contains("supply"));
        assert!(db.practice_raid(&me, None, &Plan { entrances: [0, 0, 7], ..plan }).is_err());
    }

    #[test]
    fn a_raid_moves_cash_with_burn_contract_salvage_and_pair_cooldown() {
        let db = Database::open(":memory:").unwrap();
        let (_, raider) = operator(&db, "Raider", true, 5_000);
        let (_, victim) = operator(&db, "Victim", true, 10_000);
        db.save_base(&victim, Some(layout(&[(Kind::Turret, 4, 7), (Kind::Turret, 4, 9)])), None).unwrap();
        let victim_cash = cash(&db, &victim);
        db.save_base(&raider, None, Some([squad(&[(Kind::Rifleman, 4)]), squad(&[(Kind::Rifleman, 4)]), squad(&[(Kind::Scout, 1)])])).unwrap();
        let raider_cash = cash(&db, &raider);

        assert!(db.launch_base_raid(&raider, [1, 1, 1], NOW).unwrap_err().contains("Scout"));
        let (target, fee) = db.scout_base(&raider, NOW).unwrap();
        assert_eq!(fee, 0, "first scout is free");
        assert_eq!((target.name.as_str(), target.site, target.loot_pool), ("Victim", Site::West, siege::loot_pool(victim_cash)));
        assert_eq!(db.base_state(&raider, NOW).unwrap().target, Some(target));
        assert_eq!(db.base_state(&raider, NOW).unwrap().scout_fee, 50, "next re-scout costs $50");

        let report = db.launch_base_raid(&raider, [1, 1, 1], NOW).unwrap();
        let o = &report.replay.outcome;
        assert!(report.replay.fog, "the attacker's replay is fogged");
        assert!(o.hq_damage > 0.0 && o.lost.total() > 0, "two turrets cost soldiers but don't stop nine");
        assert_eq!(report.loot, siege::loot_for(victim_cash, o.hq_damage, o.destroyed));
        assert_eq!(report.payout, siege::attacker_loot(report.loot) + report.contract_bonus);
        assert_eq!(cash(&db, &raider), raider_cash + report.payout);
        assert_eq!(cash(&db, &victim), victim_cash - report.loot + report.salvage);

        let mine = db.base_state(&raider, NOW).unwrap();
        assert_eq!(mine.owned.total(), 9 - o.lost.total(), "the dead are gone from the roster");
        assert_eq!(mine.waves.iter().map(|w| w.total()).sum::<u32>(), 9 - o.lost.total(), "and from their waves");
        assert_eq!(mine.scout_fee, 0, "scout streak resets after raiding");
        assert!(mine.refill_cost > 0, "refill knows what was lost");
        let spent_refill = db.refill_waves(&raider).unwrap();
        assert_eq!(spent_refill, mine.refill_cost);
        assert_eq!(db.base_state(&raider, NOW).unwrap().waves.iter().map(|w| w.total()).sum::<u32>(), 9);

        // The defender keeps every piece, sees an unread defense, is shielded, and can ack notifications.
        let theirs = db.base_state(&victim, NOW).unwrap();
        assert_eq!(theirs.layout.pieces.len(), 2);
        assert_eq!(theirs.unread_defenses, 1);
        db.ack_base_defenses(&victim, NOW).unwrap();
        assert_eq!(db.base_state(&victim, NOW).unwrap().unread_defenses, 0);
        assert_eq!(theirs.shield_until, NOW + siege::SHIELD_SECS);

        // Pair cooldown closes the shield-drop exploit: even if Victim attacks someone to drop
        // their 8h shield, Raider still cannot scout or raid Victim for 24h!
        db.save_base(&victim, None, Some([squad(&[(Kind::Scout, 1)]), Counts::default(), Counts::default()])).unwrap();
        db.scout_base(&victim, NOW).unwrap();
        db.launch_base_raid(&victim, [0, 0, 0], NOW).unwrap();
        assert_eq!(db.base_state(&victim, NOW).unwrap().shield_until, 0, "victim dropped own shield");
        assert!(db.scout_base(&raider, NOW + siege::SHIELD_SECS + 1).is_err(), "24h pair cooldown still blocks raider");
        assert!(db.scout_base(&raider, NOW + siege::PAIR_COOLDOWN_SECS + 1).is_ok(), "after 24h cooldown raider can scout again");

        // Each side replays it their own way; strangers can't.
        let id = &mine.attacks[0].id;
        assert!(db.base_replay(&raider, id).unwrap().fog);
        let full = db.base_replay(&victim, id).unwrap();
        assert!(!full.fog && full.defenses.len() == 2);
        assert_eq!(full.outcome, report.replay.outcome, "a replay is the same fight");
        let (_, stranger) = operator(&db, "Stranger", true, 0);
        assert!(db.base_replay(&stranger, id).is_err());
    }

    #[test]
    fn only_raidable_peers_within_one_tier_with_exposed_cash_are_targets() {
        let db = Database::open(":memory:").unwrap();
        let (user, raider) = operator(&db, "Raider", true, 5_000);
        // Not targets: sibling, Safe, broke, or >1 tier away.
        let sibling = db.create_operator(&user, "Sibling", true, NOW).unwrap();
        db.conn.lock().unwrap().execute("UPDATE operators SET cash = 9000 WHERE profile = ?1", params![sibling]).unwrap();
        db.switch_operator(&user, &raider).unwrap();
        operator(&db, "Lamb", false, 9_000);
        operator(&db, "Broke", true, siege::MIN_TARGET_CASH - 1);
        let (_, high_tier) = operator(&db, "WhaleT4", true, 50_000);
        db.conn.lock().unwrap().execute("UPDATE operators SET tier = 4 WHERE profile = ?1", params![high_tier]).unwrap();
        assert!(db.scout_base(&raider, NOW).unwrap_err().contains("No bases"));

        // An operator with $0 liquid cash but >= $500 uncollected Workshop IS a valid target.
        let (_, ws_op) = operator(&db, "Workshopper", true, 0);
        db.conn.lock().unwrap().execute("INSERT INTO facilities (profile, facility, level) VALUES (?1, 'workshop', 1)", params![ws_op]).unwrap();
        db.conn.lock().unwrap().execute("UPDATE operators SET produced_at = ?1 WHERE profile = ?2", params![NOW - 10 * 3600, ws_op]).unwrap();
        let (found_ws, fee0) = db.scout_base(&raider, NOW).unwrap();
        assert_eq!((found_ws.name.as_str(), fee0), ("Workshopper", 0));

        // Re-scouting charges escalating fee ($50) and prefers someone else.
        let (user_a, a) = operator(&db, "Alpha", true, 2_000);
        let (found_a, fee1) = db.scout_base(&raider, NOW).unwrap();
        assert_eq!((found_a.name.as_str(), fee1), ("Alpha", 50));

        // Empty waves can't raid, and a target that became unavailable is dropped.
        assert!(db.launch_base_raid(&raider, [0, 0, 0], NOW).unwrap_err().contains("empty"));
        db.save_base(&raider, None, Some([squad(&[(Kind::Scout, 1)]), Counts::default(), Counts::default()])).unwrap();
        db.delete_operator(&user_a, &a).unwrap();
        assert!(db.base_state(&raider, NOW).unwrap().target.is_none());
        assert!(db.launch_base_raid(&raider, [0, 0, 0], NOW).unwrap_err().contains("Scout"));
    }

    #[test]
    fn defender_earns_salvage_when_hq_survives_and_log_stays_short() {
        let db = Database::open(":memory:").unwrap();
        let (_, a) = operator(&db, "Alpha", true, 100_000);
        let (_, b) = operator(&db, "Bravo", true, 100_000);
        db.save_base(&b, Some(layout(&[(Kind::Turret, 4, 7), (Kind::Turret, 4, 9)])), None).unwrap();
        db.save_base(&a, None, Some([squad(&[(Kind::Heavy, 1)]), Counts::default(), Counts::default()])).unwrap();
        let b_before = cash(&db, &b);
        db.scout_base(&a, NOW).unwrap();
        let rep = db.launch_base_raid(&a, [1, 1, 1], NOW).unwrap();
        assert!(!rep.replay.outcome.destroyed);
        assert_eq!(rep.salvage, siege::defender_salvage(&rep.replay.outcome.lost, false));
        assert!(rep.salvage > 0, "defender salvages cash from dead attacker");
        assert_eq!(cash(&db, &b), b_before - rep.loot + rep.salvage);

        // Log trims to LOG_KEEP even across many days.
        db.save_base(&b, Some(Layout::default()), None).unwrap();
        db.save_base(&a, None, Some([squad(&[(Kind::Scout, 1)]), Counts::default(), Counts::default()])).unwrap();
        for i in 1..=(siege::LOG_KEEP as i64 + 3) {
            let now = NOW + i * (siege::PAIR_COOLDOWN_SECS + 1);
            db.conn.lock().unwrap().execute("UPDATE operators SET cash = 100000 WHERE profile = ?1", params![b]).unwrap();
            db.scout_base(&a, now).unwrap();
            db.launch_base_raid(&a, [0, 0, 0], now).unwrap();
        }
        assert_eq!(db.base_state(&a, NOW).unwrap().attacks.len(), siege::LOG_KEEP as usize);
        assert_eq!(db.base_state(&b, NOW).unwrap().defenses.len(), siege::LOG_KEEP as usize);
    }
}
