// End-to-end tests: a real Postgres (TEST_DATABASE_URL) and a fake Meta Graph API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import pg from 'pg';
import { createApp } from '../src/server.js';
import { normalizeUserData, sha256 } from '../src/normalize.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:55432/capi_test';
const ORIGIN = 'https://shop.example.com';

let meta; let metaUrl; let metaCalls = []; let metaReply = () => ({ status: 200, json: { events_received: 1, fbtrace_id: 'trace1' } });
let app; let base; let admin;

async function resetDb() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS capi_events, capi_counters, capi_state');
  await c.end();
}

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

const q = (sql, params) => app.db.pool.query(sql, params).then((r) => r.rows);

before(async () => {
  meta = http.createServer((r, s) => {
    let data = '';
    r.on('data', (c) => { data += c; });
    r.on('end', () => {
      const body = JSON.parse(data || '{}');
      metaCalls.push({ url: r.url, body });
      const { status, json } = metaReply(body);
      s.writeHead(status, { 'content-type': 'application/json' });
      s.end(JSON.stringify(json));
    });
  });
  await new Promise((ok) => meta.listen(0, '127.0.0.1', ok));
  metaUrl = `http://127.0.0.1:${meta.address().port}`;

  await resetDb();
  app = await createApp({
    env: {
      DATABASE_URL,
      META_PIXEL_ID: '123456789012',
      META_ACCESS_TOKEN: 'secret-token',
      META_GRAPH_BASE_URL: metaUrl,
      META_TEST_EVENT_CODE: 'TEST123',
      ALLOWED_ORIGINS: `${ORIGIN}/, https://other.example.com`,
      API_KEY: 'server-key',
      ADMIN_PASSWORD: 'pw',
      DEFAULT_PHONE_COUNTRY_CODE: '1',
      WORKER_INTERVAL_MS: '60000',
    },
    log: { info() {}, error() {} },
  });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
  admin = { authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };
});

after(async () => {
  await app.close();
  await new Promise((ok) => meta.close(ok));
});

beforeEach(async () => {
  metaCalls = [];
  metaReply = (body) => ({ status: 200, json: { events_received: body.data?.length ?? 0, fbtrace_id: 'trace1' } });
  await q('TRUNCATE capi_events, capi_counters, capi_state');
});

const browserHeaders = (extra = {}) => ({ origin: ORIGIN, 'content-type': 'text/plain', 'user-agent': 'TestAgent/1.0', 'x-real-ip': '198.51.100.7', ...extra });
const browserEvent = (extra = {}) => ({
  event_name: 'Purchase', event_id: `ev-${Math.random()}`, consent: true,
  event_source_url: `${ORIGIN}/checkout/thanks`, custom_data: { value: '49.90', currency: 'eur' }, ...extra,
});

test('normalization matches the examples in Meta documentation', () => {
  const u = normalizeUserData({
    em: ' John_Smith@gmail.com ', ph: '(650)555-1212', fn: 'Valéry', country: 'US', db: '1997-02-16', zp: '94035-1234',
  }, { defaultPhoneCountryCode: '1' });
  assert.deepEqual(u.em, ['62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f']);
  assert.deepEqual(u.ph, ['e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176']);
  assert.deepEqual(u.fn, ['08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c']);
  assert.deepEqual(u.country, ['79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621']);
  assert.deepEqual(u.db, ['01acdbf6ec7b4f478a225f1a246e5d6767eeab1a7ffa17f025265b5b94f40f0c']);
  assert.deepEqual(u.zp, [sha256('94035')]);
});

test('French phone numbers get the country code; pre-hashed values pass through', () => {
  const fr = { defaultPhoneCountryCode: '33' };
  const want = sha256('33612345678');
  assert.deepEqual(normalizeUserData({ ph: '06 12 34 56 78' }, fr).ph, [want]);
  assert.deepEqual(normalizeUserData({ ph: '+33 6 12 34 56 78' }, fr).ph, [want]);
  assert.deepEqual(normalizeUserData({ ph: '0033612345678' }, fr).ph, [want]);
  const hashed = sha256('a@b.co');
  assert.deepEqual(normalizeUserData({ em: hashed.toUpperCase() }).em, [hashed]);
  assert.equal(normalizeUserData({ em: 'not-an-email' }).em, undefined);
});

