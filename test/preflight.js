'use strict';
// Tests for scripts/preflight.js (offline): a good production setup passes, each classic mistake is caught, and no secret is printed.
const { spawnSync } = require('child_process');
const assert = require('assert');
const path = require('path');
let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message.split('\n').slice(0, 8).join('\n       ')); } };
const GOOD = { NODE_ENV: 'production', DATABASE_URL: 'postgres://postgres.abc:S3cretPW@aws-0-eu-central-1.pooler.supabase.com:6543/postgres', MIGRATE_DATABASE_URL: 'postgres://postgres.abc:S3cretPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres', BASE_URL: 'https://shop.example.com', TRUST_PROXY: '2',
  PAYSTACK_SECRET_KEY: 'sk_live_abcdefghijklmnop123456', RESEND_API_KEY: 're_abcdefghijklmnopqrstuvwxyz', MAIL_FROM: 'Shop-Beta <orders@example.com>', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'a long strong password', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstu', SEED_DEMO: '0', ALERT_EMAIL: 'me@example.com' };
const run = (over = {}, args = []) => { const env = { PATH: process.env.PATH, ...GOOD, ...over }; for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]; const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'preflight.js'), ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const fails = (over, re, args) => { const r = run(over, args); assert.strictEqual(r.code, 1, 'should fail:\n' + r.out); assert.match(r.out.split('\n').filter((l) => /^  FAIL/.test(l)).join('\n'), re); };

test('a correct production setup passes with no failures and no warnings', () => { const r = run(); assert.strictEqual(r.code, 0, r.out); assert.ok(!/^  (FAIL|WARN)/m.test(r.out), r.out); });
test('never prints a password, key or token', () => { const r = run({ DATABASE_URL: 'postgres://u:S3cretPW@localhost:6543/x' }); for (const s of ['S3cretPW', 'abcdefghijklmnop123456', 'abcdefghijklmnopqrstuvwxyz', 'a long strong password', 'eyJhbGci']) assert.ok(!r.out.includes(s), 'leaked ' + s); });
test('catches: not production, local database, placeholder password, wrong ports', () => {
  fails({ NODE_ENV: '' }, /NODE_ENV/); fails({ DATABASE_URL: 'postgres://u:p@localhost:5432/shop' }, /points at this computer/); fails({ DATABASE_URL: 'postgres://u:[YOUR-PASSWORD]@aws-0.pooler.supabase.com:6543/postgres' }, /YOUR-PASSWORD/);
  fails({ MIGRATE_DATABASE_URL: GOOD.DATABASE_URL }, /MIGRATE_DATABASE_URL uses port 6543/);
});
test('catches: http or localhost or trailing-slash BASE_URL', () => { fails({ BASE_URL: 'http://shop.example.com' }, /not https/); fails({ BASE_URL: 'https://localhost' }, /localhost/); fails({ BASE_URL: 'https://shop.example.com/' }, /slash/); });
test('catches Paystack mistakes: test key on live, live key on staging, missing key', () => {
  fails({ PAYSTACK_SECRET_KEY: 'sk_test_abcdefghijklmnop123456' }, /not a live key/); fails({ PAYSTACK_SECRET_KEY: undefined }, /PAYSTACK_SECRET_KEY is not set/);
  fails({}, /not a test key/, ['--expect', 'test']); assert.strictEqual(run({ PAYSTACK_SECRET_KEY: 'sk_test_abcdefghijklmnop123456' }, ['--expect', 'test']).code, 0);
});
test('catches email mistakes: no Resend key, resend.dev sender', () => { fails({ RESEND_API_KEY: undefined }, /RESEND_API_KEY/); fails({ MAIL_FROM: 'Shop <onboarding@resend.dev>' }, /resend\.dev/); fails({ MAIL_FROM: undefined }, /resend\.dev|not set/); });
test('catches storage mistakes: no Supabase keys, local driver', () => { fails({ SUPABASE_URL: undefined }, /SUPABASE/); fails({ STORAGE_DRIVER: 'local' }, /local/); });
test('catches test/debug settings left on in production', () => { for (const [k, v] of [['RATE_LIMITS', 'off'], ['CACHE_DISABLED', '1'], ['PAYSTACK_API_URL', 'http://127.0.0.1:4999'], ['RESEND_API_URL', 'http://x'], ['LOG_REQUESTS', 'off']]) fails({ [k]: v }, new RegExp(k)); });
test('warns (without failing) about demo products, missing alerts, Cloudflare proxy count, backups off', () => {
  const r = run({ SEED_DEMO: undefined, ALERT_EMAIL: undefined, TRUST_PROXY: '1', BACKUPS: '0' }); assert.strictEqual(r.code, 0, r.out); for (const re of [/WARN .*SEED_DEMO/, /WARN .*ALERT_EMAIL/, /WARN .*TRUST_PROXY/, /WARN .*BACKUPS=0/]) assert.match(r.out, re);
});
test('a short admin password is a failure; a setup code alone is accepted', () => { fails({ ADMIN_PASSWORD: 'short' }, /shorter than 12/); const r = run({ ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined, ADMIN_SETUP_CODE: 'a-setup-code' }); assert.strictEqual(r.code, 0, r.out); });
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
