-- Points expiry: when the customer was last warned that points are about to expire. Expiry itself stays off until 'loyalty_expiry_months' is set above 0.
ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS expiry_reminded BIGINT NOT NULL DEFAULT 0;
INSERT INTO settings (key, value) VALUES ('loyalty_expiry_months', '0') ON CONFLICT (key) DO NOTHING;
