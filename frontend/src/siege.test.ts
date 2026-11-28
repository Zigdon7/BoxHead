import { describe, expect, test } from 'vitest';
import {
  Counts, Kind, KindInfo, Layout, Replay, Rules, SiteInfo,
  ago, cellOf, damageAt, distances, layoutProblem, moveSite, needed, outcomeLine, placed, reserve, revealedAt, roomFor, routes,
  sameLayout, sameWaves, sampleWaves, saveCost, shortDuration, spareOf, starterBlueprint, supplyOf, troopAt, HQ_ID,
} from './siege';

const GRID = 17;
const kind = (id: Kind, price: number, cap: number, extra: Partial<KindInfo> = {}): KindInfo => ({
  id, name: id[0].toUpperCase() + id.slice(1), blurb: '', price, cap, soldier: false, blocks: false,
  hp: null, range: null, dps: null, speed: null, supply: null, sight: null, structureMult: null, ...extra,
});
const west: SiteInfo = { id: 'west', name: 'West side', hq: cellOf(GRID, 1, 8), entrances: [cellOf(GRID, 12, 0), cellOf(GRID, 16, 8), cellOf(GRID, 12, 16)] };
const corner: SiteInfo = { id: 'northWest', name: 'North-west corner', hq: cellOf(GRID, 1, 1), entrances: [cellOf(GRID, 16, 4), cellOf(GRID, 16, 16), cellOf(GRID, 4, 16)] };
const rules: Rules = {
  grid: GRID,
  kinds: [
    kind('wall', 25, 32, { blocks: true }), kind('turret', 450, 2, { blocks: true, range: 3.5 }), kind('sniper', 800, 0, { blocks: true }), kind('mine', 140, 2),
    kind('rifleman', 60, 2, { soldier: true, supply: 1 }), kind('scout', 45, 2, { soldier: true, supply: 1 }),
    kind('heavy', 150, 2, { soldier: true, supply: 2 }), kind('grenadier', 170, 2, { soldier: true, supply: 2 }),
  ],
  sites: [west, corner],
  guardCap: 2, waveSupply: 6, hqHp: 2000, guardHpMult: 1.5, mineDamage: 130, mineRadius: 1.5,
  waveGapSecs: 8, maxSecs: 150, lootShare: 0.2, lootCap: 15000, minTargetCash: 500, shieldSecs: 28800,
};
const layout = (pieces: [Kind, number, number][], site: Layout['site'] = 'west'): Layout => ({ site, pieces: pieces.map(([k, x, y]) => ({ kind: k, x, y })) });

describe('routes', () => {
  test('an open map walks every entrance straight to the HQ', () => {
    const paths = routes(rules, layout([]));
    expect(paths.every(p => p !== null)).toBe(true);
    // Entrance B faces the HQ along the middle row: 16 -> 2 is 14 steps, 15 squares.
    expect(paths[1]).toHaveLength(15);
    expect(paths[1]![0]).toBe(west.entrances[1]);
  });

  test('walls bend the route and each step moves one square', () => {
    const wall: [Kind, number, number][] = Array.from({ length: 16 }, (_, y) => ['wall', 8, y]);
    const path = routes(rules, layout(wall))[1]!;
    expect(path).toContain(cellOf(GRID, 8, 16));
    for (let i = 1; i < path.length; i++) {
      const d = Math.abs(path[i] % GRID - path[i - 1] % GRID) + Math.abs(Math.floor(path[i] / GRID) - Math.floor(path[i - 1] / GRID));
      expect(d).toBe(1);
    }
    expect(path.length).toBeGreaterThan(15);
  });

  test('a walled-off entrance has no route and names itself', () => {
    const pocket = layout([['wall', 15, 8], ['wall', 16, 7], ['wall', 16, 9]]);
    expect(routes(rules, pocket)[1]).toBeNull();
    expect(layoutProblem(rules, pocket)).toMatch(/Entrance B is walled off/);
    // Turrets block too; mines and garrison soldiers don't.
    expect(layoutProblem(rules, layout([['turret', 15, 8], ['wall', 16, 7], ['wall', 16, 9]]))).toMatch(/Entrance B/);
    expect(layoutProblem(rules, layout([['mine', 15, 8], ['rifleman', 16, 7], ['scout', 16, 9]]))).toBeNull();
  });

  test('distances count steps to the squares touching the HQ', () => {
    const blocked = new Array<boolean>(GRID * GRID).fill(false);
    blocked[west.hq] = true;
    const d = distances(GRID, blocked, west.hq);
    expect(d[cellOf(GRID, 2, 8)]).toBe(0);
    expect(d[cellOf(GRID, 5, 8)]).toBe(3);
    expect(d[west.hq]).toBe(Infinity);
  });
});

