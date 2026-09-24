-- 0030_booking_page.sql — per-user public booking page.
--
-- config_booking_page mirrors config_business_hours / config_meeting_policy
-- (own row -> '__default__' -> hardcoded floor), except that `slug` is a real
-- column: every page load resolves owner by slug. SQLite permits multiple NULLs
-- in a UNIQUE index, so the '__default__' defaults row (slug NULL) coexists
-- with real pages.
CREATE TABLE config_booking_page (
  owner_subject TEXT PRIMARY KEY,
  slug          TEXT,
  body          TEXT NOT NULL
);
CREATE UNIQUE INDEX config_booking_page_slug ON config_booking_page(slug);

INSERT INTO config_booking_page (owner_subject, slug, body) VALUES ('__default__', NULL,
  '{"enabled":false,"durations_minutes":[30,60],"hours":null,' ||
  '"buffer_minutes":{"before":0,"after":10},"min_notice_minutes":240,' ||
  '"horizon_days":21,"bookable_over_movable_meetings":false,' ||
  '"location":{"mode":"meet","detail":null},' ||
  '"event_title":"Meeting with {booker_name}"}');

-- One row per claimed slot. `status` drives the atomic claim: a 'reserving' or
-- 'confirmed' row blocks overlapping claims, a 'failed' row does not. Times are
-- UTC ISO 8601. ip_hash is hashToken(ip, hashingKey(env)) — never a raw IP.
CREATE TABLE bookings (
  id               TEXT PRIMARY KEY,
  owner_subject    TEXT NOT NULL,
  slug             TEXT NOT NULL,
  start_utc        TEXT NOT NULL,
  end_utc          TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  booker_name      TEXT NOT NULL,
  booker_email     TEXT NOT NULL,
  booker_note      TEXT,
  ip_hash          TEXT NOT NULL,
  status           TEXT NOT NULL,
  google_event_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX bookings_owner_window ON bookings(owner_subject, start_utc);
CREATE INDEX bookings_event        ON bookings(google_event_id);
CREATE INDEX bookings_ip           ON bookings(ip_hash, created_at);
