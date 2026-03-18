import { GameState, Player, ClientInput, Zombie, Bullet } from '../shared/types';

export class Game {
  private state: GameState = {
    players: {},
    zombies: [],
    bullets: [],
    wave: 1,
    barricades: []
  };
  private inputs: Record<string, ClientInput> = {};
  private lastTick = Date.now();
  private zombieSpawnTimer = 0;
  private waveKills = 0;

  addPlayer(id: string) {
    this.state.players[id] = {
      id,
      pos: { x: 400, y: 300 },
      angle: 0,
      score: 0,
      health: 100,
      weapon: 'pistol'
    };
    this.inputs[id] = { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, switchWeapon: false };
  }

  removePlayer(id: string) {
    delete this.state.players[id];
    delete this.inputs[id];
  }

  handleInput(id: string, input: ClientInput) {
    this.inputs[id] = input;
  }

  update() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    const speed = 200;

    for (const id in this.state.players) {
      const p = this.state.players[id];
      const i = this.inputs[id];
      
      if (!i) continue;

      if (i.up) p.pos.y -= speed * dt;
      if (i.down) p.pos.y += speed * dt;
      if (i.left) p.pos.x -= speed * dt;
      if (i.right) p.pos.x += speed * dt;
      
      p.angle = Math.atan2(i.mouseY - p.pos.y, i.mouseX - p.pos.x);
      
      if (i.switchWeapon) {
          const w = ['pistol', 'uzi', 'shotgun', 'barrel', 'barricade'] as const;
          const idx = w.indexOf(p.weapon);
          p.weapon = w[(idx + 1) % w.length];
      }

      if (i.shooting && Math.random() < 0.1) {
        if (p.weapon === 'barricade' || p.weapon === 'barrel') {
           this.state.barricades.push({ x: p.pos.x, y: p.pos.y, type: p.weapon });
        } else {
           this.state.bullets.push({
             id: Math.random().toString(),
             pos: { x: p.pos.x, y: p.pos.y },
             vel: { x: Math.cos(p.angle) * 800, y: Math.sin(p.angle) * 800 },
             ownerId: id
           });
        }
      }
    }

    for (const b of this.state.bullets) {
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
    }
    this.state.bullets = this.state.bullets.filter(b => b.pos.x > 0 && b.pos.x < 1000 && b.pos.y > 0 && b.pos.y < 800);

    this.zombieSpawnTimer += dt;
    if (this.zombieSpawnTimer > Math.max(0.5, 3 - this.state.wave * 0.2)) {
      this.zombieSpawnTimer = 0;
      const isDevil = Math.random() < 0.1 * this.state.wave;
      this.state.zombies.push({
        id: Math.random().toString(),
        type: isDevil ? 'devil' : 'zombie',
        pos: { x: Math.random() < 0.5 ? 0 : 800, y: Math.random() * 600 },
        health: isDevil ? (50 + this.state.wave * 20) : (20 + this.state.wave * 10),
        speed: isDevil ? (80 + this.state.wave * 5) : (50 + this.state.wave * 5)
      });
    }

    for (let i = this.state.zombies.length - 1; i >= 0; i--) {
      const z = this.state.zombies[i];
      let target: Player | null = null;
      let minDist = Infinity;
      for (const pid in this.state.players) {
        const p = this.state.players[pid];
        const dist = Math.hypot(p.pos.x - z.pos.x, p.pos.y - z.pos.y);
        if (dist < minDist) { minDist = dist; target = p; }
      }

      if (target) {
        const angle = Math.atan2(target.pos.y - z.pos.y, target.pos.x - z.pos.x);
        z.pos.x += Math.cos(angle) * z.speed * dt;
        z.pos.y += Math.sin(angle) * z.speed * dt;
      }

      for (let j = this.state.bullets.length - 1; j >= 0; j--) {
        const b = this.state.bullets[j];
        if (Math.hypot(b.pos.x - z.pos.x, b.pos.y - z.pos.y) < 20) {
          z.health -= 25;
          this.state.bullets.splice(j, 1);
          if (z.health <= 0) {
            this.state.zombies.splice(i, 1);
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
  }

  getState() {
    return this.state;
  }
}
