'use strict';
// Keeps the documentation honest: every environment variable the code reads must be in .env.example and docs/DEPLOY.md,
// and no secret may be committed. Needs no database.   npm run test:docs
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').slice(0, 12).join('\n       ')); } };
const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : /\.js$/.test(d.name) ? [path.join(dir, d.name)] : []);
const vars = new Set(); for (const f of ['server.js', ...files('lib'), ...files('routes'), ...files('scripts')]) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) vars.add(m[1]);
vars.add('RATE_IP_CHECKOUT'); vars.add('RATE_IP_LOGIN'); // built from a pattern in lib/auth.js (RATE_IP_<NAME>)
const ignore = new Set(['HOME', 'PATH', 'TEMP', 'TMP']);
const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), deploy = fs.existsSync(path.join(ROOT, 'docs/DEPLOY.md')) ? fs.readFileSync(path.join(ROOT, 'docs/DEPLOY.md'), 'utf8') : '';

test('every environment variable the code reads is in .env.example', () => { const miss = [...vars].filter((v) => !ignore.has(v) && !new RegExp('^#? ?' + v + '=', 'm').test(example)); assert.deepStrictEqual(miss, []); });
test('every environment variable the code reads is explained in docs/DEPLOY.md', () => { const miss = [...vars].filter((v) => !ignore.has(v) && !deploy.includes('`' + v + '`')); assert.deepStrictEqual(miss, []); });
test('every variable listed in .env.example is still used by the code (no stale settings)', () => { const listed = [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]); const stale = listed.filter((v) => !vars.has(v)); assert.deepStrictEqual(stale, []); });
test('.env is ignored by git and no secrets are committed', () => {
  assert.ok(/^\.env$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')), '.env must be in .gitignore');
  let tracked = []; try { tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return; }
  assert.ok(!tracked.some((f) => /^\.env($|\.(?!example))/.test(f)) && !tracked.some((f) => /\.db$|^data\//.test(f)), 'no .env, database or data files tracked');
  const bad = []; const rx = [[/sk_live_[A-Za-z0-9]{12,}/, 'Paystack live key'], [/pk_live_[A-Za-z0-9]{12,}/, 'Paystack live public key'], [/\bre_[A-Za-z0-9_]{20,}/, 'Resend key'], [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT (Supabase key)'], [/postgres(ql)?:\/\/[^:\s\/]+:(?!shop@|postgres@|\[|YOUR|password|\*+|<)[^@\s]{6,}@[a-z0-9.-]*(supabase|render|pooler)[a-z0-9.-]*/i, 'real database password']];
  for (const f of tracked) { if (/package-lock|\.(png|jpg|jpeg|gif|webp|ico|docx|xlsx)$/i.test(f) || f.startsWith('docs/load-results')) continue; let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; } for (const [r, n] of rx) if (r.test(t)) bad.push(`${f}: looks like a ${n}`); }
  assert.deepStrictEqual(bad, []);
});
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
