'use strict';
// Employees and their roles. A role is a list of permissions like "orders:view" / "orders:edit" ("edit" includes "view").
// The owner (users.role = 'admin') can do everything. An employee (users.role = 'staff') can use only the modules their role allows,
// and never the owner-only areas: staff accounts, settings, backups, audit log, the pharmacy desk.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const A = require('./auth');
const PW = require('./passwords');
const { fail, str, int, isEmail } = S;

const MODULES = [
  ['orders', 'Orders', 'See and process customer orders'],
  ['catalog', 'Catalogue', 'Products, categories, import and export, reviews, product approvals'],
  ['partners', 'Partner stores', 'Partner accounts and their applications'],
  ['wholesale', 'Wholesale', 'Wholesale buyers, quotations and wholesale orders'],
  ['warehouse', 'Wholesale warehouse', 'Wholesale warehouse stock: receive goods, adjustments, stock movements'],
  ['rfq', 'Requests for quotation', 'Wholesale RFQs and the quotations sent for them'],
  ['customers', 'Customers', 'Customer accounts, messages and newsletter list'],
  ['delivery', 'Delivery', 'Pickup points, riders and deliveries'],
  ['marketing', 'Marketing', 'Coupons and abandoned carts'],
  ['finance', 'Finance', 'Payments, partner payouts and financial reports'],
  ['reports', 'Reports', 'Commercial reports and analytics'],
  ['trade', 'Global Trade', 'Imports, exports, international shipping, customs, suppliers and exchange rates'],
];
const ALL = MODULES.flatMap(([k]) => [k + ':view', k + ':edit']);
const V = (...m) => m.map((x) => x + ':view'), E = (...m) => m.flatMap((x) => [x + ':view', x + ':edit']);
const DEFAULT_ROLES = [
  ['Commercial Manager', 'Runs commercial operations: everything except owner-only settings.', [...E('orders', 'catalog', 'partners', 'wholesale', 'rfq', 'customers', 'delivery', 'marketing'), ...V('finance'), ...E('reports')]],
  ['Commercial Officer', 'Manages partner accounts and the products partners submit.', [...E('partners', 'catalog'), ...V('orders', 'wholesale', 'rfq', 'customers')]],
  ['Sales Representative', 'Handles orders and customers.', [...E('orders'), ...V('catalog', 'customers', 'wholesale', 'rfq')]],
  ['Partner Relationship Officer', 'Looks after partner stores.', [...E('partners'), ...V('orders', 'catalog')]],
  ['Wholesale Sales Officer', 'Manages wholesale buyers, RFQs and quotations; can see warehouse stock.', [...E('wholesale', 'rfq'), ...V('catalog', 'orders', 'customers', 'warehouse')]],
  ['Catalogue Manager', 'Reviews and approves product uploads; keeps the catalogue clean.', [...E('catalog'), ...V('partners', 'reports')]],
  ['Order Processing Officer', 'Processes and dispatches orders.', [...E('orders', 'delivery'), ...V('customers', 'catalog')]],
  ['Finance Officer', 'Invoices, payments, payouts and financial reports.', [...E('finance'), ...V('orders', 'wholesale', 'rfq', 'partners', 'reports', 'warehouse')]],
  ['Warehouse Manager', 'Runs the wholesale warehouse: receives stock, adjusts it, sees every movement.', [...E('warehouse'), ...V('wholesale', 'rfq', 'orders', 'catalog', 'reports')]],
  ['Inventory Officer', 'Receives and counts wholesale stock.', [...E('warehouse'), ...V('catalog')]],
  ['Dispatch Officer', 'Sends out wholesale orders; sees warehouse stock.', [...E('delivery'), ...V('warehouse', 'wholesale', 'orders')]],
];
async function seedRoles() {
  if ((await get('SELECT COUNT(*) n FROM staff_roles')).n > 0) return;
  for (const [name, description, perms] of DEFAULT_ROLES) await run('INSERT INTO staff_roles (name,description,perms,builtin,created) VALUES (?,?,?,1,?) ON CONFLICT (name) DO NOTHING', name, description, JSON.stringify(perms), now());
}

