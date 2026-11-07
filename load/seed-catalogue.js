'use strict';
// Fills a THROWAWAY database with a large catalogue so load tests are realistic.
// Usage: DATA_DIR=/tmp/sb-load node load/seed-catalogue.js 20000
// Never point DATA_DIR at the live shop. Refuses to run if the data folder already holds orders.
const path = require('path');
if (!process.env.DATA_DIR) { console.error('Set DATA_DIR to a scratch folder first.'); process.exit(1); }
const { db, get, all, run, tx, now } = require(path.join(__dirname, '..', 'lib', 'db'));
const { seed } = require(path.join(__dirname, '..', 'lib', 'seed'));
seed();
if (get('SELECT 1 x FROM orders LIMIT 1')) { console.error('This database already has orders. Refusing to touch it.'); process.exit(1); }
const N = Math.max(1, Number(process.argv[2]) || 20000);
const cats = all('SELECT id, store, name FROM categories');
const words = ['Classic', 'Premium', 'Royal', 'Fresh', 'Glow', 'Smart', 'Ultra', 'Family', 'Pure', 'Gold', 'Daily', 'Mega'];
const things = ['Soap', 'Lotion', 'Rice', 'Shirt', 'Charger', 'Cream', 'Sandals', 'Juice', 'Notebook', 'Perfume', 'Biscuit', 'Cable'];
const t = now();
tx(() => {
  for (let i = 0; i < N; i++) {
    const c = cats[i % cats.length], name = `${words[i % 12]} ${things[(i * 7) % 12]} ${Math.floor(i / 12)}`;
    const price = 500 + ((i * 137) % 40000);
    const r = run('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,featured,bestseller,new_arrival,sold,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      `load-${i}`, c.store, c.id, name, `Brand${i % 50}`, `${name} for load testing. ${c.name}.`, price, i % 5 === 0 ? price + 500 : 0, 1000000, `LT-${i}`, '📦', i % 40 === 0 ? 1 : 0, i % 50 === 0 ? 1 : 0, i % 60 === 0 ? 1 : 0, i % 97, t - i);
    if (i % 4 === 0) { const pid = Number(r.lastInsertRowid); for (const s of ['S', 'M', 'L']) run('INSERT INTO variants (product_id,size,color,stock) VALUES (?,?,?,?)', pid, s, '', 100000); run('UPDATE products SET stock=300000 WHERE id=?', pid); }
  }
});
console.log(`Seeded ${N} products. Total products now: ${get('SELECT COUNT(*) n FROM products').n}`);
void db;
