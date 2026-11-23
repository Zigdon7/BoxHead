//! Base defense and base raids: the tower-defense side of the Homefront.
//!
//! * Every operator has a **base** on a square map: a headquarters (HQ) that
//!   sits against a **side or corner** the owner picks, and three **entrances**
//!   on the far edges. The owner places **equipment** (walls, turrets, sniper
//!   towers, mines) and **garrison soldiers** on the grid. Walls and towers
//!   block movement, so a layout is only valid while every entrance still has
//!   a walkable route to the HQ.
//! * An attacker brings **three waves** of soldiers and picks an entrance for
//!   each wave. The fight is simulated here, on the server, with no random
//!   numbers: the same base and plan always give the same battle, so a replay
//!   is just the simulation run again.
//! * **Fog of war**: the attacker only ever learns about squares their
//!   soldiers got close to, and a square stays revealed for the rest of the
//!   raid. [`Battle::replay`] with `fog` leaves everything else out of the
//!   data, so it can't be read from the network either.
//!
//! All numbers here are first-pass playtest values.

use std::collections::VecDeque;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Cells along each edge of a base map.
pub const GRID: usize = 17;
pub const CELLS: usize = GRID * GRID;
/// Bumped whenever the simulation changes, so old replays aren't re-run under new rules.
pub const SIM_VERSION: u32 = 1;
pub const TICKS_PER_SEC: u32 = 10;
/// A raid ends after this long even if soldiers are still alive.
pub const MAX_TICKS: u32 = 150 * TICKS_PER_SEC;
pub const WAVES: usize = 3;
/// Time between one wave starting and the next.
pub const WAVE_GAP: u32 = 8 * TICKS_PER_SEC;
/// Time between soldiers of one wave stepping through the entrance.
pub const SPAWN_GAP: u32 = 5;
/// Garrison soldiers are dug in: this much more health than the same soldier attacking.
pub const GUARD_HP_MULT: f32 = 1.5;
pub const MINE_DAMAGE: u32 = 130;
pub const MINE_RADIUS: f32 = 1.5;

/// Share of the defender's cash a raid can take, and the most it can ever take.
pub const LOOT_SHARE: f64 = 0.20;
pub const LOOT_CAP: u32 = 15_000;
/// Operators with less cash than this aren't offered as targets: nothing to take.
pub const MIN_TARGET_CASH: u32 = 500;
/// After being raided a base can't be raided again for this long.
pub const SHIELD_SECS: i64 = 8 * 3600;
/// Raid logs kept per operator, per side.
pub const LOG_KEEP: u32 = 30;

const TROOP_LIMIT: u32 = 40;
const DEFENSE_ID: i32 = 1000;
const HQ_ID: i32 = 2000;
const HIDDEN_ID: i32 = -1;

// ---------- What can be bought and placed ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Wall,
    Turret,
    Sniper,
    Mine,
    Rifleman,
    Scout,
    Heavy,
    Grenadier,
}

pub const KINDS: [Kind; 8] = [
    Kind::Wall, Kind::Turret, Kind::Sniper, Kind::Mine,
    Kind::Rifleman, Kind::Scout, Kind::Heavy, Kind::Grenadier,
];
pub const SOLDIERS: [Kind; 4] = [Kind::Rifleman, Kind::Scout, Kind::Heavy, Kind::Grenadier];
/// The order a wave walks in: the toughest soldiers lead.
const MARCH_ORDER: [Kind; 4] = [Kind::Heavy, Kind::Rifleman, Kind::Grenadier, Kind::Scout];

/// How a soldier or a gun fights.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Combat {
    pub hp: f32,
    /// In cells.
    pub range: f32,
    pub damage: u32,
    /// Ticks between shots.
    pub cooldown: u32,
    /// Cells per second (0 for things that don't move).
    pub speed: f32,
    /// Damage multiplier against turrets, towers and the HQ.
    pub structure_mult: f32,
    /// How far around itself a soldier clears the fog, in cells.
    pub sight: i32,
    /// Room a soldier takes in a wave.
    pub supply: u32,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Wall => "wall", Kind::Turret => "turret", Kind::Sniper => "sniper", Kind::Mine => "mine",
            Kind::Rifleman => "rifleman", Kind::Scout => "scout", Kind::Heavy => "heavy", Kind::Grenadier => "grenadier",
        }
    }
    pub fn parse(s: &str) -> Option<Self> { KINDS.into_iter().find(|k| k.as_str() == s) }
    fn index(&self) -> usize { KINDS.iter().position(|k| k == self).unwrap() }
    pub fn label(&self) -> &'static str {
        match self {
            Kind::Wall => "Wall", Kind::Turret => "Gun turret", Kind::Sniper => "Sniper tower", Kind::Mine => "Mine",
            Kind::Rifleman => "Rifleman", Kind::Scout => "Scout", Kind::Heavy => "Heavy", Kind::Grenadier => "Grenadier",
        }
    }
    pub fn blurb(&self) -> &'static str {
        match self {
            Kind::Wall => "Blocks the way. Can't be destroyed, so it can never seal the HQ off.",
            Kind::Turret => "Fast, short-range gun. Blocks the way until it is destroyed.",
            Kind::Sniper => "Slow, hard-hitting shots across half the map.",
            Kind::Mine => "Hidden until stepped on, then hurts everyone close by. One use per raid.",
            Kind::Rifleman => "Steady all-rounder.",
            Kind::Scout => "Fast and fragile. Clears twice as much fog.",
            Kind::Heavy => "Slow, tough, leads the wave and soaks up fire.",
            Kind::Grenadier => "Wrecks turrets, towers and the HQ.",
        }
    }
    pub fn is_soldier(&self) -> bool { SOLDIERS.contains(self) }
    /// Soldiers can't walk through this.
    pub fn blocks(&self) -> bool { matches!(self, Kind::Wall | Kind::Turret | Kind::Sniper) }
    pub fn price(&self) -> u32 {
        match self {
            Kind::Wall => 25, Kind::Turret => 450, Kind::Sniper => 800, Kind::Mine => 140,
            Kind::Rifleman => 60, Kind::Scout => 45, Kind::Heavy => 150, Kind::Grenadier => 170,
        }
    }
    /// How it fights. Walls and mines don't.
    pub fn combat(&self) -> Option<Combat> {
        let c = |hp, range, damage, cooldown, speed, structure_mult, sight, supply| Combat { hp, range, damage, cooldown, speed, structure_mult, sight, supply };
        Some(match self {
            Kind::Wall | Kind::Mine => return None,
            Kind::Turret => c(300.0, 3.5, 7, 3, 0.0, 1.0, 0, 0),
            Kind::Sniper => c(200.0, 6.0, 45, 24, 0.0, 1.0, 0, 0),
            Kind::Rifleman => c(120.0, 3.0, 10, 5, 1.6, 1.0, 1, 1),
            Kind::Scout => c(70.0, 2.0, 5, 4, 2.8, 1.0, 2, 1),
            Kind::Heavy => c(420.0, 1.6, 16, 8, 1.2, 1.0, 1, 2),
            Kind::Grenadier => c(110.0, 2.8, 30, 15, 1.4, 2.5, 1, 2),
        })
    }
    /// Most of this equipment a base of `tier` can have placed. Garrison
    /// soldiers share one limit instead: [`guard_cap`].
    pub fn cap(&self, tier: u32) -> u32 {
        let t = tier.clamp(1, 4);
        match self {
            Kind::Wall => 20 + 12 * t,
            Kind::Turret => 1 + t,
            Kind::Sniper => t - 1,
            Kind::Mine => 2 * t,
            _ => guard_cap(tier),
        }
    }
}

