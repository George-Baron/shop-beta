-- Wallet at checkout: how much of an order was paid from the VELTO wallet (kobo). The rest (charge_amount) goes to the gateway.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet_amount BIGINT NOT NULL DEFAULT 0 CHECK (wallet_amount >= 0);
