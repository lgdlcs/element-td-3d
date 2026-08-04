#!/usr/bin/env node
/**
 * Visual capture harness.
 *
 *   node tools/shot.mjs --out shots/x.png --scenario midgame --w 1920 --h 1080
 *
 * Boots the game in a real GPU-backed Chromium, drives it into a deterministic
 * state via `window.__game`, waits for the frame to settle, and writes a PNG.
 * Every art/QA agent uses this so screenshots are comparable across runs.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const OUT = resolve(arg('out', 'shots/shot.png'));
const URL = arg('url', 'http://localhost:5273/');
const W = Number(arg('w', 1920));
const H = Number(arg('h', 1080));
const SCENARIO = arg('scenario', 'midgame');
const QUALITY = arg('q', 'ultra');
const SETTLE = Number(arg('settle', 2.5));

mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-frame-rate-limit',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});

const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: Number(arg('dpr', 1)),
});

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

// Neutralise Vite HMR. Several agents write source files concurrently; a hot
// reload mid-scenario silently reconstructs the game and we photograph a fresh
// board instead of the state we set up. Stubbing the client makes each capture
// a sealed snapshot of whatever was on disk when the page loaded.
await page.route('**/@vite/client', (route) =>
  route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));

await page.goto(`${URL}?q=${QUALITY}`, { waitUntil: 'load' });

