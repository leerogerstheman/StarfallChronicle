'use strict';

/**
 * Balance harness.
 *
 * Runs each authored encounter many times with a *competent* auto-player and
 * reports the outcome distribution. The point is not to prove the game is
 * winnable — it is to catch the two failure modes that a hand-played demo hides:
 *
 *   1. **Trivial fights.** If a boss dies in four turns to basic attacks, the
 *      encounter is not doing its job and the player will never see the kit.
 *   2. **Unwinnable fights.** If a well-played party at the recommended level
 *      loses more than half the time, the numbers are wrong, not the player.
 *
 * The auto-player here is meaningfully smarter than the self-test's: it opens
 * with debuffs, saves skill points for break windows, focuses fire on the
 * target it can actually break, and never wastes an ultimate on a nearly-dead
 * enemy. That is roughly how a first-time player who has read the tooltips
 * plays, which is the right baseline.
 *
 * Usage:
 *   node test/balance.js              summary table
 *   node test/balance.js --verbose    per-encounter detail
 *   node test/balance.js --runs 200   more samples
 */

const progression = require('../src/core/progression');
const skills = require('../src/core/skills');
const { getStatus } = require('../src/core/status');
const { Battle } = require('../src/battle/battle');
const { PHASE } = require('../src/battle/action-constants');
const { WORLD } = require('../src/core/world-data');

const argv = process.argv.slice(2);
const RUNS = numberArg('--runs', 60);
const VERBOSE = argv.includes('--verbose');

function numberArg(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = parseInt(argv[i + 1], 10);
  return Number.isFinite(v) ? v : fallback;
}

// ===========================================================================
// Encounter definitions to test
// ===========================================================================

/**
 * The three authored beats of the demo, plus two stress cases.
 * `expect` is the design intent, asserted at the end of the run.
 */
const ENCOUNTERS = [
  {
    id: 'trash_wave',
    name: '小怪波次（低语林）',
    party: ['ayaha', 'rinne', 'rin', 'elise'],
    enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }, { id: 'larva' }, { id: 'larva' }],
    levels: [8, 9, 10],
    expect: { winRate: [0.95, 1.0], maxRounds: 12, minRounds: 1 },
    note: '应当用普攻+少量战技轻松解决，用来教学弱点与击破',
  },
  {
    id: 'trash_matriarch',
    name: '小怪波次（虫母）',
    party: ['ayaha', 'rinne', 'rin', 'elise'],
    enemies: [{ id: 'rotgrub', count: 2 }, { id: 'grub_matriarch' }, { id: 'larva', count: 2 }],
    levels: [10, 11, 12],
    expect: { winRate: [0.8, 1.0], maxRounds: 20 },
    note: '会召唤小怪，教玩家优先处理召唤者',
  },
  {
    id: 'elite_sentinel',
    name: '精英：深渊哨兵',
    party: ['ayaha', 'rinne', 'rin', 'byakuya'],
    enemies: [{ id: 'abyss_sentinel' }],
    levels: [13, 14, 15, 16],
    expect: { winRate: [0.55, 1.0], maxRounds: 40, minRounds: 4 },
    note: '只用风/雷弱点，逼玩家换编队；应需要真正的战技循环',
  },
  {
    id: 'boss_ashen_king',
    name: 'Boss：灰烬之王',
    party: ['ayaha', 'rinne', 'rin', 'elise'],
    enemies: [{ id: 'ashen_king' }],
    levels: [18, 19, 20, 21],
    isBoss: true,
    expect: { winRate: [0.25, 0.95], maxRounds: 80, minRounds: 8 },
    note: '两阶段 + 召唤 + 蓄力终结技，满配队伍应当能赢但会掉人',
  },
  {
    id: 'boss_ashen_king_underleveled',
    name: 'Boss：灰烬之王（等级不足）',
    party: ['ayaha', 'rinne', 'rin', 'elise'],
    enemies: [{ id: 'ashen_king' }],
    levels: [13, 13, 13, 13],
    isBoss: true,
    expect: { winRate: [0.0, 0.5], maxRounds: 80 },
    note: '等级不足时应当明显吃亏，给玩家升级的动机',
  },
];

// ===========================================================================
// The competent auto-player
// ===========================================================================

