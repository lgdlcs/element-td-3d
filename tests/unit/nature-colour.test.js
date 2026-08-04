import { describe, it, expect } from 'vitest';
import { ELEMENTS, ELEMENT_IDS, DUALS } from '../../src/game/Elements.js';
import { resolveFamily, FAMILY_FX } from '../../src/fx/ElementLang.js';

/**
 * Nature's identity colour, as PROPERTIES rather than as a literal.
 *
 * elements.test.js already pins the hex. Pinning a hex freezes the pixel and
 * nothing else: it cannot tell "this was re-authored on purpose" from "this
 * drifted", and it says nothing at all about the three things the change was
 * actually for. Those three are asserted here, so a future re-tune is free to
 * move the value and is not free to undo the point of it:
 *
 *   1. IT IS LESS SATURATED THAN IT WAS. The complaint was "fluorescent", and
 *      chroma is what fluorescent means. HSL saturation, because that is the
 *      axis the brief names.
 *   2. IT IS STILL IN THE NATURE HUE BUCKET. ElementLang.familyFromHue owns a
 *      [70, 165) window, and a colour that falls out of it silently changes
 *      which VFX dialect nature's projectiles and impacts speak.
 *   3. IT IS STILL TELLABLE APART from the other identity colours it could
 *      collide with — earth and water on the wheel, and the four duals that are
 *      also green. Desaturating moves a colour TOWARDS its neighbours, so this
 *      is the specific failure the change could have introduced.
 *
 * WHAT THIS FILE DOES NOT MEASURE. Every consumer reads these hexes through
 * `new THREE.Color().setHex(h).convertSRGBToLinear()`, which with three's
 * ColorManagement on is two transforms, so the value on screen is roughly the
 * authored one squared (see the docblock on ELEMENTS.nature). That is uniform
 * across the whole game, so sRGB-space comparisons BETWEEN elements are honest
 * and absolute brightness claims from a hex are not. Everything below is a
 * comparison.
 */

/** The value nature carried before this round. Every "less than" here is against it. */
const OLD_NATURE_COLOR = 0x4fe07a;
const OLD_NATURE_ACCENT = 0xd6ff8f;

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/**
 * HSL, the ordinary way. Written out rather than imported because nothing in
 * src/ computes it — deriving the expectation from the same code as the subject
 * would make the test agree with itself.
 */
