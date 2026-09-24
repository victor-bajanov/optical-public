#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/solver-usage-backfill.py's pure logic: chunking the 7-day
window into query slices the telemetry endpoint actually honours, pairing a
`solver_fetch` line with its `solver_diagnostics` line by requestId, mapping
the Worker event shape to a trigger, and the CSV row shape.

Run: uv run bin/test_solver_usage_backfill.py
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "solver_usage_backfill", Path(__file__).parent / "solver-usage-backfill.py"
)
assert _spec and _spec.loader
bf = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bf
_spec.loader.exec_module(bf)

T0 = datetime(2026, 8, 20, 0, 0, tzinfo=timezone.utc)


def ev(msg: str, *, ts: datetime, rid: str, origin: str = "fetch",
       entrypoint: str | None = None, trigger: str | None = None) -> dict:
    workers = {"eventType": origin, "requestId": rid}
    if entrypoint:
        workers["entrypoint"] = entrypoint
    meta = {"requestId": rid, "origin": origin, "message": msg}
    if trigger:
        meta["trigger"] = trigger
    return {"timestamp": int(ts.timestamp() * 1000), "$workers": workers, "$metadata": meta}


def test_window_chunks_cover_range_in_sub_day_slices():
    chunks = bf.window_chunks(T0, T0 + timedelta(days=2), step=timedelta(hours=6))
    assert chunks[0][0] == T0
    assert chunks[-1][1] == T0 + timedelta(days=2)
    assert all(b - a <= timedelta(hours=6) for a, b in chunks)
    # contiguous, non-overlapping
    assert all(chunks[i][1] == chunks[i + 1][0] for i in range(len(chunks) - 1))


def test_classify_trigger():
    assert bf.classify_trigger(ev("x", ts=T0, rid="r", origin="fetch", trigger="POST /v1/resolve")) == "api"
    assert bf.classify_trigger(ev("x", ts=T0, rid="r", origin="alarm", entrypoint="ResolveCoordinator")) == "webhook"
    assert bf.classify_trigger(ev("x", ts=T0, rid="r", origin="rpc", entrypoint="ResolveCoordinator")) == "webhook"
    assert bf.classify_trigger(ev("x", ts=T0, rid="r", origin="scheduled")) == "cron"
    assert bf.classify_trigger(ev("x", ts=T0, rid="r", origin="fetch", trigger="POST /v1/polls")) == "other"


def test_pair_events_joins_fetch_and_diagnostics_by_request_id():
    events = [
        ev('solver_fetch {"attempt":1,"ms":3286,"status":200,"solver_uptime_ms":432}',
           ts=T0, rid="A", origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_diagnostics {"pass1_wall_seconds":0.0114,"pass2_wall_seconds":0.003,"status":"OPTIMAL","round_trip_ms":3286}',
           ts=T0 + timedelta(seconds=3), rid="A", origin="alarm", entrypoint="ResolveCoordinator"),
        # a retried solve: two fetch lines, one diagnostics
        ev('solver_fetch {"attempt":1,"ms":45000,"error":"AbortError"}', ts=T0 + timedelta(minutes=5), rid="B",
           origin="fetch", trigger="POST /v1/resolve"),
        ev('solver_fetch {"attempt":2,"ms":300,"status":200,"solver_uptime_ms":5000}', ts=T0 + timedelta(minutes=5, seconds=45),
           rid="B", origin="fetch", trigger="POST /v1/resolve"),
        ev('solver_diagnostics {"pass1_wall_seconds":0.01,"pass2_wall_seconds":0.01,"status":"OPTIMAL","round_trip_ms":45300}',
           ts=T0 + timedelta(minutes=5, seconds=46), rid="B", origin="fetch", trigger="POST /v1/resolve"),
        # a 422: fetch only, no diagnostics line
        ev('solver_fetch {"attempt":1,"ms":280,"status":422,"solver_uptime_ms":9000}', ts=T0 + timedelta(minutes=9),
           rid="C", origin="scheduled"),
    ]
    rows = bf.pair_events(events)
    by = {r["request_id"]: r for r in rows}
    assert set(by) == {"A", "B", "C"}
    assert {r["call_id"] for r in rows} == {"A#1", "B#1", "C#1"}

    a = by["A"]
    assert a["at"] == "2026-08-20T00:00:00Z"           # timestamp of the FIRST fetch attempt
    assert a["trigger"] == "webhook"
    assert a["attempts"] == 1
    assert a["http_status"] == 200
    assert a["round_trip_ms"] == 3286
    assert a["solver_uptime_ms"] == 432                  # from the LAST attempt (the one that answered)
    assert a["pass1_ms"] == 11.4 and a["pass2_ms"] == 3.0
    assert a["status"] == "OPTIMAL"

    b = by["B"]
    assert b["attempts"] == 2 and b["http_status"] == 200 and b["solver_uptime_ms"] == 5000
    assert b["round_trip_ms"] == 45300 and b["trigger"] == "api"

    c = by["C"]
    assert c["attempts"] == 1 and c["http_status"] == 422 and c["status"] == "UNSAT"
    assert c["pass1_ms"] is None and c["round_trip_ms"] == 280 and c["trigger"] == "cron"


