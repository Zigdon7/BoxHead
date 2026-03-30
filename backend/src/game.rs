use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use rand::Rng;
use uuid::Uuid;

use crate::map::*;
use crate::spatial_grid::SpatialGrid;
use crate::types::*;

// ---------- Spatial-grid helper structs ----------

/// Wall entry inserted into multiple grid cells. Carries its insertion
/// position (`cell_x`, `cell_y`) separately from its actual rect so that
/// `SpatialGrid::insert` places it in the correct cell.
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
        // Center is inside the rect - push out along minimum overlap axis
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

    // Dedup walls by their rect (same wall may appear in multiple cells)
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
        ZombieType::Zombie => 10.0,
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

    let (ammo_chance, health_chance, weapon_chance) = match zombie_type {
        ZombieType::Zombie => (0.20, 0.05, 0.02),
        ZombieType::Devil => (0.30, 0.10, 0.05),
        ZombieType::Crawler => (0.15, 0.05, 0.03),
        ZombieType::Brute => (0.40, 0.15, 0.10),
        ZombieType::Vampire => (0.25, 0.20, 0.08),
    };

    let drop_type = if roll < ammo_chance { Some(DropType::Ammo) }
        else if roll < ammo_chance + health_chance { Some(DropType::Health) }
        else if roll < ammo_chance + health_chance + weapon_chance { Some(DropType::Weapon) }
        else { None };

    drop_type.map(|dt| DropInternal {
        id: uuid::Uuid::new_v4().to_string(),
        drop_type: dt,
        x, y,
        despawn_at: game_time + DROP_DESPAWN_TIME,
    })
}

// ---------- Game ----------

