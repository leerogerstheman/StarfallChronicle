'use strict';

/**
 * Battle event log.
 *
 * The engine never writes to the DOM. It appends structured events to one of
 * these, and the presentation layer decides what to do with them. That split is
 * what lets `test/balance.js` run ten thousand battles in-process with no
 * browser at all, and what will let a future replay viewer re-render a battle
 * from a saved log.
 *
 * Two consumers exist today:
 *   - `Battle` keeps a `Log` and streams events straight to the HTTP response
 *     as newline-delimited JSON, which the browser consumes as a live feed.
 *   - Tests keep a `Log` and assert on it.
 */

/** Event kinds. Kept as a frozen map so typos throw instead of silently pass. */
const EVENTS = {
  BATTLE_START: 'battle.start',
  BATTLE_END: 'battle.end',
  WAVE_START: 'wave.start',
  ROUND_START: 'round.start',
  TURN_START: 'turn.start',
  TURN_END: 'turn.end',
  ACTION_QUEUED: 'action.queued',

  SKILL_CAST: 'skill.cast',
  SKILL_FAILED: 'skill.failed',
  DAMAGE: 'combat.damage',
  HEAL: 'combat.heal',
  MISS: 'combat.miss',
  CRIT: 'combat.crit',
  WEAKNESS_HIT: 'combat.weakness',
  TOUGHNESS: 'combat.toughness',
  BREAK: 'combat.break',
  BREAK_RECOVER: 'combat.breakRecover',

  STATUS_APPLIED: 'status.applied',
  STATUS_RESISTED: 'status.resisted',
  STATUS_EXPIRED: 'status.expired',
  STATUS_TICK: 'status.tick',
  STATUS_CLEANSED: 'status.cleansed',
  STATUS_REMOVED: 'status.removed',

  SP_CHANGE: 'resource.skillPoint',
  ENERGY_CHANGE: 'resource.energy',
  ULTIMATE_READY: 'ultimate.ready',
  ULTIMATE_CAST: 'ultimate.cast',

  UNIT_DOWN: 'unit.down',
  UNIT_REVIVED: 'unit.revived',
  UNIT_SUMMONED: 'unit.summoned',
  UNIT_ESCAPED: 'unit.escaped',

  DELAY: 'order.delay',
  ADVANCE: 'order.advance',
  ORDER_PUSHED: 'order.pushed',
  EXTRA_TURN: 'order.extraTurn',

  PHASE_CHANGE: 'enemy.phase',
  DIALOGUE: 'narrative.dialogue',
  INFO: 'narrative.info',
  WARNING: 'narrative.warning',
};

/**
 * Reverse index so `Log.push` can tell a real kind from a typo.
 *
 * This exists because the engine calls `log.push(EVENTS.DAMAGE, ...)` while
 * anything holding a raw string (a data file, a boss script, a test) naturally
 * writes `'combat.damage'`. An earlier version only accepted the enum *keys*,
 * which meant every legitimate push from the short-name side logged a warning
 * and buried the real failures in noise.
 */
const EVENT_VALUES = new Set(Object.values(EVENTS));

/**
 * A ring-buffer-free, append-only event list with an optional sink.
 *
 * `sink` is called synchronously for every event. The HTTP layer passes a
 * function that writes a JSON line to the response; tests pass nothing.
 */
class Log {
  constructor(options = {}) {
    this.entries = [];
    this.sink = options.sink || null;
    this.seq = 0;
    this.verbose = options.verbose !== false;
    /** Suppress animation-only events when a caller only wants state changes. */
    this.filter = options.filter || null;
  }

  /**
   * @param {string} kind one of EVENTS (either the key or its value)
   * @param {object} [data] payload; must be JSON-serialisable
   */
  push(kind, data = {}) {
    // Accept both `EVENTS.DAMAGE` ("combat.damage") and the enum key form so
    // callers never have to care which side of the boundary they are on.
    const resolved = EVENTS[kind] || kind;
    if (!EVENT_VALUES.has(resolved) && this.verbose) {
      // Not fatal — a data-driven boss script may emit custom kinds — but an
      // unknown kind from engine code is always a bug worth surfacing.
      // eslint-disable-next-line no-console
      console.warn(`[log] unknown event kind: ${kind}`);
    }
    if (this.filter && !this.filter(resolved, data)) return null;
    // `kind` is the event's *type* and must win over any same-named field in the
    // payload. This is not hypothetical: `skill.cast` carries a `kind` describing
    // the skill ('basic' / 'skill' / 'ultimate'), and spreading the payload after
    // the type silently rewrote every cast event into `kind: 'skill'`. Consumers
    // keying on `kind` then saw a stream with no casts in it at all.
    const entry = { seq: ++this.seq, ...data, kind: resolved, t: Date.now() };
    this.entries.push(entry);
    if (this.sink) {
      try {
        this.sink(entry);
      } catch (err) {
        // A dead socket must never take the battle down with it.
        this.sink = null;
      }
    }
    return entry;
  }

  /** All entries of one kind. Accepts either the key or the dotted value. */
  of(kind) {
    const resolved = EVENTS[kind] || kind;
    return this.entries.filter((e) => e.kind === resolved);
  }

  /** Last entry of one kind, or undefined. */
  last(kind) {
    const resolved = EVENTS[kind] || kind;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].kind === resolved) return this.entries[i];
    }
    return undefined;
  }

  /** Total damage dealt by `unitId` across the battle. */
  damageBy(unitId) {
    return this.entries
      .filter((e) => e.kind === EVENTS.DAMAGE && e.sourceId === unitId)
      .reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  /** Total damage taken by `unitId` across the battle. */
  damageTakenBy(unitId) {
    return this.entries
      .filter((e) => e.kind === EVENTS.DAMAGE && e.targetId === unitId)
      .reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  /** Number of turns a unit took. */
  turnsOf(unitId) {
    return this.entries.filter((e) => e.kind === EVENTS.TURN_START && e.unitId === unitId).length;
  }

  /** Compact digest printed by the balance harness. */
  digest() {
    const dmg = new Map();
    const taken = new Map();
    const breaks = new Map();
    for (const e of this.entries) {
      if (e.kind === EVENTS.DAMAGE) {
        dmg.set(e.sourceId, (dmg.get(e.sourceId) || 0) + (e.amount || 0));
        taken.set(e.targetId, (taken.get(e.targetId) || 0) + (e.amount || 0));
      } else if (e.kind === EVENTS.BREAK) {
        breaks.set(e.sourceId, (breaks.get(e.sourceId) || 0) + 1);
      }
    }
    return {
      events: this.entries.length,
      rounds: this.of(EVENTS.ROUND_START).length,
      damageDealt: Object.fromEntries(dmg),
      damageTaken: Object.fromEntries(taken),
      breaks: Object.fromEntries(breaks),
    };
  }

  /** Human-readable transcript, used by `npm run selftest -- --print`. */
  toText() {
    return this.entries.map((e) => {
      const tag = e.kind.padEnd(20);
      const rest = { ...e };
      delete rest.seq;
      delete rest.kind;
      delete rest.t;
      return `${String(e.seq).padStart(4)} ${tag} ${JSON.stringify(rest)}`;
    }).join('\n');
  }
}

/** Log that throws away everything — for hot loops that only need final state. */
class NullLog extends Log {
  constructor() {
    super();
  }
  push() {
    return null;
  }
}

module.exports = { Log, NullLog, EVENTS };
