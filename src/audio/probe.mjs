#!/usr/bin/env node
/**
 * probe.mjs — numerical verification harness for the audio stack.
 *
 *   node src/audio/probe.mjs            # full report
 *   node src/audio/probe.mjs --json     # machine readable
 *
 * We cannot listen to the game, so every cue is *measured* instead. The script
 * boots the dev server page in Chromium (so the ES modules resolve exactly as
 * they do at runtime), renders each cue through the real Mixer chain inside an
 * OfflineAudioContext, and reports peak / RMS / duration / spectral centroid.
 *
 * It also renders the music director at several intensities and a 30-voice
 * simultaneous-SFX stress test to prove the master bus cannot clip.
 */
import { chromium } from 'playwright';

const ORIGIN = process.env.AUDIO_PROBE_ORIGIN ?? 'http://localhost:5273';
// A synthetic host page on the dev-server origin. It is NOT served by Vite, so
// Vite never injects its HMR client — a concurrent file save elsewhere in the
// repo cannot full-reload the page and destroy a measurement mid-render.
// Dynamic imports of /src/audio/*.js still resolve against the real dev server.
const URL = `${ORIGIN}/__audio_probe__`;
const JSON_ONLY = process.argv.includes('--json');

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
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.route(`${ORIGIN}/__audio_probe__`, (route) => route.fulfill({
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><meta charset="utf-8"><title>audio probe</title><body>audio probe host</body>',
}));
// We only need Vite's module graph, not a running game — analysing the audio
// modules in isolation keeps the measurements free of renderer noise.
await page.goto(URL, { waitUntil: 'domcontentloaded' });

