'use strict';

/**
 * The game session: one save file, one party, one place in the world.
 *
 * This is the layer that turns the battle engine into a *game*. It owns:
 *   - the party (durable member records + current HP/energy),
 *   - where the player is in the world graph,
 *   - the encounter roll when entering a node,
 *   - EXP/gold/loot settlement after a fight,
 *   - the inventory and shop,
 *   - a battle in progress, if any.
 *
 * Design note on state: everything the player can *see* is derived on demand
 * from the member records via `progression.buildSheet`. Nothing caches a stat.
 * The cost is a few extra object builds per request, which is nothing at this
 * scale, and the benefit is that changing a character's base stats in
 * `core/characters.js` immediately and correctly affects an existing save.
 */

const { Battle, PHASE } = require('../battle/battle');
const { WORLD, getNode, neighbors } = require('../core/world-data');
const progression = require('../core/progression');
const { STARTING_INVENTORY, getItem, ITEMS } = require('../core/items');
const { getEquipment, getCharacter, CHARACTERS } = require('../core/characters');
const skills = require('../core/skills');
const { getStatus } = require('../core/status');
const { Log } = require('../core/log');
const { Rng } = require('../core/rng');

/** Where the session thinks the player is. */
const MODE = {
  TOWN: 'town',
  FIELD: 'field',
  BATTLE: 'battle',
  RESULT: 'result',
  GAME_OVER: 'game_over',
  VICTORY: 'victory',
};

/** What entering a node produced, which decides what the UI shows next. */
const ENTRY = {
  SAFE: 'safe',
  ENCOUNTER: 'encounter',
  BLOCKED: 'blocked',
  STORY: 'story',
};

let sessionSerial = 0;

class Game {
  /**
   * @param {object} [options]
   * @param {number} [options.seed]     master seed; every encounter derives from it
   * @param {string[]} [options.party]  character ids
   * @param {number} [options.level]    starting level (a demo convenience)
   */
  constructor(options = {}) {
    this.id = `session-${++sessionSerial}`;
    this.seed = options.seed != null ? options.seed : (Math.random() * 0xffffffff) >>> 0;
    this.rng = new Rng(this.seed);

    this.mode = MODE.TOWN;
    this.nodeId = WORLD.startNode;
    /** Nodes already visited, for the map UI and for one-shot story beats. */
    this.visited = new Set([WORLD.startNode]);
    /** Flags: boss defeated, elite defeated, story beats seen. */
    this.flags = new Set();

    this.gold = options.gold != null ? options.gold : 500;
    this.inventory = options.inventory
      ? options.inventory.map((e) => ({ ...e }))
      : STARTING_INVENTORY.map((e) => ({ ...e }));

    const startLevel = options.level || 8;
    const partyIds = options.party || ['ayaha', 'rinne', 'rin', 'elise'];
    /** Every character in the roster, so the player can swap at a town. */
    this.roster = WORLD.roster.map((id) => progression.createMember(id, { level: startLevel }));
    /** Who is currently deployed, in turn-order display order. */
    this.activeIds = partyIds.slice(0, WORLD.partySize);
    if (!this.activeIds.includes('elise')) this.activeIds[this.activeIds.length - 1] = 'elise';

    /** The battle in progress, if `mode === 'battle'`. */
    this.battle = null;
    this.battleLog = null;
    /** Set while a node's story text is on screen. */
    this.pendingStory = null;
    /** Result of the last battle, for the result screen. */
    this.lastResult = null;
    /** Encounters cleared in the current node, for `eliteArrivesAfter`. */
    this.encountersInNode = 0;

    this.history = [];
  }

  // =========================================================================
  // Party
  // =========================================================================

  get members() {
    return this.activeIds
      .map((id) => this.roster.find((m) => m.charId === id))
      .filter(Boolean);
  }

  memberById(id) {
    return this.roster.find((m) => m.charId === id) || null;
  }