test('health check and root page respond', async () => {
  assert.equal((await req('/healthz')).status, 200);
  assert.match((await req('/')).text, /CAPI Relay is running/);
});

test('browser endpoint refuses unknown origins and answers preflight for allowed ones', async () => {
  assert.equal((await req('/e', { method: 'POST', body: browserEvent(), headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await req('/e', { method: 'POST', body: browserEvent(), headers: browserHeaders({ origin: 'https://evil.example' }) })).status, 403);
  const pre = await req('/e', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
});

test('without consent nothing is stored or sent', async () => {
  const r = await req('/e', { method: 'POST', body: browserEvent({ consent: false, user_data: { em: 'jane@example.com' } }), headers: browserHeaders() });
  assert.equal(r.status, 202);
  assert.equal(r.json.reason, 'no_consent');
  assert.equal((await q('SELECT count(*)::int AS n FROM capi_events'))[0].n, 0);
  await app.worker.tick();
  assert.equal(metaCalls.length, 0);
  const stats = await app.db.stats();
  assert.equal(stats.count.skipped_no_consent, 1);
});

test('consented browser event reaches Meta with hashed data and request identifiers', async () => {
  const r = await req('/e', {
    method: 'POST',
    body: browserEvent({ event_id: 'order-1', user_data: { em: 'Jane@Example.com', client_ip_address: '6.6.6.6' } }),
    headers: browserHeaders({ cookie: '_fbp=fb.1.1596403881668.1116446470; other=x' }),
  });
  assert.equal(r.status, 202);
  assert.equal(r.json.accepted, true);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);

  await app.worker.tick();
  assert.equal(metaCalls.length, 1);
  const call = metaCalls[0];
  assert.match(call.url, /^\/v26\.0\/123456789012\/events\?access_token=secret-token$/);
  assert.equal(call.body.test_event_code, 'TEST123');
  const ev = call.body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, 'order-1');
  assert.equal(ev.action_source, 'website');
  assert.equal(ev.event_source_url, `${ORIGIN}/checkout/thanks`);
  assert.deepEqual(ev.user_data.em, [sha256('jane@example.com')]);
  assert.equal(ev.user_data.client_ip_address, '198.51.100.7', 'IP comes from the request, not the payload');
  assert.equal(ev.user_data.client_user_agent, 'TestAgent/1.0');
  assert.equal(ev.user_data.fbp, 'fb.1.1596403881668.1116446470');
  assert.deepEqual(ev.custom_data, { value: 49.9, currency: 'EUR' });

  const rows = await q('SELECT status, fbtrace_id, payload FROM capi_events');
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].fbtrace_id, 'trace1');
  assert.ok(!JSON.stringify(rows[0].payload).includes('jane@example.com'), 'raw email is never stored');
});

test('the same event_id is accepted once', async () => {
  const ev = browserEvent({ event_id: 'dup-1' });
  await req('/e', { method: 'POST', body: ev, headers: browserHeaders() });
  const second = await req('/e', { method: 'POST', body: ev, headers: browserHeaders() });
  assert.equal(second.json.duplicate, true);
  await app.worker.tick();
  assert.equal(metaCalls.length, 1);
  assert.equal(metaCalls[0].body.data.length, 1);
});

