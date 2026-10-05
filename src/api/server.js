'use strict';

/**
 * HTTP API.
 *
 * Deliberately tiny and dependency-free, for two reasons: the project's promise
 * is "double-click and play", and the API surface is small enough that a
 * framework would be more configuration than code.
 *
 * Shape: one long-lived session per browser tab, addressed by `?session=<id>`.
 * A session owns a `Game`. Every response is JSON; battle events stream as
 * newline-delimited JSON on a separate endpoint so the UI can animate a turn as
 * it happens rather than waiting for the whole thing.
 *
 * Why a server at all, rather than a purely client-side game? Because the battle
 * engine is Node code with a test suite, and running it in the browser would
 * mean either duplicating it or shipping a bundler. Keeping the authority on the
 * server also means the client cannot desync: it renders what it is told.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { Game, MODE } = require('../world/game');
const skills = require('../core/skills');
const { STATUSES } = require('../core/status');
const { ELEMENTS, BALANCE, SKILL_TYPES } = require('../core/rules');
const { CHARACTERS, EQUIPMENT } = require('../core/characters');
const { ENEMIES } = require('../core/enemies');
const { ITEMS } = require('../core/items');
const { WORLD } = require('../core/world-data');
const { listCharacters, DEFAULT_LOADOUT } = require('../core/characters');
const enemies = require('../core/enemies');
const art = require('../art');

/** Sessions, keyed by id. In-memory: closing the server ends the save. */
const sessions = new Map();

/** How many sessions to keep before evicting the oldest. */
const MAX_SESSIONS = 32;

function createSession(options = {}) {
  const game = new Game(options);
  sessions.set(game.id, game);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== game.id) sessions.delete(oldest);
  }
  return game;
}

function getSession(id) {
  return sessions.get(id) || null;
}

// ===========================================================================
// Static file serving
// ===========================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Serve a file from `public/`, refusing anything that escapes it.
 *
 * The path check is not decoration: `path.join(PUBLIC_DIR, '../../etc/passwd')`
 * resolves outside the directory, and on Windows so does a backslash-laden
 * traversal. Normalising and then asserting the prefix is the only reliable
 * check, and it must run *after* resolution, not on the raw request string.
 */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  // Reject NUL bytes outright; they truncate paths in some syscalls.
  if (rel.includes('\0')) {
    return send(res, 400, { error: 'bad path' });
  }
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, { error: 'not found', path: rel });
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // No caching: this is a dev/demo server and stale JS is the number one
      // source of "my fix didn't work".
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ===========================================================================
// Generated art
// ===========================================================================

/**
 * Art is generated, never stored.
 *
 * `src/art/` is a pure function from a spec to an SVG string, so there is no
 * build step, no asset directory to keep in sync, and no way for a portrait to
 * go missing after a rename. The cost is CPU on first request, which is why the
 * result is memoised and the gzip is cached alongside it.
 *
 * `no-cache` rather than `no-store`: the browser is told to revalidate, so an
 * edited spec shows up on the next refresh, but an unchanged portrait costs a
 * 304 instead of a 45 KB download. `no-store` would make the battle HUD
 * re-download every unit's portrait on every re-render.
 */
const encoded = new Map();
const MAX_ENCODED = 128;

