#!/usr/bin/env node
'use strict';
// Step 9: the whole load test on ONE computer: 2 app instances behind a round-robin balancer (like Render), a throwaway Postgres database
// with a 20,000-product catalogue, a fake Paystack, k6 load, then load/verify.js to check for lost, duplicated or oversold orders.
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres node load/run-staging.js [--vus 2000] [--rate 100] [--hold 180s] [--ramp 45s] [--profile mixed] [--chaos] [--products 20000]
// --chaos  at the middle of the run, instance 2 is shut down gracefully and restarted (what a Render deploy does) while traffic continues.
// Results are printed and saved to load/results/<time>.json. Everything shares this computer's CPUs, so the numbers are a FLOOR, not what Render will do.
// For the real staging run on Render see docs/LOAD-TEST.md.
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const A = process.argv.slice(2), opt = (n, d) => { const i = A.indexOf('--' + n); return i >= 0 ? A[i + 1] : d; };
const VUS = opt('vus', '2000'), RATE = opt('rate', '100'), HOLD = opt('hold', '180s'), RAMP = opt('ramp', '45s'), PROFILE = opt('profile', 'mixed'), PRODUCTS = opt('products', '20000'), CHAOS = A.includes('--chaos');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const withDb = (n) => { const u = new URL(ADMIN_URL); u.pathname = '/' + n; return u.toString(); };
const DB = 'sb_load_' + Date.now().toString(36), ROOT = path.join(__dirname, '..'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-load-'));
const SECRET = 'sk_test_loadtest', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (s) => /ms$/.test(s) ? parseFloat(s) / 1000 : /m$/.test(s) ? parseFloat(s) * 60 : parseFloat(s);
const procs = [], oldLogs = [];
const adminSql = async (s, db) => { const c = new Client({ connectionString: db ? withDb(db) : ADMIN_URL }); await c.connect(); try { return await c.query(s); } finally { await c.end(); } };
const sh = (cmd, args, env = {}) => { const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, DATABASE_URL: withDb(DB), PGSSL: 'disable', ...env }, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`); return r.stdout; };
const start = (cmd, args, env, name) => { const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); p.name = name; p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); p.exited = new Promise((r) => p.on('exit', r)); procs.push(p); return p; };
const waitUp = async (url, ms = 30000) => { const end = Date.now() + ms; for (;;) { try { if ((await fetch(url)).ok) return; } catch { /* wait */ } if (Date.now() > end) throw new Error('did not start: ' + url); await sleep(200); } };

(async () => {
  console.log(`Load test: ${PROFILE}, ${VUS} browsing shoppers + ${RATE} checkouts/min, ramp ${RAMP}, hold ${HOLD}${CHAOS ? ', with an instance restart' : ''}. Database ${DB}.`);
  await adminSql(`CREATE DATABASE ${DB}`);
  console.log(sh('node', ['load/seed-catalogue.js', PRODUCTS]).trim());
  const c = new Client({ connectionString: withDb(DB) }); await c.connect();
  await c.query("INSERT INTO settings (key,value) VALUES ('paystack_enabled','1') ON CONFLICT (key) DO UPDATE SET value='1'");
  await c.end();
  sh('node', ['load/verify.js', '--snapshot', path.join(TMP, 'before.json')]);
  const ps = start('node', ['load/mock-paystack.js'], { PORT: '4999', LATENCY_MS: '120' }, 'paystack'); await sleep(500);
  const envFor = (port, id) => ({ PORT: String(port), DATABASE_URL: withDb(DB), PGSSL: 'disable', BASE_URL: 'http://localhost:3100', STORAGE_DRIVER: 'local', DATA_DIR: path.join(TMP, 'data' + port), INSTANCE_ID: id, TRUST_PROXY: '1',
    PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: 'http://127.0.0.1:4999', ADMIN_EMAIL: 'load@example.com', ADMIN_PASSWORD: 'load-test-admin-pw', NODE_ENV: '', LOG_REQUESTS: 'errors', RATE_LIMITS: '', MIGRATE_ON_START: '0', SEED_DEMO: '0' });
  const mk = (port, id) => start('node', ['--disable-warning=ExperimentalWarning', 'server.js'], envFor(port, id), id);
  const i1 = mk(3101, 'instance-1'); let i2 = mk(3102, 'instance-2');
  try { await waitUp('http://127.0.0.1:3101/health'); await waitUp('http://127.0.0.1:3102/health'); } catch (e) { throw new Error(e.message + '\n' + i1.log.slice(-800) + '\n' + i2.log.slice(-800)); }
  const lb = start('node', ['scripts/dev-lb.js', '3100', 'http://127.0.0.1:3101', 'http://127.0.0.1:3102'], {}, 'lb'); await waitUp('http://127.0.0.1:3100/health');
  console.log('2 instances and the balancer are up.');

  // Every 5 s: memory and CPU of each instance, how busy the WHOLE computer is (it is shared with k6, the balancer and Postgres, so a busy
  // computer makes latency look worse than it would on Render), and database connections. CPU is read from /proc, not from ps (ps averages over the process lifetime).
  const TICK_MS = 10; const readProc = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); return Number(f[11]) + Number(f[12]); } catch { return null; } };
  const readCpu = () => { const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + (f[4] || 0) }; };
  const appCpuTicks = {}; let lastCpu = readCpu(); const samples = [];
  const sampler = setInterval(() => {
    const row = { inst: [] }; const c = readCpu(); row.busyPct = Math.round(100 * (1 - (c.idle - lastCpu.idle) / Math.max(1, c.total - lastCpu.total))); lastCpu = c;
    for (const p of [i1, i2]) { const t = readProc(p.pid); if (t !== null) { appCpuTicks[p.name] = t; let rss = 0; try { rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'))[1]) / 1024; } catch { /* gone */ } row.inst.push({ rssMb: Math.round(rss) }); } }
    adminSql(`SELECT COUNT(*)::int c FROM pg_stat_activity WHERE datname='${DB}'`).then((r) => { row.pgConns = r.rows[0].c; }).catch(() => {}); samples.push(row);
  }, 5000);

  const logFile = path.join(TMP, 'k6-orders.log'), summary = path.join(TMP, 'k6-summary.json');
  const k6 = spawn('k6', ['run', '--quiet', '--console-output', logFile, '--summary-export', summary, '-e', 'PROFILE=' + PROFILE, '-e', 'VUS=' + VUS, '-e', 'RATE=' + RATE, '-e', 'HOLD=' + HOLD, '-e', 'RAMP=' + RAMP, '-e', 'BASE=http://127.0.0.1:3100', '-e', 'PS_SECRET=' + SECRET, 'load/baseline.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let k6out = ''; k6.stdout.on('data', (d) => { k6out += d; }); k6.stderr.on('data', (d) => { k6out += d; }); const k6done = new Promise((r) => k6.on('exit', r));
  let chaosNote = '';
  if (CHAOS) {
    await sleep((secs(RAMP) + secs(HOLD) / 2) * 1000);
    console.log('CHAOS: shutting instance-2 down gracefully (as a deploy would)...'); const t0 = Date.now(); i2.kill('SIGTERM'); await i2.exited; oldLogs.push(i2.log); await sleep(3000);
    i2 = mk(3102, 'instance-2b'); await waitUp('http://127.0.0.1:3102/health'); chaosNote = `instance-2 was stopped and restarted; it was back and healthy ${Math.round((Date.now() - t0) / 1000)} s after the stop signal`; console.log('CHAOS: ' + chaosNote);
  }
  const code = await k6done; clearInterval(sampler);
  if (code !== 0 && code !== 99) console.log('\n--- k6 output (it stopped with exit ' + code + ') ---\n' + k6out.slice(-2500));
  console.log('\n--- k6 finished (exit ' + code + ') ---\n' + k6out.split('\n').filter((l) => /✓|✗|checks|http_req|app_errors|orders_|iterations|vus_max|data_received|THRESHOLD|thresholds|http_reqs/.test(l)).join('\n').slice(0, 6000));
  console.log('\n--- integrity checks ---');
  const v = spawnSync('node', ['load/verify.js', '--log', logFile, '--snapshot', path.join(TMP, 'before.json'), '--scarce-total', '10', '--out', path.join(TMP, 'verify.json')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: withDb(DB), PGSSL: 'disable' }, encoding: 'utf8' }); console.log(v.stdout + v.stderr);
  const keepLog = path.join(ROOT, 'load', 'results', 'last-orders.log'); fs.mkdirSync(path.dirname(keepLog), { recursive: true }); fs.copyFileSync(logFile, keepLog);
  const sum = JSON.parse(fs.readFileSync(summary, 'utf8')).metrics; const m = (n, k) => sum[n] && sum[n][k];
  const tally = {}; for (const l of [i1.log, i2.log, ...oldLogs].join('\n').split('\n')) { try { const o = JSON.parse(l); if (o.msg === 'request' && o.status >= 400) { const k = `${o.method} ${o.path} -> ${o.status}`; tally[k] = (tally[k] || 0) + 1; } } catch { /* not json */ } }
  const errLog = [i1, i2].map((p) => p.log).join('\n').split('\n').filter((l) => /"level":"error"/.test(l)).slice(0, 10);
  const result = {
    when: new Date().toISOString(), machine: `${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB, shared by everything`, profile: PROFILE, vus: Number(VUS), checkoutsPerMin: Number(RATE), ramp: RAMP, hold: HOLD, chaos: chaosNote || null,
    http: { requests: m('http_reqs', 'count'), perSecond: Math.round(m('http_reqs', 'rate')), p50: m('http_req_duration', 'med'), p90: m('http_req_duration', 'p(90)'), p95: m('http_req_duration', 'p(95)'), p99: m('http_req_duration', 'p(99)'), max: m('http_req_duration', 'max'), failedRate: m('http_req_failed', 'rate') },
    appErrorRate: m('app_errors', 'rate'), ordersAccepted: m('orders_accepted', 'count'), soldOutRefusals: m('orders_refused_sold_out', 'count'),
    p95ByRequest: Object.fromEntries(Object.keys(sum).filter((k) => /^http_req_duration\{name:/.test(k)).map((k) => [k.replace(/^http_req_duration\{name:/, '').slice(0, -1), sum[k]['p(95)']])),
    wholeComputerBusyPercent: { average: Math.round(samples.reduce((a, s) => a + s.busyPct, 0) / Math.max(1, samples.length)), peak: Math.max(0, ...samples.map((s) => s.busyPct)) },
    appCpuMsPerRequest: Math.round(100 * Object.values(appCpuTicks).reduce((a, b) => a + b, 0) * TICK_MS / m('http_reqs', 'count')) / 100, appCpuSecondsTotal: Math.round(Object.values(appCpuTicks).reduce((a, b) => a + b, 0) * TICK_MS / 1000),
    peakMemoryMbPerInstance: Math.max(0, ...samples.map((s) => Math.max(0, ...s.inst.map((x) => x.rssMb)))), peakDbConnections: Math.max(0, ...samples.map((s) => s.pgConns || 0)),
    integrity: JSON.parse(fs.readFileSync(path.join(TMP, 'verify.json'), 'utf8')).checks, integrityOk: v.status === 0, serverErrorLines: errLog.length, refusedByServer: tally, k6ThresholdsPassed: code === 0,
  };
  fs.mkdirSync(path.join(ROOT, 'load', 'results'), { recursive: true }); const out = path.join(ROOT, 'load', 'results', new Date().toISOString().replace(/[:.]/g, '-') + (CHAOS ? '-chaos' : '') + '.json'); fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log('\n--- result ---\n' + JSON.stringify({ ...result, integrity: undefined, p95ByRequest: result.p95ByRequest }, null, 2)); if (errLog.length) console.log('Server error lines:\n' + errLog.join('\n')); console.log('Saved ' + out);
  for (const p of procs) p.kill(); await sleep(1500); await adminSql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true }); else console.log('Kept ' + TMP);
  process.exit(result.integrityOk && result.k6ThresholdsPassed ? 0 : 1);
})().catch(async (e) => { console.error(e); for (const p of procs) p.kill(); await adminSql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); process.exit(2); });
