'use strict';
// Staff configuration for shipping and duties: zones, shipping methods (services), weight-bracket rates, and customs duty rules.
// Everything starts empty. A customer sees a shipping option only when a zone, a method and a matching rate bracket exist for the destination.
const { get, all, run, now } = require('../db');
const S = require('../shop');
const T = require('./core');
const { fail, str } = S;

const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const codes = async (v, label) => {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  for (const c of list) if (!/^[A-Z]{2}$/.test(c) || !(await get('SELECT 1 x FROM trade_countries WHERE code=?', c))) fail(400, `${label}: "${c.slice(0, 10)}" is not a known country code.`);
  return [...new Set(list)];
};
const cur = async (v, label) => { const c = String(v || '').toUpperCase(); if (!(await get('SELECT 1 x FROM trade_currencies WHERE code=?', c))) fail(400, `${label}: unknown currency.`); return c; };
const num = (v, label, o) => { const n = T.dec(v, label, { places: 4, ...o }); return n; };
const date = (v, label) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) fail(400, `${label}: use the form 2026-12-31.`); return String(v); };

/* ---------- zones ---------- */
const zoneShape = (z) => ({ id: Number(z.id), name: z.name, origin_country: z.origin_country, countries: JSON.parse(z.countries || '[]'), remote_area_postcodes: JSON.parse(z.remote_area_postcodes || '[]'), active: !!Number(z.active) });
async function zones() { return (await all('SELECT * FROM trade_shipping_zones ORDER BY name')).map(zoneShape); }
async function saveZone(id, b, user, ip) {
  const cur0 = id ? await get('SELECT * FROM trade_shipping_zones WHERE id=?', id) : null; if (id && !cur0) fail(404, 'Zone not found.');
  const name = b.name !== undefined ? str(b.name, 60) : cur0 && cur0.name; if (!name) fail(400, 'Give the zone a name.');
  const countries = b.countries !== undefined ? await codes(b.countries, 'Countries') : cur0 ? JSON.parse(cur0.countries) : [];
  if (!countries.length) fail(400, 'Choose at least one country for the zone.');
  const remote = b.remote_area_postcodes !== undefined ? (Array.isArray(b.remote_area_postcodes) ? b.remote_area_postcodes : String(b.remote_area_postcodes || '').split(/[,;\n]+/)).map((x) => String(x).trim().toUpperCase().slice(0, 10)).filter(Boolean).slice(0, 500) : cur0 ? JSON.parse(cur0.remote_area_postcodes) : [];
  const origin = b.origin_country ? (await codes(b.origin_country, 'Origin country'))[0] : cur0 ? cur0.origin_country : 'NG', active = b.active !== undefined ? bool(b.active) : cur0 ? cur0.active : 1;
  try {
    if (cur0) await run('UPDATE trade_shipping_zones SET name=?, origin_country=?, countries=?, remote_area_postcodes=?, active=? WHERE id=?', name, origin, JSON.stringify(countries), JSON.stringify(remote), active, id);
    else id = Number((await run('INSERT INTO trade_shipping_zones (name,origin_country,countries,remote_area_postcodes,active,created) VALUES (?,?,?,?,?,?)', name, origin, JSON.stringify(countries), JSON.stringify(remote), active, now())).lastInsertRowid);
  } catch (e) { if (e.code === '23505') fail(409, 'A zone with that name already exists.'); throw e; }
  await T.audit(user, cur0 ? 'zone.update' : 'zone.create', 'trade_shipping_zones', id, { name, countries: countries.length }, ip);
  return zoneShape(await get('SELECT * FROM trade_shipping_zones WHERE id=?', id));
}
async function deleteZone(id, user, ip) {
  if (!(await get('SELECT 1 x FROM trade_shipping_zones WHERE id=?', id))) fail(404, 'Zone not found.');
  await run('DELETE FROM trade_shipping_zones WHERE id=?', id); await T.audit(user, 'zone.delete', 'trade_shipping_zones', id, {}, ip); return { ok: true };
}