const report = await page.evaluate(async () => {
  const SR = 48000;

  // ---- analysis --------------------------------------------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function measure(buf) {
    const n = buf.length;
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const mono = new Float32Array(n);
    let peak = 0, clipped = 0, bad = 0, dcSum = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const d of chs) {
        const v = d[i];
        if (!Number.isFinite(v)) bad++;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        if (a >= 0.999) clipped++;
        s += v;
      }
      mono[i] = s / chs.length;
      dcSum += mono[i];
    }
    const dc = dcSum / n;
    // active region
    const thr = Math.max(1e-4, peak * 0.0025);
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) if (Math.abs(mono[i]) > thr) { if (first < 0) first = i; last = i; }
    if (first < 0) return { peak, rms: 0, dur: 0, centroid: 0, clipped, dc, bad, silent: true };
    let sum = 0;
    for (let i = first; i <= last; i++) sum += mono[i] * mono[i];
    const rms = Math.sqrt(sum / (last - first + 1));

    // spectral centroid, averaged over Hann-windowed frames of the active part
    const N = 4096, hop = 2048;
    let cw = 0, cnum = 0;
    for (let s = first; s + N <= last + 1; s += hop) {
      const re = new Float64Array(N), im = new Float64Array(N);
      let e = 0;
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
        re[i] = mono[s + i] * w;
        e += re[i] * re[i];
      }
      if (e < 1e-10) continue;
      fft(re, im);
      let num = 0, den = 0;
      for (let k = 1; k < N / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        num += mag * (k * SR) / N;
        den += mag;
      }
      if (den > 0) { cnum += (num / den) * e; cw += e; }
    }
    // single-frame fallback for very short cues
    if (cw === 0) {
      const N2 = 2048;
      const re = new Float64Array(N2), im = new Float64Array(N2);
      for (let i = 0; i < N2 && first + i < n; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N2 - 1));
        re[i] = mono[first + i] * w;
      }
      fft(re, im);
      let num = 0, den = 0;
      for (let k = 1; k < N2 / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        num += mag * (k * SR) / N2; den += mag;
      }
      cnum = den > 0 ? num / den : 0; cw = 1;
    }
    return {
      peak, rms, dur: (last - first) / SR, centroid: cnum / cw,
      clipped, dc, bad, silent: false,
    };
  }

  // ---- rig -------------------------------------------------------------
  const dsp = await import('/src/audio/dsp.js');
  const { Mixer } = await import('/src/audio/Mixer.js');
  const { Sfx } = await import('/src/audio/Sfx.js');
  const { Music } = await import('/src/audio/Music.js');
  const { Ambience } = await import('/src/audio/Ambience.js');
  const { AudioEngine } = await import('/src/audio/AudioEngine.js');

  function rig(ctx, vol = 0.5) {
    const mixer = new Mixer(ctx, { masterVolume: vol });
    const sfx = new Sfx(ctx, mixer);
    sfx.setNoise({
      white: dsp.makeNoise(ctx, 2, 'white'),
      pink: dsp.makeNoise(ctx, 3, 'pink'),
      brown: dsp.makeNoise(ctx, 3, 'brown'),
    });
    return { mixer, sfx };
  }

  const CUES = [
    ['build', 2.0], ['upgrade', 3.0], ['sell', 2.0], ['select', 1.0],
    ['deny', 1.5], ['death', 1.5], ['bossDeath', 5.0], ['leak', 3.5],
    ['waveStart', 3.5], ['bossHorn', 6.5], ['waveClear', 4.0],
    ['elementPick', 5.0], ['victory', 8.0], ['gameover', 9.0],
  ];
  const ELEMENTS = ['fire', 'water', 'nature', 'earth', 'light', 'dark',
    'steam', 'magma', 'ice', 'void', 'crystal', 'poison'];

  const out = { cues: {}, impacts: {}, music: {}, stress: {}, ambience: {} };

  // --- individual cues ---------------------------------------------------
  for (const [name, dur] of CUES) {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
    const { sfx } = rig(ctx);
    sfx[name](0.05);
    out.cues[name] = measure(await ctx.startRendering());
  }

  // --- element impacts (averaged over 6 renders to catch randomisation) ---
  for (const el of ELEMENTS) {
    const acc = [];
    for (let r = 0; r < 6; r++) {
      const ctx = new OfflineAudioContext(2, Math.ceil(SR * 2.5), SR);
      const { sfx } = rig(ctx);
      sfx.impact(el, 0.85, 0.05, 0);
      acc.push(measure(await ctx.startRendering()));
    }
    const avg = (k) => acc.reduce((s, a) => s + a[k], 0) / acc.length;
    out.impacts[el] = {
      peak: Math.max(...acc.map((a) => a.peak)), rms: avg('rms'),
      dur: avg('dur'), centroid: avg('centroid'),
      peakSpread: Math.max(...acc.map((a) => a.peak)) - Math.min(...acc.map((a) => a.peak)),
      durSpread: Math.max(...acc.map((a) => a.dur)) - Math.min(...acc.map((a) => a.dur)),
      clipped: acc.reduce((s, a) => s + a.clipped, 0),
      silent: acc.some((a) => a.silent),
    };
  }

  // --- music at each intensity state -------------------------------------
  for (const [label, mode, x] of [
    ['prep', 'calm', 0.12], ['rising', 'combat', 0.45],
    ['combat', 'combat', 0.72], ['heavy', 'combat', 0.95], ['boss', 'boss', 0.9],
  ]) {
    const dur = 14;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
    const { mixer, sfx } = rig(ctx);
    const music = new Music(ctx, mixer, sfx);
    music.mode = mode;
    music.setIntensity(x);
    music.renderBars(0.05, 8);
    const m = measure(await ctx.startRendering());
    out.music[label] = { ...m, bpm: music.bpm, voicing: music._voicing.slice() };
  }

  // --- harmony: does the progression actually move, with voice leading? ---
  {
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const spell = (v) => v.map((m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)).join(' ');
    out.harmony = {};
    for (const mode of ['calm', 'combat', 'boss']) {
      const ctx = new OfflineAudioContext(2, SR * 2, SR);
      const { mixer, sfx } = rig(ctx);
      const music = new Music(ctx, mixer, sfx);
      music.mode = mode;
      music.setIntensity(mode === 'boss' ? 0.9 : 0.5);
      const bars = [];
      let t = 0.02;
      let prev = null;
      let motion = 0, unisons = 0, crossings = 0;
      for (let b = 0; b < 8; b++) {
        t = music.renderBars(t, 1);
        const v = music._voicing.slice();
        if (prev) for (let i = 0; i < v.length; i++) motion += Math.abs(v[i] - prev[i]);
        for (let i = 1; i < v.length; i++) {
          if (v[i] === v[i - 1]) unisons++;
          if (v[i] < v[i - 1]) crossings++;
        }
        bars.push(spell(v));
        prev = v;
      }
      out.harmony[mode] = {
        bars,
        avgVoiceMotionSemitones: motion / (7 * 3),
        unisons, crossings,
      };
    }
  }

  // --- ducking: is the music actually pushed down under a big cue? -------
  {
    // Both renders must be sample-identical apart from the duck, otherwise we
    // are measuring the per-note randomisation instead of the ducker.
    const realRandom = Math.random;
    const seeded = () => {
      let s = 20260728;
      return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    };
    const render = async (withDuck) => {
      Math.random = seeded();
      const ctx = new OfflineAudioContext(2, SR * 4, SR);
      const { mixer, sfx } = rig(ctx);
      const music = new Music(ctx, mixer, sfx);
      music.mode = 'combat';
      music.setIntensity(0.8);
      music.renderBars(0.02, 4);
      if (withDuck) mixer.duck(0.55, 0.04, 1.4, 1.0);
      const buf = await ctx.startRendering();
      // RMS of the window just after the duck lands
      const d = buf.getChannelData(0);
      const win = (t0, t1) => {
        const a = Math.floor(SR * t0), b = Math.floor(SR * t1);
        let s = 0;
        for (let i = a; i < b; i++) s += d[i] * d[i];
        return Math.sqrt(s / (b - a));
      };
      return { deep: win(1.06, 1.2), avg: win(1.1, 1.6), recovered: win(2.4, 3.0) };
    };
    const dry = await render(false);
    const ducked = await render(true);
    Math.random = realRandom;
    out.duck = {
      deepDb: 20 * Math.log10(ducked.deep / dry.deep),
      avgDb: 20 * Math.log10(ducked.avg / dry.avg),
      recoveredDb: 20 * Math.log10(ducked.recovered / dry.recovered),
    };
  }

  // --- ambience bed -------------------------------------------------------
  {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * 12), SR);
    const { mixer, sfx } = rig(ctx);
    const amb = new Ambience(ctx, mixer, sfx);
    amb.start(0);
    amb.event(2.0, 'resonance');
    amb.event(6.0, 'rumble');
    out.ambience = measure(await ctx.startRendering());
  }

  // --- stress: 30 simultaneous SFX + music + ambience, master at 1.0 -----
  for (const [label, vol] of [['default(0.5)', 0.5], ['max(1.0)', 1.0]]) {
    const dur = 6;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
    const { mixer, sfx } = rig(ctx, vol);
    const music = new Music(ctx, mixer, sfx);
    music.mode = 'boss';
    music.setIntensity(1);
    music.renderBars(0.02, 4);
    const amb = new Ambience(ctx, mixer, sfx);
    amb.start(0);
    // 30 impacts inside one 40 ms frame — the pathological case
    let played = 0;
    for (let i = 0; i < 30; i++) {
      const el = ELEMENTS[i % ELEMENTS.length];
      sfx.impact(el, 1, 0.5 + (i % 4) * 0.008, (i / 30) * 2 - 1);
      played++;
    }
    // plus the loudest one-shots landing on the same beat
    sfx.bossHorn(0.5, 0);
    sfx.leak(0.55, 0);
    sfx.bossDeath(0.6, 0);
    sfx.waveStart(0.52, 0);
    for (let i = 0; i < 12; i++) sfx.death(0.5 + i * 0.01, 0);
    out.stress[label] = { ...measure(await ctx.startRendering()), voices: played + 16 };
  }

  // --- apocalypse: literally every cue in the game on the same sample ----
  {
    const dur = 10;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
    const { mixer, sfx } = rig(ctx, 1.0);
    const music = new Music(ctx, mixer, sfx);
    music.mode = 'boss';
    music.setIntensity(1);
    music.renderBars(0.02, 6);
    const amb = new Ambience(ctx, mixer, sfx);
    amb.start(0);
    amb.event(0.5, 'rumble'); amb.event(0.5, 'resonance');
    for (const [name] of CUES) sfx[name](0.5);          // all 14 cues at once
    for (let i = 0; i < 60; i++) {                       // 60 impacts at once
      sfx.impact(ELEMENTS[i % ELEMENTS.length], 1, 0.5 + (i % 3) * 0.004, (i / 60) * 2 - 1);
    }
    out.stress.apocalypse = {
      ...measure(await ctx.startRendering()),
      voices: CUES.length + 60 + 2,
    };
  }

  // --- does the voice budget actually cull, and does priority win? -------
  {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const { mixer } = rig(ctx);
    // 200 equal-priority requests inside one instant: only `budget` may pass.
    let lowAccepted = 0;
    for (let i = 0; i < 200; i++) if (mixer.acquire(2, 0.5)) lowAccepted++;
    // now a high-priority cue arrives with the bus completely full
    const highAccepted = mixer.acquire(9, 1.0);
    // and a second low-priority one must now be refused
    const lowAfter = mixer.acquire(1, 0.5);
    // throttling: same cue twice in the same instant
    const thrFirst = mixer.throttle('probe', 0.05);
    const thrSecond = mixer.throttle('probe', 0.05);

    // and end-to-end through the engine, with distinct cue names so the
    // per-element throttle cannot mask the budget
    const ctx2 = new OfflineAudioContext(2, SR * 2, SR);
    const eng = new AudioEngine({ context: ctx2, volume: 0.5 });
    let engAccepted = 0;
    for (let i = 0; i < 200; i++) {
      const n = eng.mixer._voices.length;
      eng.playImpact(ELEMENTS[i % ELEMENTS.length], 0.9);
      if (eng.mixer._voices.length > n) engAccepted++;
    }
    out.budget = {
      budget: mixer._budget,
      lowAccepted, highAccepted, lowAfterFull: lowAfter,
      throttleFirst: thrFirst, throttleSecond: thrSecond,
      engineRequested: 200, engineAccepted: engAccepted,
    };
    eng.dispose();
  }

  // --- API surface check --------------------------------------------------
  {
    const ctx = new OfflineAudioContext(2, SR * 3, SR);
    const eng = new AudioEngine({ context: ctx, volume: 0.5 });
    const names = ['build', 'upgrade', 'sell', 'select', 'deny', 'death', 'bossDeath',
      'leak', 'waveStart', 'bossHorn', 'waveClear', 'elementPick', 'victory', 'gameover'];
    const errs = [];
    for (const n of names) { try { eng.play(n); } catch (e) { errs.push(`${n}: ${e.message}`); } }
    try { eng.setVolume(0.3); eng.setVolume(1); } catch (e) { errs.push(`setVolume: ${e.message}`); }
    try { eng.play('nonexistent-cue'); } catch (e) { errs.push(`unknown cue threw: ${e.message}`); }
    try { eng.playImpact('fire', 0.5); eng.playShot('water', 0.4); } catch (e) { errs.push(`impact: ${e.message}`); }
    out.api = { errors: errs, ok: errs.length === 0 };
    eng.dispose();
  }

  return out;
});

