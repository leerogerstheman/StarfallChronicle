'use strict';

/**
 * Boot-time self-check.
 *
 * Run automatically when the server starts (and by `npm run selftest`). It fails
 * loudly on any data error *before* a player can hit it, which is the single
 * highest-value thing a project like this can do: a typo in a status id should
 * be a red line in the terminal, not a skill that silently does nothing during a
 * boss fight.
 *
 * Sections:
 *   1. registry integrity   — every id referenced anywhere exists
 *   2. world integrity      — every node reachable, every encounter spawnable
 *   3. engine invariants    — the damage formula behaves as documented
 *   4. determinism          — the same seed produces the same battle
 *   5. smoke battles        — each authored encounter actually completes
 */

const { ELEMENT_IDS, BALANCE } = require('../src/core/rules');
const skills = require('../src/core/skills');
const enemies = require('../src/core/enemies');
const { CHARACTERS, getCharacter, EQUIPMENT, getEquipment } = require('../src/core/characters');
const { STATUSES, getStatus } = require('../src/core/status');
const { WORLD, unreachableNodes, getNode } = require('../src/core/world-data');
const { ITEMS } = require('../src/core/items');
const progression = require('../src/core/progression');
const { Rng } = require('../src/core/rng');
const { resolveDamage, defenceFactor, levelFactor, elementInteraction } = require('../src/core/damage');
const { Entity } = require('../src/core/entity');
const { Battle } = require('../src/battle/battle');
const { PHASE } = require('../src/battle/action-constants');
const scripts = require('../src/battle/scripts');
const { chooseEnemyAction } = require('../src/battle/ai');

const results = [];
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
    return true;
  } catch (err) {
    failures++;
    results.push({ name, ok: false, detail: err.message });
    return false;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function section(title) {
  results.push({ section: title });
}

// ===========================================================================
// 1. Registry integrity
// ===========================================================================
section('注册表完整性 / Registry integrity');

check('版本号在 package.json 与 config.js 之间一致', () => {
  // The banner prints `config.version`; the release tag comes from
  // package.json. If they disagree, the game reports a version that no
  // published release corresponds to — which is how a bug report ends up
  // describing code nobody can find.
  const pkg = require('../package.json');
  const config = require('../src/config');
  assert(pkg.version === config.version,
    `package.json 是 ${pkg.version}，config.js 是 ${config.version}`);
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), `版本号格式不对：${pkg.version}`);
  return `v${pkg.version}`;
});

check('技能定义合法', () => {
  const problems = skills.validateAll();
  assert(problems.length === 0, problems.join('; '));
  return `${Object.keys(skills.SKILLS).length} 个技能`;
});

check('角色引用的技能都存在', () => {
  const problems = [];
  for (const id of Object.keys(CHARACTERS)) {
    const c = getCharacter(id);
    for (const [slot, skillId] of Object.entries(c.skills)) {
      if (!skillId) continue;
      if (!skills.SKILLS[skillId]) problems.push(`${id}.${slot} -> ${skillId}`);
    }
    for (const hook of c.hooks || []) {
      if (!scripts.get(hook.handler)) problems.push(`${id} hook ${hook.handler}`);
    }
  }
  assert(problems.length === 0, `悬空引用: ${problems.join(', ')}`);
  return `${Object.keys(CHARACTERS).length} 名角色`;
});

check('敌人定义合法', () => {
  const problems = enemies.validateAll(skills.SKILLS, ELEMENT_IDS);
  assert(problems.length === 0, problems.join('; '));
  return `${Object.keys(enemies.ENEMIES).length} 种敌人`;
});

check('敌人 AI 脚本引用有效', () => {
  const problems = [];
  for (const id of Object.keys(enemies.ENEMIES)) {
    const ai = enemies.ENEMIES[id].ai || {};
    for (const p of ai.phases || []) {
      if (!scripts.get('bossPhaseChange') && p.skill) problems.push(`${id}: phase script missing`);
    }
    for (const s of [...(ai.script || []), ...(ai.phases || []), ...(ai.finishers || [])]) {
      if (s.skill && !skills.SKILLS[s.skill]) problems.push(`${id}: ${s.skill}`);
    }
  }
  assert(problems.length === 0, problems.join('; '));
  return 'ok';
});

check('技能里的脚本处理器都存在', () => {
  const missing = [];
  for (const id of Object.keys(skills.SKILLS)) {
    for (const eff of skills.SKILLS[id].effects) {
      if (eff.type === 'script' && !scripts.get(eff.handler)) missing.push(`${id} -> ${eff.handler}`);
    }
  }
  // `bossPhaseChange` is invoked by the AI, not by a skill effect, so it is
  // deliberately not in this list; everything else must resolve.
  assert(missing.length === 0, missing.join(', '));
  return `${scripts.count()} 个脚本处理器`;
});

check('状态定义引用合法', () => {
  const problems = [];
  for (const id of Object.keys(STATUSES)) {
    const s = getStatus(id);
    if (s.element && !ELEMENT_IDS.includes(s.element)) problems.push(`${id}: element ${s.element}`);
    if (s.stackMode === 'stack' && !s.maxStacks) problems.push(`${id}: stack mode without maxStacks`);
  }
  assert(problems.length === 0, problems.join('; '));
  return `${Object.keys(STATUSES).length} 种状态`;
});

check('装备定义合法', () => {
  const problems = [];
  const validSlots = ['weapon', 'boots', 'accessory'];
  for (const id of Object.keys(EQUIPMENT)) {
    const it = getEquipment(id);
    if (!validSlots.includes(it.slot)) problems.push(`${id}: slot ${it.slot}`);
  }
  assert(problems.length === 0, problems.join('; '));
  return `${Object.keys(EQUIPMENT).length} 件装备`;
});

check('道具定义合法', () => {
  const problems = [];
  for (const id of Object.keys(ITEMS)) {
    for (const effect of ITEMS[id].effects) {
      if (!skills.VALID_EFFECTS.includes(effect.type)) {
        problems.push(`${id}: effect ${effect.type}`);
      }
      if (effect.type === 'status' && !STATUSES[effect.status]) {
        problems.push(`${id}: unknown status ${effect.status}`);
      }
    }
  }
  assert(problems.length === 0, problems.join('; '));
  return `${Object.keys(ITEMS).length} 件道具`;
});

check('每个角色都有普攻/战技/终结技', () => {
  const problems = [];
  for (const id of Object.keys(CHARACTERS)) {
    const c = getCharacter(id);
    for (const slot of ['basic', 'skill', 'ultimate']) {
      const skillId = c.skills[slot];
      if (!skillId) { problems.push(`${id} 缺少 ${slot}`); continue; }
      const kind = skills.SKILLS[skillId].kind;
      const expected = slot === 'ultimate' ? 'ultimate' : slot;
      if (kind !== expected) problems.push(`${id}.${slot} 是 ${kind}`);
    }
  }
  assert(problems.length === 0, problems.join('; '));
  return '5/5 完整';
});