  /**
   * Swap a deployed character. Refuses mid-battle, and refuses a character who
   * is down (you cannot field a corpse; the inn is where that gets fixed).
   */
  setParty(ids) {
    if (this.mode === MODE.BATTLE) return { ok: false, reason: 'inBattle' };
    const clean = [];
    for (const id of ids) {
      if (!this.memberById(id)) return { ok: false, reason: 'unknownCharacter', id };
      if (clean.includes(id)) continue;
      clean.push(id);
    }
    if (clean.length === 0) return { ok: false, reason: 'emptyParty' };
    if (clean.length > WORLD.partySize) return { ok: false, reason: 'tooMany', max: WORLD.partySize };
    this.activeIds = clean;
    return { ok: true, party: clean };
  }

  /** Every deployed member at full HP and full energy. */
  fullHeal() {
    for (const m of this.roster) {
      const stats = progression.previewStats(m);
      m.hp = stats.maxHp;
      m.energy = 0;
    }
  }

  /** Members who are down (0 HP) and would need reviving. */
  get downedMembers() {
    return this.members.filter((m) => m.hp != null && m.hp <= 0);
  }

  // =========================================================================
  // World traversal
  // =========================================================================

  get node() {
    return getNode(this.nodeId);
  }

  /** Move to an adjacent node and resolve whatever is there. */
  travel(targetId) {
    if (this.mode === MODE.BATTLE) return { ok: false, reason: 'inBattle' };
    if (!neighbors(this.nodeId).includes(targetId)) {
      return { ok: false, reason: 'notAdjacent', from: this.nodeId, to: targetId };
    }
    const node = getNode(targetId);
    // The level gate lives on travel, not on `enter`, so the destination is
    // always *visible* with its requirement — a player can see where to go and
    // what they need, instead of walking into a wall they cannot explain.
    const lock = this.nodeLocked(node);
    if (lock) {
      return { ok: false, reason: lock.reason, required: lock.required, current: lock.current, node: targetId };
    }
    this.nodeId = targetId;
    const firstVisit = !this.visited.has(targetId);
    this.visited.add(targetId);
    this.encountersInNode = 0;
    this.mode = node.type === 'town' ? MODE.TOWN : MODE.FIELD;
    this.history.push({ at: Date.now(), node: targetId, firstVisit });
    return { ok: true, entry: this.describeNode(node), firstVisit };
  }

