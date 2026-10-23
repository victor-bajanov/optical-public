-- 0044_outbound_mail_counts.sql — hosted-trial O9.8 per-subject outbound mail cap.
--
-- One row per (subject, UTC day): how many third-party recipients mail from
-- the subject's own mailbox (Gmail / Graph notification providers) has been
-- addressed to that day. mail/outbound-cap.ts reserves against
-- OUTBOUND_MAIL_DAILY_CAP with a single conditional upsert before each send,
-- and prunes the subject's older days as it goes, so the table holds at most
-- about one row per mailing subject. Self-addressed mail is never counted.
-- Owner-scoped: offboard deletes a leaver's rows (lifecycle/owner-scoped-tables.ts).
CREATE TABLE outbound_mail_counts (
  subject TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, utc_day)
);