/* ---------- shipping methods ---------- */
const METHODS = ['express', 'standard', 'economy', 'air_freight', 'sea_freight', 'consolidated', 'customer_arranged'];
const svcShape = (s) => ({ id: Number(s.id), provider_id: Number(s.provider_id), provider: s.provider_name, code: s.code, name: s.name, method: s.method, est_days_min: s.est_days_min, est_days_max: s.est_days_max, supports_ddp: !!Number(s.supports_ddp), supports_insurance: !!Number(s.supports_insurance), active: !!Number(s.active) });
const SVC_SQL = 'SELECT s.*, p.name AS provider_name FROM shipping_services s JOIN shipping_providers p ON p.id=s.provider_id';
async function services() { return (await all(`${SVC_SQL} ORDER BY s.id`)).map(svcShape); }
async function saveService(id, b, user, ip) {
  const c = id ? await get('SELECT * FROM shipping_services WHERE id=?', id) : null; if (id && !c) fail(404, 'Shipping method not found.');
  const prov = await get("SELECT id FROM shipping_providers WHERE code='manual'");
  const name = b.name !== undefined ? str(b.name, 60) : c && c.name; if (!name) fail(400, 'Give the shipping method a name.');
  const method = b.method !== undefined ? String(b.method) : c ? c.method : ''; if (!METHODS.includes(method)) fail(400, 'Choose a method type: ' + METHODS.join(', ') + '.');
  const code = c ? c.code : (str(b.code, 30).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || method + '_' + Date.now().toString(36));
  const dmin = b.est_days_min !== undefined ? (b.est_days_min === '' || b.est_days_min == null ? null : Math.round(num(b.est_days_min, 'Minimum days', { min: 0, max: 365, places: 0 }))) : c ? c.est_days_min : null;
  const dmax = b.est_days_max !== undefined ? (b.est_days_max === '' || b.est_days_max == null ? null : Math.round(num(b.est_days_max, 'Maximum days', { min: 0, max: 365, places: 0 }))) : c ? c.est_days_max : null;
  if (dmin != null && dmax != null && dmax < dmin) fail(400, 'Maximum days cannot be less than minimum days.');
  const ddp = b.supports_ddp !== undefined ? bool(b.supports_ddp) : c ? c.supports_ddp : 0, ins = b.supports_insurance !== undefined ? bool(b.supports_insurance) : c ? c.supports_insurance : 0, active = b.active !== undefined ? bool(b.active) : c ? c.active : 1;
  try {
    if (c) await run('UPDATE shipping_services SET name=?, method=?, est_days_min=?, est_days_max=?, supports_ddp=?, supports_insurance=?, active=? WHERE id=?', name, method, dmin, dmax, ddp, ins, active, id);
    else id = Number((await run('INSERT INTO shipping_services (provider_id,code,name,method,est_days_min,est_days_max,supports_ddp,supports_insurance,active) VALUES (?,?,?,?,?,?,?,?,?)', prov.id, code, name, method, dmin, dmax, ddp, ins, active)).lastInsertRowid);
  } catch (e) { if (e.code === '23505') fail(409, 'A method with that code already exists.'); throw e; }
  await T.audit(user, c ? 'service.update' : 'service.create', 'shipping_services', id, { name, method }, ip);
  return svcShape(await get(`${SVC_SQL} WHERE s.id=?`, id));
}
async function deleteService(id, user, ip) {
  if (!(await get('SELECT 1 x FROM shipping_services WHERE id=?', id))) fail(404, 'Shipping method not found.');
  if (await get('SELECT 1 x FROM export_orders WHERE service_id=? LIMIT 1', id)) fail(409, 'Orders already used this method. Switch it off instead of deleting it.');
  await run('DELETE FROM shipping_services WHERE id=?', id); await T.audit(user, 'service.delete', 'shipping_services', id, {}, ip); return { ok: true };
}

