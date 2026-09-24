-- 0016_audit_log.sql — minimal append-only audit trail (Plan 4 brief G).
-- source ∈ {cron, webhook, api, admin}. Lean by design: only cron resolves,
-- offboarding, and denied cross-user attempts are instrumented.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  subject TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  table_name TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_log_subject ON audit_log(subject);
CREATE INDEX audit_log_created_at ON audit_log(created_at);
