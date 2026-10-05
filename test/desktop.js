'use strict';

/**
 * Desktop shell test.
 *
 * The native launcher is the one part of this project that is not JavaScript,
 * so it needs its own test: does it build, does it find the project, does it
 * start the server, does it open a window, and — the part that is easy to get
 * wrong — does closing the window actually take the server down with it?
 *
 * Two layers, because the second one is not always available:
 *
 *   1. `--selfcheck`  builds the launcher and asks it to do everything except
 *      open a window. Runs anywhere Windows + csc.exe exist, including CI.
 *   2. window test    launches it for real, reads the window title back out of
 *      the OS, then closes the window with WM_CLOSE (taskkill without /F) and
 *      asserts the child Node process is gone. Skipped when the WebView2
 *      runtime is missing, because then the launcher deliberately falls back
 *      to a browser and a modal dialog.
 *
 * Every step that cannot run is reported as skipped, never as passed.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'desktop', 'bin');
const EXE = path.join(BIN, 'StarfallChronicle.exe');

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(name, why) {
  skipped++;
  process.stdout.write(`  \x1b[33m-\x1b[0m ${name}  \x1b[90mskipped: ${why}\x1b[0m\n`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    if (detail === SKIP) return;
    ok(name, detail);
  } catch (err) {
    bad(name, err.message);
  }
}

const SKIP = Symbol('skip');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// -- helpers ----------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** Parse one line of `tasklist /FO CSV` output, honouring quoted fields. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function tasklist(args) {
  const r = spawnSync('tasklist', args, { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return [];
  return String(r.stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('"'))
    .map(parseCsvLine);
}

function nodePids() {
  return new Set(tasklist(['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'])
    .map((cols) => Number(cols[1]))
    .filter((n) => Number.isFinite(n)));
}

/**
 * Run a PowerShell snippet that prints compact JSON, or null.
 *
 * The encoding preamble is not optional: Windows PowerShell writes to a pipe
 * using the console code page (GBK on a Chinese system), so a UTF-8 reader on
 * this end would turn the window title into mojibake. That is exactly the kind
 * of silent corruption that lets a title assertion pass on its ASCII half
 * alone, so it is pinned here rather than worked around at the call site.
 */
function psJson(command) {
  const preamble = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', preamble + command],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const text = String(r.stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (err) { return null; }
}

/**
 * Pid and main window title of the launcher, or null when it is not running.
 *
 * Deliberately not `tasklist /V`: that reports whichever top-level window it
 * finds first, and a WinForms process owns an invisible OLE helper window
 * (`OleMainThreadWndName`) before the form exists. `MainWindowTitle` asks for
 * the process's actual main window instead.
 */
function launcherRow() {
  const row = psJson(
    '$p = Get-Process -Name StarfallChronicle -ErrorAction SilentlyContinue | Select-Object -First 1; '
    + 'if ($p) { [pscustomobject]@{ pid = $p.Id; title = [string]$p.MainWindowTitle } | ConvertTo-Json -Compress }',
  );
  if (!row) return null;
  return { pid: Number(row.pid), title: String(row.title || '') };
}

/** How many WebView2 host processes name our launcher as their embedder. */
function webviewHostCount() {
  const n = psJson(
    "(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
    + "Where-Object { $_.CommandLine -like '*StarfallChronicle*' }).Count",
  );
  return Number(n) || 0;
}

/** Poll `fn` until it returns something truthy, or give up. */
async function waitFor(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function fetchHealth(port, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function hasWebViewRuntime() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env['ProgramFiles'],
  ].filter(Boolean).map((p) => path.join(p, 'Microsoft', 'EdgeWebView', 'Application'));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, dir, 'msedgewebview2.exe'))) return true;
    }
  }
  return false;
}

function runSelfcheck(port) {
  const r = spawnSync(EXE, ['--selfcheck', '--port', String(port)], {
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  });
  return r;
}

// -- main -------------------------------------------------------------------

