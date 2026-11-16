'use strict';
// Wholesale warehouse: stock that is SEPARATE from the retail store (products.stock is retail only).
//   on_hand   = physical sellable stock in the warehouse
//   reserved  = set aside for an accepted quote/order
//   available = on_hand - reserved   (computed, never stored)
// Every change goes through move(): it locks the balance row, applies the change, and writes the movement record in the same
// transaction, so the balance and its audit trail can never disagree. The database also refuses reserved > on_hand.
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const { fail, str, int } = S;

/* ---------- roles ---------- */
const ROLES = ['warehouse_manager', 'sales_officer', 'inventory_officer', 'accounts_officer', 'dispatch_officer'];
const ROLE_LABEL = { warehouse_manager: 'Warehouse Manager', sales_officer: 'Wholesale Sales Officer', inventory_officer: 'Inventory Officer', accounts_officer: 'Accounts Officer', dispatch_officer: 'Dispatch Officer' };
// What each role may do. The shop administrator (users.role = 'admin') is the Super Administrator and may do everything.
const PERMISSIONS = {
  'stock.view': ['warehouse_manager', 'inventory_officer', 'sales_officer', 'dispatch_officer', 'accounts_officer'],
  'stock.write': ['warehouse_manager', 'inventory_officer'],
  'activity.view': ['warehouse_manager'],
  'roles.manage': [],                                       // administrator only
};
async function rolesOf(user) {
  if (!user) return [];
  if (user.role === 'admin') return ['super_admin'];
  const rows = await all('SELECT role FROM wholesale_user_roles WHERE user_id=? AND active=1', user.id);
  return rows.map((r) => r.role);
}
async function can(user, permission) {
  const roles = await rolesOf(user);
  if (roles.includes('super_admin')) return true;
  const allowed = PERMISSIONS[permission] || [];
  return roles.some((r) => allowed.includes(r));
}
// Express middleware: signed in, and allowed to do `permission`. Checked on the server for every request.
const require_ = (permission) => async (req, res, next) => {
  try {
    if (!req.user) return next(new S.HttpError(401, 'Please sign in.'));
    if (!(await can(req.user, permission))) return next(new S.HttpError(403, 'You do not have permission to do that.'));
    next();
  } catch (e) { next(e); }
};

/* ---------- audit log and document numbers ---------- */
async function audit(by, action, entity, entityRef, detail, userId) {
  await run('INSERT INTO wholesale_activity_logs (user_id, actor, action, entity, entity_ref, detail, created) VALUES (?,?,?,?,?,?,?)', userId || null, str(by, 80), str(action, 60), str(entity, 40), str(entityRef, 60), str(detail, 500), now());
}
// Allocates the next number atomically (one UPDATE row-locks the counter), e.g. MV-2026-000001. Numbers are never reused.
// Inside a rolled-back transaction a number is simply not used, which keeps the sequence free of duplicates.
async function nextRef(kind, prefix) {
  const lagosYear = new Date(Date.now() + 3600000).getUTCFullYear(); // Africa/Lagos is UTC+1 all year
  const r = await get('INSERT INTO wholesale_document_sequences (kind, year, last_value) VALUES (?,?,1) ON CONFLICT (kind, year) DO UPDATE SET last_value = wholesale_document_sequences.last_value + 1 RETURNING last_value', kind, lagosYear);
  return `${prefix}-${lagosYear}-${String(r.last_value).padStart(6, '0')}`;
}

/* ---------- warehouse ---------- */
let mainId = 0;
async function mainWarehouseId() {
  if (mainId) return mainId;
  const w = await get("SELECT id FROM wholesale_warehouses WHERE code='MAIN'");
  if (!w) fail(500, 'The main wholesale warehouse is not set up.');
  return (mainId = Number(w.id));
}

/* ---------- the one function that changes wholesale stock ---------- */
const TYPES = {
  // type: [effect on on_hand sign, effect on reserved sign, counter column, needs a reason]
  opening: [1, 0, 'opening_qty', false], receipt: [1, 0, 'received_qty', false], return: [1, 0, 'returned_qty', true], transfer_in: [1, 0, 'received_qty', true],
  damaged: [-1, 0, 'damaged_qty', true], expired: [-1, 0, 'expired_qty', true], transfer_out: [-1, 0, null, true],
  reserve: [0, 1, null, false], release: [0, -1, null, false], dispatch: [-1, -1, 'dispatched_qty', false],
};
/**
 * Apply one stock change. Must be called inside tx() when several changes belong together (the helpers below do this).
 *  type: one of TYPES, or 'adjustment' with a signed qty (+ adds, - removes).
 *  Returns the movement (ref, previous and new balances). A repeated idempotencyKey returns the first movement and changes nothing.
 */
