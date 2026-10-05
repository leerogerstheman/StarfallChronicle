'use strict';

/**
 * Application entry point.
 *
 *   node src/server.js              start on http://127.0.0.1:8787
 *   PORT=9000 node src/server.js
 *
 * Environment:
 *   HOST              bind address (default 127.0.0.1; 0.0.0.0 to publish on a LAN)
 *   PORT              listen port (default 8787)
 *   STARFALL_OPEN=1   open the default browser after start
 *   STARFALL_QUIET=1  suppress the banner (used by the test harness)
 *
 * The boot sequence deliberately runs the self-check *before* binding the port.
 * A content error — a skill referencing a status that does not exist, an
 * encounter naming an unknown enemy — should stop the server with a readable
 * message rather than produce a game that silently misbehaves three screens in.
 *
 * That ordering has one exception: the check is skipped when
 * `STARFALL_SKIP_SELFTEST=1`, which the test harness sets because it already ran
 * the suite.
 */

const config = require('./config');
const { createServer } = require('./api/server');
const { spawn } = require('child_process');

/**
 * Run the self-check in-process. Kept out of `test/run-all.js`'s CLI path so
 * the banner stays clean, and wrapped so that a *crash* in the check itself is
 * reported as a boot failure rather than an unhandled exception.
 */
function selfCheck() {
  try {
    const { run } = require('../test/run-all');
    // Suppress the harness's own output; the server prints its own summary.
    const originalWrite = process.stdout.write;
    let captured = '';
    process.stdout.write = (chunk, ...rest) => {
      captured += chunk;
      return true;
    };
    let failures;
    try {
      failures = run();
    } finally {
      process.stdout.write = originalWrite;
    }
    return { failures, output: captured };
  } catch (err) {
    return { failures: 1, output: `自检崩溃：${err.stack || err.message}` };
  }
}

function banner(url, check, extra = {}) {
  const lines = [
    '',
    '  ============================================================',
    `   星陨纪年 / Starfall Chronicle   v${config.version}`,
    '   JRPG 战斗模板与可玩 Demo',
    '  ============================================================',
    '',
    `   访问地址 / URL      ${url}`,
    `   Node 版本           ${process.version}`,
    '',
  ];

  if (check) {
    const pass = check.failures === 0;
    lines.push(
      `   自检     / SelfTest  ${pass ? '✓ 全部通过' : `*** ${check.failures} 项失败 ***`}`,
    );
    if (!pass) {
      lines.push('', '   失败详情：');
      for (const line of check.output.split('\n')) {
        if (line.includes('✗')) lines.push(`     ${line.trim()}`);
      }
      lines.push('');
    }
  }

  lines.push(
    '   ------------------------------------------------------------',
    '   玩法 / How to play',
    '     1. 城镇里先看「队伍」调整出战 4 人，去旅店休息、军需处买装备。',
    '     2. 「出发」进入下一张地图，探索会触发遭遇战。',
    '     3. 战斗：普攻攒战技点，战技削韧，韧性归零即「击破」。',
    '     4. 能量满时按 Q 或点角色头像，可插入终结技（不消耗回合）。',
    '',
    '   快捷键 / Hotkeys  1 普攻   2 战技   3 终结技   Q 插入终结技   Space 推进',
    '',
    '   建议先跑一遍平衡性测试 / Balance harness:',
    '     npm run balance',
    '',
  );

  if (extra.warning) lines.push(`   ⚠  ${extra.warning}`, '');
  process.stdout.write(lines.join('\n') + '\n');
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    // `detached` + `unref` so a browser failure cannot take the server with it.
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

function main() {
  const skipCheck = process.env.STARFALL_SKIP_SELFTEST === '1';
  const quiet = process.env.STARFALL_QUIET === '1';

  let check = null;
  if (!skipCheck) {
    check = selfCheck();
    if (check.failures > 0 && !quiet) {
      // Print the failing lines and refuse to start. A demo that boots into a
      // broken state is worse than one that refuses to boot.
      process.stdout.write('\n\x1b[31m启动前自检未通过，已中止。\x1b[0m\n');
      for (const line of check.output.split('\n')) {
        if (line.includes('✗') || line.includes('通过')) process.stdout.write(`${line}\n`);
      }
      process.stdout.write('\n用 `npm run selftest` 查看完整输出。\n\n');
      process.exit(1);
    }
  }

  const server = createServer();
  const host = config.host;
  const port = config.port;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\n端口 ${port} 已被占用。\n`
        + `可能是上一次的服务器还在运行。换个端口：\n`
        + `  set PORT=8788 && node src/server.js\n\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`服务器错误：${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    const url = `http://${shown}:${port}/`;
    if (!quiet) {
      banner(url, check, {
        warning: host === '0.0.0.0' ? '已绑定 0.0.0.0，同一局域网内任何人都能访问。' : null,
      });
    }
    if (process.env.STARFALL_OPEN === '1') openBrowser(url);
  });

  // Graceful shutdown so a Ctrl+C does not leave a half-open socket behind.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      process.stdout.write('\n正在关闭服务器…\n');
      server.close(() => process.exit(0));
      // Do not hang forever on a lingering keep-alive connection.
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
}

if (require.main === module) main();

module.exports = { main, selfCheck, banner };
