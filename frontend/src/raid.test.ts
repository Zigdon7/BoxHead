import { describe, expect, test } from 'vitest';
import type { Item } from './generated/types';
import {
  gearScore, gearScoreWith, slotsFor, upgradeDelta, mapLockText, bestMapFor, formatClock, formatDistance,
  nearest, compass, threatLevel, raidTitle, swapCandidate, itemEffect, backpackValue, CAMP_WARNING, deployRiskText, campWarningText,
  estimatedValue, DECRYPT_SECS, itemGroup, daysUntil, opsProgress,
} from './raid';

const item = (kind: Item['kind'], power: number, value = power * 10): Item =>
  ({ id: `${kind}-${power}-${value}`, kind, rarity: 'common', power, name: kind, value });

describe('gear score', () => {
  test('is the floored average of four slots, empty slots count as zero', () => {
    expect(gearScore({})).toBe(0);
    expect(gearScore({ primary: item('pistol', 6), armor: item('armor', 4), pack: item('pack', 4) })).toBe(3);
    expect(gearScore({ primary: item('uzi', 21), secondary: item('pistol', 20), armor: item('armor', 20), pack: item('pack', 20) })).toBe(20);
  });

  test('previewing a swap uses the slot it would go in', () => {
    const l = { primary: item('pistol', 10), armor: item('armor', 10) };
    expect(gearScoreWith(l, 'secondary', item('shotgun', 30))).toBe(12);
    expect(upgradeDelta(l, item('shotgun', 30))).toEqual({ slot: 'secondary', delta: 7 });
    expect(upgradeDelta(l, item('armor', 2))!.delta).toBeLessThan(0);
    expect(upgradeDelta(l, item('valuable', 50))).toBeNull();
  });

  test('items only fit matching slots', () => {
    expect(slotsFor('rocketLauncher')).toEqual(['primary', 'secondary']);
    expect(slotsFor('armor')).toEqual(['armor']);
    expect(slotsFor('valuable')).toEqual([]);
  });

  test('item effects read as one line', () => {
    expect(itemEffect(item('armor', 50))).toBe('200 max health');
    expect(itemEffect(item('uzi', 50))).toBe('200% damage');
    expect(itemEffect(item('pack', 24))).toBe('6 loot slots · 108 ammo');
  });
});

describe('maps', () => {
  const maps = [
    { id: 'a', tier: 1, minGearScore: 0, unlocked: true },
    { id: 'b', tier: 2, minGearScore: 20, unlocked: false },
    { id: 'c', tier: 3, minGearScore: 40, unlocked: false },
  ];
  test('lock text says what is needed', () => {
    expect(mapLockText(maps[1], 12)).toBe('Needs gear score 20 (you have 12)');
    expect(mapLockText(maps[0], 0)).toBe('Unlocked');
  });
  test('best map is the hardest one you qualify for', () => {
    expect(bestMapFor(maps, 25)!.id).toBe('b');
    expect(bestMapFor(maps, 0)!.id).toBe('a');
  });
});

describe('deploy risk', () => {
  test('says what is at stake from the filled slots, not the rounded gear score', () => {
    expect(deployRiskText({})).toMatch(/risk nothing/);
    const single = deployRiskText({ armor: item('armor', 3, 70) });
    expect(single).toMatch(/\$70/);
    expect(single).toMatch(/loaner pistol/);
    expect(deployRiskText({ primary: item('pistol', 6, 40) })).not.toMatch(/loaner/);
    expect(deployRiskText({ primary: item('pistol', 6, 40) }, 150)).toMatch(/\$150 entry fee is never refunded/);
    expect(deployRiskText({ primary: item('pistol', 6, 40) }, 0, true)).toMatch(/insured/);
  });
  test('camping text says how to escape and how long is left', () => {
    expect(campWarningText(60)).toBe('Camping: move 14 m away or hunters come in 15s');
  });
});

describe('raid HUD', () => {
  test('clock and distance formatting', () => {
    expect(formatClock(725)).toBe('12:05');
    expect(formatClock(0.2)).toBe('0:01');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatDistance(320)).toBe('10 m');
    expect(formatDistance(64000)).toBe('2.0 km');
  });

  test('nearest point and compass', () => {
    const pts = [{ x: 0, y: 0, name: 'a' }, { x: 100, y: 0, name: 'b' }];
    expect(nearest(pts, 90, 5)!.point.name).toBe('b');
    expect(nearest([], 0, 0)).toBeNull();
    expect(compass(1, 0)).toBe('E');
    expect(compass(0, -1)).toBe('N');
    expect(compass(-1, 1)).toBe('SW');
  });

  test('camping threat escalates to hunted', () => {
    expect(threatLevel(10, false)).toBe('none');
    expect(threatLevel(CAMP_WARNING, false)).toBe('warning');
    expect(threatLevel(0, true)).toBe('hunted');
  });

  test('results headline says what was kept', () => {
    expect(raidTitle('extracted').kept).toBe(true);
    expect(raidTitle('killed').kept).toBe(false);
    expect(raidTitle('missingInAction').title).toBe('Missing in action');
    expect(raidTitle('abandoned').tagline).toMatch(/forfeits/);
  });

  test('full packs keep gear and valuables apart', () => {
    const armor = item('armor', 38, 254);
    const watch = item('valuable', 30, 546);
    const pack = [armor, watch];
    expect(swapCandidate(pack, 3, { kind: 'valuable', value: 1, power: 1, rarity: 'common' })).toBe('fits');
    expect(swapCandidate(pack, 2, { kind: 'valuable', value: 900, power: 40, rarity: 'common' })).toBe(watch);
    expect(swapCandidate(pack, 2, { kind: 'shotgun', value: 999, power: 20, rarity: 'common' })).toBeNull();
    expect(swapCandidate(pack, 2, { kind: 'shotgun', value: 10, power: 45, rarity: 'common' })).toBe(armor);
    expect(backpackValue(pack)).toBe(800);
  });

  test('sealed loot is valued by what it should open into and competes with valuables', () => {
    const sealed = { ...item('encrypted', 60, 120), rarity: 'legendary' as const };
    expect(estimatedValue(sealed)).toBeGreaterThan(sealed.value);
    const junk = item('valuable', 1, 75);
    const gun = item('pistol', 5, 40);
    expect(swapCandidate([gun, junk], 2, sealed)).toBe(junk);
    expect(swapCandidate([gun, sealed], 2, { kind: 'uzi', value: 10, power: 50, rarity: 'common' })).toBe(gun);
    expect(DECRYPT_SECS.legendary).toBeGreaterThan(DECRYPT_SECS.common);
    expect(itemGroup('encrypted')).toBe('encrypted');
    expect(itemGroup('rocketLauncher')).toBe('weapons');
  });
});

describe('progression helpers', () => {
  test('daysUntil rounds up and never goes negative', () => {
    expect(daysUntil(0, 86400)).toBe(1);
    expect(daysUntil(0, 86401)).toBe(2);
    expect(daysUntil(100, 50)).toBe(0);
  });

  test('opsProgress is the share of the current rank earned', () => {
    expect(opsProgress({ xp: 0, prev: 0, next: 150 })).toBe(0);
    expect(opsProgress({ xp: 325, prev: 150, next: 500 })).toBe(0.5);
    expect(opsProgress({ xp: 9000, prev: 5000, next: null })).toBe(1);
  });
});
