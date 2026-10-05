'use strict';

/**
 * Timing probe: samples the client's state every 250 ms after entering a battle.
 *
 * Used to diagnose ordering bugs between the server's step result and the
 * client's render, which are invisible in a single snapshot and obvious in a
 * timeline.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createServer } = require('../src/api/server');
const { findBrowser } = require('./browser');

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = this.id++;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
    }
    return r.result.value;
  }
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) { process.stdout.write('no browser\n'); return 1; }

  process.env.STARFALL_QUIET = '1';
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-probe-'));
  const proc = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((res, rej) => {
    let b = '';
    const t = setTimeout(() => rej(new Error('browser timeout')), 25000);
    const d = (c) => { b += c.toString(); const m = b.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]); } };
    proc.stderr.on('data', d); proc.stdout.on('data', d);
  });

  const meta = await (await fetch(`${wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '')}/json/list`)).json();
  const tgt = meta.find((t) => t.type === 'page');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });

  const wait = async (expr, ms = 20000) => {
    const s = Date.now();
    while (Date.now() - s < ms) {
      try { if (await cdp.eval(`return !!(${expr});`)) return true; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout: ${expr}`);
  };

  try {
    await wait(`document.getElementById('title') && !document.getElementById('title').classList.contains('hidden')`);
    await cdp.eval(`
      document.getElementById('start-level').value = '20';
      document.querySelector('[data-action="new-game"]').click();
      return 1;
    `);
    await wait(`State.view && State.view.mode === 'town'`);
    await cdp.eval(`
      const i = [...document.querySelectorAll('#travel-list .travel-item')].find(b => b.textContent.includes('低语林'));
      i.click();
      return 1;
    `);
    await wait(`State.view.node.id === 'whisper_woods'`);

    process.stdout.write('\n--- 点击「探索」前 ---\n');
    process.stdout.write(await cdp.eval(`
      return JSON.stringify({
        mode: State.view.mode,
        busy: Runtime.busy,
        actions: [...document.querySelectorAll('#scene-actions .btn')].map(b => b.textContent.trim()),
      });
    `) + '\n');

    // Instrument the command renderer so the sequence of calls is visible. The
    // bug class this catches is *ordering*: a correct render followed by a stale
    // one, which a single snapshot cannot distinguish from a broken render.
    await cdp.eval(`
      window.__log = [];
      const orig = BattleUI.renderCommands.bind(BattleUI);
      BattleUI.renderCommands = function (view) {
        window.__log.push({
          actor: State.activeActor ? State.activeActor.uid : null,
          viewHasBattle: !!(view && view.battle),
          viewAllies: view && view.allies ? view.allies.map(a => a.uid) : null,
          busy: Runtime.busy,
        });
        return orig(view);
      };
      return 1;
    `);

    await cdp.eval(`
      const b = [...document.querySelectorAll('#scene-actions .btn')].find(x => x.textContent.includes('探索'));
      if (!b) throw new Error('no explore button');
      b.click();
      return 1;
    `);

    process.stdout.write('\n--- 采样 ---\n');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = await cdp.eval(`
        return {
          mode: State.view ? State.view.mode : null,
          busy: Runtime.busy,
          actor: State.activeActor ? State.activeActor.name : null,
          cmds: document.querySelectorAll('#command-buttons .cmd-btn').length,
          actorCard: !!document.getElementById('actor-name'),
          battleScreen: !document.getElementById('screen-battle').classList.contains('hidden'),
          enemies: State.view && State.view.battle ? State.view.battle.enemies.length : -1,
        };
      `);
      process.stdout.write(
        `${String(i).padStart(2)}  mode=${String(s.mode).padEnd(7)} busy=${String(s.busy).padEnd(5)} `
        + `actor=${String(s.actor).padEnd(6)} cmds=${s.cmds} actorCard=${s.actorCard} `
        + `screen=${s.battleScreen} enemies=${s.enemies}\n`,
      );
    }

    if (cdp.errors.length) {
      process.stdout.write('\n--- 异常 ---\n');
      for (const e of cdp.errors) process.stdout.write(`${e}\n`);
    }

    process.stdout.write('\n--- renderCommands 调用序列 ---\n');
    const log = await cdp.eval('return window.__log || [];');
    for (const entry of log) {
      process.stdout.write(
        `  actor=${String(entry.actor).padEnd(9)} hasBattle=${String(entry.viewHasBattle).padEnd(5)} `
        + `allies=${entry.viewAllies ? entry.viewAllies.length : 'null'} busy=${entry.busy}\n`,
      );
    }
  } finally {
    try { ws.close(); } catch { /* gone */ }
    proc.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* lock */ }
  }
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
}