async function move({ productId, warehouseId, type, qty, reason = '', by = '', userId = null, relatedType = '', relatedRef = '', idempotencyKey = null }) {
  const n = int(qty);
  if (type === 'adjustment' ? n === 0 : n < 1) fail(400, 'Enter a quantity greater than zero.');
  if (n > 1000000 || n < -1000000) fail(400, 'That quantity is too large.');
  const spec = type === 'adjustment' ? [n > 0 ? 1 : -1, 0, 'adjustment_qty', true] : TYPES[type];
  if (!spec) fail(400, 'Unknown stock movement.');
  if (spec[3] && !str(reason, 300)) fail(400, 'Please write the reason.');
  const amount = Math.abs(n);
  return tx(async () => {
    if (idempotencyKey) {
      const dup = await get('SELECT * FROM wholesale_stock_movements WHERE idempotency_key=?', str(idempotencyKey, 100));
      if (dup) return { ...dup, duplicate: true };
    }
    const p = await get('SELECT id, vendor_id FROM products WHERE id=?', productId);
    if (!p || p.vendor_id) fail(404, 'Only our own products are held in the wholesale warehouse.');
    await run('INSERT INTO wholesale_stock_balances (product_id, warehouse_id, updated) VALUES (?,?,?) ON CONFLICT (product_id, warehouse_id) DO NOTHING', productId, warehouseId, now());
    const b = await get('SELECT * FROM wholesale_stock_balances WHERE product_id=? AND warehouse_id=? FOR UPDATE', productId, warehouseId); // concurrent changes to one product queue here
    if (idempotencyKey) { // a second request with the same key that was waiting on the lock
      const dup = await get('SELECT * FROM wholesale_stock_movements WHERE idempotency_key=?', str(idempotencyKey, 100));
      if (dup) return { ...dup, duplicate: true };
    }
    const dOn = spec[0] * amount, dRes = spec[1] * amount;
    const newOn = b.on_hand + dOn, newRes = b.reserved + dRes;
    if (type === 'reserve' && newOn - newRes < 0) fail(409, 'Not enough available wholesale stock.');
    if (newOn < 0 || newRes < 0) fail(409, dRes < 0 ? 'That would release more than is reserved.' : 'There is not enough wholesale stock for that.');
    if (newRes > newOn) fail(409, 'That would take stock that is already set aside for a customer. Release or ship those orders first.');
    const counter = spec[2];
    // on_hand and reserved are changed relative to the locked row; the CHECK constraints are a second line of defence.
    await run(`UPDATE wholesale_stock_balances SET on_hand = on_hand + ?, reserved = reserved + ?, updated = ?${counter ? `, ${counter} = ${counter} + ?` : ''} WHERE id = ?`,
      ...[dOn, dRes, now(), ...(counter ? [type === 'adjustment' ? n : amount] : []), b.id]);
    const ref = await nextRef('MV', 'MV');
    await run(`INSERT INTO wholesale_stock_movements (ref, product_id, warehouse_id, type, qty, delta_on_hand, delta_reserved, prev_on_hand, new_on_hand, prev_reserved, new_reserved, related_type, related_ref, reason, idempotency_key, by, user_id, created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, productId, warehouseId, type, amount, dOn, dRes, b.on_hand, newOn, b.reserved, newRes, str(relatedType, 30), str(relatedRef, 60), str(reason, 300), idempotencyKey ? str(idempotencyKey, 100) : null, str(by, 80), userId, now());
    return { ref, product_id: Number(productId), type, qty: amount, prev_on_hand: b.on_hand, new_on_hand: newOn, prev_reserved: b.reserved, new_reserved: newRes };
  });
}

/* ---------- staff operations ---------- */
// Goods received (supplier delivery / opening stock). One receipt number covers all its lines; the same key will not apply twice.
async function receive(items, { reference = '', note = '', opening = false, by, userId, key }) {
  if (!Array.isArray(items) || !items.length) fail(400, 'Add at least one product.');
  if (items.length > 300) fail(400, 'A receipt can have up to 300 lines.');
  const wh = await mainWarehouseId();
  return tx(async () => {
    if (key) { const dup = await get('SELECT related_ref FROM wholesale_stock_movements WHERE idempotency_key=?', str(key, 100) + ':0'); if (dup) return { grn: dup.related_ref, duplicate: true, lines: items.length }; }
    const grn = await nextRef('GRN', 'GRN');
    let i = 0;
    for (const it of items) {
      await move({ productId: int(it.productId), warehouseId: wh, type: opening ? 'opening' : 'receipt', qty: int(it.qty), reason: str(note, 300) || (opening ? 'Opening stock' : 'Stock received'), by, userId, relatedType: 'receipt', relatedRef: grn, idempotencyKey: key ? str(key, 100) + ':' + i : null });
      i++;
    }
    await audit(by, opening ? 'stock.opening' : 'stock.receipt', 'receipt', grn, `${items.length} line(s)${reference ? ' · ref ' + str(reference, 60) : ''}`, userId);
    return { grn, lines: items.length };
  });
}
async function adjust({ productId, qty, kind, reason, by, userId, key }) {
  const wh = await mainWarehouseId();
  const type = kind === 'damaged' ? 'damaged' : kind === 'expired' ? 'expired' : kind === 'return' ? 'return' : 'adjustment';
  const m = await move({ productId: int(productId), warehouseId: wh, type, qty: int(qty), reason, by, userId, relatedType: 'adjustment', idempotencyKey: key || null });
  if (!m.duplicate) await audit(by, 'stock.' + type, 'product', String(productId), `${m.prev_on_hand} -> ${m.new_on_hand} (${str(reason, 200)})`, userId);
  return m;
}
async function setReorderLevel(productId, level, by, userId) {
  const wh = await mainWarehouseId(), n = int(level);
  if (n < 0 || n > 1000000) fail(400, 'Enter a reorder level of zero or more.');
  await run('INSERT INTO wholesale_stock_balances (product_id, warehouse_id, updated) VALUES (?,?,?) ON CONFLICT (product_id, warehouse_id) DO NOTHING', productId, wh, now());
  await run('UPDATE wholesale_stock_balances SET reorder_level=?, updated=? WHERE product_id=? AND warehouse_id=?', n, now(), productId, wh);
  await audit(by, 'stock.reorder_level', 'product', String(productId), 'set to ' + n, userId);
}

/* ---------- reservations for quotes/orders (used by lib/wholesale.js) ---------- */
// Set aside every line of a quote. All lines succeed or none do (the caller's transaction rolls back).
async function reserveQuote(quote, items) {
  const wh = await mainWarehouseId();
  for (const i of items) {
    try {
      await move({ productId: i.product_id, warehouseId: wh, type: 'reserve', qty: i.qty, by: 'system', relatedType: 'quote', relatedRef: quote.ref, reason: 'Quotation approved' });
    } catch (e) {
      if (e.status === 409) fail(409, `We no longer have enough ${i.name} in the wholesale warehouse for this quote. Please contact us.`);
      throw e;
    }
    await run("INSERT INTO wholesale_stock_reservations (quote_id, product_id, warehouse_id, qty, status, created) VALUES (?,?,?,?, 'active', ?)", quote.id, i.product_id, wh, i.qty, now());
  }
}
async function closeReservations(quote, how, by, reason) {
  const rows = await all("SELECT * FROM wholesale_stock_reservations WHERE quote_id=? AND status='active' ORDER BY product_id FOR UPDATE", quote.id);
  for (const r of rows) {
    await move({ productId: r.product_id, warehouseId: r.warehouse_id, type: how === 'consumed' ? 'dispatch' : 'release', qty: r.qty, by: by || 'system', relatedType: 'quote', relatedRef: quote.ref, reason });
    await run('UPDATE wholesale_stock_reservations SET status=?, closed=? WHERE id=?', how, now(), r.id);
  }
  return rows.length;
}
const releaseQuote = (quote, by, reason) => closeReservations(quote, 'released', by, reason || 'Reservation released');
const dispatchQuote = (quote, by) => closeReservations(quote, 'consumed', by, 'Dispatched to customer');

/* ---------- reading ---------- */
// available stock for a list of products (a product with no balance row has none)
async function availableFor(productIds) {
  const ids = [...new Set(productIds.map(Number))]; if (!ids.length) return {};
  const wh = await mainWarehouseId();
  const rows = await all(`SELECT product_id, on_hand - reserved AS available FROM wholesale_stock_balances WHERE warehouse_id=? AND product_id = ANY(?::bigint[])`, wh, ids);
  const out = Object.fromEntries(ids.map((i) => [i, 0]));
  for (const r of rows) out[Number(r.product_id)] = Number(r.available);
  return out;
}
async function stockList(q = {}) {
  const wh = await mainWarehouseId();
  const where = ['p.vendor_id IS NULL', 'p.is_pharmacy=0'], args = [wh];
  if (q.low === '1') where.push('COALESCE(b.on_hand - b.reserved, 0) <= COALESCE(b.reorder_level, 0)');
  if (q.only === '1') where.push('b.id IS NOT NULL');
  for (const w of String(q.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)) { where.push("(lower(p.name) LIKE ? ESCAPE '\\' OR lower(p.sku) LIKE ? ESCAPE '\\')"); const l = '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; args.push(l, l); }
  const limit = Math.min(500, Math.max(1, int(q.limit, 200))), offset = Math.max(0, int(q.offset, 0));
  const rows = await all(`SELECT p.id, p.name, p.sku, p.store, p.stock AS retail_stock, p.wholesale_price,
      COALESCE(b.on_hand,0) AS on_hand, COALESCE(b.reserved,0) AS reserved, COALESCE(b.on_hand - b.reserved,0) AS available,
      COALESCE(b.reorder_level,0) AS reorder_level, COALESCE(b.dispatched_qty,0) AS dispatched_qty, COALESCE(b.damaged_qty,0) AS damaged_qty, COALESCE(b.expired_qty,0) AS expired_qty
    FROM products p LEFT JOIN wholesale_stock_balances b ON b.product_id=p.id AND b.warehouse_id=?
    WHERE ${where.join(' AND ')} ORDER BY p.store, p.name LIMIT ${limit} OFFSET ${offset}`, ...args);
  return rows.map((r) => ({ ...r, id: Number(r.id), low: Number(r.available) <= Number(r.reorder_level) && Number(r.reorder_level) > 0 }));
}
async function movements(q = {}) {
  const where = [], args = [];
  if (q.productId) { where.push('m.product_id=?'); args.push(int(q.productId)); }
  if (q.related) { where.push('m.related_ref=?'); args.push(str(q.related, 60)); }
  const limit = Math.min(500, Math.max(1, int(q.limit, 100)));
  return all(`SELECT m.ref, m.product_id, p.name, m.type, m.qty, m.delta_on_hand, m.delta_reserved, m.prev_on_hand, m.new_on_hand, m.prev_reserved, m.new_reserved, m.related_type, m.related_ref, m.reason, m.by, m.created
    FROM wholesale_stock_movements m JOIN products p ON p.id=m.product_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT ${limit}`, ...args);
}
async function activity(limit = 100) {
  return all(`SELECT actor, action, entity, entity_ref, detail, created FROM wholesale_activity_logs ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, int(limit, 100)))}`);
}

/* ---------- staff role management (administrator only) ---------- */
async function listStaff() {
  return all(`SELECT r.id, r.role, r.active, r.created, u.id AS user_id, u.name, u.email FROM wholesale_user_roles r JOIN users u ON u.id=r.user_id ORDER BY u.name, r.role`);
}
async function grantRole(email, role, by, userId) {
  if (!ROLES.includes(role)) fail(400, 'Choose a valid role.');
  const u = await get('SELECT id, role, name FROM users WHERE lower(email)=?', str(email, 120).toLowerCase());
  if (!u) fail(404, 'No account with that email. Ask the person to create an account first.');
  if (u.role !== 'customer' && u.role !== 'admin') fail(400, 'Only a normal account can be given a warehouse role.');
  await run('INSERT INTO wholesale_user_roles (user_id, role, active, created, created_by) VALUES (?,?,1,?,?) ON CONFLICT (user_id, role) DO UPDATE SET active=1', u.id, role, now(), str(by, 80));
  await audit(by, 'staff.grant', 'user', String(u.id), role, userId);
}
async function revokeRole(id, by, userId) {
  const r = await get('SELECT id, user_id, role FROM wholesale_user_roles WHERE id=?', int(id));
  if (!r) fail(404, 'Not found.');
  await run('UPDATE wholesale_user_roles SET active=0 WHERE id=?', r.id);
  await audit(by, 'staff.revoke', 'user', String(r.user_id), r.role, userId);
}

module.exports = { ROLES, ROLE_LABEL, PERMISSIONS, rolesOf, can, require: require_, audit, nextRef, mainWarehouseId, move, receive, adjust, setReorderLevel, reserveQuote, releaseQuote, dispatchQuote, availableFor, stockList, movements, activity, listStaff, grantRole, revokeRole };