// ---------------------------------------------------------------------------
// Live check: the offline renders prove the DSP, but not that the engine
// actually arms on a gesture and self-drives inside the real game. This runs
// the real page, clicks once to satisfy the autoplay policy, fires every cue,
// and confirms the music scheduler is advancing on its own.
// ---------------------------------------------------------------------------
const live = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const liveLogs = [];
live.on('console', (m) => liveLogs.push(`[${m.type()}] ${m.text()}`));
live.on('pageerror', (e) => liveLogs.push(`[pageerror] ${e.message}`));
await live.goto(`${ORIGIN}/`, { waitUntil: 'load' });
await live.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await live.mouse.click(640, 760);           // the gesture that arms audio
await live.waitForTimeout(400);

const liveReport = await live.evaluate(async () => {
  const a = window.__game.audio;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap0 = { step: a.music?._step, ctx: a.ctx?.state };
  for (const n of ['build', 'upgrade', 'sell', 'select', 'deny', 'death', 'bossDeath',
    'leak', 'waveStart', 'bossHorn', 'waveClear', 'elementPick']) {
    a.play(n); await wait(90);
  }
  for (let i = 0; i < 40; i++) { a.playImpact(['fire', 'water', 'nature', 'earth', 'light', 'dark'][i % 6], Math.random()); }
  await wait(1500);
  return {
    ctxState: a.ctx?.state,
    ctxTimeAdvanced: a.ctx.currentTime > 0,
    schedulerRunning: (a.music?._step ?? 0) > (snap0.step ?? 0),
    stepsScheduled: a.music?._step,
    musicIntensity: a.music?.intensity,
    musicMode: a.music?.mode,
    ambienceRunning: !!a.ambience?._timer,
    voicesLive: a.mixer?._voices.length,
    voiceBudget: a.mixer?._budget,
    before: snap0,
  };
});
await browser.close();

