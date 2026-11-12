'use strict';
// A small job queue on PostgreSQL (no Redis, no extra service).
//
//   enqueue(queue, payload, opts)  add a job. Inside a transaction it is saved WITH that transaction: if the order is saved the job exists,
//                                  if the order is rolled back the job never existed. (This is what makes "no lost emails" possible.)
//   register(queue, handler)       say what to do for a kind of job. The handler throws to fail; the job is retried later.
//   start() / stop()               the worker loop. Every web instance runs one; FOR UPDATE SKIP LOCKED makes sure each job runs on one instance only.
//
// Retries: attempt 1 now, then after 30 s, 2 min, 8 min, 32 min, 2 h (max_attempts 6), then the job is marked failed and shows in Admin > Jobs.
// Crash safety: a job being worked on has a lease (locked_until). If the instance dies, the lease runs out and another instance picks the job up.
// A handler can be run more than once for the same job (crash after doing the work, before saying so), so handlers must be safe to repeat.
const log = require('./log');
const { get, all, run, insert, now } = require('./db');

const handlers = new Map();
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 4);
const POLL_MS = Math.max(50, Number(process.env.WORKER_POLL_MS) || 1000);
const LEASE_S = Math.max(5, Number(process.env.JOB_LEASE_SECONDS) || 120);
const BACKOFF_BASE_S = process.env.JOB_BACKOFF_BASE_SECONDS === undefined ? 30 : Number(process.env.JOB_BACKOFF_BASE_SECONDS); // retry delays: base * 4^(attempt-1)
const KEEP_DONE_DAYS = 7, KEEP_FAILED_DAYS = 60;

const register = (queue, fn) => handlers.set(queue, fn);

async function enqueue(queue, payload = {}, { runAt, delaySeconds, singletonKey, maxAttempts } = {}) {
  const t = now();
  const args = [queue, JSON.stringify(payload), maxAttempts || 6, runAt || t + (delaySeconds || 0), singletonKey || null, t];
  if (!singletonKey) return insert('INSERT INTO jobs (queue,payload,max_attempts,run_at,singleton_key,created) VALUES (?,?,?,?,?,?)', ...args);
  // One open job per key: asking again while one is waiting or running does nothing and returns null.
  const r = await get('INSERT INTO jobs (queue,payload,max_attempts,run_at,singleton_key,created) VALUES (?,?,?,?,?,?) ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL AND state IN (\'queued\',\'active\') DO NOTHING RETURNING id', ...args);
  return r ? r.id : null;
}

// For scheduled work: add the job unless one of this kind was already added within the last `everySeconds` (by any instance).
async function enqueueEvery(queue, everySeconds, payload = {}) {
  const t = now();
  const r = await get(`INSERT INTO jobs (queue,payload,run_at,singleton_key,created)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE queue = ? AND created > ?)
    ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL AND state IN ('queued','active') DO NOTHING RETURNING id`,
  queue, JSON.stringify(payload), t, 'every:' + queue, t, queue, t - everySeconds);
  return r ? r.id : null;
}

// Take up to `n` due jobs. One statement: pick with SKIP LOCKED, mark active, give them a lease.
async function claim(n, only) {
  const t = now();
  // Jobs whose worker died more times than allowed are failed instead of being tried again.
  await run("UPDATE jobs SET state='failed', finished=?, last_error=CASE WHEN last_error='' THEN 'Worker stopped while running this job' ELSE last_error END WHERE state='active' AND locked_until<? AND attempts>=max_attempts", t, t);
  const names = only || [...handlers.keys()];
  if (!names.length) return [];
  return all(`WITH due AS (
      SELECT id FROM jobs WHERE queue = ANY(?) AND run_at <= ? AND (state='queued' OR (state='active' AND locked_until < ?))
      ORDER BY run_at, id LIMIT ? FOR UPDATE SKIP LOCKED)
    UPDATE jobs j SET state='active', attempts=j.attempts+1, locked_until=?
    FROM due WHERE j.id = due.id RETURNING j.id, j.queue, j.payload, j.attempts, j.max_attempts`, names, t, t, n, t + LEASE_S);
}

const backoff = (attempt) => BACKOFF_BASE_S * 4 ** (attempt - 1);
const clip = (e) => String((e && e.message) || e).slice(0, 500);

