use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

use crate::gear::{MapDef, BLOCK_SIZE, MAP_MARGIN};

pub const WALL_THICKNESS: f64 = 20.0;

// Entity radii
pub const PLAYER_RADIUS: f64 = 15.0;
pub const ZOMBIE_RADIUS: f64 = 12.0;
pub const BULLET_RADIUS: f64 = 3.0;

// Zombie combat
pub const ZOMBIE_ATTACK_COOLDOWN: f64 = 1.0;
pub const ZOMBIE_ATTACK_RANGE: f64 = ZOMBIE_RADIUS + PLAYER_RADIUS + 5.0;
pub const ZOMBIE_DAMAGE: f64 = 20.0;
/// Ordinary enemies notice visible players this close.
pub const ZOMBIE_AGGRO_RANGE: f64 = 480.0;
/// A pursuit cannot pull ordinary monsters beyond their home territory.
pub const ZOMBIE_CHASE_LEASH: f64 = 800.0;
pub const ZOMBIE_CHASE_SECS: f64 = 12.0;
pub const ZOMBIE_MEMORY_SECS: f64 = 2.5;
pub const ZOMBIE_RETURN_COOLDOWN: f64 = 4.0;
/// Even anti-camping hunters eventually give up and return home.
pub const HUNTER_CHASE_SECS: f64 = 30.0;
/// Enemies this far from every player are culled (no loot, no kill credit).
pub const ZOMBIE_DESPAWN_RANGE: f64 = 1900.0;
// Nests: unbreakable spawners. Monsters pour out of a nest while a player is near it.
pub const NEST_SIZE: f64 = 56.0;
/// A nest spawns only while a living player is within this range.
pub const NEST_ACTIVE_RANGE: f64 = 1500.0;
/// Monsters appear in a ring this far from the nest's centre.
pub const NEST_SPAWN_RING: (f64, f64) = (70.0, 150.0);
/// Idle monsters drift back toward their nest once they stray this far.
pub const NEST_LEASH: f64 = 260.0;

// Camping: staying in one place too long draws out a boss.
/// You're camping while you haven't strayed further than this (about 14 m)
/// from where you are at any point in the last CAMP_WINDOW seconds.
pub const CAMP_RADIUS: f64 = 450.0;
pub const CAMP_WINDOW: f64 = 30.0;
/// Seconds of camping before hunters are sent for you.
pub const CAMP_LIMIT: f64 = 75.0;
/// The camp meter starts warning you at this point.
#[cfg(test)] // mirrored by the client HUD
pub const CAMP_WARNING: f64 = 45.0;
pub const MAX_ZOMBIES_HARD_CAP: usize = 220;

// Per-weapon fire rates
pub const PISTOL_COOLDOWN: f64 = 0.2;
pub const UZI_COOLDOWN: f64 = 0.08;
pub const SHOTGUN_COOLDOWN: f64 = 0.5;
pub const ROCKET_COOLDOWN: f64 = 1.0;
pub const BULLET_SPEED: f64 = 800.0;
pub const ROCKET_SPEED: f64 = 500.0;
pub const BULLET_LIFETIME: f64 = 1.6;
pub const ROCKET_EXPLOSION_RADIUS: f64 = 80.0;

// Melee
pub const MELEE_RANGE: f64 = 62.0;
pub const MELEE_ARC: f64 = 2.0 * PI / 3.0;
pub const MELEE_COOLDOWN: f64 = 0.38;

// Ammo caches (respawning)
pub const AMMO_PICKUP_RADIUS: f64 = 18.0;
pub const AMMO_PICKUP_AMOUNT: i32 = 20;
pub const AMMO_RESPAWN_TIME: f64 = 45.0;

// Supply crates (respawning loot)
pub const CRATE_RADIUS: f64 = 18.0;
pub const CRATE_RESPAWN_TIME: f64 = 240.0;

// Extraction
pub const EXTRACT_RADIUS: f64 = 110.0;
pub const EXTRACT_TIME: f64 = 6.0;

// Uplinks: terminals that decrypt sealed loot while you stand at them.
pub const UPLINK_RADIUS: f64 = 90.0;
/// Decrypting is loud: monsters this close come for you, and nearby nests spawn faster.
pub const UPLINK_ALERT_RANGE: f64 = 1300.0;

// Dash
pub const DASH_SPEED_MULT: f64 = 3.0;
pub const DASH_DURATION: f64 = 0.15;
pub const DASH_MAX_CHARGES: i32 = 3;
pub const DASH_RECHARGE_TIME: f64 = 2.5;
pub const DASH_IFRAME_GRACE: f64 = 0.12;

