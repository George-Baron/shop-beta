'use strict';
// Phase 2: pharmacy department. Everything here is reachable only when PHARMACY_ENABLED=1 (the routes return 404 otherwise).
// This is software support for a process that must be checked by a lawyer and the PCN. It does not make the business compliant by itself.
const crypto = require('crypto');
const { get, all, run, tx, now } = require('./db');
const S = require('./shop');
const PC = require('./pharmacy-core');
const sms = require('./sms');
const nepp = require('./nepp');
const storage = require('./storage');
const cache = require('./cache');

const { fail, str, int } = S;
const YEAR = 365 * 86400, RETAIN = 5 * YEAR;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const lagosToday = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const dateToEpoch = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / 1000) - 3600; // midnight Lagos time (UTC+1)
const addMonths = (epoch, n) => { const d = new Date(epoch * 1000); d.setUTCMonth(d.getUTCMonth() + n); return Math.floor(d.getTime() / 1000); };
const isSuper = (u) => !!u && u.role === 'pharmacist' && !u.pharmacy_id;      // our own superintendent pharmacist
const isPharmacist = (u) => !!u && u.role === 'pharmacist';
const who = (u) => `${u.name} (PCN ${u.reg_no || 'no reg. no.'})`;
const bump = async () => { cache.clear(); await cache.bump().catch(() => {}); };

async function setting(key, dflt = '') { const s = await S.getSettings(); return s[key] === undefined || s[key] === '' ? dflt : s[key]; }

/* ================= buyer identity (phone OTP + minimal ID) ================= */
const ID_TYPES = ['nin', 'voters', 'passport', 'drivers'];
async function identityOf(userId) { return get('SELECT * FROM buyer_identity WHERE user_id=?', userId); }
function publicIdentity(i) {
  if (!i) return { phoneVerified: false, idSubmitted: false, status: 'none' };
  return { fullName: i.full_name, phone: i.phone, phoneVerified: !!i.phone_verified_at, idSubmitted: ['submitted', 'verified'].includes(i.status), idType: i.id_type, idLast4: i.id_last4, status: i.status };
}
async function ensureIdentity(userId) {
  await run('INSERT INTO buyer_identity (user_id, created, updated, retain_until) VALUES (?,?,?,?) ON CONFLICT (user_id) DO NOTHING', userId, now(), now(), now() + RETAIN);
  return identityOf(userId);
}
async function startPhoneVerification(user, phoneRaw) {
  const phone = PC.normalizePhone(phoneRaw);
  if (!phone) fail(400, 'Please enter a Nigerian mobile number, like 0803 123 4567.');
  const recent = await get('SELECT COUNT(*) n FROM otps WHERE user_id=? AND created>?', user.id, now() - 3600);
  if (Number(recent.n) >= 5) fail(429, 'Too many codes requested. Please try again in an hour.');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await ensureIdentity(user.id);
  await run('INSERT INTO otps (user_id,target,code_hash,expires,created) VALUES (?,?,?,?,?)', user.id, phone, PC.mac('otp:' + user.id + ':' + phone + ':' + code), now() + 600, now());
  await sms.send(phone, `Your ${(await S.getSettings()).store_name} verification code is ${code}. It lasts 10 minutes. Do not share it.`);
  return { sent: true, live: sms.live() };
}
async function confirmPhone(user, codeRaw) {
  const code = String(codeRaw || '').replace(/\D/g, '');
  const o = await get('SELECT * FROM otps WHERE user_id=? AND used=0 AND expires>? ORDER BY id DESC LIMIT 1', user.id, now());
  if (!o) fail(400, 'That code has expired. Please ask for a new one.');
  if (o.attempts >= 5) fail(429, 'Too many wrong tries. Please ask for a new code.');
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(PC.mac('otp:' + user.id + ':' + o.target + ':' + code)), Buffer.from(o.code_hash));
  if (!ok) { await run('UPDATE otps SET attempts = attempts + 1 WHERE id=?', o.id); fail(400, 'That code is not right.'); }
  await tx(async () => {
    await run('UPDATE otps SET used=1 WHERE id=?', o.id);
    await run('UPDATE buyer_identity SET phone=?, phone_verified_at=?, updated=? WHERE user_id=?', o.target, now(), now(), user.id);
  });
  return publicIdentity(await identityOf(user.id));
}
async function submitIdentity(user, b) {
  const i = await ensureIdentity(user.id);
  if (!i.phone_verified_at) fail(400, 'Please verify your phone number first.');
  const fullName = str(b.fullName, 80), idType = str(b.idType, 12), num = String(b.idNumber || '').replace(/\s/g, '');
  if (fullName.split(/\s+/).filter(Boolean).length < 2) fail(400, 'Please enter your full name as it appears on your ID.');
  if (!ID_TYPES.includes(idType)) fail(400, 'Please choose the type of ID.');
  if (!/^[A-Za-z0-9-]{6,24}$/.test(num)) fail(400, 'That ID number does not look right.');
  await run("UPDATE buyer_identity SET full_name=?, id_type=?, id_last4=?, id_number_enc=?, status='submitted', verified_by='', verified_at=NULL, updated=? WHERE user_id=?",
    fullName, idType, num.slice(-4), PC.encryptText(num), now(), user.id);
  return publicIdentity(await identityOf(user.id));
}