test('server API needs the key, honours consent and reports bad events', async () => {
  assert.equal((await req('/v1/events', { method: 'POST', body: { events: [] }, headers: { 'content-type': 'application/json' } })).status, 401);
  const hashedEmail = sha256('vip@example.com');
  const now = Math.floor(Date.now() / 1000);
  const r = await req('/v1/events', {
    method: 'POST',
    headers: { authorization: 'Bearer server-key', 'content-type': 'application/json' },
    body: {
      events: [
        { event_name: 'Purchase', event_id: 's-1', consent: true, event_source_url: `${ORIGIN}/c`, user_data: { em: hashedEmail, client_ip_address: '203.0.113.9', client_user_agent: 'UA' } },
        { event_name: 'Purchase', event_id: 's-2', consent: false, event_source_url: `${ORIGIN}/c`, user_data: { em: 'x@y.co' } },
        { event_name: 'Lead', event_id: 's-3', consent: true, event_time: now - 8 * 86400, event_source_url: `${ORIGIN}/c`, user_data: { em: 'x@y.co' } },
        { event_name: 'Lead', event_id: 's-4', consent: true, action_source: 'system_generated', user_data: { external_id: 'crm-42' } },
      ],
    },
  });
  assert.equal(r.status, 202);
  assert.equal(r.json.accepted, 2);
  assert.equal(r.json.skipped_no_consent, 1);
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0].index, 2);
  assert.match(r.json.errors[0].error, /older than 7 days/);

  await app.worker.tick();
  const sent = metaCalls.flatMap((c) => c.body.data);
  assert.equal(sent.length, 2);
  const s1 = sent.find((e) => e.event_id === 's-1');
  assert.deepEqual(s1.user_data.em, [hashedEmail]);
  assert.equal(s1.user_data.client_ip_address, '203.0.113.9');
  const s4 = sent.find((e) => e.event_id === 's-4');
  assert.equal(s4.action_source, 'system_generated');
  assert.deepEqual(s4.user_data.external_id, [sha256('crm-42')]);
});

test('transient Meta errors are retried later', async () => {
  metaReply = () => ({ status: 500, json: { error: { message: 'Service temporarily unavailable', code: 2, is_transient: true } } });
  await req('/e', { method: 'POST', body: browserEvent(), headers: browserHeaders() });
  await app.worker.tick();
  let [row] = await q('SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM capi_events');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.later, true);
  assert.match(row.last_error, /temporarily unavailable/);

  metaReply = (body) => ({ status: 200, json: { events_received: body.data.length } });
  await q("UPDATE capi_events SET next_attempt_at = now() - interval '1 second'");
  await app.worker.tick();
  [row] = await q('SELECT status, attempts FROM capi_events');
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 2);
});

test('one invalid event does not block the rest of its batch', async () => {
  metaReply = (body) => (body.data.some((e) => e.event_name === 'BadEvent')
    ? { status: 400, json: { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'The value is not valid' } } }
    : { status: 200, json: { events_received: body.data.length } });
  for (const name of ['Purchase', 'BadEvent', 'Lead', 'AddToCart', 'ViewContent']) {
    await req('/e', { method: 'POST', body: browserEvent({ event_name: name }), headers: browserHeaders() });
  }
  await app.worker.tick();
  const rows = await q('SELECT event_name, status, last_error FROM capi_events ORDER BY id');
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'failed', 'sent', 'sent', 'sent']);
  assert.match(rows[1].last_error, /not valid/);
});

test('a configuration error keeps events queued and shows on the dashboard', async () => {
  metaReply = () => ({ status: 400, json: { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } } });
  await req('/e', { method: 'POST', body: browserEvent(), headers: browserHeaders() });
  await app.worker.tick();
  const [row] = await q('SELECT status FROM capi_events');
  assert.equal(row.status, 'pending');
  const page = await req('/admin', { headers: admin });
  assert.match(page.text, /Meta refused the last delivery/);
  assert.match(page.text, /Invalid OAuth access token/);

  metaReply = (body) => ({ status: 200, json: { events_received: body.data.length } });
  await q("UPDATE capi_events SET next_attempt_at = now() - interval '1 second'");
  await app.worker.tick();
  const page2 = await req('/admin', { headers: admin });
  assert.doesNotMatch(page2.text, /Meta refused the last delivery/);
});

