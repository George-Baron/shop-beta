-- Safe checkout: one order per checkout attempt (idempotency), stored payment link, and pay-on-delivery phone confirmation.
ALTER TABLE orders
  ADD COLUMN idem_key TEXT,
  ADD COLUMN idem_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN pay_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN confirmed_at BIGINT,
  ADD COLUMN confirmed_by TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_orders_idem ON orders(idem_key) WHERE idem_key IS NOT NULL;
-- pay-on-delivery orders still waiting for the confirmation call (for the auto-cancel sweep)
CREATE INDEX idx_orders_pod_unconfirmed ON orders(created) WHERE payment_method = 'pod' AND status = 'pending';
-- Orders that already exist were placed before the confirmation step: treat pay-on-delivery ones as confirmed so nothing is cancelled by surprise.
UPDATE orders SET confirmed_at = created, confirmed_by = 'before the confirmation step' WHERE payment_method = 'pod' AND status <> 'cancelled';
