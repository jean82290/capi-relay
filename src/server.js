// CAPI Relay — consent-first server-side Conversions API relay.

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { buildEvent, EventError } from './events.js';
import { createWorker } from './worker.js';
import { renderAdmin } from './admin.js';
import { snippetSource } from './snippet.js';
import { sendToMeta } from './meta.js';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BROWSER_BODY_BYTES = 16 * 1024;
const MAX_SERVER_EVENTS = 500;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === '_fbp' || k === '_fbc') {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

// Railway's edge overwrites X-Real-IP with the caller's address.
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') || undefined;
}

function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && body !== null;
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body ?? '');
}

// Token bucket per client IP for the public browser endpoint.
function createRateLimiter({ perMinute = 120, burst = 240 } = {}) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
  }, 60 * 1000).unref();
  return (key) => {
    const now = Date.now();
    const b = buckets.get(key) || { tokens: burst, ts: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 60000) * perMinute);
    b.ts = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}

export async function createApp({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const config = loadConfig(env);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const db = createDb(config.databaseUrl);
  await db.migrate();
  const worker = createWorker({ db, config, fetchImpl, log });
  const allowRequest = createRateLimiter();
  const csrfToken = createHmac('sha256', config.adminPassword || 'locked').update('capi-relay-csrf').digest('hex');

  function corsHeaders(origin) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'Origin',
    };
  }

  function originAllowed(origin) {
    return Boolean(origin) && config.allowedOrigins.includes(String(origin).toLowerCase());
  }

  function adminAuthorized(req) {
    if (!config.adminPassword) return false;
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Basic ')) return false;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return safeEqual(password, config.adminPassword);
  }

  async function handleBrowserEvent(req, res) {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return send(res, 403, { error: 'origin not allowed; add it to ALLOWED_ORIGINS' });
    const cors = corsHeaders(origin);
    if (!allowRequest(clientIp(req) || 'unknown')) return send(res, 429, { error: 'rate limited' }, cors);

    let input;
    try {
      input = JSON.parse(await readBody(req, MAX_BROWSER_BODY_BYTES));
    } catch (err) {
      return send(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON' }, cors);
    }

    if (config.requireConsent && input?.consent !== true) {
      await db.bump('skipped_no_consent');
      return send(res, 202, { accepted: false, reason: 'no_consent' }, cors);
    }

    let built;
    try {
      built = buildEvent(input, {
        source: 'browser',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
        cookies: parseCookies(req.headers.cookie),
        config,
      });
    } catch (err) {
      if (err instanceof EventError) return send(res, 400, { error: err.message }, cors);
      throw err;
    }

    const { duplicates } = await db.insertEvents([{ source: 'browser', event: built.event }]);
    await db.bump('received');
    if (duplicates) await db.bump('duplicate', duplicates);
    worker.nudge();
    return send(res, 202, { accepted: true, event_id: built.event.event_id, duplicate: duplicates > 0 }, cors);
  }

  async function handleServerEvents(req, res) {
    const auth = String(req.headers.authorization || '');
    if (!config.apiKey || !auth.startsWith('Bearer ') || !safeEqual(auth.slice(7).trim(), config.apiKey)) {
      return send(res, 401, { error: 'missing or invalid API key (Authorization: Bearer <API_KEY>)' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    } catch (err) {
      return send(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON' });
    }
    const list = Array.isArray(body?.events) ? body.events : body && typeof body === 'object' ? [body] : [];
    if (list.length === 0) return send(res, 400, { error: 'send {"events": [...]} or a single event object' });
    if (list.length > MAX_SERVER_EVENTS) return send(res, 413, { error: `at most ${MAX_SERVER_EVENTS} events per request` });

    const rows = [];
    const errors = [];
    let skipped = 0;
    list.forEach((input, index) => {
      if (config.requireConsent && input?.consent !== true) {
        skipped += 1;
        return;
      }
      try {
        const { event } = buildEvent(input, { source: 'server', config });
        rows.push({ source: 'server', event });
      } catch (err) {
        if (!(err instanceof EventError)) throw err;
        errors.push({ index, error: err.message });
      }
    });

    const { inserted, duplicates } = await db.insertEvents(rows);
    await db.bump('received', inserted);
    await db.bump('duplicate', duplicates);
    await db.bump('skipped_no_consent', skipped);
    if (inserted) worker.nudge();
    const status = errors.length && !inserted && !duplicates && !skipped ? 400 : 202;
    return send(res, status, { accepted: inserted, duplicates, skipped_no_consent: skipped, errors });
  }

  async function handleAdmin(req, res, url) {
    if (!adminAuthorized(req)) {
      return send(res, 401, config.adminPassword ? 'Authentication required' : 'Set ADMIN_PASSWORD to unlock the dashboard', {
        'www-authenticate': 'Basic realm="CAPI Relay", charset="UTF-8"',
      });
    }
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    };

    if (req.method === 'POST' && url.pathname === '/admin/test') {
      const form = new URLSearchParams(await readBody(req, 4096));
      if (!safeEqual(form.get('csrf') || '', csrfToken)) return send(res, 403, 'Invalid form token');
      let flash;
      if (!config.testEventCode || !config.metaReady) {
        flash = { tone: 'warn', text: 'Set META_PIXEL_ID, META_ACCESS_TOKEN and META_TEST_EVENT_CODE first.' };
      } else {
        const event = {
          event_name: 'PageView',
          event_time: Math.floor(Date.now() / 1000),
          event_id: `capi-relay-test-${Date.now()}`,
          action_source: 'website',
          event_source_url: config.allowedOrigins[0] || baseUrl(req),
          user_data: { client_ip_address: clientIp(req), client_user_agent: String(req.headers['user-agent'] || 'capi-relay') },
        };
        const r = await sendToMeta(config, [event], { fetchImpl });
        flash = r.kind === 'ok'
          ? { tone: 'ok', text: `Meta received the test event. Check Events Manager → Test events (code ${config.testEventCode}).` }
          : { tone: 'bad', text: `Meta refused the test event: ${r.message}` };
      }
      const stats = await db.stats();
      const cfgErr = await db.getState('config_error');
      res.writeHead(200, headers);
      return res.end(renderAdmin({ config, stats, configError: cfgErr?.value, baseUrl: baseUrl(req), csrf: csrfToken, flash }));
    }

    if (url.pathname === '/admin/stats.json') {
      return send(res, 200, await db.stats(), { 'cache-control': 'no-store' });
    }

    const stats = await db.stats();
    const cfgErr = await db.getState('config_error');
    res.writeHead(200, headers);
    return res.end(renderAdmin({ config, stats, configError: cfgErr?.value, baseUrl: baseUrl(req), csrf: csrfToken }));
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;

    if (path === '/healthz') {
      try {
        await db.ping();
        return send(res, 200, { ok: true });
      } catch {
        return send(res, 503, { ok: false, error: 'database unreachable' });
      }
    }

    if (path === '/e') {
      if (req.method === 'OPTIONS') {
        const origin = req.headers.origin;
        if (!originAllowed(origin)) return send(res, 403, '');
        res.writeHead(204, corsHeaders(origin));
        return res.end();
      }
      if (req.method === 'POST') return handleBrowserEvent(req, res);
      return send(res, 405, { error: 'method not allowed' });
    }

    if (path === '/capi.js' && req.method === 'GET') {
      return send(res, 200, snippetSource(`${baseUrl(req)}/e`), {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
      });
    }

    if (path === '/v1/events') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      return handleServerEvents(req, res);
    }

    if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(req, res, url);

    if (path === '/' && req.method === 'GET') {
      return send(res, 200, 'CAPI Relay is running. Dashboard: /admin\n');
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error?.('[http] error:', err.message);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;

  return {
    config,
    db,
    worker,
    server,
    async listen(port = config.port) {
      await new Promise((resolve) => server.listen(port, resolve));
      worker.start();
      return server.address().port;
    },
    async close() {
      await worker.stop();
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

async function main() {
  const app = await createApp();
  const port = await app.listen();
  console.log(`[capi-relay] listening on :${port}`);
  for (const p of app.config.problems) console.warn(`[capi-relay] setup: ${p}`);
  if (app.config.testEventCode) console.warn('[capi-relay] test mode: META_TEST_EVENT_CODE is set');
  const shutdown = async (signal) => {
    console.log(`[capi-relay] ${signal} received, draining…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('[capi-relay] failed to start:', err.message);
    process.exit(1);
  });
}
