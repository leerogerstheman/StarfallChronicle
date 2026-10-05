'use strict';

/**
 * End-to-end integration test over real HTTP.
 *
 * This drives the actual server the way the browser does: create a session,
 * walk the map, fight the authored encounters, buy gear, level up, and confirm
 * the demo can be finished. `test/run-all.js` tests the engine in isolation;
 * this tests the *wiring* — routes, session handling, the game state machine,
 * and the victory path.
 *
 * It binds a server to an ephemeral port (`listen(0)`) so it never collides with
 * a server the developer already has running.
 */

const { createServer, sessions } = require('../src/api/server');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail) {
  passed++;
  process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}\n`);
}

function bad(name, detail) {
  failed++;
  failures.push(`${name}: ${detail}`);
  process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}  \x1b[31m${detail}\x1b[0m\n`);
}

/**
 * Run a test, awaiting it if it returns a promise.
 *
 * This is deliberately `async` and awaited by every caller. An earlier version
 * was synchronous, which meant every `check(..., async () => {...})` reported a
 * pass immediately and the assertion inside never ran — 30 green ticks over an
 * untested suite, which is worse than a failure because it is invisible.
 */
async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (err) {
    bad(name, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  process.env.STARFALL_QUIET = '1';
  const server = createServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is asserted below */ }
    return { status: res.status, body: json, text };
  };

  /**
   * Drive a battle to completion with a competent policy, exactly as the browser
   * client does: fire charged ultimates first (the interrupt rule), then take
   * the acting ally's turn, preferring a skill that matches the target's
   * weakness.
   */
  const autoFight = async (sid, maxSteps = 900) => {
    let state = (await call('GET', `/api/state?session=${sid}`)).body.view;
    let guard = 0;
    const stats = { commands: 0, ultimates: 0, steps: 0 };
    while (state.mode === 'battle' && guard++ < maxSteps) {
      const battle = state.battle;
      const charged = battle.allies.find((a) => a.alive && a.ultimateReady);
      if (charged) {
        const ult = charged.skills.find((s) => s.kind === 'ultimate');
        const target = battle.enemies.find((e) => e.alive);
        if (ult && target) {
          const r = await call('POST', '/api/battle/ultimate', {
            session: sid, unit: charged.uid, skill: ult.id, target: target.uid,
          });
          if (r.status === 200) {
            stats.ultimates++;
            state = r.body.view;
            if (state.mode !== 'battle') break;
            continue;
          }
        }
      }
      const step = await call('POST', '/api/battle/step', { session: sid });
      if (step.status !== 200) throw new Error(`step 失败：${step.text}`);
      stats.steps++;
      state = step.body.view;
      if (state.mode !== 'battle') break;

      const actor = step.body.result.actor;
      if (!actor) continue;
      const target = state.battle.enemies.find((e) => e.alive);
      if (!target) break;
      const skill = actor.skills.find((s) => s.kind === 'skill' && s.affordable && s.usable
        && target.weaknesses.includes(s.element))
        || actor.skills.find((s) => s.kind === 'skill' && s.affordable && s.usable)
        || actor.skills.find((s) => s.kind === 'basic');
      const r = await call('POST', '/api/battle/command', {
        session: sid,
        type: skill.kind === 'basic' ? 'basic' : 'skill',
        skill: skill.id,
        target: target.uid,
        unit: actor.uid,
      });
      if (r.status !== 200) throw new Error(`command 失败：${r.text}`);
      stats.commands++;
      state = r.body.view;
    }
    return { state, stats };
  };

  process.stdout.write('\n\x1b[1m端到端集成测试 / End-to-end over HTTP\x1b[0m\n');

  // ---------------------------------------------------------------------
  // Static assets
  // ---------------------------------------------------------------------
  await check('首页可访问且包含标题', async () => {
    const idx = await fetch(base + '/');
    assert(idx.status === 200, `GET / 返回 ${idx.status}`);
    const html = await idx.text();
    assert(html.includes('星陨纪年'), '首页应包含游戏标题');
    return `${html.length} 字节`;
  });

  for (const asset of ['/css/style.css', '/js/api.js', '/js/ui.js', '/js/art.js', '/js/battle.js', '/js/world.js', '/js/main.js']) {
    await check(`静态资源 ${asset}`, async () => {
      const r = await fetch(base + asset);
      assert(r.status === 200, `HTTP ${r.status}`);
      const text = await r.text();
      assert(text.length > 100, `内容过短：${text.length} 字节`);
      // A JS or CSS file with a replacement character means the encoding was
      // corrupted in transit, which shows up as mojibake all over the UI.
      assert(!text.includes('\uFFFD'), '文件包含替换字符，说明编码损坏');
      return `${text.length} 字节`;
    });
  }

  // --- Generated art -----------------------------------------------------

  await check('/api/art 列出了全部美术', async () => {
    const r = await call('GET', '/api/art');
    assert(r.status === 200 && r.body.ok, `HTTP ${r.status}`);
    const kinds = new Set(r.body.entries.map((e) => e.kind));
    assert(kinds.has('character') && kinds.has('enemy') && kinds.has('npc'),
      `缺少类别：${[...kinds].join(',')}`);
    assert(r.body.entries.length >= 13, `只有 ${r.body.entries.length} 个形象`);
    for (const e of r.body.entries) {
      // The client and the art tools both need these to frame the bust crop,
      // and neither can derive them: heights differ per character.
      assert(typeof e.bustY0 === 'number', `${e.id} 缺少 bustY0`);
      assert(typeof e.scale === 'number', `${e.id} 缺少 scale`);
    }
    return `${r.body.entries.length} 个形象 · ${[...kinds].join('/')}`;
  });

  await check('每张立绘都能通过 HTTP 取到，且是 SVG', async () => {
    const manifest = (await call('GET', '/api/art')).body.entries;
    let bytes = 0;
    for (const entry of manifest) {
      for (const view of ['full', 'bust']) {
        const res = await fetch(`${base}${entry.url}?view=${view}`);
        assert(res.status === 200, `${entry.url}?view=${view} → HTTP ${res.status}`);
        assert(/image\/svg\+xml/.test(res.headers.get('content-type') || ''),
          `${entry.url} 的 Content-Type 是 ${res.headers.get('content-type')}`);
        const svg = await res.text();
        assert(svg.startsWith('<svg') && svg.endsWith('</svg>'), `${entry.url} 不是完整 SVG`);
        bytes += svg.length;
      }
    }
    return `${manifest.length} × 2 视图，共 ${(bytes / 1024).toFixed(0)} KB`;
  });

  await check('立绘支持 gzip 与 ETag 重验证', async () => {
    const url = `${base}/art/character/ayaha.svg`;
    const gz = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
    assert(gz.headers.get('content-encoding') === 'gzip', '没有返回 gzip');
    const etag = gz.headers.get('etag');
    assert(etag, '没有 ETag');
    const raw = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
    const rawSize = Number(raw.headers.get('content-length'));
    const gzSize = Number(gz.headers.get('content-length'));
    assert(gzSize < rawSize * 0.6, `压缩率只有 ${(rawSize / gzSize).toFixed(1)}×`);
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert(again.status === 304, `重验证返回 ${again.status}，应为 304`);
    return `${(rawSize / 1024).toFixed(0)} KB → ${(gzSize / 1024).toFixed(0)} KB，304 正常`;
  });

  await check('不存在的形象返回 404 而不是崩溃', async () => {
    for (const bad of ['/art/character/nobody.svg', '/art/wizard/ayaha.svg', '/art/character/ayaha.png']) {
      const r = await call('GET', bad);
      assert(r.status === 404, `${bad} → HTTP ${r.status}`);
    }
    return '三种错误路径均为 404';
  });

  await check('目录穿越被拒绝', async () => {
    const r = await fetch(base + '/../package.json');
    assert(r.status === 403 || r.status === 404, `应被拒绝，得到 ${r.status}`);
    return `HTTP ${r.status}`;
  });

  await check('不存在的 API 返回 404', async () => {
    const r = await call('GET', '/api/nope');
    assert(r.status === 404, `应 404，得到 ${r.status}`);
    assert(r.body && r.body.ok === false, '应返回 ok:false');
    return 'ok';
  });

  await check('没有会话时状态查询报错', async () => {
    const r = await call('GET', '/api/state?session=bogus');
    assert(r.status === 404, `应 404，得到 ${r.status}`);
    assert(r.body && r.body.code === 'noSession', '应带 noSession 代码');
    return 'ok';
  });

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------
  const create = await call('POST', '/api/session', { seed: 20260101, level: 10 });
  assert(create.status === 200, `创建会话失败：${create.status} ${create.text}`);
  const sid = create.body.view.sessionId;
  ok('创建会话', `${sid}，起始等级 10`);

  await check('初始状态是城镇', () => {
    const v = create.body.view;
    assert(v.mode === 'town', `mode 应为 town，得到 ${v.mode}`);
    assert(v.node.type === 'town', '起始节点应是城镇');
    assert(v.party.active.length === 4, `应有 4 名出战角色，得到 ${v.party.active.length}`);
    assert(v.gold > 0, '应有起始金币');
    return `${v.node.name}，${v.party.active.join(' / ')}`;
  });

  await check('静态数据完整', async () => {
    const r = await call('GET', '/api/data');
    assert(r.body.characters.length === 5, `应有 5 名角色，得到 ${r.body.characters.length}`);
    assert(r.body.skills.length >= 40, `技能数偏少：${r.body.skills.length}`);
    assert(r.body.enemies.length >= 6, `敌人数偏少：${r.body.enemies.length}`);
    assert(r.body.world.nodes.length === 5, `节点数应为 5，得到 ${r.body.world.nodes.length}`);
    assert(Object.keys(r.body.elements).length === 7, '应有 7 种属性');
    return `${r.body.characters.length} 角色 / ${r.body.skills.length} 技能 / ${r.body.enemies.length} 敌人`;
  });

  // ---------------------------------------------------------------------
  // Town services
  // ---------------------------------------------------------------------
  await check('旅店休息恢复全队', async () => {
    const before = await call('GET', `/api/state?session=${sid}`);
    const goldBefore = before.body.view.gold;
    const r = await call('POST', '/api/party/rest', { session: sid });
    assert(r.status === 200, `休息失败：${r.status} ${r.text}`);
    assert(r.body.view.gold === goldBefore - 30, `应花费 30 金：${goldBefore} -> ${r.body.view.gold}`);
    assert(r.body.view.restBonus, '应获得休息增益');
    const allFull = r.body.view.party.members.every((m) => m.hp === m.maxHp);
    assert(allFull, '全员应满血');
    return `金币 ${goldBefore} -> ${r.body.view.gold}，增益「${r.body.result.bonusName}」`;
  });

  await check('购买装备并穿戴会改变属性', async () => {
    const before = await call('GET', `/api/state?session=${sid}`);
    const ayahaBefore = before.body.view.party.members.find((m) => m.charId === 'ayaha');
    const critBefore = ayahaBefore.stats.critRate;

    const r = await call('POST', '/api/shop/buy', { session: sid, item: 'gear_crit_lens' });
    assert(r.status === 200, `购买失败：${r.status} ${r.text}`);
    const eq = await call('POST', '/api/party/equip', { session: sid, charId: 'ayaha', item: 'gear_crit_lens' });
    assert(eq.status === 200, `装备失败：${eq.status} ${eq.text}`);
    const ayaha = eq.body.view.party.members.find((m) => m.charId === 'ayaha');
    assert(ayaha.equipment.accessory === 'gear_crit_lens', '饰品应已更换');
    assert(ayaha.stats.critRate > critBefore, `暴击率应提升：${critBefore} -> ${ayaha.stats.critRate}`);
    return `暴击率 ${(critBefore * 100).toFixed(0)}% -> ${(ayaha.stats.critRate * 100).toFixed(0)}%`;
  });

  await check('无法购买买不起的东西', async () => {
    const poor = await call('POST', '/api/session', { level: 1, gold: 1 });
    const poorId = poor.body.view.sessionId;
    const r = await call('POST', '/api/shop/buy', { session: poorId, item: 'gear_wind_blade' });
    assert(r.status === 400, `应被拒绝，得到 ${r.status}`);
    assert(r.body.reason === 'notEnoughGold', `原因应为 notEnoughGold，得到 ${r.body.reason}`);
    return 'ok';
  });

  await check('只能前往相邻节点', async () => {
    const r = await call('POST', '/api/travel', { session: sid, to: 'throne_of_ash' });
    assert(r.status === 400, `应被拒绝，得到 ${r.status}`);
    assert(r.body.reason === 'notAdjacent', `原因应为 notAdjacent，得到 ${r.body.reason}`);
    return 'ok';
  });

  await check('等级不足时无法进入 Boss 区域', async () => {
    const low = await call('POST', '/api/session', { level: 1 });
    const lowId = low.body.view.sessionId;
    for (const node of ['whisper_woods', 'grub_hollow', 'sentinel_gate']) {
      const t = await call('POST', '/api/travel', { session: lowId, to: node });
      assert(t.status === 200, `前往 ${node} 失败：${t.text}`);
    }

    // The gate is enforced at *travel*: the destination is visible but locked,
    // so the player can see where to go and what level they need. That is a
    // better design than an invisible wall, and it means the refusal has to be
    // tested here rather than at `enter` (where you would already be standing
    // inside the boss room).
    const state = await call('GET', `/api/state?session=${lowId}`);
    const locked = state.body.view.node.connections.find((c) => c.id === 'throne_of_ash');
    assert(locked, '应能看见通往王座的路径');
    assert(locked.locked, 'Boss 区域应被等级锁住');
    assert(locked.locked.required === 10, `需求等级应为 10，得到 ${locked.locked.required}`);
    assert(locked.locked.current < 10, `当前等级应不足，得到 ${locked.locked.current}`);

    const attempt = await call('POST', '/api/travel', { session: lowId, to: 'throne_of_ash' });
    assert(attempt.status === 400, `前往王座应被拒绝，得到 ${attempt.status}`);
    assert(attempt.body.reason === 'level', `原因应为 level，得到 ${attempt.body.reason}`);
    return `需 Lv${locked.locked.required}，当前 Lv${locked.locked.current}`;
  });

  // ---------------------------------------------------------------------
  // Battle flow
  // ---------------------------------------------------------------------
  await check('探索会触发遭遇并可进入战斗', async () => {
    const t = await call('POST', '/api/travel', { session: sid, to: 'whisper_woods' });
    assert(t.status === 200, `前往失败：${t.text}`);
    const r = await call('POST', '/api/enter', { session: sid });
    assert(r.status === 200, `进入失败：${r.status} ${r.text}`);
    assert(r.body.result.entry === 'encounter', `应为遭遇，得到 ${r.body.result.entry}`);
    assert(r.body.view.mode === 'battle', '模式应切换为战斗');
    const enemies = r.body.view.battle.enemies;
    assert(enemies.length > 0, '应有敌人');
    return `${r.body.view.battle.name}：${enemies.map((e) => e.name).join('、')}`;
  });

  await check('战斗推进到需要玩家输入', async () => {
    const r = await call('POST', '/api/battle/step', { session: sid });
    assert(r.status === 200, `step 失败：${r.status} ${r.text}`);
    assert(r.body.result.waiting === true, '应等待玩家输入');
    assert(r.body.result.actor, '应返回当前行动者');
    assert(r.body.result.actor.side === 'ally', '行动者应为我方');
    assert(Array.isArray(r.body.result.actor.skills), '行动者应带技能列表');
    return `${r.body.result.actor.name} 行动，${r.body.result.actor.skills.length} 个技能可用`;
  });

  await check('完整打完一场小怪战并结算奖励', async () => {
    const { state, stats } = await autoFight(sid);
    assert(state.mode !== 'battle', `战斗应结束，实际仍在 ${state.mode}`);
    assert(state.lastResult, '应有战斗结果');
    assert(state.lastResult.won, `应获胜，实际 ${state.lastResult.phase}`);
    assert(state.lastResult.exp > 0, '应获得经验');
    assert(state.lastResult.gold > 0, '应获得金币');
    assert(Array.isArray(state.lastResult.partyAfter), '应返回战后队伍状态');
    return `${state.lastResult.rounds} 回合，${stats.commands} 次指令，+${state.lastResult.exp} 经验`;
  });

  await check('战斗胜利后可以继续探索', async () => {
    const r = await call('POST', '/api/battle/acknowledge', { session: sid });
    assert(r.status === 200, `确认失败：${r.status} ${r.text}`);
    assert(r.body.view.mode !== 'battle', '应离开战斗状态');
    return `模式 ${r.body.view.mode}`;
  });

  await check('队伍可以重新编成', async () => {
    const r = await call('POST', '/api/party', { session: sid, party: ['ayaha', 'byakuya', 'rin', 'elise'] });
    assert(r.status === 200, `编成失败：${r.status} ${r.text}`);
    assert(r.body.view.party.active.includes('byakuya'), '白鸦应进入队伍');
    assert(r.body.view.party.active.length === 4, '应为 4 人');
    // Restore the default party for the later boss test.
    await call('POST', '/api/party', { session: sid, party: ['ayaha', 'rinne', 'rin', 'elise'] });
    return r.body.view.party.active.join(' / ');
  });

  await check('队伍人数超限会被拒绝', async () => {
    const r = await call('POST', '/api/party', {
      session: sid, party: ['ayaha', 'rinne', 'rin', 'byakuya', 'elise'],
    });
    assert(r.status === 400, `应被拒绝，得到 ${r.status}`);
    assert(r.body.reason === 'tooMany', `原因应为 tooMany，得到 ${r.body.reason}`);
    return 'ok';
  });

  await check('战斗中无法改队伍', async () => {
    const s = await call('POST', '/api/session', { level: 15 });
    const id = s.body.view.sessionId;
    await call('POST', '/api/battle/practice', { session: id, enemies: ['rotgrub'] });
    const r = await call('POST', '/api/party', { session: id, party: ['ayaha'] });
    assert(r.status === 400, `应被拒绝，得到 ${r.status}`);
    assert(r.body.reason === 'inBattle', `原因应为 inBattle，得到 ${r.body.reason}`);
    return 'ok';
  });

  // ---------------------------------------------------------------------
  // Elite
  // ---------------------------------------------------------------------
  await check('精英战可以开始并打完', async () => {
    const s = await call('POST', '/api/session', { seed: 5150, level: 18 });
    const id = s.body.view.sessionId;
    const r = await call('POST', '/api/battle/practice', {
      session: id, enemies: ['abyss_sentinel'], name: '精英测试',
    });
    assert(r.status === 200, `练习战失败：${r.status} ${r.text}`);
    assert(r.body.view.mode === 'battle', '应进入战斗');
    const enemy = r.body.view.battle.enemies[0];
    assert(enemy.name.includes('哨兵'), `应是哨兵，得到 ${enemy.name}`);
    assert(enemy.toughnessMax > 0, '精英应有韧性条');
    assert(enemy.weaknesses.length > 0, '精英应有弱点');

    const { state } = await autoFight(id);
    assert(state.mode !== 'battle', `战斗应结束，实际 ${state.mode}`);
    assert(state.lastResult.won, `Lv18 队伍应击败精英，实际 ${state.lastResult.phase}`);
    return `${state.lastResult.rounds} 回合，弱点 ${enemy.weaknesses.join('/')}`;
  });

  await check('未知敌人被拒绝', async () => {
    const r = await call('POST', '/api/battle/practice', { session: sid, enemies: ['not_a_real_enemy'] });
    assert(r.status === 400, `应被拒绝，得到 ${r.status}`);
    assert(r.body.reason === 'unknownEnemy', `原因应为 unknownEnemy，得到 ${r.body.reason}`);
    return 'ok';
  });

  // ---------------------------------------------------------------------
  // Boss run, end to end
  // ---------------------------------------------------------------------
  await check('Lv22 队伍可以走完全程并击败 Boss 通关', async () => {
    const s = await call('POST', '/api/session', { seed: 777, level: 22 });
    const id = s.body.view.sessionId;

    for (const node of ['whisper_woods', 'grub_hollow', 'sentinel_gate']) {
      const t = await call('POST', '/api/travel', { session: id, to: node });
      assert(t.status === 200, `前往 ${node} 失败：${t.text}`);
    }
    const gate = await call('POST', '/api/travel', { session: id, to: 'throne_of_ash' });
    assert(gate.status === 200, `进入王座失败：${gate.text}`);

    const enter = await call('POST', '/api/enter', { session: id });
    assert(enter.status === 200, `进入失败：${enter.text}`);
    assert(enter.body.result.entry === 'story', `应先播剧情，得到 ${enter.body.result.entry}`);
    assert(Array.isArray(enter.body.result.story.text), '剧情应有文本');
    assert(enter.body.result.story.text.length > 0, '剧情文本不应为空');

    const cont = await call('POST', '/api/story/continue', { session: id });
    assert(cont.status === 200, `继续失败：${cont.text}`);
    assert(cont.body.view.mode === 'battle', '剧情后应进入战斗');
    const boss = cont.body.view.battle.enemies[0];
    assert(boss.name.includes('瓦尔特斯'), `应是 Boss，得到 ${boss.name}`);
    assert(boss.toughnessMax >= 400, `Boss 韧性应厚实，得到 ${boss.toughnessMax}`);

    const { state, stats } = await autoFight(id, 2000);
    assert(state.mode !== 'battle', `战斗应结束，实际 ${state.mode}`);
    assert(state.lastResult, '应有结果');
    if (!state.lastResult.won) {
      throw new Error(`Lv22 队伍应能击败 Boss，实际 ${state.lastResult.phase}（${state.lastResult.rounds} 回合）`);
    }
    assert(state.mode === 'victory', `应进入通关状态，得到 ${state.mode}`);
    assert(state.progress.bossDefeated, '应记录 Boss 已讨伐');
    return `${state.lastResult.rounds} 回合获胜，${stats.ultimates} 次终结技，${stats.commands} 次指令`;
  });

  await check('通关后仍可自由探索', async () => {
    const r = await call('POST', '/api/battle/acknowledge', { session: sid });
    assert(r.status === 200, `失败：${r.text}`);
    assert(r.body.view.mode !== 'battle', '应离开战斗');
    return `模式 ${r.body.view.mode}`;
  });

  await check('Boss 无法逃跑', async () => {
    const s = await call('POST', '/api/session', { level: 22 });
    const id = s.body.view.sessionId;
    await call('POST', '/api/battle/practice', { session: id, enemies: ['ashen_king'], name: 'boss' });
    const state = await call('GET', `/api/state?session=${id}`);
    assert(state.body.view.battle.canFlee === false, 'Boss 战不应允许逃跑');
    return 'canFlee = false';
  });

  // ---------------------------------------------------------------------
  // Robustness
  // ---------------------------------------------------------------------
  await check('战斗外的战斗指令被拒绝', async () => {
    const r = await call('POST', '/api/battle/step', { session: sid });
    assert(r.status === 400, `应被拒绝，得到 ${r.status}`);
    assert(r.body.reason === 'notInBattle', `原因应为 notInBattle，得到 ${r.body.reason}`);
    return 'ok';
  });

  await check('非法 JSON 被拒绝', async () => {
    const res = await fetch(base + '/api/travel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json',
    });
    assert(res.status === 400, `应 400，得到 ${res.status}`);
    return 'ok';
  });

  await check('会话互相隔离', async () => {
    const a = await call('POST', '/api/session', { seed: 1, level: 15 });
    const b = await call('POST', '/api/session', { seed: 2, level: 15 });
    const idA = a.body.view.sessionId;
    const idB = b.body.view.sessionId;
    assert(idA !== idB, '会话 id 应不同');
    await call('POST', '/api/travel', { session: idA, to: 'whisper_woods' });
    const stateB = await call('GET', `/api/state?session=${idB}`);
    assert(stateB.body.view.node.id === 'haven_town', 'B 会话不应受 A 影响');
    return `${idA} vs ${idB}`;
  });

  await check('会话数量有上限，旧会话被回收', async () => {
    for (let i = 0; i < 45; i++) {
      await call('POST', '/api/session', { level: 5 });
    }
    assert(sessions.size <= 32, `会话数应 <= 32，得到 ${sessions.size}`);
    return `${sessions.size} 个会话`;
  });

  server.close();

  process.stdout.write(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} 通过\x1b[0m\n\n`);
  if (failed) {
    for (const f of failures) process.stdout.write(`  \x1b[31m${f}\x1b[0m\n`);
  }
  return failed;
}

if (require.main === module) {
  main().then((f) => process.exit(f === 0 ? 0 : 1)).catch((err) => {
    process.stderr.write(`集成测试崩溃：${err.stack}\n`);
    process.exit(1);
  });
}

module.exports = { main };