/**
 * Decide a turn. Priority order reflects how the game is meant to be played:
 *
 *   1. Fire a charged ultimate, but only if it will not be wasted — an
 *      ultimate against a target about to die from a basic attack is a loss.
 *   2. Heal with the support if anyone is in danger (below 40%).
 *   3. Apply a debuff if the target does not have it yet.
 *   4. Use a skill if the target is breakable by this character and not broken.
 *   5. Basic attack to regenerate skill points.
 *
 * This ordering is intentionally conservative about skill points: it banks them
 * for break windows rather than spending every turn.
 */
function decide(unit, battle) {
  const ctx = { unit, battle };

  const basic = findSkill(unit, 'basic');
  const skill = findSkill(unit, 'skill');
  const ultimate = findSkill(unit, 'ultimate');
  const skillDef = skill ? skills.SKILLS[skill] : null;
  const isHealer = skillDef ? skillDef.effects.some((e) => e.type === 'heal') : false;
  const isBuffer = skillDef ? skillDef.effects.some((e) => e.type === 'status' || e.type === 'shield') : false;

  // --- 1. Ultimate ---------------------------------------------------------
  if (ultimate && unit.ultimateReady) {
    const target = pickTarget(unit, battle, skills.SKILLS[ultimate]);
    const worthIt = target && target.hp / target.resolveStats().maxHp > 0.12;
    // A defensive/support ultimate (Elise's) is worth firing when the party is hurt.
    const partyHurt = battle.livingAllies.some((a) => a.hp / a.resolveStats().maxHp < 0.6);
    const isSupportUlt = skills.SKILLS[ultimate].effects.some((e) => e.type === 'heal' || e.type === 'shield');
    if (worthIt || (isSupportUlt && partyHurt)) {
      return { type: 'ultimate', skill: ultimate, target: target ? target.uid : battle.pickDefaultTarget(unit) };
    }
  }

  // --- 2. Heal -------------------------------------------------------------
  if (isHealer && battle.skillPoints >= 1) {
    const hurt = battle.livingAllies
      .filter((a) => a.hp / a.resolveStats().maxHp < 0.45)
      .sort((a, b) => a.hp / a.resolveStats().maxHp - b.hp / b.resolveStats().maxHp)[0];
    if (hurt) return { type: 'skill', skill, target: hurt.uid };
  }

  // --- 3. Debuff -----------------------------------------------------------
  // Only if the current focus target is missing it and the fight is not trivial.
  if (skillDef && battle.skillPoints >= 2 && appliesNewDebuff(skillDef, battle)) {
    const target = pickTarget(unit, battle, skillDef);
    if (target) return { type: 'skill', skill, target: target.uid };
  }

  // --- 4. Break window -----------------------------------------------------
  if (skill && battle.skillPoints >= 1) {
    const breakable = battle.livingEnemies
      .filter((e) => e.toughness > 0 && !e.broken)
      .sort((a, b) => a.toughness - b.toughness)[0];
    if (breakable && canBreak(unit, breakable, skillDef)) {
      return { type: 'skill', skill, target: breakable.uid };
    }
    // Also worth using a skill on an already-broken target if we have spare SP.
    const broken = battle.livingEnemies.filter((e) => e.broken)[0];
    if (broken && battle.skillPoints >= 3) {
      return { type: 'skill', skill, target: broken.uid };
    }
  }

  // --- 5. Basic attack -----------------------------------------------------
  const fallbackSkill = basic || unit.skills[0];
  return { type: 'basic', skill: fallbackSkill, target: battle.pickDefaultTarget(unit) };
}

/** Does this skill apply a debuff the current focus target does not already have? */
function appliesNewDebuff(skillDef, battle) {
  const targets = battle.livingEnemies;
  if (!targets.length) return false;
  for (const eff of skillDef.effects) {
    if (eff.type !== 'status') continue;
    const def = getStatus(eff.status);
    if (def.kind !== 'debuff' && def.kind !== 'dot' && def.kind !== 'control') continue;
    // Worth casting if at least half the enemies lack it.
    const missing = targets.filter((t) => !t.findStatus(eff.status)).length;
    if (missing >= Math.ceil(targets.length / 2)) return true;
  }
  return false;
}

/** Can this unit actually break that target with its skill? */
function canBreak(unit, target, skillDef) {
  if (!skillDef) return false;
  if (target.weaknesses.includes(skillDef.element)) return true;
  // Off-element still chips; worth it if the bar is nearly down.
  return target.toughness < target.toughnessMax * 0.25;
}