// Downed, revive and bleed-out
pub const REVIVE_RANGE: f64 = 50.0;
pub const REVIVE_TIME: f64 = 3.0;
/// Seconds a downed player can wait for a squadmate before they are killed.
pub const BLEEDOUT_TIME: f64 = 25.0;
/// With nobody else alive in the raid there is no one to wait for.
pub const BLEEDOUT_ALONE: f64 = 3.0;

// Drop pickups
pub const DROP_PICKUP_RADIUS: f64 = 18.0;
pub const DROP_DESPAWN_TIME: f64 = 20.0;
pub const LOOT_DESPAWN_TIME: f64 = 120.0;
pub const DROP_AMMO_AMOUNT: f64 = 15.0;
/// Health drops heal a quarter of your max health.
pub const DROP_HEALTH_FRACTION: f64 = 0.25;
/// Revived players stand back up with half their max health.
pub const REVIVE_FRACTION: f64 = 0.5;
/// Rounds a rocket uses.
pub const ROCKET_AMMO_COST: f64 = 2.0;

// Combo
pub const COMBO_DURATION: f64 = 4.0;

// Placeable tactical items
pub const BARREL_RADIUS: f64 = 16.0;
pub const BARREL_HP: f64 = 30.0;
pub const BARREL_EXPLOSION_RADIUS: f64 = 110.0;
pub const BARREL_DAMAGE: f64 = 200.0;

pub const BARRICADE_RADIUS: f64 = 20.0;
pub const BARRICADE_HP: f64 = 220.0;
pub const BARRICADE_CONTACT_DAMAGE: f64 = 12.0;

pub const MINE_RADIUS: f64 = 12.0;
pub const MINE_HP: f64 = 20.0;
pub const MINE_TRIGGER_RADIUS: f64 = 38.0;
pub const MINE_EXPLOSION_RADIUS: f64 = 95.0;
pub const MINE_DAMAGE: f64 = 175.0;

// Crits
pub const CRIT_BASE_CHANCE: f64 = 0.20;
pub const CRIT_DAMAGE_MULT: f64 = 1.75;

