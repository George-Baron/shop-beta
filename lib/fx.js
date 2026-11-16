'use strict';
// Currency conversion through Naira (the base currency). Rates are "Naira per 1 unit of the currency", kept in the fx_rates table.
// A missing rate is an error, never a guess: a wrong rate would quietly sell goods below cost.
const BASE = 'NGN';

// rates: { USD: 1500, CNY: 210, ... }  (NGN is always 1)
function convert(amount, from, to, rates) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error('That amount is not a number.');
  from = String(from).toUpperCase(); to = String(to).toUpperCase();
  if (from === to) return n;
  const r = (c) => { if (c === BASE) return 1; const v = Number(rates && rates[c]); if (!(v > 0)) throw new Error(`There is no exchange rate for ${c}.`); return v; };
  return (n * r(from)) / r(to);
}
const toNaira = (amount, from, rates) => convert(amount, from, BASE, rates);
const fromNaira = (amount, to, rates) => convert(amount, BASE, to, rates);

module.exports = { BASE, convert, toNaira, fromNaira };
