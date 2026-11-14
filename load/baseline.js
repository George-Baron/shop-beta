// k6 load test for Shop-Beta (steps 1, 4, 9).  Run through load/run-staging.js, or by hand:
//   k6 run -e PROFILE=mixed -e VUS=2000 -e RATE=100 -e BASE=http://localhost:3100 -e PS_SECRET=sk_test_x load/baseline.js
// PROFILE=browse   shoppers with think time (2-6 s between pages), ramps to VUS then holds. This is what "N concurrent shoppers" means.
// PROFILE=stress   VUS connections hammering with no think time (raw capacity).
// PROFILE=checkout RATE checkouts per minute only.
// PROFILE=mixed    the real target: VUS browsing shoppers AND RATE checkouts per minute at the same time (checkouts start once the ramp is done).
// Checkout mix: 70% pay on delivery, 30% online (the script then sends the signed Paystack webhook, 20% of them twice, like Paystack retries);
//   5% of checkouts are sent twice with the same Idempotency-Key (a shopper's retry); 10% target a scarce product that has only 50 units
//   (the rest of those must be refused, never oversold). Every accepted order is printed as a JSON line for load/verify.js.
// Use a THROWAWAY database (see load/seed-catalogue.js). Checkout creates real orders and uses stock.
import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3100';
const PROFILE = __ENV.PROFILE || 'browse';
const VUS = Number(__ENV.VUS || 100);
const HOLD = __ENV.HOLD || '60s';
const RAMP = __ENV.RAMP || '30s';
const RUN = __ENV.RUN_ID || String(Date.now()).slice(-6);
const PS_SECRET = __ENV.PS_SECRET || '';
const ONLINE = Number(__ENV.ONLINE_SHARE === undefined ? 0.3 : __ENV.ONLINE_SHARE);
const errors = new Rate('app_errors');
const accepted = new Counter('orders_accepted');
const refused = new Counter('orders_refused_sold_out');

