import { GameState, Player, ClientInput, Zombie, Bullet, Wall } from '../shared/types';

const MAP_WIDTH = 2400;
const MAP_HEIGHT = 1800;
const WALL_THICKNESS = 20;
const PLAYER_RADIUS = 15;
const ZOMBIE_RADIUS = 12;
const BULLET_RADIUS = 3;
const ZOMBIE_ATTACK_COOLDOWN = 1.0;
const ZOMBIE_ATTACK_RANGE = ZOMBIE_RADIUS + PLAYER_RADIUS + 5;
const ZOMBIE_DAMAGE = 20;
const BULLET_DAMAGE = 25;
const SHOOT_COOLDOWN = 0.2;
const BULLET_SPEED = 800;
const BULLET_LIFETIME = 2.0;

// Generate the map walls — BoxHead-style layout with rooms and corridors
function generateWalls(): Wall[] {
  const W = WALL_THICKNESS;
  const walls: Wall[] = [];

  // === Outer boundary walls ===
  walls.push({ x: 0, y: 0, w: MAP_WIDTH, h: W });              // top
  walls.push({ x: 0, y: MAP_HEIGHT - W, w: MAP_WIDTH, h: W }); // bottom
  walls.push({ x: 0, y: 0, w: W, h: MAP_HEIGHT });              // left
  walls.push({ x: MAP_WIDTH - W, y: 0, w: W, h: MAP_HEIGHT }); // right

  // === Central cross structure ===
  // Horizontal wall with gaps
  walls.push({ x: 300, y: 880, w: 500, h: W });   // left segment
  walls.push({ x: 1000, y: 880, w: 400, h: W });  // middle segment
  walls.push({ x: 1600, y: 880, w: 500, h: W });  // right segment

  // Vertical wall with gaps
  walls.push({ x: 1190, y: 200, w: W, h: 400 });  // top segment
  walls.push({ x: 1190, y: 800, w: W, h: 200 });  // middle segment
  walls.push({ x: 1190, y: 1200, w: W, h: 400 }); // bottom segment

  // === Top-left room ===
  walls.push({ x: 200, y: 300, w: 400, h: W });   // top wall
  walls.push({ x: 200, y: 300, w: W, h: 300 });   // left wall
  walls.push({ x: 200, y: 580, w: 250, h: W });   // bottom wall (with gap on right)

  // === Top-right room ===
  walls.push({ x: 1600, y: 300, w: 500, h: W });  // top wall
  walls.push({ x: 2080, y: 300, w: W, h: 300 });  // right wall
  walls.push({ x: 1750, y: 580, w: 350, h: W });  // bottom wall (with gap on left)

  // === Bottom-left room ===
  walls.push({ x: 200, y: 1200, w: 250, h: W });  // top wall (gap on right)
  walls.push({ x: 200, y: 1200, w: W, h: 350 });  // left wall
  walls.push({ x: 200, y: 1530, w: 500, h: W });  // bottom wall

  // === Bottom-right room ===
  walls.push({ x: 1750, y: 1200, w: 350, h: W }); // top wall (gap on left)
  walls.push({ x: 2080, y: 1200, w: W, h: 350 }); // right wall
  walls.push({ x: 1600, y: 1530, w: 500, h: W }); // bottom wall

  // === Scattered cover blocks ===
  // Small pillars / obstacles for tactical cover
  walls.push({ x: 700, y: 450, w: 60, h: 60 });
  walls.push({ x: 1500, y: 450, w: 60, h: 60 });
  walls.push({ x: 700, y: 1300, w: 60, h: 60 });
  walls.push({ x: 1500, y: 1300, w: 60, h: 60 });

  // Center arena pillars
  walls.push({ x: 1050, y: 750, w: 40, h: 40 });
  walls.push({ x: 1300, y: 750, w: 40, h: 40 });
  walls.push({ x: 1050, y: 1000, w: 40, h: 40 });
  walls.push({ x: 1300, y: 1000, w: 40, h: 40 });

  // Corridor walls creating narrow passages
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
  // Check if circle overlaps rectangle
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
  // If inside the rect completely, push out the shortest axis
  if (dist === 0) {
    const overlapX1 = (px - rx); // distance from left edge
    const overlapX2 = (rx + rw - px); // distance from right edge
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

function collidesWithWalls(px: number, py: number, radius: number): boolean {
  for (const w of WALLS) {
    if (rectContains(w.x, w.y, w.w, w.h, px, py, radius)) return true;
  }
  return false;
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

// Spawn points — open areas away from walls
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
  private state: GameState = {
    players: {},
    zombies: [],
    bullets: [],
    wave: 1,
    barricades: [],
    walls: WALLS,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    gameOver: false
  };
  private inputs: Record<string, ClientInput> = {};
  private lastTick = Date.now();
  private zombieSpawnTimer = 0;
  private waveKills = 0;
  private shootCooldowns: Record<string, number> = {};
  private zombieAttackCooldowns: Record<string, number> = {};
  private bulletLifetimes: Record<string, number> = {};

  addPlayer(id: string) {
    // Spawn in center of map
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
    this.inputs[id] = { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, switchWeapon: false };
    this.shootCooldowns[id] = 0;
  }

  removePlayer(id: string) {
    delete this.state.players[id];
    delete this.inputs[id];
    delete this.shootCooldowns[id];
  }

  handleInput(id: string, input: ClientInput) {
    this.inputs[id] = input;
  }

  update(dtOverride?: number) {
    const now = Date.now();
    const dt = dtOverride ?? (now - this.lastTick) / 1000;
    this.lastTick = now;

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

      // Try to move, resolve wall collisions
      let newX = p.pos.x + dx;
      let newY = p.pos.y + dy;

      // Keep in map bounds
      newX = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, newX));
      newY = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, newY));

      // Resolve wall collisions
      const resolved = resolveWallCollisions(newX, newY, PLAYER_RADIUS);
      p.pos.x = resolved.x;
      p.pos.y = resolved.y;

      // Aim — need to convert from screen coords to world coords
      // Client sends world-space mouse coords now
      p.angle = Math.atan2(i.mouseY - p.pos.y, i.mouseX - p.pos.x);

      // Weapon switch
      if (i.switchWeapon) {
        const w = ['pistol', 'uzi', 'shotgun', 'barrel', 'barricade'] as const;
        const idx = w.indexOf(p.weapon);
        p.weapon = w[(idx + 1) % w.length];
      }

      // Shoot cooldown
      if (this.shootCooldowns[id] > 0) {
        this.shootCooldowns[id] -= dt;
      }

      // Shooting
      if (i.shooting && this.shootCooldowns[id] <= 0 && p.ammo > 0) {
        if (p.weapon === 'barricade' || p.weapon === 'barrel') {
          this.state.barricades.push({ x: p.pos.x, y: p.pos.y, type: p.weapon });
          p.ammo--;
          this.shootCooldowns[id] = SHOOT_COOLDOWN;
        } else {
          const bid = Math.random().toString();
          this.state.bullets.push({
            id: bid,
            pos: { x: p.pos.x, y: p.pos.y },
            vel: { x: Math.cos(p.angle) * BULLET_SPEED, y: Math.sin(p.angle) * BULLET_SPEED },
            ownerId: id
          });
          this.bulletLifetimes[bid] = BULLET_LIFETIME;
          p.ammo--;
          this.shootCooldowns[id] = SHOOT_COOLDOWN;
        }
      }

      if (p.health <= 0) {
        p.health = 0;
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
    // Remove bullets that hit walls, go out of bounds, or expire
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

    // Spawn zombies from map edges
    this.zombieSpawnTimer += dt;
    const spawnInterval = Math.max(0.5, 3 - this.state.wave * 0.2);
    if (this.zombieSpawnTimer > spawnInterval) {
      this.zombieSpawnTimer = 0;
      const isDevil = Math.random() < 0.1 * this.state.wave;
      const zid = Math.random().toString();
      // Pick a random spawn zone
      const spawn = SPAWN_ZONES[Math.floor(Math.random() * SPAWN_ZONES.length)];
      this.state.zombies.push({
        id: zid,
        type: isDevil ? 'devil' : 'zombie',
        pos: { x: spawn.x, y: spawn.y },
        health: isDevil ? (50 + this.state.wave * 20) : (20 + this.state.wave * 10),
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

        // Wall collision for zombies
        const zResolved = resolveWallCollisions(newZX, newZY, ZOMBIE_RADIUS);
        z.pos.x = zResolved.x;
        z.pos.y = zResolved.y;

        // Melee attack
        if (this.zombieAttackCooldowns[z.id] === undefined) {
          this.zombieAttackCooldowns[z.id] = 0;
        }
        if (this.zombieAttackCooldowns[z.id] > 0) {
          this.zombieAttackCooldowns[z.id] -= dt;
        }
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
          z.health -= BULLET_DAMAGE;
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

    // Check game over
    const playerIds = Object.keys(this.state.players);
    if (playerIds.length > 0 && playerIds.every(id => this.state.players[id].health <= 0)) {
      this.state.gameOver = true;
    }
  }

  getState() {
    return this.state;
  }
}
