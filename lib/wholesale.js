'use strict';
// Wholesale buying. Only OUR stock is sold wholesale (never a partner store's). The path:
//   application (evaluated for weeks) -> approved buyer picks products at wholesale prices -> quote request
//   -> we send a proforma invoice (goods + logistics + service fee) -> buyer accepts (goods are set aside)
//   -> buyer pays (Paystack or bank transfer) -> ONLY THEN do we ship.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const cache = require('./cache');
const { fail, str, int, isEmail } = S;

const MAX_LINES = 60, MAX_OPEN_QUOTES = 10;
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () => 'WQ-' + Array.from(crypto.randomBytes(8), (b) => REF_CHARS[b % REF_CHARS.length]).join('');
const DAY = 86400;

const cfg = async () => {
  const s = await S.getSettings();
  const num = (k, d, lo, hi) => { const n = Number(s[k]); return Number.isFinite(n) && s[k] !== undefined && s[k] !== '' ? Math.min(hi, Math.max(lo, n)) : d; };
  return { service_pct: num('wholesale_service_pct', 3, 0, 30), valid_days: num('wholesale_valid_days', 7, 1, 60), pay_days: num('wholesale_pay_days', 3, 1, 30), eval_days: num('wholesale_eval_days', 21, 0, 180), bank: String(s.wholesale_bank_details || ''), contact: s.contact_email || '' };
};
const SETTING_KEYS = ['wholesale_service_pct', 'wholesale_valid_days', 'wholesale_pay_days', 'wholesale_eval_days', 'wholesale_bank_details'];
async function saveSettings(b) {
  const out = {};
  for (const [k, lo, hi] of [['wholesale_service_pct', 0, 30], ['wholesale_valid_days', 1, 60], ['wholesale_pay_days', 1, 30], ['wholesale_eval_days', 0, 180]]) {
    if (!(k in b)) continue; const n = Number(b[k]); if (!Number.isFinite(n) || n < lo || n > hi) fail(400, `${k.replace('wholesale_', '').replace(/_/g, ' ')} must be between ${lo} and ${hi}.`); out[k] = String(n);
  }
  if ('wholesale_bank_details' in b) out.wholesale_bank_details = str(b.wholesale_bank_details, 400);
  for (const [k, v] of Object.entries(out)) await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', k, v);
  cache.clear();
}

const event = (qid, status, note = '', by = '') => run('INSERT INTO wholesale_events (quote_id,status,note,by,created) VALUES (?,?,?,?,?)', qid, status, note, by, now());
const mail = async (to, subject, html) => { try { await S.queueMail(to, subject, S.mailWrap(await S.getSettings(), html)); } catch (e) { console.error('Wholesale email failed:', e.message); } };
const tellUs = async (subject, html) => { const c = (await cfg()).contact; if (c) await mail(c, subject, html); };
const link = (q) => `${S.BASE_URL}/wholesale/quote/${q.ref}`;

