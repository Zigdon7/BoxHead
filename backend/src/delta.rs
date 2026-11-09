use std::collections::{HashMap, HashSet};
use crate::types::*;

/// Everything the delta tracker diffs, borrowed from a frame.
pub struct World<'a> {
    pub players: &'a HashMap<String, Player>,
    pub zombies: &'a [Zombie],
    pub bullets: &'a [Bullet],
    pub placeables: &'a [Placeable],
    pub drops: &'a [DropPickup],
    pub ammo: &'a HashMap<String, bool>,
    pub crates: &'a HashMap<String, bool>,
}

fn tenths(v: f64) -> f64 { (v * 10.0).round() / 10.0 }

struct PrevState {
    players: HashMap<String, Player>,
    zombie_map: HashMap<String, Zombie>,
    bullet_set: HashSet<String>,
    placeable_map: HashMap<String, Placeable>,
    drop_set: HashSet<String>,
    ammo: HashMap<String, bool>,
    crates: HashMap<String, bool>,
}

/// Per-client diff state. Ticks come from the room's frame sequence, so they
/// keep increasing across restarts and resyncs.
pub struct DeltaTracker {
    prev: Option<PrevState>,
}

fn full_player(p: &Player) -> PlayerDelta {
    PlayerDelta {
        id: p.id.clone(),
        name: Some(p.name.clone()),
        pos: Some(p.pos.clone()),
        angle: Some(p.angle),
        health: Some(p.health),
        max_health: Some(p.max_health),
        ammo: Some(p.ammo),
        max_ammo: Some(p.max_ammo),
        weapon: Some(p.weapon.clone()),
        weapons: Some(p.weapons.clone()),
        active_slot: Some(p.active_slot),
        combo: Some(p.combo),
        combo_timer: Some(tenths(p.combo_timer)),
        max_combo: Some(p.max_combo),
        kills: Some(p.kills),
        tactical_items: Some(p.tactical_items),
        bounty: Some(p.bounty),
        backpack: Some(p.backpack.clone()),
        backpack_capacity: Some(p.backpack_capacity),
        gear_score: Some(p.gear_score),
        raid_time: Some(p.raid_time.ceil()),
        extract_progress: Some(tenths(p.extract_progress)),
        bleedout: Some(tenths(p.bleedout)),
        camp: Some(p.camp.floor()),
        hunted: Some(p.hunted),
        decrypt: Some(tenths(p.decrypt)),
        damage_log: Some(p.damage_log.clone()),
    }
}

/// Fields that changed since the previous frame. Timers are compared at the
/// resolution clients see, so a slow countdown still crosses each boundary.
fn player_diff(prev: &Player, curr: &Player) -> Option<PlayerDelta> {
    let mut d = PlayerDelta { id: curr.id.clone(), ..Default::default() };
    let mut changed = false;
    macro_rules! eq_field {
        ($f:ident) => {
            if curr.$f != prev.$f { d.$f = Some(curr.$f.clone()); changed = true; }
        };
    }
    // Compare at wire precision, not frame to frame: slow aiming or creeping
    // must still cross each rounding boundary and reach other clients.
    if tenths(curr.pos.x) != tenths(prev.pos.x) || tenths(curr.pos.y) != tenths(prev.pos.y) {
        d.pos = Some(Vector2 { x: tenths(curr.pos.x), y: tenths(curr.pos.y) });
        changed = true;
    }
    let hundredths = |a: f64| (a * 100.0).round() / 100.0;
    if hundredths(curr.angle) != hundredths(prev.angle) {
        d.angle = Some(hundredths(curr.angle));
        changed = true;
    }
    eq_field!(name);
    eq_field!(health);
    eq_field!(max_health);
    eq_field!(ammo);
    eq_field!(max_ammo);
    eq_field!(weapon);
    eq_field!(weapons);
    eq_field!(active_slot);
    eq_field!(combo);
    eq_field!(max_combo);
    eq_field!(kills);
    eq_field!(tactical_items);
    eq_field!(bounty);
    eq_field!(backpack);
    eq_field!(backpack_capacity);
    eq_field!(gear_score);
    eq_field!(damage_log);
    eq_field!(hunted);
    if curr.camp.floor() != prev.camp.floor() { d.camp = Some(curr.camp.floor()); changed = true; }
    if tenths(curr.combo_timer) != tenths(prev.combo_timer) { d.combo_timer = Some(tenths(curr.combo_timer)); changed = true; }
    if curr.raid_time.ceil() != prev.raid_time.ceil() { d.raid_time = Some(curr.raid_time.ceil()); changed = true; }
    if tenths(curr.extract_progress) != tenths(prev.extract_progress) { d.extract_progress = Some(tenths(curr.extract_progress)); changed = true; }
    if tenths(curr.bleedout) != tenths(prev.bleedout) { d.bleedout = Some(tenths(curr.bleedout)); changed = true; }
    if tenths(curr.decrypt) != tenths(prev.decrypt) { d.decrypt = Some(tenths(curr.decrypt)); changed = true; }
    changed.then_some(d)
}

