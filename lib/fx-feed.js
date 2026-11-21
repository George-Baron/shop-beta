'use strict';
// Optional automatic exchange rates. Off unless FX_FEED_ENABLED=1. Rates entered by hand are "locked" and never touched; the feed only keeps unlocked rates fresh.
// A jump of more than 25% in one update is treated as a bad reading and ignored, and a feed rate that goes stale (see FX_MAX_AGE_HOURS) stops being used.
const { get, all, run, now } = require('./db');

const enabled = () => process.env.FX_FEED_ENABLED === '1';
const url = () => process.env.FX_FEED_URL || 'https://open.er-api.com/v6/latest/NGN';   // answers { rates: { USD: 0.00066, ... } } = units per 1 Naira
const MAX_JUMP = 0.25;

async function refresh() {
  if (!enabled()) return { skipped: 'The automatic rate feed is switched off.' };
  const res = await fetch(url(), { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('The rate feed answered ' + res.status);
  const d = await res.json().catch(() => null);
  const per = d && (d.rates || d.conversion_rates);
  if (!per || typeof per !== 'object') throw new Error('The rate feed sent something we do not understand.');
  const out = { updated: [], kept_locked: [], rejected: [], missing: [] };
  const t = now();
  for (const c of await all("SELECT code FROM currencies WHERE code <> 'NGN' ORDER BY code")) {
    const units = Number(per[c.code]);
    if (!(units > 0) || !Number.isFinite(units)) { out.missing.push(c.code); continue; }
    const rate = 1 / units;                                       // Naira per 1 unit
    const cur = await get('SELECT ngn_per_unit, locked FROM fx_rates WHERE currency = ?', c.code);
    if (cur && cur.locked) { out.kept_locked.push(c.code); await run('UPDATE fx_rates SET checked_at = ? WHERE currency = ?', t, c.code); continue; }
    if (cur && Math.abs(rate - Number(cur.ngn_per_unit)) / Number(cur.ngn_per_unit) > MAX_JUMP) { out.rejected.push(c.code); continue; }
    await run("INSERT INTO fx_rates (currency, ngn_per_unit, source, updated, updated_by, locked, checked_at) VALUES (?,?,'feed',?,'feed',FALSE,?) ON CONFLICT (currency) DO UPDATE SET ngn_per_unit = EXCLUDED.ngn_per_unit, source = 'feed', updated = EXCLUDED.updated, updated_by = 'feed', checked_at = EXCLUDED.checked_at", c.code, Math.round(rate * 1e6) / 1e6, t, t);
    out.updated.push(c.code);
  }
  require('./cache').clear();
  return out;
}
module.exports = { enabled, refresh, url };