async function main() {
  process.stdout.write('\n  原生窗口 / Desktop shell\n');

  if (process.platform !== 'win32') {
    skip('原生窗口启动器', '非 Windows 平台');
    return finish();
  }

  const csc = findCsc();
  if (!csc) {
    skip('原生窗口启动器', '本机没有 csc.exe（.NET Framework 4.x）');
    return finish();
  }

  // --- build ---------------------------------------------------------------

  await check('build-desktop.bat 能用系统自带的 csc.exe 构建', () => {
    const r = spawnSync('cmd.exe', ['/c', 'build-desktop.bat'], {
      cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
    });
    assert(!r.error, `无法执行 build-desktop.bat：${r.error && r.error.message}`);
    assert(r.status === 0, `构建返回 ${r.status}：${(r.stdout || '').slice(-400)}`);
    assert(fs.existsSync(EXE), '构建后没有 StarfallChronicle.exe');
    return `${(fs.statSync(EXE).size / 1024).toFixed(0)} KB`;
  });

  await check('WebView2 托管程序集被放到 exe 旁边', () => {
    // The .NET Framework loader resolves assemblies by name from the
    // application directory, so "next to the exe" is the only place that works.
    const needed = [
      'Microsoft.Web.WebView2.Core.dll',
      'Microsoft.Web.WebView2.WinForms.dll',
      'WebView2Loader.dll',
    ];
    for (const f of needed) {
      assert(fs.existsSync(path.join(BIN, f)), `缺少 ${f}`);
    }
    return `${needed.length} 个 DLL`;
  });

  // --- selfcheck -----------------------------------------------------------

  await check('--selfcheck：找到项目、找到 Node、起服务、再收干净', async () => {
    const before = nodePids();
    const port = await freePort();
    const r = runSelfcheck(port);
    assert(!r.error, `启动失败：${r.error && r.error.message}`);
    assert(r.status === 0, `退出码 ${r.status}（stderr: ${(r.stderr || '').trim()}）`);
    assert(/selfcheck ok/.test(r.stdout || ''), `输出里没有成功标记：${JSON.stringify(r.stdout)}`);

    await sleep(600);
    const leaked = [...nodePids()].filter((p) => !before.has(p));
    assert(leaked.length === 0, `selfcheck 之后留下孤儿 Node 进程：${leaked.join(',')}`);
    return `port ${port}`;
  });

  await check('--selfcheck 结束后端口被真正释放（可以连续跑）', async () => {
    // If shutdown only killed the process without letting the socket go, the
    // second run would find the port busy, decide it is "attached" to someone
    // else's server, and never start its own. That failure mode is invisible
    // unless you run it twice on the same port.
    const port = await freePort();
    const first = runSelfcheck(port);
    assert(first.status === 0, `第一次退出码 ${first.status}`);

    const second = runSelfcheck(port);
    assert(second.status === 0, `第二次退出码 ${second.status}（端口没有释放？）`);
    assert(/selfcheck ok/.test(second.stdout || ''), `第二次输出异常：${JSON.stringify(second.stdout)}`);
    return `port ${port} ×2`;
  });

  // --- window --------------------------------------------------------------

  if (!hasWebViewRuntime()) {
    skip('原生窗口：标题、任务栏、关闭收尾', '本机没有 WebView2 运行时（启动器会退回浏览器）');
    return finish();
  }

  const port = await freePort();
  const before = nodePids();
  const proc = spawn(EXE, ['--port', String(port)], { stdio: 'ignore', windowsHide: false });

  try {
    await check('原生窗口能起来，并且服务在同一端口就绪', async () => {
      const deadline = Date.now() + 45000;
      let health = null;
      while (Date.now() < deadline) {
        health = await fetchHealth(port);
        if (health && health.ok) break;
        await sleep(300);
      }
      assert(health && health.ok, '窗口启动后 /api/health 没有就绪');
      return `uptime ${health.uptime}s`;
    });

    await check('窗口是独立的原生窗口（有自己的标题）', async () => {
      // Both halves are required. Matching only "Starfall" would still pass if
      // the Chinese half arrived as mojibake, which is the failure this whole
      // PowerShell-pipe encoding dance exists to prevent.
      const looksRight = (t) => /星陨纪年/.test(t) && /Starfall/.test(t);

      const row = await waitFor(() => {
        const r = launcherRow();
        return r && looksRight(r.title) ? r : null;
      }, 40000);

      if (!row) {
        const seen = launcherRow();
        assert(seen, '系统里找不到 StarfallChronicle.exe 进程');
        throw new Error(`40 秒内没出现标题正确的窗口（最后读到：${JSON.stringify(seen.title)}）`);
      }
      return `pid ${row.pid} · "${row.title}"`;
    });

    await check('页面真的渲染了（WebView2 子进程活着）', async () => {
      // The browser host process carries the embedding executable's name on its
      // command line; renderer children do not. A hit therefore means our own
      // WebView2 process tree is up, not some other app's WebView.
      const count = await waitFor(() => webviewHostCount() || null, 25000);
      assert(count, '没有属于本程序的 msedgewebview2 进程');
      return `${count} 个 WebView2 宿主进程`;
    });

    await check('关闭窗口会结束服务，且不留孤儿进程', async () => {
      const row = launcherRow();
      assert(row, '窗口已经不在了，无法测试关闭行为');

      // taskkill without /F posts WM_CLOSE: this exercises the real
      // FormClosed handler instead of yanking the process out.
      spawnSync('taskkill', ['/PID', String(row.pid)], { encoding: 'utf8', windowsHide: true });

      const exited = await waitForExit(proc, 20000);
      assert(exited, '窗口收到 WM_CLOSE 后 20 秒仍未退出');

      await sleep(800);
      const leaked = [...nodePids()].filter((p) => !before.has(p));
      assert(leaked.length === 0, `留下孤儿 Node 进程：${leaked.join(',')}`);

      const health = await fetchHealth(port, 1200);
      assert(health === null, '窗口关了但端口还在响应');
      return 'WM_CLOSE → 退出码 ' + proc.exitCode;
    });
  } finally {
    if (proc.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    }
    // Belt and braces: never let this test leave a server behind.
    for (const pid of nodePids()) {
      if (!before.has(pid)) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    }
  }

  return finish();
}

function finish() {
  process.stdout.write(
    `\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} 通过`
    + `${skipped ? `\x1b[0m\x1b[90m（${skipped} 项跳过）` : ''}\x1b[0m\n\n`,
  );
  for (const f of failures) process.stdout.write(`  \x1b[31m${f}\x1b[0m\n`);
  if (failures.length) process.stdout.write('\n');
  return failed;
}

if (require.main === module) {
  main().then((f) => process.exit(f === 0 ? 0 : 1)).catch((err) => {
    process.stderr.write(`原生窗口测试崩溃：${err.stack}\n`);
    process.exit(1);
  });
}

module.exports = { main };
