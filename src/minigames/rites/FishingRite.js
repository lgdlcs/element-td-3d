/**
 * FISHING — "pêche". A lake at dawn, seen side-on, and four anglers on one water.
 *
 * Lucas asked for "the same principle as the hunt, but with fishermen and fish",
 * and that is what this is: the same competitive rule (every fish carries a
 * pre-drawn deadline with a rival's name on it; land it first or lose it) with
 * the same 20-second clock. What it is NOT is the same GAME, and the whole design
 * of this file is one decision made to keep it from becoming one.
 *
 * THE VERB IS THE WHOLE DESIGN. `hunt` is a REACTION shot — the animal is there,
 * you shoot it, and the only variable is how fast your hand is. `fishing` is a
 * LEADING shot. You do not shoot; you CAST. A click drops a hook at the pointer,
 * it sinks for SINK seconds, and it catches whatever it overlaps AT THE MOMENT IT
 * LANDS — not on the way down. The fish never stop moving. So the question the
 * player answers is not "where is it" but "where will it be in 0.35 s", and that
 * is a different mental act from a reflex, executed with a different rhythm.
 * Without this split, two of the eleven rites in a run are the same game with
 * different sprites, which is the single largest design risk in this batch.
 *
 * THE LEAD HAS TO BE A PER-FISH QUANTITY, AND FOR A LONG TIME IT WAS NOT. This
 * is the correction the rest of the file is built around. With a speed band only
 * 1.7x wide and a catch ellipse half a unit across, the required lead ran from
 * 0.70 to 1.19 units across the entire shoal — a spread one window could swallow
 * whole. A bot that simply cast a FIXED 1.2 units ahead of every nose, with no
 * model of velocity at all, scored 1.00 / 1.00 / 0.96 against 1.00 / 1.00 / 1.00
 * for one computing the exact landing position. The rite asked you to read the
 * water and then accepted a number you had memorised in your first four casts.
 * The band is 2.6x wide now (SPEED_MIN..SPEED_MAX) and stratified, so every run
 * contains the slowest fish and the fastest and fourteen spaced between, and no
 * single offset covers them: the best constant available at wave 3 scores about
 * 0.76 and by wave 53 about 0.42. `tests/unit/fishing-rite.test.js` measures that
 * player rather than trusting this paragraph.
 *
 * EVERYTHING VISUAL IN HERE SERVES THAT ONE MECHANIC. A lead you cannot see is a
 * guess, and guessing is not anticipation — it is a coin flip with extra steps.
 * So fish velocity is rendered as a first-class quantity rather than as
 * decoration: every fish trails a wake whose length is EXACTLY the distance it
 * covers during one sink, so the mnemonic is "cast one wake ahead of the nose".
 * The dashed ghost that draws the answer outright is a TUTORIAL and is spent
 * after three casts (GHOST_CASTS) — rendered forever it does not teach the lead,
 * it replaces it, and the player's act collapses into "click the dashed circle".
 *
 * WHAT IS SCARCE, WHICH FOR A LONG TIME WAS NOTHING. A rite with no scarce
 * resource has no difficulty curve, and this one measured a flat 1.00 from wave 3
 * to wave 53 because the cast cycle was 0.65 s against a rival claim every
 * 1.35 s: thirty casts chased sixteen fish, so a player could waste two thirds of
 * them and still clear a par set at 55 % of the water. Three things bind now, and
 * all three tighten with the wave — the water runs out sooner (CLAIM_SQUEEZE),
 * a cast costs more of the clock (REEL_WAVE), and par is two thirds of everything
 * swimming rather than half of it (PAR_FRACTION). At wave 53 the lake is empty by
 * about seventeen seconds and an empty cast costs a tenth of that.
 *
 * WHY THE SINK IS A CONSTANT AND NOT A FUNCTION OF DEPTH. Physically, a lure
 * takes longer to reach the bottom. Mechanically, that would make the required
 * lead a different number for every lane FOR A REASON THE PLAYER CANNOT SEE, and
 * the rite would reward arithmetic rather than reading the water. The lead
 * already varies per fish — it varies with the thing the wake draws. One constant
 * commitment window is what makes the wake readable as an answer at all.
 *
 * WHY A SINKING LURE DOES NOT CATCH WHAT IT PASSES THROUGH. It would look like a
 * bug if a hook fell straight through a fish, so the lure is drawn CLOSED — a
 * streamlined sinking weight — and visibly snaps open at the settle, with a ring.
 * It is not fishing until it stops. That is a drawing solving a rules problem,
 * and it is cheaper than the alternative (a swept-volume test), which would also
 * have quietly turned the leading shot back into a reaction shot.
 *
 * NO DOM (beyond one guarded getComputedStyle for the palette), NO THREE, NO
 * Math.random — the unit suite imports this in node.
 */

import { MINIGAMES } from '../../core/Config.js';
import { mulberry32 } from '../../core/Rng.js';
import { FIELD, clamp } from '../contract.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';

/** The host's fixed step. Only used to interpolate `draw`; never to advance logic. */
const DT = MINIGAMES.dt;

// ---- the lake -------------------------------------------------------------

/** Waterline, in world units. Above it: dawn sky and four boats. Below: the game. */
const SURFACE = 1.2;
/** Silt. Nothing swims below it and no cast lands under it. */
const FLOOR = -4.15;
/**
 * The band fish are drawn into, inset from both so a body never clips either.
 *
 * SHALLOW sits a clear margin under the deepest TROUGH the waterline can reach
 * (SURFACE - SURFACE_AMP = 0.90), because the surface is no longer a straight
 * line in the picture: the shoal is masked by the wavy waterline itself rather
 * than by a rectangle at SURFACE, and a fish whose back reaches the trough would
 * be sliced by its own water. Top of the tallest fish is
 * SHALLOW + BOB + LEN_MAX*0.17 = 0.30 + 0.20 + 0.15 = 0.65.
 */
const SHALLOW = 0.3;
const DEEP = -3.7;
/**
 * Horizontal wrap span, wider than the field on purpose.
 *
 * Fish glide off one edge and back in from the other two units later, so the
 * shoal reads as passing THROUGH the frame rather than bouncing inside it — and
 * a fish that has just left is a fish the player can watch coming back, which is
 * the only reason to ever look at the edges.
 */
const SPAN = FIELD.w + 4;

// ---- the cast -------------------------------------------------------------

/** Seconds from click to settle. THE constant the whole rite is built on. */
const SINK = 0.45;
/**
 * Seconds of reeling after a cast that caught NOTHING, at wave 3.
 *
 * Longer than `hunt`'s 0.45 s recoil, deliberately: a cast is a slower, more
 * committed act than a trigger pull and the punishment should match the gesture.
 * With SINK it makes an empty cycle 1.05 s against a landed one's 0.65 s, so a
 * player who sprays gets roughly two thirds of the attempts of one who reads the
 * water. That gap IS the anti-mash rule; there is no ammunition limit here
 * because the reel already is one, expressed in the fiction instead of in a
 * counter.
 *
 * BOTH REELS ARE NOW A FUNCTION OF THE WAVE (see `REEL_WAVE`), and that is the
 * repair of the rite's central flaw. At a flat 0.7/0.3 the cast cycle was 0.65 s
 * against a rival claim rate of 1.35 s — twice as fast as the deadline that was
 * supposed to be pressuring it — so THIRTY casts chased sixteen fish and a
 * player could miss two thirds of them and still clear par. Nothing in the rite
 * was scarce, and a rite with nothing scarce has no wave curve, which is exactly
 * what the calibration harness measured: a flat 1.00 from wave 3 to wave 53.
 */
const REEL_EMPTY = 0.7;
/** Seconds of reeling after a catch, at wave 3. Shorter — the fish is coming to you. */
const REEL_HELD = 0.3;
/**
 * How much longer both reels take at wave 53 than at wave 3.
 *
 * THE SCARCITY KNOB. At 0.85 the held cycle goes 0.65 s -> 0.90 s and the empty
 * one 1.05 s -> 1.65 s, against a claim rhythm that `CLAIM_SQUEEZE` tightens the
 * other way at the same time. The two together are what turn the NUMBER OF CASTS
 * into the binding constraint: at wave 53 the water empties in about twelve
 * seconds and a cast costs a tenth of that, so a wasted one is a fish somebody
 * else lands. It is applied to the reel rather than to the hit window on purpose
 * — a shrinking window is difficulty you discover by missing, a lengthening reel
 * is difficulty you watch fill up on the rod before you commit.
 */
const REEL_WAVE = 0.35;
/**
 * How far the rivals' claim schedule is compressed by wave 53.
 *
 * `SeededRivals` moves its own deadlines by only ~0.43 s across the whole run
 * (`pressure` 0.42 -> 0.78 against CLAIM_URGENCY 1.2), which is nothing next to
 * a 1.35 s spacing — so the field was, in practice, the same field at wave 53 as
 * at wave 3. rivals.js is explicit that a rite wanting a different rhythm
 * "scales the RESULT", and this is that scale: at wave 53 the whole schedule
 * runs at 0.6x, so the sixteenth fish is gone by ~12.8 s instead of ~21.4 s and
 * the lake is a shorter, faster thing than the clock. The ORDER is untouched, so
 * `claimant(i)` still names the angler the source dealt.
 */