/* ================= prescriptions ================= */
const FILE_TYPES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.length > 8 && b.toString('hex', 0, 4) === '89504e47' },
  { mime: 'application/pdf', test: (b) => b.toString('latin1', 0, 5) === '%PDF-' },
];
const MAX_RX_FILE = 4_000_000;
const newRxRef = () => 'RX-' + crypto.randomBytes(5).toString('hex').toUpperCase();
const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function createPrescription(user, ip, b) {
  const m = /^data:(?:image\/(?:png|jpeg)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.file || ''));
  if (!m) fail(400, 'Please upload a photo (JPG or PNG) or a PDF of the prescription.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_RX_FILE) fail(400, 'That file is over 4 MB.');
  const kind = FILE_TYPES.find((k) => k.test(buf));
  if (!kind) fail(400, 'That file is not a valid JPG, PNG or PDF.');

  const pr = b.prescriber || {}, pt = b.patient || {};
  const prescriber = { name: str(pr.name, 100), reg: str(pr.regNo, 40), council: str(pr.council, 20) || 'MDCN', phone: str(pr.phone, 30), email: str(pr.email, 120), address: str(pr.address, 200) };
  if (prescriber.name.length < 3) fail(400, 'Please enter the prescriber\'s name as written on the prescription.');
  if (prescriber.reg.length < 3) fail(400, 'Please enter the prescriber\'s registration number.');
  if (!PC.normalizePhone(prescriber.phone) && !S.isEmail(prescriber.email)) fail(400, 'Please enter the prescriber\'s phone number or email address.');
  if (prescriber.address.length < 6) fail(400, 'Please enter the prescriber\'s address (it must be in Nigeria).');
  const patient = { name: str(pt.name, 100), age: str(pt.age, 20), address: str(pt.address, 200) };
  if (patient.name.split(/\s+/).filter(Boolean).length < 2) fail(400, 'Please enter the patient\'s full name as written on the prescription.');
  const issuedOn = str(b.issuedOn, 10);
  if (!isDate(issuedOn)) fail(400, 'Please enter the date on the prescription.');
  if (issuedOn > lagosToday()) fail(400, 'The prescription date is in the future.');
  const issued = dateToEpoch(issuedOn), validUntil = addMonths(issued, 6);
  if (validUntil < now()) fail(400, 'This prescription is more than 6 months old and can no longer be used. Please ask the prescriber for a new one.');
  const duration = Math.min(365, Math.max(0, int(b.durationDays)));
  const maxFills = Math.min(12, Math.max(1, int(b.maxFills, 1)));
  const interval = Math.min(365, Math.max(0, int(b.refillIntervalDays)));
  if (maxFills > 1 && interval < 1) fail(400, 'This prescription allows refills: enter how many days the prescriber wants between them.');
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 20).map((l) => ({ drug: str(l && l.drug, 160), qty: int(l && l.qty), productId: l && l.productId ? int(l.productId) : null }));
  if (!lines.length || lines.some((l) => !l.drug || l.qty < 1 || l.qty > 999)) fail(400, 'List each medicine on the prescription with the quantity written (1 to 999).');

  const sha = sha256(buf);
  const fp = PC.mac(['rx', normText(prescriber.reg), normText(patient.name), issuedOn].join('|'));
  const dupe = await get('SELECT id, user_id, status, fills_used, fills_reserved, max_fills FROM prescriptions WHERE (file_sha256=? OR fingerprint=?) AND status NOT IN (\'rejected\',\'cancelled\') ORDER BY id LIMIT 1', sha, fp);
  if (dupe && Number(dupe.user_id) === Number(user.id) && dupe.fills_used + dupe.fills_reserved < dupe.max_fills) fail(409, 'You have already uploaded this prescription. Please use that one.');
  for (const l of lines) if (l.productId && !(await get('SELECT 1 x FROM products WHERE id=? AND is_pharmacy=1', l.productId))) l.productId = null;

  const ref = newRxRef(), key = ref.toLowerCase() + '.bin';
  await storage.prescriptions.put(key, PC.encryptBuf(buf));
  const id = await tx(async () => {
    const r = await run(`INSERT INTO prescriptions (ref,user_id,file_key,file_mime,file_sha256,prescriber_name,prescriber_reg_no,prescriber_council,prescriber_contact,prescriber_address,patient_enc,fingerprint,
        issued_on,valid_until,duration_days,max_fills,refill_interval_days,created,updated,retain_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, user.id, key, kind.mime, sha, prescriber.name, prescriber.reg, prescriber.council, [prescriber.phone, prescriber.email].filter(Boolean).join(' / '), prescriber.address,
      PC.encryptText(JSON.stringify(patient)), fp, issued, validUntil, duration, maxFills, interval, now(), now(), now() + RETAIN);
    const pid = Number(r.lastInsertRowid);
    for (const l of lines) await run('INSERT INTO prescription_lines (prescription_id,product_id,drug_text,qty_written) VALUES (?,?,?,?)', pid, l.productId, l.drug, l.qty);
    return pid;
  });
  await PC.audit(user, ip, 'rx_upload', 'prescription', id, ref);
  return { id, ref, duplicateWarning: !!dupe };
}
async function rxLines(id) { return all('SELECT id, product_id, drug_text, qty_written FROM prescription_lines WHERE prescription_id=? ORDER BY id', id); }
// What a customer or pharmacist sees. Patient details are decrypted here and nowhere else.
async function presentRx(rx) {
  let patient = {}; try { patient = JSON.parse(PC.decryptText(rx.patient_enc) || '{}'); } catch { patient = { name: '(could not be decrypted)' }; }
  return {
    id: rx.id, ref: rx.ref, status: rx.status, mime: rx.file_mime, issued_on: rx.issued_on, valid_until: rx.valid_until, duration_days: rx.duration_days, max_fills: rx.max_fills, fills_used: rx.fills_used,
    fills_reserved: rx.fills_reserved, refill_interval_days: rx.refill_interval_days, last_filled_at: rx.last_filled_at,
    prescriber: { name: rx.prescriber_name, regNo: rx.prescriber_reg_no, council: rx.prescriber_council, contact: rx.prescriber_contact, address: rx.prescriber_address }, patient,
    reviewer: rx.reviewer_name ? { name: rx.reviewer_name, regNo: rx.reviewer_reg_no, at: rx.reviewed_at } : null, register_check: rx.register_check, decision_note: rx.decision_note, lines: await rxLines(rx.id),
  };
}
async function myPrescriptions(user) {
  const rows = await all('SELECT * FROM prescriptions WHERE user_id=? ORDER BY id DESC LIMIT 30', user.id);
  const out = []; for (const r of rows) { const p = await presentRx(r); delete p.register_check; out.push(p); }
  return out;
}
// The file is decrypted only for the owner or a pharmacist who is reviewing it, and every opening is logged.
async function openFile(user, ip, id) {
  const rx = await get('SELECT * FROM prescriptions WHERE id=?', id);
  if (!rx) fail(404, 'Prescription not found.');
  if (Number(rx.user_id) !== Number(user.id)) {
    if (!isPharmacist(user)) fail(403, 'Not allowed.');
    if (!isSuper(user) && !(await get('SELECT 1 x FROM order_rx r JOIN orders o ON o.id=r.order_id WHERE r.prescription_id=? AND o.pharmacy_id=?', id, user.pharmacy_id))) fail(403, 'This prescription is not for your pharmacy.');
  }
  await PC.audit(user, ip, 'rx_file_view', 'prescription', id, rx.ref);
  return { mime: rx.file_mime, buf: PC.decryptBuf(await storage.prescriptions.get(rx.file_key)) };
}

/* ================= medicines in a cart ================= */
// Called by checkout. Returns null for an ordinary cart. Throws a 400 when a medicine order breaks a rule.
async function inspectCart(lines, user, body) {
  if (!PC.enabled()) return null;
  const ids = [...new Set(lines.map((l) => l.productId))];
  const ps = await all(`SELECT id, name, is_pharmacy, is_medicine, rx_required, temp_sensitive, max_qty, partner_id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const meds = ps.filter((p) => p.is_pharmacy);
  if (!meds.length) return null;
  if (meds.length !== ps.length) fail(400, 'Medicines must be ordered separately from other items. Please check out your medicines on their own.');
  if (body.delivery === 'pickup') fail(400, 'Medicines are delivered to your door by the pharmacy\'s rider. Store pickup is not available for them.');
  if (!user) fail(401, 'Please sign in to order medicines.');
  const pharmacyIds = new Set();
  for (const p of meds) {
    const ph = await get('SELECT id FROM pharmacies WHERE partner_id=?', p.partner_id);
    if (!ph) fail(400, `${p.name} is not available right now.`);
    pharmacyIds.add(Number(ph.id));
  }
  if (pharmacyIds.size > 1) fail(400, 'Your medicines come from more than one pharmacy. Please order from one pharmacy at a time.');
  const i = await identityOf(user.id);
  if (!i || !i.phone_verified_at) fail(403, 'Please verify your phone number before ordering medicines.');
  if (!['submitted', 'verified'].includes(i.status)) fail(403, 'Please add your ID details before ordering medicines.');
  const rxRequired = meds.some((p) => p.rx_required);
  return { pharmacyId: [...pharmacyIds][0], rxRequired, tempSensitive: meds.some((p) => p.temp_sensitive), meds: new Map(meds.map((p) => [Number(p.id), p])) };
}
async function usableRx(rx, userId, orderId) {
  if (!rx || Number(rx.user_id) !== Number(userId)) fail(400, 'One of the prescriptions is not yours.');
  if (!['submitted', 'approved', 'partly_approved', 'needs_info'].includes(rx.status)) fail(400, `Prescription ${rx.ref} cannot be used (${rx.status}).`);
  if (Number(rx.valid_until) < now()) fail(400, `Prescription ${rx.ref} has expired (prescriptions last 6 months).`);
  if (rx.fills_used + rx.fills_reserved >= rx.max_fills) fail(400, `Prescription ${rx.ref} has already been used the number of times it allows.`);
  if (rx.last_filled_at && rx.refill_interval_days && now() < Number(rx.last_filled_at) + rx.refill_interval_days * 86400)
    fail(400, `Prescription ${rx.ref} can only be refilled ${rx.refill_interval_days} days after the last supply.`);
  const busy = await get("SELECT o.ref FROM order_rx r JOIN orders o ON o.id=r.order_id WHERE r.prescription_id=? AND o.status<>'cancelled' AND o.rx_status IN ('submitted','needs_info') AND o.id<>?", rx.id, orderId || 0);
  if (busy) fail(400, `Prescription ${rx.ref} is already attached to order ${busy.ref}, which is waiting for the pharmacist.`);
}
// Before stock is taken: the prescriptions must exist and cover what is in the cart.
async function checkPrescriptions(ph, lines, user, body) {
  if (!ph.rxRequired) return { rxs: [] };
  const ids = [...new Set((Array.isArray(body.prescriptionIds) ? body.prescriptionIds : []).map((x) => int(x)).filter((x) => x > 0))].slice(0, 6);
  if (!ids.length) fail(400, 'This order has prescription-only medicines. Please upload the prescription first.');
  const rxs = [];
  for (const id of ids) { const rx = await get('SELECT * FROM prescriptions WHERE id=?', id); await usableRx(rx, user.id); rxs.push(rx); }
  for (const l of lines) {
    const p = ph.meds.get(Number(l.productId)); if (!p || !p.rx_required) continue;
    const mapped = [];
    for (const rx of rxs) mapped.push(...(await rxLines(rx.id)).filter((x) => Number(x.product_id) === Number(l.productId)));
    if (mapped.length && l.qty > Math.max(...mapped.map((x) => x.qty_written))) fail(400, `You asked for ${l.qty} of ${l.name}, but the prescription allows ${Math.max(...mapped.map((x) => x.qty_written))}. A pharmacy can only supply the quantity written.`);
  }
  return { rxs };
}
// Inside the order transaction, after the order and its items are saved.
async function attach(orderId, ph, checked, user) {
  const status = ph.rxRequired ? 'submitted' : 'none';
  await run('UPDATE orders SET is_pharmacy=1, pharmacy_id=?, rx_required=?, rx_status=?, temp_sensitive=? WHERE id=?', ph.pharmacyId, ph.rxRequired ? 1 : 0, status, ph.tempSensitive ? 1 : 0, orderId);
  for (const rx of checked.rxs) {
    await run('INSERT INTO order_rx (order_id, prescription_id) VALUES (?,?) ON CONFLICT DO NOTHING', orderId, rx.id);
    for (const ln of await rxLines(rx.id)) if (ln.product_id) await run('UPDATE order_items SET rx_line_id=? WHERE order_id=? AND product_id=? AND rx_line_id IS NULL', ln.id, orderId, ln.product_id);
  }
  await runFlags(orderId, ph, checked.rxs, user);
  await S.addEvent(orderId, 'pending', ph.rxRequired ? 'Waiting for the pharmacist to check your prescription. Nothing is dispatched until it is approved.' : 'Medicines order placed.');
}

/* ================= suspicious-order flags ================= */
async function addFlag(orderId, kind, detail) {
  if (await get("SELECT 1 x FROM pharmacy_flags WHERE order_id=? AND kind=? AND status='open'", orderId, kind)) return;
  await run('INSERT INTO pharmacy_flags (order_id,kind,detail,created) VALUES (?,?,?,?)', orderId, kind, detail, now());
  await run('UPDATE orders SET pharm_hold=1 WHERE id=?', orderId);
}
async function runFlags(orderId, ph, rxs, user) {
  const o = await get('SELECT * FROM orders WHERE id=?', orderId), digits = String(o.phone).replace(/\D/g, '').slice(-10), t = now();
  const mine = await get("SELECT COUNT(*) n FROM orders WHERE is_pharmacy=1 AND id<>? AND status<>'cancelled' AND created>? AND (user_id=? OR right(regexp_replace(phone,'[^0-9]','','g'),10)=?)", orderId, t - 86400, o.user_id, digits);
  if (Number(mine.n) >= 2) await addFlag(orderId, 'repeat_person', `${Number(mine.n) + 1} medicine orders from the same person in 24 hours.`);
  if (o.address) {
    const a = await get("SELECT COUNT(DISTINCT user_id) n FROM orders WHERE is_pharmacy=1 AND id<>? AND status<>'cancelled' AND created>? AND user_id IS DISTINCT FROM ? AND lower(state)=lower(?) AND regexp_replace(lower(address),'[^a-z0-9]','','g')=?",
      orderId, t - 7 * 86400, o.user_id, o.state, normText(o.address));
    if (Number(a.n) > 0) await addFlag(orderId, 'repeat_address', 'This address was used by a different customer for a medicine order in the last 7 days.');
  }
  const limit = int(await setting('pharm_large_qty', '10'), 10);
  for (const it of await all('SELECT oi.qty, oi.name, p.max_qty FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?', orderId)) {
    const cap = it.max_qty > 0 ? it.max_qty : limit;
    if (it.qty > cap) await addFlag(orderId, 'large_quantity', `${it.qty} × ${it.name} is above the usual limit of ${cap}.`);
  }
  for (const rx of rxs) {
    const other = await get("SELECT id FROM prescriptions WHERE id<>? AND (file_sha256=? OR fingerprint=?) AND status NOT IN ('rejected','cancelled') LIMIT 1", rx.id, rx.file_sha256, rx.fingerprint);
    if (other) await addFlag(orderId, 'reused_prescription', `Prescription ${rx.ref} matches another prescription already in the system (same image or same prescriber, patient and date).`);
  }
}
async function resolveFlag(user, ip, flagId, status, note) {
  if (!(isSuper(user) || user.role === 'admin')) fail(403, 'Only the superintendent pharmacist or an administrator can review flags.');
  if (!['cleared', 'confirmed'].includes(status)) fail(400, 'Choose "cleared" or "confirmed".');
  note = str(note, 300); if (note.length < 5) fail(400, 'Please write a note for the record.');
  const f = await get('SELECT * FROM pharmacy_flags WHERE id=?', flagId);
  if (!f || f.status !== 'open') fail(404, 'That flag is not open.');
  await tx(async () => {
    await run('UPDATE pharmacy_flags SET status=?, reviewed_by=?, reviewed_at=?, note=? WHERE id=?', status, user.name, now(), note, f.id);
    if (status === 'confirmed') { const o = await S.loadOrder('id=?', f.order_id); if (o && o.status !== 'delivered') await S.cancelOrder(o, 'Cancelled after a pharmacy review. Contact the store if you think this is a mistake.'); }
    if (!(await get("SELECT 1 x FROM pharmacy_flags WHERE order_id=? AND status='open'", f.order_id))) {
      await run('UPDATE orders SET pharm_hold=0 WHERE id=?', f.order_id);
      const o = await get('SELECT * FROM orders WHERE id=?', f.order_id);
      // money that arrived while the order was held lets it go forward now
      if (status === 'cleared' && o.payment_method === 'paystack' && o.payment_status === 'paid' && o.status === 'pending' && (!o.rx_required || o.rx_status === 'verified')) {
        await run("UPDATE orders SET status='paid' WHERE id=?", o.id); await S.addEvent(o.id, 'paid', 'Payment received'); await require('./delivery').issueCode(o.id);
      }
    }
  });
  await PC.audit(user, ip, 'flag_' + status, 'order', f.order_id, f.kind);
}
async function listFlags(status = 'open') {
  return all(`SELECT f.*, o.ref FROM pharmacy_flags f JOIN orders o ON o.id=f.order_id WHERE f.status=? ORDER BY f.id DESC LIMIT 200`, status);
}

/* ================= pharmacist verification ================= */
async function myQueue(user) {
  if (!isPharmacist(user)) fail(403, 'Not allowed.');
  const where = isSuper(user) ? '' : 'AND o.pharmacy_id = ' + Number(user.pharmacy_id);
  return all(`SELECT o.id, o.ref, o.created, o.rx_status, o.pharm_hold, o.temp_sensitive, o.total, ph.pharmacy_name,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) items
    FROM orders o LEFT JOIN pharmacies ph ON ph.id=o.pharmacy_id WHERE o.rx_required=1 AND o.rx_status IN ('submitted','needs_info') AND o.status<>'cancelled' ${where} ORDER BY o.created LIMIT 200`);
}
async function loadForReview(user, orderId) {
  if (!isPharmacist(user)) fail(403, 'Not allowed.');
  const o = await S.loadOrder('id=?', orderId);
  if (!o || !o.rx_required) fail(404, 'Order not found.');
  if (!isSuper(user) && Number(o.pharmacy_id) !== Number(user.pharmacy_id)) fail(403, 'This order is for a different pharmacy.');
  return o;
}
async function reviewOrder(user, ip, orderId) {
  const o = await loadForReview(user, orderId);
  const rxs = await all('SELECT p.* FROM order_rx r JOIN prescriptions p ON p.id=r.prescription_id WHERE r.order_id=? ORDER BY p.id', o.id);
  const idn = o.user_id ? await identityOf(o.user_id) : null;
  await PC.audit(user, ip, 'order_review_open', 'order', o.id, o.ref);
  return {
    order: { id: o.id, ref: o.ref, status: o.status, rx_status: o.rx_status, created: o.created, name: o.name, total: o.total, hold: !!o.pharm_hold, temp_sensitive: !!o.temp_sensitive,
      items: o.items.map((i) => ({ id: i.id, product_id: i.product_id, name: i.name, qty: i.qty, rx_line_id: i.rx_line_id })) },
    buyer: idn ? { fullName: idn.full_name, phoneVerified: !!idn.phone_verified_at, idType: idn.id_type, idLast4: idn.id_last4, idStatus: idn.status } : null,
    prescriptions: await Promise.all(rxs.map(presentRx)),
    flags: await all('SELECT id, kind, detail, status FROM pharmacy_flags WHERE order_id=? ORDER BY id', o.id),
    items_need_prescription: (await all('SELECT oi.id FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND p.rx_required=1', o.id)).map((r) => r.id),
  };
}
// decision: approve | partial | reject | need_info
async function decide(user, ip, orderId, b) {
  if (!isPharmacist(user) || !user.reg_no) fail(403, 'Only a pharmacist with a registration number on file can decide.');
  const o = await loadForReview(user, orderId);
  if (!['submitted', 'needs_info'].includes(o.rx_status) || o.status === 'cancelled') fail(409, 'This order is not waiting for a decision.');
  const decision = str(b.decision, 12), reason = str(b.reason, 500);
  if (!['approve', 'partial', 'reject', 'need_info'].includes(decision)) fail(400, 'Choose approve, partly approve, reject or ask for more information.');
  const rxs = await all('SELECT p.* FROM order_rx r JOIN prescriptions p ON p.id=r.prescription_id WHERE r.order_id=?', o.id);
  const now_ = now();

  if (decision === 'reject' || decision === 'need_info') {
    if (reason.length < 5) fail(400, 'Please write the reason. The customer will see it.');
    await tx(async () => {
      if (decision === 'reject') {
        await run("UPDATE prescriptions SET status='rejected', reviewer_id=?, reviewer_name=?, reviewer_reg_no=?, reviewed_at=?, decision_note=?, updated=? WHERE id IN (SELECT prescription_id FROM order_rx WHERE order_id=?)", user.id, user.name, user.reg_no, now_, reason, now_, o.id);
        await run("UPDATE orders SET rx_status='rejected' WHERE id=?", o.id);
        await S.cancelOrder(o, `Prescription not accepted by ${who(user)}: ${reason}`);
      } else {
        await run("UPDATE prescriptions SET status='needs_info', reviewer_id=?, reviewer_name=?, reviewer_reg_no=?, reviewed_at=?, decision_note=?, updated=? WHERE id IN (SELECT prescription_id FROM order_rx WHERE order_id=?)", user.id, user.name, user.reg_no, now_, reason, now_, o.id);
        await run("UPDATE orders SET rx_status='needs_info' WHERE id=?", o.id);
        await S.addEvent(o.id, o.status, `The pharmacist needs more information: ${reason}`);
      }
    });
    await PC.audit(user, ip, 'rx_' + decision, 'order', o.id, reason);
    await notifyCustomer(o, decision === 'reject' ? 'We could not accept your prescription' : 'We need more information about your prescription', reason);
    return { ok: true, decision };
  }

  // approve / partial
  const check = str(b.registerCheck, 400);
  if (check.length < 10) fail(400, 'Record how you checked the prescriber on the council register (what you searched and what you found).');
  if (!b.identityChecked) fail(400, 'Please confirm you checked the buyer\'s ID details against the prescription.');
  if (o.pharm_hold) fail(409, 'This order has an open suspicious-order flag. The superintendent pharmacist must review it first.');
  if (!rxs.length) fail(400, 'No prescription is attached to this order.');
  const lineMap = new Map(); for (const rx of rxs) for (const l of await rxLines(rx.id)) lineMap.set(Number(l.id), { ...l, rx });
  for (const rx of rxs) {
    if (Number(rx.valid_until) < now_) fail(400, `Prescription ${rx.ref} has expired. Reject the order.`);
    if (rx.fills_used + rx.fills_reserved >= rx.max_fills) fail(400, `Prescription ${rx.ref} has no fills left. Reject the order.`);
    if (rx.last_filled_at && rx.refill_interval_days && now_ < Number(rx.last_filled_at) + rx.refill_interval_days * 86400) fail(400, `Prescription ${rx.ref} is not due for a refill yet.`);
  }
  const ph = await get('SELECT * FROM pharmacies WHERE id=?', o.pharmacy_id);
  if (!ph || ph.status !== 'approved' || Number(ph.licence_expires) < now_) fail(409, 'This pharmacy\'s licence is not current. The order cannot be approved.');
  const rxIds = await all('SELECT oi.id, oi.product_id FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND p.rx_required=1', o.id);
  const needs = new Set(rxIds.map((r) => Number(r.id)));
  const given = new Map((Array.isArray(b.items) ? b.items : []).map((x) => [Number(x.orderItemId), { lineId: x.lineId ? Number(x.lineId) : null, qty: int(x.qty, -1) }]));
  const changes = [];
  for (const it of o.items) {
    const g = given.get(Number(it.id)) || { lineId: it.rx_line_id ? Number(it.rx_line_id) : null, qty: it.qty };
    const qty = g.qty < 0 ? it.qty : g.qty;
    if (qty > it.qty) fail(400, `${it.name}: the approved quantity cannot be more than was ordered.`);
    if (decision === 'approve' && qty !== it.qty) fail(400, 'To approve fewer items or smaller quantities, choose "Partly approve".');
    const lineId = needs.has(Number(it.id)) ? (g.lineId || (it.rx_line_id ? Number(it.rx_line_id) : null)) : null;
    if (needs.has(Number(it.id)) && qty > 0) {
      const ln = lineMap.get(lineId);
      if (!ln) fail(400, `${it.name}: choose which line of the prescription it matches.`);
      if (qty > ln.qty_written) fail(400, `${it.name}: the prescription allows ${ln.qty_written}. Only the quantity written can be supplied.`);
    }
    changes.push({ it, qty, lineId });
  }
  if (!changes.some((c) => c.qty > 0)) fail(400, 'Nothing is approved. Choose "Reject" instead.');
  if (decision === 'partial' && changes.every((c) => c.qty === c.it.qty)) fail(400, 'Everything is approved as ordered. Choose "Approve".');

  await tx(async () => {
    let subtotal = 0;
    for (const c of changes) {
      const cut = c.it.qty - c.qty;
      if (cut > 0) {
        if (c.it.variant_id) await run('UPDATE variants SET stock = stock + ? WHERE id=?', cut, c.it.variant_id); else await run('UPDATE products SET stock = stock + ? WHERE id=?', cut, c.it.product_id);
        await S.recalcStock(c.it.product_id); cache.drop('stock:' + c.it.product_id);
        await run('UPDATE products SET sold = GREATEST(0, sold - ?) WHERE id=?', cut, c.it.product_id);
      }
      if (c.qty === 0) await run('DELETE FROM order_items WHERE id=?', c.it.id);
      else { await run('UPDATE order_items SET qty=?, rx_line_id=? WHERE id=?', c.qty, c.lineId, c.it.id); subtotal += c.qty * c.it.price; }
    }
    const discount = Math.min(o.discount, subtotal), total = subtotal - discount + o.delivery_fee;
    await run('UPDATE orders SET subtotal=?, discount=?, total=?, rx_status=?, rx_fill_reserved=1 WHERE id=?', subtotal, discount, total, 'verified', o.id);
    for (const rx of rxs) await run('UPDATE prescriptions SET status=?, fills_reserved = fills_reserved + 1, reviewer_id=?, reviewer_name=?, reviewer_reg_no=?, reviewed_at=?, register_check=?, decision_note=?, updated=? WHERE id=?',
      decision === 'partial' ? 'partly_approved' : 'approved', user.id, user.name, user.reg_no, now_, check, reason, now_, rx.id);
    if (o.user_id) await run("UPDATE buyer_identity SET status='verified', verified_by=?, verified_at=?, updated=? WHERE user_id=? AND status IN ('submitted','verified')", who(user), now_, now_, o.user_id);
    await S.addEvent(o.id, o.status, `Prescription ${decision === 'partial' ? 'partly approved' : 'approved'} by ${who(user)}.${decision === 'partial' ? ' Some items or quantities were reduced: ' + (reason || 'see your order.') : ''}`);
    // Money that already arrived before approval (for example a demo payment) lets the order go forward now.
    const fresh = await get('SELECT * FROM orders WHERE id=?', o.id);
    if (fresh.payment_method === 'paystack' && fresh.payment_status === 'paid' && fresh.status === 'pending') {
      await run("UPDATE orders SET status='paid' WHERE id=?", o.id); await S.addEvent(o.id, 'paid', 'Payment received'); await require('./delivery').issueCode(o.id);
    }
  });
  await PC.audit(user, ip, 'rx_' + decision, 'order', o.id, check);
  const fresh = await S.loadOrder('id=?', o.id);
  await notifyCustomer(fresh, 'Your prescription was approved', fresh.payment_method === 'paystack' && fresh.payment_status !== 'paid'
    ? `Please pay ${S.naira(fresh.total)} to confirm your order: ${S.BASE_URL}/order/${fresh.ref}?t=${fresh.access_token}` : 'Your order will now be prepared.');
  return { ok: true, decision, total: fresh.total };
}
async function notifyCustomer(o, subject, text) {
  try {
    const s = await S.getSettings();
    await S.queueMail(o.email, `${subject} · order ${o.ref}`, S.mailWrap(s, `<p>${S.esc(text)}</p><p><a href="${S.BASE_URL}/order/${S.esc(o.ref)}?t=${S.esc(o.access_token)}">View your order</a></p>`));
  } catch (e) { console.error('pharmacy mail failed:', e.message); }
}
// The customer answers a "need more information" request by adding another prescription or a corrected one.
async function addPrescriptionToOrder(user, ip, ref, rxId) {
  const o = await S.loadOrder('ref=? AND user_id=?', str(ref, 20), user.id);
  if (!o || !o.rx_required) fail(404, 'Order not found.');
  if (o.rx_status !== 'needs_info' || o.status === 'cancelled') fail(409, 'This order is not asking for more information.');
  const rx = await get('SELECT * FROM prescriptions WHERE id=?', int(rxId));
  await usableRx(rx, user.id, o.id);
  await tx(async () => {
    await run('INSERT INTO order_rx (order_id, prescription_id) VALUES (?,?) ON CONFLICT DO NOTHING', o.id, rx.id);
    for (const ln of await rxLines(rx.id)) if (ln.product_id) await run('UPDATE order_items SET rx_line_id=? WHERE order_id=? AND product_id=? AND rx_line_id IS NULL', ln.id, o.id, ln.product_id);
    await run("UPDATE orders SET rx_status='submitted' WHERE id=?", o.id);
    await run("UPDATE prescriptions SET status='submitted', updated=? WHERE id IN (SELECT prescription_id FROM order_rx WHERE order_id=?) AND status='needs_info'", now(), o.id);
    await S.addEvent(o.id, o.status, 'You sent more information. Waiting for the pharmacist.');
  });
  await runFlags(o.id, null, [rx], user);
}
// After approval, an online-pay order is paid by the customer. Returns what the checkout returns.
async function payAfterApproval(order) {
  if (order.status === 'cancelled') fail(409, 'This order was cancelled.');
  if (order.payment_method !== 'paystack' || order.payment_status === 'paid') fail(400, 'Nothing to pay.');
  if (order.rx_required && order.rx_status !== 'verified') fail(409, 'The pharmacist has not approved this prescription yet.');
  if (order.pharm_hold) fail(409, 'This order is being reviewed. We will contact you.');
  if (!S.paystackLive()) return { ref: order.ref, token: order.access_token, next: 'demo' };
  if (!order.pay_url) { order.pay_url = await S.paystackInitialize(order); await run('UPDATE orders SET pay_url=? WHERE id=?', order.pay_url, order.id); }
  return { ref: order.ref, token: order.access_token, next: 'paystack', url: order.pay_url };
}
// Unverified prescription orders do not hold stock forever.
async function expireRxOrders() {
  if (!PC.enabled()) return 0;
  const hours = Math.min(720, Math.max(1, int(await setting('pharm_unverified_hours', '48'), 48)));
  let n = 0;
  for (const r of await all("SELECT id FROM orders WHERE rx_required=1 AND rx_status IN ('submitted','needs_info') AND status='pending' AND created<?", now() - hours * 3600)) {
    const o = await S.loadOrder('id=?', r.id);
    if (o && o.status === 'pending') { await S.cancelOrder(o, `The prescription was not verified within ${hours} hours.`); n++; }
  }
  return n;
}

/* ================= delivery rules ================= */
// The rider asks the person at the door for their name. It must match the buyer, as well as the handover code.
async function checkRecipient(order, given) {
  if (!order.is_pharmacy) return { ok: true };
  const idn = order.user_id ? await identityOf(order.user_id) : null;
  const expected = (idn && idn.full_name) || order.name;
  if (!String(given || '').trim()) return { ok: false, message: 'Ask the person at the door for their full name and enter it. Medicines are handed only to the buyer.' };
  if (!PC.nameMatches(given, expected)) return { ok: false, message: 'That name does not match the buyer. Do not hand over the medicines. Call the shop.' };
  return { ok: true, name: String(given).trim().slice(0, 80) };
}
async function checkRider(order, riderId) {
  if (!order.temp_sensitive) return;
  const r = await get("SELECT gdp FROM users WHERE id=? AND role='rider'", riderId);
  if (!r || !r.gdp) fail(400, 'This order contains temperature-sensitive medicines. It must go with a rider marked as meeting Good Distribution Practice (cold chain).');
}

/* ================= returns ================= */
const RETURN_REASONS = ['tampered', 'expired', 'wrong_item', 'damaged'];
async function requestReturn(user, b) {
  const o = await S.loadOrder('ref=? AND user_id=?', str(b.ref, 20), user.id);
  if (!o || !o.is_pharmacy) fail(404, 'Order not found.');
  if (o.status !== 'delivered') fail(400, 'Only delivered orders can be returned.');
  const reason = str(b.reason, 20);
  if (!RETURN_REASONS.includes(reason)) fail(400, 'Medicines can only be returned if they arrived tampered with, expired, damaged, or not what you ordered.');
  const days = int(await setting('pharm_return_days', '7'), 7);
  if (o.delivered_at && now() > Number(o.delivered_at) + days * 86400) fail(400, `Returns must be reported within ${days} days of delivery.`);
  if (await get("SELECT 1 x FROM medicine_returns WHERE order_id=? AND status IN ('requested','approved')", o.id)) fail(409, 'You already reported a problem with this order.');
  const r = await run('INSERT INTO medicine_returns (order_id,user_id,reason,note,created,updated) VALUES (?,?,?,?,?,?)', o.id, user.id, reason, str(b.note, 500), now(), now());
  return { id: Number(r.lastInsertRowid) };
}
async function listReturns(user) {
  if (!(isPharmacist(user) || user.role === 'admin')) fail(403, 'Not allowed.');
  const own = isPharmacist(user) && !isSuper(user) ? ` AND o.pharmacy_id=${Number(user.pharmacy_id)}` : '';
  return all(`SELECT r.*, o.ref, o.name FROM medicine_returns r JOIN orders o ON o.id=r.order_id WHERE 1=1 ${own} ORDER BY r.id DESC LIMIT 200`);
}
async function updateReturn(user, id, b) {
  if (!(isPharmacist(user) || user.role === 'admin')) fail(403, 'Not allowed.');
  const status = str(b.status, 12); if (!['approved', 'rejected', 'collected'].includes(status)) fail(400, 'Choose approved, rejected or collected.');
  const resolution = str(b.resolution, 300); if (resolution.length < 5) fail(400, 'Please write what was decided (refund, replacement or reason for refusing).');
  // Returned medicines are NEVER put back on sale automatically: restock stays 0.
  const r = await run('UPDATE medicine_returns SET status=?, resolution=?, handled_by=?, updated=? WHERE id=?', status, resolution, user.name, now(), int(id));
  if (!r.changes) fail(404, 'Return not found.');
}

/* ================= products: set by the pharmacy, approved by our superintendent ================= */
async function saveMedFields(user, id, b) {
  if (!isPharmacist(user)) fail(403, 'Only a pharmacist can set the medicine details.');
  const p = await get('SELECT * FROM products WHERE id=?', int(id));
  if (!p) fail(404, 'Product not found.');
  if (!isSuper(user)) {
    const ph = await get('SELECT partner_id FROM pharmacies WHERE id=?', user.pharmacy_id);
    if (!ph || Number(ph.partner_id) !== Number(p.partner_id)) fail(403, 'This product belongs to a different pharmacy.');
  }
  const expiry = str(b.expiry_date, 10);
  if (expiry && !isDate(expiry)) fail(400, 'Expiry date must look like 2027-03-31.');
  const f = { is_medicine: b.is_medicine ? 1 : 0, rx_required: b.rx_required ? 1 : 0, nafdac_no: str(b.nafdac_no, 30).toUpperCase(), batch_no: str(b.batch_no, 40), expiry_date: expiry,
    storage_temp: str(b.storage_temp, 60), temp_sensitive: b.temp_sensitive ? 1 : 0, max_qty: Math.min(999, Math.max(0, int(b.max_qty))) };
  await run("UPDATE products SET is_medicine=?, rx_required=?, nafdac_no=?, batch_no=?, expiry_date=?, storage_temp=?, temp_sensitive=?, max_qty=?, pharm_status='pending', pharm_approved_by='', pharm_approved_at=NULL WHERE id=?",
    f.is_medicine, f.rx_required, f.nafdac_no, f.batch_no, f.expiry_date, f.storage_temp, f.temp_sensitive, f.max_qty, p.id);
  await bump();
}
async function productsToApprove(user) {
  if (!isSuper(user)) fail(403, 'Only our superintendent pharmacist approves medicine listings.');
  return all("SELECT p.id, p.name, p.brand, p.price, p.is_medicine, p.rx_required, p.nafdac_no, p.batch_no, p.expiry_date, p.storage_temp, p.temp_sensitive, p.max_qty, p.pharm_status, p.partner_id, pt.name partner, ph.status pharmacy_status, ph.licence_expires FROM products p LEFT JOIN partners pt ON pt.id=p.partner_id LEFT JOIN pharmacies ph ON ph.partner_id=p.partner_id WHERE p.is_pharmacy=1 AND p.pharm_status IN ('pending','rejected','approved') ORDER BY (p.pharm_status='pending') DESC, p.id DESC LIMIT 300");
}
async function decideProduct(user, ip, id, b) {
  if (!isSuper(user) || !user.reg_no) fail(403, 'Only our superintendent pharmacist (with a registration number on file) approves medicine listings.');
  const p = await get('SELECT * FROM products WHERE id=? AND is_pharmacy=1', int(id));
  if (!p) fail(404, 'Product not found.');
  const decision = str(b.decision, 10), note = str(b.note, 300);
  if (decision === 'reject') {
    if (note.length < 5) fail(400, 'Please write the reason.');
    await run("UPDATE products SET pharm_status='rejected', pharm_approved_by='', pharm_approved_at=NULL WHERE id=?", p.id);
  } else if (decision === 'approve') {
    const problems = [];
    if (p.is_medicine && !p.nafdac_no) problems.push('NAFDAC number');
    if (!p.batch_no) problems.push('batch number');
    if (!p.expiry_date || p.expiry_date < lagosToday()) problems.push('a future expiry date');
    if (!p.storage_temp) problems.push('storage temperature');
    if (!p.partner_id || !(await get("SELECT 1 x FROM pharmacies WHERE partner_id=? AND status='approved'", p.partner_id))) problems.push('an approved partner pharmacy');
    if (problems.length) fail(400, 'This listing is missing: ' + problems.join(', ') + '.');
    await run("UPDATE products SET pharm_status='approved', pharm_approved_by=?, pharm_approved_at=? WHERE id=?", who(user), now(), p.id);
  } else fail(400, 'Choose approve or reject.');
  await PC.audit(user, ip, 'product_' + decision, 'product', p.id, note);
  await bump();
}

/* ================= partner pharmacies (admin) ================= */
const licenceEnd = (year) => Math.floor(Date.UTC(year, 11, 31, 23, 59, 59) / 1000) - 3600; // 31 December, Lagos time
async function listPharmacies() {
  return all(`SELECT ph.*, pt.name partner_name, (SELECT COUNT(*) FROM products p WHERE p.partner_id=ph.partner_id AND p.is_pharmacy=1) products FROM pharmacies ph JOIN partners pt ON pt.id=ph.partner_id ORDER BY ph.id`);
}
async function savePharmacy(user, id, b) {
  const f = { partner_id: int(b.partner_id), pharmacy_name: str(b.pharmacy_name, 100), premises: str(b.premises_licence_no, 40), epharm: str(b.epharmacy_licence_no, 40), sname: str(b.superintendent_name, 80), sreg: str(b.superintendent_reg_no, 40), year: int(b.licence_year) };
  if (!f.pharmacy_name) fail(400, 'Please enter the pharmacy name.');
  if (f.year && (f.year < 2020 || f.year > 2100)) fail(400, 'Please enter the licence year, like 2027.');
  const exp = f.year ? licenceEnd(f.year) : 0;
  if (id) {
    const cur = await get('SELECT * FROM pharmacies WHERE id=?', id); if (!cur) fail(404, 'Pharmacy not found.');
    const changed = cur.premises_licence_no !== f.premises || cur.epharmacy_licence_no !== f.epharm || cur.superintendent_name !== f.sname || cur.superintendent_reg_no !== f.sreg || cur.licence_year !== f.year;
    await run(`UPDATE pharmacies SET pharmacy_name=?, premises_licence_no=?, epharmacy_licence_no=?, superintendent_name=?, superintendent_reg_no=?, licence_year=?, licence_expires=?, updated=?,
      status = CASE WHEN ? AND status IN ('approved','pending') THEN 'draft' ELSE status END WHERE id=?`, f.pharmacy_name, f.premises, f.epharm, f.sname, f.sreg, f.year, exp, now(), changed, id);
    if (changed) await bump();
    return id;
  }
  if (!(await get('SELECT 1 x FROM partners WHERE id=?', f.partner_id))) fail(400, 'Choose the pickup point this pharmacy runs from.');
  if (await get('SELECT 1 x FROM pharmacies WHERE partner_id=?', f.partner_id)) fail(409, 'That pickup point already has a pharmacy record.');
  const r = await run('INSERT INTO pharmacies (partner_id,pharmacy_name,premises_licence_no,epharmacy_licence_no,superintendent_name,superintendent_reg_no,licence_year,licence_expires,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
    f.partner_id, f.pharmacy_name, f.premises, f.epharm, f.sname, f.sreg, f.year, exp, now(), now());
  return Number(r.lastInsertRowid);
}
async function saveAgreement(id, buf, mime, filename) {
  const ph = await get('SELECT * FROM pharmacies WHERE id=?', id); if (!ph) fail(404, 'Pharmacy not found.');
  if (!FILE_TYPES.some((k) => k.test(buf))) fail(400, 'The agreement must be a PDF, JPG or PNG.');
  if (buf.length > 8_000_000) fail(400, 'That file is over 8 MB.');
  const key = `agreement-${id}-${crypto.randomBytes(4).toString('hex')}.bin`;
  await storage.pharmacyDocs.put(key, PC.encryptBuf(buf));
  await run('UPDATE pharmacies SET agreement_file=?, agreement_name=?, updated=? WHERE id=?', key, str(filename, 100) || 'agreement', now(), id);
  if (ph.agreement_file) storage.pharmacyDocs.remove(ph.agreement_file).catch(() => {});
}
async function openAgreement(user, ip, id) {
  const ph = await get('SELECT * FROM pharmacies WHERE id=?', id);
  if (!ph || !ph.agreement_file) fail(404, 'No agreement uploaded.');
  await PC.audit(user, ip, 'agreement_view', 'pharmacy', id, ph.agreement_name);
  const buf = PC.decryptBuf(await storage.pharmacyDocs.get(ph.agreement_file));
  return { buf, mime: FILE_TYPES.find((k) => k.test(buf)).mime, name: ph.agreement_name };
}
async function setPharmacyStatus(user, ip, id, action, note) {
  const ph = await get('SELECT * FROM pharmacies WHERE id=?', id); if (!ph) fail(404, 'Pharmacy not found.');
  note = str(note, 300);
  if (action === 'submit') {
    if (!['draft', 'suspended'].includes(ph.status)) fail(409, 'Already submitted.');
    await run("UPDATE pharmacies SET status='pending', updated=? WHERE id=?", now(), id);
  } else if (action === 'approve') {
    const missing = [];
    if (!ph.premises_licence_no) missing.push('premises licence number'); if (!ph.epharmacy_licence_no) missing.push('e-pharmacy licence number');
    if (!ph.superintendent_name || !ph.superintendent_reg_no) missing.push('superintendent pharmacist name and registration number');
    if (!ph.licence_year) missing.push('licence year'); if (!ph.agreement_file) missing.push('signed agreement');
    if (missing.length) fail(400, 'Missing: ' + missing.join(', ') + '.');
    if (Number(ph.licence_expires) < now()) fail(400, 'This licence year has already ended. Enter the current year\'s licence.');
    if (!(await get("SELECT 1 x FROM users WHERE role='pharmacist' AND pharmacy_id=? AND active=1 AND reg_no<>''", id))) fail(400, 'Add at least one pharmacist account (with registration number) for this pharmacy first.');
    if (ph.status === 'approved') fail(409, 'Already approved.');
    await run("UPDATE pharmacies SET status='approved', approved_by=?, approved_at=?, review_note=?, updated=? WHERE id=?", user.name, now(), note, now(), id);
  } else if (action === 'suspend') {
    if (note.length < 5) fail(400, 'Please write the reason.');
    await run("UPDATE pharmacies SET status='suspended', review_note=?, updated=? WHERE id=?", note, now(), id);
  } else fail(400, 'Unknown action.');
  await PC.audit(user, ip, 'pharmacy_' + action, 'pharmacy', id, note);
  await bump();
}

/* ================= pharmacists (admin) ================= */
async function listPharmacists() {
  return all("SELECT u.id, u.name, u.email, u.phone, u.reg_no, u.pharmacy_id, u.active, ph.pharmacy_name FROM users u LEFT JOIN pharmacies ph ON ph.id=u.pharmacy_id WHERE u.role='pharmacist' ORDER BY u.id");
}
async function savePharmacist(id, b, A, PW) {
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30), reg = str(b.reg_no, 40);
  const pharmacyId = b.pharmacy_id ? int(b.pharmacy_id) : null;
  if (!name || !S.isEmail(email)) fail(400, 'Please enter the pharmacist\'s name and email.');
  if (reg.length < 3) fail(400, 'The pharmacist\'s PCN registration number is required.');
  if (pharmacyId && !(await get('SELECT 1 x FROM pharmacies WHERE id=?', pharmacyId))) fail(400, 'Pharmacy not found.');
  if (id) {
    const u = await get("SELECT id FROM users WHERE id=? AND role='pharmacist'", id); if (!u) fail(404, 'Pharmacist not found.');
    await run('UPDATE users SET name=?, phone=?, reg_no=?, pharmacy_id=?, active=? WHERE id=?', name, phone, reg, pharmacyId, b.active === false || b.active === 0 ? 0 : 1, id);
    if (b.password) { const bad = PW.check(b.password, { email, name, min: PW.STAFF_MIN }); if (bad) fail(400, bad); await run('UPDATE users SET password=? WHERE id=?', await A.hashPassword(b.password), id); await A.dropUserSessions(id); }
    return id;
  }
  const bad = PW.check(b.password, { email, name, min: PW.STAFF_MIN }); if (bad) fail(400, bad);
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) fail(409, 'That email already has an account.');
  const r = await run("INSERT INTO users (name,email,phone,password,role,pharmacy_id,reg_no,created) VALUES (?,?,?,?,'pharmacist',?,?,?)", name, email, phone, await A.hashPassword(b.password), pharmacyId, reg, now());
  return Number(r.lastInsertRowid);
}

