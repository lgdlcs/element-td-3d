/**
 * Wave schedule.
 *
 * 50 waves shaped as a difficulty staircase with boss beats every 10 and a
 * mixed "gauntlet" finale. HP scales super-linearly but bounty scales slower,
 * so late game requires compounding, not just spending.
 */

import { ECONOMY, WAVES } from '../core/Config.js';

const ORDER = ['normal', 'fast', 'armored', 'swarm', 'ground', 'normal', 'armored', 'fast', 'swarm', 'boss'];

/** 55 scripted waves, then endless escalating bosses (Element TD canon). */
export const TOTAL_WAVES = 55;

/**
 * Air waves are on a fixed period (WAVES.airEvery) and nowhere else.
 *
 * The ORDER table used to sprinkle 'flying' at two arbitrary offsets, which made
 * air something you discovered by leaking to it. On a fixed cadence it is a
 * schedule you can build against, and `isAirWave(n + 1)` is what the HUD warns
 * on a full wave in advance.
 *
 * Boss waves win the collision (wave 70 is both): a boss is a single unit with
 * its own type, and rewriting it into a flyer would silently delete the boss.
 */
export function isAirWave(n) {
  if (n % WAVES.airEvery !== 0) return false;
  return !(n % 10 === 0 || n > TOTAL_WAVES);
}

/** Seconds of build time before wave `n`: 60s on wave 1, -5s each, floor 30s. */
export function prepTimeFor(n) {
  const base = Math.max(WAVES.prepFloor, WAVES.prepFirst - (n - 1) * WAVES.prepStep);
  return n % 10 === 0 || n > TOTAL_WAVES ? base + WAVES.bossPrepBonus : base;
}

export function waveDef(n) {
  const i = n - 1;
  const isBoss = n % 10 === 0 || n > TOTAL_WAVES;
  const isAir = isAirWave(n);
  // ORDER no longer contains 'flying' at all — air is scheduled, not sprinkled.
  // 'ground' is not a creep type; it is the slot air used to occupy, resolved to
  // a normal march so the rotation keeps its original length and rhythm.
  const type = isBoss ? 'boss' : isAir ? 'flying' : (ORDER[i % ORDER.length] === 'ground' ? 'normal' : ORDER[i % ORDER.length]);

  const tier = Math.floor(i / 10);
  const hp = Math.round(52 * Math.pow(1.185, i) * (1 + tier * 0.06));
  const count = isBoss ? 1 + Math.floor(tier * 0.6) : Math.min(30, 8 + Math.floor(i * 0.42));
  const bounty = Math.round((isBoss ? 90 : 9) * Math.pow(1.052, i));
  const interval = isBoss ? 1.6 : Math.max(0.22, 0.62 - i * 0.006);

  return {
    n, type, hp, count, bounty, interval, isBoss, isAir,
    label: isBoss ? `BOSS — ${type}` : isAir ? 'AIR' : type,
    // One pick at the start (granted by Game on boot), then every 5th wave
    // through wave 50 — 11 in total.
    grantsElement: n % ECONOMY.elementEveryWaves === 0 && n <= ECONOMY.lastElementWave,
    prepTime: prepTimeFor(n),
    endless: n > TOTAL_WAVES,
  };
}

/** Total HP the player must chew through — used by the UI threat meter. */
export function waveThreat(n) {
  const d = waveDef(n);
  return d.hp * d.count;
}

export class WaveRunner {
  constructor(creeps, fx) {
    this.creeps = creeps;
    this.fx = fx;
    this.wave = 0;
    this.spawning = false;
    this.spawned = 0;
    this.timer = 0;
    this.def = null;
    this.onWaveCleared = null;
    this.onWaveStart = null;
  }

  start(n) {
    this.wave = n;
    this.def = waveDef(n);
    this.spawning = true;
    this.spawned = 0;
    this.timer = 0;
    this.onWaveStart?.(this.def);
  }

  get inProgress() { return this.spawning || this.creeps.count > 0; }

  update(dt) {
    if (this.spawning) {
      this.timer -= dt;
      while (this.timer <= 0 && this.spawned < this.def.count) {
        // Spawn AT the portal, with only a small random jitter.
        //
        // This used to pass `this.spawned * 0.4`, a cumulative offset pushing
        // creep N back by 0.4N units along -Z. Because arrivals are already
        // staggered by `interval`, that offset was redundant — and it rendered
        // the entire pending wave as a rigid, perfectly-spaced queue standing
        // off the board edge, health bars and ground glows included. A blind
        // reviewer flagged it as a repeating sprite lattice with "zero
        // positional jitter, zero scale variance" and said it invalidated the
        // frame. It was arithmetic, so of course it had none.
        this.creeps.spawn(
          this.def.type, this.def.hp, this.def.bounty,
          Math.random() * 0.8,
        );
        this.spawned++;
        // Jitter the gap. Removing the cumulative offset above killed the
        // *static* queue, but a constant `interval` against a near-constant
        // walk speed still lays the wave out as a perfectly even single-file
        // column — the same "rigid, evenly-spaced diagonal, zero variance"
        // read, now marching instead of standing. Regular spacing is the tell,
        // and it survives any amount of per-unit position jitter.
        //
        // The multiplier averages 1.0, so total spawn duration and therefore
        // wave pacing are unchanged; only the rhythm varies. The low tail
        // lets units arrive in loose pairs and threes, which is what a group
        // of things running at you actually looks like.
        this.timer += this.def.interval * (0.45 + Math.random() * 1.10);
      }
      if (this.spawned >= this.def.count) this.spawning = false;
    } else if (this.def && this.creeps.count === 0) {
      const cleared = this.def;
      this.def = null;
      this.onWaveCleared?.(cleared);
    }
  }
}
