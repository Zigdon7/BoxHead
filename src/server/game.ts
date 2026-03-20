import { GameState, Player, ClientInput, Zombie, Bullet, Wall, AmmoPickup, WEAPON_STATS } from '../shared/types';

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
  for (const w of WALLS) {
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
  for (const w of WALLS) {
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

        for (let zi = this.state.zombies.length - 1; zi >= 0; zi--) {
          const z = this.state.zombies[zi];
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
              this.state.zombies.splice(zi, 1);
              delete this.zombieAttackCooldowns[z.id];
              p.score += z.type === 'devil' ? 50 : 10;
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
    const spawnInterval = Math.max(0.5, 3 - this.state.wave * 0.2);
    if (this.zombieSpawnTimer > spawnInterval) {
      this.zombieSpawnTimer = 0;
      const isDevil = Math.random() < 0.1 * this.state.wave;
      const zid = Math.random().toString();
      const spawn = SPAWN_ZONES[Math.floor(Math.random() * SPAWN_ZONES.length)];
      const hp = isDevil ? (50 + this.state.wave * 20) : (20 + this.state.wave * 10);
      this.state.zombies.push({
        id: zid,
        type: isDevil ? 'devil' : 'zombie',
        pos: { x: spawn.x, y: spawn.y },
        health: hp,
        maxHealth: hp,
        speed: isDevil ? (80 + this.state.wave * 5) : (50 + this.state.wave * 5)
      });
      this.zombieAttackCooldowns[zid] = 0;
    }

    // Update zombies
    for (let i = this.state.zombies.length - 1; i >= 0; i--) {
      const z = this.state.zombies[i];

      let target: Player | null = null;
      let minDist = Infinity;
      for (const pid in this.state.players) {
        const p = this.state.players[pid];
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
              this.state.players[b.ownerId].score += z.type === 'devil' ? 50 : 10;
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
}
