//! Gear, loot and the raid maps they unlock.
//!
//! Every piece of gear has a **power** from 1 to 100 and a rarity. A player's
//! **gear score** is the average power of their four loadout slots (an empty
//! slot counts as 0). Each map requires a minimum gear score, has tougher
//! enemies than the one before it, and drops loot in a higher power band, so
//! extracting from one map is how you gear up for the next.

use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::types::{Weapon, ZombieType};

// ---------- Items ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Pistol,
    Uzi,
    Shotgun,
    RocketLauncher,
    Armor,
    Pack,
    /// Salvage with no use except its sale price.
    Valuable,
    /// Sealed loot: what's inside is only known once it's decrypted at an
    /// uplink during a raid. Worth scrap until then.
    Encrypted,
}

pub const GEAR_KINDS: [ItemKind; 6] = [
    ItemKind::Pistol, ItemKind::Uzi, ItemKind::Shotgun, ItemKind::RocketLauncher, ItemKind::Armor, ItemKind::Pack,
];

impl ItemKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemKind::Pistol => "pistol",
            ItemKind::Uzi => "uzi",
            ItemKind::Shotgun => "shotgun",
            ItemKind::RocketLauncher => "rocketLauncher",
            ItemKind::Armor => "armor",
            ItemKind::Pack => "pack",
            ItemKind::Valuable => "valuable",
            ItemKind::Encrypted => "encrypted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [ItemKind::Pistol, ItemKind::Uzi, ItemKind::Shotgun, ItemKind::RocketLauncher, ItemKind::Armor, ItemKind::Pack, ItemKind::Valuable, ItemKind::Encrypted]
            .into_iter().find(|k| k.as_str() == s)
    }

    pub fn label(&self) -> &'static str {
        match self {
            ItemKind::Pistol => "Pistol",
            ItemKind::Uzi => "Uzi",
            ItemKind::Shotgun => "Shotgun",
            ItemKind::RocketLauncher => "Rocket Launcher",
            ItemKind::Armor => "Armor",
            ItemKind::Pack => "Pack",
            ItemKind::Valuable => "Valuable",
            ItemKind::Encrypted => "Encrypted",
        }
    }

    /// Weapons, armor and packs: things you can equip.
    pub fn is_gear(&self) -> bool { GEAR_KINDS.contains(self) }

    pub fn weapon(&self) -> Option<Weapon> {
        match self {
            ItemKind::Pistol => Some(Weapon::Pistol),
            ItemKind::Uzi => Some(Weapon::Uzi),
            ItemKind::Shotgun => Some(Weapon::Shotgun),
            ItemKind::RocketLauncher => Some(Weapon::RocketLauncher),
            _ => None,
        }
    }

    /// Whether an item of this kind can be equipped in `slot`.
    pub fn fits(&self, slot: Slot) -> bool {
        match slot {
            Slot::Primary | Slot::Secondary => self.weapon().is_some(),
            Slot::Armor => *self == ItemKind::Armor,
            Slot::Pack => *self == ItemKind::Pack,
        }
    }

    fn base_value(&self) -> f64 {
        match self {
            ItemKind::Pistol => 30.0,
            ItemKind::Uzi => 45.0,
            ItemKind::Shotgun => 50.0,
            ItemKind::RocketLauncher => 65.0,
            ItemKind::Armor => 45.0,
            ItemKind::Pack => 40.0,
            ItemKind::Valuable => 70.0,
            ItemKind::Encrypted => 20.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Rarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
}

pub const RARITIES: [Rarity; 5] = [Rarity::Common, Rarity::Uncommon, Rarity::Rare, Rarity::Epic, Rarity::Legendary];

impl Rarity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Rarity::Common => "common",
            Rarity::Uncommon => "uncommon",
            Rarity::Rare => "rare",
            Rarity::Epic => "epic",
            Rarity::Legendary => "legendary",
        }
    }

    pub fn parse(s: &str) -> Option<Self> { RARITIES.into_iter().find(|r| r.as_str() == s) }

    pub fn label(&self) -> &'static str {
        match self {
            Rarity::Common => "Common",
            Rarity::Uncommon => "Uncommon",
            Rarity::Rare => "Rare",
            Rarity::Epic => "Epic",
            Rarity::Legendary => "Legendary",
        }
    }

    /// Power added on top of the map's roll.
    fn power_bonus(&self) -> u32 {
        match self { Rarity::Common => 0, Rarity::Uncommon => 3, Rarity::Rare => 6, Rarity::Epic => 10, Rarity::Legendary => 15 }
    }

    fn value_mult(&self) -> f64 {
        match self { Rarity::Common => 1.0, Rarity::Uncommon => 1.6, Rarity::Rare => 2.6, Rarity::Epic => 4.5, Rarity::Legendary => 8.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub rarity: Rarity,
    pub power: u32,
    pub name: String,
    /// What the trader pays for it.
    pub value: u32,
}

pub const MAX_POWER: u32 = 100;

impl Item {
    pub fn new(kind: ItemKind, rarity: Rarity, power: u32, name: Option<String>) -> Self {
        let power = power.clamp(1, MAX_POWER);
        let name = name.unwrap_or_else(|| default_name(kind, power));
        Self { id: uuid::Uuid::new_v4().to_string(), kind, rarity, power, value: sell_value(kind, rarity, power), name }
    }

    #[cfg(test)]
    pub fn is_gear(&self) -> bool { self.kind.is_gear() }
}

/// A model name for gear, by kind and how strong it is. Rarity is shown
/// separately, so names never repeat (or contradict) it.
pub fn default_name(kind: ItemKind, power: u32) -> String {
    let names: [&str; 4] = match kind {
        ItemKind::Pistol => ["Snub Revolver", "Field Pistol", "Tactical Pistol", "Hand Cannon"],
        ItemKind::Uzi => ["Street SMG", "Compact SMG", "Vector SMG", "Reaper SMG"],
        ItemKind::Shotgun => ["Sawn-off", "Pump Shotgun", "Combat Shotgun", "Breacher"],
        ItemKind::RocketLauncher => ["Tube Launcher", "Field RPG", "Twin Launcher", "Hellfire Launcher"],
        ItemKind::Armor => ["Quilted Vest", "Kevlar Vest", "Plate Carrier", "Juggernaut Rig"],
        ItemKind::Pack => ["Sling Bag", "Hiking Pack", "Assault Pack", "Mule Rig"],
        ItemKind::Valuable => return "Salvage".into(),
        ItemKind::Encrypted => return "Sealed Case".into(),
    };
    names[match power { 0..=15 => 0, 16..=35 => 1, 36..=60 => 2, _ => 3 }].to_string()
}

/// Trader sale price. Valuables are worth more than gear of the same power.
pub fn sell_value(kind: ItemKind, rarity: Rarity, power: u32) -> u32 {
    (kind.base_value() * (1.0 + power as f64 / 15.0) * rarity.value_mult()).round() as u32
}

// ---------- Item effects in a raid ----------

/// Gun damage multiplier for a weapon of this power (1.0 at power 0, 3.0 at 100).
pub fn weapon_damage_mult(power: u32) -> f64 { 1.0 + power as f64 / 50.0 }

/// The loaner pistol (power 0) hits 20% softer than any real gun.
pub const LOANER_DAMAGE: f64 = 0.8;

/// Damage multiplier for a gun carried into a raid (power 0 is the loaner).
pub fn raid_damage_mult(power: u32) -> f64 { if power == 0 { LOANER_DAMAGE } else { weapon_damage_mult(power) } }

/// Max health with armor of this power (no armor = 100).
pub fn armor_max_health(power: u32) -> f64 { 100.0 + power as f64 * 2.0 }

/// Backpack slots for loot carried out of a raid.
pub fn pack_capacity(power: u32) -> u32 { 4 + power / 12 }

/// Shared ammo reserve for non-pistol guns.
pub fn pack_max_ammo(power: u32) -> f64 { 60.0 + 2.0 * power as f64 }

/// Deploying without a pack: two loot slots, a small ammo pouch, one barricade.
pub const NO_PACK_CAPACITY: u32 = 2;
pub const NO_PACK_AMMO: f64 = 40.0;
pub const NO_PACK_TACTICAL: [u32; 3] = [0, 1, 0];

/// Barrels, barricades and claymores you deploy with.
pub fn pack_tactical(power: u32) -> [u32; 3] { [1 + power / 35, 1 + power / 35, power / 45] }

/// Katana damage multiplier from overall gear score.
pub fn melee_mult(gear_score: u32) -> f64 { 1.0 + gear_score as f64 / 90.0 }

/// Which pack slot a new item would replace when the pack is full, if any.
/// Gear competes only with gear (lowest power goes, if the new item is more
/// powerful); valuables and encrypted loot compete with each other by what
/// they're worth (an encrypted item by what it should decrypt into).
pub fn swap_target(pack: &[Item], incoming: &Item) -> Option<usize> {
    let gear = incoming.kind.is_gear();
    let score = |i: &Item| if gear { i.power } else { pack_worth(i) };
    let (idx, low) = pack.iter().enumerate()
        .filter(|(_, i)| i.kind.is_gear() == gear)
        .min_by_key(|(_, i)| score(i))?;
    (score(incoming) > score(low)).then_some(idx)
}

/// What a non-gear item is worth for pack decisions.
pub fn pack_worth(item: &Item) -> u32 {
    if item.kind == ItemKind::Encrypted { estimated_value(item) } else { item.value }
}

// ---------- Encrypted loot ----------

const ENCRYPTED_NAMES: [&str; 4] = ["Encrypted Drive", "Sealed Case", "Locked Cache", "Coded Lockbox"];

/// Seconds standing at an uplink to decrypt one item; rarer signals take longer.
pub fn decrypt_secs(rarity: Rarity) -> f64 {
    match rarity { Rarity::Common => 4.0, Rarity::Uncommon => 6.0, Rarity::Rare => 8.0, Rarity::Epic => 11.0, Rarity::Legendary => 15.0 }
}

/// Chance a piece of raid loot comes sealed. Most of the good stuff does, and
/// more of it on harder maps.
pub fn encrypt_chance(tier: u32, rarity: Rarity) -> f64 {
    let by_rarity = match rarity { Rarity::Common => 0.0, Rarity::Uncommon => 0.05, Rarity::Rare => 0.15, Rarity::Epic => 0.3, Rarity::Legendary => 0.45 };
    (0.25 + 0.08 * (tier.max(1) - 1) as f64 + by_rarity).min(0.9)
}

/// Roughly what an encrypted item decrypts into, for the trader-free estimate shown to players.
pub fn estimated_value(item: &Item) -> u32 {
    (sell_value(ItemKind::Valuable, item.rarity, item.power) as f64 * 0.8).round() as u32
}

/// Seal an item: its rarity (signal strength) and power stay visible, its kind doesn't.
pub fn seal(rng: &mut impl Rng, item: &Item) -> Item {
    let name = ENCRYPTED_NAMES[rng.random_range(0..ENCRYPTED_NAMES.len())];
    Item::new(ItemKind::Encrypted, item.rarity, item.power, Some(name.to_string()))
}

/// Seal raid loot with the map's odds.
pub fn maybe_seal(rng: &mut impl Rng, tier: u32, item: Item) -> Item {
    if item.kind != ItemKind::Encrypted && rng.random::<f64>() < encrypt_chance(tier, item.rarity) { seal(rng, &item) } else { item }
}

fn next_rarity(r: Rarity) -> Rarity {
    match r { Rarity::Common => Rarity::Uncommon, Rarity::Uncommon => Rarity::Rare, Rarity::Rare => Rarity::Epic, _ => Rarity::Legendary }
}

/// Open an encrypted item: gear (60%) or a valuable, same signal and power,
/// with a one-in-five chance the contents are a grade better.
pub fn decrypt(rng: &mut impl Rng, item: &Item) -> Item {
    let rarity = if rng.random::<f64>() < 0.2 { next_rarity(item.rarity) } else { item.rarity };
    let power = item.power + rarity.power_bonus() - item.rarity.power_bonus();
    if rng.random::<f64>() < 0.6 {
        let kind = GEAR_KINDS[rng.random_range(0..GEAR_KINDS.len())];
        Item::new(kind, rarity, power, None)
    } else {
        let name = VALUABLE_NAMES[rng.random_range(0..VALUABLE_NAMES.len())];
        Item::new(ItemKind::Valuable, rarity, power, Some(name.to_string()))
    }
}

// ---------- Loadout ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Slot { Primary, Secondary, Armor, Pack }

pub const SLOTS: [Slot; 4] = [Slot::Primary, Slot::Secondary, Slot::Armor, Slot::Pack];

impl Slot {
    pub fn as_str(&self) -> &'static str {
        match self { Slot::Primary => "primary", Slot::Secondary => "secondary", Slot::Armor => "armor", Slot::Pack => "pack" }
    }
    pub fn parse(s: &str) -> Option<Self> { SLOTS.into_iter().find(|slot| slot.as_str() == s) }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loadout {
    pub primary: Option<Item>,
    pub secondary: Option<Item>,
    pub armor: Option<Item>,
    pub pack: Option<Item>,
    /// Account and Homefront bonuses applied in the raid. Never sent to clients.
    #[serde(skip)]
    pub boost: RaidBoost,
}

/// Bonuses an operator brings into a raid on top of its gear.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RaidBoost {
    pub max_health: f64,
    /// Added to the weapon damage multiplier (0.06 = +6%).
    pub damage: f64,
}

