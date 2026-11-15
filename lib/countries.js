'use strict';
// Country and currency names without a hand-typed table: Node's built-in Intl data knows every ISO country and currency.
const REGION = new Intl.DisplayNames(['en'], { type: 'region' });
const CURRENCY = new Intl.DisplayNames(['en'], { type: 'currency' });
const nameOf = (c) => { try { const n = REGION.of(c); return n && n !== c ? n : ''; } catch { return ''; } };

let list = null;
function countries() { // [{ code, name }] sorted by name
  if (list) return list;
  const out = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { const code = String.fromCharCode(a, b), name = nameOf(code); if (name && !/^Unknown/i.test(name)) out.push({ code, name }); }
  return (list = out.sort((x, y) => x.name.localeCompare(y.name)));
}
const isCountry = (c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c) && !!nameOf(c) && !/^Unknown/i.test(nameOf(c));
const countryName = (c) => nameOf(c) || c;
let cur = null;
const currencies = () => cur || (cur = Intl.supportedValuesOf('currency').map((code) => ({ code, name: CURRENCY.of(code) || code })));
const isCurrency = (c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c) && Intl.supportedValuesOf('currency').includes(c);

module.exports = { countries, isCountry, countryName, currencies, isCurrency };
