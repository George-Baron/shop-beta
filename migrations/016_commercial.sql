-- Commercial operations: a relationship officer for each partner store. Additive only.
ALTER TABLE vendors ADD COLUMN officer_id BIGINT REFERENCES users(id) ON DELETE SET NULL, ADD COLUMN officer_at BIGINT;
CREATE INDEX idx_vendors_officer ON vendors(officer_id) WHERE officer_id IS NOT NULL;