impl Loadout {
    pub fn get(&self, slot: Slot) -> Option<&Item> {
        match slot { Slot::Primary => self.primary.as_ref(), Slot::Secondary => self.secondary.as_ref(), Slot::Armor => self.armor.as_ref(), Slot::Pack => self.pack.as_ref() }
    }
    pub fn set(&mut self, slot: Slot, item: Option<Item>) {
        match slot { Slot::Primary => self.primary = item, Slot::Secondary => self.secondary = item, Slot::Armor => self.armor = item, Slot::Pack => self.pack = item }
    }
    pub fn gear_score(&self) -> u32 { gear_score(&SLOTS.map(|s| self.get(s).map(|i| i.power))) }
}

/// Average power of the four loadout slots, rounded down. Empty slots count as 0.
pub fn gear_score(powers: &[Option<u32>; 4]) -> u32 {
    powers.iter().map(|p| p.unwrap_or(0)).sum::<u32>() / 4
}

/// The free sidearm you deploy with when no weapon is equipped. It is never lost.
pub fn loaner_pistol() -> Item {
    Item { id: "loaner".into(), kind: ItemKind::Pistol, rarity: Rarity::Common, power: 0, name: "Loaner Pistol".into(), value: 0 }
}

/// What a brand new operator owns: enough to raid the first map.
pub fn starter_kit() -> Vec<(Item, Option<Slot>)> {
    vec![
        (Item::new(ItemKind::Pistol, Rarity::Common, 6, Some("Service Pistol".into())), Some(Slot::Primary)),
        (Item::new(ItemKind::Armor, Rarity::Common, 4, Some("Padded Vest".into())), Some(Slot::Armor)),
        (Item::new(ItemKind::Pack, Rarity::Common, 4, Some("Canvas Satchel".into())), Some(Slot::Pack)),
    ]
}

