#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/container-usage.py: the GraphQL response -> CSV row shaping
and the unit conversions (byte-seconds -> GiB-hours / GB-hours) the cost
model downstream depends on.

Run: uv run bin/test_container_usage.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "container_usage", Path(__file__).parent / "container-usage.py"
)
assert _spec and _spec.loader
cu = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cu
_spec.loader.exec_module(cu)

GIB = 2**30
RESPONSE = {
    "data": {"viewer": {"accounts": [{
        "usage": [
            {"dimensions": {"date": "2026-08-20", "instanceId": "abc" * 20, "applicationId": "app1"},
             "sum": {"allocatedMemory": 12 * GIB * 3600, "cpuTimeSec": 150.9, "allocatedDisk": 4e9 * 3600}},
            {"dimensions": {"date": "2026-08-21", "instanceId": "abc" * 20, "applicationId": "app1"},
             "sum": {"allocatedMemory": 12 * GIB * 1800, "cpuTimeSec": 57.1, "allocatedDisk": 4e9 * 1800}},
        ],
        "metrics": [
            {"dimensions": {"date": "2026-08-20", "instanceId": "abc" * 20}, "max": {"containerUptime": 65413}, "count": 112},
        ],
    }]}},
    "errors": None,
}


def test_rows_from_response_converts_units_and_joins_metrics():
    rows = cu.rows_from_response(RESPONSE)
    assert [r["date"] for r in rows] == ["2026-08-20", "2026-08-21"]
    r = rows[0]
    assert r["instance_id"] == "abc" * 20
    assert r["memory_gib_h"] == pytest.approx(12.0)
    assert r["vcpu_s"] == pytest.approx(150.9)
    assert r["disk_gb_h"] == pytest.approx(4.0)
    assert r["max_uptime_ms"] == 65413
    assert r["samples"] == 112
    assert rows[1]["max_uptime_ms"] is None and rows[1]["samples"] is None


def test_rows_from_response_raises_on_graphql_errors():
    with pytest.raises(RuntimeError, match="unknown field"):
        cu.rows_from_response({"data": None, "errors": [{"message": 'unknown field "x"'}]})


def test_date_windows_stay_under_the_api_range_cap():
    from datetime import date, timedelta
    wins = cu.date_windows(date(2026, 6, 19), date(2026, 8, 21))
    assert wins[0][0] == date(2026, 6, 19) and wins[-1][1] == date(2026, 8, 21)
    assert all((b - a) <= timedelta(days=cu.MAX_WINDOW_DAYS) for a, b in wins)
    assert all(wins[i][1] + timedelta(days=1) == wins[i + 1][0] for i in range(len(wins) - 1))  # inclusive, contiguous
    assert cu.MAX_WINDOW_DAYS <= 30  # API rejects > 4w4d


def test_csv_columns_are_stable():
    assert cu.COLUMNS == ["date", "instance_id", "memory_gib_h", "vcpu_s", "disk_gb_h", "max_uptime_ms", "samples"]


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
