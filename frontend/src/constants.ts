export const WEAPON_STATS: Record<string, { damage: number; name: string; slot: number }> = {
  pistol:         { damage: 25,  name: 'Pistol',          slot: 1 },
  uzi:            { damage: 15,  name: 'Uzi',             slot: 2 },
  shotgun:        { damage: 80,  name: 'Shotgun',         slot: 3 },
  rocketLauncher: { damage: 150, name: 'Rocket Launcher', slot: 4 },
  melee:          { damage: 35,  name: 'Melee',           slot: 0 },
};

// Shared physics constants (must match backend map.rs)
export const PLAYER_SPEED = 200.0;
export const PLAYER_RADIUS = 15.0;
export const DASH_SPEED_MULT = 3.0;
export const DASH_DURATION = 0.15;
export const DASH_MAX_CHARGES = 3;
export const DASH_RECHARGE_TIME = 2.5;