/// Most garrison soldiers (of any kind) a base of `tier` can post.
pub fn guard_cap(tier: u32) -> u32 { 1 + tier.clamp(1, 4) }
/// Supply each attacking wave can hold for an operator whose Homefront is `tier`.
pub fn wave_supply(tier: u32) -> u32 { 3 + 3 * tier.clamp(1, 4) }
pub fn hq_hp(tier: u32) -> u32 { 1500 + 500 * tier.clamp(1, 4) }

/// What a raid takes from a defender with `cash`: half the pool scales with
/// the damage done to the HQ, and destroying the HQ takes all of it.
pub fn loot_pool(cash: u32) -> u32 { ((cash as f64 * LOOT_SHARE).floor() as u32).min(LOOT_CAP) }
pub fn loot_for(cash: u32, hq_damage: f64, destroyed: bool) -> u32 {
    let share = if destroyed { 1.0 } else { 0.5 * hq_damage.clamp(0.0, 1.0) };
    ((loot_pool(cash) as f64 * share).floor() as u32).min(cash)
}

/// A count of each kind: what's owned, what a wave holds, what was lost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts([u32; KINDS.len()]);

impl Counts {
    pub fn get(&self, kind: Kind) -> u32 { self.0[kind.index()] }
    pub fn set(&mut self, kind: Kind, n: u32) { self.0[kind.index()] = n; }
    pub fn add(&mut self, kind: Kind, n: u32) { self.0[kind.index()] += n; }
    pub fn total(&self) -> u32 { self.0.iter().sum() }
    pub fn iter(&self) -> impl Iterator<Item = (Kind, u32)> + '_ { KINDS.into_iter().map(|k| (k, self.get(k))).filter(|(_, n)| *n > 0) }
    /// Wave room these soldiers take.
    pub fn supply(&self) -> u32 { self.iter().map(|(k, n)| n * k.combat().map_or(0, |c| c.supply)).sum() }
    pub fn plus(&self, other: &Counts) -> Counts {
        let mut out = *self;
        for k in KINDS { out.add(k, other.get(k)); }
        out
    }
    /// What it costs to own at least `self`, already owning `owned`.
    pub fn cost_beyond(&self, owned: &Counts) -> u32 {
        KINDS.iter().map(|&k| self.get(k).saturating_sub(owned.get(k)) * k.price()).sum()
    }
}

impl Serialize for Counts {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.iter().map(|(k, n)| (k.as_str(), n)))
    }
}

impl<'de> Deserialize<'de> for Counts {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = std::collections::BTreeMap::<String, u32>::deserialize(d)?;
        let mut out = Counts::default();
        for (key, n) in raw { if let Some(k) = Kind::parse(&key) { out.set(k, n.min(9_999)); } }
        Ok(out)
    }
}

// ---------- The map ----------

/// Where on the map the HQ sits. The three entrances are on the far edges.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Site { North, East, South, West, NorthEast, SouthEast, SouthWest, NorthWest }

pub const SITES: [Site; 8] = [
    Site::North, Site::East, Site::South, Site::West,
    Site::NorthEast, Site::SouthEast, Site::SouthWest, Site::NorthWest,
];

pub fn cell_of(x: usize, y: usize) -> usize { y * GRID + x }
pub fn xy_of(cell: usize) -> (usize, usize) { (cell % GRID, cell / GRID) }

impl Site {
    pub fn label(&self) -> &'static str {
        match self {
            Site::North => "North side", Site::East => "East side", Site::South => "South side", Site::West => "West side",
            Site::NorthEast => "North-east corner", Site::SouthEast => "South-east corner",
            Site::SouthWest => "South-west corner", Site::NorthWest => "North-west corner",
        }
    }
    /// The HQ cell and the three entrance cells (A, B, C). Every site is the
    /// west side or the north-west corner, mirrored.
    fn cells(&self) -> ((usize, usize), [(usize, usize); WAVES]) {
        let m = GRID - 1;
        let mid = m / 2;
        let side = ((1, mid), [(m - 4, 0), (m, mid), (m - 4, m)]);
        let corner = ((1, 1), [(m, 4), (m, m), (4, m)]);
        let flip_x = |(hq, e): ((usize, usize), [(usize, usize); WAVES])| ((m - hq.0, hq.1), e.map(|(x, y)| (m - x, y)));
        let flip_y = |(hq, e): ((usize, usize), [(usize, usize); WAVES])| ((hq.0, m - hq.1), e.map(|(x, y)| (x, m - y)));
        let turn = |(hq, e): ((usize, usize), [(usize, usize); WAVES])| ((hq.1, hq.0), e.map(|(x, y)| (y, x)));
        match self {
            Site::West => side,
            Site::East => flip_x(side),
            Site::North => turn(side),
            Site::South => flip_y(turn(side)),
            Site::NorthWest => corner,
            Site::NorthEast => flip_x(corner),
            Site::SouthWest => flip_y(corner),
            Site::SouthEast => flip_x(flip_y(corner)),
        }
    }
    pub fn hq(&self) -> usize { let (x, y) = self.cells().0; cell_of(x, y) }
    pub fn entrances(&self) -> [usize; WAVES] { self.cells().1.map(|(x, y)| cell_of(x, y)) }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Piece {
    pub kind: Kind,
    pub x: u8,
    pub y: u8,
}

