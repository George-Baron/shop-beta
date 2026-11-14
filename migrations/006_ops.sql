-- Step 8: a record of every backup attempt (shown in Admin so a silent failure is noticed).
CREATE TABLE backup_log (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  bytes BIGINT NOT NULL DEFAULT 0,
  tables INTEGER NOT NULL DEFAULT 0,
  rows_total BIGINT NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  encrypted INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'schedule',
  created BIGINT NOT NULL
);
ALTER TABLE backup_log ENABLE ROW LEVEL SECURITY;
