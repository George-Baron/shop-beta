'use strict';
// npm run preflight        launch-readiness check (see DEPLOY.md, step 9). Exit code 1 if anything FAILs.
// npm run preflight -- --offline   only check settings, do not connect to the database or Supabase.
const { checkEnv, checkLive, summary } = require('../lib/preflight');
(async () => {
  const offline = process.argv.includes('--offline');
  let results = checkEnv(process.env);
  if (!offline) { const db = require('../lib/db'); try { results = results.concat(await checkLive(process.env, db)); } finally { await db.close().catch(() => {}); } }
  const icon = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };
  for (const r of results) console.log(`${icon[r.level]}  ${r.name}: ${r.msg}${r.fix && r.level !== 'PASS' ? '\n        -> ' + r.fix : ''}`);
  const s = summary(results);
  console.log(`\n${s.pass} ok, ${s.warn} to decide, ${s.fail} must fix.${s.fail ? ' Do not launch yet.' : s.warn ? ' You can launch once you have decided on each WARN.' : ' Ready to launch.'}`);
  process.exit(s.fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
