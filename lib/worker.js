'use strict';
// The background worker: sends emails, settles Paystack payments, and runs the timed chores.
// It runs inside the web process by default; `npm run worker` runs it alone (then set WORKER_ENABLED=0 on the web instances).
const queue = require('./queue');
const S = require('./shop');
const jobs = require('./jobs');
const { now } = require('./db');

const handlers = {
  email: (p) => S.sendOutboxEmail(Number(p.outboxId)),
  // A Paystack "charge.success" webhook: ask Paystack to confirm the money, then mark the order paid. Retried if Paystack is unreachable.
  'paystack.settle': (p) => S.settleWithPaystack(String(p.ref), { strict: true }),
  'cron.expireUnpaid': () => jobs.expireUnpaid(),
  'cron.expireUnconfirmedPod': () => jobs.expireUnconfirmedPod(),
  'cron.remindAbandoned': () => jobs.remindAbandoned(),
  'cron.cleanup': () => jobs.cleanup(),
  'cron.expireRxOrders': () => require('./pharmacy').expireRxOrders(),
  'cron.expireWholesale': () => require('./wholesale').expireLapsed(),
  'cron.dropshipWatch': () => require('./dropship-orders').watch(),
  'cron.fxFeed': () => require('./fx-feed').refresh(),
  'dropship.images': (p) => require('./dropship').fetchImages(p.productId),
  'cron.riderWatch': () => require('./dispatch').watch(),
  'cron.riderDispatch': () => require('./dispatch').sweep(),
  'cron.scheduledReports': () => require('./report-schedule').runDue(),
  alert: (p) => require('./errors').sendAlert(p),
  'cron.loyalty': () => require('./loyalty').sweep(),
  // Daily: the wallet books must balance. A failure raises an error, which the error tracking turns into an alert to the owner (ALERT_EMAIL / ALERT_WEBHOOK_URL).
  'cron.walletReconcile': async () => { const r = await require('./wallet').reconcile(); if (!r.ok) throw new Error(`Wallet reconciliation FAILED: ${r.drift.length} account(s) differ from the ledger, ${r.unbalanced.length} unbalanced transaction(s). Freeze top-ups (settings wallet_enabled=0) and investigate.`); },
  'cron.backup': () => require('./backup').create('schedule'),
  'cron.opsMonitor': () => require('./ops/monitor').run(),
  'cron.opsOrders': () => require('./ops/orders').sweep(),
};

// Every instance asks for each chore; the key makes sure only one copy per time slot is queued, so chores never run twice.
const SCHEDULE = [['cron.expireUnpaid', 600], ['cron.expireUnconfirmedPod', 600], ['cron.remindAbandoned', 900], ['cron.cleanup', 3600], ['cron.expireWholesale', 1800], ['cron.riderWatch', 30], ['cron.opsMonitor', 300], ['cron.opsOrders', 120], ['cron.riderDispatch', 60], ['cron.scheduledReports', 1800], ['cron.loyalty', 300], ['cron.walletReconcile', 86400]];
// A daily backup (about 01:00 Lagos time). On by default in production; BACKUP_ENABLED=0 turns it off, BACKUP_ENABLED=1 turns it on elsewhere.
if ((process.env.BACKUP_ENABLED || (process.env.NODE_ENV === 'production' ? '1' : '0')) === '1') SCHEDULE.push(['cron.backup', 86400]);
if (require('./fx-feed').enabled()) SCHEDULE.push(['cron.fxFeed', 21600]);
if (process.env.DROPSHIP_ORDERS_ENABLED === '1') SCHEDULE.push(['cron.dropshipWatch', 21600]);
if (require('./pharmacy-core').enabled()) SCHEDULE.push(['cron.expireRxOrders', 1800]);
const timers = [];
let handle = null;

function start() {
  if (handle) return;
  handle = queue.work(handlers);
  for (const [kind, every] of SCHEDULE) {
    const ask = () => queue.enqueue(kind, {}, { key: `${kind}:${Math.floor(now() / every)}`, maxAttempts: 2 }).catch((e) => console.error('Could not schedule', kind, e.message));
    const t = setInterval(ask, Math.min(every, 300) * 1000); t.unref(); timers.push(t);
    ask();
  }
}
async function stop() { for (const t of timers.splice(0)) clearInterval(t); if (handle) { await handle.stop(); handle = null; } }

module.exports = { start, stop, handlers };
