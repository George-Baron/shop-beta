-- Customer return requests after delivery: requested -> (approved) awaiting_settlement -> settled, or rejected / cancelled.
-- "settling" is the few seconds while a refund is being sent to the payment gateway (it stops two people settling the same return).
CREATE TABLE order_returns (
  id BIGSERIAL PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','awaiting_settlement','settling','settled','rejected','cancelled')),
  reason TEXT NOT NULL,
  item_condition TEXT NOT NULL,
  packaging TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',               -- [{item_id, name, qty, price}] what the customer wants to send back
  requested_amount INTEGER NOT NULL DEFAULT 0,    -- Naira, what the rules say these items are worth
  approved_amount INTEGER,                        -- Naira, what staff approved to refund
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name TEXT NOT NULL DEFAULT '',
  decided_at BIGINT,
  settle_method TEXT NOT NULL DEFAULT '',         -- original | wallet | manual
  settle_reference TEXT NOT NULL DEFAULT '',
  wallet_refunded BIGINT NOT NULL DEFAULT 0,      -- kobo returned to the customer's VELTO wallet
  gateway_refunded BIGINT NOT NULL DEFAULT 0,     -- kobo returned to the card/bank (or paid by hand)
  gateway_ref TEXT NOT NULL DEFAULT '',
  gateway_status TEXT NOT NULL DEFAULT '',
  restocked INTEGER NOT NULL DEFAULT 0,
  settled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  settled_by_name TEXT NOT NULL DEFAULT '',
  settled_at BIGINT,
  settling_at BIGINT,
  last_error TEXT NOT NULL DEFAULT '',
  created BIGINT NOT NULL,
  updated BIGINT NOT NULL
);
CREATE INDEX idx_order_returns_status ON order_returns(status, id DESC);
CREATE INDEX idx_order_returns_order ON order_returns(order_id);
CREATE UNIQUE INDEX idx_order_returns_one_open ON order_returns(order_id) WHERE status IN ('requested','awaiting_settlement','settling');  -- one open return per order
ALTER TABLE order_returns ENABLE ROW LEVEL SECURITY;