const parsePerms = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((p) => ALL.includes(p)) : null; } catch { return null; } };
const cleanPerms = (a) => { if (!Array.isArray(a)) fail(400, 'Permissions must be a list.'); const out = [...new Set(a.map(String))]; if (out.some((p) => !ALL.includes(p))) fail(400, 'One of the permissions is not recognised.'); for (const p of out) if (p.endsWith(':edit') && !out.includes(p.replace(':edit', ':view'))) out.push(p.replace(':edit', ':view')); return out; };

// The list of permissions for a signed-in person: ['*'] for the owner, a list for an employee, [] for anyone else.
async function permsOf(u) {
  if (!u) return [];
  if (u.role === 'admin') return ['*'];
  if (u.role !== 'staff') return [];
  const own = u.staff_perms ? parsePerms(u.staff_perms) : null;
  if (own) return own;
  const r = u.staff_role_id ? await get('SELECT perms FROM staff_roles WHERE id=?', u.staff_role_id) : null;
  return r ? parsePerms(r.perms) || [] : [];
}
const allows = (perms, module, write) => perms.includes('*') || perms.includes(module + (write ? ':edit' : ':view'));

/* ---- which module does a request to /api/admin/... belong to? Anything not listed is for the owner only. ---- */
const RULES = [
  [/^\/(dashboard|notifications)(\/|$)/, 'any'],
  [/^\/orders(\/|$)/, ['orders']],
  [/^\/vendors\/review\/products/, ['catalog', 'partners']],
  [/^\/vendors\/payables$/, ['finance', 'partners']],
  [/^\/vendors\/\d+\/payouts$/, ['finance']],
  [/^\/vendors(\/|$)/, ['partners']],
  [/^\/wholesale\/settings/, null],
  [/^\/wholesale\/quotes\/[^/]+\/transfer$/, ['finance', 'wholesale']],
  [/^\/wholesale\/quotes/, ['wholesale', 'finance'], 'read-finance'],
  [/^\/wholesale(\/|$)/, ['wholesale']],
  [/^\/rfq(\/|$)/, ['rfq']],
  [/^\/commercial\/partners\/\d+\/officer$/, ['partners']],
  [/^\/commercial\/reports\/(partner-performance|retail-sales)/, ['reports', 'finance']],   // money reports
  [/^\/commercial\/reports\/employee-performance/, ['reports']],
  [/^\/commercial\/schedules/, ['reports']],
  [/^\/commercial\/reports/, ['reports', 'partners', 'rfq']],
  [/^\/commercial\/(overview|officers)$/, ['partners', 'rfq']],
  [/^\/warehouse\/orders\/[^/]+\/(dispatch|delivered|failed)$/, ['delivery', 'warehouse']],   // the dispatch officer sends goods out; warehouse staff can too
  [/^\/warehouse\/reports\/(sales|buyers|invoices|receivables)$/, ['reports', 'finance']],        // money reports
  [/^\/warehouse\/invoices\//, ['finance', 'warehouse', 'wholesale']],
  [/^\/warehouse(\/|$)/, ['warehouse']],
  [/^\/(products|categories|stores|upload|reviews|catalog)(\/|$)/, ['catalog']],
  [/^\/(customers|messages|newsletter)(\/|$)/, ['customers']],
  [/^\/(coupons|abandoned|announce)(\/|$)/, ['marketing']],
  [/^\/(partners|riders|deliveries|rider-ops)(\/|$)/, ['delivery']],
  [/^\/reports(\/|$)/, ['reports']],
  [/^\/trade\/(suppliers\/\d+\/bank|payments|reports\/(payment_reconciliation|fx_differences))/, ['finance']],   // money and bank details need the Finance permission, not just Trade
  [/^\/trade(\/|$)/, ['trade']],
];
function moduleFor(path, write) {
  for (const [re, mods, mode] of RULES) {
    if (!re.test(path)) continue;
    if (mods === 'any') return 'any';
    if (!mods) return null;
    return mode === 'read-finance' && !write ? mods : mode === 'read-finance' ? ['wholesale'] : mods;
  }
  return null;
}
// Express middleware for /api/admin: the owner passes; an employee passes only where a permission covers the request.
async function gate(req, res, next) {
  try {
    if (req.user.role === 'admin') return next();
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method), mods = moduleFor(req.path, write);
    if (mods === 'any') return next();
    const perms = await permsOf(req.user);
    if (mods && mods.some((m) => allows(perms, m, write))) return next();
    throw new S.HttpError(403, 'Your role does not include this. Ask the administrator if you need access.');
  } catch (e) { next(e); }
}

