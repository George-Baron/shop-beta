-- Global Trade phase 5: carrier integrations (live rates, booking, labels, tracking webhooks).
-- Credentials are never stored here: providers name the environment variables that hold them (shipping_providers.credential_env).
ALTER TABLE shipping_bookings ADD COLUMN IF NOT EXISTS carrier TEXT NOT NULL DEFAULT '';
ALTER TABLE shipping_bookings ADD COLUMN IF NOT EXISTS service_name TEXT NOT NULL DEFAULT '';
ALTER TABLE shipping_bookings ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT '';
ALTER TABLE shipping_bookings ADD COLUMN IF NOT EXISTS quote_id BIGINT REFERENCES shipping_rate_quotes(id) ON DELETE SET NULL;
-- one live booking per export order: a second click or a retry can never book twice
CREATE UNIQUE INDEX IF NOT EXISTS uq_sbk_export_live ON shipping_bookings(export_order_id) WHERE export_order_id IS NOT NULL AND status IN ('requested','booked','cancel_requested');
CREATE INDEX IF NOT EXISTS idx_sbk_tracking ON shipping_bookings(tracking_number) WHERE tracking_number <> '';
ALTER TABLE shipping_services ADD COLUMN IF NOT EXISTS carrier TEXT NOT NULL DEFAULT '';
-- webhook deliveries are recorded once (table from migration 023, keyed by provider + event id) so a repeated delivery is ignored
