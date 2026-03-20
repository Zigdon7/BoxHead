use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

// Map dimensions
pub const MAP_WIDTH: f64 = 2400.0;
pub const MAP_HEIGHT: f64 = 1800.0;
pub const WALL_THICKNESS: f64 = 20.0;

// Entity radii
pub const PLAYER_RADIUS: f64 = 15.0;
pub const ZOMBIE_RADIUS: f64 = 12.0;
pub const BULLET_RADIUS: f64 = 3.0;

// Zombie combat
pub const ZOMBIE_ATTACK_COOLDOWN: f64 = 1.0;
pub const ZOMBIE_ATTACK_RANGE: f64 = ZOMBIE_RADIUS + PLAYER_RADIUS + 5.0;
pub const ZOMBIE_DAMAGE: f64 = 20.0;

// Shooting
pub const SHOOT_COOLDOWN: f64 = 0.2;
pub const BULLET_SPEED: f64 = 800.0;
pub const BULLET_LIFETIME: f64 = 2.0;

// Melee
pub const MELEE_RANGE: f64 = 50.0;
pub const MELEE_ARC: f64 = PI / 2.0;
pub const MELEE_COOLDOWN: f64 = 0.4;

// Ammo pickups
pub const AMMO_PICKUP_RADIUS: f64 = 18.0;
pub const AMMO_PICKUP_AMOUNT: i32 = 15;
pub const AMMO_RESPAWN_TIME: f64 = 15.0;

// Zombie spawning
pub const MAX_ZOMBIES_BASE: i32 = 30;
pub const MAX_ZOMBIES_PER_PLAYER: i32 = 8;
pub const MAX_ZOMBIES_HARD_CAP: i32 = 200;

// Player movement
pub const PLAYER_SPEED: f64 = 200.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
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
}

pub fn generate_walls() -> Vec<Wall> {
    let w = WALL_THICKNESS;

    vec![
        // Boundary walls
        Wall::new(0.0, 0.0, MAP_WIDTH, w),
        Wall::new(0.0, MAP_HEIGHT - w, MAP_WIDTH, w),
        Wall::new(0.0, 0.0, w, MAP_HEIGHT),
        Wall::new(MAP_WIDTH - w, 0.0, w, MAP_HEIGHT),
        // Central cross with gaps
        Wall::new(300.0, 880.0, 500.0, w),
        Wall::new(1000.0, 880.0, 400.0, w),
        Wall::new(1600.0, 880.0, 500.0, w),
        Wall::new(1190.0, 200.0, w, 400.0),
        Wall::new(1190.0, 800.0, w, 200.0),
        Wall::new(1190.0, 1200.0, w, 400.0),
        // Top-left room
        Wall::new(200.0, 300.0, 400.0, w),
        Wall::new(200.0, 300.0, w, 300.0),
        Wall::new(200.0, 580.0, 250.0, w),
        // Top-right room
        Wall::new(1600.0, 300.0, 500.0, w),
        Wall::new(2080.0, 300.0, w, 300.0),
        Wall::new(1750.0, 580.0, 350.0, w),
        // Bottom-left room
        Wall::new(200.0, 1200.0, 250.0, w),
        Wall::new(200.0, 1200.0, w, 350.0),
        Wall::new(200.0, 1530.0, 500.0, w),
        // Bottom-right room
        Wall::new(1750.0, 1200.0, 350.0, w),
        Wall::new(2080.0, 1200.0, w, 350.0),
        Wall::new(1600.0, 1530.0, 500.0, w),
        // Cover pillars
        Wall::new(700.0, 450.0, 60.0, 60.0),
        Wall::new(1500.0, 450.0, 60.0, 60.0),
        Wall::new(700.0, 1300.0, 60.0, 60.0),
        Wall::new(1500.0, 1300.0, 60.0, 60.0),
        // Center arena pillars
        Wall::new(1050.0, 750.0, 40.0, 40.0),
        Wall::new(1300.0, 750.0, 40.0, 40.0),
        Wall::new(1050.0, 1000.0, 40.0, 40.0),
        Wall::new(1300.0, 1000.0, 40.0, 40.0),
        // Corridor walls
        Wall::new(500.0, 100.0, w, 150.0),
        Wall::new(900.0, 100.0, w, 150.0),
        Wall::new(500.0, 1550.0, w, 150.0),
        Wall::new(900.0, 1550.0, w, 150.0),
        // Side alcoves
        Wall::new(50.0, 700.0, 150.0, w),
        Wall::new(50.0, 1100.0, 150.0, w),
        Wall::new(2200.0, 700.0, 150.0, w),
        Wall::new(2200.0, 1100.0, 150.0, w),
    ]
}

pub fn spawn_zones() -> Vec<(f64, f64)> {
    vec![
        (100.0, 100.0),
        (MAP_WIDTH - 100.0, 100.0),
        (100.0, MAP_HEIGHT - 100.0),
        (MAP_WIDTH - 100.0, MAP_HEIGHT - 100.0),
        (MAP_WIDTH / 2.0, 50.0),
        (MAP_WIDTH / 2.0, MAP_HEIGHT - 50.0),
        (50.0, MAP_HEIGHT / 2.0),
        (MAP_WIDTH - 50.0, MAP_HEIGHT / 2.0),
    ]
}

pub fn ammo_spawn_points() -> Vec<(f64, f64, i32)> {
    vec![
        (120.0, 120.0, AMMO_PICKUP_AMOUNT),
        (MAP_WIDTH - 120.0, 120.0, AMMO_PICKUP_AMOUNT),
        (120.0, MAP_HEIGHT - 120.0, AMMO_PICKUP_AMOUNT),
        (MAP_WIDTH - 120.0, MAP_HEIGHT - 120.0, AMMO_PICKUP_AMOUNT),
        (MAP_WIDTH / 2.0, 120.0, AMMO_PICKUP_AMOUNT),
        (MAP_WIDTH / 2.0, MAP_HEIGHT - 120.0, AMMO_PICKUP_AMOUNT),
        (120.0, MAP_HEIGHT / 2.0, AMMO_PICKUP_AMOUNT),
        (MAP_WIDTH - 120.0, MAP_HEIGHT / 2.0, AMMO_PICKUP_AMOUNT),
    ]
}