pub struct Game {
    players: HashMap<String, Player>,
    player_names: HashMap<String, String>,
    inputs: HashMap<String, ClientInput>,
    zombies: Vec<Zombie>,
    bullets: Vec<Bullet>,
    drops: Vec<DropInternal>,
    wave: u32,
    game_over: bool,
    zombie_spawn_timer: f64,
    wave_kills: u32,
    shoot_cooldowns: HashMap<String, f64>,
    melee_cooldowns: HashMap<String, f64>,
    zombie_attack_cooldowns: HashMap<String, f64>,
    bullet_lifetimes: HashMap<String, f64>,
    game_time: f64,
    ammo_pickups: Vec<AmmoPickupInternal>,
    walls: Vec<Wall>,
    wall_grid: SpatialGrid<WallEntry>,
    zombie_grid: SpatialGrid<ZombieRef>,
    player_grid: SpatialGrid<PlayerRef>,
    // Dash state per player: charges and active burst timer
    dash_charges: HashMap<String, i32>,
    dash_recharge: HashMap<String, f64>, // time until next charge restored
    dash_active: HashMap<String, f64>,
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
            inputs: HashMap::new(),
            zombies: Vec::new(),
            bullets: Vec::new(),
            drops: Vec::new(),
            wave: 1,
            game_over: false,
            zombie_spawn_timer: 0.0,
            wave_kills: 0,
            shoot_cooldowns: HashMap::new(),
            melee_cooldowns: HashMap::new(),
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
            revive_progress: HashMap::new(),
            zombie_wall_stuck: HashMap::new(),
        }
    }

    /// Reset the game world but keep connected players (respawn them).
    pub fn reset(&mut self) {
        self.zombies.clear();
        self.bullets.clear();
        self.drops.clear();
        self.wave = 1;
        self.game_over = false;
        self.zombie_spawn_timer = 0.0;
        self.wave_kills = 0;
        self.shoot_cooldowns.clear();
        self.melee_cooldowns.clear();
        self.zombie_attack_cooldowns.clear();
        self.bullet_lifetimes.clear();
        self.dash_charges.clear();
        self.dash_recharge.clear();
        self.dash_active.clear();
        self.revive_progress.clear();
        self.zombie_wall_stuck.clear();
        self.game_time = 0.0;
        for pickup in &mut self.ammo_pickups {
            pickup.respawn_at = None;
        }
        // Respawn all players (preserve names)
        let ids: Vec<String> = self.players.keys().cloned().collect();
        self.players.clear();
        self.inputs.clear();
        for id in ids {
            let name = self.player_names.get(&id).cloned().unwrap_or_default();
            self.add_player(&id, &name);
        }
    }

    pub fn add_player(&mut self, id: &str, name: &str) {
        self.player_names.insert(id.to_string(), name.to_string());
        let player = Player {
            id: id.to_string(),
            name: name.to_string(),
            pos: Vector2 { x: MAP_WIDTH / 2.0, y: MAP_HEIGHT / 2.0 },
            angle: 0.0,
            score: 0.0,
            health: 100.0,
            ammo: 30.0,
            max_ammo: 30.0,
            weapon: Weapon::Pistol,
            weapon_slots: [true, false, false, false],
        };
        self.players.insert(id.to_string(), player);
    }

    pub fn remove_player(&mut self, id: &str) {
        self.players.remove(id);
        self.player_names.remove(id);
        self.inputs.remove(id);
        self.shoot_cooldowns.remove(id);
        self.melee_cooldowns.remove(id);
    }

    pub fn handle_input(&mut self, id: &str, input: ClientInput) {
        self.inputs.insert(id.to_string(), input);
    }

    pub fn update(&mut self, dt: f64) {
        if self.game_over {
            return;
        }

        self.game_time += dt;

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

        // Update players
        let player_ids: Vec<String> = self.players.keys().cloned().collect();

        for pid in &player_ids {
            if self.players.get(pid).map_or(true, |p| p.health <= 0.0) {
                continue;
            }

            let input = match self.inputs.get(pid) {
                Some(i) => i.clone(),
                None => continue,
            };

            // Dash logic — charge-based (max 3)
            {
                let charges = self.dash_charges.entry(pid.clone()).or_insert(DASH_MAX_CHARGES);
                let recharge = self.dash_recharge.entry(pid.clone()).or_insert(0.0);
                let active = self.dash_active.entry(pid.clone()).or_insert(0.0);
                *active = (*active - dt).max(0.0);

                // Recharge one charge over time
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
                    *charges -= 1;
                    if *charges < DASH_MAX_CHARGES {
                        // Start recharge timer if not already running
                        if *recharge <= 0.0 {
                            *recharge = DASH_RECHARGE_TIME;
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

            let speed = if is_dashing { PLAYER_SPEED * DASH_SPEED_MULT } else { PLAYER_SPEED };

            {
                let p = self.players.get_mut(pid).unwrap();
                p.pos.x += dx * speed * dt;
                p.pos.y += dy * speed * dt;

                // Try wrapping through tunnels first
                let (wx, wy) = wrap_position(p.pos.x, p.pos.y, PLAYER_RADIUS);
                p.pos.x = wx;
                p.pos.y = wy;

                // Then clamp to map bounds (only matters if not in a tunnel)
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

            // Melee attack
            let melee_cd = *self.melee_cooldowns.get(pid).unwrap();
            if input.melee && melee_cd <= 0.0 {
                self.melee_cooldowns.insert(pid.clone(), MELEE_COOLDOWN);

                let p = self.players.get(pid).unwrap();
                let px = p.pos.x;
                let py = p.pos.y;
                let p_angle = p.angle;

                let nearby = self.zombie_grid.query(px, py, MELEE_RANGE);
                let mut indices: Vec<usize> = nearby.iter().map(|zr| zr.index).collect();
                indices.sort_unstable();
                indices.dedup();

                let mut kills = 0u32;
                for &zi in &indices {
                    if zi >= self.zombies.len() {
                        continue;
                    }
                    let z = &self.zombies[zi];
                    let zdx = z.pos.x - px;
                    let zdy = z.pos.y - py;
                    let dist = (zdx * zdx + zdy * zdy).sqrt();
                    if dist > MELEE_RANGE {
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

                    self.zombies[zi].health -= MELEE_DAMAGE;

                    if dist > 0.0 {
                        let knx = zdx / dist;
                        let kny = zdy / dist;
                        self.zombies[zi].pos.x += knx * 30.0;
                        self.zombies[zi].pos.y += kny * 30.0;
                    }

                    if self.zombies[zi].health <= 0.0 {
                        let score = zombie_score(&self.zombies[zi].zombie_type);
                        if let Some(d) = roll_drop(&self.zombies[zi].zombie_type, self.zombies[zi].pos.x, self.zombies[zi].pos.y, self.game_time) {
                            self.drops.push(d);
                        }
                        if let Some(p) = self.players.get_mut(pid) {
                            p.score += score;
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
                    self.shoot_cooldowns.insert(pid.clone(), weapon.cooldown());

                    let angle = p.angle;
                    let px = p.pos.x;
                    let py = p.pos.y;
                    let damage = weapon.damage();
                    let owner_id = pid.clone();

                    if !is_pistol {
                        self.players.get_mut(pid).unwrap().ammo -= 1.0;
                    }

                    match weapon {
                        Weapon::Shotgun => {
                            let spread = PI / 12.0;
                            for i in 0..5 {
                                let a = angle - spread * 2.0 + spread * i as f64;
                                let bid = Uuid::new_v4().to_string();
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
                                    damage: damage / 5.0,
                                });
                            }
                        }
                        Weapon::RocketLauncher => {
                            let bid = Uuid::new_v4().to_string();
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
                                damage: ROCKET_DAMAGE,
                            });
                        }
                        _ => {
                            let bid = Uuid::new_v4().to_string();
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
                                damage,
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
                if drop.despawn_at <= self.game_time { continue; } // already expired
                let dist = f64::hypot(p.pos.x - drop.x, p.pos.y - drop.y);
                if dist < PLAYER_RADIUS + DROP_PICKUP_RADIUS {
                    match drop.drop_type {
                        DropType::Ammo => { p.ammo = (p.ammo + DROP_AMMO_AMOUNT).min(p.max_ammo); }
                        DropType::Health => { p.health = (p.health + DROP_HEALTH_AMOUNT).min(100.0); }
                        DropType::Weapon => {
                            // Unlock a random locked weapon slot
                            let locked: Vec<usize> = (1..4).filter(|&s| !p.weapon_slots[s]).collect();
                            if locked.is_empty() {
                                p.ammo = (p.ammo + DROP_AMMO_AMOUNT).min(p.max_ammo); // fallback to ammo
                            } else {
                                let idx = locked[rng.random_range(0..locked.len())];
                                p.weapon_slots[idx] = true;
                            }
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

        // Update bullet positions
        for bullet in &mut self.bullets {
            bullet.pos.x += bullet.vel.x * dt;
            bullet.pos.y += bullet.vel.y * dt;
        }

        // Filter bullets (OOB / lifetime / wall) — rockets explode on wall hit
        {
            let mut rocket_explosions: Vec<(f64, f64)> = Vec::new();
            let wall_grid = &self.wall_grid;
            let lifetimes = &mut self.bullet_lifetimes;
            self.bullets.retain(|b| {
                if let Some(lt) = lifetimes.get_mut(&b.id) {
                    *lt -= dt;
                    if *lt <= 0.0 {
                        lifetimes.remove(&b.id);
                        if b.damage >= 100.0 {
                            rocket_explosions.push((b.pos.x, b.pos.y));
                        }
                        return false;
                    }
                }
                // Wrap bullets through tunnels
                let (bwx, bwy) = wrap_position(b.pos.x, b.pos.y, BULLET_RADIUS);
                b.pos.x = bwx;
                b.pos.y = bwy;

                // Only remove if out of bounds AND not in a tunnel (wrapping didn't help)
                if b.pos.x < -BULLET_RADIUS
                    || b.pos.x > MAP_WIDTH + BULLET_RADIUS
                    || b.pos.y < -BULLET_RADIUS
                    || b.pos.y > MAP_HEIGHT + BULLET_RADIUS
                {
                    lifetimes.remove(&b.id);
                    if b.damage >= 100.0 {
                        rocket_explosions.push((b.pos.x, b.pos.y));
                    }
                    return false;
                }
                if bullet_hits_wall(b.pos.x, b.pos.y, wall_grid) {
                    lifetimes.remove(&b.id);
                    if b.damage >= 100.0 {
                        rocket_explosions.push((b.pos.x, b.pos.y));
                    }
                    return false;
                }
                true
            });

            // Apply rocket AoE damage from wall/OOB explosions
            for (ex, ey) in &rocket_explosions {
                for z in &mut self.zombies {
                    let dist = f64::hypot(z.pos.x - ex, z.pos.y - ey);
                    if dist < ROCKET_EXPLOSION_RADIUS {
                        z.health -= ROCKET_DAMAGE;
                    }
                }
            }
        }

        // Spawn zombies
        self.zombie_spawn_timer -= dt;
        if self.zombie_spawn_timer <= 0.0 {
            self.zombie_spawn_timer = 0.5 / (1.0 + (self.wave as f64 - 1.0) * 0.2);

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

                let (zombie_type, hp, speed) = if wave >= 5 && r < 0.05 {
                    (
                        ZombieType::Vampire,
                        80.0 + wave as f64 * 15.0,
                        90.0 + wave as f64 * 5.0,
                    )
                } else if wave >= 4 && r < 0.15 {
                    (
                        ZombieType::Brute,
                        150.0 + wave as f64 * 30.0,
                        30.0 + wave as f64 * 2.0,
                    )
                } else if wave >= 3 && r < 0.30 {
                    (
                        ZombieType::Crawler,
                        10.0 + wave as f64 * 5.0,
                        120.0 + wave as f64 * 5.0,
                    )
                } else if wave >= 2 && r < 0.40 {
                    (
                        ZombieType::Devil,
                        50.0 + wave as f64 * 20.0,
                        80.0 + wave as f64 * 5.0,
                    )
                } else {
                    (
                        ZombieType::Zombie,
                        20.0 + wave as f64 * 10.0,
                        50.0 + wave as f64 * 5.0,
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

        // Rebuild zombie grid
        self.zombie_grid.clear();
        for (i, z) in self.zombies.iter().enumerate() {
            self.zombie_grid.insert(ZombieRef {
                index: i,
                x: z.pos.x,
                y: z.pos.y,
            });
        }

        // Update zombies
        let player_positions: Vec<(String, f64, f64)> = self
            .players
            .values()
            .filter(|p| p.health > 0.0)
            .map(|p| (p.id.clone(), p.pos.x, p.pos.y))
            .collect();

        if !player_positions.is_empty() {
            let mut zombie_kill_indices: Vec<usize> = Vec::new();
            let mut bullet_kill_indices: Vec<usize> = Vec::new();
            let mut score_awards: Vec<(String, f64)> = Vec::new();
            let mut damage_to_players: Vec<(String, f64)> = Vec::new();

            for zi in (0..self.zombies.len()).rev() {
                let z = &self.zombies[zi];
                let zx = z.pos.x;
                let zy = z.pos.y;
                let z_speed = z.speed;

                // Find nearest player (spatial query first, then fallback)
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

                        // Per-type movement AI
                        let (mut move_dx, mut move_dy) = (tdx / tdist, tdy / tdist);

                        match z_type {
                            ZombieType::Crawler => {
                                // Skitter: zigzag toward player
                                let phase = (self.game_time * 8.0 + zid_hash as f64 * 0.1).sin() * 0.7;
                                let perp_x = -move_dy;
                                let perp_y = move_dx;
                                move_dx += perp_x * phase;
                                move_dy += perp_y * phase;
                                let len = (move_dx * move_dx + move_dy * move_dy).sqrt();
                                if len > 0.0 { move_dx /= len; move_dy /= len; }
                            }
                            ZombieType::Devil => {
                                // Hellion: periodic charge bursts (2x speed for 0.3s every 2s)
                                let cycle = (self.game_time + zid_hash as f64 * 0.3) % 2.0;
                                if cycle < 0.3 {
                                    let burst = 2.0;
                                    move_dx *= burst;
                                    move_dy *= burst;
                                }
                            }
                            ZombieType::Vampire => {
                                // Shade: flank — approach at an angle, circle when close
                                if tdist < 200.0 {
                                    // Circle the player
                                    let circle_dir = if zid_hash % 2 == 0 { 1.0 } else { -1.0 };
                                    let perp_x = -move_dy * circle_dir;
                                    let perp_y = move_dx * circle_dir;
                                    move_dx = move_dx * 0.3 + perp_x * 0.7;
                                    move_dy = move_dy * 0.3 + perp_y * 0.7;
                                    let len = (move_dx * move_dx + move_dy * move_dy).sqrt();
                                    if len > 0.0 { move_dx /= len; move_dy /= len; }
                                } else {
                                    // Approach at 30-degree offset
                                    let angle_offset: f64 = if zid_hash % 2 == 0 { 0.5 } else { -0.5 };
                                    let cos_a = angle_offset.cos();
                                    let sin_a = angle_offset.sin();
                                    let rx = move_dx * cos_a - move_dy * sin_a;
                                    let ry = move_dx * sin_a + move_dy * cos_a;
                                    move_dx = rx;
                                    move_dy = ry;
                                }
                            }
                            _ => {} // Walker and Brute: direct approach
                        }

                        z.pos.x += move_dx * z_speed * dt;
                        z.pos.y += move_dy * z_speed * dt;

                        // Wrap through tunnels
                        let (zwx, zwy) = wrap_position(z.pos.x, z.pos.y, ZOMBIE_RADIUS);
                        z.pos.x = zwx;
                        z.pos.y = zwy;

                        z.pos.x = z.pos.x.max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                        z.pos.y = z.pos.y.max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);

                        // Wall collision — Brutes and Crawlers ignore walls
                        match z_type {
                            ZombieType::Brute | ZombieType::Crawler => {
                                // These types phase/smash through walls
                            }
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
                                        // Brief pause — zombie bumps into wall
                                        z.pos.x = nx;
                                        z.pos.y = ny;
                                    } else {
                                        // Creep around: pick a steer direction on first stuck frame past delay
                                        if entry.1 == 0.0 {
                                            // Choose steer direction based on wall normal
                                            // Try both perpendicular directions, pick the one closer to target
                                            let perp1_x = -move_dy;
                                            let perp1_y = move_dx;
                                            let perp2_x = move_dy;
                                            let perp2_y = -move_dx;
                                            // Dot product with direction to target to pick best side
                                            let dot1 = perp1_x * (tx - zx) + perp1_y * (ty - zy);
                                            let dot2 = perp2_x * (tx - zx) + perp2_y * (ty - zy);
                                            entry.1 = if dot1 >= dot2 { 1.0 } else { -1.0 };
                                        }

                                        let steer_dir = entry.1;
                                        // Blend: mostly perpendicular, slightly toward target
                                        let creep_dx = -move_dy * steer_dir * 0.8 + move_dx * 0.2;
                                        let creep_dy = move_dx * steer_dir * 0.8 + move_dy * 0.2;
                                        let creep_len = (creep_dx * creep_dx + creep_dy * creep_dy).sqrt();
                                        let (cdx, cdy) = if creep_len > 0.0 {
                                            (creep_dx / creep_len, creep_dy / creep_len)
                                        } else {
                                            (0.0, 0.0)
                                        };

                                        // Move at half speed while creeping
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
                                    // Not blocked — clear stuck state
                                    self.zombie_wall_stuck.remove(&zid);
                                    z.pos.x = nx;
                                    z.pos.y = ny;
                                }
                            }
                        }
                    }

                    // Zombie melee attack
                    let z = &self.zombies[zi];
                    let zdx = tx - z.pos.x;
                    let zdy = ty - z.pos.y;
                    let dist_to_target = (zdx * zdx + zdy * zdy).sqrt();

                    let attack_damage = match z.zombie_type {
                        ZombieType::Brute => ZOMBIE_DAMAGE * 2.0,    // Juggernaut hits hard
                        ZombieType::Vampire => ZOMBIE_DAMAGE * 0.8,  // Shade: lighter hit but heals
                        _ => ZOMBIE_DAMAGE,
                    };

                    if dist_to_target < ZOMBIE_ATTACK_RANGE {
                        let cd = self
                            .zombie_attack_cooldowns
                            .entry(z.id.clone())
                            .or_insert(0.0);
                        if *cd <= 0.0 {
                            let attack_speed = match z.zombie_type {
                                ZombieType::Crawler => ZOMBIE_ATTACK_COOLDOWN * 0.5, // Skitter attacks fast
                                ZombieType::Brute => ZOMBIE_ATTACK_COOLDOWN * 1.5,   // Juggernaut slow swing
                                _ => ZOMBIE_ATTACK_COOLDOWN,
                            };
                            *cd = attack_speed;
                            damage_to_players.push((target_id.clone(), attack_damage));

                            // Vampire heals on hit
                            if z.zombie_type == ZombieType::Vampire {
                                let z_mut = &mut self.zombies[zi];
                                z_mut.health = (z_mut.health + 15.0).min(z_mut.max_health);
                            }
                        }
                    }
                }

                // Check bullet collisions
                for bi in (0..self.bullets.len()).rev() {
                    if bullet_kill_indices.contains(&bi) {
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
                        let is_rocket = damage >= 100.0;
                        let impact_x = b.pos.x;
                        let impact_y = b.pos.y;
                        bullet_kill_indices.push(bi);

                        if is_rocket {
                            // Rocket AoE: damage all zombies in explosion radius
                            for zj in 0..self.zombies.len() {
                                let aoe_dist = f64::hypot(self.zombies[zj].pos.x - impact_x, self.zombies[zj].pos.y - impact_y);
                                if aoe_dist < ROCKET_EXPLOSION_RADIUS {
                                    self.zombies[zj].health -= ROCKET_DAMAGE;
                                    if self.zombies[zj].health <= 0.0 && !zombie_kill_indices.contains(&zj) {
                                        let score = zombie_score(&self.zombies[zj].zombie_type);
                                        score_awards.push((owner_id.clone(), score));
                                        zombie_kill_indices.push(zj);
                                    }
                                }
                            }
                            break;
                        } else {
                            self.zombies[zi].health -= damage;
                            if self.zombies[zi].health <= 0.0 {
                                let score = zombie_score(&self.zombies[zi].zombie_type);
                                score_awards.push((owner_id, score));
                                zombie_kill_indices.push(zi);
                                break;
                            }
                        }
                    }
                }
            }

            // Decrement zombie attack cooldowns
            for cd in self.zombie_attack_cooldowns.values_mut() {
                *cd -= dt;
            }

            // Apply damage to players
            for (pid, dmg) in &damage_to_players {
                if let Some(p) = self.players.get_mut(pid) {
                    p.health = (p.health - dmg).max(0.0);
                }
            }

            // Apply score awards
            for (pid, score) in &score_awards {
                if let Some(p) = self.players.get_mut(pid) {
                    p.score += score;
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
        }

        // Despawn expired drops
        self.drops.retain(|d| d.despawn_at > self.game_time);

        // Wave advancement
        if self.wave_kills >= self.wave * 10 {
            self.wave += 1;
            self.wave_kills = 0;
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

                // Find closest alive player within revive range
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
                    // Reset progress if a different player is reviving
                    if entry.0 != *reviver_id {
                        *entry = (reviver_id.clone(), 0.0);
                    }
                    entry.1 += dt;

                    if entry.1 >= REVIVE_TIME {
                        // Revive the player
                        if let Some(p) = self.players.get_mut(dead_id) {
                            p.health = REVIVE_HEALTH;
                        }
                        self.revive_progress.remove(dead_id);
                    }
                } else {
                    // No one nearby — reset progress
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
