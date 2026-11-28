// Pure extraction-shooter presentation logic (gear, maps, raid HUD), kept
// DOM-free so it can be unit tested. Numbers mirror backend/src/gear.rs and map.rs.

import type { Item, ItemKind, Rarity, Slot, RaidResult, Weapon } from './generated/types';

export const EXTRACT_TIME = 6;
export const CAMP_LIMIT = 75;
export const CAMP_WARNING = 45;
/** You're camping while you stay within this distance (units) for the last 30 seconds. */
export const CAMP_RADIUS = 450;
export const BLEEDOUT_TIME = 25;
/** Stand this close to an uplink to decrypt sealed loot (mirrors map.rs). */
export const UPLINK_RADIUS = 90;
export const SLOTS: Slot[] = ['primary', 'secondary', 'armor', 'pack'];

export interface MapSummary {
  id: string; name: string; tier: number; minGearScore: number; threat: string; blurb: string; entryFee: number;
  raidSecs: number; lootPower: [number, number]; width: number; height: number; unlocked: boolean;
  /** Entry fee before the Operations discount. */
  baseEntryFee?: number;
  /** The operator's Operations rank on this map. */
  opsRank?: number;
}

export interface OperatorSummary {
  id: string; name: string; raidable: boolean; tier: number; cash: number; gearScore: number; inRaid: boolean; active: boolean;
}

export interface Operations {
  map: string; name: string; xp: number; rank: number; maxRank: number;
  /** XP for the next rank (null at the top) and for the current one. */
  next: number | null; prev: number;
  entryFee: number; baseEntryFee: number; bountyBonus: number;
  requisition?: number; requisitionCost?: number; requisitionPower?: number;
}

export interface FacilityInfo {
  id: 'storage' | 'armory' | 'office' | 'workshop'; name: string; level: number; maxLevel: number; effect: string;
  next: { level: number; cost: number; effect: string; needsTier: boolean } | null;
}

export interface Homefront {
  tier: number; maxTier: number; topTier: number; safeTier: number;
  next: { tier: number; cash: number; valuables: number; minRarity: Rarity; have: number; uses: string[] } | null;
  facilities: FacilityInfo[];
  workshop: { stored: number; perHour: number; capacity: number; collected?: number };
}

export interface PerkInfo { id: string; name: string; perRank: string; rank: number; maxRank: number }

export interface Legacy {
  earned: number; available: number; cap: number; stashBonus: number; stashBonusCap: number;
  relocations: number; lastRelocation: string | null; boostLevel: number;
  badges: { season: string; operator: string; value: number }[];
  perks: PerkInfo[];
  respecCost?: number;
}

export interface SeasonInfo {
  id: string; name: string; endsAt: number; relocationOpensAt: number; relocationOpen: boolean; now: number;
}

export interface RelocationInfo {
  minTier: number;
  /** Why the active operator can't relocate now (null when it can). */
  blocker: string | null;
  reward: { value: number; legacyPoints: number; stashSlots: number; boostLevel: number } | null;
}

export interface Offer { id: string; kind: ItemKind; rarity: Rarity; power: number; name: string; price: number }

export interface Hideout {
  ok: boolean; error?: string; account: boolean;
  cash: number; raids: number; extracts: number; deaths: number; inRaid: boolean;
  gearScore: number; loadout: Partial<Record<Slot, Item | null>>; stash: Item[]; stashCapacity: number;
  offers: Offer[]; maps: MapSummary[];
  overflow?: Item[]; investmentValue?: number;
  /** Unread incoming base raids on the active operator. */
  unreadBaseDefenses?: number;
  /** Raidable operators (PvP) are available on this server. */
  pvpEnabled?: boolean;
  /** What insuring the current loadout for one raid costs. */
  insuranceCost: number;
  /** Ids of sealed stash items marked to come along on the next raid. */
  carry: string[];
  /** How many sealed items fit in the equipped pack. */
  carryCapacity: number;
  /** The account has no operator yet: only operator creation is possible. */
  needsOperator?: boolean;
  operators?: OperatorSummary[];
  maxOperators?: number;
  /** The active operator. */
  id?: string; name?: string; raidable?: boolean;
  accountId?: string; friendId?: string;
  insuranceRate?: number;
  boost?: { maxHealth: number; damage: number };
  homefront?: Homefront;
  operations?: Operations[];
  season?: SeasonInfo;
  legacy?: Legacy;
  relocation?: RelocationInfo;
}

