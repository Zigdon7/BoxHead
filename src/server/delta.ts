import { Player, Zombie, Bullet, DeltaState, SnapshotState } from '../shared/types';

interface PrevState {
  players: Record<string, Player>;
  zombieMap: Map<string, Zombie>;
  bulletSet: Set<string>;
  wave: number;
  ammoAvailability: Map<string, boolean>;
  gameOver: boolean;
}

function clonePlayer(p: Player): Player {
  return { ...p, pos: { ...p.pos } };
}

function cloneZombie(z: Zombie): Zombie {
  return { ...z, pos: { ...z.pos } };
}

export class DeltaTracker {
  private prev: PrevState | null = null;
  private tick = 0;

  getTick(): number {
    return this.tick;
  }

  computeDelta(
    players: Record<string, Player>,
    zombies: Zombie[],
    bullets: Bullet[],
    wave: number,
    ammoAvailability: Map<string, boolean>,
    gameOver: boolean
  ): DeltaState {
    this.tick++;

    if (!this.prev) {
      // First tick — save state, return a full-ish delta
      this.saveState(players, zombies, bullets, wave, ammoAvailability, gameOver);
      return {
        type: 'delta',
        tick: this.tick,
        players: Object.fromEntries(
          Object.entries(players).map(([id, p]) => [id, { ...p }])
        ),
        zombiesNew: zombies.map(cloneZombie),
        bulletsNew: [...bullets],
        wave,
        gameOver
      };
    }

    const delta: DeltaState = { type: 'delta', tick: this.tick };

    // Players
    const playerChanges: Record<string, Partial<Player> & { id: string }> = {};
    const playersRemoved: string[] = [];
    let hasPlayerChanges = false;

    for (const id in players) {
      const curr = players[id];
      const prev = this.prev.players[id];
      if (!prev) {
        // New player
        playerChanges[id] = { ...curr };
        hasPlayerChanges = true;
        continue;
      }
      const diff: Partial<Player> & { id: string } = { id };
      let changed = false;
      if (Math.abs(curr.pos.x - prev.pos.x) > 0.5 || Math.abs(curr.pos.y - prev.pos.y) > 0.5) {
        diff.pos = { x: Math.round(curr.pos.x * 10) / 10, y: Math.round(curr.pos.y * 10) / 10 };
        changed = true;
      }
      if (Math.abs(curr.angle - prev.angle) > 0.01) { diff.angle = Math.round(curr.angle * 100) / 100; changed = true; }
      if (curr.health !== prev.health) { diff.health = curr.health; changed = true; }
      if (curr.score !== prev.score) { diff.score = curr.score; changed = true; }
      if (curr.ammo !== prev.ammo) { diff.ammo = curr.ammo; changed = true; }
      if (curr.weapon !== prev.weapon) { diff.weapon = curr.weapon; changed = true; }
      if (changed) {
        playerChanges[id] = diff;
        hasPlayerChanges = true;
      }
    }
    for (const id in this.prev.players) {
      if (!(id in players)) {
        playersRemoved.push(id);
      }
    }
    if (hasPlayerChanges) delta.players = playerChanges;
    if (playersRemoved.length > 0) delta.playersRemoved = playersRemoved;

    // Zombies
    const zombiesNew: Zombie[] = [];
    const zombiesUpdated: (Partial<Zombie> & { id: string })[] = [];
    const zombiesRemoved: string[] = [];
    const currZombieMap = new Map<string, Zombie>();

    for (const z of zombies) {
      currZombieMap.set(z.id, z);
      const prev = this.prev.zombieMap.get(z.id);
      if (!prev) {
        zombiesNew.push(cloneZombie(z));
        continue;
      }
      const diff: Partial<Zombie> & { id: string } = { id: z.id };
      let changed = false;
      if (Math.abs(z.pos.x - prev.pos.x) > 0.5 || Math.abs(z.pos.y - prev.pos.y) > 0.5) {
        diff.pos = { x: Math.round(z.pos.x), y: Math.round(z.pos.y) };
        changed = true;
      }
      if (z.health !== prev.health) { diff.health = z.health; changed = true; }
      if (changed) {
        zombiesUpdated.push(diff);
      }
    }
    for (const [id] of this.prev.zombieMap) {
      if (!currZombieMap.has(id)) {
        zombiesRemoved.push(id);
      }
    }
    if (zombiesNew.length > 0) delta.zombiesNew = zombiesNew;
    if (zombiesUpdated.length > 0) delta.zombiesUpdated = zombiesUpdated;
    if (zombiesRemoved.length > 0) delta.zombiesRemoved = zombiesRemoved;

    // Bullets — just track new and removed by ID
    const currBulletIds = new Set(bullets.map(b => b.id));
    const bulletsNew: Bullet[] = [];
    const bulletsRemoved: string[] = [];

    for (const b of bullets) {
      if (!this.prev.bulletSet.has(b.id)) {
        bulletsNew.push(b);
      }
    }
    for (const id of this.prev.bulletSet) {
      if (!currBulletIds.has(id)) {
        bulletsRemoved.push(id);
      }
    }
    if (bulletsNew.length > 0) delta.bulletsNew = bulletsNew;
    if (bulletsRemoved.length > 0) delta.bulletsRemoved = bulletsRemoved;

    // Wave
    if (wave !== this.prev.wave) delta.wave = wave;

    // Ammo pickups
    const ammoChanges: { id: string; available: boolean }[] = [];
    for (const [id, avail] of ammoAvailability) {
      if (this.prev.ammoAvailability.get(id) !== avail) {
        ammoChanges.push({ id, available: avail });
      }
    }
    if (ammoChanges.length > 0) delta.ammoPickups = ammoChanges;

    // Game over
    if (gameOver !== this.prev.gameOver) delta.gameOver = gameOver;

    this.saveState(players, zombies, bullets, wave, ammoAvailability, gameOver);
    return delta;
  }

  buildSnapshot(
    players: Record<string, Player>,
    zombies: Zombie[],
    bullets: Bullet[],
    wave: number,
    ammoAvailability: Map<string, boolean>,
    gameOver: boolean
  ): SnapshotState {
    return {
      type: 'snapshot',
      tick: this.tick,
      players: Object.fromEntries(
        Object.entries(players).map(([id, p]) => [id, clonePlayer(p)])
      ),
      zombies: zombies.map(cloneZombie),
      bullets: [...bullets],
      wave,
      ammoPickups: Array.from(ammoAvailability.entries()).map(([id, available]) => ({ id, available })),
      gameOver
    };
  }

  private saveState(
    players: Record<string, Player>,
    zombies: Zombie[],
    bullets: Bullet[],
    wave: number,
    ammoAvailability: Map<string, boolean>,
    gameOver: boolean
  ): void {
    const zombieMap = new Map<string, Zombie>();
    for (const z of zombies) {
      zombieMap.set(z.id, cloneZombie(z));
    }
    this.prev = {
      players: Object.fromEntries(
        Object.entries(players).map(([id, p]) => [id, clonePlayer(p)])
      ),
      zombieMap,
      bulletSet: new Set(bullets.map(b => b.id)),
      wave,
      ammoAvailability: new Map(ammoAvailability),
      gameOver
    };
  }
}