/* ---------- accounts ---------- */
const publicAccount = (a) => ({ id: Number(a.id), business_name: a.business_name, contact_name: a.contact_name, phone: a.phone, email: a.email, address: a.address, state: a.state, city: a.city, reg_no: a.reg_no, business_type: a.business_type, buys: a.buys, est_monthly: a.est_monthly, status: a.status, status_note: a.status_note, evaluate_until: Number(a.evaluate_until), created: Number(a.created), partner_store: !!a.vendor_id });
const accountOf = (user) => (user ? get('SELECT * FROM wholesale_accounts WHERE user_id=?', user.id) : null);
async function me(user) { const a = await accountOf(user); return a ? publicAccount(a) : null; }
async function apply(user, b) {
  if (!['customer', 'vendor'].includes(user.role)) fail(403, 'Please use a customer account (or your partner store account) to apply.');
  if (await accountOf(user)) fail(409, 'You have already applied. We will contact you after the evaluation.');
  const business = str(b.business_name, 100), contact = str(b.contact_name, 80) || user.name, phone = str(b.phone, 30), email = (str(b.email, 120) || user.email).toLowerCase();
  const address = str(b.address, 200), state = str(b.state, 60), city = str(b.city, 60), regNo = str(b.reg_no, 40);
  if (business.length < 2) fail(400, 'Please enter your business name.');
  if (phone.replace(/\D/g, '').length < 10) fail(400, 'Please enter a phone number we can call.');
  if (!isEmail(email)) fail(400, 'Please enter a valid email.');
  if (address.length < 6 || !state) fail(400, 'Please enter your business address and state.');
  if (!regNo) fail(400, 'Please enter your business registration number (CAC). We check it before approving you.');
  const buys = str(b.buys, 500); if (buys.length < 5) fail(400, 'Tell us briefly what you plan to buy.');
  const c = await cfg();
  const id = (await run('INSERT INTO wholesale_accounts (user_id,vendor_id,business_name,contact_name,phone,email,address,state,city,reg_no,business_type,buys,est_monthly,status,evaluate_until,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    user.id, user.role === 'vendor' ? user.vendor_id : null, business, contact, phone, email, address, state, city, regNo, str(b.business_type, 40), buys, str(b.est_monthly, 80), 'pending', now() + c.eval_days * DAY, now())).lastInsertRowid;
  await tellUs('New wholesale application: ' + business, `<p>${S.esc(business)} (${S.esc(contact)}, ${S.esc(phone)}) applied to buy wholesale. Open Admin > Wholesale to evaluate.</p>`);
  return Number(id);
}
async function approvedAccount(user) {
  const a = await accountOf(user);
  if (!a) fail(403, 'Please apply to become a wholesale buyer first.');
  if (a.status === 'pending') fail(403, 'Your wholesale application is still being evaluated.');
  if (a.status !== 'approved') fail(403, 'Your wholesale account is not active. Please contact us.');
  return a;
}

/* ---------- wholesale price list (approved buyers only; never cached, never in the public product pages) ---------- */
async function catalog(user, q = {}) {
  await approvedAccount(user);
  const where = ["p.vendor_id IS NULL", 'p.active=1', 'p.is_pharmacy=0', 'p.wholesale_price IS NOT NULL', 'p.stock >= p.wholesale_min_qty', 'NOT EXISTS (SELECT 1 FROM variants vv WHERE vv.product_id=p.id)'], args = [];
  if (q.store) { where.push('p.store=?'); args.push(str(q.store, 40)); }
  for (const w of String(q.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)) { where.push("(lower(p.name) LIKE ? ESCAPE '\\' OR lower(p.sku) LIKE ? ESCAPE '\\')"); const l = '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; args.push(l, l); }
  const rows = await all(`SELECT p.id, p.slug, p.name, p.brand, p.store, p.price, p.wholesale_price, p.wholesale_min_qty, p.stock, p.emoji, p.images, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where.join(' AND ')} ORDER BY p.store, p.name LIMIT 400`, ...args);
  return rows.map((p) => ({ id: Number(p.id), slug: p.slug, name: p.name, brand: p.brand, store: p.store, category: p.category, retail_price: p.price, price: p.wholesale_price, min_qty: p.wholesale_min_qty, stock: p.stock, emoji: p.emoji, image: S.parseImages(p.images)[0] || '' }));
}

/* ---------- requests and quotes ---------- */
const publicQuote = async (q, admin = false) => {
  const items = await all('SELECT id, product_id, name, qty, list_price, unit_price FROM wholesale_quote_items WHERE quote_id=? ORDER BY id', q.id);
  const out = {
    ref: q.ref, status: q.status, buyer_note: q.buyer_note, created: Number(q.created),
    ship: { name: q.ship_name, phone: q.ship_phone, state: q.ship_state, city: q.ship_city, address: q.ship_address },
    items: items.map((i) => ({ id: Number(i.id), product_id: Number(i.product_id), name: i.name, qty: i.qty, list_price: i.list_price, unit_price: i.unit_price, line_total: i.unit_price * i.qty })),
    goods_total: q.goods_total, logistics_fee: q.logistics_fee, service_pct: Number(q.service_pct), service_fee: q.service_fee, total: q.total,
    valid_until: q.valid_until == null ? null : Number(q.valid_until), pay_by: q.pay_by == null ? null : Number(q.pay_by), shipment_plan: q.shipment_plan, admin_note: q.admin_note,
    payment_method: q.payment_method, carrier: q.carrier, tracking: q.tracking, ship_note: q.ship_note,
    quoted_at: q.quoted_at && Number(q.quoted_at), accepted_at: q.accepted_at && Number(q.accepted_at), paid_at: q.paid_at && Number(q.paid_at), shipped_at: q.shipped_at && Number(q.shipped_at), delivered_at: q.delivered_at && Number(q.delivered_at),
    events: (await all('SELECT status, note, created FROM wholesale_events WHERE quote_id=? ORDER BY id', q.id)).map((e) => ({ status: e.status, note: e.note, created: Number(e.created) })),
  };
  if (q.status === 'accepted') { out.bank = (await cfg()).bank; out.pay_ref = q.ref; }
  if (admin) out.payment_ref = q.payment_ref;
  return out;
};
async function loadMine(user, ref) {
  const a = await accountOf(user), q = a && (await get('SELECT * FROM wholesale_quotes WHERE ref=? AND account_id=?', str(ref, 20).toUpperCase(), a.id));
  if (!q) fail(404, 'Quote not found.');
  return { a, q };
}

async function createRequest(user, b) {
  const a = await approvedAccount(user);
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) fail(400, 'Choose at least one product.');
  if (lines.length > MAX_LINES) fail(400, `Up to ${MAX_LINES} products per request.`);
  if ((await get("SELECT COUNT(*) n FROM wholesale_quotes WHERE account_id=? AND status IN ('requested','quoted','accepted')", a.id)).n >= MAX_OPEN_QUOTES) fail(429, 'You have several open requests already. Please wait for our reply or cancel one.');
  const ship = { name: str(b.ship_name, 80) || a.contact_name, phone: str(b.ship_phone, 30) || a.phone, state: str(b.ship_state, 60) || a.state, city: str(b.ship_city, 60) || a.city, address: str(b.ship_address, 200) || a.address };
  if (ship.address.length < 6 || !ship.state) fail(400, 'Please enter the delivery address and state.');
  const seen = new Set(), rows = [];
  for (const l of lines) {
    const pid = int(l && l.productId), qty = int(l && l.qty);
    if (!pid || seen.has(pid)) continue; seen.add(pid);
    const p = await get('SELECT id, name, price, stock, wholesale_price, wholesale_min_qty FROM products WHERE id=? AND vendor_id IS NULL AND active=1 AND is_pharmacy=0 AND wholesale_price IS NOT NULL', pid);
    if (!p) fail(400, 'One of the products is not available wholesale.');
    if (qty < p.wholesale_min_qty) fail(400, `${p.name}: the minimum wholesale quantity is ${p.wholesale_min_qty}.`);
    if (qty > p.stock) fail(400, `${p.name}: we only have ${p.stock} in stock. Ask for a smaller amount, or tell us in the note that you need more later.`);
    rows.push({ p, qty });
  }
  if (!rows.length) fail(400, 'Choose at least one product.');
  const goods = rows.reduce((s, r) => s + r.p.wholesale_price * r.qty, 0), ref = newRef();
  return tx(async () => {
    const qid = Number((await run('INSERT INTO wholesale_quotes (ref,account_id,status,buyer_note,ship_name,ship_phone,ship_state,ship_city,ship_address,goods_total,total,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ref, a.id, 'requested', str(b.note, 800), ship.name, ship.phone, ship.state, ship.city, ship.address, goods, goods, now())).lastInsertRowid);
    for (const r of rows) await run('INSERT INTO wholesale_quote_items (quote_id,product_id,name,qty,list_price,unit_price) VALUES (?,?,?,?,?,?)', qid, r.p.id, r.p.name, r.qty, r.p.price, r.p.wholesale_price);
    await event(qid, 'requested', 'Quote requested', a.business_name);
    await tellUs('New wholesale request ' + ref, `<p>${S.esc(a.business_name)} asked for a quotation (${S.naira(goods)} of goods at wholesale prices). Open Admin > Wholesale > Requests.</p>`);
    return ref;
  });
}
async function myQuotes(user) {
  const a = await accountOf(user); if (!a) return [];
  return (await all('SELECT ref, status, goods_total, total, created, valid_until FROM wholesale_quotes WHERE account_id=? ORDER BY id DESC LIMIT 100', a.id)).map((q) => ({ ref: q.ref, status: q.status, goods_total: q.goods_total, total: q.total, created: Number(q.created), valid_until: q.valid_until && Number(q.valid_until) }));
}
async function myQuote(user, ref) { const { q } = await loadMine(user, ref); return publicQuote(q); }

/* Stock set aside for an accepted quote (and given back when it lapses or is cancelled before shipping). */
async function holdStock(q) {
  const items = await all('SELECT product_id, name, qty FROM wholesale_quote_items WHERE quote_id=?', q.id);
  for (const i of items) {
    const r = await run('UPDATE products SET stock = stock - ? WHERE id=? AND vendor_id IS NULL AND stock >= ?', i.qty, i.product_id, i.qty);
    if (!r.changes) fail(409, `We no longer have enough ${i.name} in stock for this quote. Please contact us.`);
  }
  await run('UPDATE wholesale_quotes SET stock_held=1 WHERE id=?', q.id);
}
async function releaseStock(q) {
  if (!Number(q.stock_held)) return;
  for (const i of await all('SELECT product_id, qty FROM wholesale_quote_items WHERE quote_id=?', q.id)) await run('UPDATE products SET stock = stock + ? WHERE id=?', i.qty, i.product_id);
  await run('UPDATE wholesale_quotes SET stock_held=0 WHERE id=?', q.id);
}

async function accept(user, ref) {
  const { a, q } = await loadMine(user, ref);
  if (a.status !== 'approved') fail(403, 'Your wholesale account is not active.');
  const c = await cfg();
  await tx(async () => {
    const cur = await get('SELECT * FROM wholesale_quotes WHERE id=? FOR UPDATE', q.id);
    if (cur.status !== 'quoted') fail(409, 'This quotation cannot be accepted any more.');
    if (cur.valid_until && Number(cur.valid_until) < now()) fail(410, 'This quotation has expired. Please ask for a new one.');
    await holdStock(cur);
    await run("UPDATE wholesale_quotes SET status='accepted', accepted_at=?, pay_by=? WHERE id=?", now(), now() + c.pay_days * DAY, cur.id);
    await event(cur.id, 'accepted', `Quotation approved by the buyer. The goods are set aside until ${new Date((now() + c.pay_days * DAY) * 1000).toISOString().slice(0, 10)}. Payment comes before shipping.`, a.business_name);
  });
  cache.clear();
  await tellUs(`Wholesale quote ${q.ref} accepted`, `<p>${S.esc(a.business_name)} accepted quotation ${q.ref}. Waiting for payment.</p>`);
}
async function decline(user, ref) {
  const { a, q } = await loadMine(user, ref);
  if (!['requested', 'quoted'].includes(q.status)) fail(409, 'This request cannot be declined any more.');
  await run("UPDATE wholesale_quotes SET status='declined' WHERE id=?", q.id);
  await event(q.id, 'declined', 'Declined by the buyer', a.business_name);
}

/* ---------- payment (before shipping) ---------- */
async function startPayment(user, ref) {
  const { a, q } = await loadMine(user, ref);
  if (q.status !== 'accepted') fail(409, 'Please approve the quotation first, then pay.');
  if (!S.paystackLive()) {
    if (S.demoAllowed()) return { demo: true };
    fail(400, 'Online payment is not available. Please pay by bank transfer using the details shown.');
  }
  if (!q.pay_url) {
    const res = await fetch((process.env.PAYSTACK_API_URL || 'https://api.paystack.co') + '/transaction/initialize', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, amount: q.total * 100, currency: 'NGN', reference: q.ref, callback_url: link(q), metadata: { wholesale_quote: q.ref, business: a.business_name } }), signal: AbortSignal.timeout(15000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.status || !d.data || !d.data.authorization_url) fail(502, 'We could not start the payment. Please try again or pay by bank transfer.');
    await run('UPDATE wholesale_quotes SET pay_url=?, payment_method=? WHERE id=?', d.data.authorization_url, 'paystack', q.id);
    return { url: d.data.authorization_url };
  }
  return { url: q.pay_url };
}
async function demoPay(user, ref) {
  if (!S.demoAllowed() || S.paystackLive()) fail(404, 'Not found.');
  const { q } = await loadMine(user, ref);
  await markPaid(q.ref, 'paystack', 'DEMO-' + q.ref, 'Demo payment');
}
// Marks a quote paid. Safe to call twice. Money that arrives for a quote that already lapsed is flagged for a person, never silently ignored.
async function markPaid(ref, method, payRef, by) {
  let q0;
  const done = await tx(async () => {
    q0 = await get('SELECT * FROM wholesale_quotes WHERE ref=? FOR UPDATE', ref);
    if (!q0) fail(404, 'Quote not found.');
    if (['paid', 'shipped', 'delivered'].includes(q0.status)) return false;
    if (q0.status !== 'accepted') { await event(q0.id, q0.status, `Payment of ${S.naira(q0.total)} arrived while the quote was "${q0.status}". Please review and refund or reinstate by hand.`, by || method); return 'review'; }
    await run("UPDATE wholesale_quotes SET status='paid', paid_at=?, payment_method=?, payment_ref=? WHERE id=?", now(), method, payRef || '', q0.id);
    await event(q0.id, 'paid', `Payment received (${method}${payRef ? ', ' + payRef : ''}). We can now arrange shipment.`, by || method);
    return true;
  });
  const a = await get('SELECT * FROM wholesale_accounts WHERE id=?', q0.account_id);
  if (done === true) {
    await mail(a.email, `Payment received for ${q0.ref}`, `<p>Hi ${S.esc(a.contact_name)}, we received your payment of <b>${S.naira(q0.total)}</b> for quotation ${q0.ref}. We will arrange the shipment as agreed. ${link(q0)}</p>`);
    await tellUs(`Wholesale ${q0.ref} paid`, `<p>${S.esc(a.business_name)} paid ${S.naira(q0.total)}. Please arrange shipment.</p>`);
  } else if (done === 'review') await tellUs(`Wholesale payment needs review: ${q0.ref}`, `<p>A payment arrived for ${q0.ref} while it was ${q0.status}. Please check.</p>`);
  return done;
}
// Called from the Paystack webhook / return check (references starting WQ-).
async function settle(ref, { strict = false } = {}) {
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=?', ref);
  if (!q || ['paid', 'shipped', 'delivered'].includes(q.status)) return q || null;
  const d = await S.paystackVerify(ref);
  if (!d && strict) throw new Error('Paystack could not confirm the payment yet');
  if (d && d.status === 'success') {
    const bad = String(d.reference || ref).toUpperCase() !== ref ? 'reference differs' : d.currency !== 'NGN' ? `currency was ${d.currency}` : Number(d.amount) !== q.total * 100 ? `amount was ${Number(d.amount) / 100}, quote total is ${q.total}` : '';
    if (bad) { await event(q.id, q.status, `Payment check failed (${bad}). Not marked paid. Please review with Paystack.`, 'paystack'); console.error(`Wholesale payment mismatch on ${ref}: ${bad}`); }
    else await markPaid(ref, 'paystack', String(d.reference || ref), 'paystack');
  }
  return get('SELECT * FROM wholesale_quotes WHERE ref=?', ref);
}

/* ---------- admin ---------- */
const publicRow = (a) => ({ ...publicAccount(a), user_id: Number(a.user_id), approved_by: a.approved_by });
async function adminAccounts(status) {
  const rows = await all(`SELECT * FROM wholesale_accounts ${status ? 'WHERE status=?' : ''} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC LIMIT 300`, ...(status ? [status] : []));
  return rows.map(publicRow);
}
async function decideAccount(id, action, b, by) {
  const a = await get('SELECT * FROM wholesale_accounts WHERE id=?', int(id));
  if (!a) fail(404, 'Application not found.');
  const note = str(b && b.note, 300);
  if (action === 'approve') {
    if (!['pending', 'rejected', 'suspended'].includes(a.status)) fail(409, 'Already approved.');
    if (a.status === 'pending' && Number(a.evaluate_until) > now() && !(b && b.early)) fail(409, `The evaluation period runs until ${new Date(Number(a.evaluate_until) * 1000).toISOString().slice(0, 10)}. Confirm to approve early.`);
    await run("UPDATE wholesale_accounts SET status='approved', status_note=?, approved_at=?, approved_by=? WHERE id=?", note, now(), by, a.id);
    await mail(a.email, 'You are approved as a Shop-Beta wholesale buyer', `<p>Hi ${S.esc(a.contact_name)}, ${S.esc(a.business_name)} is approved for wholesale buying. Sign in and open ${S.BASE_URL}/wholesale to see wholesale prices and request a quotation.</p>`);
  } else if (action === 'reject' || action === 'suspend') {
    if (!note) fail(400, 'Please write the reason.');
    await run('UPDATE wholesale_accounts SET status=?, status_note=? WHERE id=?', action === 'reject' ? 'rejected' : 'suspended', note, a.id);
    await mail(a.email, 'About your Shop-Beta wholesale application', `<p>Hi ${S.esc(a.contact_name)}, ${S.esc(note)}</p>`);
  } else if (action === 'extend') {
    await run('UPDATE wholesale_accounts SET evaluate_until=?, status_note=? WHERE id=?', now() + Math.max(0, Math.min(180, int(b && b.days, 14))) * DAY, note, a.id);
  } else fail(400, 'Unknown action.');
}
async function adminQuotes(status) {
  const rows = await all(`SELECT q.*, a.business_name FROM wholesale_quotes q JOIN wholesale_accounts a ON a.id=q.account_id ${status ? 'WHERE q.status=?' : ''} ORDER BY CASE q.status WHEN 'requested' THEN 0 WHEN 'accepted' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END, q.id DESC LIMIT 300`, ...(status ? [status] : []));
  return rows.map((q) => ({ ref: q.ref, status: q.status, business: q.business_name, goods_total: q.goods_total, total: q.total, created: Number(q.created), valid_until: q.valid_until && Number(q.valid_until), pay_by: q.pay_by && Number(q.pay_by) }));
}
async function adminQuote(ref) {
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=?', str(ref, 20).toUpperCase());
  if (!q) fail(404, 'Quote not found.');
  const a = await get('SELECT * FROM wholesale_accounts WHERE id=?', q.account_id);
  const stock = await all('SELECT i.id, p.stock FROM wholesale_quote_items i JOIN products p ON p.id=i.product_id WHERE i.quote_id=?', q.id);
  return { ...(await publicQuote(q, true)), account: publicAccount(a), stock_held: !!Number(q.stock_held), in_stock: Object.fromEntries(stock.map((s) => [Number(s.id), s.stock])), defaults: await cfg() };
}
// Compile the proforma invoice and quotation: goods at the agreed unit prices, our logistics fee, our service fee.
async function sendQuote(ref, b, by) {
  const c = await cfg();
  await tx(async () => {
    const q = await get('SELECT * FROM wholesale_quotes WHERE ref=? FOR UPDATE', str(ref, 20).toUpperCase());
    if (!q) fail(404, 'Quote not found.');
    if (!['requested', 'quoted'].includes(q.status)) fail(409, 'This quote can no longer be changed.');
    const items = await all('SELECT * FROM wholesale_quote_items WHERE quote_id=? ORDER BY id', q.id);
    const edits = new Map((Array.isArray(b.items) ? b.items : []).map((i) => [Number(i.id), i]));
    let goods = 0, kept = 0;
    for (const it of items) {
      const e = edits.get(Number(it.id)); let qty = it.qty, unit = it.unit_price;
      if (e) { qty = int(e.qty, it.qty); unit = int(e.unit_price, it.unit_price); }
      if (qty <= 0) { await run('DELETE FROM wholesale_quote_items WHERE id=?', it.id); continue; }
      if (unit < 0) fail(400, 'A price cannot be negative.');
      const st = await get('SELECT stock FROM products WHERE id=?', it.product_id);
      if (qty > st.stock) fail(409, `${it.name}: only ${st.stock} in stock.`);
      await run('UPDATE wholesale_quote_items SET qty=?, unit_price=? WHERE id=?', qty, unit, it.id); goods += qty * unit; kept++;
    }
    if (!kept) fail(400, 'A quotation needs at least one item.');
    const logistics = Math.max(0, int(b.logistics_fee)), pct = b.service_pct === '' || b.service_pct == null ? c.service_pct : Math.min(30, Math.max(0, Number(b.service_pct) || 0));
    const service = Math.round((goods * pct) / 100), days = Math.max(1, Math.min(60, int(b.valid_days, c.valid_days)));
    const plan = str(b.shipment_plan, 400); if (!plan) fail(400, 'Say how and when the shipment will be arranged (for example "Truck from Lagos, pickup within 3 days of payment").');
    await run("UPDATE wholesale_quotes SET status='quoted', goods_total=?, logistics_fee=?, service_pct=?, service_fee=?, total=?, valid_until=?, shipment_plan=?, admin_note=?, quoted_at=? WHERE id=?",
      goods, logistics, pct, service, goods + logistics + service, now() + days * DAY, plan, str(b.admin_note, 500), now(), q.id);
    await event(q.id, 'quoted', `Proforma invoice sent: goods ${S.naira(goods)}, logistics ${S.naira(logistics)}, service fee ${S.naira(service)}, total ${S.naira(goods + logistics + service)}.`, by);
  });
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=?', str(ref, 20).toUpperCase()), a = await get('SELECT * FROM wholesale_accounts WHERE id=?', q.account_id);
  await mail(a.email, `Your Shop-Beta wholesale quotation ${q.ref}`, `<p>Hi ${S.esc(a.contact_name)}, your proforma invoice and quotation <b>${q.ref}</b> is ready.</p><p>Total value of goods: ${S.naira(q.goods_total)}<br>Logistics fee: ${S.naira(q.logistics_fee)}<br>Service fee: ${S.naira(q.service_fee)}<br><b>Total: ${S.naira(q.total)}</b></p><p>It is valid until ${new Date(Number(q.valid_until) * 1000).toISOString().slice(0, 10)}. Approve it and pay before we ship: ${link(q)}</p>`);
}
async function adminCancel(ref, reason, by) {
  if (!reason) fail(400, 'Please write the reason.');
  const out = await tx(async () => {
    const q = await get('SELECT * FROM wholesale_quotes WHERE ref=? FOR UPDATE', str(ref, 20).toUpperCase());
    if (!q) fail(404, 'Quote not found.');
    if (['shipped', 'delivered', 'cancelled', 'declined', 'expired'].includes(q.status)) fail(409, 'This quote cannot be cancelled any more.');
    await releaseStock(q);
    await run("UPDATE wholesale_quotes SET status='cancelled' WHERE id=?", q.id);
    await event(q.id, 'cancelled', reason + (q.status === 'paid' ? ' (the buyer had paid: refund them and record it)' : ''), by);
    return q;
  });
  cache.clear();
  const a = await get('SELECT * FROM wholesale_accounts WHERE id=?', out.account_id);
  await mail(a.email, `Wholesale quotation ${out.ref} cancelled`, `<p>${S.esc(reason)}</p>`);
}
async function markTransferReceived(ref, payRef, by) {
  if (!payRef) fail(400, 'Enter the bank transfer reference or the date you saw it in the account.');
  const r = await markPaid(str(ref, 20).toUpperCase(), 'transfer', str(payRef, 80), by);
  if (!r) fail(409, 'Already marked as paid.');
  if (r === 'review') fail(409, 'That quote is no longer waiting for payment. Review it.');
}
async function ship(ref, b, by) {
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=?', str(ref, 20).toUpperCase());
  if (!q) fail(404, 'Quote not found.');
  if (q.status !== 'paid') fail(409, 'We only ship after payment is received.');
  const carrier = str(b.carrier, 80); if (!carrier) fail(400, 'Enter who is carrying the goods (our truck, a courier, the buyer collecting).');
  await run("UPDATE wholesale_quotes SET status='shipped', shipped_at=?, carrier=?, tracking=?, ship_note=? WHERE id=?", now(), carrier, str(b.tracking, 80), str(b.note, 300), q.id);
  await event(q.id, 'shipped', `Shipped with ${carrier}${b.tracking ? ' (' + str(b.tracking, 80) + ')' : ''}.`, by);
  const a = await get('SELECT * FROM wholesale_accounts WHERE id=?', q.account_id);
  await mail(a.email, `Your wholesale order ${q.ref} has shipped`, `<p>Hi ${S.esc(a.contact_name)}, ${q.ref} is on its way with ${S.esc(carrier)}${b.tracking ? ', tracking ' + S.esc(str(b.tracking, 80)) : ''}. ${link(q)}</p>`);
}
async function deliver(ref, by) {
  const q = await get('SELECT * FROM wholesale_quotes WHERE ref=?', str(ref, 20).toUpperCase());
  if (!q || q.status !== 'shipped') fail(409, 'Only a shipped order can be marked delivered.');
  await run("UPDATE wholesale_quotes SET status='delivered', delivered_at=? WHERE id=?", now(), q.id);
  await event(q.id, 'delivered', 'Delivered', by);
}
async function expireLapsed() {
  let n = 0;
  const lapsed = await all("SELECT * FROM wholesale_quotes WHERE (status='quoted' AND valid_until < ?) OR (status='accepted' AND pay_by < ?)", now(), now());
  for (const l of lapsed) {
    await tx(async () => {
      const q = await get('SELECT * FROM wholesale_quotes WHERE id=? FOR UPDATE', l.id);
      if (!['quoted', 'accepted'].includes(q.status)) return;
      await releaseStock(q);
      await run("UPDATE wholesale_quotes SET status='expired' WHERE id=?", q.id);
      await event(q.id, 'expired', q.status === 'accepted' ? 'Not paid in time. The goods were released.' : 'The quotation was not accepted in time.', 'system');
      n++;
    });
  }
  if (n) cache.clear();
  return n;
}

// Wholesale price list management (our own products only; products with sizes/colours and medicines are not offered wholesale).
async function adminProducts(q = {}) {
  const where = ['p.vendor_id IS NULL', 'p.is_pharmacy=0', 'NOT EXISTS (SELECT 1 FROM variants vv WHERE vv.product_id=p.id)'], args = [];
  if (q.store) { where.push('p.store=?'); args.push(str(q.store, 40)); }
  if (q.only === '1') where.push('p.wholesale_price IS NOT NULL');
  for (const w of String(q.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)) { where.push("lower(p.name) LIKE ? ESCAPE '\\'"); args.push('%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  return all(`SELECT p.id, p.name, p.store, p.price, p.stock, p.wholesale_price, p.wholesale_min_qty, p.active FROM products p WHERE ${where.join(' AND ')} ORDER BY p.store, p.name LIMIT 300`, ...args);
}
async function setProductPrice(id, b) {
  const p = await get('SELECT id, price, vendor_id, is_pharmacy FROM products WHERE id=?', int(id));
  if (!p || p.vendor_id) fail(404, 'Only our own products can be sold wholesale.');
  if (p.is_pharmacy) fail(400, 'Medicines are not sold wholesale here.');
  if (await get('SELECT 1 x FROM variants WHERE product_id=? LIMIT 1', p.id)) fail(400, 'Products with sizes or colours are not offered wholesale yet.');
  const blank = b.wholesale_price === '' || b.wholesale_price == null, price = blank ? null : int(b.wholesale_price), min = Math.max(1, int(b.wholesale_min_qty, 1));
  if (!blank && (price < 1 || price > p.price)) fail(400, `The wholesale price must be between ₦1 and the retail price (${S.naira(p.price)}).`);
  await run('UPDATE products SET wholesale_price=?, wholesale_min_qty=? WHERE id=?', price, min, p.id);
  cache.clear();
}

module.exports = {
  cfg, SETTING_KEYS, saveSettings, me, apply, accountOf, approvedAccount, catalog, createRequest, myQuotes, myQuote, accept, decline, startPayment, demoPay, markPaid, settle,
  adminAccounts, decideAccount, adminQuotes, adminQuote, sendQuote, adminCancel, markTransferReceived, ship, deliver, expireLapsed, adminProducts, setProductPrice,
};
