'use strict';

/**
 * Battle constants that both `battle.js` and `ai.js` need.
 *
 * These live in their own module purely to break a require cycle: `battle.js`
 * requires `ai.js` (to let enemies decide), and `ai.js` would need `ACTION` from
 * `battle.js`. Node's CommonJS handles cycles by handing back a partially
 * initialised export object, which works right up until the moment it doesn't —
 * so the shared vocabulary lives here instead and both sides import it.
 *
 * Rule of thumb for this codebase: anything two modules in the same layer both
 * need goes in a leaf module with no dependencies of its own.
 */

/** Lifecycle of one battle. */
const PHASE = {
  INIT: 'init',
  ACTIVE: 'active',
  WON: 'won',
  LOST: 'lost',
  FLED: 'fled',
};

/** Terminal phases — nothing may be commanded once one of these is reached. */
const TERMINAL_PHASES = [PHASE.WON, PHASE.LOST, PHASE.FLED];

function isTerminal(phase) {
  return TERMINAL_PHASES.includes(phase);
}

/** What a unit does on its turn. */
const ACTION = {
  BASIC: 'basic',
  SKILL: 'skill',
  ULTIMATE: 'ultimate',
  ITEM: 'item',
  DEFEND: 'defend',
  FLEE: 'flee',
};

/** Which side a selector refers to, for validation. */
const SIDES = { ALLY: 'ally', ENEMY: 'enemy' };

module.exports = { PHASE, ACTION, SIDES, TERMINAL_PHASES, isTerminal };
