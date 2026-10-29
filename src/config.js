// Reads and validates configuration from environment variables.
// The relay must boot even when Meta settings are missing, so the
// dashboard can tell the operator what to fix instead of crash-looping.

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const pixelId = String(env.META_PIXEL_ID || '').trim();
  const accessToken = String(env.META_ACCESS_TOKEN || '').trim();

  const config = {
    port: int(env.PORT, 3000, 1, 65535),
    databaseUrl: env.DATABASE_URL || '',
    pixelId,
    accessToken,
    apiVersion: String(env.META_API_VERSION || 'v26.0').trim(),
    graphBaseUrl: String(env.META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    testEventCode: String(env.META_TEST_EVENT_CODE || '').trim(),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    apiKey: String(env.API_KEY || '').trim(),
    adminPassword: String(env.ADMIN_PASSWORD || '').trim(),
    requireConsent: bool(env.REQUIRE_CONSENT, true),
    retentionDays: int(env.RETENTION_DAYS, 7, 1, 90),
    defaultPhoneCountryCode: String(env.DEFAULT_PHONE_COUNTRY_CODE || '').replace(/\D/g, ''),
    workerIntervalMs: int(env.WORKER_INTERVAL_MS, 2000, 100, 60000),
    batchSize: int(env.BATCH_SIZE, 500, 1, 1000),
  };

  config.problems = [];
  if (!config.databaseUrl) config.problems.push('DATABASE_URL is not set.');
  if (!/^\d{5,20}$/.test(pixelId)) config.problems.push('META_PIXEL_ID is missing or is not a numeric dataset/pixel ID.');
  if (!accessToken) config.problems.push('META_ACCESS_TOKEN is missing (Events Manager → Settings → Conversions API → Generate access token).');
  if (config.allowedOrigins.length === 0) config.problems.push('ALLOWED_ORIGINS is empty: browser events are refused until you list your site, e.g. https://www.myshop.com');
  if (!config.adminPassword) config.problems.push('ADMIN_PASSWORD is not set: the dashboard is locked.');
  config.metaReady = /^\d{5,20}$/.test(pixelId) && Boolean(accessToken);
  return config;
}
