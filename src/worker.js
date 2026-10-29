// Background worker: drains the queue to Meta with retries, isolates invalid
// events, expires events Meta would refuse, and purges old rows.

import { sendToMeta } from './meta.js';
import { MAX_EVENT_AGE_SECONDS } from './events.js';

const MAX_ATTEMPTS = 15;
const CONFIG_RETRY_SECONDS = 600;

function backoffSeconds(attempts) {
  const base = Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function createWorker({ db, config, fetchImpl, log = console }) {
  let timer = null;
  let running = false;
  let again = false;
  let lastPurge = 0;
  let stopped = false;

  // Sends a group of claimed rows; splits the batch when Meta rejects it as invalid,
  // because one bad event makes Meta reject the whole request.
  async function deliver(rows) {
    const result = await sendToMeta(config, rows.map((r) => r.payload), { fetchImpl });
    const ids = rows.map((r) => r.id);

    if (result.kind === 'ok') {
      await db.markSent(ids, result.fbtraceId);
      await db.bump('sent', ids.length);
      return;
    }
    if (result.kind === 'config') {
      log.error?.(`[worker] Meta refused the configuration, ${ids.length} event(s) kept for retry in 10 min: ${result.message}`);
      await db.setState('config_error', result.message);
      await db.markRetry(ids, result.message, CONFIG_RETRY_SECONDS);
      return 'config';
    }
    if (result.kind === 'retry') {
      log.error?.(`[worker] temporary delivery problem, ${ids.length} event(s) will be retried: ${result.message}`);
      const retry = rows.filter((r) => r.attempts + 1 < MAX_ATTEMPTS);
      const giveUp = rows.filter((r) => r.attempts + 1 >= MAX_ATTEMPTS);
      for (const r of retry) await db.markRetry([r.id], result.message, backoffSeconds(r.attempts + 1));
      await db.markFailed(giveUp.map((r) => r.id), `gave up after ${MAX_ATTEMPTS} attempts: ${result.message}`);
      return 'retry';
    }
    // invalid
    if (rows.length === 1) {
      log.error?.(`[worker] Meta rejected a ${rows[0].payload.event_name} event: ${result.message}`);
      await db.markFailed(ids, result.message);
      await db.bump('rejected', 1);
      return;
    }
    const mid = Math.ceil(rows.length / 2);
    const a = await deliver(rows.slice(0, mid));
    const b = await deliver(rows.slice(mid));
    return a || b;
  }

  async function tick() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (Date.now() - lastPurge > 30 * 60 * 1000) {
          lastPurge = Date.now();
          await db.releaseStale();
          const purged = await db.purge(config.retentionDays);
          if (purged) log.info?.(`[worker] purged ${purged} events older than ${config.retentionDays} days`);
        }
        if (!config.metaReady) break;

        const rows = await db.claimBatch(config.batchSize);
        if (rows.length === 0) break;

        const now = Math.floor(Date.now() / 1000);
        const tooOld = rows.filter((r) => Number(r.event_time) < now - MAX_EVENT_AGE_SECONDS + 300);
        const fresh = rows.filter((r) => !tooOld.includes(r));
        if (tooOld.length) {
          await db.markFailed(tooOld.map((r) => r.id), 'expired: older than 7 days before it could be delivered', 'expired');
        }
        if (fresh.length === 0) {
          again = true;
          continue;
        }

        const outcome = await deliver(fresh);
        if (outcome === undefined) await db.setState('config_error', '');
        // Stop draining on transient or configuration errors; the backoff handles the rest.
        if (outcome) break;
        if (rows.length === config.batchSize) again = true;
      } while (again && !stopped);
    } catch (err) {
      log.error?.('[worker] error:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      stopped = false;
      timer = setInterval(tick, config.workerIntervalMs);
      timer.unref?.();
      tick();
    },
    // Called after new events arrive, so they leave within ~250 ms instead of waiting for the interval.
    nudge: (() => {
      let pending = null;
      return () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          tick();
        }, 250);
        pending.unref?.();
      };
    })(),
    tick,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
