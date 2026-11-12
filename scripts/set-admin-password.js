'use strict';
// Recovery: set (or create) the administrator from the command line when the password is lost.
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long new password' DATABASE_URL=... node scripts/set-admin-password.js
// Ends every session of that account. The password is read from the environment so it never lands in shell history flags or logs.
const { run, get, close } = require('../lib/db');
const A = require('../lib/auth');
const boot = require('../lib/bootstrap-admin');
(async () => {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = String(process.env.ADMIN_PASSWORD || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid email address.');
  if (pw.length < boot.MIN_ADMIN_PASSWORD) throw new Error(`ADMIN_PASSWORD must be at least ${boot.MIN_ADMIN_PASSWORD} characters.`);
  const hash = await A.hashPassword(pw), admin = await get("SELECT id FROM users WHERE role='admin'");
  if (admin) { await run('UPDATE users SET email=?, password=? WHERE id=?', email, hash, admin.id); await A.dropUserSessions(admin.id); console.log('Administrator password updated for ' + email + '. All their sessions were ended.'); }
  else { await run("INSERT INTO users (name,email,phone,password,role,created) VALUES ('Administrator',?,'',?,'admin',?)", email, hash, Date.now()); console.log('Administrator created for ' + email + '.'); }
  await close();
})().catch((e) => { console.error(e.message); process.exit(1); });
