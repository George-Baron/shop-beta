-- Points used at checkout, and each customer's payment preferences. Safe to run again.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0 CHECK (points_used >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_discount INTEGER NOT NULL DEFAULT 0 CHECK (points_discount >= 0);   -- Naira taken off by points (already inside orders.discount)

CREATE TABLE IF NOT EXISTS payment_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_method TEXT NOT NULL DEFAULT '' CHECK (default_method IN ('','wallet','paystack','card','pod')),
  preselect_wallet INTEGER NOT NULL DEFAULT 0, preselect_points INTEGER NOT NULL DEFAULT 0,   -- only pre-ticks the choice; the customer still sees the final amounts and confirms
  promo_notifications INTEGER NOT NULL DEFAULT 1,
  updated BIGINT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('loyalty_max_discount_pct','30') ON CONFLICT (key) DO NOTHING;