pub const STARTING_CASH: u32 = 400;

/// Insuring a loadout costs this share of its sale value. If the raid is lost,
/// the insured loadout comes back (the pack, bounty and entry fee don't).
pub const INSURANCE_RATE: f64 = crate::progression::BASE_INSURANCE_RATE;

#[cfg(test)]
pub fn insurance_cost(loadout: &Loadout) -> u32 { insurance_cost_at(loadout, INSURANCE_RATE) }

/// Insurance at a given rate (the Insurance Office and Broker perk lower it).
pub fn insurance_cost_at(loadout: &Loadout, rate: f64) -> u32 {
    (SLOTS.iter().filter_map(|s| loadout.get(*s)).map(|i| i.value as f64).sum::<f64>() * rate).ceil() as u32
}
/// Items kept in the stash, not counting equipped gear.
pub const STASH_CAPACITY: usize = 40;

// ---------- Maps ----------

#[derive(Debug)]
pub struct MapDef {
    pub id: &'static str,
    pub name: &'static str,
    pub tier: u32,
    pub min_gear_score: u32,
    pub blurb: &'static str,
    /// Blocks across and down; each city block is 640 units square.
    pub blocks: (u32, u32),
    pub seed: u64,
    /// Loot power band before rarity bonuses.
    pub loot_power: (u32, u32),
    pub enemy_health: f64,
    pub enemy_damage: f64,
    pub enemy_speed: f64,
    /// Chance (0–1) per enemy of being an elite: bigger, tougher, better loot.
    pub elite_chance: f64,
    pub max_enemies_base: usize,
    pub max_enemies_per_player: usize,
    /// Seconds between spawns with one player in the map.
    pub spawn_interval: f64,
    pub raid_secs: f64,
    /// Relative spawn weights: zombie, crawler, devil, brute, vampire.
    pub spawn_weights: [f64; 5],
    /// Extra cash per kill banked on extraction, as a multiplier.
    pub bounty_mult: f64,
    /// Cash charged to deploy (paid even if you die).
    pub entry_fee: u32,
}