describe('layout rules', () => {
  test('limits, shared squares and keep-clear squares are reported', () => {
    expect(layoutProblem(rules, layout([]))).toBeNull();
    expect(layoutProblem(rules, layout([['turret', 4, 4], ['turret', 6, 4], ['turret', 8, 4]]))).toMatch(/holds 2 turrets/);
    expect(layoutProblem(rules, layout([['sniper', 4, 4]]))).toMatch(/higher Homefront tier/);
    expect(layoutProblem(rules, layout([['rifleman', 4, 4], ['scout', 5, 4], ['heavy', 6, 4]]))).toMatch(/garrisons 2/);
    expect(layoutProblem(rules, layout([['wall', 4, 4], ['mine', 4, 4]]))).toMatch(/share a square/);
    expect(layoutProblem(rules, layout([['wall', 1, 8]]))).toMatch(/stay clear/);
    expect(layoutProblem(rules, layout([['mine', 16, 8]]))).toMatch(/stay clear/);
  });

  test('room left counts garrison soldiers together', () => {
    const l = layout([['turret', 4, 4], ['rifleman', 5, 5]]);
    expect(roomFor(rules, l, 'turret')).toBe(1);
    expect(roomFor(rules, l, 'heavy')).toBe(1);
    expect(roomFor(rules, l, 'sniper')).toBe(0);
    expect(placed(l)).toEqual({ turret: 1, rifleman: 1 });
  });

  test('moving the HQ drops pieces that would sit on the new HQ or entrances', () => {
    const l = layout([['wall', 1, 1], ['wall', 16, 4], ['wall', 5, 5]]);
    const moved = moveSite(rules, l, 'northWest');
    expect(moved.site).toBe('northWest');
    expect(moved.pieces).toEqual([{ kind: 'wall', x: 5, y: 5 }]);
  });

  test('layouts and waves compare by content, not order', () => {
    expect(sameLayout(layout([['wall', 1, 2], ['mine', 3, 4]]), layout([['mine', 3, 4], ['wall', 1, 2]]))).toBe(true);
    expect(sameLayout(layout([['wall', 1, 2]]), layout([['wall', 1, 2]], 'northWest'))).toBe(false);
    expect(sameWaves([{ rifleman: 2 }, {}, {}], [{ rifleman: 2, scout: 0 }, {}, {}])).toBe(true);
    expect(sameWaves([{ rifleman: 2 }, {}, {}], [{}, { rifleman: 2 }, {}])).toBe(false);
  });
});

describe('buying', () => {
  const waves: Counts[] = [{ rifleman: 3, heavy: 1 }, { rifleman: 1 }, {}];
  const l = layout([['wall', 4, 4], ['wall', 4, 5], ['turret', 6, 6], ['rifleman', 3, 8]]);

  test('saving only buys what is not owned yet', () => {
    expect(needed(l, waves)).toEqual({ wall: 2, turret: 1, rifleman: 5, heavy: 1 });
    expect(saveCost(rules, l, waves, {}).total).toBe(2 * 25 + 450 + 5 * 60 + 150);
    const cost = saveCost(rules, l, waves, { wall: 10, turret: 1, rifleman: 2 });
    expect(cost.buys).toEqual([{ kind: 'rifleman', count: 3, cost: 180 }, { kind: 'heavy', count: 1, cost: 150 }]);
    expect(saveCost(rules, l, waves, needed(l, waves)).total).toBe(0);
  });

  test('supply, reserves, spares and starter helpers', () => {
    expect(supplyOf(rules, waves[0])).toBe(5);
    expect(supplyOf(rules, {})).toBe(0);
    expect(reserve(l, waves, { rifleman: 7, scout: 2, wall: 99 })).toEqual({ rifleman: 2, scout: 2 });
    const spares = spareOf(rules, l, waves, { wall: 6, rifleman: 7 });
    expect(spares).toEqual([
      { kind: 'wall', count: 4, refund: 50 },
      { kind: 'rifleman', count: 2, refund: 60 },
    ]);
    for (const s of rules.sites) {
      const bp = starterBlueprint(rules, s.id);
      expect(bp.pieces.length).toBeGreaterThan(0);
      expect(layoutProblem(rules, bp)).toBeNull();
      const budget = starterBlueprint(rules, s.id, true);
      expect(budget.pieces.length).toBeGreaterThan(0);
      expect(layoutProblem(rules, budget)).toBeNull();
      expect(saveCost(rules, budget, [{}, {}, {}], {}).total).toBeLessThanOrEqual(400);
    }
    const sample = sampleWaves(rules);
    expect(sample).toHaveLength(3);
    for (const w of sample) {
      expect(supplyOf(rules, w)).toBeGreaterThan(0);
      expect(supplyOf(rules, w)).toBeLessThanOrEqual(rules.waveSupply);
    }
  });
});

