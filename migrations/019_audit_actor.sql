-- Who kind of person made the change: staff (back office), partner (partner store) or buyer (wholesale buyer).
ALTER TABLE audit_log ADD COLUMN actor TEXT NOT NULL DEFAULT 'staff';
CREATE INDEX idx_audit_actor ON audit_log(actor, id DESC);