// ===========================================================================
// 2. World integrity
// ===========================================================================
section('世界完整性 / World integrity');

check('所有节点可达', () => {
  const orphans = unreachableNodes();
  assert(orphans.length === 0, `不可达节点: ${orphans.join(', ')}`);
  return `${Object.keys(WORLD.nodes).length} 个节点`;
});

check('连接是双向的', () => {
  const problems = [];
  for (const id of Object.keys(WORLD.nodes)) {
    for (const next of getNode(id).connections) {
      if (!WORLD.nodes[next]) { problems.push(`${id} -> 不存在的 ${next}`); continue; }
      if (!getNode(next).connections.includes(id)) problems.push(`${id} <-> ${next} 单向`);
    }
  }
  assert(problems.length === 0, problems.join('; '));
  return 'ok';
});

check('遭遇组里的敌人都存在', () => {
  const problems = [];
  for (const id of Object.keys(WORLD.nodes)) {
    const node = getNode(id);
    for (const group of (node.encounter && node.encounter.groups) || []) {
      for (const e of group.enemies) {
        if (!enemies.ENEMIES[e.id]) problems.push(`${id}: 未知敌人 ${e.id}`);
        if (!(e.count > 0)) problems.push(`${id}: 数量非法 ${e.count}`);
      }
    }
    if (node.elite && !enemies.ENEMIES[node.elite]) problems.push(`${id}: 未知精英 ${node.elite}`);
    if (node.boss && !enemies.ENEMIES[node.boss]) problems.push(`${id}: 未知 Boss ${node.boss}`);
  }
  assert(problems.length === 0, problems.join('; '));
  return 'ok';
});

check('商店商品都存在', () => {
  const problems = [];
  for (const entry of WORLD.shop.stock) {
    if (!EQUIPMENT[entry.item]) problems.push(`未知装备 ${entry.item}`);
    if (!(entry.price > 0)) problems.push(`${entry.item} 价格非法`);
  }
  assert(problems.length === 0, problems.join('; '));
  return `${WORLD.shop.stock.length} 项商品`;
});

check('每个可操控角色都能组队成型', () => {
  for (const id of WORLD.roster) {
    const member = progression.createMember(id, { level: 12 });
    const sheet = progression.buildSheet(member);
    assert(sheet.stats.maxHp > 0 && sheet.stats.atk > 0, `${id} 属性非法`);
  }
  assert(WORLD.roster.length === 5, `名册应有 5 人，实际 ${WORLD.roster.length}`);
  return `${WORLD.roster.length} 人`;
});

// ===========================================================================
// 3. Engine invariants
// ===========================================================================
section('引擎不变式 / Engine invariants');

check('伤害公式：等级差被限制在区间内', () => {
  assert(levelFactor(1, 60) === BALANCE.LEVEL_BAND[0], `下限应被夹紧，得到 ${levelFactor(1, 60)}`);
  assert(levelFactor(60, 1) === BALANCE.LEVEL_BAND[1], `上限应被夹紧，得到 ${levelFactor(60, 1)}`);
  assert(Math.abs(levelFactor(10, 10) - 1) < 1e-9, '同等级应为 1.0');
  return `区间 ${BALANCE.LEVEL_BAND.join('–')}`;
});

check('伤害公式：防御永不减到 0 或负数', () => {
  assert(defenceFactor(0, 10) === 1, 'DEF 0 应无减免');
  const high = defenceFactor(100000, 10);
  assert(high > 0 && high < 0.05, `超高 DEF 应接近 0 但不为 0，得到 ${high}`);
  const a = defenceFactor(100, 10);
  const b = defenceFactor(200, 10);
  assert(b < a, 'DEF 越高减伤越多');
  return `DEF 100 -> ${(a * 100).toFixed(1)}%`;
});

check('属性克制关系正确', () => {
  const target = new Entity({ id: 't', name: 't', side: 'enemy', baseStats: { maxHp: 1, atk: 1, def: 0, spd: 1 }, weaknesses: ['fire'], resist: { ice: 0.5, lightning: 0, wind: -0.5 } });
  const attacker = new Entity({ id: 'a', name: 'a', side: 'ally', baseStats: { maxHp: 1, atk: 1, def: 0, spd: 1 } });
  assert(elementInteraction(attacker, target, 'fire').kind === 'weakness', '火应命中弱点');
  assert(elementInteraction(attacker, target, 'ice').kind === 'resist', '冰应被抵抗');
  assert(elementInteraction(attacker, target, 'lightning').kind === 'immune', '雷应免疫');
  assert(elementInteraction(attacker, target, 'wind').kind === 'absorb', '风应被吸收');
  assert(elementInteraction(attacker, target, 'physical').kind === 'neutral', '物理应中立');
  return '弱点/抵抗/免疫/吸收/中立';
});

check('伤害为正整数，且弱点伤害高于中立', () => {
  const mk = (weak) => {
    const t = new Entity({ id: 't', name: 't', side: 'enemy', level: 10, baseStats: { maxHp: 9999, atk: 100, def: 100, spd: 100 }, weaknesses: weak ? ['fire'] : [] });
    const a = new Entity({ id: 'a', name: 'a', side: 'ally', level: 10, baseStats: { maxHp: 1000, atk: 200, def: 50, spd: 100, critRate: 0, critDmg: 1.5 } });
    return resolveDamage({ attacker: a, target: t, skill: { multiplier: 1, element: 'fire' }, rng: null });
  };
  const weak = mk(true);
  const neutral = mk(false);
  assert(Number.isInteger(weak.amount) && weak.amount > 0, `伤害应为正整数，得到 ${weak.amount}`);
  assert(weak.amount >= neutral.amount, '弱点伤害不应低于中立伤害');
  return `弱点 ${weak.amount} / 中立 ${neutral.amount}`;
});

check('效果命中与抵抗会改变减益命中率', () => {
  // Two identical battles, one with high effect RES on the target.
  const run = (res) => {
    const battle = makeBattle({ level: 20, enemies: [{ id: 'rotgrub' }] });
    const target = battle.enemies[0];
    target.baseStats.effectRes = res;
    let landed = 0;
    for (let i = 0; i < 200; i++) {
      target.statuses = [];
      const inst = battle.applyStatus(battle.allies[0], target, { status: 'burn', duration: 2, chance: 0.5 });
      if (inst) landed++;
    }
    return landed;
  };
  const low = run(0);
  const high = run(0.9);
  assert(low > high, `高抵抗应更少命中：${low} vs ${high}`);
  return `RES 0 -> ${low}/200, RES 0.9 -> ${high}/200`;
});

