-- Owner approval gate: requested -> recommended (reviewed by the Operations Manager, waiting for the owner) -> awaiting_settlement (owner approved) -> settled.
ALTER TABLE order_returns DROP CONSTRAINT IF EXISTS order_returns_status_check;
ALTER TABLE order_returns ADD CONSTRAINT order_returns_status_check CHECK (status IN ('requested','recommended','awaiting_settlement','settling','settled','rejected','cancelled'));
DROP INDEX IF EXISTS idx_order_returns_one_open;
CREATE UNIQUE INDEX idx_order_returns_one_open ON order_returns(order_id) WHERE status IN ('requested','recommended','awaiting_settlement','settling');

ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS recommended_amount INTEGER;      -- Naira the reviewer suggests
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS recommended_note TEXT NOT NULL DEFAULT '';
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS recommended_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS recommended_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS recommended_at BIGINT;
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS approval TEXT NOT NULL DEFAULT '';   -- '' | owner | auto (small-amount rule)
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS auto_settle TEXT NOT NULL DEFAULT ''; -- '' | done | failed | manual_needed
