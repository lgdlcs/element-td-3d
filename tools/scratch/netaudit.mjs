/**
 * The audit the adversarial reviewer for `net` never delivered — it died on an API
 * error mid-response, so NetClient and Rng are the only two multiplayer components
 * with no independent verification. This is that verification.
 *
 * The claim under test is the one that matters most in the whole transport:
 *
 *   "connect() NEVER throws, NEVER rejects, and always settles."
 *
 * Because if it can wedge, the multiplayer work has made the SINGLE-PLAYER game
 * worse — main.js awaits it before the run begins. So it is attacked with four
 * different flavours of broken server, not just a closed port:
 *
 *   1. nothing listening at all
 *   2. a TCP socket that accepts and then says nothing (the nastiest case: the
 *      connection is established at the TCP level and simply never upgrades, so a
 *      naive implementation waits forever)
 *   3. a server that accepts the TCP connection and immediately destroys it
 *   4. an HTTP server that answers the upgrade with 200 instead of 101
 *
 * Unhandled rejections and uncaught exceptions are trapped at the process level,
 * because the failure mode being hunted is precisely the one that does not show up
 * as a returned value.
 */
import net from 'node:net';
import http from 'node:http';
import { mulberry32, hashStr, rngFor, pickN } from '../../src/core/Rng.js';

