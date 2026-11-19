'use strict';
// Export orders: international checkout, shipping quotes, and the orders staff then pack and ship.
//
// An international order is an ordinary row in "orders" (so payment, stock and the admin screens keep working, in NGN), marked delivery='international',
// plus an "export_orders" row with everything international: the customer's currency and the exchange rate fixed at that moment, the address,
// the shipping method, duties. The customer is charged in NGN through the existing Paystack flow; their own currency is shown beside it (phase 7 adds native-currency payment).
// Rules enforced here: only our own stock (not partner stock), only products signed off for that country, every price computed on the server,
// a quote is bound to one exact cart and expires, stock is taken in the same transaction as the order, and no step is skipped silently.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const P = require('./products');
const FR = require('./freight');
const DU = require('./duties');
const { fail, str } = S;

const FLOW = ['pending', 'confirmed', 'processing', 'packed', 'dispatched', 'in_transit', 'customs', 'out_for_delivery', 'delivered'];
const STAGE = { confirmed: 'order_confirmed', processing: 'processing', packed: 'packed', dispatched: 'dispatched', in_transit: 'in_transit', customs: 'import_customs', out_for_delivery: 'out_for_delivery', delivered: 'delivered' };
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

/* ---------- address and contact ---------- */
function cleanAddress(c, b) {
  const contact = b.contact || {}, a = b.address || {};
  const name = str(contact.name, 80), email = str(contact.email, 120).toLowerCase();
  if (name.length < 2 || !S.isEmail(email)) fail(400, 'Please enter your name and a valid email address.');
  const dial = String(contact.dial_code == null || contact.dial_code === '' ? c.dial_code : contact.dial_code).replace(/\D/g, '');
  if (!/^\d{1,4}$/.test(dial)) fail(400, 'Please enter a valid phone country code, for example 44.');
  const phone = String(contact.phone || '').replace(/[^\d]/g, '');
  if (phone.length < 5 || phone.length > 14) fail(400, 'Please enter a valid phone number (digits only, without the country code).');
  const line1 = str(a.line1, 120), line2 = str(a.line2, 120), city = str(a.city, 60), region = str(a.region, 60), postal = str(a.postal_code, 12).toUpperCase();
  if (line1.length < 4) fail(400, 'Please enter your street address.');
  if (city.length < 2) fail(400, 'Please enter your city.');
  if ((c.config || {}).region_required && !region) fail(400, 'Please enter your state or province.');
  if (Number(c.postal_required)) {
    if (!postal) fail(400, 'Please enter your postal or ZIP code.');
    if (c.postal_regex) { try { if (!new RegExp(c.postal_regex).test(postal)) fail(400, `That postal code does not look right for ${c.name}.`); } catch (e) { if (e instanceof S.HttpError) throw e; /* a broken pattern is never allowed to block checkout */ } }
  }
  const taxId = str(b.tax_id, 40);
  if (Number(c.tax_id_required) && !taxId) fail(400, `${c.tax_id_label || 'Tax identification number'} is required for deliveries to ${c.name}.`);
  return { name, email, dial, phone, line1, line2, city, region, postal, taxId, instructions: str(b.instructions, 300) };
}

/* ---------- the cart as the server sees it ---------- */
async function loadCart(items, country) {
  const priced = await S.priceCart({ items, coupon: '', state: '', delivery: 'standard' });
  if (!priced.lines.length) fail(400, priced.issues[0] ? priced.issues[0].message : 'Your cart is empty.');
  if (priced.issues.some((i) => /sold out|no longer available/.test(i.message))) fail(409, priced.issues[0].message);
  const lines = [];
  for (const l of priced.lines) {
    if (l.vendorId) fail(400, `${l.name} is sold by a partner store and cannot be shipped internationally yet.`);
    const ok = await P.offerable(l.productId, country); if (!ok.ok) fail(409, `${l.name}: ${ok.reason}`);
    const t = await get('SELECT * FROM product_trade_settings WHERE product_id=?', l.productId);
    lines.push({ ...l, trade: t });
  }
  return { lines, issues: priced.issues, goodsNgn: lines.reduce((a, l) => a + l.price * l.qty, 0) };
}
async function customsValue(l) {
  const t = l.trade;
  if (t.export_declared_value == null) return l.price * l.qty;
  const cur = t.declared_currency || 'NGN';
  return Math.round(Number(t.export_declared_value) * (cur === 'NGN' ? 1 : (await FX.rate(cur, 'NGN')).rate)) * l.qty;
}

