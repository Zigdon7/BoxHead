// Base defense and base raids: the shapes the server sends and the pure maths
// the Base screen needs (routes, layout checks, costs, replay playback, fog).
// The rules themselves live on the server (backend/src/siege.rs); the checks
// here only give instant feedback, and the server checks everything again.

export type Kind = 'wall' | 'turret' | 'sniper' | 'mine' | 'rifleman' | 'scout' | 'heavy' | 'grenadier';
export type SiteId = 'north' | 'east' | 'south' | 'west' | 'northEast' | 'southEast' | 'southWest' | 'northWest';
export type Counts = Partial<Record<Kind, number>>;

export interface Piece { kind: Kind; x: number; y: number }
export interface Layout { site: SiteId; pieces: Piece[] }

export interface KindInfo {
  id: Kind; name: string; blurb: string; price: number; soldier: boolean; blocks: boolean; cap: number;
  hp: number | null; range: number | null; dps: number | null; speed: number | null; supply: number | null;
  sight: number | null; structureMult: number | null; infantryMult?: number | null;
}
export interface SiteInfo { id: SiteId; name: string; hq: number; entrances: number[] }
export interface Rules {
  grid: number; kinds: KindInfo[]; sites: SiteInfo[];
  guardCap: number; waveSupply: number; hqHp: number; guardHpMult: number; mineDamage: number; mineRadius: number;
  waveGapSecs: number; maxSecs: number; lootShare: number; lootCap: number; minTargetCash: number; shieldSecs: number;
  lootBurnShare?: number; defenderSalvageShare?: number; contractShare?: number; contractCap?: number;
  pairCooldownSecs?: number; maxTierGap?: number; scoutFees?: number[]; sellRefundRate?: number;
}

export interface Target { name: string; tier: number; site: SiteId; hq: number; entrances: number[]; lootPool: number; hqHp: number }
export interface RaidLog {
  id: string; at: number; opponent: string; hqDamage: number; destroyed: boolean; loot: number;
  payout?: number; contractBonus?: number; salvage?: number;
  sent: Counts; lost: Counts; replayable: boolean;
}
export interface BaseState {
  name: string; tier: number; raidable: boolean; cash: number;
  layout: Layout; owned: Counts; waves: Counts[]; shieldUntil: number; atRisk: number;
  workshopAtRisk?: number; scoutFee?: number; unreadDefenses?: number;
  refillWaves?: Counts[]; refillCost?: number;
  target: Target | null; attacks: RaidLog[]; defenses: RaidLog[];
  rules: Rules; now: number; raidBlocker: string | null;
}

export interface Outcome { hqDamage: number; destroyed: boolean; ticks: number; sent: Counts; lost: Counts }
export interface ReplayDefense { id: number; kind: Kind; cell: number; hp: number; seen: number | null; destroyed: number | null }
export interface ReplayTroop { id: number; kind: Kind; wave: number; hp: number; points: [number, number][]; died: number | null }
export interface Replay {
  version: number; grid: number; ticksPerSec: number; fog: boolean; site: SiteId;
  hq: number; hqHp: number; entrances: number[]; waveEntrances: number[];
  walls: [number, number | null][];
  defenses: ReplayDefense[];
  mines: { cell: number; blown: number | null; disarmed?: number | null }[];
  troops: ReplayTroop[];
  /** [tick, attacker id, target id, damage]; -1 is a gun the attacker never saw. */
  shots: [number, number, number, number][];
  blasts: { tick: number; cell: number; hits: [number, number][] }[];
  reveals: [number, number][];
  outcome: Outcome;
}

export const WAVES = 3;
export const ENTRANCE_NAMES = ['A', 'B', 'C'] as const;
export const SOLDIERS: Kind[] = ['rifleman', 'scout', 'heavy', 'grenadier'];
export const HQ_ID = 2000;
export const HIDDEN_ID = -1;

export const kindInfo = (rules: Rules, kind: Kind): KindInfo => rules.kinds.find(k => k.id === kind)!;
export const siteInfo = (rules: Rules, site: SiteId): SiteInfo => rules.sites.find(s => s.id === site)!;
export const cellOf = (grid: number, x: number, y: number) => y * grid + x;
export const xyOf = (grid: number, cell: number): [number, number] => [cell % grid, Math.floor(cell / grid)];