pub const BLOCK_SIZE: f64 = 640.0;
pub const MAP_MARGIN: f64 = 80.0;

impl MapDef {
    pub fn width(&self) -> f64 { MAP_MARGIN * 2.0 + self.blocks.0 as f64 * BLOCK_SIZE }
    pub fn height(&self) -> f64 { MAP_MARGIN * 2.0 + self.blocks.1 as f64 * BLOCK_SIZE }
    pub fn threat(&self) -> &'static str {
        match self.tier { 1 => "Low", 2 => "Moderate", 3 => "High", _ => "Extreme" }
    }
}

pub static MAPS: [MapDef; 4] = [
    MapDef {
        id: "outskirts", name: "Outskirts", tier: 1, min_gear_score: 0,
        blurb: "Abandoned suburbs on the edge of the quarantine. Walkers, crawlers and the odd devil; light loot.",
        blocks: (7, 6), seed: 0x0B0C_5EED_0001, loot_power: (2, 16),
        enemy_health: 1.0, enemy_damage: 1.0, enemy_speed: 1.0, elite_chance: 0.0,
        max_enemies_base: 26, max_enemies_per_player: 8, spawn_interval: 0.9, raid_secs: 10.0 * 60.0,
        spawn_weights: [70.0, 22.0, 8.0, 0.0, 0.0], bounty_mult: 1.0, entry_fee: 0,
    },
    MapDef {
        id: "rustyard", name: "Rust Yard", tier: 2, min_gear_score: 20,
        blurb: "A collapsed industrial port. Devils hunt in packs and the first brutes appear.",
        blocks: (8, 6), seed: 0x0B0C_5EED_0002, loot_power: (14, 34),
        enemy_health: 1.5, enemy_damage: 1.35, enemy_speed: 1.12, elite_chance: 0.03,
        max_enemies_base: 32, max_enemies_per_player: 9, spawn_interval: 0.85, raid_secs: 11.0 * 60.0,
        spawn_weights: [48.0, 20.0, 22.0, 10.0, 0.0], bounty_mult: 1.6, entry_fee: 150,
    },
    MapDef {
        id: "quarantine", name: "Quarantine Zone", tier: 3, min_gear_score: 40,
        blurb: "The hot zone behind the wall. Brutes, vampires and elite packs guard valuable caches.",
        blocks: (9, 6), seed: 0x0B0C_5EED_0003, loot_power: (32, 59),
        enemy_health: 2.1, enemy_damage: 1.8, enemy_speed: 1.3, elite_chance: 0.06,
        max_enemies_base: 38, max_enemies_per_player: 10, spawn_interval: 0.8, raid_secs: 12.0 * 60.0,
        spawn_weights: [34.0, 18.0, 22.0, 16.0, 10.0], bounty_mult: 2.4, entry_fee: 600,
    },
    MapDef {
        id: "blacksite", name: "Black Site", tier: 4, min_gear_score: 65,
        blurb: "The lab where it started. Elite hordes, relentless vampires and the best gear in the zone.",
        blocks: (10, 7), seed: 0x0B0C_5EED_0004, loot_power: (55, 88),
        enemy_health: 2.8, enemy_damage: 2.3, enemy_speed: 1.42, elite_chance: 0.11,
        max_enemies_base: 44, max_enemies_per_player: 11, spawn_interval: 0.75, raid_secs: 13.0 * 60.0,
        spawn_weights: [24.0, 16.0, 22.0, 20.0, 18.0], bounty_mult: 3.4, entry_fee: 2000,
    },
];