/* ---------- quote ---------- */
// Builds every shipping option for this cart and destination (in NGN integers, then shown in the customer's currency).
async function compute(b) {
  const country = String(b.country || '').toUpperCase(), cur = String(b.currency || 'NGN').toUpperCase();
  const c = await get('SELECT * FROM trade_countries WHERE code=? AND export_to=1 AND active=1', country); if (!c) fail(404, 'We do not ship to that country yet.');
  const cc = await get('SELECT * FROM trade_currencies WHERE code=? AND active=1', cur); if (!cc) fail(400, 'That currency is not available.');
  const st = await T.settings(), cart = await loadCart(b.items, country);
  const postal = str((b.address || {}).postal_code || b.postal_code, 12).toUpperCase();
  const wantIns = b.insurance === true || b.insurance === 'true' || b.insurance === 1;
  const perNgn = cur === 'NGN' ? { rate: 1, markup: 1, source: 'base', stale: false } : await (async () => { const r = await FX.rate('NGN', cur); return { rate: r.rate * (1 + Number(st.fx_markup_pct) / 100), source: r.source, stale: r.stale }; })();
  const dec = Number(cc.decimals), disp = (ngn) => T.roundTo(ngn * perNgn.rate, dec);
  const hash = sha(JSON.stringify([cart.lines.map((l) => [l.productId, l.variantId || 0, l.qty]).sort(), country, postal.replace(/\s+/g, ''), cur, wantIns]));
  const opts = await FR.options({ country, postal, lines: cart.lines.map((l) => ({ qty: l.qty, weight_kg: l.trade.weight_kg, length_cm: l.trade.length_cm, width_cm: l.trade.width_cm, height_cm: l.trade.height_cm })), goodsNgn: cart.goodsNgn, wantInsurance: wantIns, st });
  const customsLines = []; for (const l of cart.lines) customsLines.push({ product_id: l.productId, hs_code: l.trade.hs_code, origin_country: l.trade.origin_country, value_ngn: await customsValue(l) });
  const wantDdp = c.duty_arrangement === 'DDP' || st.default_duty_arrangement === 'DDP';
  const out = [];
  for (const o of opts) {
    const du = await DU.estimate({ dest: country, lines: customsLines, freightNgn: o.shipping_ngn, insuranceNgn: o.insurance_ngn });
    const ddp = wantDdp && Number(o.service.supports_ddp) && du.status === 'verified';
    const collected = ddp ? du.total_ngn : 0, total = cart.goodsNgn + o.shipping_ngn + o.insurance_ngn + collected;
    let note;
    if (ddp) note = `Duties and taxes are included in your total. Nothing more to pay on delivery.`;
    else {
      const why = wantDdp && !ddp ? ' We cannot collect them for this method.' : '';
      if (du.status === 'not_available') note = `Import duties and taxes may be charged in ${c.name} when the parcel arrives. They are not included in your total and we could not estimate them.${why}`;
      else note = `Duties and taxes are NOT included in your total. You pay them when the parcel arrives (estimate ${cur === 'NGN' ? '₦' + du.total_ngn.toLocaleString('en-NG') : disp(du.total_ngn).toLocaleString('en', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' ' + cur}${du.status === 'verified' ? '' : ', not yet verified by our staff'}${du.status === 'partial' ? ', and some items could not be estimated' : ''}).${why}`;
    }
    const d = { goods: disp(cart.goodsNgn), shipping: disp(o.shipping_ngn), insurance: disp(o.insurance_ngn), duties: disp(collected) };
    const days = { min: o.service.est_days_min, max: o.service.est_days_max }, day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    out.push({
      service_id: Number(o.service.id), label: `${o.service.provider_name} · ${o.service.name}`, method: o.service.method, source: 'manual_estimate', days,
      est_delivery: days.min != null && days.max != null ? { from: day(days.min), to: day(days.max) } : null, weights: o.weights, supports_insurance: !!Number(o.service.supports_insurance),
      amounts: d, total: T.roundTo(d.goods + d.shipping + d.insurance + d.duties, dec), charged_ngn: total,
      duties: { arrangement: ddp ? 'DDP' : 'DAP', collected_at_checkout: ddp, status: du.status, estimate_ngn: du.status === 'not_available' ? null : { duty: du.duty_ngn, vat: du.vat_ngn, levy: du.levy_ngn, total: du.total_ngn }, de_minimis: du.de_minimis, message: note },
      _ngn: { goods: cart.goodsNgn, shipping: o.shipping_ngn, insurance: o.insurance_ngn, duties: collected, total, parts: o.parts }, _du: du,
    });
  }
  return { country: c, currency: cc, perNgn, disp, hash, postal, wantIns, st, cart, options: out };
}

