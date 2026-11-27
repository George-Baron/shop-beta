'use strict';
// Integrations centre. A service is "connected" only when a real test call succeeded, and the result (time, success, last error) is kept.
// Credentials are checked on the server and never sent to the browser. Couriers have no adapter in this codebase, so they can never show as connected.
const { get, all, now } = require('../db');
const { fail } = require('../shop');
const AU = require('./autonomy');

const env = (k) => process.env[k] || '';
const withTimeout = async (url, opt = {}, ms = 8000) => { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { return await fetch(url, { ...opt, signal: c.signal }); } finally { clearTimeout(t); } };

const REGISTRY = [
  { key: 'database', name: 'VELTO-MART database', capabilities: ['orders', 'stock', 'riders', 'suppliers', 'trade'], creds: () => 'built in', test: async () => { const r = await get('SELECT (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM products) p'); return { ok: true, message: `Read ${r.o} orders and ${r.p} products.` }; } },
  { key: 'riders', name: 'Rider dispatch and GPS', capabilities: ['assign riders', 'live location'], creds: () => 'built in', test: async () => { const r = await get("SELECT COUNT(*) v, COUNT(l.rider_id) g FROM riders r LEFT JOIN rider_latest_location l ON l.rider_id=r.id AND l.received_at>? WHERE r.suspended=0 AND r.verification_status='verified'", now() - 900); return Number(r.v) ? { ok: true, message: `${r.v} verified rider(s), ${r.g} with GPS in the last 15 minutes.` } : { ok: false, message: 'No verified riders yet.' }; } },
  { key: 'llm', name: 'AI model (assistant)', capabilities: ['natural-language instructions'], creds: () => (env('ANTHROPIC_API_KEY') ? 'key present' : 'missing ANTHROPIC_API_KEY'), test: async () => {
    if (!env('ANTHROPIC_API_KEY')) return { ok: false, message: 'ANTHROPIC_API_KEY is not set.' };
    const r = await withTimeout('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' } });
    return r.ok ? { ok: true, message: 'The provider accepted the key.' } : { ok: false, message: `The provider answered ${r.status}${r.status === 401 ? ' (key rejected)' : ''}.` }; } },
  { key: 'email', name: 'Email (Resend)', capabilities: ['customer emails', 'supplier quotation requests'], creds: () => (env('RESEND_API_KEY') ? 'key present' : 'missing RESEND_API_KEY'), test: async () => {
    if (!env('RESEND_API_KEY')) return { ok: false, message: 'RESEND_API_KEY is not set.' };
    const r = await withTimeout((env('RESEND_API_URL') || 'https://api.resend.com') + '/domains', { headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY') } });
    return r.ok ? { ok: true, message: 'The provider accepted the key. No email was sent.' } : { ok: false, message: `The provider answered ${r.status}.` }; } },
  { key: 'paystack', name: 'Paystack payments', capabilities: ['card payments', 'refunds'], creds: () => (env('PAYSTACK_SECRET_KEY') ? 'key present' : 'missing PAYSTACK_SECRET_KEY'), test: async () => {
    if (!env('PAYSTACK_SECRET_KEY')) return { ok: false, message: 'PAYSTACK_SECRET_KEY is not set.' };
    const r = await withTimeout((env('PAYSTACK_API_URL') || 'https://api.paystack.co') + '/bank?perPage=1', { headers: { Authorization: 'Bearer ' + env('PAYSTACK_SECRET_KEY') } });
    return r.ok ? { ok: true, message: 'The provider accepted the key. No money moved.' } : { ok: false, message: `The provider answered ${r.status}.` }; } },
  { key: 'fx', name: 'Exchange rates', capabilities: ['foreign amounts in NGN'], creds: () => 'no key needed', test: async () => {
    const r = await withTimeout(env('FX_FEED_URL') || 'https://open.er-api.com/v6/latest/NGN'); if (!r.ok) return { ok: false, message: `The rate feed answered ${r.status}.` };
    const j = await r.json().catch(() => null); return j && j.rates && j.rates.USD ? { ok: true, message: 'The feed returned rates. Using them for approvals also needs FX_FEED_ENABLED=1.' } : { ok: false, message: 'The feed answered but without usable rates.' }; } },
  ...[['dhl', 'DHL', ['DHL_API_KEY', 'DHL_API_SECRET']], ['ups', 'UPS', ['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET']], ['fedex', 'FedEx', ['FEDEX_API_KEY', 'FEDEX_API_SECRET']]].map(([key, name, vars]) => ({
    key, name, capabilities: ['rates', 'booking', 'tracking'], adapter: false, creds: () => (vars.every(env) ? 'credentials present (unused)' : 'no credentials'),
    test: async () => ({ ok: false, message: `${name} has no adapter in this system yet, so nothing can be tested or booked through it. Staff record ${name} rates and tracking by hand in Logistics.` }) })),
];

async function results() { return (await AU.kvGet('integration_tests')) || {}; }
async function status() {
  const res = await results();
  return REGISTRY.map((r) => { const t = res[r.key]; return { key: r.key, name: r.name, capabilities: r.capabilities, credentials: r.creds(), adapter: r.adapter !== false,
    status: r.adapter === false ? 'not_connected' : !t ? 'not_tested' : t.ok ? 'connected' : 'failing', last_tested: t ? t.at : null, last_ok: t ? t.last_ok : null, last_error: t && !t.ok ? t.message : (t && t.last_error) || '', message: t ? t.message : 'Not tested yet.' }; });
}
async function test(key, by) {
  const r = REGISTRY.find((x) => x.key === key); if (!r) fail(404, 'Unknown integration.');
  let out; try { out = await r.test(); } catch (e) { out = { ok: false, message: e.name === 'AbortError' ? 'The service did not answer in 8 seconds.' : 'Could not reach it: ' + String(e.message).slice(0, 160) }; }
  const res = await results(), prev = res[key] || {};
  res[key] = { at: now(), ok: !!out.ok, message: out.message, last_ok: out.ok ? now() : prev.last_ok || null, last_error: out.ok ? prev.last_error || '' : out.message };
  await AU.kvSet('integration_tests', res, by);
  await require('./store').logAction({ agent: 'settings', actor_kind: 'human', actor_name: by, action_type: 'integration.test', description: `${r.name}: ${out.ok ? 'test passed' : 'test failed'}`, status: out.ok ? 'done' : 'failed', error: out.ok ? '' : out.message });
  return { key, ok: !!out.ok, message: out.message };
}
module.exports = { REGISTRY, status, test };