function neighbors(grid: number, cell: number): number[] {
  const [x, y] = xyOf(grid, cell);
  const out: number[] = [];
  if (y > 0) out.push(cell - grid);
  if (x < grid - 1) out.push(cell + 1);
  if (y < grid - 1) out.push(cell + grid);
  if (x > 0) out.push(cell - 1);
  return out;
}

/** Steps from each walkable cell to the nearest cell touching the HQ (Infinity = no way in). */
export function distances(grid: number, blocked: boolean[], hq: number): number[] {
  const dist = new Array<number>(grid * grid).fill(Infinity);
  const queue: number[] = [];
  for (const n of neighbors(grid, hq)) if (!blocked[n]) { dist[n] = 0; queue.push(n); }
  for (let i = 0; i < queue.length; i++) {
    for (const n of neighbors(grid, queue[i])) {
      if (!blocked[n] && dist[n] === Infinity) { dist[n] = dist[queue[i]] + 1; queue.push(n); }
    }
  }
  return dist;
}

function blockedCells(rules: Rules, layout: Layout): boolean[] {
  const blocked = new Array<boolean>(rules.grid * rules.grid).fill(false);
  blocked[siteInfo(rules, layout.site).hq] = true;
  for (const p of layout.pieces) if (kindInfo(rules, p.kind).blocks) blocked[cellOf(rules.grid, p.x, p.y)] = true;
  return blocked;
}

/** The way soldiers would walk from each entrance to the HQ (null = walled off). */
export function routes(rules: Rules, layout: Layout): (number[] | null)[] {
  const site = siteInfo(rules, layout.site);
  const dist = distances(rules.grid, blockedCells(rules, layout), site.hq);
  return site.entrances.map(start => {
    if (dist[start] === Infinity) return null;
    const path = [start];
    let cell = start;
    while (dist[cell] > 0) {
      cell = neighbors(rules.grid, cell).find(n => dist[n] < dist[cell])!;
      path.push(cell);
    }
    return path;
  });
}

export function placed(layout: Layout): Counts {
  const c: Counts = {};
  for (const p of layout.pieces) c[p.kind] = (c[p.kind] ?? 0) + 1;
  return c;
}

export const guardsPlaced = (layout: Layout) => layout.pieces.filter(p => SOLDIERS.includes(p.kind)).length;

/** How many more of `kind` this base may place (garrison soldiers share one limit). */
export function roomFor(rules: Rules, layout: Layout, kind: Kind): number {
  const info = kindInfo(rules, kind);
  if (info.soldier) return rules.guardCap - guardsPlaced(layout);
  return info.cap - (placed(layout)[kind] ?? 0);
}

/** Why a layout can't be saved, or null if it follows the rules. */
export function layoutProblem(rules: Rules, layout: Layout): string | null {
  const site = siteInfo(rules, layout.site);
  const used = new Set<number>();
  for (const p of layout.pieces) {
    const cell = cellOf(rules.grid, p.x, p.y);
    if (p.x < 0 || p.y < 0 || p.x >= rules.grid || p.y >= rules.grid) return 'A piece is off the map';
    if (cell === site.hq || site.entrances.includes(cell)) return 'The HQ and the entrances must stay clear';
    if (used.has(cell)) return 'Two pieces share a square';
    used.add(cell);
  }
  const have = placed(layout);
  for (const k of rules.kinds) {
    if (!k.soldier && (have[k.id] ?? 0) > k.cap) return k.cap === 0 ? `${k.name}s unlock at a higher Homefront tier` : `Your base holds ${k.cap} ${k.name.toLowerCase()}s`;
  }
  if (guardsPlaced(layout) > rules.guardCap) return `Your base garrisons ${rules.guardCap} soldiers`;
  const walled = routes(rules, layout).findIndex(r => r === null);
  if (walled >= 0) return `Entrance ${ENTRANCE_NAMES[walled]} is walled off. Every entrance needs a way to the HQ.`;
  return null;
}

export const supplyOf = (rules: Rules, wave: Counts) =>
  SOLDIERS.reduce((sum, k) => sum + (wave[k] ?? 0) * (kindInfo(rules, k).supply ?? 0), 0);

export const totalOf = (c: Counts) => Object.values(c).reduce<number>((a, b) => a + (b ?? 0), 0);

