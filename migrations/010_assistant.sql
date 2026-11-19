-- Support assistant: only a daily counter (a spending cap). Conversations are not stored.
CREATE TABLE assistant_usage (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY;