/** Whole days (rounded up) from one unix time to another. */
export function daysUntil(now: number, then: number): number { return Math.max(0, Math.ceil((then - now) / 86400)); }

/** Progress (0-1) through the current Operations rank. */
export function opsProgress(o: Pick<Operations, 'xp' | 'next' | 'prev'>): number {
  if (o.next === null) return 1;
  return Math.max(0, Math.min(1, (o.xp - o.prev) / Math.max(1, o.next - o.prev)));
}

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#b3b9c4',
  uncommon: '#40c97a',
  rare: '#4f9dff',
  epic: '#b57bff',
  legendary: '#ff8a3d',
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary',
};

export const KIND_LABEL: Record<ItemKind, string> = {
  pistol: 'Pistol', uzi: 'Uzi', shotgun: 'Shotgun', rocketLauncher: 'Rocket Launcher',
  armor: 'Armor', pack: 'Pack', valuable: 'Valuable', encrypted: 'Encrypted',
};

export const SLOT_LABEL: Record<Slot, string> = { primary: 'Primary', secondary: 'Secondary', armor: 'Armor', pack: 'Pack' };

export const KIND_ICON: Record<ItemKind, string> = {
  pistol: 'i-pistol', uzi: 'i-uzi', shotgun: 'i-shotgun', rocketLauncher: 'i-rocket',
  armor: 'i-shield', pack: 'i-crate', valuable: 'i-star', encrypted: 'i-lock',
};

// ---------- Encrypted loot (mirrors gear.rs) ----------

/** Seconds at an uplink to decrypt one item of this signal strength. */
export const DECRYPT_SECS: Record<Rarity, number> = { common: 4, uncommon: 6, rare: 8, epic: 11, legendary: 15 };
const RARITY_VALUE_MULT: Record<Rarity, number> = { common: 1, uncommon: 1.6, rare: 2.6, epic: 4.5, legendary: 8 };

/** Roughly what a sealed item is worth once decrypted. */
export function estimatedValue(item: Pick<Item, 'rarity' | 'power'>): number {
  return Math.round(Math.round(70 * (1 + item.power / 15) * RARITY_VALUE_MULT[item.rarity]) * 0.8);
}

export const isEncrypted = (item: Pick<Item, 'kind'>) => item.kind === 'encrypted';
export const isGear = (kind: ItemKind) => kind !== 'valuable' && kind !== 'encrypted';

/** Worth used when a full pack decides what to swap (valuables and sealed loot). */
export function packWorth(item: Pick<Item, 'kind' | 'value' | 'rarity' | 'power'>): number {
  return item.kind === 'encrypted' ? estimatedValue(item) : item.value;
}

/** Inventory filter groups. */
export type ItemGroup = 'all' | 'weapons' | 'armor' | 'packs' | 'valuables' | 'encrypted';
export function itemGroup(kind: ItemKind): Exclude<ItemGroup, 'all'> {
  if (isWeapon(kind)) return 'weapons';
  if (kind === 'armor') return 'armor';
  if (kind === 'pack') return 'packs';
  return kind === 'encrypted' ? 'encrypted' : 'valuables';
}

export function isWeapon(kind: ItemKind): kind is Weapon { return kind === 'pistol' || kind === 'uzi' || kind === 'shotgun' || kind === 'rocketLauncher'; }

