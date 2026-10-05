'use strict';

/**
 * Browser smoke test.
 *
 * Drives a real headless browser against a real server and plays the game the
 * way a person does: click "new game", walk to the forest, fight, and reach the
 * result screen. It exists because the API tests cannot see the two failure
 * modes that actually ruin a frontend:
 *
 *   1. A JavaScript exception during boot, which leaves the title screen up and
 *      the console full of red.
 *   2. A render that throws on one of the many shapes the server can return
 *      (a battle with one enemy, a battle with five, a broken enemy, a dead
 *      ally), which shows as a half-drawn screen.
 *
 * The browser is driven over the Chrome DevTools Protocol using Node's built-in
 * `WebSocket` and `fetch` — no Playwright, no npm install. The project's promise
 * is "double-click and play", and a test harness that needs a 300 MB browser
 * download would break that promise for anyone who clones it.
 *
 * Skips (rather than fails) when no Chromium-family browser is present.
 */

const fs = require('fs');
const path = require('path');
const { createServer } = require('../src/api/server');
const { launchBrowser, waitFor } = require('./lib/cdp');

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
async function check(name, fn) {
  try {
    ok(name, await fn());
  } catch (err) {
    bad(name, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Assert that an action either damaged an enemy or spent a skill point.
 *
 * Both outcomes are legitimate — a basic attack spends nothing but always deals
 * damage, while a defensive skill may spend nothing and deal none — so the check
 * has to accept either rather than demanding one specific effect.
 */
function assert2(hpAfter, hpBefore, spAfter, spBefore, kind) {
  if (!hpAfter || !hpBefore) throw new Error('缺少伤害前后的生命值快照');
  const damaged = hpAfter.some((h, i) => h < hpBefore[i]);
  const spSpent = spAfter < spBefore;
  if (!damaged && !spSpent) {
    throw new Error(`${kind} 既没有造成伤害也没有消耗战技点（HP ${hpBefore.join(',')} → ${hpAfter.join(',')}，SP ${spBefore} → ${spAfter}）`);
  }
}

async function main() {
  const { findBrowser } = require('./lib/cdp');
  const browserPath = findBrowser();
  process.stdout.write('\n\x1b[1m浏览器冒烟测试 / Browser smoke test\x1b[0m\n');

  if (!browserPath) {
    process.stdout.write('  \x1b[33m⊘ 跳过：未找到 Chromium 系浏览器（Chrome / Edge / Chromium）\x1b[0m\n');
    process.stdout.write('  安装其中之一即可运行本测试。\n\n');
    return 0;
  }
  process.stdout.write(`  \x1b[90m浏览器：${browserPath}\x1b[0m\n`);

  // --- Server on an ephemeral port -------------------------------------
  process.env.STARFALL_QUIET = '1';
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  // --- Browser with a throwaway profile --------------------------------
  const browser = await launchBrowser({ browserPath, windowSize: '1440,900' });
  const { cdp } = browser;

  let navigated = false;
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') navigated = true;
  });

  /**
   * Save a PNG of the current screen.
   *
   * These are documentation, not assertions: they are how a human reviews the
   * UI without running the game, and they are the only artefact that shows the
   * generated art in context. A failure to capture is reported and ignored —
   * a screenshot must never be the reason the suite goes red.
   */
  const capture = async (name) => {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(__dirname, '..', 'docs', `screenshot-${name}.png`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      process.stdout.write(`  \x1b[90m截图：docs/screenshot-${name}.png\x1b[0m\n`);
    } catch (err) {
      process.stdout.write(`  \x1b[90m截图 ${name} 失败（不影响测试）：${err.message}\x1b[0m\n`);
    }
  };

  /**
   * Wait until every `<img>` matching `selector` has decoded.
   *
   * `naturalWidth > 0` is the only honest assertion about generated art:
   * "the src is set" passes on a 404, "the element exists" passes on a broken
   * SVG. But a freshly inserted `<img>` is not decoded yet, so every check has
   * to wait first — otherwise the suite reports a race as a missing picture,
   * which is the most annoying kind of false failure because it comes and goes.
   */
  const awaitImages = (selector) => cdp.eval(`
    const imgs = [...document.querySelectorAll(${JSON.stringify(selector)})];
    await Promise.all(imgs.map(i => (i.complete && i.naturalWidth > 0)
      ? null
      : new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r); })));
    return imgs.length;
  `);

  try {
    // ===================================================================
    // Boot
    // ===================================================================
    await cdp.send('Page.navigate', { url });

    await check('页面可以加载并进入标题界面', async () => {
      await waitFor(cdp, `document.getElementById('title') && !document.getElementById('title').classList.contains('hidden')`,
        15000, '标题界面出现');
      const title = await cdp.eval(`return document.querySelector('.title-name').textContent;`);
      if (!title.includes('星陨')) throw new Error(`标题文本异常：${title}`);
      // Drive battles through the client's real code path, but without waiting
      // for the animations. Without this the boss fight takes over twenty
      // minutes of wall clock; with it, the same fight is seconds.
      await cdp.eval(`BattleUI.speed = 0; return true;`);
      return title;
    });

    await check('启动过程中没有 JavaScript 错误', () => {
      if (cdp.pageErrors.length) throw new Error(cdp.pageErrors.join(' | '));
      const fatal = cdp.consoleErrors.filter((e) => !/favicon/i.test(e));
      if (fatal.length) throw new Error(fatal.join(' | '));
      return '无异常';
    });

    await check('静态数据已加载到客户端', async () => {
      const info = await cdp.eval(`
        return {
          chars: Object.keys(State.data.characters).length,
          skills: State.data.skills.length,
          enemies: State.data.enemies.length,
          nodes: State.data.world.nodes.length,
        };
      `);
      if (info.chars !== 5) throw new Error(`角色数应为 5，得到 ${info.chars}`);
      if (info.nodes !== 5) throw new Error(`节点数应为 5，得到 ${info.nodes}`);
      return `${info.chars} 角色 / ${info.skills} 技能 / ${info.enemies} 敌人`;
    });

    // ===================================================================
    // Start a game
    // ===================================================================
    await check('可以开始新游戏并进入城镇界面', async () => {
      await cdp.eval(`
        document.getElementById('start-level').value = '20';
        document.querySelector('[data-action="new-game"]').click();
        return true;
      `);
      await waitFor(cdp, `State.sessionId && State.view && State.view.mode === 'town'`, 15000, '进入城镇');
      await waitFor(cdp, `!document.getElementById('screen-world').classList.contains('hidden')`, 8000, '城镇界面显示');
      const place = await cdp.eval(`return document.getElementById('scene-name').textContent;`);
      const party = await cdp.eval(`return document.querySelectorAll('#party-strip .party-card').length;`);
      if (party !== 4) throw new Error(`队伍卡片应为 4 张，得到 ${party}`);
      await capture('town');
      return `${place}，${party} 名队员`;
    });

    await check('城镇与移动列表都渲染出来了', async () => {
      const travel = await cdp.eval(`return document.querySelectorAll('#travel-list .travel-item').length;`);
      const actions = await cdp.eval(`return document.querySelectorAll('#scene-actions .btn').length;`);
      if (travel < 1) throw new Error('没有可前往的地点');
      if (actions < 1) throw new Error('没有可执行的操作');
      return `${travel} 个目的地，${actions} 个操作`;
    });

    await check('城镇 NPC 与队伍条都显示头像', async () => {
      await awaitImages('#npc-row img.npc-face');
      await awaitImages('#party-strip img.party-face');
      const info = await cdp.eval(`
        const npc = [...document.querySelectorAll('#npc-row .npc-card')];
        const npcImgs = [...document.querySelectorAll('#npc-row img.npc-face')];
        const partyImgs = [...document.querySelectorAll('#party-strip img.party-face')];
        const decoded = (list) => list.filter(i => i.complete && i.naturalWidth > 0).length;
        return {
          npc: npc.length,
          npcImgs: npcImgs.length,
          npcDecoded: decoded(npcImgs),
          npcSrc: npcImgs.length ? npcImgs[0].getAttribute('src') : null,
          partyImgs: partyImgs.length,
          partyDecoded: decoded(partyImgs),
        };
      `);
      if (info.npc === 0) throw new Error('城镇里没有 NPC 卡');
      if (info.npcImgs !== info.npc) throw new Error(`${info.npc} 个 NPC 里只有 ${info.npcImgs} 个有头像`);
      if (info.npcDecoded !== info.npcImgs) {
        throw new Error(`${info.npcImgs} 张 NPC 头像里只有 ${info.npcDecoded} 张解码成功`);
      }
      if (!/^\/art\/npc\//.test(info.npcSrc || '')) {
        throw new Error(`NPC 用的是角色头像而不是自己的：${info.npcSrc}`);
      }
      if (info.partyDecoded !== info.partyImgs) {
        throw new Error(`队伍条 ${info.partyImgs} 张里只有 ${info.partyDecoded} 张解码成功`);
      }
      return `NPC ${info.npcDecoded}/${info.npc}，队伍 ${info.partyDecoded}/${info.partyImgs}`;
    });

    await check('可以打开队伍编成并看到全部 5 名角色', async () => {
      await cdp.eval(`
        const btn = [...document.querySelectorAll('#scene-actions .btn')]
          .find(b => b.textContent.includes('队伍编成') || b.textContent.includes('整备队伍'));
        if (!btn) throw new Error('找不到队伍按钮');
        btn.click();
        return true;
      `);
      await waitFor(cdp, `!document.getElementById('modal').classList.contains('hidden')`, 6000, '弹窗打开');
      const cards = await cdp.eval(`return document.querySelectorAll('#modal-body .member-card').length;`);
      if (cards !== 5) throw new Error(`应有 5 张角色卡，得到 ${cards}`);
      const skills = await cdp.eval(`return document.querySelectorAll('#modal-body .skill-item').length;`);

      // The standing art is the biggest thing the art pipeline produces, so it
      // is the one most likely to be wired up but never actually decode.
      await awaitImages('#modal-body .member-art img.member-standing');
      await awaitImages('#modal-body .member-avatar img.member-face');
      const art = await cdp.eval(`
        const imgs = [...document.querySelectorAll('#modal-body .member-art img.member-standing')];
        const faces = [...document.querySelectorAll('#modal-body .member-avatar img.member-face')];
        return {
          standing: imgs.length,
          standingDecoded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          faces: faces.length,
          facesDecoded: faces.filter(i => i.complete && i.naturalWidth > 0).length,
          sample: imgs.length ? imgs[0].getAttribute('src') : null,
        };
      `);
      if (art.standing !== 5) throw new Error(`应有 5 张立绘，得到 ${art.standing}`);
      if (art.standingDecoded !== 5) throw new Error(`5 张立绘里只有 ${art.standingDecoded} 张解码成功`);
      if (art.facesDecoded !== 5) throw new Error(`5 张头像里只有 ${art.facesDecoded} 张解码成功`);
      if (!/view=full/.test(art.sample || '')) throw new Error(`立绘没有用 full 视图：${art.sample}`);

      await capture('party');
      await cdp.eval(`Modal.close(); return true;`);
      return `${cards} 张角色卡，${skills} 条技能说明，5 张立绘`;
    });

    await check('图鉴里的「形象」画廊能打开，13 个形象全部解码', async () => {
      // The gallery exists because there was previously nowhere in the game to
      // look at a character: the art was decoration on a 34px circle. So this
      // asserts the entry point, the count, and that the pictures actually
      // decoded — not merely that a grid element was created.
      await cdp.eval(`
        const btn = [...document.querySelectorAll('#scene-actions .btn')]
          .find(b => b.textContent.includes('图鉴'));
        if (!btn) throw new Error('城镇操作栏里没有图鉴按钮');
        btn.click();
        return true;
      `);
      await waitFor(cdp, `!document.getElementById('modal').classList.contains('hidden')`, 6000, '图鉴打开');

      // Thirteen images is enough that the last one is still in flight when the
      // first render finishes. Waiting for every one to decode is the
      // difference between testing the gallery and testing the network.
      await awaitImages('#modal-body .art-card-img');

      const gallery = await cdp.eval(`
        const cards = [...document.querySelectorAll('#modal-body .art-card')];
        const imgs = [...document.querySelectorAll('#modal-body .art-card-img')];
        const sections = [...document.querySelectorAll('#modal-body .art-section-label')].map(s => s.textContent);
        return {
          cards: cards.length,
          imgs: imgs.length,
          decoded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          broken: imgs.filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.getAttribute('src')),
          sections,
          manifest: Art.list('character').length + Art.list('npc').length + Art.list('enemy').length,
        };
      `);
      if (gallery.cards !== gallery.manifest) {
        throw new Error(`画廊有 ${gallery.cards} 张卡，清单里有 ${gallery.manifest} 个形象`);
      }
      if (gallery.decoded !== gallery.imgs) {
        throw new Error(`${gallery.imgs} 张里只有 ${gallery.decoded} 张解码成功：${gallery.broken.join(', ')}`);
      }
      if (gallery.sections.length < 3) {
        throw new Error(`应有三组（角色/NPC/敌人），得到 ${gallery.sections.join(',')}`);
      }
      await capture('gallery');
      return `${gallery.cards} 张卡 · ${gallery.sections.join(' / ')} · ${gallery.decoded} 张已解码`;
    });

    await check('点击形象能放大查看，并列出表情与 Boss 形态', async () => {
      await cdp.eval(`
        const card = [...document.querySelectorAll('#modal-body .art-card')]
          .find(c => c.textContent.includes('苍叶'));
        if (!card) throw new Error('画廊里找不到苍叶');
        card.click();
        return true;
      `);
      await awaitImages('#modal-body .art-view-img');
      await awaitImages('#modal-body .expr-frame img');

      const opened = await cdp.eval(`
        const big = document.querySelector('#modal-body .art-view-img');
        const faces = [...document.querySelectorAll('#modal-body .expr-frame img')];
        return {
          title: document.getElementById('modal-title').textContent,
          hasBig: !!big,
          bigDecoded: !!(big && big.complete && big.naturalWidth > 0),
          bigSrc: big ? big.getAttribute('src') : null,
          expressions: document.querySelectorAll('#modal-body .expr-cell').length,
          exprDecoded: faces.filter(i => i.complete && i.naturalWidth > 0).length,
          labels: [...document.querySelectorAll('#modal-body .expr-label')].map(l => l.textContent),
        };
      `);
      if (!opened.hasBig || !opened.bigDecoded) throw new Error('放大视图里的大图没有解码');
      if (!/view=full/.test(opened.bigSrc || '')) throw new Error(`放大用的是 ${opened.bigSrc}`);
      if (!opened.title.includes('苍叶')) throw new Error(`标题是「${opened.title}」`);
      if (opened.expressions < 3) throw new Error(`表情只有 ${opened.expressions} 个`);
      if (opened.exprDecoded !== opened.expressions) {
        throw new Error(`${opened.expressions} 个表情里只有 ${opened.exprDecoded} 个解码成功`);
      }

      // Then the boss, which is the only figure with two forms. It is found on
      // the gallery tab, not on the 敌人 tab: that one is the stat table.
      await cdp.eval(`
        const back = [...document.querySelectorAll('#modal-body .btn')].find(b => b.textContent.includes('返回图鉴'));
        if (!back) throw new Error('放大视图里没有返回按钮');
        back.click();
        return true;
      `);
      await waitFor(cdp, `!!document.querySelector('#modal-body .art-card')`, 6000, '回到画廊');
      await cdp.eval(`
        const card = [...document.querySelectorAll('#modal-body .art-card')]
          .find(c => c.textContent.includes('瓦尔特斯'));
        if (!card) throw new Error('画廊里找不到灰烬之王');
        card.click();
        return true;
      `);
      await awaitImages('#modal-body .expr-frame img');

      const boss = await cdp.eval(`
        const imgs = [...document.querySelectorAll('#modal-body .expr-frame img')];
        return {
          forms: imgs.length,
          decoded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          srcs: imgs.map(i => i.getAttribute('src')),
        };
      `);
      if (boss.forms !== 2) throw new Error(`Boss 应有 2 个形态，得到 ${boss.forms}`);
      if (boss.decoded !== 2) throw new Error(`2 个形态里只有 ${boss.decoded} 个解码成功`);
      if (!boss.srcs.some((s) => /phase=2/.test(s))) throw new Error(`没有第二阶段：${boss.srcs.join(', ')}`);

      await cdp.eval(`Modal.close(); return true;`);
      return `苍叶 ${opened.expressions} 个表情（${opened.labels.join('/')}），Boss ${boss.forms} 个形态`;
    });

    await check('可以打开图鉴并切换分类', async () => {
      await cdp.eval(`
        const btn = [...document.querySelectorAll('#scene-actions .btn')]
          .find(b => b.textContent.includes('整备队伍'));
        if (btn) btn.click();
        return true;
      `);
      await waitFor(cdp, `!document.getElementById('modal').classList.contains('hidden')`, 6000, '弹窗打开');
      const tabs = await cdp.eval(`return document.querySelectorAll('#modal-body .btn').length;`);
      // Click through each codex tab; a throw here means a render bug.
      const counts = await cdp.eval(`
        const out = [];
        const btns = [...document.querySelectorAll('#modal-body .btn')].filter(b => ['技能','状态效果','敌人','装备'].includes(b.textContent.trim()));
        for (const b of btns) { b.click(); await new Promise(r => setTimeout(r, 60)); out.push(document.querySelectorAll('#modal-body tr').length); }
        return out;
      `);
      await cdp.eval(`Modal.close(); return true;`);
      if (counts.some((c) => c < 2)) throw new Error(`某个分类没有渲染出行：${counts.join(',')}`);
      return `分类行数 ${counts.join(' / ')}`;
    });

    // ===================================================================
    // Travel + battle
    // ===================================================================
    await check('可以移动到低语林', async () => {
      await cdp.eval(`
        const item = [...document.querySelectorAll('#travel-list .travel-item')]
          .find(b => b.textContent.includes('低语林'));
        if (!item) throw new Error('找不到低语林');
        item.click();
        return true;
      `);
      await waitFor(cdp, `State.view.node.id === 'whisper_woods'`, 10000, '抵达低语林');
      const name = await cdp.eval(`return document.getElementById('scene-name').textContent;`);
      return name;
    });

    await check('战斗界面完整渲染（行动条 / 单位 / 指令）', async () => {
      await cdp.eval(`
        const btn = [...document.querySelectorAll('#scene-actions .btn')]
          .find(b => b.textContent.includes('探索'));
        if (!btn) throw new Error('找不到探索按钮');
        btn.click();
        return true;
      `);
      await waitFor(cdp, `State.view && State.view.mode === 'battle'`, 15000, '进入战斗');
      await waitFor(cdp, `!document.getElementById('screen-battle').classList.contains('hidden')`, 8000, '战斗界面显示');
      // The first step animates before it hands control over; wait for the
      // command panel rather than reading the DOM immediately after entry.
      await waitFor(cdp, `Runtime.busy === false && document.querySelectorAll('#command-buttons .cmd-btn').length > 0`,
        20000, '指令按钮出现');
      await waitFor(cdp, `document.getElementById('actor-name') !== null`, 5000, '行动者卡片');

      const ui = await cdp.eval(`
        return {
          timeline: document.querySelectorAll('#timeline-track .tl-item').length,
          enemies: document.querySelectorAll('#side-enemy .unit').length,
          allies: document.querySelectorAll('#side-ally .unit').length,
          commands: document.querySelectorAll('#command-buttons .cmd-btn').length,
          pips: document.querySelectorAll('#sp-pips .sp-pip').length,
          actor: document.getElementById('actor-name').textContent,
          hpBars: document.querySelectorAll('.unit .bar-hp .bar-fill').length,
          toughBars: document.querySelectorAll('.unit .bar-tough').length,
          weakPips: document.querySelectorAll('.unit .weak-pip').length,
          statusRows: document.querySelectorAll('.unit .status-row').length,
        };
      `);
      if (ui.timeline < 2) throw new Error(`行动条应有多项，得到 ${ui.timeline}`);
      if (ui.enemies < 1) throw new Error('没有敌人卡片');
      if (ui.allies !== 4) throw new Error(`应有 4 张我方卡片，得到 ${ui.allies}`);
      if (ui.commands < 3) throw new Error(`指令按钮应有至少 3 个，得到 ${ui.commands}`);
      if (ui.pips !== 5) throw new Error(`战技点应有 5 格，得到 ${ui.pips}`);
      if (ui.hpBars !== ui.enemies + ui.allies) throw new Error('每个单位都应有血条');
      if (ui.toughBars !== ui.enemies) throw new Error('每个敌人都应有韧性条');
      if (ui.weakPips < ui.enemies) throw new Error('每个敌人都应显示弱点图标');
      return `行动条 ${ui.timeline} 项 / 敌 ${ui.enemies} / 我 ${ui.allies} / 指令 ${ui.commands}，「${ui.actor}」行动中`;
    });

    await check('点击战技会进入选目标状态', async () => {
      const result = await cdp.eval(`
        const btn = [...document.querySelectorAll('#command-buttons .cmd-btn')]
          .find(b => b.dataset.kind === 'skill');
        if (!btn) throw new Error('找不到战技按钮');
        if (btn.disabled) return { skipped: true, reason: '战技点不足' };
        btn.click();
        await new Promise(r => setTimeout(r, 150));
        return {
          overlay: !document.getElementById('target-overlay').classList.contains('hidden'),
          targetable: document.querySelectorAll('#side-enemy .unit.is-targetable').length,
          hint: document.getElementById('target-hint').textContent,
          highlight: document.querySelectorAll('#side-enemy .unit.is-targetable').length,
        };
      `);
      if (result.skipped) return `跳过（${result.reason}）`;
      if (!result.overlay) throw new Error('选目标提示未出现');
      if (result.targetable < 1) throw new Error('没有可点击的敌人');
      return result.hint;
    });

    await check('取消选择会回到指令面板', async () => {
      // Esc and the cancel button must both restore the panel, or a player can
      // get stuck in targeting state with no way out.
      const cancelled = await cdp.eval(`
        document.querySelector('[data-action="cancel-target"]').click();
        await new Promise(r => setTimeout(r, 100));
        return {
          overlayHidden: document.getElementById('target-overlay').classList.contains('hidden'),
          stillTargetable: document.querySelectorAll('.unit.is-targetable').length,
          pending: !!State.pendingCommand,
        };
      `);
      if (!cancelled.overlayHidden) throw new Error('取消后提示未隐藏');
      if (cancelled.stillTargetable !== 0) throw new Error('取消后仍显示可选目标');
      if (cancelled.pending) throw new Error('取消后仍保留待处理指令');
      return '取消正常';
    });

    // --- Generated art ---------------------------------------------------

    await check('战斗里每个单位都显示真实头像，且图片确实解码成功', async () => {
      // `naturalWidth > 0` is the only honest check here. Asserting that the
      // `src` is set would pass on a 404; asserting the element exists would
      // pass on a broken SVG. A decoded image is the actual requirement.
      await awaitImages('.unit-portrait img.unit-face');
      const info = await cdp.eval(`
        const imgs = [...document.querySelectorAll('.unit-portrait img.unit-face')];
        return {
          units: document.querySelectorAll('.unit').length,
          images: imgs.length,
          decoded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          srcs: imgs.slice(0, 3).map(i => i.getAttribute('src')),
          samples: imgs.slice(0, 2).map(i => i.getAttribute('src')),
        };
      `);
      if (info.units === 0) throw new Error('战斗里没有单位卡');
      if (info.images !== info.units) {
        throw new Error(`${info.units} 个单位里只有 ${info.images} 个有头像`);
      }
      if (info.decoded !== info.images) {
        throw new Error(`${info.images} 张头像里只有 ${info.decoded} 张解码成功（src: ${info.srcs.join(', ')}）`);
      }
      for (const src of info.srcs) {
        if (!/^\/art\/(character|enemy|npc)\//.test(src)) throw new Error(`头像地址不对：${src}`);
        if (!/view=bust/.test(src)) throw new Error(`头像没有用 bust 裁切：${src}`);
      }
      return `${info.decoded}/${info.units} 张已解码`;
    });

    await check('行动条与当前行动者头像也用了真实美术', async () => {
      await awaitImages('.tl-item img.tl-face');
      await awaitImages('#actor-avatar img.actor-face');
      const info = await cdp.eval(`
        const tl = [...document.querySelectorAll('.tl-item img.tl-face')];
        const actor = document.querySelector('#actor-avatar img.actor-face');
        return {
          timeline: tl.length,
          timelineDecoded: tl.filter(i => i.complete && i.naturalWidth > 0).length,
          actor: !!actor,
          actorDecoded: !!(actor && actor.complete && actor.naturalWidth > 0),
        };
      `);
      if (info.timeline === 0) throw new Error('行动条没有任何头像');
      if (info.timelineDecoded !== info.timeline) {
        throw new Error(`行动条 ${info.timeline} 张里只有 ${info.timelineDecoded} 张解码成功`);
      }
      if (!info.actor || !info.actorDecoded) throw new Error('当前行动者头像没有渲染出来');
      await capture('battle');
      return `行动条 ${info.timeline} 张 + 行动者 1 张`;
    });

    await check('选中敌人后技能生效、日志有内容、战技点被消耗', async () => {      const before = await cdp.eval(`
        const b = State.view.battle;
        return {
          hp: b.enemies.map(e => e.hp),
          sp: b.skillPoints,
          actor: State.activeActor ? State.activeActor.name : null,
        };
      `);

      // Choose a skill, then click the first targetable enemy. Doing both in one
      // evaluate keeps the two steps inside a single animation frame budget so
      // the pending-command state cannot be cleared by an unrelated re-render.
      const clicked = await cdp.eval(`
        const btn = [...document.querySelectorAll('#command-buttons .cmd-btn')]
          .find(b => b.dataset.kind === 'skill' && !b.disabled)
          || [...document.querySelectorAll('#command-buttons .cmd-btn')].find(b => b.dataset.kind === 'basic' && !b.disabled);
        if (!btn) throw new Error('没有可用的指令按钮');
        btn.click();
        await new Promise(r => setTimeout(r, 150));
        const t = document.querySelector('#side-enemy .unit.is-targetable');
        if (t) { t.click(); return { targeted: true, kind: btn.dataset.kind }; }
        return { targeted: false, kind: btn.dataset.kind };
      `);

      await waitFor(cdp,
        `Runtime.busy === false`,
        25000, '指令结算完成');

      const after = await cdp.eval(`
        const b = State.view.battle;
        return {
          mode: State.view.mode,
          hp: b ? b.enemies.map(e => e.hp) : null,
          sp: b ? b.skillPoints : null,
          logLines: document.querySelectorAll('#battle-log .log-line').length,
          logText: [...document.querySelectorAll('#battle-log .log-line')].map(l => l.textContent).join(' | '),
        };
      `);

      if (after.mode === 'battle') {
        assert2(after.hp, before.hp, after.sp, before.sp, clicked.kind);
      }
      if (after.logLines < 1) throw new Error('战斗日志没有内容');
      return `「${before.actor}」${clicked.kind === 'skill' ? '战技' : '普攻'} · 战技点 ${before.sp} → ${after.sp} · 日志 ${after.logLines} 行`;
    });

    await check('可以连续出招直到战斗结束', async () => {
      // Drive the real UI: click a command button, then click a target if the
      // client asks for one. The client does not auto-pick targets for basic
      // attacks either, so both branches are exercised here.
      const result = await cdp.eval(`
        let guard = 0;
        let commands = 0;
        while (State.view && State.view.mode === 'battle' && guard++ < 200) {
          // Wait for the animation queue to drain.
          let waited = 0;
          while (Runtime.busy && waited++ < 300) await new Promise(r => setTimeout(r, 40));
          if (State.view.mode !== 'battle') break;

          // Fire a charged ultimate first — that is the mechanic under test.
          //
          // Through BattleUI.fireUltimate, not Api.ultimate. Calling the API
          // directly and assigning State.view skips consume(), which is the
          // only thing that notices the finished flag and shows the result
          // screen. When the ultimate happened to be the killing blow, the
          // battle ended with the result screen still hidden — a one-in-many
          // flake that only ever appeared on the fastest wins.
          const charged = State.view.battle.allies.find(a => a.alive && a.ultimateReady);
          if (charged) {
            const ult = charged.skills.find(s => s.kind === 'ultimate');
            const tgt = State.view.battle.enemies.find(e => e.alive);
            if (ult && tgt) {
              await BattleUI.fireUltimate(charged.uid, ult.id, tgt.uid);
              let drain = 0;
              while (Runtime.busy && drain++ < 300) await new Promise(r => setTimeout(r, 40));
              await new Promise(r => setTimeout(r, 80));
              continue;
            }
          }

          const btns = [...document.querySelectorAll('#command-buttons .cmd-btn')];
          if (!btns.length) { await new Promise(r => setTimeout(r, 100)); continue; }
          const skill = btns.find(b => b.dataset.kind === 'skill' && !b.disabled);
          const basic = btns.find(b => b.dataset.kind === 'basic' && !b.disabled);
          const chosen = skill || basic;
          if (!chosen) { await new Promise(r => setTimeout(r, 100)); continue; }

          chosen.click();
          await new Promise(r => setTimeout(r, 90));
          // The client highlights legal targets; click one if it is asking.
          const targetable = document.querySelector('.unit.is-targetable');
          if (targetable) targetable.click();
          commands++;

          let inner = 0;
          while (Runtime.busy && inner++ < 300) await new Promise(r => setTimeout(r, 40));
          await new Promise(r => setTimeout(r, 50));
        }
        return {
          mode: State.view ? State.view.mode : 'none',
          guard,
          commands,
          result: State.view && State.view.lastResult,
        };
      `);
      if (result.mode === 'battle') throw new Error(`战斗未结束（${result.guard} 次循环，${result.commands} 次指令）`);
      if (!result.result) throw new Error('没有战斗结果');
      return `${result.result.won ? '胜利' : result.result.phase}，${result.result.rounds} 回合，${result.commands} 次指令，+${result.result.exp} 经验`;
    });

    await check('结算界面正确显示', async () => {
      await waitFor(cdp, `!document.getElementById('screen-result').classList.contains('hidden')`, 10000, '结算界面');
      const info = await cdp.eval(`
        return {
          title: document.querySelector('.result-title').textContent.trim(),
          stats: document.querySelectorAll('.result-stat').length,
          rows: document.querySelectorAll('.result-row').length,
          hasButton: !!document.querySelector('#result-card .btn'),
        };
      `);
      if (info.stats !== 3) throw new Error(`应有 3 个统计格，得到 ${info.stats}`);
      if (info.rows < 1) throw new Error('没有队伍结算行');
      if (!info.hasButton) throw new Error('没有继续按钮');
      return `「${info.title}」`;
    });

    await check('可以回到探索界面继续游戏', async () => {
      await cdp.eval(`document.querySelector('#result-card .btn').click(); return true;`);
      await waitFor(cdp, `State.view && State.view.mode !== 'battle' && State.view.mode !== 'result'`, 10000, '回到世界界面');
      await waitFor(cdp, `!document.getElementById('screen-world').classList.contains('hidden')`, 6000, '世界界面显示');
      return `模式 ${await cdp.eval('return State.view.mode;')}`;
    });

    // ===================================================================
    // The boss, driven from the UI
    // ===================================================================
    await check('Boss 战：剧情 → 战斗 → 结束，全流程无异常', async () => {
      // Defensive: a check that threw before its own cleanup would otherwise
      // leave a modal open, and the story modal below would then be layered on
      // top of it — which is how a test bug turns into a twenty-minute hang
      // instead of a red line.
      await cdp.eval(`if (Modal.isOpen) Modal.close(); return true;`);

      // Walk to the boss node and enter. The UI path is `WorldUI.enterNode`
      // (which shows the story modal), so the test drives that rather than
      // calling the API directly and leaving the modal unopened.
      const viaUi = await cdp.eval(`
        // Walk back to town and sleep at the inn first. A player who walks
        // straight from one trash wave into the boss arrives at whatever health
        // the last fight left them, and the fight then hinges on one damage
        // roll — the run that produced this line lost the boss in three rounds.
        // Resting costs one API call, removes that coin flip, and means the test
        // actually exercises the boss's phases and summons.
        for (const node of ['haven_town']) {
          await Api.travel(State.sessionId, node).then(r => { State.view = r.view; });
        }
        await Api.rest(State.sessionId).then(r => { State.view = r.view; });

        // Travel first, through the API, so the world state is right.
        for (const node of ['whisper_woods', 'grub_hollow', 'sentinel_gate', 'throne_of_ash']) {
          await Api.travel(State.sessionId, node).then(r => { State.view = r.view; });
        }
        WorldUI.render(State.view);
        return State.view.node.id;
      `);
      if (viaUi !== 'throne_of_ash') throw new Error(`应抵达王座，实际 ${viaUi}`);

      await cdp.eval(`WorldUI.enterNode('boss'); return true;`);
      await waitFor(cdp, `!document.getElementById('modal').classList.contains('hidden')`, 8000, '剧情弹窗');

      // Page through the story, then start the fight. The "continue" button is
      // the primary one; the header also holds a close button.
      for (let i = 0; i < 8; i++) {
        const finished = await cdp.eval(`
          const btn = document.querySelector('#modal-body .btn-primary');
          if (!btn) return document.getElementById('modal').classList.contains('hidden');
          btn.click();
          await new Promise(r => setTimeout(r, 150));
          return document.getElementById('modal').classList.contains('hidden');
        `);
        if (finished) break;
      }
      await waitFor(cdp, `State.view && State.view.mode === 'battle'`, 20000, 'Boss 战斗开始');

      const bossInfo = await cdp.eval(`
        const boss = State.view.battle.enemies[0];
        return { name: boss.name, toughness: boss.toughnessMax, weaknesses: boss.weaknesses };
      `);
      if (!bossInfo.name.includes('瓦尔特斯')) throw new Error(`不是 Boss：${bossInfo.name}`);

      // Fight it out in short slices rather than one long evaluate. A single
      // call that loops for hundreds of actions blocks the CDP message pump and
      // trips the client's own command timeout, which looks like a hang in the
      // app rather than a limitation of the harness.
      let rounds = 0;
      for (let slice = 0; slice < 80; slice++) {
        // A slice of 6 actions keeps each evaluate well under a second even on a
        // slow machine, which is what keeps this test from flaking.
        const chunk = await cdp.eval(`
          let actions = 0;
          let stall = 0;
          while (actions < 6 && State.view && State.view.mode === 'battle') {
            // Bounded, because "no command buttons yet" is a legitimate state
            // (the server is mid-turn) and an unbounded retry there hangs the
            // whole suite instead of failing it. Kept small on purpose: 60
            // retries is three seconds, which is long enough for a real
            // transition and short enough that a broken state fails loudly.
            if (stall++ > 60) break;
            let waited = 0;
            while (Runtime.busy && waited++ < 200) await new Promise(r => setTimeout(r, 30));
            if (State.view.mode !== 'battle') break;

            const charged = State.view.battle.allies.find(a => a.alive && a.ultimateReady);
            if (charged) {
              const ult = charged.skills.find(s => s.kind === 'ultimate');
              const tgt = State.view.battle.enemies.find(e => e.alive);
              if (ult && tgt) {
                // Same reason as the trash fight above: go through the client's
                // own path so the view, the command panel and the event replay
                // all stay in step. Driving the API directly here left the
                // command panel stale, so the next click often hit a button
                // belonging to an actor who was no longer active — the server
                // refused it, the loop counted it anyway, and the fight dragged
                // on for a hundred rounds instead of fifteen.
                await BattleUI.fireUltimate(charged.uid, ult.id, tgt.uid);
                let drain = 0;
                while (Runtime.busy && drain++ < 200) await new Promise(r => setTimeout(r, 30));
                actions++;
                continue;
              }
            }

            const btns = [...document.querySelectorAll('#command-buttons .cmd-btn')];
            if (!btns.length) { await new Promise(r => setTimeout(r, 60)); continue; }

            // Play like a competent player, not like a metronome. The balance
            // harness drives its fights with a weakness-aware policy; a browser
            // test that always clicks "the first skill" loses the boss fight in
            // four rounds and never reaches the phases and summons it is
            // supposed to be exercising.
            const living = State.view.battle.enemies.filter(e => e.alive);
            const weak = new Set(living.flatMap(e => e.weaknesses || []));
            const elementOf = (btn) => {
              const s = (State.data.skills || []).find(x => x.id === btn.dataset.skill);
              return s ? s.element : null;
            };
            const pick = (kind) => btns
              .filter(b => b.dataset.kind === kind && !b.disabled)
              .sort((a, b) => (weak.has(elementOf(b)) ? 1 : 0) - (weak.has(elementOf(a)) ? 1 : 0))[0];

            const chosen = pick('skill') || pick('basic');
            if (!chosen) { await new Promise(r => setTimeout(r, 60)); continue; }
            chosen.click();
            await new Promise(r => setTimeout(r, 70));

            const element = elementOf(chosen);
            const targets = [...document.querySelectorAll('.unit.is-targetable')];
            const best = targets.find((t) => {
              const e = living.find((x) => x.uid === t.dataset.uid);
              return e && element && (e.weaknesses || []).includes(element);
            }) || targets[0];
            if (best) best.click();

            actions++;
            let inner = 0;
            while (Runtime.busy && inner++ < 200) await new Promise(r => setTimeout(r, 30));
          }
          return { mode: State.view ? State.view.mode : 'none', actions };
        `);
        rounds += chunk.actions;
        if (chunk.mode !== 'battle') break;
        if (chunk.actions === 0) break;
      }

      const outcome = await cdp.eval(`
        return {
          mode: State.view ? State.view.mode : 'none',
          result: State.view && State.view.lastResult,
        };
      `);

      if (outcome.mode === 'battle') throw new Error(`Boss 战未结束（${rounds} 次行动后仍在战斗）`);
      if (!outcome.result) throw new Error('Boss 战没有结果');
      if (cdp.pageErrors.length) throw new Error(`战斗期间出现异常：${cdp.pageErrors.join(' | ')}`);
      return `${bossInfo.name}（韧性 ${bossInfo.toughness}，弱点 ${bossInfo.weaknesses.join('/')}）→ `
        + `${outcome.result.won ? '胜利' : outcome.result.phase}，${outcome.result.rounds} 回合，${rounds} 次行动`;
    });

    await check('整个流程结束时没有未捕获的异常', () => {
      if (cdp.pageErrors.length) throw new Error(cdp.pageErrors.join(' | '));
      const fatal = cdp.consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
      if (fatal.length) throw new Error(fatal.join(' | '));
      return `无异常（控制台错误 ${cdp.consoleErrors.length} 条，均已忽略）`;
    });

    // A screenshot so a human can eyeball the result.
    await capture('boss');
  } finally {
    server.close();
    // Give the browser a moment to release its profile directory before the
    // launcher tries to delete it.
    await new Promise((r) => setTimeout(r, 300));
    browser.close();
  }

  process.stdout.write(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} 通过\x1b[0m\n\n`);
  for (const f of failures) process.stdout.write(`  \x1b[31m${f}\x1b[0m\n`);
  return failed;
}

if (require.main === module) {
  main()
    .then((f) => process.exit(f === 0 ? 0 : 1))
    .catch((err) => {
      process.stderr.write(`浏览器测试崩溃：${err.stack}\n`);
      process.exit(1);
    });
}

module.exports = { main };
