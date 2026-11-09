-- Lease-style locks so only one instance runs each background job at a time.
-- (Works through Supabase's transaction pooler, unlike session-level advisory locks.)
CREATE TABLE job_locks (name TEXT PRIMARY KEY, locked_until BIGINT NOT NULL DEFAULT 0);
