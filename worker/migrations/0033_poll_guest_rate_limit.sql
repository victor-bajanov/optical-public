-- 0033_poll_guest_rate_limit.sql — per-IP, time-windowed rate limiting for
-- POST /poll/:id/join.
--
-- Additive only (0032 is applied in dev and test now, so editing it in place
-- would not reach either — see the wave-3 addition notes). `ip_hash` and
-- `created_at` give poll_invitees the same shape `bookings` already has for
-- countRecentByIp-style windowed counting; MAX_GUESTS_PER_POLL stays as the
-- separate poll-scoped circuit breaker (defence in depth, not replaced by
-- this). Both columns are nullable: organiser-added invitees (kind='invited')
-- are never joined from a browser, so they carry NULL here — only the
-- guest-join path populates them.
ALTER TABLE poll_invitees ADD COLUMN ip_hash TEXT;
ALTER TABLE poll_invitees ADD COLUMN created_at TEXT;
CREATE INDEX idx_poll_invitees_ip_window ON poll_invitees(poll_id, ip_hash, created_at);
