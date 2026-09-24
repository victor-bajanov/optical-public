#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/solver-capture-pull.py's pure logic: the D1-row -> R2-key and
D1-row -> output-path mappings (including timestamp sanitisation), the
manifest row shape and its idempotent-by-(env,id) merge, the date-range SQL
filter, the wrangler command shapes (dev needs --env, prod must not have it,
only the capturing envs are --env choices), and the envelope env-vs-source assertion
(including "unknown" as a hard error, not a silent skip).

Pure functions only — no live wrangler/network calls.

Run: uv run bin/test_solver_capture_pull.py
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "solver_capture_pull", Path(__file__).parent / "solver-capture-pull.py"
)
assert _spec and _spec.loader, "could not load solver-capture-pull module"
cap = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cap
_spec.loader.exec_module(cap)


# =============================================================================
# r2_key — D1 row id -> R2 object key
# =============================================================================


def test_r2_key_is_flat_problems_prefix():
    assert cap.r2_key("abc-123") == "problems/abc-123.json"


# =============================================================================
# output_path — D1 row -> local corpus path (env-partitioned, timestamp-safe)
# =============================================================================


def test_output_path_sanitises_colons_in_the_timestamp():
    p = cap.output_path(Path("analysis/corpus"), "dev", "abc-123", "2026-08-20T10:15:00Z")
    assert p == Path("analysis/corpus/dev/2026-08-20T10-15-00Z-abc-123.json")


def test_output_path_partitions_by_env():
    p = cap.output_path(Path("analysis/corpus"), "prod", "id1", "2026-08-20T00:00:00Z")
    assert p.parent.name == "prod"


# =============================================================================
# manifest_row_from — D1 row -> the committed manifest column shape
# =============================================================================


D1_ROW = {
    "id": "abc-123",
    "at": "2026-08-20T10:00:00Z",
    "owner": "victor@example.com",
    "trigger": "api",
    "window_start": "2026-08-24",
    "attempts": 1,
    "http_status": 200,
    "round_trip_ms": 314,
    "solver_uptime_ms": 900,
    "pass1_ms": 10.5,
    "pass2_ms": 2.1,
    "status": "OPTIMAL",
    "n_tasks": 12,
    "n_chunks": 4,
    "n_external": 2,
    "n_dropped": 0,
    "source": "live",
}


def test_manifest_row_from_picks_the_documented_columns_only():
    row = cap.manifest_row_from(D1_ROW, "dev")
    assert row == {
        "id": "abc-123",
        "at": "2026-08-20T10:00:00Z",
        "env": "dev",
        "trigger": "api",
        "status": "OPTIMAL",
        "n_tasks": 12,
        "n_chunks": 4,
        "round_trip_ms": 314,
    }


def test_manifest_columns_are_stable_and_ordered():
    assert cap.MANIFEST_COLUMNS == [
        "id", "at", "env", "trigger", "status", "n_tasks", "n_chunks", "round_trip_ms",
    ]


# =============================================================================
# merge_manifest — idempotent by (env, id)
# =============================================================================


def test_merge_manifest_writes_new_rows(tmp_path):
    path = tmp_path / "manifest.csv"
    row = cap.manifest_row_from(D1_ROW, "dev")
    new, total = cap.merge_manifest(path, [row])
    assert (new, total) == (1, 1)
    assert path.exists()


def test_merge_manifest_rerun_is_idempotent(tmp_path):
    path = tmp_path / "manifest.csv"
    row = cap.manifest_row_from(D1_ROW, "dev")
    cap.merge_manifest(path, [row])
    new, total = cap.merge_manifest(path, [row])
    assert (new, total) == (0, 1)


def test_merge_manifest_keys_by_env_and_id_not_id_alone(tmp_path):
    # Same id captured under two different envs must not collide/overwrite.
    path = tmp_path / "manifest.csv"
    dev_row = cap.manifest_row_from(D1_ROW, "dev")
    prod_row = cap.manifest_row_from(D1_ROW, "prod")
    cap.merge_manifest(path, [dev_row])
    new, total = cap.merge_manifest(path, [prod_row])
    assert (new, total) == (1, 2)


def test_merge_manifest_updates_row_content_on_rerun(tmp_path):
    path = tmp_path / "manifest.csv"
    row = cap.manifest_row_from(D1_ROW, "dev")
    cap.merge_manifest(path, [row])
    changed = dict(row, status="UNSAT")
    cap.merge_manifest(path, [changed])
    with path.open() as f:
        import csv
        rows = list(csv.DictReader(f))
    assert len(rows) == 1
    assert rows[0]["status"] == "UNSAT"


# =============================================================================
# d1_query_cmd — wrangler d1 execute invocation + date-range SQL filter
# =============================================================================


def test_d1_query_cmd_dev_includes_env_flag():
    cmd = cap.d1_query_cmd("dev", None, None)
    assert cmd[:5] == ["npx", "wrangler", "d1", "execute", "DB"]
    assert "--env" in cmd
    assert cmd[cmd.index("--env") + 1] == "dev"
    assert "--remote" in cmd and "--json" in cmd


def test_d1_query_cmd_prod_has_no_env_flag():
    cmd = cap.d1_query_cmd("prod", None, None)
    assert "--env" not in cmd


def test_d1_query_cmd_with_no_range_still_filters_to_source_live():
    # WHERE is now always present (source = 'live'), even with no date range.
    cmd = cap.d1_query_cmd("dev", None, None)
    sql = cmd[-1]
    assert "WHERE" in sql
    assert "source = 'live'" in sql
    assert "at >=" not in sql and "at <" not in sql