describe('replay playback', () => {
  const replay: Replay = {
    version: 1, grid: GRID, ticksPerSec: 10, fog: true, site: 'west', hq: west.hq, hqHp: 2000,
    entrances: west.entrances, waveEntrances: [1, 1, 1], walls: [], mines: [],
    defenses: [{ id: 1000, kind: 'turret', cell: cellOf(GRID, 10, 6), hp: 300, seen: 12, destroyed: null }],
    troops: [{ id: 0, kind: 'rifleman', wave: 0, hp: 120, points: [[0, cellOf(GRID, 16, 8)], [10, cellOf(GRID, 15, 8)], [20, cellOf(GRID, 14, 8)]], died: 26 }],
    shots: [[5, 1000, 0, 7], [9, 0, 1000, 10], [26, -1, 0, 113], [30, 0, HQ_ID, 10]],
    blasts: [{ tick: 15, cell: cellOf(GRID, 15, 8), hits: [[0, 50]] }],
    reveals: [[0, cellOf(GRID, 16, 8)], [10, cellOf(GRID, 15, 8)], [20, cellOf(GRID, 14, 8)]],
    outcome: { hqDamage: 0.005, destroyed: false, ticks: 30, sent: { rifleman: 1 }, lost: { rifleman: 1 } },
  };
  const troop = replay.troops[0];

  test('soldiers glide between squares and stay where they fall', () => {
    expect(troopAt(GRID, troop, -1)).toBeNull();
    expect(troopAt(GRID, troop, 0)).toEqual({ x: 16.5, y: 8.5 });
    expect(troopAt(GRID, troop, 5)).toEqual({ x: 16, y: 8.5 });
    expect(troopAt(GRID, troop, 10)).toEqual({ x: 15.5, y: 8.5 });
    expect(troopAt(GRID, troop, 20)).toEqual({ x: 14.5, y: 8.5 });
    expect(troopAt(GRID, troop, 99)).toEqual({ x: 14.5, y: 8.5 });
    const fell = { ...troop, died: 15 };
    expect(troopAt(GRID, fell, 99)).toEqual({ x: 15, y: 8.5 });
    expect(troopAt(GRID, { ...troop, points: [] }, 5)).toBeNull();
  });

  test('damage adds up over time, including mines and the HQ', () => {
    expect(damageAt(replay, 4).size).toBe(0);
    expect(damageAt(replay, 9).get(0)).toBe(7);
    expect(damageAt(replay, 9).get(1000)).toBe(10);
    expect(damageAt(replay, 20).get(0)).toBe(57);
    expect(damageAt(replay, 30).get(0)).toBe(170);
    expect(damageAt(replay, 30).get(HQ_ID)).toBe(10);
  });

  test('fog lifts square by square and never comes back', () => {
    const count = (tick: number) => revealedAt(replay, tick).filter(Boolean).length;
    expect([count(0), count(9), count(10), count(25), count(500)]).toEqual([1, 1, 2, 3, 3]);
    expect(revealedAt(replay, 10)[cellOf(GRID, 15, 8)]).toBe(true);
    expect(revealedAt(replay, 10)[cellOf(GRID, 14, 8)]).toBe(false);
  });
});

describe('wording', () => {
  test('outcomes, durations and ages read plainly', () => {
    expect(outcomeLine({ hqDamage: 1, destroyed: true, sent: { rifleman: 6 }, lost: { rifleman: 2 } })).toBe('HQ destroyed · 2 of 6 soldiers lost');
    expect(outcomeLine({ hqDamage: 0.424, destroyed: false, sent: { scout: 3, heavy: 1 }, lost: {} })).toBe('HQ 42% damaged · 0 of 4 soldiers lost');
    expect(outcomeLine({ hqDamage: 0, destroyed: false, sent: { scout: 1 }, lost: { scout: 1 } })).toBe('HQ untouched · 1 of 1 soldiers lost');
    expect(shortDuration(30)).toBe('under a minute');
    expect(shortDuration(8 * 3600 - 60)).toBe('7h 59m');
    expect(shortDuration(600)).toBe('10m');
    expect([ago(1000, 990), ago(1000, 700), ago(10000, 1000), ago(200000, 1000)]).toEqual(['just now', '5m ago', '2h ago', '2d ago']);
  });
});
