-- 0017_per_user_config.sql — re-key config tables by owner_subject (Plan 6 brief A/E).
--
-- SQLite cannot change a primary key in place, so each table is rebuilt
-- (RENAME -> CREATE -> copy -> DROP), mirroring 0014_calendar_sync_per_user.sql.
-- The existing single GLOBAL row of each table is carried over verbatim into the
-- sentinel owner '__default__'. Loaders resolve "this owner's row else __default__"
-- (see src/planning/resolve-internal.ts, src/db/business-hours.ts). Per-user rows
-- are created lazily by admin/per-user edits; users without a row fall back here.
-- Downtime acceptable (brief E).

-- config_weights: was (id INTEGER PK, body). New PK = owner_subject.
ALTER TABLE config_weights RENAME TO config_weights_legacy;
CREATE TABLE config_weights (
  owner_subject TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
INSERT INTO config_weights (owner_subject, body)
  SELECT '__default__', body FROM config_weights_legacy WHERE id = 1;
DROP TABLE config_weights_legacy;

-- config_contexts: was (context TEXT PK, body). New PK = (owner_subject, context).
ALTER TABLE config_contexts RENAME TO config_contexts_legacy;
CREATE TABLE config_contexts (
  owner_subject TEXT NOT NULL,
  context TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (owner_subject, context)
);
INSERT INTO config_contexts (owner_subject, context, body)
  SELECT '__default__', context, body FROM config_contexts_legacy;
DROP TABLE config_contexts_legacy;

-- config_business_hours: was (id INTEGER PK, body). New PK = owner_subject.
ALTER TABLE config_business_hours RENAME TO config_business_hours_legacy;
CREATE TABLE config_business_hours (
  owner_subject TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
INSERT INTO config_business_hours (owner_subject, body)
  SELECT '__default__', body FROM config_business_hours_legacy WHERE id = 1;
DROP TABLE config_business_hours_legacy;