/** Everything a layout and three waves need to have owned. */
export function needed(layout: Layout, waves: Counts[]): Counts {
  const need = placed(layout);
  for (const w of waves) for (const k of SOLDIERS) if (w[k]) need[k] = (need[k] ?? 0) + w[k]!;
  return need;
}

/** What saving would cost: only what isn't owned yet is bought. */
export function saveCost(rules: Rules, layout: Layout, waves: Counts[], owned: Counts): { total: number; buys: { kind: Kind; count: number; cost: number }[] } {
  const need = needed(layout, waves);
  const buys = rules.kinds.map(k => {
    const count = Math.max(0, (need[k.id] ?? 0) - (owned[k.id] ?? 0));
    return { kind: k.id, count, cost: count * k.price };
  }).filter(b => b.count > 0);
  return { total: buys.reduce((s, b) => s + b.cost, 0), buys };
}

/** Soldiers owned but neither garrisoned nor in a wave. */
export function reserve(layout: Layout, waves: Counts[], owned: Counts): Counts {
  const need = needed(layout, waves);
  const out: Counts = {};
  for (const k of SOLDIERS) { const spare = (owned[k] ?? 0) - (need[k] ?? 0); if (spare > 0) out[k] = spare; }
  return out;
}

/** Everything owned (equipment or soldiers) not currently placed or assigned. */
export function spareOf(rules: Rules, layout: Layout, waves: Counts[], owned: Counts): { kind: Kind; count: number; refund: number }[] {
  const need = needed(layout, waves);
  const rate = rules.sellRefundRate ?? 0.5;
  return rules.kinds.map(k => {
    const count = Math.max(0, (owned[k.id] ?? 0) - (need[k.id] ?? 0));
    return { kind: k.id, count, refund: Math.floor(count * k.price * rate) };
  }).filter(s => s.count > 0);
}

/** A quick, valid starter defense layout oriented around `site`'s HQ for practice/onboarding. */
export function starterBlueprint(rules: Rules, site: SiteId): Layout {
  const g = rules.grid;
  const info = siteInfo(rules, site);
  const [hx, hy] = xyOf(g, info.hq);
  const mid = Math.floor(g / 2);
  const dx = hx < mid ? 1 : hx > mid ? -1 : 0;
  const dy = hy < mid ? 1 : hy > mid ? -1 : 0;
  const keepOut = new Set([info.hq, ...info.entrances]);
  const used = new Set<number>();
  const pieces: Piece[] = [];
  const put = (kind: Kind, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= g || y >= g) return;
    const cell = cellOf(g, x, y);
    if (keepOut.has(cell) || used.has(cell)) return;
    const candidate: Layout = { site, pieces: [...pieces, { kind, x, y }] };
    if (layoutProblem(rules, candidate)) return;
    used.add(cell);
    pieces.push({ kind, x, y });
  };
  // Two turrets flanking forward of HQ, a guard beside HQ, a mine on the main approach, and a funnel wall.
  if (dx !== 0 && dy === 0) {
    put('turret', hx + dx * 3, hy - 2);
    put('turret', hx + dx * 3, hy + 2);
    put('rifleman', hx + dx * 2, hy - 1);
    put('mine', hx + dx * 5, hy);
    for (const oy of [-4, -3, -2, 2, 3, 4]) put('wall', hx + dx * 5, hy + oy);
  } else if (dy !== 0 && dx === 0) {
    put('turret', hx - 2, hy + dy * 3);
    put('turret', hx + 2, hy + dy * 3);
    put('rifleman', hx - 1, hy + dy * 2);
    put('mine', hx, hy + dy * 5);
    for (const ox of [-4, -3, -2, 2, 3, 4]) put('wall', hx + ox, hy + dy * 5);
  } else {
    put('turret', hx + dx * 3, hy + dy * 1);
    put('turret', hx + dx * 1, hy + dy * 3);
    put('rifleman', hx + dx * 2, hy + dy * 2);
    put('mine', hx + dx * 4, hy + dy * 4);
    for (let k = 0; k <= 3; k++) {
      put('wall', hx + dx * 5, hy + dy * k);
      put('wall', hx + dx * k, hy + dy * 5);
    }
  }
  return { site, pieces };
}