async function quote(b, user) {
  const q = await compute(b), ttl = Number(q.st.quote_ttl_minutes) * 60, t = now();
  const options = [];
  for (const o of q.options) {
    const id = Number((await run('INSERT INTO shipping_rate_quotes (cart_key,cart_hash,user_id,service_id,service_label,source,origin_country,destination_country,currency,amount,insurance,duties,actual_kg,volumetric_kg,chargeable_kg,est_days_min,est_days_max,breakdown,expires_at,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?)',
      q.hash.slice(0, 24), q.hash, user ? user.id : null, o.service_id, o.label, 'manual_estimate', q.st.origin_country, q.country.code, q.currency.code, o.amounts.shipping, o.amounts.insurance, o.amounts.duties, o.weights.actual_kg, o.weights.volumetric_kg, o.weights.chargeable_kg, o.days.min, o.days.max,
      JSON.stringify({ ngn: o._ngn, duties: o.duties, fx: { per_ngn: q.perNgn.rate, source: q.perNgn.source } }), t + ttl, t)).lastInsertRowid);
    const { _ngn, _du, ...pub } = o; options.push({ ...pub, quote_id: id, expires_at: t + ttl });
  }
  return { country: { code: q.country.code, name: q.country.name }, currency: { code: q.currency.code, symbol: q.currency.symbol, decimals: Number(q.currency.decimals) }, rate_source: q.perNgn.source, rate_stale: !!q.perNgn.stale,
    goods: q.disp(q.cart.goodsNgn), items: q.cart.lines.map((l) => ({ product_id: l.productId, name: l.name, qty: l.qty, unit_price: q.disp(l.price) })), issues: q.cart.issues, options,
    message: options.length ? '' : 'No shipping method is available for this destination and parcel yet. Please contact us.', quote_ttl_minutes: Number(q.st.quote_ttl_minutes) };
}