// What the sign-in and /me answers carry for back-office people, so the screens can show only the modules they may use.
async function decorate(pub, u) {
  if (!u || (u.role !== 'admin' && u.role !== 'staff')) return pub;
  const r = u.staff_role_id ? await get('SELECT name FROM staff_roles WHERE id=?', u.staff_role_id) : null;
  return { ...pub, perms: await permsOf(u), staff_role: u.role === 'admin' ? 'Super Administrator' : (r ? r.name : ''), username: u.username || '' };
}

/* ---- roles ---- */
async function listRoles() {
  const rows = await all('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.staff_role_id=r.id) AS members FROM staff_roles r ORDER BY r.builtin DESC, r.id');
  return rows.map((r) => ({ id: Number(r.id), name: r.name, description: r.description, perms: parsePerms(r.perms) || [], builtin: !!Number(r.builtin), members: Number(r.members) }));
}
async function saveRole(id, b) {
  const name = str(b.name, 60), description = str(b.description, 200); if (!name) fail(400, 'A role needs a name.');
  const perms = JSON.stringify(cleanPerms(b.perms || []));
  try {
    if (id) { const r = await run('UPDATE staff_roles SET name=?, description=?, perms=? WHERE id=?', name, description, perms, id); if (!r.changes) fail(404, 'Role not found.'); return id; }
    return Number((await run('INSERT INTO staff_roles (name,description,perms,builtin,created) VALUES (?,?,?,0,?)', name, description, perms, now())).lastInsertRowid);
  } catch (e) { if (e && e.code === '23505') fail(409, 'A role with that name already exists.'); throw e; }
}
async function deleteRole(id) {
  const r = await get('SELECT * FROM staff_roles WHERE id=?', id); if (!r) fail(404, 'Role not found.');
  if (Number(r.builtin)) fail(400, 'The standard roles cannot be deleted. Edit their permissions instead.');
  if ((await get('SELECT COUNT(*) n FROM users WHERE staff_role_id=?', id)).n > 0) fail(409, 'Some employees still have this role. Move them to another role first.');
  await run('DELETE FROM staff_roles WHERE id=?', id);
}

