import { expect, test } from 'vitest';
import { Game } from '../server/game';

test('Game has required features', () => {
    const game = new Game();
    game.addPlayer('1');
    const state = game.getState();
    expect(state.wave).toBe(1);
    expect(state.players['1'].weapon).toBe('pistol');
    
    // Simulate game loop and weapon switch
    game.handleInput('1', { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, switchWeapon: true });
    game.update(1/60);
    expect(state.players['1'].weapon).toBe('uzi');
});
