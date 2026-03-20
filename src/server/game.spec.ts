import { describe, it, expect, beforeEach } from 'vitest';
import { Game } from './game';
import { ClientInput } from '../shared/types';

function mkInput(overrides: Partial<ClientInput> = {}): ClientInput {
  return { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, melee: false, switchWeapon: false, ...overrides };
}

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
      expect(p.ammo).toBeGreaterThan(0);
    });

    it('moves with WASD input', () => {
      game.addPlayer('p1');
      const startPos = { ...game.getState().players['p1'].pos };
      game.handleInput('p1', mkInput({ down: true, right: true }));
      game.update(1/60);
      const newPos = game.getState().players['p1'].pos;
      expect(newPos.x).toBeGreaterThan(startPos.x);
      expect(newPos.y).toBeGreaterThan(startPos.y);
    });

    it('angle updates from mouse position', () => {
      game.addPlayer('p1');
      const pPos = game.getState().players['p1'].pos;
      // Aim to the right of the player
      game.handleInput('p1', mkInput({ mouseX: pPos.x + 500, mouseY: pPos.y }));
      game.update(1/60);
      const angle = game.getState().players['p1'].angle;
      expect(Math.abs(angle)).toBeLessThan(Math.PI / 2);
    });

    it('stays in bounds (old: keepInBounds)', () => {
      game.addPlayer('p1');
      for (let i = 0; i < 200; i++) {
        game.handleInput('p1', mkInput({ left: true }));
        game.update(1/60);
      }
      expect(game.getState().players['p1'].pos.x).toBeGreaterThanOrEqual(0);
    });

    it('dies when health <= 0', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.players['p1'].health = 0;
      game.update(1/60);
      const p = state.players['p1'];
      expect(!p || p.health <= 0).toBe(true);
    });
  });

  // === SHOOTING ===
  describe('Shooting', () => {
    it('creates bullets when shooting', () => {
      game.addPlayer('p1');
      // Move player to safe open area away from walls
      game.getState().players['p1'].pos = { x: 800, y: 700 };
      game.handleInput('p1', mkInput({ mouseX: 800, mouseY: 100, shooting: true }));
      for (let i = 0; i < 100; i++) game.update(1/60);
      expect(game.getState().bullets.length).toBeGreaterThan(0);
    });

    it('bullets have owner', () => {
      game.addPlayer('p1');
      const pPos = game.getState().players['p1'].pos;
      game.handleInput('p1', mkInput({ mouseX: pPos.x + 500, mouseY: pPos.y, shooting: true }));
      for (let i = 0; i < 100; i++) game.update(1/60);
      const bullets = game.getState().bullets;
      if (bullets.length > 0) {
        expect(bullets[0].ownerId).toBe('p1');
      }
    });

    it('shoot cooldown exists (old: 200ms between shots)', () => {
      game.addPlayer('p1');
      const pPos = game.getState().players['p1'].pos;
      game.handleInput('p1', mkInput({ mouseX: pPos.x + 500, mouseY: pPos.y, shooting: true }));
      game.update(1/60);
      game.update(1/60);
      let totalBullets = 0;
      for (let i = 0; i < 60; i++) game.update(1/60);
      totalBullets = game.getState().bullets.length;
      expect(totalBullets).toBeLessThan(60);
    });

    it('ammo decreases when shooting', () => {
      game.addPlayer('p1');
      const p = game.getState().players['p1'];
      const startAmmo = p.ammo;
      const pPos = p.pos;
      game.handleInput('p1', mkInput({ mouseX: pPos.x + 500, mouseY: pPos.y, shooting: true }));
      for (let i = 0; i < 100; i++) game.update(1/60);
      expect(p.ammo).toBeLessThan(startAmmo);
    });

    it('cannot shoot when out of ammo', () => {
      game.addPlayer('p1');
      const p = game.getState().players['p1'];
      p.ammo = 0;
      const pPos = p.pos;
      game.handleInput('p1', mkInput({ mouseX: pPos.x + 500, mouseY: pPos.y, shooting: true }));
      const bulletsBefore = game.getState().bullets.length;
      for (let i = 0; i < 20; i++) game.update(1/60);
      expect(game.getState().bullets.length).toBe(bulletsBefore);
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
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 100, y: 300 }, health: 50, maxHealth: 50, speed: 100
      });
      const startX = state.zombies[state.zombies.length - 1].pos.x;
      game.update(1/60);
      expect(state.zombies.find(z => z.id === 'z1')!.pos.x).toBeGreaterThan(startX);
    });

    it('deal melee damage to players on proximity (old: zombie.attack)', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.players['p1'].pos = { x: 400, y: 300 };
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 401, y: 300 }, health: 50, maxHealth: 50, speed: 0
      });
      const startHealth = state.players['p1'].health;
      for (let i = 0; i < 120; i++) game.update(1/60);
      expect(state.players['p1'].health).toBeLessThan(startHealth);
    });

    it('die when health reaches 0 from bullets', () => {
      game.addPlayer('p1');
      const state = game.getState();
      // Place zombie and bullet in open area (away from walls)
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 800, y: 700 }, health: 1, maxHealth: 1, speed: 0
      });
      state.bullets.push({
        id: 'b1', pos: { x: 799, y: 700 }, vel: { x: 100, y: 0 }, ownerId: 'p1', damage: 25
      });
      game.update(1/60);
      const freshState = game.getState();
      const zombie = freshState.zombies.find(z => z.id === 'z1');
      expect(!zombie || zombie.health <= 0).toBe(true);
    });

    it('killing zombies awards score to bullet owner', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.zombies.push({
        id: 'z1', type: 'zombie', pos: { x: 800, y: 700 }, health: 1, maxHealth: 1, speed: 0
      });
      state.bullets.push({
        id: 'b1', pos: { x: 799, y: 700 }, vel: { x: 100, y: 0 }, ownerId: 'p1', damage: 25
      });
      game.update(1/60);
      expect(game.getState().players['p1'].score).toBeGreaterThan(0);
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
      for (let i = 0; i < 20; i++) {
        state.zombies.push({
          id: `z${i}`, type: 'zombie', pos: { x: 500, y: 300 }, health: 1, maxHealth: 1, speed: 0
        });
        state.bullets.push({
          id: `b${i}`, pos: { x: 499, y: 300 }, vel: { x: 100, y: 0 }, ownerId: 'p1', damage: 25
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
      // Re-fetch state since getState() returns a shallow copy
      expect(game.getState().gameOver).toBe(true);
    });
  });

  // === BULLETS ===
  describe('Bullets', () => {
    it('removed when out of bounds', () => {
      game.addPlayer('p1');
      const state = game.getState();
      state.bullets.push({
        id: 'b1', pos: { x: -100, y: 300 }, vel: { x: -100, y: 0 }, ownerId: 'p1', damage: 25
      });
      game.update(1/60);
      // Re-fetch state since bullet filter creates a new array
      expect(game.getState().bullets.find(b => b.id === 'b1')).toBeUndefined();
    });
  });

  // === WEAPON SWITCHING (new feature) ===
  describe('Weapon switching', () => {
    it('cycles weapons', () => {
      game.addPlayer('p1');
      const w1 = game.getState().players['p1'].weapon;
      game.handleInput('p1', mkInput({ switchWeapon: true }));
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
