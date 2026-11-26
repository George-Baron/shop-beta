-- AI Operations Manager: remember which model answered and how many tokens it used, so real spend can be shown and capped.
ALTER TABLE ops_chat_messages ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT '';
ALTER TABLE ops_chat_messages ADD COLUMN IF NOT EXISTS tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ops_chat_messages ADD COLUMN IF NOT EXISTS tokens_cached INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ops_chat_messages ADD COLUMN IF NOT EXISTS tokens_out INTEGER NOT NULL DEFAULT 0;