/* ---- employees ---- */
const tempPassword = () => { const C = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(12), (b) => C[b % C.length]).join('') + '#7'; };
const publicStaff = (u, r) => ({ id: Number(u.id), name: u.name, email: u.email, username: u.username || '', phone: u.phone, super: u.role === 'admin', role_id: u.staff_role_id ? Number(u.staff_role_id) : null, role: u.role === 'admin' ? 'Super Administrator' : (r ? r.name : ''), custom_perms: u.staff_perms ? parsePerms(u.staff_perms) : null, active: u.active !== 0, last_login: u.last_login ? Number(u.last_login) : null, created: Number(u.created) });
async function listStaff() {
  const rows = await all("SELECT u.*, r.name AS rname FROM users u LEFT JOIN staff_roles r ON r.id=u.staff_role_id WHERE u.role IN ('staff','admin') ORDER BY (u.role='admin') DESC, u.id");
  return rows.map((u) => publicStaff(u, u.rname ? { name: u.rname } : null));
}
const cleanUsername = (s) => { const u = str(s, 30).toLowerCase(); if (!u) return null; if (!/^[a-z0-9._-]{3,30}$/.test(u)) fail(400, 'A username uses 3 to 30 letters, digits, dots, dashes or underscores.'); return u; };
const INVITE_SECS = 72 * 3600;
// Emails the employee a link to choose their own password (valid 72 hours). Returns the link only when email is not set up,
// so the owner can pass it on by hand; with email on, nobody but the employee ever sees it.
async function sendInvite(u, by) {
  const token = crypto.randomBytes(32).toString('hex');
  await run('DELETE FROM resets WHERE user_id=?', u.id);
  await run('INSERT INTO resets (token,user_id,expires) VALUES (?,?,?)', A.sha(token), u.id, now() + INVITE_SECS);
  const link = `${S.BASE_URL}/forgot?token=${token}&invite=1`;
  const St = await S.getSettings(), first = String(u.name || '').split(' ')[0];
  if (!S.mailOn) return { emailed: false, invite_link: link };
  await S.queueMail(u.email, `You have been added to ${St.store_name}`, S.mailWrap(St, `<p>Hi ${S.esc(first)}, ${S.esc(by || 'the store owner')} has created a staff account for you.</p><p>Your sign-in email is <b>${S.esc(u.email)}</b>. Use the button below to choose your password. The link works for 3 days and only once.</p><p><a href="${S.esc(link)}" style="display:inline-block;background:#16181d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Choose my password</a></p><p>If you were not expecting this, ignore this email and nothing happens.</p>`));
  return { emailed: true };
}
async function resendInvite(id, actor) {
  const u = await get("SELECT * FROM users WHERE id=? AND role IN ('staff','admin')", id); if (!u) fail(404, 'Employee not found.');
  if (u.role === 'admin' && Number(actor.id) !== Number(id)) fail(403, 'Administrators change their own password.');
  if (u.active === 0) fail(400, 'This account is switched off.');
  return sendInvite(u, actor.name);
}
async function createStaff(b, by) {
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30), username = cleanUsername(b.username);
  if (!name || !isEmail(email)) fail(400, 'An employee needs a name and a valid email.');
  const sup = !!b.super; let roleId = null;
  if (!sup) { roleId = int(b.role_id); if (!roleId || !(await get('SELECT 1 x FROM staff_roles WHERE id=?', roleId))) fail(400, 'Please choose a role.'); }
  const perms = b.perms ? JSON.stringify(cleanPerms(b.perms)) : null;
  const invite = (b.invite === true || (b.invite !== false && S.mailOn)) && !(typeof b.password === 'string' && b.password);
  let password = typeof b.password === 'string' && b.password ? b.password : '', generated = false;
  if (!password) { password = tempPassword(); generated = true; }
  { const bad = PW.check(password, { email, name, min: PW.STAFF_MIN }); if (bad) fail(400, bad); }
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'That email already has an account.');
  if (username && (await get('SELECT 1 x FROM users WHERE username=?', username))) fail(409, 'That username is taken.');
  const id = Number((await run('INSERT INTO users (name,email,phone,password,role,username,staff_role_id,staff_perms,created) VALUES (?,?,?,?,?,?,?,?,?)', name, email, phone, await A.hashPassword(password), sup ? 'admin' : 'staff', username, roleId, sup ? null : perms, now())).lastInsertRowid);
  if (invite) { const u = await get('SELECT * FROM users WHERE id=?', id); const r = await sendInvite(u, by); return { id, invited: true, ...r, note: r.emailed ? 'An email with a link to choose a password is on its way to ' + email + '.' : 'Email is not set up yet, so nothing was sent. Give this link to ' + name + ' (valid 3 days).', by }; }
  return { id, temp_password: generated ? password : undefined, note: 'Give this person their sign-in details. They can change the password under their account.', by };
}
async function updateStaff(id, b, actor) {
  const u = await get("SELECT * FROM users WHERE id=? AND role IN ('staff','admin')", id); if (!u) fail(404, 'Employee not found.');
  const isSelf = Number(actor.id) === Number(id);
  const sets = [], args = [], put = (c, v) => { sets.push(c + '=?'); args.push(v); };
  if ('name' in b) { const n = str(b.name, 80); if (!n) fail(400, 'A name is needed.'); put('name', n); }
  if ('phone' in b) put('phone', str(b.phone, 30));
  if ('username' in b) { const un = cleanUsername(b.username); if (un && (await get('SELECT 1 x FROM users WHERE username=? AND id<>?', un, id))) fail(409, 'That username is taken.'); put('username', un); }
  if (u.role === 'staff') {
    if ('role_id' in b) { const rid = int(b.role_id); if (!rid || !(await get('SELECT 1 x FROM staff_roles WHERE id=?', rid))) fail(400, 'Please choose a role.'); put('staff_role_id', rid); }
    if ('perms' in b) put('staff_perms', b.perms === null ? null : JSON.stringify(cleanPerms(b.perms)));
  }
  if ('active' in b) {
    const on = b.active ? 1 : 0;
    if (!on && isSelf) fail(400, 'You cannot switch off your own account.');
    if (!on && u.role === 'admin' && (await get("SELECT COUNT(*) n FROM users WHERE role='admin' AND active<>0 AND id<>?", id)).n < 1) fail(400, 'There must be at least one active administrator.');
    put('active', on);
  }
  if (!sets.length) return;
  await run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...args, id);
  if ('active' in b && !b.active) await A.dropUserSessions(id);
  if ('role_id' in b || 'perms' in b) await A.dropUserSessions(id); // permissions changed: sign them in again so nothing stale lingers
}
async function resetPassword(id, actor) {
  const u = await get("SELECT * FROM users WHERE id=? AND role IN ('staff','admin')", id); if (!u) fail(404, 'Employee not found.');
  if (u.role === 'admin' && Number(actor.id) !== Number(id)) fail(403, 'Administrators change their own password.');
  const pw = tempPassword(); await run('UPDATE users SET password=? WHERE id=?', await A.hashPassword(pw), id); await A.dropUserSessions(id);
  return { temp_password: pw };
}
async function loginHistory(id) { return (await all('SELECT ok, ip, agent, created FROM login_log WHERE user_id=? ORDER BY id DESC LIMIT 100', id)).map((l) => ({ ok: !!l.ok, ip: l.ip, agent: l.agent, created: Number(l.created) })); }
async function activity(id) { return all('SELECT method, path, status, detail, created FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT 200', id); }
async function logLogin(user, who, ok, req) {
  try { await run('INSERT INTO login_log (user_id,who,ok,ip,agent,created) VALUES (?,?,?,?,?,?)', user ? user.id : null, str(who, 120), ok ? 1 : 0, str(req.clientIp, 60), str(req.headers['user-agent'], 160), now()); if (ok && user) await run('UPDATE users SET last_login=? WHERE id=?', now(), user.id); } catch (e) { console.error('Login log failed:', e.message); }
}
async function performance(days) {
  const since = now() - Math.max(1, Math.min(365, int(days, 30))) * 86400;
  const rows = await all("SELECT id, name, role FROM users WHERE role IN ('staff','admin') ORDER BY id");
  const out = [];
  for (const u of rows) {
    const cnt = async (sql, ...a) => Number((await get(sql, ...a)).n);
    out.push({
      id: Number(u.id), name: u.name, role: u.role === 'admin' ? 'Super Administrator' : 'Employee',
      actions: await cnt("SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND created>=? AND method<>'GET'", u.id, since),
      orders_handled: await cnt("SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND created>=? AND method='PUT' AND path LIKE '/api/admin/orders/%'", u.id, since),
      products_reviewed: await cnt("SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND created>=? AND method='POST' AND path LIKE '/api/admin/vendors/review/products/%'", u.id, since),
      rfqs_assigned: await cnt('SELECT COUNT(*) n FROM rfqs WHERE assigned_to=? AND assigned_at>=?', u.id, since),
      quotations_sent: await cnt('SELECT COUNT(*) n FROM rfqs WHERE assigned_to=? AND quoted_at>=?', u.id, since),
      rfqs_converted: await cnt("SELECT COUNT(*) n FROM rfqs WHERE assigned_to=? AND status IN ('converted','completed') AND updated>=?", u.id, since),
      logins: await cnt('SELECT COUNT(*) n FROM login_log WHERE user_id=? AND ok=1 AND created>=?', u.id, since),
    });
  }
  return out;
}
// People who hold a permission (the owner always does): used to tell the right people about new work.
async function whoCan(module, write = false) {
  const rows = await all("SELECT * FROM users WHERE role IN ('staff','admin') AND active<>0");
  const out = [];
  for (const u of rows) if (allows(await permsOf(u), module, write)) out.push(u);
  return out;
}

module.exports = { sendInvite, resendInvite, MODULES, ALL, DEFAULT_ROLES, seedRoles, permsOf, allows, gate, moduleFor, listRoles, saveRole, deleteRole, listStaff, createStaff, updateStaff, resetPassword, loginHistory, activity, logLogin, performance, whoCan, decorate };
