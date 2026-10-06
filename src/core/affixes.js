'use strict';

/**
 * Elite affixes.
 *
 * An affix is a named modifier rolled onto an enemy group at battle start, the
 * way a roguelike tags a room. It exists because the alternative is more
 * enemies, and a fixed roster can only be fought the same way every time — so
 * "the elite is interesting" silently becomes "the elite was interesting the
 * one time I met it".
 *
 * Three shapes of affix, and keeping them separate is the point:
 *
 *   `stats`   a static multiplier applied when the entity is built. Cheap and
 *             impossible to forget: it is part of the entity from tick one, so
 *             it cannot be skipped by a code path that forgets to check.
 *   `status`  a shield or a status applied at battle start, which reuses the
 *             existing status engine including its stacking and resist rules.
 *   `hooks`   a script hook. Expressive, but every one of these is a real code
 *             path that runs on a hot turn, so they are kept to two.
 *
 * `rewardMultiplier` is the honest way to make a harder affix worth taking:
 * tougher enemies that pay better, which is the trade a player can actually
 * reason about.
 *
 * Affixes are opt-in. An encounter that declares no `affixPool` gets none, so
 * every existing encounter keeps exactly the balance it was tuned for, and new
 * content can adopt them without retuning the old.
 */

const BALANCE = require('./rules').BALANCE;

const AFFIXES = {
  // -- stat affixes ---------------------------------------------------------

  fortified: {
    id: 'fortified',
    name: '坚壁',
    icon: '▣',
    weight: 10,
    tier: 1,
    desc: '韧性上限 +40%。打不打得动，看你的属性。',
    stats: { toughness: 0.4 },
  },
  swift: {
    id: 'swift',
    name: '迅捷',
    icon: '➤',
    weight: 10,
    tier: 1,
    desc: '速度 +30%，行动更频繁。推条与击破的价值变高。',
    stats: { spd: 0.30 },
  },
  savage: {
    id: 'savage',
    name: '凶暴',
    icon: '⚔',
    weight: 9,
    tier: 2,
    desc: '攻击 +32%，生命 −12%。',
    stats: { atk: 0.32, maxHp: -0.12 },
  },
  brittle: {
    id: 'brittle',
    name: '脆化',
    icon: '⧗',
    weight: 10,
    tier: 1,
    desc: '韧性 −40%、生命 −18%，攻击 +12%。碎得快，也咬得疼。',
    stats: { toughness: -0.40, maxHp: -0.18, atk: 0.12 },
  },

  // -- reward affixes -------------------------------------------------------

  greedy: {
    id: 'greedy',
    name: '贪婪',
    icon: '◈',
    weight: 11,
    tier: 1,
    desc: '经验与掉落 +60%，攻击 +10%。值钱的怪物通常不客气。',
    rewardMultiplier: 1.6,
    stats: { atk: 0.10 },
  },

  // -- shield affixes -------------------------------------------------------

  barrier: {
    id: 'barrier',
    name: '界障',
    icon: '▤',
    weight: 8,
    tier: 2,
    desc: '开战时获得等同于 18% 最大生命的护盾。',
    startShieldRatio: 0.18,
  },
  guardian: {
    id: 'guardian',
    name: '结界',
    icon: '❉',
    weight: 7,
    tier: 3,
    desc: '开战时为所有同伴附加 10% 最大生命的护盾。先拆它。',
    startShieldAlliesRatio: 0.10,
  },

  // -- hook affixes ---------------------------------------------------------

  /** Every turn it survives, it claws some of its health back. */
  regen: {
    id: 'regen',
    name: '再生',
    icon: '✚',
    weight: 8,
    tier: 2,
    desc: '每回合结束时回复 4% 最大生命。',
    hooks: [{ on: 'turnEnd', handler: 'affixRegen' }],
  },
  /**
   * The one affix that changes *how* you fight rather than how hard it hits:
   * basic attacks are punished, so the answer is skills and ultimates — which
   * costs skill points the party may not have. That is a real tension.
   */
  thorns: {
    id: 'thorns',
    name: '荆棘',
    icon: '❋',
    weight: 7,
    tier: 3,
    desc: '受到普通攻击时反弹 16% 所受伤害。改用战技与终结技。',
    hooks: [{ on: 'damaged', handler: 'affixThorns' }],
  },
};

const AFFIX_IDS = Object.keys(AFFIXES);

/**
 * Bosses never draw the raw-power snowballs. `swift` and `savage` multiply the
 * boss's already-huge atk/speed bundles — a boss that rolled both kills the
 * story-clear party in four rounds, which does not read as "rolled hard
 * affixes" but as "the game decided I lose". Boss affixes stay, but their pool
 * is the *pacing* set: shields, regeneration, thorns, greed — things that
 * change how you fight, not whether you are allowed to fight at all. Elites
 * draw from the full pool: one affix on a mid-tier stat bundle is a challenge,
 * not a coin flip on the run.
 */
const BOSS_BANNED = new Set(['swift', 'savage']);

function getAffix(id) {
  return AFFIXES[id] || null;
}

/**
 * Roll `count` affixes from `pool`.
 *
 * Deterministic on the battle's own RNG, so the same seed reproduces the same
 * affixes — which is what turns "the boss rolled two `savage` and I died" from
 * an anecdote into a reproducible report. De-duplicated: an affix twice on the
 * same entity would read as a bug even when the numbers say otherwise.
 */
function rollAffixes(pool, count, rng) {
  if (!pool || !pool.length) return [];
  const available = pool.filter((id) => getAffix(id));
  const picked = [];
  for (let i = 0; i < count && available.length; i++) {
    const total = available.reduce((sum, id) => sum + (getAffix(id).weight || 1), 0);
    if (total <= 0) break;
    let roll = rng.next() * total;
    for (let j = 0; j < available.length; j++) {
      roll -= getAffix(available[j]).weight || 1;
      if (roll <= 0) {
        picked.push(available[j]);
        available.splice(j, 1);
        break;
      }
    }
  }
  return picked;
}

/**
 * Roll the affixes a *fight* carries.
 *
 * This is the single place the shipped rule lives: a boss draws
 * `AFFIXES_PER_BOSS`, an elite `AFFIXES_PER_ELITE`, anything else none. It is
 * derived from the battle seed with a fixed scramble rather than the battle's
 * own RNG stream, so the affixes are stable per fight *and* independent of how
 * many rolls the battle itself makes — a policy tweak deep in the turn loop can
 * never retroactively change which affix the elite rolled.
 *
 * Both the session layer (`game._beginBattle`) and the balance harness must
 * call this, or the 60-run balance numbers would measure a fight players never
 * meet.
 */
function rollFightAffixes(battleSeed, opts = {}) {
  const count = opts.isBoss ? BALANCE.AFFIXES_PER_BOSS
    : opts.isElite ? BALANCE.AFFIXES_PER_ELITE : 0;
  if (!count) return [];
  const { Rng } = require('./rng');
  const rng = new Rng((battleSeed ^ 0x9e3779b9) >>> 0);
  const pool = opts.isBoss ? AFFIX_IDS.filter((id) => !BOSS_BANNED.has(id)) : AFFIX_IDS;
  return rollAffixes(pool, count, rng);
}

/** Summarise affixes for the client. */
function affixView(ids) {
  return (ids || []).map((id) => {
    const a = getAffix(id);
    return a
      ? { id: a.id, name: a.name, icon: a.icon, desc: a.desc, tier: a.tier }
      : { id, name: id, icon: '?', desc: '', tier: 0 };
  });
}

module.exports = { AFFIXES, AFFIX_IDS, getAffix, rollAffixes, rollFightAffixes, affixView };