fn availability(map: &HashMap<String, bool>) -> Vec<AmmoPickupState> {
    map.iter().map(|(id, available)| AmmoPickupState { id: id.clone(), available: *available }).collect()
}

fn availability_changes(prev: &HashMap<String, bool>, curr: &HashMap<String, bool>) -> Option<Vec<AmmoPickupState>> {
    let changes: Vec<_> = curr.iter().filter(|(id, a)| prev.get(*id) != Some(a))
        .map(|(id, a)| AmmoPickupState { id: id.clone(), available: *a }).collect();
    (!changes.is_empty()).then_some(changes)
}

impl DeltaTracker {
    pub fn new() -> Self {
        DeltaTracker { prev: None }
    }

    pub fn compute_delta(&mut self, w: &World, tick: u64) -> DeltaState {
        let mut delta = DeltaState { msg_type: "delta".to_string(), tick, ..Default::default() };

        let Some(prev) = self.prev.as_ref() else {
            delta.players = Some(w.players.iter().map(|(id, p)| (id.clone(), full_player(p))).collect());
            delta.zombies_new = Some(w.zombies.to_vec());
            delta.bullets_new = Some(w.bullets.to_vec());
            if !w.placeables.is_empty() { delta.placeables_new = Some(w.placeables.to_vec()); }
            if !w.drops.is_empty() { delta.drops_new = Some(w.drops.to_vec()); }
            delta.ammo_pickups = Some(availability(w.ammo));
            delta.crates = Some(availability(w.crates));
            self.save_state(w);
            return delta;
        };

        // Players
        let mut player_changes: HashMap<String, PlayerDelta> = HashMap::new();
        for (id, curr) in w.players {
            match prev.players.get(id) {
                Some(prev_p) => { if let Some(d) = player_diff(prev_p, curr) { player_changes.insert(id.clone(), d); } }
                None => { player_changes.insert(id.clone(), full_player(curr)); }
            }
        }
        let players_removed: Vec<String> = prev.players.keys().filter(|id| !w.players.contains_key(*id)).cloned().collect();
        if !player_changes.is_empty() { delta.players = Some(player_changes); }
        if !players_removed.is_empty() { delta.players_removed = Some(players_removed); }

        // Zombies
        let mut zombies_new = Vec::new();
        let mut zombies_updated = Vec::new();
        let mut curr_zombie_ids: HashSet<&str> = HashSet::new();
        for z in w.zombies {
            curr_zombie_ids.insert(&z.id);
            if let Some(prev_z) = prev.zombie_map.get(&z.id) {
                let mut zd = ZombieDelta { id: z.id.clone(), pos: None, health: None };
                // Compare wire coordinates: sub-half-pixel movement must still cross
                // pixel boundaries, even though the baseline is saved every tick.
                if z.pos.x.round() != prev_z.pos.x.round() || z.pos.y.round() != prev_z.pos.y.round() {
                    zd.pos = Some(Vector2 { x: z.pos.x.round(), y: z.pos.y.round() });
                }
                if z.health != prev_z.health { zd.health = Some(z.health); }
                if zd.pos.is_some() || zd.health.is_some() { zombies_updated.push(zd); }
            } else {
                zombies_new.push(z.clone());
            }
        }
        let zombies_removed: Vec<String> = prev.zombie_map.keys().filter(|id| !curr_zombie_ids.contains(id.as_str())).cloned().collect();
        if !zombies_new.is_empty() { delta.zombies_new = Some(zombies_new); }
        if !zombies_updated.is_empty() { delta.zombies_updated = Some(zombies_updated); }
        if !zombies_removed.is_empty() { delta.zombies_removed = Some(zombies_removed); }

        // Bullets
        let curr_bullet_ids: HashSet<&str> = w.bullets.iter().map(|b| b.id.as_str()).collect();
        let bullets_new: Vec<Bullet> = w.bullets.iter().filter(|b| !prev.bullet_set.contains(&b.id)).cloned().collect();
        let bullets_removed: Vec<String> = prev.bullet_set.iter().filter(|id| !curr_bullet_ids.contains(id.as_str())).cloned().collect();
        if !bullets_new.is_empty() { delta.bullets_new = Some(bullets_new); }
        if !bullets_removed.is_empty() { delta.bullets_removed = Some(bullets_removed); }

        // Placeables
        let mut placeables_new = Vec::new();
        let mut placeables_updated = Vec::new();
        let curr_placeable_ids: HashSet<&str> = w.placeables.iter().map(|p| p.id.as_str()).collect();
        for p in w.placeables {
            match prev.placeable_map.get(&p.id) {
                Some(prev_pl) if p.health != prev_pl.health => placeables_updated.push(PlaceableDelta { id: p.id.clone(), health: Some(p.health) }),
                Some(_) => {}
                None => placeables_new.push(p.clone()),
            }
        }
        let placeables_removed: Vec<String> = prev.placeable_map.keys().filter(|id| !curr_placeable_ids.contains(id.as_str())).cloned().collect();
        if !placeables_new.is_empty() { delta.placeables_new = Some(placeables_new); }
        if !placeables_updated.is_empty() { delta.placeables_updated = Some(placeables_updated); }
        if !placeables_removed.is_empty() { delta.placeables_removed = Some(placeables_removed); }

        // Drops
        let curr_drop_ids: HashSet<&str> = w.drops.iter().map(|d| d.id.as_str()).collect();
        let drops_new: Vec<DropPickup> = w.drops.iter().filter(|d| !prev.drop_set.contains(&d.id)).cloned().collect();
        let drops_removed: Vec<String> = prev.drop_set.iter().filter(|id| !curr_drop_ids.contains(id.as_str())).cloned().collect();
        if !drops_new.is_empty() { delta.drops_new = Some(drops_new); }
        if !drops_removed.is_empty() { delta.drops_removed = Some(drops_removed); }

        delta.ammo_pickups = availability_changes(&prev.ammo, w.ammo);
        delta.crates = availability_changes(&prev.crates, w.crates);

        self.save_state(w);
        delta
    }