impl Piece {
    fn cell(&self) -> usize { cell_of(self.x as usize, self.y as usize) }
}

/// A base as its owner laid it out.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Layout {
    pub site: Site,
    #[serde(default)]
    pub pieces: Vec<Piece>,
}

impl Default for Layout {
    fn default() -> Self { Layout { site: Site::West, pieces: Vec::new() } }
}

impl Layout {
    /// Which cells soldiers can't walk through (including the HQ itself).
    fn blocked(&self) -> Vec<bool> {
        let mut blocked = vec![false; CELLS];
        blocked[self.site.hq()] = true;
        for p in &self.pieces { if p.kind.blocks() { blocked[p.cell()] = true; } }
        blocked
    }

    /// How many of each kind are placed.
    pub fn placed(&self) -> Counts {
        let mut c = Counts::default();
        for p in &self.pieces { c.add(p.kind, 1); }
        c
    }

    /// Check a layout against the rules for a base of `tier`: everything on
    /// the map, one thing per square, within the limits, and every entrance
    /// able to walk to the HQ. Returns what is placed.
    pub fn validate(&self, tier: u32) -> Result<Counts, String> {
        if self.pieces.len() > CELLS { return Err("Too many pieces".into()); }
        let hq = self.site.hq();
        let entrances = self.site.entrances();
        let mut used = vec![false; CELLS];
        for p in &self.pieces {
            if p.x as usize >= GRID || p.y as usize >= GRID { return Err("A piece is off the map".into()); }
            let cell = p.cell();
            if cell == hq { return Err("Nothing can be placed on the HQ".into()); }
            if entrances.contains(&cell) { return Err("Entrances must stay clear".into()); }
            if used[cell] { return Err("Two pieces share a square".into()); }
            used[cell] = true;
        }
        let placed = self.placed();
        for k in KINDS {
            if !k.is_soldier() && placed.get(k) > k.cap(tier) {
                return Err(match k.cap(tier) {
                    0 => format!("{}s unlock at a higher Homefront tier.", k.label()),
                    cap => format!("A tier {tier} base holds {cap} {}s. You placed {}.", k.label().to_lowercase(), placed.get(k)),
                });
            }
        }
        let guards: u32 = SOLDIERS.iter().map(|&k| placed.get(k)).sum();
        if guards > guard_cap(tier) {
            return Err(format!("A tier {tier} base garrisons {} soldiers. You posted {guards}.", guard_cap(tier)));
        }
        let dist = distances(&self.blocked(), hq);
        for (i, &e) in entrances.iter().enumerate() {
            if dist[e] == u32::MAX {
                return Err(format!("Entrance {} is walled off. Every entrance needs a way to the HQ.", ENTRANCE_NAMES[i]));
            }
        }
        Ok(placed)
    }
}

pub const ENTRANCE_NAMES: [char; WAVES] = ['A', 'B', 'C'];

fn neighbors(cell: usize) -> impl Iterator<Item = usize> {
    let (x, y) = xy_of(cell);
    [(x, y.wrapping_sub(1)), (x + 1, y), (x, y + 1), (x.wrapping_sub(1), y)]
        .into_iter().filter(|&(nx, ny)| nx < GRID && ny < GRID).map(|(nx, ny)| cell_of(nx, ny))
}

/// Steps from every walkable cell to the nearest cell touching the HQ
/// (`u32::MAX` where there is no way in).
pub fn distances(blocked: &[bool], hq: usize) -> Vec<u32> {
    let mut dist = vec![u32::MAX; CELLS];
    let mut queue = VecDeque::new();
    for n in neighbors(hq) {
        if !blocked[n] { dist[n] = 0; queue.push_back(n); }
    }
    while let Some(cell) = queue.pop_front() {
        for n in neighbors(cell) {
            if !blocked[n] && dist[n] == u32::MAX {
                dist[n] = dist[cell] + 1;
                queue.push_back(n);
            }
        }
    }
    dist
}

// ---------- A raid ----------

/// The defender's base as it stood when the raid started.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub layout: Layout,
    pub tier: u32,
}

/// What the attacker sends: three waves and the entrance (0–2) each one uses.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Plan {
    pub waves: [Counts; WAVES],
    pub entrances: [u8; WAVES],
}

impl Plan {
    pub fn sent(&self) -> Counts { self.waves.iter().fold(Counts::default(), |acc, w| acc.plus(w)) }
}

/// Check three waves: soldiers only, each within the wave's supply.
pub fn validate_waves(waves: &[Counts; WAVES], tier: u32) -> Result<(), String> {
    let room = wave_supply(tier);
    for (i, w) in waves.iter().enumerate() {
        if w.iter().any(|(k, _)| !k.is_soldier()) { return Err("Waves are made of soldiers".into()); }
        if w.supply() > room {
            return Err(format!("Wave {} needs {} supply. A tier {tier} Homefront fields {room} per wave.", i + 1, w.supply()));
        }
    }
    Ok(())
}

pub fn validate_entrances(entrances: &[u8; WAVES]) -> Result<(), String> {
    if entrances.iter().any(|&e| e as usize >= WAVES) { Err("Pick entrance A, B or C for each wave".into()) } else { Ok(()) }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// 0 to 1.
    pub hq_damage: f64,
    pub destroyed: bool,
    pub ticks: u32,
    pub sent: Counts,
    pub lost: Counts,
}

struct Troop {
    kind: Kind,
    wave: usize,
    c: Combat,
    hp: f32,
    x: f32,
    y: f32,
    cell: usize,
    next: Option<usize>,
    cd: u32,
    spawn: u32,
    spawned: bool,
    died: Option<u32>,
    /// (tick, cell) each time the soldier stood on a cell's centre.
    points: Vec<(u32, u16)>,
}

impl Troop {
    fn alive(&self) -> bool { self.spawned && self.died.is_none() }
}

struct Defense {
    kind: Kind,
    cell: usize,
    c: Combat,
    hp: f32,
    max_hp: f32,
    cd: u32,
    destroyed: Option<u32>,
}

struct Mine {
    cell: usize,
    blown: Option<u32>,
}

struct Blast {
    tick: u32,
    cell: usize,
    hits: Vec<(i32, u32)>,
}

/// A finished raid: everything that happened, tick by tick.
pub struct Battle {
    site: Site,
    plan: Plan,
    hq_max: u32,
    walls: Vec<usize>,
    troops: Vec<Troop>,
    defenses: Vec<Defense>,
    mines: Vec<Mine>,
    /// (tick, attacker, target, damage); ids as in the replay.
    shots: Vec<(u32, i32, i32, u32)>,
    blasts: Vec<Blast>,
    /// When the attacker first saw each cell.
    seen: Vec<Option<u32>>,
    pub outcome: Outcome,
}

