-- Global Trade phase 3: export checkout.
-- Carriers usually bill weight in steps (for example every 0.5 kg). The step lives on the rate rule, so each carrier can use its own.
ALTER TABLE shipping_rate_rules ADD COLUMN weight_step NUMERIC(6,3) NOT NULL DEFAULT 0.5 CHECK (weight_step > 0);
-- Which shipping service and insurance choice an export order used (the quote itself is kept in shipping_rate_quotes).
ALTER TABLE export_orders ADD COLUMN service_id BIGINT REFERENCES shipping_services(id) ON DELETE SET NULL;
ALTER TABLE export_orders ADD COLUMN insured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_orders ADD COLUMN service_label TEXT NOT NULL DEFAULT '';
ALTER TABLE export_orders ADD COLUMN total_ngn INTEGER NOT NULL DEFAULT 0;   -- what was actually charged (the order's total in naira)
-- A quote belongs to one exact cart, destination and currency; the hash is how checkout proves the cart did not change.
ALTER TABLE shipping_rate_quotes ADD COLUMN cart_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_srq_hash ON shipping_rate_quotes(cart_hash, id DESC);
-- One tracking event per (order, stage) from the system; manual events carry their own hash.
CREATE INDEX idx_exoi_product ON export_order_items(product_id);
