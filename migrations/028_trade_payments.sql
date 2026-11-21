-- Global Trade phase 7: refunds and reconciliation on international payments.
ALTER TABLE international_payments ADD COLUMN IF NOT EXISTS provider_status TEXT NOT NULL DEFAULT '';   -- the provider's own status text (pending, processing, processed, failed...)
ALTER TABLE international_payments ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE international_payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE international_payments ADD COLUMN IF NOT EXISTS created_by BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_idem ON international_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_parent ON international_payments(parent_id);
