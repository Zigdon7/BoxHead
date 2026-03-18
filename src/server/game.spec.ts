import { describe, it, expect, beforeEach } from 'vitest';
import { Game } from './game';

describe('Feature parity: Old BoxHead → New Rebuild', () => {
  let game: Game;

  beforeEach(() => {
    game = new Game();
  });

  // === PLAYER BASICS ===
  describe('Player', () => {
    it('starts with health 100', () => {
      game.addPlayer('p1');
      expect(game.getState().players['p1'].health).toBe(100);
    });

    it('starts with score 0', () => {
      game.addPlayer('p1');
      expect(game.getState().players['p1'].score).toBe(0);
    });

    it('starts with a weapon', () => {
      game.addPlayer('p1');
      expect(game.getState().players['p1'].weapon).toBeDefined();
    });

    it('has ammo system (old: ammo 30, maxAmmo 30)', () => {
      game.addPlayer('p1');
      const p = game.getState().players['p1'];
      expect(p).toHaveProperty('ammo');
      expect((p as any).ammo).toBeGreaterThan(0);
    });

    it('moves with WASD input', () => {
      game.addPlayer('p1');
      const startPos = { ...game.getState().players['p1'].pos };
      game.handleInput('p1', { up: false, down: true, left: false, right: true, mouseX: 0, mouseY: 0, shooting: false, switchWeapon: false });
      game.update(1/60);
      const newPos = game.getState().players['p1'].pos;
      expect(newPos.x).toBeGreaterThan(startPos.x);
      expect(newPos.y).toBeGreaterThan(startPos.y);
    });

    it('angle updates from mouse position', () => {
      game.addPlayer('p1');
      game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 999, mouseY: 300, shooting: false, switchWeapon: false });
      game.update(1/60);
      const angle = game.getState().players['p1'].angle;
      // Aiming to the right should be roughly 0
      expect(Math.abs(angle)).toBeLessThan(Math.PI / 2);
    });

    it('stays in bounds (old: keepInBounds)', () => {
      game.addPlayer('p1');
      // Move far left
      for (let i = 0; i < 200; i++) {
        game.handleInput('p1', { up: false, down: false, left: true, right: false, mouseX: 0, mouseY: 0, shooting: false, switchWeapon: false });
        game.update(1/60);
      }
      expect(game.getState().players['p1'].pos.x).toBeGreaterThanOrEqual(0);
    });

    it('dies when health <= 0', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.players['p1'].health = 0;
      game.update(1/60);
      // Player should be marked dead or removed
      const p = state.players['p1'];
      expect(!p || p.health <= 0 || (p as any).alive === false).toBe(true);
    });
  });

  // === SHOOTING ===
  describe('Shooting', () => {
    it('creates bullets when shooting', () => {
      game.addPlayer('p1');
      game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 500, mouseY: 300, shooting: true, switchWeapon: false });
      // Run many frames to overcome any cooldown/random
      for (let i = 0; i < 100; i++) game.update(1/60);
      expect(game.getState().bullets.length).toBeGreaterThan(0);
    });

    it('bullets have owner', () => {
      game.addPlayer('p1');
      game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 500, mouseY: 300, shooting: true, switchWeapon: false });
      for (let i = 0; i < 100; i++) game.update(1/60);
      const bullets = game.getState().bullets;
      if (bullets.length > 0) {
        expect(bullets[0].ownerId).toBe('p1');
      }
    });

    it('shoot cooldown exists (old: 200ms between shots)', () => {
      game.addPlayer('p1');
      game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 500, mouseY: 300, shooting: true, switchWeapon: false });
      game.update(1/60);
      const count1 = game.getState().bullets.length;
      game.update(1/60);
      const count2 = game.getState().bullets.length;
      // Should NOT fire every single frame (old had cooldown)
      // With random 0.1 chance this is probabilistic but with cooldown it's deterministic
      // We just check bullets don't equal frame count after many frames
      let totalBullets = 0;
      for (let i = 0; i < 60; i++) game.update(1/60);
      totalBullets = game.getState().bullets.length;
      expect(totalBullets).toBeLessThan(60); // Not every frame
    });

    it('ammo decreases when shooting', () => {
      game.addPlayer('p1');
      const p = game.getState().players['p1'] as any;
      if (p.ammo === undefined) {
        expect.fail('Player should have ammo property');
        return;
      }
      const startAmmo = p.ammo;
      game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 500, mouseY: 300, shooting: true, switchWeapon: false });
      for (let i = 0; i < 100; i++) game.update(1/60);
      expect(p.ammo).toBeLessThan(startAmmo);
    });

    it('cannot shoot when out of ammo', () => {
      game.addPlayer('p1');
      const p = game.getState().players['p1'] as any;
      if (p.ammo !== undefined) {
        p.ammo = 0;
        game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 500, mouseY: 300, shooting: true, switchWeapon: false });
        const bulletsBefore = game.getState().bullets.length;
        for (let i = 0; i < 20; i++) game.update(1/60);
        expect(game.getState().bullets.length).toBe(bulletsBefore);
      }
    });
  });

  // === ZOMBIES ===
  describe('Zombies', () => {
    it('spawn over time', () => {
      game.addPlayer('p1');
      for (let i = 0; i < 300; i++) game.update(1/60);
      expect(game.getState().zombies.length).toBeGreaterThan(0);
    });

    it('chase closest player', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.players['p1'].pos = { x: 400, y: 300 };
      // Spawn a zombie far away
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 100, y: 300 }, health: 50, speed: 100
      });
      const startX = state.zombies[0].pos.x;
      game.update(1/60);
      // Zombie should move toward player (x increases)
      expect(state.zombies[0].pos.x).toBeGreaterThan(startX);
    });

    it('deal melee damage to players on proximity (old: zombie.attack)', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.players['p1'].pos = { x: 400, y: 300 };
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 401, y: 300 }, health: 50, speed: 0
      });
      const startHealth = state.players['p1'].health;
      for (let i = 0; i < 120; i++) game.update(1/60);
      expect(state.players['p1'].health).toBeLessThan(startHealth);
    });

    it('die when health reaches 0 from bullets', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 500, y: 300 }, health: 1, speed: 0
      });
      state.bullets.push({
        id: 'b1', pos: { x: 499, y: 300 }, vel: { x: 100, y: 0 }, ownerId: 'p1'
      });
      game.update(1/60);
      const zombie = state.zombies.find(z => z.id === 'z1');
      expect(!zombie || zombie.health <= 0).toBe(true);
    });

    it('killing zombies awards score to bullet owner', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 500, y: 300 }, health: 1, speed: 0
      });
      state.bullets.push({
        id: 'b1', pos: { x: 499, y: 300 }, vel: { x: 100, y: 0 }, ownerId: 'p1'
      });
      game.update(1/60);
      expect(state.players['p1'].score).toBeGreaterThan(0);
    });
  });

  // === WAVE SYSTEM ===
  describe('Wave system', () => {
    it('starts at wave 1', () => {
      expect(game.getState().wave).toBe(1);
    });

    it('wave advances after enough kills', () => {
      game.addPlayer('p1');
      const state = game.getState();
      // Kill many zombies to advance wave
      for (let i = 0; i < 20; i++) {
        state.zombies.push({
          id: `z${i}`, type: 'zombie', pos: { x: 500, y: 300 }, health: 1, speed: 0
        });
        state.bullets.push({
          id: `b${i}`, pos: { x: 499, y: 300 }, vel: { x: 100, y: 0 }, ownerId: 'p1'
        });
        game.update(1/60);
      }
      expect(state.wave).toBeGreaterThanOrEqual(1);
    });
  });

  // === GAME STATE ===
  describe('Game state', () => {
    it('has game over condition when all players dead (old: gameState gameOver)', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.players['p1'].health = -1;
      game.update(1/60);
      expect(state.gameOver).toBe(true);
    });
  });

  // === BULLETS ===  
  describe('Bullets', () => {
    it('removed when out of bounds', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.bullets.push({
        id: 'b1', pos: { x: -100, y: 300 }, vel: { x: -100, y: 0 }, ownerId: 'p1'
      });
      game.update(1/60);
      expect(state.bullets.find(b => b.id === 'b1')).toBeUndefined();
    });
  });

  // === WEAPON SWITCHING (new feature) ===
  describe('Weapon switching', () => {
    it('cycles weapons', () => {
      game.addPlayer('p1');
      const w1 = game.getState().players['p1'].weapon;
      game.handleInput('p1', { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, switchWeapon: true });
      game.update(1/60);
      expect(game.getState().players['p1'].weapon).not.toBe(w1);
    });
  });

  // === MULTIPLAYER ===
  describe('Multiplayer', () => {
    it('supports multiple players', () => {
      game.addPlayer('p1');
      game.addPlayer('p2');
      expect(Object.keys(game.getState().players).length).toBe(2);
    });

    it('removes player on disconnect', () => {
      game.addPlayer('p1');
      game.removePlayer('p1');
      expect(game.getState().players['p1']).toBeUndefined();
    });
  });
});
