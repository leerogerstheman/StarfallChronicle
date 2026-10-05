'use strict';

/**
 * Live-page inspector.
 *
 * A debugging aid rather than a test: it boots the game in a real browser, walks
 * to a fight, and dumps the DOM plus client state so a human (or an agent) can
 * see what the page actually looks like instead of inferring it from failures.
 *
 *   node test/inspect.js
 *   node test/inspect.js --boss        jump straight to the boss fight
 *   node test/inspect.js --shot out.png
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createServer } = require('../src/api/server');
const { findBrowser } = require('./browser');

const argv = process.argv.slice(2);
const TO_BOSS = argv.includes('--boss');
const SHOT = (() => {
  const i = argv.indexOf('--shot');
  return i >= 0 ? argv[i + 1] : null;
})();

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id != null) {
        const e = this.pending.get(msg.id);
        if (e) {
          this.pending.delete(msg.id);
          if (msg.error) e.reject(new Error(msg.error.message));
          else e.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.errors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 30000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
    }
    return res.result.value;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    process.stdout.write('未找到浏览器。\n');
    return 1;
  }

  process.env.STARFALL_QUIET = '1';
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starfall-inspect-'));
  const proc = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('browser did not start')), 25000);
    const onData = (c) => {
      buf += c.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
  });

  const meta = await (await fetch(`${wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '')}/json/list`)).json();
  const target = meta.find((t) => t.type === 'page');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });

  const waitFor = async (expr, timeout = 15000, label = expr) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await cdp.eval(`return !!(${expr});`)) return true; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`waitFor timeout: ${label}`);
  };

  try {
    await waitFor(`document.getElementById('title') && !document.getElementById('title').classList.contains('hidden')`);
    await cdp.eval(`
      document.getElementById('start-level').value = '20';
      document.querySelector('[data-action="new-game"]').click();
      return true;
    `);
    await waitFor(`State.view && State.view.mode === 'town'`);

    if (TO_BOSS) {
      await cdp.eval(`
        for (const n of ['whisper_woods','grub_hollow','sentinel_gate','throne_of_ash']) {
          await Api.travel(State.sessionId, n).then(r => { State.view = r.view; });
        }
        const res = await Api.enter(State.sessionId);
        State.view = res.view;
        return res.result.entry;
      `);
      await cdp.eval(`
        Modal.close();
        await Main.continueStory();
        return true;
      `);
      await waitFor(`State.view && State.view.mode === 'battle'`, 20000, 'boss battle');
    } else {
      await cdp.eval(`
        const i = [...document.querySelectorAll('#travel-list .travel-item')].find(b => b.textContent.includes('低语林'));
        i.click();
        return true;
      `);
      await waitFor(`State.view.node.id === 'whisper_woods'`);
      await cdp.eval(`
        const b = [...document.querySelectorAll('#scene-actions .btn')].find(x => x.textContent.includes('探索'));
        b.click();
        return true;
      `);
      await waitFor(`State.view && State.view.mode === 'battle'`, 20000, 'battle');
    }

    // Let the first step settle.
    await new Promise((r) => setTimeout(r, 2500));

    const report = await cdp.eval(`
      const q = (s) => document.querySelectorAll(s).length;
      return {
        stateMode: State.view && State.view.mode,
        hasBattle: !!(State.view && State.view.battle),
        battleMode: State.view && State.view.battle && State.view.battle.mode,
        battleEnemies: State.view && State.view.battle ? State.view.battle.enemies.length : -1,
        battleAllies: State.view && State.view.battle ? State.view.battle.allies.length : -1,
        activeActor: State.activeActor ? State.activeActor.name : null,
        busy: Runtime.busy,
        hiddenScreens: ['screen-world','screen-battle','screen-result']
          .filter(id => document.getElementById(id).classList.contains('hidden')),
        dom: {
          timeline: q('#timeline-track .tl-item'),
          enemyUnits: q('#side-enemy .unit'),
          allyUnits: q('#side-ally .unit'),
          cmdButtons: q('#command-buttons .cmd-btn'),
          pips: q('#sp-pips .sp-pip'),
          actorCard: q('#actor-card .actor-name'),
          logLines: q('#battle-log .log-line'),
          targetable: q('#side-enemy .unit.is-targetable'),
        },
        sceneActions: [...document.querySelectorAll('#scene-actions .btn')].map(b => b.textContent.trim()),
      };
    `);

    process.stdout.write('\n=== 页面状态 ===\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    // What the command panel markup actually contains, if anything.
    const panel = await cdp.eval(`return document.getElementById('command-panel').innerHTML.slice(0, 600);`);
    process.stdout.write('\n=== #command-panel innerHTML ===\n' + panel + '\n');

    const actorCard = await cdp.eval(`return document.getElementById('actor-card').innerHTML.slice(0, 400);`);
    process.stdout.write('\n=== #actor-card innerHTML ===\n' + actorCard + '\n');

    if (cdp.errors.length) {
      process.stdout.write('\n=== 页面异常 ===\n');
      for (const e of cdp.errors) process.stdout.write(e + '\n');
    }

    if (SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      process.stdout.write(`\n截图：${SHOT}\n`);
    }
  } finally {
    cdp.close();
    proc.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((err) => {
    process.stderr.write(`崩溃：${err.stack}\n`);
    process.exit(1);
  });
}
