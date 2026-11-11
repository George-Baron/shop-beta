-- Order states become: pending, paid, confirmed, dispatched, delivered, cancelled, refunded.
-- (Old "processing" becomes "confirmed" and old "shipped" becomes "dispatched".)
UPDATE orders SET status = 'confirmed' WHERE status = 'processing';
UPDATE orders SET status = 'dispatched' WHERE status = 'shipped';
UPDATE order_events SET status = 'confirmed' WHERE status = 'processing';
UPDATE order_events SET status = 'dispatched' WHERE status = 'shipped';

ALTER TABLE orders
  ADD COLUMN phone_confirmed_at BIGINT,                      -- pay-on-delivery: when staff phoned the customer and the order was confirmed
  ADD COLUMN phone_confirmed_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN phone_confirm_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN pay_url TEXT NOT NULL DEFAULT '';               -- Paystack payment page for this order (so a repeated request returns the same one)
-- Nothing outside these values can ever be saved, whatever a bug or a script tries.
ALTER TABLE orders ADD CONSTRAINT orders_status_chk CHECK (status IN ('pending','paid','confirmed','dispatched','delivered','cancelled','refunded'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_chk CHECK (payment_status IN ('unpaid','paid','refunded'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_chk CHECK (payment_method IN ('pod','paystack'));

-- One row per "Place order" tap. A second request with the same key gets the first order back instead of creating another.
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  created BIGINT NOT NULL
);
CREATE INDEX idx_idempotency_created ON idempotency_keys (created);