pub fn map_by_id(id: &str) -> Option<&'static MapDef> { MAPS.iter().find(|m| m.id == id) }

pub fn default_map() -> &'static MapDef { &MAPS[0] }

/// Maps a player with this gear score may deploy to.
pub fn can_deploy(map: &MapDef, gear_score: u32) -> bool { gear_score >= map.min_gear_score }

// ---------- Loot rolls ----------

fn roll_rarity(rng: &mut impl Rng, tier: u32, luck: f64) -> Rarity {
    // Higher tiers and tougher sources shift the odds toward rare gear.
    let shift = (tier as f64 - 1.0) * 0.6 + luck;
    let weights = [
        (60.0 - shift * 8.0).max(20.0),
        26.0 + shift * 2.0,
        10.0 + shift * 3.0,
        3.5 + shift * 2.0,
        0.5 + shift * 0.9,
    ];
    let total: f64 = weights.iter().sum();
    let mut roll = rng.random::<f64>() * total;
    for (rarity, w) in RARITIES.into_iter().zip(weights) {
        if roll < w { return rarity; }
        roll -= w;
    }
    Rarity::Common
}

fn roll_power(rng: &mut impl Rng, map: &MapDef, rarity: Rarity) -> u32 {
    let (lo, hi) = map.loot_power;
    // Skewed toward the low end: high rolls are rare.
    let u = rng.random::<f64>().powf(1.4);
    (lo as f64 + (hi - lo) as f64 * u).round() as u32 + rarity.power_bonus()
}