    /// A full snapshot, which also becomes the baseline for this client's next delta.
    pub fn snapshot(&mut self, w: &World, tick: u64) -> SnapshotState {
        self.save_state(w);
        SnapshotState {
            msg_type: "snapshot".to_string(),
            tick,
            players: w.players.clone(),
            zombies: w.zombies.to_vec(),
            bullets: w.bullets.to_vec(),
            placeables: w.placeables.to_vec(),
            ammo_pickups: availability(w.ammo),
            crates: availability(w.crates),
            drops: w.drops.to_vec(),
        }
    }

    fn save_state(&mut self, w: &World) {
        self.prev = Some(PrevState {
            players: w.players.clone(),
            zombie_map: w.zombies.iter().map(|z| (z.id.clone(), z.clone())).collect(),
            bullet_set: w.bullets.iter().map(|b| b.id.clone()).collect(),
            placeable_map: w.placeables.iter().map(|p| (p.id.clone(), p.clone())).collect(),
            drop_set: w.drops.iter().map(|d| d.id.clone()).collect(),
            ammo: w.ammo.clone(),
            crates: w.crates.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::test_support::kit;

    fn world<'a>(players: &'a HashMap<String, Player>, zombies: &'a [Zombie], empty: &'a HashMap<String, bool>) -> World<'a> {
        World { players, zombies, bullets: &[], placeables: &[], drops: &[], ammo: empty, crates: empty }
    }

    fn one_player() -> HashMap<String, Player> {
        let mut game = crate::game::Game::new(crate::gear::default_map());
        game.add_player("p", "P", &kit(5, 5, 5));
        game.players().clone()
    }

    #[test]
    fn slow_countdowns_reach_clients_at_their_display_resolution() {
        let mut tracker = DeltaTracker::new();
        let empty = HashMap::new();
        let mut players = one_player();
        let (mut raid_client, mut extract_client) = (0.0, 0.0);
        let mut sent = 0;
        // Ten seconds of raid clock and a full extraction countdown, at 60 Hz.
        for frame in 0..600 {
            let p = players.get_mut("p").unwrap();
            p.raid_time = 600.0 - frame as f64 / 60.0;
            p.extract_progress = (frame as f64 / 60.0).min(6.0);
            let delta = tracker.compute_delta(&world(&players, &[], &empty), 1);
            if let Some(d) = delta.players.and_then(|mut m| m.remove("p")) {
                if let Some(t) = d.raid_time { raid_client = t; sent += 1; }
                if let Some(e) = d.extract_progress { extract_client = e; }
            }
            let p = &players["p"];
            assert_eq!(raid_client, p.raid_time.ceil(), "frame {frame}");
            assert!((extract_client - p.extract_progress).abs() <= 0.051, "frame {frame}: {extract_client} vs {}", p.extract_progress);
        }
        assert!(sent <= 12, "the raid clock is sent once a second, not every frame ({sent})");
    }

    #[test]
    fn slow_aim_reaches_other_clients() {
        let mut tracker = DeltaTracker::new();
        let empty = HashMap::new();
        let mut players = one_player();
        let mut client_angle = 0.0;
        for frame in 0..120 {
            players.get_mut("p").unwrap().angle = frame as f64 * 0.004; // ~0.24 rad/s
            let delta = tracker.compute_delta(&world(&players, &[], &empty), 1);
            if let Some(a) = delta.players.and_then(|mut m| m.remove("p")).and_then(|d| d.angle) { client_angle = a; }
            assert!((client_angle - players["p"].angle).abs() <= 0.0051, "frame {frame}");
        }
    }

    #[test]
    fn slow_diagonal_brutes_stay_in_sync() {
        let mut tracker = DeltaTracker::new();
        let empty = HashMap::new();
        let players = HashMap::new();
        let mut zombie = Zombie {
            id: "brute".into(), zombie_type: ZombieType::Brute,
            pos: Vector2 { x: 100.0, y: 100.0 }, health: 100.0,
            max_health: 100.0, speed: 20.0, elite: false, target: None,
        };
        let mut client_pos = zombie.pos.clone();
        for _ in 0..120 {
            let delta = tracker.compute_delta(&world(&players, std::slice::from_ref(&zombie), &empty), 1);
            for update in delta.zombies_updated.unwrap_or_default() {
                if let Some(pos) = update.pos { client_pos = pos; }
            }
            assert!((client_pos.x - zombie.pos.x).abs() <= 0.51);
            assert!((client_pos.y - zombie.pos.y).abs() <= 0.51);
            zombie.pos.x += 0.22;
            zombie.pos.y += 0.22;
        }
    }

    #[test]
    fn backpack_changes_are_sent_and_quiet_frames_send_nothing() {
        let mut tracker = DeltaTracker::new();
        let empty = HashMap::new();
        let mut players = one_player();
        tracker.compute_delta(&world(&players, &[], &empty), 1);
        let quiet = tracker.compute_delta(&world(&players, &[], &empty), 1);
        assert!(quiet.players.is_none());
        players.get_mut("p").unwrap().backpack.push(crate::gear::loaner_pistol());
        let d = tracker.compute_delta(&world(&players, &[], &empty), 1);
        assert_eq!(d.players.unwrap()["p"].backpack.as_ref().unwrap().len(), 1);
    }
}
