/**
 * Acceptance driver for the spectate protocol (watch / watched / snap / unwatch).
 * Real WebSocket clients over a real port; nothing is stubbed.
 *
 *   node tools/scratch/mpspectate.mjs
 *
 * The four properties it exists to prove, in the order they are asserted:
 *
 *  1. B receives NOTHING before it subscribes, even though A is streaming.
 *  2. B receives A's snapshots once subscribed, with `from` stamped by the server
 *     and A's own frames never echoed back to A.
 *  3. B receives nothing after unsubscribing, and A is told `watched {n:0}` -
 *     which is the signal that makes the feature free when nobody is looking.
 *  4. The bounds bite: an oversized frame is refused unparsed, and the snap
 *     bucket throttles a flood instead of relaying it.
 */
import WebSocket from 'ws';
import { createServer } from '../../server/index.js';
import { NetClient } from '../../src/net/NetClient.js';

// NetClient only ever touches the standard WebSocket surface, so `ws` stands in
// for the browser global. Section 14 drives the real client against this same
// server, because a protocol both ends agree on and neither end can drive is not
// a feature yet.
if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WebSocket;

const PORT = 5292;
const URL = `ws://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class C {
  constructor(name) { this.name = name; this.rx = []; }
  static async open(name) {
    const c = new C(name);
    c.ws = new WebSocket(URL);
    c.ws.on('message', (d) => { try { c.rx.push(JSON.parse(d.toString())); } catch { c.rx.push({ t: '<unparseable>' }); } });
    c.ws.on('error', () => {});
    await new Promise((res, rej) => { c.ws.once('open', res); c.ws.once('error', rej); });
    return c;
  }
  send(o) { this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  raw(s) { this.ws.send(s); }
  async hello() { this.send({ t: 'hello', name: this.name }); return this.wait('welcome'); }
  last(t) { return [...this.rx].reverse().find((m) => m.t === t); }
  all(t) { return this.rx.filter((m) => m.t === t); }
  clear() { this.rx.length = 0; }
  wait(t, timeout = 1500) {
    const hit = this.rx.find((m) => m.t === t);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`${this.name}: timeout waiting for ${t}; got ${this.rx.map((m) => m.t).join(',') || '<nothing>'}`)), timeout);
      const on = (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.t !== t) return;
        clearTimeout(to); this.ws.off('message', on); res(m);
      };
      this.ws.on('message', on);
    });
  }
  close() { return new Promise((r) => { this.ws.once('close', r); this.ws.close(); setTimeout(r, 400); }); }
}

/** One plausible snapshot: header + N creeps flat, 6 numbers each. */
function snapshot(n, creeps = 12) {
  const c = [];
  for (let i = 0; i < creeps; i++) c.push(i + 1, i % 6, 100 + i, 200 - i, 88, 1);
  return { t: 'snap', v: 1, n, ts: n * 100, w: 12, l: 20, g: 340, sc: 5100, ph: 1, pt: 0, c };
}

const srv = createServer({ port: PORT, log: false, pingMs: 5000 });
await sleep(150);
console.log(`server up on ${URL}\n`);

// ---------------------------------------------------------------- setup
const a = await C.open('Ada');
const b = await C.open('Bob');
const wa = await a.hello();
const wb = await b.hello();
a.send({ t: 'create' });
const joinedA = await a.wait('joined');
b.send({ t: 'join', code: joinedA.code });
await b.wait('joined');
await a.wait('lobby');

// ---------------------------------------------------------------- 1
console.log('1. `watch` is refused outside a running run');
b.send({ t: 'watch', id: wa.id });
const errLobby = await b.wait('error');
ok('BAD_WATCH before the run starts', errLobby.code === 'BAD_WATCH', JSON.stringify(errLobby));

a.send({ t: 'start' });
await a.wait('go');
await b.wait('go');
await sleep(120);

// ---------------------------------------------------------------- 2
console.log('\n2. an unwatched player streams into the void');
a.clear(); b.clear();
for (let i = 0; i < 6; i++) { a.send(snapshot(i)); await sleep(20); }
await sleep(200);
ok('B received no snap before subscribing', b.all('snap').length === 0, JSON.stringify(b.rx.map((m) => m.t)));
ok('A was never told it had watchers', a.all('watched').length === 0, JSON.stringify(a.all('watched')));
ok('A got no error for streaming to nobody', a.all('error').length === 0, JSON.stringify(a.all('error')));

// ---------------------------------------------------------------- 3
console.log('\n3. bad subscriptions are refused');
a.clear(); b.clear();
b.send({ t: 'watch', id: wb.id });
const errSelf = await b.wait('error');
ok('watching yourself is BAD_WATCH', errSelf.code === 'BAD_WATCH', JSON.stringify(errSelf));
b.clear();
b.send({ t: 'watch', id: 'p99999' });
const errGhost = await b.wait('error');
ok('watching a stranger is NO_PLAYER', errGhost.code === 'NO_PLAYER', JSON.stringify(errGhost));

// ---------------------------------------------------------------- 4
console.log('\n4. B subscribes and the stream flows');
a.clear(); b.clear();
b.send({ t: 'watch', id: wa.id });
const watching = await b.wait('watching');
ok('watching acks with id + server-side name', watching.id === wa.id && watching.name === 'Ada', JSON.stringify(watching));
const watched = await a.wait('watched');
ok('A is told n=1', watched.n === 1, JSON.stringify(watched));

a.clear(); b.clear();
for (let i = 10; i < 16; i++) { a.send(snapshot(i)); await sleep(100); }
await sleep(200);
const got = b.all('snap');
ok('B received the snapshots', got.length === 6, `${got.length}`);
ok('server stamped `from`', got.every((m) => m.from === wa.id), JSON.stringify(got[0] && { from: got[0].from }));
ok('payload survived the relay intact', got[0].v === 1 && got[0].c.length === 72 && got[0].n === 10, JSON.stringify({ v: got[0].v, len: got[0].c.length, n: got[0].n }));
ok('sequence preserved and in order', got.map((m) => m.n).join(',') === '10,11,12,13,14,15', got.map((m) => m.n).join(','));
ok('A never received its own snapshots back', a.all('snap').length === 0, `${a.all('snap').length}`);

// ---------------------------------------------------------------- 5
console.log('\n5. the reverse direction is not implied by the forward one');
a.clear(); b.clear();
for (let i = 0; i < 4; i++) { b.send(snapshot(i)); await sleep(30); }
await sleep(200);
ok('A receives nothing from B (A never subscribed)', a.all('snap').length === 0, `${a.all('snap').length}`);
ok('B got no watched frame either', b.all('watched').length === 0, JSON.stringify(b.all('watched')));

// ---------------------------------------------------------------- 6
console.log('\n6. re-watching the same target is a no-op');
a.clear(); b.clear();
b.send({ t: 'watch', id: wa.id });
await sleep(200);
ok('no second `watching` frame', b.all('watching').length === 0, JSON.stringify(b.all('watching')));
ok('no `watched` churn for A', a.all('watched').length === 0, JSON.stringify(a.all('watched')));

// ---------------------------------------------------------------- 7
console.log('\n7. B unsubscribes and the stream stops dead');
a.clear(); b.clear();
b.send({ t: 'watch', id: null });
const unwatch = await b.wait('unwatch');
ok('B is told it unsubscribed', unwatch.id === wa.id && unwatch.reason === 'gone', JSON.stringify(unwatch));
const watched0 = await a.wait('watched');
ok('A is told n=0', watched0.n === 0, JSON.stringify(watched0));

a.clear(); b.clear();
for (let i = 30; i < 36; i++) { a.send(snapshot(i)); await sleep(30); }
await sleep(250);
ok('B received nothing after unsubscribing', b.all('snap').length === 0, JSON.stringify(b.rx.map((m) => m.t)));
ok('A was not rate-limited for streaming to nobody', a.all('error').length === 0, JSON.stringify(a.all('error')));

// ---------------------------------------------------------------- 8
console.log('\n8. the size bound bites before the parse');
a.clear();
// 12 KB: under maxPayload (16 KB) so ws delivers it, over MAX_FRAME_BYTES (8 KB)
// so the protocol must refuse it without parsing.
const fatCreeps = [];
for (let i = 0; i < 400; i++) fatCreeps.push(i, 1, 12345, 12345, 100, 15);
const fat = JSON.stringify({ t: 'snap', v: 1, n: 1, c: fatCreeps });
ok('the oversized frame really is oversized', fat.length > 8 * 1024 && fat.length < 16 * 1024, `${fat.length} bytes`);
b.send({ t: 'watch', id: wa.id });
await b.wait('watching');
await a.wait('watched');
a.clear(); b.clear();
a.raw(fat);
const tooBig = await a.wait('error');
ok('oversized snap answers TOO_BIG', tooBig.code === 'TOO_BIG', JSON.stringify(tooBig));
await sleep(200);
ok('and nothing was relayed to B', b.all('snap').length === 0, `${b.all('snap').length}`);
// A normal snapshot still works right after, i.e. the connection was not poisoned.
a.clear(); b.clear();
a.send(snapshot(50));
await b.wait('snap');
ok('a normal snapshot still flows afterwards', b.all('snap').length === 1);

// ---------------------------------------------------------------- 9
console.log('\n9. the rate bound bites');
a.clear(); b.clear();
// 60 frames back to back against a 24-burst / 12-per-sec bucket.
for (let i = 100; i < 160; i++) a.send(snapshot(i, 4));
await sleep(400);
const relayed = b.all('snap').length;
ok('the flood was throttled, not relayed', relayed > 0 && relayed <= 30, `${relayed} of 60 relayed`);
ok('and the sender was told', a.all('error').some((m) => m.code === 'RATE_LIMIT'), JSON.stringify(a.all('error')));

// ---------------------------------------------------------------- 10
console.log('\n10. a finished streamer drops its watchers');
a.clear(); b.clear();
a.send({ t: 'finished', score: 100, wave: 12, won: false });
const unwatchFin = await b.wait('unwatch');
ok('B is unwatched with reason finished', unwatchFin.id === wa.id && unwatchFin.reason === 'finished', JSON.stringify(unwatchFin));
const watchedFin = await a.wait('watched');
ok('A is told n=0 on finish', watchedFin.n === 0, JSON.stringify(watchedFin));
a.clear(); b.clear();
a.send(snapshot(200));
await sleep(200);
ok('a finished board relays nothing', b.all('snap').length === 0, `${b.all('snap').length}`);

// ---------------------------------------------------------------- 11
console.log('\n11. a watcher keeps its subscription across its OWN finish');
// A is finished; B watches nobody. Reverse the roles: B streams, A watches, then
// A finishes and must STILL be receiving B's board.
a.clear(); b.clear();
a.send({ t: 'watch', id: wb.id });
const watchingB = await a.wait('watching');
ok('A subscribes to B', watchingB.id === wb.id, JSON.stringify(watchingB));
await b.wait('watched');
a.clear(); b.clear();
b.send(snapshot(300));
await a.wait('snap');
ok('A (already finished) receives B\'s board', a.all('snap').length === 1);

// ---------------------------------------------------------------- 12
console.log('\n12. a departing target unsubscribes its watchers');
a.clear(); b.clear();
b.send({ t: 'leave' });
const unwatchLeft = await a.wait('unwatch');
ok('A is unwatched with reason left', unwatchLeft.id === wb.id && unwatchLeft.reason === 'left', JSON.stringify(unwatchLeft));

// ---------------------------------------------------------------- 13
console.log('\n13. a new round starts with no subscriptions carried over');
const c1 = await C.open('Cid');
const c2 = await C.open('Dot');
const w1 = await c1.hello();
await c2.hello();
c1.send({ t: 'create' });
const joined1 = await c1.wait('joined');
c2.send({ t: 'join', code: joined1.code });
await c2.wait('joined');
c1.send({ t: 'start' });
await c2.wait('go');
c2.send({ t: 'watch', id: w1.id });
await c2.wait('watching');
await c1.wait('watched');
c1.clear(); c2.clear();
// End the run: both finish -> `over` must clear the subscription first.
c1.send({ t: 'finished', score: 1, wave: 1, won: false });
c2.send({ t: 'finished', score: 1, wave: 1, won: false });
await c2.wait('over');
ok('`unwatch` arrived before `over`', c2.rx.findIndex((m) => m.t === 'unwatch') < c2.rx.findIndex((m) => m.t === 'over'), c2.rx.map((m) => m.t).join(','));
c1.clear(); c2.clear();
c1.send({ t: 'start' });
await c2.wait('go');
c1.clear(); c2.clear();
c1.send(snapshot(400));
await sleep(250);
ok('round 2 relays nothing without a fresh watch', c2.all('snap').length === 0, `${c2.all('snap').length}`);

// ---------------------------------------------------------------- 14
console.log('\n14. the NetClient API drives the same protocol');
const n1 = new NetClient();
const n2 = new NetClient();
const seen = { snaps: [], counts: [], watching: null, unwatch: null };
n2.onBoardSnapshot = (m) => seen.snaps.push(m);
n2.onWatching = (info) => { seen.watching = info; };
n2.onUnwatch = (info) => { seen.unwatch = info; };
n1.onWatcherCountChanged = (n, streaming) => seen.counts.push([n, streaming]);

ok('connect() resolves true', (await n1.connect(URL)) === true && (await n2.connect(URL)) === true);
n1.hello('Eve'); n2.hello('Fay');
await sleep(120);
ok('snap() is a no-op with no watchers', n1.snap({ v: 1, n: 0, c: [] }) === false);
ok('streaming is false with no watchers', n1.streaming === false);

n1.create();
await sleep(150);
n2.join(n1.code);
await sleep(150);
n1.start();
await sleep(150);
ok('both clients reached a running room', !!n1.code && n1.code === n2.code, `${n1.code} / ${n2.code}`);

n2.watch(n1.id);
await sleep(200);
ok('onWatching fired with the target name', seen.watching?.id === n1.id && seen.watching?.name === 'Eve', JSON.stringify(seen.watching));
ok('net.watching tracks the server ack', n2.watching === n1.id);
ok('onWatcherCountChanged fired 1/true', JSON.stringify(seen.counts) === '[[1,true]]', JSON.stringify(seen.counts));
ok('streaming flipped true', n1.streaming === true);

// The transport floor must pass an honest 10 Hz caller and clamp a 60 Hz one.
seen.snaps.length = 0;
let sent = 0;
for (let i = 0; i < 6; i++) { if (n1.snap(snapshot(i, 3))) sent++; await sleep(105); }
await sleep(200);
ok('a 10 Hz caller is not throttled', sent === 6, `${sent}/6 left the client`);
ok('and all six arrived', seen.snaps.length === 6, `${seen.snaps.length}`);
ok('the payload carries `from`', seen.snaps[0].from === n1.id, JSON.stringify(seen.snaps[0]?.from));

let burst = 0;
for (let i = 0; i < 60; i++) { if (n1.snap(snapshot(i, 3))) burst++; }
ok('a 60-per-tick caller is clamped by the transport', burst === 1, `${burst} of 60 left the client`);

// Drain first. The one snapshot the clamp let through is still in flight, and
// clearing the array without waiting for it makes the post-unwatch assertion
// below fail on an ordering artefact of the test rather than on a relay bug.
await sleep(200);
seen.snaps.length = 0;
n2.unwatch();
await sleep(200);
ok('onUnwatch fired', seen.unwatch?.reason === 'gone' && seen.unwatch?.id === n1.id, JSON.stringify(seen.unwatch));
ok('net.watching cleared', n2.watching === null);
ok('onWatcherCountChanged fired 0/false', JSON.stringify(seen.counts) === '[[1,true],[0,false]]', JSON.stringify(seen.counts));
ok('streaming flipped back to false', n1.streaming === false);
await sleep(150);
ok('snap() refuses to send once unwatched', n1.snap(snapshot(999, 3)) === false);
ok('and nothing more arrived', seen.snaps.length === 0, `${seen.snaps.length}`);

n1.disconnect(); n2.disconnect();

// ---------------------------------------------------------------- done
await a.close(); await b.close(); await c1.close(); await c2.close();
await srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
