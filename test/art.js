'use strict';

/**
 * Art test.
 *
 * The art in this project is generated geometry, which means it can be checked
 * the way the rest of the engine is checked. This suite is the gate; the visual
 * judgement lives in `tools/art-sheet.js`, which renders a picture and measures
 * the pixels.
 *
 * What this catches, in rough order of how likely it is to actually happen:
 *
 *   - A character, enemy or NPC exists in the game data but has no art spec, so
 *     the UI would show an empty box.
 *   - A spec names a hair style, weapon or costume that does not exist, so the
 *     render throws at request time instead of at test time.
 *   - Geometry drifts outside the canvas. Characters are scaled about the
 *     ground line, so a tall character's hair or weapon can leave the top of
 *     the frame — which is invisible in the source and obvious in the render.
 *     Cubic beziers stay inside the convex hull of their control points, so
 *     checking every emitted coordinate is a *conservative* bound: if the
 *     numbers are inside, the drawing definitely is.
 *   - Two clip paths collide, which happens the moment two characters appear in
 *     one document without unique ids.
 *   - An expression stops being an expression (all four render identically), or
 *     a boss's second phase becomes a recolour of its first.
 *
 * Deliberately no browser: this must run anywhere the engine runs.
 */

const art = require('../src/art');
const { CHARACTERS } = require('../src/core/characters');
const { ENEMIES } = require('../src/core/enemies');
const { WORLD } = require('../src/core/world-data');
const body = require('../src/art/body');
const { STYLES: HAIR_STYLES } = require('../src/art/hair');
const { WEAPONS } = require('../src/art/gear');

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

function check(name, fn) {
  try {
    const detail = fn();
    ok(name, detail);
  } catch (err) {
    bad(name, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function section(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

// ---------------------------------------------------------------------------
// SVG inspection helpers
// ---------------------------------------------------------------------------

const NUM = /-?\d+(?:\.\d+)?/g;

/**
 * Every coordinate the document emits, in canvas units.
 *
 * Path data is a sequence of commands that all take x/y pairs, so the numbers
 * pair up in order without needing a real parser. `circle`/`ellipse`/`rect`/
 * `line`/`polygon` are read from their own attributes.
 */
function extractPoints(svg) {
  const points = [];

  for (const m of svg.matchAll(/ d="([^"]*)"/g)) {
    const nums = (m[1].match(NUM) || []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
  }
  for (const m of svg.matchAll(/<circle([^>]*)\/>/g)) {
    const cx = Number((m[1].match(/ cx="([-\d.]+)"/) || [])[1]);
    const cy = Number((m[1].match(/ cy="([-\d.]+)"/) || [])[1]);
    const r = Number((m[1].match(/ r="([-\d.]+)"/) || [])[1]) || 0;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      points.push([cx - r, cy - r], [cx + r, cy + r]);
    }
  }
  for (const m of svg.matchAll(/<ellipse([^>]*)\/>/g)) {
    const cx = Number((m[1].match(/ cx="([-\d.]+)"/) || [])[1]);
    const cy = Number((m[1].match(/ cy="([-\d.]+)"/) || [])[1]);
    const rx = Number((m[1].match(/ rx="([-\d.]+)"/) || [])[1]) || 0;
    const ry = Number((m[1].match(/ ry="([-\d.]+)"/) || [])[1]) || 0;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      points.push([cx - rx, cy - ry], [cx + rx, cy + ry]);
    }
  }
  for (const m of svg.matchAll(/<rect([^>]*)\/>/g)) {
    const x = Number((m[1].match(/ x="([-\d.]+)"/) || [])[1]);
    const y = Number((m[1].match(/ y="([-\d.]+)"/) || [])[1]);
    const w = Number((m[1].match(/ width="([-\d.]+)"/) || [])[1]) || 0;
    const h = Number((m[1].match(/ height="([-\d.]+)"/) || [])[1]) || 0;
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y], [x + w, y + h]);
  }
  for (const m of svg.matchAll(/<line([^>]*)\/>/g)) {
    // Read by attribute name. Matching every number in the attribute string
    // picks up the digit inside `x1`/`y1`/`x2`/`y2` themselves, which silently
    // produced a phantom point at x = 1 and made every figure look like it was
    // hanging off the left edge of the canvas.
    const num = (name) => {
      const hit = m[1].match(new RegExp(` ${name}="([-\\d.]+)"`));
      return hit ? Number(hit[1]) : NaN;
    };
    const [x1, y1, x2, y2] = [num('x1'), num('y1'), num('x2'), num('y2')];
    if ([x1, y1, x2, y2].every(Number.isFinite)) points.push([x1, y1], [x2, y2]);
  }

  return points;
}

