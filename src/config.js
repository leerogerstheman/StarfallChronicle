'use strict';

/**
 * Runtime configuration, read once at boot.
 *
 * Kept separate from `server.js` so that tests and tooling can import the same
 * values without triggering a listen.
 */

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

const config = {
  version: '0.1.0',
  /** Bind address. 127.0.0.1 by default; there is no authentication. */
  host: process.env.HOST || '127.0.0.1',
  port: intFromEnv('PORT', 8787),
};

module.exports = config;