test('events that became too old are expired instead of sent', async () => {
  const old = Math.floor(Date.now() / 1000) - 7 * 86400 + 100;
  await req('/e', { method: 'POST', body: browserEvent({ event_time: old }), headers: browserHeaders() });
  await q('UPDATE capi_events SET event_time = event_time - 600');
  await app.worker.tick();
  const [row] = await q('SELECT status FROM capi_events');
  assert.equal(row.status, 'expired');
  assert.equal(metaCalls.length, 0);
});

test('rows older than the retention window are deleted', async () => {
  await req('/e', { method: 'POST', body: browserEvent(), headers: browserHeaders() });
  await app.worker.tick();
  await q("UPDATE capi_events SET created_at = now() - interval '30 days'");
  assert.equal(await app.db.purge(7), 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM capi_events'))[0].n, 0);
});

test('dashboard is protected, shows counts and never shows personal data', async () => {
  assert.equal((await req('/admin')).status, 401);
  assert.equal((await req('/admin', { headers: { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` } })).status, 401);
  await req('/e', { method: 'POST', body: browserEvent({ user_data: { em: 'secret.person@example.com' } }), headers: browserHeaders() });
  await app.worker.tick();
  const page = await req('/admin', { headers: admin });
  assert.equal(page.status, 200);
  assert.match(page.text, /Delivered to Meta/);
  assert.match(page.text, /Test mode is on/);
  assert.match(page.text, new RegExp(`${base.replace(/[.:/]/g, '\\$&')}/capi\\.js`));
  assert.ok(!page.text.includes('secret.person@example.com'));
  assert.ok(!page.text.includes('123456789012'), 'pixel id is masked');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('dashboard test button sends a PageView with the test code', async () => {
  const page = await req('/admin', { headers: admin });
  const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const bad = await req('/admin/test', { method: 'POST', headers: { ...admin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=wrong' });
  assert.equal(bad.status, 403);
  const ok = await req('/admin/test', { method: 'POST', headers: { ...admin, 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Meta received the test event/);
  assert.equal(metaCalls.length, 1);
  assert.equal(metaCalls[0].body.data[0].event_name, 'PageView');
  assert.equal(metaCalls[0].body.test_event_code, 'TEST123');
});

test('browser helper sends nothing before consent and shares the event ID with the Pixel', async () => {
  const js = await req('/capi.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const beacons = []; const fbqCalls = [];
  const window = {
    location: { href: `${ORIGIN}/product?fbclid=IwAR123`, search: '?fbclid=IwAR123' },
    navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
    crypto: { randomUUID: () => 'uuid-1' },
    fbq: (...args) => fbqCalls.push(args),
    capi: undefined,
  };
  window.capi = function stub() { (window.capi.q = window.capi.q || []).push(arguments); };
  window.capi('track', 'ViewContent', { content_ids: ['sku-1'] }); // queued before load, no consent
  const document = { cookie: '_fbp=fb.1.111.222' };
  vm.runInNewContext(js.text, { window, document, Blob: class { constructor(parts) { this.text = parts.join(''); } } });

  assert.equal(beacons.length, 0, 'nothing sent without consent');
  assert.equal(fbqCalls.length, 0);

  window.capi('consent', true);
  const id = window.capi('track', 'Purchase', { value: 10, currency: 'EUR' }, { userData: { em: 'a@b.co' } });
  assert.equal(id, 'uuid-1');
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, `${base}/e`);
  const payload = JSON.parse(beacons[0].blob.text);
  assert.equal(payload.event_id, 'uuid-1');
  assert.equal(payload.consent, true);
  assert.equal(payload.fbp, 'fb.1.111.222');
  assert.match(payload.fbc, /^fb\.1\.\d+\.IwAR123$/);
  // Objects created inside the vm context have another realm's prototypes, so compare as JSON.
  assert.equal(JSON.stringify(fbqCalls[0]), JSON.stringify(['track', 'Purchase', { value: 10, currency: 'EUR' }, { eventID: 'uuid-1' }]));

  window.capi('consent', false);
  window.capi('track', 'Lead');
  assert.equal(beacons.length, 1, 'withdrawing consent stops sending');
});
