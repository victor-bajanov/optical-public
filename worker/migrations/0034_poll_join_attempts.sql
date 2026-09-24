-- 0034_poll_join_attempts.sql — per-IP join-ATTEMPT log for POST
-- /poll/:id/join's rate limit.
--
-- Fixes R1-F1/R4-H2: 0033's per-IP limit counted poll_invitees rows carrying
-- ip_hash, but the already-invited and dropped-invitee arms never insert a
-- new poll_invitees row, so those attempts were invisible to the counter —
-- an attacker could hammer any known invitee address from one IP with zero
-- throttling (re-issuing + emailing their link unboundedly, and rotating
-- their token out from under them each time).
--
-- A dedicated table decouples "how many attempts has this IP made on this
-- poll" from "does an invitee row exist": every attempt is recorded here
-- regardless of outcome (new guest / already-invited / dropped / at-cap),
-- BEFORE route.ts branches on which case it is. poll_invitees.ip_hash/
-- created_at (0033) still record which IP created a given GUEST row — a
-- different question, left as-is; only the rate-limit COUNT moves here.
CREATE TABLE poll_join_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id TEXT NOT NULL REFERENCES polls(id),
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_poll_join_attempts_window ON poll_join_attempts(poll_id, ip_hash, created_at);
