// Offroad tuning instrument: mean ratio, gates, gold and rivals beaten per driver and wave.
// node tools/scratch/offroad-law.mjs [--seeds 20]
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { OFFROAD_RITE, DURATION, HALF_W } from '../../src/minigames/rites/OffroadRite.js';
import { offroadTarget, offroadSteer, playRite, skill, SKILL_PERFECT } from '../../tests/unit/helpers/reference-player.js';

const DT = MINIGAMES.dt;
const CAP = Math.ceil(DURATION / DT) + 1;
const nArg = process.argv.indexOf('--seeds');
const N = nArg > 0 ? Number(process.argv[nArg + 1]) : 20;
const SEEDS = Array.from({ length: N }, (_, i) => 1000 + i * 7919);

function run(strategy, seed, wave) {
  const inst = OFFROAD_RITE.create();
  inst.init({ rand: riteRng(seed, 'offroad', 0), wave, width: FIELD.w, height: FIELD.h, quality: 'high' });
  for (let n = 0; n < CAP; n++) { if (inst.update(DT, strategy(inst)) === true) break; inst.drainEvents(); }
  return inst;
}
const onRoad = (inst) => Math.abs(inst.x - inst.centreAt(inst.s)) < HALF_W;
const boostOn = (mode, inst) => mode === 'fast' ? inst.boostT <= 0 && inst.boostLeft > 0 && onRoad(inst) && inst.isFast(inst.s)
  : mode === 'mash';
const kb = (mode, target = offroadTarget) => (inst) => makeInput({ axis: offroadSteer(inst, target(inst)), action: boostOn(mode, inst) ? 1 : 0 });
const lineOnly = (inst) => { const g = inst.gates[inst.nextGate]; return g ? { s: g.s, u: 0 } : { s: inst.s + 6, u: 0 }; };

const DRIVERS = {
  idle: () => makeInput(),
  'kb-best': kb('fast'),
  'kb-mash': kb('mash'),
  'kb-noboost': kb('never'),
  'line-noboost': kb('never', lineOnly),
  'line-fast': kb('fast', lineOnly),
};
const row = (name, f) => {
  const cells = [3, 28, 53].map((wave) => {
    let r = 0, g = 0, c = 0, b = 0, fin = 0;
    for (const seed of SEEDS) { const i = f(seed, wave); const s = i.score(); r += s.ratio; g += i.gatesHit; c += i.coinsTaken; b += i.beaten ?? 0; fin += i.finished ? 1 : 0; }
    return `${(r / N).toFixed(3)} g${(g / N).toFixed(1)} c${(c / N).toFixed(1)} b${(b / N).toFixed(2)} f${fin}`;
  });
  console.log(name.padEnd(14), cells.join('  |  '));
};
console.log('driver'.padEnd(14), 'w3  |  w28  |  w53   (ratio, gates/12, gold/30, rivals beaten/3, finishers)');
for (const [name, d] of Object.entries(DRIVERS)) row(name, (seed, wave) => run(d, seed, wave));
for (const m of [0, 0.5, 1, 2]) {
  console.log(`ref m=${m}`.padEnd(14), [3, 28, 53].map((wave) => (SEEDS.reduce((a, seed) => a + playRite({ rite: 'offroad', seed, wave, skill: m === 0 ? SKILL_PERFECT : skill(m) }).ratio, 0) / N).toFixed(3)).join('  |  '));
}
