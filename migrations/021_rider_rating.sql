-- Customers can rate the delivery of their own order once it is delivered.
ALTER TABLE rider_feedback ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','customer'));
ALTER TABLE rider_feedback ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';
-- one customer rating per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_rider_feedback_customer ON rider_feedback(order_id) WHERE source='customer' AND order_id IS NOT NULL;
