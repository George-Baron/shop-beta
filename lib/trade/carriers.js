'use strict';
// Carrier registry and live rates. A provider is "ready" only when its credentials are present in the server environment
// AND staff switched it on. Otherwise it is shown as "awaiting configuration". Nothing is ever faked.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const FX = require('./fx');
const EP = require('./adapters/easypost');
const { fail } = S;

const ADAPTERS = { easypost: EP };
const NO_DIRECT = 'A direct connection to this carrier has not been built. Add the carrier to your EasyPost account and it is available through EasyPost.';
const KNOWN = [
  { code: 'easypost', name: 'EasyPost (multi-carrier)', kind: 'aggregator', adapter: 'easypost', required: ['EASYPOST_API_KEY'], optional: ['EASYPOST_WEBHOOK_SECRET'], priority: 10,
    caps: { live_rates: true, booking: true, labels: true, tracking: true, webhooks: true, cancel: true, insurance: true, pickup: false, ddp: false },
    help: 'One account that reaches DHL, FedEx, UPS and others you connect inside EasyPost. Add EASYPOST_API_KEY on the server. For automatic tracking, add EASYPOST_WEBHOOK_SECRET and register the webhook address shown below in your EasyPost dashboard.' },
  ...[['dhl_express', 'DHL Express'], ['fedex', 'FedEx'], ['ups', 'UPS'], ['aramex', 'Aramex'], ['ems', 'EMS (postal)']].map(([code, name], i) => ({ code, name, kind: 'carrier', adapter: 'none', required: [], optional: [], priority: 50 + i, caps: {}, help: NO_DIRECT })),
];
const KNOWN_BY = Object.fromEntries(KNOWN.map((k) => [k.code, k]));
const jl = (v) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } };

async function ensureProviders() {   // adds missing rows only; never changes what staff already set
  const t = now();
  for (const k of KNOWN) await run('INSERT INTO shipping_providers (code,name,kind,adapter,credential_env,enabled,priority,capabilities,created,updated) VALUES (?,?,?,?,?,0,?,?::jsonb,?,?) ON CONFLICT (code) DO NOTHING', k.code, k.name, k.kind, k.adapter, JSON.stringify([...k.required, ...k.optional]), k.priority, JSON.stringify(k.caps), t, t);
}
const envState = (k) => [...k.required.map((n) => ({ name: n, required: true, set: !!process.env[n] })), ...k.optional.map((n) => ({ name: n, required: false, set: !!process.env[n] }))];
function statusOf(row) {
  const k = KNOWN_BY[row.code]; if (row.adapter === 'manual') return 'ready';
  if (!k || row.adapter === 'none' || !ADAPTERS[row.adapter]) return 'not_integrated';
  if (k.required.some((n) => !process.env[n])) return 'awaiting_configuration';
  return Number(row.enabled) ? 'ready' : 'disabled';
}
const LABEL = { ready: 'Ready', disabled: 'Configured, switched off', awaiting_configuration: 'Awaiting configuration', not_integrated: 'Not integrated' };
const pubShape = (r) => { const k = KNOWN_BY[r.code], st = statusOf(r); return { code: r.code, name: r.name, kind: r.kind, adapter: r.adapter, status: st, status_label: LABEL[st], enabled: !!Number(r.enabled), preferred: !!Number(r.preferred), priority: Number(r.priority), supported_countries: jl(r.supported_countries),
  capabilities: r.capabilities || {}, env: k ? envState(k) : [], help: k ? k.help : '', webhook_path: r.adapter === 'easypost' ? '/api/trade/webhooks/easypost' : '', customs_defaults: (r.settings && r.settings.customs_defaults) || {} }; };