/** A balanced 3-wave sample army fitting `rules.waveSupply`, for instant practice testing. */
export function sampleWaves(rules: Rules): Counts[] {
  const room = rules.waveSupply;
  const build = (plan: [Kind, number][]): Counts => {
    const w: Counts = {};
    let left = room;
    for (const [k, want] of plan) {
      const sup = kindInfo(rules, k).supply ?? 1;
      const take = Math.min(want, Math.floor(left / sup));
      if (take > 0) { w[k] = (w[k] ?? 0) + take; left -= take * sup; }
    }
    if (left > 0) w.rifleman = (w.rifleman ?? 0) + left;
    return w;
  };
  return [
    build([['heavy', 1], ['scout', 1], ['rifleman', 6]]),
    build([['heavy', 1], ['grenadier', 1], ['rifleman', 6]]),
    build([['grenadier', 2], ['scout', 1], ['rifleman', 6]]),
  ];
}

export const sameLayout = (a: Layout, b: Layout) => {
  const key = (l: Layout) => l.site + '|' + l.pieces.map(p => `${p.kind}:${p.x},${p.y}`).sort().join(';');
  return key(a) === key(b);
};
export const sameWaves = (a: Counts[], b: Counts[]) => {
  const key = (w: Counts[]) => [0, 1, 2].map(i => SOLDIERS.map(k => w[i]?.[k] ?? 0).join(',')).join('|');
  return key(a) === key(b);
};

/** Move a base to another site, dropping pieces that would sit on its HQ or entrances. */
export function moveSite(rules: Rules, layout: Layout, site: SiteId): Layout {
  const info = siteInfo(rules, site);
  const keepOut = new Set([info.hq, ...info.entrances]);
  return { site, pieces: layout.pieces.filter(p => !keepOut.has(cellOf(rules.grid, p.x, p.y))) };
}

// ---------- Replay playback ----------

/** Where a soldier is at `tick` (in cells, cell centres at +0.5), or null before it sets out. */
export function troopAt(grid: number, troop: ReplayTroop, tick: number): { x: number; y: number } | null {
  const pts = troop.points;
  if (pts.length === 0 || tick < pts[0][0]) return null;
  const center = (cell: number) => { const [x, y] = xyOf(grid, cell); return { x: x + 0.5, y: y + 0.5 }; };
  // Dead soldiers stay where they fell.
  const t = troop.died !== null ? Math.min(tick, troop.died) : tick;
  let i = pts.length - 1;
  while (i > 0 && pts[i][0] > t) i--;
  const here = center(pts[i][1]);
  const next = pts[i + 1];
  if (!next) return here;
  // Between two squares: the soldier left as soon as it arrived, so the walk spans both times.
  const span = next[0] - pts[i][0];
  const f = span > 0 ? Math.min(1, (t - pts[i][0]) / span) : 1;
  const there = center(next[1]);
  return { x: here.x + (there.x - here.x) * f, y: here.y + (there.y - here.y) * f };
}

/** Health left at `tick` for everything that took damage, by id. */
export function damageAt(replay: Replay, tick: number): Map<number, number> {
  const taken = new Map<number, number>();
  for (const [t, , to, dmg] of replay.shots) { if (t > tick) break; taken.set(to, (taken.get(to) ?? 0) + dmg); }
  for (const b of replay.blasts) { if (b.tick > tick) break; for (const [id, dmg] of b.hits) taken.set(id, (taken.get(id) ?? 0) + dmg); }
  return taken;
}

/** Which cells are out of the fog at `tick`. */
export function revealedAt(replay: Replay, tick: number): boolean[] {
  const seen = new Array<boolean>(replay.grid * replay.grid).fill(false);
  for (const [t, cell] of replay.reveals) { if (t > tick) break; seen[cell] = true; }
  return seen;
}

/** A raid's result in a few words. */
export function outcomeLine(o: Pick<Outcome, 'hqDamage' | 'destroyed' | 'sent' | 'lost'>): string {
  const pct = Math.round(o.hqDamage * 100);
  const sent = totalOf(o.sent), lost = totalOf(o.lost);
  return `${o.destroyed ? 'HQ destroyed' : pct === 0 ? 'HQ untouched' : `HQ ${pct}% damaged`} · ${lost} of ${sent} soldiers lost`;
}

/** "3h 20m", "12m" or "under a minute" for a number of seconds. */
export function shortDuration(secs: number): string {
  if (secs < 60) return 'under a minute';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "just now", "5m ago", "3h ago" or "2d ago". */
export function ago(now: number, then: number): string {
  const s = Math.max(0, now - then);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
