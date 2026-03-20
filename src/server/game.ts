import { GameState, Player, ClientInput, Zombie, Wall, AmmoPickup, WEAPON_STATS } from '../shared/types';
import { SpatialGrid } from './spatial-grid';

const MAP_WIDTH = 2400;
const MAP_HEIGHT = 1800;
const WALL_THICKNESS = 20;
const PLAYER_RADIUS = 15;
const ZOMBIE_RADIUS = 12;
const BULLET_RADIUS = 3;
const ZOMBIE_ATTACK_COOLDOWN = 1.0;
const ZOMBIE_ATTACK_RANGE = ZOMBIE_RADIUS + PLAYER_RADIUS + 5;
const ZOMBIE_DAMAGE = 20;
const SHOOT_COOLDOWN = 0.2;
const BULLET_SPEED = 800;
const BULLET_LIFETIME = 2.0;

// Zombie population scaling
const MAX_ZOMBIES_BASE = 30;
const MAX_ZOMBIES_PER_PLAYER = 8;
const MAX_ZOMBIES_HARD_CAP = 200;

// Melee
const MELEE_RANGE = 50;
const MELEE_ARC = Math.PI / 2; // 90 degree arc in front of player
const MELEE_COOLDOWN = 0.4;

// Ammo pickups
const AMMO_PICKUP_RADIUS = 18;
const AMMO_PICKUP_AMOUNT = 15;
const AMMO_RESPAWN_TIME = 15; // seconds

// Ammo spawn locations — corners and mid-edges
const AMMO_SPAWN_POINTS = [
  { x: 120, y: 120 },
  { x: MAP_WIDTH - 120, y: 120 },
  { x: 120, y: MAP_HEIGHT - 120 },
  { x: MAP_WIDTH - 120, y: MAP_HEIGHT - 120 },
  { x: MAP_WIDTH / 2, y: 120 },
  { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 120 },
  { x: 120, y: MAP_HEIGHT / 2 },
  { x: MAP_WIDTH - 120, y: MAP_HEIGHT / 2 },
];

// Generate the map walls
function generateWalls(): Wall[] {
  const W = WALL_THICKNESS;
  const walls: Wall[] = [];

  // Outer boundary
  walls.push({ x: 0, y: 0, w: MAP_WIDTH, h: W });
  walls.push({ x: 0, y: MAP_HEIGHT - W, w: MAP_WIDTH, h: W });
  walls.push({ x: 0, y: 0, w: W, h: MAP_HEIGHT });
  walls.push({ x: MAP_WIDTH - W, y: 0, w: W, h: MAP_HEIGHT });

  // Central cross with gaps
  walls.push({ x: 300, y: 880, w: 500, h: W });
  walls.push({ x: 1000, y: 880, w: 400, h: W });
  walls.push({ x: 1600, y: 880, w: 500, h: W });
  walls.push({ x: 1190, y: 200, w: W, h: 400 });
  walls.push({ x: 1190, y: 800, w: W, h: 200 });
  walls.push({ x: 1190, y: 1200, w: W, h: 400 });

  // Top-left room
  walls.push({ x: 200, y: 300, w: 400, h: W });
  walls.push({ x: 200, y: 300, w: W, h: 300 });
  walls.push({ x: 200, y: 580, w: 250, h: W });

  // Top-right room
  walls.push({ x: 1600, y: 300, w: 500, h: W });
  walls.push({ x: 2080, y: 300, w: W, h: 300 });
  walls.push({ x: 1750, y: 580, w: 350, h: W });

  // Bottom-left room
  walls.push({ x: 200, y: 1200, w: 250, h: W });
  walls.push({ x: 200, y: 1200, w: W, h: 350 });
  walls.push({ x: 200, y: 1530, w: 500, h: W });

  // Bottom-right room
  walls.push({ x: 1750, y: 1200, w: 350, h: W });
  walls.push({ x: 2080, y: 1200, w: W, h: 350 });
  walls.push({ x: 1600, y: 1530, w: 500, h: W });

  // Cover pillars
  walls.push({ x: 700, y: 450, w: 60, h: 60 });
  walls.push({ x: 1500, y: 450, w: 60, h: 60 });
  walls.push({ x: 700, y: 1300, w: 60, h: 60 });
  walls.push({ x: 1500, y: 1300, w: 60, h: 60 });

  // Center arena pillars
  walls.push({ x: 1050, y: 750, w: 40, h: 40 });
  walls.push({ x: 1300, y: 750, w: 40, h: 40 });
  walls.push({ x: 1050, y: 1000, w: 40, h: 40 });
  walls.push({ x: 1300, y: 1000, w: 40, h: 40 });

  // Corridor walls
  walls.push({ x: 500, y: 100, w: W, h: 150 });
  walls.push({ x: 900, y: 100, w: W, h: 150 });
  walls.push({ x: 500, y: 1550, w: W, h: 150 });
  walls.push({ x: 900, y: 1550, w: W, h: 150 });

  // Side alcoves
  walls.push({ x: 50, y: 700, w: 150, h: W });
  walls.push({ x: 50, y: 1100, w: 150, h: W });
  walls.push({ x: 2200, y: 700, w: 150, h: W });
  walls.push({ x: 2200, y: 1100, w: 150, h: W });

  return walls;
}