const HEAD = { 'Content-Type': 'application/json', 'X-Requested-With': 'shop-beta' };
const scenarios = {
  browse: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: RAMP, target: VUS }, { duration: HOLD, target: VUS }, { duration: '10s', target: 0 }], exec: 'browse' },
  stress: { executor: 'constant-vus', vus: VUS, duration: HOLD, exec: 'stress' },
  checkout: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 100), timeUnit: '1m', duration: HOLD, preAllocatedVUs: 50, maxVUs: 600, exec: 'checkout' },
};
scenarios.mixed_browse = { ...scenarios.browse };
scenarios.mixed_checkout = { ...scenarios.checkout, startTime: RAMP };
const chosen = PROFILE === 'mixed' ? { mixed_browse: scenarios.mixed_browse, mixed_checkout: scenarios.mixed_checkout } : { [PROFILE]: scenarios[PROFILE] };
const NAMES = ['page /', 'api config', 'api home', 'api products list', 'api search', 'page /product', 'api product', 'api checkout', 'api webhook'];
const thresholds = { http_req_duration: ['p(95)<800'], app_errors: ['rate<0.01'] };
for (const n of NAMES) thresholds[`http_req_duration{name:${n}}`] = ['p(95)<800'];
export const options = { scenarios: chosen, thresholds, summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'] };

export function setup() {
  const cfg = http.get(`${BASE}/api/config`).json();
  const stores = cfg.stores.map((s) => s.slug);
  const list = http.get(`${BASE}/api/products?page=1`).json().products;
  // load/seed-catalogue.js names products load-<n>; those with n not divisible by 4 have no sizes and 1,000,000 in stock.
  const plain = []; for (let n = 1; plain.length < 20 && n < 200; n++) { if (n % 4 === 0) continue; const r = http.get(`${BASE}/api/products/load-${n}`); if (r.status === 200) plain.push(r.json().product); }
  if (!plain.length) throw new Error('No plain load-test products found: seed the catalogue with load/seed-catalogue.js');
  const scarce = http.get(`${BASE}/api/products/load-scarce`);
  return {
    stores, slugs: list.map((p) => p.slug), plainIds: plain.map((p) => p.id), states: cfg.zones.filter((z) => z.pod).map((z) => z.state),
    scarceId: scarce.status === 200 ? scarce.json().product.id : 0,
  };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const words = ['soap', 'rice', 'cream', 'shirt', 'charger', 'premium', 'glow', 'classic'];
function ok(res, name) { const good = check(res, { [name + ' 200']: (r) => r.status === 200 }); errors.add(!good); return good; }

function page(d) {
  const store = pick(d.stores);
  ok(http.get(`${BASE}/`, { tags: { name: 'page /' } }), 'html');
  ok(http.get(`${BASE}/api/config`, { tags: { name: 'api config' } }), 'config');
  ok(http.get(`${BASE}/api/home/${store}`, { tags: { name: 'api home' } }), 'home');
  return store;
}
export function browse(d) {
  const store = page(d); sleep(2 + Math.random() * 4);
  ok(http.get(`${BASE}/api/products?store=${store}&page=${1 + Math.floor(Math.random() * 5)}&sort=popular`, { tags: { name: 'api products list' } }), 'list'); sleep(2 + Math.random() * 4);
  ok(http.get(`${BASE}/api/products?q=${pick(words)}`, { tags: { name: 'api search' } }), 'search'); sleep(2 + Math.random() * 4);
  const slug = pick(d.slugs);
  ok(http.get(`${BASE}/product/${slug}`, { tags: { name: 'page /product' } }), 'product html');
  ok(http.get(`${BASE}/api/products/${slug}`, { tags: { name: 'api product' } }), 'product'); sleep(2 + Math.random() * 4);
}
export function stress(d) {
  const r = Math.random();
  if (r < 0.2) page(d);
  else if (r < 0.5) ok(http.get(`${BASE}/api/products?store=${pick(d.stores)}&page=${1 + Math.floor(Math.random() * 5)}`, { tags: { name: 'api products list' } }), 'list');
  else if (r < 0.65) ok(http.get(`${BASE}/api/products?q=${pick(words)}`, { tags: { name: 'api search' } }), 'search');
  else ok(http.get(`${BASE}/api/products/${pick(d.slugs)}`, { tags: { name: 'api product' } }), 'product');
}

export function checkout(d) {
  const i = exec.scenario.iterationInTest, r = Math.random();
  const scarce = d.scarceId && r < 0.1, online = !scarce && PS_SECRET && Math.random() < ONLINE;
  const key = `k6-${RUN}-${i}`, n = Math.floor(Math.random() * 1e9);
  const body = JSON.stringify({
    items: [{ productId: scarce ? d.scarceId : pick(d.plainIds), qty: 1 }], payment: online ? 'paystack' : 'pod', delivery: 'standard',
    contact: { name: 'Load Test', email: `load${RUN}-${i}@example.com`, phone: '0803' + String(1000000 + (i % 8999999)) },
    address: { state: pick(d.states), city: 'Test', address: '1 Test Street' },
  });
  // A different fake client address each time: mobile shoppers are many different people. (Render's balancer appends the real one.)
  const headers = { ...HEAD, 'Idempotency-Key': key, 'X-Forwarded-For': `10.${n % 250}.${(n >> 8) % 250}.${(n >> 16) % 250}` };
  const send = () => http.post(`${BASE}/api/checkout`, body, { headers, tags: { name: 'api checkout' } });
  const res = send();
  if (scarce && (res.status === 400 || res.status === 409)) { refused.add(1); errors.add(false); return; } // sold out: the correct answer once the 50 are gone
  if (!ok(res, 'checkout')) return;
  const out = res.json(); accepted.add(1);
  console.log(JSON.stringify({ k: 'order', ref: out.ref, key, scarce: !!scarce, online: out.next === 'paystack' }));
  if (Math.random() < 0.05) { // the shopper's phone retried with the same key: must be the same order
    const again = send(); const same = ok(again, 'replay') && again.json().ref === out.ref; errors.add(!same);
    if (!same) console.log(JSON.stringify({ k: 'replay-mismatch', ref: out.ref, other: again.status === 200 ? again.json().ref : again.status }));
  }
  if (out.next === 'paystack') {
    sleep(0.3 + Math.random() * 1.5); // the shopper pays on Paystack's page, then Paystack calls us
    const hook = JSON.stringify({ event: 'charge.success', data: { reference: out.ref } });
    const sig = crypto.hmac('sha512', PS_SECRET, hook, 'hex');
    const h = { 'Content-Type': 'application/json', 'x-paystack-signature': sig };
    ok(http.post(`${BASE}/api/paystack/webhook`, hook, { headers: h, tags: { name: 'api webhook' } }), 'webhook');
    if (Math.random() < 0.2) ok(http.post(`${BASE}/api/paystack/webhook`, hook, { headers: h, tags: { name: 'api webhook' } }), 'webhook again');
  }
}
