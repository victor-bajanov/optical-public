-- 0029_calendar_feed_multi.sql — multi-endpoint busy feeds. One
-- calendar_feed_tokens row = one endpoint; 0020 reserved `label` and
-- `reveal_rules` for exactly this.
-- Backfill v1 rows, enforce label uniqueness among ACTIVE rows, and add the
-- single-use secret-reveal table. reveal_rules is a JSON array of regex
-- source strings, full-matched (^(?:p)$, case-sensitive) against event
-- titles; matching titles are revealed in that endpoint's feed.
UPDATE calendar_feed_tokens SET label = 'default' WHERE label IS NULL;
UPDATE calendar_feed_tokens SET reveal_rules = '[]' WHERE reveal_rules IS NULL;

CREATE UNIQUE INDEX calendar_feed_tokens_owner_label
  ON calendar_feed_tokens(owner_subject, label) WHERE revoked_at IS NULL;

-- Pending secret reveals. secret_ciphertext is the FULL feed URL encrypted
-- with AES-GCM (purpose "feed-reveal", key from encryptionKey(env)); it is
-- nulled on consume or replaced on regenerate. reveal_token_hash is
-- hashToken(token, hashingKey(env)). TTL 1 hour, enforced at read time.
CREATE TABLE calendar_feed_reveals (
  id                TEXT PRIMARY KEY,
  feed_id           TEXT NOT NULL,
  owner_subject     TEXT NOT NULL,
  reveal_token_hash TEXT NOT NULL,
  secret_ciphertext BLOB,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  consumed_at       TEXT
);
CREATE UNIQUE INDEX calendar_feed_reveals_hash ON calendar_feed_reveals(reveal_token_hash);
CREATE INDEX calendar_feed_reveals_feed  ON calendar_feed_reveals(feed_id);
CREATE INDEX calendar_feed_reveals_owner ON calendar_feed_reveals(owner_subject);
