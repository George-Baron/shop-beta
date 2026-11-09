-- Indexes for product listing, search, and orders. Plus a search column kept up to date by triggers.

-- Product listing: department page and shop page, default and common sort orders (active products only).
CREATE INDEX idx_products_store_featured ON products (store, featured DESC, id DESC) WHERE active = 1;
CREATE INDEX idx_products_store_sold ON products (store, sold DESC, id DESC) WHERE active = 1;
CREATE INDEX idx_products_store_created ON products (store, created DESC, id DESC) WHERE active = 1;
CREATE INDEX idx_products_store_price ON products (store, price) WHERE active = 1;
CREATE INDEX idx_products_active_id ON products (id DESC) WHERE active = 1;
CREATE INDEX idx_products_category ON products (category_id) WHERE active = 1;
CREATE INDEX idx_products_flags ON products (store, id DESC) WHERE active = 1 AND (featured = 1 OR bestseller = 1 OR new_arrival = 1);
CREATE INDEX idx_products_deals ON products (store) WHERE active = 1 AND compare_price > price;
CREATE INDEX idx_products_lowstock ON products (stock, id) WHERE active = 1 AND stock <= 5;
CREATE INDEX idx_reviews_product ON reviews (product_id, approved);
CREATE INDEX idx_reviews_user ON reviews (user_id, product_id);
CREATE INDEX idx_variants_size_color ON variants (product_id, size, color);

-- Search: one lower-case text column holding name, brand, SKU, category name and description.
ALTER TABLE products ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

CREATE FUNCTION products_search_text() RETURNS trigger AS $$
BEGIN
  NEW.search_text := lower(NEW.name || ' | ' || NEW.brand || ' | ' || NEW.sku || ' | ' ||
    COALESCE((SELECT c.name FROM categories c WHERE c.id = NEW.category_id), '') || ' | ' || NEW.description);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_search BEFORE INSERT OR UPDATE OF name, brand, sku, description, category_id ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_text();

-- Renaming a category refreshes the products in it (touching category_id fires the trigger above).
CREATE FUNCTION categories_rename() RETURNS trigger AS $$
BEGIN
  UPDATE products SET category_id = category_id WHERE category_id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_categories_rename AFTER UPDATE OF name ON categories
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION categories_rename();

-- Fast substring search (LIKE '%word%') needs the pg_trgm extension. Supabase and normal Postgres have it.
-- If it cannot be created, search still works, only slower.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX idx_products_search ON products USING gin (search_text gin_trgm_ops) WHERE active = 1;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm is not available (%). Product search will be slower.', SQLERRM;
END $$;

-- Orders: by customer, by status, by payment reference, by email, by date.
CREATE INDEX idx_orders_user ON orders (user_id, id DESC);
CREATE INDEX idx_orders_status ON orders (status, created DESC);
CREATE INDEX idx_orders_status_id ON orders (status, id DESC);
CREATE INDEX idx_orders_created ON orders (created);
CREATE INDEX idx_orders_email ON orders (lower(email), created DESC);
CREATE INDEX idx_orders_paystack_ref ON orders (paystack_ref) WHERE paystack_ref <> '';
CREATE INDEX idx_orders_unpaid ON orders (created) WHERE payment_method = 'paystack' AND payment_status = 'unpaid' AND status = 'pending';
CREATE INDEX idx_order_items_order ON order_items (order_id);
CREATE INDEX idx_order_items_product ON order_items (product_id);
CREATE INDEX idx_order_events_order ON order_events (order_id, id);

CREATE INDEX idx_messages_unread ON messages (read) WHERE read = 0;
CREATE INDEX idx_outbox_created ON outbox (created);
CREATE INDEX idx_abandoned_pending ON abandoned (created) WHERE reminded = 0;
