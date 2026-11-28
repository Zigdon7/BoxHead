//! Long-term progression: operators, Homefront, Operations, seasons and Legacy.
//!
//! * An **account** owns up to [`MAX_OPERATORS`] operators. Each operator is
//!   created either **raidable** (its Homefront can be raided and it may run
//!   PvP) or **safe** (its Homefront stays in the safe tier and it is PvE only).
//!   That choice is permanent for the operator.
//! * **Homefront** is an operator's base: a tier (1–4) and facilities whose
//!   level can't pass the tier. Safe operators top out at [`SAFE_TIER_CAP`].
//! * **Operations** are per-map ranks earned by raiding that map. Ranks cut
//!   the map's entry fee and raise its bounty.
//! * **Seasons** are fixed calendar quarters. In the last
//!   [`RELOCATION_WINDOW_DAYS`] days of a season an account may **relocate**
//!   one operator: the operator is retired (everything it owns is gone) and
//!   the account earns **Legacy** — capped perk points, stash space, a season
//!   badge and a head-start boost for the next season. Relocating is optional
//!   and skipping a season costs nothing.

use serde::Serialize;

use crate::gear::{MapDef, Rarity};

// ---------- Operators ----------

pub const MAX_OPERATORS: usize = 3;
pub const OPERATOR_NAME_MAX: usize = 16;

/// Trim and validate an operator name. Blank names get a numbered default.
pub fn clean_operator_name(raw: &str, ordinal: usize) -> Result<String, String> {
    let name: String = raw.trim().chars().take(OPERATOR_NAME_MAX).collect();
    if name.is_empty() { return Ok(format!("Operator {ordinal}")); }
    if !name.chars().all(|c| c.is_alphanumeric() || " -_'.".contains(c)) {
        return Err("Operator names can use letters, numbers, spaces and - _ ' .".into());
    }
    Ok(name)
}

// ---------- Homefront ----------

pub const MAX_TIER: u32 = 4;
/// Highest Homefront tier for an operator that doesn't allow raids.
pub const SAFE_TIER_CAP: u32 = 3;

pub fn tier_cap(raidable: bool) -> u32 { if raidable { MAX_TIER } else { SAFE_TIER_CAP } }

/// What it costs to raise the Homefront to `tier`: cash plus valuables of at
/// least a given rarity, taken from the stash (cheapest first).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TierCost {
    pub tier: u32,
    pub cash: u32,
    pub valuables: u32,
    pub min_rarity: Rarity,
}

pub fn tier_cost(tier: u32) -> Option<TierCost> {
    let (cash, valuables, min_rarity) = match tier {
        2 => (1_500, 2, Rarity::Uncommon),
        3 => (6_000, 3, Rarity::Rare),
        4 => (20_000, 3, Rarity::Epic),
        _ => return None,
    };
    Some(TierCost { tier, cash, valuables, min_rarity })
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Facility {
    /// More stash space.
    Storage,
    /// Better trader stock.
    Armory,
    /// Cheaper insurance.
    Office,
    /// Makes cash between raids.
    Workshop,
}

pub const FACILITIES: [Facility; 4] = [Facility::Storage, Facility::Armory, Facility::Office, Facility::Workshop];

impl Facility {
    pub fn as_str(&self) -> &'static str {
        match self { Facility::Storage => "storage", Facility::Armory => "armory", Facility::Office => "office", Facility::Workshop => "workshop" }
    }
    pub fn parse(s: &str) -> Option<Self> { FACILITIES.into_iter().find(|f| f.as_str() == s) }
    pub fn label(&self) -> &'static str {
        match self { Facility::Storage => "Storage", Facility::Armory => "Armory", Facility::Office => "Insurance Office", Facility::Workshop => "Workshop" }
    }
    fn base_cost(&self) -> u32 {
        match self { Facility::Storage => 400, Facility::Armory => 600, Facility::Office => 500, Facility::Workshop => 800 }
    }
    /// Cash to raise this facility to `level`.
    pub fn cost(&self, level: u32) -> u32 { self.base_cost() * level * level }

    /// What the facility does at `level`, in words.
    #[cfg(test)]
    pub fn effect(&self, level: u32) -> String { self.effect_for(level, false) }

    /// What the facility does at `level` for a Safe or Raidable operator.
    pub fn effect_for(&self, level: u32, raidable: bool) -> String {
        match self {
            Facility::Storage => format!("+{} stash slots", storage_bonus(level)),
            Facility::Armory => match armory_powers(level).last() {
                Some(p) => format!("Sells up to power {p}"),
                None => "Sells up to power 24".into(),
            },
            Facility::Office => format!("Insurance {}% of gear value", (insurance_rate(level, 0) * 100.0).round()),
            Facility::Workshop => if level == 0 { "Idle".into() } else {
                let rate = workshop_rate_for(level, raidable);
                if raidable { format!("${rate}/hr (+15% Raidable), holds {WORKSHOP_HOURS}h") }
                else { format!("${rate}/hr, holds {WORKSHOP_HOURS}h") }
            },
        }
    }
}

