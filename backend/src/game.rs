//! One raid world: a large generated map that players drop into, loot and try
//! to extract from. The world is persistent while a room exists; each player
//! has their own raid clock from the moment they deploy.

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use std::sync::atomic::{AtomicU64, Ordering};

use rand::Rng;

/// Short, process-unique ids for enemies, bullets, drops and placeables. They're
/// sent to every client many times a second, so they're kept far shorter than a UUID.
fn short_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("{:x}", NEXT.fetch_add(1, Ordering::Relaxed))
}

use crate::gear::{self, Item, ItemKind, Loadout, MapDef};
use crate::map::*;
use crate::spatial_grid::SpatialGrid;
use crate::types::*;

// ---------- Spatial-grid helper structs ----------

#[derive(Clone, Debug)]
struct WallEntry {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    cell_x: f64,
    cell_y: f64,
}

impl crate::spatial_grid::Positioned for WallEntry {
    fn pos(&self) -> (f64, f64) {
        (self.cell_x, self.cell_y)
    }
}

#[derive(Clone, Debug)]
struct ZombieRef {
    index: usize,
    x: f64,
    y: f64,
}

impl crate::spatial_grid::Positioned for ZombieRef {
    fn pos(&self) -> (f64, f64) {
        (self.x, self.y)
    }
}

#[derive(Clone, Debug)]
struct PlayerRef {
    id: String,
    x: f64,
    y: f64,
}

impl crate::spatial_grid::Positioned for PlayerRef {
    fn pos(&self) -> (f64, f64) {
        (self.x, self.y)
    }
}

// ---------- Internal pickups ----------

#[derive(Clone, Debug)]
struct AmmoPickupInternal {
    id: String,
    x: f64,
    y: f64,
    amount: i32,
    respawn_at: Option<f64>,
}

#[derive(Clone, Debug)]
struct CrateInternal {
    id: String,
    x: f64,
    y: f64,
    respawn_at: Option<f64>,
}

struct DropInternal {
    id: String,
    drop_type: DropType,
    x: f64,
    y: f64,
    despawn_at: f64,
    item: Option<Item>,
    /// A player who just swapped this out of their pack can't pick it straight back up.
    blocked: Option<(String, f64)>,
}

// ---------- Explosion event ----------

#[derive(Clone, Debug)]
struct ExplosionEvent {
    x: f64,
    y: f64,
    radius: f64,
    damage: f64,
    owner_id: String,
}

// ---------- Collision helpers ----------

const WALL_GRID_CELL_SIZE: f64 = 200.0;

fn rect_contains(rx: f64, ry: f64, rw: f64, rh: f64, px: f64, py: f64, radius: f64) -> bool {
    let closest_x = px.max(rx).min(rx + rw);
    let closest_y = py.max(ry).min(ry + rh);
    let dx = px - closest_x;
    let dy = py - closest_y;
    (dx * dx + dy * dy) < (radius * radius)
}

