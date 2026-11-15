use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Vector2 {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Weapon {
    Pistol,
    Uzi,
    Shotgun,
    RocketLauncher,
}

impl Weapon {
    pub fn damage(&self) -> f64 {
        match self {
            Weapon::Pistol => 18.0,
            Weapon::Uzi => 15.0,
            Weapon::Shotgun => 80.0,
            Weapon::RocketLauncher => 150.0,
        }
    }

    pub fn cooldown(&self) -> f64 {
        match self {
            Weapon::Pistol => crate::map::PISTOL_COOLDOWN,
            Weapon::Uzi => crate::map::UZI_COOLDOWN,
            Weapon::Shotgun => crate::map::SHOTGUN_COOLDOWN,
            Weapon::RocketLauncher => crate::map::ROCKET_COOLDOWN,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DropType {
    Ammo,
    Health,
    Tactical,
    /// Gear or a valuable: goes in your backpack and is kept only if you extract.
    Loot,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaceableType {
    Barrel,
    Barricade,
    Mine,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Placeable {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: PlaceableType,
    pub pos: Vector2,
    pub health: f64,
    #[serde(rename = "maxHealth")]
    pub max_health: f64,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlaceableDelta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<f64>,
}

pub const MELEE_DAMAGE: f64 = 45.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ZombieType {
    Zombie,
    Devil,
    Crawler,
    Brute,
    Vampire,
    /// Boss sent after players who camp in one place. Never spawns at random.
    Abomination,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DamageHit {
    pub source: ZombieType,
    pub enemy_id: String,
    pub damage: f64,
    pub health_after: f64,
    pub distance: f64,
    pub time: f64,
}

/// A gun carried into the raid: its kind and how hard it hits.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RaidWeapon {
    pub kind: Weapon,
    pub power: u32,
    pub rarity: crate::gear::Rarity,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub id: String,
    pub name: String,
    pub pos: Vector2,
    pub angle: f64,
    pub health: f64,
    pub max_health: f64,
    pub ammo: f64,
    pub max_ammo: f64,
    /// The gun in hand.
    pub weapon: Weapon,
    /// Up to two guns (primary, secondary); `active_slot` indexes into this.
    pub weapons: Vec<RaidWeapon>,
    pub active_slot: u32,
    pub combo: u32,
    pub combo_timer: f64,
    pub max_combo: u32,
    pub kills: u32,
    pub tactical_items: [u32; 3],
    /// Cash earned from kills this raid; banked only on extraction.
    pub bounty: f64,
    /// Loot picked up this raid; kept only on extraction.
    pub backpack: Vec<crate::gear::Item>,
    pub backpack_capacity: u32,
    pub gear_score: u32,
    /// Seconds left before the raid ends and you are lost (missing in action).
    pub raid_time: f64,
    /// 0..EXTRACT_TIME while standing in an extraction zone.
    pub extract_progress: f64,
    /// Seconds until a downed player dies (0 while standing).
    pub bleedout: f64,
    /// Seconds spent camping in one spot; at CAMP_LIMIT an Abomination comes for you.
    pub camp: f64,
    /// An Abomination is hunting this player right now.
    pub hunted: bool,
    /// Seconds spent decrypting the first sealed item in the pack (0 when not at an uplink).
    pub decrypt: f64,
    #[serde(default)]
    pub damage_log: Vec<DamageHit>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Zombie {
    pub id: String,
    #[serde(rename = "type")]
    pub zombie_type: ZombieType,
    pub pos: Vector2,
    pub health: f64,
    #[serde(rename = "maxHealth")]
    pub max_health: f64,
    pub speed: f64,
    /// Elites are bigger and tougher and drop better loot.
    #[serde(default)]
    pub elite: bool,
    /// Set on hunters sent after a camper: the player they're hunting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bullet {
    pub id: String,
    pub pos: Vector2,
    pub vel: Vector2,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    pub damage: f64,
    #[serde(default, rename = "isCrit")]
    pub is_crit: bool,
    #[serde(default, rename = "isRocket")]
    pub is_rocket: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AmmoSpawnPoint {
    pub x: f64,
    pub y: f64,
    pub amount: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AmmoPickupState {
    pub id: String,
    pub available: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClientInput {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
    #[serde(rename = "mouseX")]
    pub mouse_x: f64,
    #[serde(rename = "mouseY")]
    pub mouse_y: f64,
    pub shooting: bool,
    pub melee: bool,
    #[serde(rename = "selectWeapon")]
    pub select_weapon: u8,
    #[serde(default)]
    pub dash: bool,
    #[serde(default, rename = "placeItem")]
    pub place_item: u8,
    /// Drop the last item picked up.
    #[serde(default, rename = "dropItem")]
    pub drop_item: bool,
    /// Drop this backpack item (from the inventory screen).
    #[serde(default, rename = "dropId", skip_serializing_if = "Option::is_none")]
    pub drop_id: Option<String>,
    /// Server-side: this input has already been applied once (one-shot actions are spent).
    #[serde(skip)]
    pub consumed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DropPickup {
    pub id: String,
    #[serde(rename = "type")]
    pub drop_type: DropType,
    pub pos: Vector2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<crate::gear::Item>,
}

// --- Network messages ---

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    pub id: String,
    pub name: String,
    pub tier: u32,
    pub min_gear_score: u32,
    pub raid_secs: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InitPayload {
    #[serde(rename = "type")]
    pub msg_type: String, // "init"
    pub id: String,
    pub map: MapInfo,
    pub walls: Vec<crate::map::Wall>,
    pub map_width: f64,
    pub map_height: f64,
    pub ammo_spawn_points: Vec<AmmoSpawnPoint>,
    pub extracts: Vec<crate::map::ExtractPoint>,
    pub crates: Vec<crate::map::Point>,
    pub nests: Vec<crate::map::Point>,
    pub uplinks: Vec<crate::map::ExtractPoint>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotState {
    #[serde(rename = "type")]
    pub msg_type: String, // "snapshot"
    pub tick: u64,
    pub players: HashMap<String, Player>,
    pub zombies: Vec<Zombie>,
    pub bullets: Vec<Bullet>,
    pub placeables: Vec<Placeable>,
    pub ammo_pickups: Vec<AmmoPickupState>,
    /// Which supply crates are stocked (`crate_N` ids, in init order).
    pub crates: Vec<AmmoPickupState>,
    pub drops: Vec<DropPickup>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerDelta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<Vector2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_health: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ammo: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_ammo: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weapon: Option<Weapon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weapons: Option<Vec<RaidWeapon>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_slot: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub combo: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub combo_timer: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_combo: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kills: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tactical_items: Option<[u32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backpack: Option<Vec<crate::gear::Item>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backpack_capacity: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gear_score: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raid_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bleedout: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decrypt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damage_log: Option<Vec<DamageHit>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ZombieDelta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<Vector2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeltaState {
    #[serde(rename = "type")]
    pub msg_type: String, // "delta"
    pub tick: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub players: Option<HashMap<String, PlayerDelta>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "playersRemoved")]
    pub players_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "zombiesNew")]
    pub zombies_new: Option<Vec<Zombie>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "zombiesUpdated")]
    pub zombies_updated: Option<Vec<ZombieDelta>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "zombiesRemoved")]
    pub zombies_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "bulletsNew")]
    pub bullets_new: Option<Vec<Bullet>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "bulletsRemoved")]
    pub bullets_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "placeablesNew")]
    pub placeables_new: Option<Vec<Placeable>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "placeablesUpdated")]
    pub placeables_updated: Option<Vec<PlaceableDelta>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "placeablesRemoved")]
    pub placeables_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "dropsNew")]
    pub drops_new: Option<Vec<DropPickup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "dropsRemoved")]
    pub drops_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "ammoPickups")]
    pub ammo_pickups: Option<Vec<AmmoPickupState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crates: Option<Vec<AmmoPickupState>>,
}

