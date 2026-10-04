import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/Game.js';
import { rulesFor } from '../../src/game/runMode.js';

/**
 * A Game without its renderer: the real speed, pause and beginRun methods on
 * just the state they read. Constructing one needs WebGL.
 */
function bareGame({ speed = 1, paused = false } = {}) {
  const g = Object.create(Game.prototype);
  g.mode = 'solo';
  g._begun = false;
  g.state = { speed, paused, phase: 'lobby', pendingElementPicks: 0 };
  g.locked = null;
  g.hud = {
    refreshTop() {},
    openElementPicker() {},
    applyRunRules(rules) { g.locked = rules; },
  };
  return g;
}

describe('run mode', () => {
  it('solo: speed and pause change the run', () => {
    const g = bareGame();
    g.beginRun(7, { mode: 'solo' });
    expect(g.setSpeed(3)).toBe(true);
    expect(g.state.speed).toBe(3);
    expect(g.togglePause()).toBe(true);
    expect(g.state.paused).toBe(true);
    expect(g.togglePause()).toBe(true);
    expect(g.state.paused).toBe(false);
  });

  it('online: speed and pause are refused and the run stays at 1x', () => {
    const g = bareGame();
    g.beginRun(7, { mode: 'online' });
    expect(g.setSpeed(3)).toBe(false);
    expect(g.state.speed).toBe(1);
    expect(g.togglePause()).toBe(false);
    expect(g.state.paused).toBe(false);
  });

  it('online: beginRun drops a speed or pause set in the lobby, and locks the HUD', () => {
    const g = bareGame({ speed: 3, paused: true });
    g.beginRun(7, { mode: 'online' });
    expect(g.mode).toBe('online');
    expect(g.state.speed).toBe(1);
    expect(g.state.paused).toBe(false);
    expect(g.locked).toEqual({ speed: false, pause: false });
  });

  it('online: a pause that somehow exists can still be lifted', () => {
    const g = bareGame();
    g.beginRun(7, { mode: 'online' });
    g.state.paused = true;
    expect(g.togglePause()).toBe(true);
    expect(g.state.paused).toBe(false);
  });

  it('the mode is set once: a second beginRun cannot switch an online run to solo', () => {
    const g = bareGame();
    g.beginRun(7, { mode: 'online' });
    expect(g.beginRun(7, { mode: 'solo' })).toBe(false);
    expect(g.setSpeed(3)).toBe(false);
  });

  it('an unknown mode throws instead of silently allowing everything', () => {
    expect(() => rulesFor('multiplayer')).toThrow('unknown run mode: multiplayer');
    expect(() => bareGame().beginRun(7, { mode: 'multiplayer' })).toThrow('unknown run mode');
  });
});