const R = [];
const ok = (name, cond, detail = '') => {
  R.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
};

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(`unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => unhandled.push(`uncaughtException: ${e?.message ?? e}`));

// =============================================================== Rng ==========
console.log('--- Rng ---');

const a = mulberry32(12345);
const b = mulberry32(12345);
const seqA = Array.from({ length: 200 }, () => a());
const seqB = Array.from({ length: 200 }, () => b());
ok('same seed gives the same sequence', seqA.join() === seqB.join());
ok('output stays inside [0,1)', seqA.every((v) => v >= 0 && v < 1),
  `min ${Math.min(...seqA).toFixed(6)} max ${Math.max(...seqA).toFixed(6)}`);

// A signed-int32 divide bug hands out negatives about half the time and is the
// documented reason for the `>>> 0` in mulberry32. 200 samples would catch it;
// 200k makes it certain, and doubles as a distribution check.
const big = mulberry32(7);
const buckets = new Array(10).fill(0);
let negatives = 0;
for (let i = 0; i < 200000; i++) {
  const v = big();
  if (v < 0) negatives++;
  buckets[Math.min(9, Math.floor(v * 10))]++;
}
ok('no negative draws in 200k samples', negatives === 0, `${negatives} negatives`);
const lo = Math.min(...buckets), hi = Math.max(...buckets);
ok('roughly uniform over 10 buckets', hi / lo < 1.08, `spread ${lo}..${hi}, ratio ${(hi / lo).toFixed(3)}`);

ok('hashStr is stable', hashStr('elements') === hashStr('elements'));
ok('hashStr separates similar strings', hashStr('elements') !== hashStr('element'));
ok('hashStr returns uint32', Number.isInteger(hashStr('x')) && hashStr('x') >= 0 && hashStr('x') <= 0xffffffff);

const p3 = rngFor(999, 'elements', 3);
const p3b = rngFor(999, 'elements', 3);
const p4 = rngFor(999, 'elements', 4);
ok('rngFor is addressable and stable',
  Array.from({ length: 8 }, () => p3()).join() === Array.from({ length: 8 }, () => p3b()).join());
ok('rngFor diverges on a different index',
  Array.from({ length: 8 }, () => rngFor(999, 'elements', 3)()).join()
  !== Array.from({ length: 8 }, () => p4()).join());
// The reviewer of Rng never ran; this is the specific claim its own comment makes
// about part separation, and it is worth checking because the implementation does
// NOT insert a separator byte — it hashes each part and mixes sequentially. That
// happens to be sufficient, but only if it actually holds.
ok("('a','bc') does not collide with ('ab','c')",
  Array.from({ length: 6 }, () => rngFor(1, 'a', 'bc')()).join()
  !== Array.from({ length: 6 }, () => rngFor(1, 'ab', 'c')()).join());
ok("rngFor(s,'a','a') differs from rngFor(s)",
  Array.from({ length: 6 }, () => rngFor(1, 'a', 'a')()).join()
  !== Array.from({ length: 6 }, () => rngFor(1)()).join());

const SRC = Object.freeze(['fire', 'water', 'nature', 'earth', 'light', 'dark']);
const mutable = [...SRC];
const picked = pickN(rngFor(42, 'x'), mutable, 3);
ok('pickN returns n items', picked.length === 3, picked.join(','));
ok('pickN items are distinct', new Set(picked).size === picked.length);
ok('pickN does not mutate its input', mutable.join() === SRC.join(), mutable.join(','));
ok('pickN is stable for a fixed seed',
  pickN(rngFor(42, 'x'), [...SRC], 3).join() === picked.join());
ok('pickN clamps n to the array length', pickN(rngFor(1, 'y'), [...SRC], 99).length === SRC.length);
ok('pickN(0) is empty', pickN(rngFor(1, 'z'), [...SRC], 0).length === 0);
// Every element must be reachable — a partial shuffle that only ever indexes the
// tail would silently make some elements unofferable.
const seen = new Set();
for (let i = 0; i < 400; i++) for (const v of pickN(rngFor(i, 'cover'), [...SRC], 3)) seen.add(v);
ok('every element can be offered', seen.size === SRC.length, `${seen.size}/${SRC.length}`);

// ========================================================= NetClient =========
console.log('\n--- NetClient offline behaviour ---');

// NetClient reads `location` for its default URL and `WebSocket` for transport.
// Node 22 has a global WebSocket, so only `location` needs supplying.
globalThis.location = { hostname: 'localhost', search: '' };
const { NetClient } = await import('../../src/net/NetClient.js');

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function attempt(label, url, expectOnline = false) {
  const c = new NetClient();
  const t0 = Date.now();
  let threw = null;
  let online;
  try {
    online = await c.connect(url);
  } catch (e) {
    threw = e?.message ?? String(e);
  }
  const ms = Date.now() - t0;
  ok(`${label}: connect() did not throw`, threw === null, threw ?? '');
  ok(`${label}: settled`, online !== undefined, `returned ${online} in ${ms}ms`);
  ok(`${label}: reports ${expectOnline ? 'online' : 'offline'}`,
    expectOnline ? online === true : online === false, `state=${c.state}`);
  ok(`${label}: settled in under 12s`, ms < 12000, `${ms}ms`);

  // Every send helper must be safe while offline — these get called from a frame
  // loop, so one throw here is a dead render loop, not a logged warning.
  let sendThrew = null;
  try {
    c.hello('probe'); c.create(); c.join('ABCD'); c.leave();
    c.ready(true); c.start(); c.status({ lives: 1, score: 2, wave: 3 });
    c.finished({ score: 1, wave: 1, won: false });
  } catch (e) { sendThrew = e?.message ?? String(e); }
  ok(`${label}: every send helper is safe`, sendThrew === null, sendThrew ?? '');
  c.disconnect();
  return c;
}

// 1. nothing listening
await attempt('dead port', `ws://127.0.0.1:${await freePort()}`);

// 2. accepts TCP, then never speaks — the case a naive timeout-less client hangs on
const mute = net.createServer((sock) => { sock.on('error', () => {}); /* say nothing, ever */ });
await new Promise((r) => mute.listen(0, '127.0.0.1', r));
await attempt('mute TCP server', `ws://127.0.0.1:${mute.address().port}`);
mute.close();

// 3. accepts then immediately destroys
const slam = net.createServer((sock) => sock.destroy());
await new Promise((r) => slam.listen(0, '127.0.0.1', r));
await attempt('instant close', `ws://127.0.0.1:${slam.address().port}`);
slam.close();

// 4. speaks HTTP but refuses the upgrade
const wrong = http.createServer((req, res) => { res.writeHead(200); res.end('not a websocket'); });
await new Promise((r) => wrong.listen(0, '127.0.0.1', r));
await attempt('HTTP 200 instead of 101', `ws://127.0.0.1:${wrong.address().port}`);
wrong.close();

// --- status throttling, measured -------------------------------------------
console.log('\n--- status throttle ---');
{
  const c = new NetClient();
  let sent = 0;
  // Stub the socket layer: the throttle decision has to be observable without a
  // server, and what is being tested is the RATE, not the transport.
  c._ws = { readyState: 1, send: () => { sent++; } };
  c._state = 'online';
  const t0 = Date.now();
  // 3 seconds of calling it every frame at 60fps is ~180 calls. Contract says
  // ~2 Hz, so anything past ~8 frames is the throttle failing.
  while (Date.now() - t0 < 3000) {
    c.status({ lives: 50, score: 1, wave: 1, killed: 0, leaked: 0, towers: 0 });
    await new Promise((r) => setTimeout(r, 16));
  }
  const secs = (Date.now() - t0) / 1000;
  const rate = sent / secs;
  console.log(`   ${sent} frames in ${secs.toFixed(1)}s = ${rate.toFixed(2)}/s`);
  ok('status is throttled to roughly 2 Hz', rate > 0.5 && rate < 4.5, `${rate.toFixed(2)}/s`);
  c.disconnect();
}

// ------------------------------------------------------------------ verdict --
await new Promise((r) => setTimeout(r, 1200));   // let any late rejection surface
const fail = R.filter((r) => !r.pass).length;
console.log(`\n${unhandled.length ? `UNHANDLED:\n${unhandled.join('\n')}` : 'no unhandled rejections or exceptions'}`);
console.log(`${fail === 0 && unhandled.length === 0 ? 'ALL GREEN' : `${fail} failed, ${unhandled.length} unhandled`}`);
process.exit(fail || unhandled.length ? 1 : 0);
