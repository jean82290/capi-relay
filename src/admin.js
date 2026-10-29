// Server-rendered admin dashboard. It never displays personal data:
// only counts, event names and Meta's error messages.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function maskPixel(id) {
  if (!id) return '—';
  return id.length > 6 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}

function ago(date) {
  if (!date) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function renderAdmin({ config, stats, configError, baseUrl, csrf, flash }) {
  const st = stats.status;
  const sent = st.sent || 0;
  const pending = (st.pending || 0) + (st.sending || 0);
  const failed = st.failed || 0;
  const expired = st.expired || 0;
  const received = sent + pending + failed + expired;
  const skipped = stats.count.skipped_no_consent || 0;
  const duplicates = stats.count.duplicate || 0;
  const settled = sent + failed + expired;
  const rate = settled ? Math.round((sent / settled) * 1000) / 10 : null;

  let health = { label: 'Healthy', tone: 'ok' };
  if (!config.metaReady || config.problems.length) health = { label: 'Setup needed', tone: 'warn' };
  if (configError) health = { label: 'Meta rejects the configuration', tone: 'bad' };

  const snippet = `<!-- Load after your Meta Pixel. Nothing is sent before consent. -->
<script>
  window.capi = window.capi || function () { (capi.q = capi.q || []).push(arguments) };
  // Call this from your cookie banner (CMP) when the visitor accepts marketing cookies:
  // capi('consent', true);
</script>
<script async src="${esc(baseUrl)}/capi.js"></script>`;

  const tile = (label, value, hint) => `
    <div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${hint ? `<div class="tile-hint">${hint}</div>` : ''}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>CAPI Relay</title>
<style>
  :root {
    --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1da;
    --accent: #2f5bea; --ok: #1f7a4d; --ok-bg: #e3f3ea; --warn: #8a5a00; --warn-bg: #fbf0d9;
    --bad: #a3261b; --bad-bg: #fbe4e1; --code: #f1efea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141413; --panel: #1d1d1b; --ink: #ecebe7; --muted: #a09d96; --line: #2f2e2b;
      --accent: #7b9cff; --ok: #6fd3a0; --ok-bg: #16301f; --warn: #f2c46b; --warn-bg: #33280f;
      --bad: #ff9a8f; --bad-bg: #3a1714; --code: #252522;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  h1 small { display: block; font-size: 13px; font-weight: 400; color: var(--muted); }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .pill { padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .pill.ok { background: var(--ok-bg); color: var(--ok); }
  .pill.warn { background: var(--warn-bg); color: var(--warn); }
  .pill.bad { background: var(--bad-bg); color: var(--bad); }
  .banner { border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
  .banner.warn { background: var(--warn-bg); color: var(--warn); }
  .banner.bad { background: var(--bad-bg); color: var(--bad); }
  .banner.ok { background: var(--ok-bg); color: var(--ok); }
  .banner ul { margin: 6px 0 0; padding-left: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .tile-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .tile-value { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .tile-hint { font-size: 12px; color: var(--muted); }
  section.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-word; }
  pre { background: var(--code); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.45; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  td.err { color: var(--bad); }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .muted { color: var(--muted); font-size: 13px; }
  footer { margin-top: 28px; color: var(--muted); font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>CAPI Relay<small>Server-side Conversions API for Facebook &amp; Instagram ads</small></h1>
    <span class="pill ${health.tone}">${health.label}</span>
  </header>

  ${flash ? `<div class="banner ${flash.tone}">${esc(flash.text)}</div>` : ''}
  ${configError ? `<div class="banner bad"><strong>Meta refused the last delivery.</strong> Events are kept and retried every 10 minutes until this is fixed.<br>${esc(configError)}</div>` : ''}
  ${config.problems.length ? `<div class="banner warn"><strong>Finish the setup</strong> (Railway → this service → Variables):<ul>${config.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
  ${config.testEventCode ? `<div class="banner warn"><strong>Test mode is on</strong> (META_TEST_EVENT_CODE is set). Events appear in Events Manager → Test events. Remove the variable when you go live.</div>` : ''}
  ${!config.requireConsent ? `<div class="banner warn"><strong>Consent check is off</strong> (REQUIRE_CONSENT=false). Only do this where the law does not require consent for ad tracking. In the EU/UK it does.</div>` : ''}

  <div class="grid">
    ${tile('Received · 24 h', received.toLocaleString('en-US'))}
    ${tile('Delivered to Meta', sent.toLocaleString('en-US'), rate === null ? 'no deliveries yet' : `${rate}% delivery rate`)}
    ${tile('Waiting', pending.toLocaleString('en-US'), 'queued or retrying')}
    ${tile('Failed', (failed + expired).toLocaleString('en-US'), expired ? `${expired} expired` : 'rejected by Meta')}
    ${tile('No consent', skipped.toLocaleString('en-US'), 'dropped, never stored')}
    ${tile('Duplicates', duplicates.toLocaleString('en-US'), 'same event_id ignored')}
  </div>

  <section class="card">
    <h2>Configuration</h2>
    <dl>
      <dt>Dataset (Pixel) ID</dt><dd>${esc(maskPixel(config.pixelId))}</dd>
      <dt>Access token</dt><dd>${config.accessToken ? 'set' : '<strong>missing</strong>'}</dd>
      <dt>Graph API version</dt><dd>${esc(config.apiVersion)}</dd>
      <dt>Allowed sites</dt><dd>${config.allowedOrigins.length ? config.allowedOrigins.map(esc).join(', ') : '<strong>none</strong>'}</dd>
      <dt>Consent required</dt><dd>${config.requireConsent ? 'yes' : 'no'}</dd>
      <dt>Data kept for</dt><dd>${config.retentionDays} days, then deleted</dd>
      <dt>Last delivery</dt><dd>${esc(ago(stats.lastSent))}</dd>
    </dl>
  </section>

  <section class="card">
    <div class="row"><h2>1 · Add to your website</h2><button class="ghost" type="button" data-copy="snippet">Copy</button></div>
    <pre id="snippet">${esc(snippet)}</pre>
    <p class="muted">Then replace your <code>fbq('track', …)</code> calls with <code>capi('track', 'Purchase', { value: 49.90, currency: 'EUR' })</code>. It sends the event to the Pixel and to this relay with the same event ID, so Meta counts it once.</p>
  </section>

  <section class="card">
    <h2>2 · Send events from your backend (optional)</h2>
    <pre>curl -X POST ${esc(baseUrl)}/v1/events \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"events":[{"event_name":"Purchase","event_id":"order-1042","consent":true,
       "event_source_url":"https://www.myshop.com/checkout",
       "user_data":{"em":"jane@example.com","client_ip_address":"203.0.113.7","client_user_agent":"Mozilla/5.0 …"},
       "custom_data":{"value":49.9,"currency":"EUR"}}]}'</pre>
  </section>

  <section class="card">
    <div class="row"><h2>Recent delivery problems</h2>
    ${config.testEventCode && config.metaReady ? `<form method="post" action="/admin/test"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Send a test event</button></form>` : '<span class="muted">Set META_TEST_EVENT_CODE to send a test event from here.</span>'}
    </div>
    ${stats.errors.length ? `<table><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Meta said</th></tr></thead><tbody>
      ${stats.errors.map((e) => `<tr><td>${esc(ago(e.created_at))}</td><td>${esc(e.event_name)}</td><td>${esc(e.status)} · ${e.attempts} tries</td><td class="err">${esc(e.last_error)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">None in the last 24 hours.</p>'}
  </section>

  <footer>Open-source, MIT licensed. Not affiliated with, endorsed or sponsored by Meta Platforms, Inc. You are responsible for collecting valid consent and for complying with Meta's Business Tools Terms.</footer>
</main>
<script>
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = document.getElementById(b.getAttribute('data-copy')).textContent;
      navigator.clipboard.writeText(t).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); });
    });
  });
</script>
</body>
</html>`;
}