// Wait for the game object to exist.
// Generous: with a cold module graph, a heavy procedural texture forge, and
// other agents writing source files while the page boots, 30s is not enough.
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// ---------------------------------------------------------------------------
// Scenarios: deterministic game states worth photographing.
// ---------------------------------------------------------------------------
await page.evaluate(async ({ scenario, settle }) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Deterministic RNG so repeat runs are pixel-comparable.
  let seed = 1337;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const giveAll = () => {
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.pendingElementPicks = 0;
    g.state.gold = 999999;
    g.hud.closeElementPicker();
    g.state.phase = 'prep';
    g.hud.refreshBuildBar();
  };

  const buildMaze = (specs) => {
    for (const [key, c, r] of specs) g.build(key, c, r);
  };

  // A hand-authored maze that looks like a real player's board.
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];

  switch (scenario) {
    case 'empty':
      g.hud.closeElementPicker();
      g.state.phase = 'prep';
      break;

    case 'picker':
      g.state.pendingElementPicks = 1;
      g.hud.openElementPicker();
      break;

    case 'earlygame':
      giveAll();
      g.state.gold = 400;
      buildMaze(MAZE.slice(0, 5));
      g.state.wave = 3;
      break;

    /**
     * THE BUILD CURSOR, which twenty scenarios could not photograph.
     *
     * The grid overlay only comes up while something is queued (Game.#updateHover
     * calls arena.setGridVisible(true) under `selectedBuild`), and not one case
     * here ever put a piece in hand — so "is the quadrillage readable" and "does
     * the 2x2 ghost read louder than the lines it sits on" had to be judged with
     * an out-of-tree probe every time. This freezes the whole cursor in one
     * frame: grid, hover ghost, range ring and the cursor hint.
     *
     * The reason it hunts for a cell instead of hardcoding one: placementReason
     * returns 'valid' (NOT 'ok'), and the answer depends on the maze that was
     * just built, so a fixed pair of coordinates would silently start
     * photographing a REFUSAL the day MAZE changes.
     */
    case 'holding': {
      giveAll();
      buildMaze(MAZE);
      g.state.gold = 4820;
      g.state.wave = 21;
      g.setBuildSelection('fire');
      let cell = null;
      for (let r = 2; r < 18 && !cell; r += 2) {
        for (let c = 2; c < 22; c += 2) {
          if (g.placementReason(c, r) === 'valid') { cell = { c, r }; break; }
        }
      }
      if (cell) {
        const p = g.grid.towerCentreToWorld(cell.c, cell.r, {});
        const V = g.camera.position.constructor;
        const v = new V(p.x, 0, p.z).project(g.camera);
        const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
        // Straight into Game's own pointer path: a synthetic pointermove is what
        // sets the hover cell, the ghost state and the range ring together.
        g.canvas.dispatchEvent(new PointerEvent('pointermove', {
          clientX: Math.round(sx), clientY: Math.round(sy), bubbles: true,
        }));
      }
      await wait(600);
      break;
    }

    /**
     * A PRIMAL AT ITS TOP LEVEL, next to ordinary towers.
     *
     * giveAll() binds each element once, and a primal needs PRIMAL.stacksRequired
     * copies of one — so no scenario could show one at all, let alone the third
     * level this round added. Built beside the normal maze on purpose: "is that
     * one an ultimate" is a question about a tower's neighbours, not about a
     * tower on an empty board.
     */
    case 'primal': {
      giveAll();
      buildMaze(MAZE.slice(0, 12));
      g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark',
        'fire', 'fire', 'light', 'light', 'water', 'water'];
      g.state.gold = 999999;
      g.hud.refreshBuildBar();
      for (const [key, c, r] of [['primal_fire', 8, 13], ['primal_light', 14, 13]]) {
        if (!g.build(key, c, r)) continue;
        const t = g.towers.towers[g.towers.towers.length - 1];
        g.towers.upgrade(t.id);
        g.towers.upgrade(t.id);
      }
      g.state.wave = 34;
      // Far enough back that the ordinary maze is in the same frame: the whole
      // question is relative size, and a close-up of a primal answers nothing.
      g.rig.focus(0, 4, 62);
      await wait(900);
      break;
    }

    case 'midgame':
    case 'combat': {
      giveAll();
      buildMaze(MAZE);
      g.state.wave = 21;
      g.state.gold = 4820;
      g.state.lives = 43;
      g.state.score = 128400;
      g.state.phase = 'combat';
      g.waves.start(22);
      await wait(3600);
      break;
    }

    case 'boss': {
      giveAll();
      buildMaze(MAZE);
      g.state.wave = 29;
      g.state.phase = 'combat';
      g.waves.start(30);
      await wait(4200);
      break;
    }

    case 'inspector': {
      giveAll();
      buildMaze(MAZE);
      const t = g.towers.towers[7];
      g.towers.upgrade(t.id);
      g.selectTower(t.id);
      g.rig.focus(t.x, t.z, 30);
      break;
    }

    case 'closeup': {
      giveAll();
      buildMaze(MAZE);
      g.state.phase = 'combat';
      g.waves.start(18);
      await wait(3200);
      const t = g.towers.towers[10];
      g.rig.focus(t.x, t.z, 22);
      g.rig._polarGoal = 0.95;
      break;
    }

    // --- creep art scenarios (appended; safe additive cases) ---------------
    case 'creepline': {
      giveAll();
      g.state.phase = 'combat';
      const types = ['swarm', 'fast', 'normal', 'armored', 'flying', 'boss'];
      const c = g.creeps;
      const made = [];
      for (let k = 0; k < types.length; k++) {
        const i = c.spawn(types[k], 1000, 10, 0);
        if (i < 0) continue;
        made.push(i);
        c.x[i] = -11 + k * 4.4;
        c.z[i] = 0;
        c.vx[i] = 0.0001; c.vz[i] = 0.0001;
        c.speed[i] = 0; c.baseSpeed[i] = 0;
        c.yaw[i] = 0.35;
        c.spawnT[i] = 1;
      }
      // Statuses across the row: damaged / frozen / burning / poisoned.
      if (made[1] !== undefined) c.hp[made[1]] = c.maxHp[made[1]] * 0.42;
      if (made[2] !== undefined) { c.applySlow(made[2], 0.6, 999); c.hp[made[2]] = c.maxHp[made[2]] * 0.7; }
      if (made[3] !== undefined) { c.applyBurn(made[3], 0.0001, 999); c.hp[made[3]] = c.maxHp[made[3]] * 0.25; }
      if (made[4] !== undefined) c.applyPoison(made[4], 0.0001, 999);
      if (made[5] !== undefined) c.hp[made[5]] = c.maxHp[made[5]] * 0.6;
      g.rig.focus(0, 0, 20);
      g.rig._polarGoal = 1.12;
      await wait(900);
      break;
    }

    case 'creepwalk': {
      giveAll();
      buildMaze(MAZE);
      g.state.phase = 'combat';
      g.waves.start(24);
      await wait(3000);
      const c = g.creeps;
      let ax = 0, az = 0, n = 0;
      for (let i = 0; i < c.capacity; i++) {
        if (!c.alive[i]) continue;
        ax += c.x[i]; az += c.z[i]; n++;
      }
      if (n) g.rig.focus(ax / n, az / n, 24);
      g.rig._polarGoal = 1.02;
      await wait(900);
      break;
    }

    case 'creepboss': {
      giveAll();
      buildMaze(MAZE);
      g.state.phase = 'combat';
      g.waves.start(30);
      await wait(4200);
      const c = g.creeps;
      for (let i = 0; i < c.capacity; i++) {
        if (c.alive[i] && c.typeKeys[c.typeIdx[i]] === 'boss') {
          c.baseSpeed[i] = 0.35;   // slow it so it stays framed while we settle
          g.rig.focus(c.x[i], c.z[i], 26);
          g.rig._polarGoal = 1.08;
          break;
        }
      }
      await wait(1400);
      break;
    }

    case 'creepstress': {
      giveAll();
      buildMaze(MAZE);
      g.state.phase = 'combat';
      const c = g.creeps;
      const types = ['normal', 'fast', 'armored', 'swarm', 'flying'];
      for (let k = 0; k < 320; k++) {
        c.spawn(types[k % types.length], 4000, 5, (k % 40) * 0.9 + Math.floor(k / 40) * 3);
      }
      await wait(2500);
      break;
    }

    // --- appended by the VFX agent; existing scenarios above are untouched ---

    // Maximum-load readability test (gate G7): every buildable cell filled with
    // an upgraded tower, all of them firing into a dense late wave at once.
    case 'barrage': {
      for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
      giveAll();
      const specs = [];
      const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark',
                    'steam', 'magma', 'ice', 'poison', 'void', 'magic',
                    'blaze', 'crystal', 'life', 'mud', 'abyss', 'gaia'];
      let n = 0;
      for (let r = 3; r <= 17 && n < 34; r += 2) {
        for (let c = 6; c <= 18 && n < 34; c += 2) {
          specs.push([keys[n % keys.length], c, r]);
          n++;
        }
      }
      buildMaze(specs);
      for (const t of g.towers.towers) { g.state.gold = 999999; g.towers.upgrade(t.id); }
      g.state.wave = 34;
      g.state.phase = 'combat';
      g.waves.start(35);
      await wait(4500);
      break;
    }

    // Freeze the sim mid-combat so transient effects can be inspected at a
    // known age. `--settle` is honoured before the freeze.
    case 'fxfreeze': {
      giveAll();
      buildMaze(MAZE);
      g.state.phase = 'combat';
      g.waves.start(26);
      await wait(3000 + settle * 1000);
      g.state.speed = 0;
      if (g.setSpeed) g.setSpeed(0);
      break;
    }

    // VFX bench: no waves, no towers. Fires one projectile per element family
    // across the board and detonates one impact of each along a row, so
    // projectile look, trail shape, impact language and decals can be judged in
    // isolation and reproducibly. `--settle` scrubs the effect age.
    // Ablation twin of 'fxlab' (appended, VFX round 2): identical, but every
    // object the VFX layer owns is hidden. Anything still on screen belongs to
    // someone else. Used to attribute artefacts to the right agent.
    case 'fxlab_noribbon':
    case 'fxlab_nopoints':
    case 'fxlab_nobillboards':
    case 'fxlab_notrail':
    case 'fxlab': {
      if (scenario === 'fxlab_noribbon') {
        g.projectiles.ribbons.mesh.visible = false;
        g.projectiles.renderer.billboards.visible = false;
        g.projectiles.renderer.rocks.visible = false;
        g.fx.muzzleRibbons.mesh.visible = false;
        g.fx.arcs.mesh.visible = false;
        g.fx.energy.points.visible = false;
        g.fx.matter.points.visible = false;
        g.fx.decals.glow.mesh.visible = false;
        g.fx.decals.mark.mesh.visible = false;
      }
      if (scenario === 'fxlab_nopoints') {
        g.fx.energy.points.visible = false;
        g.fx.matter.points.visible = false;
      }
      if (scenario === 'fxlab_nobillboards') {
        g.projectiles.renderer.billboards.visible = false;
        g.projectiles.renderer.rocks.visible = false;
      }
      if (scenario === 'fxlab_notrail') {
        g.projectiles.ribbons.mesh.visible = false;
      }
      // The boot veil can still be up when __game appears; wait it out.
      for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
      await wait(400);
      giveAll();
      g.state.phase = 'combat';
      const P = g.projectiles;
      const els = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
      const stats = {
        fire:   { damage: 1, burn: { dps: 1, dur: 3 } },
        water:  { damage: 1, slow: { amt: 0.3, dur: 2 } },
        nature: { damage: 1 },
        earth:  { damage: 1, splash: { radius: 2.8, falloff: 0.5 } },
        light:  { damage: 1, armorPen: 3 },
        dark:   { damage: 1, execute: 0.1 },
      };
      // Identity hexes, mirrored from ELEMENTS. `nature` sat at the retired
      // 0x4fe07a here for a round after the palette moved.
      const COLOR = { fire: 0xff5a1f, water: 0x2fa8ff, nature: 0x63bd76, earth: 0xc08a4a, light: 0xfff2c4, dark: 0x8a4fd6 };
      const ACC = { fire: 0xffd166, water: 0xa8e8ff, nature: 0x8ad47f, earth: 0xf0d6a8, light: 0xffffff, dark: 0xdca8ff };
      // Impacts + chain lightning are re-triggered on a loop so they are
      // guaranteed to be ~0.15s old at capture time rather than expired.
      const pulse = () => {
        for (let k = 0; k < els.length; k++) {
          g.fx.impactElemental(-15 + k * 6.0, 0.6, -9, els[k], 1.5);
          g.fx.explosion(-15 + k * 6.0, 0.6, -1, 2.6, [0.45, 0.45, 0.45], els[k]);
        }
        for (let k = 0; k < 3; k++) {
          g.fx.lightning(-9 + k * 6, 1.4, 7, -5 + k * 6, 1.6, 11, [0.9, 0.75, 0.35]);
        }
      };
      pulse();
      const pulser = setInterval(pulse, 320);
      // One clean volley, one projectile per family, so trails do not overlap.
      let tick = 0;
      const spawner = setInterval(() => {
        for (let k = 0; k < els.length; k++) {
          const e = els[k];
          P.spawn({
            x: -15 + k * 6.0, y: 3.0, z: 15,
            tx: -15 + k * 6.0, ty: 0.6, tz: -12,
            target: -1, speed: e === 'light' ? 90 : e === 'earth' ? 24 : 36,
            color: COLOR[e], accent: ACC[e], towerId: -1,
            stats: stats[e], arc: e === 'earth' ? 0.35 : 0.05,
            element: e,
          });
        }
        if (++tick > 40) { clearInterval(spawner); clearInterval(pulser); }
      }, 900);
      await wait(1100);
      break;
    }

    // Muzzle bench (appended by the VFX agent, round 2). One tower of each of
    // the six families in a row, all firing continuously at a frozen creep
    // line, camera low and close. This is the only framing in which a muzzle
    // flash can actually be judged: at default zoom it is 12 pixels wide.
    case 'muzzlelab': {
      for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
      giveAll();
      const cells = [['fire', 8, 7], ['water', 10, 7], ['nature', 12, 7],
                     ['earth', 14, 7], ['light', 16, 7], ['dark', 18, 7]];
      buildMaze(cells);
      g.state.phase = 'combat';
      const c = g.creeps;
      const held = [];
      for (const tw of g.towers.towers) {
        const i = c.spawn('armored', 4e7, 6, 0);
        if (i < 0) continue;
        held.push(i);
        c.x[i] = tw.x; c.z[i] = tw.z + 3.2;
        c.vx[i] = 0.0001; c.vz[i] = 0.0001;
        c.speed[i] = 0; c.baseSpeed[i] = 0;
        c.spawnT[i] = 1;
      }
      // Keep them pinned and immortal so the barrels never stop.
      setInterval(() => {
        for (const i of held) { if (c.alive[i]) { c.hp[i] = c.maxHp[i]; c.speed[i] = 0; } }
      }, 60);
      const t = g.towers.towers[2];
      g.rig.focus(t.x, t.z, 22);
      g.rig._polarGoal = 0.95;
      await wait(1800);
      break;
    }

    // Pure muzzle bench: no towers, no creeps, no projectiles. Six flashes,
    // one per family, fired horizontally across a row on a short loop so the
    // capture always lands on a live one. Isolates the VFX layer completely.
    case 'muzzlebench': {
      for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
      giveAll();
      g.state.phase = 'combat';
      const els = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
      const COLOR = { fire: 0xff5a1f, water: 0x2fa8ff, nature: 0x63bd76, earth: 0xc08a4a, light: 0xfff2c4, dark: 0x8a4fd6 };
      const fire = () => {
        for (let k = 0; k < els.length; k++) {
          const x = -13 + k * 5.2, y = 2.4, z = 2;
          g.fx.registerSpawnHint(x, y, z, 0.15, 0.10, -1, els[k]);
          g.fx.muzzleFlash(x, y, z, COLOR[els[k]], 1.3);
        }
      };
      fire();
      setInterval(fire, 90);
      g.rig.focus(-1, 2, 24);
      g.rig._polarGoal = 1.18;
      await wait(1200);
      break;
    }

    default:
      giveAll();
      buildMaze(MAZE);
      break;
  }

  await wait(settle * 1000);
}, { scenario: SCENARIO, settle: SETTLE });

