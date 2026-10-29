// Postgres storage: a small durable queue plus hourly counters.
// Only hashed contact data is stored, and rows are purged after RETENTION_DAYS.

import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capi_events (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_time       BIGINT      NOT NULL,
  event_name       TEXT        NOT NULL,
  event_id         TEXT        NOT NULL,
  source           TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  attempts         INT         NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at        TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  last_error       TEXT,
  fbtrace_id       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS capi_events_dedup ON capi_events (event_name, event_id);
CREATE INDEX IF NOT EXISTS capi_events_queue ON capi_events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS capi_events_created ON capi_events (created_at);
CREATE INDEX IF NOT EXISTS capi_events_status ON capi_events (status, created_at);

CREATE TABLE IF NOT EXISTS capi_counters (
  hour   TIMESTAMPTZ NOT NULL,
  name   TEXT        NOT NULL,
  value  BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, name)
);

CREATE TABLE IF NOT EXISTS capi_state (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export function createDb(databaseUrl) {
  const ssl = /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, ssl });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  return {
    pool,

    async migrate() {
      await pool.query(SCHEMA);
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    // Inserts events; returns { inserted, duplicates }.
    async insertEvents(rows) {
      if (rows.length === 0) return { inserted: 0, duplicates: 0 };
      const values = [];
      const params = [];
      rows.forEach((r, i) => {
        const b = i * 5;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`);
        params.push(r.event.event_time, r.event.event_name, r.event.event_id, r.source, JSON.stringify(r.event));
      });
      const res = await pool.query(
        `INSERT INTO capi_events (event_time, event_name, event_id, source, payload)
         VALUES ${values.join(', ')}
         ON CONFLICT (event_name, event_id) DO NOTHING`,
        params,
      );
      return { inserted: res.rowCount, duplicates: rows.length - res.rowCount };
    },

    async bump(name, by = 1) {
      if (by <= 0) return;
      await pool.query(
        `INSERT INTO capi_counters (hour, name, value) VALUES (date_trunc('hour', now()), $1, $2)
         ON CONFLICT (hour, name) DO UPDATE SET value = capi_counters.value + EXCLUDED.value`,
        [name, by],
      );
    },

    // Claims a batch of due events so concurrent workers never send the same row twice.
    async claimBatch(limit) {
      const res = await pool.query(
        `UPDATE capi_events SET status = 'sending', locked_at = now()
         WHERE id IN (
           SELECT id FROM capi_events
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, event_time, attempts, payload`,
        [limit],
      );
      return res.rows;
    },

    // Rows stuck in 'sending' (crash mid-flight) go back to the queue.
    async releaseStale() {
      await pool.query(
        `UPDATE capi_events SET status = 'pending', locked_at = NULL
         WHERE status = 'sending' AND locked_at < now() - interval '5 minutes'`,
      );
    },

    async markSent(ids, fbtraceId) {
      if (!ids.length) return;
      await pool.query(
        `UPDATE capi_events SET status = 'sent', sent_at = now(), locked_at = NULL,
                attempts = attempts + 1, last_error = NULL, fbtrace_id = $2
         WHERE id = ANY($1::bigint[])`,
        [ids, fbtraceId || null],
      );
    },

    async markFailed(ids, error, status = 'failed') {
      if (!ids.length) return;
      await pool.query(
        `UPDATE capi_events SET status = $3, locked_at = NULL, attempts = attempts + 1, last_error = $2
         WHERE id = ANY($1::bigint[])`,
        [ids, String(error).slice(0, 1000), status],
      );
    },

    async markRetry(ids, error, delaySeconds) {
      if (!ids.length) return;
      await pool.query(
        `UPDATE capi_events SET status = 'pending', locked_at = NULL, attempts = attempts + 1,
                last_error = $2, next_attempt_at = now() + make_interval(secs => $3)
         WHERE id = ANY($1::bigint[])`,
        [ids, String(error).slice(0, 1000), delaySeconds],
      );
    },

    async setState(key, value) {
      await pool.query(
        `INSERT INTO capi_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      );
    },

    async getState(key) {
      const res = await pool.query('SELECT value, updated_at FROM capi_state WHERE key = $1', [key]);
      return res.rows[0] || null;
    },

    async purge(retentionDays) {
      const ev = await pool.query(
        `DELETE FROM capi_events WHERE created_at < now() - make_interval(days => $1) AND status <> 'sending'`,
        [retentionDays],
      );
      await pool.query(`DELETE FROM capi_counters WHERE hour < now() - interval '90 days'`);
      return ev.rowCount;
    },

    async stats() {
      const [byStatus, counters, errors, last] = await Promise.all([
        pool.query(
          `SELECT status, count(*)::int AS n FROM capi_events
           WHERE created_at > now() - interval '24 hours' GROUP BY status`,
        ),
        pool.query(
          `SELECT name, sum(value)::int AS n FROM capi_counters
           WHERE hour > now() - interval '24 hours' GROUP BY name`,
        ),
        pool.query(
          `SELECT event_name, status, attempts, last_error, created_at FROM capi_events
           WHERE last_error IS NOT NULL AND created_at > now() - interval '24 hours'
           ORDER BY created_at DESC LIMIT 10`,
        ),
        pool.query(`SELECT max(sent_at) AS last_sent FROM capi_events WHERE status = 'sent'`),
      ]);
      const status = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n]));
      const count = Object.fromEntries(counters.rows.map((r) => [r.name, r.n]));
      return { status, count, errors: errors.rows, lastSent: last.rows[0]?.last_sent || null };
    },

    async close() {
      await pool.end();
    },
  };
}
