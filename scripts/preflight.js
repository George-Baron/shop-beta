#!/usr/bin/env node
'use strict';
// Go-live checker. Reads the settings it is given (from the environment, or from a file with --env-file) and tells you what is wrong BEFORE customers find out.
//   node scripts/preflight.js --env-file production.env --expect live            (offline: only looks at the values)
//   node scripts/preflight.js --env-file production.env --expect live --online    (also: connects to the database, Paystack and Storage)
//   npm run preflight -- --expect test                                            (staging: expects Paystack TEST keys)
// Never prints a secret. Exit code 1 if anything FAILS (warnings do not fail). Keep the env file outside the repository and delete it afterwards.
const fs = require('fs');
const A = process.argv.slice(2), val = (n) => { const i = A.indexOf(n); return i >= 0 ? A[i + 1] : undefined; };
const file = val('--env-file'), expect = val('--expect') || 'live', online = A.includes('--online');
const env = { ...process.env };
if (file) for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); }
const results = []; const add = (level, name, why) => { results.push({ level, name, why }); console.log(`  ${level.padEnd(4)} ${name}${why ? '  ' + why : ''}`); };
const ok = (n) => add('PASS', n), warn = (n, w) => add('WARN', n, w), fail = (n, w) => add('FAIL', n, w);
const has = (k) => !!(env[k] || '').trim();
const host = (u) => { try { return new URL(u); } catch { return null; } };

console.log(`Shop-Beta go-live check (expecting Paystack ${expect.toUpperCase()} keys${online ? ', with online checks' : ', offline'})\n`);
env.NODE_ENV === 'production' ? ok('NODE_ENV is production') : fail('NODE_ENV is not "production"', 'set NODE_ENV=production on Render (it turns on strict start-up checks and secure cookies)');

const db = host(env.DATABASE_URL || '');
if (!db) fail('DATABASE_URL is missing or not a valid address'); else {
  /\[YOUR-PASSWORD\]|YOUR-PASSWORD/i.test(env.DATABASE_URL) ? fail('DATABASE_URL still contains [YOUR-PASSWORD]', 'put your real database password in (special characters must be URL-encoded)') : ok('DATABASE_URL is set');
  ['localhost', '127.0.0.1'].includes(db.hostname) ? fail('DATABASE_URL points at this computer', 'use the Supabase transaction pooler string') : ok('DATABASE_URL is not local');
  /supabase\.com$/.test(db.hostname) && db.port !== '6543' ? warn('DATABASE_URL does not use port 6543', 'the running shop should use the Supabase TRANSACTION pooler (port 6543)') : ok('DATABASE_URL port looks right');
}
const mig = host(env.MIGRATE_DATABASE_URL || '');
if (!mig) /supabase\.com$/.test(db && db.hostname) ? warn('MIGRATE_DATABASE_URL is not set', 'set it to the Supabase SESSION pooler string (port 5432) so schema updates work') : ok('MIGRATE_DATABASE_URL not needed here'); else mig.port === '6543' ? fail('MIGRATE_DATABASE_URL uses port 6543', 'schema updates need the SESSION pooler (port 5432) or the direct connection') : ok('MIGRATE_DATABASE_URL is set');

const base = host(env.BASE_URL || '');
!base ? fail('BASE_URL is missing') : base.protocol !== 'https:' ? fail('BASE_URL is not https', 'emails and Paystack return links would be insecure/broken') : /localhost|127\.0\.0\.1/.test(base.hostname) ? fail('BASE_URL is localhost') : /\/$/.test(env.BASE_URL) ? fail('BASE_URL ends with a slash', 'remove the trailing /') : ok('BASE_URL is https: ' + base.origin);
if (base && !/onrender\.com$/.test(base.hostname)) env.TRUST_PROXY === '2' ? ok('TRUST_PROXY=2 (Cloudflare + Render)') : warn('TRUST_PROXY is ' + (env.TRUST_PROXY || 'not set') + ' but you use your own domain', 'if Cloudflare is in front of Render set TRUST_PROXY=2, then check the visitor IP in the logs (docs/DEPLOY.md)');
else if (base) (env.TRUST_PROXY || '1') === '1' ? ok('TRUST_PROXY=1 (Render address, no Cloudflare)') : warn('TRUST_PROXY is ' + env.TRUST_PROXY + ' on a Render address', 'normally 1 when Cloudflare is not in front');

