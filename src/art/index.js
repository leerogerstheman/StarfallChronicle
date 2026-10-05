'use strict';

/**
 * Art entry point.
 *
 * Everything under `src/art/` is a pure function from a spec to an SVG string.
 * Nothing is written to disk and nothing is pre-rendered, which keeps the
 * project's "no build step" promise: edit a spec, refresh, see the change.
 *
 * Renders are memoised by (kind, id, view, expression) because a battle screen
 * asks for the same eight portraits on every single frame of animation, and
 * re-walking the geometry each time would be pure waste. The cache is bounded
 * so a caller cannot grow it without limit by inventing expressions.
 */

const { render: renderHuman } = require('./human');
const { render: renderCreature } = require('./creature');
const { bustView } = require('./body');
const characters = require('./specs/characters');
const enemies = require('./specs/enemies');
const npcs = require('./specs/npcs');

const KINDS = {
  character: {
    label: '角色',
    ids: () => characters.characterArtIds(),
    spec: (id) => characters.characterArt(id),
    render: renderHuman,
  },
  enemy: {
    label: '敌人',
    ids: () => enemies.enemyArtIds(),
    spec: (id) => enemies.enemyArt(id),
    render: renderCreature,
  },
  npc: {
    label: 'NPC',
    ids: () => npcs.npcArtIds(),
    spec: (id) => npcs.npcArt(id),
    render: renderHuman,
  },
};

const VIEWS = ['full', 'bust'];
const EXPRESSIONS = require('./face').EXPRESSION_IDS;

const MAX_CACHE = 256;
const cache = new Map();

function normaliseOptions(options = {}) {
  const view = VIEWS.includes(options.view) ? options.view : 'full';
  const expression = EXPRESSIONS.includes(options.expression) ? options.expression : 'neutral';
  const phase = Number.isFinite(Number(options.phase)) ? Number(options.phase) : 1;
  // `plain` drops the backdrop and the element motifs, leaving the figure on
  // transparency. It exists for the silhouette measurements in
  // `tools/art-sheet.js` — a soft aura disc behind a figure makes "how much of
  // the canvas is this character" meaningless — and it doubles as the right
  // mode for anywhere the art sits on a coloured panel.
  const plain = options.plain === true || options.plain === '1' || options.plain === 'true';
  return { view, expression, phase, plain };
}

/**
 * Render one piece of art.
 *
 * Throws on an unknown kind or id rather than returning a placeholder: a
 * missing portrait is a bug in the data, and the art test exists precisely to
 * catch it before it becomes an empty box in the UI.
 */
function renderArt(kind, id, options = {}) {
  const entry = KINDS[kind];
  if (!entry) throw new Error(`Unknown art kind: ${kind}`);

  const opts = normaliseOptions(options);
  // Every option that changes the output must be in the key. `plain` was
  // missing here at first, which meant the first non-plain render poisoned the
  // cache and every later silhouette measurement silently got the backdrop —
  // a wrong answer that looked exactly like a right one.
  const key = `${kind}:${id}:${opts.view}:${opts.expression}:${opts.phase}:${opts.plain ? 'p' : 'f'}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const spec = entry.spec(id);
  const result = entry.render(spec, opts);
  const payload = { svg: result.svg, spec, view: opts.view, expression: opts.expression };

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, payload);
  return payload;
}

/** Everything that has art, for the client's preloader and for the art test. */
function artManifest() {
  const out = [];
  for (const [kind, entry] of Object.entries(KINDS)) {
    for (const id of entry.ids()) {
      const spec = entry.spec(id);
      const scale = Number.isFinite(spec.scale) ? spec.scale : 1;
      out.push({
        kind,
        id,
        name: spec.name,
        en: spec.en || '',
        title: spec.title || '',
        element: spec.element || 'physical',
        role: spec.role || '',
        lore: spec.lore || '',
        accent: spec.accent || '',
        scale,
        // Where the bust crop starts vertically. The cast has different
        // heights, so this is not a constant; tools and tests that sample the
        // bust need it rather than a hard-coded number.
        bustY0: kind === 'enemy' ? (spec.bust || [70, 60, 260, 260])[1] : bustView(scale)[1],
        url: `/art/${kind}/${id}.svg`,
      });
    }
  }
  return out;
}

/** Drop the memo cache. Used by tests that mutate specs. */
function clearArtCache() {
  cache.clear();
}

module.exports = { renderArt, artManifest, clearArtCache, KINDS, VIEWS, EXPRESSIONS };
