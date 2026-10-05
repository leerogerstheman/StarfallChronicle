'use strict';

/**
 * Render every piece of art into a contact sheet and measure it.
 *
 * Why this exists
 * ---------------
 * The art in this project was authored without the ability to look at the
 * result. Geometry can be reasoned about, but "is this actually a person and
 * not a knot of polygons" cannot. So this tool does two things:
 *
 *   1. Writes `docs/art-sheet.png` — a real picture, for a human to judge.
 *   2. Measures each figure in a headless browser by drawing it to a canvas and
 *      reading the pixels back, then prints numbers that catch the failure modes
 *      that matter and that a human eye would otherwise have to catch:
 *
 *        fill      fraction of the canvas covered. Near 0 means the figure is
 *                  off-canvas or scaled to nothing; near 1 means a shape has
 *                  swallowed the frame.
 *        bbox      where the ink actually landed. A figure touching an edge is
 *                  being clipped, which is the most common generator bug.
 *        head      vertical position of the widest row in the top third, a
 *                  crude but effective "is there a head, and is it at the top".
 *        twin      pairwise silhouette overlap (IoU) within a kind. Two
 *                  characters above ~0.9 are the same drawing with different
 *                  paint, which defeats the entire point of portraits.
 *
 * Exits non-zero when a measurement is out of range, so it can gate a release
 * as well as inform one.
 *
 *   node tools/art-sheet.js
 *   node tools/art-sheet.js --out docs/art-sheet.png --kind character
 *   node tools/art-sheet.js --no-shot      measurements only, no browser shot
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const art = require('../src/art');
const { launchBrowser } = require('../test/lib/cdp');

const ROOT = path.resolve(__dirname, '..');
const METRIC_PX = 128;

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'docs', 'art-sheet.png'), kind: null, shot: true, cell: 240 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
    else if (a === '--cell') out.cell = Number(argv[++i]);
    else if (a === '--no-shot') out.shot = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function buildPage(entries, cell) {
  const cellFor = (e) => `
    <figure class="cell">
      <img src="${e.measureUrl}" data-id="${e.kind}/${e.id}" alt="${e.id}">
      <figcaption><b>${e.name}</b><span>${e.title || e.en || ''}</span></figcaption>
    </figure>`;

  const groupFor = (kind, list) => `
    <section class="group">
      <h2>${kind}</h2>
      <div class="grid">${list.map(cellFor).join('')}</div>
    </section>`;

  const kinds = [...new Set(entries.map((e) => e.kind))];

  // Bust probes ride along in a hidden row. They have to be in the same
  // document as the sheet so the canvas is not tainted, but they must not
  // appear in the picture.
  const probes = entries
    .filter((e) => e.kind !== 'enemy')
    .map((e) => `<img data-probe="${e.kind}/${e.id}" data-scale="${e.scale}" data-busty="${e.bustY0}"
        style="display:none" src="/art/${e.kind}/${e.id}.svg?view=bust&plain=1" alt="">`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Starfall Chronicle · art sheet</title>
<style>
  :root { --bg:#0a0c14; --panel:#12151f; --line:#242a3d; --text:#e6e9f2; --faint:#7c86a3; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:13px/1.4 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; padding:24px 28px 40px; }
  h1 { font-size:20px; letter-spacing:.12em; margin:0 0 4px; }
  .sub { color:var(--faint); margin-bottom:22px; font-size:12px; }
  h2 { font-size:12px; letter-spacing:.28em; text-transform:uppercase; color:var(--faint);
       margin:26px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(${cell}px,1fr)); gap:14px; }
  .cell { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:10px;
          overflow:hidden; display:flex; flex-direction:column; }
  .cell img { width:100%; height:${Math.round(cell * 1.5)}px; object-fit:contain;
              background:#080a10; display:block; }
  figcaption { padding:8px 10px 10px; display:flex; flex-direction:column; gap:2px; }
  figcaption b { font-size:13px; font-weight:600; }
  figcaption span { font-size:11px; color:var(--faint); }
</style></head>
<body>
  <h1>星陨纪年 · 美术对照表</h1>
  <div class="sub">Starfall Chronicle — generated SVG art sheet.
    ${entries.length} figures. Everything here is produced by <code>src/art/</code> at request time.</div>
  ${kinds.map((k) => groupFor(k, entries.filter((e) => e.kind === k))).join('')}
  <div style="display:none">${probes}</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// In-page measurement
// ---------------------------------------------------------------------------

const MEASURE_SCRIPT = (px) => `
  const nodes = [...document.querySelectorAll('.cell img')];
  await Promise.all(nodes.map((n) => n.complete ? null : new Promise((r) => {
    n.addEventListener('load', r); n.addEventListener('error', r);
  })));
  const out = [];
  for (const img of nodes) {
    const c = document.createElement('canvas');
    c.width = ${px}; c.height = ${px};
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, ${px}, ${px});
    ctx.drawImage(img, 0, 0, ${px}, ${px});
    const d = ctx.getImageData(0, 0, ${px}, ${px}).data;

    const mask = new Uint8Array(${px} * ${px});
    let count = 0, minX = ${px}, minY = ${px}, maxX = -1, maxY = -1;
    for (let y = 0; y < ${px}; y++) {
      for (let x = 0; x < ${px}; x++) {
        const a = d[(y * ${px} + x) * 4 + 3];
        if (a > 24) {
          mask[y * ${px} + x] = 1;
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) { out.push({ id: img.dataset.id, empty: true, mask: [] }); continue; }

    // Widest run per row, to find where the mass of the drawing is.
    const rowWidth = new Array(${px}).fill(0);
    for (let y = 0; y < ${px}; y++) {
      let first = -1, last = -1;
      for (let x = 0; x < ${px}; x++) {
        if (mask[y * ${px} + x]) { if (first < 0) first = x; last = x; }
      }
      rowWidth[y] = last < 0 ? 0 : last - first + 1;
    }

    out.push({
      id: img.dataset.id,
      empty: false,
      fill: count / (${px} * ${px}),
      bbox: [minX / ${px}, minY / ${px}, (maxX + 1) / ${px}, (maxY + 1) / ${px}],
      rowWidth,
      // 32x32 silhouette, for comparing figures to each other. "Any ink at
      // all", not "mostly ink": a threshold of 0.5 erases exactly the thin
      // features that distinguish one character from another — a spear shaft,
      // a trailing lock of hair — and makes every figure look like the same
      // blob.
      thumb: (() => {
        const s = 32, t = [];
        for (let by = 0; by < s; by++) for (let bx = 0; bx < s; bx++) {
          let hit = 0, total = 0;
          for (let y = Math.floor(by * ${px} / s); y < Math.floor((by + 1) * ${px} / s); y++)
            for (let x = Math.floor(bx * ${px} / s); x < Math.floor((bx + 1) * ${px} / s); x++) {
              total++; if (mask[y * ${px} + x]) hit++;
            }
          t.push(total ? hit / total : 0);
        }
        return t;
      })(),
    });
  }

  // --- face probes ---------------------------------------------------------
  // Sample a handful of known landmarks in the bust view. This is the check
  // that would catch the failure a human spots instantly and no bounding box
  // ever will: hair grown over the eyes, or a face the same colour as the
  // fringe above it.
  const probes = [];
  for (const img of document.querySelectorAll('img[data-probe]')) {
    const c = document.createElement('canvas');
    c.width = 216; c.height = 216;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 216, 216);
    ctx.drawImage(img, 0, 0, 216, 216);
    const d = ctx.getImageData(0, 0, 216, 216).data;
    const at = (fx, fy) => {
      const x = Math.max(0, Math.min(215, Math.round(fx * 215)));
      const y = Math.max(0, Math.min(215, Math.round(fy * 215)));
      const i = (y * 216 + x) * 4;
      return [d[i], d[i + 1], d[i + 2], d[i + 3]];
    };
    // Bust viewBox is computed per character, because the cast has different
    // heights. The helper below takes a point in the *unscaled* body coordinate
    // system and pushes it through the same ground-anchored scale the renderer
    // uses, then into bust-local normalised coordinates. Skipping the scale
    // step would sample the wrong pixel on every character who is not 1.0.
    const scale = Number(img.dataset.scale) || 1;
    const bustY0 = Number(img.dataset.busty) || 52;
    const full = (x, y) => {
      const sx = 230 + (x - 230) * scale;
      const sy = 906 + (y - 906) * scale;
      return at((sx - 122) / 216, (sy - bustY0) / 216);
    };
    probes.push({
      id: img.dataset.probe,
      hair: full(230, 100),
      eyeL: full(203, 156),
      eyeR: full(257, 156),
      // Inward of the old sample. At x=196 the point landed on the outline of
      // Rin's framing lock and the quartermaster's beard, so both reported a
      // "skin" pixel of pure ink — the probe was wrong, not the art.
      cheek: full(212, 180),
      chin: full(230, 204),
    });
  }
  return { figures: out, probes };
`;

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function iou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > 0 ? 1 : 0;
    const y = b[i] > 0 ? 1 : 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 0;
}

/** Perceived luminance of an `[r,g,b,a]` sample. */
function lum(px) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(px[0]) + 0.7152 * f(px[1]) + 0.0722 * f(px[2]);
}

function rgbDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const hex = (px) => `#${px.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Landmark checks on the bust.
 *
 * These are the checks that stand in for looking at the picture. A bounding
 * box can be perfect while the fringe has grown over both eyes, so the only
 * way to assert "there is a readable face here" is to sample the pixels where
 * the face is supposed to be.
 */
function analyseProbes(probes) {
  const problems = [];
  const rows = [];

  for (const p of probes) {
    const issues = [];
    if (p.hair[3] < 200) issues.push('头顶没有不透明像素（刘海缺失？）');
    if (p.cheek[3] < 200) issues.push('脸颊没有不透明像素');

    const hairVsSkin = rgbDistance(p.hair, p.cheek);
    if (hairVsSkin < 45) {
      issues.push(`头发与皮肤几乎同色（RGB 距离 ${hairVsSkin.toFixed(0)}，应 > 45）`);
    }

    for (const [name, px] of [['左眼', p.eyeL], ['右眼', p.eyeR]]) {
      if (px[3] < 200) issues.push(`${name}位置没有像素（被头发盖住了？）`);
      else if (lum(px) > 0.34) issues.push(`${name}位置不够暗（亮度 ${lum(px).toFixed(2)}，应 < 0.34）`);
    }

    // Skin is warm: red must lead blue by a clear margin. This catches a face
    // that has been covered by hair, armour or a collar.
    if (p.cheek[3] >= 200 && p.cheek[0] - p.cheek[2] < 18) {
      issues.push(`脸颊不像肤色（R ${p.cheek[0]} 对 B ${p.cheek[2]}，暖色差应 ≥ 18）`);
    }

    rows.push({ id: p.id, hair: hex(p.hair), cheek: hex(p.cheek), eye: hex(p.eyeL), distance: hairVsSkin });
    for (const i of issues) problems.push(`${p.id}: ${i}`);
  }

  return { problems, rows };
}

function analyse(metrics) {
  const problems = [];
  const notes = [];

  for (const m of metrics) {
    if (m.empty) {
      problems.push(`${m.id}: 空白（画布上没有任何像素）`);
      continue;
    }
    const [x0, y0, x1, y1] = m.bbox;
    if (m.fill < 0.02) problems.push(`${m.id}: 覆盖率只有 ${(m.fill * 100).toFixed(1)}%，图形太小或跑到画布外`);
    if (m.fill > 0.94) problems.push(`${m.id}: 覆盖率 ${(m.fill * 100).toFixed(1)}%，几乎填满画布（多半有形状失控）`);
    if (x0 <= 0.002 || y0 <= 0.002 || x1 >= 0.998 || y1 >= 0.998) {
      problems.push(`${m.id}: 图形触到画布边缘（bbox ${m.bbox.map((v) => v.toFixed(2)).join(', ')}），会被裁切`);
    }
  }

  // Head check: the top of a standing figure is its head, and a head is always
  // narrower than the shoulders below it. If the widest row in the top 15% is
  // also the widest row overall, the head is oversized or the figure is upside
  // down. 15% rather than 40% because at 40% the check is measuring the
  // shoulders and always fires.
  for (const m of metrics) {
    if (m.empty || !m.rowWidth) continue;
    const n = m.rowWidth.length;
    const topMax = Math.max(...m.rowWidth.slice(0, Math.floor(n * 0.15)));
    const allMax = Math.max(...m.rowWidth);
    if (allMax > 0 && topMax / allMax > 0.9) {
      notes.push(`${m.id}: 顶部最宽处是全图最宽处的 ${(topMax / allMax * 100).toFixed(0)}%，头部可能过大`);
    }
  }

  // Distinctness, within a kind only: an enemy should not look like a
  // character, but two characters must not look like each other.
  const byKind = new Map();
  for (const m of metrics) {
    if (m.empty) continue;
    const kind = m.id.split('/')[0];
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(m);
  }
  const pairs = [];
  for (const [kind, list] of byKind) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const score = iou(list[i].thumb, list[j].thumb);
        pairs.push({ kind, a: list[i].id, b: list[j].id, score });
      }
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  const worst = pairs.filter((p) => p.score >= 0.93);
  for (const p of worst) {
    problems.push(`${p.a} 与 ${p.b} 剪影重合度 ${(p.score * 100).toFixed(0)}%，几乎一模一样`);
  }

  return { problems, notes, pairs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = art.artManifest().filter((e) => !args.kind || e.kind === args.kind);

  const entries = manifest.map((e) => ({
    ...e,
    measureUrl: `/art/${e.kind}/${e.id}.svg?view=full&plain=1`,
  }));

  const page = buildPage(entries, args.cell);

  // A throwaway server: the page needs same-origin images so the canvas is not
  // tainted and `getImageData` is allowed. A `file://` page would taint it.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    const match = /^\/art\/([a-z]+)\/([A-Za-z0-9_]+)\.svg$/.exec(url.pathname);
    if (!match) { res.writeHead(404); return res.end('nope'); }
    try {
      const { svg } = art.renderArt(match[1], match[2], {
        view: url.searchParams.get('view'),
        expression: url.searchParams.get('expression'),
        phase: url.searchParams.get('phase'),
        plain: url.searchParams.get('plain'),
      });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      return res.end(svg);
    } catch (err) {
      res.writeHead(404);
      return res.end(err.message);
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  process.stdout.write('\n\x1b[1m美术对照表 / Art sheet\x1b[0m\n');
  process.stdout.write(`  ${entries.length} figures · ${base}\n\n`);

  const browser = await launchBrowser({ windowSize: `${args.cell * 5 + 200},1400` });
  let exitCode = 0;

  try {
    await browser.cdp.send('Page.navigate', { url: base });
    await browser.cdp.eval('return document.readyState;');
    await new Promise((r) => setTimeout(r, 600));

    const measured = await browser.cdp.eval(MEASURE_SCRIPT(METRIC_PX));
    const metrics = measured.figures;
    const probeReport = analyseProbes(measured.probes);

    // --- table ---------------------------------------------------------
    process.stdout.write(
      `  ${'figure'.padEnd(26)}${'fill'.padStart(7)}${'bbox (x0,y0,x1,y1)'.padStart(28)}${'head/top'.padStart(11)}\n`,
    );
    for (const m of metrics) {
      if (m.empty) {
        process.stdout.write(`  \x1b[31m${m.id.padEnd(26)}EMPTY\x1b[0m\n`);
        continue;
      }
      const n = m.rowWidth.length;
      const topMax = Math.max(...m.rowWidth.slice(0, Math.floor(n * 0.15)));
      const allMax = Math.max(...m.rowWidth);
      const ratio = allMax ? (topMax / allMax * 100).toFixed(0) + '%' : '-';
      process.stdout.write(
        `  ${m.id.padEnd(26)}${(m.fill * 100).toFixed(1).padStart(6)}%`
        + `${m.bbox.map((v) => v.toFixed(2)).join(', ').padStart(28)}${ratio.padStart(11)}\n`,
      );
    }

    if (probeReport.rows.length) {
      process.stdout.write('\n  \x1b[1m五官取样（bust 视图上的固定点）\x1b[0m\n');
      for (const r of probeReport.rows) {
        process.stdout.write(
          `  ${r.id.padEnd(26)}头发 ${r.hair}  脸颊 ${r.cheek}  眼 ${r.eye}`
          + `  \x1b[90m色差 ${r.distance.toFixed(0)}\x1b[0m\n`,
        );
      }
    }

    const { problems, notes, pairs } = analyse(metrics);
    problems.push(...probeReport.problems);

    process.stdout.write('\n  \x1b[1m剪影重合度最高的几对（越低越好）\x1b[0m\n');
    for (const p of pairs.slice(0, 6)) {
      const tag = p.score >= 0.9 ? '\x1b[31m' : p.score >= 0.8 ? '\x1b[33m' : '\x1b[90m';
      process.stdout.write(`  ${tag}${(p.score * 100).toFixed(0).padStart(3)}%\x1b[0m  ${p.a}  vs  ${p.b}\n`);
    }

    if (notes.length) {
      process.stdout.write('\n  \x1b[33m提示\x1b[0m\n');
      for (const n of notes) process.stdout.write(`    ${n}\n`);
    }

    if (problems.length) {
      process.stdout.write('\n  \x1b[31m问题\x1b[0m\n');
      for (const p of problems) process.stdout.write(`    ${p}\n`);
      exitCode = 1;
    } else {
      process.stdout.write('\n  \x1b[32m所有几何检查通过\x1b[0m\n');
    }

    // --- screenshot ----------------------------------------------------
    if (args.shot) {
      const height = await browser.cdp.eval('return document.body.scrollHeight;');
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: args.cell * 5 + 200,
        height: Math.min(height, 8000),
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 500));
      const shot = await browser.cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
      });
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, Buffer.from(shot.data, 'base64'));
      process.stdout.write(`\n  对照表已保存：${args.out}  (${(fs.statSync(args.out).size / 1024).toFixed(0)} KB)\n`);
    }
  } finally {
    browser.close();
    server.close();
  }

  process.stdout.write('\n');
  return exitCode;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((err) => {
    process.stderr.write(`美术对照表生成失败：${err.stack}\n`);
    process.exit(1);
  });
}

module.exports = { main, iou, analyse };