const VALUABLE_NAMES: [&str; 12] = [
    "Gold Watch", "Circuit Board", "Med Supplies", "Jewelry Box", "Fuel Cell", "Silver Chain",
    "Lab Notes", "Field Radio", "Vaccine Sample", "Military Intel", "Battery Pack", "Old Coins",
];

/// A random piece of gear from this map.
pub fn roll_gear(rng: &mut impl Rng, map: &MapDef, luck: f64) -> Item {
    let kind = GEAR_KINDS[rng.random_range(0..GEAR_KINDS.len())];
    let rarity = roll_rarity(rng, map.tier, luck);
    Item::new(kind, rarity, roll_power(rng, map, rarity), None)
}

/// A random valuable: no use in a raid, worth cash at the trader.
pub fn roll_valuable(rng: &mut impl Rng, map: &MapDef, luck: f64) -> Item {
    let rarity = roll_rarity(rng, map.tier, luck);
    let name = VALUABLE_NAMES[rng.random_range(0..VALUABLE_NAMES.len())];
    Item::new(ItemKind::Valuable, rarity, roll_power(rng, map, rarity), Some(name.to_string()))
}

/// Contents of a supply crate: one to three items, many of them sealed.
pub fn roll_crate(rng: &mut impl Rng, map: &MapDef) -> Vec<Item> {
    let count = 1 + rng.random_range(0..3) as usize;
    (0..count).map(|_| {
        let item = if rng.random::<f64>() < 0.55 { roll_gear(rng, map, 0.6) } else { roll_valuable(rng, map, 0.3) };
        maybe_seal(rng, map.tier, item)
    }).collect()
}

/// Chance that an enemy drops gear or a valuable when it dies.
pub fn enemy_loot_chance(kind: &ZombieType, elite: bool) -> f64 {
    let base: f64 = match kind {
        ZombieType::Zombie => 0.035,
        ZombieType::Crawler => 0.04,
        ZombieType::Devil => 0.07,
        ZombieType::Vampire => 0.14,
        ZombieType::Brute => 0.2,
        ZombieType::Abomination => 1.0,
    };
    if elite { (base * 4.0).min(0.9) } else { base }
}

// ---------- Trader ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub id: String,
    pub kind: ItemKind,
    pub rarity: Rarity,
    pub power: u32,
    pub name: String,
    pub price: u32,
}

const OFFER_POWERS: [u32; 3] = [8, 16, 24];

/// The trader's base stock: common gear up to power 24, enough for Rust Yard. Anything better comes from raids.
#[cfg(test)]
pub fn trader_offers() -> Vec<Offer> { trader_offers_with(&[]) }

/// The trader's stock plus the extra powers a Homefront Armory unlocks.
pub fn trader_offers_with(extra_powers: &[u32]) -> Vec<Offer> {
    let mut offers = Vec::new();
    for kind in GEAR_KINDS {
        for &power in OFFER_POWERS.iter().chain(extra_powers) {
            offers.push(Offer {
                id: format!("{}-{}", kind.as_str(), power),
                kind, rarity: Rarity::Common, power,
                name: format!("{} {}", trader_grade(power), kind.label()),
                price: sell_value(kind, Rarity::Common, power) * 4,
            });
        }
    }
    offers
}

fn trader_grade(power: u32) -> &'static str {
    match power { 0..=10 => "Surplus", 11..=20 => "Standard", 21..=30 => "Military", _ => "Spec Ops" }
}

