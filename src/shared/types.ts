export interface Vector2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Player {
  id: string;
  pos: Vector2;
  angle: number;
  score: number;
  health: number;
  ammo: number;
  maxAmmo: number;
  weapon: 'pistol' | 'uzi' | 'shotgun' | 'barrel' | 'barricade';
}

export interface Zombie {
  id: string;
  type: 'zombie' | 'devil' | 'crawler' | 'brute' | 'vampire';
  pos: Vector2;
  health: number;
  maxHealth: number;
  speed: number;
}

export interface Bullet {
  id: string;
  pos: Vector2;
  vel: Vector2;
  ownerId: string;
  damage: number;
}

export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AmmoPickup {
  id: string;
  pos: Vector2;
  amount: number;
  respawnAt: number; // server-only, but sent so client knows it exists
}

export interface GameState {
  players: Record<string, Player>;
  zombies: Zombie[];
  bullets: Bullet[];
  wave: number;
  barricades: any[];
  walls: Wall[];
  ammoPickups: AmmoPickup[];
  mapWidth: number;
  mapHeight: number;
  gameOver: boolean;
}

// Weapon stats shared between client (for HUD) and server
export const WEAPON_STATS: Record<string, { damage: number; name: string }> = {
  pistol:    { damage: 25, name: 'Pistol' },
  uzi:       { damage: 15, name: 'Uzi' },
  shotgun:   { damage: 80, name: 'Shotgun' },
  barrel:    { damage: 0,  name: 'Barrel' },
  barricade: { damage: 0,  name: 'Barricade' },
  melee:     { damage: 35, name: 'Melee' },
};

export type ClientInput = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  mouseX: number;
  mouseY: number;
  shooting: boolean;
  melee: boolean;
  switchWeapon: boolean;
};

// --- Network message types ---

/** Sent once on connect with static data */
export interface InitPayload {
  type: 'init';
  id: string;
  walls: Wall[];
  mapWidth: number;
  mapHeight: number;
  ammoSpawnPoints: { x: number; y: number; amount: number }[];
}

/** Full state snapshot (sent on connect and for resync) */
export interface SnapshotState {
  type: 'snapshot';
  tick: number;
  players: Record<string, Player>;
  zombies: Zombie[];
  bullets: Bullet[];
  wave: number;
  ammoPickups: { id: string; available: boolean }[];
  gameOver: boolean;
}

/** Incremental delta (sent every tick) */
export interface DeltaState {
  type: 'delta';
  tick: number;
  players?: Record<string, Partial<Player> & { id: string }>;
  playersRemoved?: string[];
  zombiesNew?: Zombie[];
  zombiesUpdated?: (Partial<Zombie> & { id: string })[];
  zombiesRemoved?: string[];
  bulletsNew?: Bullet[];
  bulletsRemoved?: string[];
  wave?: number;
  ammoPickups?: { id: string; available: boolean }[];
  gameOver?: boolean;
}

export type ServerMessage = InitPayload | SnapshotState | DeltaState;