const CLAIM_SQUEEZE = 0.2;
/** The lure's own radius, added to a fish's catch ellipse. */
const HOOK_R = 0.15;
/**
 * Half-height of the catch ellipse, as a multiple of the fish's length.
 *
 * DELIBERATELY TALLER THAN THE DRAWN FISH (which is LEN*0.17 to the back), and
 * the asymmetry is the point. The horizontal half-width is what the leading shot
 * is measured against — widen it and a single memorised offset starts covering
 * the whole speed band, which is exactly how this rite lost its subject. The
 * VERTICAL tolerance costs the lead nothing: depth is a thing the player can
 * read at leisure off the gradient, and being punished for a quarter-unit of
 * mouse tremor on an axis the rite is not about is noise, not difficulty. So the
 * window is narrow where the game is and generous where it is not.
 */
const RY_K = 0.36;

// ---- the water's stock ----------------------------------------------------

const FISH = 16;
/**
 * ctx.rand() draws per fish. A CONSTANT, never a function of the wave.
 *
 * The five are: start offset within its stratum, depth, speed magnitude,
 * direction, and body length. The bob phase is NOT drawn — it is derived from
 * the fish's index by the golden angle, which decorrelates sixteen sine waves
 * for free and costs nothing from the budget.
 */
const PER_FISH = 5;
/**
 * The speed band, and it is WIDE on purpose — 2.6x from the slowest fish to the
 * fastest, where it used to be 1.7x.
 *
 * THIS IS WHAT MAKES THE LEAD A PER-FISH QUANTITY RATHER THAN A HABIT. With a
 * narrow band the required lead was 0.70..1.19 units across the whole shoal, and
 * a catch ellipse half a unit wide swallowed that spread whole: a bot that
 * simply cast a FIXED 1.2 units ahead of every nose, with no idea how fast
 * anything was swimming, scored 1.00 / 1.00 / 0.96. The rite claimed to be about
 * reading velocity and was in fact about remembering one number.
 *
 * At 1.95..5.0 the lead spans 0.68..1.75 units at wave 3 and 1.23..3.15 at wave
 * 53 — several ellipse-widths of spread — so no single offset covers the shoal
 * and the player has to look at the wake of the fish they actually chose.
 */
const SPEED_MIN = 2.0;
const SPEED_MAX = 6.0;
const LEN_MIN = 0.5;
const LEN_MAX = 0.8;
/**
 * How far a fish rises and falls. Four times what it was, and it is mechanics
 * rather than decoration now.
 *
 * At 0.09 units the vertical component of the lead was worth 0.03 units against
 * a catch ellipse 0.30 tall — invisible, which is why a bot aiming at
 * `fishY(f, t) + 0.25` scored 1.00 at every wave. The lead was a purely
 * horizontal habit with a free y. At 0.20 a fish moves up to 0.17 units
 * vertically during one sink against a half-height of 0.24, so WHERE IT WILL BE
 * is a point and not a column. Still small against the 4-unit water column, so
 * depth stays the thing the eye reads first.
 */
const BOB = 0.2;
/**
 * A fish must out-swim its own catch ellipse during one sink, or aiming AT it
 * would work and the rite would silently collapse back into `hunt`. Worst case
 * is the longest, slowest fish: LEN_MAX/2 + HOOK_R = 0.56 units of ellipse
 * against SPEED_MIN * SINK = 0.6825 units of travel. It holds by 0.12 units at
 * the hardest corner of the distribution, and
 * `tests/unit/fishing-rite.test.js` asserts the inequality rather than trusting
 * this comment.
 */
const GOLD_VALUE = 3;
/**
 * The golden fish is forced into the middle of the index range.
 *
 * Index also sets the deadline (see `claimAt`), so a golden fish at index 0 is
 * gone before the player has read the water and one at index 15 is never
 * contested at all — 3 points of pure variance decided by one rand() draw, in
 * either direction. Confining it to indices 4..11 keeps it worth roughly two
 * seconds of committed play on every seed.
 */
const GOLD_LO = 4;
const GOLD_SPAN = 8;

const RIVALS = 3;
const DURATION = 20;
/**
 * The bar, as a fraction of everything in the water.
 *
 * 68 % of (15 plain + one golden at 3x) = 12.24 points. It was 55 % = 9.9, and
 * that number was decoration: a perfect run lands 12 to 13 fish for 14 to 15
 * points, so the bar was cleared with a third of the water still swimming and
 * the top of the range could not be played toward. At 68 % the ceiling costs a
 * near-flawless run at wave 3 and is out of reach by wave 53, which is the shape
 * the calibration gate asks every rite for.
 *
 * NOT higher than that, and the constraint is the gate's own: flawless play must
 * still clear 0.75 at wave 53, where the squeezed claim schedule and the long
 * reel between them cap even the oracle bot at about ten points.
 */
const PAR_FRACTION = 0.66;
const PAR = PAR_FRACTION * (FISH - 1 + GOLD_VALUE);

/** Fixed-size presentation pools. Written in update, read in draw, never grown. */
const RIPPLES = 12;
const WAVELETS = 9;
const MOTES = 7;
/** Cue queue cap. The host drains every frame; this is the seatbelt, not the plan. */
const MAX_EVENTS = 32;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 * FISH * PER_FISH  = 80  the shoal
 *                 +  1   which fish is golden
 *                 + 12   RIVALS * PER_RIVAL, consumed inside SeededRivals
 *                 +  1   the seed for this rite's private presentation generator
 *                 = 94
 *
 * The last one is the rule from docs/MINIGAMES.md §3 and it is worth restating:
 * cosmetic noise may NOT come from ctx.rand() directly, because the moment a
 * particle count or a wavelet phase is drawn from it, the number of draws starts
 * depending on the quality preset — and every value drawn after that point
 * differs between two players in the same room.
 */
const RAND_CALLS = FISH * PER_FISH + 1 + RIVALS * PER_RIVAL + 1;

/** Fish life cycle. Small integers so a snapshot of the instance stays readable. */
const SWIMMING = 0;
const KEPT = 1;
const LOST = 2;

/** How long the settled lure lingers on screen for its snap-open, in seconds. */
const SETTLE_HOLD = 0.18;

/**
 * How many casts the lead ghost is shown for. THREE, then it is gone for good.
 *
 * The ghost draws the exact answer — a dashed outline at `fishX(f, t + SINK)` —
 * for the fish nearest the pointer. Rendered on every free frame it does not
 * teach the lead, it REPLACES it: the player's act stops being "read how fast
 * that fish is going" and becomes "click the dashed circle", and the wake, the
 * chevron and the whole velocity-as-a-first-class-quantity argument at the top
 * of this file are decoration around a solved problem.
 *
 * Three casts is what the docblock always claimed the WAKE was worth ("a player
 * learns that in three casts and never unlearns it"). So the ghost now spends
 * exactly that budget and hands the job back to the drawing that was built for
 * it. It is a tutorial, and a tutorial that never ends is a UI.
 */
const GHOST_CASTS = 3;

/**
 * Total swing of the waterline, peak to trough, in world units.
 *
 * FIXED rather than emergent: the nine wavelet amplitudes are normalised to sum
 * to half of this at init, so the surface can be relied on to stay inside
 * SURFACE +- SURFACE_AMP. Two things depend on that being a NUMBER and not a
 * hope — the shoal is masked by the real wavy line rather than by a rectangle at
 * SURFACE (which is what used to leave a straight step across a swinging
 * waterline), and SHALLOW is placed clear of the deepest trough.
 */
const SURFACE_AMP = 0.3;

/** Where the anglers stand. Uneven on purpose — an evenly spaced row reads as UI. */
const PLAYER_X = -0.2;
const RIVAL_X = Object.freeze([-6.5, -3.6, 4.8]);

/** '#6cc3dd' | 'rgb(108,195,221)' -> '108,195,221'. Painter.halo wants bare channels. */
function rgbOf(css, fallback) {
  const s = String(css || '').trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `${m[1]},${m[2]},${m[3]}`;
  return fallback;
}

/** '108,195,221' -> [108, 195, 221]. The numeric twin of every rgbOf above. */
function chan(bare) {
  const p = String(bare).split(',');
  return [+p[0] || 0, +p[1] || 0, +p[2] || 0];
}

/**
 * Lerp two channel triples. Returns a triple, so mixes compose.
 *
 * THE WHOLE SHOAL IS PAINTED THROUGH THIS FUNCTION AND THAT IS A BUG FIX, not a
 * refactor. A fish used to be five separately-TRANSLUCENT shapes — tail, dorsal,
 * body, belly, eye — each stacking its own alpha, so the fish scalloped: the
 * tail root and the dorsal read as lighter patches inside the silhouette, and
 * two fish crossing produced a visibly brighter lens where they overlapped. At
 * sixteen fish a frame that is not a fish, it is a pile of glass.
 *
 * The falloff the critique liked — deep fish are dimmer, and distance is legible
 * without a label — is the same falloff; it is just expressed as a COLOUR mixed
 * toward the water at that depth instead of as an alpha. Opaque shapes cannot
 * stack, so a fish is one solid animal at every depth and two fish crossing look
 * like two fish crossing.
 */