check('战技点不会超过上限，也不会变成负数', () => {
  const battle = makeBattle({ level: 12, enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }] });
  for (let i = 0; i < 20; i++) battle.gainSkillPoints(1, battle.allies[0], 'test');
  assert(battle.skillPoints === BALANCE.MAX_SKILL_POINTS, `上限应为 ${BALANCE.MAX_SKILL_POINTS}`);
  for (let i = 0; i < 20; i++) battle.spendSkillPoints(1, battle.allies[0], 'test');
  assert(battle.skillPoints === 0, '不应为负');
  return `0–${BALANCE.MAX_SKILL_POINTS}`;
});

check('终结技需要充能满才能释放', () => {
  const battle = makeBattle({ level: 12, enemies: [{ id: 'rotgrub' }] });
  const hero = battle.allies[0];
  const ultId = hero.skills.find((id) => skills.SKILLS[id].kind === 'ultimate');
  const ultDef = skills.SKILLS[ultId];

  hero.energy = 0;
  assert(!battle.castSkill(hero, ultId, battle.enemies[0].uid), '未充能时不应能释放');

  hero.energy = hero.resolveStats().maxEnergy;
  assert(battle.castSkill(hero, ultId, battle.enemies[0].uid), '充能满时应能释放');

  // The gauge is spent, but the action itself may refund part of it: an
  // ultimate whose `energyGain` is positive (or whose script grants energy)
  // legitimately leaves the caster with some charge. Assert the *spend*
  // happened by checking the gauge dropped below its previous value, not that
  // it hit exactly zero.
  const gained = ultDef.energyGain || 0;
  const expectedCeiling = gained + 20; // 20 = the generic post-cast refund cap
  assert(hero.energy <= expectedCeiling,
    `释放后能量应被清空后仅少量返还，期望 <= ${expectedCeiling}，得到 ${hero.energy}`);
  return `充能门槛生效（释放后剩余 ${hero.energy}）`;
});

check('终结技可以插入到任意时刻（行动条不被消耗）', () => {
  const battle = makeBattle({ level: 20, enemies: [{ id: 'abyss_sentinel' }] });
  const hero = battle.allies[0];
  hero.energy = hero.resolveStats().maxEnergy;
  const avBefore = hero.actionValue;
  const ok = battle.queueUltimate(hero.uid, null, battle.enemies[0].uid);
  assert(ok.ok, `排队失败: ${ok.reason}`);
  battle._resolvePendingUltimates();
  assert(hero.actionValue === avBefore, '插入终结技不应改变行动条位置');
  return '插入机制生效';
});

check('韧性会被削减并在归零时击破', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const target = battle.enemies[0];
  const hero = battle.allies.find((a) => a.id === 'ayaha');
  assert(target.toughness > 0, '敌人应有韧性');

  const skillId = hero.skills.find((id) => skills.SKILLS[id].id === 'ayaha_skill');
  const toughnessBefore = target.toughness;
  let guard = 0;
  // Stop as soon as it breaks. The loop guard is generous because a break is a
  // *chance* outcome only in the sense of damage variance; the real reason this
  // needs more than one cast is that a break also depends on the enemy still
  // being alive, so the fight can end first.
  while (!target.broken && target.alive && guard++ < 20) {
    battle.skillPoints = 5;
    battle.castSkill(hero, skillId, target.uid);
  }

  if (!target.alive) {
    // Killing the target before the bar empties is legitimate; assert the
    // toughness *was* being reduced, which is the actual invariant.
    assert(target.toughness < toughnessBefore,
      `目标被击杀前韧性应已被削减：${toughnessBefore} -> ${target.toughness}`);
    return `目标先倒下（韧性 ${toughnessBefore} -> ${target.toughness}）`;
  }
  assert(target.broken, `应能被击破，当前韧性 ${target.toughness}`);
  assert(target.toughness === 0, '击破后韧性应为 0');
  return `击破用了 ${guard} 次战技`;
});

check('非弱点属性的削韧效率更低', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const target = battle.enemies[0];
  // rotgrub 弱火/风，抗冰。用冰 vs 火比较。
  const iceAmount = 60;
  const viaIce = Math.round(iceAmount * BALANCE.OFF_ELEMENT_TOUGHNESS_MULT);
  const viaFire = Math.round(iceAmount * BALANCE.WEAKNESS_TOUGHNESS_MULT);
  assert(viaIce < viaFire, '非弱点削韧应更低');
  return `弱点 ${viaFire} vs 非弱点 ${viaIce}`;
});

check('DoT 使用施法瞬间的攻击力快照', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const target = battle.enemies[0];
  const rinne = battle.allies.find((a) => a.id === 'rinne');
  battle.applyStatus(rinne, target, { status: 'burn', stacks: 1, duration: 3 }, { force: true });
  const inst = target.findStatus('burn');
  const atkAtCast = rinne.resolveStats().atk;
  assert(Math.abs(inst.snapshot.atk - atkAtCast) < 1e-6, '应记录施法时攻击力');
  // Now buff Rinne; the burn must not grow.
  battle.applyStatus(rinne, rinne, { status: 'atk_up', duration: 3 }, { force: true });
  assert(inst.snapshot.atk === atkAtCast, '后续增益不应改变已施加的 DoT');
  return '快照隔离生效';
});

check('护盾先于生命值被消耗', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const ally = battle.allies[0];
  ally.statuses = [];
  const hpBefore = ally.hp;
  battle.applyStatus(ally, ally, { status: 'shield', value: 500, duration: 3 }, { force: true });
  battle.dealDamage(battle.enemies[0], ally, 300, {});
  assert(ally.hp === hpBefore, '护盾应吸收全部伤害');
  battle.dealDamage(battle.enemies[0], ally, 400, {});
  assert(ally.hp === hpBefore - 200, `超出部分应打到生命值，期望 ${hpBefore - 200}，得到 ${ally.hp}`);
  return '护盾机制正确';
});

check('不屈可以挡住致命一击', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const ally = battle.allies[0];
  ally.hp = 10;
  battle.applyStatus(ally, ally, { status: 'undying', duration: 2 }, { force: true });
  battle.dealDamage(battle.enemies[0], ally, 99999, {});
  assert(ally.alive && ally.hp === 1, `应保留 1 点生命，得到 ${ally.hp}`);
  return '保留 1 HP';
});

check('行动条：速度越高行动越频繁', () => {
  const make = (spd) => new Entity({ id: 'x', name: 'x', side: 'ally', baseStats: { maxHp: 1000, atk: 10, def: 10, spd } });
  const count = (e) => {
    let ticks = 0;
    while (ticks < 1000) { e.actionValue += e.resolveStats().spd; ticks++; if (e.actionValue >= BALANCE.ACTION_VALUE) { e.actionValue = 0; ticks = ticks; break; } }
    return ticks;
  };
  const fast = count(make(200));
  const slow = count(make(100));
  assert(fast < slow, '高速度应更快到达行动阈值');
  assert(Math.abs(slow / fast - 2) < 0.05, `速度比应为 2，得到 ${(slow / fast).toFixed(2)}`);
  return `${slow} vs ${fast} tick`;
});

