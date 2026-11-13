'use strict';
// Launch-readiness checks. `npm run preflight` runs them against the settings of the machine it runs on (put the same environment variables there
// that your live service has, or run it from Render's Shell tab). Each result is PASS, WARN (works but you should decide) or FAIL (do not launch).
const SECRET_KEYS = /^(sk_live_|sk_test_)/;
const R = (level, name, msg, fix) => ({ level, name, msg, fix: fix || '' });

// Part 1: only looks at the settings. No network.
function checkEnv(env) {
  const out = [];
  const prod = env.NODE_ENV === 'production';
  out.push(prod ? R('PASS', 'NODE_ENV', 'production') : R('FAIL', 'NODE_ENV', `is "${env.NODE_ENV || ''}"`, 'Set NODE_ENV=production. Without it, demo payments and the open admin setup are not locked down.'));
  const base = env.BASE_URL || '';
  if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) out.push(R('FAIL', 'BASE_URL', `is "${base}"`, 'Set BASE_URL to your public https address with no trailing slash, e.g. https://www.yourshop.com. Emails and Paystack return links use it.'));
  else if (/\/$/.test(base)) out.push(R('FAIL', 'BASE_URL', 'has a trailing slash', 'Remove the final "/".'));
  else if (/onrender\.com/.test(base)) out.push(R('WARN', 'BASE_URL', base + ' (Render address)', 'Fine for a trial. Use your own domain before real customers.'));
  else out.push(R('PASS', 'BASE_URL', base));
  const db = env.DATABASE_URL || '';
  if (!db || /127\.0\.0\.1|localhost/.test(db)) out.push(R('FAIL', 'DATABASE_URL', 'missing or local', 'Use the Supabase connection string.'));
  else {
    out.push(/:6543(\/|\?|$)/.test(db) ? R('PASS', 'DATABASE_URL', 'Supabase transaction pooler (port 6543)') : R('WARN', 'DATABASE_URL', 'not the transaction pooler (port 6543)', 'Fine with one instance. With two instances prefer the pooler string so connections are shared.'));
    const inst = Number(env.INSTANCES) || 2, per = Number(env.DB_POOL_MAX) || 10;
    out.push(inst * per > 60 ? R('WARN', 'DB_POOL_MAX', `${inst} instances x ${per} = ${inst * per} connections`, 'Keep the total under your Supabase plan\'s pooler limit (lower DB_POOL_MAX).') : R('PASS', 'DB_POOL_MAX', `${inst} instances x ${per} = ${inst * per} connections`));
  }
  out.push(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? R('PASS', 'Photos', 'Supabase Storage configured') : R('FAIL', 'Photos', 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing', 'Without them the server will not start in production (photos would vanish on restart).'));
  const key = env.PAYSTACK_SECRET_KEY || '';
  out.push(!key ? R('FAIL', 'Paystack', 'no PAYSTACK_SECRET_KEY', 'Online card payment is OFF without it (demo payments are blocked in production). Add your key.')
    : !SECRET_KEYS.test(key) ? R('FAIL', 'Paystack', 'key does not start with sk_live_ or sk_test_', 'Use the SECRET key from Paystack > Settings > API Keys, not the public key.')
    : key.startsWith('sk_test_') ? R('WARN', 'Paystack', 'TEST key', 'Fine for rehearsal. Switch to the sk_live_ key to take real money.') : R('PASS', 'Paystack', 'live key'));
  out.push(env.RESEND_API_KEY && env.MAIL_FROM && /@/.test(env.MAIL_FROM) ? R('PASS', 'Email', 'Resend configured') : R('WARN', 'Email', 'RESEND_API_KEY or MAIL_FROM missing', 'Customers will not get order emails. Add both and verify your domain in Resend.'));
  out.push(env.HANDOVER_SECRET && env.HANDOVER_SECRET.length >= 24 ? R('PASS', 'HANDOVER_SECRET', 'set') : R('WARN', 'HANDOVER_SECRET', env.HANDOVER_SECRET ? 'shorter than 24 characters' : 'not set', 'The app then keeps a generated secret in the database. Better to set a long random value yourself.'));
  out.push(env.GEOAPIFY_API_KEY ? R('PASS', 'Maps', 'Geoapify key set') : R('WARN', 'Maps', 'no GEOAPIFY_API_KEY', 'Checkout still works, but distance and delivery-time quotes fall back to rough straight-line estimates.'));
  out.push(env.BACKUP_PASSPHRASE && env.BACKUP_PASSPHRASE.length >= 16 ? R('PASS', 'Backups', 'encrypted (passphrase set)') : R('WARN', 'Backups', env.BACKUP_PASSPHRASE ? 'passphrase shorter than 16 characters' : 'no BACKUP_PASSPHRASE', 'Backups hold customer data. Set a long passphrase and keep a copy away from Render.'));
  out.push(env.BACKUP_ENABLED === '0' ? R('FAIL', 'Backups', 'switched off (BACKUP_ENABLED=0)', 'Remove that setting.') : R('PASS', 'Backups', 'nightly schedule on'));
  const adminOk = env.ADMIN_EMAIL && env.ADMIN_PASSWORD, code = env.SETUP_CODE;
  out.push(adminOk ? (String(env.ADMIN_PASSWORD).length >= 12 ? R('PASS', 'Admin account', 'created from ADMIN_EMAIL / ADMIN_PASSWORD at start') : R('FAIL', 'Admin account', 'ADMIN_PASSWORD shorter than 12', 'Use 12+ characters.'))
    : code ? R('PASS', 'Admin account', 'first-run setup page protected by SETUP_CODE')
    : R('WARN', 'Admin account', 'neither ADMIN_EMAIL+ADMIN_PASSWORD nor SETUP_CODE set', 'Fine only if an admin account already exists. Otherwise nobody can create one in production.'));
  out.push(env.TRUST_PROXY === '0' ? R('FAIL', 'TRUST_PROXY', 'is 0', 'Render and Cloudflare sit in front of the app. Remove this setting or set it to 1, or every visitor looks like one IP.') : R('PASS', 'TRUST_PROXY', 'on'));
  out.push(env.ALLOW_DEMO_PAYMENTS ? R('FAIL', 'ALLOW_DEMO_PAYMENTS', 'is set', 'Remove it from the live service.') : R('PASS', 'Demo payments', 'off'));
  const testOnly = ['ALLOW_LOCAL_UPLOADS', 'JOB_BACKOFF_SECONDS', 'PAYSTACK_API_URL', 'RESEND_API_URL', 'GEO_API_URL', 'GEO_DOWN_PAUSE_MS'].filter((k) => env[k]);
  if (env.STORAGE_DRIVER === 'local') testOnly.push('STORAGE_DRIVER=local');
  out.push(testOnly.length ? R('FAIL', 'Test-only settings', testOnly.join(', ') + ' set', 'These exist for tests (they redirect payments, email or photos). Remove them from the live service.') : R('PASS', 'Test-only settings', 'none set'));
  out.push(env.RATE_LIMIT_MULTIPLIER ? R('FAIL', 'RATE_LIMIT_MULTIPLIER', 'is set (test-only setting)', 'Remove it from the live service. It weakens every rate limit.') : R('PASS', 'Rate limits', 'normal'));
  out.push(env.SEED_DEMO === '0' ? R('PASS', 'Catalogue', 'starts empty (SEED_DEMO=0)') : R('WARN', 'Catalogue', 'SEED_DEMO is not 0', 'On a brand-new empty database the app adds demo products. Set SEED_DEMO=0 before the first start, then add your real products.'));
  return out;
}

// Part 2: talks to the database and Supabase Storage.
async function checkLive(env, { get, health } = {}) {
  const out = [];
  try { await health(); out.push(R('PASS', 'Database', 'reachable')); } catch (e) { out.push(R('FAIL', 'Database', 'cannot connect: ' + e.message, 'Check DATABASE_URL, the password, and DATABASE_SSL / DATABASE_CA (see DEPLOY.md, "database certificate").')); return out; }
  try {
    const m = await get("SELECT COUNT(*) n FROM schema_migrations"); out.push(m.n > 0 ? R('PASS', 'Migrations', m.n + ' applied') : R('FAIL', 'Migrations', 'none applied', 'Start the app once, or run `npm run migrate`.'));
    const a = await get("SELECT COUNT(*) n FROM users WHERE role='admin'"); out.push(a.n > 0 ? R('PASS', 'Admin user', 'exists') : R('WARN', 'Admin user', 'none yet', 'Create one with SETUP_CODE or ADMIN_EMAIL/ADMIN_PASSWORD.'));
    const p = await get('SELECT COUNT(*) n FROM products WHERE active=1'); out.push(p.n > 0 ? R('PASS', 'Products', p.n + ' active') : R('WARN', 'Products', 'none active', 'Add or import products before launch.'));
    const bk = await get('SELECT MAX(created) t FROM backup_log WHERE ok=1'); out.push(bk && bk.t ? R('PASS', 'Last backup', new Date(bk.t * 1000).toISOString()) : R('WARN', 'Last backup', 'none yet', 'Press "Back up now" in Admin > Settings and confirm it succeeds.'));
  } catch (e) { out.push(R('FAIL', 'Database tables', e.message, 'Run `npm run migrate`.')); }
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const bucket = async (name, wantPublic) => {
      try {
        const r = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(name)}`, { headers: { Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_SERVICE_ROLE_KEY }, signal: AbortSignal.timeout(10000) });
        if (r.status === 404 || r.status === 400) return out.push(R('FAIL', 'Bucket ' + name, 'does not exist', `Supabase > Storage > New bucket > "${name}"${wantPublic ? ', tick "Public bucket"' : ', leave "Public" OFF'}.`));
        if (!r.ok) return out.push(R('WARN', 'Bucket ' + name, 'could not check (HTTP ' + r.status + ')', 'Check SUPABASE_URL and the service role key.'));
        const j = await r.json();
        if (typeof j.public !== 'boolean') return out.push(R('WARN', 'Bucket ' + name, 'exists (could not read its public setting)'));
        out.push(j.public === wantPublic ? R('PASS', 'Bucket ' + name, wantPublic ? 'exists and is public' : 'exists and is private')
          : R('FAIL', 'Bucket ' + name, wantPublic ? 'is PRIVATE, photos will not show' : 'is PUBLIC, anyone could download your backups', wantPublic ? 'Edit the bucket and turn "Public" on.' : 'Edit the bucket and turn "Public" off, or delete and recreate it.'));
      } catch (e) { out.push(R('WARN', 'Bucket ' + name, 'could not check: ' + e.message)); }
    };
    await bucket(env.SUPABASE_BUCKET || 'product-images', true);
    await bucket(env.SUPABASE_BACKUP_BUCKET || 'backups', false);
  }
  return out;
}

const summary = (results) => ({ fail: results.filter((r) => r.level === 'FAIL').length, warn: results.filter((r) => r.level === 'WARN').length, pass: results.filter((r) => r.level === 'PASS').length });
module.exports = { checkEnv, checkLive, summary };