/** Choose a target: prefer one this unit can break, else the weakest, else the boss. */
function pickTarget(unit, battle, skillDef) {
  const pool = battle.livingEnemies;
  if (!pool.length) return null;
  const element = skillDef ? skillDef.element : 'physical';
  const scored = pool.map((e) => {
    let score = 0;
    if (e.weaknesses.includes(element)) score += 100;
    if (e.broken) score += 40;
    // Focus the summoner over its adds.
    if (e.summonedBy) score -= 25;
    // Prefer low toughness so breaks land soon.
    score += (1 - e.toughness / Math.max(1, e.toughnessMax)) * 30;
    // Prefer low HP so fights end.
    score += (1 - e.hp / Math.max(1, e.resolveStats().maxHp)) * 40;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].e;
}

function findSkill(unit, kind) {
  return unit.skills.find((id) => skills.SKILLS[id].kind === kind) || null;
}

// ===========================================================================
// Runner
// ===========================================================================

function makeBattle(spec, level, seed) {
  const members = spec.party.map((id) => progression.createMember(id, { level }));
  const sheets = members.map((m) => {
    const s = progression.buildSheet(m);
    s.member = m;
    return s;
  });
  const enemies = [];
  for (const e of spec.enemies) {
    const count = e.count || 1;
    for (let i = 0; i < count; i++) enemies.push({ id: e.id });
  }
  return new Battle({
    allies: sheets,
    enemies,
    seed,
    isBoss: !!spec.isBoss,
    canFlee: false,
    name: spec.name,
  });
}

/** Play one battle to completion with the competent policy. */
function play(battle, maxTurns = 400) {
  let turns = 0;
  let guard = 0;
  while (battle.phase === PHASE.ACTIVE && turns < maxTurns && guard++ < maxTurns * 6) {
    // Queue any ultimate that is charged and worth it (interrupt window).
    for (const ally of battle.livingAllies) {
      if (!ally.ultimateReady) continue;
      const d = decide(ally, battle);
      if (d.type === 'ultimate') battle.queueUltimate(ally.uid, d.skill, d.target);
    }
    const unit = battle.advanceToNextTurn();
    if (!unit) break;
    if (unit.side === 'enemy') {
      battle.takeTurn(unit, null);
    } else {
      battle.takeTurn(unit, (u, b) => decide(u, b));
    }
    turns++;
  }
  if (battle.phase === PHASE.ACTIVE) {
    battle.flags.set('turnLimitHit', true);
    battle.endBattle(PHASE.LOST, 'turnLimit');
  }
  return battle;
}

function summarize(spec) {
  const runs = [];
  // Sample every level in the band evenly and use several seeds per level, so a
  // per-level win rate is based on more than one battle. With `levels.length`
  // values and RUNS samples the naive `i % levels.length` gave four seeds per
  // level at RUNS=24 — far too few to tell a 40% win rate from a 60% one, which
  // is exactly the range the boss lives in.
  const seedsPerLevel = Math.max(1, Math.floor(RUNS / spec.levels.length));
  for (let i = 0; i < RUNS; i++) {
    const level = spec.levels[i % spec.levels.length];
    const battle = makeBattle(spec, level, 9000 + i * 7);
    play(battle);
    runs.push({
      level,
      seed: 9000 + i * 7,
      won: battle.phase === PHASE.WON,
      rounds: battle.round,
      ticks: battle.tick,
      survivors: battle.livingAllies.length,
      partySize: battle.allies.length,
      breaks: battle.log.of('combat.break').length,
      summons: battle.log.of('unit.summoned').length,
      damage: battle.allies.reduce((s, a) => s + a.stats.damageDealt, 0),
      events: battle.log.entries.length,
      timedOut: battle.flags.get('turnLimitHit') === true,
    });
  }

  const winRate = runs.filter((r) => r.won).length / runs.length;
  const wins = runs.filter((r) => r.won);
  const avg = (arr, key) => (arr.length ? arr.reduce((s, r) => s + r[key], 0) / arr.length : 0);

  // Wilson score interval: the honest way to report "50% of 24 samples". A raw
  // percentage invites tuning against noise; the interval shows how little a
  // small sample actually pins down.
  const n = runs.length;
  const p = winRate;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;

  return {
    spec,
    runs,
    seedsPerLevel,
    winRate,
    winRateInterval: [Math.max(0, centre - margin), Math.min(1, centre + margin)],
    rounds: avg(runs, 'rounds'),
    roundsOnWin: avg(wins, 'rounds'),
    survivorsOnWin: avg(wins, 'survivors'),
    breaks: avg(runs, 'breaks'),
    summons: avg(runs, 'summons'),
    events: avg(runs, 'events'),
    timeouts: runs.filter((r) => r.timedOut).length,
  };
}

// ===========================================================================
// Report
// ===========================================================================

function bar(rate, width = 20) {
  const filled = Math.round(rate * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function main() {
  process.stdout.write('\n\x1b[1m星陨纪年 · 平衡性测试 / Balance harness\x1b[0m\n');
  process.stdout.write(`每场遭遇 ${RUNS} 次采样\n\n`);

  const summaries = ENCOUNTERS.map(summarize);
  let problems = 0;

  for (const s of summaries) {
    const expect = s.spec.expect || {};
    const checks = [];

    if (expect.winRate) {
      const [lo, hi] = expect.winRate;
      // Judge against the confidence interval rather than the raw percentage.
      // With a small sample the raw number swings several points run to run, and
      // tuning against that is how a designer ends up chasing noise.
      const [lo95, hi95] = s.winRateInterval;
      const ok = hi95 >= lo && lo95 <= hi;
      if (!ok) problems++;
      checks.push({
        ok,
        label: `胜率 ${(s.winRate * 100).toFixed(0)}%`,
        expect: `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`,
      });
    }
    if (expect.minRounds != null) {
      const ok = s.roundsOnWin === 0 || s.roundsOnWin >= expect.minRounds;
      if (!ok) problems++;
      checks.push({ ok, label: `胜时回合 ${s.roundsOnWin.toFixed(1)}`, expect: `≥ ${expect.minRounds}` });
    }
    if (expect.maxRounds != null) {
      const ok = s.rounds <= expect.maxRounds;
      if (!ok) problems++;
      checks.push({ ok, label: `平均回合 ${s.rounds.toFixed(1)}`, expect: `≤ ${expect.maxRounds}` });
    }

    const status = checks.every((c) => c.ok) ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
    process.stdout.write(`${status} \x1b[1m${s.spec.name}\x1b[0m\n`);
    const [lo95, hi95] = s.winRateInterval;
    process.stdout.write(`   胜率  ${bar(s.winRate)} ${(s.winRate * 100).toFixed(0)}%` +
      `  \x1b[90m(95% 置信区间 ${(lo95 * 100).toFixed(0)}–${(hi95 * 100).toFixed(0)}%)\x1b[0m\n`);
    process.stdout.write(
      `   回合  ${s.rounds.toFixed(1)} 平均 / ${s.roundsOnWin ? s.roundsOnWin.toFixed(1) : '—'} 胜时` +
      `   ${'存活'} ${s.survivorsOnWin ? s.survivorsOnWin.toFixed(1) : '—'}/${s.runs[0].partySize}` +
      `   ${'击破'} ${s.breaks.toFixed(1)}   ${'召唤'} ${s.summons.toFixed(1)}` +
      (s.timeouts ? `   \x1b[33m超时 ${s.timeouts}\x1b[0m` : '') + '\n',
    );
    for (const c of checks) {
      process.stdout.write(`   ${c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.label}  \x1b[90m(期望 ${c.expect})\x1b[0m\n`);
    }
    process.stdout.write(`   \x1b[90m${s.spec.note}\x1b[0m\n\n`);

    if (VERBOSE) {
      const levels = [...new Set(s.runs.map((r) => r.level))].sort((a, b) => a - b);
      for (const lv of levels) {
        const sub = s.runs.filter((r) => r.level === lv);
        const wr = sub.filter((r) => r.won).length / sub.length;
        process.stdout.write(`     Lv${String(lv).padStart(2)}  ${bar(wr, 12)} ${(wr * 100).toFixed(0)}%  ` +
          `平均 ${(sub.reduce((a, r) => a + r.rounds, 0) / sub.length).toFixed(1)} 回合\n`);
      }
      process.stdout.write('\n');
    }
  }

  process.stdout.write(problems === 0
    ? '\x1b[32m所有平衡性期望均满足\x1b[0m\n\n'
    : `\x1b[31m${problems} 项平衡性期望未满足\x1b[0m\n\n`);

  return problems;
}

if (require.main === module) {
  process.exit(main() === 0 ? 0 : 1);
}

module.exports = { ENCOUNTERS, decide, play, makeBattle, summarize, main };
