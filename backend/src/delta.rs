use std::collections::{HashMap, HashSet};
use crate::types::*;

struct PrevState {
    players: HashMap<String, Player>,
    zombie_map: HashMap<String, Zombie>,
    bullet_set: HashSet<String>,
    placeable_map: HashMap<String, Placeable>,
    drop_set: HashSet<String>,
    wave: u32,
    wave_kills: u32,
    wave_target: u32,
    wave_break_timer: f64,
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

    #[allow(clippy::too_many_arguments)]
    pub fn compute_delta(
        &mut self,
        players: &HashMap<String, Player>,
        zombies: &[Zombie],
        bullets: &[Bullet],
        placeables: &[Placeable],
        drops: &[DropPickup],
        wave: u32,
        wave_kills: u32,
        wave_target: u32,
        wave_break_timer: f64,
        ammo_availability: &HashMap<String, bool>,
        game_over: bool,
    ) -> DeltaState {
        self.tick += 1;

        if self.prev.is_none() {
            self.save_state(
                players,
                zombies,
                bullets,
                placeables,
                drops,
                wave,
                wave_kills,
                wave_target,
                wave_break_timer,
                ammo_availability,
                game_over,
            );
            let player_deltas: HashMap<String, PlayerDelta> = players.iter().map(|(id, p)| {
                (id.clone(), PlayerDelta {
                    id: p.id.clone(),
                    name: Some(p.name.clone()),
                    pos: Some(p.pos.clone()),
                    angle: Some(p.angle),
                    score: Some(p.score),
                    credits: Some(p.credits),
                    health: Some(p.health),
                    max_health: Some(p.max_health),
                    ammo: Some(p.ammo),
                    max_ammo: Some(p.max_ammo),
                    weapon: Some(p.weapon.clone()),
                    weapon_slots: Some(p.weapon_slots),
                    combo: Some(p.combo),
                    combo_timer: Some(p.combo_timer),
                    max_combo: Some(p.max_combo),
                    kills: Some(p.kills),
                    tactical_items: Some(p.tactical_items),
                    damage_level: Some(p.damage_level),
                    melee_level: Some(p.melee_level),
                    damage_log: Some(p.damage_log.clone()),
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
                placeables_new: if placeables.is_empty() { None } else { Some(placeables.to_vec()) },
                placeables_updated: None,
                placeables_removed: None,
                drops_new: if drops.is_empty() { None } else { Some(drops.to_vec()) },
                drops_removed: None,
                wave: Some(wave),
                wave_kills: Some(wave_kills),
                wave_target: Some(wave_target),
                wave_break_timer: Some(wave_break_timer),
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
            placeables_new: None,
            placeables_updated: None,
            placeables_removed: None,
            drops_new: None,
            drops_removed: None,
            wave: None,
            wave_kills: None,
            wave_target: None,
            wave_break_timer: None,
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
                    name: None, pos: None, angle: None, score: None, credits: None, health: None,
                    max_health: None, ammo: None, max_ammo: None, weapon: None, weapon_slots: None,
                    combo: None, combo_timer: None, max_combo: None, kills: None,
                    tactical_items: None, damage_level: None, melee_level: None, damage_log: None,
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
                if curr.damage_log != prev_p.damage_log { pd.damage_log = Some(curr.damage_log.clone()); changed = true; }
                if curr.health != prev_p.health { pd.health = Some(curr.health); changed = true; }
                if curr.max_health != prev_p.max_health { pd.max_health = Some(curr.max_health); changed = true; }
                if curr.score != prev_p.score { pd.score = Some(curr.score); changed = true; }
                if curr.credits != prev_p.credits { pd.credits = Some(curr.credits); changed = true; }
                if curr.ammo != prev_p.ammo { pd.ammo = Some(curr.ammo); changed = true; }
                if curr.max_ammo != prev_p.max_ammo { pd.max_ammo = Some(curr.max_ammo); changed = true; }
                if curr.weapon != prev_p.weapon { pd.weapon = Some(curr.weapon.clone()); changed = true; }
                if curr.weapon_slots != prev_p.weapon_slots { pd.weapon_slots = Some(curr.weapon_slots); changed = true; }
                if curr.combo != prev_p.combo { pd.combo = Some(curr.combo); changed = true; }
                if (curr.combo_timer - prev_p.combo_timer).abs() > 0.05 {
                    pd.combo_timer = Some((curr.combo_timer * 10.0).round() / 10.0);
                    changed = true;
                }
                if curr.max_combo != prev_p.max_combo { pd.max_combo = Some(curr.max_combo); changed = true; }
                if curr.kills != prev_p.kills { pd.kills = Some(curr.kills); changed = true; }
                if curr.tactical_items != prev_p.tactical_items { pd.tactical_items = Some(curr.tactical_items); changed = true; }
                if curr.damage_level != prev_p.damage_level { pd.damage_level = Some(curr.damage_level); changed = true; }
                if curr.melee_level != prev_p.melee_level { pd.melee_level = Some(curr.melee_level); changed = true; }

                if changed {
                    player_changes.insert(id.clone(), pd);
                }
            } else {
                // New player
                player_changes.insert(id.clone(), PlayerDelta {
                    id: curr.id.clone(),
                    name: Some(curr.name.clone()),
                    pos: Some(curr.pos.clone()),
                    angle: Some(curr.angle),
                    score: Some(curr.score),
                    credits: Some(curr.credits),
                    health: Some(curr.health),
                    max_health: Some(curr.max_health),
                    ammo: Some(curr.ammo),
                    max_ammo: Some(curr.max_ammo),
                    weapon: Some(curr.weapon.clone()),
                    weapon_slots: Some(curr.weapon_slots),
                    combo: Some(curr.combo),
                    combo_timer: Some(curr.combo_timer),
                    max_combo: Some(curr.max_combo),
                    kills: Some(curr.kills),
                    tactical_items: Some(curr.tactical_items),
                    damage_level: Some(curr.damage_level),
                    melee_level: Some(curr.melee_level),
                    damage_log: Some(curr.damage_log.clone()),
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

                // Compare wire coordinates: sub-half-pixel movement must still cross
                // pixel boundaries, even though the baseline is saved every tick.
                if z.pos.x.round() != prev_z.pos.x.round() || z.pos.y.round() != prev_z.pos.y.round() {
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

        // Placeables
        let mut placeables_new: Vec<Placeable> = Vec::new();
        let mut placeables_updated: Vec<PlaceableDelta> = Vec::new();
        let mut placeables_removed: Vec<String> = Vec::new();
        let mut curr_placeable_ids: HashSet<String> = HashSet::new();

        for p in placeables {
            curr_placeable_ids.insert(p.id.clone());
            if let Some(prev_pl) = prev.placeable_map.get(&p.id) {
                if p.health != prev_pl.health {
                    placeables_updated.push(PlaceableDelta {
                        id: p.id.clone(),
                        health: Some(p.health),
                    });
                }
            } else {
                placeables_new.push(p.clone());
            }
        }
        for id in prev.placeable_map.keys() {
            if !curr_placeable_ids.contains(id) {
                placeables_removed.push(id.clone());
            }
        }
        if !placeables_new.is_empty() { delta.placeables_new = Some(placeables_new); }
        if !placeables_updated.is_empty() { delta.placeables_updated = Some(placeables_updated); }
        if !placeables_removed.is_empty() { delta.placeables_removed = Some(placeables_removed); }

        // Drops
        let curr_drop_ids: HashSet<String> = drops.iter().map(|d| d.id.clone()).collect();
        let mut drops_new: Vec<DropPickup> = Vec::new();
        let mut drops_removed: Vec<String> = Vec::new();

        for d in drops {
            if !prev.drop_set.contains(&d.id) {
                drops_new.push(d.clone());
            }
        }
        for id in &prev.drop_set {
            if !curr_drop_ids.contains(id) {
                drops_removed.push(id.clone());
            }
        }
        if !drops_new.is_empty() { delta.drops_new = Some(drops_new); }
        if !drops_removed.is_empty() { delta.drops_removed = Some(drops_removed); }

        // Wave & progress
        if wave != prev.wave { delta.wave = Some(wave); }
        if wave_kills != prev.wave_kills { delta.wave_kills = Some(wave_kills); }
        if wave_target != prev.wave_target { delta.wave_target = Some(wave_target); }
        if (wave_break_timer - prev.wave_break_timer).abs() > 0.05 {
            delta.wave_break_timer = Some((wave_break_timer * 10.0).round() / 10.0);
        }

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

        self.save_state(
            players,
            zombies,
            bullets,
            placeables,
            drops,
            wave,
            wave_kills,
            wave_target,
            wave_break_timer,
            ammo_availability,
            game_over,
        );
        delta
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_snapshot(
        &self,
        players: &HashMap<String, Player>,
        zombies: &[Zombie],
        bullets: &[Bullet],
        placeables: &[Placeable],
        drops: &[DropPickup],
        wave: u32,
        wave_kills: u32,
        wave_target: u32,
        wave_break_timer: f64,
        ammo_availability: &HashMap<String, bool>,
        game_over: bool,
    ) -> SnapshotState {
        SnapshotState {
            msg_type: "snapshot".to_string(),
            tick: self.tick,
            players: players.clone(),
            zombies: zombies.to_vec(),
            bullets: bullets.to_vec(),
            placeables: placeables.to_vec(),
            wave,
            wave_kills,
            wave_target,
            wave_break_timer: (wave_break_timer * 10.0).round() / 10.0,
            ammo_pickups: ammo_availability.iter().map(|(id, avail)| {
                AmmoPickupState { id: id.clone(), available: *avail }
            }).collect(),
            drops: drops.to_vec(),
            game_over,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn save_state(
        &mut self,
        players: &HashMap<String, Player>,
        zombies: &[Zombie],
        bullets: &[Bullet],
        placeables: &[Placeable],
        drops: &[DropPickup],
        wave: u32,
        wave_kills: u32,
        wave_target: u32,
        wave_break_timer: f64,
        ammo_availability: &HashMap<String, bool>,
        game_over: bool,
    ) {
        let mut zombie_map = HashMap::new();
        for z in zombies {
            zombie_map.insert(z.id.clone(), z.clone());
        }
        let mut placeable_map = HashMap::new();
        for p in placeables {
            placeable_map.insert(p.id.clone(), p.clone());
        }
        self.prev = Some(PrevState {
            players: players.clone(),
            zombie_map,
            bullet_set: bullets.iter().map(|b| b.id.clone()).collect(),
            placeable_map,
            drop_set: drops.iter().map(|d| d.id.clone()).collect(),
            wave,
            wave_kills,
            wave_target,
            wave_break_timer,
            ammo_availability: ammo_availability.clone(),
            game_over,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_diagonal_brutes_stay_in_sync() {
        let mut tracker = DeltaTracker::new();
        let mut zombie = Zombie {
            id: "brute".into(), zombie_type: ZombieType::Brute,
            pos: Vector2 { x: 100.0, y: 100.0 }, health: 100.0,
            max_health: 100.0, speed: 20.0,
        };
        let mut client_pos = zombie.pos.clone();
        for _ in 0..120 {
            let delta = tracker.compute_delta(
                &HashMap::new(), &[zombie.clone()], &[], &[], &[],
                1, 0, 10, 0.0, &HashMap::new(), false,
            );
            if let Some(updates) = delta.zombies_updated {
                for update in updates {
                    if let Some(pos) = update.pos { client_pos = pos; }
                }
            }
            assert!((client_pos.x - zombie.pos.x).abs() <= 0.51);
            assert!((client_pos.y - zombie.pos.y).abs() <= 0.51);
            zombie.pos.x += 0.22;
            zombie.pos.y += 0.22;
        }
    }
}
