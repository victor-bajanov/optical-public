-- 0025_meeting_policy.sql — per-user owned-meeting attendee-enforcement default.
-- Mirrors config_business_hours: PK owner_subject, '__default__' is the instance
-- default. Loaders resolve own-row-else-default (src/db/meeting-policy.ts).
CREATE TABLE config_meeting_policy (
  owner_subject TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
INSERT INTO config_meeting_policy (owner_subject, body)
  VALUES ('__default__', '{"attendee_enforcement":"not_declined"}');