def test_pair_events_splits_multiple_solves_under_one_request_id():
    # A webhook alarm iterates several weeks: N fetch/diagnostics pairs share one requestId.
    events = [
        ev('solver_fetch {"attempt":1,"ms":3300,"status":200,"solver_uptime_ms":400}', ts=T0, rid="R",
           origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_diagnostics {"pass1_wall_seconds":0.01,"pass2_wall_seconds":0.01,"status":"OPTIMAL","round_trip_ms":3300}',
           ts=T0 + timedelta(seconds=3), rid="R", origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_fetch {"attempt":1,"ms":280,"status":200,"solver_uptime_ms":3700}', ts=T0 + timedelta(seconds=4), rid="R",
           origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_diagnostics {"pass1_wall_seconds":0.01,"pass2_wall_seconds":0.01,"status":"OPTIMAL","round_trip_ms":280}',
           ts=T0 + timedelta(seconds=5), rid="R", origin="alarm", entrypoint="ResolveCoordinator"),
        # third solve in the same request 422s (no diagnostics line), then a fourth succeeds
        ev('solver_fetch {"attempt":1,"ms":250,"status":422,"solver_uptime_ms":4000}', ts=T0 + timedelta(seconds=6), rid="R",
           origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_fetch {"attempt":1,"ms":260,"status":200,"solver_uptime_ms":4300}', ts=T0 + timedelta(seconds=7), rid="R",
           origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_diagnostics {"pass1_wall_seconds":0.01,"pass2_wall_seconds":0.01,"status":"OPTIMAL","round_trip_ms":260}',
           ts=T0 + timedelta(seconds=8), rid="R", origin="alarm", entrypoint="ResolveCoordinator"),
    ]
    rows = bf.pair_events(events)
    assert [r["call_id"] for r in rows] == ["R#1", "R#2", "R#3", "R#4"]
    assert [r["solver_uptime_ms"] for r in rows] == [400, 3700, 4000, 4300]
    assert [r["status"] for r in rows] == ["OPTIMAL", "OPTIMAL", "UNSAT", "OPTIMAL"]
    assert all(r["attempts"] == 1 for r in rows)


def test_pair_events_orders_fetch_before_diagnostics_at_equal_timestamps():
    # Observed in prod: both lines carry the same ms timestamp; the diagnostics
    # line listed first must still close the fetch's call, not open nothing.
    events = [
        ev('solver_diagnostics {"pass1_wall_seconds":0.01,"pass2_wall_seconds":0.01,"status":"OPTIMAL","round_trip_ms":3575}',
           ts=T0, rid="R", origin="alarm", entrypoint="ResolveCoordinator"),
        ev('solver_fetch {"attempt":1,"ms":3575,"status":200,"solver_uptime_ms":417}', ts=T0, rid="R",
           origin="alarm", entrypoint="ResolveCoordinator"),
    ]
    rows = bf.pair_events(events)
    assert len(rows) == 1 and rows[0]["status"] == "OPTIMAL" and rows[0]["pass1_ms"] == 10.0


def test_pair_events_dedupes_identical_events_across_overlapping_pulls():
    e = ev('solver_fetch {"attempt":1,"ms":300,"status":200,"solver_uptime_ms":5000}', ts=T0, rid="A")
    e["$metadata"]["id"] = "01X"
    rows = bf.pair_events([e, dict(e)])
    assert len(rows) == 1 and rows[0]["attempts"] == 1


def test_csv_columns_are_stable():
    assert bf.COLUMNS == [
        "at", "env", "call_id", "request_id", "trigger", "attempts", "http_status", "round_trip_ms",
        "solver_uptime_ms", "pass1_ms", "pass2_ms", "status", "source",
    ]


def test_env_is_derived_from_the_worker_service_name():
    assert bf.env_for_service("weekly-scheduling-assistant") == "prod"
    assert bf.env_for_service("weekly-scheduling-assistant-dev") == "dev"


def test_services_are_every_worker_that_calls_the_solver():
    expected = ["weekly-scheduling-assistant", "weekly-scheduling-assistant-dev"]
    assert bf.SERVICES == expected


def test_pair_events_stamps_env():
    e = ev('solver_fetch {"attempt":1,"ms":300,"status":200,"solver_uptime_ms":5000}', ts=T0, rid="A")
    rows = bf.pair_events([e], env="dev")
    assert rows[0]["env"] == "dev"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
