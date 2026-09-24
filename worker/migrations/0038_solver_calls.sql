-- 0038_solver_calls.sql — one row per solver call (container-retirement card 1.1).
--
-- Workers Logs expire after 7 days; the cost model / backtest
-- (bin/container-backtest.py, runbook §G) need a durable, per-call demand
-- dataset. runResolve inserts a row after every solve it gets an HTTP answer
-- for — success AND 422 (status 'UNSAT') — never on transport failure. Insert
-- failures are logged, not thrown: observability must not fail a resolve.
-- `source='logs'` is reserved for rows backfilled from Workers Logs
-- (bin/solver-usage-backfill.py); live inserts use the default.
CREATE TABLE solver_calls (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  owner TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('api', 'webhook', 'cron')),
  window_start TEXT,
  attempts INTEGER,
  http_status INTEGER,
  round_trip_ms INTEGER,
  solver_uptime_ms INTEGER,
  pass1_ms REAL,
  pass2_ms REAL,
  status TEXT,
  n_tasks INTEGER,
  n_chunks INTEGER,
  n_external INTEGER,
  n_dropped INTEGER,
  source TEXT NOT NULL DEFAULT 'live'
);

-- The snapshot/backtest scripts read time ranges; the table only grows.
CREATE INDEX solver_calls_at ON solver_calls(at);