async function list() { return { providers: (await all('SELECT * FROM shipping_providers ORDER BY priority, name')).map(pubShape), origin: await originStatus() }; }
async function originStatus() { const st = await T.settings(); const miss = ['origin_name', 'origin_line1', 'origin_city', 'origin_postal', 'origin_phone'].filter((k) => !st[k]); return { complete: !miss.length, missing: miss }; }
async function load(code) { const r = await get('SELECT * FROM shipping_providers WHERE code=?', String(code || '')); if (!r) fail(404, 'Provider not found.'); return r; }
async function update(code, b, user, ip) {
  const r = await load(code), set = [], a = [], ch = {};
  if (b.enabled !== undefined) {
    const on = b.enabled === true || b.enabled === 1 || b.enabled === '1';
    if (on) { const st = statusOf({ ...r, enabled: 1 }); if (st === 'not_integrated') fail(409, 'This carrier cannot be switched on: ' + NO_DIRECT); if (st === 'awaiting_configuration') fail(409, `Add ${KNOWN_BY[r.code].required.filter((n) => !process.env[n]).join(', ')} to the server settings first, then try again.`); }
    set.push('enabled=?'); a.push(on ? 1 : 0); ch.enabled = on;
  }
  if (b.preferred !== undefined) { set.push('preferred=?'); a.push(b.preferred === true || b.preferred === 1 || b.preferred === '1' ? 1 : 0); ch.preferred = !!a[a.length - 1]; }
  if (b.priority !== undefined) { const n = Number(b.priority); if (!Number.isInteger(n) || n < 1 || n > 1000) fail(400, 'Priority must be a whole number from 1 to 1000.'); set.push('priority=?'); a.push(n); ch.priority = n; }
  if (b.supported_countries !== undefined) {
    const list = [...new Set((Array.isArray(b.supported_countries) ? b.supported_countries : String(b.supported_countries).split(/[,;\s]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
    for (const c of list) if (!(await get('SELECT 1 x FROM trade_countries WHERE code=?', c))) fail(400, `Unknown country code ${c.slice(0, 5)}.`);
    set.push('supported_countries=?'); a.push(JSON.stringify(list)); ch.supported_countries = list;
  }
  if (b.customs_defaults !== undefined) {
    const d = b.customs_defaults || {}, ok = {}, CT = ['merchandise', 'documents', 'gift', 'returned_goods', 'sample', 'other'], ND = ['return', 'abandon'], RT = ['none', 'other', 'quarantine', 'sanitary_phytosanitary'];
    if (d.customs_signer) ok.customs_signer = String(d.customs_signer).slice(0, 60);
    if (d.contents_type) { if (!CT.includes(d.contents_type)) fail(400, 'Unknown contents type.'); ok.contents_type = d.contents_type; }
    if (d.non_delivery_option) { if (!ND.includes(d.non_delivery_option)) fail(400, 'Unknown non-delivery option.'); ok.non_delivery_option = d.non_delivery_option; }
    if (d.restriction_type) { if (!RT.includes(d.restriction_type)) fail(400, 'Unknown restriction type.'); ok.restriction_type = d.restriction_type; }
    set.push("settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{customs_defaults}', ?::jsonb)"); a.push(JSON.stringify(ok)); ch.customs_defaults = ok;
  }
  if (!set.length) return pubShape(r);
  await run(`UPDATE shipping_providers SET ${set.join(', ')}, updated=? WHERE code=?`, ...a, now(), r.code);
  await T.audit(user, 'provider.update', 'shipping_providers', r.code, ch, ip);
  return pubShape(await load(code));
}
async function test(code) {
  const r = await load(code), st = statusOf({ ...r, enabled: 1 });
  if (st === 'not_integrated') fail(409, NO_DIRECT); if (st === 'awaiting_configuration') fail(409, 'Credentials are missing on the server, so there is nothing to test yet.');
  try { return { ok: true, ...(await ADAPTERS[r.adapter].ping()) }; } catch (e) { if (e.name === 'CarrierError') fail(e.status === 504 ? 504 : 422, e.message); throw e; }
}
async function readyProviders(country) {
  return (await all("SELECT * FROM shipping_providers WHERE enabled=1 AND adapter<>'manual' AND adapter<>'none' ORDER BY priority")).filter((p) => statusOf(p) === 'ready' && (!jl(p.supported_countries).length || jl(p.supported_countries).includes(country)));
}

/* ---------- live rates for the customer's cart ---------- */
const r3 = (n) => Math.round(n * 1000) / 1000;
async function serviceRow(provider, rate) {
  const code = `${rate.carrier}:${rate.service}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').slice(0, 60), name = `${rate.carrier} ${rate.service}`.replace(/_/g, ' ').slice(0, 80), express = /express|priority|overnight|expedited|international_?plus/i.test(rate.service);
  await run('INSERT INTO shipping_services (provider_id,code,name,method,est_days_min,est_days_max,supports_ddp,supports_insurance,active,carrier) VALUES (?,?,?,?,?,?,0,0,1,?) ON CONFLICT (provider_id, code) DO UPDATE SET name=EXCLUDED.name, carrier=EXCLUDED.carrier', provider.id, code, name, express ? 'express' : 'standard', rate.days, rate.days, rate.carrier);
  return get('SELECT s.*, p.name AS provider_name, p.code AS provider_code FROM shipping_services s JOIN shipping_providers p ON p.id=s.provider_id WHERE s.provider_id=? AND s.code=?', provider.id, code);
}
const fromAddress = (st) => ({ name: st.origin_name, line1: st.origin_line1, city: st.origin_city, region: st.origin_region, postal_code: st.origin_postal, country: st.origin_country, phone: st.origin_phone });
function parcelOf(lines) {   // one parcel: heaviest footprint, items stacked. Staff confirm real dimensions at booking.
  let w = 0, l = 0, wd = 0, h = 0;
  for (const x of lines) { w += Number(x.weight_kg) * x.qty; l = Math.max(l, Number(x.length_cm)); wd = Math.max(wd, Number(x.width_cm)); h += Number(x.height_cm) * x.qty; }
  return { weight_kg: r3(w), length_cm: l, width_cm: wd, height_cm: h };
}
async function customsOf(cartLines, valueOf) {
  const usd = (await FX.rate('NGN', 'USD')).rate, items = [];
  for (const l of cartLines) items.push({ description: l.trade.customs_description || l.name, quantity: l.qty, weight_kg: Number(l.trade.weight_kg), value_usd: (await valueOf(l)) / l.qty * usd, hs_code: l.trade.hs_code, origin_country: l.trade.origin_country });
  return { items };
}
// Returns { options, note }. Never throws: a carrier problem must not stop the customer from seeing the manual options.
async function liveOptions({ country, address, cartLines, valueOf, goodsNgn, st }) {
  const provs = await readyProviders(country); if (!provs.length) return { options: [], note: '' };
  if (!(await originStatus()).complete) return { options: [], note: '' };
  if (!address || !address.line1 || !address.city) return { options: [], note: 'Enter your street address and city to also see live carrier prices.' };
  const options = []; let note = '';
  const parcel = parcelOf(cartLines.map((l) => ({ ...l.trade, qty: l.qty })));
  for (const p of provs) {
    try {
      const customs = await customsOf(cartLines, valueOf); customs.defaults = (p.settings && p.settings.customs_defaults) || {};
      const res = await ADAPTERS[p.adapter].rates({ from: fromAddress(st), to: { name: 'Customer', line1: address.line1, line2: address.line2, city: address.city, region: address.region, postal_code: address.postal_code, country }, parcel, customs, reference: 'quote' });
      for (const rt of res.rates) {
        let rate; try { rate = await FX.rate(rt.currency, 'NGN'); } catch { continue; }   // no usable exchange rate: leave this price out
        const base = rt.amount * rate.rate, margin = base * Number(st.shipping_margin_pct) / 100, handling = Number(st.handling_fee_ngn);
        const shipping = Math.ceil(base + margin + handling - 1e-9), svc = await serviceRow(p, rt);
        const vol = r3(parcel.length_cm * parcel.width_cm * parcel.height_cm / 5000);
        options.push({ service: svc, source: 'api', provider_quote_ref: JSON.stringify({ shipment_id: res.shipment_id, rate_id: rt.rate_id }), shipping_ngn: shipping, insurance_ngn: 0, days: rt.days,
          weights: { actual_kg: parcel.weight_kg, volumetric_kg: vol, chargeable_kg: Math.max(parcel.weight_kg, vol), divisor: 5000, step: 0 }, parts: { carrier: Math.round(base), fuel: 0, remote: 0, margin: Math.round(margin), handling: Math.round(handling) },
          carrier_rate: { carrier: rt.carrier, service: rt.service, amount: rt.amount, currency: rt.currency } });
      }
      if (!res.rates.length) note = 'Live carrier prices are not available for this parcel and destination.';
    } catch (e) { console.error('[carriers] live rates:', p.code, e.message); note = 'Live carrier prices are not available right now. Our standard estimates are shown instead.'; }
  }
  return { options, note };
}

module.exports = { KNOWN, ADAPTERS, ensureProviders, list, load, update, test, statusOf, readyProviders, liveOptions, originStatus, parcelOf, customsOf, fromAddress };
