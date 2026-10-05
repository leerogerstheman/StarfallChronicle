'use strict';

/**
 * Render every piece of art to disk and print a table.
 *
 * A development tool, not a test: it answers "what does the generator actually
 * emit, and how big is it" without starting the server. `test/art.js` asserts
 * the invariants; this is what you run when an invariant fails and you want to
 * look at the output — or, with `--bounds`, when the invariant is "something is
 * outside the canvas" and you need to know which layer.
 *
 *   node tools/render-art.js                → %TEMP%/starfall-art
 *   node tools/render-art.js --out docs/art
 *   node tools/render-art.js --kind enemy
 *   node tools/render-art.js --expression victory
 *   node tools/render-art.js --bounds       per-layer min/max, no files written
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const art = require('../src/art');
const { figure } = require('../src/art/human');
const { extractPoints, applyScale } = require('../test/art');
const body = require('../src/art/body');

function parseArgs(argv) {
  const out = {
    out: path.join(os.tmpdir(), 'starfall-art'),
    kind: null, expression: null, views: null, bounds: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
    else if (a === '--expression') out.expression = argv[++i];
    else if (a === '--views') out.views = argv[++i].split(',');
    else if (a === '--bounds') out.bounds = true;
  }
  return out;
}

/**
 * Per-layer bounds.
 *
 * "Something is off the canvas" is not actionable; "the hairFront layer of
 * byakuya reaches y = -4" is. Each layer is measured on its own for exactly
 * that reason.
 */
function reportBounds(kindFilter) {
  const manifest = art.artManifest();
  const kinds = kindFilter ? [kindFilter] : ['character', 'npc'];

  for (const kind of kinds) {
    for (const entry of manifest.filter((m) => m.kind === kind)) {
      const spec = art.renderArt(kind, entry.id, { view: 'full' }).spec;
      const scale = entry.scale || 1;
      const { layers } = figure(spec, { uid: entry.id, showAura: false, showMotifs: false });

      let worst = null;
      for (const [name, markup] of Object.entries(layers)) {
        if (!markup) continue;
        const pts = applyScale(extractPoints(markup), scale);
        let minY = Infinity;
        let minX = Infinity;
        let maxX = -Infinity;
        for (const [x, y] of pts) {
          if (y < minY) minY = y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
        const margin = Math.min(minY, minX, body.CANVAS.w - maxX, body.CANVAS.h - minY);
        if (!worst || margin < worst.margin) worst = { name, margin, minY, minX, maxX };
      }
      const flag = worst.margin < 14 ? '\x1b[31m' : '\x1b[32m';
      process.stdout.write(
        `  ${entry.id.padEnd(14)} scale ${String(scale).padEnd(5)} `
        + `tightest layer ${worst.name.padEnd(11)} ${flag}余量 ${worst.margin.toFixed(1)}\x1b[0m`
        + `  (minY ${worst.minY.toFixed(1)}, x ${worst.minX.toFixed(1)}…${worst.maxX.toFixed(1)})\n`,
      );
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.bounds) {
    process.stdout.write('\n\x1b[1m各层几何边界 / Per-layer bounds\x1b[0m\n');
    reportBounds(args.kind);
    process.stdout.write('\n');
    return 0;
  }

  fs.mkdirSync(args.out, { recursive: true });

  const manifest = art.artManifest();
  const kinds = args.kind ? [args.kind] : [...new Set(manifest.map((m) => m.kind))];
  const views = args.views || ['full', 'bust'];
  const expressions = args.expression ? [args.expression] : ['neutral'];

  let total = 0;
  let count = 0;
  const allIds = new Map();

  process.stdout.write('\n');
  for (const kind of kinds) {
    process.stdout.write(`  ${kind}\n`);
    for (const entry of manifest.filter((m) => m.kind === kind)) {
      for (const view of views) {
        for (const expression of expressions) {
          const { svg } = art.renderArt(kind, entry.id, { view, expression });
          const name = [entry.id, view, expression].filter(Boolean).join('-');
          fs.writeFileSync(path.join(args.out, `${kind}-${name}.svg`), svg, 'utf8');

          total += Buffer.byteLength(svg, 'utf8');
          count++;

          for (const m of svg.matchAll(/ id="([^"]+)"/g)) {
            if (allIds.has(m[1])) allIds.set(m[1], allIds.get(m[1]) + 1);
            else allIds.set(m[1], 1);
          }

          const issues = [];
          if (/NaN|undefined|Infinity/.test(svg)) issues.push('NON-FINITE');
          if (!svg.startsWith('<svg')) issues.push('NO ROOT');
          if (!svg.endsWith('</svg>')) issues.push('UNCLOSED');

          process.stdout.write(
            `    ${name.padEnd(28)} ${String(svg.length).padStart(7)} B`
            + `  ${issues.length ? `\x1b[31m${issues.join(' ')}\x1b[0m` : '\x1b[32mok\x1b[0m'}\n`,
          );
        }
      }
    }
  }

  const shared = [...allIds.entries()].filter(([, n]) => n > 1);
  process.stdout.write(`\n  ${count} files, ${(total / 1024).toFixed(0)} KB total\n`);
  process.stdout.write(`  duplicate element ids across all files: ${shared.length ? shared.map(([k]) => k).join(', ') : 'none'}\n`);
  process.stdout.write(`  written to ${args.out}\n\n`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
