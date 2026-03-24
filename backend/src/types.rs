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
            Weapon::Pistol => 25.0,
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

    pub fn slot(&self) -> usize {
        match self {
            Weapon::Pistol => 0,
            Weapon::Uzi => 1,
            Weapon::Shotgun => 2,
            Weapon::RocketLauncher => 3,
        }
    }

    pub fn from_slot(slot: usize) -> Option<Weapon> {
        match slot {
            0 => Some(Weapon::Pistol),
            1 => Some(Weapon::Uzi),
            2 => Some(Weapon::Shotgun),
            3 => Some(Weapon::RocketLauncher),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DropType {
    Ammo,
    Health,
    Weapon,
}

pub const MELEE_DAMAGE: f64 = 35.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ZombieType {
    Zombie,
    Devil,
    Crawler,
    Brute,
    Vampire,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub id: String,
    pub name: String,
    pub pos: Vector2,
    pub angle: f64,
    pub score: f64,
    pub health: f64,
    pub ammo: f64,
    #[serde(rename = "maxAmmo")]
    pub max_ammo: f64,
    pub weapon: Weapon,
    #[serde(rename = "weaponSlots")]
    pub weapon_slots: [bool; 4],
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DropPickup {
    pub id: String,
    #[serde(rename = "type")]
    pub drop_type: DropType,
    pub pos: Vector2,
}

// --- Network messages ---

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InitPayload {
    #[serde(rename = "type")]
    pub msg_type: String, // "init"
    pub id: String,
    pub walls: Vec<crate::map::Wall>,
    #[serde(rename = "mapWidth")]
    pub map_width: f64,
    #[serde(rename = "mapHeight")]
    pub map_height: f64,
    #[serde(rename = "ammoSpawnPoints")]
    pub ammo_spawn_points: Vec<AmmoSpawnPoint>,
    #[serde(rename = "gameOver")]
    pub game_over: bool,
    pub wave: u32,
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
    pub wave: u32,
    #[serde(rename = "ammoPickups")]
    pub ammo_pickups: Vec<AmmoPickupState>,
    pub drops: Vec<DropPickup>,
    #[serde(rename = "gameOver")]
    pub game_over: bool,
}

#[derive(Serialize, Clone, Debug)]
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
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ammo: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "maxAmmo")]
    pub max_ammo: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weapon: Option<Weapon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "weaponSlots")]
    pub weapon_slots: Option<[bool; 4]>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ZombieDelta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<Vector2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
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
    #[serde(rename = "dropsNew")]
    pub drops_new: Option<Vec<DropPickup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "dropsRemoved")]
    pub drops_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wave: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "ammoPickups")]
    pub ammo_pickups: Option<Vec<AmmoPickupState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gameOver")]
    pub game_over: Option<bool>,
}

#[derive(Deserialize, Debug)]
pub struct ClientMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub input: Option<ClientInput>,
    pub name: Option<String>,
    pub token: Option<String>,
}
