-- Browser push (Web Push) subscriptions, one row per device. The endpoint and keys belong to the person's browser; they are only used to send them their own notifications.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  fails INTEGER NOT NULL DEFAULT 0,
  created BIGINT NOT NULL,
  last_ok BIGINT
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
