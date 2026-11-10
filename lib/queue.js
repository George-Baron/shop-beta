'use strict';
// Postgres-backed job queue.
//   enqueue(kind, payload, { key, delay })  -> job id, or null if the same key was already queued
//   work(handlers, opts)                    -> starts the polling worker; returns { stop() }
// Jobs retry with growing waits (30 s, 2 min, 10 min, 1 h, 6 h) and then show up as "failed" in the admin.
// A job whose worker died mid-way is picked up again once its 5-minute lock runs out.
const { get, all, run, now, pool } = require('./db');

const BACKOFF = (process.env.JOB_BACKOFF_SECONDS || '30,120,600,3600,21600').split(',').map(Number).filter((n) => n >= 0);
const LOCK_SECONDS = 300;
const listeners = new Set();
const kick = () => { for (const f of listeners) f(); };

async function enqueue(kind, payload = {}, opts = {}) {
  const t = now();
  const r = await get(
    'INSERT INTO jobs (kind, payload, run_at, key, max_attempts, created) VALUES (?,?::jsonb,?,?,?,?) ON CONFLICT (key) DO NOTHING RETURNING id',
    kind, JSON.stringify(payload), t + Math.max(0, Math.floor(opts.delay || 0)), opts.key || null, opts.maxAttempts || BACKOFF.length + 1, t);
  if (r) kick();
  return r ? Number(r.id) : null;
}

async function claim(n) {
  const t = now();
  const { rows } = await pool.query(
    `UPDATE jobs SET state='running', attempts=attempts+1, locked_until=$1
       WHERE id IN (SELECT id FROM jobs WHERE (state='queued' AND run_at<=$2) OR (state='running' AND locked_until<$2)
                    ORDER BY run_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [t + LOCK_SECONDS, t, n]);
  return rows;
}

async function finish(job, err) {
  const t = now();
  if (!err) return run("UPDATE jobs SET state='done', finished=?, locked_until=NULL, last_error=NULL WHERE id=?", t, job.id);
  const msg = String(err && err.message ? err.message : err).slice(0, 500);
  if (err && err.permanent || job.attempts >= job.max_attempts) return run("UPDATE jobs SET state='failed', finished=?, locked_until=NULL, last_error=? WHERE id=?", t, msg, job.id);
  return run("UPDATE jobs SET state='queued', run_at=?, locked_until=NULL, last_error=? WHERE id=?", t + BACKOFF[Math.min(job.attempts - 1, BACKOFF.length - 1)], msg, job.id);
}

function work(handlers, { concurrency = Number(process.env.WORKER_CONCURRENCY) || 4, pollMs = Number(process.env.WORKER_POLL_MS) || 2000 } = {}) {
  let running = 0, stopped = false, timer = null, pending = false;
  const tick = async () => {
    if (stopped) return;
    if (pending) return; pending = true;
    try {
      while (!stopped && running < concurrency) {
        const jobs = await claim(concurrency - running);
        if (!jobs.length) break;
        for (const job of jobs) {
          running++;
          (async () => {
            try {
              const h = handlers[job.kind];
              if (!h) throw Object.assign(new Error('No handler for job kind ' + job.kind), { permanent: true });
              await h(job.payload, job);
              await finish(job, null);
            } catch (e) {
              console.error(`Job ${job.id} (${job.kind}) failed, attempt ${job.attempts}:`, e && e.message);
              try { await finish(job, e); } catch (e2) { console.error('Could not record job result:', e2.message); }
            } finally { running--; if (!stopped) setImmediate(tick); }
          })();
        }
      }
    } catch (e) { console.error('Worker poll failed:', e.message); }
    finally { pending = false; }
  };
  const loop = () => { if (stopped) return; tick().finally(() => { timer = setTimeout(loop, pollMs); timer.unref(); }); };
  listeners.add(tick);
  loop();
  return {
    async stop() {
      stopped = true; listeners.delete(tick); clearTimeout(timer);
      for (let i = 0; i < 100 && running > 0; i++) await new Promise((r) => setTimeout(r, 100)); // let running jobs finish (up to 10 s)
    },
  };
}

const counts = async () => {
  const rows = await all("SELECT state, COUNT(*) n FROM jobs GROUP BY state");
  const o = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) o[r.state] = Number(r.n);
  return o;
};
const retry = (id) => run("UPDATE jobs SET state='queued', attempts=0, run_at=?, locked_until=NULL, finished=NULL WHERE id=? AND state='failed'", now(), id).then((r) => { if (r.changes) kick(); return r.changes > 0; });
const remove = (id) => run("DELETE FROM jobs WHERE id=? AND state='failed'", id).then((r) => r.changes > 0);
const prune = async () => {
  await run("DELETE FROM jobs WHERE state='done' AND finished<?", now() - 7 * 86400);
  await run("DELETE FROM jobs WHERE state='failed' AND finished<?", now() - 90 * 86400);
};

module.exports = { enqueue, work, counts, retry, remove, prune, BACKOFF };
