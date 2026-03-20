use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use rand::Rng;
use uuid::Uuid;

use crate::map::*;
use crate::spatial_grid::SpatialGrid;
use crate::types::*;

// ---------- Spatial-grid helper structs ----------

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
        // Center is inside the rect – push out along minimum overlap axis
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

fn point_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

// Dead code removed — see build_wall_grid_impl and bullet_hits_wall_at below
#[cfg(any())]
fn _dead(_walls: &[Wall]) {
    for _wall in _walls {
        // Insert the wall into every cell it overlaps
        let min_col = (wall.x / WALL_GRID_CELL_SIZE).floor() as i32;
        let max_col = ((wall.x + wall.w) / WALL_GRID_CELL_SIZE).floor() as i32;
        let min_row = (wall.y / WALL_GRID_CELL_SIZE).floor() as i32;
        let max_row = ((wall.y + wall.h) / WALL_GRID_CELL_SIZE).floor() as i32;

        let cols = (MAP_WIDTH / WALL_GRID_CELL_SIZE).ceil() as i32;
        let rows = (MAP_HEIGHT / WALL_GRID_CELL_SIZE).ceil() as i32;

        for row in min_row.max(0)..=max_row.min(rows - 1) {
            for col in min_col.max(0)..=max_col.min(cols - 1) {
                let cx = (col as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                let cy = (row as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                // We insert a WallEntry positioned at the cell center so it lands in the right cell
                // But we need its actual rect for collision. Trick: position at cell center.
                // Actually, we need to insert directly into the cell. Since SpatialGrid::insert
                // uses pos() to determine the cell, we position each copy at that cell's center.
                let entry = WallEntry {
                    x: wall.x,
                    y: wall.y,
                    w: wall.w,
                    h: wall.h,
                };
                // We need to insert with position mapping to this specific cell.
                // Use a wrapper that overrides pos. Simpler: just insert centered on cell.
                let _ = cx;
                let _ = cy;
                // The grid's insert uses the Positioned trait. Since WallEntry::pos() returns center
                // of the wall, a large wall will only go into one cell. We need multi-cell insertion.
                // Let's insert with a position set to each cell's center instead.
                let cell_entry = WallEntry {
                    x: wall.x,
                    y: wall.y,
                    w: wall.w,
                    h: wall.h,
                };
                // We'll manually place it. But SpatialGrid only has insert which uses pos().
                // We need to work around this. Let's create a special WallEntry for each cell
                // whose "pos" maps to that cell.
                // Actually, let's just use a different approach: insert the wall once and
                // query with a large enough radius. The resolve_wall_collisions already uses
                // query_radius = radius + WALL_GRID_CELL_SIZE which should catch nearby walls.
                // But for correctness with large walls, we want multi-cell insertion.
                // Let's create a CellWallEntry that has a fake position.
                let _ = cell_entry;
                // We'll handle this below with direct cell manipulation.
                let _ = entry;
                break; // break out, we'll use a different strategy
            }
            break;
        }
    }

    // Better approach: insert each wall with its center position. The query radius in
    // resolve_wall_collisions is generous enough. But for very large walls (like boundary walls
    // spanning the full map), this won't work well. Let's create multiple entries per wall
    // by creating WallEntry copies positioned at each cell they overlap.
    let mut grid2 = SpatialGrid::new(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE);
    for wall in walls {
        let min_col = (wall.x / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let max_col = ((wall.x + wall.w) / WALL_GRID_CELL_SIZE)
            .floor()
            .max(0.0) as usize;
        let min_row = (wall.y / WALL_GRID_CELL_SIZE).floor().max(0.0) as usize;
        let max_row = ((wall.y + wall.h) / WALL_GRID_CELL_SIZE)
            .floor()
            .max(0.0) as usize;

        for row in min_row..=max_row {
            for col in min_col..=max_col {
                let cx = (col as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                let cy = (row as f64 + 0.5) * WALL_GRID_CELL_SIZE;
                // Create entry whose pos() returns cell center so it's inserted into correct cell
                let entry = CellWallEntry {
                    x: wall.x,
                    y: wall.y,
                    w: wall.w,
                    h: wall.h,
                    cell_x: cx,
                    cell_y: cy,
                };
                // But our grid is SpatialGrid<WallEntry>, not SpatialGrid<CellWallEntry>.
                // We need a unified approach.
                let _ = entry;
            }
        }
    }

    // Simplest correct approach: use SpatialGrid with WallEntry where pos() returns center,
    // and insert once per cell. We'll make WallEntry carry cell_x/cell_y for positioning
    // but that changes the struct. Instead, let's just use a simple vec-based approach
    // embedded in the grid by directly manipulating cells... but SpatialGrid doesn't expose
    // cells publicly.
    //
    // OK, the cleanest solution: just insert each wall once (centered), and use a generous
    // query radius. The max wall dimension is MAP_WIDTH (2400) for boundary walls.
    // For the boundary walls, this won't work with a single-cell insert.
    //
    // Let's just fall back to: insert at center, and when querying, use a large enough radius.
    // Actually, resolve_wall_collisions already queries with radius + WALL_GRID_CELL_SIZE.
    // The boundary walls are handled by the map-bounds clamping that happens before wall
    // collision resolution. So the spatial grid mostly needs to handle interior walls which
    // are all small enough.
    //
    // For safety, let's insert each wall at multiple points along its extent.

    drop(grid);
    let mut grid = SpatialGrid::new(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE);
    for wall in walls {
        // Sample points along the wall, one per cell it spans
        let x_steps = ((wall.w / WALL_GRID_CELL_SIZE).ceil() as usize).max(1);
        let y_steps = ((wall.h / WALL_GRID_CELL_SIZE).ceil() as usize).max(1);

        let mut inserted_cells = HashSet::new();
        for yi in 0..=y_steps {
            for xi in 0..=x_steps {
                let sx = wall.x + (xi as f64 / x_steps as f64) * wall.w;
                let sy = wall.y + (yi as f64 / y_steps as f64) * wall.h;
                // Determine which cell this point falls in
                let col = (sx / WALL_GRID_CELL_SIZE) as usize;
                let row = (sy / WALL_GRID_CELL_SIZE) as usize;
                if inserted_cells.insert((col, row)) {
                    // Insert a WallEntry positioned at this sample point
                    // so it ends up in the right cell
                    grid.insert(WallEntryAt {
                        x: wall.x,
                        y: wall.y,
                        w: wall.w,
                        h: wall.h,
                        pos_x: sx.min(MAP_WIDTH - 1.0).max(0.0),
                        pos_y: sy.min(MAP_HEIGHT - 1.0).max(0.0),
                    });
                }
            }
        }
    }

    // Hmm, but grid is SpatialGrid<WallEntry> and WallEntryAt is different.
    // Let me rethink this entirely.

    drop(grid);

    // Final approach: use SpatialGrid<WallEntryAt> everywhere for the wall grid.
    build_wall_grid_impl(walls)
}

#[derive(Clone, Debug)]
struct WallEntryAt {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    pos_x: f64,
    pos_y: f64,
}

impl crate::spatial_grid::Positioned for WallEntryAt {
    fn pos(&self) -> (f64, f64) {
        (self.pos_x, self.pos_y)
    }
}

fn build_wall_grid_impl(walls: &[Wall]) -> SpatialGrid<WallEntryAt> {
    let mut grid = SpatialGrid::new(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE);
    for wall in walls {
        let x_steps = ((wall.w / WALL_GRID_CELL_SIZE).ceil() as usize).max(1);
        let y_steps = ((wall.h / WALL_GRID_CELL_SIZE).ceil() as usize).max(1);

        let mut inserted_cells = HashSet::new();
        for yi in 0..=y_steps {
            for xi in 0..=x_steps {
                let sx = wall.x + (xi as f64 / x_steps as f64) * wall.w;
                let sy = wall.y + (yi as f64 / y_steps as f64) * wall.h;
                let col = (sx / WALL_GRID_CELL_SIZE) as usize;
                let row = (sy / WALL_GRID_CELL_SIZE) as usize;
                if inserted_cells.insert((col, row)) {
                    grid.insert(WallEntryAt {
                        x: wall.x,
                        y: wall.y,
                        w: wall.w,
                        h: wall.h,
                        pos_x: sx.min(MAP_WIDTH - 1.0).max(0.0),
                        pos_y: sy.min(MAP_HEIGHT - 1.0).max(0.0),
                    });
                }
            }
        }
    }
    grid
}

fn resolve_wall_collisions_at(
    mut px: f64,
    mut py: f64,
    radius: f64,
    wall_grid: &SpatialGrid<WallEntryAt>,
) -> (f64, f64) {
    let query_radius = radius + WALL_GRID_CELL_SIZE;
    let nearby = wall_grid.query(px, py, query_radius);

    let mut seen = HashSet::new();
    let mut walls: Vec<&WallEntryAt> = Vec::new();
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

fn bullet_hits_wall_at(px: f64, py: f64, wall_grid: &SpatialGrid<WallEntryAt>) -> bool {
    let nearby = wall_grid.query(px, py, WALL_GRID_CELL_SIZE);
    for w in &nearby {
        if point_in_rect(px, py, w.x, w.y, w.w, w.h) {
            return true;
        }
    }
    false
}

// ---------- Game ----------

pub struct Game {
    players: HashMap<String, Player>,
    inputs: HashMap<String, ClientInput>,
    zombies: Vec<Zombie>,
    bullets: Vec<Bullet>,
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
    wall_grid: SpatialGrid<WallEntryAt>,
    zombie_grid: SpatialGrid<ZombieRef>,
    player_grid: SpatialGrid<PlayerRef>,
}

impl Game {
    pub fn new() -> Self {
        let walls = generate_walls();
        let wall_grid = build_wall_grid_impl(&walls);

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
            inputs: HashMap::new(),
            zombies: Vec::new(),
            bullets: Vec::new(),
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
        }
    }

    pub fn add_player(&mut self, id: &str) {
        let spawn = spawn_zones();
        let mut rng = rand::rng();
        let idx = rng.random_range(0..spawn.len());
        let (sx, sy) = spawn[idx];

        let player = Player {
            id: id.to_string(),
            pos: Vector2 { x: sx, y: sy },
            angle: 0.0,
            score: 0.0,
            health: 100.0,
            ammo: 30.0,
            max_ammo: 30.0,
            weapon: Weapon::Pistol,
        };
        self.players.insert(id.to_string(), player);
    }

    pub fn remove_player(&mut self, id: &str) {
        self.players.remove(id);
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

        // Collect player IDs to iterate over
        let player_ids: Vec<String> = self.players.keys().cloned().collect();

        for pid in &player_ids {
            let health = {
                let p = match self.players.get(pid) {
                    Some(p) => p,
                    None => continue,
                };
                p.health
            };

            if health <= 0.0 {
                continue;
            }

            let input = match self.inputs.get(pid) {
                Some(i) => i.clone(),
                None => continue,
            };

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

            let p = self.players.get_mut(pid).unwrap();
            p.pos.x += dx * PLAYER_SPEED * dt;
            p.pos.y += dy * PLAYER_SPEED * dt;

            // Clamp to map bounds
            p.pos.x = p.pos.x.max(PLAYER_RADIUS).min(MAP_WIDTH - PLAYER_RADIUS);
            p.pos.y = p.pos.y.max(PLAYER_RADIUS).min(MAP_HEIGHT - PLAYER_RADIUS);

            // Resolve wall collisions
            let (nx, ny) =
                resolve_wall_collisions_at(p.pos.x, p.pos.y, PLAYER_RADIUS, &self.wall_grid);
            p.pos.x = nx;
            p.pos.y = ny;

            // Update angle
            p.angle = (input.mouse_y - p.pos.y).atan2(input.mouse_x - p.pos.x);

            // Weapon switch
            if input.switch_weapon {
                p.weapon = p.weapon.next();
            }

            // Decrement cooldowns
            let shoot_cd = self.shoot_cooldowns.entry(pid.clone()).or_insert(0.0);
            *shoot_cd -= dt;
            let melee_cd = self.melee_cooldowns.entry(pid.clone()).or_insert(0.0);
            *melee_cd -= dt;

            // Melee attack
            if input.melee && *melee_cd <= 0.0 {
                *melee_cd = MELEE_COOLDOWN;

                let p = self.players.get(pid).unwrap();
                let px = p.pos.x;
                let py = p.pos.y;
                let p_angle = p.angle;

                let nearby_zombies = self.zombie_grid.query(px, py, MELEE_RANGE);
                let mut zombie_indices_to_check: Vec<usize> = nearby_zombies
                    .iter()
                    .map(|zr| zr.index)
                    .collect();
                zombie_indices_to_check.sort_unstable();
                zombie_indices_to_check.dedup();

                let mut kills = 0u32;
                for &zi in &zombie_indices_to_check {
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

                    // Apply damage
                    self.zombies[zi].health -= MELEE_DAMAGE;

                    // Knockback
                    if dist > 0.0 {
                        let knx = zdx / dist;
                        let kny = zdy / dist;
                        self.zombies[zi].pos.x += knx * 30.0;
                        self.zombies[zi].pos.y += kny * 30.0;
                    }

                    if self.zombies[zi].health <= 0.0 {
                        let score = zombie_score(&self.zombies[zi].zombie_type);
                        if let Some(p) = self.players.get_mut(pid) {
                            p.score += score;
                        }
                        kills += 1;
                    }
                }
                self.wave_kills += kills;

                // Remove dead zombies (iterate backwards)
                self.zombies.retain(|z| z.health > 0.0);
            }

            // Shooting
            let shoot_cd = self.shoot_cooldowns.get_mut(pid).unwrap();
            if input.shooting && *shoot_cd <= 0.0 {
                let p = self.players.get(pid).unwrap();
                if p.ammo > 0.0 {
                    *shoot_cd = SHOOT_COOLDOWN;
                    let angle = p.angle;
                    let px = p.pos.x;
                    let py = p.pos.y;
                    let weapon = p.weapon.clone();
                    let damage = weapon.damage();
                    let owner_id = pid.clone();

                    let p = self.players.get_mut(pid).unwrap();
                    p.ammo -= 1.0;

                    match weapon {
                        Weapon::Shotgun => {
                            // Shotgun fires multiple pellets
                            let spread = PI / 12.0;
                            for i in 0..5 {
                                let a = angle - spread * 2.0 + spread * i as f64;
                                let bullet = Bullet {
                                    id: Uuid::new_v4().to_string(),
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
                                };
                                self.bullet_lifetimes
                                    .insert(bullet.id.clone(), BULLET_LIFETIME);
                                self.bullets.push(bullet);
                            }
                        }
                        _ => {
                            let bullet = Bullet {
                                id: Uuid::new_v4().to_string(),
                                pos: Vector2 {
                                    x: px + angle.cos() * PLAYER_RADIUS,
                                    y: py + angle.sin() * PLAYER_RADIUS,
                                },
                                vel: Vector2 {
                                    x: angle.cos() * BULLET_SPEED,
                                    y: angle.sin() * BULLET_SPEED,
                                },
                                owner_id: owner_id.clone(),
                                damage,
                            };
                            self.bullet_lifetimes
                                .insert(bullet.id.clone(), BULLET_LIFETIME);
                            self.bullets.push(bullet);
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

        // Update bullet lifetimes and filter bullets
        let wall_grid = &self.wall_grid;
        let bullet_lifetimes = &mut self.bullet_lifetimes;
        self.bullets.retain(|b| {
            if let Some(lt) = bullet_lifetimes.get_mut(&b.id) {
                *lt -= dt;
                if *lt <= 0.0 {
                    bullet_lifetimes.remove(&b.id);
                    return false;
                }
            }
            // OOB check
            if b.pos.x < 0.0 || b.pos.x > MAP_WIDTH || b.pos.y < 0.0 || b.pos.y > MAP_HEIGHT {
                bullet_lifetimes.remove(&b.id);
                return false;
            }
            // Wall check
            if bullet_hits_wall_at(b.pos.x, b.pos.y, wall_grid) {
                bullet_lifetimes.remove(&b.id);
                return false;
            }
            true
        });

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
                let spawn = spawn_zones();
                let idx = rng.random_range(0..spawn.len());
                let (sx, sy) = spawn[idx];

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

                let zombie = Zombie {
                    id: Uuid::new_v4().to_string(),
                    zombie_type,
                    pos: Vector2 { x: sx, y: sy },
                    health: hp,
                    max_health: hp,
                    speed,
                };
                self.zombies.push(zombie);
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

        if player_positions.is_empty() {
            // Check game over below
        } else {
            let mut zombie_indices_to_remove: Vec<usize> = Vec::new();
            let mut bullet_indices_to_remove: Vec<usize> = Vec::new();
            let mut score_awards: Vec<(String, f64)> = Vec::new();
            let mut damage_to_players: Vec<(String, f64)> = Vec::new();

            for zi in (0..self.zombies.len()).rev() {
                let z = &self.zombies[zi];
                let zx = z.pos.x;
                let zy = z.pos.y;
                let z_speed = z.speed;

                // Find nearest player
                let mut nearest_id: Option<String> = None;
                let mut nearest_dist = f64::MAX;

                // Try spatial query first (600 radius)
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

                // Fallback: check all players
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

                if let Some(target_id) = &nearest_id {
                    let (tx, ty) = player_positions
                        .iter()
                        .find(|(id, _, _)| id == target_id)
                        .map(|(_, x, y)| (*x, *y))
                        .unwrap_or((zx, zy));

                    let tdx = tx - zx;
                    let tdy = ty - zy;
                    let tdist = (tdx * tdx + tdy * tdy).sqrt();

                    if tdist > 0.0 {
                        let move_x = (tdx / tdist) * z_speed * dt;
                        let move_y = (tdy / tdist) * z_speed * dt;
                        let z = &mut self.zombies[zi];
                        z.pos.x += move_x;
                        z.pos.y += move_y;

                        // Clamp
                        z.pos.x = z.pos.x.max(ZOMBIE_RADIUS).min(MAP_WIDTH - ZOMBIE_RADIUS);
                        z.pos.y = z.pos.y.max(ZOMBIE_RADIUS).min(MAP_HEIGHT - ZOMBIE_RADIUS);

                        // Resolve wall collisions
                        let (nx, ny) = resolve_wall_collisions_at(
                            z.pos.x,
                            z.pos.y,
                            ZOMBIE_RADIUS,
                            &self.wall_grid,
                        );
                        z.pos.x = nx;
                        z.pos.y = ny;
                    }

                    // Zombie melee attack
                    let z = &self.zombies[zi];
                    let zdx = tx - z.pos.x;
                    let zdy = ty - z.pos.y;
                    let dist_to_target = (zdx * zdx + zdy * zdy).sqrt();

                    if dist_to_target < ZOMBIE_ATTACK_RANGE {
                        let cd = self
                            .zombie_attack_cooldowns
                            .entry(z.id.clone())
                            .or_insert(0.0);
                        if *cd <= 0.0 {
                            *cd = ZOMBIE_ATTACK_COOLDOWN;
                            damage_to_players.push((target_id.clone(), ZOMBIE_DAMAGE));
                        }
                    }
                }

                // Check bullet collisions
                for bi in (0..self.bullets.len()).rev() {
                    if bullet_indices_to_remove.contains(&bi) {
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
                        self.zombies[zi].health -= damage;
                        bullet_indices_to_remove.push(bi);

                        if self.zombies[zi].health <= 0.0 {
                            let score = zombie_score(&self.zombies[zi].zombie_type);
                            score_awards.push((owner_id, score));
                            zombie_indices_to_remove.push(zi);
                            break; // zombie is dead, stop checking bullets
                        }
                    }
                }
            }

            // Decrement zombie attack cooldowns
            for (_, cd) in self.zombie_attack_cooldowns.iter_mut() {
                *cd -= dt;
            }

            // Apply damage to players
            for (pid, dmg) in &damage_to_players {
                if let Some(p) = self.players.get_mut(pid) {
                    p.health -= dmg;
                    if p.health < 0.0 {
                        p.health = 0.0;
                    }
                }
            }

            // Apply score awards
            for (pid, score) in &score_awards {
                if let Some(p) = self.players.get_mut(pid) {
                    p.score += score;
                }
            }

            // Remove dead zombies
            zombie_indices_to_remove.sort_unstable();
            zombie_indices_to_remove.dedup();
            for &zi in zombie_indices_to_remove.iter().rev() {
                if zi < self.zombies.len() {
                    self.zombie_attack_cooldowns
                        .remove(&self.zombies[zi].id);
                    self.zombies.swap_remove(zi);
                }
            }
            self.wave_kills += zombie_indices_to_remove.len() as u32;

            // Remove bullets that hit zombies
            bullet_indices_to_remove.sort_unstable();
            bullet_indices_to_remove.dedup();
            for &bi in bullet_indices_to_remove.iter().rev() {
                if bi < self.bullets.len() {
                    self.bullet_lifetimes.remove(&self.bullets[bi].id);
                    self.bullets.swap_remove(bi);
                }
            }
        }

        // Wave advancement
        if self.wave_kills >= self.wave * 10 {
            self.wave += 1;
            self.wave_kills = 0;
        }

        // Game over check
        let any_alive = self.players.values().any(|p| p.health > 0.0);
        if !self.players.is_empty() && !any_alive {
            self.game_over = true;
        }
    }

    // --- Getters ---

    pub fn players(&self) -> &HashMap<String, Player> {
        &self.players
    }

    pub fn zombies(&self) -> &[Zombie] {
        &self.zombies
    }

    pub fn bullets(&self) -> &[Bullet] {
        &self.bullets
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

fn zombie_score(zombie_type: &ZombieType) -> f64 {
    match zombie_type {
        ZombieType::Vampire => 100.0,
        ZombieType::Brute => 75.0,
        ZombieType::Devil => 50.0,
        ZombieType::Crawler => 25.0,
        ZombieType::Zombie => 10.0,
    }
}