function serveArt(req, res, pathname, search) {
  const match = /^\/art\/([a-z]+)\/([A-Za-z0-9_]+)\.svg$/.exec(pathname);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }

  const [, kind, id] = match;
  let payload;
  try {
    payload = art.renderArt(kind, id, {
      view: search.get('view'),
      expression: search.get('expression'),
      phase: search.get('phase'),
    });
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`no such art: ${kind}/${id}`);
  }

  const key = `${kind}/${id}?${search.toString()}`;
  let entry = encoded.get(key);
  if (!entry) {
    const raw = Buffer.from(payload.svg, 'utf8');
    entry = {
      etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`,
      raw,
      gzip: zlib.gzipSync(raw, { level: 9 }),
    };
    if (encoded.size >= MAX_ENCODED) encoded.delete(encoded.keys().next().value);
    encoded.set(key, entry);
  }

  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  const useGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = useGzip ? entry.gzip : entry.raw;
  const headers = {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': body.length,
    ETag: entry.etag,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (useGzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  return res.end(body);
}

// ===========================================================================
// Response helpers
// ===========================================================================

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ===========================================================================
// Routes
// ===========================================================================

/**
 * The route table. Each entry is `[method, pattern, handler]` where `pattern`
 * may contain `:params`. Handlers receive `(ctx)` with the parsed body, query,
 * session and params, and return a plain object (or `{ __status, ... }`).
 */
const routes = [];

function route(method, pattern, handler) {
  const parts = pattern.split('/').filter(Boolean);
  routes.push({ method, parts, handler, pattern });
}

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
      else if (p !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

/** Every session-scoped route needs a live session; resolve once, here. */
function requireSession(ctx) {
  const id = ctx.query.session || (ctx.body && ctx.body.session);
  const game = id ? getSession(id) : null;
  if (!game) {
    const err = new Error('session not found');
    err.status = 404;
    err.code = 'noSession';
    throw err;
  }
  ctx.game = game;
  return game;
}

// --- Meta ------------------------------------------------------------------

route('GET', '/api/health', () => ({
  ok: true,
  sessions: sessions.size,
  uptime: Math.round(process.uptime()),
}));

/**
 * Static game data. The UI fetches this once and renders the codex, the party
 * screen's tooltips and the enemy weakness hints from it, so nothing is
 * duplicated between the engine and the presentation layer.
 */
route('GET', '/api/data', () => ({
  elements: ELEMENTS,
  balance: {
    maxSkillPoints: BALANCE.MAX_SKILL_POINTS,
    startSkillPoints: BALANCE.START_SKILL_POINTS,
    actionValue: BALANCE.ACTION_VALUE,
    maxLevel: BALANCE.MAX_LEVEL,
  },
  characters: listCharacters().map((c) => ({
    id: c.id,
    name: c.name,
    en: c.en,
    title: c.title,
    element: c.element,
    role: c.role,
    rarity: c.rarity,
    color: c.color,
    sprite: c.sprite,
    lore: c.lore,
    baseStats: c.baseStats,
    skills: c.skills,
    defaultLoadout: DEFAULT_LOADOUT[c.id] || {},
  })),
  skills: Object.values(skills.SKILLS).map((s) => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    kind: s.kind,
    element: s.element,
    target: s.target,
    multiplier: s.multiplier,
    toughness: s.toughness,
    cost: s.skillPointCost,
    desc: s.desc,
  })),
  statuses: Object.values(STATUSES).map((s) => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    kind: s.kind,
    desc: s.desc,
    element: s.element || null,
    maxStacks: s.maxStacks,
  })),
  items: Object.values(ITEMS),
  equipment: Object.values(EQUIPMENT),
  enemies: Object.values(ENEMIES).map((e) => ({
    id: e.id,
    name: e.name,
    title: e.title,
    level: e.level,
    weaknesses: e.weaknesses,
    resist: e.resist,
    toughness: e.toughness,
    sprite: e.sprite,
    color: e.color,
    scale: e.scale,
    intro: e.intro || null,
  })),
  world: {
    name: WORLD.name,
    subtitle: WORLD.subtitle,
    partySize: WORLD.partySize,
    roster: WORLD.roster,
    nodes: Object.values(WORLD.nodes).map((n) => ({
      id: n.id, name: n.name, type: n.type, bg: n.bg, desc: n.desc,
      connections: n.connections,
    })),
    shop: WORLD.shop,
    inn: WORLD.inn,
  },
  skillTypes: SKILL_TYPES,
}));

// --- Session ---------------------------------------------------------------

route('POST', '/api/session', (ctx) => {
  const game = createSession({
    seed: ctx.body.seed,
    party: ctx.body.party,
    level: ctx.body.level,
    gold: ctx.body.gold,
  });
  return { ok: true, view: game.view() };
});

route('GET', '/api/state', (ctx) => {
  const game = requireSession(ctx);
  return { ok: true, view: game.view() };
});

// --- Movement --------------------------------------------------------------

route('POST', '/api/travel', (ctx) => {
  const game = requireSession(ctx);
  const result = game.travel(ctx.body.to);
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/enter', (ctx) => {
  const game = requireSession(ctx);
  const result = game.enter();
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/story/continue', (ctx) => {
  const game = requireSession(ctx);
  const result = game.continueStory();
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

// --- Party -----------------------------------------------------------------

route('POST', '/api/party', (ctx) => {
  const game = requireSession(ctx);
  const result = game.setParty(ctx.body.party || []);
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/party/equip', (ctx) => {
  const game = requireSession(ctx);
  const result = game.equipOn(ctx.body.charId, ctx.body.item);
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/party/rest', (ctx) => {
  const game = requireSession(ctx);
  const result = game.rest();
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/shop/buy', (ctx) => {
  const game = requireSession(ctx);
  const result = game.buy(ctx.body.item);
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

// --- Battle ----------------------------------------------------------------

route('POST', '/api/battle/step', (ctx) => {
  const game = requireSession(ctx);
  const result = game.step();
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/battle/command', (ctx) => {
  const game = requireSession(ctx);
  const result = game.command({
    type: ctx.body.type,
    skill: ctx.body.skill,
    target: ctx.body.target,
    unit: ctx.body.unit,
    item: ctx.body.item,
  });
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/battle/ultimate', (ctx) => {
  const game = requireSession(ctx);
  const result = game.fireUltimate(ctx.body.unit, ctx.body.skill, ctx.body.target);
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

route('POST', '/api/battle/acknowledge', (ctx) => {
  const game = requireSession(ctx);
  const result = game.acknowledge();
  return { ok: true, result, view: game.view() };
});

/** Debug/practice: start an arbitrary encounter. Handy while building content. */
route('POST', '/api/battle/practice', (ctx) => {
  const game = requireSession(ctx);
  const specs = (ctx.body.enemies || ['rotgrub']).map((e) => (typeof e === 'string' ? { id: e } : e));
  for (const spec of specs) {
    if (!enemies.ENEMIES[spec.id]) return { __status: 400, ok: false, reason: 'unknownEnemy', id: spec.id };
  }
  const result = game.startCustomBattle(specs, ctx.body.name);
  if (!result.ok) return { __status: 400, ...result };
  return { ok: true, result, view: game.view() };
});

// --- Codex -----------------------------------------------------------------

route('GET', '/api/codex/skill/:id', (ctx) => {
  const skill = skills.SKILLS[ctx.params.id];
  if (!skill) return { __status: 404, ok: false, reason: 'notFound' };
  return { ok: true, skill };
});

// --- Art -------------------------------------------------------------------

/**
 * Everything that has art.
 *
 * The client uses this to preload portraits before a battle starts, which is
 * the difference between a battle screen that appears complete and one that
 * pops its faces in one at a time.
 */
route('GET', '/api/art', () => ({
  ok: true,
  views: art.VIEWS,
  expressions: art.EXPRESSIONS,
  entries: art.artManifest(),
}));

// ===========================================================================
// Server
// ===========================================================================

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // API
  if (pathname.startsWith('/api/')) {
    const matched = matchRoute(req.method, pathname);
    if (!matched) {
      return send(res, 404, { ok: false, error: 'no such endpoint', path: pathname });
    }
    const ctx = {
      req,
      res,
      params: matched.params,
      query: Object.fromEntries(url.searchParams),
      body: {},
    };
    const run = async () => {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        try {
          ctx.body = await readBody(req);
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
      }
      let payload;
      try {
        payload = await matched.route.handler(ctx);
      } catch (err) {
        const status = err.status || 500;
        // A 500 from this server is always a bug in the engine or a bad request
        // shape; surface the message so the browser console is actionable
        // instead of showing "Internal Server Error".
        return send(res, status, { ok: false, error: err.message, code: err.code || 'internalError' });
      }
      const status = payload && payload.__status ? payload.__status : 200;
      if (payload && payload.__status) delete payload.__status;
      return send(res, status, payload);
    };
    run();
    return;
  }

  // Generated art. Checked before static so `/art/...` can never be shadowed
  // by a file that happens to land in `public/art/`.
  if (pathname.startsWith('/art/')) {
    return serveArt(req, res, pathname, url.searchParams);
  }

  // Static
  serveStatic(req, res, pathname);
}
function createServer() {
  return http.createServer(handle);
}

module.exports = { createServer, handle, createSession, getSession, sessions, routes };