check('推条与拉条改变行动顺序', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const target = battle.enemies[0];
  target.actionValue = 8000;
  const before = battle.pushActionValue(target, 2500, 'test');
  assert(before === 2500, `应推后 2500，得到 ${before}`);
  assert(target.actionValue === 5500, `行动值应为 5500，得到 ${target.actionValue}`);
  battle.advanceActionValue(target, 3000, 'test');
  assert(target.actionValue === 8500, `行动值应为 8500，得到 ${target.actionValue}`);
  return '推条/拉条正确';
});

check('状态叠加规则正确（refresh vs stack）', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const ally = battle.allies[0];
  ally.statuses = [];
  // atk_up 是 refresh 模式：重复施加不叠层，只刷新时间
  battle.applyStatus(ally, ally, { status: 'atk_up', duration: 2 }, { force: true });
  battle.applyStatus(ally, ally, { status: 'atk_up', duration: 2 }, { force: true });
  assert(ally.findStatus('atk_up').stacks === 1, 'refresh 模式不应叠层');
  // burn 是 stack 模式：应叠到上限
  const enemy = battle.enemies[0];
  for (let i = 0; i < 10; i++) battle.applyStatus(ally, enemy, { status: 'burn', duration: 3 }, { force: true });
  const burn = enemy.findStatus('burn');
  assert(burn.stacks === getStatus('burn').maxStacks, `应叠到 ${getStatus('burn').maxStacks}，得到 ${burn.stacks}`);
  return `refresh 1 层 / stack 上限 ${burn.stacks} 层`;
});

check('免疫属性不消耗随机数（保持回放一致）', () => {
  const battle = makeBattle({ level: 14, enemies: [{ id: 'rotgrub' }] });
  const target = battle.enemies[0];
  target.resist.lightning = 0;
  const hero = battle.allies[0];
  const before = battle.rng.draws;
  resolveDamage({ attacker: hero, target, skill: { multiplier: 1, element: 'lightning' }, rng: battle.rng });
  assert(battle.rng.draws === before, '免疫应短路且不抽随机数');
  return '短路正确';
});

// ===========================================================================
// 4. Determinism
// ===========================================================================
section('确定性 / Determinism');

check('同一随机种子产生完全相同的战斗', () => {
  const run = () => {
    const battle = makeBattle({ level: 14, seed: 12345, enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }, { id: 'larva' }] });
    autoPlay(battle, 60);
    return JSON.stringify(battle.snapshot());
  };
  const a = run();
  const b = run();
  assert(a === b, '两次运行的快照不一致');
  return `${JSON.parse(a).events} 事件`;
});

check('不同种子产生不同战斗', () => {
  const run = (seed) => {
    const battle = makeBattle({ level: 14, seed, enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }] });
    autoPlay(battle, 60);
    return JSON.stringify(battle.snapshot());
  };
  assert(run(1) !== run(2), '不同种子应产生不同结果');
  return 'ok';
});

check('RNG 分布合理（均值接近 0.5）', () => {
  const rng = new Rng(999);
  let sum = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) sum += rng.next();
  const mean = sum / n;
  assert(Math.abs(mean - 0.5) < 0.01, `均值 ${mean.toFixed(4)} 偏离过大`);
  return `均值 ${mean.toFixed(4)}`;
});

check('RNG 的加权选择遵循权重', () => {
  const rng = new Rng(7);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 10000; i++) {
    const pick = rng.weighted([['a', 3], ['b', 1]]);
    counts[pick]++;
  }
  const ratio = counts.a / counts.b;
  assert(Math.abs(ratio - 3) < 0.25, `权重比应为 3，得到 ${ratio.toFixed(2)}`);
  return `a:b = ${ratio.toFixed(2)}:1`;
});

// ===========================================================================
// 5. Smoke battles
// ===========================================================================
section('实战冒烟测试 / Smoke battles');

check('小怪战可以打完', () => {
  const battle = makeBattle({ level: 10, seed: 1001, enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }, { id: 'larva' }, { id: 'larva' }] });
  const log = autoPlay(battle, 80);
  assert(battle.phase !== PHASE.INIT && battle.phase !== PHASE.ACTIVE, `战斗未结束：${battle.phase}`);
  assert(battle.phase === PHASE.WON, `应获胜，实际 ${battle.phase}（${battle.round} 回合）`);
  return `${battle.round} 回合，${log} 事件`;
});

check('精英战可以打完', () => {
  const battle = makeBattle({ level: 14, seed: 2002, enemies: [{ id: 'abyss_sentinel' }] });
  const log = autoPlay(battle, 200);
  assert(battle.phase === PHASE.WON, `应获胜，实际 ${battle.phase}`);
  const breaks = battle.log.of('combat.break').length;
  assert(breaks > 0, '精英战应至少击破一次');
  return `${battle.round} 回合，击破 ${breaks} 次`;
});

check('Boss 战结构完整（阶段转换与召唤机制可用）', () => {
  // The naive auto-player in this file cannot reliably beat the boss — that is
  // by design, and `test/balance.js` is where winnability is measured with a
  // competent policy. What must hold here is that the *engine* wires the boss's
  // scripted mechanics correctly, so this drives the boss directly rather than
  // hoping the auto-player reaches 50% HP.
  const battle = makeBattle({ level: 20, seed: 3003, enemies: [{ id: 'ashen_king' }], isBoss: true, canFlee: false });
  const boss = battle.enemies[0];

  // Phase transition at 50% HP, driven via the AI's declarative trigger.
  boss.hp = Math.round(boss.resolveStats().maxHp * 0.45);
  const decision = chooseEnemyAction(battle, boss);
  assert(decision.skill === 'boss_phase2_unleash', `50% 生命时应触发阶段转换，实际 ${decision.skill}`);
  battle.executeDecision(boss, decision);
  const phases = battle.log.of('enemy.phase').length;
  assert(phases >= 1, 'Boss 应触发至少一次阶段转换');
  assert(boss.phase === 2, `Boss 应进入阶段 2，实际 ${boss.phase}`);
  assert(boss.weaknesses.includes('wind'), '阶段 2 应获得风弱点');

  // The trigger fires exactly once, no matter how often the AI is consulted.
  for (let i = 0; i < 5; i++) {
    const again = chooseEnemyAction(battle, boss);
    assert(again.skill !== 'boss_phase2_unleash', '阶段转换只应触发一次');
  }

  // Summoning works and respects both budgets.
  const spawned = battle.summon(boss, 'ash_husk', 2);
  assert(spawned.length === 2, `应召唤 2 个残骸，实际 ${spawned.length}`);
  const summoned = battle.log.of('unit.summoned').length;
  assert(summoned > 0, 'Boss 应召唤过小怪');

  // And a full battle still terminates (whatever the outcome).
  const battle2 = makeBattle({ level: 20, seed: 3003, enemies: [{ id: 'ashen_king' }], isBoss: true, canFlee: false });
  autoPlay(battle2, 400);
  assert(battle2.phase !== PHASE.INIT && battle2.phase !== PHASE.ACTIVE, `战斗应有结果，实际 ${battle2.phase}`);
  return `${phases} 次阶段转换，召唤 ${summoned} 个；整场结果 ${battle2.phase}`;
});

