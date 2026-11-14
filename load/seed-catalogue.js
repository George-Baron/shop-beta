'use strict';
// Fills a THROWAWAY database with a large catalogue so load tests are realistic.
//   DATABASE_URL=postgres://.../shop_load node load/seed-catalogue.js 20000
// Never point this at the live shop: it refuses a non-local database unless you add --allow-remote,
// and it refuses a database that already holds orders.
const fs = require('fs');
const path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch { /* no .env */ }
const { get, run, end } = require('../lib/db');
const { migrate } = require('../lib/migrate');
const { seed } = require('../lib/seed');

(async () => {
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(host) && !process.argv.includes('--allow-remote')) {
    console.error(`Refusing: ${host} is not a local database. Load tests must never touch the live shop.`); process.exit(1);
  }
  await migrate(); await seed();
  if (await get('SELECT 1 x FROM orders LIMIT 1')) { console.error('This database already has orders. Refusing to touch it.'); process.exit(1); }
  const N = Math.max(1, Number(process.argv.find((a) => /^\d+$/.test(a))) || 20000);
  await run(`WITH c AS (SELECT array_agg(id ORDER BY id) ids, array_agg(store ORDER BY id) stores, COUNT(*) n FROM categories)
    INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,featured,bestseller,new_arrival,sold,created)
    SELECT 'load-'||i, c.stores[1+i%c.n], c.ids[1+i%c.n],
      (ARRAY['Classic','Premium','Royal','Fresh','Glow','Smart','Ultra','Family','Pure','Gold','Daily','Mega'])[1+i%12]||' '||(ARRAY['Soap','Lotion','Rice','Shirt','Charger','Cream','Sandals','Juice','Notebook','Perfume','Biscuit','Cable'])[1+(i*7)%12]||' '||(i/12),
      'Brand'||(i%50), 'Load test product number '||i, 500+((i*137)%40000), CASE WHEN i%5=0 THEN 1000+((i*137)%40000) ELSE 0 END, 1000000, 'LT-'||i, '📦',
      CASE WHEN i%40=0 THEN 1 ELSE 0 END, CASE WHEN i%50=0 THEN 1 ELSE 0 END, CASE WHEN i%60=0 THEN 1 ELSE 0 END, i%97, 1700000000+i
    FROM c, generate_series(0, ?::int - 1) i`, N);
  await run(`INSERT INTO variants (product_id,size,color,stock) SELECT p.id, v.s, '', 100000 FROM products p CROSS JOIN (VALUES ('S'),('M'),('L')) v(s)
    WHERE p.slug LIKE 'load-%' AND substring(p.slug from 6)::int % 4 = 0`);
  await run("UPDATE products SET stock = 300000 WHERE slug LIKE 'load-%' AND substring(slug from 6)::int % 4 = 0");
  // A scarce item for the overselling test: only 10 units, and the load script keeps trying to buy it.
  if (!process.argv.includes('--no-scarce')) await run("INSERT INTO products (slug,store,category_id,name,brand,description,price,stock,sku,emoji,created) SELECT 'load-scarce', store, category_id, 'Scarce load-test item', 'X', 'Only 10 units', 1500, 10, 'LT-SCARCE', '🔥', 1700000000 FROM products ORDER BY id LIMIT 1 ON CONFLICT (slug) DO NOTHING");
  await run('ANALYZE');
  console.log(`Seeded ${N} products. Total products now: ${(await get('SELECT COUNT(*) n FROM products')).n}`);
  await end();
})().catch((e) => { console.error(e.message); process.exit(1); });
