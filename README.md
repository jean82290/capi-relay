# CAPI Relay

**Consent-first, self-hosted server-side tracking for Facebook & Instagram ads.**
CAPI Relay receives your website's conversion events and forwards them to the Meta Conversions API from your own server, with deduplication against the browser Pixel, automatic retries, and a small dashboard. One service and a Postgres database — no Google Tag Manager, no per-event fees.

> Not affiliated with, endorsed or sponsored by Meta Platforms, Inc. "Facebook" and "Instagram" are trademarks of Meta Platforms, Inc., used here only to describe compatibility.

**Documentation:** https://jean82290.github.io/capi-relay/

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/xSo6oY?referralCode=NamAm4&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Why

Browser pixels miss conversions: ad blockers, Safari's tracking limits and closed tabs all drop events before they reach Meta. Meta recommends sending the same events from a server through the Conversions API, with a shared `event_id` so each conversion is counted once. CAPI Relay is that server, ready to deploy.

```
 visitor's browser                         your Railway project
┌────────────────────┐   same event_id   ┌──────────────────────┐        ┌──────────────┐
│ Meta Pixel  ───────┼───────────────────┼──────────────────────┼──────▶ │              │
│ capi('track', …) ──┼──▶ POST /e ──────▶│ CAPI Relay ─ Postgres│──────▶ │ Conversions  │
└────────────────────┘                   │  queue · retries     │        │ API (Meta)   │
 your backend ───────────▶ POST /v1/events│  hashing · consent   │        └──────────────┘
                                         └──────────────────────┘
```

## What makes it different

- **Consent is enforced, not optional.** Nothing leaves the browser until your cookie banner calls `capi('consent', true)`. Server calls must say `"consent": true` per event. Events without consent are dropped and never stored.
- **Personal data is hashed on arrival.** Emails, phones, names, cities, zip codes, dates of birth and external IDs are normalized and SHA-256 hashed following Meta's rules before they touch the database. IP and user agent stay unhashed, as Meta requires.
- **Short retention.** Stored events are deleted after `RETENTION_DAYS` (default 7).
- **Reliable delivery.** A durable Postgres queue, exponential backoff, and automatic isolation of an invalid event so it never blocks the rest of its batch. Events Meta would refuse (older than 7 days) are expired rather than retried forever.
- **Deduplication.** The browser helper fires the Pixel and the relay with the same `event_id`; the relay also ignores repeats of the same `event_name` + `event_id`.
- **A dashboard that tells you what's wrong.** Delivery rate, queue, failures with Meta's own error messages, setup checklist, and a one-click test event.
- **Tiny.** Plain Node.js with a single dependency (`pg`).

## Deploy in 10 minutes

1. **Get your IDs from Meta.** In Events Manager, open your dataset (Pixel) → *Settings*. Copy the **dataset ID**, then under *Conversions API* click **Generate access token**. No app review is needed.
2. **Deploy the template** and fill in `META_PIXEL_ID`, `META_ACCESS_TOKEN` and `ALLOWED_ORIGINS` (your site, e.g. `https://www.myshop.com`).
3. **Add a custom domain** on the CAPI Relay service, such as `t.myshop.com` (Railway → service → *Settings* → *Networking*). Recommended: on a subdomain of your site, the browser sends the Pixel's `_fbp`/`_fbc` cookies to the relay, which improves matching.
4. **Add the snippet** below to your site and connect it to your cookie banner.
5. **Test.** Set `META_TEST_EVENT_CODE` to the code shown in Events Manager → *Test events*, open `https://t.myshop.com/admin` (any username, password = `ADMIN_PASSWORD`) and press **Send a test event**. Remove the variable when you go live.

## Website snippet

Load it after your Meta Pixel (which should itself only load after consent):

```html
<script>
  window.capi = window.capi || function () { (capi.q = capi.q || []).push(arguments) };
</script>
<script async src="https://t.myshop.com/capi.js"></script>
```

From your cookie banner's callback, when the visitor accepts marketing cookies:

```js
capi('consent', true);   // and capi('consent', false) if they withdraw it
```

Then send events with `capi('track', …)` instead of `fbq('track', …)`. It fires the Pixel and the relay with the same event ID:

```js
capi('track', 'ViewContent', { content_ids: ['sku-42'], content_type: 'product' });

capi('track', 'Purchase',
  { value: 49.90, currency: 'EUR', order_id: '1042' },
  { userData: { em: 'jane@example.com', ph: '06 12 34 56 78' }, eventId: 'order-1042' });
```