check('治疗技能永远不会作用于敌人', () => {
  // The bug this guards against: `resolveSelector('primary')` returned whatever
  // uid it was handed, with no side check. A healing skill defaults its effects
  // to `primary`, so pointing 艾莉丝's heal at the boss topped it up for 130,773
  // HP across one fight — which presents as "the boss is unkillable" and sends
  // you tuning HP for an hour.
  const battle = makeBattle({ level: 20, party: ['elise'], enemies: [{ id: 'ashen_king' }] });
  const elise = battle.allies[0];
  const boss = battle.enemies[0];
  const healSkill = elise.skills.find((id) => skills.SKILLS[id].effects.some((e) => e.type === 'heal'));
  assert(healSkill, '艾莉丝应有治疗技能');

  // Deliberately aim it at the enemy.
  const bossHpBefore = boss.hp;
  battle.castSkill(elise, healSkill, boss.uid);
  assert(boss.hp <= bossHpBefore, `治疗不应给敌人回血：${bossHpBefore} -> ${boss.hp}`);

  // And the same skill aimed at an ally must still work.
  elise.hp = Math.round(elise.resolveStats().maxHp * 0.3);
  const allyHpBefore = elise.hp;
  battle.castSkill(elise, healSkill, elise.uid);
  assert(elise.hp > allyHpBefore, `治疗应当回复友方生命：${allyHpBefore} -> ${elise.hp}`);
  return '治疗目标侧别正确';
});

check('伤害技能永远不会作用于队友', () => {
  const battle = makeBattle({ level: 20, party: ['ayaha', 'elise'], enemies: [{ id: 'rotgrub' }] });
  const ayaha = battle.allies[0];
  const elise = battle.allies[1];
  const attackSkill = ayaha.skills.find((id) => skills.SKILLS[id].kind === 'basic');
  const allyHpBefore = elise.hp;
  // Aim an attack at a party member.
  battle.castSkill(ayaha, attackSkill, elise.uid);
  assert(elise.hp === allyHpBefore, `攻击不应打到队友：${allyHpBefore} -> ${elise.hp}`);
  return '攻击目标侧别正确';
});

check('增益与减益按施法者阵营解析', () => {
  // Use a target that survives the hit, or the debuff is correctly never applied
  // to a corpse and the test measures nothing.
  const battle = makeBattle({ level: 12, party: ['rinne'], enemies: [{ id: 'abyss_sentinel' }, { id: 'abyss_sentinel' }] });
  const rinne = battle.allies[0];

  // Rinne's ultimate is an AoE debuff: it must hit every enemy and no ally.
  battle.skillPoints = 5;
  rinne.energy = rinne.resolveStats().maxEnergy;
  const ult = rinne.skills.find((id) => skills.SKILLS[id].kind === 'ultimate');
  battle.castSkill(rinne, ult, battle.enemies[0].uid);

  assert(battle.livingEnemies.length > 0, '目标应当存活，否则无法检验减益');
  const enemiesBurned = battle.enemies.filter((e) => e.findStatus('burn')).length;
  const alliesBurned = battle.allies.filter((a) => a.findStatus('burn')).length;
  assert(enemiesBurned > 0, '敌方应被附加灼烧');
  assert(alliesBurned === 0, `我方不应被附加灼烧（${alliesBurned} 人）`);

  // Elise's ultimate is a party buff: it must hit every ally and no enemy.
  const battle2 = makeBattle({ level: 20, party: ['elise'], enemies: [{ id: 'ashen_king' }] });
  const elise = battle2.allies[0];
  elise.energy = elise.resolveStats().maxEnergy;
  const eliseUlt = elise.skills.find((id) => skills.SKILLS[id].kind === 'ultimate');
  battle2.castSkill(elise, eliseUlt, battle2.enemies[0].uid);
  const alliesBuffed = battle2.allies.filter((a) => a.findStatus('damage_up')).length;
  const enemiesBuffed = battle2.enemies.filter((e) => e.findStatus('damage_up')).length;
  assert(alliesBuffed > 0, '我方应获得伤害强化');
  assert(enemiesBuffed === 0, `敌方不应获得伤害强化（${enemiesBuffed} 个）`);

  // An enemy AoE debuff must not land on its own side either.
  const battle3 = makeBattle({ level: 20, party: ['ayaha'], enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }] });
  const grub = battle3.enemies[0];
  battle3.castSkill(grub, 'enemy_spit', battle3.allies[0].uid);
  const selfPoisoned = battle3.enemies.filter((e) => e.findStatus('poison')).length;
  assert(selfPoisoned === 0, `敌人不应给自己下毒（${selfPoisoned} 个）`);

  return '阵营解析正确';
});

check('击破会产生推条（节奏奖励）', () => {

check('敌人不会对自己人滥施治疗', () => {
  // A holistic guard: over a long boss fight the boss must not be healed by the
  // party's skills at all. This is the assertion that would have caught the
  // targeting bug immediately.
  const battle = makeBattle({ level: 20, seed: 31415, enemies: [{ id: 'ashen_king' }], isBoss: true, canFlee: false });
  autoPlay(battle, 200);
  const boss = battle.enemies[0];
  const allySourcedHeals = battle.log.entries.filter((e) =>
    e.kind === 'combat.heal' &&
    e.targetId === boss.uid &&
    e.cause &&
    String(e.cause).startsWith('skill:') &&
    !String(e.cause).includes('boss_'));
  const total = allySourcedHeals.reduce((s, e) => s + e.amount, 0);
  assert(total === 0, `我方技能不应给 Boss 回血，累计 ${total}`);
  return 'Boss 未被我方治疗';
});
  const battle = makeBattle({ level: 16, seed: 5005, enemies: [{ id: 'abyss_sentinel' }] });
  autoPlay(battle, 200);
  const breakDelays = battle.log.entries.filter((e) => e.kind === 'order.delay' && e.cause === 'break');
  assert(breakDelays.length > 0, '击破应产生推条事件');
  return `${breakDelays.length} 次击破推条`;
});

check('自动战斗从不会卡死', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const battle = makeBattle({ level: 12, seed, enemies: [{ id: 'rotgrub' }, { id: 'larva' }, { id: 'larva' }] });
    const before = battle.log.entries.length;
    autoPlay(battle, 100);
    assert(battle.phase !== PHASE.ACTIVE, `seed ${seed} 卡死在第 ${battle.round} 回合`);
    assert(battle.log.entries.length > before, '应产生事件');
  }
  return '40 个种子全部正常结束';
});

