use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use rand::Rng;
use uuid::Uuid;

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

// ---------- Internal ammo pickup ----------

#[derive(Clone, Debug)]
struct AmmoPickupInternal {
    id: String,
    x: f64,
    y: f64,
    amount: i32,
    respawn_at: Option<f64>,
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

fn resolve_circle_rect(
    px: f64,
    py: f64,
    radius: f64,
    rx: f64,
    ry: f64,
    rw: f64,
    rh: f64,
) -> (f64, f64) {
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

fn resolve_wall_collisions(
    mut px: f64,
    mut py: f64,
    radius: f64,
    wall_grid: &SpatialGrid<WallEntry>,
) -> (f64, f64) {
    let query_radius = radius + WALL_GRID_CELL_SIZE;
    let nearby = wall_grid.query(px, py, query_radius);

    let mut seen = HashSet::new();
    let mut walls: Vec<&WallEntry> = Vec::new();
    for w in &nearby {
        let key = (
            (w.x * 100.0) as i64,
            (w.y * 100.0) as i64,
            (w.w * 100.0) as i64,
            (w.h * 100.0) as i64,
        );
        if seen.insert(key) {
            walls.push(w);
        }
    }

    for w in &walls {
        if rect_contains(w.x, w.y, w.w, w.h, px, py, radius) {
            let (nx, ny) = resolve_circle_rect(px, py, radius, w.x, w.y, w.w, w.h);
            px = nx;
            py = ny;
        }
    }
    (px, py)
}

fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

fn bullet_hits_wall(px: f64, py: f64, wall_grid: &SpatialGrid<WallEntry>) -> bool {
    let nearby = wall_grid.query(px, py, WALL_GRID_CELL_SIZE);
    for w in &nearby {
        if point_in_rect(px, py, w.x, w.y, w.w, w.h) {
            return true;
        }
    }
    false
}

// ---------- Build wall grid ----------

fn build_wall_grid(walls: &[Wall]) -> SpatialGrid<WallEntry> {
    let mut grid: SpatialGrid<WallEntry> =
        SpatialGrid::new(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE);

    let grid_cols = (MAP_WIDTH / WALL_GRID_CELL_SIZE).ceil() as usize;
    let grid_rows = (MAP_HEIGHT / WALL_GRID_CELL_SIZE).ceil() as usize;

    for wall in walls {
        let min_col = (wall.x / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let max_col = ((wall.x + wall.w) / WALL_GRID_CELL_SIZE)
            .floor()
            .max(0.0) as usize;
        let min_row = (wall.y / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let max_row = ((wall.y + wall.h) / WALL_GRID_CELL_SIZE)
            .floor()
            .max(0.0) as usize;

        for row in min_row..=max_row.min(grid_rows - 1) {
            for col in min_col..=max_col.min(grid_cols - 1) {
                let cx = (col as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                let cy = (row as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                grid.insert(WallEntry {
                    x: wall.x,
                    y: wall.y,
                    w: wall.w,
                    h: wall.h,
                    cell_x: cx.min(MAP_WIDTH - 1.0),
                    cell_y: cy.min(MAP_HEIGHT - 1.0),
                });
            }
        }
    }
    grid
}

// ---------- Score helper ----------

fn zombie_score(zombie_type: &ZombieType) -> f64 {
    match zombie_type {
        ZombieType::Vampire => 100.0,
        ZombieType::Brute => 75.0,
        ZombieType::Devil => 50.0,
        ZombieType::Crawler => 25.0,
        ZombieType::Zombie => 15.0,
    }
}

// ---------- Drop internal ----------

struct DropInternal {
    id: String,
    drop_type: DropType,
    x: f64,
    y: f64,
    despawn_at: f64,
}

// ---------- Drop roll ----------

fn roll_drop(zombie_type: &ZombieType, x: f64, y: f64, game_time: f64) -> Option<DropInternal> {
    let mut rng = rand::rng();
    let roll: f64 = rng.random();

    let (ammo_chance, health_chance, weapon_chance, tactical_chance) = match zombie_type {
        ZombieType::Zombie => (0.18, 0.05, 0.02, 0.05),
        ZombieType::Devil => (0.25, 0.10, 0.05, 0.08),
        ZombieType::Crawler => (0.15, 0.05, 0.03, 0.05),
        ZombieType::Brute => (0.35, 0.15, 0.12, 0.15),
        ZombieType::Vampire => (0.25, 0.18, 0.08, 0.12),
    };

    let drop_type = if roll < ammo_chance {
        Some(DropType::Ammo)
    } else if roll < ammo_chance + health_chance {
        Some(DropType::Health)
    } else if roll < ammo_chance + health_chance + weapon_chance {
        Some(DropType::Weapon)
    } else if roll < ammo_chance + health_chance + weapon_chance + tactical_chance {
        Some(DropType::Tactical)
    } else {
        None
    };

    drop_type.map(|dt| DropInternal {
        id: uuid::Uuid::new_v4().to_string(),
        drop_type: dt,
        x,
        y,
        despawn_at: game_time + DROP_DESPAWN_TIME,
    })
}

fn award_kill_to_player(p: &mut Player, base_score: f64) {
    p.kills += 1;
    p.combo += 1;
    p.combo_timer = COMBO_DURATION;
    if p.combo > p.max_combo {
        p.max_combo = p.combo;
    }

    let mult = (1.0 + (p.combo.saturating_sub(1) as f64) * 0.2).min(5.0);
    p.score += (base_score * mult).round();
    p.credits += (base_score * 0.85 * mult).round().max(12.0);

    // Combo milestone rewards
    if p.combo % 5 == 0 {
        p.ammo = (p.ammo + 15.0).min(p.max_ammo);
        p.tactical_items[0] = (p.tactical_items[0] + 1).min(99);
        p.credits += 35.0;
    }
    if p.combo % 10 == 0 {
        p.tactical_items[2] = (p.tactical_items[2] + 1).min(99);
        p.health = (p.health + 15.0).min(p.max_health);
        p.credits += 60.0;
        // Unlock next locked weapon if any
        for slot in 1..4 {
            if !p.weapon_slots[slot] {
                p.weapon_slots[slot] = true;
                break;
            }
        }
    }
    if p.combo % 15 == 0 {
        p.tactical_items[1] = (p.tactical_items[1] + 2).min(99);
        p.max_ammo += 10.0;
        p.ammo = (p.ammo + 10.0).min(p.max_ammo);
        p.credits += 100.0;
    }
}

// ---------- Game ----------

#[derive(Debug)]
pub struct WaveClear {
    pub player_id: String,
    pub wave: u32,
    pub score: f64,
    pub kills: u32,
}

pub struct Game {
    players: HashMap<String, Player>,
    player_names: HashMap<String, String>,
    join_order: Vec<String>,
    paused: bool,
    wave_entries: HashMap<String, (f64, u32)>,
    pending_wave_clears: Vec<WaveClear>,
    inputs: HashMap<String, ClientInput>,
    zombies: Vec<Zombie>,
    bullets: Vec<Bullet>,
    placeables: Vec<Placeable>,
    drops: Vec<DropInternal>,
    wave: u32,
    game_over: bool,
    zombie_spawn_timer: f64,
    wave_kills: u32,
    wave_break_timer: f64,
    shoot_cooldowns: HashMap<String, f64>,
    melee_cooldowns: HashMap<String, f64>,
    place_cooldowns: HashMap<String, f64>,
    upgrade_cooldowns: HashMap<String, f64>,
    zombie_attack_cooldowns: HashMap<String, f64>,
    bullet_lifetimes: HashMap<String, f64>,
    game_time: f64,
    ammo_pickups: Vec<AmmoPickupInternal>,
    walls: Vec<Wall>,
    wall_grid: SpatialGrid<WallEntry>,
    zombie_grid: SpatialGrid<ZombieRef>,
    player_grid: SpatialGrid<PlayerRef>,
    // Dash state per player: charges, recharge, active burst timer, and i-frames
    dash_charges: HashMap<String, i32>,
    dash_recharge: HashMap<String, f64>,
    dash_active: HashMap<String, f64>,
    dash_iframes: HashMap<String, f64>,
    // Revive: dead_player_id -> (reviver_id, progress_seconds)
    revive_progress: HashMap<String, (String, f64)>,
    // Zombie wall-stuck tracking: zombie_id -> (stuck_timer, steer_angle)
    zombie_wall_stuck: HashMap<String, (f64, f64)>,
}

impl Game {
    pub fn new() -> Self {
        let walls = generate_walls();
        let wall_grid = build_wall_grid(&walls);

        let ammo_points = ammo_spawn_points();
        let ammo_pickups: Vec<AmmoPickupInternal> = ammo_points
            .iter()
            .enumerate()
            .map(|(i, &(x, y, amount))| AmmoPickupInternal {
                id: format!("ammo_{}", i),
                x,
                y,
                amount,
                respawn_at: None,
            })
            .collect();

        Self {
            players: HashMap::new(),
            player_names: HashMap::new(),
            join_order: Vec::new(),
            paused: false,
            wave_entries: HashMap::new(),
            pending_wave_clears: Vec::new(),
            inputs: HashMap::new(),
            zombies: Vec::new(),
            bullets: Vec::new(),
            placeables: Vec::new(),
            drops: Vec::new(),
            wave: 1,
            game_over: false,
            zombie_spawn_timer: 0.0,
            wave_kills: 0,
            wave_break_timer: 0.0,
            shoot_cooldowns: HashMap::new(),
            melee_cooldowns: HashMap::new(),
            place_cooldowns: HashMap::new(),
            upgrade_cooldowns: HashMap::new(),
            zombie_attack_cooldowns: HashMap::new(),
            bullet_lifetimes: HashMap::new(),
            game_time: 0.0,
            ammo_pickups,
            walls,
            wall_grid,
            zombie_grid: SpatialGrid::new(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE),
            player_grid: SpatialGrid::new(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE),
            dash_charges: HashMap::new(),
            dash_recharge: HashMap::new(),
            dash_active: HashMap::new(),
            dash_iframes: HashMap::new(),
            revive_progress: HashMap::new(),
            zombie_wall_stuck: HashMap::new(),
        }
    }

    pub fn wave_target(&self) -> u32 {
        self.wave * 12
    }

    pub fn wave_kills(&self) -> u32 {
        self.wave_kills
    }

    pub fn wave_break_timer(&self) -> f64 {
        self.wave_break_timer
    }

    /// Only an empty room can select a new round; late joiners keep its wave.
    pub fn start_empty_round(&mut self, requested: u32, unlocked: u32) -> bool {
        if !self.players.is_empty() { return false; }
        self.reset_at_wave(requested, unlocked);
        true
    }

    pub fn reset_at_wave(&mut self, requested: u32, unlocked: u32) {
        self.reset();
        self.wave = requested.max(1).min(unlocked.max(1));
    }

    /// Reset the game world but keep connected players (respawn them).
    pub fn reset(&mut self) {
        self.zombies.clear();
        self.bullets.clear();
        self.placeables.clear();
        self.drops.clear();
        self.wave = 1;
        self.game_over = false;
        self.paused = false;
        self.zombie_spawn_timer = 0.0;
        self.wave_kills = 0;
        self.wave_break_timer = 0.0;
        self.shoot_cooldowns.clear();
        self.melee_cooldowns.clear();
        self.place_cooldowns.clear();
        self.upgrade_cooldowns.clear();
        self.zombie_attack_cooldowns.clear();
        self.bullet_lifetimes.clear();
        self.dash_charges.clear();
        self.dash_recharge.clear();
        self.dash_active.clear();
        self.dash_iframes.clear();
        self.revive_progress.clear();
        self.zombie_wall_stuck.clear();
        self.game_time = 0.0;
        self.wave_entries.clear();
        self.pending_wave_clears.clear();
        for pickup in &mut self.ammo_pickups {
            pickup.respawn_at = None;
        }
        // Respawn all players (preserve names)
        let ids = self.join_order.clone();
        self.join_order.clear();
        self.players.clear();
        self.inputs.clear();
        for id in ids {
            let name = self.player_names.get(&id).cloned().unwrap_or_default();
            self.add_player(&id, &name);
        }
    }

    pub fn add_player(&mut self, id: &str, name: &str) {
        if !self.players.contains_key(id) { self.join_order.push(id.to_string()); }
        self.player_names.insert(id.to_string(), name.to_string());
        let player = Player {
            id: id.to_string(),
            name: name.to_string(),
            pos: Vector2 { x: MAP_WIDTH / 2.0, y: MAP_HEIGHT / 2.0 },
            angle: 0.0,
            score: 0.0,
            credits: 100.0,
            health: 100.0,
            max_health: 100.0,
            ammo: 40.0,
            max_ammo: 40.0,
            weapon: Weapon::Pistol,
            weapon_slots: [true, false, false, false],
            combo: 0,
            combo_timer: 0.0,
            max_combo: 0,
            kills: 0,
            tactical_items: [2, 2, 1],
            damage_level: 0,
            melee_level: 0,
            damage_log: Vec::new(),
        };
        // Join before any wave kills to qualify; mid-wave joins wait for the next wave.
        if self.wave_kills == 0 && self.wave_break_timer <= 0.0 {
            self.wave_entries.insert(id.to_string(), (player.score, player.kills));
        }
        self.players.insert(id.to_string(), player);
    }

    pub fn remove_player(&mut self, id: &str) {
        if self.host_id() == Some(id) {
            self.paused = false;
            self.inputs.clear();
        }
        self.join_order.retain(|player| player != id);
        self.players.remove(id);
        self.wave_entries.remove(id);
        self.player_names.remove(id);
        self.inputs.remove(id);
        self.shoot_cooldowns.remove(id);
        self.melee_cooldowns.remove(id);
        self.place_cooldowns.remove(id);
        self.upgrade_cooldowns.remove(id);
        self.dash_iframes.remove(id);
    }

    fn start_wave_tracking(&mut self) {
        self.wave_entries = self.players.iter().map(|(id, player)|
            (id.clone(), (player.score, player.kills))).collect();
    }

    pub fn take_wave_clears(&mut self) -> Vec<WaveClear> {
        std::mem::take(&mut self.pending_wave_clears)
    }

    pub fn host_id(&self) -> Option<&str> { self.join_order.first().map(String::as_str) }

    pub fn is_paused(&self) -> bool { self.paused }

    pub fn set_paused(&mut self, id: &str, paused: bool) -> bool {
        if self.host_id() != Some(id) || self.game_over { return false; }
        if self.paused != paused {
            self.paused = paused;
            self.inputs.clear();
        }
        true
    }

    pub fn handle_input(&mut self, id: &str, input: ClientInput) {
        if self.paused || !self.players.contains_key(id) { return; }
        self.inputs.insert(id.to_string(), input);
    }

    pub fn update(&mut self, dt: f64) {
        if self.game_over || self.paused {
            return;
        }

        self.game_time += dt;

        // Wave break countdown
        let in_wave_break = self.wave_break_timer > 0.0;
        if in_wave_break {
            self.wave_break_timer = (self.wave_break_timer - dt).max(0.0);
            if self.wave_break_timer <= 0.0 {
                self.wave += 1;
                self.wave_kills = 0;
                self.zombie_spawn_timer = 0.2;
                self.start_wave_tracking();
            }
        }

        // Rebuild player grid
        self.player_grid.clear();
        for (id, p) in &self.players {
            if p.health > 0.0 {
                self.player_grid.insert(PlayerRef {
                    id: id.clone(),
                    x: p.pos.x,
                    y: p.pos.y,
                });
            }
        }

        // Rebuild zombie grid before player combat actions
        self.zombie_grid.clear();
        for (i, z) in self.zombies.iter().enumerate() {
            self.zombie_grid.insert(ZombieRef {
                index: i,
                x: z.pos.x,
                y: z.pos.y,
            });
        }

        let mut explosions: Vec<ExplosionEvent> = Vec::new();

        // Update players
        let player_ids: Vec<String> = self.players.keys().cloned().collect();

        for pid in &player_ids {
            if self.players.get(pid).map_or(true, |p| p.health <= 0.0) {
                continue;
            }

            // Update player combo timer (freeze combo decay during wave break!)
            if !in_wave_break {
                if let Some(p) = self.players.get_mut(pid) {
                    if p.combo > 0 {
                        p.combo_timer = (p.combo_timer - dt).max(0.0);
                        if p.combo_timer <= 0.0 {
                            p.combo = 0;
                        }
                    }
                }
            }

            let input = match self.inputs.get(pid) {
                Some(i) => i.clone(),
                None => continue,
            };

            // Dash logic — charge-based (max 3) with i-frames and shockwave
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
                        if *charges < DASH_MAX_CHARGES {
                            *recharge = DASH_RECHARGE_TIME;
                        } else {
                            *recharge = 0.0;
                        }
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

            // Dash shockwave pushes back nearby zombies
            if just_dashed {
                if let Some(p) = self.players.get(pid) {
                    let px = p.pos.x;
                    let py = p.pos.y;
                    for z in &mut self.zombies {
                        let dx = z.pos.x - px;
                        let dy = z.pos.y - py;
                        let dist = (dx * dx + dy * dy).sqrt();
                        if dist > 0.0 && dist < 55.0 {
                            z.pos.x = (z.pos.x + (dx / dist) * 35.0).max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                            z.pos.y = (z.pos.y + (dy / dist) * 35.0).max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);
                        }
                    }
                }
            }

            let is_dashing = self.dash_active.get(pid).copied().unwrap_or(0.0) > 0.0;

            // Movement
            let mut dx = 0.0_f64;
            let mut dy = 0.0_f64;
            if input.up {
                dy -= 1.0;
            }
            if input.down {
                dy += 1.0;
            }
            if input.left {
                dx -= 1.0;
            }
            if input.right {
                dx += 1.0;
            }

            let len = (dx * dx + dy * dy).sqrt();
            if len > 0.0 {
                dx /= len;
                dy /= len;
            }

            let has_overdrive = self.players.get(pid).map_or(false, |p| p.combo >= 10);
            let base_speed = if has_overdrive { PLAYER_SPEED * 1.15 } else { PLAYER_SPEED };
            let speed = if is_dashing { base_speed * DASH_SPEED_MULT } else { base_speed };

            {
                let p = self.players.get_mut(pid).unwrap();
                p.pos.x += dx * speed * dt;
                p.pos.y += dy * speed * dt;

                // Try wrapping through tunnels first
                let (wx, wy) = wrap_position(p.pos.x, p.pos.y, PLAYER_RADIUS);
                p.pos.x = wx;
                p.pos.y = wy;

                p.pos.x = p.pos.x.max(PLAYER_RADIUS).min(MAP_WIDTH - PLAYER_RADIUS);
                p.pos.y = p.pos.y.max(PLAYER_RADIUS).min(MAP_HEIGHT - PLAYER_RADIUS);

                let (nx, ny) =
                    resolve_wall_collisions(p.pos.x, p.pos.y, PLAYER_RADIUS, &self.wall_grid);
                p.pos.x = nx;
                p.pos.y = ny;

                p.angle = (input.mouse_y - p.pos.y).atan2(input.mouse_x - p.pos.x);

                if input.select_weapon > 0 && input.select_weapon <= 4 {
                    let slot = (input.select_weapon - 1) as usize;
                    if p.weapon_slots[slot] {
                        if let Some(w) = Weapon::from_slot(slot) {
                            p.weapon = w;
                        }
                    }
                }
            }

            // Decrement cooldowns
            *self.shoot_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;
            *self.melee_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;
            *self.place_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;
            *self.upgrade_cooldowns.entry(pid.clone()).or_insert(0.0) -= dt;

            // Tactical item placement (1 = Barrel, 2 = Barricade, 3 = Claymore Mine)
            let place_cd = *self.place_cooldowns.get(pid).unwrap_or(&0.0);
            if input.place_item >= 1 && input.place_item <= 3 && place_cd <= 0.0 {
                let item_idx = (input.place_item - 1) as usize;
                let can_place = self.players.get(pid).map_or(false, |p| p.tactical_items[item_idx] > 0);
                if can_place {
                    self.place_cooldowns.insert(pid.clone(), 0.35);
                    let p = self.players.get_mut(pid).unwrap();
                    p.tactical_items[item_idx] -= 1;

                    let (item_type, hp, offset, radius) = match item_idx {
                        0 => (PlaceableType::Barrel, BARREL_HP, 42.0, BARREL_RADIUS),
                        1 => (PlaceableType::Barricade, BARRICADE_HP, 42.0, BARRICADE_RADIUS),
                        _ => (PlaceableType::Mine, MINE_HP, 28.0, MINE_RADIUS),
                    };

                    let mut ix = (p.pos.x + p.angle.cos() * offset).max(radius).min(MAP_WIDTH - radius);
                    let mut iy = (p.pos.y + p.angle.sin() * offset).max(radius).min(MAP_HEIGHT - radius);
                    let (nx, ny) = resolve_wall_collisions(ix, iy, radius, &self.wall_grid);
                    ix = nx;
                    iy = ny;

                    self.placeables.push(Placeable {
                        id: Uuid::new_v4().to_string(),
                        item_type,
                        pos: Vector2 { x: ix, y: iy },
                        health: hp,
                        max_health: hp,
                        owner_id: pid.clone(),
                    });
                }
            }

            // Armory / Shop Upgrades (spends credits, never reduces score!)
            // 1 = Firearm Power, 2 = Nano-Armor, 3 = Expanded Mag, 4 = Tactical Pack, 5 = Melee Blade, 6 = Unlock Weapon
            let upg_cd = *self.upgrade_cooldowns.get(pid).unwrap_or(&0.0);
            if input.buy_upgrade >= 1 && input.buy_upgrade <= 6 && upg_cd <= 0.0 {
                if let Some(p) = self.players.get_mut(pid) {
                    let bought = match input.buy_upgrade {
                        1 => {
                            let cost = 200.0 + (p.damage_level as f64) * 150.0;
                            if p.credits >= cost && p.damage_level < 10 {
                                p.credits -= cost;
                                p.damage_level += 1;
                                true
                            } else {
                                false
                            }
                        }
                        2 => {
                            let cost = 150.0;
                            if p.credits >= cost {
                                p.credits -= cost;
                                p.max_health = (p.max_health + 25.0).min(350.0);
                                p.health = (p.health + 60.0).min(p.max_health);
                                true
                            } else {
                                false
                            }
                        }
                        3 => {
                            let cost = 125.0;
                            if p.credits >= cost {
                                p.credits -= cost;
                                p.max_ammo = (p.max_ammo + 25.0).min(300.0);
                                p.ammo = p.max_ammo;
                                true
                            } else {
                                false
                            }
                        }
                        4 => {
                            let cost = 140.0;
                            if p.credits >= cost {
                                p.credits -= cost;
                                p.tactical_items[0] = (p.tactical_items[0] + 2).min(99);
                                p.tactical_items[1] = (p.tactical_items[1] + 2).min(99);
                                p.tactical_items[2] = (p.tactical_items[2] + 2).min(99);
                                true
                            } else {
                                false
                            }
                        }
                        5 => {
                            let cost = 150.0 + (p.melee_level as f64) * 125.0;
                            if p.credits >= cost && p.melee_level < 10 {
                                p.credits -= cost;
                                p.melee_level += 1;
                                true
                            } else {
                                false
                            }
                        }
                        6 => {
                            let cost = 250.0;
                            let next_locked = (1..4).find(|&s| !p.weapon_slots[s]);
                            if let Some(slot) = next_locked {
                                if p.credits >= cost {
                                    p.credits -= cost;
                                    p.weapon_slots[slot] = true;
                                    if let Some(w) = Weapon::from_slot(slot) {
                                        p.weapon = w;
                                    }
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        }
                        _ => false,
                    };
                    if bought {
                        self.upgrade_cooldowns.insert(pid.clone(), 0.25);
                    }
                }
            }

            // Melee attack (Katana / Tactical Blade Cleave)
            let melee_cd = *self.melee_cooldowns.get(pid).unwrap();
            if input.melee && melee_cd <= 0.0 {
                let p = self.players.get(pid).unwrap();
                let cd_mult = if p.combo >= 10 { 0.78 } else { 1.0 };
                self.melee_cooldowns.insert(pid.clone(), MELEE_COOLDOWN * cd_mult);

                let px = p.pos.x;
                let py = p.pos.y;
                let p_angle = p.angle;
                let melee_lvl = p.melee_level as f64;
                let effective_range = MELEE_RANGE * (1.0 + melee_lvl * 0.10);
                let melee_dmg_mult = (1.0 + melee_lvl * 0.35) * (1.0 + (p.damage_level as f64) * 0.15);
                let crit_chance = (CRIT_BASE_CHANCE + (p.damage_level as f64) * 0.04 + melee_lvl * 0.03).min(0.70);

                // Melee can also trigger barrels
                for pl in &mut self.placeables {
                    if pl.item_type == PlaceableType::Barrel {
                        let bdx = pl.pos.x - px;
                        let bdy = pl.pos.y - py;
                        let dist = (bdx * bdx + bdy * bdy).sqrt();
                        if dist <= effective_range + BARREL_RADIUS {
                            let angle_to_b = bdy.atan2(bdx);
                            let mut angle_diff = (angle_to_b - p_angle).abs();
                            if angle_diff > PI {
                                angle_diff = 2.0 * PI - angle_diff;
                            }
                            if angle_diff <= MELEE_ARC / 2.0 {
                                pl.health = 0.0;
                                explosions.push(ExplosionEvent {
                                    x: pl.pos.x,
                                    y: pl.pos.y,
                                    radius: BARREL_EXPLOSION_RADIUS,
                                    damage: BARREL_DAMAGE,
                                    owner_id: pid.clone(),
                                });
                            }
                        }
                    }
                }

                let nearby = self.zombie_grid.query(px, py, effective_range);
                let mut indices: Vec<usize> = nearby.iter().map(|zr| zr.index).collect();
                indices.sort_unstable();
                indices.dedup();

                let mut rng = rand::rng();
                let mut kills = 0u32;
                let lifesteal_per_kill = 5.0 + melee_lvl * 3.0;
                for &zi in &indices {
                    if zi >= self.zombies.len() {
                        continue;
                    }
                    let z = &self.zombies[zi];
                    let zdx = z.pos.x - px;
                    let zdy = z.pos.y - py;
                    let dist = (zdx * zdx + zdy * zdy).sqrt();
                    if dist > effective_range {
                        continue;
                    }

                    let angle_to_zombie = zdy.atan2(zdx);
                    let mut angle_diff = (angle_to_zombie - p_angle).abs();
                    if angle_diff > PI {
                        angle_diff = 2.0 * PI - angle_diff;
                    }
                    if angle_diff > MELEE_ARC / 2.0 {
                        continue;
                    }

                    let is_crit = rng.random::<f64>() < crit_chance;
                    let final_dmg = MELEE_DAMAGE * melee_dmg_mult * if is_crit { CRIT_DAMAGE_MULT } else { 1.0 };
                    self.zombies[zi].health -= final_dmg;

                    if dist > 0.0 {
                        let knx = zdx / dist;
                        let kny = zdy / dist;
                        self.zombies[zi].pos.x = (self.zombies[zi].pos.x + knx * 48.0).max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                        self.zombies[zi].pos.y = (self.zombies[zi].pos.y + kny * 48.0).max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);
                    }

                    if self.zombies[zi].health <= 0.0 {
                        let score = zombie_score(&self.zombies[zi].zombie_type);
                        if let Some(d) = roll_drop(&self.zombies[zi].zombie_type, self.zombies[zi].pos.x, self.zombies[zi].pos.y, self.game_time) {
                            self.drops.push(d);
                        }
                        if let Some(p) = self.players.get_mut(pid) {
                            award_kill_to_player(p, score);
                            p.health = (p.health + lifesteal_per_kill).min(p.max_health);
                        }
                        kills += 1;
                    }
                }

                self.wave_kills += kills;
                self.zombies.retain(|z| z.health > 0.0);
            }

            // Shooting
            let shoot_cd = *self.shoot_cooldowns.get(pid).unwrap_or(&0.0);
            if input.shooting && shoot_cd <= 0.0 {
                let p = self.players.get(pid).unwrap();
                let is_pistol = p.weapon == Weapon::Pistol;
                if is_pistol || p.ammo > 0.0 {
                    let weapon = p.weapon.clone();
                    let cd_mult = if p.combo >= 10 { 0.75 } else { 1.0 };
                    self.shoot_cooldowns.insert(pid.clone(), weapon.cooldown() * cd_mult);

                    let angle = p.angle;
                    let px = p.pos.x;
                    let py = p.pos.y;
                    let dmg_mult = 1.0 + (p.damage_level as f64) * 0.20;
                    let crit_chance = (CRIT_BASE_CHANCE + (p.damage_level as f64) * 0.04).min(0.60);
                    let base_damage = weapon.damage() * dmg_mult;
                    let owner_id = pid.clone();

                    if !is_pistol {
                        self.players.get_mut(pid).unwrap().ammo -= 1.0;
                    }

                    let mut rng = rand::rng();

                    match weapon {
                        Weapon::Shotgun => {
                            let spread = PI / 12.0;
                            for i in 0..5 {
                                let a = angle - spread * 2.0 + spread * i as f64;
                                let bid = Uuid::new_v4().to_string();
                                let is_crit = rng.random::<f64>() < crit_chance;
                                let pellet_dmg = (base_damage / 5.0) * if is_crit { CRIT_DAMAGE_MULT } else { 1.0 };
                                self.bullet_lifetimes.insert(bid.clone(), BULLET_LIFETIME);
                                self.bullets.push(Bullet {
                                    id: bid,
                                    pos: Vector2 {
                                        x: px + a.cos() * PLAYER_RADIUS,
                                        y: py + a.sin() * PLAYER_RADIUS,
                                    },
                                    vel: Vector2 {
                                        x: a.cos() * BULLET_SPEED,
                                        y: a.sin() * BULLET_SPEED,
                                    },
                                    owner_id: owner_id.clone(),
                                    damage: (pellet_dmg * 10.0).round() / 10.0,
                                    is_crit,
                                    is_rocket: false,
                                });
                            }
                        }
                        Weapon::RocketLauncher => {
                            let bid = Uuid::new_v4().to_string();
                            let is_crit = rng.random::<f64>() < crit_chance;
                            let r_dmg = base_damage * if is_crit { CRIT_DAMAGE_MULT } else { 1.0 };
                            self.bullet_lifetimes.insert(bid.clone(), BULLET_LIFETIME);
                            self.bullets.push(Bullet {
                                id: bid,
                                pos: Vector2 {
                                    x: px + angle.cos() * PLAYER_RADIUS,
                                    y: py + angle.sin() * PLAYER_RADIUS,
                                },
                                vel: Vector2 {
                                    x: angle.cos() * ROCKET_SPEED,
                                    y: angle.sin() * ROCKET_SPEED,
                                },
                                owner_id,
                                damage: r_dmg.round(),
                                is_crit,
                                is_rocket: true,
                            });
                        }
                        _ => {
                            let bid = Uuid::new_v4().to_string();
                            let is_crit = rng.random::<f64>() < crit_chance;
                            let b_dmg = base_damage * if is_crit { CRIT_DAMAGE_MULT } else { 1.0 };
                            self.bullet_lifetimes.insert(bid.clone(), BULLET_LIFETIME);
                            self.bullets.push(Bullet {
                                id: bid,
                                pos: Vector2 {
                                    x: px + angle.cos() * PLAYER_RADIUS,
                                    y: py + angle.sin() * PLAYER_RADIUS,
                                },
                                vel: Vector2 {
                                    x: angle.cos() * BULLET_SPEED,
                                    y: angle.sin() * BULLET_SPEED,
                                },
                                owner_id,
                                damage: (b_dmg * 10.0).round() / 10.0,
                                is_crit,
                                is_rocket: false,
                            });
                        }
                    }
                }
            }

            // Ammo pickup collision
            let p = self.players.get_mut(pid).unwrap();
            for pickup in &mut self.ammo_pickups {
                if pickup.respawn_at.is_some() {
                    continue;
                }
                let pdx = p.pos.x - pickup.x;
                let pdy = p.pos.y - pickup.y;
                let dist = (pdx * pdx + pdy * pdy).sqrt();
                if dist < PLAYER_RADIUS + AMMO_PICKUP_RADIUS {
                    p.ammo = (p.ammo + pickup.amount as f64).min(p.max_ammo);
                    pickup.respawn_at = Some(self.game_time + AMMO_RESPAWN_TIME);
                }
            }

            // Drop pickup collision
            let mut rng = rand::rng();
            let mut drops_to_remove = Vec::new();
            for (di, drop) in self.drops.iter().enumerate() {
                if drop.despawn_at <= self.game_time { continue; }
                let dist = f64::hypot(p.pos.x - drop.x, p.pos.y - drop.y);
                if dist < PLAYER_RADIUS + DROP_PICKUP_RADIUS {
                    match drop.drop_type {
                        DropType::Ammo => { p.ammo = (p.ammo + DROP_AMMO_AMOUNT).min(p.max_ammo); }
                        DropType::Health => { p.health = (p.health + DROP_HEALTH_AMOUNT).min(p.max_health); }
                        DropType::Weapon => {
                            let locked: Vec<usize> = (1..4).filter(|&s| !p.weapon_slots[s]).collect();
                            if locked.is_empty() {
                                p.ammo = (p.ammo + DROP_AMMO_AMOUNT).min(p.max_ammo);
                                p.score += 50.0;
                                p.credits += 60.0;
                            } else {
                                let idx = locked[rng.random_range(0..locked.len())];
                                p.weapon_slots[idx] = true;
                            }
                        }
                        DropType::Tactical => {
                            let idx = rng.random_range(0..3);
                            p.tactical_items[idx] = (p.tactical_items[idx] + 1).min(99);
                        }
                    }
                    drops_to_remove.push(di);
                }
            }
            for &di in drops_to_remove.iter().rev() {
                self.drops.remove(di);
            }
        }

        // Update ammo pickup respawns
        for pickup in &mut self.ammo_pickups {
            if let Some(respawn_at) = pickup.respawn_at {
                if self.game_time >= respawn_at {
                    pickup.respawn_at = None;
                }
            }
        }

        // Update bullet positions + wrap through tunnels
        for bullet in &mut self.bullets {
            bullet.pos.x += bullet.vel.x * dt;
            bullet.pos.y += bullet.vel.y * dt;
            let (bwx, bwy) = wrap_position(bullet.pos.x, bullet.pos.y, BULLET_RADIUS);
            bullet.pos.x = bwx;
            bullet.pos.y = bwy;
        }

        // Filter bullets (OOB / lifetime / wall / barrel hit)
        {
            let wall_grid = &self.wall_grid;
            let lifetimes = &mut self.bullet_lifetimes;
            let placeables = &mut self.placeables;
            self.bullets.retain(|b| {
                if let Some(lt) = lifetimes.get_mut(&b.id) {
                    *lt -= dt;
                    if *lt <= 0.0 {
                        lifetimes.remove(&b.id);
                        if b.is_rocket {
                            explosions.push(ExplosionEvent {
                                x: b.pos.x,
                                y: b.pos.y,
                                radius: ROCKET_EXPLOSION_RADIUS,
                                damage: b.damage,
                                owner_id: b.owner_id.clone(),
                            });
                        }
                        return false;
                    }
                }
                if b.pos.x < -BULLET_RADIUS
                    || b.pos.x > MAP_WIDTH + BULLET_RADIUS
                    || b.pos.y < -BULLET_RADIUS
                    || b.pos.y > MAP_HEIGHT + BULLET_RADIUS
                {
                    lifetimes.remove(&b.id);
                    if b.is_rocket {
                        explosions.push(ExplosionEvent {
                            x: b.pos.x,
                            y: b.pos.y,
                            radius: ROCKET_EXPLOSION_RADIUS,
                            damage: b.damage,
                            owner_id: b.owner_id.clone(),
                        });
                    }
                    return false;
                }
                if bullet_hits_wall(b.pos.x, b.pos.y, wall_grid) {
                    lifetimes.remove(&b.id);
                    if b.is_rocket {
                        explosions.push(ExplosionEvent {
                            x: b.pos.x,
                            y: b.pos.y,
                            radius: ROCKET_EXPLOSION_RADIUS,
                            damage: b.damage,
                            owner_id: b.owner_id.clone(),
                        });
                    }
                    return false;
                }
                // Check if bullet hits an explosive barrel
                for pl in placeables.iter_mut() {
                    if pl.item_type == PlaceableType::Barrel && pl.health > 0.0 {
                        let dist = f64::hypot(b.pos.x - pl.pos.x, b.pos.y - pl.pos.y);
                        if dist < BARREL_RADIUS + BULLET_RADIUS {
                            pl.health -= b.damage;
                            lifetimes.remove(&b.id);
                            if b.is_rocket {
                                explosions.push(ExplosionEvent {
                                    x: b.pos.x,
                                    y: b.pos.y,
                                    radius: ROCKET_EXPLOSION_RADIUS,
                                    damage: b.damage,
                                    owner_id: b.owner_id.clone(),
                                });
                            }
                            if pl.health <= 0.0 {
                                explosions.push(ExplosionEvent {
                                    x: pl.pos.x,
                                    y: pl.pos.y,
                                    radius: BARREL_EXPLOSION_RADIUS,
                                    damage: BARREL_DAMAGE,
                                    owner_id: b.owner_id.clone(),
                                });
                            }
                            return false;
                        }
                    }
                }
                true
            });
        }

        // Spawn zombies (only when not in wave break)
        if !in_wave_break {
            self.zombie_spawn_timer -= dt;
            if self.zombie_spawn_timer <= 0.0 {
                self.zombie_spawn_timer = 0.55 / (1.0 + (self.wave as f64 - 1.0) * 0.18);

                let living_players = self
                    .players
                    .values()
                    .filter(|p| p.health > 0.0)
                    .count() as i32;

                let max_zombies = (MAX_ZOMBIES_BASE + MAX_ZOMBIES_PER_PLAYER * living_players)
                    .min(MAX_ZOMBIES_HARD_CAP) as usize;

                if self.zombies.len() < max_zombies && living_players > 0 {
                    let mut rng = rand::rng();
                    let zones = spawn_zones();
                    let idx = rng.random_range(0..zones.len());
                    let (sx, sy) = zones[idx];

                    let r: f64 = rng.random();
                    let wave = self.wave;

                    let (zombie_type, hp, speed) = if wave >= 5 && r < 0.07 {
                        (
                            ZombieType::Vampire,
                            80.0 + wave as f64 * 15.0,
                            64.0 + (wave as f64 * 2.4).min(34.0),
                        )
                    } else if wave >= 4 && r < 0.16 {
                        (
                            ZombieType::Brute,
                            150.0 + wave as f64 * 30.0,
                            24.0 + (wave as f64 * 1.4).min(20.0),
                        )
                    } else if wave >= 3 && r < 0.30 {
                        (
                            ZombieType::Crawler,
                            10.0 + wave as f64 * 5.0,
                            78.0 + (wave as f64 * 2.6).min(36.0),
                        )
                    } else if wave >= 2 && r < 0.42 {
                        (
                            ZombieType::Devil,
                            50.0 + wave as f64 * 20.0,
                            54.0 + (wave as f64 * 2.4).min(34.0),
                        )
                    } else {
                        (
                            ZombieType::Zombie,
                            20.0 + wave as f64 * 10.0,
                            38.0 + (wave as f64 * 2.2).min(30.0),
                        )
                    };

                    self.zombies.push(Zombie {
                        id: Uuid::new_v4().to_string(),
                        zombie_type,
                        pos: Vector2 { x: sx, y: sy },
                        health: hp,
                        max_health: hp,
                        speed,
                    });
                }
            }
        }

        // Check Claymore Mine proximity triggers against zombies
        for pl in &mut self.placeables {
            if pl.item_type == PlaceableType::Mine && pl.health > 0.0 {
                let triggered = self.zombies.iter().any(|z| {
                    z.health > 0.0 && f64::hypot(z.pos.x - pl.pos.x, z.pos.y - pl.pos.y) < MINE_TRIGGER_RADIUS
                });
                if triggered {
                    pl.health = 0.0;
                    explosions.push(ExplosionEvent {
                        x: pl.pos.x,
                        y: pl.pos.y,
                        radius: MINE_EXPLOSION_RADIUS,
                        damage: MINE_DAMAGE,
                        owner_id: pl.owner_id.clone(),
                    });
                }
            }
        }

        // Update zombies
        let player_positions: Vec<(String, f64, f64)> = self
            .players
            .values()
            .filter(|p| p.health > 0.0)
            .map(|p| (p.id.clone(), p.pos.x, p.pos.y))
            .collect();

        let mut zombie_kill_indices: Vec<usize> = Vec::new();
        let mut bullet_kill_indices: Vec<usize> = Vec::new();
        let mut kill_awards: Vec<(String, f64)> = Vec::new();
        let mut damage_to_players: Vec<(String, DamageHit)> = Vec::new();

        if !player_positions.is_empty() {
            for zi in (0..self.zombies.len()).rev() {
                let z = &self.zombies[zi];
                let zx = z.pos.x;
                let zy = z.pos.y;
                let z_speed = z.speed;

                // Find nearest player
                let mut nearest_id: Option<String> = None;
                let mut nearest_dist = f64::MAX;

                let nearby_players = self.player_grid.query(zx, zy, 600.0);
                for pr in &nearby_players {
                    let pdx = pr.x - zx;
                    let pdy = pr.y - zy;
                    let dist = (pdx * pdx + pdy * pdy).sqrt();
                    if dist < nearest_dist {
                        nearest_dist = dist;
                        nearest_id = Some(pr.id.clone());
                    }
                }

                if nearest_id.is_none() {
                    for (pid, px, py) in &player_positions {
                        let pdx = px - zx;
                        let pdy = py - zy;
                        let dist = (pdx * pdx + pdy * pdy).sqrt();
                        if dist < nearest_dist {
                            nearest_dist = dist;
                            nearest_id = Some(pid.clone());
                        }
                    }
                }

                if let Some(ref target_id) = nearest_id {
                    let (tx, ty) = player_positions
                        .iter()
                        .find(|(id, _, _)| id == target_id)
                        .map(|(_, x, y)| (*x, *y))
                        .unwrap_or((zx, zy));

                    let tdx = tx - zx;
                    let tdy = ty - zy;
                    let tdist = (tdx * tdx + tdy * tdy).sqrt();

                    if tdist > 0.0 {
                        let z = &mut self.zombies[zi];
                        let z_type = z.zombie_type.clone();
                        let zid_hash = z.id.as_bytes().iter().fold(0u64, |a, &b| a.wrapping_mul(31).wrapping_add(b as u64));

                        let (mut move_dx, mut move_dy) = (tdx / tdist, tdy / tdist);

                        match z_type {
                            ZombieType::Crawler => {
                                let phase = (self.game_time * 8.0 + zid_hash as f64 * 0.1).sin() * 0.7;
                                let perp_x = -move_dy;
                                let perp_y = move_dx;
                                move_dx += perp_x * phase;
                                move_dy += perp_y * phase;
                                let len = (move_dx * move_dx + move_dy * move_dy).sqrt();
                                if len > 0.0 { move_dx /= len; move_dy /= len; }
                            }
                            ZombieType::Devil => {
                                let cycle = (self.game_time + zid_hash as f64 * 0.3) % 2.0;
                                if cycle < 0.3 {
                                    let burst = 1.55;
                                    move_dx *= burst;
                                    move_dy *= burst;
                                }
                            }
                            ZombieType::Vampire => {
                                if tdist < 200.0 {
                                    let circle_dir = if zid_hash % 2 == 0 { 1.0 } else { -1.0 };
                                    let perp_x = -move_dy * circle_dir;
                                    let perp_y = move_dx * circle_dir;
                                    move_dx = move_dx * 0.3 + perp_x * 0.7;
                                    move_dy = move_dy * 0.3 + perp_y * 0.7;
                                    let len = (move_dx * move_dx + move_dy * move_dy).sqrt();
                                    if len > 0.0 { move_dx /= len; move_dy /= len; }
                                } else {
                                    let angle_offset: f64 = if zid_hash % 2 == 0 { 0.5 } else { -0.5 };
                                    let cos_a = angle_offset.cos();
                                    let sin_a = angle_offset.sin();
                                    let rx = move_dx * cos_a - move_dy * sin_a;
                                    let ry = move_dx * sin_a + move_dy * cos_a;
                                    move_dx = rx;
                                    move_dy = ry;
                                }
                            }
                            _ => {}
                        }

                        z.pos.x += move_dx * z_speed * dt;
                        z.pos.y += move_dy * z_speed * dt;

                        // Wrap through tunnels
                        let (zwx, zwy) = wrap_position(z.pos.x, z.pos.y, ZOMBIE_RADIUS);
                        z.pos.x = zwx;
                        z.pos.y = zwy;

                        z.pos.x = z.pos.x.max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                        z.pos.y = z.pos.y.max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);

                        // Barricade collision & thorny damage
                        for pl in &mut self.placeables {
                            if pl.item_type == PlaceableType::Barricade && pl.health > 0.0 {
                                let bdx = z.pos.x - pl.pos.x;
                                let bdy = z.pos.y - pl.pos.y;
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
                                        let score = zombie_score(&z.zombie_type);
                                        kill_awards.push((pl.owner_id.clone(), score));
                                        zombie_kill_indices.push(zi);
                                    }
                                }
                            }
                        }

                        // Wall collision — Brutes and Crawlers ignore walls
                        match z_type {
                            ZombieType::Brute | ZombieType::Crawler => {}
                            _ => {
                                let (nx, ny) = resolve_wall_collisions(
                                    z.pos.x, z.pos.y, ZOMBIE_RADIUS, &self.wall_grid,
                                );

                                let wall_blocked_x = (nx - z.pos.x).abs() > 0.1;
                                let wall_blocked_y = (ny - z.pos.y).abs() > 0.1;
                                let blocked = wall_blocked_x || wall_blocked_y;

                                let zid = z.id.clone();

                                if blocked {
                                    let entry = self.zombie_wall_stuck.entry(zid.clone())
                                        .or_insert((0.0, 0.0));
                                    entry.0 += dt;

                                    if entry.0 < 0.3 {
                                        z.pos.x = nx;
                                        z.pos.y = ny;
                                    } else {
                                        if entry.1 == 0.0 {
                                            let perp1_x = -move_dy;
                                            let perp1_y = move_dx;
                                            let perp2_x = move_dy;
                                            let perp2_y = -move_dx;
                                            let dot1 = perp1_x * (tx - zx) + perp1_y * (ty - zy);
                                            let dot2 = perp2_x * (tx - zx) + perp2_y * (ty - zy);
                                            entry.1 = if dot1 >= dot2 { 1.0 } else { -1.0 };
                                        }

                                        let steer_dir = entry.1;
                                        let creep_dx = -move_dy * steer_dir * 0.8 + move_dx * 0.2;
                                        let creep_dy = move_dx * steer_dir * 0.8 + move_dy * 0.2;
                                        let creep_len = (creep_dx * creep_dx + creep_dy * creep_dy).sqrt();
                                        let (cdx, cdy) = if creep_len > 0.0 {
                                            (creep_dx / creep_len, creep_dy / creep_len)
                                        } else {
                                            (0.0, 0.0)
                                        };

                                        z.pos.x = zx + cdx * z_speed * 0.5 * dt;
                                        z.pos.y = zy + cdy * z_speed * 0.5 * dt;
                                        let (cwx, cwy) = wrap_position(z.pos.x, z.pos.y, ZOMBIE_RADIUS);
                                        z.pos.x = cwx;
                                        z.pos.y = cwy;
                                        z.pos.x = z.pos.x.max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                                        z.pos.y = z.pos.y.max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);
                                        let (cnx, cny) = resolve_wall_collisions(
                                            z.pos.x, z.pos.y, ZOMBIE_RADIUS, &self.wall_grid,
                                        );
                                        z.pos.x = cnx;
                                        z.pos.y = cny;
                                    }
                                } else {
                                    self.zombie_wall_stuck.remove(&zid);
                                    z.pos.x = nx;
                                    z.pos.y = ny;
                                }
                            }
                        }
                    }

                    // Zombie melee attack (respects player dash i-frames!)
                    let z = &self.zombies[zi];
                    if z.health > 0.0 {
                        let zdx = tx - z.pos.x;
                        let zdy = ty - z.pos.y;
                        let dist_to_target = (zdx * zdx + zdy * zdy).sqrt();

                        let attack_damage = match z.zombie_type {
                            ZombieType::Brute => ZOMBIE_DAMAGE * 2.0,
                            ZombieType::Vampire => ZOMBIE_DAMAGE * 0.8,
                            _ => ZOMBIE_DAMAGE,
                        };

                        if dist_to_target < ZOMBIE_ATTACK_RANGE {
                            let target_invuln = self.dash_iframes.get(target_id).copied().unwrap_or(0.0) > 0.0;
                            if !target_invuln {
                                let cd = self
                                    .zombie_attack_cooldowns
                                    .entry(z.id.clone())
                                    .or_insert(0.0);
                                if *cd <= 0.0 {
                                    let attack_speed = match z.zombie_type {
                                        ZombieType::Crawler => ZOMBIE_ATTACK_COOLDOWN * 0.5,
                                        ZombieType::Brute => ZOMBIE_ATTACK_COOLDOWN * 1.5,
                                        _ => ZOMBIE_ATTACK_COOLDOWN,
                                    };
                                    *cd = attack_speed;
                                    damage_to_players.push((target_id.clone(), DamageHit {
                                        source: z.zombie_type.clone(),
                                        enemy_id: z.id.clone(),
                                        damage: attack_damage,
                                        health_after: 0.0,
                                        distance: dist_to_target,
                                        time: self.game_time,
                                    }));

                                    if z.zombie_type == ZombieType::Vampire {
                                        let z_mut = &mut self.zombies[zi];
                                        z_mut.health = (z_mut.health + 15.0).min(z_mut.max_health);
                                    }
                                }
                            }
                        }
                    }
                }

                // Check bullet collisions
                for bi in (0..self.bullets.len()).rev() {
                    if bullet_kill_indices.contains(&bi) || zombie_kill_indices.contains(&zi) {
                        continue;
                    }
                    let b = &self.bullets[bi];
                    let z = &self.zombies[zi];
                    let bdx = b.pos.x - z.pos.x;
                    let bdy = b.pos.y - z.pos.y;
                    let dist = (bdx * bdx + bdy * bdy).sqrt();
                    if dist < ZOMBIE_RADIUS + BULLET_RADIUS {
                        let damage = b.damage;
                        let owner_id = b.owner_id.clone();
                        let is_rocket = b.is_rocket;
                        let impact_x = b.pos.x;
                        let impact_y = b.pos.y;
                        let b_vel_x = b.vel.x;
                        let b_vel_y = b.vel.y;
                        bullet_kill_indices.push(bi);

                        if is_rocket {
                            explosions.push(ExplosionEvent {
                                x: impact_x,
                                y: impact_y,
                                radius: ROCKET_EXPLOSION_RADIUS,
                                damage,
                                owner_id,
                            });
                            break;
                        } else {
                            self.zombies[zi].health -= damage;

                            // Bullet knockback physics
                            let b_speed = (b_vel_x * b_vel_x + b_vel_y * b_vel_y).sqrt();
                            if b_speed > 0.0 {
                                let kb = if damage >= 25.0 { 10.0 } else { 5.0 };
                                let z_mut = &mut self.zombies[zi];
                                z_mut.pos.x = (z_mut.pos.x + (b_vel_x / b_speed) * kb).max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                                z_mut.pos.y = (z_mut.pos.y + (b_vel_y / b_speed) * kb).max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);
                                if z_mut.zombie_type != ZombieType::Brute && z_mut.zombie_type != ZombieType::Crawler {
                                    let (nx, ny) = resolve_wall_collisions(z_mut.pos.x, z_mut.pos.y, ZOMBIE_RADIUS, &self.wall_grid);
                                    z_mut.pos.x = nx;
                                    z_mut.pos.y = ny;
                                }
                            }

                            if self.zombies[zi].health <= 0.0 {
                                let score = zombie_score(&self.zombies[zi].zombie_type);
                                kill_awards.push((owner_id, score));
                                zombie_kill_indices.push(zi);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Process all queued explosions (including chain reactions with barrels/mines!)
        let mut processed_placeables = HashSet::new();
        while let Some(exp) = explosions.pop() {
            // Damage and knock back zombies in blast radius
            for (zi, z) in self.zombies.iter_mut().enumerate() {
                if z.health <= 0.0 {
                    continue;
                }
                let dx = z.pos.x - exp.x;
                let dy = z.pos.y - exp.y;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist < exp.radius {
                    z.health -= exp.damage;
                    if dist > 0.0 {
                        let falloff = (1.0 - dist / exp.radius).max(0.35);
                        let kb = 60.0 * falloff;
                        z.pos.x = (z.pos.x + (dx / dist) * kb).max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                        z.pos.y = (z.pos.y + (dy / dist) * kb).max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);
                    }
                    if z.health <= 0.0 && !zombie_kill_indices.contains(&zi) {
                        let score = zombie_score(&z.zombie_type);
                        kill_awards.push((exp.owner_id.clone(), score));
                        zombie_kill_indices.push(zi);
                    }
                }
            }

            // Chain reaction with other placeables
            for pl in &mut self.placeables {
                if pl.health <= 0.0 || processed_placeables.contains(&pl.id) {
                    continue;
                }
                let dist = f64::hypot(pl.pos.x - exp.x, pl.pos.y - exp.y);
                if dist < exp.radius {
                    match pl.item_type {
                        PlaceableType::Barrel => {
                            pl.health = 0.0;
                            processed_placeables.insert(pl.id.clone());
                            explosions.push(ExplosionEvent {
                                x: pl.pos.x,
                                y: pl.pos.y,
                                radius: BARREL_EXPLOSION_RADIUS,
                                damage: BARREL_DAMAGE,
                                owner_id: exp.owner_id.clone(),
                            });
                        }
                        PlaceableType::Mine => {
                            pl.health = 0.0;
                            processed_placeables.insert(pl.id.clone());
                            explosions.push(ExplosionEvent {
                                x: pl.pos.x,
                                y: pl.pos.y,
                                radius: MINE_EXPLOSION_RADIUS,
                                damage: MINE_DAMAGE,
                                owner_id: exp.owner_id.clone(),
                            });
                        }
                        PlaceableType::Barricade => {
                            pl.health -= exp.damage * 0.35;
                        }
                    }
                }
            }
        }

        // Remove destroyed placeables
        self.placeables.retain(|pl| pl.health > 0.0);

        // Decrement zombie attack cooldowns
        for cd in self.zombie_attack_cooldowns.values_mut() {
            *cd -= dt;
        }

        // Apply damage to players
        for (pid, hit) in damage_to_players {
            if let Some(p) = self.players.get_mut(&pid) {
                if p.health <= 0.0 { continue; }
                p.health = (p.health - hit.damage).max(0.0);
                let mut hit = hit;
                hit.health_after = p.health;
                p.damage_log.retain(|previous| hit.time - previous.time <= 15.0);
                p.damage_log.push(hit);
                if p.damage_log.len() > 32 { p.damage_log.remove(0); }
            }
        }

        // Apply kill & combo awards
        for (pid, score) in &kill_awards {
            if let Some(p) = self.players.get_mut(pid) {
                award_kill_to_player(p, *score);
            }
        }

        // Remove dead zombies (reverse sorted to keep indices valid)
        zombie_kill_indices.sort_unstable();
        zombie_kill_indices.dedup();
        for &zi in zombie_kill_indices.iter().rev() {
            if zi < self.zombies.len() {
                if let Some(d) = roll_drop(&self.zombies[zi].zombie_type, self.zombies[zi].pos.x, self.zombies[zi].pos.y, self.game_time) {
                    self.drops.push(d);
                }
                self.zombie_attack_cooldowns.remove(&self.zombies[zi].id);
                self.zombies.swap_remove(zi);
            }
        }
        self.wave_kills += zombie_kill_indices.len() as u32;

        // Remove bullets that hit zombies
        bullet_kill_indices.sort_unstable();
        bullet_kill_indices.dedup();
        for &bi in bullet_kill_indices.iter().rev() {
            if bi < self.bullets.len() {
                self.bullet_lifetimes.remove(&self.bullets[bi].id);
                self.bullets.swap_remove(bi);
            }
        }

        // Despawn expired drops
        self.drops.retain(|d| d.despawn_at > self.game_time);

        // Wave advancement -> triggers Wave Break!
        let target = self.wave_target();
        if self.wave_kills >= target && self.wave_break_timer <= 0.0 {
            self.wave_break_timer = WAVE_BREAK_DURATION;
            if self.players.values().any(|player| player.health > 0.0) {
                for (id, (score_at_start, kills_at_start)) in &self.wave_entries {
                    if let Some(player) = self.players.get(id) {
                        self.pending_wave_clears.push(WaveClear {
                            player_id: id.clone(), wave: self.wave,
                            score: (player.score - score_at_start).max(0.0),
                            kills: player.kills.saturating_sub(*kills_at_start),
                        });
                    }
                }
            }
            // Clear remaining zombies on wave completion and grant wave clear bonus
            for z in &self.zombies {
                if let Some(d) = roll_drop(&z.zombie_type, z.pos.x, z.pos.y, self.game_time) {
                    self.drops.push(d);
                }
            }
            self.zombies.clear();
            self.zombie_attack_cooldowns.clear();

            let credit_bonus = 100.0 + (self.wave as f64) * 30.0;
            for p in self.players.values_mut() {
                if p.health > 0.0 {
                    p.health = (p.health + 25.0).min(p.max_health);
                    p.ammo = (p.ammo + 15.0).min(p.max_ammo);
                    p.credits += credit_bonus;
                    p.tactical_items[0] = (p.tactical_items[0] + 1).min(99);
                    p.tactical_items[1] = (p.tactical_items[1] + 1).min(99);
                }
            }
        }

        // Revive: living players near dead players revive them over time
        {
            let dead_ids: Vec<String> = self.players.iter()
                .filter(|(_, p)| p.health <= 0.0)
                .map(|(id, _)| id.clone())
                .collect();

            let alive_positions: Vec<(String, f64, f64)> = self.players.iter()
                .filter(|(_, p)| p.health > 0.0)
                .map(|(id, p)| (id.clone(), p.pos.x, p.pos.y))
                .collect();

            for dead_id in &dead_ids {
                let dead_pos = match self.players.get(dead_id) {
                    Some(p) => (p.pos.x, p.pos.y),
                    None => continue,
                };

                let mut reviver: Option<String> = None;
                for (aid, ax, ay) in &alive_positions {
                    let dx = ax - dead_pos.0;
                    let dy = ay - dead_pos.1;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist < REVIVE_RANGE {
                        reviver = Some(aid.clone());
                        break;
                    }
                }

                if let Some(ref reviver_id) = reviver {
                    let entry = self.revive_progress.entry(dead_id.clone())
                        .or_insert((reviver_id.clone(), 0.0));
                    if entry.0 != *reviver_id {
                        *entry = (reviver_id.clone(), 0.0);
                    }
                    entry.1 += dt;

                    if entry.1 >= REVIVE_TIME {
                        if let Some(p) = self.players.get_mut(dead_id) {
                            p.health = REVIVE_HEALTH;
                            p.damage_log.clear();
                        }
                        self.revive_progress.remove(dead_id);
                    }
                } else {
                    self.revive_progress.remove(dead_id);
                }
            }
        }

        // Game over check
        if !self.players.is_empty() && !self.players.values().any(|p| p.health > 0.0) {
            self.game_over = true;
        }
    }

    // ---- Getters ----

    pub fn players(&self) -> &HashMap<String, Player> {
        &self.players
    }

    pub fn zombies(&self) -> &[Zombie] {
        &self.zombies
    }

    pub fn bullets(&self) -> &[Bullet] {
        &self.bullets
    }

    pub fn placeables(&self) -> &[Placeable] {
        &self.placeables
    }

    pub fn drops(&self) -> Vec<DropPickup> {
        self.drops.iter().map(|d| DropPickup {
            id: d.id.clone(),
            drop_type: d.drop_type.clone(),
            pos: Vector2 { x: d.x, y: d.y },
        }).collect()
    }

    pub fn wave(&self) -> u32 {
        self.wave
    }

    pub fn walls(&self) -> &[Wall] {
        &self.walls
    }

    pub fn map_dimensions(&self) -> (f64, f64) {
        (MAP_WIDTH, MAP_HEIGHT)
    }

    pub fn ammo_availability(&self) -> Vec<AmmoPickupState> {
        self.ammo_pickups
            .iter()
            .map(|p| AmmoPickupState {
                id: p.id.clone(),
                available: p.respawn_at.is_none(),
            })
            .collect()
    }

    pub fn ammo_spawn_points(&self) -> Vec<AmmoSpawnPoint> {
        self.ammo_pickups
            .iter()
            .map(|p| AmmoSpawnPoint {
                x: p.x,
                y: p.y,
                amount: p.amount as f64,
            })
            .collect()
    }

    pub fn is_game_over(&self) -> bool {
        self.game_over
    }
}

#[cfg(test)]
mod damage_tests {
    use super::*;

    #[test]
    fn brute_death_records_melee_source_and_final_blow() {
        let mut game = Game::new();
        game.add_player("test", "Tester");
        game.players.get_mut("test").unwrap().health = 30.0;
        let pos = game.players["test"].pos.clone();
        game.zombies.push(Zombie {
            id: "test-brute".into(), zombie_type: ZombieType::Brute,
            pos: Vector2 { x: pos.x + 20.0, y: pos.y },
            health: 1000.0, max_health: 1000.0, speed: 0.0,
        });
        game.update(0.016);
        let player = &game.players["test"];
        assert_eq!(player.health, 0.0);
        let hit = player.damage_log.last().expect("death must have a damage record");
        assert_eq!(hit.source, ZombieType::Brute);
        assert_eq!(hit.enemy_id, "test-brute");
        assert_eq!(hit.damage, 40.0);
        assert_eq!(hit.health_after, 0.0);
        assert!(hit.distance < ZOMBIE_ATTACK_RANGE);
    }

    #[test]
    fn distant_brutes_cannot_deal_damage() {
        let mut game = Game::new();
        game.add_player("test", "Tester");
        let pos = game.players["test"].pos.clone();
        game.zombies.push(Zombie {
            id: "test-brute".into(), zombie_type: ZombieType::Brute,
            pos: Vector2 { x: pos.x + 200.0, y: pos.y },
            health: 1000.0, max_health: 1000.0, speed: 0.0,
        });
        game.update(0.016);
        assert_eq!(game.players["test"].health, 100.0);
        assert!(game.players["test"].damage_log.is_empty());
    }
}

#[cfg(test)]
mod starting_wave_tests {
    use super::*;

    #[test]
    fn empty_round_starts_at_selected_unlocked_wave() {
        let mut game = Game::new();
        assert!(game.start_empty_round(7, 9));
        assert_eq!(game.wave(), 7);
        assert_eq!(game.wave_target(), 84);
        assert_eq!(game.wave_kills(), 0);
        assert!(!game.is_game_over());
    }

    #[test]
    fn requested_wave_cannot_exceed_record_or_go_below_one() {
        let mut game = Game::new();
        game.start_empty_round(100, 4);
        assert_eq!(game.wave(), 4);
        game.start_empty_round(0, 4);
        assert_eq!(game.wave(), 1);
    }

    #[test]
    fn joining_player_cannot_change_an_active_round() {
        let mut game = Game::new();
        game.start_empty_round(5, 5);
        game.add_player("host", "Host");
        assert!(!game.start_empty_round(20, 20));
        assert_eq!(game.wave(), 5);
        assert_eq!(game.players()["host"].health, 100.0);
    }

    #[test]
    fn replay_at_selected_wave_respawns_players_and_clears_recap() {
        let mut game = Game::new();
        game.add_player("host", "Host");
        game.players.get_mut("host").unwrap().health = 0.0;
        game.reset_at_wave(8, 8);
        assert_eq!(game.wave(), 8);
        assert_eq!(game.players()["host"].health, 100.0);
        assert!(game.players()["host"].damage_log.is_empty());
    }
}

#[cfg(test)]
mod host_pause_tests {
    use super::*;

    #[test]
    fn only_first_connected_player_can_pause_or_resume() {
        let mut game = Game::new();
        game.add_player("first", "First"); game.add_player("second", "Second");
        assert_eq!(game.host_id(), Some("first"));
        assert!(!game.set_paused("second", true));
        assert!(!game.set_paused("missing", true));
        assert!(!game.is_paused());
        assert!(game.set_paused("first", true));
        assert!(!game.set_paused("second", false));
        assert!(game.is_paused());
        assert!(game.set_paused("first", false));
    }

    #[test]
    fn pause_freezes_entire_world_and_rejects_inputs() {
        let mut game = Game::new(); game.add_player("host", "Host");
        game.update(0.016);
        let clock = game.game_time;
        let before = serde_json::to_string(&game.players).unwrap();
        let enemies = serde_json::to_string(&game.zombies).unwrap();
        let spawn_timer = game.zombie_spawn_timer;
        game.set_paused("host", true);
        let input = serde_json::from_value(serde_json::json!({
            "up":true,"down":false,"left":false,"right":false,
            "mouseX":0,"mouseY":0,"shooting":true,"melee":true,"selectWeapon":0,
            "dash":true,"placeItem":1,"buyUpgrade":1,
        })).unwrap();
        game.handle_input("host", input);
        for _ in 0..120 { game.update(1.0/60.0); }
        assert_eq!(game.game_time, clock);
        assert_eq!(game.zombie_spawn_timer, spawn_timer);
        assert_eq!(serde_json::to_string(&game.players).unwrap(), before);
        assert_eq!(serde_json::to_string(&game.zombies).unwrap(), enemies);
        assert!(game.inputs.is_empty());
        game.set_paused("host", false); game.update(0.016);
        assert!(game.game_time > clock);
    }

    #[test]
    fn host_departure_resumes_and_transfers_to_oldest_remaining_player() {
        let mut game = Game::new();
        for id in ["one", "two", "three"] { game.add_player(id, id); }
        game.set_paused("one", true);
        game.remove_player("one");
        assert!(!game.is_paused());
        assert_eq!(game.host_id(), Some("two"));
        assert!(game.set_paused("two", true));
        game.remove_player("three");
        assert!(game.is_paused());
        game.remove_player("two");
        assert_eq!(game.host_id(), None); assert!(!game.is_paused());
    }

    #[test]
    fn restart_preserves_host_order_and_unpauses() {
        let mut game = Game::new();
        game.add_player("z", "Host"); game.add_player("a", "Guest");
        game.set_paused("z", true); game.reset_at_wave(5, 5);
        assert_eq!(game.host_id(), Some("z"));
        assert_eq!(game.join_order, vec!["z", "a"]);
        assert!(!game.is_paused());
        assert_eq!(game.wave(), 5);
    }

    #[test]
    fn a_late_joiner_does_not_unpause_or_take_host() {
        let mut game = Game::new(); game.add_player("host", "Host");
        game.set_paused("host", true);
        game.add_player("new", "New");
        assert!(game.is_paused()); assert_eq!(game.host_id(), Some("host"));
    }
}

#[cfg(test)]
mod wave_clear_credit_tests {
    use super::*;

    fn finish_wave(game: &mut Game) {
        game.wave_kills = game.wave_target();
        game.update(0.0);
    }

    #[test]
    fn only_full_wave_participants_get_clear_credit() {
        let mut game = Game::new(); game.add_player("host", "Host");
        game.wave_kills = 1;
        game.add_player("late", "Late");
        game.players.get_mut("host").unwrap().score = 120.0;
        game.players.get_mut("host").unwrap().kills = 3;
        finish_wave(&mut game);
        let clears = game.take_wave_clears();
        assert_eq!(clears.len(), 1);
        assert_eq!(clears[0].player_id, "host");
        assert_eq!(clears[0].wave, 1);
        assert_eq!(clears[0].score, 120.0);
        assert_eq!(clears[0].kills, 3);
        game.update(0.0);
        assert!(game.take_wave_clears().is_empty());
        game.wave_break_timer = 0.01; game.update(0.02);
        assert!(game.wave_entries.contains_key("late"));
        game.players.get_mut("host").unwrap().score += 25.0;
        finish_wave(&mut game);
        let clears = game.take_wave_clears();
        assert_eq!(clears.len(), 2);
        assert_eq!(clears.iter().find(|clear| clear.player_id == "host").unwrap().score, 25.0);
    }

    #[test]
    fn joining_before_first_kill_qualifies_but_leaving_does_not() {
        let mut game = Game::new();
        for id in ["host", "squadmate", "leaver"] { game.add_player(id, id); }
        game.remove_player("leaver"); finish_wave(&mut game);
        let clears = game.take_wave_clears();
        assert_eq!(clears.len(), 2);
        assert!(!clears.iter().any(|clear| clear.player_id == "leaver"));
    }

    #[test]
    fn downed_teammates_share_clear_but_a_total_wipe_does_not() {
        let mut game = Game::new();
        game.add_player("alive", "Alive"); game.add_player("down", "Down");
        game.players.get_mut("down").unwrap().health = 0.0;
        finish_wave(&mut game);
        assert_eq!(game.take_wave_clears().len(), 2);
        game.reset();
        for player in game.players.values_mut() { player.health = 0.0; }
        finish_wave(&mut game);
        assert!(game.take_wave_clears().is_empty());
    }

    #[test]
    fn restart_clears_pending_awards_and_reinitializes_wave_entries() {
        let mut game = Game::new(); game.add_player("host", "Host");
        finish_wave(&mut game);
        game.reset_at_wave(4, 4);
        assert!(game.take_wave_clears().is_empty());
        assert!(game.wave_entries.contains_key("host"));
        finish_wave(&mut game);
        assert_eq!(game.take_wave_clears()[0].wave, 4);
    }
}

#[cfg(test)]
mod progression_tick_tests {
    use super::*;

    fn state(game: Game, profiles: HashMap<String, (String, u32)>) -> crate::AppState {
        crate::AppState {
            game: tokio::sync::Mutex::new(game),
            delta_tracker: tokio::sync::Mutex::new(crate::delta::DeltaTracker::new()),
            clients: tokio::sync::Mutex::new(HashMap::new()),
            pending_snapshots: tokio::sync::Mutex::new(HashSet::new()),
            wave_profiles: tokio::sync::Mutex::new(profiles),
            last_room_status: tokio::sync::Mutex::new(String::new()),
            social: tokio::sync::Mutex::new(crate::social::SocialState::new()),
            db: crate::db::Database::open(":memory:").unwrap(),
            google_client_id: String::new(), google_client_secret: String::new(),
        }
    }

    #[tokio::test]
    async fn authoritative_clear_persists_and_notifies_only_eligible_profile() {
        let mut game = Game::new(); game.add_player("host", "Host");
        game.wave_kills = 1; game.add_player("late", "Late");
        game.wave_kills = game.wave_target();
        let state = state(game, HashMap::from([
            ("host".into(), ("host-browser".into(), 1)),
            ("late".into(), ("late-browser".into(), 1)),
        ]));
        let (host_tx, mut host_rx) = tokio::sync::mpsc::channel(4);
        let (late_tx, mut late_rx) = tokio::sync::mpsc::channel(4);
        state.clients.lock().await.extend([("host".into(), host_tx), ("late".into(), late_tx)]);
        crate::tick(&state).await;
        assert_eq!(state.db.unlocked_wave("host-browser"), 2);
        assert_eq!(state.db.unlocked_wave("late-browser"), 1);
        let mut received_progress = false;
        while let Ok(message) = host_rx.try_recv() {
            let data: serde_json::Value = serde_json::from_str(&message).unwrap();
            if data["type"] == "progress" {
                assert_eq!(data["progress"]["unlockedWave"], 2); received_progress = true;
            }
        }
        assert!(received_progress);
        while let Ok(message) = late_rx.try_recv() {
            let data: serde_json::Value = serde_json::from_str(&message).unwrap();
            assert_ne!(data["type"], "progress");
        }
    }

    #[tokio::test]
    async fn duplicate_tabs_count_one_clear_per_profile() {
        let mut game = Game::new(); game.add_player("one", "One"); game.add_player("two", "Two");
        game.players.get_mut("one").unwrap().score = 100.0;
        game.players.get_mut("two").unwrap().score = 200.0;
        game.wave_kills = game.wave_target();
        let state = state(game, HashMap::from([
            ("one".into(), ("same-browser".into(), 1)),
            ("two".into(), ("same-browser".into(), 1)),
        ]));
        let (one_tx, _one_rx) = tokio::sync::mpsc::channel(4);
        let (two_tx, _two_rx) = tokio::sync::mpsc::channel(4);
        state.clients.lock().await.extend([("one".into(), one_tx), ("two".into(), two_tx)]);
        crate::tick(&state).await;
        let progress = state.db.progress("same-browser");
        assert_eq!(progress.levels[0].clears, 1);
        assert_eq!(progress.levels[0].best_score, 200.0);
    }
}
