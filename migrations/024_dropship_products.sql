-- Dropshipping, step 2: dropship products, pricing inputs, exchange rates, margin rules. Safe to re-run: every statement is guarded.

-- "own" = our stock (everything that exists today). "dropship" = the supplier ships it. Dropship products start with listing='pending'
-- (the review flag partner-store products already use) and are only visible to customers once approved AND their supplier is active.
ALTER TABLE products ADD COLUMN IF NOT EXISTS fulfilment TEXT NOT NULL DEFAULT 'own';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_fulfilment_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_fulfilment_check CHECK (fulfilment IN ('own','dropship'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_products_dropship ON products(listing, id DESC) WHERE fulfilment = 'dropship';

-- Everything about a dropship product that customers must never see (supplier, supplier SKU, cost, margin) lives here, not on products.
CREATE TABLE IF NOT EXISTS dropship_products (
  product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  supplier_sku TEXT NOT NULL CHECK (length(btrim(supplier_sku)) > 0),
  supplier_url TEXT NOT NULL DEFAULT '',
  cost NUMERIC(14,2) NOT NULL CHECK (cost >= 0),                    -- per unit, in the supplier's currency
  ship_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (ship_cost >= 0),-- shipping we pay per unit, in the supplier's currency
  supplier_stock INTEGER CHECK (supplier_stock IS NULL OR supplier_stock >= 0),   -- NULL = they did not tell us
  processing_days INTEGER CHECK (processing_days IS NULL OR (processing_days >= 0 AND processing_days <= 120)),   -- NULL = use the supplier's average
  ship_times JSONB NOT NULL DEFAULT '{}'::jsonb,                    -- {"NG":{"min":7,"max":14},"ALL":{...}}: shipping days per destination
  weight_kg NUMERIC(8,3) CHECK (weight_kg IS NULL OR weight_kg >= 0),
  length_cm NUMERIC(8,1) CHECK (length_cm IS NULL OR length_cm >= 0), width_cm NUMERIC(8,1) CHECK (width_cm IS NULL OR width_cm >= 0), height_cm NUMERIC(8,1) CHECK (height_cm IS NULL OR height_cm >= 0),
  hs_code TEXT NOT NULL DEFAULT '', origin_country CHAR(2), ships_from CHAR(2),                 -- ships_from NULL = the supplier's country
  duty_pct NUMERIC(5,2) CHECK (duty_pct IS NULL OR (duty_pct >= 0 AND duty_pct <= 500)),       -- NULL = shop default
  tax_pct NUMERIC(5,2) CHECK (tax_pct IS NULL OR (tax_pct >= 0 AND tax_pct <= 100)),
  margin_type TEXT CHECK (margin_type IS NULL OR margin_type IN ('percent','fixed')), margin_value NUMERIC(12,2) CHECK (margin_value IS NULL OR margin_value >= 0),
  price_mode TEXT NOT NULL DEFAULT 'auto' CHECK (price_mode IN ('auto','manual')),             -- auto: the price comes from the calculation
  priced_rate NUMERIC(20,8), priced_at BIGINT,                                                  -- the exchange rate the price was last worked out with
  source_images TEXT NOT NULL DEFAULT '[]',                                                     -- supplier photo links still to be copied into our storage
  created BIGINT NOT NULL, updated BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dropship_supplier_sku ON dropship_products(supplier_id, lower(btrim(supplier_sku)));
CREATE INDEX IF NOT EXISTS idx_dropship_supplier ON dropship_products(supplier_id);

-- Exchange rates: Naira per 1 unit of the currency. The admin edits these by hand (step 3 adds the optional automatic feed).
CREATE TABLE IF NOT EXISTS fx_rates (
  currency CHAR(3) PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'NGN'),
  ngn_per_unit NUMERIC(20,8) NOT NULL CHECK (ngn_per_unit > 0),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','feed')),
  updated BIGINT NOT NULL, updated_by TEXT NOT NULL DEFAULT ''
);

-- Margin rule per category (the other levels are on the product, the supplier, and in dropship_settings).
CREATE TABLE IF NOT EXISTS dropship_category_margins (
  category_id BIGINT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  margin_type TEXT NOT NULL CHECK (margin_type IN ('percent','fixed')), margin_value NUMERIC(12,2) NOT NULL CHECK (margin_value >= 0)
);

-- Pricing defaults. A separate table, NOT the public "settings" table, so cost and margin settings can never be sent to the storefront.
CREATE TABLE IF NOT EXISTS dropship_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');

ALTER TABLE dropship_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dropship_category_margins ENABLE ROW LEVEL SECURITY;
ALTER TABLE dropship_settings ENABLE ROW LEVEL SECURITY;