/* ---------- checkout ---------- */
async function checkout(b, user, idemKey) {
  const q0 = await compute(b), c = q0.country, a = cleanAddress(c, b);
  const svc = Number(b.service_id), opt = q0.options.find((o) => o.service_id === svc); if (!opt) fail(400, 'Please choose a shipping method.');
  const qr = await get('SELECT * FROM shipping_rate_quotes WHERE id=?', Number(b.quote_id) || 0);
  if (!qr || qr.cart_hash !== q0.hash || Number(qr.service_id) !== svc) fail(409, 'Your shipping quote no longer matches your cart. Please get the shipping options again.');
  if (Number(qr.expires_at) < now()) fail(409, 'Your shipping quote has expired. Please get the shipping options again.');
  const was = qr.breakdown && qr.breakdown.ngn ? Number(qr.breakdown.ngn.total) : -1;
  if (was !== opt._ngn.total) fail(409, 'The price changed since your quote (stock, exchange rate or shipping rates). Please review the new total.');
  const key = typeof idemKey === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(idemKey) ? idemKey : null, fp = sha(JSON.stringify([q0.hash, svc, a.email, a.name, a.line1, a.city]));
  const replay = async () => { const prev = await S.loadOrder('idem_key=?', key); if (!prev) return null; if (prev.idem_hash !== fp) fail(409, 'Your cart or details changed since that attempt. Please place the order again.'); prev.replayed = true; return prev; };
  if (key) { const prev = await replay(); if (prev) return prev; }
  if (S.paystackLive() === false && !S.demoAllowed()) fail(400, 'Online payment is not available right now.');
  const dec = Number(q0.currency.decimals), rateToNgn = 1 / q0.perNgn.rate, N = opt._ngn, lines = [...q0.cart.lines].sort((x, y) => (x.productId - y.productId) || ((x.variantId || 0) - (y.variantId || 0)));
  const fxSource = (q0.perNgn.source || '') + (Number(q0.st.fx_markup_pct) > 0 ? ` +${q0.st.fx_markup_pct}% markup` : '');

  const place = () => tx(async () => {
    for (const l of lines) await S.takeStock(l);
    const t = now(), ref = await S.newRef();
    const phone = `+${a.dial} ${a.phone}`, address = [a.line1, a.line2].filter(Boolean).join(', ');
    const r = await run(`INSERT INTO orders (ref,user_id,status,payment_method,payment_status,name,email,phone,state,city,address,notes,delivery,delivery_fee,subtotal,discount,coupon,total,created,idem_key,idem_hash,access_token)
      VALUES (?,?,'pending','paystack','unpaid',?,?,?,?,?,?,?,'international',?,?,0,'',?,?,?,?,?)`,
      ref, user ? user.id : null, a.name, a.email, phone, a.region || c.name, a.city, address, str(b.notes, 300), N.shipping + N.insurance, N.goods, N.total, t, key, fp, crypto.randomBytes(24).toString('hex'));
    const oid = Number(r.lastInsertRowid), ex = T.ref('EX');
    const eo = Number((await run(`INSERT INTO export_orders (order_id,ref,user_id,origin_country,destination_country,ship_name,ship_email,ship_phone,phone_dial_code,address_line1,address_line2,city,region,postal_code,tax_id,delivery_instructions,address_validated,
        currency,fx_rate_to_ngn,fx_source,subtotal,shipping,insurance,duties,taxes,other_charges,total,shipping_method,quote_id,quote_source,duty_arrangement,duties_collected,status,stock_reserved,service_id,insured,service_label,total_ngn,eta,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0, ?,?,?,?,?,?,?,0,0,?,?,?,'manual_estimate',?,?,'pending',1,?,?,?,?,?,?,?)`,
      oid, ex, user ? user.id : null, q0.st.origin_country, c.code, a.name, a.email, a.phone, a.dial, a.line1, a.line2, a.city, a.region, a.postal, a.taxId, a.instructions,
      q0.currency.code, T.roundTo(rateToNgn, 10), fxSource, opt.amounts.goods, opt.amounts.shipping, opt.amounts.insurance, opt.amounts.duties, opt.total, opt.method, Number(qr.id), opt.duties.arrangement, opt.duties.collected_at_checkout ? 1 : 0,
      svc, N.insurance > 0 ? 1 : 0, opt.label, N.total, opt.est_delivery ? opt.est_delivery.to : null, t, t)).lastInsertRowid);
    for (const l of q0.cart.lines) {
      const oi = Number((await run('INSERT INTO order_items (order_id,product_id,variant_id,name,variant_label,price,qty,emoji,image) VALUES (?,?,?,?,?,?,?,?,?)', oid, l.productId, l.variantId, l.name, l.variantLabel, l.price, l.qty, l.emoji, l.image)).lastInsertRowid);
      const cv = await customsValue(l);
      await run('INSERT INTO export_order_items (export_order_id,order_item_id,product_id,description,customs_description,hs_code,origin_country,qty,unit_price,declared_value,weight_kg) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        eo, oi, l.productId, l.name + (l.variantLabel ? ` (${l.variantLabel})` : ''), l.trade.customs_description, l.trade.hs_code, l.trade.origin_country, l.qty, T.roundTo(l.price * q0.perNgn.rate, dec + 2), T.roundTo(cv * q0.perNgn.rate, dec), l.trade.weight_kg);
    }
    await S.addEvent(oid, 'pending', 'International order placed. Waiting for payment.');
    await T.audit(user, 'export_order.create', 'export_orders', ex, { order: ref, country: c.code, currency: q0.currency.code, total_ngn: N.total }, '');
    return S.loadOrder('id=?', oid);
  });
  const refClash = (e) => e && e.code === '23505' && /orders_ref_key/.test(String(e.constraint || e.message || ''));
  const idemClash = (e) => key && e && e.code === '23505' && /idx_orders_idem/.test(String(e.constraint || e.message || ''));
  try { return await place(); } catch (e) { if (idemClash(e)) { const prev = await replay(); if (prev) return prev; } if (!refClash(e)) throw e; }
  return place();
}

/* ---------- hooks called by the order code ---------- */
const track = async (eo, stage, description, { source = 'system', location = '', user = null, unique = true } = {}) => {
  const hash = unique ? sha(`ex:${eo.id}:${stage}`) : sha(`ex:${eo.id}:${stage}:${now()}:${crypto.randomBytes(4).toString('hex')}`);
  await run('INSERT INTO shipment_tracking_events (export_order_id,stage,description,location,occurred_at,source,event_hash,created_by,created) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (event_hash) DO NOTHING', eo.id, stage, description, location, now(), source, hash, user ? user.id : null, now());
};
async function deduct(eo, why) {   // stock was taken at placement (reserved); this records that it is now final. Done once.
  const r = await run('UPDATE export_orders SET stock_deducted=1, updated=? WHERE id=? AND stock_deducted=0', now(), eo.id);
  if (r.changes === 1) await S.addEvent(eo.order_id, (await get('SELECT status FROM orders WHERE id=?', eo.order_id)).status, `Stock confirmed as sold (${why}).`, { internal: true });
}
async function onPaid(order, providerRef) {
  const eo = await get('SELECT * FROM export_orders WHERE order_id=? FOR UPDATE', order.id); if (!eo) return;
  if (eo.status === 'pending') {
    await run("UPDATE export_orders SET status='confirmed', updated=? WHERE id=?", now(), eo.id);
    await track(eo, 'order_confirmed', 'Payment received. Your international order is confirmed.');
  }
  if (providerRef && !/^DEMO-/.test(providerRef)) await run("INSERT INTO international_payments (export_order_id,order_id,provider,provider_ref,currency,amount,fx_rate_to_ngn,amount_ngn,kind,status,verified,verified_at,created,updated) VALUES (?,?,'paystack',?,'NGN',?,1,?,'charge','succeeded',1,?,?,?) ON CONFLICT (provider,provider_ref) DO NOTHING", eo.id, order.id, providerRef, order.total, order.total, now(), now(), now());
  if ((await T.settings()).export_stock_deduct_at === 'confirm') await deduct(eo, 'payment confirmed');
}
async function onCancelled(order) {
  await run("UPDATE export_orders SET status='cancelled', stock_reserved=0, updated=? WHERE order_id=? AND status NOT IN ('cancelled','returned')", now(), order.id);
}

/* ---------- customer view ---------- */
async function customerOrder(ref, token, user) {
  const o = await S.loadOrder('ref=?', String(ref || '').toUpperCase().slice(0, 20));
  const ok = o && ((token && o.access_token && token.length === o.access_token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(o.access_token))) || (user && o.user_id && Number(o.user_id) === Number(user.id)));
  if (!ok || o.delivery !== 'international') fail(404, 'We could not find that order.');
  const eo = await get('SELECT * FROM export_orders WHERE order_id=?', o.id);
  const ev = await all('SELECT stage, description, location, occurred_at, source FROM shipment_tracking_events WHERE export_order_id=? ORDER BY occurred_at, id', eo.id);
  return { ref: o.ref, export_ref: eo.ref, status: eo.status, payment_status: o.payment_status, created: Number(eo.created), currency: eo.currency, fx_rate_to_ngn: Number(eo.fx_rate_to_ngn), charged_ngn: Number(eo.total_ngn),
    amounts: { goods: Number(eo.subtotal), shipping: Number(eo.shipping), insurance: Number(eo.insurance), duties: Number(eo.duties), total: Number(eo.total) }, duties: { arrangement: eo.duty_arrangement, collected: !!Number(eo.duties_collected) },
    shipping: { method: eo.service_label, source: eo.quote_source, carrier: eo.carrier, tracking_number: eo.tracking_number, eta: eo.eta },
    destination: { country: eo.destination_country, city: eo.city, name: eo.ship_name }, items: o.items.map((i) => ({ name: i.name, qty: i.qty })), timeline: ev.map((e) => ({ stage: e.stage, description: e.description, location: e.location, at: Number(e.occurred_at) })) };
}

