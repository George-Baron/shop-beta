'use strict';
// Global Trade: shared helpers (settings, audit log, number and text checks). Every other lib/trade/*.js file builds on this one.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const { fail, str } = S;

/* ---------- settings ---------- */
// type: 'bool' | 'pct' | 'int' | 'money' | 'text' | 'enum'. Defaults are conservative: nothing risky is on until the owner turns it on.
const SCHEMA = {
  origin_country:        { type: 'country', def: 'NG', label: 'Home (export origin) country' },
  fx_refresh_enabled:    { type: 'bool', def: process.env.NODE_ENV === 'production' || process.env.FX_REFRESH === '1' ? '1' : '0', label: 'Refresh exchange rates automatically' },
  fx_max_age_hours:      { type: 'int', def: '30', min: 1, max: 720, label: 'Rates older than this many hours are marked stale' },
  fx_block_hours:        { type: 'int', def: '72', min: 1, max: 2160, label: 'Rates older than this many hours are NOT used for checkout' },
  fx_markup_pct:         { type: 'pct', def: '0', min: 0, max: 20, label: 'Exchange-rate markup added to displayed prices (%)' },
  quote_ttl_minutes:     { type: 'int', def: '30', min: 5, max: 1440, label: 'Shipping quote stays valid for (minutes)' },
  default_incoterm:      { type: 'enum', def: 'DAP', options: ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'], label: 'Default Incoterm' },
  default_duty_arrangement: { type: 'enum', def: 'DAP', options: ['DAP', 'DDP'], label: 'Default for customer shipments (DAP = customer pays duties on arrival, DDP = we collect them)' },
  handling_fee_ngn:      { type: 'money', def: '0', min: 0, max: 100000000, label: 'Handling fee per international order (NGN)' },
  shipping_margin_pct:   { type: 'pct', def: '0', min: 0, max: 100, label: 'Shipping margin on carrier prices (%)' },
  insurance_pct:         { type: 'pct', def: '0', min: 0, max: 20, label: 'Optional insurance rate (% of declared value)' },
  notify_customers:      { type: 'bool', def: '1', label: 'Email customers about international order and shipment updates' },
  notify_admin_email:    { type: 'text', def: '', max: 120, label: 'Email that receives trade alerts' },
  export_stock_deduct_at: { type: 'enum', def: 'dispatch', options: ['confirm', 'packed', 'dispatch'], label: 'Deduct stock for export orders at' },
  origin_name:           { type: 'text', def: '', max: 80, label: 'Sender name on shipping labels' },
  origin_phone:          { type: 'text', def: '', max: 30, label: 'Sender phone on shipping labels (with country code)' },
  origin_line1:          { type: 'text', def: '', max: 120, label: 'Sender street address' },
  origin_city:           { type: 'text', def: '', max: 60, label: 'Sender city' },
  origin_region:         { type: 'text', def: '', max: 60, label: 'Sender state' },
  origin_postal:         { type: 'text', def: '', max: 12, label: 'Sender postal code' },
  ai_assistant_enabled:  { type: 'bool', def: '0', label: 'Global Trade Assistant (advisory only)' },
};

async function settings() {
  const rows = await all('SELECT key, value FROM trade_settings');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(Object.entries(SCHEMA).map(([k, d]) => [k, k in m ? m[k] : d.def]));
}
const setting = async (k) => (await settings())[k];

async function cleanSetting(k, v) {
  const d = SCHEMA[k]; if (!d) fail(400, `Unknown setting "${k}".`);
  if (d.type === 'bool') return v === true || v === 1 || v === '1' || v === 'true' ? '1' : '0';
  if (d.type === 'enum') { if (!d.options.includes(String(v))) fail(400, `${d.label}: choose one of ${d.options.join(', ')}.`); return String(v); }
  if (d.type === 'text') return str(v, d.max || 200);
  if (d.type === 'country') { const c = String(v || '').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_countries WHERE code=?', c))) fail(400, `${d.label}: unknown country code.`); return c; }
  const n = Number(v); if (!Number.isFinite(n)) fail(400, `${d.label}: enter a number.`);
  if (d.type === 'int' || d.type === 'money') { if (!Number.isInteger(n)) fail(400, `${d.label}: enter a whole number.`); }
  if (d.min != null && n < d.min) fail(400, `${d.label}: must be at least ${d.min}.`);
  if (d.max != null && n > d.max) fail(400, `${d.label}: must be at most ${d.max}.`);
  return String(n);
}
async function saveSettings(body, user, ip) {
  const before = await settings(), changes = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!SCHEMA[k]) continue;
    const val = await cleanSetting(k, v);
    if (val !== before[k]) changes[k] = { from: before[k], to: val };
  }
  for (const [k, c] of Object.entries(changes)) await run('INSERT INTO trade_settings (key,value,updated,updated_by) VALUES (?,?,?,?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated=EXCLUDED.updated, updated_by=EXCLUDED.updated_by', k, c.to, now(), user ? user.id : null);
  if (Object.keys(changes).length) await audit(user, 'settings.update', 'trade_settings', '', changes, ip);
  return settings();
}

/* ---------- audit ---------- */
// Business events (who changed which trade record, from what to what). Secrets and bank details must never be passed in.
async function audit(user, action, entity, entityId, detail, ip) {
  try {
    await run('INSERT INTO trade_audit_logs (user_id,user_name,action,entity,entity_id,detail,ip,created) VALUES (?,?,?,?,?,?::jsonb,?,?)',
      user ? user.id : null, user ? String(user.name || user.email || '').slice(0, 80) : 'system', action, entity, String(entityId == null ? '' : entityId).slice(0, 80), JSON.stringify(detail || {}).slice(0, 4000), String(ip || '').slice(0, 64), now());
  } catch (e) { console.error('Trade audit write failed:', e.message); }
}

/* ---------- small validators ---------- */
const yesNo = (v, keep) => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return keep;
  if (['yes', 'y', 'true', '1'].includes(s)) return 1;
  if (['no', 'n', 'false', '0'].includes(s)) return 0;
  return NaN;
};
// Number or null. Throws a friendly 400 for text that is not a number, or is out of range.
function dec(v, label, { min = 0, max = 1e12, places = 4, blank = null } = {}) {
  if (v === '' || v == null) return blank;
  const n = Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) fail(400, `${label}: "${String(v).slice(0, 30)}" is not a number.`);
  if (n < min) fail(400, `${label}: must be at least ${min}.`);
  if (n > max) fail(400, `${label}: is too large.`);
  const f = 10 ** places; return Math.round(n * f) / f;
}
const hsClean = (v) => String(v || '').replace(/\s+/g, '').trim();
const HS_OK = /^[0-9]{4,10}(\.[0-9]+)*$/;
const roundTo = (n, decimals) => { const f = 10 ** decimals; return Math.round((n + Number.EPSILON) * f) / f; };
const page = (q, def = 25) => { const per = Math.min(100, Math.max(1, Number(q.per) || def)), p = Math.max(1, Number(q.page) || 1); return { per, offset: (p - 1) * per, page: p }; };
const ref = (prefix) => `${prefix}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${require('crypto').randomBytes(3).toString('hex').toUpperCase()}`;

module.exports = { SCHEMA, settings, setting, saveSettings, audit, yesNo, dec, hsClean, HS_OK, roundTo, page, ref };