pub fn storage_bonus(level: u32) -> u32 { level * 10 }

/// Extra trader powers the Armory unlocks. They stay below the Quarantine
/// Zone's gate so the trader can never skip raiding for gear.
pub fn armory_powers(level: u32) -> &'static [u32] {
    const ALL: [u32; 4] = [28, 32, 35, 38];
    &ALL[..(level as usize).min(ALL.len())]
}

pub const BASE_INSURANCE_RATE: f64 = 0.35;
pub const MIN_INSURANCE_RATE: f64 = 0.15;

/// Share of the loadout's value insurance costs, after the Office and the Broker perk.
pub fn insurance_rate(office: u32, broker: u32) -> f64 {
    (BASE_INSURANCE_RATE - 0.04 * office as f64 - 0.03 * broker as f64).max(MIN_INSURANCE_RATE)
}

pub const WORKSHOP_HOURS: u32 = 48;
/// Extra Workshop income rate for Raidable operators (+15% risk dividend).
pub const RAIDABLE_WORKSHOP_BONUS: f64 = 0.15;
pub const RESPEC_COST: u32 = 1_000;
/// Earn one selected piece of gear after this much extracted activity on a map.
pub const REQUISITION_COST: u32 = 120;

/// Cash per hour the Workshop makes at `level`.
pub fn workshop_rate(level: u32) -> u32 { 60 * level }

/// Cash per hour the Workshop makes for a Safe or Raidable operator.
pub fn workshop_rate_for(level: u32, raidable: bool) -> u32 {
    if raidable { (workshop_rate(level) as f64 * (1.0 + RAIDABLE_WORKSHOP_BONUS)).round() as u32 }
    else { workshop_rate(level) }
}

/// Cash waiting in the Workshop after `secs` since the last collection.
#[cfg(test)]
pub fn workshop_stored(level: u32, secs: i64) -> u32 { workshop_stored_for(level, false, secs) }

pub fn workshop_stored_for(level: u32, raidable: bool, secs: i64) -> u32 {
    let hours = (secs.max(0) as f64 / 3600.0).min(WORKSHOP_HOURS as f64);
    (hours * workshop_rate_for(level, raidable) as f64).floor() as u32
}

// ---------- Operations ----------

/// XP needed for each Operations rank on a map.
pub const OPS_THRESHOLDS: [u32; 5] = [150, 500, 1_200, 2_500, 5_000];
pub const MAX_OPS_RANK: u32 = OPS_THRESHOLDS.len() as u32;

pub fn ops_rank(xp: u32) -> u32 { OPS_THRESHOLDS.iter().filter(|&&t| xp >= t).count() as u32 }

/// XP to the next rank, or None at the top.
pub fn ops_next(xp: u32) -> Option<u32> { OPS_THRESHOLDS.iter().copied().find(|&t| xp < t) }

/// Operations XP for one raid: extracting is worth far more than dying.
pub fn activity_points(kills: u32, activity: &crate::types::RaidActivity) -> u32 {
    kills.saturating_add(activity.assists).min(100)
        + activity.crates.min(10) * 8 + activity.revives.min(3) * 5
}

pub fn ops_xp_for(extracted: bool, kills: u32, activity: &crate::types::RaidActivity, boost_level: u32) -> u32 {
    let earned = activity_points(kills, activity);
    let base = earned + if extracted { earned.min(100) } else { 0 };
    (base as f64 * (1.0 + 0.10 * boost_level as f64)).round() as u32
}

