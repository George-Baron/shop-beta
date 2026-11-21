'use strict';
// Restricted items and the compliance checklist.
//  - Restricted classes (medicines, food, chemicals, batteries, weapons...): words and HS code starts. A product that matches a "block" class cannot be
//    listed. One that matches a "review" class stays hidden until a person records that they checked the permits. The admin edits the classes.
//  - Checklist rules per country pair: reminders of permits and licences to verify, kept as data the admin edits. Never legal advice.
const { get, all, run, now } = require('./db');
const S = require('./shop');
const { fail, str, int } = S;
const C = require('./countries');

const classes = () => all('SELECT * FROM restricted_classes ORDER BY CASE action WHEN \'block\' THEN 0 ELSE 1 END, label');
const words = (t) => String(t || '').split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean);
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// d: { name, description, brand, hs_code } -> { action: 'block'|'review'|'', hits: [{ slug, label, action, why }] }. A block outranks a review.
async function classify(d, list) {
  list = list || await classes();
  const text = [d.name, d.description, d.brand].filter(Boolean).join(' ').toLowerCase(), hs = String(d.hs_code || '').replace(/\D/g, '');
  const hits = [];
  for (const c of list) {
    if (!c.active) continue;
    const kw = words(c.keywords).find((w) => new RegExp('(^|[^a-z0-9])' + esc(w) + '(s|es)?($|[^a-z0-9])').test(text));
    const pre = hs ? words(c.hs_prefixes).find((p) => hs.startsWith(p.replace(/\D/g, ''))) : '';
    if (kw) hits.push({ slug: c.slug, label: c.label, action: c.action, why: `the product mentions "${kw}"` });
    else if (pre) hits.push({ slug: c.slug, label: c.label, action: c.action, why: `the HS code starts with ${pre}` });
  }
  const worst = hits.find((h) => h.action === 'block') || hits[0];
  return { action: worst ? worst.action : '', slug: worst ? worst.slug : '', hits };
}
const explain = (r) => r.hits.map((h) => `${h.label} (${h.why})`).join('; ');

async function saveClass(user, slug, b) {
  slug = str(slug, 31).toLowerCase();
  const old = slug ? await get('SELECT * FROM restricted_classes WHERE slug=?', slug) : null;
  if (!old) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(slug)) fail(400, 'The code must be lowercase letters, numbers or _ and start with a letter.');
  }
  const label = str(b.label, 80) || (old && old.label); if (!label) fail(400, 'Give the class a name.');
  const action = b.action === 'block' ? 'block' : b.action === 'review' ? 'review' : fail(400, 'Choose block or review.');
  const keywords = words(b.keywords).slice(0, 200).join(','), hs = words(b.hs_prefixes).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 2 && p.length <= 10).slice(0, 100).join(',');
  const active = b.active === false || b.active === 0 || b.active === '0' ? 0 : 1;
  if (slug === 'medicines' && (action !== 'block' || !active) && process.env.PHARMACY_ENABLED !== '1') fail(400, 'Medicines stay blocked here. They are sold only through the pharmacy, behind PHARMACY_ENABLED.');
  await run(`INSERT INTO restricted_classes (slug,label,action,keywords,hs_prefixes,note,active,updated) VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT (slug) DO UPDATE SET label=EXCLUDED.label, action=EXCLUDED.action, keywords=EXCLUDED.keywords, hs_prefixes=EXCLUDED.hs_prefixes, note=EXCLUDED.note, active=EXCLUDED.active, updated=EXCLUDED.updated`,
    slug, label, action, keywords, hs, str(b.note, 300), active, now());
  return slug;
}
async function removeClass(slug) {
  if (slug === 'medicines' || slug === 'weapons') fail(400, 'This class cannot be removed. You can only make it stricter or turn it off.');
  await run('DELETE FROM restricted_classes WHERE slug=?', str(slug, 31));
}