/** Which loadout slots an item can be equipped in. */
export function slotsFor(kind: ItemKind): Slot[] {
  if (isWeapon(kind)) return ['primary', 'secondary'];
  if (kind === 'armor') return ['armor'];
  if (kind === 'pack') return ['pack'];
  return [];
}

/** Average power of the four loadout slots, rounded down (server rule). */
export function gearScore(loadout: Partial<Record<Slot, Item | null>>): number {
  return Math.floor(SLOTS.reduce((sum, s) => sum + (loadout[s]?.power ?? 0), 0) / 4);
}

/** Gear score if `item` replaced whatever is in `slot`. */
export function gearScoreWith(loadout: Partial<Record<Slot, Item | null>>, slot: Slot, item: Item | null): number {
  return gearScore({ ...loadout, [slot]: item });
}

/** Sustained damage per second for a gun of this kind and power (types.rs base damage / cooldown). */
const GUN_BASE: Record<Weapon, { damage: number; cooldown: number }> = {
  pistol: { damage: 18, cooldown: 0.2 }, uzi: { damage: 15, cooldown: 0.08 }, shotgun: { damage: 80, cooldown: 0.5 }, rocketLauncher: { damage: 150, cooldown: 1 },
};
export function weaponDps(kind: ItemKind, power: number): number | null {
  if (!isWeapon(kind)) return null;
  const g = GUN_BASE[kind];
  return Math.round((g.damage * (1 + power / 50)) / g.cooldown);
}

// Item effects (mirror gear.rs).
export const weaponDamageMult = (power: number) => 1 + power / 50;
export const armorMaxHealth = (power: number) => 100 + power * 2;
export const packCapacity = (power: number) => 4 + Math.floor(power / 12);
export const packMaxAmmo = (power: number) => 60 + 2 * power;

/** One line describing what an item does for you. */
export function itemEffect(item: Pick<Item, 'kind' | 'power'>): string {
  if (isWeapon(item.kind)) return `${Math.round(weaponDamageMult(item.power) * 100)}% damage`;
  if (item.kind === 'armor') return `${armorMaxHealth(item.power)} max health`;
  if (item.kind === 'pack') return `${packCapacity(item.power)} loot slots · ${packMaxAmmo(item.power)} ammo`;
  if (item.kind === 'encrypted') return `Decrypt at an uplink`;
  return 'Sell it at the trader';
}

/** "How much better or worse": compare an item to what's equipped in its best slot. */
export function upgradeDelta(loadout: Partial<Record<Slot, Item | null>>, item: Item): { slot: Slot; delta: number } | null {
  const slots = slotsFor(item.kind);
  if (slots.length === 0) return null;
  // Prefer an empty slot, then the weakest one.
  const slot = slots.slice().sort((a, b) => (loadout[a]?.power ?? -1) - (loadout[b]?.power ?? -1))[0];
  return { slot, delta: gearScoreWith(loadout, slot, item) - gearScore(loadout) };
}

export function mapLockText(map: Pick<MapSummary, 'minGearScore' | 'unlocked'>, gs: number): string {
  if (map.unlocked || gs >= map.minGearScore) return 'Unlocked';
  return `Needs gear score ${map.minGearScore} (you have ${gs})`;
}

/** Highest-tier map this gear score can deploy to. */
export function bestMapFor<T extends Pick<MapSummary, 'tier' | 'minGearScore'>>(maps: T[], gs: number): T | undefined {
  return maps.filter(m => gs >= m.minGearScore).sort((a, b) => b.tier - a.tier)[0];
}