#[cfg(test)]
pub fn ops_xp(extracted: bool, kills: u32, boost_level: u32) -> u32 {
    ops_xp_for(extracted, kills, &crate::types::RaidActivity::default(), boost_level)
}

/// Entry fee after an Operations rank discount (10% per rank).
pub fn ops_fee(map: &MapDef, rank: u32) -> u32 {
    (map.entry_fee as f64 * (1.0 - 0.10 * rank.min(MAX_OPS_RANK) as f64)).round() as u32
}

pub fn ops_bounty_bonus(rank: u32) -> f64 { 0.04 * rank.min(MAX_OPS_RANK) as f64 }

// ---------- Seasons ----------

pub const RELOCATION_WINDOW_DAYS: i64 = 28;
/// Homefront tier an operator needs before it can relocate.
pub const RELOCATION_MIN_TIER: u32 = 3;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    /// e.g. "2026-Q4".
    pub id: String,
    pub name: String,
    pub starts_at: i64,
    pub ends_at: i64,
    pub relocation_opens_at: i64,
}

impl Season {
    pub fn relocation_open(&self, now: i64) -> bool { now >= self.relocation_opens_at && now < self.ends_at }
}

/// Days since 1970-01-01 for a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month) for a day count since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + (m <= 2) as i64, m)
}

/// The season (calendar quarter, UTC) that contains `now` (unix seconds).
pub fn season_at(now: i64) -> Season {
    let (year, month) = civil_from_days(now.div_euclid(86_400));
    let quarter = (month - 1) / 3;
    let starts_at = days_from_civil(year, quarter * 3 + 1, 1) * 86_400;
    let (ny, nq) = if quarter == 3 { (year + 1, 0) } else { (year, quarter + 1) };
    let ends_at = days_from_civil(ny, nq * 3 + 1, 1) * 86_400;
    Season {
        id: format!("{year}-Q{}", quarter + 1),
        name: format!("Season {year} Q{}", quarter + 1),
        starts_at, ends_at,
        relocation_opens_at: ends_at - RELOCATION_WINDOW_DAYS * 86_400,
    }
}

/// The season after the one containing `now`.
pub fn next_season(now: i64) -> Season { season_at(season_at(now).ends_at) }

// ---------- Relocation and Legacy ----------

/// Most Legacy points an account can ever earn.
pub const LEGACY_CAP: u32 = 12;
/// Most stash slots relocations can ever add.
pub const STASH_BONUS_CAP: u32 = 20;
pub const STASH_BONUS_PER_RELOCATION: u32 = 5;
/// Highest head-start boost level from relocating in back-to-back seasons.
pub const MAX_BOOST: u32 = 3;

/// Legacy points a relocation earns for an operator worth `value` (cash plus
/// what everything it owns would sell for).
pub fn legacy_points_for(value: u32) -> u32 {
    match value { 0..=4_999 => 0, 5_000..=19_999 => 1, 20_000..=49_999 => 2, _ => 3 }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelocationReward {
    pub value: u32,
    pub legacy_points: u32,
    pub stash_slots: u32,
    pub boost_level: u32,
}

/// What relocating would earn, given the account's Legacy so far.
/// `streak` is true when the account also relocated last season.
pub fn relocation_reward(value: u32, legacy_earned: u32, stash_bonus: u32, prev_boost: u32, streak: bool) -> RelocationReward {
    RelocationReward {
        value,
        legacy_points: legacy_points_for(value).min(LEGACY_CAP.saturating_sub(legacy_earned)),
        stash_slots: STASH_BONUS_PER_RELOCATION.min(STASH_BONUS_CAP.saturating_sub(stash_bonus)),
        boost_level: if streak { (prev_boost + 1).min(MAX_BOOST) } else { 1 },
    }
}

/// Bounty multiplier from the season's head-start boost.
pub fn boost_bounty_bonus(level: u32) -> f64 { 0.05 * level.min(MAX_BOOST) as f64 }

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Perk {
    /// More max health.
    Vitality,
    /// More weapon damage.
    Firepower,
    /// Bigger bounties.
    Scavenger,
    /// More stash space.
    Packrat,
    /// Cheaper insurance.
    Broker,
}

pub const PERKS: [Perk; 5] = [Perk::Vitality, Perk::Firepower, Perk::Scavenger, Perk::Packrat, Perk::Broker];
pub const PERK_MAX_RANK: u32 = 3;

impl Perk {
    pub fn as_str(&self) -> &'static str {
        match self { Perk::Vitality => "vitality", Perk::Firepower => "firepower", Perk::Scavenger => "scavenger", Perk::Packrat => "packrat", Perk::Broker => "broker" }
    }
    pub fn parse(s: &str) -> Option<Self> { PERKS.into_iter().find(|p| p.as_str() == s) }
    pub fn label(&self) -> &'static str {
        match self { Perk::Vitality => "Vitality", Perk::Firepower => "Firepower", Perk::Scavenger => "Scavenger", Perk::Packrat => "Packrat", Perk::Broker => "Broker" }
    }
    pub fn per_rank(&self) -> &'static str {
        match self {
            Perk::Vitality => "+6 max health",
            Perk::Firepower => "+3% weapon damage",
            Perk::Scavenger => "+5% bounty",
            Perk::Packrat => "+5 stash slots",
            Perk::Broker => "Insurance 3% cheaper",
        }
    }
}