fn resolve_circle_rect(px: f64, py: f64, radius: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> (f64, f64) {
    let closest_x = px.max(rx).min(rx + rw);
    let closest_y = py.max(ry).min(ry + rh);
    let dx = px - closest_x;
    let dy = py - closest_y;
    let dist = (dx * dx + dy * dy).sqrt();

    if dist > 0.0 && dist < radius {
        let overlap = radius - dist;
        let nx = dx / dist;
        let ny = dy / dist;
        (px + nx * overlap, py + ny * overlap)
    } else if dist == 0.0 {
        let left = px - rx;
        let right = (rx + rw) - px;
        let top = py - ry;
        let bottom = (ry + rh) - py;
        let min_overlap = left.min(right).min(top).min(bottom);
        if min_overlap == left {
            (rx - radius, py)
        } else if min_overlap == right {
            (rx + rw + radius, py)
        } else if min_overlap == top {
            (px, ry - radius)
        } else {
            (px, ry + rh + radius)
        }
    } else {
        (px, py)
    }
}

fn resolve_wall_collisions(mut px: f64, mut py: f64, radius: f64, wall_grid: &SpatialGrid<WallEntry>) -> (f64, f64) {
    let nearby = wall_grid.query(px, py, radius + WALL_GRID_CELL_SIZE);
    let mut seen = HashSet::new();
    for w in &nearby {
        let key = ((w.x * 100.0) as i64, (w.y * 100.0) as i64, (w.w * 100.0) as i64, (w.h * 100.0) as i64);
        if !seen.insert(key) { continue; }
        if rect_contains(w.x, w.y, w.w, w.h, px, py, radius) {
            let (nx, ny) = resolve_circle_rect(px, py, radius, w.x, w.y, w.w, w.h);
            px = nx;
            py = ny;
        }
    }
    (px, py)
}

fn circle_hits_wall(px: f64, py: f64, radius: f64, wall_grid: &SpatialGrid<WallEntry>) -> bool {
    wall_grid.query(px, py, radius + WALL_GRID_CELL_SIZE).iter()
        .any(|w| rect_contains(w.x, w.y, w.w, w.h, px, py, radius))
}

fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

fn bullet_hits_wall(px: f64, py: f64, wall_grid: &SpatialGrid<WallEntry>) -> bool {
    wall_grid.query(px, py, WALL_GRID_CELL_SIZE).iter().any(|w| point_in_rect(px, py, w.x, w.y, w.w, w.h))
}

fn build_wall_grid(walls: &[Wall], width: f64, height: f64) -> SpatialGrid<WallEntry> {
    let mut grid: SpatialGrid<WallEntry> = SpatialGrid::new(width, height, WALL_GRID_CELL_SIZE);
    let grid_cols = (width / WALL_GRID_CELL_SIZE).ceil() as usize;
    let grid_rows = (height / WALL_GRID_CELL_SIZE).ceil() as usize;
    for wall in walls {
        let min_col = (wall.x / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let max_col = ((wall.x + wall.w) / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let min_row = (wall.y / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let max_row = ((wall.y + wall.h) / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        for row in min_row..=max_row.min(grid_rows - 1) {
            for col in min_col..=max_col.min(grid_cols - 1) {
                let cx = (col as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                let cy = (row as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                grid.insert(WallEntry {
                    x: wall.x, y: wall.y, w: wall.w, h: wall.h,
                    cell_x: cx.min(width - 1.0), cell_y: cy.min(height - 1.0),
                });
            }
        }
    }
    grid
}

// ---------- Enemies ----------

/// Cash added to a player's raid bounty per kill (before combo and map multipliers).
fn zombie_bounty(zombie_type: &ZombieType) -> f64 {
    match zombie_type {
        ZombieType::Abomination => 150.0,
        ZombieType::Vampire => 24.0,
        ZombieType::Brute => 20.0,
        ZombieType::Devil => 9.0,
        ZombieType::Crawler => 5.0,
        ZombieType::Zombie => 4.0,
    }
}

/// Base stats on the first map: (health, speed).
fn zombie_base_stats(zombie_type: &ZombieType) -> (f64, f64) {
    match zombie_type {
        ZombieType::Zombie => (50.0, 46.0),
        ZombieType::Crawler => (25.0, 88.0),
        ZombieType::Devil => (100.0, 62.0),
        ZombieType::Brute => (260.0, 30.0),
        ZombieType::Vampire => (160.0, 72.0),
        // As fast as a walking player: you can't simply outrun it.
        ZombieType::Abomination => (1400.0, 150.0),
    }
}

/// Bounty for a kill. Hunters sent after campers pay only their base bounty,
/// so camping on purpose to farm them doesn't pay.
fn kill_bounty(z: &Zombie) -> f64 {
    let elite = z.elite && z.target.is_none();
    zombie_bounty(&z.zombie_type) * if elite { ELITE_BOUNTY } else { 1.0 }
}

const ZOMBIE_TYPES: [ZombieType; 5] = [ZombieType::Zombie, ZombieType::Crawler, ZombieType::Devil, ZombieType::Brute, ZombieType::Vampire];
/// Kill-bounty multiplier cap from combos.
pub const COMBO_MAX_MULT: f64 = 3.0;
const ELITE_HEALTH: f64 = 2.5;
const ELITE_DAMAGE: f64 = 1.4;
const ELITE_BOUNTY: f64 = 3.0;
/// No enemy is faster than this (the player walks at 200).
const ABOMINATION_MAX_SPEED: f64 = 190.0;
/// Elites sent after a player who keeps camping after their Abomination.
const ELITE_PACK: usize = 3;
/// The first hunt in a raid is an Abomination; every later one is an elite pack,
/// for as long as the player keeps camping (hunters only pay base bounty).
const MAX_HUNTS: u32 = u32::MAX;

fn roll_zombie(map: &MapDef, rng: &mut impl Rng) -> (ZombieType, bool) {
    let total: f64 = map.spawn_weights.iter().sum();
    let mut roll = rng.random::<f64>() * total;
    let mut kind = ZombieType::Zombie;
    for (t, w) in ZOMBIE_TYPES.iter().zip(map.spawn_weights) {
        if roll < w { kind = t.clone(); break; }
        roll -= w;
    }
    (kind, rng.random::<f64>() < map.elite_chance)
}

fn make_zombie(map: &MapDef, kind: ZombieType, elite: bool, x: f64, y: f64) -> Zombie {
    let (hp, speed) = zombie_base_stats(&kind);
    let hp = (hp * map.enemy_health * if elite { ELITE_HEALTH } else { 1.0 }).round();
    Zombie {
        id: short_id(),
        zombie_type: kind,
        pos: Vector2 { x, y },
        health: hp,
        max_health: hp,
        speed: (speed * map.enemy_speed * if elite { 1.1 } else { 1.0 }).min(ABOMINATION_MAX_SPEED),
        elite,
        target: None,
    }
}

/// Collision radius: elites and bosses are bigger targets.
fn zombie_radius(z: &Zombie) -> f64 {
    match (&z.zombie_type, z.elite) {
        (ZombieType::Abomination, _) => ZOMBIE_RADIUS * 2.4,
        (_, true) => ZOMBIE_RADIUS * 1.3,
        _ => ZOMBIE_RADIUS,
    }
}

// ---------- Drop rolls ----------

/// Consumables an enemy may leave behind (ammo, health, a placeable).
fn roll_supply_drop(zombie_type: &ZombieType, x: f64, y: f64, game_time: f64) -> Option<DropInternal> {
    let mut rng = rand::rng();
    let roll: f64 = rng.random();
    let (ammo, health, tactical) = match zombie_type {
        ZombieType::Zombie => (0.16, 0.05, 0.04),
        ZombieType::Devil => (0.22, 0.10, 0.07),
        ZombieType::Crawler => (0.13, 0.05, 0.04),
        ZombieType::Brute => (0.35, 0.18, 0.14),
        ZombieType::Vampire => (0.25, 0.20, 0.10),
        ZombieType::Abomination => (1.0, 0.0, 0.0),
    };
    let drop_type = if roll < ammo {
        DropType::Ammo
    } else if roll < ammo + health {
        DropType::Health
    } else if roll < ammo + health + tactical {
        DropType::Tactical
    } else {
        return None;
    };
    Some(DropInternal {
        id: short_id(), drop_type, x, y,
        despawn_at: game_time + DROP_DESPAWN_TIME, item: None, blocked: None,
    })
}

fn loot_drop(item: Item, x: f64, y: f64, game_time: f64) -> DropInternal {
    DropInternal {
        id: short_id(), drop_type: DropType::Loot, x, y,
        despawn_at: game_time + LOOT_DESPAWN_TIME, item: Some(item), blocked: None,
    }
}

fn award_kill_to_player(p: &mut Player, base_bounty: f64, map_mult: f64) {
    p.kills += 1;
    p.combo += 1;
    p.combo_timer = COMBO_DURATION;
    if p.combo > p.max_combo {
        p.max_combo = p.combo;
    }
    let mult = (1.0 + (p.combo.saturating_sub(1) as f64) * 0.2).min(COMBO_MAX_MULT);
    p.bounty += (base_bounty * mult * map_mult).round();

    // Combo milestones resupply you in the field.
    if p.combo % 5 == 0 {
        p.ammo = (p.ammo + 15.0).min(p.max_ammo);
        p.tactical_items[0] = (p.tactical_items[0] + 1).min(99);
    }
    if p.combo % 10 == 0 {
        p.tactical_items[2] = (p.tactical_items[2] + 1).min(99);
        p.health = (p.health + 15.0).min(p.max_health);
    }
    if p.combo % 15 == 0 {
        p.tactical_items[1] = (p.tactical_items[1] + 2).min(99);
        p.ammo = (p.ammo + 10.0).min(p.max_ammo);
    }
}

fn raid_weapon(item: &Item) -> Option<RaidWeapon> {
    Some(RaidWeapon { kind: item.kind.weapon()?, power: item.power, rarity: item.rarity, name: item.name.clone() })
}

fn active_weapon(p: &Player) -> Option<&RaidWeapon> { p.weapons.get(p.active_slot as usize) }

// ---------- Game ----------

pub struct Game {
    map: &'static MapDef,
    layout: MapLayout,
    players: HashMap<String, Player>,
    player_names: HashMap<String, String>,
    join_order: Vec<String>,
    /// When each player deployed (game time) and where, for squad insertion.
    deployed_at: HashMap<String, (f64, usize)>,
    paused: bool,
    inputs: HashMap<String, ClientInput>,
    zombies: Vec<Zombie>,
    bullets: Vec<Bullet>,
    placeables: Vec<Placeable>,
    drops: Vec<DropInternal>,
    zombie_spawn_timer: f64,
    shoot_cooldowns: HashMap<String, f64>,
    melee_cooldowns: HashMap<String, f64>,
    place_cooldowns: HashMap<String, f64>,
    zombie_attack_cooldowns: HashMap<String, f64>,
    bullet_lifetimes: HashMap<String, f64>,
    game_time: f64,
    ammo_pickups: Vec<AmmoPickupInternal>,
    crates: Vec<CrateInternal>,
    wall_grid: SpatialGrid<WallEntry>,
    zombie_grid: SpatialGrid<ZombieRef>,
    player_grid: SpatialGrid<PlayerRef>,
    dash_charges: HashMap<String, i32>,
    dash_recharge: HashMap<String, f64>,
    dash_active: HashMap<String, f64>,
    dash_iframes: HashMap<String, f64>,
    // Revive: dead_player_id -> (reviver_id, progress_seconds)
    revive_progress: HashMap<String, (String, f64)>,
    // Zombie wall-stuck tracking: zombie_id -> (stuck_timer, steer_angle)
    zombie_wall_stuck: HashMap<String, (f64, f64)>,
    /// Finished raids waiting to be saved and reported by the room.
    outcomes: Vec<RaidOutcome>,
    /// Seconds until each nest spawns its next monster.
    nest_timers: Vec<f64>,
    /// The nest each monster came from (it wanders back there when idle).
    zombie_home: HashMap<String, usize>,
    /// Each player's position, sampled once a second over the camping window.
    camp_track: HashMap<String, std::collections::VecDeque<(f64, f64, f64)>>,
    /// Players who have sent at least one input (so they actually saw the raid).
    acted: HashSet<String>,
    /// Hunters sent after each player this raid (the first is an Abomination, later ones an elite pack).
    hunts_sent: HashMap<String, u32>,
    /// What each player deployed with, so a lost raid can say what was lost.
    loadouts: HashMap<String, Loadout>,
    /// Abomination id -> the camper it was sent for.
    boss_quarry: HashMap<String, String>,
    /// Players decrypting at an uplink last tick (id, x, y): the noise draws monsters.
    decrypt_noise: Vec<(String, f64, f64)>,
}

impl Game {
    pub fn new(map: &'static MapDef) -> Self {
        let layout = generate_layout(map);
        let wall_grid = build_wall_grid(&layout.walls, layout.width, layout.height);
        let ammo_pickups = layout.ammo.iter().enumerate().map(|(i, p)| AmmoPickupInternal {
            id: format!("ammo_{}", i), x: p.x, y: p.y, amount: AMMO_PICKUP_AMOUNT, respawn_at: None,
        }).collect();
        let crates = layout.crates.iter().enumerate().map(|(i, p)| CrateInternal {
            id: format!("crate_{}", i), x: p.x, y: p.y, respawn_at: None,
        }).collect();
        let (w, h) = (layout.width, layout.height);

        Self {
            map,
            players: HashMap::new(),
            player_names: HashMap::new(),
            join_order: Vec::new(),
            deployed_at: HashMap::new(),
            paused: false,
            inputs: HashMap::new(),
            zombies: Vec::new(),
            bullets: Vec::new(),
            placeables: Vec::new(),
            drops: Vec::new(),
            zombie_spawn_timer: 2.0,
            shoot_cooldowns: HashMap::new(),
            melee_cooldowns: HashMap::new(),
            place_cooldowns: HashMap::new(),
            zombie_attack_cooldowns: HashMap::new(),
            bullet_lifetimes: HashMap::new(),
            game_time: 0.0,
            ammo_pickups,
            crates,
            wall_grid,
            zombie_grid: SpatialGrid::new(w, h, WALL_GRID_CELL_SIZE),
            player_grid: SpatialGrid::new(w, h, WALL_GRID_CELL_SIZE),
            dash_charges: HashMap::new(),
            dash_recharge: HashMap::new(),
            dash_active: HashMap::new(),
            dash_iframes: HashMap::new(),
            revive_progress: HashMap::new(),
            zombie_wall_stuck: HashMap::new(),
            outcomes: Vec::new(),
            nest_timers: vec![0.0; layout.nests.len()],
            zombie_home: HashMap::new(),
            camp_track: HashMap::new(),
            hunts_sent: HashMap::new(),
            loadouts: HashMap::new(),
            acted: HashSet::new(),
            boss_quarry: HashMap::new(),
            decrypt_noise: Vec::new(),
            layout,
        }
    }

    #[cfg(test)]
    pub fn map(&self) -> &'static MapDef { self.map }

    /// Clear the world (enemies, loot, deployables) and restock every crate and
    /// cache. Players stay where they are and keep their raid.
    pub fn reset_world(&mut self) {
        self.zombies.clear();
        self.bullets.clear();
        self.placeables.clear();
        self.drops.clear();
        self.zombie_attack_cooldowns.clear();
        self.bullet_lifetimes.clear();
        self.zombie_wall_stuck.clear();
        self.zombie_home.clear();
        self.boss_quarry.clear();
        self.decrypt_noise.clear();
        for p in self.players.values_mut() { p.camp = 0.0; p.hunted = false; p.decrypt = 0.0; }
        self.camp_track.clear();
        self.zombie_spawn_timer = 2.0;
        self.paused = false;
        self.inputs.clear();
        for pickup in &mut self.ammo_pickups { pickup.respawn_at = None; }
        for c in &mut self.crates { c.respawn_at = None; }
    }

    /// Deploy a player into the raid with their loadout. Squadmates who deploy
    /// within 30 seconds of each other share an insertion point.
    #[cfg(test)]
    pub fn add_player(&mut self, id: &str, name: &str, loadout: &Loadout) {
        self.add_player_carrying(id, name, loadout, Vec::new());
    }

    /// Deploy with sealed items brought from the stash already in the pack.
    pub fn add_player_carrying(&mut self, id: &str, name: &str, loadout: &Loadout, carried: Vec<Item>) {
        if !self.players.contains_key(id) { self.join_order.push(id.to_string()); }
        self.player_names.insert(id.to_string(), name.to_string());
        // Pausing is for solo raids: someone arriving resumes the world.
        if self.paused { self.paused = false; self.inputs.clear(); }
        self.loadouts.insert(id.to_string(), loadout.clone());

        let mut rng = rand::rng();
        let recent = self.deployed_at.iter()
            .filter(|(pid, (t, _))| self.game_time - *t < 30.0 && self.players.get(*pid).is_some_and(|p| p.health > 0.0))
            .map(|(_, (_, idx))| *idx)
            .next();
        let insertion = recent.unwrap_or_else(|| rng.random_range(0..self.layout.insertions.len()));
        self.deployed_at.insert(id.to_string(), (self.game_time, insertion));
        let spot = &self.layout.insertions[insertion];
        let (sx, sy) = (spot.x + rng.random_range(-30.0..30.0), spot.y + rng.random_range(-30.0..30.0));
        let (sx, sy) = resolve_wall_collisions(sx, sy, PLAYER_RADIUS, &self.wall_grid);

        let mut weapons: Vec<RaidWeapon> = [&loadout.primary, &loadout.secondary].into_iter()
            .flatten().filter_map(raid_weapon).collect();
        if weapons.is_empty() { weapons.extend(raid_weapon(&gear::loaner_pistol())); }
        let armor = loadout.armor.as_ref().map_or(0, |i| i.power);
        let pack = loadout.pack.as_ref().map(|i| i.power);
        let max_health = gear::armor_max_health(armor) + loadout.boost.max_health;
        let max_ammo = pack.map_or(gear::NO_PACK_AMMO, gear::pack_max_ammo);
        let backpack_capacity = pack.map_or(gear::NO_PACK_CAPACITY, gear::pack_capacity);
        let mut backpack = carried;
        backpack.truncate(backpack_capacity as usize);

        let player = Player {
            id: id.to_string(),
            name: name.to_string(),
            pos: Vector2 { x: sx, y: sy },
            angle: 0.0,
            health: max_health,
            max_health,
            ammo: max_ammo,
            max_ammo,
            weapon: weapons[0].kind.clone(),
            weapons,
            active_slot: 0,
            combo: 0,
            combo_timer: 0.0,
            max_combo: 0,
            kills: 0,
            tactical_items: pack.map_or(gear::NO_PACK_TACTICAL, gear::pack_tactical),
            bounty: 0.0,
            backpack,
            backpack_capacity,
            gear_score: loadout.gear_score(),
            raid_time: self.map.raid_secs,
            extract_progress: 0.0,
            bleedout: 0.0,
            camp: 0.0,
            hunted: false,
            decrypt: 0.0,
            damage_log: Vec::new(),
        };
        self.players.insert(id.to_string(), player);
    }

    pub fn remove_player(&mut self, id: &str) {
        if self.host_id() == Some(id) {
            self.paused = false;
            self.inputs.clear();
        }
        self.join_order.retain(|player| player != id);
        self.players.remove(id);
        self.player_names.remove(id);
        self.deployed_at.remove(id);
        self.inputs.remove(id);
        self.shoot_cooldowns.remove(id);
        self.melee_cooldowns.remove(id);
        self.place_cooldowns.remove(id);
        self.dash_charges.remove(id);
        self.dash_recharge.remove(id);
        self.dash_active.remove(id);
        self.dash_iframes.remove(id);
        self.revive_progress.remove(id);
        self.camp_track.remove(id);
        self.hunts_sent.remove(id);
        self.loadouts.remove(id);
        self.acted.remove(id);
    }

    /// A player left mid-raid: they forfeit like a death. Returns `None` if
    /// their raid already ended (the outcome was produced by the game).
    pub fn abandon(&mut self, id: &str) -> Option<RaidOutcome> {
        let outcome = self.players.get(id).map(|p| self.outcome_for(p, RaidResult::Abandoned, None));
        self.remove_player(id);
        outcome
    }

    /// Whether this player ever sent input. A connection that drops before
    /// that never really played, so its raid is voided rather than lost.
    pub fn has_acted(&self, id: &str) -> bool { self.acted.contains(id) }

    fn outcome_for(&self, p: &Player, result: RaidResult, extract_name: Option<String>) -> RaidOutcome {
        let kept = result.kept_gear();
        RaidOutcome {
            player_id: p.id.clone(),
            name: p.name.clone(),
            killed_by: (result == RaidResult::Killed).then(|| p.damage_log.last().map(|h| h.source.clone())).flatten(),
            result,
            extract_name,
            loot: if kept { p.backpack.clone() } else { Vec::new() },
            // A lost raid costs the loadout and the pack (the loaner pistol is never lost).
            lost: if kept { Vec::new() } else {
                self.loadouts.get(&p.id).map(|l| gear::SLOTS.iter().filter_map(|s| l.get(*s).cloned()).collect::<Vec<_>>()).unwrap_or_default()
                    .into_iter().chain(p.backpack.iter().cloned()).collect()
            },
            bounty: p.bounty.max(0.0) as u32,
            kills: p.kills,
            max_combo: p.max_combo,
            survived_secs: (self.map.raid_secs - p.raid_time).max(0.0),
        }
    }

    fn finish_raid(&mut self, id: &str, result: RaidResult, extract_name: Option<String>) {
        if let Some(p) = self.players.get(id) {
            let outcome = self.outcome_for(p, result, extract_name);
            self.outcomes.push(outcome);
            self.remove_player(id);
        }
    }

    /// Raids that ended since the last call (extracted, killed or out of time).
    pub fn take_outcomes(&mut self) -> Vec<RaidOutcome> { std::mem::take(&mut self.outcomes) }

    pub fn host_id(&self) -> Option<&str> { self.join_order.first().map(String::as_str) }

    pub fn is_paused(&self) -> bool { self.paused }

    /// Pausing is only allowed when you're alone in the raid: a shared raid
    /// can't be frozen for strangers. Resuming is always allowed.
    pub fn set_paused(&mut self, id: &str, paused: bool) -> bool {
        if self.host_id() != Some(id) { return false; }
        if paused && self.players.len() > 1 { return false; }
        if self.paused != paused {
            self.paused = paused;
            self.inputs.clear();
        }
        true
    }

    pub fn handle_input(&mut self, id: &str, input: ClientInput) {
        if self.paused || !self.players.contains_key(id) { return; }
        self.acted.insert(id.to_string());
        self.inputs.insert(id.to_string(), input);
    }

    fn clamp_to_map(&self, x: f64, y: f64, r: f64) -> (f64, f64) {
        (x.max(r).min(self.layout.width - r), y.max(r).min(self.layout.height - r))
    }

    /// Find an open spot in a ring around (cx, cy).
    fn spawn_point_around(&self, cx: f64, cy: f64, ring: (f64, f64), rng: &mut impl Rng) -> Option<(f64, f64)> {
        for _ in 0..8 {
            let a = rng.random_range(0.0..2.0 * PI);
            let d = rng.random_range(ring.0..ring.1);
            let (x, y) = (cx + a.cos() * d, cy + a.sin() * d);
            if x < 40.0 || y < 40.0 || x > self.layout.width - 40.0 || y > self.layout.height - 40.0 { continue; }
            if circle_hits_wall(x, y, ZOMBIE_RADIUS + 2.0, &self.wall_grid) { continue; }
            return Some((x, y));
        }
        None
    }

    /// Send an Abomination after a camper, out of the nest nearest to them.
    fn spawn_boss_for(&mut self, quarry: &str) -> bool {
        let Some((px, py)) = self.players.get(quarry).map(|p| (p.pos.x, p.pos.y)) else { return false };
        if self.hunts_sent.get(quarry).copied().unwrap_or(0) >= MAX_HUNTS { return false; }
        if self.zombies.len() + ELITE_PACK > MAX_ZOMBIES_HARD_CAP { return false; }
        let mut rng = rand::rng();
        let nearest = self.layout.nests.iter().enumerate()
            .map(|(i, n)| (i, f64::hypot(n.x - px, n.y - py)))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        let (home, spot) = match nearest {
            Some((i, d)) if d < 2600.0 => (Some(i), self.spawn_point_around(self.layout.nests[i].x, self.layout.nests[i].y, NEST_SPAWN_RING, &mut rng)),
            _ => (None, self.spawn_point_around(px, py, (800.0, 1100.0), &mut rng)),
        };
        let Some((x, y)) = spot else { return false };
        let sent = self.hunts_sent.entry(quarry.to_string()).or_insert(0);
        *sent += 1;
        // The first hunter in a raid is an Abomination; after that, an elite pack.
        let pack: Vec<Zombie> = if *sent == 1 {
            vec![make_zombie(self.map, ZombieType::Abomination, false, x, y)]
        } else {
            (0..ELITE_PACK).map(|i| {
                let (kind, _) = roll_zombie(self.map, &mut rng);
                let a = i as f64 * 2.0 * PI / ELITE_PACK as f64;
                make_zombie(self.map, kind, true, x + a.cos() * 30.0, y + a.sin() * 30.0)
            }).collect()
        };
        for mut z in pack {
            z.target = Some(quarry.to_string());
            if let Some(home) = home { self.zombie_home.insert(z.id.clone(), home); }
            self.boss_quarry.insert(z.id.clone(), quarry.to_string());
            self.zombies.push(z);
        }
        true
    }

    pub fn update(&mut self, dt: f64) {
        if self.paused {
            return;
        }

        self.game_time += dt;
        let map = self.map;
        let (map_w, map_h) = (self.layout.width, self.layout.height);
        let clampz = |v: f64, max: f64| v.max(ZOMBIE_RADIUS).min(max - ZOMBIE_RADIUS);

        // Rebuild grids
        self.player_grid.clear();
        for (id, p) in &self.players {
            if p.health > 0.0 {
                self.player_grid.insert(PlayerRef { id: id.clone(), x: p.pos.x, y: p.pos.y });
            }
        }
        self.zombie_grid.clear();
        for (i, z) in self.zombies.iter().enumerate() {
            self.zombie_grid.insert(ZombieRef { index: i, x: z.pos.x, y: z.pos.y });
        }

        let mut explosions: Vec<ExplosionEvent> = Vec::new();
        let mut new_drops: Vec<DropInternal> = Vec::new();
        // Enemies killed this tick. They're removed (and drop loot) at the end of
        // the tick, so indices from the zombie grid stay valid for every player.
        let mut zombie_kill_indices: Vec<usize> = Vec::new();

        // ---------- Players ----------
        let player_ids: Vec<String> = self.players.keys().cloned().collect();
        // One-shot actions (dash, drop, place) apply once per input message: the
        // stored input is reused every tick until the next one arrives.
        for input in self.inputs.values_mut() {
            if input.consumed { input.dash = false; input.drop_item = false; input.drop_id = None; input.place_item = 0; }
            input.consumed = true;
        }
        for pid in &player_ids {
            if self.players.get(pid).map_or(true, |p| p.health <= 0.0) {
                continue;
            }

            if let Some(p) = self.players.get_mut(pid) {
                if p.combo > 0 {
                    p.combo_timer = (p.combo_timer - dt).max(0.0);
                    if p.combo_timer <= 0.0 { p.combo = 0; }
                }
            }

            let input = match self.inputs.get(pid) {
                Some(i) => i.clone(),
                None => continue,
            };

            // Dash: up to 3 charges, i-frames and a shockwave.
            let mut just_dashed = false;
            {
                let charges = self.dash_charges.entry(pid.clone()).or_insert(DASH_MAX_CHARGES);
                let recharge = self.dash_recharge.entry(pid.clone()).or_insert(0.0);
                let active = self.dash_active.entry(pid.clone()).or_insert(0.0);
                let iframes = self.dash_iframes.entry(pid.clone()).or_insert(0.0);
                *active = (*active - dt).max(0.0);
                *iframes = (*iframes - dt).max(0.0);
                if *charges < DASH_MAX_CHARGES {
                    *recharge -= dt;
                    if *recharge <= 0.0 {
                        *charges += 1;
                        *recharge = if *charges < DASH_MAX_CHARGES { DASH_RECHARGE_TIME } else { 0.0 };
                    }
                }
                if input.dash && *charges > 0 && *active <= 0.0 {
                    *active = DASH_DURATION;
                    *iframes = DASH_DURATION + DASH_IFRAME_GRACE;
                    *charges -= 1;
                    just_dashed = true;
                    if *charges < DASH_MAX_CHARGES && *recharge <= 0.0 {
                        *recharge = DASH_RECHARGE_TIME;
                    }
                }
            }
            if just_dashed {
                if let Some(p) = self.players.get(pid) {
                    let (px, py) = (p.pos.x, p.pos.y);
                    for z in &mut self.zombies {
                        let dx = z.pos.x - px;
                        let dy = z.pos.y - py;
                        let dist = (dx * dx + dy * dy).sqrt();
                        if dist > 0.0 && dist < 55.0 {
                            z.pos.x = clampz(z.pos.x + (dx / dist) * 35.0, map_w);
                            z.pos.y = clampz(z.pos.y + (dy / dist) * 35.0, map_h);
                        }
                    }
                }
            }
            let is_dashing = self.dash_active.get(pid).copied().unwrap_or(0.0) > 0.0;

            // Movement
            let (mut dx, mut dy) = (0.0_f64, 0.0_f64);
            if input.up { dy -= 1.0; }
            if input.down { dy += 1.0; }
            if input.left { dx -= 1.0; }
            if input.right { dx += 1.0; }
            let len = (dx * dx + dy * dy).sqrt();
            if len > 0.0 { dx /= len; dy /= len; }
            let has_overdrive = self.players.get(pid).map_or(false, |p| p.combo >= 10);
            let base_speed = if has_overdrive { PLAYER_SPEED * 1.15 } else { PLAYER_SPEED };
            let speed = if is_dashing { base_speed * DASH_SPEED_MULT } else { base_speed };
            {
                let (cx, cy) = {
                    let p = &self.players[pid];
                    self.clamp_to_map(p.pos.x + dx * speed * dt, p.pos.y + dy * speed * dt, PLAYER_RADIUS)
                };
                let (nx, ny) = resolve_wall_collisions(cx, cy, PLAYER_RADIUS, &self.wall_grid);
                let p = self.players.get_mut(pid).unwrap();
                p.pos.x = nx;
                p.pos.y = ny;
                p.angle = (input.mouse_y - p.pos.y).atan2(input.mouse_x - p.pos.x);
                // Keys 1 and 2 pick the primary or secondary gun.
                if input.select_weapon >= 1 && (input.select_weapon as usize) <= p.weapons.len() {
                    p.active_slot = (input.select_weapon - 1) as u32;
                    p.weapon = p.weapons[p.active_slot as usize].kind.clone();
                }
            }

            // Drop the last item you picked up (G), e.g. to make room for gear.
            // Or a chosen item, from the inventory screen.
            if input.drop_item || input.drop_id.is_some() {
                let p = self.players.get_mut(pid).unwrap();
                let pick = match &input.drop_id {
                    Some(id) => p.backpack.iter().position(|i| &i.id == id),
                    None => p.backpack.len().checked_sub(1),
                };
                if let Some(idx) = pick {
                    // Dropping the item being decrypted restarts the timer.
                    if p.backpack.iter().position(|i| i.kind == ItemKind::Encrypted) == Some(idx) { p.decrypt = 0.0; }
                    let item = p.backpack.remove(idx);
                    let mut d = loot_drop(item, p.pos.x, p.pos.y + 20.0, self.game_time);
                    d.blocked = Some((pid.clone(), self.game_time + 4.0));
                    self.drops.push(d);
                }
            }

            *self.shoot_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;
            *self.melee_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;
            *self.place_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;

            // Placeables (1 = barrel, 2 = barricade, 3 = claymore)
            let place_cd = *self.place_cooldowns.get(pid).unwrap_or(&0.0);
            if (1..=3).contains(&input.place_item) && place_cd <= 0.0 {
                let item_idx = (input.place_item - 1) as usize;
                if self.players.get(pid).is_some_and(|p| p.tactical_items[item_idx] > 0) {
                    self.place_cooldowns.insert(pid.clone(), 0.35);
                    let (item_type, hp, offset, radius) = match item_idx {
                        0 => (PlaceableType::Barrel, BARREL_HP, 42.0, BARREL_RADIUS),
                        1 => (PlaceableType::Barricade, BARRICADE_HP, 42.0, BARRICADE_RADIUS),
                        _ => (PlaceableType::Mine, MINE_HP, 28.0, MINE_RADIUS),
                    };
                    let (ix, iy) = {
                        let p = &self.players[pid];
                        self.clamp_to_map(p.pos.x + p.angle.cos() * offset, p.pos.y + p.angle.sin() * offset, radius)
                    };
                    let (ix, iy) = resolve_wall_collisions(ix, iy, radius, &self.wall_grid);
                    self.players.get_mut(pid).unwrap().tactical_items[item_idx] -= 1;
                    self.placeables.push(Placeable {
                        id: short_id(), item_type, pos: Vector2 { x: ix, y: iy },
                        health: hp, max_health: hp, owner_id: pid.clone(),
                    });
                }
            }

            // Melee: katana cleave. Scales with gear score and heals on kills.
            let melee_cd = *self.melee_cooldowns.get(pid).unwrap();
            if input.melee && melee_cd <= 0.0 {
                let p = self.players.get(pid).unwrap();
                let cd_mult = if p.combo >= 10 { 0.78 } else { 1.0 };
                self.melee_cooldowns.insert(pid.clone(), MELEE_COOLDOWN * cd_mult);
                let (px, py, p_angle) = (p.pos.x, p.pos.y, p.angle);
                let dmg_mult = gear::melee_mult(p.gear_score);
                let crit_chance = CRIT_BASE_CHANCE;

                for pl in &mut self.placeables {
                    if pl.item_type != PlaceableType::Barrel { continue; }
                    let (bdx, bdy) = (pl.pos.x - px, pl.pos.y - py);
                    if (bdx * bdx + bdy * bdy).sqrt() <= MELEE_RANGE + BARREL_RADIUS {
                        let mut angle_diff = (bdy.atan2(bdx) - p_angle).abs();
                        if angle_diff > PI { angle_diff = 2.0 * PI - angle_diff; }
                        if angle_diff <= MELEE_ARC / 2.0 {
                            pl.health = 0.0;
                            explosions.push(ExplosionEvent { x: pl.pos.x, y: pl.pos.y, radius: BARREL_EXPLOSION_RADIUS, damage: BARREL_DAMAGE * map.enemy_health, owner_id: pid.clone() });
                        }
                    }
                }

                let nearby = self.zombie_grid.query(px, py, MELEE_RANGE);
                let mut indices: Vec<usize> = nearby.iter().map(|zr| zr.index).collect();
                indices.sort_unstable();
                indices.dedup();
                let mut rng = rand::rng();
                for &zi in &indices {
                    if zi >= self.zombies.len() || self.zombies[zi].health <= 0.0 || zombie_kill_indices.contains(&zi) { continue; }
                    let z = &self.zombies[zi];
                    let (zdx, zdy) = (z.pos.x - px, z.pos.y - py);
                    let dist = (zdx * zdx + zdy * zdy).sqrt();
                    if dist > MELEE_RANGE { continue; }
                    let mut angle_diff = (zdy.atan2(zdx) - p_angle).abs();
                    if angle_diff > PI { angle_diff = 2.0 * PI - angle_diff; }
                    if angle_diff > MELEE_ARC / 2.0 { continue; }

                    let is_crit = rng.random::<f64>() < crit_chance;
                    self.zombies[zi].health -= crate::types::MELEE_DAMAGE * dmg_mult * if is_crit { CRIT_DAMAGE_MULT } else { 1.0 };
                    if dist > 0.0 {
                        let z = &mut self.zombies[zi];
                        z.pos.x = clampz(z.pos.x + zdx / dist * 48.0, map_w);
                        z.pos.y = clampz(z.pos.y + zdy / dist * 48.0, map_h);
                    }
                    if self.zombies[zi].health <= 0.0 {
                        let z = self.zombies[zi].clone();
                        zombie_kill_indices.push(zi);
                        if let Some(p) = self.players.get_mut(pid) {
                            award_kill_to_player(p, kill_bounty(&z), map.bounty_mult);
                            p.health = (p.health + p.max_health * 0.04).min(p.max_health);
                        }
                    }
                }
            }

            // Shooting
            let shoot_cd = *self.shoot_cooldowns.get(pid).unwrap_or(&0.0);
            if input.shooting && shoot_cd <= 0.0 {
                let p = self.players.get(pid).unwrap();
                let weapon = p.weapon.clone();
                let is_pistol = weapon == Weapon::Pistol;
                let needed = if weapon == Weapon::RocketLauncher { ROCKET_AMMO_COST } else { 1.0 };
                if is_pistol || p.ammo >= needed {
                    let cd_mult = if p.combo >= 10 { 0.75 } else { 1.0 };
                    self.shoot_cooldowns.insert(pid.clone(), weapon.cooldown() * cd_mult);
                    let (angle, px, py) = (p.angle, p.pos.x, p.pos.y);
                    let power = active_weapon(p).map_or(1, |w| w.power);
                    let boost = self.loadouts.get(pid).map_or(0.0, |l| l.boost.damage);
                    let base_damage = weapon.damage() * (gear::raid_damage_mult(power) + boost);
                    let crit_chance = (CRIT_BASE_CHANCE + power as f64 * 0.002).min(0.45);
                    let owner_id = pid.clone();
                    if !is_pistol {
                        let cost = if weapon == Weapon::RocketLauncher { ROCKET_AMMO_COST } else { 1.0 };
                        let p = self.players.get_mut(pid).unwrap();
                        p.ammo = (p.ammo - cost).max(0.0);
                    }
                    let mut rng = rand::rng();
                    let mut fire = |a: f64, dmg: f64, speed: f64, rocket: bool, rng: &mut rand::rngs::ThreadRng| {
                        let bid = short_id();
                        let is_crit = rng.random::<f64>() < crit_chance;
                        let d = dmg * if is_crit { CRIT_DAMAGE_MULT } else { 1.0 };
                        self.bullet_lifetimes.insert(bid.clone(), BULLET_LIFETIME);
                        self.bullets.push(Bullet {
                            id: bid,
                            pos: Vector2 { x: px + a.cos() * PLAYER_RADIUS, y: py + a.sin() * PLAYER_RADIUS },
                            vel: Vector2 { x: a.cos() * speed, y: a.sin() * speed },
                            owner_id: owner_id.clone(),
                            damage: (d * 10.0).round() / 10.0,
                            is_crit,
                            is_rocket: rocket,
                        });
                    };
                    match weapon {
                        Weapon::Shotgun => {
                            let spread = PI / 12.0;
                            for i in 0..5 {
                                fire(angle - spread * 2.0 + spread * i as f64, base_damage / 5.0, BULLET_SPEED, false, &mut rng);
                            }
                        }
                        Weapon::RocketLauncher => fire(angle, base_damage, ROCKET_SPEED, true, &mut rng),
                        _ => fire(angle, base_damage, BULLET_SPEED, false, &mut rng),
                    }
                }
            }

            // Pickups: ammo caches, crates and drops on the ground.
            let p = self.players.get_mut(pid).unwrap();
            for pickup in &mut self.ammo_pickups {
                if pickup.respawn_at.is_some() { continue; }
                if f64::hypot(p.pos.x - pickup.x, p.pos.y - pickup.y) < PLAYER_RADIUS + AMMO_PICKUP_RADIUS && p.ammo < p.max_ammo {
                    p.ammo = (p.ammo + pickup.amount as f64).min(p.max_ammo);
                    pickup.respawn_at = Some(self.game_time + AMMO_RESPAWN_TIME);
                }
            }
            let mut rng = rand::rng();
            for c in &mut self.crates {
                if c.respawn_at.is_some() { continue; }
                if f64::hypot(p.pos.x - c.x, p.pos.y - c.y) < PLAYER_RADIUS + CRATE_RADIUS + 6.0 {
                    c.respawn_at = Some(self.game_time + CRATE_RESPAWN_TIME);
                    let contents = gear::roll_crate(&mut rng, map);
                    let n = contents.len();
                    for (i, item) in contents.into_iter().enumerate() {
                        // Spill the loot in a ring so each item can be picked up on its own.
                        let a = i as f64 / n as f64 * 2.0 * PI + rng.random_range(0.0..0.6);
                        new_drops.push(loot_drop(item, c.x + a.cos() * 34.0, c.y + a.sin() * 34.0, self.game_time));
                    }
                    if rng.random::<f64>() < 0.45 {
                        new_drops.push(DropInternal {
                            id: short_id(), drop_type: DropType::Ammo, x: c.x, y: c.y + 2.0,
                            despawn_at: self.game_time + DROP_DESPAWN_TIME, item: None, blocked: None,
                        });
                    }
                }
            }

            let mut taken = Vec::new();
            for (di, drop) in self.drops.iter_mut().enumerate() {
                if drop.despawn_at <= self.game_time { continue; }
                if f64::hypot(p.pos.x - drop.x, p.pos.y - drop.y) >= PLAYER_RADIUS + DROP_PICKUP_RADIUS { continue; }
                if let Some((who, until)) = &drop.blocked {
                    if who == pid && *until > self.game_time { continue; }
                }
                match drop.drop_type {
                    DropType::Ammo => {
                        if p.ammo >= p.max_ammo { continue; }
                        p.ammo = (p.ammo + DROP_AMMO_AMOUNT).min(p.max_ammo);
                    }
                    DropType::Health => {
                        if p.health >= p.max_health { continue; }
                        p.health = (p.health + p.max_health * DROP_HEALTH_FRACTION).min(p.max_health);
                    }
                    DropType::Tactical => {
                        let idx = rng.random_range(0..3);
                        p.tactical_items[idx] = (p.tactical_items[idx] + 1).min(99);
                    }
                    DropType::Loot => {
                        let Some(item) = drop.item.clone() else { continue };
                        if (p.backpack.len() as u32) < p.backpack_capacity {
                            p.backpack.push(item);
                        } else {
                            // Full pack: gear only replaces weaker gear, and valuables only
                            // cheaper valuables, so a gold watch never pushes out the armor
                            // you need for the next gate.
                            let Some(low) = gear::swap_target(&p.backpack, &item) else { continue };
                            let swapped = std::mem::replace(&mut p.backpack[low], item);
                            drop.item = Some(swapped);
                            drop.id = short_id();
                            drop.despawn_at = self.game_time + LOOT_DESPAWN_TIME;
                            drop.blocked = Some((pid.clone(), self.game_time + 4.0));
                            continue;
                        }
                    }
                }
                taken.push(di);
            }
            for &di in taken.iter().rev() {
                self.drops.remove(di);
            }
        }

        // Respawning caches and crates
        for pickup in &mut self.ammo_pickups {
            if pickup.respawn_at.is_some_and(|t| self.game_time >= t) { pickup.respawn_at = None; }
        }
        for c in &mut self.crates {
            if c.respawn_at.is_some_and(|t| self.game_time >= t) { c.respawn_at = None; }
        }

        // ---------- Bullets ----------
        for bullet in &mut self.bullets {
            bullet.pos.x += bullet.vel.x * dt;
            bullet.pos.y += bullet.vel.y * dt;
        }
        {
            let wall_grid = &self.wall_grid;
            let lifetimes = &mut self.bullet_lifetimes;
            let placeables = &mut self.placeables;
            self.bullets.retain(|b| {
                let rocket_blast = |explosions: &mut Vec<ExplosionEvent>| {
                    if b.is_rocket {
                        explosions.push(ExplosionEvent { x: b.pos.x, y: b.pos.y, radius: ROCKET_EXPLOSION_RADIUS, damage: b.damage, owner_id: b.owner_id.clone() });
                    }
                };
                if let Some(lt) = lifetimes.get_mut(&b.id) {
                    *lt -= dt;
                    if *lt <= 0.0 {
                        lifetimes.remove(&b.id);
                        rocket_blast(&mut explosions);
                        return false;
                    }
                }
                if b.pos.x < 0.0 || b.pos.x > map_w || b.pos.y < 0.0 || b.pos.y > map_h || bullet_hits_wall(b.pos.x, b.pos.y, wall_grid) {
                    lifetimes.remove(&b.id);
                    rocket_blast(&mut explosions);
                    return false;
                }
                for pl in placeables.iter_mut() {
                    if pl.item_type == PlaceableType::Barrel && pl.health > 0.0
                        && f64::hypot(b.pos.x - pl.pos.x, b.pos.y - pl.pos.y) < BARREL_RADIUS + BULLET_RADIUS {
                        pl.health -= b.damage;
                        lifetimes.remove(&b.id);
                        rocket_blast(&mut explosions);
                        if pl.health <= 0.0 {
                            explosions.push(ExplosionEvent { x: pl.pos.x, y: pl.pos.y, radius: BARREL_EXPLOSION_RADIUS, damage: BARREL_DAMAGE * map.enemy_health, owner_id: b.owner_id.clone() });
                        }
                        return false;
                    }
                }
                true
            });
        }

        // ---------- Spawning: monsters pour out of nests near players ----------
        let living: Vec<(f64, f64)> = self.players.values().filter(|p| p.health > 0.0).map(|p| (p.pos.x, p.pos.y)).collect();
        self.zombie_spawn_timer -= dt;
        if self.zombie_spawn_timer <= 0.0 && !living.is_empty() {
            let max_zombies = (map.max_enemies_base + map.max_enemies_per_player * living.len()).min(MAX_ZOMBIES_HARD_CAP);
            // Each nest keeps a handful of monsters out; tougher maps keep more.
            let per_nest = 5 + map.tier as usize * 2;
            let mut per_home = vec![0usize; self.layout.nests.len()];
            for home in self.zombie_home.values() { if *home < per_home.len() { per_home[*home] += 1; } }
            let mut rng = rand::rng();
            for i in 0..self.layout.nests.len() {
                let (nx, ny) = (self.layout.nests[i].x, self.layout.nests[i].y);
                let near = living.iter().filter(|(x, y)| f64::hypot(x - nx, y - ny) < NEST_ACTIVE_RANGE).count();
                if near == 0 { continue; }
                // A squad draws more monsters than a lone player (sqrt so it doesn't explode).
                // Decrypting nearby is loud: the nest wakes up faster.
                let loud = self.decrypt_noise.iter().any(|(_, x, y)| f64::hypot(x - nx, y - ny) < NEST_ACTIVE_RANGE);
                self.nest_timers[i] -= dt * (near as f64).sqrt() * if loud { 1.8 } else { 1.0 };
                if self.nest_timers[i] > 0.0 { continue; }
                self.nest_timers[i] = map.spawn_interval * rng.random_range(3.0..5.0);
                if per_home[i] >= per_nest || self.zombies.len() >= max_zombies { continue; }
                if let Some((x, y)) = self.spawn_point_around(nx, ny, NEST_SPAWN_RING, &mut rng) {
                    let (kind, elite) = roll_zombie(map, &mut rng);
                    let z = make_zombie(map, kind, elite, x, y);
                    self.zombie_home.insert(z.id.clone(), i);
                    per_home[i] += 1;
                    self.zombies.push(z);
                }
            }
        }

        // Camping: if you haven't strayed more than CAMP_RADIUS from where you
        // are now at any point in the last CAMP_WINDOW seconds, the meter fills;
        // moving on drains it. Strafing on the spot doesn't count as moving.
        // A full meter sends hunters; the meter stays empty while they hunt you.
        let hunted: HashSet<String> = self.boss_quarry.values().cloned().collect();
        let now = self.game_time;
        let mut campers = Vec::new();
        for p in self.players.values_mut() {
            if p.health <= 0.0 { continue; }
            let track = self.camp_track.entry(p.id.clone()).or_default();
            if track.back().is_none_or(|(t, _, _)| now - t >= 1.0) { track.push_back((now, p.pos.x, p.pos.y)); }
            while track.front().is_some_and(|(t, _, _)| now - t > CAMP_WINDOW) { track.pop_front(); }
            let settled = track.iter().all(|(_, x, y)| f64::hypot(p.pos.x - x, p.pos.y - y) <= CAMP_RADIUS);
            if hunted.contains(&p.id) {
                p.camp = 0.0;
            } else if settled {
                p.camp = (p.camp + dt).min(CAMP_LIMIT);
            } else {
                p.camp = (p.camp - dt * 2.0).max(0.0);
            }
            if p.camp >= CAMP_LIMIT && !hunted.contains(&p.id) && self.hunts_sent.get(&p.id).copied().unwrap_or(0) < MAX_HUNTS {
                campers.push(p.id.clone());
            }
        }
        for id in campers {
            // If nothing could be sent (no open spot this tick), the meter stays
            // full and it tries again next tick. Once a player's hunts are used up
            // the meter just rests at full.
            let exhausted = self.hunts_sent.get(&id).copied().unwrap_or(0) >= MAX_HUNTS;
            if self.spawn_boss_for(&id) || exhausted {
                if let Some(p) = self.players.get_mut(&id) { p.camp = if exhausted { CAMP_LIMIT } else { 0.0 }; }
            }
        }

        // Claymores trigger on nearby enemies
        for pl in &mut self.placeables {
            if pl.item_type == PlaceableType::Mine && pl.health > 0.0
                && self.zombies.iter().any(|z| z.health > 0.0 && f64::hypot(z.pos.x - pl.pos.x, z.pos.y - pl.pos.y) < MINE_TRIGGER_RADIUS) {
                pl.health = 0.0;
                explosions.push(ExplosionEvent { x: pl.pos.x, y: pl.pos.y, radius: MINE_EXPLOSION_RADIUS, damage: MINE_DAMAGE * map.enemy_health, owner_id: pl.owner_id.clone() });
            }
        }

        // ---------- Enemies ----------
        let player_positions: HashMap<String, (f64, f64)> = self.players.values()
            .filter(|p| p.health > 0.0).map(|p| (p.id.clone(), (p.pos.x, p.pos.y))).collect();
        let mut bullet_kill_indices: Vec<usize> = Vec::new();
        let mut kill_awards: Vec<(String, f64)> = Vec::new();
        let mut damage_to_players: Vec<(String, DamageHit)> = Vec::new();

        for zi in (0..self.zombies.len()).rev() {
            let (zx, zy, z_speed) = (self.zombies[zi].pos.x, self.zombies[zi].pos.y, self.zombies[zi].speed);
            let zid_hash = self.zombies[zi].id.as_bytes().iter().fold(0u64, |a, &b| a.wrapping_mul(31).wrapping_add(b as u64));

            // Nearest player within aggro range; otherwise wander.
            let mut target: Option<(String, f64, f64)> = None;
            let mut nearest = ZOMBIE_AGGRO_RANGE;
            for pr in self.player_grid.query(zx, zy, ZOMBIE_AGGRO_RANGE) {
                let d = f64::hypot(pr.x - zx, pr.y - zy);
                if d < nearest { nearest = d; target = Some((pr.id.clone(), pr.x, pr.y)); }
            }
            // An uplink at work is heard from much further away.
            if target.is_none() {
                let mut nearest = UPLINK_ALERT_RANGE;
                for (id, x, y) in &self.decrypt_noise {
                    let d = f64::hypot(x - zx, y - zy);
                    if d < nearest { nearest = d; target = player_positions.get(id).map(|(px, py)| (id.clone(), *px, *py)); }
                }
            }
            // An Abomination hunts its camper from anywhere on the map.
            if let Some(quarry) = self.boss_quarry.get(&self.zombies[zi].id) {
                if let Some((qx, qy)) = player_positions.get(quarry) {
                    target = Some((quarry.clone(), *qx, *qy));
                }
            }

            let z_type = self.zombies[zi].zombie_type.clone();
            let (move_dx, move_dy, speed_scale, tx, ty) = if let Some((_, tx, ty)) = &target {
                let (tdx, tdy) = (tx - zx, ty - zy);
                let tdist = (tdx * tdx + tdy * tdy).sqrt().max(1e-6);
                let (mut mdx, mut mdy) = (tdx / tdist, tdy / tdist);
                let mut scale = 1.0;
                match z_type {
                    ZombieType::Crawler => {
                        let phase = (self.game_time * 8.0 + zid_hash as f64 * 0.1).sin() * 0.7;
                        let (perp_x, perp_y) = (-mdy, mdx);
                        mdx += perp_x * phase;
                        mdy += perp_y * phase;
                        let l = (mdx * mdx + mdy * mdy).sqrt();
                        if l > 0.0 { mdx /= l; mdy /= l; }
                    }
                    ZombieType::Devil => {
                        if (self.game_time + zid_hash as f64 * 0.3) % 2.0 < 0.3 { scale = 1.55; }
                    }
                    ZombieType::Vampire => {
                        let dir = if zid_hash % 2 == 0 { 1.0 } else { -1.0 };
                        if tdist < 200.0 {
                            let (px_, py_) = (-mdy * dir, mdx * dir);
                            mdx = mdx * 0.3 + px_ * 0.7;
                            mdy = mdy * 0.3 + py_ * 0.7;
                            let l = (mdx * mdx + mdy * mdy).sqrt();
                            if l > 0.0 { mdx /= l; mdy /= l; }
                        } else {
                            let off: f64 = 0.5 * dir;
                            let (c, s) = (off.cos(), off.sin());
                            (mdx, mdy) = (mdx * c - mdy * s, mdx * s + mdy * c);
                        }
                    }
                    _ => {}
                }
                (mdx, mdy, scale, *tx, *ty)
            } else {
                // Idle: shamble around the home nest, drifting back if strayed too far.
                let home = self.zombie_home.get(&self.zombies[zi].id).and_then(|&i| self.layout.nests.get(i));
                match home {
                    Some(n) if f64::hypot(n.x - zx, n.y - zy) > NEST_LEASH => {
                        let d = f64::hypot(n.x - zx, n.y - zy);
                        ((n.x - zx) / d, (n.y - zy) / d, 0.45, n.x, n.y)
                    }
                    _ => {
                        let heading = (zid_hash % 628) as f64 / 100.0 + (self.game_time * 0.15 + zid_hash as f64 * 0.01).sin() * 1.2;
                        (heading.cos(), heading.sin(), 0.3, zx, zy)
                    }
                }
            };

            {
                let z = &mut self.zombies[zi];
                z.pos.x = clampz(z.pos.x + move_dx * z_speed * speed_scale * dt, map_w);
                z.pos.y = clampz(z.pos.y + move_dy * z_speed * speed_scale * dt, map_h);

                // Barricades block and hurt enemies
                for pl in &mut self.placeables {
                    if pl.item_type != PlaceableType::Barricade || pl.health <= 0.0 { continue; }
                    let (bdx, bdy) = (z.pos.x - pl.pos.x, z.pos.y - pl.pos.y);
                    let bdist = (bdx * bdx + bdy * bdy).sqrt();
                    let min_d = ZOMBIE_RADIUS + BARRICADE_RADIUS;
                    if bdist < min_d {
                        if bdist > 0.001 {
                            let overlap = min_d - bdist;
                            z.pos.x += (bdx / bdist) * overlap;
                            z.pos.y += (bdy / bdist) * overlap;
                        }
                        pl.health -= 22.0 * dt;
                        z.health -= BARRICADE_CONTACT_DAMAGE * dt;
                        if z.health <= 0.0 && !zombie_kill_indices.contains(&zi) {
                            kill_awards.push((pl.owner_id.clone(), kill_bounty(z)));
                            zombie_kill_indices.push(zi);
                        }
                    }
                }
            }

            // Walls: brutes and crawlers push through; the rest steer around.
            if !matches!(z_type, ZombieType::Brute | ZombieType::Crawler | ZombieType::Abomination) {
                let (cur_x, cur_y) = (self.zombies[zi].pos.x, self.zombies[zi].pos.y);
                let (nx, ny) = resolve_wall_collisions(cur_x, cur_y, ZOMBIE_RADIUS, &self.wall_grid);
                let blocked = (nx - cur_x).abs() > 0.1 || (ny - cur_y).abs() > 0.1;
                let zid = self.zombies[zi].id.clone();
                if blocked {
                    let entry = self.zombie_wall_stuck.entry(zid).or_insert((0.0, 0.0));
                    entry.0 += dt;
                    if entry.0 < 0.3 {
                        self.zombies[zi].pos.x = nx;
                        self.zombies[zi].pos.y = ny;
                    } else {
                        if entry.1 == 0.0 {
                            let dot1 = -move_dy * (tx - zx) + move_dx * (ty - zy);
                            let dot2 = move_dy * (tx - zx) - move_dx * (ty - zy);
                            entry.1 = if dot1 >= dot2 { 1.0 } else { -1.0 };
                        }
                        let steer = entry.1;
                        let (cdx, cdy) = (-move_dy * steer * 0.8 + move_dx * 0.2, move_dx * steer * 0.8 + move_dy * 0.2);
                        let cl = (cdx * cdx + cdy * cdy).sqrt().max(1e-6);
                        let sx = clampz(zx + cdx / cl * z_speed * 0.5 * dt, map_w);
                        let sy = clampz(zy + cdy / cl * z_speed * 0.5 * dt, map_h);
                        let (cnx, cny) = resolve_wall_collisions(sx, sy, ZOMBIE_RADIUS, &self.wall_grid);
                        self.zombies[zi].pos.x = cnx;
                        self.zombies[zi].pos.y = cny;
                    }
                } else {
                    self.zombie_wall_stuck.remove(&zid);
                    self.zombies[zi].pos.x = nx;
                    self.zombies[zi].pos.y = ny;
                }
            }

            // Melee attack on the target (dash i-frames make you immune)
            if let Some((target_id, tx, ty)) = &target {
                let z = &self.zombies[zi];
                let dist_to_target = f64::hypot(tx - z.pos.x, ty - z.pos.y);
                if z.health > 0.0 && dist_to_target < ZOMBIE_ATTACK_RANGE + zombie_radius(z) - ZOMBIE_RADIUS
                    && self.dash_iframes.get(target_id).copied().unwrap_or(0.0) <= 0.0 {
                    let cd = self.zombie_attack_cooldowns.entry(z.id.clone()).or_insert(0.0);
                    if *cd <= 0.0 {
                        let type_mult = match z.zombie_type { ZombieType::Abomination => 3.0, ZombieType::Brute => 2.0, ZombieType::Vampire => 0.8, _ => 1.0 };
                        let damage = (ZOMBIE_DAMAGE * type_mult * map.enemy_damage * if z.elite { ELITE_DAMAGE } else { 1.0 }).round();
                        *cd = match z.zombie_type {
                            ZombieType::Crawler => ZOMBIE_ATTACK_COOLDOWN * 0.5,
                            ZombieType::Brute => ZOMBIE_ATTACK_COOLDOWN * 1.5,
                            ZombieType::Abomination => ZOMBIE_ATTACK_COOLDOWN * 1.2,
                            _ => ZOMBIE_ATTACK_COOLDOWN,
                        };
                        damage_to_players.push((target_id.clone(), DamageHit {
                            source: z.zombie_type.clone(), enemy_id: z.id.clone(), damage,
                            health_after: 0.0, distance: dist_to_target, time: self.game_time,
                        }));
                        if z.zombie_type == ZombieType::Vampire {
                            let z = &mut self.zombies[zi];
                            z.health = (z.health + 15.0 * map.enemy_health).min(z.max_health);
                        }
                    }
                }
            }

            // Bullet hits
            for bi in (0..self.bullets.len()).rev() {
                if bullet_kill_indices.contains(&bi) || zombie_kill_indices.contains(&zi) { continue; }
                let b = &self.bullets[bi];
                let z = &self.zombies[zi];
                let hit_r = zombie_radius(z) + BULLET_RADIUS;
                if f64::hypot(b.pos.x - z.pos.x, b.pos.y - z.pos.y) >= hit_r { continue; }
                let (damage, owner_id, is_rocket, ix, iy, vx, vy) = (b.damage, b.owner_id.clone(), b.is_rocket, b.pos.x, b.pos.y, b.vel.x, b.vel.y);
                bullet_kill_indices.push(bi);
                if is_rocket {
                    explosions.push(ExplosionEvent { x: ix, y: iy, radius: ROCKET_EXPLOSION_RADIUS, damage, owner_id });
                    break;
                }
                self.zombies[zi].health -= damage;
                let b_speed = (vx * vx + vy * vy).sqrt();
                if b_speed > 0.0 {
                    let kb = if damage >= 25.0 { 10.0 } else { 5.0 };
                    let z = &mut self.zombies[zi];
                    z.pos.x = clampz(z.pos.x + vx / b_speed * kb, map_w);
                    z.pos.y = clampz(z.pos.y + vy / b_speed * kb, map_h);
                    if !matches!(z.zombie_type, ZombieType::Brute | ZombieType::Crawler | ZombieType::Abomination) {
                        let (nx, ny) = resolve_wall_collisions(z.pos.x, z.pos.y, ZOMBIE_RADIUS, &self.wall_grid);
                        z.pos.x = nx;
                        z.pos.y = ny;
                    }
                }
                if self.zombies[zi].health <= 0.0 {
                    let z = &self.zombies[zi];
                    kill_awards.push((owner_id, kill_bounty(z)));
                    zombie_kill_indices.push(zi);
                    break;
                }
            }
        }

        // Explosions, including chain reactions with barrels and claymores
        let mut processed_placeables = HashSet::new();
        while let Some(exp) = explosions.pop() {
            for (zi, z) in self.zombies.iter_mut().enumerate() {
                if z.health <= 0.0 { continue; }
                let (dx, dy) = (z.pos.x - exp.x, z.pos.y - exp.y);
                let dist = (dx * dx + dy * dy).sqrt();
                if dist >= exp.radius { continue; }
                // Full damage at the centre, 40% at the edge.
                z.health -= exp.damage * (1.0 - 0.6 * dist / exp.radius);
                if dist > 0.0 {
                    let kb = 60.0 * (1.0 - dist / exp.radius).max(0.35);
                    z.pos.x = clampz(z.pos.x + dx / dist * kb, map_w);
                    z.pos.y = clampz(z.pos.y + dy / dist * kb, map_h);
                }
                if z.health <= 0.0 && !zombie_kill_indices.contains(&zi) {
                    kill_awards.push((exp.owner_id.clone(), kill_bounty(z)));
                    zombie_kill_indices.push(zi);
                }
            }
            for pl in &mut self.placeables {
                if pl.health <= 0.0 || processed_placeables.contains(&pl.id) { continue; }
                if f64::hypot(pl.pos.x - exp.x, pl.pos.y - exp.y) >= exp.radius { continue; }
                match pl.item_type {
                    PlaceableType::Barrel | PlaceableType::Mine => {
                        let (radius, damage) = if pl.item_type == PlaceableType::Barrel { (BARREL_EXPLOSION_RADIUS, BARREL_DAMAGE) } else { (MINE_EXPLOSION_RADIUS, MINE_DAMAGE) };
                        let damage = damage * map.enemy_health;
                        pl.health = 0.0;
                        processed_placeables.insert(pl.id.clone());
                        explosions.push(ExplosionEvent { x: pl.pos.x, y: pl.pos.y, radius, damage, owner_id: exp.owner_id.clone() });
                    }
                    PlaceableType::Barricade => pl.health -= exp.damage * 0.35,
                }
            }
        }
        self.placeables.retain(|pl| pl.health > 0.0);

        for cd in self.zombie_attack_cooldowns.values_mut() { *cd -= dt; }

        // Damage to players
        let others_alive = |players: &HashMap<String, Player>, id: &str| players.values().any(|p| p.id != id && p.health > 0.0);
        for (pid, mut hit) in damage_to_players {
            let alone = !others_alive(&self.players, &pid);
            if let Some(p) = self.players.get_mut(&pid) {
                if p.health <= 0.0 { continue; }
                p.health = (p.health - hit.damage).max(0.0);
                hit.health_after = p.health;
                p.damage_log.retain(|previous| hit.time - previous.time <= 15.0);
                p.damage_log.push(hit);
                if p.damage_log.len() > 32 { p.damage_log.remove(0); }
                if p.health <= 0.0 {
                    p.bleedout = if alone { BLEEDOUT_ALONE } else { BLEEDOUT_TIME };
                    p.extract_progress = 0.0;
                    p.decrypt = 0.0;
                    p.combo = 0;
                }
            }
        }

        for (pid, bounty) in &kill_awards {
            if let Some(p) = self.players.get_mut(pid) {
                award_kill_to_player(p, *bounty, map.bounty_mult);
            }
        }

        // Remove dead enemies and roll their drops
        zombie_kill_indices.sort_unstable();
        zombie_kill_indices.dedup();
        for &zi in zombie_kill_indices.iter().rev() {
            if zi < self.zombies.len() {
                let z = self.zombies[zi].clone();
                Self::roll_kill_drops(map, &z, self.game_time, &mut new_drops);
                self.zombie_attack_cooldowns.remove(&z.id);
                self.zombie_wall_stuck.remove(&z.id);
                self.zombie_home.remove(&z.id);
                self.boss_quarry.remove(&z.id);
                self.zombies.swap_remove(zi);
            }
        }

        bullet_kill_indices.sort_unstable();
        bullet_kill_indices.dedup();
        for &bi in bullet_kill_indices.iter().rev() {
            if bi < self.bullets.len() {
                self.bullet_lifetimes.remove(&self.bullets[bi].id);
                self.bullets.swap_remove(bi);
            }
        }

        // Cull enemies nobody is near (they don't count as kills)
        if !living.is_empty() {
            let quarry = &self.boss_quarry;
            let far = |z: &Zombie| !quarry.contains_key(&z.id) && living.iter().all(|(x, y)| f64::hypot(x - z.pos.x, y - z.pos.y) > ZOMBIE_DESPAWN_RANGE);
            let culled: Vec<String> = self.zombies.iter().filter(|z| far(z)).map(|z| z.id.clone()).collect();
            if !culled.is_empty() {
                for id in &culled {
                    self.zombie_home.remove(id);
                    self.zombie_attack_cooldowns.remove(id);
                    self.zombie_wall_stuck.remove(id);
                }
                self.zombies.retain(|z| !far(z));
            }
        }

        self.drops.extend(new_drops);
        let now = self.game_time;
        self.drops.retain(|d| d.despawn_at > now);

        // A boss whose camper is gone (extracted, dead or left) becomes an ordinary monster.
        // Hunters keep their target while they're downed (no shaking one off with a
        // quick down-and-revive); they're released once the target leaves the raid.
        let players = &self.players;
        self.boss_quarry.retain(|_, q| players.contains_key(q));
        let hunted: HashSet<String> = self.boss_quarry.values().cloned().collect();
        for p in self.players.values_mut() { p.hunted = hunted.contains(&p.id); }

        // ---------- Raid clock, extraction, downed players ----------
        let mut finished: Vec<(String, RaidResult, Option<String>)> = Vec::new();
        let alive_positions: Vec<(String, f64, f64)> = self.players.values()
            .filter(|p| p.health > 0.0).map(|p| (p.id.clone(), p.pos.x, p.pos.y)).collect();
        let mut noise = Vec::new();
        let mut decrypt_rng = rand::rng();
        for p in self.players.values_mut() {
            p.raid_time = (p.raid_time - dt).max(0.0);
            if p.raid_time <= 0.0 {
                finished.push((p.id.clone(), RaidResult::MissingInAction, None));
                continue;
            }
            if p.health > 0.0 {
                // Standing at an uplink decrypts sealed loot one item at a time.
                let at_uplink = self.layout.uplinks.iter().any(|u| f64::hypot(u.x - p.pos.x, u.y - p.pos.y) < u.radius);
                match (at_uplink, p.backpack.iter().position(|i| i.kind == ItemKind::Encrypted)) {
                    (true, Some(idx)) => {
                        p.decrypt += dt;
                        noise.push((p.id.clone(), p.pos.x, p.pos.y));
                        if p.decrypt >= gear::decrypt_secs(p.backpack[idx].rarity) {
                            p.backpack[idx] = gear::decrypt(&mut decrypt_rng, &p.backpack[idx]);
                            p.decrypt = 0.0;
                        }
                    }
                    _ => p.decrypt = 0.0,
                }
                let zone = self.layout.extracts.iter().find(|e| f64::hypot(e.x - p.pos.x, e.y - p.pos.y) < e.radius);
                match zone {
                    Some(e) => {
                        p.extract_progress = (p.extract_progress + dt).min(EXTRACT_TIME);
                        if p.extract_progress >= EXTRACT_TIME {
                            finished.push((p.id.clone(), RaidResult::Extracted, Some(e.name.clone())));
                        }
                    }
                    None => p.extract_progress = 0.0,
                }
                continue;
            }

            // Downed: a squadmate standing close revives you; otherwise you bleed out.
            let reviver = alive_positions.iter()
                .find(|(aid, ax, ay)| *aid != p.id && f64::hypot(ax - p.pos.x, ay - p.pos.y) < REVIVE_RANGE)
                .map(|(aid, _, _)| aid.clone());
            match reviver {
                Some(reviver_id) => {
                    let entry = self.revive_progress.entry(p.id.clone()).or_insert((reviver_id.clone(), 0.0));
                    if entry.0 != reviver_id { *entry = (reviver_id, 0.0); }
                    entry.1 += dt;
                    if entry.1 >= REVIVE_TIME {
                        p.health = (p.max_health * REVIVE_FRACTION).round();
                        p.bleedout = 0.0;
                        p.damage_log.clear();
                        self.revive_progress.remove(&p.id);
                    }
                }
                None => {
                    self.revive_progress.remove(&p.id);
                    if alive_positions.iter().all(|(aid, _, _)| *aid == p.id) {
                        p.bleedout = p.bleedout.min(BLEEDOUT_ALONE);
                    }
                    p.bleedout = (p.bleedout - dt).max(0.0);
                    if p.bleedout <= 0.0 {
                        finished.push((p.id.clone(), RaidResult::Killed, None));
                    }
                }
            }
        }
        self.decrypt_noise = noise;
        for (id, result, extract) in finished {
            self.finish_raid(&id, result, extract);
        }
    }

    fn roll_kill_drops(map: &MapDef, z: &Zombie, game_time: f64, out: &mut Vec<DropInternal>) {
        if let Some(d) = roll_supply_drop(&z.zombie_type, z.pos.x, z.pos.y, game_time) {
            out.push(d);
        }
        let mut rng = rand::rng();
        if z.zombie_type == ZombieType::Abomination {
            // The reward for surviving one: a lucky piece of gear, a valuable and a sealed prize.
            for i in 0..3 {
                let item = match i {
                    0 => gear::roll_gear(&mut rng, map, 2.0),
                    1 => gear::roll_valuable(&mut rng, map, 2.0),
                    _ => { let prize = gear::roll_gear(&mut rng, map, 2.5); gear::seal(&mut rng, &prize) }
                };
                let a = i as f64 * 2.1;
                out.push(loot_drop(item, z.pos.x + a.cos() * 30.0, z.pos.y + a.sin() * 30.0, game_time));
            }
            return;
        }
        let elite = z.elite && z.target.is_none();
        // Fights are worth more on harder maps: +35% loot chance per tier above 1.
        let tier_bonus = 1.0 + (map.tier as f64 - 1.0) * 0.35;
        if rng.random::<f64>() < (gear::enemy_loot_chance(&z.zombie_type, elite) * tier_bonus).min(0.95) {
            let luck = if elite { 1.5 } else { 0.0 };
            let item = if rng.random::<f64>() < 0.6 { gear::roll_gear(&mut rng, map, luck) } else { gear::roll_valuable(&mut rng, map, luck) };
            let item = gear::maybe_seal(&mut rng, map.tier, item);
            out.push(loot_drop(item, z.pos.x + 10.0, z.pos.y - 8.0, game_time));
        }
    }

    // ---- Getters ----

    pub fn players(&self) -> &HashMap<String, Player> { &self.players }

    pub fn zombies(&self) -> &[Zombie] { &self.zombies }

    pub fn bullets(&self) -> &[Bullet] { &self.bullets }

    pub fn placeables(&self) -> &[Placeable] { &self.placeables }

    pub fn drops(&self) -> Vec<DropPickup> {
        self.drops.iter().map(|d| DropPickup {
            id: d.id.clone(),
            drop_type: d.drop_type.clone(),
            pos: Vector2 { x: d.x, y: d.y },
            item: d.item.clone(),
        }).collect()
    }

    pub fn layout(&self) -> &MapLayout { &self.layout }

    pub fn ammo_availability(&self) -> Vec<AmmoPickupState> {
        self.ammo_pickups.iter().map(|p| AmmoPickupState { id: p.id.clone(), available: p.respawn_at.is_none() }).collect()
    }

    pub fn crate_availability(&self) -> Vec<AmmoPickupState> {
        self.crates.iter().map(|c| AmmoPickupState { id: c.id.clone(), available: c.respawn_at.is_none() }).collect()
    }

    pub fn ammo_spawn_points(&self) -> Vec<AmmoSpawnPoint> {
        self.ammo_pickups.iter().map(|p| AmmoSpawnPoint { x: p.x, y: p.y, amount: p.amount as f64 }).collect()
    }

    pub fn map_info(&self) -> MapInfo {
        MapInfo {
            id: self.map.id.into(), name: self.map.name.into(), tier: self.map.tier,
            min_gear_score: self.map.min_gear_score, raid_secs: self.map.raid_secs,
        }
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use crate::gear::{ItemKind, Rarity, Slot};

    pub fn kit(weapon: u32, armor: u32, pack: u32) -> Loadout {
        let mut l = Loadout::default();
        l.set(Slot::Primary, Some(Item::new(ItemKind::Pistol, Rarity::Common, weapon, None)));
        l.set(Slot::Armor, Some(Item::new(ItemKind::Armor, Rarity::Common, armor, None)));
        l.set(Slot::Pack, Some(Item::new(ItemKind::Pack, Rarity::Common, pack, None)));
        l
    }

    pub fn game() -> Game { Game::new(crate::gear::default_map()) }

    impl Game {
        /// Test hook: down every player.
        pub fn down_all_players(&mut self) {
            for p in self.players.values_mut() { p.health = 0.0; p.bleedout = BLEEDOUT_ALONE; }
        }
        pub fn player_mut(&mut self, id: &str) -> &mut Player { self.players.get_mut(id).unwrap() }
        pub fn push_zombie(&mut self, z: Zombie) { self.zombies.push(z); }
        pub fn clear_zombies(&mut self) { self.zombies.clear(); self.zombie_spawn_timer = 1e9; }
        pub fn drop_loot_at(&mut self, item: Item, x: f64, y: f64) { let t = self.game_time; self.drops.push(loot_drop(item, x, y, t)); }
        pub fn time(&self) -> f64 { self.game_time }
        pub fn input_count(&self) -> usize { self.inputs.len() }
    }

    pub fn enemy(id: &str, kind: ZombieType, x: f64, y: f64, health: f64, speed: f64) -> Zombie {
        Zombie { id: id.into(), zombie_type: kind, pos: Vector2 { x, y }, health, max_health: health, speed, elite: false, target: None }
    }

    pub fn idle_input() -> ClientInput {
        serde_json::from_value(serde_json::json!({
            "up":false,"down":false,"left":false,"right":false,"mouseX":0,"mouseY":0,"shooting":false,"melee":false,"selectWeapon":0,
        })).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::gear::{ItemKind, Rarity, MAPS};

    /// Put a player somewhere open, away from extracts, with nothing around.
    fn isolate(game: &mut Game, id: &str) -> (f64, f64) {
        game.clear_zombies();
        let spot = game.layout.insertions[0].clone();
        let p = game.player_mut(id);
        p.pos = Vector2 { x: spot.x, y: spot.y };
        (spot.x, spot.y)
    }

    #[test]
    fn loadout_sets_health_ammo_pack_and_gear_score() {
        let mut game = game();
        game.add_player("p", "P", &kit(40, 50, 60));
        let p = &game.players()["p"];
        assert_eq!(p.max_health, gear::armor_max_health(50));
        assert_eq!(p.health, p.max_health);
        assert_eq!(p.max_ammo, gear::pack_max_ammo(60));
        assert_eq!(p.backpack_capacity, gear::pack_capacity(60));
        assert_eq!(p.gear_score, (40 + 50 + 60) / 4);
        assert_eq!(p.weapons.len(), 1);
        assert_eq!(p.weapons[0].power, 40);
        assert_eq!(p.raid_time, game.map().raid_secs);
    }

    #[test]
    fn an_empty_loadout_deploys_with_a_loaner_pistol() {
        let mut game = game();
        game.add_player("p", "P", &Loadout::default());
        let p = &game.players()["p"];
        assert_eq!(p.weapon, Weapon::Pistol);
        assert_eq!(p.weapons[0].name, "Loaner Pistol");
        assert_eq!(p.gear_score, 0);
        assert_eq!(p.max_health, 100.0);
    }

    #[test]
    fn players_spawn_at_insertion_points_and_squads_share_one() {
        let mut game = game();
        game.add_player("a", "A", &kit(5, 5, 5));
        game.add_player("b", "B", &kit(5, 5, 5));
        let (a, b) = (&game.players()["a"].pos, &game.players()["b"].pos);
        assert!(f64::hypot(a.x - b.x, a.y - b.y) < 120.0, "squad deployed together");
        assert!(!game.layout.blocked(a.x, a.y, PLAYER_RADIUS - 1.0));
    }

    #[test]
    fn second_weapon_is_selected_with_key_two() {
        let mut game = game();
        let mut l = kit(10, 5, 5);
        l.secondary = Some(Item::new(ItemKind::Shotgun, Rarity::Rare, 30, None));
        game.add_player("p", "P", &l);
        let mut input = idle_input();
        input.select_weapon = 2;
        game.handle_input("p", input);
        game.update(1.0 / 60.0);
        let p = &game.players()["p"];
        assert_eq!(p.weapon, Weapon::Shotgun);
        assert_eq!(p.active_slot, 1);
    }

    #[test]
    fn weapon_power_scales_bullet_damage() {
        let shot = |power: u32| {
            let mut game = game();
            game.add_player("p", "P", &kit(power, 5, 5));
            isolate(&mut game, "p");
            let mut input = idle_input();
            input.shooting = true;
            input.mouse_x = 99999.0;
            game.handle_input("p", input);
            game.update(1.0 / 60.0);
            let b = &game.bullets()[0];
            if b.is_crit { b.damage / CRIT_DAMAGE_MULT } else { b.damage }
        };
        assert!((shot(50) / shot(1) - gear::weapon_damage_mult(50) / gear::weapon_damage_mult(1)).abs() < 0.05);
    }

    #[test]
    fn standing_in_an_extract_zone_extracts_with_loot_and_bounty() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.clear_zombies();
        let e = game.layout.extracts[0].clone();
        let item = Item::new(ItemKind::Valuable, Rarity::Epic, 30, Some("Gold Watch".into()));
        {
            let p = game.player_mut("p");
            p.pos = Vector2 { x: e.x, y: e.y };
            p.backpack.push(item.clone());
            p.bounty = 120.0;
        }
        for _ in 0..((EXTRACT_TIME - 0.5) * 60.0) as usize { game.update(1.0 / 60.0); }
        assert!(game.players().contains_key("p"), "not yet: extraction takes {EXTRACT_TIME}s");
        assert!(game.players()["p"].extract_progress > EXTRACT_TIME - 1.0);
        for _ in 0..60 { game.update(1.0 / 60.0); }
        assert!(!game.players().contains_key("p"), "extracted players leave the raid");
        let outcomes = game.take_outcomes();
        assert_eq!(outcomes.len(), 1);
        let o = &outcomes[0];
        assert_eq!(o.result, RaidResult::Extracted);
        assert_eq!(o.extract_name.as_deref(), Some(e.name.as_str()));
        assert_eq!(o.loot, vec![item]);
        assert_eq!(o.bounty, 120);
        assert!(game.take_outcomes().is_empty(), "outcomes are reported once");
    }

    #[test]
    fn leaving_the_extract_zone_resets_the_countdown() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.clear_zombies();
        let e = game.layout.extracts[0].clone();
        game.player_mut("p").pos = Vector2 { x: e.x, y: e.y };
        for _ in 0..120 { game.update(1.0 / 60.0); }
        assert!(game.players()["p"].extract_progress > 1.5);
        isolate(&mut game, "p");
        game.update(1.0 / 60.0);
        assert_eq!(game.players()["p"].extract_progress, 0.0);
    }

    #[test]
    fn dying_alone_ends_the_raid_and_loses_everything() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "p");
        {
            let p = game.player_mut("p");
            p.health = 10.0;
            p.bounty = 500.0;
            p.backpack.push(Item::new(ItemKind::Uzi, Rarity::Rare, 25, None));
        }
        game.push_zombie(enemy("brute", ZombieType::Brute, x + 20.0, y, 1000.0, 0.0));
        game.update(1.0 / 60.0);
        assert_eq!(game.players()["p"].health, 0.0);
        assert!(game.players()["p"].bleedout <= BLEEDOUT_ALONE, "nobody can revive a solo player");
        for _ in 0..(BLEEDOUT_ALONE * 60.0) as usize + 5 { game.update(1.0 / 60.0); }
        let o = game.take_outcomes().pop().expect("raid ended");
        assert_eq!(o.result, RaidResult::Killed);
        assert_eq!(o.killed_by, Some(ZombieType::Brute));
        assert!(o.loot.is_empty(), "the dead keep nothing");
        assert_eq!(o.bounty, 500, "the bounty they lost is reported (it is not banked)");
        assert_eq!(o.kills, 0);
    }

    #[test]
    fn a_squadmate_can_revive_a_downed_player_before_they_bleed_out() {
        let mut game = game();
        game.add_player("a", "A", &kit(5, 5, 5));
        game.add_player("b", "B", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "a");
        game.player_mut("b").pos = Vector2 { x: x + 30.0, y };
        {
            let a = game.player_mut("a");
            a.health = 0.0;
            a.bleedout = BLEEDOUT_TIME;
        }
        for _ in 0..(REVIVE_TIME * 60.0) as usize + 5 { game.update(1.0 / 60.0); }
        let a = &game.players()["a"];
        assert_eq!(a.health, (a.max_health * REVIVE_FRACTION).round());
        assert_eq!(a.bleedout, 0.0);
        assert!(game.take_outcomes().is_empty());
    }

    #[test]
    fn running_out_of_raid_time_is_missing_in_action() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        isolate(&mut game, "p");
        game.player_mut("p").raid_time = 0.5;
        game.player_mut("p").bounty = 300.0;
        for _ in 0..40 { game.update(1.0 / 60.0); }
        let o = game.take_outcomes().pop().unwrap();
        assert_eq!(o.result, RaidResult::MissingInAction);
        assert!(o.loot.is_empty());
    }

    #[test]
    fn abandoning_forfeits_and_only_reports_live_raids() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.player_mut("p").bounty = 50.0;
        let o = game.abandon("p").unwrap();
        assert_eq!(o.result, RaidResult::Abandoned);
        assert!(game.abandon("p").is_none(), "already gone");
    }

    #[test]
    fn walking_over_loot_fills_the_backpack_then_swaps_for_better() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 0)); // pack power 0: 4 slots
        let (x, y) = isolate(&mut game, "p");
        game.handle_input("p", idle_input());
        for i in 0..4 { game.drop_loot_at(Item::new(ItemKind::Valuable, Rarity::Common, 1 + i, Some("Junk".into())), x, y); }
        game.update(1.0 / 60.0);
        assert_eq!(game.players()["p"].backpack.len(), 4);

        let cheap = Item::new(ItemKind::Valuable, Rarity::Common, 1, Some("Scrap".into()));
        game.drop_loot_at(cheap, x, y);
        game.update(1.0 / 60.0);
        assert_eq!(game.drops().len(), 1, "worse loot stays on the ground when the pack is full");

        let gem = Item::new(ItemKind::Valuable, Rarity::Legendary, 50, Some("Rare Coins".into()));
        game.drop_loot_at(gem.clone(), x, y);
        game.update(1.0 / 60.0);
        let p = &game.players()["p"];
        assert!(p.backpack.contains(&gem), "the better item was swapped in");
        assert_eq!(p.backpack.len(), 4);
        assert_eq!(game.drops().len(), 2, "the cheapest item was put down");
        for _ in 0..30 { game.update(1.0 / 60.0); }
        assert_eq!(game.players()["p"].backpack.len(), 4, "no ping-pong pickups");
    }

    #[test]
    fn opening_a_crate_spills_loot_and_the_crate_restocks_later() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.clear_zombies();
        let c = game.layout.crates[0].clone();
        game.player_mut("p").pos = Vector2 { x: c.x, y: c.y };
        game.handle_input("p", idle_input());
        game.update(1.0 / 60.0);
        assert!(!game.crate_availability()[0].available);
        let loot = game.drops().iter().filter(|d| d.drop_type == DropType::Loot).count();
        let picked = game.players()["p"].backpack.len();
        assert!(loot + picked >= 1, "a crate holds at least one item");
        game.crates[0].respawn_at = Some(game.time() + 0.01);
        game.update(1.0 / 60.0);
        assert!(game.crate_availability()[0].available);
    }

    #[test]
    fn monsters_pour_out_of_nests_near_players_and_nowhere_else() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.clear_zombies();
        let nest = game.layout.nests[0].clone();
        // Stand a block away from the first nest, out of its monsters' aggro for a moment.
        game.player_mut("p").pos = Vector2 { x: nest.x + 320.0, y: nest.y };
        game.zombie_spawn_timer = 0.0;
        for _ in 0..60 * 20 {
            game.player_mut("p").pos = Vector2 { x: nest.x + 320.0, y: nest.y };
            game.player_mut("p").health = 1e6; // keep the observer alive
            game.update(1.0 / 60.0);
        }
        assert!(!game.zombies().is_empty(), "an active nest spawns");
        let per_nest = 5 + game.map().tier as usize * 2;
        let homes: Vec<usize> = game.zombie_home.values().copied().collect();
        for i in 0..game.layout.nests.len() {
            let n = &game.layout.nests[i];
            let count = homes.iter().filter(|&&h| h == i).count();
            assert!(count <= per_nest, "nest {i} over its cap ({count})");
            if f64::hypot(n.x - nest.x - 320.0, n.y - nest.y) > NEST_ACTIVE_RANGE {
                assert_eq!(count, 0, "a nest with nobody near stays quiet");
            }
        }
    }

    #[test]
    fn nests_are_unbreakable_walls() {
        let game = game();
        for n in &game.layout.nests {
            assert!(game.layout.blocked(n.x, n.y, 1.0), "bullets and players are stopped by the nest core");
        }
    }

    #[test]
    fn camping_sends_an_abomination_after_the_camper_only() {
        let mut game = game();
        game.add_player("camper", "C", &kit(5, 5, 5));
        game.add_player("mover", "M", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "camper");
        game.player_mut("mover").pos = Vector2 { x: x + 100.0, y };
        let frames = (CAMP_LIMIT * 60.0) as usize + 2;
        for f in 0..frames {
            // The mover keeps relocating, so only the camper's meter fills.
            let step = if (f / 60) % 2 == 0 { 0.0 } else { CAMP_RADIUS + 50.0 };
            game.player_mut("mover").pos = Vector2 { x: x + 100.0 + step, y };
            for id in ["camper", "mover"] { game.player_mut(id).health = 1e6; }
            game.update(1.0 / 60.0);
            if f == (CAMP_WARNING * 60.0) as usize + 5 {
                assert!(game.players()["camper"].camp >= CAMP_WARNING, "the meter warns the camper first");
            }
        }
        let bosses: Vec<_> = game.zombies().iter().filter(|z| z.zombie_type == ZombieType::Abomination).collect();
        let quarries: Vec<_> = bosses.iter().map(|b| game.boss_quarry.get(&b.id).cloned()).collect();
        assert_eq!(bosses.len(), 1, "one Abomination for one camper, got {quarries:?}");
        assert_eq!(game.boss_quarry.get(&bosses[0].id).map(String::as_str), Some("camper"));
        assert!(game.players()["camper"].hunted && !game.players()["mover"].hunted);
        assert!(game.players()["camper"].camp < 1.0, "the meter resets once the boss is sent");
        // Camping on while hunted never stacks a second boss.
        for _ in 0..frames { game.player_mut("camper").health = 1e6; game.player_mut("mover").health = 1e6; game.update(1.0 / 60.0); }
        let for_camper = game.boss_quarry.values().filter(|q| *q == "camper").count();
        assert_eq!(for_camper, 1, "a hunted camper never gets a second boss");
    }

    #[test]
    fn the_abomination_hunts_from_anywhere_and_pays_out_on_death() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "p");
        game.update(1.0 / 60.0); // settle the camp anchor where we put the player
        game.player_mut("p").camp = CAMP_LIMIT;
        game.update(1.0 / 60.0);
        let boss_id = game.boss_quarry.keys().next().cloned().expect("boss spawned");
        // Far beyond normal aggro range it still closes in.
        let far = (x + ZOMBIE_AGGRO_RANGE * 2.0).min(game.layout.width - 40.0);
        { let b = game.zombies.iter_mut().find(|z| z.id == boss_id).unwrap(); b.pos = Vector2 { x: far, y }; }
        for _ in 0..60 { game.player_mut("p").health = 1e6; game.update(1.0 / 60.0); }
        let b = game.zombies().iter().find(|z| z.id == boss_id).unwrap();
        assert!(b.pos.x < far - 20.0, "the boss is coming");
        let mut out = Vec::new();
        Game::roll_kill_drops(game.map(), b, 0.0, &mut out);
        assert_eq!(out.iter().filter(|d| d.drop_type == DropType::Loot).count(), 3, "guaranteed loot");
        assert!(make_zombie(game.map(), ZombieType::Abomination, false, 0.0, 0.0).speed >= 140.0, "too fast to simply walk away from");
        assert_eq!(make_zombie(game.map(), ZombieType::Abomination, false, 0.0, 0.0).max_health, 1400.0);
    }

    #[test]
    fn idle_monsters_drift_back_to_their_nest() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        isolate(&mut game, "p");
        let n = game.layout.nests[0].clone();
        // A downed player isn't a target, so the stray has nobody to chase.
        { let p = game.player_mut("p"); p.health = 0.0; p.bleedout = BLEEDOUT_ALONE; }
        game.push_zombie(enemy("stray", ZombieType::Zombie, n.x + NEST_LEASH + 200.0, n.y + 100.0, 50.0, 60.0));
        game.zombie_home.insert("stray".into(), 0);
        let d0 = NEST_LEASH + 200.0;
        for _ in 0..120 { game.update(1.0 / 60.0); }
        if let Some(z) = game.zombies().iter().find(|z| z.id == "stray") {
            assert!(f64::hypot(z.pos.x - n.x, z.pos.y - n.y) < d0 + 100.0 - 20.0, "it walked home");
        }
    }

    #[test]
    fn harder_maps_spawn_tougher_hitting_enemies() {
        let mut rng = rand::rng();
        let walker_t1 = make_zombie(&MAPS[0], ZombieType::Zombie, false, 0.0, 0.0);
        let walker_t4 = make_zombie(&MAPS[3], ZombieType::Zombie, false, 0.0, 0.0);
        assert!(walker_t4.max_health > walker_t1.max_health * 2.5);
        let elite = make_zombie(&MAPS[3], ZombieType::Zombie, true, 0.0, 0.0);
        assert!(elite.max_health > walker_t4.max_health && elite.elite);
        // Brutes and vampires never appear on the first map.
        for _ in 0..2000 {
            let (kind, elite) = roll_zombie(&MAPS[0], &mut rng);
            assert!(!matches!(kind, ZombieType::Brute | ZombieType::Vampire) && !elite);
        }
        let hit = |map: &'static MapDef| {
            let mut game = Game::new(map);
            game.add_player("p", "P", &kit(5, 5, 5));
            let (x, y) = isolate(&mut game, "p");
            game.push_zombie(enemy("z", ZombieType::Zombie, x + 20.0, y, 1000.0, 0.0));
            game.update(1.0 / 60.0);
            game.players()["p"].damage_log.last().unwrap().damage
        };
        assert!(hit(&MAPS[3]) > hit(&MAPS[0]));
    }

    #[test]
    fn kills_add_bounty_scaled_by_the_map() {
        let bounty = |map: &'static MapDef| {
            let mut game = Game::new(map);
            game.add_player("p", "P", &kit(5, 5, 5));
            let p = game.player_mut("p");
            award_kill_to_player(p, zombie_bounty(&ZombieType::Devil), map.bounty_mult);
            p.bounty
        };
        assert!(bounty(&MAPS[2]) > bounty(&MAPS[0]));
    }

    #[test]
    fn distant_brutes_cannot_deal_damage() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "p");
        let max = game.players()["p"].max_health;
        game.push_zombie(enemy("brute", ZombieType::Brute, x + 200.0, y, 1000.0, 0.0));
        game.update(1.0 / 60.0);
        assert_eq!(game.players()["p"].health, max);
        assert!(game.players()["p"].damage_log.is_empty());
    }

    #[test]
    fn reset_world_restocks_but_keeps_players_raiding() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.crates[0].respawn_at = Some(1e9);
        game.push_zombie(enemy("z", ZombieType::Zombie, 500.0, 500.0, 10.0, 0.0));
        game.player_mut("p").raid_time = 100.0;
        game.reset_world();
        assert!(game.zombies().is_empty());
        assert!(game.crate_availability()[0].available);
        assert_eq!(game.players()["p"].raid_time, 100.0);
    }

    // ---- Host pause (kept from the arena mode) ----

    #[test]
    fn only_a_solo_host_can_pause_and_anyone_arriving_resumes() {
        let mut game = game();
        game.add_player("first", "First", &kit(5, 5, 5));
        assert!(!game.set_paused("missing", true));
        assert!(game.set_paused("first", true), "alone in the raid: pausing is fine");
        game.add_player("second", "Second", &kit(5, 5, 5));
        assert!(!game.is_paused(), "a new arrival resumes the raid");
        assert!(!game.set_paused("first", true), "a shared raid can't be frozen");
        assert!(!game.set_paused("second", true));
        game.remove_player("second");
        assert!(game.set_paused("first", true));
        assert!(game.set_paused("first", false));
    }

    #[test]
    fn pause_freezes_the_world_and_raid_clocks() {
        let mut game = game();
        game.add_player("host", "Host", &kit(5, 5, 5));
        game.update(0.016);
        let clock = game.time();
        let raid_time = game.players()["host"].raid_time;
        game.set_paused("host", true);
        let mut input = idle_input();
        input.up = true;
        input.shooting = true;
        game.handle_input("host", input);
        for _ in 0..120 { game.update(1.0 / 60.0); }
        assert_eq!(game.time(), clock);
        assert_eq!(game.players()["host"].raid_time, raid_time);
        assert_eq!(game.input_count(), 0);
        game.set_paused("host", false);
        game.update(0.016);
        assert!(game.time() > clock);
    }

    #[test]
    fn host_passes_to_the_oldest_remaining_player() {
        let mut game = game();
        for id in ["one", "two", "three"] { game.add_player(id, id, &kit(5, 5, 5)); }
        game.remove_player("one");
        assert_eq!(game.host_id(), Some("two"));
        game.remove_player("three");
        assert!(game.set_paused("two", true), "now alone");
        game.remove_player("two");
        assert_eq!(game.host_id(), None);
        assert!(!game.is_paused());
    }

    #[test]
    fn strafing_on_the_spot_still_counts_as_camping() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "p");
        // Hop 400 units back and forth every second: never far from where you were.
        for f in 0..(CAMP_LIMIT * 60.0) as usize + 120 {
            let off = if (f / 60) % 2 == 0 { 0.0 } else { 400.0 };
            game.player_mut("p").pos = Vector2 { x: x + off, y };
            game.player_mut("p").health = 1e6;
            game.update(1.0 / 60.0);
        }
        assert!(game.players()["p"].hunted, "the old move-350-units dodge doesn't work");
    }

    #[test]
    fn travelling_drains_the_camp_meter() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "p");
        game.update(1.0 / 60.0);
        game.player_mut("p").camp = 40.0;
        for f in 0..600 {
            game.player_mut("p").pos = Vector2 { x: x + f as f64 * 3.0, y };
            game.update(1.0 / 60.0);
        }
        assert!(game.players()["p"].camp < 40.0, "moving on lets the meter drain");
    }

    #[test]
    fn the_second_hunt_in_a_raid_is_an_elite_pack_not_another_boss() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        isolate(&mut game, "p");
        game.spawn_boss_for("p");
        game.spawn_boss_for("p");
        let abominations = game.zombies().iter().filter(|z| z.zombie_type == ZombieType::Abomination).count();
        let elites = game.zombies().iter().filter(|z| z.elite).count();
        assert_eq!(abominations, 1, "one Abomination per player per raid");
        assert_eq!(elites, ELITE_PACK);
        assert_eq!(game.boss_quarry.values().filter(|q| *q == "p").count(), 1 + ELITE_PACK, "the pack hunts the camper too");
    }

    #[test]
    fn camping_keeps_drawing_elite_packs_that_pay_only_base_bounty() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        isolate(&mut game, "p");
        for _ in 0..4 { assert!(game.spawn_boss_for("p")); }
        assert_eq!(game.zombies().iter().filter(|z| z.zombie_type == ZombieType::Abomination).count(), 1);
        assert_eq!(game.zombies().iter().filter(|z| z.elite).count(), ELITE_PACK * 3, "camping never becomes free");
        let hunter = game.zombies().iter().find(|z| z.elite).unwrap().clone();
        assert_eq!(hunter.target.as_deref(), Some("p"));
        assert_eq!(kill_bounty(&hunter), zombie_bounty(&hunter.zombie_type), "no elite bonus for farmed hunters");
    }

    #[test]
    fn one_press_of_g_drops_one_item_even_if_the_input_is_reused() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 50));
        isolate(&mut game, "p");
        for i in 0..5 { game.player_mut("p").backpack.push(Item::new(ItemKind::Valuable, Rarity::Common, 1 + i, Some("Junk".into()))); }
        let mut input = idle_input();
        input.drop_item = true;
        game.handle_input("p", input);
        // No new input for half a second (lag, or a background tab).
        for _ in 0..30 { game.update(1.0 / 60.0); }
        assert_eq!(game.players()["p"].backpack.len(), 4);
    }

    #[test]
    fn hunters_stay_on_a_downed_target() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        game.add_player("q", "Q", &kit(5, 5, 5));
        isolate(&mut game, "p");
        game.spawn_boss_for("p");
        { let p = game.player_mut("p"); p.health = 0.0; p.bleedout = BLEEDOUT_TIME; }
        game.update(1.0 / 60.0);
        assert!(game.boss_quarry.values().any(|q| q == "p"), "a down-and-revive doesn't shake it off");
    }

    #[test]
    fn explosions_fall_off_with_distance() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "p");
        game.push_zombie(enemy("centre", ZombieType::Brute, x + 400.0, y, 1000.0, 0.0));
        game.push_zombie(enemy("edge", ZombieType::Brute, x + 400.0 + ROCKET_EXPLOSION_RADIUS * 0.9, y, 1000.0, 0.0));
        let mut b = Bullet { id: "r".into(), pos: Vector2 { x: x + 400.0, y }, vel: Vector2 { x: 0.0, y: 0.0 }, owner_id: "p".into(), damage: 100.0, is_crit: false, is_rocket: true };
        b.pos.x += 0.0;
        game.bullets.push(b);
        game.update(1.0 / 60.0);
        let hp = |id: &str| game.zombies().iter().find(|z| z.id == id).map_or(0.0, |z| z.health);
        assert!(1000.0 - hp("centre") > 1000.0 - hp("edge"), "the blast is weaker at the edge");
    }

    #[test]
    fn standing_at_an_uplink_decrypts_sealed_loot_and_draws_monsters() {
        let mut game = game();
        game.add_player("p", "P", &kit(10, 10, 10));
        game.clear_zombies();
        let u = game.layout().uplinks[0].clone();
        let mut rng = rand::rng();
        let sealed = gear::seal(&mut rng, &Item::new(ItemKind::Uzi, Rarity::Common, 10, None));
        let keep = Item::new(ItemKind::Pistol, Rarity::Common, 3, None);
        {
            let p = game.player_mut("p");
            p.backpack.push(keep.clone());
            p.backpack.push(sealed.clone());
            p.pos = Vector2 { x: u.x, y: u.y };
        }
        // A monster far outside normal aggro range, but within earshot of the uplink.
        let far = (u.x + ZOMBIE_AGGRO_RANGE + 150.0).min(game.layout().width - 40.0);
        game.push_zombie(enemy("z", ZombieType::Zombie, far, u.y, 1e6, 0.0));
        let mut input = idle_input();
        input.mouse_x = u.x; input.mouse_y = u.y;
        game.handle_input("p", input);
        for _ in 0..((gear::decrypt_secs(Rarity::Common) - 1.0) * 60.0) as usize { game.update(1.0 / 60.0); }
        assert!(game.players()["p"].decrypt > 2.0, "decrypting while at the uplink");
        assert!(!game.decrypt_noise.is_empty(), "decrypting is loud");
        for _ in 0..90 { game.update(1.0 / 60.0); }
        let p = &game.players()["p"];
        assert_eq!(p.backpack.len(), 2);
        assert_eq!(p.backpack[0], keep, "other items are untouched");
        assert_ne!(p.backpack[1].kind, ItemKind::Encrypted, "the sealed item opened");
        assert_eq!(p.decrypt, 0.0, "nothing left to decrypt");
    }

    #[test]
    fn walking_away_from_the_uplink_resets_decryption() {
        let mut game = game();
        game.add_player("p", "P", &kit(10, 10, 10));
        game.clear_zombies();
        let u = game.layout().uplinks[0].clone();
        let mut rng = rand::rng();
        let sealed = gear::seal(&mut rng, &Item::new(ItemKind::Uzi, Rarity::Legendary, 10, None));
        { let p = game.player_mut("p"); p.backpack.push(sealed); p.pos = Vector2 { x: u.x, y: u.y }; }
        game.handle_input("p", idle_input());
        for _ in 0..120 { game.update(1.0 / 60.0); }
        assert!(game.players()["p"].decrypt > 1.5);
        game.player_mut("p").pos.x += UPLINK_RADIUS * 3.0;
        game.update(1.0 / 60.0);
        assert_eq!(game.players()["p"].decrypt, 0.0);
        assert_eq!(game.players()["p"].backpack[0].kind, ItemKind::Encrypted);
    }

    #[test]
    fn the_inventory_screen_can_drop_any_item() {
        let mut game = game();
        game.add_player("p", "P", &kit(10, 10, 10));
        let a = Item::new(ItemKind::Pistol, Rarity::Common, 3, None);
        let b = Item::new(ItemKind::Valuable, Rarity::Common, 3, Some("Junk".into()));
        { let p = game.player_mut("p"); p.backpack.push(a.clone()); p.backpack.push(b.clone()); }
        let mut input = idle_input();
        input.drop_id = Some(a.id.clone());
        game.handle_input("p", input);
        for _ in 0..3 { game.update(1.0 / 60.0); }
        assert_eq!(game.players()["p"].backpack, vec![b], "only the chosen item was dropped, once");
    }

    #[test]
    fn sealed_items_carried_from_the_stash_start_in_the_pack() {
        let mut game = game();
        let mut rng = rand::rng();
        let carried: Vec<Item> = (0..20).map(|_| gear::seal(&mut rng, &Item::new(ItemKind::Armor, Rarity::Rare, 20, None))).collect();
        game.add_player_carrying("p", "P", &kit(10, 10, 0), carried);
        let p = &game.players()["p"];
        assert_eq!(p.backpack.len() as u32, p.backpack_capacity, "only what fits comes along");
    }

    #[test]
    fn legacy_boosts_raise_health_and_damage() {
        let mut boosted = kit(10, 10, 0);
        boosted.boost = gear::RaidBoost { max_health: 18.0, damage: 0.09 };
        let mut game = game();
        game.add_player("a", "A", &kit(10, 10, 0));
        game.add_player("b", "B", &boosted);
        assert_eq!(game.players()["b"].max_health, game.players()["a"].max_health + 18.0);
        assert_eq!(game.players()["b"].health, game.players()["b"].max_health);
    }

    #[test]
    fn g_drops_the_last_item_picked_up() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        isolate(&mut game, "p");
        let item = Item::new(ItemKind::Valuable, Rarity::Common, 3, Some("Junk".into()));
        game.player_mut("p").backpack.push(item.clone());
        let mut input = idle_input();
        input.drop_item = true;
        game.handle_input("p", input);
        game.update(1.0 / 60.0);
        assert!(game.players()["p"].backpack.is_empty());
        assert_eq!(game.drops().iter().filter(|d| d.item.as_ref() == Some(&item)).count(), 1);
        game.handle_input("p", idle_input());
        for _ in 0..30 { game.update(1.0 / 60.0); }
        assert!(game.players()["p"].backpack.is_empty(), "a dropped item isn't picked straight back up");
    }

    #[test]
    fn the_camp_meter_stays_empty_while_you_are_hunted() {
        let mut game = game();
        game.add_player("p", "P", &kit(5, 5, 5));
        isolate(&mut game, "p");
        game.spawn_boss_for("p");
        for _ in 0..600 { game.player_mut("p").health = 1e6; game.update(1.0 / 60.0); }
        assert_eq!(game.players()["p"].camp, 0.0);
    }

    #[test]
    fn a_lost_raid_lists_the_loadout_and_pack_it_cost() {
        let mut game = game();
        let l = kit(5, 6, 7);
        game.add_player("p", "P", &l);
        let junk = Item::new(ItemKind::Valuable, Rarity::Common, 3, Some("Junk".into()));
        game.player_mut("p").backpack.push(junk.clone());
        let o = game.abandon("p").unwrap();
        assert_eq!(o.lost.len(), 4, "three equipped items plus the pack contents");
        assert!(o.lost.contains(&junk) && o.lost.contains(l.armor.as_ref().unwrap()));
        let mut naked = Game::new(crate::gear::default_map());
        naked.add_player("n", "N", &Loadout::default());
        assert!(naked.abandon("n").unwrap().lost.is_empty(), "the loaner pistol is never lost");
    }

    #[test]
    fn two_players_cleaving_in_one_tick_both_land_their_hits() {
        let mut game = game();
        game.add_player("a", "A", &kit(5, 5, 5));
        game.add_player("b", "B", &kit(5, 5, 5));
        let (x, y) = isolate(&mut game, "a");
        game.player_mut("b").pos = Vector2 { x: x + 80.0, y };
        // Two weak enemies: one in front of each player.
        game.push_zombie(enemy("za", ZombieType::Zombie, x + 30.0, y, 1.0, 0.0));
        game.push_zombie(enemy("zb", ZombieType::Zombie, x + 110.0, y, 1.0, 0.0));
        let mut swing = idle_input();
        swing.melee = true;
        swing.mouse_x = 99999.0;
        swing.mouse_y = y;
        game.handle_input("a", swing.clone());
        game.handle_input("b", swing);
        game.update(1.0 / 60.0);
        assert!(game.zombies().is_empty(), "the second swing used valid indices: {:?}", game.zombies().iter().map(|z| &z.id).collect::<Vec<_>>());
        assert_eq!(game.players()["a"].kills + game.players()["b"].kills, 2);
    }

    #[test]
    fn deploying_without_a_pack_or_gun_is_weaker() {
        let mut game = game();
        game.add_player("n", "N", &Loadout::default());
        let n = &game.players()["n"];
        assert_eq!(n.backpack_capacity, crate::gear::NO_PACK_CAPACITY);
        assert_eq!(n.weapons[0].power, 0);
        assert!(gear::raid_damage_mult(0) < gear::raid_damage_mult(1));
    }

    #[test]
    fn every_map_runs_a_busy_minute_without_panicking() {
        for map in &MAPS {
            let mut game = Game::new(map);
            for i in 0..4 { game.add_player(&format!("p{i}"), "P", &kit(map.min_gear_score + 10, 40, 40)); }
            let mut input = idle_input();
            input.shooting = true;
            input.right = true;
            for (i, id) in ["p0", "p1", "p2", "p3"].iter().enumerate() {
                let mut inp = input.clone();
                inp.mouse_x = if i % 2 == 0 { 0.0 } else { 99999.0 };
                game.handle_input(id, inp);
            }
            game.zombie_spawn_timer = 0.0;
            for _ in 0..3600 { game.update(1.0 / 60.0); }
            assert!(game.zombies().len() <= MAX_ZOMBIES_HARD_CAP);
        }
    }
}
