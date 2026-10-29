// Sends batches to the Conversions API and classifies failures.

const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80004]);
const CONFIG_CODES = new Set([10, 102, 190, 200, 270, 294]);

/**
 * @returns {Promise<{kind: 'ok'|'invalid'|'config'|'retry', message?: string, fbtraceId?: string, received?: number}>}
 */
export async function sendToMeta(config, events, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `${config.graphBaseUrl}/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.pixelId)}/events`
    + `?access_token=${encodeURIComponent(config.accessToken)}`;
  const body = { data: events };
  if (config.testEventCode) body.test_event_code = config.testEventCode;

  let res;
  let json;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    return { kind: 'retry', message: `network: ${err.name === 'TimeoutError' ? 'timeout' : err.message}` };
  }

  if (res.ok && json && typeof json.events_received === 'number') {
    return { kind: 'ok', received: json.events_received, fbtraceId: json.fbtrace_id };
  }

  const e = (json && json.error) || {};
  const message = [
    e.message || `HTTP ${res.status}`,
    e.error_user_msg ? `— ${e.error_user_msg}` : '',
    e.code !== undefined ? `(code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : '',
  ].filter(Boolean).join(' ');

  if (res.status >= 500 || res.status === 429 || e.is_transient || RETRYABLE_CODES.has(e.code)) {
    return { kind: 'retry', message, fbtraceId: e.fbtrace_id };
  }
  // Wrong token, missing permission, or a pixel ID that does not exist: an operator problem,
  // not an event problem. Events wait in the queue until the configuration is fixed.
  if (CONFIG_CODES.has(e.code) || res.status === 401 || res.status === 403 || (e.code === 100 && e.error_subcode === 33)) {
    return { kind: 'config', message, fbtraceId: e.fbtrace_id };
  }
  return { kind: 'invalid', message, fbtraceId: e.fbtrace_id };
}
