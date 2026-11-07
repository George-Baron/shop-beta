// k6 load test for Shop-Beta. Run:  k6 run -e PROFILE=browse -e VUS=500 -e BASE=http://localhost:3100 load/baseline.js
// PROFILE=browse   shoppers with think time (2-6 s between pages), ramps to VUS then holds. This is what "N concurrent shoppers" means.
// PROFILE=stress   VUS connections hammering with no think time (raw capacity).
// PROFILE=checkout 100 pay-on-delivery checkouts per minute (RATE per minute can be changed with -e RATE=100).
// Use a THROWAWAY database (see load/seed-catalogue.js). Checkout creates real orders and uses stock.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3100';
const PROFILE = __ENV.PROFILE || 'browse';
const VUS = Number(__ENV.VUS || 100);
const HOLD = __ENV.HOLD || '60s';
const errors = new Rate('app_errors');

const scenarios = {
  browse: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: __ENV.RAMP || '30s', target: VUS }, { duration: HOLD, target: VUS }, { duration: '10s', target: 0 }], exec: 'browse' },
  stress: { executor: 'constant-vus', vus: VUS, duration: HOLD, exec: 'stress' },
  checkout: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 100), timeUnit: '1m', duration: HOLD, preAllocatedVUs: 50, maxVUs: 400, exec: 'checkout' },
};
export const options = {
  scenarios: { [PROFILE]: scenarios[PROFILE] },
  thresholds: { http_req_duration: ['p(95)<800'], app_errors: ['rate<0.01'] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const cfg = http.get(`${BASE}/api/config`).json();
  const stores = cfg.stores.map((s) => s.slug);
  const list = http.get(`${BASE}/api/products?page=1`).json().products;
  const first = http.get(`${BASE}/api/products/${list[0].slug}`).json().product;
  return { stores, slugs: list.map((p) => p.slug), ids: list.map((p) => p.id), states: cfg.zones.filter((z) => z.pod).map((z) => z.state), variantId: first.variants && first.variants[0] ? first.variants[0].id : null, firstId: first.id };
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
  const n = Math.floor(Math.random() * 1e9);
  const body = JSON.stringify({
    items: [{ productId: d.firstId, variantId: d.variantId, qty: 1 }], payment: 'pod', delivery: 'standard',
    contact: { name: 'Load Test', email: `load${n}@example.com`, phone: '08030000000' }, address: { state: pick(d.states), city: 'Test', address: '1 Test Street' },
  });
  // Different fake client address each time: mobile shoppers are many different people. (The server currently trusts this header.)
  const res = http.post(`${BASE}/api/checkout`, body, { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.${n % 250}.${(n >> 8) % 250}.${(n >> 16) % 250}` }, tags: { name: 'api checkout' } });
  ok(res, 'checkout');
}
