//! Bases and base raids in the database: each operator's layout, what they
//! own, their three waves, who they scouted, and the log of raids fought.
//! The rules and the fight itself are in [`crate::siege`].

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::Database;
use crate::siege::{self, Counts, Layout, Plan, Replay, Snapshot, WAVES};

pub(super) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS bases (
        profile TEXT PRIMARY KEY,
        layout TEXT NOT NULL,
        owned TEXT NOT NULL DEFAULT '{}',
        waves TEXT NOT NULL DEFAULT '[]',
        shield_until INTEGER NOT NULL DEFAULT 0,
        target TEXT
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
        lost TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS base_raids_by_attacker ON base_raids(attacker, created_at);
    CREATE INDEX IF NOT EXISTS base_raids_by_defender ON base_raids(defender, created_at);
";

/// One operator's base, as stored. An operator that never built one has the
/// default: an HQ on the west side and nothing else.
#[derive(Clone, Debug, Default)]
struct BaseRow {
    layout: Layout,
    owned: Counts,
    waves: [Counts; WAVES],
    shield_until: i64,
    target: Option<String>,
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
    /// The most this raid could take.
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
    pub loot: u32,
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
    /// Cash a raid on this base could take right now.
    pub at_risk: u32,
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
    pub loot: u32,
    pub replay: Replay,
}

fn sql(e: rusqlite::Error) -> String { e.to_string() }

impl Database {
    fn base_row(conn: &Connection, profile: &str) -> BaseRow {
        conn.query_row("SELECT layout, owned, waves, shield_until, target FROM bases WHERE profile = ?1", params![profile], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?))
        }).optional().ok().flatten().map_or_else(BaseRow::default, |(layout, owned, waves, shield_until, target)| BaseRow {
            layout: serde_json::from_str(&layout).unwrap_or_default(),
            owned: serde_json::from_str(&owned).unwrap_or_default(),
            waves: serde_json::from_str(&waves).unwrap_or_default(),
            shield_until, target,
        })
    }

    fn write_base(conn: &Connection, profile: &str, row: &BaseRow) -> Result<(), String> {
        let json = |v: serde_json::Result<String>| v.map_err(|e| e.to_string());
        conn.execute(
            "INSERT INTO bases (profile, layout, owned, waves, shield_until, target) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(profile) DO UPDATE SET layout = ?2, owned = ?3, waves = ?4, shield_until = ?5, target = ?6",
            params![profile, json(serde_json::to_string(&row.layout))?, json(serde_json::to_string(&row.owned))?,
                json(serde_json::to_string(&row.waves))?, row.shield_until, row.target],
        ).map(|_| ()).map_err(sql)
    }

    /// (name, tier, raidable, cash, account) of an operator.
    fn base_owner(conn: &Connection, profile: &str) -> Option<(String, u32, bool, u32, Option<String>)> {
        conn.query_row("SELECT name, tier, raidable, cash, account FROM operators WHERE profile = ?1", params![profile],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i32>(2)? != 0, r.get(3)?, r.get(4)?))).optional().ok().flatten()
    }

    /// The scouted base, if it can still be raided.
    fn target_view(conn: &Connection, attacker_account: Option<&str>, target: &str, now: i64) -> Option<TargetView> {
        let (name, tier, raidable, cash, account) = Self::base_owner(conn, target)?;
        let row = Self::base_row(conn, target);
        if !raidable || account.is_none() || account.as_deref() == attacker_account || row.shield_until > now { return None; }
        let site = row.layout.site;
        Some(TargetView { name, tier, site, hq: site.hq(), entrances: site.entrances(), loot_pool: siege::loot_pool(cash), hq_hp: siege::hq_hp(tier) })
    }

    fn raid_logs(conn: &Connection, profile: &str, attacking: bool) -> Vec<RaidLog> {
        let (mine, theirs) = if attacking { ("attacker", "defender_name") } else { ("defender", "attacker_name") };
        let query = format!("SELECT id, created_at, {theirs}, hq_damage, destroyed, loot, sent, lost, sim_version FROM base_raids WHERE {mine} = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2");
        conn.prepare(&query).and_then(|mut s| s.query_map(params![profile, siege::LOG_KEEP], |r| Ok(RaidLog {
            id: r.get(0)?, at: r.get(1)?, opponent: r.get(2)?, hq_damage: r.get(3)?, destroyed: r.get::<_, i32>(4)? != 0, loot: r.get(5)?,
            sent: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
            lost: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
            replayable: r.get::<_, u32>(8)? == siege::SIM_VERSION,
        })).map(|rows| rows.flatten().collect())).unwrap_or_default()
    }

    /// Everything the Base screen shows for one operator.
    pub fn base_state(&self, profile: &str, now: i64) -> Option<BaseState> {
        let conn = self.conn.lock().unwrap();
        let (name, tier, raidable, cash, account) = Self::base_owner(&conn, profile)?;
        let row = Self::base_row(&conn, profile);
        let target = row.target.as_deref().and_then(|t| Self::target_view(&conn, account.as_deref(), t, now));
        Some(BaseState {
            name, tier, raidable, cash, at_risk: if raidable { siege::loot_pool(cash) } else { 0 },
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
        if let Some(waves) = waves { row.waves = waves; }
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

    /// Pick a base to raid: another account's Raidable operator with cash worth
    /// taking and no shield, close to the attacker's tier when there is one.
    pub fn scout_base(&self, profile: &str, now: i64) -> Result<TargetView, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        let (_, account) = Self::raid_blocker(&tx, profile)?;
        let account = account.ok_or("Sign in to raid bases")?;
        let (_, tier, ..) = Self::base_owner(&tx, profile).ok_or("No operator for this profile")?;
        let mut row = Self::base_row(&tx, profile);
        // Prefer someone other than the base already on the table.
        let found: Option<String> = tx.query_row(
            "SELECT o.profile FROM operators o LEFT JOIN bases b ON b.profile = o.profile
             WHERE o.raidable = 1 AND o.account IS NOT NULL AND o.account != ?1 AND o.cash >= ?2 AND COALESCE(b.shield_until, 0) <= ?3
             ORDER BY o.profile = COALESCE(?4, ''), ABS(CAST(o.tier AS INTEGER) - ?5) > 1, RANDOM() LIMIT 1",
            params![account, siege::MIN_TARGET_CASH, now, row.target, tier], |r| r.get(0)).optional().map_err(sql)?;
        let Some(found) = found else {
            return Err("No bases to raid right now: everyone is shielded or broke. Try again later.".into());
        };
        let view = Self::target_view(&tx, Some(&account), &found, now).ok_or("That base just became unavailable. Scout again.")?;
        row.target = Some(found);
        Self::write_base(&tx, profile, &row)?;
        tx.commit().map_err(sql)?;
        Ok(view)
    }

    /// Send the saved waves at the scouted base. The fight is settled here and
    /// now: cash moves, dead soldiers are gone, the defender gets a shield, and
    /// both sides get a log entry they can replay.
    pub fn launch_base_raid(&self, profile: &str, entrances: [u8; WAVES], now: i64) -> Result<RaidReport, String> {
        siege::validate_entrances(&entrances)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(sql)?;
        let (attacker_name, account) = Self::raid_blocker(&tx, profile)?;
        let mut mine = Self::base_row(&tx, profile);
        let target = mine.target.clone().ok_or("Scout a base first.")?;
        if Self::target_view(&tx, account.as_deref(), &target, now).is_none() {
            mine.target = None;
            Self::write_base(&tx, profile, &mine)?;
            tx.commit().map_err(sql)?;
            return Err("That base is no longer open to raids. Scout another.".into());
        }
        let (defender_name, tier, _, defender_cash, _) = Self::base_owner(&tx, &target).ok_or("That base is gone. Scout another.")?;
        let mut theirs = Self::base_row(&tx, &target);
        let plan = Plan { waves: mine.waves, entrances };
        if plan.sent().total() == 0 { return Err("Your waves are empty. Add soldiers on the Army tab first.".into()); }

        let snapshot = Snapshot { layout: theirs.layout.clone(), tier };
        let battle = siege::simulate(&snapshot, &plan);
        let outcome = &battle.outcome;
        let loot = siege::loot_for(defender_cash, outcome.hq_damage, outcome.destroyed);

        // Dead soldiers leave the roster and their wave. Raiding also drops your own shield.
        for (wave, lost) in mine.waves.iter_mut().zip(battle.lost_by_wave()) {
            for (k, n) in lost.iter() {
                wave.set(k, wave.get(k).saturating_sub(n));
                mine.owned.set(k, mine.owned.get(k).saturating_sub(n));
            }
        }
        mine.target = None;
        mine.shield_until = 0;
        theirs.shield_until = now + siege::SHIELD_SECS;
        Self::write_base(&tx, profile, &mine)?;
        Self::write_base(&tx, &target, &theirs)?;
        tx.execute("UPDATE operators SET cash = cash - ?1 WHERE profile = ?2", params![loot, target]).map_err(sql)?;
        tx.execute("UPDATE operators SET cash = cash + ?1 WHERE profile = ?2", params![loot, profile]).map_err(sql)?;

        let id = uuid::Uuid::new_v4().to_string();
        let json = |v: serde_json::Result<String>| v.map_err(|e| e.to_string());
        tx.execute(
            "INSERT INTO base_raids (id, attacker, defender, attacker_name, defender_name, created_at, snapshot, plan, sim_version, hq_damage, destroyed, loot, sent, lost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![id, profile, target, attacker_name, defender_name, now, json(serde_json::to_string(&snapshot))?, json(serde_json::to_string(&plan))?,
                siege::SIM_VERSION, outcome.hq_damage, outcome.destroyed as i32, loot,
                json(serde_json::to_string(&outcome.sent))?, json(serde_json::to_string(&outcome.lost))?],
        ).map_err(sql)?;
        // Keep each side's log short.
        for (column, who) in [("attacker", profile), ("defender", target.as_str())] {
            tx.execute(&format!(
                "DELETE FROM base_raids WHERE id IN (SELECT id FROM base_raids WHERE {column} = ?1 ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?2)"),
                params![who, siege::LOG_KEEP]).map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
        Ok(RaidReport { id, defender: defender_name, loot, replay: battle.replay(true) })
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
        let profile = db.create_operator(&user, name, raidable, 0).unwrap();
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

        // Garrison soldiers and wave soldiers both come out of what's owned.
        let waves = [squad(&[(Kind::Rifleman, 2)]), Counts::default(), Counts::default()];
        assert_eq!(db.save_base(&me, None, Some(waves)).unwrap(), 2 * Kind::Rifleman.price());
        let posted = layout(&[(Kind::Turret, 4, 8), (Kind::Rifleman, 3, 8)]);
        assert_eq!(db.save_base(&me, Some(posted), None).unwrap(), Kind::Rifleman.price(), "the third rifleman is new");

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
    fn a_raid_moves_cash_costs_dead_soldiers_and_shields_the_defender() {
        let db = Database::open(":memory:").unwrap();
        let (_, raider) = operator(&db, "Raider", true, 5_000);
        let (_, victim) = operator(&db, "Victim", true, 10_000);
        db.save_base(&victim, Some(layout(&[(Kind::Turret, 4, 7), (Kind::Turret, 4, 9)])), None).unwrap();
        let victim_cash = cash(&db, &victim);
        db.save_base(&raider, None, Some([squad(&[(Kind::Rifleman, 4)]), squad(&[(Kind::Rifleman, 4)]), squad(&[(Kind::Scout, 1)])])).unwrap();
        let raider_cash = cash(&db, &raider);

        assert!(db.launch_base_raid(&raider, [1, 1, 1], NOW).unwrap_err().contains("Scout"));
        let target = db.scout_base(&raider, NOW).unwrap();
        assert_eq!((target.name.as_str(), target.site, target.loot_pool), ("Victim", Site::West, siege::loot_pool(victim_cash)));
        assert_eq!(db.base_state(&raider, NOW).unwrap().target, Some(target));

        let report = db.launch_base_raid(&raider, [1, 1, 1], NOW).unwrap();
        let o = &report.replay.outcome;
        assert!(report.replay.fog, "the attacker's replay is fogged");
        assert!(o.hq_damage > 0.0 && o.lost.total() > 0, "two turrets cost soldiers but don't stop nine");
        assert_eq!(report.loot, siege::loot_for(victim_cash, o.hq_damage, o.destroyed));
        assert!(report.loot > 0);
        assert_eq!(cash(&db, &raider), raider_cash + report.loot);
        assert_eq!(cash(&db, &victim), victim_cash - report.loot);

        let mine = db.base_state(&raider, NOW).unwrap();
        assert_eq!(mine.owned.total(), 9 - o.lost.total(), "the dead are gone from the roster");
        assert_eq!(mine.waves.iter().map(|w| w.total()).sum::<u32>(), 9 - o.lost.total(), "and from their waves");
        assert!(mine.target.is_none());
        assert_eq!((mine.attacks.len(), mine.defenses.len()), (1, 0));
        assert_eq!((mine.attacks[0].opponent.as_str(), mine.attacks[0].loot), ("Victim", report.loot));

        // The defender keeps every piece, sees the raid in the log, and is shielded.
        let theirs = db.base_state(&victim, NOW).unwrap();
        assert_eq!(theirs.layout.pieces.len(), 2);
        assert_eq!((theirs.defenses.len(), theirs.defenses[0].opponent.as_str()), (1, "Raider"));
        assert_eq!(theirs.shield_until, NOW + siege::SHIELD_SECS);
        assert!(db.scout_base(&raider, NOW).unwrap_err().contains("No bases"));
        assert!(db.scout_base(&raider, NOW + siege::SHIELD_SECS).is_ok(), "the shield runs out");

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
    fn only_raidable_operators_on_other_accounts_with_cash_are_targets() {
        let db = Database::open(":memory:").unwrap();
        let (user, raider) = operator(&db, "Raider", true, 5_000);
        // Not targets: my own other operator, a Safe operator, and a broke one.
        let sibling = db.create_operator(&user, "Sibling", true, 0).unwrap();
        db.conn.lock().unwrap().execute("UPDATE operators SET cash = 9000 WHERE profile = ?1", params![sibling]).unwrap();
        db.switch_operator(&user, &raider).unwrap();
        operator(&db, "Lamb", false, 9_000);
        operator(&db, "Broke", true, siege::MIN_TARGET_CASH - 1);
        assert!(db.scout_base(&raider, NOW).unwrap_err().contains("No bases"));
        let (_, safe) = operator(&db, "Homebody", false, 5_000);
        assert!(db.scout_base(&safe, NOW).unwrap_err().contains("Safe operator"));
        assert!(db.launch_base_raid(&safe, [0, 0, 0], NOW).unwrap_err().contains("Safe operator"));

        let (user_a, a) = operator(&db, "Alpha", true, 2_000);
        assert_eq!(db.scout_base(&raider, NOW).unwrap().name, "Alpha");
        let (_, _b) = operator(&db, "Bravo", true, 2_000);
        assert_eq!(db.scout_base(&raider, NOW).unwrap().name, "Bravo", "scouting again finds someone else when it can");
        assert_eq!(db.scout_base(&raider, NOW).unwrap().name, "Alpha");

        // Empty waves can't raid, and a target that became unavailable is dropped.
        assert!(db.launch_base_raid(&raider, [0, 0, 0], NOW).unwrap_err().contains("empty"));
        db.save_base(&raider, None, Some([squad(&[(Kind::Scout, 1)]), Counts::default(), Counts::default()])).unwrap();
        db.delete_operator(&user_a, &a).unwrap();
        assert!(db.base_state(&raider, NOW).unwrap().target.is_none());
        assert!(db.launch_base_raid(&raider, [0, 0, 0], NOW).unwrap_err().contains("Scout"));
    }

    #[test]
    fn raiding_drops_your_own_shield_and_deleting_an_operator_forgets_its_raids() {
        let db = Database::open(":memory:").unwrap();
        let (_, a) = operator(&db, "Alpha", true, 5_000);
        let (user_b, b) = operator(&db, "Bravo", true, 5_000);
        for p in [&a, &b] { db.save_base(p, None, Some([squad(&[(Kind::Rifleman, 2)]), Counts::default(), Counts::default()])).unwrap(); }
        db.scout_base(&a, NOW).unwrap();
        db.launch_base_raid(&a, [0, 0, 0], NOW).unwrap();
        assert!(db.base_state(&b, NOW).unwrap().shield_until > NOW);
        // Bravo hits back: that ends Bravo's shield.
        db.scout_base(&b, NOW).unwrap();
        db.launch_base_raid(&b, [0, 0, 0], NOW).unwrap();
        assert_eq!(db.base_state(&b, NOW).unwrap().shield_until, 0);
        assert_eq!(db.base_state(&a, NOW).unwrap().defenses.len(), 1);

        db.delete_operator(&user_b, &b).unwrap();
        let left = db.base_state(&a, NOW).unwrap();
        assert_eq!((left.attacks.len(), left.defenses.len()), (0, 0), "raids with a deleted operator are gone from both logs");
        assert!(db.base_state(&b, NOW).is_none());
        let rows: u32 = db.conn.lock().unwrap().query_row("SELECT (SELECT COUNT(*) FROM bases WHERE profile = ?1) + (SELECT COUNT(*) FROM base_raids)", params![b], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn the_raid_log_stays_short() {
        let db = Database::open(":memory:").unwrap();
        let (_, a) = operator(&db, "Alpha", true, 100_000);
        let (_, b) = operator(&db, "Bravo", true, 100_000);
        db.save_base(&a, None, Some([squad(&[(Kind::Scout, 1)]), Counts::default(), Counts::default()])).unwrap();
        for i in 0..(siege::LOG_KEEP as i64 + 3) {
            let now = NOW + i * (siege::SHIELD_SECS + 1);
            db.conn.lock().unwrap().execute("UPDATE operators SET cash = 100000 WHERE profile = ?1", params![b]).unwrap();
            db.scout_base(&a, now).unwrap();
            db.launch_base_raid(&a, [0, 0, 0], now).unwrap();
        }
        assert_eq!(db.base_state(&a, NOW).unwrap().attacks.len(), siege::LOG_KEEP as usize);
        assert_eq!(db.base_state(&b, NOW).unwrap().defenses.len(), siege::LOG_KEEP as usize);
    }
}