/// An account's perk ranks, applied to every operator it owns.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Perks {
    pub vitality: u32,
    pub firepower: u32,
    pub scavenger: u32,
    pub packrat: u32,
    pub broker: u32,
}

impl Perks {
    pub fn get(&self, perk: Perk) -> u32 {
        match perk { Perk::Vitality => self.vitality, Perk::Firepower => self.firepower, Perk::Scavenger => self.scavenger, Perk::Packrat => self.packrat, Perk::Broker => self.broker }
    }
    pub fn set(&mut self, perk: Perk, rank: u32) {
        let r = rank.min(PERK_MAX_RANK);
        match perk { Perk::Vitality => self.vitality = r, Perk::Firepower => self.firepower = r, Perk::Scavenger => self.scavenger = r, Perk::Packrat => self.packrat = r, Perk::Broker => self.broker = r }
    }
    pub fn spent(&self) -> u32 { PERKS.iter().map(|&p| self.get(p)).sum() }
    pub fn health_bonus(&self) -> f64 { 6.0 * self.vitality as f64 }
    pub fn damage_mult(&self) -> f64 { 1.0 + 0.03 * self.firepower as f64 }
    pub fn bounty_bonus(&self) -> f64 { 0.05 * self.scavenger as f64 }
    pub fn stash_bonus(&self) -> u32 { 5 * self.packrat }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gear;

    #[test]
    fn seasons_are_calendar_quarters() {
        // 2026-11-09 12:00 UTC.
        let now = 1_794_225_600;
        let s = season_at(now);
        assert_eq!(s.id, "2026-Q4");
        assert_eq!(s.starts_at, days_from_civil(2026, 10, 1) * 86_400);
        assert_eq!(s.ends_at, days_from_civil(2027, 1, 1) * 86_400);
        assert!(!s.relocation_open(now), "early November is before the window");
        assert!(s.relocation_open(days_from_civil(2026, 12, 20) * 86_400));
        assert!(!s.relocation_open(s.ends_at), "the window closes when the season ends");
        assert_eq!(next_season(now).id, "2027-Q1");
        assert_eq!(season_at(s.ends_at - 1).id, "2026-Q4");
        assert_eq!(season_at(days_from_civil(2028, 2, 29) * 86_400).id, "2028-Q1");
    }

