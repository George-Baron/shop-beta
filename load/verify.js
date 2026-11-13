'use strict';
// After a load test: did the shop lose, duplicate or oversell anything?  (Step 9 targets: zero lost or duplicated orders, no overselling.)
//   DATABASE_URL=... node load/verify.js --snapshot before.json     (BEFORE the test: records every stock level)
//   DATABASE_URL=... node load/verify.js --log k6-orders.log --snapshot before.json [--scarce-total 50] [--out result.json]
// The log is k6's --console-output file: one JSON line per order the shop accepted.
const fs = require('fs');
const { Client } = require('pg');
const args = process.argv.slice(2), val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = new URL(process.env.DATABASE_URL); const mode = (process.env.PGSSL || '').toLowerCase(); url.searchParams.delete('sslmode');
const client = new Client({ connectionString: url.toString(), ssl: mode === 'disable' || ['localhost', '127.0.0.1'].includes(url.hostname) ? false : { rejectUnauthorized: false } });
const q = async (s, a) => (await client.query(s, a)).rows;

(async () => {
  await client.connect();
  if (!val('--log')) { // snapshot mode
    const p = await q('SELECT id, stock FROM products'), v = await q('SELECT id, stock FROM variants');
    fs.writeFileSync(val('--snapshot'), JSON.stringify({ p: Object.fromEntries(p.map((r) => [r.id, r.stock])), v: Object.fromEntries(v.map((r) => [r.id, r.stock])) }));
    console.log(`Snapshot of ${p.length} products and ${v.length} variants saved.`); return client.end();
  }
  const snap = JSON.parse(fs.readFileSync(val('--snapshot'), 'utf8'));
  const logged = [], mism = [];
  for (const line of fs.readFileSync(val('--log'), 'utf8').split('\n')) {
    const m = /msg="(.*)"(?: source=console)?\s*$/.exec(line) || /^(\{.*\})$/.exec(line); if (!m) continue;
    let o; try { o = JSON.parse(line.includes('msg="') ? JSON.parse('"' + m[1] + '"') : m[1]); } catch { continue; }
    if (o.k === 'order') logged.push(o); else if (o.k === 'replay-mismatch') mism.push(o);
  }
  // let the background worker finish confirming payments and sending mail before judging
  let jobs; for (let i = 0; i < 90; i++) { jobs = (await q("SELECT COUNT(*) FILTER (WHERE state IN ('queued','active'))::int open, COUNT(*) FILTER (WHERE state='failed')::int failed FROM jobs"))[0]; if (!jobs.open) break; await sleep(1000); }

  const checks = []; const add = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  (' + detail + ')' : '')); };
  const refs = [...new Set(logged.map((o) => o.ref))], keys = new Set(logged.map((o) => o.key));
  const orders = await q("SELECT id, ref, status, payment_method, payment_status, total FROM orders WHERE email LIKE 'load%@example.com'");
  const byRef = new Map(orders.map((o) => [o.ref, o]));
  add('orders the shop accepted are all in the database (none lost)', refs.every((r) => byRef.has(r)), `${refs.length} accepted, ${refs.filter((r) => !byRef.has(r)).length} missing`);
  const extra = orders.filter((o) => !refs.includes(o.ref)); add('no extra or duplicated orders (database orders = distinct accepted checkouts)', orders.length === keys.size && orders.length === refs.length && extra.length === 0, `${orders.length} in database, ${keys.size} distinct tries accepted, ${refs.length} distinct order numbers, ${extra.length} in the database but never confirmed to a shopper`);
  const dupKeys = await q("SELECT key, COUNT(*) c FROM idempotency_keys WHERE key LIKE 'k6-%' GROUP BY key HAVING COUNT(*) > 1"); add('no idempotency key produced two orders', dupKeys.length === 0 && mism.length === 0, `${mism.length} replay mismatches`);
  add('every order has items', (await q("SELECT COUNT(*)::int c FROM orders o WHERE email LIKE 'load%@example.com' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id)"))[0].c === 0);
  const neg = (await q('SELECT (SELECT COUNT(*) FROM products WHERE stock<0)::int p, (SELECT COUNT(*) FROM variants WHERE stock<0)::int v'))[0]; add('no product or variant has negative stock', neg.p === 0 && neg.v === 0, `products ${neg.p}, variants ${neg.v}`);
  // stock conservation: starting stock - units in orders that are not cancelled/refunded = stock now, for every product that was touched
  const sold = await q(`SELECT i.product_id pid, i.variant_id vid, SUM(i.qty)::int n FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.email LIKE 'load%@example.com' AND o.status NOT IN ('cancelled','refunded') GROUP BY 1,2`);
  const now = Object.fromEntries((await q('SELECT id, stock FROM products')).map((r) => [r.id, r.stock])), nowV = Object.fromEntries((await q('SELECT id, stock FROM variants')).map((r) => [r.id, r.stock]));
  const soldByP = {}, soldByV = {}; for (const s of sold) { soldByP[s.pid] = (soldByP[s.pid] || 0) + s.n; if (s.vid) soldByV[s.vid] = (soldByV[s.vid] || 0) + s.n; }
  const hasVariants = new Set((await q('SELECT DISTINCT product_id FROM variants')).map((r) => String(r.product_id)));
  // EVERY product and variant in the shop: starting stock minus units sold must equal stock now. Catches stock that moved with no order too.
  const wrong = [...Object.keys(snap.p).filter((id) => !hasVariants.has(id) && snap.p[id] - (soldByP[id] || 0) !== now[id]).map((id) => `product ${id}: start ${snap.p[id]} sold ${soldByP[id] || 0} now ${now[id]}`),
    ...Object.keys(snap.v).filter((id) => snap.v[id] - (soldByV[id] || 0) !== nowV[id]).map((id) => `variant ${id}: start ${snap.v[id]} sold ${soldByV[id] || 0} now ${nowV[id]}`)];
  const touched = Object.keys(soldByP);
  add('stock adds up: starting stock minus units sold = stock now, for every product and variant in the shop', wrong.length === 0, `${Object.keys(snap.p).length} products and ${Object.keys(snap.v).length} variants checked, ${touched.length} sold from${wrong.length ? ', WRONG: ' + wrong.slice(0, 5).join('; ') : ''}`);
  const sc = (await q("SELECT id, stock FROM products WHERE slug='load-scarce'"))[0], scTotal = Number(val('--scarce-total') || 50);
  if (sc) {
    const scOrders = logged.filter((o) => o.scarce).length, attempts = (await q("SELECT COUNT(*)::int c FROM order_items WHERE product_id=$1", [sc.id]))[0].c;
    add('scarce product (only ' + scTotal + ' units): never oversold', sc.stock >= 0 && (soldByP[sc.id] || 0) <= scTotal && (soldByP[sc.id] || 0) + sc.stock === scTotal, `sold ${soldByP[sc.id] || 0}, left ${sc.stock}, accepted orders ${scOrders}, order lines ${attempts}`);
  }
  const online = orders.filter((o) => o.payment_method === 'paystack'), unpaid = online.filter((o) => o.payment_status !== 'paid' && o.status !== 'cancelled');
  add('every online order whose webhook arrived is marked paid exactly once', unpaid.length === 0, `${online.length} online orders, ${unpaid.length} not paid`);
  const twice = await q("SELECT order_id, COUNT(*) c FROM order_events WHERE status='paid' GROUP BY order_id HAVING COUNT(*) > 1"); add('no order was marked paid twice', twice.length === 0, `${twice.length} duplicates`);
  const noMail = await q("SELECT COUNT(*)::int c FROM orders o WHERE email LIKE 'load%@example.com' AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.to_email=o.email)"); add('every order has its confirmation email saved (none lost)', noMail[0].c === 0, `${noMail[0].c} without`);
  add('background queue drained with no failed jobs', jobs.open === 0 && jobs.failed === 0, `waiting ${jobs.open}, failed ${jobs.failed}`);
  const res = { orders: orders.length, accepted: refs.length, online: online.length, checks };
  if (val('--out')) fs.writeFileSync(val('--out'), JSON.stringify(res, null, 2));
  await client.end(); const bad = checks.filter((c) => !c.ok).length; console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nAll integrity checks passed.'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