/* ---------- weight-bracket rates ---------- */
const ruleShape = (r) => ({ id: Number(r.id), zone_id: Number(r.zone_id), zone: r.zone_name, service_id: r.service_id == null ? null : Number(r.service_id), service: r.service_name || '', min_kg: Number(r.min_kg), max_kg: r.max_kg == null ? null : Number(r.max_kg), base_amount: Number(r.base_amount), per_kg: Number(r.per_kg),
  currency: r.currency, fuel_surcharge_pct: Number(r.fuel_surcharge_pct), remote_surcharge: Number(r.remote_surcharge), handling_fee: Number(r.handling_fee), margin_pct: Number(r.margin_pct), volumetric_divisor: Number(r.volumetric_divisor), weight_step: Number(r.weight_step), active: !!Number(r.active) });
const RULE_SQL = 'SELECT r.*, z.name AS zone_name, s.name AS service_name FROM shipping_rate_rules r JOIN trade_shipping_zones z ON z.id=r.zone_id LEFT JOIN shipping_services s ON s.id=r.service_id';
async function rules() { return (await all(`${RULE_SQL} ORDER BY z.name, r.service_id NULLS FIRST, r.min_kg`)).map(ruleShape); }
async function saveRule(id, b, user, ip) {
  const c = id ? await get('SELECT * FROM shipping_rate_rules WHERE id=?', id) : null; if (id && !c) fail(404, 'Rate not found.');
  const pick = (k, d) => (b[k] !== undefined ? b[k] : c ? c[k] : d);
  const zone = Number(pick('zone_id')); if (!(await get('SELECT 1 x FROM trade_shipping_zones WHERE id=?', zone))) fail(400, 'Choose a zone.');
  const svcRaw = pick('service_id', null), svc = svcRaw === '' || svcRaw == null ? null : Number(svcRaw); if (svc != null && !(await get('SELECT 1 x FROM shipping_services WHERE id=?', svc))) fail(400, 'Choose a shipping method, or leave it empty to cover every method in the zone.');
  const min = num(pick('min_kg', 0), 'From (kg)', { min: 0, max: 100000, places: 3 }), maxRaw = pick('max_kg', null), max = maxRaw === '' || maxRaw == null ? null : num(maxRaw, 'Up to (kg)', { min: 0.001, max: 100000, places: 3 });
  if (max != null && max <= min) fail(400, '"Up to (kg)" must be larger than "From (kg)".');
  const row = { base: num(pick('base_amount', 0), 'Base amount', { min: 0, max: 1e9 }), perKg: num(pick('per_kg', 0), 'Price per kg', { min: 0, max: 1e9 }), fuel: num(pick('fuel_surcharge_pct', 0), 'Fuel surcharge %', { min: 0, max: 100, places: 3 }), remote: num(pick('remote_surcharge', 0), 'Remote-area surcharge', { min: 0, max: 1e9 }),
    handling: num(pick('handling_fee', 0), 'Handling fee', { min: 0, max: 1e9 }), margin: num(pick('margin_pct', 0), 'Margin %', { min: 0, max: 200, places: 3 }), div: Math.round(num(pick('volumetric_divisor', 5000), 'Volumetric divisor', { min: 1000, max: 20000, places: 0 })), step: num(pick('weight_step', 0.5), 'Weight step (kg)', { min: 0.1, max: 50, places: 3 }) };
  if (!(row.base > 0 || row.perKg > 0)) fail(400, 'Enter a base amount or a price per kg: a rate of zero would ship for free.');
  const currency = await cur(pick('currency'), 'Currency'), active = b.active !== undefined ? bool(b.active) : c ? c.active : 1;
  // two brackets for the same zone and method must not overlap, or the price would depend on row order
  const clash = await get(`SELECT 1 x FROM shipping_rate_rules WHERE zone_id=? AND COALESCE(service_id,0)=COALESCE(?,0) AND active=1 AND ${id ? 'id<>? AND' : ''} min_kg < COALESCE(?, 1e12) AND COALESCE(max_kg, 1e12) > ?`, ...[zone, svc, ...(id ? [id] : []), max, min]);
  if (clash && active) fail(409, 'That weight range overlaps another active rate for the same zone and method.');
  if (c) await run('UPDATE shipping_rate_rules SET zone_id=?,service_id=?,min_kg=?,max_kg=?,base_amount=?,per_kg=?,currency=?,fuel_surcharge_pct=?,remote_surcharge=?,handling_fee=?,margin_pct=?,volumetric_divisor=?,weight_step=?,active=?,updated=? WHERE id=?', zone, svc, min, max, row.base, row.perKg, currency, row.fuel, row.remote, row.handling, row.margin, row.div, row.step, active, now(), id);
  else id = Number((await run('INSERT INTO shipping_rate_rules (zone_id,service_id,min_kg,max_kg,base_amount,per_kg,currency,fuel_surcharge_pct,remote_surcharge,handling_fee,margin_pct,volumetric_divisor,weight_step,active,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', zone, svc, min, max, row.base, row.perKg, currency, row.fuel, row.remote, row.handling, row.margin, row.div, row.step, active, now())).lastInsertRowid);
  await T.audit(user, c ? 'rate.update' : 'rate.create', 'shipping_rate_rules', id, { zone, svc, min, max, currency }, ip);
  return ruleShape(await get(`${RULE_SQL} WHERE r.id=?`, id));
}
async function deleteRule(id, user, ip) { if (!(await get('SELECT 1 x FROM shipping_rate_rules WHERE id=?', id))) fail(404, 'Rate not found.'); await run('DELETE FROM shipping_rate_rules WHERE id=?', id); await T.audit(user, 'rate.delete', 'shipping_rate_rules', id, {}, ip); return { ok: true }; }