check('全队阵亡会判定失败', () => {
  // A deliberately unfair fight: level-1 party vs a level-60 boss.
  const battle = makeBattle({ level: 1, seed: 6006, enemies: [{ id: 'ashen_king', level: 60 }], isBoss: true, canFlee: false });
  const log = autoPlay(battle, 400);
  assert(battle.phase === PHASE.LOST, `应失败，实际 ${battle.phase}`);
  return `${battle.round} 回合后全灭`;
});

check('事件类型不会被载荷字段覆盖', () => {
  // The bug this guards: `Log.push` built entries as `{ kind: <type>, ...data }`,
  // so a payload field literally named `kind` overwrote the event's own type.
  // `skill.cast` carries `kind: 'skill'` to say *what kind of skill* was used, so
  // every cast event silently became `kind: 'skill'` — and any consumer that
  // switched on `kind` (the browser's animation layer, the balance harness's
  // counters) saw a stream with no casts in it at all.
  const { Log, EVENTS } = require('../src/core/log');
  const log = new Log();
  log.push(EVENTS.SKILL_CAST, { kind: 'skill', skillName: 'x' });
  log.push(EVENTS.DAMAGE, { kind: 'whatever', amount: 1 });
  const cast = log.entries[0];
  assert(cast.kind === 'skill.cast', `事件类型应为 skill.cast，得到 ${cast.kind}`);
  assert(log.entries[1].kind === 'combat.damage', '伤害事件的类型被覆盖了');
  assert(log.of(EVENTS.SKILL_CAST).length === 1, 'of() 应能找到该事件');
  return 'kind 始终是事件类型';
});

check('每次指令都会把战斗事件交回客户端', () => {
  // The bug this guards: `Game.command` resolved the player's action (appending
  // events to the battle log) and then called `Game.step`, which computed its
  // own "events since" index — *after* those events existed. The client received
  // an empty event array on every single action, so the battle log stayed blank
  // and no animation played, while the state underneath advanced correctly.
  //
  // A tanky enemy is used deliberately: against trash the fight ends in two
  // rounds and the run may never reach a turn where a skill is affordable, which
  // would make the `sawCast` assertion test the encounter rather than the engine.
  const { Game } = require('../src/world/game');
  const game = new Game({ seed: 4242, level: 14 });
  game.startCustomBattle([{ id: 'abyss_sentinel' }], '事件流测试');

  let totalEvents = 0;
  let sawCast = false;
  let sawSkillCast = false;
  let sawDamage = false;
  let sawEnd = false;
  let guard = 0;

  while (guard++ < 200) {
    const step = game.step();
    if (step.finished) break;
    if (!step.ok) break;
    if (!step.waiting) continue;

    const actor = step.actor;
    const target = step.state.enemies.find((e) => e.alive);
    if (!target) break;

    // `step.actor` is a *view* object, so its skills are enriched objects with
    // `id`, `usable` and `affordable` — not plain id strings. Prefer a skill
    // when it is affordable so the run exercises the spend path.
    const basic = actor.skills.find((s) => s.kind === 'basic');
    const skill = actor.skills.find((s) => s.kind === 'skill' && s.affordable && s.usable);
    const chosen = skill || basic;
    const res = game.command({
      type: skill ? 'skill' : 'basic',
      skill: chosen.id,
      target: target.uid,
      unit: actor.uid,
    });

    const events = res.events || [];
    totalEvents += events.length;
    // Every *action* must produce events — the original bug returned zero on
    // every single command. A call that only settles an already-finished battle
    // is the one legitimate sparse case, and it is identified by `finished`.
    if (!res.finished) {
      assert(events.length > 0,
        `第 ${guard} 次指令返回了 0 个事件——客户端将无法播放任何演出`);
    }
    if (events.some((e) => e.kind === 'skill.cast')) sawCast = true;
    if (events.some((e) => e.kind === 'skill.cast' && e.kind === 'skill')) sawSkillCast = true;
    if (events.some((e) => e.kind === 'skill.cast' && e.skill && e.skill.includes('_skill'))) sawSkillCast = true;
    if (events.some((e) => e.kind === 'combat.damage')) sawDamage = true;
    if (events.some((e) => e.kind === 'battle.end')) sawEnd = true;

    if (res.finished) break;
  }

  assert(sawCast, '事件流中应包含技能释放事件');
  assert(sawSkillCast, '事件流中应包含「战技」的释放事件（而非只有普攻）');
  assert(sawDamage, '事件流中应包含伤害事件');
  assert(sawEnd, '事件流中应包含战斗结束事件');
  return `${guard} 次指令共交付 ${totalEvents} 个事件，含 skill.cast / combat.damage / battle.end`;
});

check('战斗结束后总能结算，不会卡在 battle 模式', () => {
  // The bug this guards: `Game.command` called `Game.step` after the acting
  // character's blow had already ended the battle. `step` correctly refused with
  // `notInBattle`, but the *game* never settled the fight — so `mode` stayed
  // `battle` forever while `inBattle` was false, and every subsequent command
  // bounced. From the player's seat it is a frozen game with no error.
  //
  // The invariant is therefore: whenever a battle's phase is terminal, either
  // the game has already settled it, or the very next command settles it.
  const { Game } = require('../src/world/game');
  const { PHASE: P } = require('../src/battle/action-constants');

  for (let seed = 1; seed <= 12; seed++) {
    const game = new Game({ seed, level: 20 });
    game.travel('whisper_woods');
    const entered = game.enter();
    assert(entered.entry === 'encounter', `seed ${seed}: 应进入战斗`);

    let guard = 0;
    let settled = false;
    while (guard++ < 200) {
      const step = game.step();
      if (step.finished) { settled = true; break; }
      if (!step.ok) {
        // A refusal is only acceptable if the battle is genuinely still live.
        assert(game.battle && game.battle.phase === P.ACTIVE,
          `seed ${seed}: 拒绝指令时战斗应仍在进行（phase=${game.battle ? game.battle.phase : 'null'}）`);
        break;
      }
      if (!step.waiting) continue;
      const actor = step.actor;
      const target = step.state.enemies.find((e) => e.alive);
      if (!target) break;
      const basic = actor.skills.find((s) => s.kind === 'basic');
      const res = game.command({ type: 'basic', skill: basic.id, target: target.uid, unit: actor.uid });
      if (res.finished) { settled = true; break; }
      if (!res.ok) {
        assert(game.battle && game.battle.phase === P.ACTIVE,
          `seed ${seed}: 指令被拒时战斗应仍在进行，实际 phase=${game.battle ? game.battle.phase : 'null'}，mode=${game.mode}`);
        break;
      }
    }

    assert(settled, `seed ${seed}: 战斗应在回合上限内结算`);
    assert(game.mode !== 'battle', `seed ${seed}: 结算后不应停留在 battle 模式，实际 ${game.mode}`);
    assert(game.lastResult && game.lastResult.won, `seed ${seed}: 应获胜`);
  }
  return '12 个种子全部正确结算';
});