#[derive(Deserialize, Debug)]
pub struct ClientMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub input: Option<ClientInput>,
    pub token: Option<String>,
    pub paused: Option<bool>,
    #[serde(rename = "roomId")]
    pub room_id: Option<String>,
    /// Insure the loadout for this raid (join only).
    pub insure: Option<bool>,
}

// --- Raid results ---

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RaidResult {
    /// Reached an extraction point: loot, bounty and loadout are kept.
    Extracted,
    /// Downed and not revived: the loadout and everything carried are lost.
    Killed,
    /// The raid timer ran out: lost like a death.
    MissingInAction,
    /// Left or disconnected mid-raid: lost like a death.
    Abandoned,
}

impl RaidResult {
    pub fn kept_gear(&self) -> bool { *self == RaidResult::Extracted }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RaidOutcome {
    pub player_id: String,
    pub name: String,
    pub result: RaidResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killed_by: Option<ZombieType>,
    pub loot: Vec<crate::gear::Item>,
    /// What a lost raid cost: the loadout and everything in the pack.
    /// (`bounty` is what was earned; it's banked only on extraction.)
    pub lost: Vec<crate::gear::Item>,
    pub bounty: u32,
    pub kills: u32,
    pub max_combo: u32,
    pub survived_secs: f64,
}
