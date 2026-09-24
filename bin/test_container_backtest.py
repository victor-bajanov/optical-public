#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/container-backtest.py: replaying recorded solver arrivals
through a (sleepAfter, boot) container model must produce the right warm/cold
verdicts and billed seconds, and the calibration against measured usage must
be computed the way the plan says (card 1.5).

Run: uv run bin/test_container_backtest.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("container_backtest", Path(__file__).parent / "container-backtest.py")
assert _spec and _spec.loader
bt = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bt
_spec.loader.exec_module(bt)


def call(t: float, trigger: str = "webhook", service_s: float = 0.3, env: str = "prod") -> dict:
    return {"t": t, "trigger": trigger, "service_s": service_s, "env": env}


def test_simulate_warm_cold_and_billed_seconds():
    # boot 3 s, service 0.3 s, sleepAfter 30 s.
    calls = [call(0), call(10), call(100), call(103.2), call(200, trigger="api")]
    r = bt.simulate(calls, sleep_after_s=30, boot_s=3.0)
    assert [c["cold"] for c in r["calls"]] == [True, False, True, False, True]
    # interval 1: up from 0, last activity finishes at 10.3 -> sleeps at 40.3  => 40.3 s
    # interval 2: up from 100, boot+service ends 103.3; warm call at 103.2 queues, ends 103.6 -> sleeps 133.6 => 33.6 s
    # interval 3: up from 200, ends 203.3 -> sleeps 233.3 => 33.3 s
    assert r["billed_s"] == pytest.approx(40.3 + 33.6 + 33.3)
    assert r["cold"] == 3 and r["n"] == 5
    # api latency = service (+ boot when cold)
    assert r["api_latency_s"] == [pytest.approx(3.3)]


def test_simulate_arrival_during_boot_is_warm_and_queues_behind_it():
    calls = [call(0), call(1.0)]   # second arrives while the first is still booting
    r = bt.simulate(calls, sleep_after_s=30, boot_s=3.0)
    assert [c["cold"] for c in r["calls"]] == [True, False]
    # second call can't start before the first finishes at 3.3 -> ends 3.6; its latency is 2.6
    assert r["calls"][1]["latency_s"] == pytest.approx(2.6)
    assert r["billed_s"] == pytest.approx(33.6)


def test_sleep_after_zero_bills_only_busy_time():
    r = bt.simulate([call(0), call(100)], sleep_after_s=0, boot_s=3.0)
    assert r["cold"] == 2 and r["billed_s"] == pytest.approx(2 * 3.3)


def test_prepare_calls_derives_service_and_boot_from_the_snapshot():
    rows = [
        {"at": "2026-08-20T00:00:00Z", "trigger": "webhook", "round_trip_ms": "3700", "solver_uptime_ms": "400"},
        {"at": "2026-08-20T00:00:10Z", "trigger": "webhook", "round_trip_ms": "300", "solver_uptime_ms": "5000"},
        {"at": "2026-08-20T00:00:20Z", "trigger": "api", "round_trip_ms": "280", "solver_uptime_ms": "9000"},
    ]
    calls, boot_s = bt.prepare_calls(rows)
    assert [c["t"] for c in calls] == [0.0, 10.0, 20.0]
    # warm service = that call's own round trip; cold calls get the warm median
    assert [c["service_s"] for c in calls] == [pytest.approx(0.29), pytest.approx(0.3), pytest.approx(0.28)]
    assert boot_s == pytest.approx(3.7 - 0.29)


def test_calibrate_compares_simulated_to_measured_memory_on_full_days():
    # Window covers 2 full days; usage rows give measured GiB-h for them.
    calls = [call(3600), call(90000)]                 # day 1 and day 2
    usage = [{"date": "2026-08-14", "memory_gib_h": str(12 * 33.3 / 3600)},
             {"date": "2026-08-15", "memory_gib_h": str(12 * 33.3 / 3600)},
             {"date": "2026-08-16", "memory_gib_h": "99"}]   # outside the window, ignored
    rep = bt.calibrate(calls, usage, window=("2026-08-14", "2026-08-15"), memory_gib=12,
                       sleep_after_s=30, boot_s=3.0)
    assert rep["simulated_gib_s"] == pytest.approx(2 * 33.3 * 12)
    assert rep["measured_gib_s"] == pytest.approx(2 * 33.3 * 12)
    assert rep["delta"] == pytest.approx(0.0, abs=1e-9) and rep["ok"] is True


def test_simulate_reports_cold_and_latency_for_prod_only_but_bills_every_env():
    # A dev smoke run keeps the shared container warm; the prod call that follows is warm
    # and the billed interval covers both, but cold % / latency are prod-facing numbers.
    calls = [call(0, env="dev"), call(10, trigger="api", env="prod")]
    r = bt.simulate(calls, sleep_after_s=30, boot_s=3.0)
    assert r["billed_s"] == pytest.approx(40.3)          # dev: 0 -> 3.3; prod: 10 -> 10.3; sleeps at 40.3
    assert r["n"] == 1 and r["cold"] == 0                # prod-only counts
    assert r["api_latency_s"] == [pytest.approx(0.3)]
    assert r["n_all"] == 2 and r["cold_all"] == 1


def test_grid_contains_the_plan_configs():
    assert {256, 512, 1024, 2048, 3072, 4096, 12288} <= set(bt.MEMORY_MIB)
    assert {30, 120, 300, 600, 1800, 3600} <= set(bt.SLEEP_AFTER_S)


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