await page.waitForTimeout(400);

// Headless Chromium software-rasterises this scene; a busy frame can take well
// over Playwright's 30s default to produce.
let buf = await page.screenshot({ type: 'png', timeout: 120000 });

/**
 * BLACK-FRAME GUARD.
 *
 * Editing a source file and capturing immediately races Vite's module-graph
 * invalidation: the page boots against a half-updated graph, a shader fails to
 * compile, and we photograph a black frame. It does NOT throw, `errors` comes
 * back empty, and the draw-call and triangle counts look completely normal — so
 * the capture is indistinguishable from a real one except by looking at it.
 * That signature is PITFALLS §9, and it silently corrupted three separate
 * measurements in one day before this guard existed.
 *
 * Retrying is the correct fix rather than sleeping longer, because the race is
 * with the dev server's own work and its duration is not knowable from here.
 */
const frameLuma = async (b) => page.evaluate(async (d) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + d;
  await img.decode();
  const cv = document.createElement('canvas');
  // 64px wide is plenty to tell "black" from "not black" and costs nothing.
  cv.width = 64; cv.height = Math.max(1, Math.round(64 * img.height / img.width));
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0, cv.width, cv.height);
  const px = cx.getImageData(0, 0, cv.width, cv.height).data;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  return s / (px.length / 4);
}, b.toString('base64'));