/** The ground-anchored scale the renderer applies to a figure. */
function applyScale(points, scale) {
  if (!scale || scale === 1) return points;
  return points.map(([x, y]) => [230 + (x - 230) * scale, 906 + (y - 906) * scale]);
}

/**
 * A tag-balance check.
 *
 * Not a full XML parser — just enough to catch an unclosed `<g>` or a stray
 * `</path>`, which is what a string-building renderer actually gets wrong.
 */
function checkWellFormed(svg) {
  const stack = [];
  const tokens = svg.match(/<[^>]+>/g) || [];
  for (const token of tokens) {
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      const top = stack.pop();
      if (top !== name) throw new Error(`标签不匹配：</${name}> 关闭了 <${top || '空'}>`);
    } else if (token.endsWith('/>')) {
      // self-closing, nothing to do
    } else {
      const name = (token.match(/^<([a-zA-Z]+)/) || [])[1];
      if (name) stack.push(name);
    }
  }
  if (stack.length) throw new Error(`有未闭合的标签：<${stack.join('>, <')}>`);
}

// ---------------------------------------------------------------------------

function main() {
  process.stdout.write('\n\x1b[1m美术生成 / Generated art\x1b[0m\n');

  const manifest = art.artManifest();
  const byKey = new Map(manifest.map((m) => [`${m.kind}/${m.id}`, m]));

  section('覆盖完整性 / Coverage');

  check('每个可操控角色都有立绘', () => {
    const ids = Object.keys(CHARACTERS);
    const missing = ids.filter((id) => !byKey.has(`character/${id}`));
    assert(!missing.length, `缺少美术：${missing.join(', ')}`);
    return `${ids.length} 名角色`;
  });

  check('每种敌人都有插画', () => {
    const ids = Object.keys(ENEMIES);
    const missing = ids.filter((id) => !byKey.has(`enemy/${id}`));
    assert(!missing.length, `缺少美术：${missing.join(', ')}`);
    return `${ids.length} 种敌人`;
  });

  check('每个城镇 NPC 都有自己的头像', () => {
    const npcs = [];
    for (const node of Object.values(WORLD.nodes)) {
      for (const npc of node.npcs || []) npcs.push(npc);
    }
    const missing = npcs.filter((n) => !byKey.has(`npc/${n.id}`));
    assert(!missing.length, `缺少美术：${missing.map((n) => n.id).join(', ')}`);
    // NPCs used to borrow a playable character's portrait, which made the
    // innkeeper literally Elise. Distinct specs are the fix, so assert it.
    const borrowed = npcs.filter((n) => byKey.has(`character/${n.id}`));
    assert(!borrowed.length, `NPC 与角色同名，会共用头像：${borrowed.map((n) => n.id).join(', ')}`);
    return `${npcs.length} 名 NPC`;
  });

  check('美术里的名字与游戏数据一致', () => {
    for (const entry of manifest) {
      if (entry.kind === 'character') {
        assert(entry.name === CHARACTERS[entry.id].name,
          `${entry.id} 名字不一致：${entry.name} vs ${CHARACTERS[entry.id].name}`);
      }
      if (entry.kind === 'enemy') {
        assert(entry.name === ENEMIES[entry.id].name,
          `${entry.id} 名字不一致：${entry.name} vs ${ENEMIES[entry.id].name}`);
      }
    }
    return '名字与数据文件同步';
  });

  section('渲染合法性 / Render validity');

  check('每个形象都能渲染出合法 SVG', () => {
    let bytes = 0;
    for (const entry of manifest) {
      for (const view of ['full', 'bust']) {
        const { svg } = art.renderArt(entry.kind, entry.id, { view });
        assert(svg.startsWith('<svg'), `${entry.id}/${view} 没有 svg 根元素`);
        assert(svg.endsWith('</svg>'), `${entry.id}/${view} 没有闭合`);
        assert(!/NaN|undefined|Infinity/.test(svg), `${entry.id}/${view} 里出现了 NaN/undefined`);
        checkWellFormed(svg);
        bytes += svg.length;
      }
    }
    return `${manifest.length} 个形象 × 2 视图，共 ${(bytes / 1024).toFixed(0)} KB`;
  });

  check('所有颜色都是合法字面量', () => {
    const legal = /^(#[0-9a-f]{3,8}|none|currentColor|url\(#[\w-]+\)|rgba?\([\d.,\s%]+\))$/i;
    for (const entry of manifest) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full' });
      for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
        assert(legal.test(m[1]), `${entry.id} 的颜色不合法：${m[1]}`);
      }
    }
    return '全部为 hex / none / url(#…)';
  });

  check('同一文档内的元素 id 不重复', () => {
    for (const entry of manifest) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full' });
      const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
      assert(!dupes.length, `${entry.id} 内重复 id：${[...new Set(dupes)].join(', ')}`);
      // Every reference must resolve, or a clip path silently does nothing.
      for (const m of svg.matchAll(/url\(#([\w-]+)\)/g)) {
        assert(ids.includes(m[1]), `${entry.id} 引用了不存在的 id：${m[1]}`);
      }
    }
    return 'id 唯一且引用可解析';
  });

  check('不同形象之间的 id 不会互相覆盖', () => {
    const owner = new Map();
    const clashes = [];
    for (const entry of manifest) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full' });
      for (const m of svg.matchAll(/ id="([^"]+)"/g)) {
        const key = m[1];
        if (owner.has(key) && owner.get(key) !== entry.id) {
          clashes.push(`${key}（${owner.get(key)} 与 ${entry.id}）`);
        }
        owner.set(key, entry.id);
      }
    }
    assert(!clashes.length, `id 冲突：${clashes.slice(0, 4).join('; ')}`);
    return `${owner.size} 个 id 全部归属唯一`;
  });

  section('几何约束 / Geometry');

  check('没有图形超出画布（含缩放后的角色）', () => {
    const offenders = [];
    for (const entry of manifest) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full', plain: true });
      const box = entry.kind === 'enemy'
        ? [0, 0, 400, 400]
        : [0, 0, body.CANVAS.w, body.CANVAS.h];
      const pts = applyScale(extractPoints(svg), entry.scale);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of pts) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      const out = [];
      if (minX < box[0]) out.push(`左 ${minX.toFixed(0)}`);
      if (minY < box[1]) out.push(`上 ${minY.toFixed(0)}`);
      if (maxX > box[2]) out.push(`右 ${maxX.toFixed(0)}`);
      if (maxY > box[3]) out.push(`下 ${maxY.toFixed(0)}`);
      if (out.length) offenders.push(`${entry.id}（${out.join('，')}）`);
    }
    assert(!offenders.length, `超出画布：${offenders.join('; ')}`);
    return `${manifest.length} 个形象全部在画布内`;
  });

  check('每个角色都留出了足够的顶部余量', () => {
    // Scale is anchored at the ground, so a taller character's hair rises
    // faster than the canvas does. Anything under ~14 units of headroom is one
    // hair tweak away from being clipped.
    const tight = [];
    for (const entry of manifest.filter((e) => e.kind !== 'enemy')) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full', plain: true });
      const pts = applyScale(extractPoints(svg), entry.scale);
      const minY = Math.min(...pts.map((p) => p[1]));
      if (minY < 14) tight.push(`${entry.id}（顶部余量 ${minY.toFixed(0)}）`);
    }
    assert(!tight.length, `顶部余量不足：${tight.join('; ')}`);
    return '全部 ≥ 14 单位';
  });

  check('bust 视图确实框住了头部', () => {
    for (const entry of manifest.filter((e) => e.kind !== 'enemy')) {
      const scale = entry.scale || 1;
      const [vx, vy, vw, vh] = body.bustView(scale);
      const head = body.head();
      const nums = (head.match(NUM) || []).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const [x, y] = [230 + (nums[i] - 230) * scale, 906 + (nums[i + 1] - 906) * scale];
        assert(x >= vx && x <= vx + vw && y >= vy && y <= vy + vh,
          `${entry.id}: 头部坐标 ${x.toFixed(0)},${y.toFixed(0)} 落在 bust 视图之外`);
      }
    }
    return '头部完整落在裁切框内';
  });

  check('全身与头像的 viewBox 与清单一致', () => {
    for (const entry of manifest) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'bust' });
      const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
      assert(vb, `${entry.id} 缺少 viewBox`);
      const parts = vb.split(/\s+/).map(Number);
      assert(Math.abs(parts[1] - entry.bustY0) < 0.6,
        `${entry.id}: 清单里的 bustY0=${entry.bustY0}，实际 ${parts[1]}`);
    }
    return `${manifest.length} 个 bust 视图与清单同步`;
  });

  section('设计约束 / Design invariants');

  check('每个可操控角色的姿势都不重复', () => {
    // Scoped to the playable cast. NPCs are allowed to share a pose with each
    // other — they are never on screen together as a lineup — but the five
    // characters are, and a cloned stance is the first thing a player notices.
    const used = new Map();
    const clashes = [];
    for (const entry of manifest.filter((e) => e.kind === 'character')) {
      const spec = art.renderArt(entry.kind, entry.id, { view: 'full' }).spec;
      const pose = spec.pose || 'stand';
      if (used.has(pose)) clashes.push(`${pose}（${used.get(pose)} 与 ${entry.id}）`);
      used.set(pose, entry.id);
    }
    assert(!clashes.length, `姿势重复：${clashes.join('; ')}`);
    return `${used.size} 名角色，${used.size} 种姿势`;
  });

  check('所有人类形象加起来也不重复姿势', () => {
    const used = new Map();
    const clashes = [];
    for (const entry of manifest.filter((e) => e.kind !== 'enemy')) {
      const spec = art.renderArt(entry.kind, entry.id, { view: 'full' }).spec;
      const pose = spec.pose || 'stand';
      if (used.has(pose)) clashes.push(`${pose}（${used.get(pose)} 与 ${entry.id}）`);
      used.set(pose, entry.id);
    }
    assert(!clashes.length, `姿势重复：${clashes.join('; ')}`);
    return `${used.size} 个人类形象，姿势各不相同`;
  });

  check('每个角色的身高都不相同', () => {
    const seen = new Map();
    const clashes = [];
    for (const entry of manifest.filter((e) => e.kind !== 'enemy')) {
      const spec = art.renderArt(entry.kind, entry.id, { view: 'full' }).spec;
      const scale = spec.scale || 1;
      if (seen.has(scale)) clashes.push(`${scale}（${seen.get(scale)} 与 ${entry.id}）`);
      seen.set(scale, entry.id);
    }
    assert(!clashes.length, `身高完全相同：${clashes.join('; ')}`);
    const values = [...seen.keys()].sort((a, b) => a - b);
    return `${values[0]} – ${values[values.length - 1]}`;
  });

  check('用到的发型与武器都已实现', () => {
    for (const entry of manifest) {
      const spec = art.renderArt(entry.kind, entry.id, { view: 'full' }).spec;
      if (spec.hair) {
        assert(Object.prototype.hasOwnProperty.call(HAIR_STYLES, spec.hair.style),
          `${entry.id} 的发型不存在：${spec.hair.style}`);
        assert(/^#[0-9a-f]{6}$/i.test(spec.hair.base), `${entry.id} 的发色不合法`);
      }
      if (spec.weapon) {
        assert(Object.prototype.hasOwnProperty.call(WEAPONS, spec.weapon),
          `${entry.id} 的武器不存在：${spec.weapon}`);
      }
    }
    return `${Object.keys(HAIR_STYLES).length} 种发型 / ${Object.keys(WEAPONS).length} 种武器`;
  });

  check('四种表情各不相同', () => {
    for (const entry of manifest.filter((e) => e.kind === 'character')) {
      const seen = new Map();
      for (const expression of art.EXPRESSIONS) {
        const { svg } = art.renderArt(entry.kind, entry.id, { view: 'bust', expression });
        const face = (svg.match(/<svg[\s\S]*<\/svg>/) || [''])[0];
        if (seen.has(face)) throw new Error(`${entry.id} 的 ${expression} 与 ${seen.get(face)} 完全相同`);
        seen.set(face, expression);
      }
    }
    return `${art.EXPRESSIONS.length} 种表情互不相同`;
  });

  check('Boss 二阶段不是简单换色', () => {
    const a = art.renderArt('enemy', 'ashen_king', { view: 'full', phase: 1 }).svg;
    const b = art.renderArt('enemy', 'ashen_king', { view: 'full', phase: 2 }).svg;
    assert(a !== b, '一阶段与二阶段完全相同');
    const shapes = (svg) => (svg.match(/<(path|circle|ellipse|polygon)\b/g) || []).length;
    const delta = Math.abs(shapes(a) - shapes(b));
    assert(delta >= 4, `二阶段只多了 ${delta} 个形状，看起来只是换色`);
    return `二阶段多出 ${delta} 个形状`;
  });

  check('敌人不会共用同一套剪影', () => {
    const seen = new Map();
    const clashes = [];
    for (const entry of manifest.filter((e) => e.kind === 'enemy')) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full', plain: true });
      const shape = (svg.match(/ d="([^"]{0,40})/g) || []).join('|');
      if (seen.has(shape)) clashes.push(`${seen.get(shape)} 与 ${entry.id}`);
      seen.set(shape, entry.id);
    }
    assert(!clashes.length, `敌人形状雷同：${clashes.join('; ')}`);
    return `${seen.size} 种敌人形状各异`;
  });

  section('体积 / Size');

  check('单张立绘不超过 64 KB', () => {
    const big = [];
    for (const entry of manifest) {
      const { svg } = art.renderArt(entry.kind, entry.id, { view: 'full' });
      const kb = svg.length / 1024;
      if (kb > 64) big.push(`${entry.id} ${kb.toFixed(0)} KB`);
    }
    assert(!big.length, `过大：${big.join(', ')}`);
    const all = manifest.map((e) => art.renderArt(e.kind, e.id, { view: 'full' }).svg.length);
    return `最大 ${(Math.max(...all) / 1024).toFixed(0)} KB，平均 ${(all.reduce((a, b) => a + b, 0) / all.length / 1024).toFixed(0)} KB`;
  });

  check('头像不会比立绘还大', () => {
    for (const entry of manifest) {
      const full = art.renderArt(entry.kind, entry.id, { view: 'full' }).svg.length;
      const bust = art.renderArt(entry.kind, entry.id, { view: 'bust' }).svg.length;
      // A small slack for the viewBox string itself: an enemy's bust is the
      // same layers under a different crop, so the two are near-identical in
      // size and demanding "strictly smaller" would be a lie.
      assert(bust <= full + 64, `${entry.id}: 头像 ${bust} 明显大于立绘 ${full}`);
    }
    return 'bust ≤ full + 64 B';
  });

  process.stdout.write(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} 通过\x1b[0m\n\n`);
  for (const f of failures) process.stdout.write(`  \x1b[31m${f}\x1b[0m\n`);
  return failed;
}

if (require.main === module) {
  process.exit(main() === 0 ? 0 : 1);
}

module.exports = { main, extractPoints, checkWellFormed, applyScale };