fn center(cell: usize) -> (f32, f32) {
    let (x, y) = xy_of(cell);
    (x as f32 + 0.5, y as f32 + 0.5)
}

fn reveal(seen: &mut [Option<u32>], cell: usize, sight: i32, tick: u32) {
    let (cx, cy) = xy_of(cell);
    for dy in -sight..=sight {
        for dx in -sight..=sight {
            let (x, y) = (cx as i32 + dx, cy as i32 + dy);
            if x < 0 || y < 0 || x >= GRID as i32 || y >= GRID as i32 { continue; }
            let c = cell_of(x as usize, y as usize);
            if seen[c].is_none() { seen[c] = Some(tick); }
        }
    }
}

/// Fight a raid out. Deterministic: no random numbers, no clock.
pub fn simulate(base: &Snapshot, plan: &Plan) -> Battle {
    let site = base.layout.site;
    let hq = site.hq();
    let entrances = site.entrances();
    let hq_max = hq_hp(base.tier);
    let mut hq_left = hq_max as f32;
    let hq_at = center(hq);

    let mut blocked = base.layout.blocked();
    let mut dist = distances(&blocked, hq);
    let mut walls = Vec::new();
    let mut defenses = Vec::new();
    let mut mines = Vec::new();
    for p in &base.layout.pieces {
        match (p.kind, p.kind.combat()) {
            (Kind::Wall, _) => walls.push(p.cell()),
            (Kind::Mine, _) => mines.push(Mine { cell: p.cell(), blown: None }),
            (kind, Some(c)) => {
                let hp = if kind.is_soldier() { c.hp * GUARD_HP_MULT } else { c.hp };
                defenses.push(Defense { kind, cell: p.cell(), c, hp, max_hp: hp, cd: 0, destroyed: None });
            }
            _ => {}
        }
    }

    let mut troops = Vec::new();
    for (w, wave) in plan.waves.iter().enumerate() {
        let gate = entrances[(plan.entrances[w] as usize).min(WAVES - 1)];
        let mut n = 0;
        for kind in MARCH_ORDER {
            let Some(c) = kind.combat() else { continue };
            for _ in 0..wave.get(kind).min(TROOP_LIMIT) {
                let (x, y) = center(gate);
                troops.push(Troop {
                    kind, wave: w, c, hp: c.hp, x, y, cell: gate, next: None, cd: 0,
                    spawn: w as u32 * WAVE_GAP + n * SPAWN_GAP, spawned: false, died: None, points: Vec::new(),
                });
                n += 1;
            }
        }
    }

    // The attacker knows where the HQ and the entrances are before the first step.
    let mut seen = vec![None; CELLS];
    seen[hq] = Some(0);
    for e in entrances { seen[e] = Some(0); }

    let mut shots = Vec::new();
    let mut blasts = Vec::new();
    let mut tick = 0;
    let mut destroyed = false;
    loop {
        // Soldiers step through their entrance.
        for t in troops.iter_mut().filter(|t| !t.spawned && t.spawn <= tick) {
            t.spawned = true;
            t.points.push((tick, t.cell as u16));
            reveal(&mut seen, t.cell, t.c.sight, tick);
        }

        // March: always toward a neighbour that is closer to the HQ.
        let mut arrivals = Vec::new();
        for (i, t) in troops.iter_mut().enumerate().filter(|(_, t)| t.alive()) {
            let mut budget = t.c.speed / TICKS_PER_SEC as f32;
            while budget > 0.0 {
                if t.next.is_none() {
                    let here = dist[t.cell];
                    if here == 0 || here == u32::MAX { break; }
                    let options: Vec<usize> = neighbors(t.cell).filter(|&n| dist[n] < here).collect();
                    // Soldiers with equally short ways in spread across them.
                    t.next = options.get(i % options.len().max(1)).copied();
                }
                let Some(next) = t.next else { break };
                let (nx, ny) = center(next);
                let gap = f32::hypot(nx - t.x, ny - t.y);
                if budget < gap {
                    t.x += (nx - t.x) / gap * budget;
                    t.y += (ny - t.y) / gap * budget;
                    break;
                }
                budget -= gap;
                (t.x, t.y, t.cell, t.next) = (nx, ny, next, None);
                t.points.push((tick, next as u16));
                reveal(&mut seen, next, t.c.sight, tick);
                arrivals.push(next);
            }
        }

        // Mines go off under the first soldier to step on them.
        for cell in arrivals {
            let Some(mine) = mines.iter_mut().find(|m| m.cell == cell && m.blown.is_none()) else { continue };
            mine.blown = Some(tick);
            let (mx, my) = center(cell);
            let mut hits = Vec::new();
            for (i, t) in troops.iter_mut().enumerate().filter(|(_, t)| t.alive()) {
                if f32::hypot(t.x - mx, t.y - my) <= MINE_RADIUS {
                    t.hp -= MINE_DAMAGE as f32;
                    if t.hp <= 0.0 { t.died = Some(tick); }
                    hits.push((i as i32, MINE_DAMAGE));
                }
            }
            blasts.push(Blast { tick, cell, hits });
        }

        // Soldiers shoot the nearest gun in reach, or the HQ when no gun is.
        let mut reopened = false;
        for (i, t) in troops.iter_mut().enumerate().filter(|(_, t)| t.alive()) {
            if t.cd > 0 { t.cd -= 1; continue; }
            let target = defenses.iter().enumerate().filter(|(_, d)| d.destroyed.is_none())
                .map(|(j, d)| { let (dx, dy) = center(d.cell); (f32::hypot(dx - t.x, dy - t.y), j) })
                .filter(|&(gap, _)| gap <= t.c.range)
                .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            if let Some((_, j)) = target {
                let d = &mut defenses[j];
                let dmg = if d.kind.is_soldier() { t.c.damage } else { (t.c.damage as f32 * t.c.structure_mult).round() as u32 };
                d.hp -= dmg as f32;
                shots.push((tick, i as i32, DEFENSE_ID + j as i32, dmg));
                if d.hp <= 0.0 {
                    d.destroyed = Some(tick);
                    if d.kind.blocks() { blocked[d.cell] = false; reopened = true; }
                }
                t.cd = t.c.cooldown;
            } else if f32::hypot(hq_at.0 - t.x, hq_at.1 - t.y) <= t.c.range && hq_left > 0.0 {
                let dmg = (t.c.damage as f32 * t.c.structure_mult).round() as u32;
                hq_left -= dmg as f32;
                shots.push((tick, i as i32, HQ_ID, dmg));
                t.cd = t.c.cooldown;
            }
        }
        if reopened { dist = distances(&blocked, hq); }

        // Guns shoot whoever in reach is closest to the HQ.
        for (j, d) in defenses.iter_mut().enumerate().filter(|(_, d)| d.destroyed.is_none()) {
            if d.cd > 0 { d.cd -= 1; continue; }
            let (dx, dy) = center(d.cell);
            let target = troops.iter().enumerate().filter(|(_, t)| t.alive())
                .filter(|(_, t)| f32::hypot(t.x - dx, t.y - dy) <= d.c.range)
                .min_by_key(|(i, t)| (dist[t.cell], *i)).map(|(i, _)| i);
            let Some(i) = target else { continue };
            let t = &mut troops[i];
            t.hp -= d.c.damage as f32;
            if t.hp <= 0.0 { t.died = Some(tick); }
            shots.push((tick, DEFENSE_ID + j as i32, i as i32, d.c.damage));
            d.cd = d.c.cooldown;
        }

        if hq_left <= 0.0 { destroyed = true; break; }
        if troops.iter().all(|t| t.spawned && t.died.is_some()) { break; }
        tick += 1;
        if tick >= MAX_TICKS { break; }
    }

    let mut lost = Counts::default();
    for t in troops.iter().filter(|t| t.died.is_some()) { lost.add(t.kind, 1); }
    let outcome = Outcome {
        hq_damage: (1.0 - (hq_left.max(0.0) / hq_max as f32) as f64).clamp(0.0, 1.0),
        destroyed, ticks: tick, sent: plan.sent(), lost,
    };
    Battle { site, plan: *plan, hq_max, walls, troops, defenses, mines, shots, blasts, seen, outcome }
}