export function formatClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDistance(units: number): string {
  // 32 world units ≈ 1 metre (a player is about a metre wide).
  const m = Math.round(units / 32);
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

export function nearest<T extends { x: number; y: number }>(points: T[], x: number, y: number): { point: T; dist: number } | null {
  let best: { point: T; dist: number } | null = null;
  for (const p of points) {
    const dist = Math.hypot(p.x - x, p.y - y);
    if (!best || dist < best.dist) best = { point: p, dist };
  }
  return best;
}

/** Eight-way compass label for a direction from (x, y) toward a target. Screen y points down. */
export function compass(dx: number, dy: number): string {
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const a = Math.atan2(dy, dx);
  return dirs[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

export type ThreatLevel = 'none' | 'warning' | 'hunted';
export function threatLevel(camp: number, hunted: boolean): ThreatLevel {
  if (hunted) return 'hunted';
  return camp >= CAMP_WARNING ? 'warning' : 'none';
}

export function raidTitle(result: RaidResult): { title: string; tagline: string; kept: boolean } {
  switch (result) {
    case 'extracted': return { title: 'Extracted', tagline: 'You made it out with everything', kept: true };
    case 'killed': return { title: 'Killed in action', tagline: 'Your loadout and loot are lost', kept: false };
    case 'missingInAction': return { title: 'Missing in action', tagline: 'The raid clock ran out. Your loadout and loot are lost', kept: false };
    default: return { title: 'Raid abandoned', tagline: 'Leaving a raid forfeits your loadout and loot', kept: false };
  }
}

/** What the deploy screen says is at risk, based on which slots are filled. */
export function deployRiskText(loadout: Partial<Record<Slot, Item | null>>, entryFee = 0, insured = false): string {
  const filled = SLOTS.filter(s => loadout[s]);
  const fee = entryFee > 0 ? ` The $${entryFee.toLocaleString('en-US')} entry fee is never refunded.` : '';
  if (filled.length === 0) return `Nothing equipped: you deploy with a loaner pistol and a 2-slot pack, and risk nothing but your time.${fee}`;
  const worth = filled.reduce((sum, s) => sum + (loadout[s]?.value ?? 0), 0);
  const noGun = !loadout.primary && !loadout.secondary ? ' No gun equipped: you get a loaner pistol.' : '';
  const gear = insured
    ? 'At risk: anything you loot. Your equipped gear is insured and comes back if you die.'
    : `At risk: your equipped gear (worth $${worth.toLocaleString('en-US')}) and anything you loot. Extract to keep it all; die and it's gone.`;
  return `${gear}${fee}${noGun}`;
}

/** The camping meter, in words the player can act on. */
export function campWarningText(camp: number): string {
  const left = Math.max(0, Math.ceil(CAMP_LIMIT - camp));
  return `Camping: move ${formatDistance(CAMP_RADIUS)} away or hunters come in ${left}s`;
}

export function itemsValue(items: Pick<Item, 'value'>[]): number { return items.reduce((sum, i) => sum + i.value, 0); }

export function backpackValue(items: Pick<Item, 'value'>[]): number {
  return items.reduce((sum, i) => sum + i.value, 0);
}

/** Item a full pack would swap out for `candidate` (server rule): gear only
 *  replaces weaker gear (by power); valuables and sealed loot replace each
 *  other by what they're worth. */
export function swapCandidate<T extends Pick<Item, 'value' | 'power' | 'kind' | 'rarity' | 'protected'>>(pack: T[], capacity: number, candidate: Pick<Item, 'value' | 'power' | 'kind' | 'rarity'>): T | null | 'fits' {
  if (pack.length < capacity) return 'fits';
  const gear = isGear(candidate.kind);
  const score = (i: Pick<Item, 'value' | 'power' | 'kind' | 'rarity'>) => (gear ? i.power : packWorth(i));
  const low = pack.filter(i => !i.protected && isGear(i.kind) === gear)
    .reduce<T | null>((min, i) => (!min || score(i) < score(min) ? i : min), null);
  return low && score(candidate) > score(low) ? low : null;
}

export function enemyName(type: string): string {
  const names: Record<string, string> = { zombie: 'Walker', devil: 'Devil', crawler: 'Crawler', brute: 'Brute', vampire: 'Vampire', abomination: 'Abomination' };
  return names[type] ?? type;
}