const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
const liveErrors = liveLogs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
report.live = liveReport;
report.liveErrors = liveErrors;

if (JSON_ONLY) {
  console.log(JSON.stringify({ report, errors }, null, 2));
} else {
  const f = (v, d = 3) => (v == null ? '—' : Number(v).toFixed(d));
  const row = (n, m) => `${n.padEnd(14)} ${f(m.peak).padStart(7)} ${f(m.rms, 4).padStart(8)} ${f(m.dur, 2).padStart(7)}s ${Math.round(m.centroid).toString().padStart(7)} Hz ${m.clipped ? ` CLIP:${m.clipped}` : ''}${m.silent ? ' SILENT!' : ''}${m.bad ? ` NaN:${m.bad}` : ''}${Math.abs(m.dc ?? 0) > 0.01 ? ` DC:${f(m.dc)}` : ''}`;
  const head = `${'cue'.padEnd(14)} ${'peak'.padStart(7)} ${'rms'.padStart(8)} ${'dur'.padStart(8)} ${'centroid'.padStart(10)}`;

  console.log('\n=== GAME CUES (master @ 0.5) ===\n' + head);
  for (const [n, m] of Object.entries(report.cues)) console.log(row(n, m));

  console.log('\n=== ELEMENT IMPACTS (6 renders each, intensity 0.85) ===\n' + head + '   peakSpread durSpread');
  for (const [n, m] of Object.entries(report.impacts)) {
    console.log(row(n, m) + `  ${f(m.peakSpread).padStart(9)} ${f(m.durSpread, 2).padStart(8)}s`);
  }

  console.log('\n=== MUSIC (8 bars per intensity state) ===\n' + head + '   bpm  voicing');
  for (const [n, m] of Object.entries(report.music)) {
    console.log(row(n, m) + `  ${f(m.bpm, 1)}  [${m.voicing.join(',')}]`);
  }

  console.log('\n=== AMBIENCE (12 s) ===\n' + head);
  console.log(row('ambience', report.ambience));

  console.log('\n=== STRESS: 30 impacts + 4 big cues + 12 deaths + music + ambience ===\n' + head);
  for (const [n, m] of Object.entries(report.stress)) console.log(row(n, m) + `  voices=${m.voices}`);

  console.log('\n=== HARMONY (8 bars, spelled) ===');
  for (const [mode, h] of Object.entries(report.harmony)) {
    console.log(`${mode}: ${h.bars.map((b, i) => `${i + 1}|${b}`).join('  ')}`);
    console.log(`   avg voice motion ${f(h.avgVoiceMotionSemitones, 2)} semitones/chord, unisons=${h.unisons}, crossings=${h.crossings}`);
  }

  console.log('\n=== DUCKING (music level vs. an identical un-ducked render) ===');
  console.log(`deepest ${f(report.duck.deepDb, 2)} dB | avg over 0.5 s ${f(report.duck.avgDb, 2)} dB | recovered by 2.4 s ${f(report.duck.recoveredDb, 2)} dB`);

  console.log('\n=== VOICE BUDGET ===');
  console.log(JSON.stringify(report.budget));
  console.log('\n=== PUBLIC API ===');
  console.log(JSON.stringify(report.api));
  console.log('\n=== LIVE (real game page, armed by a real click) ===');
  console.log(JSON.stringify(report.live, null, 2));
  console.log('live errors: ' + JSON.stringify(report.liveErrors));
  console.log('\n=== PAGE ERRORS ===');
  console.log(JSON.stringify(errors, null, 2));
}
