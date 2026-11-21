-- Reports emailed on a schedule to staff. Recipients are staff accounts (never outside addresses); each send re-checks they may still see the report.
CREATE TABLE report_schedules (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('commercial','warehouse')),
  report TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  recipient_ids TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  last_slot TEXT,
  last_sent BIGINT,
  last_note TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created BIGINT NOT NULL
);
ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
