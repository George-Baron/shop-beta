'use strict';
// Exchange rates. Only real rates are used: fetched from a rate provider, or typed in by staff (marked "manual").
// If there is no usable rate the caller gets a clear 503; a rate is never guessed.
// Rates are stored as NGN -> X. Any other pair is calculated through NGN. A transaction copies the rate it used (see snapshot()), so later updates never change it.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const { fail } = S;

const BASE = 'NGN';
// {base} is replaced by the base currency. Default: a free provider that needs no key. Set FX_API_URL (and FX_API_KEY if the provider wants one) to use another.
const API_URL = () => process.env.FX_API_URL || 'https://open.er-api.com/v6/latest/{base}';

async function activeCurrencies() { return all('SELECT * FROM trade_currencies WHERE active=1 ORDER BY is_base DESC, sort, code'); }

// Fetch the provider's table and store a row for every ACTIVE currency. Throws on any problem and stores nothing in that case.
async function refresh({ fetchImpl = fetch } = {}) {
  const url = API_URL().replace('{base}', BASE);
  const headers = { Accept: 'application/json' }; if (process.env.FX_API_KEY) headers.Authorization = 'Bearer ' + process.env.FX_API_KEY;
  let body;
  try {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('provider answered HTTP ' + r.status);
    body = await r.json();
  } catch (e) { throw new Error('Could not fetch exchange rates: ' + e.message); }
  const rates = body && (body.rates || body.conversion_rates);
  if (!rates || typeof rates !== 'object' || (body.result && body.result !== 'success')) throw new Error('Exchange-rate provider returned an unexpected answer.');
  const base = String(body.base_code || body.base || BASE).toUpperCase();
  if (base !== BASE) throw new Error(`Exchange-rate provider answered for ${base}, not ${BASE}.`);
  const upd = Number(body.time_last_update_unix) || null, t = now(), host = (() => { try { return new URL(url).host; } catch { return 'provider'; } })();
  let stored = 0; const missing = [];
  for (const c of await activeCurrencies()) {
    if (c.code === BASE) continue;
    const rate = Number(rates[c.code]);
    if (!Number.isFinite(rate) || rate <= 0) { missing.push(c.code); continue; }
    await run('INSERT INTO trade_exchange_rates (base,quote,rate,source,fetched_at,provider_updated,manual) VALUES (?,?,?,?,?,?,0) ON CONFLICT (base,quote,fetched_at) DO NOTHING', BASE, c.code, rate, host, t, upd);
    stored++;
  }
  await run("INSERT INTO trade_settings (key,value,updated) VALUES ('fx_last_refresh',?,?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated=EXCLUDED.updated", String(t), t);
  return { stored, missing, source: host };
}

// The newest stored NGN -> quote rate, with its age.
async function latest(quote) {
  if (quote === BASE) return { rate: 1, fetched_at: now(), source: 'base', manual: false, age_hours: 0, stale: false };
  const r = await get('SELECT rate, source, fetched_at, manual FROM trade_exchange_rates WHERE base=? AND quote=? ORDER BY fetched_at DESC, id DESC LIMIT 1', BASE, quote);
  if (!r) return null;
  const st = await T.settings(), age = (now() - Number(r.fetched_at)) / 3600;
  return { rate: Number(r.rate), fetched_at: Number(r.fetched_at), source: r.source, manual: !!Number(r.manual), age_hours: Math.round(age * 10) / 10, stale: age > Number(st.fx_max_age_hours), blocked: age > Number(st.fx_block_hours) };
}

// Rate for 1 unit of `from` expressed in `to`. Throws 503 when a rate is missing or too old to trade on.
async function rate(from, to, { allowStale = false } = {}) {
  from = String(from).toUpperCase(); to = String(to).toUpperCase();
  if (from === to) return { rate: 1, source: 'same currency', fetched_at: now(), stale: false };
  const a = await latest(from), b = await latest(to);
  for (const [c, x] of [[from, a], [to, b]]) {
    if (!x) fail(503, `No exchange rate is available for ${c} yet.`);
    if (x.blocked && !allowStale) fail(503, `The exchange rate for ${c} is out of date. Please try again later.`);
  }
  return { rate: b.rate / a.rate, source: [a.source, b.source].filter((s) => s !== 'base').join(' + ') || 'base', fetched_at: Math.min(a.fetched_at, b.fetched_at), stale: !!(a.stale || b.stale), manual: !!(a.manual || b.manual) };
}

async function decimalsOf(code) { const c = await get('SELECT decimals FROM trade_currencies WHERE code=?', code); return c ? Number(c.decimals) : 2; }

// Convert for DISPLAY: applies the owner's markup (default 0%) and rounds to the target currency's decimals.
async function convert(amount, from, to, { markup = true, allowStale = false } = {}) {
  const r = await rate(from, to, { allowStale });
  const st = await T.settings(), m = markup && String(from).toUpperCase() !== String(to).toUpperCase() ? 1 + Number(st.fx_markup_pct) / 100 : 1;
  const out = T.roundTo(Number(amount) * r.rate * m, await decimalsOf(String(to).toUpperCase()));
  return { amount: out, rate: r.rate * m, source: r.source, fetched_at: r.fetched_at, stale: r.stale };
}

// What a transaction stores: the exact rate used at that moment, its source and time. Existing transactions are never recalculated.
async function snapshot(currency) {
  const r = await rate(currency, BASE);          // value of 1 unit of `currency` in NGN
  return { currency, fx_rate_to_ngn: r.rate, fx_source: r.manual ? 'manual:' + r.source : r.source, fx_fetched_at: r.fetched_at };
}

async function setManual(quote, value, user, ip, note) {
  quote = String(quote || '').toUpperCase();
  const c = await get('SELECT * FROM trade_currencies WHERE code=?', quote);
  if (!c || c.is_base) fail(400, 'Choose a currency other than the base currency (NGN).');
  const v = T.dec(value, 'Rate', { min: 0.000001, max: 1e9, places: 10 }); if (v == null) fail(400, 'Enter the rate: how many ' + quote + ' you get for 1 NGN.');
  await run('INSERT INTO trade_exchange_rates (base,quote,rate,source,fetched_at,manual) VALUES (?,?,?,?,?,1)', BASE, quote, v, 'manual: ' + String(note || 'set by staff').slice(0, 60), now());
  await T.audit(user, 'rates.manual', 'trade_exchange_rates', quote, { quote, rate: v, note }, ip);
}

// For the admin screen: every active currency with its newest rate (how many NGN is one unit worth) and its age.
async function table() {
  const out = [];
  for (const c of await activeCurrencies()) {
    const l = await latest(c.code);
    out.push({ code: c.code, name: c.name, symbol: c.symbol, decimals: Number(c.decimals), is_base: !!Number(c.is_base), ngn_per_unit: l && l.rate ? Math.round((1 / l.rate) * 1e6) / 1e6 : null, rate_from_ngn: l ? l.rate : null,
      source: l ? l.source : '', manual: l ? l.manual : false, fetched_at: l ? l.fetched_at : null, age_hours: l ? l.age_hours : null, stale: l ? l.stale : false, blocked: l ? !!l.blocked : false, missing: !l });
  }
  return out;
}

module.exports = { BASE, refresh, latest, rate, convert, snapshot, setManual, table, decimalsOf };

// Called by the background worker. Does nothing unless the owner switched automatic refresh on. A provider failure makes the job retry; old rates stay in use until they are too old.
async function refreshIfEnabled() {
  if ((await T.settings()).fx_refresh_enabled !== '1') return { skipped: true };
  return refresh();
}
module.exports.refreshIfEnabled = refreshIfEnabled;
