'use strict';
// Customer-facing currencies. Prices are kept in Naira; a customer is charged in their own currency at a rate that is fixed when the order is placed.
// Rates live in fx_rates ("Naira per 1 unit"), set by hand or by the optional automatic feed. A missing or stale rate means the currency is not offered:
// we never guess, because a wrong rate quietly sells goods below cost.
const { get, all } = require('./db');
const { now } = require('./db');

const BASE = 'NGN';
const maxAgeSeconds = () => Math.max(1, Number(process.env.FX_MAX_AGE_HOURS) || 72) * 3600;   // a feed rate older than this is not used

// How many minor units a currency has (kobo and cents = 2, yen = 0). Taken from the runtime's currency data, not typed in by hand.
const decimals = (code) => {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: String(code).toUpperCase() }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
};
const toMinor = (major, code) => Math.round(Number(major) * 10 ** decimals(code));
const fromMinor = (minor, code) => Number(minor) / 10 ** decimals(code);
const format = (minor, code, locale = 'en') => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: String(code).toUpperCase() }).format(fromMinor(minor, code)); } catch { return `${fromMinor(minor, code)} ${code}`; } };

// The rate customers are charged at. The markup covers bank and gateway currency costs, so the customer is charged slightly MORE units of their money.
const chargeRate = (ngnPerUnit, markupPct) => Number(ngnPerUnit) / (1 + (Number(markupPct) || 0) / 100);

// Amount in minor units for a Naira total. Always rounded UP, so rounding can never leave us short.
function chargeFor(totalNgn, rate, code) {
  if (!(rate > 0)) throw new Error('There is no exchange rate for ' + code + '.');
  const f = 10 ** decimals(code);
  return Math.ceil((Number(totalNgn) / rate) * f - 1e-7);
}

// Currencies that can be offered right now: switched on, with a usable rate. Returns { USD: { code, rate (charge rate), base_rate, markup_pct, decimals, source, updated } }
async function available() {
  const rows = await all('SELECT c.code, c.markup_pct, f.ngn_per_unit, f.source, f.updated FROM currencies c LEFT JOIN fx_rates f ON f.currency = c.code WHERE c.enabled = TRUE');
  const out = { [BASE]: { code: BASE, rate: 1, base_rate: 1, markup_pct: 0, decimals: decimals(BASE), source: 'base', updated: null } };
  const t = now();
  for (const r of rows) {
    if (r.code === BASE) continue;
    const base = Number(r.ngn_per_unit);
    if (!(base > 0)) continue;
    if (r.source === 'feed' && t - Number(r.updated) > maxAgeSeconds()) continue;      // stale automatic rate
    out[r.code] = { code: r.code, rate: chargeRate(base, r.markup_pct), base_rate: base, markup_pct: Number(r.markup_pct), decimals: decimals(r.code), source: r.source, updated: Number(r.updated) };
  }
  return out;
}
// One currency, or null when it cannot be offered.
async function one(code) { return (await available())[String(code || BASE).toUpperCase()] || null; }

// What the customer pays for this Naira total: the locked rate and the minor-unit amount sent to the payment gateway.
async function quote(totalNgn, code) {
  code = String(code || BASE).toUpperCase();
  const c = await one(code);
  if (!c) return null;
  return { currency: code, rate: c.rate, decimals: c.decimals, amount: code === BASE ? Math.round(totalNgn * 100) : chargeFor(totalNgn, c.rate, code) };
}

module.exports = { BASE, decimals, toMinor, fromMinor, format, chargeRate, chargeFor, available, one, quote, maxAgeSeconds };