| Call | Effect |
|---|---|
| `capi('consent', true \| false)` | Grants or withdraws consent. Default: not granted. |
| `capi('track', name, customData?, options?)` | Sends an event. Returns its `event_id`. `options`: `userData`, `eventId`, `pixel: false` (skip the Pixel call). |
| `capi('config', { pixel: false })` | Never call `fbq` (if you fire the Pixel yourself with the same `eventID`). |

The helper never sets cookies. It reads the `_fbp` and `_fbc` cookies created by the Pixel and builds `fbc` from an `fbclid` URL parameter when needed.

## Server API

Send events from your backend (order confirmations, CRM updates, offline sales). Up to 500 events per request.

```bash
curl -X POST https://t.myshop.com/v1/events \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "event_name": "Purchase",
      "event_id": "order-1042",
      "consent": true,
      "event_source_url": "https://www.myshop.com/checkout",
      "user_data": {
        "em": "jane@example.com",
        "client_ip_address": "203.0.113.7",
        "client_user_agent": "Mozilla/5.0 …"
      },
      "custom_data": { "value": 49.90, "currency": "EUR" }
    }]
  }'
```

Response: `{"accepted": 1, "duplicates": 0, "skipped_no_consent": 0, "errors": []}`.

- `consent` must be `true` for each event (you are confirming the person consented).
- `action_source` defaults to `website`; other Meta values (`system_generated`, `physical_store`, `email`, …) are accepted. Website events need `event_source_url`.
- `event_time` (Unix seconds) is optional and must be within the last 7 days.
- Values already hashed with SHA-256 (64 hex characters) are passed through unchanged.
- Use the same `event_id` as the browser event when both describe the same conversion.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `META_PIXEL_ID` | yes | | Dataset / Pixel ID from Events Manager. |
| `META_ACCESS_TOKEN` | yes | | Conversions API access token from Events Manager. |
| `ALLOWED_ORIGINS` | yes | | Comma-separated sites allowed to send browser events, e.g. `https://myshop.com,https://www.myshop.com`. |
| `DATABASE_URL` | yes | | Postgres connection string (set automatically by the template). |
| `ADMIN_PASSWORD` | yes | | Dashboard password (generated by the template). |
| `API_KEY` | for server API | | Bearer key for `/v1/events` (generated by the template). |
| `META_TEST_EVENT_CODE` | no | | Routes events to Events Manager → Test events. Remove in production. |
| `REQUIRE_CONSENT` | no | `true` | Set `false` only where the law does not require consent for ad tracking (not in the EU/UK). |
| `RETENTION_DAYS` | no | `7` | Days before stored events are deleted (1–90). |
| `DEFAULT_PHONE_COUNTRY_CODE` | no | | Calling code added to national phone numbers, e.g. `33` for France, `1` for the US. |
| `META_API_VERSION` | no | `v26.0` | Graph API version. |

## Endpoints

| Path | Purpose |
|---|---|
| `GET /capi.js` | Browser helper. |
| `POST /e` | Browser events (CORS-restricted to `ALLOWED_ORIGINS`, rate-limited). |
| `POST /v1/events` | Server events (Bearer `API_KEY`). |
| `GET /admin` | Dashboard (HTTP basic auth, password `ADMIN_PASSWORD`). |
| `GET /admin/stats.json` | Dashboard numbers as JSON. |
| `GET /healthz` | Health check. |

## Privacy and your responsibilities

CAPI Relay is a tool you run on your own infrastructure; you are the controller of the data it processes. In particular, under the GDPR and ePrivacy rules, server-side tracking does **not** remove the need for consent. Before going live:

- make sure your cookie banner calls `capi('consent', …)` and that your Meta Pixel only loads after consent;
- mention Meta's Conversions API in your privacy policy;
- respect Meta's Business Tools Terms (for example, do not send sensitive data such as health information).

What the relay stores: the Meta-formatted event (hashed contact data, IP address, user agent, `fbp`/`fbc`, your `custom_data`), delivery status and Meta's error messages — for `RETENTION_DAYS` only. What it never stores: events without consent, raw emails or phone numbers.

## Development

```bash
npm install
# Tests need a disposable Postgres database:
TEST_DATABASE_URL=postgres://postgres@localhost:5432/capi_test npm test
DATABASE_URL=postgres://… META_PIXEL_ID=… META_ACCESS_TOKEN=… npm start
```

The test suite runs against a real Postgres and a fake Graph API: consent gating, hashing against Meta's documented examples, deduplication, retries, batch isolation, expiry, retention and the dashboard.

## License

MIT — see [LICENSE](LICENSE). Provided as is, without warranty.
