'use strict';

/**
 * Deterministic pseudo-random number generator.
 *
 * Every source of randomness in the game funnels through this class so that a
 * battle can be replayed exactly from its seed. That matters for three reasons:
 *
 *   1. Balance testing. `test/balance.js` runs thousands of battles; without a
 *      seed the numbers move around and regressions hide in the noise.
 *   2. Bug reports. A save file carries the seed, so "I died to the boss on
 *      turn 12" can be reproduced exactly.
 *   3. Network play later. A server-authoritative battle only has to ship the
 *      seed plus the player's command list.
 *
 * The algorithm is mulberry32: 32-bit state, one multiply-xor round per draw,
 * statistically fine for gameplay and trivial to reimplement in another
 * language if the engine is ever ported.
 */
class Rng {
  /** @param {number} [seed] any integer; defaults to a time-based seed. */
  constructor(seed) {
    if (seed === undefined || seed === null) {
      seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    }
    this.seed = seed >>> 0;
    this.state = this.seed;
    this.draws = 0;
  }

  /** Uniform float in [0, 1). */
  next() {
    this.draws++;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min, max) {
    return min + this.next() * (max - min);
  }

  /** True with probability `p` (0..1). */
  chance(p) {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  /** Pick one element uniformly. */
  pick(list) {
    if (!list || list.length === 0) return undefined;
    return list[Math.floor(this.next() * list.length)];
  }

  /**
   * Pick one element with weights. Entries are `[value, weight]` pairs or
   * objects carrying a `weight` property. Non-positive weights are ignored.
   */
  weighted(entries, weightOf) {
    const get = weightOf || ((e) => (Array.isArray(e) ? e[1] : e.weight));
    const val = (e) => (Array.isArray(e) ? e[0] : e);
    let total = 0;
    for (const e of entries) {
      const w = get(e);
      if (w > 0) total += w;
    }
    if (total <= 0) return this.pick(entries.map(val));
    let roll = this.next() * total;
    for (const e of entries) {
      const w = get(e);
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return val(e);
    }
    return val(entries[entries.length - 1]);
  }

  /** Fisher-Yates shuffle returning a new array. */
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** Snapshot so a caller can rewind (used by the "undo" guard in tests). */
  save() {
    return { state: this.state, draws: this.draws };
  }

  restore(snap) {
    this.state = snap.state;
    this.draws = snap.draws;
  }
}

/** Smallest float that keeps damage from collapsing to a zero-hit. */
const MIN_MULTIPLIER = 0.05;

/**
 * One battle's worth of variance helpers, kept separate from `Rng` so that the
 * damage formula can be unit-tested with variance switched off.
 */
const Variance = {
  /** ±`spread` around 1.0, clamped so a hit is never fully negated. */
  roll(rng, spread) {
    if (!spread) return 1;
    return Math.max(MIN_MULTIPLIER, 1 + rng.float(-spread, spread));
  },
};

module.exports = { Rng, Variance };
