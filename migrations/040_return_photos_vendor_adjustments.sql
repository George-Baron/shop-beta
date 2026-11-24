-- Photos the customer attaches to a return request (the files live in the private "return-photos" bucket), and money adjustments to a partner's earnings when a return is settled.
CREATE TABLE order_return_photos (
  id BIGSERIAL PRIMARY KEY,
  return_id BIGINT NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  stored TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created BIGINT NOT NULL
);
CREATE INDEX idx_order_return_photos_return ON order_return_photos(return_id);
ALTER TABLE order_return_photos ENABLE ROW LEVEL SECURITY;

-- amount is in naira and NEGATIVE when it takes money off the partner's balance. One row per partner per settled return.
CREATE TABLE vendor_adjustments (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  return_id BIGINT REFERENCES order_returns(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'return',
  note TEXT NOT NULL DEFAULT '',
  created BIGINT NOT NULL
);
CREATE UNIQUE INDEX idx_vendor_adjustments_return ON vendor_adjustments(return_id, vendor_id) WHERE return_id IS NOT NULL;
CREATE INDEX idx_vendor_adjustments_vendor ON vendor_adjustments(vendor_id, id DESC);
ALTER TABLE vendor_adjustments ENABLE ROW LEVEL SECURITY;

ALTER TABLE order_returns ADD COLUMN charge_vendor SMALLINT NOT NULL DEFAULT 1;