/* ---------- staff ---------- */
async function listOrders(q) {
  const { per, offset, page } = T.page(q, 25), where = ['1=1'], args = [];
  if (q.status && FLOW.concat(['cancelled', 'returned']).includes(q.status)) { where.push('eo.status=?'); args.push(q.status); }
  if (q.country) { where.push('eo.destination_country=?'); args.push(String(q.country).toUpperCase().slice(0, 2)); }
  if (q.q) { where.push('(eo.ref ILIKE ? OR o.ref ILIKE ? OR eo.ship_email ILIKE ? OR eo.ship_name ILIKE ? OR eo.tracking_number ILIKE ?)'); const s = '%' + String(q.q).slice(0, 60).replace(/[%_]/g, '') + '%'; args.push(s, s, s, s, s); }
  const base = `FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE ${where.join(' AND ')}`;
  return { total: (await get(`SELECT COUNT(*) n ${base}`, ...args)).n, page, per, orders: (await all(`SELECT eo.ref, o.ref AS order_ref, eo.status, eo.destination_country, eo.ship_name, eo.currency, eo.total, eo.total_ngn, eo.service_label, eo.tracking_number, eo.created, o.payment_status ${base} ORDER BY eo.id DESC LIMIT ? OFFSET ?`, ...args, per, offset))
    .map((r) => ({ ref: r.ref, order_ref: r.order_ref, status: r.status, country: r.destination_country, customer: r.ship_name, currency: r.currency, total: Number(r.total), total_ngn: Number(r.total_ngn), method: r.service_label, tracking_number: r.tracking_number, payment_status: r.payment_status, created: Number(r.created) })) };
}
async function loadAdmin(ref, lock) {
  const eo = await get(`SELECT eo.*, o.ref AS order_ref, o.payment_status, o.status AS order_status FROM export_orders eo JOIN orders o ON o.id=eo.order_id WHERE eo.ref=? OR o.ref=? ${lock ? 'FOR UPDATE OF eo' : ''}`, String(ref || '').toUpperCase(), String(ref || '').toUpperCase());
  if (!eo) fail(404, 'International order not found.');
  return eo;
}
async function getOrder(ref) {
  const eo = await loadAdmin(ref);
  const items = await all('SELECT i.*, p.sku FROM export_order_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.export_order_id=? ORDER BY i.id', eo.id);
  const ev = await all('SELECT id, stage, description, location, occurred_at, source FROM shipment_tracking_events WHERE export_order_id=? ORDER BY occurred_at, id', eo.id);
  const pay = await all('SELECT provider, provider_ref, currency, amount, status, verified, created FROM international_payments WHERE export_order_id=? ORDER BY id', eo.id);
  const { ...o } = eo; delete o.id;
  return { order: { ...o, id: Number(eo.id) }, items, events: ev, payments: pay, next: nextSteps(eo), settings: await T.settings() };
}
const nextSteps = (eo) => {
  if (['cancelled', 'returned', 'delivered'].includes(eo.status)) return eo.status === 'delivered' ? ['returned'] : [];
  const i = FLOW.indexOf(eo.status), n = FLOW.slice(i + 1).filter((s) => eo.payment_status === 'paid' && s !== 'confirmed');
  if (['dispatched', 'in_transit', 'customs', 'out_for_delivery'].includes(eo.status)) n.push('returned'); else n.push('cancelled');
  return n;
};
async function setStatus(ref, b, user, ip) {
  const to = String(b.status || ''), note = str(b.note, 300);
  const done = await tx(async () => {
    const eo = await loadAdmin(ref, true), from = eo.status;
    if (!nextSteps(eo).includes(to)) fail(409, `This order cannot move from "${from}" to "${to}".`);
    const order = await S.loadOrder('id=?', eo.order_id);
    if (to === 'cancelled') {
      if (Number(eo.stock_deducted)) fail(409, 'Stock was already confirmed as sold for this order. Use "returned" once the goods are back.');
      await S.cancelOrder(order, note || 'International order cancelled by staff'); await T.audit(user, 'export_order.cancel', 'export_orders', eo.ref, { from, note }, ip); return { from, to };
    }
    if (to === 'returned') { await run("UPDATE export_orders SET status='returned', updated=? WHERE id=?", now(), eo.id); await S.addEvent(eo.order_id, order.status, 'Shipment returned. ' + (note || '') + ' Stock is not returned automatically: adjust it when the goods are checked.', { internal: true }); await T.audit(user, 'export_order.return', 'export_orders', eo.ref, { from, note }, ip); return { from, to }; }
    if (to === 'packed') {
      const open = await get('SELECT COUNT(*) n FROM export_order_items WHERE export_order_id=? AND packed_qty<>qty', eo.id);
      if (Number(open.n) > 0) fail(409, 'Record the packed quantity of every item first (it must equal the ordered quantity).');
    }
    const carrier = str(b.carrier, 60) || eo.carrier, trk = str(b.tracking_number, 60) || eo.tracking_number;
    if (to === 'dispatched') { if (!carrier || !trk) fail(400, 'Enter the carrier and the tracking number before marking the shipment dispatched.'); }
    const eta = b.eta ? String(b.eta).slice(0, 10) : null; if (eta && !/^\d{4}-\d{2}-\d{2}$/.test(eta)) fail(400, 'The estimated delivery date must look like 2026-12-31.');
    await run('UPDATE export_orders SET status=?, carrier=?, tracking_number=?, eta=COALESCE(?::date, eta), updated=? WHERE id=?', to, carrier, trk, eta, now(), eo.id);
    const mapped = to === 'delivered' ? 'delivered' : FLOW.indexOf(to) >= FLOW.indexOf('dispatched') ? 'shipped' : 'processing';
    if (to === 'delivered') await run('UPDATE orders SET status=?, delivered_at=? WHERE id=?', mapped, now(), eo.order_id); else await run('UPDATE orders SET status=? WHERE id=? AND status NOT IN (\'delivered\',\'cancelled\',\'refunded\')', mapped, eo.order_id);
    const words = { processing: 'We are preparing your order.', packed: 'Your order is packed.', dispatched: `Your parcel has been dispatched${carrier ? ' with ' + carrier : ''}.${trk ? ' Tracking number: ' + trk + '.' : ''}`, in_transit: 'Your parcel is in transit.', customs: 'Your parcel is going through customs.', out_for_delivery: 'Your parcel is out for delivery.', delivered: 'Your parcel was delivered.' };
    await S.addEvent(eo.order_id, mapped, note || words[to] || '');
    await track(eo, STAGE[to], note || words[to] || '', { user, source: 'manual' });
    const at = (await T.settings()).export_stock_deduct_at;
    if (at !== 'confirm' && FLOW.indexOf(to) >= FLOW.indexOf(at === 'packed' ? 'packed' : 'dispatched')) await deduct(eo, to);
    await T.audit(user, 'export_order.status', 'export_orders', eo.ref, { from, to, carrier, tracking: trk }, ip);
    return { from, to };
  });
  return { ...done, order: (await getOrder(ref)).order };
}
async function pack(ref, b, user, ip) {
  const eo = await loadAdmin(ref);
  if (!['confirmed', 'processing'].includes(eo.status)) fail(409, 'Items can be packed while the order is confirmed or being processed.');
  if (!Array.isArray(b.items) || !b.items.length) fail(400, 'Nothing to save.');
  await tx(async () => {
    for (const it of b.items) {
      const row = await get('SELECT id, qty FROM export_order_items WHERE id=? AND export_order_id=?', Number(it.id) || 0, eo.id); if (!row) fail(404, 'One of those items is not on this order.');
      const n = Number(it.packed_qty); if (!Number.isInteger(n) || n < 0 || n > Number(row.qty)) fail(400, `Packed quantity must be a whole number from 0 to ${row.qty}.`);
      await run('UPDATE export_order_items SET packed_qty=? WHERE id=?', n, row.id);
    }
  });
  await T.audit(user, 'export_order.pack', 'export_orders', eo.ref, { items: b.items.length }, ip);
  return getOrder(ref);
}
async function addTrackingEvent(ref, b, user, ip) {
  const eo = await loadAdmin(ref), stage = String(b.stage || '');
  if (!['delayed', 'exception', 'customs_hold', 'departed_origin', 'arrived_destination', 'customs_released', 'export_customs', 'in_transit', 'import_customs', 'out_for_delivery'].includes(stage)) fail(400, 'Choose a valid tracking stage.');
  if (['cancelled', 'returned'].includes(eo.status)) fail(409, 'This order is closed.');
  await track(eo, stage, str(b.description, 300), { source: 'manual', location: str(b.location, 100), user, unique: false });
  await T.audit(user, 'export_order.tracking', 'export_orders', eo.ref, { stage }, ip);
  return getOrder(ref);
}
async function pickingList(ref, kind) {
  const eo = await loadAdmin(ref), items = await all('SELECT i.*, p.sku FROM export_order_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.export_order_id=? ORDER BY i.id', eo.id);
  const weight = items.reduce((a, i) => a + Number(i.weight_kg || 0) * i.qty, 0);
  return { kind: kind === 'packing' ? 'packing' : 'picking', order: eo.ref, retail_order: eo.order_ref, destination: { country: eo.destination_country, name: eo.ship_name, address: [eo.address_line1, eo.address_line2, eo.city, eo.region, eo.postal_code].filter(Boolean).join(', '), phone: `+${eo.phone_dial_code} ${eo.ship_phone}` },
    items: items.map((i) => ({ id: Number(i.id), sku: i.sku || '', name: i.description, hs_code: i.hs_code, origin: i.origin_country, qty: i.qty, packed_qty: i.packed_qty, weight_kg: Number(i.weight_kg || 0) })), total_weight_kg: Math.round(weight * 1000) / 1000, shipping_method: eo.service_label, printed_at: now() };
}

module.exports = { FLOW, quote, checkout, onPaid, onCancelled, customerOrder, listOrders, getOrder, setStatus, pack, addTrackingEvent, pickingList, cleanAddress, compute };