// ---------- Replays ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayDefense {
    pub id: i32,
    pub kind: Kind,
    pub cell: usize,
    pub hp: u32,
    /// Tick the attacker first saw it (None = never).
    pub seen: Option<u32>,
    pub destroyed: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMine {
    pub cell: usize,
    pub blown: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTroop {
    pub id: i32,
    pub kind: Kind,
    pub wave: usize,
    pub hp: u32,
    pub points: Vec<(u32, u16)>,
    pub died: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBlast {
    pub tick: u32,
    pub cell: usize,
    pub hits: Vec<(i32, u32)>,
}

/// A raid as the client plays it back. With `fog`, it holds only what the
/// attacker's soldiers uncovered.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    pub version: u32,
    pub grid: usize,
    pub ticks_per_sec: u32,
    pub fog: bool,
    pub site: Site,
    pub hq: usize,
    pub hq_hp: u32,
    pub entrances: [usize; WAVES],
    pub wave_entrances: [u8; WAVES],
    /// (cell, tick the attacker first saw it).
    pub walls: Vec<(usize, Option<u32>)>,
    pub defenses: Vec<ReplayDefense>,
    pub mines: Vec<ReplayMine>,
    pub troops: Vec<ReplayTroop>,
    /// (tick, attacker id, target id, damage). Soldiers are 0.., defenses 1000..,
    /// the HQ is 2000, and -1 is a gun the attacker never saw.
    pub shots: Vec<(u32, i32, i32, u32)>,
    pub blasts: Vec<ReplayBlast>,
    /// (tick, cell): when each cell came out of the fog.
    pub reveals: Vec<(u32, usize)>,
    pub outcome: Outcome,
}

impl Battle {
    /// Soldiers lost from each wave.
    pub fn lost_by_wave(&self) -> [Counts; WAVES] {
        let mut lost = [Counts::default(); WAVES];
        for t in self.troops.iter().filter(|t| t.died.is_some()) { lost[t.wave].add(t.kind, 1); }
        lost
    }

    pub fn replay(&self, fog: bool) -> Replay {
        let visible = |cell: usize| !fog || self.seen[cell].is_some();
        let mut reveals: Vec<(u32, usize)> = self.seen.iter().enumerate().filter_map(|(c, s)| s.map(|t| (t, c))).collect();
        reveals.sort_unstable();
        Replay {
            version: SIM_VERSION, grid: GRID, ticks_per_sec: TICKS_PER_SEC, fog,
            site: self.site, hq: self.site.hq(), hq_hp: self.hq_max,
            entrances: self.site.entrances(), wave_entrances: self.plan.entrances,
            walls: self.walls.iter().filter(|&&c| visible(c)).map(|&c| (c, self.seen[c])).collect(),
            defenses: self.defenses.iter().enumerate().filter(|(_, d)| visible(d.cell)).map(|(j, d)| ReplayDefense {
                id: DEFENSE_ID + j as i32, kind: d.kind, cell: d.cell, hp: d.max_hp.round() as u32,
                seen: self.seen[d.cell], destroyed: d.destroyed,
            }).collect(),
            // A mine stays hidden until it goes off, even on a square in plain view.
            mines: self.mines.iter().filter(|m| !fog || m.blown.is_some()).map(|m| ReplayMine { cell: m.cell, blown: m.blown }).collect(),
            troops: self.troops.iter().enumerate().filter(|(_, t)| t.spawned).map(|(i, t)| ReplayTroop {
                id: i as i32, kind: t.kind, wave: t.wave, hp: t.c.hp.round() as u32, points: t.points.clone(), died: t.died,
            }).collect(),
            shots: self.shots.iter().map(|&(tick, from, to, dmg)| {
                let hidden = (DEFENSE_ID..HQ_ID).contains(&from) && !visible(self.defenses[(from - DEFENSE_ID) as usize].cell);
                (tick, if hidden { HIDDEN_ID } else { from }, to, dmg)
            }).collect(),
            blasts: self.blasts.iter().map(|b| ReplayBlast { tick: b.tick, cell: b.cell, hits: b.hits.clone() }).collect(),
            reveals,
            outcome: self.outcome.clone(),
        }
    }
}

/// What the client needs to draw the shop and the map: every kind with its
/// price, limit and numbers, and every site with its HQ and entrances.
pub fn catalog_json(tier: u32) -> serde_json::Value {
    let kinds: Vec<serde_json::Value> = KINDS.iter().map(|k| {
        let c = k.combat();
        serde_json::json!({
            "id": k.as_str(), "name": k.label(), "blurb": k.blurb(), "price": k.price(),
            "soldier": k.is_soldier(), "blocks": k.blocks(), "cap": k.cap(tier),
            "hp": c.map(|c| c.hp), "range": c.map(|c| c.range),
            "dps": c.map(|c| (c.damage as f32 * TICKS_PER_SEC as f32 / (c.cooldown + 1) as f32).round()),
            "speed": c.map(|c| c.speed), "supply": c.map(|c| c.supply), "sight": c.map(|c| c.sight),
            "structureMult": c.map(|c| c.structure_mult),
        })
    }).collect();
    let sites: Vec<serde_json::Value> = SITES.iter().map(|s| serde_json::json!({
        "id": s, "name": s.label(), "hq": s.hq(), "entrances": s.entrances(),
    })).collect();
    serde_json::json!({
        "grid": GRID, "kinds": kinds, "sites": sites,
        "guardCap": guard_cap(tier), "waveSupply": wave_supply(tier), "hqHp": hq_hp(tier),
        "guardHpMult": GUARD_HP_MULT, "mineDamage": MINE_DAMAGE, "mineRadius": MINE_RADIUS,
        "waveGapSecs": WAVE_GAP / TICKS_PER_SEC, "maxSecs": MAX_TICKS / TICKS_PER_SEC,
        "lootShare": LOOT_SHARE, "lootCap": LOOT_CAP, "minTargetCash": MIN_TARGET_CASH, "shieldSecs": SHIELD_SECS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(kind: Kind, x: u8, y: u8) -> Piece { Piece { kind, x, y } }
    fn squad(pairs: &[(Kind, u32)]) -> Counts {
        let mut c = Counts::default();
        for &(k, n) in pairs { c.set(k, n); }
        c
    }
    fn plan(waves: [&[(Kind, u32)]; 3], entrances: [u8; 3]) -> Plan {
        Plan { waves: waves.map(squad), entrances }
    }
    fn base(site: Site, pieces: Vec<Piece>, tier: u32) -> Snapshot {
        let layout = Layout { site, pieces };
        layout.validate(tier).expect("test base is valid");
        Snapshot { layout, tier }
    }

    #[test]
    fn every_site_puts_the_hq_on_a_side_or_corner_with_entrances_on_the_far_edges() {
        for site in SITES {
            let (hx, hy) = xy_of(site.hq());
            let edge = |v: usize| v == 1 || v == GRID - 2;
            assert!(edge(hx) || edge(hy), "{site:?} HQ hugs an edge");
            let entrances = site.entrances();
            for (i, &e) in entrances.iter().enumerate() {
                let (x, y) = xy_of(e);
                assert!(x == 0 || y == 0 || x == GRID - 1 || y == GRID - 1, "{site:?} entrance {i} is on the map edge");
                assert!(x.abs_diff(hx) + y.abs_diff(hy) >= GRID - 2, "{site:?} entrance {i} is far from the HQ");
                assert!(entrances.iter().filter(|&&o| o == e).count() == 1, "entrances are distinct");
            }
            assert!(Layout { site, pieces: Vec::new() }.validate(1).is_ok());
        }
        let corners = SITES.iter().filter(|s| { let (x, y) = xy_of(s.hq()); (x == 1 || x == GRID - 2) && (y == 1 || y == GRID - 2) }).count();
        assert_eq!(corners, 4);
    }

    #[test]
    fn a_layout_must_leave_every_entrance_a_way_in() {
        // Wall the HQ in completely.
        let ring = vec![piece(Kind::Wall, 0, 7), piece(Kind::Wall, 1, 7), piece(Kind::Wall, 2, 7), piece(Kind::Wall, 2, 8),
            piece(Kind::Wall, 2, 9), piece(Kind::Wall, 1, 9), piece(Kind::Wall, 0, 9)];
        let sealed = Layout { site: Site::West, pieces: ring.clone() };
        assert!(sealed.validate(1).unwrap_err().contains("walled off"));
        // One gap is enough.
        let open = Layout { site: Site::West, pieces: ring[1..].to_vec() };
        assert!(open.validate(1).is_ok());
        // Cutting off a single entrance is refused too, and names it.
        let (ex, ey) = xy_of(Site::West.entrances()[1]);
        let pocket = Layout { site: Site::West, pieces: vec![
            piece(Kind::Wall, ex as u8 - 1, ey as u8), piece(Kind::Wall, ex as u8, ey as u8 - 1), piece(Kind::Wall, ex as u8, ey as u8 + 1),
        ] };
        assert!(pocket.validate(1).unwrap_err().contains("Entrance B"));
        // Turrets block the way just like walls.
        let turrets = Layout { site: Site::West, pieces: vec![
            piece(Kind::Turret, ex as u8 - 1, ey as u8), piece(Kind::Wall, ex as u8, ey as u8 - 1), piece(Kind::Wall, ex as u8, ey as u8 + 1),
        ] };
        assert!(turrets.validate(1).is_err());
    }

    #[test]
    fn layouts_follow_the_tier_limits_and_the_map() {
        let v = |pieces: Vec<Piece>, tier| Layout { site: Site::West, pieces }.validate(tier);
        assert!(v(vec![piece(Kind::Sniper, 5, 5)], 1).unwrap_err().contains("higher Homefront tier"));
        assert!(v(vec![piece(Kind::Sniper, 5, 5)], 2).is_ok());
        let turrets: Vec<Piece> = (0..3).map(|i| piece(Kind::Turret, 5 + 2 * i, 3)).collect();
        assert!(v(turrets.clone(), 1).unwrap_err().contains("holds 2"));
        assert!(v(turrets, 2).is_ok());
        let guards: Vec<Piece> = (0..3).map(|i| piece(Kind::Rifleman, 5 + i, 3)).collect();
        assert!(v(guards, 1).unwrap_err().contains("garrisons 2"));
        assert!(v(vec![piece(Kind::Wall, 5, 5), piece(Kind::Mine, 5, 5)], 1).unwrap_err().contains("share a square"));
        assert!(v(vec![piece(Kind::Wall, 17, 0)], 1).unwrap_err().contains("off the map"));
        let (hx, hy) = xy_of(Site::West.hq());
        assert!(v(vec![piece(Kind::Wall, hx as u8, hy as u8)], 1).is_err());
        let (ex, ey) = xy_of(Site::West.entrances()[0]);
        assert!(v(vec![piece(Kind::Mine, ex as u8, ey as u8)], 1).unwrap_err().contains("Entrances"));
        for tier in 1..=4 { assert!(Kind::Wall.cap(tier) < (CELLS / 3) as u32); }
    }

    #[test]
    fn waves_are_soldiers_within_the_supply() {
        let ok = [squad(&[(Kind::Rifleman, 2), (Kind::Heavy, 1)]), Counts::default(), squad(&[(Kind::Scout, 4)])];
        assert!(validate_waves(&ok, 1).is_ok());
        assert!(validate_waves(&[squad(&[(Kind::Rifleman, 7)]), Counts::default(), Counts::default()], 1).unwrap_err().contains("Wave 1"));
        assert!(validate_waves(&[squad(&[(Kind::Rifleman, 7)]), Counts::default(), Counts::default()], 2).is_ok());
        assert!((2..=4).all(|t| wave_supply(t) > wave_supply(t - 1)), "higher tiers field bigger waves");
        assert!(validate_waves(&[Counts::default(), squad(&[(Kind::Turret, 1)]), Counts::default()], 4).is_err());
        assert!(validate_entrances(&[0, 1, 2]).is_ok() && validate_entrances(&[0, 3, 0]).is_err());
    }

    #[test]
    fn counts_round_trip_and_price_only_what_is_missing() {
        let c = squad(&[(Kind::Wall, 3), (Kind::Heavy, 2)]);
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, r#"{"wall":3,"heavy":2}"#);
        assert_eq!(serde_json::from_str::<Counts>(&json).unwrap(), c);
        assert_eq!(serde_json::from_str::<Counts>(r#"{"tank":9}"#).unwrap(), Counts::default());
        let owned = squad(&[(Kind::Wall, 1), (Kind::Heavy, 5)]);
        assert_eq!(c.cost_beyond(&owned), 2 * Kind::Wall.price());
        assert_eq!(c.supply(), 4, "only soldiers take supply");
    }

    #[test]
    fn an_undefended_base_falls_and_a_raid_is_the_same_every_time() {
        let b = base(Site::West, Vec::new(), 1);
        let p = plan([&[(Kind::Rifleman, 4)], &[(Kind::Rifleman, 4)], &[(Kind::Rifleman, 4)]], [0, 1, 2]);
        let battle = simulate(&b, &p);
        assert!(battle.outcome.destroyed, "nothing stops twelve riflemen");
        assert_eq!(battle.outcome.hq_damage, 1.0);
        assert_eq!(battle.outcome.lost.total(), 0);
        assert_eq!(battle.outcome.sent.total(), 12);
        let again = simulate(&b, &p);
        assert_eq!(serde_json::to_string(&battle.replay(true)).unwrap(), serde_json::to_string(&again.replay(true)).unwrap());
    }

    #[test]
    fn soldiers_walk_around_walls_and_never_through_them() {
        // A wall across the map with one gap at the bottom.
        let wall: Vec<Piece> = (0..GRID as u8 - 1).map(|y| piece(Kind::Wall, 8, y)).collect();
        let b = base(Site::West, wall.clone(), 4);
        let battle = simulate(&b, &plan([&[(Kind::Scout, 1)], &[], &[]], [1, 0, 0]));
        let walled: Vec<usize> = wall.iter().map(|p| p.cell()).collect();
        let path = &battle.troops[0].points;
        assert!(path.iter().all(|&(_, c)| !walled.contains(&(c as usize))), "never stands on a wall");
        assert!(path.iter().any(|&(_, c)| c as usize == cell_of(8, GRID - 1)), "uses the gap");
        for pair in path.windows(2) {
            let (a, b) = (xy_of(pair[0].1 as usize), xy_of(pair[1].1 as usize));
            assert_eq!(a.0.abs_diff(b.0) + a.1.abs_diff(b.1), 1, "one square at a time");
            assert!(pair[1].0 >= pair[0].0);
        }
        assert!(battle.outcome.hq_damage > 0.0, "it reached the HQ");
    }

    #[test]
    fn defenses_kill_soldiers_and_dead_soldiers_are_the_ones_lost() {
        let b = base(Site::West, vec![piece(Kind::Turret, 3, 7), piece(Kind::Turret, 3, 9)], 1);
        let battle = simulate(&b, &plan([&[(Kind::Scout, 2)], &[], &[]], [1, 1, 1]));
        assert_eq!(battle.outcome.lost.get(Kind::Scout), 2, "two scouts can't take two turrets");
        assert!(!battle.outcome.destroyed);
        assert_eq!(battle.lost_by_wave()[0].get(Kind::Scout), 2);
        assert!(battle.outcome.ticks < MAX_TICKS, "the raid ends when the last soldier dies");
        // Soldiers still waiting to step through the entrance when the HQ falls stay home, unharmed.
        let open = base(Site::West, Vec::new(), 1);
        let rush = simulate(&open, &plan([&[(Kind::Grenadier, 4)], &[], &[(Kind::Rifleman, 40)]], [1, 1, 1]));
        assert!(rush.outcome.destroyed);
        assert!(rush.outcome.ticks < 2 * WAVE_GAP + 39 * SPAWN_GAP, "the HQ fell before the last soldier set out");
        let set_out = rush.replay(false).troops.len() as u32;
        assert!(set_out >= 4 && set_out < rush.outcome.sent.total(), "{set_out} of {} set out", rush.outcome.sent.total());
        assert_eq!(rush.outcome.lost.total(), 0);
    }

    #[test]
    fn a_destroyed_turret_opens_the_way_it_was_blocking() {
        // A corridor from entrance B runs straight at a turret plugging a wall, then
        // turns away to a gap at the top of the map: the long way round.
        let mut pieces: Vec<Piece> = (1..GRID as u8 - 1).filter(|&y| y != 8).map(|y| piece(Kind::Wall, 6, y)).collect();
        pieces.extend((8..GRID as u8).map(|x| piece(Kind::Wall, x, 7)));
        pieces.extend((7..GRID as u8).map(|x| piece(Kind::Wall, x, 9)));
        pieces.push(piece(Kind::Turret, 6, 8));
        let b = base(Site::West, pieces, 4);
        let battle = simulate(&b, &plan([&[(Kind::Grenadier, 3)], &[], &[]], [1, 1, 1]));
        let turret_fell = battle.defenses[0].destroyed.expect("grenadiers out-range and destroy the turret");
        let through = battle.troops.iter().any(|t| t.points.iter().any(|&(tick, c)| c as usize == cell_of(6, 8) && tick > turret_fell));
        assert!(through, "survivors cut through where the turret stood");
    }

    #[test]
    fn mines_hit_everyone_nearby_once() {
        let (ex, ey) = xy_of(Site::West.entrances()[1]);
        let b = base(Site::West, vec![piece(Kind::Mine, ex as u8 - 1, ey as u8)], 1);
        let battle = simulate(&b, &plan([&[(Kind::Scout, 2)], &[], &[]], [1, 1, 1]));
        assert_eq!(battle.blasts.len(), 1);
        assert!(battle.outcome.lost.get(Kind::Scout) >= 1, "a mine kills a scout outright");
        assert!(battle.mines[0].blown.is_some());
    }

    #[test]
    fn fog_hides_everything_the_soldiers_never_got_near() {
        // One turret by the route from entrance B, one tucked in a far corner behind walls.
        let near = piece(Kind::Rifleman, 10, 9);
        let far = [piece(Kind::Sniper, 2, 13), piece(Kind::Wall, 15, 1), piece(Kind::Mine, 13, 13)];
        let b = base(Site::West, vec![near, far[0], far[1], far[2]], 2);
        let battle = simulate(&b, &plan([&[(Kind::Heavy, 2)], &[], &[]], [1, 1, 1]));
        let full = battle.replay(false);
        let fogged = battle.replay(true);
        assert_eq!((full.defenses.len(), full.walls.len(), full.mines.len()), (2, 1, 1));
        assert!(fogged.fog && !full.fog);
        assert_eq!(fogged.defenses.len(), 1, "only the guard by the route was seen");
        assert_eq!(fogged.defenses[0].kind, Kind::Rifleman);
        assert!(fogged.walls.is_empty() && fogged.mines.is_empty());
        let json = serde_json::to_string(&fogged).unwrap();
        assert!(!json.contains("sniper"), "nothing about the hidden tower leaves the server");
        // The sniper still shot them: those shots have no source.
        assert!(full.shots.iter().any(|s| s.1 == DEFENSE_ID + 1));
        assert!(fogged.shots.iter().any(|s| s.1 == HIDDEN_ID) && fogged.shots.iter().all(|s| s.1 != DEFENSE_ID + 1));
        assert_eq!(full.shots.len(), fogged.shots.len());
        // Squares stay revealed, and only squares near a soldier's path are.
        let seen: Vec<usize> = fogged.reveals.iter().map(|r| r.1).collect();
        for t in &fogged.troops { for &(_, c) in &t.points { assert!(seen.contains(&(c as usize))); } }
        assert!(!seen.contains(&cell_of(2, 13)) && !seen.contains(&cell_of(15, 1)));
        assert!(seen.len() < CELLS / 2);
        // Scouts see twice as far as everyone else.
        let lone = |k| simulate(&base(Site::West, Vec::new(), 1), &plan([&[(k, 1)], &[], &[]], [1, 1, 1])).replay(true).reveals.len();
        assert!(lone(Kind::Scout) > lone(Kind::Rifleman));
    }

    #[test]
    fn loot_scales_with_hq_damage_and_is_capped() {
        assert_eq!(loot_pool(10_000), 2_000);
        assert_eq!(loot_pool(1_000_000), LOOT_CAP);
        assert_eq!(loot_for(10_000, 1.0, true), 2_000);
        assert_eq!(loot_for(10_000, 0.5, false), 500);
        assert_eq!(loot_for(10_000, 0.0, false), 0);
        assert_eq!(loot_for(0, 1.0, true), 0);
    }

    /// A maxed base against a maxed army of the same tier should be a contest:
    /// the best simple plan does real damage, and a careless one loses soldiers.
    #[test]
    fn same_tier_raids_are_contested() {
        for tier in 1..=4u32 {
            let mut pieces = Vec::new();
            // Turrets and towers in an arc around the HQ, a short wall in front, guards and mines on the approach.
            let spots = [(4, 6), (4, 10), (5, 8), (3, 4), (3, 12)];
            for &(x, y) in spots.iter().take(Kind::Turret.cap(tier) as usize) { pieces.push(piece(Kind::Turret, x, y)); }
            let towers = [(2, 6), (2, 10), (1, 5)];
            for &(x, y) in towers.iter().take(Kind::Sniper.cap(tier) as usize) { pieces.push(piece(Kind::Sniper, x, y)); }
            for y in 5..=11u8 { if y != 8 { pieces.push(piece(Kind::Wall, 7, y)); } }
            let posts = [(3, 7), (3, 9), (2, 7), (2, 9), (4, 8), (1, 7), (1, 9), (3, 8)];
            for &(x, y) in posts.iter().take(guard_cap(tier) as usize) { pieces.push(piece(Kind::Rifleman, x, y)); }
            let mines = [(8, 8), (9, 8), (7, 4), (7, 12), (10, 8), (6, 8), (8, 3), (8, 13)];
            for &(x, y) in mines.iter().take(Kind::Mine.cap(tier) as usize) { pieces.push(piece(Kind::Mine, x, y)); }
            let b = base(Site::West, pieces, tier);
            let room = wave_supply(tier);
            let each = (room / 6).max(1);
            let balanced = squad(&[(Kind::Heavy, each), (Kind::Grenadier, each), (Kind::Rifleman, room - 4 * each)]);
            let p = Plan { waves: [balanced; 3], entrances: [1, 1, 1] };
            validate_waves(&p.waves, tier).unwrap();
            let o = simulate(&b, &p).outcome;
            println!("tier {tier}: hq damage {:.2}, destroyed {}, lost {}/{} in {}s", o.hq_damage, o.destroyed, o.lost.total(), o.sent.total(), o.ticks / TICKS_PER_SEC);
            assert!(o.lost.total() > 0, "tier {tier}: a full base costs the attacker soldiers");
            assert!(o.hq_damage > 0.25, "tier {tier}: a massed, mixed army still hurts a full base");
            let split = simulate(&b, &Plan { waves: [balanced; 3], entrances: [0, 1, 2] }).outcome;
            println!("tier {tier} split three ways: hq damage {:.2}, lost {}/{}", split.hq_damage, split.lost.total(), split.sent.total());
            let scouts = Plan { waves: [squad(&[(Kind::Scout, room)]); 3], entrances: [0, 1, 2] };
            let rush = simulate(&b, &scouts).outcome;
            println!("tier {tier} scout rush: hq damage {:.2}, lost {}/{}", rush.hq_damage, rush.lost.total(), rush.sent.total());
            assert!(!rush.destroyed, "tier {tier}: a scout rush doesn't beat a full base");
        }
    }
}