const WALLS = generateWalls();

// Static wall grid — walls have pos at their center for spatial lookup
const WALL_GRID_CELL_SIZE = 200;
type WallEntry = Wall & { pos: { x: number; y: number } };
const wallEntries: WallEntry[] = WALLS.map(w => ({ ...w, pos: { x: w.x + w.w / 2, y: w.y + w.h / 2 } }));
const wallGrid = new SpatialGrid<WallEntry>(MAP_WIDTH, MAP_HEIGHT, WALL_GRID_CELL_SIZE);
// Insert each wall into every cell it overlaps
for (const w of wallEntries) {
  const minCol = Math.max(0, Math.floor(w.x / WALL_GRID_CELL_SIZE));
  const maxCol = Math.min(Math.ceil(MAP_WIDTH / WALL_GRID_CELL_SIZE) - 1, Math.floor((w.x + w.w) / WALL_GRID_CELL_SIZE));
  const minRow = Math.max(0, Math.floor(w.y / WALL_GRID_CELL_SIZE));
  const maxRow = Math.min(Math.ceil(MAP_HEIGHT / WALL_GRID_CELL_SIZE) - 1, Math.floor((w.y + w.h) / WALL_GRID_CELL_SIZE));
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      // Insert with adjusted pos to land in the right cell
      const entry = { ...w, pos: { x: c * WALL_GRID_CELL_SIZE + 1, y: r * WALL_GRID_CELL_SIZE + 1 } };
      wallGrid.insert(entry);
    }
  }
}

// Collision helpers
function rectContains(rx: number, ry: number, rw: number, rh: number, px: number, py: number, radius: number): boolean {
  const closestX = Math.max(rx, Math.min(px, rx + rw));
  const closestY = Math.max(ry, Math.min(py, ry + rh));
  const dx = px - closestX;
  const dy = py - closestY;
  return (dx * dx + dy * dy) < (radius * radius);
}

function resolveCircleRect(px: number, py: number, radius: number, rx: number, ry: number, rw: number, rh: number): { x: number; y: number } {
  const closestX = Math.max(rx, Math.min(px, rx + rw));
  const closestY = Math.max(ry, Math.min(py, ry + rh));
  const dx = px - closestX;
  const dy = py - closestY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < radius && dist > 0) {
    const overlap = radius - dist;
    return { x: px + (dx / dist) * overlap, y: py + (dy / dist) * overlap };
  }
  if (dist === 0) {
    const overlapX1 = (px - rx);
    const overlapX2 = (rx + rw - px);
    const overlapY1 = (py - ry);
    const overlapY2 = (ry + rh - py);
    const min = Math.min(overlapX1, overlapX2, overlapY1, overlapY2);
    if (min === overlapX1) return { x: rx - radius, y: py };
    if (min === overlapX2) return { x: rx + rw + radius, y: py };
    if (min === overlapY1) return { x: px, y: ry - radius };
    return { x: px, y: ry + rh + radius };
  }
  return { x: px, y: py };
}