/* ---------- duty and tax rules ---------- */
const dutyShape = (r) => ({ id: Number(r.id), destination_country: r.destination_country, origin_country: r.origin_country || '', hs_prefix: r.hs_prefix, duty_pct: Number(r.duty_pct), vat_pct: Number(r.vat_pct), other_levy_pct: Number(r.other_levy_pct), other_levy_label: r.other_levy_label, valuation: r.valuation, vat_on_duty: !!Number(r.vat_on_duty),
  de_minimis: r.de_minimis == null ? null : Number(r.de_minimis), de_minimis_currency: r.de_minimis_currency || '', source: r.source, source_url: r.source_url, verified: !!Number(r.verified), verified_at: r.verified_at ? Number(r.verified_at) : null, valid_from: r.valid_from ? String(r.valid_from).slice(0, 10) : '', valid_to: r.valid_to ? String(r.valid_to).slice(0, 10) : '', notes: r.notes, active: !!Number(r.active) });
async function dutyRules(q = {}) { return (await all(`SELECT * FROM customs_duty_rules ${q.country ? 'WHERE destination_country=?' : ''} ORDER BY destination_country, hs_prefix, id`, ...(q.country ? [String(q.country).toUpperCase()] : []))).map(dutyShape); }
async function saveDutyRule(id, b, user, ip) {
  const c = id ? await get('SELECT * FROM customs_duty_rules WHERE id=?', id) : null; if (id && !c) fail(404, 'Duty rule not found.');
  const pick = (k, d) => (b[k] !== undefined ? b[k] : c ? c[k] : d);
  const dest = (await codes(pick('destination_country'), 'Destination country'))[0]; if (!dest) fail(400, 'Choose the destination country.');
  const orig = pick('origin_country', '') ? (await codes(pick('origin_country'), 'Origin country'))[0] : null;
  const hs = String(pick('hs_prefix', '')).replace(/\D/g, ''); if (hs.length > 10) fail(400, 'HS prefix: at most 10 digits (leave empty for every product).');
  const duty = num(pick('duty_pct', 0), 'Import duty %', { min: 0, max: 500, places: 3 }), vat = num(pick('vat_pct', 0), 'VAT %', { min: 0, max: 100, places: 3 }), levy = num(pick('other_levy_pct', 0), 'Other levy %', { min: 0, max: 100, places: 3 });
  const val = String(pick('valuation', 'CIF')).toUpperCase(); if (!['FOB', 'CIF', 'CIP'].includes(val)) fail(400, 'Valuation must be FOB, CIF or CIP.');
  const dmRaw = pick('de_minimis', null), dm = dmRaw === '' || dmRaw == null ? null : num(dmRaw, 'De-minimis limit', { min: 0, max: 1e12 }), dmc = dm == null ? null : await cur(pick('de_minimis_currency', 'USD'), 'De-minimis currency');
  const source = str(pick('source', ''), 200), url = str(pick('source_url', ''), 300); if (url && !/^https?:\/\//i.test(url)) fail(400, 'Source link must start with http:// or https://');
  const vf = b.verified !== undefined ? bool(b.verified) : c ? Number(c.verified) : 0;
  if (vf && (!source || !url)) fail(400, 'To mark a rule verified, record where the rate comes from (source name and link).');
  const vfrom = date(pick('valid_from', null), 'Valid from'), vto = date(pick('valid_to', null), 'Valid to'); if (vfrom && vto && vto < vfrom) fail(400, '"Valid to" is before "Valid from".');
  const wasVerified = c ? Number(c.verified) : 0, changedRates = c && ['duty_pct', 'vat_pct', 'other_levy_pct', 'valuation', 'hs_prefix', 'destination_country'].some((k) => b[k] !== undefined && String(b[k]) !== String(c[k]));
  const verifiedNow = vf && (!wasVerified || changedRates) ? 1 : vf;      // editing the numbers of a verified rule asks for a fresh sign-off below
  const needsResign = wasVerified && changedRates && b.verified === undefined;
  const finalVf = needsResign ? 0 : verifiedNow, active = b.active !== undefined ? bool(b.active) : c ? c.active : 1;
  const vals = [dest, orig, hs, duty, vat, levy, str(pick('other_levy_label', ''), 60), val, bool(pick('vat_on_duty', 1)), dm, dmc, source, url, finalVf, finalVf ? user.id : null, finalVf ? (wasVerified && !needsResign && !changedRates && c.verified_at ? Number(c.verified_at) : now()) : null, vfrom, vto, str(pick('notes', ''), 300), active];
  const cols = 'destination_country,origin_country,hs_prefix,duty_pct,vat_pct,other_levy_pct,other_levy_label,valuation,vat_on_duty,de_minimis,de_minimis_currency,source,source_url,verified,verified_by,verified_at,valid_from,valid_to,notes,active';
  if (c) await run(`UPDATE customs_duty_rules SET ${cols.split(',').map((k) => k + '=?').join(',')}, updated=? WHERE id=?`, ...vals, now(), id);
  else id = Number((await run(`INSERT INTO customs_duty_rules (${cols},created,updated) VALUES (${cols.split(',').map(() => '?').join(',')},?,?)`, ...vals, now(), now())).lastInsertRowid);
  await T.audit(user, c ? 'duty.update' : 'duty.create', 'customs_duty_rules', id, { dest, hs, duty, vat, verified: !!finalVf }, ip);
  return dutyShape(await get('SELECT * FROM customs_duty_rules WHERE id=?', id));
}
async function deleteDutyRule(id, user, ip) { if (!(await get('SELECT 1 x FROM customs_duty_rules WHERE id=?', id))) fail(404, 'Duty rule not found.'); await run('DELETE FROM customs_duty_rules WHERE id=?', id); await T.audit(user, 'duty.delete', 'customs_duty_rules', id, {}, ip); return { ok: true }; }

module.exports = { METHODS, zones, saveZone, deleteZone, services, saveService, deleteService, rules, saveRule, deleteRule, dutyRules, saveDutyRule, deleteDutyRule };