// The scene has never legitimately measured below ~50 mean, even in the old
// night-lit build (which sat at 56). Under 25 is a failed frame.
//
// Deliberately FAIL rather than retry. Retrying means reloading the page, and
// the scenario — 21 towers, wave 21, a live creep column — is built by this
// script before the capture. A reload silently discards all of it and hands
// back a pristine shot of an EMPTY BOARD: plausible, well-exposed, and wrong.
// That is strictly worse than a black frame, because a black frame is obvious.
// Refusing to write is the only outcome that cannot be mistaken for a result.
const meanL = await frameLuma(buf);
if (meanL < 25) {
  console.error(`\n[shot] ABORT — frame mean luminance ${meanL.toFixed(1)}: black frame.`);
  console.error('[shot] Almost always a Vite module-graph rebuild race: a source');
  console.error('[shot] file was edited moments ago, a shader failed to compile, and');
  console.error('[shot] nothing threw. Draw-call and triangle counts look normal and');
  console.error('[shot] `errors` is empty, so this is invisible downstream (PITFALLS §9).');
  console.error('[shot] Wait a few seconds and re-run. NOT overwriting ' + OUT + '.\n');
  await browser.close();
  process.exit(2);
}

writeFileSync(OUT, buf);

// Grab a perf + health sample alongside the image.
const stats = await page.evaluate(() => {
  const g = window.__game;
  const info = g.pipeline.renderer.info;
  // Where is every live creep on screen? Answers "the HUD says 8 alive, I can
  // only find two" without guessing: project each one through the live camera
  // and compare the pixel coordinates against what you can see in the PNG.
  // Also catches units rendering somewhere their simulation position says they
  // are not.
  const c = g.creeps;
  const cam = g.rig?.camera ?? g.camera;
  const creepPx = [];
  if (cam && c?._live) {
    cam.updateMatrixWorld(true);
    const V = new g.arena.group.position.constructor();
    for (let k = 0; k < c._liveCount; k++) {
      const i = c._live[k];
      V.set(c.x[i], c.y[i] + 1, c.z[i]);
      V.project(cam);
      creepPx.push({
        world: [+c.x[i].toFixed(1), +c.z[i].toFixed(1)],
        px: [Math.round((V.x * 0.5 + 0.5) * window.innerWidth),
          Math.round((-V.y * 0.5 + 0.5) * window.innerHeight)],
        type: c.typeKeys[c.typeIdx[i]],
      });
    }
  }
  return {
    creepPx,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length ?? 0,
    creeps: g.creeps.count,
    towers: g.towers.towers.length,
    phase: g.state.phase,
    wave: g.state.wave,
    gold: Math.floor(g.state.gold),
    lives: g.state.lives,
  };
});

await browser.close();

const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
console.log(JSON.stringify({ out: OUT, scenario: SCENARIO, stats, errors }, null, 2));
if (flag('strict') && errors.length) process.exit(1);
