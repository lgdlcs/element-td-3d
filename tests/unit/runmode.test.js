import { describe, it, expect } from 'vitest';
import { RUN_RULES, rulesFor } from '../../src/game/runMode.js';

describe('run mode rules', () => {
  it('solo allows speed and pause', () => {
    expect(rulesFor('solo')).toEqual({ speed: true, pause: true });
  });

  it('online forbids speed and pause', () => {
    expect(rulesFor('online')).toEqual({ speed: false, pause: false });
  });

  it('an unknown mode throws instead of silently allowing everything', () => {
    expect(() => rulesFor('multiplayer')).toThrow('unknown run mode: multiplayer');
    expect(() => rulesFor(undefined)).toThrow();
  });

});