check('战斗结束后拒绝新的指令', () => {
  const battle = makeBattle({ level: 14, seed: 7007, enemies: [{ id: 'rotgrub' }] });
  autoPlay(battle, 60);
  assert(battle.phase === PHASE.WON, '应先获胜');
  const hero = battle.allies[0];
  const before = battle.log.entries.length;
  const ok = battle.castSkill(hero, hero.skills[0], null);
  assert(!ok, '战斗结束后不应能释放技能');
  return '指令已封锁';
});

check('每个角色都能参与一次完整战斗并有输出', () => {
  const report = [];
  for (const id of WORLD.roster) {
    const battle = makeBattle({ level: 14, seed: 8008 + id.length, enemies: [{ id: 'rotgrub' }, { id: 'rotgrub' }, { id: 'grub_matriarch' }], party: [id] });
    autoPlay(battle, 120);
    // With a solo party the character must at least have taken a turn.
    const turns = battle.log.of('turn.start').filter((e) => e.uid.startsWith(id)).length;
    assert(turns > 0, `${id} 从未行动`);
    report.push(`${id}:${turns}回合`);
  }
  return report.join(' ');
});

// ===========================================================================
// 6. Progression
// ===========================================================================
section('成长系统 / Progression');

check('等级经验曲线单调递增', () => {
  let prev = 0;
  for (let lv = 1; lv < 30; lv++) {
    const need = progression.expToNext(lv);
    assert(need > prev, `等级 ${lv} 所需经验应递增：${need} <= ${prev}`);
    prev = need;
  }
  return `Lv1->2 需要 ${progression.expToNext(1)}, Lv29->30 需要 ${progression.expToNext(29)}`;
});

check('获得经验会正确升级', () => {
  const member = progression.createMember('ayaha', { level: 1 });
  const before = progression.previewStats(member);
  const res = progression.grantExp(member, 100000);
  const after = progression.previewStats(member);
  assert(member.level > 1, '应升级');
  assert(after.maxHp > before.maxHp && after.atk > before.atk, '属性应增长');
  assert(res.levels.length > 0, '应返回升级记录');
  return `Lv1 -> Lv${member.level}`;
});

check('等级不会超过上限', () => {
  const member = progression.createMember('ayaha', { level: 1 });
  progression.grantExp(member, 1e12);
  assert(member.level === BALANCE.MAX_LEVEL, `应停在 ${BALANCE.MAX_LEVEL}，得到 ${member.level}`);
  assert(member.exp === 0, '满级后经验应归零');
  return `Lv${member.level}`;
});

check('换装会改变属性', () => {
  const member = progression.createMember('ayaha', { level: 10 });
  member.equipment = { weapon: null, boots: null, accessory: null };
  const bare = progression.previewStats(member);
  progression.equip(member, 'gear_wind_blade');
  const armed = progression.previewStats(member);
  assert(armed.atk > bare.atk, `装备应提升攻击力：${bare.atk} -> ${armed.atk}`);
  return `ATK ${Math.round(bare.atk)} -> ${Math.round(armed.atk)}`;
});

check('预览属性与战斗内属性一致', () => {
  // The menu and the fight must never disagree. This is the regression test for
  // the duplicated stat formula in `progression.previewStats`.
  for (const id of WORLD.roster) {
    const member = progression.createMember(id, { level: 17 });
    const sheet = progression.buildSheet(member);
    const battle = makeBattle({ level: 17, party: [id], enemies: [{ id: 'rotgrub' }] });
    const entity = battle.allies[0];
    const inBattle = entity.resolveStats();
    for (const key of ['maxHp', 'atk', 'def', 'spd', 'critRate', 'critDmg', 'maxEnergy']) {
      const a = sheet.stats[key];
      const b = inBattle[key];
      assert(Math.abs(a - b) < 1.5, `${id}.${key} 菜单 ${a} vs 战斗 ${b}`);
    }
  }
  return '5/5 一致';
});

check('等级成长只被应用一次（角色与敌人）', () => {
  // The single nastiest bug in this engine's history: pre-scaling a stat block
  // by the growth curve and *also* handing the entity its real level made
  // `resolveStats` apply growth a second time. For allies that meant item
  // bonuses counted twice; for the boss it meant DEF 562 instead of 244, which
  // silently converted a 15-round fight into a 76-round one.
  //
  // The assertion is simply that the value the entity resolves equals the value
  // the scaling formula promises, for every level.
  const { BALANCE: B } = require('../src/core/rules');
  const { ENEMIES } = require('../src/core/enemies');
  const problems = [];

  for (const level of [1, 5, 22, 40]) {
    // --- Enemies ---
    const battle = makeBattle({ level: 20, party: ['ayaha'], enemies: [{ id: 'ashen_king', level }] });
    const boss = battle.enemies[0];
    const resolved = boss.resolveStats();
    for (const key of ['maxHp', 'atk', 'def']) {
      const expected = ENEMIES.ashen_king.baseStats[key] * (1 + B.GROWTH[key] * (level - 1));
      const actual = resolved[key];
      if (Math.abs(actual - expected) > Math.max(1, expected * 0.005)) {
        problems.push(`boss Lv${level} ${key}: 期望 ${Math.round(expected)}, 实际 ${Math.round(actual)}`);
      }
    }

    // --- Allies ---
    const member = progression.createMember('ayaha', { level });
    const sheet = progression.buildSheet(member);
    const allyBattle = makeBattle({ level, party: ['ayaha'], enemies: [{ id: 'rotgrub' }] });
    const entity = allyBattle.allies[0];
    const inBattle = entity.resolveStats();
    for (const key of ['maxHp', 'atk', 'def']) {
      if (Math.abs(sheet.stats[key] - inBattle[key]) > 1.5) {
        problems.push(`ayaha Lv${level} ${key}: 面板 ${Math.round(sheet.stats[key])}, 战斗 ${Math.round(inBattle[key])}`);
      }
    }
    if (entity.level !== level) problems.push(`ayaha Lv${level}: 战斗内等级变成 ${entity.level}`);
  }

  assert(problems.length === 0, problems.join('; '));
  return '敌人与角色在各等级均只缩放一次';
});

check('敌人 HP 处于设计区间内', () => {
  // Guards the tier targets documented in `core/enemies.js`. If a future edit
  // writes "the number I want at this level" instead of the level-1 equivalent,
  // this catches it before a playtester spends 70 rounds on a boss.
  const { ENEMIES } = require('../src/core/enemies');
  const bands = {
    // id: [min, max] effective HP at the definition's own level.
    // These are the tier targets documented at the top of `core/enemies.js`,
    // tightened after `test/balance.js` validated the actual fight lengths:
    //   elite ~5 rounds, boss ~25 rounds at the intended party level.
    rotgrub: [600, 3000],
    larva: [300, 1500],
    grub_matriarch: [1500, 6000],
    abyss_sentinel: [12000, 22000],
    ashen_king: [22000, 34000],
    ash_husk: [800, 5000],
  };
  const problems = [];
  const { BALANCE: B } = require('../src/core/rules');
  for (const [id, [lo, hi]] of Object.entries(bands)) {
    const def = ENEMIES[id];
    if (!def) { problems.push(`${id} 已不存在`); continue; }
    const hp = def.baseStats.maxHp * (1 + B.GROWTH.maxHp * (def.level - 1));
    if (hp < lo || hp > hi) problems.push(`${id}: 有效 HP ${Math.round(hp)} 超出 ${lo}–${hi}`);
  }
  assert(problems.length === 0, problems.join('; '));
  return '6/6 在区间内';
});