function lerp3(a, b, k) {
  const u = k < 0 ? 0 : k > 1 ? 1 : k;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** A triple as the bare channels every rgba() and halo() in this file wants. */
function bare(c) { return `${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])}`; }

class FishingRite {
  init(ctx) {
    this.wave = ctx.wave;
    this.hw = ctx.width / 2;
    this.hh = ctx.height / 2;
    this.quality = ctx.quality;

    this.t = 0;
    this.points = 0;
    this.kept = 0;
    this.lost = 0;
    this.casts = 0;
    this.empties = 0;
    this.goldKept = false;

    /** The hook in flight, or null. One at a time — the line is the resource. */
    this.hook = null;
    /** Seconds on the rite clock before which no new cast is accepted. */
    this.readyAt = 0;
    /** Length of the reel currently running, so the bar in draw has a denominator. */
    this.reelSpan = REEL_HELD;
    /** How many casts the tutorial ghost is still shown for. See #drawGhost. */
    this.ghostCasts = GHOST_CASTS;
    /** Last moment a cast was refused, for the "still reeling" pulse in draw. */
    this.deniedAt = -9;

    /**
     * Difficulty, from the wave, applied to the NUMBERS and never to the number
     * of draws (docs/MINIGAMES.md §3). Same saturating shape as
     * SeededRivals.pressure, and for the same reason: wave 53 should be hard,
     * not arithmetically impossible.
     */
    const press = clamp((ctx.wave - 3) / 50, 0, 1);
    this.speedMul = 1 + 0.4 * press;
    /**
     * THE THREE WAVE KNOBS, and the two new ones are the ones that bite.
     *
     * `speedMul` is the old one and it was never enough on its own: a faster
     * fish is a longer lead, and a player who reads the wake pays nothing for
     * it. What it does cost is the moment your eye leaves the water — a stale
     * read is worth twice as many units at wave 53 as at wave 3 — so it stays,
     * as the LEGIBILITY tax rather than as the difficulty curve.
     *
     * `reelHeld` / `reelEmpty` are the difficulty curve. They make the number of
     * casts in twenty seconds fall from ~30 to ~18, and an empty one from a
     * twentieth of the run to a twelfth of it.
     *
     * `claimScale` is the deadline. Together the three say the same sentence
     * three ways: at wave 53 there is less water, it is gone sooner, and you get
     * fewer chances at it.
     */
    this.reelHeld = REEL_HELD * (1 + REEL_WAVE * press);
    this.reelEmpty = REEL_EMPTY * (1 + REEL_WAVE * press);
    this.claimScale = 1 - CLAIM_SQUEEZE * press;
    // The bar on the rod needs a denominator before the first cast resolves.
    this.reelSpan = this.reelHeld;
    /**
     * How murky the water is. THE ONE WAVE KNOB THAT IS PURELY A DRAWING.
     *
     * "Thinning the shallows" used to be a real one — the wave emptied the top
     * 35 % of the water column — and it was the single reason this rite got
     * EASIER as the run went on. Sixteen fish squeezed into two thirds of the
     * column is a shoal a third denser, and a sloppy cast in a dense shoal
     * blunders into a neighbour. The calibration harness read that as a score
     * rising from 0.743 at wave 3 to 0.962 at wave 53, which is the difficulty
     * curve running backwards.
     *
     * So the DEPTH distribution is now wave-invariant by construction (see the
     * stratification below) and the wave spends itself on murk instead: a deeper
     * fish is drawn against darker water at wave 53 than at wave 3, so reading
     * its velocity — the thing the player is actually aiming at — takes longer.
     *
     * STATED PLAINLY BECAUSE IT MATTERS FOR THE NUMBERS: the calibration bot
     * cannot see this. Its brain is an oracle and reads `fishX` directly, so
     * murk costs it nothing, and every calibration figure for this rite is
     * therefore an upper bound on what a human scores — the same limitation
     * `helpers/reference-player.js` records for `platforms`. The three knobs
     * above are the ones the instrument can measure, and they are the ones the
     * curve is tuned on.
     */
    this.murk = 0.42 * press;

    // ---- the one and only draw, in a fixed order -------------------------
    /** @type {Array<{x0:number,v:number,depth:number,len:number,bobP:number,bobW:number,gold:boolean,state:number,endAt:number}>} */
    this.fish = [];
    const stride = SPAN / FISH;
    for (let i = 0; i < FISH; i++) {
      // Stratified start positions: one fish per SPAN/FISH slice, jittered
      // inside it. A free uniform over the whole span clumps visibly at n=16 —
      // three fish nose to tail and a bare quarter of the lake — and a lake with
      // a bare quarter is a lake where a third of the player's casts have no
      // legal target. Same number of draws, better water.
      const x0 = -SPAN / 2 + (i + ctx.rand()) * stride;
      const u = ctx.rand();
      // Depth is stratified exactly the way x is, and for a stronger reason
      // than "it looks better": a free uniform lets the column's density wander
      // with the seed, and density is what decides whether a near-miss cast
      // blunders into a neighbouring fish. A rite whose forgiveness is a
      // property of the draw cannot be calibrated. Sixteen strata, one fish
      // each, jittered inside — the same water depth-wise on every seed and at
      // every wave.
      //
      // The stratum is `i * 7 % FISH` rather than `i`, and the 7 is doing real
      // work: the INDEX also sets the deadline (see `claimAt`), so a stratum
      // that followed the index would mean the shallowest fish is always the
      // first one the rivals take, and the water would visibly drain from the
      // top down. 7 is coprime with 16, so it visits all sixteen strata and
      // decorrelates depth from deadline for free.
      const band = ((i * 7) % FISH) + u;
      const depth = SHALLOW - (band / FISH) * (SHALLOW - DEEP);
      // SPEED IS STRATIFIED TOO, and this one is the rite's whole subject.
      // The lead is `|v| * SINK`, so the speed multiset IS the set of questions
      // the water asks. Drawn free, a seed could deal sixteen fish inside half a
      // unit of each other's lead and the run would be a rite where one number
      // works all afternoon — the exact failure the widened band exists to
      // prevent. Stratified, every run contains the slowest fish, the fastest
      // fish, and fourteen spaced between, so "read this one" is always a real
      // question and the wake is always worth looking at. Same coprime trick as
      // the depth, with a different step so speed and depth are not the same
      // permutation wearing two hats.
      const sp = SPEED_MIN + ((((i * 5) % FISH) + ctx.rand()) / FISH) * (SPEED_MAX - SPEED_MIN);
      // Which way it swims: the Thue-Morse sequence on the index, so the shoal
      // is exactly eight fish each way on EVERY seed. Drawn free, a seed could
      // send thirteen of sixteen the same way, and a one-directional shoal is a
      // rite where the lead is a habit again — always to the right. Thue-Morse
      // rather than `i % 2` because x is stratified BY INDEX, so alternating
      // would draw a comb; this one is balanced without being periodic.
      const dir = ((i ^ (i >> 1) ^ (i >> 2) ^ (i >> 3)) & 1) ? -1 : 1;
      const len = LEN_MIN + ((((i * 3) % FISH) + ctx.rand()) / FISH) * (LEN_MAX - LEN_MIN);
      this.fish.push({
        x0,
        v: dir * sp * this.speedMul,
        depth,
        len,
        // Golden angle: sixteen phases that never line up, for zero draws.
        bobP: i * 2.399963229728653,
        // The draw the direction no longer needs. The bob rate has to stay
        // decorrelated from the bob phase or the shoal breathes in unison, and
        // a free uniform is a better decorrelator than `i % 5` was.
        bobW: 1.3 + ctx.rand() * 1.1,
        gold: false,
        state: SWIMMING,
        /** When it left the water, for the fade. -9 while it is still swimming. */
        endAt: -9,
      });
    }

    this.goldIndex = GOLD_LO + Math.floor(ctx.rand() * GOLD_SPAN);
    const gf = this.fish[this.goldIndex];
    gf.gold = true;
    gf.len = Math.min(LEN_MAX, gf.len * 1.15);
    // The prize is worth 3x, so it must not also be the easiest thing in the
    // lake: a golden fish that dawdles is a free 3 points for a player who
    // happened to look at it. It swims in the top fifth of the range — not AT
    // the maximum, which with the widened speed band would put it a full three
    // units ahead of its own nose and make it a different rite from the shoal.
    gf.v = Math.sign(gf.v) * (SPEED_MIN + 0.8 * (SPEED_MAX - SPEED_MIN)) * this.speedMul;

    /**
     * The other three anglers.
     *
     * The claim schedule is drawn HERE and frozen: this rite never calls
     * applyPenalty (there is no verb in fishing that slows a rival down), so
     * `claimTime(i)` can never change after init and caching it costs nothing
     * while removing 48 arithmetic ops per step from the claim sweep.
     */
    this.rivals = new SeededRivals(ctx.rand, { count: RIVALS, wave: ctx.wave });
    this.roster = this.rivals.roster();
    this.claimAt = new Float64Array(FISH);
    /**
     * Whose name goes on fish i — the same schedule, read the other way.
     *
     * `claimTime(i)` is the field's best time at fish `i` and `claimant(i)` is
     * the angler who posted it; they are the min and the argmin of one array, so
     * the number and the name cannot drift apart. This used to be `i % RIVALS`,
     * a round-robin over the roster — which the previous docblock defended as
     * "the rule is the number, the name is paint", true at the time and still
     * the wrong shape: the source published no claimant, so every fish was
     * genuinely taken by the same angler and the display said otherwise.
     */
    this.claimBy = new Int8Array(FISH);
    for (let i = 0; i < FISH; i++) {
      // SCALED, not replaced. `claimTime(i)` is still the field's best time at
      // fish i and `claimant(i)` is still whoever posted it; the wave only
      // decides how fast the whole afternoon runs. Compressing the schedule
      // cannot reorder it, so the name over a fish is the source's answer.
      this.claimAt[i] = this.rivals.claimTime(i) * this.claimScale;
      const who = this.rivals.claimant(i);
      this.claimBy[i] = who ? who.id : -1;
    }
    /** Per-rival counters and the last time each one flashed a claim. */
    this.tally = new Int32Array(RIVALS);
    this._flash = new Float64Array(RIVALS).fill(-9);

    // ---- presentation, from ONE seeded generator, consumed ONLY here -----
    // Called in init and never again. A generator advanced from draw() would be
    // state mutated by a method the contract says must not mutate state, and it
    // would produce a different picture depending on how many frames the host
    // happened to render — the definition of a heisenbug.
    const fx = mulberry32(Math.floor(ctx.rand() * 0xffffffff) >>> 0);
    this._wave = [];
    for (let i = 0; i < WAVELETS; i++) {
      this._wave.push({ k: 0.7 + fx() * 2.4, p: fx() * 6.283, a: 0.03 + fx() * 0.05, s: 0.4 + fx() * 0.9 });
    }
    // Normalise the swing. Nine free amplitudes summed to anywhere between 0.27
    // and 0.72 depending on the seed, so "how far the waterline moves" was a
    // property of the draw — and every piece of geometry that has to clear the
    // surface (SHALLOW, the sky mask, the shoal's own clip) was sized against a
    // guess. Now it is SURFACE_AMP on every seed and the shapes stay put.
    let amp = 0;
    for (const w of this._wave) amp += w.a;
    for (const w of this._wave) w.a *= SURFACE_AMP / amp;
    this._mote = [];
    for (let i = 0; i < MOTES; i++) {
      this._mote.push({ x: (fx() * 2 - 1) * this.hw, y: DEEP + fx() * (SHALLOW - DEEP), r: 0.03 + fx() * 0.05, s: 0.1 + fx() * 0.25 });
    }
    this._rip = [];
    for (let i = 0; i < RIPPLES; i++) this._rip.push({ x: 0, y: 0, t0: -9, kind: 0 });
    this._ripAt = 0;

    /** Pointer, remembered from update so draw never touches an input record. */
    this._px = 0;
    this._py = 0;
    this._pin = false;

    /** @type {Array<{type:string,x?:number,y?:number}>} */
    this._events = [{ type: 'start' }];

    this.pal = this.#readPalette();
  }

  /**
   * Design tokens, once, off the document element — the Lottery.js:722 pattern.
   *
   * A canvas cannot resolve `var(--gold)`, and reading them per frame is a
   * forced style recalc sixty times a second for values that never move.
   *
   * THE PREFIXED NAMES ARE NOT A STYLE CHOICE. `--rite-accent` is generic and is
   * declared inside `#rite[data-rite="fishing"]`, an element a rite never sees;
   * reading it off the document element missed and the literal fallback painted.
   * The three colours this rite owns live on `:root` as `--rite-fishing-accent`,
   * `--rite-fishing-deep` and `--rite-fishing-shelf` instead, and the theme block
   * aliases the first of them into `--rite-accent` for the chrome. Retuning the
   * water is now one edit in ui/minigames.css and it moves both surfaces.
   *
   * The literals below stay as FALLBACKS, not as the shipping values: this
   * module is imported by a vitest suite whose environment is `node`, where
   * there is no stylesheet and bare `document` is a ReferenceError.
   */
  #readPalette() {
    const cs = (typeof getComputedStyle === 'function' && typeof document !== 'undefined')
      ? getComputedStyle(document.documentElement) : null;
    const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
    const accent = tok('--rite-fishing-accent', '#6cc3dd');
    const rAccent = rgbOf(accent, '108,195,221');
    const rGold = rgbOf(tok('--gold', '#e5bd79'), '229,189,121');
    const rInk = rgbOf(tok('--ink', '#e9ebf3'), '233,235,243');
    const rDeep = rgbOf(tok('--rite-fishing-deep', '#03070c'), '3,7,12');
    const rShelf = rgbOf(tok('--rite-fishing-shelf', '#0b2233'), '11,34,51');
    return {
      ink: tok('--ink', '#e9ebf3'),
      ink2: tok('--ink-2', '#a3a9bb'),
      ink3: tok('--ink-3', '#6d7488'),
      ink4: tok('--ink-4', '#4a5064'),
      gold: tok('--gold', '#e5bd79'),
      goldHi: tok('--gold-hi', '#f7dfae'),
      line: tok('--line-2', 'rgba(255,255,255,0.14)'),
      // Bare channels, because that is what halo() and every rgba() below want.
      rAccent, rGold, rInk, rDeep, rShelf,
      // And the numeric twins, because the shoal is painted by MIXING colours
      // rather than by stacking alphas — see lerp3.
      nAccent: chan(rAccent),
      nGold: chan(rGold),
      nInk: chan(rInk),
      nDeep: chan(rDeep),
      nShelf: chan(rShelf),
    };
  }

  // ---- the water, as pure functions of time -------------------------------

  /**
   * Fish `f`'s x at rite-time `t`. PURE, and that is load-bearing three times
   * over: the catch test evaluates it at the exact landing instant (which falls
   * between two steps), `draw` evaluates it at a sub-step interpolated time, and
   * the test file evaluates it a step ahead to build a leading shot. A stored,
   * per-step-integrated position could not answer any of those questions.
   */
  fishX(f, t) {
    const u = f.x0 + f.v * t + SPAN / 2;
    return ((u % SPAN) + SPAN) % SPAN - SPAN / 2;
  }

  /** Fish `f`'s y at `t`. The bob is small on purpose — depth must stay readable. */
  fishY(f, t) {
    return f.depth + BOB * Math.sin(f.bobW * t + f.bobP);
  }

  /** Where the hook will be if it lands now, for the ghost and for the tests. */
  leadX(f, t) { return this.fishX(f, t + SINK); }

  /**
   * Does a hook resting at (hx, hy) overlap fish `f` at time `t`?
   *
   * An ellipse rather than a circle because a fish is four times longer than it
   * is tall, and a circular window either forgives a miss above the back or
   * refuses a hit at the nose. The ellipse traces the silhouette that is drawn,
   * so what the player sees is what the rules test — the only version of a hit
   * box worth having.
   *
   * The wrap is handled by testing the three images of the fish (left, centre,
   * right). Without it a fish straddling the seam is uncatchable on one side of
   * itself, which is a bug that only appears for a few hundred milliseconds per
   * lap and would be blamed on the player's aim.
   */
  overlaps(f, t, hx, hy) {
    const rx = f.len * 0.5 + HOOK_R;
    const ry = f.len * RY_K + HOOK_R;
    const fy = this.fishY(f, t);
    const dy = (hy - fy) / ry;
    if (dy * dy > 1) return false;
    const fx = this.fishX(f, t);
    for (let k = -1; k <= 1; k++) {
      const dx = (hx - (fx + k * SPAN)) / rx;
      if (dx * dx + dy * dy <= 1) return true;
    }
    return false;
  }

  // ---- the step -----------------------------------------------------------

  update(dt, input) {
    this.t += dt;

    if (input.inside) { this._px = input.x; this._py = input.y; }
    this._pin = !!input.inside;

    // 1. CASTS. `clicks` and not `action`, and not `input.x/y`: the queue carries
    //    the position captured at the press, while input.x is wherever the
    //    pointer has drifted to by the end of the step. In a rite whose entire
    //    subject is WHERE you committed, reading the drifted position would
    //    credit the cast to a spot the player never chose. Button 0 and button 2
    //    are the same verb here, and a Space/Enter commit arrives as a click at
    //    the last pointer position — three inputs, one gesture, no platform
    //    handicapped by the trackpad's two-finger settle delay.
    const clicks = input.clicks;
    if (clicks && clicks.length) {
      for (let i = 0; i < clicks.length; i++) {
        if (this.hook || this.t < this.readyAt) { this.deniedAt = this.t; break; }
        const c = clicks[i];
        // COPY the two numbers. The records are pooled and refilled on the next
        // pointerdown (contract.js), so a stored reference would silently start
        // reporting a later shot's coordinates mid-sink.
        const hx = clamp(c.x, -this.hw + 0.2, this.hw - 0.2);
        const hy = clamp(c.y, FLOOR + 0.15, SURFACE - 0.2);
        this.hook = { x: hx, y: hy, t0: this.t, landAt: this.t + SINK, hit: -1 };
        this.casts++;
        if (this.ghostCasts > 0) this.ghostCasts--;
        this.#ripple(hx, SURFACE, 0);
        this._push({ type: 'tick', x: hx });
        // Exactly one cast per step, however many clicks arrived. The extras are
        // not queued for later either: a mashed burst is one cast and the rest
        // is noise, which is the whole point of an anti-mash rule.
        break;
      }
    }

    // 2. THE HOOK SETTLES. Resolved BEFORE the claim sweep, and the catch test
    //    additionally compares the exact landing instant against the exact
    //    deadline. Either alone would be right; both together mean the answer
    //    cannot depend on which side of a 16.6 ms boundary the two times fell,
    //    and a rite whose outcome depends on step alignment is a rite two
    //    players on one seed can disagree about.
    if (this.hook) {
      // `settledAt` is the latch. Without it the same hook re-resolves on every
      // step of its linger — one cast quietly eating the whole shoal, while the
      // counter that would give it away (`casts`) still reads 1.
      if (this.hook.settledAt == null && this.t >= this.hook.landAt) this.#settleHook();
      if (this.hook.settledAt != null && this.t >= this.hook.settledAt + SETTLE_HOLD) this.hook = null;
    }

    // 3. THE RIVALS TAKE THEIRS.
    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      if (f.state !== SWIMMING || this.t < this.claimAt[i]) continue;
      f.state = LOST;
      f.endAt = this.t;
      this.lost++;
      const who = this.claimBy[i];
      if (who >= 0) { this.tally[who]++; this._flash[who] = this.t; }
      const fx = this.fishX(f, this.claimAt[i]);
      this.#ripple(fx, SURFACE, 2);
      this._push({ type: 'claim', x: fx });
    }

    // 4. THE END. Nothing cosmetic is integrated here: ripples, wakes and the
    //    lure are pure functions of (t - t0), which is why draw can be skipped
    //    entirely on a zero-sized canvas (docs/MINIGAMES.md §5) without the
    //    picture desynchronising from the simulation on the next frame.
    if (this.t >= DURATION) return true;
    // An empty lake ends the rite early rather than making the player watch a
    // clock run out over water they have already cleared.
    if (this.kept + this.lost >= FISH && !this.hook) return true;
    return false;
  }

  /** Resolve the settled lure against the shoal. One fish per cast, the nearest. */
  #settleHook() {
    const h = this.hook;
    const tl = h.landAt;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      if (f.state !== SWIMMING) continue;
      // STRICT `<`. The player wins by being early, never by tying — and a tie
      // is unreachable anyway, since `landAt` is a multiple of 1/60 plus SINK
      // and a deadline is a sum of irrational-looking seeded constants.
      if (!(tl < this.claimAt[i])) continue;
      if (!this.overlaps(f, tl, h.x, h.y)) continue;
      const d = Math.hypot(this.fishX(f, tl) - h.x, this.fishY(f, tl) - h.y);
      if (d < bestD) { bestD = d; best = i; }
    }

    if (best >= 0) {
      const f = this.fish[best];
      f.state = KEPT;
      f.endAt = tl;
      this.kept++;
      this.points += f.gold ? GOLD_VALUE : 1;
      if (f.gold) this.goldKept = true;
      h.hit = best;
      this.#ripple(h.x, h.y, f.gold ? 3 : 1);
      this._push({ type: f.gold ? 'perfect' : 'good', x: h.x });
      this.reelSpan = this.reelHeld;
    } else {
      this.empties++;
      this.#ripple(h.x, h.y, 4);
      this._push({ type: 'miss', x: h.x });
      this.reelSpan = this.reelEmpty;
    }
    this.readyAt = tl + this.reelSpan;
    // Latched, and kept on screen a moment longer so draw can show the
    // snap-open. Cleared by update, not here.
    h.settledAt = tl;
  }

  /** Write into the ripple ring. Fixed length; the oldest is simply overwritten. */
  #ripple(x, y, kind) {
    const r = this._rip[this._ripAt];
    r.x = x; r.y = y; r.t0 = this.t; r.kind = kind;
    this._ripAt = (this._ripAt + 1) % RIPPLES;
  }

  _push(ev) { if (this._events.length < MAX_EVENTS) this._events.push(ev); }

  // ---- the picture --------------------------------------------------------

  /**
   * MUST NOT MUTATE. Every value read below is either instance state written by
   * `update`, a module constant, or a pure function of `t` — including the
   * fish, the hook and the ripples. The only allocation is the seven-point
   * silhouette per visible fish, which is deliberate: a shared scratch buffer
   * would be state, and state mutated from draw is exactly what this rule
   * exists to forbid. Sixteen seven-element arrays a frame is nothing on a 2D
   * overlay whose frame is fragment-bound elsewhere (docs/PERF_BUDGET.md).
   */
  draw(g, alpha = 0) {
    const t = this.t + alpha * DT;
    const P = this.pal;
    const hw = this.hw, hh = this.hh;

    // The waterline, once. It is the top edge of the water, the mask over the
    // shoal and the line that gets stroked, and all three have to be THE SAME
    // CURVE or the picture tells three stories about where the water is. It used
    // to tell exactly that: the water was a rectangle at SURFACE, the shoal was
    // clipped to the same rectangle, and only the stroked line actually swung —
    // so a straight step ran across a moving waterline.
    const lip = this.#surfacePoints(t, hw);

    this.#drawSky(g, t, P, hw, hh);
    this.#drawWater(g, t, P, hw, lip);

    // Everything alive is clipped to the water. The clip is a rectangle at the
    // deepest TROUGH the surface can reach rather than at SURFACE, which is what
    // makes it invisible: the water above it is real water on every frame, so
    // the straight edge can never be the thing you see. SHALLOW is placed to
    // clear it (see its docblock), so nothing is actually cut off.
    const lid = SURFACE - SURFACE_AMP;
    g.clipRect(0, (FLOOR + lid) / 2, FIELD.w, lid - FLOOR, () => {
      this.#drawMotes(g, t, P);
      // The boats' underwater halves, INSIDE the water and UNDER the shoal.
      // They used to be drawn after the clip closed, which painted three
      // translucent hull reflections straight over any shallow fish that
      // happened to be passing — the one place in the rite where scenery could
      // hide the game.
      for (let i = 0; i < this.roster.length; i++) this.#drawWet(g, t, P, RIVAL_X[i] ?? 0, 0.55, false);
      this.#drawWet(g, t, P, PLAYER_X, 1, true);
      this.#drawShoal(g, t, P);
      this.#drawHook(g, t, P);
    });

    this.#drawSurface(g, t, P, lip);
    this.#drawAnglers(g, t, P);
    this.#drawHud(g, P, hw, hh);
  }

  /**
   * The waterline as a point list, left to right. Allocated per frame and never
   * stored — a cached one would be state written by `draw`, which the contract
   * forbids, and it would be wrong the moment the host resized.
   */
  #surfacePoints(t, hw) {
    const pts = [];
    const N = this.quality === 'low' ? 24 : 64;
    for (let i = 0; i <= N; i++) {
      const x = -hw + (FIELD.w * i) / N;
      pts.push([x, SURFACE + this.#surfaceY(x, t)]);
    }
    return pts;
  }

  #drawSky(g, t, P, hw, hh) {
    // Dawn: cold at the zenith, warm where it meets the water. The gradient runs
    // the full height of the sky band so the horizon glow lands exactly on the
    // waterline and the two halves of the picture share one light source.
    g.rect(0, (SURFACE + hh) / 2, FIELD.w, hh - SURFACE, {
      fill: g.linearFill(0, hh, 0, SURFACE, [
        [0, `rgba(${P.rDeep},1)`],
        [0.55, `rgba(${P.rShelf},0.85)`],
        [0.88, `rgba(${P.rAccent},0.28)`],
        [1, `rgba(${P.rGold},0.30)`],
      ]),
    });
    // The sun, low and half-drowned. Additive so it reads as light rather than
    // as a disc of paint sitting on the sky.
    const sx = -hw * 0.52;
    g.save().add();
    g.halo(sx, SURFACE + 0.35, 3.4, P.rGold, 0.16, 0.34);
    g.circle(sx, SURFACE + 0.42, 0.34, { fill: `rgba(${P.rGold},0.5)` });
    g.restore();
  }

  #drawWater(g, t, P, hw, lip) {
    // The water is a POLYGON whose top edge is the waterline itself, not a
    // rectangle at SURFACE with a stroked squiggle laid over it. One shape, one
    // edge, and the light on the surface is the same light the water is filled
    // with — which is the difference between a lake and a blue panel with a wire
    // on top of it.
    //
    // Depth is one gradient. This is what `linearFill` is for and the reason it
    // is worth the one hole in Painter's "no raw context" guarantee: the
    // alternative, twenty stacked translucent bands, banks visibly at exactly
    // the depths a player is trying to read a fish through.
    const body = lip.slice();
    body.push([hw, FLOOR - 0.9], [-hw, FLOOR - 0.9]);
    g.poly(body, {
      fill: g.linearFill(0, SURFACE, 0, FLOOR, [
        [0, `rgba(${P.rAccent},0.34)`],
        [0.18, `rgba(${P.rShelf},0.92)`],
        [0.62, `rgba(${P.rDeep},0.96)`],
        [1, `rgba(${P.rDeep},1)`],
      ]),
    });
    // Silt shelf, so the bottom of the frame is a floor and not an edge.
    g.rect(0, FLOOR - 0.35, FIELD.w, 0.9, { fill: `rgba(${P.rShelf},0.55)` });
    // Two slow shafts from the low sun.
    //
    // GRADIENTS, NOT FLAT POLYGONS. A hard-edged grey wedge at a constant alpha
    // does not read as light through water; it reads as a compositing error, and
    // that is exactly what it was being mistaken for. A shaft in a lake is
    // brightest where it enters and gone before the bottom, and it has no edge
    // at all — so each one is drawn three times, at three widths, each fading to
    // nothing by the halfway mark. Three cheap polygons buy a falloff in both
    // axes without a mask.
    if (this.quality !== 'low') {
      g.save().add();
      for (let i = 0; i < 2; i++) {
        const x = -hw * 0.5 + i * 3.1 + Math.sin(t * 0.13 + i) * 0.4;
        for (let k = 0; k < 3; k++) {
          const w = 1.0 + k * 0.8;
          g.poly([[x, SURFACE], [x + w, SURFACE], [x + w + 1.4, FLOOR], [x + 0.2, FLOOR]], {
            fill: g.linearFill(0, SURFACE, 0, FLOOR * 0.55, [
              [0, `rgba(${P.rAccent},${(0.030 - k * 0.008).toFixed(3)})`],
              [1, `rgba(${P.rAccent},0)`],
            ]),
          });
        }
      }
      g.restore();
    }
  }

  #drawMotes(g, t, P) {
    // Suspended silt drifting up. Seven of them, seeded once. Their only job is
    // to prove the water is a volume — without something between the camera and
    // the fish, "deeper" reads as "darker" and nothing else.
    for (const m of this._mote) {
      const y = DEEP + (((m.y - DEEP) + m.s * t) % (SHALLOW - DEEP));
      g.circle(m.x + Math.sin(t * 0.4 + m.x) * 0.12, y, m.r, { fill: `rgba(${P.rInk},0.07)` });
    }
  }

  #drawShoal(g, t, P) {
    // Which fish gets the explicit lead ghost: the one nearest the pointer.
    // ONE, never sixteen — sixteen ghosts is a screen full of arrows and the
    // player stops reading any of them.
    let ghost = -1;
    if (this._pin && !this.hook && this.ghostCasts > 0) {
      let bd = 2.6;
      for (let i = 0; i < FISH; i++) {
        const f = this.fish[i];
        if (f.state !== SWIMMING) continue;
        const d = Math.hypot(this.fishX(f, t) - this._px, this.fishY(f, t) - this._py);
        if (d < bd) { bd = d; ghost = i; }
      }
    }

    // TWO PASSES, and the reason is the opaque paint. A wake is now solid water
    // colour rather than a translucent smear, so a wake drawn after a fish would
    // occlude it. Every wake first, every body second: the shoal is a single
    // layer of animals over a single layer of trails, which is also how it reads
    // — the trails belong to the water, the fish are in front of it.
    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      if (f.state !== SWIMMING) continue;
      const x = this.fishX(f, t);
      this.#drawWake(g, P, f, x, this.fishY(f, t), Math.abs(f.v) * SINK, this.#vis(f));
    }

    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      const gone = f.state !== SWIMMING;
      // A fish that left fades over 0.45 s rather than blinking out, so the
      // player can see WHERE they lost it and connect it to the name that just
      // flashed on a boat.
      const age = gone ? t - f.endAt : 0;
      if (gone && age > 0.45) continue;
      const fade = gone ? clamp(1 - age / 0.45, 0, 1) : 1;
      const x = this.fishX(f, t);
      const y = this.fishY(f, t);

      this.#drawFish(g, t, P, f, x, y, fade, gone, age);
      if (!gone) this.#drawContest(g, t, P, i, x, y);
      if (i === ghost) this.#drawGhost(g, t, P, f);
    }
  }

  /**
   * How strongly a fish stands out from the water it is in, 0..1.
   *
   * THE RITE'S DIFFICULTY, AS A SINGLE NUMBER, and it is the number the whole
   * shoal is coloured through. Two terms:
   *
   *  - depth. A fish at the surface is nearly full accent, one on the silt is
   *    mostly water. This is the falloff that makes distance legible without a
   *    label, and it is the reason the rite can put sixteen fish on screen and
   *    still have a foreground.
   *  - murk, which is the wave (see `init`). It bites on DEEP fish only: the
   *    shallows at wave 53 look like the shallows at wave 3 and the bottom of
   *    the lake goes quiet, so the water the player can still read shrinks as
   *    the run goes on. A flat darkening would just be a dimmer screen.
   *
   * Floored at 0.16 rather than at 0, because a fish you cannot see at all is
   * not difficulty, it is a fish that is not in the game.
   */
  #vis(f) {
    const clarity = clamp((f.depth - DEEP) / (SHALLOW - DEEP), 0, 1);
    return clamp((0.30 + 0.66 * clarity) * (1 - this.murk * (1 - clarity)), 0.16, 1);
  }

  /** The water's own colour at depth `y` — what a fish is mixed toward. */
  #waterAt(y) {
    const k = clamp((SURFACE - y) / (SURFACE - FLOOR), 0, 1);
    return lerp3(this.pal.nShelf, this.pal.nDeep, clamp((k - 0.18) / 0.44, 0, 1));
  }

  /**
   * The wake: three tapering dashes behind the tail, spanning EXACTLY `lead`
   * world units — the distance this fish covers in one sink.
   *
   * This is the core readability device of the whole rite and the reason it is
   * measured rather than decorative. A wake drawn "long for fast fish" tells the
   * player something vague; a wake drawn one sink long tells them the answer,
   * in the unit they need it, without a number on screen: cast one wake ahead
   * of the nose. A player learns that in three casts and never unlearns it —
   * which is the whole reason the explicit ghost is now spent after three casts
   * (see GHOST_CASTS) and this drawing is left holding the job it was built for.
   *
   * IT IS TIED TO `vis`, THE SAME NUMBER THE FISH IS, and that is a bug fix. The
   * wake used to keep its own alpha while a deep fish fell to a quarter of its
   * own, which left `> - - -` marks floating in empty black water — debris,
   * pointing at nothing. A wake is never more visible than the animal making it
   * now, and it is drawn in mixed water colour rather than a translucent smear,
   * so three dashes are three dashes instead of three overlapping panes.
   */
  #drawWake(g, P, f, x, y, lead, vis) {
    const back = -Math.sign(f.v);
    const tail = x + back * f.len * 0.55;
    const water = this.#waterAt(y);
    for (let k = 0; k < 3; k++) {
      const s = tail + back * lead * (k / 3);
      const e = tail + back * lead * ((k + 0.72) / 3);
      g.capsule(s, y, e, y, 0.04 * (1 - k * 0.22), {
        fill: `rgb(${bare(lerp3(water, P.nAccent, vis * (0.55 - k * 0.15)))})`,
      });
    }
    // A chevron on the nose, opening backwards. Direction at a glance, for a
    // fish too deep to read a silhouette on.
    const n = x - back * f.len * 0.5;
    g.poly([[n + back * -0.17, y + 0.14], [n, y], [n + back * -0.17, y - 0.14]],
      { close: false, stroke: `rgb(${bare(lerp3(water, P.nAccent, vis * 0.7))})`, width: 0.04 });
  }

  /**
   * One fish: blob body, two fins, an eye. Mirrored, never rotated, for
   * legibility.
   *
   * EVERY SHAPE IS OPAQUE. See `lerp3` for why; the short version is that five
   * translucent overlapping shapes make a fish that visibly comes apart into
   * parts, and two of them crossing make a bright lens where they meet. Depth is
   * carried by the COLOUR each shape is mixed to, so the tail is darker than the
   * body because it is nearer the water's colour, not because you can see
   * through it. The only alpha in here is the 0.45 s fade of a fish that has
   * already left the game.
   */
  #drawFish(g, t, P, f, x, y, fade, gone, age) {
    const L = f.len;
    const H = L * 0.34;
    const water = this.#waterAt(y);
    const vis = this.#vis(f);
    const base = f.gold ? P.nGold : P.nAccent;
    // Gold is a PRIZE and is allowed to cheat the depth falloff — it is the one
    // thing in the lake the player is meant to spot from across the frame.
    const skin = lerp3(water, base, f.gold ? Math.max(vis, 0.72) : vis);
    const fin = lerp3(water, base, (f.gold ? Math.max(vis, 0.72) : vis) * 0.55);
    const edge = lerp3(skin, P.nInk, 0.30);

    g.save();
    if (fade < 1) g.alpha(fade);
    g.translate(x, y);
    // Mirror rather than rotate: a rotated fish at 180 deg has its eye and
    // dorsal on the wrong side, and a fish swimming upside down is the sort of
    // thing nobody notices in review and everybody notices in play. |scale| is
    // 1 on both axes, so the pen stays circular (see Painter.ellipse's note).
    if (f.v < 0) g.scale(-1, 1);
    // A little pitch from the bob, so the shoal is not sixteen horizontal lines.
    g.rotate(Math.cos(f.bobW * t + f.bobP) * 0.10);

    if (f.gold) { g.save().add(); g.halo(0, 0, L * 1.9, P.rGold, 0.22, 0.4); g.restore(); }

    // Tail fin first, so the body's outline reads over its root.
    g.poly([[-L * 0.40, 0], [-L * 0.66, H * 0.85], [-L * 0.58, 0], [-L * 0.66, -H * 0.85]],
      { fill: `rgb(${bare(fin)})` });
    g.poly([[L * 0.04, H * 0.5], [-L * 0.10, H * 1.05], [-L * 0.24, H * 0.45]],
      { fill: `rgb(${bare(fin)})` });

    g.blob([
      [L * 0.50, 0],
      [L * 0.18, H * 0.62],
      [-L * 0.16, H * 0.55],
      [-L * 0.42, H * 0.22],
      [-L * 0.42, -H * 0.22],
      [-L * 0.16, -H * 0.55],
      [L * 0.18, -H * 0.62],
    ], {
      fill: `rgb(${bare(skin)})`,
      stroke: `rgb(${bare(edge)})`,
      width: 0.03,
    });

    // Belly highlight and eye — two marks, and between them the fish has a
    // front. Without them a blob is a leaf.
    g.ellipse(-L * 0.02, -H * 0.30, L * 0.26, H * 0.26, 0, { fill: `rgb(${bare(lerp3(skin, P.nInk, 0.22))})` });
    g.circle(L * 0.32, H * 0.16, 0.055, { fill: `rgb(${bare(lerp3(skin, P.nDeep, 0.85))})` });
    g.restore();

    // The take: a bright ring where a fish was lifted out.
    if (gone && f.state === KEPT) {
      const k = clamp(age / 0.45, 0, 1);
      g.circle(x, y, 0.3 + k * 1.1, { stroke: `rgba(${f.gold ? P.rGold : P.rInk},${((1 - k) * 0.5).toFixed(3)})`, width: 0.05 });
    }
  }

  /**
   * The contest bracket: which fish a rival is about to take, and how soon.
   *
   * Without it the fish simply vanish and the player learns nothing from losing
   * one. With it, the pressure is visible a second and a half out and the choice
   * "chase the contested one or take the safe one" actually exists.
   */
  #drawContest(g, t, P, i, x, y) {
    const left = this.claimAt[i] - t;
    if (left <= 0 || left > 1.6) return;
    const k = 1 - left / 1.6;
    const w = 0.55 + this.fish[i].len * 0.6 - k * 0.3;
    // NOT faded by depth, unlike everything else in the water. Depth is a
    // legibility cost the rite charges for reading VELOCITY; a deadline is not a
    // thing you squint at, it is a thing you are told, and a bracket you cannot
    // see on a deep fish is a fish that vanishes without warning.
    const c = `rgba(${P.rGold},${(0.3 + 0.55 * k).toFixed(3)})`;
    for (const s of [-1, 1]) {
      g.poly([[x + s * w, y - 0.30], [x + s * (w + 0.14), y - 0.30], [x + s * (w + 0.14), y + 0.30], [x + s * w, y + 0.30]],
        { close: false, stroke: c, width: 0.04 });
    }
  }

  /**
   * The lead ghost: a dashed outline of the fish at the position the hook would
   * actually reach it. Shown for one fish, the one under the pointer, FOR THE
   * FIRST THREE CASTS ONLY.
   *
   * The last clause is the correction. Rendered forever, this is not the rite
   * explaining itself — it is the rite playing itself. It draws the exact answer
   * the rules are computed from, on every free frame, and the player's act
   * collapses from "read how fast that one is going" to "click the dashed
   * circle". Everything else in this file that renders velocity — the wake sized
   * to one sink, the chevron, the widened speed band — is then decoration around
   * a solved problem, and the measurement agreed: a bot with no velocity model
   * at all scored as well as one with a perfect one.
   *
   * So it is a TUTORIAL and it ends. Three casts is the budget the docblock at
   * the top of this file already claimed the wake was worth; after that the wake
   * is the only answer on screen, which is what it was drawn to be.
   */
  #drawGhost(g, t, P, f) {
    const gx = this.leadX(f, t);
    const gy = this.fishY(f, t + SINK);
    const rx = f.len * 0.5 + HOOK_R;
    const ry = f.len * RY_K + HOOK_R;
    const pulse = 0.30 + 0.14 * Math.sin(t * 7);
    g.ellipse(gx, gy, rx, ry, 0, { stroke: `rgba(${P.rInk},${pulse.toFixed(3)})`, width: 0.035 });
    g.circle(gx, gy, 0.05, { fill: `rgba(${P.rInk},0.5)` });
    // The arrow from now to then. It is the same length as the wake behind the
    // fish, on purpose — the two readings are one reading.
    const nose = this.fishX(f, t) + Math.sign(f.v) * f.len * 0.5;
    g.line(nose, gy, gx - Math.sign(f.v) * rx, gy, `rgba(${P.rInk},0.16)`, 0.03);
  }

  #drawHook(g, t, P) {
    const h = this.hook;
    if (!h) return;
    const k = clamp((t - h.t0) / SINK, 0, 1);
    const y = SURFACE - (SURFACE - h.y) * k;

    // The line, underwater: dimmer and slightly thicker than the dry half, which
    // is what water does to a thread and costs one extra draw call.
    g.line(h.x, SURFACE, h.x, y, `rgba(${P.rInk},0.16)`, 0.028);

    if (k < 1) {
      // A CLOSED lure, streamlined, falling. It is not fishing yet, and the
      // shape says so — that is the answer to "why did it fall through a fish".
      g.poly([[h.x, y - 0.16], [h.x + 0.075, y + 0.04], [h.x, y + 0.14], [h.x - 0.075, y + 0.04]],
        { fill: `rgba(${P.rGold},0.85)` });
      // The commitment arc, closing over the sink. The drama of the rite is
      // these 350 ms of unrecoverable choice, so they get a clock.
      g.arc(h.x, y, 0.24, -Math.PI / 2, -Math.PI / 2 + 6.283 * (1 - k), `rgba(${P.rGold},0.55)`, 0.045);
    } else {
      const age = t - (h.settledAt ?? h.landAt);
      const s = clamp(age / 0.18, 0, 1);
      g.circle(h.x, h.y, 0.10 + s * 0.5, { stroke: `rgba(${P.rInk},${((1 - s) * 0.6).toFixed(3)})`, width: 0.045 });
      g.circle(h.x, h.y, HOOK_R, { fill: `rgba(${P.rGold},${(1 - s * 0.5).toFixed(3)})` });
    }
  }

  #drawSurface(g, t, P, pts) {
    // The waterline, as a sum of seeded wavelets. A pure function of t: no
    // stored phase to drift, so two clients draw the same water forever. The
    // points are the ones the water was FILLED with, passed in rather than
    // recomputed, so the highlight cannot drift off the edge it belongs to.
    g.poly(pts, { close: false, stroke: `rgba(${P.rAccent},0.55)`, width: 0.045 });
    g.save().alpha(0.5);
    g.poly(pts, { close: false, stroke: `rgba(${P.rInk},0.25)`, width: 0.016 });
    g.restore();

    // Ripples: rings on the surface for entries and claims, rings in place for
    // takes and misses. Fixed pool, oldest overwritten, zero growth.
    for (const r of this._rip) {
      const age = t - r.t0;
      if (age < 0 || age > 0.9) continue;
      const s = age / 0.9;
      const rgb = r.kind === 3 ? P.rGold : r.kind === 4 ? P.rInk : r.kind === 2 ? P.rGold : P.rAccent;
      g.ellipse(r.x, r.y, 0.18 + s * 1.5, (0.18 + s * 1.5) * (r.y > SURFACE - 0.05 ? 0.22 : 1), 0, {
        stroke: `rgba(${rgb},${((1 - s) * 0.45).toFixed(3)})`, width: 0.035,
      });
    }
  }

  #surfaceY(x, t) {
    let y = 0;
    for (const w of this._wave) y += w.a * Math.sin(x * w.k + t * w.s + w.p);
    return y;
  }

  /**
   * The four boats — and the one that is YOURS.
   *
   * THE SINGLE WORST THING IN THE OLD PICTURE was here: four identical black
   * lollipops on one waterline, told apart only by a stroke at alpha 0.66 versus
   * 0.16. That is a difference no screen survives, and it means the rite's first
   * question — "which one am I" — took longer to answer than the rite lasts. The
   * player had no avatar.
   *
   * The fix is not more contrast, it is a DIFFERENT ANIMAL. The player is a
   * lantern-lit punt with a raised prow, a hat, a creel that visibly fills, and
   * the only warm light on the water besides the sun; the rivals are the flat
   * dark lollipops they always were, and smaller. You can find yourself in one
   * saccade because you are the only lit thing in the frame, and the rivals stay
   * scenery, which is what they are: three deadlines with names on.
   */
  #drawAnglers(g, t, P) {
    // The field first. The player is drawn last so the rod and the live line are
    // never behind anyone.
    for (let i = 0; i < this.roster.length; i++) {
      const r = this.roster[i];
      const x = RIVAL_X[i] ?? 0;
      const flash = t - this._flash[i];
      this.#drawBoat(g, t, P, x, 0.55, false);
      if (flash >= 0 && flash < 1.1) {
        const k = clamp(flash / 1.1, 0, 1);
        g.text(r.name.toUpperCase(), x, 2.62 + k * 0.4, {
          size: 0.42, tracking: 0.08, fill: `rgba(${P.rGold},${((1 - k) * 0.95).toFixed(3)})`,
        });
      }
      if (this.tally[i] > 0) {
        g.text(String(this.tally[i]), x, 1.78, { size: 0.34, fill: `rgba(${P.rInk},0.42)` });
      }
    }
    this.#drawBoat(g, t, P, PLAYER_X, 1, true);
  }

  /**
   * The half of a boat that is under the water, drawn INSIDE the water clip.
   *
   * It used to be drawn after the clip closed, which put three translucent hull
   * reflections on top of any shallow fish that happened to be swimming past —
   * scenery painting over the game. Same trick, drawn in the right order.
   *
   * REFRACTION, implied rather than simulated: what is under the line is offset
   * sideways, squashed and dimmer. It is one cheap mark and it is the single
   * thing that makes a horizontal line read as a water SURFACE rather than as a
   * horizon. The gameplay geometry is never offset — only the scenery is, so
   * what the rules test is still what the player sees.
   */
  #drawWet(g, t, P, x, lit, isPlayer) {
    // Anchored at the LOWER of the local waterline and SURFACE, so a crest can
    // never push a reflection up into the clip's straight lid.
    const yb = Math.min(SURFACE, SURFACE + Math.sin(t * 1.1 + x) * 0.045 + this.#surfaceY(x, t));
    const w = isPlayer ? 0.46 : 0.38;
    g.save().alpha(0.28);
    g.ellipse(x + 0.09, yb - 0.34, isPlayer ? 0.72 : 0.58, 0.17, 0, { fill: `rgba(${P.rDeep},0.85)` });
    g.capsule(x - w, yb - 0.72, x + w, yb - 0.72, 0.10, {
      fill: `rgba(${isPlayer ? P.rGold : P.rInk},${(0.10 + 0.14 * lit).toFixed(3)})`,
    });
    g.restore();
    // The lantern's light going down into the water. The one warm thing under
    // the surface, and it sits over the player's own boat — a second, softer
    // answer to "which one am I" for anybody looking at the water rather than
    // at the sky.
    if (isPlayer) {
      g.save().add();
      g.halo(x + 0.5, yb - 0.55, 1.9, P.rGold, 0.09, 0.25);
      g.restore();
    }
  }

  #drawBoat(g, t, P, x, lit, isPlayer) {
    const bob = Math.sin(t * 1.1 + x) * 0.045 + this.#surfaceY(x, t);
    const yb = SURFACE + bob;
    const ink = `rgba(${P.rInk},${(0.16 + 0.5 * lit).toFixed(3)})`;
    const hull = isPlayer ? `rgba(${P.rGold},0.72)` : ink;
    const s = isPlayer ? 1.12 : 0.84;

    if (isPlayer) {
      // The lantern, hung off the stern on a short pole. Additive, so it reads
      // as light rather than as a yellow dot, and it is the brightest small
      // thing on the water.
      const lx = x - 0.86 * s;
      const ly = yb + 0.98;
      g.save().add();
      g.halo(lx, ly, 1.5, P.rGold, 0.22, 0.25);
      g.restore();
      g.line(x - 0.5 * s, yb + 0.16, lx, ly + 0.1, `rgba(${P.rGold},0.5)`, 0.03);
      g.circle(lx, ly, 0.13, { fill: P.goldHi });
    }

    // Hull. The player's is a punt with a raised prow — a different SILHOUETTE,
    // which is the only kind of difference that survives being small.
    if (isPlayer) {
      g.poly([
        [x - 0.72 * s, yb + 0.16], [x + 0.60 * s, yb + 0.16],
        [x + 0.88 * s, yb + 0.42], [x + 0.66 * s, yb + 0.40],
        [x + 0.52 * s, yb - 0.14], [x - 0.62 * s, yb - 0.14],
      ], { fill: `rgba(${P.rDeep},0.97)`, stroke: hull, width: 0.045 });
    } else {
      g.capsule(x - 0.58 * s, yb + 0.02, x + 0.58 * s, yb + 0.02, 0.17, {
        fill: `rgba(${P.rDeep},0.95)`, stroke: ink, width: 0.03,
      });
    }

    // The angler. The player gets a hat brim, which at this size is the whole
    // difference between "a person" and "a post".
    g.capsule(x - 0.05, yb + 0.20, x - 0.05, yb + 0.70 * s, 0.15 * s, {
      fill: `rgba(${P.rDeep},0.95)`, stroke: hull, width: 0.03,
    });
    g.circle(x - 0.05, yb + 0.90 * s, 0.15 * s, { fill: `rgba(${P.rDeep},0.95)`, stroke: hull, width: 0.03 });
    if (isPlayer) {
      g.capsule(x - 0.34, yb + 0.94, x + 0.26, yb + 0.94, 0.05, { fill: `rgba(${P.rGold},0.85)` });
      // The creel, and it FILLS. Four rungs for the four quarters of par, so the
      // bar at the top of the frame is not the only place the run is reported —
      // a player watching the water still sees their own afternoon add up.
      const cy = yb + 0.30;
      g.capsule(x + 0.30, cy, x + 0.30, cy + 0.30, 0.17, { stroke: `rgba(${P.rGold},0.55)`, width: 0.035 });
      const full = clamp(this.points / PAR, 0, 1);
      for (let k = 0; k < 4; k++) {
        if (full < (k + 1) / 4 - 0.12) continue;
        g.line(x + 0.16, cy + 0.03 + k * 0.08, x + 0.44, cy + 0.03 + k * 0.08, `rgba(${P.rGold},0.85)`, 0.045);
      }
    }

    // The rod points where the angler is working. For the player that is the
    // live cast, or the pointer while the line is in.
    let aim = 1;
    if (isPlayer) {
      const target = this.hook ? this.hook.x : (this._pin ? this._px : x + 2);
      aim = target >= x ? 1 : -1;
    }
    const tipX = x + aim * 1.15 * s;
    const tipY = yb + 1.5 * s;
    g.capsule(x + aim * 0.10, yb + 0.62 * s, tipX, tipY, isPlayer ? 0.038 : 0.030, {
      fill: `rgba(${P.rGold},${(0.22 + 0.62 * lit).toFixed(3)})`,
    });

    if (isPlayer) {
      if (this.hook) {
        // The dry half of the line, tip to the point where it pierces the
        // surface. The wet half is drawn inside the water clip, in #drawHook.
        const hy = this.hook.settledAt != null
          ? this.hook.y
          : SURFACE - (SURFACE - this.hook.y) * clamp((t - this.hook.t0) / SINK, 0, 1);
        g.line(tipX, tipY, this.hook.x, Math.max(hy, SURFACE), `rgba(${P.rInk},0.30)`, 0.022);
      } else {
        // Reeling. The one piece of state the player MUST be able to read at a
        // glance, because it is the whole cost of a bad cast: a bar on the rod
        // that fills back up, plus a refusal pulse if they tried anyway.
        const left = this.readyAt - t;
        if (left > 0) {
          const k = clamp(1 - left / this.reelSpan, 0, 1);
          g.capsule(x - 0.5, yb + 1.28, x + 0.5, yb + 1.28, 0.05, { fill: `rgba(${P.rInk},0.10)` });
          g.capsule(x - 0.5, yb + 1.28, x - 0.5 + k, yb + 1.28, 0.05, { fill: `rgba(${P.rGold},0.7)` });
          const deny = t - this.deniedAt;
          if (deny >= 0 && deny < 0.25 && this._pin) {
            g.circle(this._px, this._py, 0.30 + deny, { stroke: `rgba(${P.rInk},${((1 - deny / 0.25) * 0.4).toFixed(3)})`, width: 0.04 });
          }
        } else if (this._pin) {
          // Ready. A quiet reticle at the pointer, so "the line is free" is a
          // positive signal rather than the absence of a negative one.
          g.circle(this._px, this._py, 0.17, { stroke: `rgba(${P.rGold},0.5)`, width: 0.035 });
          g.circle(this._px, this._py, 0.035, { fill: `rgba(${P.rGold},0.7)` });
        }
      }
    }
  }

  #drawHud(g, P, hw, hh) {
    const s = this.score();
    const bw = 6.4;
    // Far enough down that the CAP HEIGHT of 0.46 type clears the top of the
    // field. At `hh - 0.6` the creel count was drawn straight through the edge
    // of the stage and the run's only live number was legible as "1 / 11" with
    // its top third missing.
    const y = hh - 1.15;
    // BIGGER. The largest type on this canvas was 0.30 world units and the score
    // itself was 0.24 — on a 16-unit field that is about 1.5 % of the width, and
    // a number a player has to lean in for is a number they do not read during a
    // twenty-second rite. The creel is the only figure that matters while the
    // clock runs, so it is the biggest thing that is not water.
    g.text('CREEL', -bw / 2, y + 0.57, { size: 0.32, align: 'left', tracking: 0.16, fill: `rgba(${P.rInk},0.5)` });
    g.text(`${this.points} / ${PAR.toFixed(1)}`, bw / 2, y + 0.57, { size: 0.46, align: 'right', tracking: 0.04, fill: `rgba(${P.rInk},0.8)` });
    g.rect(0, y, bw, 0.18, { radius: 0.09, fill: `rgba(${P.rInk},0.10)` });
    if (s.ratio > 0) {
      g.save();
      g.rect(-bw / 2 + (bw * s.ratio) / 2, y, bw * s.ratio, 0.18, {
        radius: 0.09,
        fill: g.linearFill(-bw / 2, 0, bw / 2, 0, [[0, `rgba(${P.rAccent},0.8)`], [1, `rgba(${P.rGold},0.95)`]]),
      });
      g.restore();
    }
    // The clock, as a thin bleed along the very top. No numbers: a rite is 20
    // seconds and a digit is a thing to read instead of the water.
    const left = clamp(1 - this.t / DURATION, 0, 1);
    g.rect(-hw + (FIELD.w * left) / 2, hh - 0.06, FIELD.w * left, 0.05, { fill: `rgba(${P.rGold},0.35)` });
  }

  // ---- the verdict --------------------------------------------------------

  /**
   * PURE. Reads five counters and nothing else — no lazy resolution of a fish
   * in flight, no draining of anything. The host asks once, the result card asks
   * again, and the test suite asks constantly.
   */
  score() {
    const ratio = clamp(this.points / PAR, 0, 1);
    const headline = this.casts === 0 ? 'Never cast'
      : ratio >= 0.999 ? 'Full creel'
        : ratio > 0.75 ? 'Good water'
          : ratio > 0.45 ? 'A few keepers'
            : ratio > 0.15 ? 'Slim pickings'
              : 'Out-fished';
    const bits = [`${this.kept} landed`];
    if (this.goldKept) bits.push('golden fish');
    if (this.empties) bits.push(`${this.empties} empty`);
    bits.push(`${this.lost} taken`);
    return { ratio, headline, detail: bits.join(' · ') };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }

  teardown() { this._events.length = 0; }
}

/** @type {import('../contract.js').MinigameDef} */
export const FISHING_RITE = {
  id: 'fishing',
  name: 'Fishing',
  hint: 'Cast where the fish will be — the hook takes a moment to sink',
  duration: DURATION,
  theme: 'fishing',
  eyebrow: 'Cast',
  abandonNote: 'You reeled in and walked off',
  // No `cursor`: the stylesheet's crosshair is exactly right for an aiming rite.
  create: () => new FishingRite(),
};

export {
  FishingRite, RAND_CALLS, SINK, REEL_EMPTY, REEL_HELD, REEL_WAVE, CLAIM_SQUEEZE,
  FISH, PAR, PAR_FRACTION, GOLD_VALUE, GHOST_CASTS, BOB, SURFACE, SURFACE_AMP,
  FLOOR, SHALLOW, DEEP, HOOK_R, SPEED_MIN, SPEED_MAX, LEN_MAX, SPAN, RIVALS,
  DURATION, SWIMMING, KEPT, LOST,
};
