import { GameState, Player, ClientInput, Zombie, Bullet } from '../shared/types';

const BOUNDS = { width: 1000, height: 800 };
const PLAYER_RADIUS = 15;
const ZOMBIE_RADIUS = 12;
const BULLET_RADIUS = 3;
const ZOMBIE_ATTACK_COOLDOWN = 1.0; // seconds
const ZOMBIE_ATTACK_RANGE = ZOMBIE_RADIUS + PLAYER_RADIUS + 5;
const ZOMBIE_DAMAGE = 20;
const BULLET_DAMAGE = 25;
const SHOOT_COOLDOWN = 0.2; // seconds
const BULLET_SPEED = 800;
const BULLET_LIFETIME = 2.0; // seconds

export class Game {
  private state: GameState = {
    players: {},
    zombies: [],
    bullets: [],
    wave: 1,
    barricades: [],
    gameOver: false
  };
  private inputs: Record<string, ClientInput> = {};
  private lastTick = Date.now();
  private zombieSpawnTimer = 0;
  private waveKills = 0;
  // Per-player shoot cooldowns
  private shootCooldowns: Record<string, number> = {};
  // Per-zombie attack cooldowns
  private zombieAttackCooldowns: Record<string, number> = {};
  // Per-bullet lifetimes
  private bulletLifetimes: Record<string, number> = {};

  addPlayer(id: string) {
    this.state.players[id] = {
      id,
      pos: { x: 400, y: 300 },
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
      // Normalize diagonal
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag > 0) {
        dx = (dx / mag) * speed * dt;
        dy = (dy / mag) * speed * dt;
      }
      p.pos.x += dx;
      p.pos.y += dy;

      // Keep in bounds
      p.pos.x = Math.max(PLAYER_RADIUS, Math.min(BOUNDS.width - PLAYER_RADIUS, p.pos.x));
      p.pos.y = Math.max(PLAYER_RADIUS, Math.min(BOUNDS.height - PLAYER_RADIUS, p.pos.y));

      // Aim
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

      // Check player death
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
    // Remove out-of-bounds or expired bullets
    this.state.bullets = this.state.bullets.filter(b => {
      const inBounds = b.pos.x > 0 && b.pos.x < BOUNDS.width && b.pos.y > 0 && b.pos.y < BOUNDS.height;
      const alive = this.bulletLifetimes[b.id] === undefined || this.bulletLifetimes[b.id] > 0;
      if (!inBounds || !alive) {
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
      this.state.zombies.push({
        id: zid,
        type: isDevil ? 'devil' : 'zombie',
        pos: { x: Math.random() < 0.5 ? 0 : BOUNDS.width, y: Math.random() * BOUNDS.height },
        health: isDevil ? (50 + this.state.wave * 20) : (20 + this.state.wave * 10),
        speed: isDevil ? (80 + this.state.wave * 5) : (50 + this.state.wave * 5)
      });
      this.zombieAttackCooldowns[zid] = 0;
    }

    // Update zombies
    for (let i = this.state.zombies.length - 1; i >= 0; i--) {
      const z = this.state.zombies[i];
      
      // Find closest living player
      let target: Player | null = null;
      let minDist = Infinity;
      for (const pid in this.state.players) {
        const p = this.state.players[pid];
        if (p.health <= 0) continue;
        const dist = Math.hypot(p.pos.x - z.pos.x, p.pos.y - z.pos.y);
        if (dist < minDist) { minDist = dist; target = p; }
      }

      // Move toward target
      if (target) {
        const angle = Math.atan2(target.pos.y - z.pos.y, target.pos.x - z.pos.x);
        z.pos.x += Math.cos(angle) * z.speed * dt;
        z.pos.y += Math.sin(angle) * z.speed * dt;

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

    // Check game over — all players dead
    const playerIds = Object.keys(this.state.players);
    if (playerIds.length > 0 && playerIds.every(id => this.state.players[id].health <= 0)) {
      this.state.gameOver = true;
    }
  }

  getState() {
    return this.state;
  }
}
