'use strict';
// SQLite through Node's built-in driver (no native build step). Timestamps are unix seconds.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'shop.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS stores (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, tab_label TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🛍',
  tagline TEXT NOT NULL DEFAULT '', hero_title TEXT NOT NULL DEFAULT '', hero_sub TEXT NOT NULL DEFAULT '', hero_cta TEXT NOT NULL DEFAULT 'Shop now',
  promo1_title TEXT NOT NULL DEFAULT '', promo1_sub TEXT NOT NULL DEFAULT '', promo2_title TEXT NOT NULL DEFAULT '', promo2_sub TEXT NOT NULL DEFAULT '',
  banner_title TEXT NOT NULL DEFAULT '', banner_sub TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, store TEXT NOT NULL REFERENCES stores(slug) ON DELETE CASCADE, slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🛍', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, store TEXT NOT NULL REFERENCES stores(slug),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL, compare_price INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL DEFAULT '', emoji TEXT NOT NULL DEFAULT '📦', images TEXT NOT NULL DEFAULT '[]', size_label TEXT NOT NULL DEFAULT 'Size',
  featured INTEGER NOT NULL DEFAULT 0, bestseller INTEGER NOT NULL DEFAULT 0, new_arrival INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sold INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store, active);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resets (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Home', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wishlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS zones (
  state TEXT PRIMARY KEY, fee INTEGER NOT NULL DEFAULT 0, eta TEXT NOT NULL DEFAULT '', pod INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY COLLATE NOCASE, type TEXT NOT NULL DEFAULT 'percent', value INTEGER NOT NULL, min_spend INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending', payment_method TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'unpaid', paystack_ref TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, state TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL DEFAULT 'standard', delivery_fee INTEGER NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0,
  coupon TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER NOT NULL, variant_id INTEGER,
  name TEXT NOT NULL, variant_label TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL, qty INTEGER NOT NULL, emoji TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL, rating INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', approved INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, approved);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS newsletter (email TEXT PRIMARY KEY COLLATE NOCASE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS abandoned (email TEXT PRIMARY KEY COLLATE NOCASE, cart TEXT NOT NULL, created INTEGER NOT NULL, reminded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
`);

const cache = new Map();
const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
const get = (sql, ...p) => stmt(sql).get(...p);
const all = (sql, ...p) => stmt(sql).all(...p);
const run = (sql, ...p) => stmt(sql).run(...p);
const now = () => Math.floor(Date.now() / 1000);

// Run fn atomically. fn must be synchronous (no awaits) so nothing interleaves.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (err) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw err; }
}

module.exports = { db, get, all, run, tx, now, DATA_DIR };