async function settle(job, err) {
  const t = now();
  if (!err) return run("UPDATE jobs SET state='done', finished=?, locked_until=0, last_error='' WHERE id=?", t, job.id);
  const permanent = err && err.permanent === true;
  if (permanent || job.attempts >= job.max_attempts) return run("UPDATE jobs SET state='failed', finished=?, locked_until=0, last_error=? WHERE id=?", t, clip(err), job.id);
  return run("UPDATE jobs SET state='queued', run_at=?, locked_until=0, last_error=? WHERE id=?", t + backoff(job.attempts), clip(err), job.id);
}

async function execute(job) {
  const fn = handlers.get(job.queue);
  let payload = {}; try { payload = JSON.parse(job.payload); } catch { /* handler decides */ }
  try {
    if (!fn) throw Object.assign(new Error('No handler for ' + job.queue), { permanent: true });
    await fn(payload, job);
    await settle(job, null);
  } catch (e) {
    log.error(`Job ${job.id} (${job.queue}) attempt ${job.attempts}/${job.max_attempts} failed: ${clip(e)}`);
    await settle(job, e).catch((e2) => log.error('Could not record job result:', e2.message));
    if ((e && e.permanent === true) || job.attempts >= job.max_attempts) require('./errors').record(e, { source: 'job', route: job.queue }); // gives up: alert the owner
  }
}

// Run due jobs until none are left (used by tests and by the loop).
async function runDue(only) {
  let total = 0;
  for (;;) { const jobs = await claim(CONCURRENCY, only); if (!jobs.length) return total; total += jobs.length; await Promise.all(jobs.map(execute)); }
}

let loop = null, stopping = false, busy = 0;
function start() {
  if (loop || process.env.WORKER === '0') return;
  stopping = false;
  const tick = async () => {
    if (stopping) return;
    let got = 0;
    try { const jobs = await claim(Math.max(0, CONCURRENCY - busy)); got = jobs.length; busy += got; jobs.forEach((j) => execute(j).finally(() => { busy--; })); }
    catch (e) { log.error('Worker could not read the job queue:', e.message); }
    if (!stopping) loop = setTimeout(tick, got ? 0 : POLL_MS + Math.random() * 200);
    if (loop && loop.unref && !got) loop.unref();
  };
  loop = setTimeout(tick, 200); loop.unref();
}
async function stop(waitMs = 10000) {
  stopping = true; if (loop) clearTimeout(loop); loop = null;
  const end = Date.now() + waitMs; while (busy > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

/* ---- admin helpers ---- */
async function overview() {
  const t = now();
  const counts = Object.fromEntries((await all("SELECT state, COUNT(*) n FROM jobs WHERE state IN ('queued','active','failed') OR finished > ? GROUP BY state", t - 86400)).map((r) => [r.state, r.n]));
  const oldest = await get("SELECT MIN(run_at) t FROM jobs WHERE state='queued' AND run_at <= ?", t);
  return { queued: counts.queued || 0, active: counts.active || 0, failed: counts.failed || 0, done24h: counts.done || 0, oldestWaitingSeconds: oldest && oldest.t ? t - oldest.t : 0, perQueue: await all("SELECT queue, state, COUNT(*) n FROM jobs WHERE state IN ('queued','active','failed') GROUP BY queue, state ORDER BY queue") };
}
const failedList = (limit = 100) => all("SELECT id, queue, payload, attempts, last_error, created, finished FROM jobs WHERE state='failed' ORDER BY finished DESC, id DESC LIMIT ?", limit);
const retry = async (id) => (await run("UPDATE jobs SET state='queued', attempts=0, run_at=?, locked_until=0, last_error='', finished=NULL WHERE id=? AND state='failed'", now(), id)).changes === 1;
const discard = async (id) => (await run("DELETE FROM jobs WHERE id=? AND state='failed'", id)).changes === 1;
async function prune() {
  const t = now();
  await run("DELETE FROM jobs WHERE state='done' AND finished < ?", t - KEEP_DONE_DAYS * 86400);
  await run("DELETE FROM jobs WHERE state='failed' AND finished < ?", t - KEEP_FAILED_DAYS * 86400);
}

module.exports = { register, enqueue, enqueueEvery, claim, runDue, start, stop, overview, failedList, retry, discard, prune, backoff, handlers };
