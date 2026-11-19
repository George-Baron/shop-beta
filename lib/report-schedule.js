'use strict';
// Reports emailed on a schedule: daily (yesterday), weekly (Monday, the previous Monday to Sunday) or monthly (the 1st, the previous month),
// sent shortly after 07:00 Lagos time. The email carries the headline figures and a link; the full report and its PDF/Excel are in the back office.
const { get, all, run, now } = require('./db');
const S = require('./shop');
const St = require('./staff');
const C = require('./commercial');
const W = require('./wh-reports');
const { fail } = S;

const LAGOS = 3600, DAY = 86400;
const SOURCES = { commercial: C, warehouse: W };
const FREQ = { daily: 'Every day', weekly: 'Every Monday', monthly: 'On the 1st of each month' };
const ymd = (t) => new Date(t * 1000).toISOString().slice(0, 10);

const meta = (source, name) => { const m = SOURCES[source] && SOURCES[source].LIST.find((x) => x.name === name); if (!m) fail(400, 'Choose a report from the list.'); return m; };
// May this person (as a staff permission list) read this report?
function canRead(perms, source, m) {
  if (perms.includes('*')) return true;
  const has = (x) => perms.includes(x);
  if (source === 'warehouse') return has('warehouse:view') || has('warehouse:edit');
  if (m.name === 'employee-performance') return has('reports:edit');
  if (m.money) return has('reports:view') || has('finance:view') || has('reports:edit') || has('finance:edit');
  return has('reports:view') || has('partners:view') || has('rfq:view') || has('reports:edit');
}
async function recipients(ids) {
  if (!ids.length) return [];
  return all(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND role IN ('staff','admin') AND COALESCE(active,1)=1`, ...ids);
}
async function view(row) {
  const m = SOURCES[row.source].LIST.find((x) => x.name === row.report), ids = JSON.parse(row.recipient_ids || '[]');
  const us = await recipients(ids);
  return { id: Number(row.id), source: row.source, report: row.report, title: m ? m.title : row.report, frequency: row.frequency, when: FREQ[row.frequency], active: !!row.active, recipients: us.map((u) => ({ id: Number(u.id), name: u.name, email: u.email })), last_sent: row.last_sent ? Number(row.last_sent) : null, last_note: row.last_note || '' };
}
const list = async () => Promise.all((await all('SELECT * FROM report_schedules ORDER BY id DESC')).map(view));

async function validate(b) {
  const m = meta(b.source, b.report);
  if (!FREQ[b.frequency]) fail(400, 'Choose how often to send it.');
  const ids = [...new Set((Array.isArray(b.recipients) ? b.recipients : []).map(Number).filter(Number.isInteger))].slice(0, 10);
  if (!ids.length) fail(400, 'Choose at least one person to send it to.');
  const us = await recipients(ids);
  if (us.length !== ids.length) fail(400, 'Reports can only go to active employees or the owner.');
  for (const u of us) if (!canRead(await St.permsOf(u), b.source, m)) fail(400, `${u.name} does not have permission to see "${m.title}". Change their role first, or choose someone else.`);
  return { m, ids };
}
async function create(b, by) {
  const { ids } = await validate(b);
  const r = await get('INSERT INTO report_schedules (source,report,frequency,recipient_ids,created_by,created) VALUES (?,?,?,?,?,?) RETURNING id', b.source, b.report, b.frequency, JSON.stringify(ids), by.id, now());
  return Number(r.id);
}
async function update(id, b) {
  const row = await get('SELECT * FROM report_schedules WHERE id=?', id); if (!row) fail(404, 'Schedule not found.');
  if (b.active !== undefined) await run('UPDATE report_schedules SET active=? WHERE id=?', b.active ? 1 : 0, id);
  if (b.frequency !== undefined || b.recipients !== undefined) {
    const { ids } = await validate({ source: row.source, report: row.report, frequency: b.frequency || row.frequency, recipients: b.recipients || JSON.parse(row.recipient_ids) });
    await run('UPDATE report_schedules SET frequency=?, recipient_ids=? WHERE id=?', b.frequency || row.frequency, JSON.stringify(ids), id);
  }
}
const remove = (id) => run('DELETE FROM report_schedules WHERE id=?', id);

// The period a send covers, ending before "today" (Lagos).
function periodFor(freq, t = now()) {
  const d = new Date((t + LAGOS) * 1000), day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;   // Lagos midnight, as UTC seconds
  if (freq === 'daily') return { from: ymd(day0 - DAY), to: ymd(day0 - DAY) };
  if (freq === 'weekly') { const dow = (new Date(day0 * 1000).getUTCDay() + 6) % 7; const mon = day0 - dow * DAY; return { from: ymd(mon - 7 * DAY), to: ymd(mon - DAY) }; }
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return { from: ymd(prev.getTime() / 1000), to: ymd(first.getTime() / 1000 - DAY) };
}
// Which send slot is open right now (null when none is: before 07:00 Lagos, or not a Monday / the 1st).
function slotNow(freq, t = now()) {
  const d = new Date((t + LAGOS) * 1000); if (d.getUTCHours() < 7) return null;
  const day = d.toISOString().slice(0, 10);
  if (freq === 'daily') return day;
  if (freq === 'weekly') return d.getUTCDay() === 1 ? day : null;
  return d.getUTCDate() === 1 ? day : null;
}
const fmtV = (v, t) => v == null || v === '' ? '—' : t === 'money' ? 'NGN ' + Number(v).toLocaleString('en-NG') : t === 'int' ? Number(v).toLocaleString('en-NG') : t === 'hours' ? Number(v).toFixed(1) + ' h' : S.esc(v);

async function send(row) {
  const m = SOURCES[row.source].LIST.find((x) => x.name === row.report); if (!m) return 'Report no longer exists.';
  const us = [];
  for (const u of await recipients(JSON.parse(row.recipient_ids || '[]'))) if (canRead(await St.permsOf(u), row.source, m)) us.push(u);
  if (!us.length) return 'No recipient is allowed to see this report any more.';
  const q = m.dated ? periodFor(row.frequency) : {};
  const mod = SOURCES[row.source], rep = await (mod.report || mod.run)(row.report, q);
  const Set = await S.getSettings(), link = `${S.BASE_URL}/admin#/${row.source === 'warehouse' ? 'warehouse' : 'commercial'}`;
  const sum = (rep.summary || []).slice(0, 8).map((s) => `<tr><td style="padding:4px 12px 4px 0;color:#667085">${S.esc(s.label)}</td><td style="padding:4px 0"><b>${fmtV(s.value, s.type)}</b></td></tr>`).join('');
  const body = S.mailWrap(Set, `<p>Your ${S.esc(FREQ[row.frequency].toLowerCase())} report is ready.</p><h3 style="margin:8px 0">${S.esc(rep.title)}</h3><p style="color:#667085">${rep.from ? S.esc(rep.from) + (rep.to && rep.to !== rep.from ? ' to ' + S.esc(rep.to) : '') : 'Up to now'}</p><table style="font-size:14px;border-collapse:collapse">${sum}</table><p><a href="${S.esc(link)}" style="display:inline-block;background:#16181d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the full report</a></p><p style="color:#667085;font-size:12px">Sign in to see every row and to download it as PDF or Excel. Figures are not attached to this email.</p>`);
  for (const u of us) await S.queueMail(u.email, `${{ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[row.frequency]} report: ${rep.title}`, body);
  return `Sent to ${us.length} ${us.length === 1 ? 'person' : 'people'}.`;
}
// Called every half hour by the worker. The slot claim makes sure each schedule goes out once even with several servers running.
async function runDue() {
  let n = 0;
  for (const row of await all('SELECT * FROM report_schedules WHERE active=1')) {
    const slot = slotNow(row.frequency); if (!slot || row.last_slot === slot) continue;
    const claim = await run('UPDATE report_schedules SET last_slot=? WHERE id=? AND (last_slot IS NULL OR last_slot<>?)', slot, row.id, slot);
    if (!claim.changes) continue;
    let note; try { note = await send(row); } catch (e) { note = 'Failed: ' + String(e.message).slice(0, 150); console.error('Scheduled report failed:', e.message); }
    await run('UPDATE report_schedules SET last_sent=?, last_note=? WHERE id=?', now(), note, row.id); n++;
  }
  return n;
}
async function sendNow(id) {
  const row = await get('SELECT * FROM report_schedules WHERE id=?', id); if (!row) fail(404, 'Schedule not found.');
  const note = await send(row); await run('UPDATE report_schedules SET last_sent=?, last_note=? WHERE id=?', now(), note, id); return note;
}
module.exports = { list, create, update, remove, runDue, sendNow, periodFor, slotNow, canRead, FREQ };
