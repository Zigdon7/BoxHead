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
  type: 'zombie' | 'devil';
  pos: Vector2;
  health: number;
  speed: number;
}

export interface Bullet {
  id: string;
  pos: Vector2;
  vel: Vector2;
  ownerId: string;
}

export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GameState {
  players: Record<string, Player>;
  zombies: Zombie[];
  bullets: Bullet[];
  wave: number;
  barricades: any[];
  walls: Wall[];
  mapWidth: number;
  mapHeight: number;
  gameOver: boolean;
}

export type ClientInput = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  mouseX: number;
  mouseY: number;
  shooting: boolean;
  switchWeapon: boolean;
};