/* ---------- checklist rules ---------- */
const CATS = ['permit', 'licence', 'registration', 'banned', 'tax', 'document', 'other'];
const rules = () => all('SELECT * FROM trade_rules ORDER BY from_country, to_country, direction, sort, id');
async function parseRule(b) {
  const code = (v) => { v = String(v || '*').trim().toUpperCase(); if (v === '' || v === '*') return '*'; if (!C.isCountry(v)) fail(400, `"${v}" is not a country code. Use two letters like NG, or * for any country.`); return v; };
  const title = str(b.title, 160); if (!title) fail(400, 'Write what has to be checked.');
  const cls = str(b.product_class, 31).toLowerCase();
  if (cls && !(await get('SELECT 1 x FROM restricted_classes WHERE slug=?', cls))) fail(400, 'That product class does not exist. Leave it empty to apply to every shipment.');
  const url = str(b.url, 300); if (url && !/^https?:\/\/[^\s"'<>]+$/.test(url)) fail(400, 'The link must start with http:// or https://.');
  return { from_country: code(b.from_country), to_country: code(b.to_country), direction: ['import', 'export', 'both'].includes(b.direction) ? b.direction : 'both', product_class: cls,
    category: CATS.includes(b.category) ? b.category : 'other', title, detail: str(b.detail, 600), authority: str(b.authority, 120), url, required: b.required === false || b.required === 0 || b.required === '0' ? 0 : 1,
    active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1, sort: Math.max(0, Math.min(999, int(b.sort) || 0)) };
}
async function createRule(b) {
  const r = await parseRule(b);
  if (await get('SELECT 1 x FROM trade_rules WHERE from_country=? AND to_country=? AND direction=? AND product_class=? AND lower(title)=lower(?)', r.from_country, r.to_country, r.direction, r.product_class, r.title)) fail(409, 'That reminder already exists for this country pair.');
  return Number((await run('INSERT INTO trade_rules (from_country,to_country,direction,product_class,category,title,detail,authority,url,required,active,sort,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', r.from_country, r.to_country, r.direction, r.product_class, r.category, r.title, r.detail, r.authority, r.url, r.required, r.active, r.sort, now())).lastInsertRowid);
}
async function updateRule(id, b) {
  if (!(await get('SELECT 1 x FROM trade_rules WHERE id=?', int(id)))) fail(404, 'Reminder not found.');
  const r = await parseRule(b);
  if (await get('SELECT 1 x FROM trade_rules WHERE from_country=? AND to_country=? AND direction=? AND product_class=? AND lower(title)=lower(?) AND id<>?', r.from_country, r.to_country, r.direction, r.product_class, r.title, int(id))) fail(409, 'Another reminder with the same title exists for this country pair.');
  await run('UPDATE trade_rules SET from_country=?,to_country=?,direction=?,product_class=?,category=?,title=?,detail=?,authority=?,url=?,required=?,active=?,sort=?,updated=? WHERE id=?', r.from_country, r.to_country, r.direction, r.product_class, r.category, r.title, r.detail, r.authority, r.url, r.required, r.active, r.sort, now(), int(id));
}
async function removeRule(id) { await run('DELETE FROM trade_rules WHERE id=?', int(id)); }

// The reminders that apply to a shipment: its country pair (or any), its direction, and the classes of its items.
async function checklist(ship, itemClasses) {
  const rows = await all(`SELECT r.*, c.status check_status, c.note check_note, c.checked_by, c.checked_at FROM trade_rules r
    LEFT JOIN trade_checks c ON c.rule_id=r.id AND c.shipment_id=?
    WHERE r.active=1 AND r.from_country IN ('*', ?) AND r.to_country IN ('*', ?) AND r.direction IN ('both', ?) ORDER BY r.sort, r.id`, ship.id, ship.origin_country, ship.dest_country, ship.direction);
  const have = new Set(itemClasses || []);
  const list = rows.filter((r) => !r.product_class || have.has(r.product_class)).map((r) => ({ id: Number(r.id), category: r.category, title: r.title, detail: r.detail, authority: r.authority, url: r.url, required: !!r.required, product_class: r.product_class,
    from_country: r.from_country, to_country: r.to_country, status: r.check_status || 'pending', note: r.check_note || '', checked_by: r.checked_by || '', checked_at: r.checked_at ? Number(r.checked_at) : null }));
  const open = list.filter((r) => r.required && r.status === 'pending').length;
  return { items: list, open, total: list.length, note: 'These are reminders for you to verify with the official source. They are not legal advice and they may be out of date.' };
}
async function setCheck(user, shipId, ruleId, b) {
  const rule = await get('SELECT id FROM trade_rules WHERE id=?', int(ruleId)); if (!rule) fail(404, 'Reminder not found.');
  const status = ['pending', 'done', 'na'].includes(b.status) ? b.status : fail(400, 'Choose pending, done or not applicable.');
  if (status === 'na' && !str(b.note, 300)) fail(400, 'Write why this does not apply, so the next person knows.');
  await run(`INSERT INTO trade_checks (shipment_id,rule_id,status,note,checked_by,checked_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT (shipment_id,rule_id) DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, checked_by=EXCLUDED.checked_by, checked_at=EXCLUDED.checked_at`,
    int(shipId), int(ruleId), status, str(b.note, 300), user.name || user.email || 'admin', now());
}

module.exports = { classes, classify, explain, saveClass, removeClass, rules, createRule, updateRule, removeRule, checklist, setCheck, CATS };