/* ================= settings and the readiness checklist ================= */
const SETTING_KEYS = ['pharm_pcn_logo', 'pharm_aggregator_licence', 'pharm_statement', 'pharm_large_qty', 'pharm_unverified_hours', 'pharm_return_days', 'pharm_legal_review', 'pharm_licences_checked'];
async function saveSettings(b) {
  const out = {};
  if ('pharm_pcn_logo' in b) { const v = str(b.pharm_pcn_logo, 300); if (v && !/^(https:\/\/[^\s"'<>]+|\/uploads\/[A-Za-z0-9._-]+)$/.test(v)) fail(400, 'The PCN logo must be an uploaded image or an https link.'); out.pharm_pcn_logo = v; }
  if ('pharm_aggregator_licence' in b) out.pharm_aggregator_licence = str(b.pharm_aggregator_licence, 60);
  if ('pharm_statement' in b) out.pharm_statement = str(b.pharm_statement, 400);
  if ('pharm_large_qty' in b) out.pharm_large_qty = String(Math.min(999, Math.max(1, int(b.pharm_large_qty, 10))));
  if ('pharm_unverified_hours' in b) out.pharm_unverified_hours = String(Math.min(720, Math.max(1, int(b.pharm_unverified_hours, 48))));
  if ('pharm_return_days' in b) out.pharm_return_days = String(Math.min(60, Math.max(1, int(b.pharm_return_days, 7))));
  for (const k of ['pharm_legal_review', 'pharm_licences_checked']) if (k in b) out[k] = b[k] ? '1' : '0';
  await tx(async () => { for (const [k, v] of Object.entries(out)) await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v); });
  await bump();
}
async function readiness() {
  const s = await S.getSettings();
  const keyOk = (process.env.PHARMACY_DATA_KEY || '').length >= 24;
  const [ph, pharmacists, supers] = await Promise.all([
    get("SELECT COUNT(*) n FROM pharmacies WHERE status='approved' AND licence_expires>?", now()),
    get("SELECT COUNT(*) n FROM users WHERE role='pharmacist' AND pharmacy_id IS NOT NULL AND active=1 AND reg_no<>''"),
    get("SELECT COUNT(*) n FROM users WHERE role='pharmacist' AND pharmacy_id IS NULL AND active=1 AND reg_no<>''"),
  ]);
  const soon = await all("SELECT pharmacy_name, licence_expires FROM pharmacies WHERE status='approved' AND licence_expires BETWEEN ? AND ?", now(), now() + 45 * 86400);
  const items = [
    { key: 'lawyer', label: 'A Nigerian lawyer has reviewed the rules and the compliance checklist (tick when done)', ok: s.pharm_legal_review === '1', manual: true },
    { key: 'licences', label: 'You have seen the real PCN licences of the pharmacies and of our own aggregator listing (tick when done)', ok: s.pharm_licences_checked === '1', manual: true },
    { key: 'aggregator', label: 'Aggregator licence number is entered below', ok: !!s.pharm_aggregator_licence },
    { key: 'logo', label: 'PCN logo is added below', ok: !!s.pharm_pcn_logo },
    { key: 'statement', label: 'Prescription-only statement for the homepage is written', ok: !!s.pharm_statement },
    { key: 'key', label: 'PHARMACY_DATA_KEY is set (at least 24 characters, kept safe: without it records cannot be read)', ok: keyOk },
    { key: 'sms', label: 'An SMS gateway is connected (SMS_DRIVER=webhook) so verification codes reach customers', ok: sms.live() },
    { key: 'storage', label: 'Private storage is on for prescriptions and agreements (Supabase), not local disk', ok: storage.DRIVER !== 'local' },
    { key: 'pharmacy', label: 'At least one partner pharmacy is approved with a current licence', ok: Number(ph.n) > 0 },
    { key: 'pharmacists', label: 'Each approved pharmacy has a pharmacist account with a registration number', ok: Number(pharmacists.n) > 0 },
    { key: 'super', label: 'Our superintendent pharmacist has an account (approves medicine listings)', ok: Number(supers.n) > 0 },
    { key: 'nepp', label: 'NEPP integration (placeholder only: send us the official documentation)', ok: nepp.isConfigured(), optional: true },
  ];
  return { enabled: PC.enabled(), ready: items.filter((i) => !i.optional).every((i) => i.ok), items, expiring: soon };
}
async function auditLog(limit = 200) { return all('SELECT * FROM pharmacy_audit ORDER BY id DESC LIMIT ?', Math.min(500, limit)); }

module.exports = {
  isSuper, isPharmacist, identityOf, publicIdentity, startPhoneVerification, confirmPhone, submitIdentity,
  createPrescription, myPrescriptions, openFile, inspectCart, checkPrescriptions, attach, runFlags, resolveFlag, listFlags,
  myQueue, reviewOrder, decide, addPrescriptionToOrder, payAfterApproval, expireRxOrders, checkRecipient, checkRider,
  requestReturn, listReturns, updateReturn, saveMedFields, productsToApprove, decideProduct,
  listPharmacies, savePharmacy, saveAgreement, openAgreement, setPharmacyStatus, listPharmacists, savePharmacist, saveSettings, readiness, auditLog, SETTING_KEYS, MAX_RX_FILE,
};