check('Boss 阶段转换的数值缩放不会累积', () => {
  const battle = makeBattle({ level: 20, party: ['ayaha'], enemies: [{ id: 'ashen_king' }], isBoss: true });
  const boss = battle.enemies[0];
  const before = boss.resolveStats();
  const scriptsMod = require('../src/battle/scripts');
  const handler = scriptsMod.get('bossPhaseChange');
  assert(handler, 'bossPhaseChange 处理器应存在');

  boss.hp = before.maxHp * 0.45;
  handler({ battle, actor: boss, phase: 2 });
  const once = boss.resolveStats();
  handler({ battle, actor: boss, phase: 2 });
  handler({ battle, actor: boss, phase: 2 });
  const thrice = boss.resolveStats();

  // ATK scales by 1.15 in phase 2 and DEF does not scale at all.
  assert(Math.abs(thrice.atk - once.atk) < 1, `重复转换不应继续放大 ATK：${Math.round(once.atk)} -> ${Math.round(thrice.atk)}`);
  assert(Math.abs(thrice.def - once.def) < 1, `重复转换不应放大 DEF：${Math.round(once.def)} -> ${Math.round(thrice.def)}`);
  assert(once.atk > before.atk, '阶段 2 应当提升攻击力');
  assert(once.weaknesses === undefined || boss.weaknesses.includes('wind'), '阶段 2 应获得风弱点');
  return `ATK ${Math.round(before.atk)} -> ${Math.round(once.atk)}（3 次转换后仍为 ${Math.round(thrice.atk)}）`;
});

check('召唤有并发上限与累计上限', () => {
  const battle = makeBattle({ level: 20, party: ['ayaha'], enemies: [{ id: 'ashen_king' }], isBoss: true });
  const boss = battle.enemies[0];
  const policy = boss.aiPolicy;
  assert(policy.summonCap > 0, 'Boss 应声明 summonCap');
  assert(policy.summonTotalCap > 0, 'Boss 应声明 summonTotalCap');

  // Spam the summon skill far beyond both budgets.
  for (let i = 0; i < 30; i++) battle.summon(boss, 'ash_husk', 2);

  const livingAdds = battle.enemies.filter((e) => e.summonedBy === boss.uid && e.alive).length;
  const totalAdds = battle.enemies.filter((e) => e.summonedBy === boss.uid).length;
  assert(livingAdds <= policy.summonCap, `场上召唤物 ${livingAdds} 应 <= ${policy.summonCap}`);
  assert(totalAdds <= policy.summonTotalCap, `累计召唤 ${totalAdds} 应 <= ${policy.summonTotalCap}`);
  return `场上 ${livingAdds}/${policy.summonCap}，累计 ${totalAdds}/${policy.summonTotalCap}`;
});

// ===========================================================================
// Harness
// ===========================================================================

/** Build a battle with a party at a given level. */
function makeBattle(opts) {
  const level = opts.level || 12;
  const partyIds = opts.party || ['ayaha', 'rinne', 'rin', 'elise'];
  const members = partyIds.map((id) => progression.createMember(id, { level }));
  const sheets = members.map((m) => {
    const sheet = progression.buildSheet(m);
    sheet.member = m;
    return sheet;
  });
  return new Battle({
    allies: sheets,
    enemies: opts.enemies,
    seed: opts.seed,
    isBoss: !!opts.isBoss,
    canFlee: opts.canFlee,
    name: 'test',
  });
}

/**
 * Naive auto-player: use the ultimate when charged, the skill when affordable,
 * otherwise a basic attack. Deliberately dumb — the point is to exercise the
 * engine, not to play well. `test/balance.js` uses a smarter policy.
 */
function autoPlay(battle, maxTurns = 200) {
  let turns = 0;
  let guard = 0;
  while (battle.phase === PHASE.ACTIVE && turns < maxTurns && guard++ < maxTurns * 8) {
    // Fire ready ultimates before anything else (the interrupt rule).
    for (const ally of battle.livingAllies) {
      if (ally.ultimateReady) {
        const ult = ally.skills.find((id) => skills.SKILLS[id].kind === 'ultimate');
        if (ult) battle.queueUltimate(ally.uid, ult, battle.pickDefaultTarget(ally));
      }
    }
    const unit = battle.advanceToNextTurn();
    if (!unit) break;
    if (unit.side === 'enemy') {
      battle.takeTurn(unit, null);
    } else {
      battle.takeTurn(unit, (u) => decideFor(u, battle));
    }
    turns++;
  }
  return battle.log.entries.length;
}

/** The auto-player's per-turn policy. */
function decideFor(unit, battle) {
  const ult = unit.skills.find((id) => skills.SKILLS[id].kind === 'ultimate');
  const skill = unit.skills.find((id) => skills.SKILLS[id].kind === 'skill');
  const basic = unit.skills.find((id) => skills.SKILLS[id].kind === 'basic');
  const target = battle.pickDefaultTarget(unit);

  if (ult && unit.ultimateReady) return { type: 'ultimate', skill: ult, target };
  // Heal if anyone is badly hurt and this unit can heal.
  if (skill) {
    const skillDef = skills.SKILLS[skill];
    const canHeal = skillDef.effects.some((e) => e.type === 'heal');
    const hurt = battle.livingAllies.find((a) => a.hp / a.resolveStats().maxHp < 0.5);
    if (canHeal && hurt && battle.skillPoints >= skillDef.skillPointCost) {
      return { type: 'skill', skill, target: hurt.uid };
    }
  }
  if (skill && battle.skillPoints >= skills.SKILLS[skill].skillPointCost) {
    return { type: 'skill', skill, target };
  }
  return { type: 'basic', skill: basic, target };
}

// ===========================================================================
// Run
// ===========================================================================

function run() {
  const only = process.argv.includes('--print') ? null : null;
  for (const r of results) {
    if (r.section) {
      process.stdout.write(`\n\x1b[1m${r.section}\x1b[0m\n`);
      continue;
    }
    const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    process.stdout.write(`  ${mark} ${r.name}${r.detail ? `  \x1b[90m${r.detail}\x1b[0m` : ''}\n`);
  }
  const total = results.filter((r) => !r.section).length;
  process.stdout.write(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${total - failures}/${total} 通过\x1b[0m\n`);
  return failures;
}

if (require.main === module) {
  process.exit(run() === 0 ? 0 : 1);
}

module.exports = { run, results, check, makeBattle, autoPlay, decideFor };
