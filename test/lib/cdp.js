'use strict';

/**
 * A minimal Chrome DevTools Protocol client and browser launcher.
 *
 * Shared by `test/browser.js` (which plays the game) and `tools/art-sheet.js`
 * (which renders the art and measures it). Both need exactly the same three
 * things — find a browser, launch it headless with a throwaway profile, talk to
 * one page — so the launcher lives here rather than being written twice and
 * drifting.
 *
 * Deliberately not Playwright or Puppeteer: the project's promise is
 * "double-click and play", and a test harness that needs a 300 MB browser
 * download would break that promise for anyone who clones it. The whole client
 * is four CDP commands over Node's built-in `WebSocket`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Where Chromium-family browsers usually live on Windows, macOS and Linux. */
const CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

function findBrowser() {
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    this.listeners = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error(`WebSocket 连接失败：${e.message || 'unknown'}`)));
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id != null) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
        return;
      }
      for (const fn of this.listeners) fn(msg);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.pageErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
    });
  }

  /** Subscribe to raw protocol events. Returns an unsubscribe function. */
  on(fn) {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      // A generous timeout: individual evaluates are short, but a slow machine
      // can still take a while to schedule the page's microtasks.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时：${method}`));
        }
      }, 60000);
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
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

  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

/** Poll until `expression` is truthy, or throw after `timeout`. */
async function waitFor(cdp, expression, timeout = 12000, label = 'condition') {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await cdp.eval(`return !!(${expression});`);
      if (value) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待超时（${label}）：${expression}${lastErr ? ` — ${lastErr.message}` : ''}`);
}

/**
 * Launch a headless browser with a throwaway profile and connect to its first
 * page target.
 *
 * Returns `{ cdp, proc, profile, close() }`. `close()` is idempotent and is
 * safe to call from a `finally` block.
 */
async function launchBrowser(options = {}) {
  const browserPath = options.browserPath || findBrowser();
  if (!browserPath) throw new Error('未找到 Chromium 系浏览器（Chrome / Edge / Chromium）');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starfall-cdp-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${options.windowSize || '1440,900'}`,
    'about:blank',
  ];
  const proc = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const cleanup = () => {
    try { proc.kill(); } catch { /* already gone */ }
    // Windows may still hold the profile directory for a moment.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  let wsUrl;
  try {
    // Chromium prints the DevTools websocket URL to stderr once it is listening.
    wsUrl = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('浏览器未在 25 秒内启动调试端口')), 25000);
      const onData = (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/ws:\/\/[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      proc.stderr.on('data', onData);
      proc.stdout.on('data', onData);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`浏览器提前退出，代码 ${code}`));
      });
    });

    // The browser-level socket cannot create a page target; connect to the page.
    const host = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const targets = await (await fetch(`${host}/json/list`)).json();
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('找不到可用的页面目标');

    const cdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable').catch(() => { /* optional domain */ });

    let closed = false;
    return {
      cdp,
      proc,
      profile,
      browserPath,
      close() {
        if (closed) return;
        closed = true;
        cdp.close();
        cleanup();
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

module.exports = { Cdp, findBrowser, launchBrowser, waitFor, CANDIDATES };