// Player movement
pub const PLAYER_SPEED: f64 = 200.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Wall {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Wall {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    #[cfg(test)]
    fn contains_circle(&self, px: f64, py: f64, radius: f64) -> bool {
        let cx = px.clamp(self.x, self.x + self.w);
        let cy = py.clamp(self.y, self.y + self.h);
        (px - cx).powi(2) + (py - cy).powi(2) < radius * radius
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ExtractPoint {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}

/// A generated raid map: city blocks of buildings separated by streets.
#[derive(Clone, Debug)]
pub struct MapLayout {
    pub width: f64,
    pub height: f64,
    pub walls: Vec<Wall>,
    /// Where players enter the raid (street corners near the edge).
    pub insertions: Vec<Point>,
    pub extracts: Vec<ExtractPoint>,
    /// Supply crates, almost all inside buildings.
    pub crates: Vec<Point>,
    pub ammo: Vec<Point>,
    /// Unbreakable monster nests (each also has a solid core in `walls`).
    pub nests: Vec<Point>,
    /// Decryption terminals on inner street crossings.
    pub uplinks: Vec<ExtractPoint>,
}

impl MapLayout {
    #[cfg(test)]
    pub fn blocked(&self, x: f64, y: f64, radius: f64) -> bool {
        x < radius || y < radius || x > self.width - radius || y > self.height - radius
            || self.walls.iter().any(|w| w.contains_circle(x, y, radius))
    }
}

/// Street intersection (i, j); there are blocks+1 in each direction.
fn intersection(i: u32, j: u32) -> (f64, f64) {
    (MAP_MARGIN + i as f64 * BLOCK_SIZE, MAP_MARGIN + j as f64 * BLOCK_SIZE)
}

/// One wall of a building with a doorway somewhere along it.
fn wall_with_door(walls: &mut Vec<Wall>, horizontal: bool, x: f64, y: f64, len: f64, door: Option<f64>) {
    let t = WALL_THICKNESS;
    let door_w = 90.0;
    match door {
        None => walls.push(if horizontal { Wall::new(x, y, len, t) } else { Wall::new(x, y, t, len) }),
        Some(at) => {
            let start = (at * (len - door_w - 80.0)) + 40.0;
            let end = start + door_w;
            if horizontal {
                walls.push(Wall::new(x, y, start, t));
                walls.push(Wall::new(x + end, y, len - end, t));
            } else {
                walls.push(Wall::new(x, y, t, start));
                walls.push(Wall::new(x, y + end, t, len - end));
            }
        }
    }
}

/// Generate the same layout for a map every time (seeded).
pub fn generate_layout(map: &MapDef) -> MapLayout {
    let mut rng = StdRng::seed_from_u64(map.seed);
    let (cols, rows) = map.blocks;
    let width = map.width();
    let height = map.height();
    let t = WALL_THICKNESS;
    let mut walls = vec![
        Wall::new(0.0, 0.0, width, t),
        Wall::new(0.0, height - t, width, t),
        Wall::new(0.0, 0.0, t, height),
        Wall::new(width - t, 0.0, t, height),
    ];
    let mut crates = Vec::new();
    let mut ammo = Vec::new();

    let center = ((cols - 1) as f64 / 2.0, (rows - 1) as f64 / 2.0);
    for bx in 0..cols {
        for by in 0..rows {
            let (x0, y0) = intersection(bx, by);
            // Blocks nearer the centre are denser and better stocked.
            let dist = ((bx as f64 - center.0) / cols as f64).hypot((by as f64 - center.1) / rows as f64);
            let plaza = rng.random::<f64>() < 0.14;
            if plaza {
                // Open lot: an ammo cache, maybe a crate in the open, and scattered cover.
                let (mx, my) = (x0 + BLOCK_SIZE / 2.0, y0 + BLOCK_SIZE / 2.0);
                ammo.push(Point { x: mx, y: my });
                if rng.random::<f64>() < 0.5 {
                    crates.push(Point { x: mx + 60.0, y: my - 60.0 });
                }
                for _ in 0..rng.random_range(3..6) {
                    let s = rng.random_range(36.0..70.0);
                    let cx = x0 + rng.random_range(150.0..BLOCK_SIZE - 150.0 - s);
                    let cy = y0 + rng.random_range(150.0..BLOCK_SIZE - 150.0 - s);
                    // Keep the cache and crate in the open.
                    let near = |px: f64, py: f64| (cx + s / 2.0 - px).abs() < s / 2.0 + 50.0 && (cy + s / 2.0 - py).abs() < s / 2.0 + 50.0;
                    if near(mx, my) || near(mx + 60.0, my - 60.0) { continue; }
                    walls.push(Wall::new(cx, cy, s, s));
                }
                continue;
            }

            // A building with streets (at least 100 units) all around it.
            let bw = rng.random_range(300.0..440.0_f64).round();
            let bh = rng.random_range(300.0..440.0_f64).round();
            let left = x0 + rng.random_range(100.0..(BLOCK_SIZE - 100.0 - bw).max(100.5)).round();
            let top = y0 + rng.random_range(100.0..(BLOCK_SIZE - 100.0 - bh).max(100.5)).round();
            // Two or three doorways so a building is never a dead end.
            let mut doors = [false; 4];
            let first = rng.random_range(0..4);
            doors[first] = true;
            doors[(first + 2) % 4] = true;
            if rng.random::<f64>() < 0.5 { doors[rng.random_range(0..4)] = true; }
            let pos = |rng: &mut StdRng, open: bool| open.then(|| rng.random_range(0.0..1.0));
            let d: Vec<Option<f64>> = doors.iter().map(|&open| pos(&mut rng, open)).collect();
            wall_with_door(&mut walls, true, left, top, bw, d[0]);
            wall_with_door(&mut walls, true, left, top + bh - t, bw, d[2]);
            wall_with_door(&mut walls, false, left, top + t, bh - 2.0 * t, d[3]);
            wall_with_door(&mut walls, false, left + bw - t, top + t, bh - 2.0 * t, d[1]);
            // Interior cover: a pillar or a half wall.
            if rng.random::<f64>() < 0.7 {
                let s = rng.random_range(40.0..64.0);
                walls.push(Wall::new(left + bw / 2.0 - s / 2.0, top + bh / 2.0 - s / 2.0, s, s));
            }
            crates.push(Point { x: left + 50.0, y: top + 50.0 });
            if dist < 0.28 || rng.random::<f64>() < 0.25 {
                crates.push(Point { x: left + bw - 50.0, y: top + bh - 50.0 });
            }
            if rng.random::<f64>() < 0.3 {
                ammo.push(Point { x: left + bw - 50.0, y: top + 50.0 });
            }
        }
    }

    // Cover in the streets, never on an intersection (those stay clear for spawns and extracts).
    for i in 0..=cols {
        for j in 0..=rows {
            let (x, y) = intersection(i, j);
            if i < cols && rng.random::<f64>() < 0.35 {
                let s = rng.random_range(30.0..46.0);
                walls.push(Wall::new(x + BLOCK_SIZE / 2.0 - s / 2.0 + rng.random_range(-60.0..60.0), y - s / 2.0, s, s));
            }
            if j < rows && rng.random::<f64>() < 0.35 {
                let s = rng.random_range(30.0..46.0);
                walls.push(Wall::new(x - s / 2.0, y + BLOCK_SIZE / 2.0 - s / 2.0 + rng.random_range(-60.0..60.0), s, s));
            }
        }
    }

    // Nests sit on inner street crossings, never on the edge where players
    // insert and extract. Roughly one per four blocks, spread out.
    let mut inner: Vec<(u32, u32)> = (1..cols).flat_map(|i| (1..rows).map(move |j| (i, j))).collect();
    // Outskirts gains room to route around encounters without gaining nests.
    let want = if map.tier == 1 { 8 } else { ((cols * rows) as usize / 4).max(4) }.min(inner.len());
    let mut nests: Vec<Point> = Vec::new();
    while nests.len() < want && !inner.is_empty() {
        let (i, j) = inner.swap_remove(rng.random_range(0..inner.len()));
        let (x, y) = intersection(i, j);
        // Keep nests at least two blocks apart where the map allows it.
        if nests.iter().any(|n| (n.x - x).abs() < BLOCK_SIZE * 1.5 && (n.y - y).abs() < BLOCK_SIZE * 1.5) && inner.len() > want {
            continue;
        }
        walls.push(Wall::new(x - NEST_SIZE / 2.0, y - NEST_SIZE / 2.0, NEST_SIZE, NEST_SIZE));
        nests.push(Point { x, y });
    }

    // Insertions: intersections along the edges. Extracts: the four corners and,
    // on bigger maps, the middle of the two long edges.
    let mut insertions = Vec::new();
    for i in 1..cols {
        insertions.push(intersection(i, 0));
        insertions.push(intersection(i, rows));
    }
    for j in 1..rows {
        insertions.push(intersection(0, j));
        insertions.push(intersection(cols, j));
    }
    let insertions = insertions.into_iter().map(|(x, y)| Point { x, y }).collect();

    let mut extracts = vec![
        ("north-west", "North-West Gate", intersection(0, 0)),
        ("north-east", "North-East Dock", intersection(cols, 0)),
        ("south-west", "South-West Tunnel", intersection(0, rows)),
        ("south-east", "South-East Helipad", intersection(cols, rows)),
    ];
    if map.tier >= 3 {
        extracts.push(("north", "North Checkpoint", intersection(cols / 2, 0)));
        extracts.push(("south", "South Rail Yard", intersection(cols / 2, rows)));
    }
    let extracts = extracts.into_iter().map(|(id, name, (x, y))| ExtractPoint {
        id: id.into(), name: name.into(), x, y, radius: crate::map::EXTRACT_RADIUS,
    }).collect();

    // Uplinks: inner crossings that aren't nests, spread out. One more per tier.
    let taken = |x: f64, y: f64, pts: &[(f64, f64)], gap: f64| pts.iter().any(|(px, py)| (px - x).abs() < gap && (py - y).abs() < gap);
    let nest_pts: Vec<(f64, f64)> = nests.iter().map(|n| (n.x, n.y)).collect();
    let mut free: Vec<(f64, f64)> = (1..cols).flat_map(|i| (1..rows).map(move |j| intersection(i, j)))
        .filter(|(x, y)| !taken(*x, *y, &nest_pts, 1.0))
        .collect();
    let want_uplinks = (map.tier as usize + 1).min(free.len());
    let mut uplink_pts: Vec<(f64, f64)> = Vec::new();
    for gap in [BLOCK_SIZE * 1.5, BLOCK_SIZE * 0.5, 0.0] {
        let mut i = 0;
        while uplink_pts.len() < want_uplinks && i < free.len() {
            let idx = (i + rng.random_range(0..free.len())) % free.len();
            let (x, y) = free[idx];
            if gap == 0.0 || !taken(x, y, &uplink_pts, gap) {
                uplink_pts.push((x, y));
                free.swap_remove(idx);
            } else {
                i += 1;
            }
        }
    }
    let uplinks = uplink_pts.into_iter().enumerate().map(|(i, (x, y))| ExtractPoint {
        id: format!("uplink-{i}"), name: format!("Uplink {}", (b'A' + i as u8) as char), x, y, radius: UPLINK_RADIUS,
    }).collect();

    MapLayout { width, height, walls, insertions, extracts, crates, ammo, nests, uplinks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gear::MAPS;

    #[test]
    fn layouts_are_deterministic() {
        for map in &MAPS {
            let a = generate_layout(map);
            let b = generate_layout(map);
            assert_eq!(a.walls, b.walls);
            assert_eq!(a.crates, b.crates);
        }
    }

    #[test]
    fn outskirts_has_more_routing_room_without_more_nests() {
        let layout = generate_layout(&MAPS[0]);
        assert_eq!((layout.width, layout.height), (4640.0, 4000.0));
        assert_eq!(layout.nests.len(), 8);
    }

    #[test]
    fn spawns_extracts_crates_and_caches_are_reachable_and_clear_of_walls() {
        for map in &MAPS {
            let layout = generate_layout(map);
            assert!(layout.insertions.len() >= 8, "{}", map.name);
            assert!(layout.extracts.len() >= 4);
            assert!(layout.crates.len() as u32 >= map.blocks.0 * map.blocks.1 / 2, "{} has {} crates", map.name, layout.crates.len());
            for p in &layout.insertions { assert!(!layout.blocked(p.x, p.y, PLAYER_RADIUS + 4.0), "insertion in a wall on {}", map.name); }
            for e in &layout.extracts { assert!(!layout.blocked(e.x, e.y, PLAYER_RADIUS + 4.0), "extract {} in a wall", e.name); }
            for c in &layout.crates { assert!(!layout.blocked(c.x, c.y, CRATE_RADIUS), "crate in a wall on {}", map.name); }
            for a in &layout.ammo { assert!(!layout.blocked(a.x, a.y, AMMO_PICKUP_RADIUS), "ammo in a wall on {}", map.name); }
            assert!(layout.nests.len() >= 4, "{} has {} nests", map.name, layout.nests.len());
            assert_eq!(layout.uplinks.len(), map.tier as usize + 1, "{} uplinks", map.name);
            for u in &layout.uplinks {
                assert!(!layout.blocked(u.x, u.y, PLAYER_RADIUS + 4.0), "uplink in a wall on {}", map.name);
                assert!(layout.nests.iter().all(|n| f64::hypot(n.x - u.x, n.y - u.y) > 1.0), "uplink on a nest");
            }
            for n in &layout.nests {
                for p in layout.insertions.iter().map(|p| (p.x, p.y)).chain(layout.extracts.iter().map(|e| (e.x, e.y))) {
                    assert!(f64::hypot(n.x - p.0, n.y - p.1) >= BLOCK_SIZE - 1.0, "nest too close to an insertion or extract on {}", map.name);
                }
            }
        }
    }

    #[test]
    fn every_crate_can_be_walked_to_from_an_insertion() {
        // Flood fill on a coarse grid: every crate must be reachable on foot.
        for map in &MAPS {
            let layout = generate_layout(map);
            let cell = 20.0;
            let (cols, rows) = ((layout.width / cell) as usize, (layout.height / cell) as usize);
            let free = |c: usize, r: usize| !layout.blocked((c as f64 + 0.5) * cell, (r as f64 + 0.5) * cell, PLAYER_RADIUS);
            let mut seen = vec![false; cols * rows];
            let start = &layout.insertions[0];
            let mut stack = vec![((start.x / cell) as usize, (start.y / cell) as usize)];
            while let Some((c, r)) = stack.pop() {
                if c >= cols || r >= rows || seen[r * cols + c] || !free(c, r) { continue; }
                seen[r * cols + c] = true;
                stack.extend([(c + 1, r), (c.wrapping_sub(1), r), (c, r + 1), (c, r.wrapping_sub(1))]);
            }
            let reachable = |x: f64, y: f64| {
                let (c, r) = ((x / cell) as i64, (y / cell) as i64);
                (-1..=1).any(|dc| (-1..=1).any(|dr| {
                    let (c, r) = (c + dc, r + dr);
                    c >= 0 && r >= 0 && (c as usize) < cols && (r as usize) < rows && seen[r as usize * cols + c as usize]
                }))
            };
            for c in &layout.crates { assert!(reachable(c.x, c.y), "unreachable crate at {:?} on {}", c, map.name); }
            for e in &layout.extracts { assert!(reachable(e.x, e.y), "unreachable extract {} on {}", e.name, map.name); }
            for u in &layout.uplinks { assert!(reachable(u.x, u.y), "unreachable {} on {}", u.name, map.name); }
        }
    }
}
