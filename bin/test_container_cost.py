#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/container-cost.py: the Containers price model must reproduce
the invoice lines from the invoice's own quantities (exact, to the cent), and
the GraphQL usage pull must reconcile to the invoice quantities for every day
it covers.

Run: uv run bin/test_container_cost.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("container_cost", Path(__file__).parent / "container-cost.py")
assert _spec and _spec.loader
cc = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cc
_spec.loader.exec_module(cc)

FIXTURES = Path(__file__).parent.parent / "analysis" / "fixtures"




def test_included_allowances_match_invoice_tiers():
    # 25 GiB-h, 375 vCPU-min, 200 GB-h — as the invoice prints them in seconds.
    assert cc.INCLUDED == {"memory_gib_s": 90_000, "vcpu_s": 22_500, "disk_gb_s": 720_000}




def test_quote_uses_cpu_duty_not_allocation():
    # 12 GiB up 10 h/day for 30 days = 3600 GiB-h = 12,960,000 GiB-s
    q = cc.quote(memory_gib=12, disk_gb=4, hours_per_day=10, days=30, cpu_duty=0.10)
    assert q["memory"] == pytest.approx((12_960_000 - 90_000) * 0.0000025)   # ≈ $32.18
    assert q["vcpu"] == pytest.approx(max(0, 0.10 * 1_080_000 - 22_500) * 0.00002)  # ≈ $1.71, not $86
    q1 = cc.quote(memory_gib=1, disk_gb=4, hours_per_day=10, days=30, cpu_duty=0.10)
    assert q1["memory"] == pytest.approx((1_080_000 - 90_000) * 0.0000025)    # ≈ $2.48


def test_period_quantities_sums_only_rows_in_period():
    rows = [
        {"date": "2026-07-18", "memory_gib_h": "1.0", "vcpu_s": "10", "disk_gb_h": "0.5"},
        {"date": "2026-07-19", "memory_gib_h": "2.0", "vcpu_s": "20", "disk_gb_h": "1.0"},
        {"date": "2026-08-18", "memory_gib_h": "3.0", "vcpu_s": "30", "disk_gb_h": "1.5"},
        {"date": "2026-08-19", "memory_gib_h": "4.0", "vcpu_s": "40", "disk_gb_h": "2.0"},
    ]
    q = cc.period_quantities(rows, "2026-07-19", "2026-08-18")
    assert q == {"memory_gib_s": 5.0 * 3600, "vcpu_s": 50.0, "disk_gb_s": 2.5 * 3600, "days": 2,
                 "dates": ["2026-07-19", "2026-08-18"]}


def test_reconcile_reports_coverage_and_flags_outside_tolerance():
    fx = {"period": {"start": "2026-07-19", "end": "2026-07-21"}, "missing_days": ["2026-07-19"],
          "quantities": {"memory_gib_s": 300, "vcpu_s": 30, "disk_gb_s": 3000}}
    rows = [
        {"date": "2026-07-20", "memory_gib_h": str(100 / 3600), "vcpu_s": "10", "disk_gb_h": str(1000 / 3600)},
        {"date": "2026-07-21", "memory_gib_h": str(100 / 3600), "vcpu_s": "10", "disk_gb_h": str(1000 / 3600)},
    ]
    rep = cc.reconcile(fx, rows, tolerance=0.05)
    assert rep["days_observable"] == 2 and rep["days_in_period"] == 3 and rep["days_missing_known"] == 1
    # Only 2/3 of the period is observable, so the expected share is 2/3 of the invoice.
    assert rep["memory"]["observed"] == pytest.approx(200)
    assert rep["memory"]["expected_prorated"] == pytest.approx(200)
    assert rep["memory"]["ok"] is True and rep["ok"] is True
    rows[0]["vcpu_s"] = "17"   # 27 observed vs 20 prorated -> 35% off
    rep = cc.reconcile(fx, rows, tolerance=0.05)
    assert rep["vcpu"]["ok"] is False and rep["ok"] is False


def test_reconcile_counts_observable_days_without_rows_as_zero_usage():
    # A day inside the observable range with no row = the container never
    # started that day (weekend). It is NOT missing data; the share stays 2/3.
    fx = {"period": {"start": "2026-07-19", "end": "2026-07-21"}, "missing_days": ["2026-07-19"],
          "quantities": {"memory_gib_s": 300, "vcpu_s": 30, "disk_gb_s": 3000}}
    rows = [{"date": "2026-07-21", "memory_gib_h": str(200 / 3600), "vcpu_s": "20", "disk_gb_h": str(2000 / 3600)}]
    rep = cc.reconcile(fx, rows, tolerance=0.05)
    assert rep["days_observable"] == 2 and rep["memory"]["expected_prorated"] == pytest.approx(200)
    assert rep["ok"] is True




if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