function resolveWallCollisions(px: number, py: number, radius: number): { x: number; y: number } {
  let x = px, y = py;
  const nearby = wallGrid.query(x, y, radius + WALL_GRID_CELL_SIZE);
  const seen = new Set<string>();
  for (const w of nearby) {
    const key = `${w.x},${w.y},${w.w},${w.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rectContains(w.x, w.y, w.w, w.h, x, y, radius)) {
      const resolved = resolveCircleRect(x, y, radius, w.x, w.y, w.w, w.h);
      x = resolved.x;
      y = resolved.y;
    }
  }
  return { x, y };
}

function pointInRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

function bulletHitsWall(px: number, py: number): boolean {
  const nearby = wallGrid.query(px, py, WALL_GRID_CELL_SIZE);
  for (const w of nearby) {
    if (pointInRect(px, py, w.x, w.y, w.w, w.h)) return true;
  }
  return false;
}

// Zombie spawn points
const SPAWN_ZONES = [
  { x: 100, y: 100 },
  { x: MAP_WIDTH - 100, y: 100 },
  { x: 100, y: MAP_HEIGHT - 100 },
  { x: MAP_WIDTH - 100, y: MAP_HEIGHT - 100 },
  { x: MAP_WIDTH / 2, y: 50 },
  { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 50 },
  { x: 50, y: MAP_HEIGHT / 2 },
  { x: MAP_WIDTH - 50, y: MAP_HEIGHT / 2 },
];

export class Game {
  private state: GameState;
  private inputs: Record<string, ClientInput> = {};
  private lastTick = Date.now();
  private zombieSpawnTimer = 0;
  private waveKills = 0;
  private shootCooldowns: Record<string, number> = {};
  private meleeCooldowns: Record<string, number> = {};
  private zombieAttackCooldowns: Record<string, number> = {};
  private bulletLifetimes: Record<string, number> = {};
  private gameTime = 0; // total elapsed seconds
  private zombieGrid = new SpatialGrid<Zombie>(MAP_WIDTH, MAP_HEIGHT, 200);
  private playerGrid = new SpatialGrid<Player>(MAP_WIDTH, MAP_HEIGHT, 200);

  constructor() {
    // Initialize ammo pickups
    const pickups: AmmoPickup[] = AMMO_SPAWN_POINTS.map((pt, i) => ({
      id: `ammo_${i}`,
      pos: { x: pt.x, y: pt.y },
      amount: AMMO_PICKUP_AMOUNT,
      respawnAt: 0, // available immediately
    }));

    this.state = {
      players: {},
      zombies: [],
      bullets: [],
      wave: 1,
      barricades: [],
      walls: WALLS,
      ammoPickups: pickups,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      gameOver: false
    };
  }

  addPlayer(id: string) {
    this.state.players[id] = {
      id,
      pos: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 },
      angle: 0,
      score: 0,
      health: 100,
      ammo: 30,
      maxAmmo: 30,
      weapon: 'pistol'
    };
    this.inputs[id] = { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, melee: false, switchWeapon: false };
    this.shootCooldowns[id] = 0;
    this.meleeCooldowns[id] = 0;
  }

  removePlayer(id: string) {
    delete this.state.players[id];
    delete this.inputs[id];
    delete this.shootCooldowns[id];
    delete this.meleeCooldowns[id];
  }

  handleInput(id: string, input: ClientInput) {
    this.inputs[id] = input;
  }

  update(dtOverride?: number) {
    const now = Date.now();
    const dt = dtOverride ?? (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.gameTime += dt;

    if (this.state.gameOver) return;

    // Rebuild spatial grids
    this.playerGrid.clear();
    for (const id in this.state.players) {
      const p = this.state.players[id];
      if (p.health > 0) this.playerGrid.insert(p);
    }

    const speed = 200;

    // Update players
    for (const id in this.state.players) {
      const p = this.state.players[id];
      const i = this.inputs[id];
      if (!i) continue;

      // Movement
      let dx = 0, dy = 0;
      if (i.up) dy -= 1;
      if (i.down) dy += 1;
      if (i.left) dx -= 1;
      if (i.right) dx += 1;
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag > 0) {
        dx = (dx / mag) * speed * dt;
        dy = (dy / mag) * speed * dt;
      }

      let newX = p.pos.x + dx;
      let newY = p.pos.y + dy;
      newX = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, newX));
      newY = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, newY));
      const resolved = resolveWallCollisions(newX, newY, PLAYER_RADIUS);
      p.pos.x = resolved.x;
      p.pos.y = resolved.y;

      // Aim
      p.angle = Math.atan2(i.mouseY - p.pos.y, i.mouseX - p.pos.x);

      // Weapon switch
      if (i.switchWeapon) {
        const w = ['pistol', 'uzi', 'shotgun', 'barrel', 'barricade'] as const;
        const idx = w.indexOf(p.weapon);
        p.weapon = w[(idx + 1) % w.length];
      }

      // Shoot cooldown
      if (this.shootCooldowns[id] > 0) this.shootCooldowns[id] -= dt;
      if (this.meleeCooldowns[id] > 0) this.meleeCooldowns[id] -= dt;

      // Melee attack
      if (i.melee && this.meleeCooldowns[id] <= 0) {
        this.meleeCooldowns[id] = MELEE_COOLDOWN;
        const meleeDmg = WEAPON_STATS.melee.damage;

        const nearbyZombies = this.zombieGrid.query(p.pos.x, p.pos.y, MELEE_RANGE);
        for (const z of nearbyZombies) {
          const dist = Math.hypot(z.pos.x - p.pos.x, z.pos.y - p.pos.y);
          if (dist > MELEE_RANGE) continue;

          // Check if zombie is within the swing arc
          const angleToZombie = Math.atan2(z.pos.y - p.pos.y, z.pos.x - p.pos.x);
          let angleDiff = angleToZombie - p.angle;
          // Normalize to [-PI, PI]
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

          if (Math.abs(angleDiff) <= MELEE_ARC / 2) {
            z.health -= meleeDmg;
            // Knockback
            const kb = 30;
            const kbAngle = Math.atan2(z.pos.y - p.pos.y, z.pos.x - p.pos.x);
            z.pos.x += Math.cos(kbAngle) * kb;
            z.pos.y += Math.sin(kbAngle) * kb;

            if (z.health <= 0) {
              const idx = this.state.zombies.indexOf(z);
              if (idx !== -1) this.state.zombies.splice(idx, 1);
              delete this.zombieAttackCooldowns[z.id];
              const points = z.type === 'vampire' ? 100 : z.type === 'brute' ? 75 : z.type === 'devil' ? 50 : z.type === 'crawler' ? 25 : 10;
              p.score += points;
              this.waveKills++;
              if (this.waveKills > this.state.wave * 10) {
                this.state.wave++;
                this.waveKills = 0;
              }
            }
          }
        }
      }

      // Shooting
      if (i.shooting && this.shootCooldowns[id] <= 0 && p.ammo > 0) {
        if (p.weapon === 'barricade' || p.weapon === 'barrel') {
          this.state.barricades.push({ x: p.pos.x, y: p.pos.y, type: p.weapon });
          p.ammo--;
          this.shootCooldowns[id] = SHOOT_COOLDOWN;
        } else {
          const weaponDmg = WEAPON_STATS[p.weapon]?.damage ?? 25;
          const bid = Math.random().toString();
          this.state.bullets.push({
            id: bid,
            pos: { x: p.pos.x, y: p.pos.y },
            vel: { x: Math.cos(p.angle) * BULLET_SPEED, y: Math.sin(p.angle) * BULLET_SPEED },
            ownerId: id,
            damage: weaponDmg
          });
          this.bulletLifetimes[bid] = BULLET_LIFETIME;
          p.ammo--;
          this.shootCooldowns[id] = SHOOT_COOLDOWN;
        }
      }

      if (p.health <= 0) p.health = 0;

      // Ammo pickup collision
      for (const pickup of this.state.ammoPickups) {
        if (pickup.respawnAt > this.gameTime) continue; // not available yet
        const dist = Math.hypot(p.pos.x - pickup.pos.x, p.pos.y - pickup.pos.y);
        if (dist < PLAYER_RADIUS + AMMO_PICKUP_RADIUS) {
          p.ammo = Math.min(p.maxAmmo, p.ammo + pickup.amount);
          pickup.respawnAt = this.gameTime + AMMO_RESPAWN_TIME;
        }
      }
    }

    // Update bullets
    for (const b of this.state.bullets) {
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      if (this.bulletLifetimes[b.id] !== undefined) {
        this.bulletLifetimes[b.id] -= dt;
      }
    }
    this.state.bullets = this.state.bullets.filter(b => {
      const inBounds = b.pos.x > 0 && b.pos.x < MAP_WIDTH && b.pos.y > 0 && b.pos.y < MAP_HEIGHT;
      const alive = this.bulletLifetimes[b.id] === undefined || this.bulletLifetimes[b.id] > 0;
      const hitsWall = bulletHitsWall(b.pos.x, b.pos.y);
      if (!inBounds || !alive || hitsWall) {
        delete this.bulletLifetimes[b.id];
        return false;
      }
      return true;
    });

    // Spawn zombies
    this.zombieSpawnTimer += dt;
    const playerCount = Object.keys(this.state.players).length;
    const maxZombies = Math.min(MAX_ZOMBIES_HARD_CAP, MAX_ZOMBIES_BASE + playerCount * MAX_ZOMBIES_PER_PLAYER);
    const spawnInterval = Math.max(0.3 + playerCount * 0.02, 3 - this.state.wave * 0.2);
    if (this.zombieSpawnTimer > spawnInterval && this.state.zombies.length < maxZombies) {
      this.zombieSpawnTimer = 0;

      let type: 'zombie' | 'devil' | 'crawler' | 'brute' | 'vampire' = 'zombie';
      const rand = Math.random();
      if (this.state.wave >= 5 && rand < 0.05) type = 'vampire';
      else if (this.state.wave >= 4 && rand < 0.15) type = 'brute';
      else if (this.state.wave >= 3 && rand < 0.30) type = 'crawler';
      else if (this.state.wave >= 2 && rand < 0.40) type = 'devil';

      const zid = Math.random().toString();
      const spawn = SPAWN_ZONES[Math.floor(Math.random() * SPAWN_ZONES.length)];
      
      let hp = 20 + this.state.wave * 10;
      let speed = 50 + this.state.wave * 5;

      if (type === 'devil') {
        hp = 50 + this.state.wave * 20;
        speed = 80 + this.state.wave * 5;
      } else if (type === 'crawler') {
        hp = 10 + this.state.wave * 5;
        speed = 120 + this.state.wave * 5;
      } else if (type === 'brute') {
        hp = 150 + this.state.wave * 30;
        speed = 30 + this.state.wave * 2;
      } else if (type === 'vampire') {
        hp = 80 + this.state.wave * 15;
        speed = 90 + this.state.wave * 5;
      }

      this.state.zombies.push({
        id: zid,
        type,
        pos: { x: spawn.x, y: spawn.y },
        health: hp,
        maxHealth: hp,
        speed
      });
      this.zombieAttackCooldowns[zid] = 0;
    }

    // Rebuild zombie grid before zombie update
    this.zombieGrid.clear();
    this.zombieGrid.insertAll(this.state.zombies);

    // Update zombies
    for (let i = this.state.zombies.length - 1; i >= 0; i--) {
      const z = this.state.zombies[i];

      // Find nearest player using spatial grid (600px aggro radius, fallback to all)
      let target: Player | null = null;
      let minDist = Infinity;
      let nearbyPlayers = this.playerGrid.query(z.pos.x, z.pos.y, 600);
      if (nearbyPlayers.length === 0) {
        nearbyPlayers = Object.values(this.state.players).filter(p => p.health > 0);
      }
      for (const p of nearbyPlayers) {
        if (p.health <= 0) continue;
        const dist = Math.hypot(p.pos.x - z.pos.x, p.pos.y - z.pos.y);
        if (dist < minDist) { minDist = dist; target = p; }
      }

      if (target) {
        const angle = Math.atan2(target.pos.y - z.pos.y, target.pos.x - z.pos.x);
        let newZX = z.pos.x + Math.cos(angle) * z.speed * dt;
        let newZY = z.pos.y + Math.sin(angle) * z.speed * dt;
        const zResolved = resolveWallCollisions(newZX, newZY, ZOMBIE_RADIUS);
        z.pos.x = zResolved.x;
        z.pos.y = zResolved.y;

        if (this.zombieAttackCooldowns[z.id] === undefined) this.zombieAttackCooldowns[z.id] = 0;
        if (this.zombieAttackCooldowns[z.id] > 0) this.zombieAttackCooldowns[z.id] -= dt;
        const dist = Math.hypot(target.pos.x - z.pos.x, target.pos.y - z.pos.y);
        if (dist < ZOMBIE_ATTACK_RANGE && this.zombieAttackCooldowns[z.id] <= 0) {
          target.health -= ZOMBIE_DAMAGE;
          this.zombieAttackCooldowns[z.id] = ZOMBIE_ATTACK_COOLDOWN;
        }
      }

      // Bullet-zombie collisions
      for (let j = this.state.bullets.length - 1; j >= 0; j--) {
        const b = this.state.bullets[j];
        if (Math.hypot(b.pos.x - z.pos.x, b.pos.y - z.pos.y) < ZOMBIE_RADIUS + BULLET_RADIUS) {
          z.health -= b.damage;
          delete this.bulletLifetimes[b.id];
          this.state.bullets.splice(j, 1);
          if (z.health <= 0) {
            this.state.zombies.splice(i, 1);
            delete this.zombieAttackCooldowns[z.id];
            if (this.state.players[b.ownerId]) {
              const points = z.type === 'vampire' ? 100 : z.type === 'brute' ? 75 : z.type === 'devil' ? 50 : z.type === 'crawler' ? 25 : 10;
              this.state.players[b.ownerId].score += points;
            }
            this.waveKills++;
            if (this.waveKills > this.state.wave * 10) {
              this.state.wave++;
              this.waveKills = 0;
            }
            break;
          }
        }
      }
    }

    // Game over check
    const playerIds = Object.keys(this.state.players);
    if (playerIds.length > 0 && playerIds.every(id => this.state.players[id].health <= 0)) {
      this.state.gameOver = true;
    }
  }

  getState() {
    // Only send available ammo pickups to client
    return {
      ...this.state,
      ammoPickups: this.state.ammoPickups.filter(p => p.respawnAt <= this.gameTime)
    };
  }

  getPlayers(): Record<string, import('../shared/types').Player> {
    return this.state.players;
  }

  getZombies(): import('../shared/types').Zombie[] {
    return this.state.zombies;
  }

  getBullets(): import('../shared/types').Bullet[] {
    return this.state.bullets;
  }

  getWave(): number {
    return this.state.wave;
  }

  getWalls(): import('../shared/types').Wall[] {
    return this.state.walls;
  }

  getMapDimensions(): { width: number; height: number } {
    return { width: MAP_WIDTH, height: MAP_HEIGHT };
  }

  getAmmoAvailability(): Map<string, boolean> {
    const map = new Map<string, boolean>();
    for (const p of this.state.ammoPickups) {
      map.set(p.id, p.respawnAt <= this.gameTime);
    }
    return map;
  }

  getAmmoSpawnPoints(): { x: number; y: number; amount: number }[] {
    return this.state.ammoPickups.map(p => ({ x: p.pos.x, y: p.pos.y, amount: p.amount }));
  }

  isGameOver(): boolean {
    return this.state.gameOver;
  }
}
