-- Rate-limit counters shared by all instances. UNLOGGED = not written to the crash log, much faster;
-- losing these counters in a database crash is harmless.
CREATE UNLOGGED TABLE rate_limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at BIGINT NOT NULL);
CREATE INDEX idx_rate_limits_reset ON rate_limits (reset_at);