def test_d1_query_cmd_excludes_backfilled_rows():
    # bin/solver-usage-backfill.py writes source='logs' rows (ids like
    # "requestId#n") that never had a capture put — pulling them would cost a
    # wrangler spawn per row for a guaranteed miss.
    cmd = cap.d1_query_cmd("dev", None, None)
    assert "source = 'live'" in cmd[-1]


def test_d1_query_cmd_applies_since_on_at():
    cmd = cap.d1_query_cmd("dev", "2026-08-01", None)
    sql = cmd[-1]
    assert "at >= '2026-08-01'" in sql


def test_d1_query_cmd_until_is_exclusive_bound_on_the_following_day():
    # MAJOR bug this guards: SQLite/string-compares `at <= '2026-08-20'`
    # against a full timestamp like '2026-08-20T10:15:03Z' is FALSE (the
    # longer string that shares the date prefix sorts greater), so a naive
    # `<=` against the bare date silently drops the entire end day. The fix
    # compares `at < '<until + 1 day>'` instead.
    cmd = cap.d1_query_cmd("dev", None, "2026-08-20")
    sql = cmd[-1]
    assert "at < '2026-08-21'" in sql
    assert "at <= '2026-08-20'" not in sql


def test_d1_query_cmd_until_bound_includes_every_timestamp_on_the_end_day():
    # Faithful confirmation, not just a substring check: simulate SQLite's
    # lexicographic TEXT comparison (the actual semantics `at <op> 'bound'`
    # gets evaluated with) against a late timestamp on the --until day.
    cmd = cap.d1_query_cmd("dev", None, "2026-08-20")
    sql = cmd[-1]
    op, bound = re.search(r"at (<=?) '([^']+)'", sql).groups()
    at = "2026-08-20T10:15:03.456Z"
    included = (at <= bound) if op == "<=" else (at < bound)
    assert included, f"row at {at!r} was wrongly excluded by `at {op} {bound!r}`"


def test_d1_query_cmd_applies_since_and_until_together():
    cmd = cap.d1_query_cmd("dev", "2026-08-01", "2026-08-20")
    sql = cmd[-1]
    assert "at >= '2026-08-01'" in sql
    assert "at < '2026-08-21'" in sql


# =============================================================================
# r2_get_cmd — wrangler r2 object get invocation
# =============================================================================


def test_r2_get_cmd_shape():
    cmd = cap.r2_get_cmd("abc-123", Path("/tmp/x.json"))
    assert cmd[:5] == ["npx", "wrangler", "r2", "object", "get"]
    assert "optical-solver-capture/problems/abc-123.json" in cmd
    assert "--file" in cmd
    assert cmd[cmd.index("--file") + 1] == "/tmp/x.json"
    assert "--remote" in cmd


# =============================================================================
# assert_envelope_env — the config-drift alarm
# =============================================================================


def test_assert_envelope_env_passes_when_matching():
    cap.assert_envelope_env("id1", "dev", "dev")  # must not raise


def test_assert_envelope_env_raises_on_mismatch():
    with pytest.raises(cap.EnvMismatchError, match="id1"):
        cap.assert_envelope_env("id1", "dev", "prod")


def test_assert_envelope_env_raises_on_unknown():
    with pytest.raises(cap.EnvMismatchError, match="unknown"):
        cap.assert_envelope_env("id1", "dev", "unknown")


# =============================================================================
# CLI surface — only the envs that capture
# =============================================================================


def test_only_capturing_envs_are_allowed_choices():
    ap = cap.build_arg_parser()
    for env in ("dev", "prod"):
        assert ap.parse_args(["--env", env]).env == env
    with pytest.raises(SystemExit):
        ap.parse_args(["--env", "staging"])




def test_env_is_required():
    ap = cap.build_arg_parser()
    with pytest.raises(SystemExit):
        ap.parse_args([])


def test_default_output_root_is_repo_root_anchored():
    # Not CWD-relative: run from worker/ (as the wrangler subprocess calls
    # do) and a relative "analysis/corpus" default would write title-carrying
    # payloads to worker/analysis/corpus — outside the gitignored path.
    ap = cap.build_arg_parser()
    args = ap.parse_args(["--env", "dev"])
    assert args.out == cap.REPO_ROOT / "analysis" / "corpus"


# =============================================================================
# --since/--until validation — free-form input gets interpolated into the D1
# --command string, so it's guarded at parse time (repo convention).
# =============================================================================


def test_since_rejects_non_iso_input():
    ap = cap.build_arg_parser()
    with pytest.raises(SystemExit):
        ap.parse_args(["--env", "dev", "--since", "not-a-date"])


def test_until_rejects_non_iso_input():
    ap = cap.build_arg_parser()
    with pytest.raises(SystemExit):
        ap.parse_args(["--env", "dev", "--until", "2026/08/20"])


def test_since_rejects_sql_injection_attempt():
    ap = cap.build_arg_parser()
    with pytest.raises(SystemExit):
        ap.parse_args(["--env", "dev", "--since", "2026-08-01'; DROP TABLE solver_calls; --"])


def test_since_until_accept_iso_date():
    ap = cap.build_arg_parser()
    args = ap.parse_args(["--env", "dev", "--since", "2026-08-01", "--until", "2026-08-20"])
    assert args.since == "2026-08-01"
    assert args.until == "2026-08-20"


def test_since_until_accept_iso_datetime():
    ap = cap.build_arg_parser()
    args = ap.parse_args(["--env", "dev", "--since", "2026-08-01T10:15:03Z"])
    assert args.since == "2026-08-01T10:15:03Z"


def test_since_until_accept_iso_datetime_with_fractional_seconds():
    ap = cap.build_arg_parser()
    args = ap.parse_args(["--env", "dev", "--until", "2026-08-20T23:59:59.999Z"])
    assert args.until == "2026-08-20T23:59:59.999Z"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
