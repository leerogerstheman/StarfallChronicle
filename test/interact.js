'use strict';

/**
 * Interaction probe: clicks a skill button and reports what the client did.
 *
 * Companion to `probe.js`, which samples render timing. This one follows a
 * single interaction end to end — button click → pending command → target
 * highlight → submit — because that chain spans four functions in two files and
 * a break anywhere in it looks identical from the outside ("clicking does
 * nothing").
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createServer } = require('../src/api/server');
const { findBrowser } = require('./browser');

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
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
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-int-'));
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
  const ws = new WebSocket(meta.find((t) => t.type === 'page').webSocketDebuggerUrl);
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
    await cdp.eval(`document.getElementById('start-level').value='20';document.querySelector('[data-action="new-game"]').click();return 1;`);
    await wait(`State.view && State.view.mode === 'town'`);
    await cdp.eval(`
      const i = [...document.querySelectorAll('#travel-list .travel-item')].find(b => b.textContent.includes('低语林'));
      i.click(); return 1;
    `);
    await wait(`State.view.node.id === 'whisper_woods'`);
    await cdp.eval(`
      const b = [...document.querySelectorAll('#scene-actions .btn')].find(x => x.textContent.includes('探索'));
      b.click(); return 1;
    `);
    await wait(`Runtime.busy === false && document.querySelectorAll('#command-buttons .cmd-btn').length > 0`);

    process.stdout.write('\n--- 点击战技前 ---\n');
    process.stdout.write(await cdp.eval(`
      const btns = [...document.querySelectorAll('#command-buttons .cmd-btn')];
      return JSON.stringify({
        activeActor: State.activeActor ? State.activeActor.name : null,
        buttons: btns.map(b => ({ kind: b.dataset.kind, skill: b.dataset.skill, disabled: b.disabled })),
        skillPoints: State.view.battle.skillPoints,
      }, null, 1);
    `) + '\n');

    // Click the skill and watch the pending-command state evolve.
    process.stdout.write('\n--- 点击战技 ---\n');
    const afterClick = await cdp.eval(`
      const btn = [...document.querySelectorAll('#command-buttons .cmd-btn')].find(b => b.dataset.kind === 'skill');
      if (!btn) return { error: 'no skill button' };
      if (btn.disabled) return { error: 'skill button disabled' };
      btn.click();
      await new Promise(r => setTimeout(r, 250));
      return {
        pendingCommand: State.pendingCommand,
        overlayHidden: document.getElementById('target-overlay').classList.contains('hidden'),
        overlayText: document.getElementById('target-hint').textContent,
        enemyUnits: document.querySelectorAll('#side-enemy .unit').length,
        targetableUnits: document.querySelectorAll('#side-enemy .unit.is-targetable').length,
        allTargetable: document.querySelectorAll('.unit.is-targetable').length,
        enemyUnitClasses: [...document.querySelectorAll('#side-enemy .unit')].map(u => u.className),
      };
    `);
    process.stdout.write(JSON.stringify(afterClick, null, 1) + '\n');

    // Inspect the targetSideFor logic directly.
    process.stdout.write('\n--- targetSideFor 判定 ---\n');
    process.stdout.write(await cdp.eval(`
      const actor = State.activeActor;
      const out = {};
      for (const s of actor.skills) {
        out[s.name + '(' + s.kind + ')'] = { target: s.target, side: BattleUI.targetSideFor(s) };
      }
      return JSON.stringify(out, null, 1);
    `) + '\n');

    if (cdp.errors.length) {
      process.stdout.write('\n--- 异常 ---\n');
      for (const e of cdp.errors) process.stdout.write(`${e}\n`);
    }
  } finally {
    try { ws.close(); } catch { /* gone */ }
    proc.kill(); server.close();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* lock */ }
  }
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
}