    #[test]
    fn civil_dates_round_trip() {
        for (y, m) in [(1970, 1), (2000, 2), (2026, 11), (2027, 12), (2100, 3)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, 15)), (y, m));
        }
    }

    #[test]
    fn safe_operators_stop_at_the_safe_tier() {
        assert_eq!(tier_cap(false), SAFE_TIER_CAP);
        assert_eq!(tier_cap(true), MAX_TIER);
        assert!(SAFE_TIER_CAP >= RELOCATION_MIN_TIER, "safe operators can still relocate");
        assert!((2..=MAX_TIER).all(|t| tier_cost(t).is_some()));
        assert!(tier_cost(1).is_none() && tier_cost(MAX_TIER + 1).is_none());
        assert!((3..=MAX_TIER).all(|t| tier_cost(t).unwrap().cash > tier_cost(t - 1).unwrap().cash));
    }

    #[test]
    fn the_armory_never_sells_past_the_quarantine_gate() {
        for level in 0..=MAX_TIER {
            assert!(armory_powers(level).iter().all(|&p| p < gear::MAPS[2].min_gear_score));
        }
        assert_eq!(armory_powers(0).len(), 0);
        assert_eq!(armory_powers(MAX_TIER).len(), MAX_TIER as usize);
    }

    #[test]
    fn insurance_never_drops_below_the_floor() {
        assert_eq!(insurance_rate(0, 0), BASE_INSURANCE_RATE);
        assert!(insurance_rate(1, 0) < insurance_rate(0, 0));
        assert_eq!(insurance_rate(MAX_TIER, PERK_MAX_RANK), MIN_INSURANCE_RATE);
    }

    #[test]
    fn the_workshop_fills_up_and_stops() {
        assert_eq!(workshop_stored(0, 100_000), 0);
        assert_eq!(workshop_stored(2, 3600), 120);
        assert_eq!(workshop_stored(2, 3600 * 100), 120 * WORKSHOP_HOURS);
        assert_eq!(workshop_stored(2, -50), 0);
    }

    #[test]
    fn operations_ranks_cut_fees_and_raise_bounties() {
        assert_eq!(ops_rank(0), 0);
        assert_eq!(ops_rank(150), 1);
        assert_eq!(ops_rank(1_000_000), MAX_OPS_RANK);
        assert_eq!(ops_next(0), Some(150));
        assert_eq!(ops_next(5_000), None);
        let bs = &gear::MAPS[3];
        assert_eq!(ops_fee(bs, 0), bs.entry_fee);
        assert_eq!(ops_fee(bs, MAX_OPS_RANK), bs.entry_fee / 2);
        assert_eq!(ops_xp(true, 0, 0), 0);
        assert_eq!(ops_xp(false, 0, 0), 0);
        assert!(ops_xp(true, 10, 2) > ops_xp(true, 10, 0));
        assert_eq!(ops_xp(false, 10_000, 0), 100, "kills are capped");
    }

    #[test]
    fn legacy_rewards_are_capped() {
        let r = relocation_reward(100_000, 0, 0, 0, false);
        assert_eq!((r.legacy_points, r.stash_slots, r.boost_level), (3, STASH_BONUS_PER_RELOCATION, 1));
        let r = relocation_reward(100_000, LEGACY_CAP - 1, STASH_BONUS_CAP, 3, true);
        assert_eq!((r.legacy_points, r.stash_slots, r.boost_level), (1, 0, MAX_BOOST));
        assert_eq!(relocation_reward(1_000, 0, 0, 0, false).legacy_points, 0);
        assert_eq!(relocation_reward(10_000, 0, 0, 1, true).boost_level, 2);
        // Even fully specced, perks can't take every rank.
        assert!(LEGACY_CAP < PERKS.len() as u32 * PERK_MAX_RANK);
    }

    #[test]
    fn perks_round_trip_and_cap() {
        let mut p = Perks::default();
        for perk in PERKS { assert_eq!(Perk::parse(perk.as_str()), Some(perk)); p.set(perk, 9); }
        assert_eq!(p.spent(), PERKS.len() as u32 * PERK_MAX_RANK);
        assert_eq!(p.damage_mult(), 1.09);
        for f in FACILITIES { assert_eq!(Facility::parse(f.as_str()), Some(f)); }
    }

    #[test]
    fn operator_names_are_cleaned() {
        assert_eq!(clean_operator_name("  Ghost  ", 1).unwrap(), "Ghost");
        assert_eq!(clean_operator_name("", 2).unwrap(), "Operator 2");
        assert_eq!(clean_operator_name(&"x".repeat(40), 1).unwrap().len(), OPERATOR_NAME_MAX);
        assert!(clean_operator_name("<script>", 1).is_err());
    }
}