  /** Everything the UI needs to render the current node. */
  describeNode(node) {
    const n = node || this.node;
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      bg: n.bg,
      desc: n.desc,
      lore: this.visited.has(n.id) ? n.lore : null,
      safe: !!n.safe,
      services: n.services || [],
      npcs: (n.npcs || []).map((x) => ({ id: x.id, name: x.name, portrait: x.portrait })),
      connections: neighbors(n.id).map((id) => {
        const c = getNode(id);
        return { id, name: c.name, type: c.type, visited: this.visited.has(id), locked: this.nodeLocked(c) };
      }),
      hasEncounter: !!(n.encounter && this.encounterAvailable(n)),
      hasBoss: !!n.boss && !this.flags.has(`boss:${n.boss}`),
      hasElite: !!n.elite && !this.flags.has(`elite:${n.elite}`) && this.encountersInNode >= (n.eliteArrivesAfter || 0),
      checkpoint: WORLD.checkpoints.includes(n.id),
    };
  }

  /** Is a node gated by a level requirement or a story flag? */
  nodeLocked(node) {
    if (node.requiredLevel && progression.averageLevel(this.members) < node.requiredLevel) {
      return { reason: 'level', required: node.requiredLevel, current: progression.averageLevel(this.members) };
    }
    return null;
  }

  /** Has this node's random encounter already fired this visit? */
  encounterAvailable(node) {
    const enc = node.encounter;
    if (!enc || enc.rate <= 0) return false;
    if (this.encountersInNode === 0) return true;
    // Stayed in the node: allow more, but not endlessly.
    return this.encountersInNode < 3;
  }

  /**
   * Enter the current node, triggering whatever is scripted there.
   *
   * Order matters and mirrors how a JRPG actually paces a dungeon:
   *   1. a boss, if the node has one and it is undefeated (story beat + fight);
   *   2. an elite, if enough encounters have been cleared here;
   *   3. a random encounter.
   * The alternative — rolling randomly first — means a player can walk into the
   * boss room and get a trash fight, which reads as a bug.
   */
  enter() {
    if (this.mode === MODE.BATTLE) return { ok: false, reason: 'inBattle' };
    const node = this.node;

    if (node.boss && !this.flags.has(`boss:${node.boss}`)) {
      const lock = this.nodeLocked(node);
      if (lock) {
        return {
          ok: true,
          entry: ENTRY.BLOCKED,
          reason: lock,
          message: `队伍平均等级 ${lock.current}，进入这里需要 ${lock.required}。`,
        };
      }
      return this._startStory(node, () => this.startBossEncounter(node));
    }

    if (node.elite && !this.flags.has(`elite:${node.elite}`)
      && this.encountersInNode >= (node.eliteArrivesAfter || 0)) {
      return { ok: true, entry: ENTRY.ENCOUNTER, battle: this.startEliteEncounter(node) };
    }

    if (this.encounterAvailable(node)) {
      return { ok: true, entry: ENTRY.ENCOUNTER, battle: this.startRandomEncounter(node) };
    }

    return { ok: true, entry: ENTRY.SAFE, node: this.describeNode(node) };
  }

  /** Queue a story beat, running `then` once the player dismisses it. */
  _startStory(node, then) {
    const text = []
      .concat(node.prologue || [])
      .concat(node.intro ? [node.intro] : []);
    if (text.length === 0) return then();
    this.pendingStory = { node: node.id, title: node.name, text, action: 'battle', kind: 'boss' };
    this.mode = MODE.FIELD;
    return { ok: true, entry: ENTRY.STORY, story: this.pendingStory };
  }

  /** The player dismissed the story text; now do the thing it announced. */
  continueStory() {
    const story = this.pendingStory;
    if (!story) return { ok: false, reason: 'noStory' };
    this.pendingStory = null;
    if (story.kind === 'boss') {
      return { ok: true, entry: ENTRY.ENCOUNTER, battle: this.startBossEncounter(getNode(story.node)) };
    }
    return { ok: true, entry: ENTRY.SAFE, node: this.describeNode() };
  }

  // =========================================================================
  // Encounters
  // =========================================================================

  /** Build the party sheets the battle engine expects. */
  _partySheets() {
    return this.members.map((m) => {
      const sheet = progression.buildSheet(m);
      // Carry current HP/energy into the fight, so healing between battles
      // matters. A member with no recorded HP starts at full.
      const stats = sheet.stats;
      sheet.hp = m.hp != null ? Math.min(m.hp, stats.maxHp) : stats.maxHp;
      const carry = Math.floor(stats.maxEnergy * require('../core/rules').BALANCE.CARRYOVER_ENERGY_RATIO);
      sheet.energy = Math.min(m.energy || 0, carry);
      sheet.member = m;
      return sheet;
    });
  }

  _beginBattle(config) {
    if (this.members.every((m) => m.hp != null && m.hp <= 0)) {
      return { ok: false, reason: 'partyDown' };
    }
    // Each battle gets its own seed derived from the session seed, so a session
    // replays exactly but two encounters in one session are not clones.
    const battleSeed = (this.seed + this.rng.int(0, 0xffffff)) >>> 0;
    this.battleLog = new Log();
    this.battle = new Battle({
      allies: this._partySheets(),
      enemies: config.enemies,
      seed: battleSeed,
      name: config.name,
      isBoss: !!config.isBoss,
      isElite: !!config.isElite,
      // `canFlee` is an explicit falsy-or-undefined distinction: the Battle
      // constructor treats an absent value as "yes, flee allowed", so passing
      // `undefined` for a boss would silently enable fleeing. The boss and
      // elite flags drive it here, once, rather than at every call site.
      canFlee: config.canFlee != null ? config.canFlee : !config.isBoss,
      log: this.battleLog,
    });
    this.mode = MODE.BATTLE;
    this.currentEncounter = {
      kind: config.kind,
      name: config.name,
      isBoss: !!config.isBoss,
      isElite: !!config.isElite,
      node: this.nodeId,
      rewardsPerEnemy: config.enemies,
    };
    return { ok: true, battle: this.battle.toView() };
  }

  /** Roll a random group from the node's encounter table. */
  startRandomEncounter(node) {
    const enc = (node || this.node).encounter;
    if (!enc || !enc.groups.length) return { ok: false, reason: 'noEncounter' };
    // Exclude single-elite groups once the elite is already beaten, so the
    // player is not forced to re-fight a 5-round boss as a random encounter.
    const groups = enc.groups.filter((g) => {
      const hasElite = g.enemies.some((e) => e.id === 'abyss_sentinel');
      return !(hasElite && this.flags.has('elite:abyss_sentinel'));
    });
    const group = this.rng.weighted(groups.length ? groups : enc.groups);
    const enemies = [];
    for (const e of group.enemies) {
      for (let i = 0; i < (e.count || 1); i++) enemies.push({ id: e.id });
    }
    return this._beginBattle({ kind: 'random', name: group.name || '遭遇战', enemies });
  }

  /** The node's one-shot elite. */
  startEliteEncounter(node) {
    const id = (node || this.node).elite;
    if (!id) return { ok: false, reason: 'noElite' };
    return this._beginBattle({
      kind: 'elite',
      name: '精英 · ' + require('../core/enemies').getEnemy(id).name,
      enemies: [{ id }],
      isElite: true,
    });
  }

  /** The node's boss. */
  startBossEncounter(node) {
    const id = (node || this.node).boss;
    if (!id) return { ok: false, reason: 'noBoss' };
    const def = require('../core/enemies').getEnemy(id);
    return this._beginBattle({
      kind: 'boss',
      name: 'BOSS · ' + def.name,
      enemies: [{ id }],
      isBoss: true,
    });
  }

  /** Direct entry point for tests and for a "practice" menu. */
  startCustomBattle(enemySpecs, name) {
    const { ENEMIES } = require('../core/enemies');
    const defs = enemySpecs.map((s) => ENEMIES[typeof s === 'string' ? s : s.id]).filter(Boolean);
    // A practice fight against a boss is still a boss fight: it must not offer a
    // flee button, because the boss's real encounter is sealed. Deciding this
    // from the enemy definitions rather than from the caller means the two paths
    // cannot disagree — an earlier version left `canFlee` at its default `true`,
    // so the practice menu let you run away from the final boss.
    const isBoss = defs.some((d) => d && d.ai && d.ai.policy === 'boss');
    return this._beginBattle({
      kind: 'custom',
      name: name || '自由战斗',
      enemies: enemySpecs,
      isBoss,
      canFlee: !isBoss,
    });
  }

  // =========================================================================
  // Battle commands
  // =========================================================================

  get inBattle() {
    return this.mode === MODE.BATTLE && this.battle && this.battle.phase === PHASE.ACTIVE;
  }

  /**
   * Advance the battle until it needs player input or finishes.
   *
   * This is the method the HTTP layer drives. It runs enemy turns and any
   * scripted setup automatically, and returns as soon as an ally is on the clock
   * — so the browser never has to implement the turn loop, and cannot get it
   * wrong.
   */
  step() {
    return this._advance(this.battleLog ? this.battleLog.entries.length : 0);
  }

  /**
   * The battle loop, shared by `step()` and `command()`.
   *
   * @param {number} eventsFrom  index into the battle log that this call's
   *   returned events should start at.
   *
   * Why the parameter exists: `command()` resolves the player's action (which
   * appends events) and *then* needs to keep running the fight. If it simply
   * called `step()`, that inner call would compute its own start index — after
   * the action's events were already written — and the client would never
   * receive them. The battle log stayed empty and the animation never played,
   * while the state advanced correctly underneath. Threading the index through
   * is the fix: one loop, one event window.
   */
  _advance(eventsFrom) {
    if (!this.inBattle) {
      return { ok: false, reason: 'notInBattle', mode: this.mode };
    }
    const battle = this.battle;
    const eventsBefore = eventsFrom;

    let guard = 0;
    while (battle.phase === PHASE.ACTIVE && guard++ < 200) {
      // Resolve any queued ultimates first (they do not consume a turn).
      if (battle.hasPendingUltimate) {
        battle._resolvePendingUltimates();
        if (battle.phase !== PHASE.ACTIVE) break;
        continue;
      }
      const unit = battle.advanceToNextTurn();
      if (!unit) break;
      if (unit.side === 'ally') {
        // Hand control to the player — but only if the battle is *still* live.
        // `advanceToNextTurn` can end the battle as a side effect (a DoT that
        // kills the last enemy resolves before the turn is handed over), and
        // returning a `waiting` result then leaves the client believing it owes
        // a command for a battle that no longer exists.
        if (battle.phase !== PHASE.ACTIVE) break;
        return {
          ok: true,
          waiting: true,
          actor: battle.unitView(unit, true),
          state: battle.toView(),
          events: this._eventsSince(eventsBefore),
        };
      }
      battle.takeTurn(unit, null);
    }

    // Reached only when the battle is over, or the guard tripped.
    if (battle.phase !== PHASE.ACTIVE) {
      return this._finishBattle(eventsBefore);
    }
    // Guard tripped with the battle still running: report honestly rather than
    // pretending to wait, so the client can retry instead of hanging.
    return {
      ok: true,
      waiting: false,
      stalled: true,
      state: battle.toView(),
      events: this._eventsSince(eventsBefore),
    };
  }

  /** Submit a player action and continue the battle. */
  command(cmd) {
    if (!this.inBattle) {
      // The battle may have ended during the *previous* step without the client
      // hearing about it (a network hiccup, a reconnecting tab, a DoT that
      // resolved on the turn hand-over). Settle it now and report the result
      // instead of refusing with `notInBattle`, which would leave the client
      // showing a battle screen for a fight that is already over.
      if (this.battle && this.battle.phase !== PHASE.ACTIVE) {
        // Settle lazily. `_finishBattle` appends its own closing events
        // (`battle.end`), so even starting the window at the end of the current
        // log yields a non-empty, meaningful event list for the client.
        const from = this.battleLog ? this.battleLog.entries.length : 0;
        return this._finishBattle(from);
      }
      return { ok: false, reason: 'notInBattle' };
    }
    const battle = this.battle;
    const eventsBefore = this.battleLog.entries.length;

    if (cmd.type === 'ultimate') {
      // Ultimates are queued, not executed: they fire at the top of the next
      // step, which is what makes them interruptible.
      const result = battle.queueUltimate(cmd.unit, cmd.skill, cmd.target);
      if (!result.ok) {
        return { ok: false, reason: result.reason, events: this._eventsSince(eventsBefore) };
      }
      return this._advance(eventsBefore);
    }

    // Find the ally currently on the clock, and require the command to name them
    // (or accept any ready ally) so a stale browser tab cannot act out of order.
    const actor = cmd.unit
      ? battle.findUnit(cmd.unit)
      : battle.readyUnits().find((u) => u.side === 'ally');
    if (!actor || actor.side !== 'ally') return { ok: false, reason: 'noActiveAlly' };
    if (actor.actionValue < require('../core/rules').BALANCE.ACTION_VALUE) {
      return { ok: false, reason: 'notYourTurn', actor: actor.name };
    }

    battle.takeTurn(actor, () => ({ type: cmd.type, skill: cmd.skill, target: cmd.target, item: cmd.item }));

    // `takeTurn` can end the battle (the killing blow, or a counter-attack that
    // finishes the last enemy). Settle rather than calling `_advance`, which
    // would refuse for the same reason `command` just did.
    if (battle.phase !== PHASE.ACTIVE) {
      return this._finishBattle(eventsBefore);
    }
    // Continue the fight, but keep this call's event window so the client
    // receives the action's events *and* everything that followed it.
    return this._advance(eventsBefore);
  }

  /** Fire a charged ultimate without using the turn (the interrupt). */
  fireUltimate(unitId, skillId, targetId) {
    if (!this.inBattle) return { ok: false, reason: 'notInBattle' };
    const result = this.battle.queueUltimate(unitId, skillId, targetId);
    if (!result.ok) return { ok: false, reason: result.reason };
    return this.step();
  }

  _eventsSince(index) {
    return this.battleLog.entries.slice(index);
  }

  /**
   * Settle a finished battle: EXP, gold, level-ups, deaths, story flags.
   *
   * Keeping this in one place is what makes the "you won but your healer died"
   * case correct — the party's HP is written back before any flag is set, so a
   * follow-up battle reads the real state.
   */
  _finishBattle(eventsBefore = 0) {
    const battle = this.battle;
    // Hold a reference to the log: it is cleared at the end of this method, and
    // the caller's `events` slice must be taken from it first.
    const log = this.battleLog;
    const wasBoss = !!(this.currentEncounter && this.currentEncounter.isBoss);
    const wasElite = !!(this.currentEncounter && this.currentEncounter.isElite);

    // --- Write HP/energy back -------------------------------------------
    for (const entity of battle.allies) {
      const member = this.memberById(entity.id);
      if (!member) continue;
      member.hp = Math.max(0, entity.hp);
      member.energy = entity.energy;
    }

    const won = battle.phase === PHASE.WON;
    const levelUps = [];
    let gold = 0;
    let exp = 0;

    if (won) {
      // --- Rewards --------------------------------------------------------
      const rewards = battle.rewards;
      exp = rewards.exp;
      gold = rewards.gold;
      // Only survivors get EXP. That is harsh but it is the genre's convention,
      // and it makes the revive item meaningful.
      const survivors = battle.allies.filter((a) => a.alive);
      const share = survivors.length ? Math.round(exp / survivors.length) : 0;
      for (const entity of survivors) {
        const member = this.memberById(entity.id);
        if (!member) continue;
        const res = progression.grantExp(member, share);
        for (const lv of res.levels) {
          levelUps.push({ charId: member.charId, name: member.name, ...lv });
        }
      }
      this.gold += gold;

      // --- Flags ----------------------------------------------------------
      const node = this.node;
      if (wasBoss && node.boss) this.flags.add(`boss:${node.boss}`);
      if (wasElite && node.elite) this.flags.add(`elite:${node.elite}`);
      this.encountersInNode++;
      // An inn-rest bonus lasts exactly one battle.
      this.restBonus = null;
    } else {
      // --- Defeat ---------------------------------------------------------
      // A wipe costs half your gold and puts you back in town at full health.
      // The genre's standard mercy, and it keeps the demo playable.
      const lost = Math.floor(this.gold * 0.5);
      this.gold -= lost;
      this.flags.add('gameOver');
    }

    const result = {
      won,
      fled: battle.phase === PHASE.FLED,
      phase: battle.phase,
      name: this.currentEncounter ? this.currentEncounter.name : battle.name,
      rounds: battle.round,
      isBoss: wasBoss,
      isElite: wasElite,
      exp,
      gold,
      levelUps,
      survivors: battle.allies.filter((a) => a.alive).map((a) => ({ name: a.name, charId: a.id, hp: a.hp })),
      fallen: battle.allies.filter((a) => !a.alive).map((a) => ({ name: a.name, charId: a.id })),
      mvp: battle.result ? battle.result.allies.find((a) => a.mvp) : null,
      partyAfter: this.members.map((m) => ({
        charId: m.charId,
        name: m.name,
        hp: m.hp,
        level: m.level,
        exp: m.exp,
      })),
    };

    this.lastResult = result;
    this.battle = null;
    this.battleLog = null;
    this.currentEncounter = null;

    if (result.won && wasBoss) {
      this.mode = MODE.VICTORY;
      this.flags.add('cleared');
    } else if (!result.won && !result.fled) {
      this.mode = MODE.GAME_OVER;
    } else {
      this.mode = this.node.type === 'town' ? MODE.TOWN : MODE.FIELD;
    }

    // The events from the final turn (the killing blow, the last enemy's death)
    // are still in the log and must reach the client — they are the most
    // dramatic moments in the fight. `battleLog` is nulled above, so the slice
    // has to happen first. Returning an empty array here meant the last action
    // of every battle played no animation at all.
    const events = log ? log.entries.slice(eventsBefore) : [];
    return { ok: true, finished: true, result, events };
  }

  /** Leave the result / game-over screen and get back to playing. */
  acknowledge() {
    if (this.mode === MODE.GAME_OVER) {
      // Revive the party and send them home.
      this.fullHeal();
      this.nodeId = WORLD.startNode;
      this.mode = MODE.TOWN;
      this.encountersInNode = 0;
      return { ok: true, mode: this.mode, node: this.describeNode() };
    }
    if (this.mode === MODE.VICTORY) {
      this.mode = MODE.FIELD;
      return { ok: true, mode: this.mode, node: this.describeNode() };
    }
    if (this.mode === MODE.RESULT) {
      this.mode = this.node.type === 'town' ? MODE.TOWN : MODE.FIELD;
    }
    this.lastResult = null;
    return { ok: true, mode: this.mode, node: this.describeNode() };
  }

  // =========================================================================
  // Town services
  // =========================================================================

  /** A random encounter is required before services are usable away from town. */
  _requireTown(service) {
    if (this.node.type !== 'town') return { ok: false, reason: 'notInTown', service };
    if (this.mode === MODE.BATTLE) return { ok: false, reason: 'inBattle', service };
    return null;
  }

  /** Inn: pay, heal fully, gain a one-battle buff. */
  rest() {
    const guard = this._requireTown('inn');
    if (guard) return guard;
    const cost = WORLD.inn.cost;
    if (this.gold < cost) return { ok: false, reason: 'notEnoughGold', need: cost, have: this.gold };
    this.gold -= cost;
    this.fullHeal();
    this.restBonus = WORLD.inn.bonus;
    return {
      ok: true,
      gold: this.gold,
      message: WORLD.inn.greeting,
      bonus: WORLD.inn.bonus,
      bonusName: getStatus(WORLD.inn.bonus).name,
      party: this.partyView(),
    };
  }

  /** Shop: buy gear or a consumable. */
  buy(itemId) {
    const guard = this._requireTown('shop');
    if (guard) return guard;
    const entry = WORLD.shop.stock.find((s) => s.item === itemId);
    const item = getEquipment(itemId);
    const consumable = getItem(itemId);
    if (!entry && !consumable) return { ok: false, reason: 'notSold', itemId };
    const price = entry ? entry.price : consumable.price;
    if (this.gold < price) return { ok: false, reason: 'notEnoughGold', need: price, have: this.gold };
    this.gold -= price;

    if (entry) {
      // Equipment goes straight into the shared pool; the shop stocks unlimited
      // copies, which is simpler than an inventory count and matches the genre.
      this.ownedGear = this.ownedGear || new Set();
      this.ownedGear.add(itemId);
      return { ok: true, gold: this.gold, purchased: { id: itemId, name: item.name, kind: 'equipment' } };
    }
    const slot = this.inventory.find((e) => e.item === itemId);
    if (slot) slot.count++;
    else this.inventory.push({ item: itemId, count: 1 });
    return { ok: true, gold: this.gold, purchased: { id: itemId, name: consumable.name, kind: 'consumable' } };
  }

  /** Equip an owned item on a character, swapping out whatever was there. */
  equipOn(charId, itemId) {
    const guard = this._requireTown('smithy');
    if (guard) return guard;
    const member = this.memberById(charId);
    if (!member) return { ok: false, reason: 'unknownCharacter' };
    const item = getEquipment(itemId);
    if (!item) return { ok: false, reason: 'unknownItem' };
    if (this.ownedGear && !this.ownedGear.has(itemId)) {
      return { ok: false, reason: 'notOwned' };
    }
    const previous = progression.equip(member, itemId);
    return { ok: true, charId, slot: item.slot, equipped: itemId, replaced: previous, sheet: progression.buildSheet(member) };
  }

  /** Add a purchased item to the inventory (used by the shop UI). */
  addItem(itemId, count = 1) {
    const slot = this.inventory.find((e) => e.item === itemId);
    if (slot) slot.count += count;
    else this.inventory.push({ item: itemId, count });
  }

  /** Consume one from the inventory; returns false if none left. */
  consume(itemId) {
    const slot = this.inventory.find((e) => e.item === itemId);
    if (!slot || slot.count <= 0) return false;
    slot.count--;
    if (slot.count <= 0) this.inventory = this.inventory.filter((e) => e !== slot);
    return true;
  }

  // =========================================================================
  // Views
  // =========================================================================

  /** Full party detail with derived stats, for the party screen. */
  partyView() {
    return {
      active: this.activeIds.slice(),
      maxSize: WORLD.partySize,
      members: this.roster.map((m) => {
        const sheet = progression.buildSheet(m);
        const stats = sheet.stats;
        return {
          charId: m.charId,
          name: sheet.name,
          en: sheet.en,
          title: sheet.title,
          element: sheet.element,
          role: sheet.role,
          rarity: sheet.rarity,
          color: sheet.color,
          sprite: sheet.sprite,
          lore: sheet.lore,
          level: m.level,
          exp: m.exp,
          expToNext: sheet.expToNext,
          expProgress: sheet.expProgress,
          hp: m.hp != null ? m.hp : stats.maxHp,
          maxHp: stats.maxHp,
          energy: m.energy || 0,
          maxEnergy: stats.maxEnergy,
          active: this.activeIds.includes(m.charId),
          down: m.hp != null && m.hp <= 0,
          stats,
          equipment: { ...m.equipment },
          skills: Object.entries(sheet.skills).map(([slot, id]) => {
            if (!id) return null;
            const s = skills.SKILLS[id];
            return {
              slot, id, name: s.name, icon: s.icon, kind: s.kind, element: s.element,
              desc: s.desc, cost: s.skillPointCost, toughness: s.toughness,
            };
          }).filter(Boolean),
        };
      }),
    };
  }

  /** Inventory with display names resolved. */
  inventoryView() {
    return this.inventory
      .filter((e) => e.count > 0)
      .map((e) => {
        const item = ITEMS[e.item];
        return item ? { ...item, count: e.count } : null;
      })
      .filter(Boolean);
  }

  /** Everything the UI needs to render any non-battle screen. */
  view() {
    const node = this.node;
    return {
      sessionId: this.id,
      seed: this.seed,
      mode: this.mode,
      gold: this.gold,
      node: this.describeNode(node),
      party: this.partyView(),
      inventory: this.inventoryView(),
      flags: [...this.flags],
      lastResult: this.lastResult,
      pendingStory: this.pendingStory,
      restBonus: this.restBonus || null,
      battle: this.battle ? this.battle.toView() : null,
      progress: {
        visited: [...this.visited],
        totalNodes: Object.keys(WORLD.nodes).length,
        bossDefeated: this.flags.has('boss:ashen_king'),
        cleared: this.flags.has('cleared'),
      },
      world: {
        name: WORLD.name,
        subtitle: WORLD.subtitle,
      },
    };
  }
}

module.exports = { Game, MODE, ENTRY };