function hsl(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

/**
 * Weighted RGB ("redmean") distance — the cheap perceptual approximation, the
 * one every "is this colour too close to that one" check reaches for. Plain
 * euclidean RGB would call the fire/earth pair further apart than the eye does
 * and the nature/disease pair closer, i.e. exactly backwards for this test.
 * Range is 0..~765.
 */
function colourDistance(a, b) {
  const [r1, g1, b1] = rgb(a).map((v) => v * 255);
  const [r2, g2, b2] = rgb(b).map((v) => v * 255);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** ElementLang.familyFromHue's nature window. Copied deliberately — see below. */
const NATURE_HUE = { lo: 70, hi: 165 };

describe('nature — chroma', () => {
  it('is materially less saturated than the neon green it replaced', () => {
    const now = hsl(ELEMENTS.nature.color);
    const before = hsl(OLD_NATURE_COLOR);

    // Measured: 0.7005 -> 0.4054, a 42% cut. The bar is a quarter, so a
    // re-author has room to move and cannot quietly walk the whole way back.
    expect(before.s).toBeCloseTo(0.7005, 3);
    expect(now.s).toBeLessThan(before.s * 0.75);
    // ...and it is still a green, not a grey. Under ~0.15 familyFromHue stops
    // reading a hue at all and buckets on lightness instead (`d < 0.08`).
    expect(now.s).toBeGreaterThan(0.25);
  });

  it('drops the accent out of the highlighter register too', () => {
    // 0xd6ff8f was (214,255,143): a maxed green channel, HSL S=1.00 L=0.78. It
    // is the rune tint, the shard highlight and Worldroot's trim, so it was the
    // brightest surface nature owned and the loudest one.
    const now = hsl(ELEMENTS.nature.accent);
    const before = hsl(OLD_NATURE_ACCENT);
    expect(before.s).toBeCloseTo(1.0, 3);
    expect(now.s).toBeLessThan(before.s * 0.75);
    expect(now.l).toBeLessThan(before.l);
    // Still the brightest hex nature owns — it is a highlight, and inverting
    // that would flatten the ramp rather than calm it.
    expect(now.l).toBeGreaterThan(hsl(ELEMENTS.nature.color).l);
  });

  it('keeps the whole nature ramp ordered: rim darker than colour darker than accent', () => {
    const c = hsl(ELEMENTS.nature.color).l;
    const a = hsl(ELEMENTS.nature.accent).l;
    const r = hsl(ELEMENTS.nature.rim).l;
    expect(r).toBeLessThan(c);
    expect(c).toBeLessThan(a);
  });
});

describe('nature — hue bucket', () => {
  it('sits inside familyFromHue\'s [70, 165) nature window, with margin', () => {
    for (const k of ['color', 'accent', 'rim']) {
      const { h } = hsl(ELEMENTS.nature[k]);
      expect(h, `nature.${k} hue ${h.toFixed(1)}`).toBeGreaterThanOrEqual(NATURE_HUE.lo);
      expect(h, `nature.${k} hue ${h.toFixed(1)}`).toBeLessThan(NATURE_HUE.hi);
      // 20 degrees of clearance on both sides. The OLD accent had EIGHT on the
      // low side (81.96 against a boundary at 70), which is how a nature tower's
      // highlight came within a rounding of speaking the `light` dialect.
      expect(h - NATURE_HUE.lo, `nature.${k} too close to the light boundary`).toBeGreaterThan(20);
      expect(NATURE_HUE.hi - h, `nature.${k} too close to the water boundary`).toBeGreaterThan(20);
    }
    expect(hsl(OLD_NATURE_ACCENT).h - NATURE_HUE.lo).toBeLessThan(20);   // the control
  });

  /**
   * The window above is a transcript of a constant in another file, which is the
   * failure mode docs/PITFALLS.md §10 is about. This is the same claim made
   * through the real code instead.
   *
   * resolveFamily short-circuits on an exact hex match (COLOR_TO_FAMILY is built
   * from these very integers), so asking it about the authored value proves only
   * that the map was built. Perturbing the low bit of blue is invisible to the
   * eye, misses the map, and forces the hue path to answer.
   */
  it('resolves to the nature family through the hue path, not just the lookup table', () => {
    for (const k of ['color', 'accent', 'rim']) {
      const hex = ELEMENTS.nature[k];
      expect(resolveFamily(undefined, hex), `${k} exact`).toBe('nature');
      expect(resolveFamily(undefined, hex + 1), `${k} off the table`).toBe('nature');
    }
    // The explicit-id path is unaffected by any of this, and is what Towers.js
    // would use if it ever passed `element` (it does not — see Towers.#fire).
    expect(resolveFamily('nature', 0x000000)).toBe('nature');
  });
});

describe('nature — separation from its neighbours', () => {
  /**
   * The greens it has to stay distinct from.
   *
   * Not "every dual" — the four below are the ones whose hue is inside or within
   * 25 degrees of nature's own window, i.e. the ones a desaturation step could
   * actually collapse into. Poison and Disease especially: both are dark-damage
   * towers, so confusing them with a nature tower is a wrong read about what the
   * tower DOES, not only about what it is called.
   */
  const GREEN_DUALS = ['bloom', 'poison', 'disease', 'well'];

  it('names greens that actually exist, so this test cannot rot into a no-op', () => {
    const ids = new Set(Object.values(DUALS).map((d) => d.id));
    for (const id of GREEN_DUALS) expect(ids.has(id), `${id} is not a dual`).toBe(true);
  });

  it('stays far from earth, water and every green fusion', () => {
    const nature = ELEMENTS.nature.color;
    const rivals = [
      ['earth', ELEMENTS.earth.color],
      ['water', ELEMENTS.water.color],
      ...GREEN_DUALS.map((id) => [id, Object.values(DUALS).find((d) => d.id === id).color]),
    ];

    // Measured floor is disease at 125.8 (it was 188.2 before the desaturation —
    // this is the axis the change made WORSE, which is exactly why it is pinned).
    // 100 leaves a fifth of margin without licensing another step towards it.
    for (const [name, hex] of rivals) {
      const d = colourDistance(nature, hex);
      expect(d, `nature is only ${d.toFixed(1)} from ${name}`).toBeGreaterThan(100);
    }
  });

  it('keeps all six element colours mutually distinguishable, not merely unequal', () => {
    for (let i = 0; i < ELEMENT_IDS.length; i++) {
      for (let j = i + 1; j < ELEMENT_IDS.length; j++) {
        const a = ELEMENT_IDS[i], b = ELEMENT_IDS[j];
        const d = colourDistance(ELEMENTS[a].color, ELEMENTS[b].color);
        expect(d, `${a} and ${b} are only ${d.toFixed(1)} apart`).toBeGreaterThan(100);
      }
    }
  });

  it('has retired 0xd6ff8f from the VFX family too, not only from ELEMENTS', () => {
    /**
     * THE HALF THAT SHIPPED UNFIXED.
     *
     * ELEMENTS.nature dropped 0xd6ff8f and the docblock above it names that hex
     * as the actual cause of "the nature towers are too flashy" — while
     * FAMILY_FX.nature.spark was still literally 0xd6ff8f. EffectSystem.
     * impactCore mixes spark half-and-half with the tower's own colour and emits
     * the flash at spark * 2.6, above the bloom threshold, so the retired hex was
     * HALF of every nature impact and muzzle burst. A Worldroot L2 fires 6.7
     * times a second: the tower calmed down and the thing it shot did not.
     *
     * Asserted as a RELATION rather than as a hex, like everything else in this
     * file: the spark must be a highlight over the body colour, not a different
     * register from it. Every other family lands between 1.1x and 3.5x; nature
     * was at 4.9x, alone off the end of the scale.
     */
    expect(FAMILY_FX.nature.spark).not.toBe(OLD_NATURE_ACCENT);
    const s = hsl(FAMILY_FX.nature.spark);
    expect(s.h, `nature spark hue ${s.h.toFixed(1)}`).toBeGreaterThanOrEqual(NATURE_HUE.lo);
    expect(s.h).toBeLessThan(NATURE_HUE.hi);
    expect(s.s, 'the spark is back in the highlighter register').toBeLessThan(0.75);
    // Brighter than the body (it is a flash) but not a different order of thing.
    const body = hsl(ELEMENTS.nature.color);
    expect(s.l).toBeGreaterThan(body.l);
    expect(s.l).toBeLessThan(body.l * 1.9);
  });

  it('does not carry a glowDecal that nothing reads', () => {
    // EffectSystem's decal switch reads `glowDecal` in the 'scorch' and 'frost'
    // branches only; nature is 'poison', which uses `decal`. The 0x7ad62a that
    // used to sit here tuned nothing while reading as if it did — the same class
    // of defect as PITFALLS §8, one field wide.
    expect(FAMILY_FX.nature.decalType).toBe('poison');
    expect(FAMILY_FX.nature.glowDecal).toBeUndefined();
    // The control: the two families that DO read it still have it.
    expect(FAMILY_FX.fire.decalType).toBe('scorch');
    expect(typeof FAMILY_FX.fire.glowDecal).toBe('number');
    expect(FAMILY_FX.water.decalType).toBe('frost');
    expect(typeof FAMILY_FX.water.glowDecal).toBe('number');
  });

  it('gives nature an accent that is a highlight, not a second colour', () => {
    // The other side of the same coin: far enough to read as a highlight on the
    // same object, close enough that the pair is still one identity. Measured
    // 77.9. Both bounds matter — the OLD pair was 172.6 apart, which is why the
    // rune and the shards looked like a different element from the trunk.
    const d = colourDistance(ELEMENTS.nature.color, ELEMENTS.nature.accent);
    expect(d).toBeGreaterThan(35);
    expect(d).toBeLessThan(130);
  });
});