const ps = env.PAYSTACK_SECRET_KEY || '';
if (!ps) (expect === 'live' ? fail : warn)('PAYSTACK_SECRET_KEY is not set', 'online payment would run in DEMO mode (no real money moves)');
else if (expect === 'live') /^sk_live_/.test(ps) ? ok('Paystack key is a LIVE key') : fail('Paystack key is not a live key', /^sk_test_/.test(ps) ? 'it is a TEST key: real customers could not pay' : 'it should start with sk_live_');
else /^sk_test_/.test(ps) ? ok('Paystack key is a TEST key') : fail('Paystack key is not a test key', /^sk_live_/.test(ps) ? 'it is a LIVE key on a server that should be using test mode' : 'it should start with sk_test_');
has('RESEND_API_KEY') ? ok('RESEND_API_KEY is set') : fail('RESEND_API_KEY is not set', 'customers would get no order emails');
/resend\.dev/i.test(env.MAIL_FROM || 'onboarding@resend.dev') ? fail('MAIL_FROM uses resend.dev or is not set', 'Resend only delivers resend.dev mail to your own address: verify your domain and use e.g. Shop-Beta <orders@yourdomain.com>') : ok('MAIL_FROM uses your own domain');
has('ADMIN_EMAIL') && has('ADMIN_PASSWORD') ? ((env.ADMIN_PASSWORD.length >= 12) ? ok('ADMIN_EMAIL and ADMIN_PASSWORD are set (12+ characters)') : fail('ADMIN_PASSWORD is shorter than 12 characters')) : has('ADMIN_SETUP_CODE') ? ok('ADMIN_SETUP_CODE is set (create the owner in /admin)') : warn('No ADMIN_EMAIL + ADMIN_PASSWORD and no ADMIN_SETUP_CODE', 'fine only if an administrator already exists in the database; otherwise the server will not start');
has('SUPABASE_URL') && has('SUPABASE_SERVICE_ROLE_KEY') ? ok('Photo storage (Supabase) is configured') : fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing', 'product photos and backups need Supabase Storage');
(env.STORAGE_DRIVER || '').toLowerCase() === 'local' ? fail('STORAGE_DRIVER=local', 'local disk is wiped on every Render deploy') : ok('STORAGE_DRIVER is not local');
env.SEED_DEMO === '0' ? ok('SEED_DEMO=0 (no demo products)') : warn('SEED_DEMO is not 0', 'on a new empty database the shop would create 60 DEMO products customers could order; set SEED_DEMO=0');
has('ALERT_EMAIL') || has('ALERT_WEBHOOK_URL') ? ok('Error alerts go somewhere') : warn('ALERT_EMAIL / ALERT_WEBHOOK_URL not set', 'nobody is told when something breaks');
env.BACKUPS === '0' ? warn('BACKUPS=0', 'nightly database backups are switched off') : ok('Nightly backups are on');
for (const [k, bad] of [['RATE_LIMITS', (v) => v === 'off'], ['CACHE_DISABLED', (v) => v === '1'], ['PAYSTACK_API_URL', (v) => !!v], ['RESEND_API_URL', (v) => !!v], ['LOG_REQUESTS', (v) => v === 'off']]) if (bad(env[k] || '')) fail(`${k} is set to a test/debug value (${k}=${env[k]})`, 'remove it from the production settings');
for (const k of ['WORKER']) if (env[k] === '0') warn(`${k}=0`, 'this instance will not send emails or confirm payments unless a separate worker runs');

async function onlineChecks() {
  console.log('\nOnline checks');
  const t = (p, ms = 15000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timed out')), ms))]);
  try {
    const { Client } = require('pg'); const u = new URL(env.MIGRATE_DATABASE_URL || env.DATABASE_URL); const mode = (env.PGSSL || u.searchParams.get('sslmode') || '').toLowerCase(); u.searchParams.delete('sslmode');
    const c = new Client({ connectionString: u.toString(), ssl: mode === 'disable' || ['localhost', '127.0.0.1'].includes(u.hostname) ? false : { rejectUnauthorized: mode === 'verify-full' } }); await t(c.connect());
    const v = (await c.query('SELECT version() v')).rows[0].v.split(' ').slice(0, 2).join(' '); ok('Database connects (' + v + ')');
    const m = await c.query("SELECT to_regclass('public.schema_migrations') t"); if (m.rows[0].t) { const n = (await c.query('SELECT COUNT(*)::int n FROM schema_migrations')).rows[0].n; const files = fs.readdirSync(__dirname + '/../migrations').filter((f) => f.endsWith('.sql')).length; n === files ? ok(`All ${n} migrations are applied`) : warn(`${n} of ${files} migrations applied`, 'the rest are applied automatically when the server starts (MIGRATE_ON_START)'); } else warn('Database has no tables yet', 'normal before the first start or the data import');
    await c.end();
  } catch (e) { fail('Database connection failed', String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, 'postgres://***@')); }
  if (ps) try { const r = await t(fetch('https://api.paystack.co/balance', { headers: { Authorization: 'Bearer ' + ps } })); r.status === 200 ? ok('Paystack accepts the secret key') : r.status === 401 ? fail('Paystack rejected the secret key (401)', 'check you copied the whole key and that it is the ' + expect + ' key') : warn('Paystack answered ' + r.status); } catch (e) { warn('Could not reach Paystack', e.message); }
  if (has('SUPABASE_URL') && has('SUPABASE_SERVICE_ROLE_KEY')) try {
    const r = await t(fetch(env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/bucket', { headers: { Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_SERVICE_ROLE_KEY } }));
    if (r.status !== 200) fail('Supabase Storage rejected the service key', 'HTTP ' + r.status + ': use the service_role key (Project Settings > API), not the anon key'); else { const b = await r.json(), want = env.SUPABASE_BUCKET || 'shop-images', bk = env.BACKUP_BUCKET || 'db-backups'; const img = b.find((x) => x.name === want); img ? (img.public ? ok(`Bucket "${want}" exists and is public`) : fail(`Bucket "${want}" is PRIVATE`, 'photos must be public: edit the bucket and turn Public on')) : warn(`Bucket "${want}" does not exist yet`, 'it is created at first start, or create it as PUBLIC in Supabase'); const bb = b.find((x) => x.name === bk); bb && bb.public ? fail(`Backup bucket "${bk}" is PUBLIC`, 'backups contain customer data: make it private immediately') : ok(bb ? `Backup bucket "${bk}" is private` : `Backup bucket "${bk}" will be created private at first start`); }
  } catch (e) { warn('Could not reach Supabase Storage', e.message); }
}
(async () => {
  if (online) await onlineChecks();
  const f = results.filter((r) => r.level === 'FAIL').length, w = results.filter((r) => r.level === 'WARN').length;
  console.log(`\n${f ? f + ' FAILED' : 'No failures'}, ${w} warning(s). ${f ? 'Fix the FAIL lines before going live.' : 'Read each WARN and decide.'}`); process.exit(f ? 1 : 0);
})();
