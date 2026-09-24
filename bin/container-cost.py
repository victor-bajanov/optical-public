#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Cloudflare Containers cost model, reconciled against real invoices.

Two jobs:
  1. `cost_from_quantities()` — the price sheet as code. The tests prove it
     reproduces the Container lines of real invoices (analysis/fixtures/
     reconcile-*.json) to the cent from the invoice's own quantities.
  2. `reconcile()` — checks the GraphQL usage pull (analysis/container-usage.csv,
     from bin/container-usage.py) against an invoice's quantities, prorated to
     the days the pull actually covers (the API keeps only 4w4d of history).

Usage:
  bin/container-cost.py reconcile analysis/fixtures/reconcile-YYYY-MM.json
  bin/container-cost.py quote --memory-gib 12 --hours-per-day 10   # what-if monthly cost

Prices: https://developers.cloudflare.com/containers/pricing/ (fetched
2026-08-21) and cross-checked against invoice IN-00000000, which bills
memory per GiB-second with 90,000 GiB-s (25 GiB-h) included, vCPU per
vCPU-second with 22,500 (375 min) included, disk per GB-second with 720,000
(200 GB-h) included. Billing runs start -> sleep; no minimum duration.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

PRICES_USD = {
    "memory_per_gib_s": 0.0000025,
    "vcpu_per_s": 0.000020,
    "disk_per_gb_s": 0.00000007,
}
INCLUDED = {"memory_gib_s": 90_000, "vcpu_s": 22_500, "disk_gb_s": 720_000}


def cost_from_quantities(memory_gib_s: float, vcpu_s: float, disk_gb_s: float) -> dict:
    """Monthly USD for the three metered container dimensions, allowances applied."""
    memory = max(0.0, memory_gib_s - INCLUDED["memory_gib_s"]) * PRICES_USD["memory_per_gib_s"]
    vcpu = max(0.0, vcpu_s - INCLUDED["vcpu_s"]) * PRICES_USD["vcpu_per_s"]
    disk = max(0.0, disk_gb_s - INCLUDED["disk_gb_s"]) * PRICES_USD["disk_per_gb_s"]
    return {"memory": memory, "vcpu": vcpu, "disk": disk, "total": memory + vcpu + disk}


def uptime_seconds(memory_gib_s: float, memory_gib: float) -> float:
    """Memory is billed as allocation x uptime, so the memory line divided by
    the instance size recovers billed uptime seconds."""
    return memory_gib_s / memory_gib


def cpu_duty(quantities: dict, memory_gib: float = 12) -> float:
    """Fraction of one vCPU busy while the container is up. Invoices show
    vCPU-seconds are CPU time *used* (a small fraction of vCPUs x uptime),
    not allocation."""
    return quantities["vcpu_s"] / uptime_seconds(quantities["memory_gib_s"], memory_gib)


# Illustrative default; measure yours with cpu_duty() on an invoice's quantities.
DEFAULT_CPU_DUTY = 0.10


def quote(memory_gib: float, disk_gb: float, hours_per_day: float, days: int = 30,
          cpu_duty: float = DEFAULT_CPU_DUTY) -> dict:
    up = hours_per_day * 3600 * days
    c = cost_from_quantities(memory_gib * up, cpu_duty * up, disk_gb * up)
    return {"up_seconds": up, **c}


def period_quantities(rows: list[dict], start: str, end: str) -> dict:
    """Sum usage CSV rows (bin/container-usage.py columns) over an inclusive date range."""
    sel = [r for r in rows if start <= r["date"] <= end]
    return {
        "memory_gib_s": sum(float(r["memory_gib_h"]) for r in sel) * 3600,
        "vcpu_s": sum(float(r["vcpu_s"]) for r in sel),
        "disk_gb_s": sum(float(r["disk_gb_h"]) for r in sel) * 3600,
        "days": len(sel),
        "dates": sorted(r["date"] for r in sel),
    }


def _days_between(start: str, end: str) -> int:
    from datetime import date

    return (date.fromisoformat(end) - date.fromisoformat(start)).days + 1


def reconcile(fixture: dict, rows: list[dict], tolerance: float = 0.05) -> dict:
    """Compare observed (GraphQL) quantities with the invoice, prorated to the
    covered days. `missing_days` in the fixture are days the pull could never
    see; they reduce the expected share rather than counting as a miss."""
    p = fixture["period"]
    obs = period_quantities(rows, p["start"], p["end"])
    days_in_period = _days_between(p["start"], p["end"])
    missing = fixture.get("missing_days", [])
    known_missing = days_in_period if missing == "all" else len(missing)
    # Observable days = period minus days the pull could never reach. A day
    # with no usage row inside the observable range is a zero-usage day (the
    # container never started), not missing data.
    observable = days_in_period - known_missing
    share = observable / days_in_period if days_in_period else 0.0
    rep = {"days_in_period": days_in_period, "days_with_rows": obs["days"], "days_missing_known": known_missing,
           "days_observable": observable, "ok": True}
    for k in ("memory", "vcpu", "disk"):
        key = f"{k}_gib_s" if k == "memory" else ("vcpu_s" if k == "vcpu" else "disk_gb_s")
        invoice_q = fixture["quantities"][key]
        expected = invoice_q * share
        observed = obs[key]
        delta = (observed - expected) / expected if expected else (0.0 if observed == 0 else float("inf"))
        ok = abs(delta) <= tolerance
        rep[k] = {"invoice": invoice_q, "expected_prorated": expected, "observed": observed, "delta": delta, "ok": ok}
        rep["ok"] = rep["ok"] and ok
    return rep


def _load_rows(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("reconcile")
    r.add_argument("fixture", type=Path)
    r.add_argument("--usage", type=Path, default=Path("analysis/container-usage.csv"))
    r.add_argument("--tolerance", type=float, default=0.05)
    q = sub.add_parser("quote")
    q.add_argument("--memory-gib", type=float, required=True)
    q.add_argument("--disk-gb", type=float, default=4)
    q.add_argument("--hours-per-day", type=float, required=True)
    q.add_argument("--days", type=int, default=30)
    q.add_argument("--cpu-duty", type=float, default=DEFAULT_CPU_DUTY,
                   help="fraction of one vCPU busy while up (vCPU is billed on CPU time used)")
    args = ap.parse_args()

    if args.cmd == "quote":
        c = quote(args.memory_gib, args.disk_gb, args.hours_per_day, args.days, args.cpu_duty)
        print(json.dumps({k: round(v, 2) for k, v in c.items()}))
        return 0

    fx = json.loads(args.fixture.read_text())
    rep = reconcile(fx, _load_rows(args.usage), args.tolerance)
    inv_cost = cost_from_quantities(**fx["quantities"])
    print(f"{fx['invoice']} {fx['period']['start']}..{fx['period']['end']}: "
          f"{rep['days_observable']}/{rep['days_in_period']} days observable "
          f"({rep['days_missing_known']} before the API's retention horizon; {rep['days_with_rows']} had usage)")
    for k in ("memory", "vcpu", "disk"):
        d = rep[k]
        print(f"  {k:6s} invoice {d['invoice']:>10,.0f}  expected(prorated) {d['expected_prorated']:>10,.0f}  "
              f"observed {d['observed']:>10,.0f}  delta {d['delta']*100:+.1f}%  {'OK' if d['ok'] else 'MISMATCH'}")
    print(f"  price model on invoice quantities: ${inv_cost['total']:.2f} "
          f"(invoice says ${sum(fx['amounts_usd'].values()):.2f})")
    print("RECONCILED" if rep["ok"] else "NOT RECONCILED")
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
