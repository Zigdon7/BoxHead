use std::collections::{HashMap, HashSet};
use crate::types::*;

struct PrevState {
    players: HashMap<String, Player>,
    zombie_map: HashMap<String, Zombie>,
    bullet_set: HashSet<String>,
    wave: u32,
    ammo_availability: HashMap<String, bool>,
    game_over: bool,
}

pub struct DeltaTracker {
    prev: Option<PrevState>,
    tick: u64,
}

impl DeltaTracker {
    pub fn new() -> Self {
        DeltaTracker { prev: None, tick: 0 }
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    pub fn compute_delta(
        &mut self,
        players: &HashMap<String, Player>,
        zombies: &[Zombie],
        bullets: &[Bullet],
        wave: u32,
        ammo_availability: &HashMap<String, bool>,
        game_over: bool,
    ) -> DeltaState {
        self.tick += 1;

        if self.prev.is_none() {
            self.save_state(players, zombies, bullets, wave, ammo_availability, game_over);
            let player_deltas: HashMap<String, PlayerDelta> = players.iter().map(|(id, p)| {
                (id.clone(), PlayerDelta {
                    id: p.id.clone(),
                    pos: Some(p.pos.clone()),
                    angle: Some(p.angle),
                    score: Some(p.score),
                    health: Some(p.health),
                    ammo: Some(p.ammo),
                    max_ammo: Some(p.max_ammo),
                    weapon: Some(p.weapon.clone()),
                })
            }).collect();

            return DeltaState {
                msg_type: "delta".to_string(),
                tick: self.tick,
                players: Some(player_deltas),
                players_removed: None,
                zombies_new: Some(zombies.to_vec()),
                zombies_updated: None,
                zombies_removed: None,
                bullets_new: Some(bullets.to_vec()),
                bullets_removed: None,
                wave: Some(wave),
                ammo_pickups: None,
                game_over: Some(game_over),
            };
        }

        let prev = self.prev.as_ref().unwrap();
        let mut delta = DeltaState {
            msg_type: "delta".to_string(),
            tick: self.tick,
            players: None,
            players_removed: None,
            zombies_new: None,
            zombies_updated: None,
            zombies_removed: None,
            bullets_new: None,
            bullets_removed: None,
            wave: None,
            ammo_pickups: None,
            game_over: None,
        };

        // Players
        let mut player_changes: HashMap<String, PlayerDelta> = HashMap::new();
        let mut players_removed: Vec<String> = Vec::new();

        for (id, curr) in players {
            if let Some(prev_p) = prev.players.get(id) {
                let mut pd = PlayerDelta {
                    id: id.clone(),
                    pos: None, angle: None, score: None, health: None,
                    ammo: None, max_ammo: None, weapon: None,
                };
                let mut changed = false;

                if (curr.pos.x - prev_p.pos.x).abs() > 0.5 || (curr.pos.y - prev_p.pos.y).abs() > 0.5 {
                    pd.pos = Some(Vector2 {
                        x: (curr.pos.x * 10.0).round() / 10.0,
                        y: (curr.pos.y * 10.0).round() / 10.0,
                    });
                    changed = true;
                }
                if (curr.angle - prev_p.angle).abs() > 0.01 {
                    pd.angle = Some((curr.angle * 100.0).round() / 100.0);
                    changed = true;
                }
                if curr.health != prev_p.health { pd.health = Some(curr.health); changed = true; }
                if curr.score != prev_p.score { pd.score = Some(curr.score); changed = true; }
                if curr.ammo != prev_p.ammo { pd.ammo = Some(curr.ammo); changed = true; }
                if curr.weapon != prev_p.weapon { pd.weapon = Some(curr.weapon.clone()); changed = true; }

                if changed {
                    player_changes.insert(id.clone(), pd);
                }
            } else {
                // New player
                player_changes.insert(id.clone(), PlayerDelta {
                    id: curr.id.clone(),
                    pos: Some(curr.pos.clone()),
                    angle: Some(curr.angle),
                    score: Some(curr.score),
                    health: Some(curr.health),
                    ammo: Some(curr.ammo),
                    max_ammo: Some(curr.max_ammo),
                    weapon: Some(curr.weapon.clone()),
                });
            }
        }
        for id in prev.players.keys() {
            if !players.contains_key(id) {
                players_removed.push(id.clone());
            }
        }
        if !player_changes.is_empty() { delta.players = Some(player_changes); }
        if !players_removed.is_empty() { delta.players_removed = Some(players_removed); }

        // Zombies
        let mut zombies_new: Vec<Zombie> = Vec::new();
        let mut zombies_updated: Vec<ZombieDelta> = Vec::new();
        let mut zombies_removed: Vec<String> = Vec::new();
        let mut curr_zombie_ids: HashSet<String> = HashSet::new();

        for z in zombies {
            curr_zombie_ids.insert(z.id.clone());
            if let Some(prev_z) = prev.zombie_map.get(&z.id) {
                let mut zd = ZombieDelta { id: z.id.clone(), pos: None, health: None };
                let mut changed = false;

                if (z.pos.x - prev_z.pos.x).abs() > 0.5 || (z.pos.y - prev_z.pos.y).abs() > 0.5 {
                    zd.pos = Some(Vector2 { x: z.pos.x.round(), y: z.pos.y.round() });
                    changed = true;
                }
                if z.health != prev_z.health { zd.health = Some(z.health); changed = true; }
                if changed { zombies_updated.push(zd); }
            } else {
                zombies_new.push(z.clone());
            }
        }
        for id in prev.zombie_map.keys() {
            if !curr_zombie_ids.contains(id) {
                zombies_removed.push(id.clone());
            }
        }
        if !zombies_new.is_empty() { delta.zombies_new = Some(zombies_new); }
        if !zombies_updated.is_empty() { delta.zombies_updated = Some(zombies_updated); }
        if !zombies_removed.is_empty() { delta.zombies_removed = Some(zombies_removed); }

        // Bullets
        let curr_bullet_ids: HashSet<String> = bullets.iter().map(|b| b.id.clone()).collect();
        let mut bullets_new: Vec<Bullet> = Vec::new();
        let mut bullets_removed: Vec<String> = Vec::new();

        for b in bullets {
            if !prev.bullet_set.contains(&b.id) {
                bullets_new.push(b.clone());
            }
        }
        for id in &prev.bullet_set {
            if !curr_bullet_ids.contains(id) {
                bullets_removed.push(id.clone());
            }
        }
        if !bullets_new.is_empty() { delta.bullets_new = Some(bullets_new); }
        if !bullets_removed.is_empty() { delta.bullets_removed = Some(bullets_removed); }

        // Wave
        if wave != prev.wave { delta.wave = Some(wave); }

        // Ammo
        let mut ammo_changes: Vec<AmmoPickupState> = Vec::new();
        for (id, avail) in ammo_availability {
            if prev.ammo_availability.get(id) != Some(avail) {
                ammo_changes.push(AmmoPickupState { id: id.clone(), available: *avail });
            }
        }
        if !ammo_changes.is_empty() { delta.ammo_pickups = Some(ammo_changes); }

        // Game over
        if game_over != prev.game_over { delta.game_over = Some(game_over); }

        self.save_state(players, zombies, bullets, wave, ammo_availability, game_over);
        delta
    }

    pub fn build_snapshot(
        &self,
        players: &HashMap<String, Player>,
        zombies: &[Zombie],
        bullets: &[Bullet],
        wave: u32,
        ammo_availability: &HashMap<String, bool>,
        game_over: bool,
    ) -> SnapshotState {
        SnapshotState {
            msg_type: "snapshot".to_string(),
            tick: self.tick,
            players: players.clone(),
            zombies: zombies.to_vec(),
            bullets: bullets.to_vec(),
            wave,
            ammo_pickups: ammo_availability.iter().map(|(id, avail)| {
                AmmoPickupState { id: id.clone(), available: *avail }
            }).collect(),
            game_over,
        }
    }

    fn save_state(
        &mut self,
        players: &HashMap<String, Player>,
        zombies: &[Zombie],
        bullets: &[Bullet],
        wave: u32,
        ammo_availability: &HashMap<String, bool>,
        game_over: bool,
    ) {
        let mut zombie_map = HashMap::new();
        for z in zombies {
            zombie_map.insert(z.id.clone(), z.clone());
        }
        self.prev = Some(PrevState {
            players: players.clone(),
            zombie_map,
            bullet_set: bullets.iter().map(|b| b.id.clone()).collect(),
            wave,
            ammo_availability: ammo_availability.clone(),
            game_over,
        });
    }
}