pub fn find_offer(id: &str, extra_powers: &[u32]) -> Option<Offer> { trader_offers_with(extra_powers).into_iter().find(|o| o.id == id) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_loot_is_common_and_decrypts_into_real_items() {
        let mut rng = rand::rng();
        let map = &MAPS[2];
        let mut sealed = 0;
        let mut total = 0;
        for _ in 0..400 {
            for item in roll_crate(&mut rng, map) {
                total += 1;
                if item.kind == ItemKind::Encrypted { sealed += 1; }
            }
        }
        assert!(sealed * 3 > total, "a lot of loot is sealed ({sealed}/{total})");
        let box_ = seal(&mut rng, &Item::new(ItemKind::Uzi, Rarity::Epic, 50, None));
        assert!(!box_.kind.is_gear() && !box_.kind.fits(Slot::Primary));
        assert!(box_.value < estimated_value(&box_), "sealed it's scrap; opened it's worth more");
        for _ in 0..50 {
            let open = decrypt(&mut rng, &box_);
            assert_ne!(open.kind, ItemKind::Encrypted);
            assert!(open.rarity >= Rarity::Epic && open.power >= 50);
        }
        assert!(decrypt_secs(Rarity::Legendary) > decrypt_secs(Rarity::Common));
    }

    #[test]
    fn encrypted_loot_competes_with_valuables_not_gear() {
        let mut rng = rand::rng();
        let gun = Item::new(ItemKind::Pistol, Rarity::Common, 5, None);
        let junk = Item::new(ItemKind::Valuable, Rarity::Common, 1, Some("Junk".into()));
        let sealed = seal(&mut rng, &Item::new(ItemKind::Valuable, Rarity::Legendary, 60, None));
        assert_eq!(swap_target(&[gun.clone(), junk], &sealed), Some(1));
        assert_eq!(swap_target(&[gun, sealed.clone()], &Item::new(ItemKind::Uzi, Rarity::Common, 90, None)), Some(0));
    }

    #[test]
    fn gear_score_is_the_floor_of_the_slot_average() {
        assert_eq!(gear_score(&[None, None, None, None]), 0);
        assert_eq!(gear_score(&[Some(6), None, Some(4), Some(4)]), 3);
        assert_eq!(gear_score(&[Some(100), Some(100), Some(100), Some(100)]), 100);
        assert_eq!(gear_score(&[Some(21), Some(20), Some(20), Some(20)]), 20);
    }

    #[test]
    fn the_starter_kit_can_raid_the_first_map_only() {
        let mut loadout = Loadout::default();
        for (item, slot) in starter_kit() { loadout.set(slot.unwrap(), Some(item)); }
        let gs = loadout.gear_score();
        assert!(can_deploy(&MAPS[0], gs));
        assert!(MAPS[1..].iter().all(|m| !can_deploy(m, gs)), "gs {gs} must not unlock later maps");
    }

    #[test]
    fn maps_get_bigger_harder_and_more_rewarding_in_order() {
        for pair in MAPS.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            assert!(b.tier == a.tier + 1);
            assert!(b.min_gear_score > a.min_gear_score);
            assert!(b.width() * b.height() > a.width() * a.height(), "{} must be larger than {}", b.name, a.name);
            assert!(b.enemy_health > a.enemy_health && b.enemy_damage > a.enemy_damage);
            assert!(b.loot_power.0 > a.loot_power.0 && b.loot_power.1 > a.loot_power.1);
            assert!(b.bounty_mult > a.bounty_mult);
        }
        assert!(MAPS[0].width() >= 4000.0, "even the first map is far larger than the old 2400 arena");
    }

    #[test]
    fn each_map_drops_gear_that_unlocks_the_next_but_only_with_luck() {
        // Common loot tops out below the next gate; rare-or-better rolls get you over it.
        for pair in MAPS.windows(2) {
            let (top, gate) = (pair[0].loot_power.1, pair[1].min_gear_score);
            assert!(top < gate, "{}'s common loot already clears {}", pair[0].name, pair[1].name);
            assert!(top + Rarity::Rare.power_bonus() >= gate, "{} loot can't reach {}", pair[0].name, pair[1].name);
        }
    }

    #[test]
    fn the_trader_alone_cant_get_you_past_rust_yard() {
        let best = trader_offers().iter().map(|o| o.power).max().unwrap();
        assert!(best >= MAPS[1].min_gear_score && best < MAPS[2].min_gear_score);
    }

    #[test]
    fn deploying_naked_is_strictly_worse_than_the_starter_kit() {
        assert!(raid_damage_mult(loaner_pistol().power) < raid_damage_mult(6));
        assert!(NO_PACK_CAPACITY < pack_capacity(4));
        assert!(NO_PACK_AMMO < pack_max_ammo(4));
    }

    #[test]
    fn rolled_loot_stays_in_band_and_is_priced() {
        let mut rng = rand::rng();
        for map in &MAPS {
            for _ in 0..500 {
                let item = roll_gear(&mut rng, map, 0.0);
                assert!(item.is_gear());
                assert!(item.power >= map.loot_power.0 && item.power <= (map.loot_power.1 + 15).min(MAX_POWER));
                assert_eq!(item.value, sell_value(item.kind, item.rarity, item.power));
                let v = roll_valuable(&mut rng, map, 0.0);
                assert_eq!(v.kind, ItemKind::Valuable);
                assert!(v.value > 0);
            }
            let contents = roll_crate(&mut rng, map);
            assert!((1..=3).contains(&contents.len()));
        }
    }

    #[test]
    fn higher_tiers_roll_rarer_gear() {
        let mut rng = rand::rng();
        let rare_share = |map: &MapDef, rng: &mut rand::rngs::ThreadRng| {
            (0..4000).filter(|_| roll_rarity(rng, map.tier, 0.0) >= Rarity::Rare).count()
        };
        assert!(rare_share(&MAPS[3], &mut rng) > rare_share(&MAPS[0], &mut rng));
    }

    #[test]
    fn rarity_and_power_raise_value() {
        assert!(sell_value(ItemKind::Uzi, Rarity::Rare, 30) > sell_value(ItemKind::Uzi, Rarity::Common, 30));
        assert!(sell_value(ItemKind::Uzi, Rarity::Common, 60) > sell_value(ItemKind::Uzi, Rarity::Common, 30));
    }

    #[test]
    fn slots_only_accept_matching_items() {
        assert!(ItemKind::Shotgun.fits(Slot::Primary) && ItemKind::Pistol.fits(Slot::Secondary));
        assert!(!ItemKind::Armor.fits(Slot::Primary) && ItemKind::Armor.fits(Slot::Armor));
        assert!(ItemKind::Pack.fits(Slot::Pack) && !ItemKind::Pack.fits(Slot::Armor));
        assert!(SLOTS.iter().all(|&s| !ItemKind::Valuable.fits(s)));
    }

    #[test]
    fn trader_never_sells_past_power_24() {
        let offers = trader_offers();
        assert_eq!(offers.len(), GEAR_KINDS.len() * 3);
        assert!(offers.iter().all(|o| o.power <= 24 && o.rarity == Rarity::Common));
        assert!(offers.iter().all(|o| o.price > sell_value(o.kind, o.rarity, o.power)), "buying costs more than selling");
        assert!(find_offer("shotgun-16", &[]).is_some() && find_offer("shotgun-99", &[]).is_none());
        assert!(find_offer("shotgun-32", &[]).is_none() && find_offer("shotgun-32", &[28, 32]).is_some(), "Armory stock needs the Armory");
    }

    #[test]
    fn a_full_pack_keeps_gear_and_valuables_apart() {
        let armor = Item::new(ItemKind::Armor, Rarity::Common, 38, None);
        let watch = Item::new(ItemKind::Valuable, Rarity::Rare, 30, Some("Gold Watch".into()));
        let pack = vec![armor.clone(), watch.clone()];
        assert!(watch.value > armor.value, "the watch sells for more");
        // A pricier valuable replaces the watch, never the armor.
        let gem = Item::new(ItemKind::Valuable, Rarity::Legendary, 40, Some("Old Coins".into()));
        assert_eq!(swap_target(&pack, &gem), Some(1));
        // Stronger gear replaces the armor; weaker gear replaces nothing.
        assert_eq!(swap_target(&pack, &Item::new(ItemKind::Shotgun, Rarity::Common, 45, None)), Some(0));
        assert_eq!(swap_target(&pack, &Item::new(ItemKind::Shotgun, Rarity::Common, 10, None)), None);
        // With no valuables carried, a valuable has nothing to replace.
        assert_eq!(swap_target(&[armor], &gem), None);
    }

    #[test]
    fn entry_fees_rise_with_the_map() {
        assert_eq!(MAPS[0].entry_fee, 0, "the first map is always free");
        assert!(MAPS.windows(2).all(|w| w[1].entry_fee > w[0].entry_fee));
    }

    #[test]
    fn item_effects_scale_with_power() {
        assert_eq!(armor_max_health(0), 100.0);
        assert_eq!(armor_max_health(100), 300.0);
        assert_eq!(weapon_damage_mult(50), 2.0);
        assert!(pack_capacity(100) > pack_capacity(4));
        assert_eq!(pack_capacity(4), 4);
    }

    #[test]
    fn names_round_trip() {
        for kind in GEAR_KINDS.into_iter().chain([ItemKind::Valuable]) { assert_eq!(ItemKind::parse(kind.as_str()), Some(kind)); }
        for r in RARITIES { assert_eq!(Rarity::parse(r.as_str()), Some(r)); }
        for s in SLOTS { assert_eq!(Slot::parse(s.as_str()), Some(s)); }
    }
}
