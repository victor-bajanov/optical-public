-- 0020_calendar_feed_tokens.sql — per-user busy .ics feed tokens.
--
-- Keyed on `id` (a token id) with owner_subject as a COLUMN so "many tokens per
-- user" is just many rows — the future multi-token / per-token unmask feature
-- needs no reshape. token_hash is hashToken(secret, hashingKey(env)); the
-- plaintext secret is shown to the user once and never stored. reveal_rules is
-- reserved (NULL => mask everything to "Busy", the v1 behaviour). Soft-revoke
-- via revoked_at lets a future "roll token X" target one id; v1 revokes all of
-- a user's active tokens on regenerate.
CREATE TABLE calendar_feed_tokens (
  id            TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  label         TEXT,
  reveal_rules  TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE UNIQUE INDEX calendar_feed_tokens_hash  ON calendar_feed_tokens(token_hash);
CREATE INDEX        calendar_feed_tokens_owner ON calendar_feed_tokens(owner_subject, revoked_at);
