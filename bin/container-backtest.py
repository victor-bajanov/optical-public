#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Backtest container (memory, sleepAfter) configurations against recorded
solver demand (internal design notes, card 1.5).

Replays the arrivals in analysis/solver-calls.csv through a one-instance
container model: an arrival inside [up_start, last_finish + sleep_after] is
warm; otherwise it's cold, pays `boot_s`, and opens a new billed interval.
Billed seconds = sum of intervals (boot included, start -> sleep). Per config
it reports monthly cost (via bin/container-cost.py), cold %, and api-trigger
latency percentiles.

Calibration gate: the CURRENT config (12288 MiB, 30 s) simulated over the
snapshot window must land within 10 % of the memory GiB-s the billing
dataset measured for the same full days; otherwise the sleep/boot model is
wrong and the grid is not to be trusted.

Usage:
  bin/container-backtest.py [--calls analysis/solver-calls.csv] [--usage analysis/container-usage.csv]
                            [--boot-s auto] [--out analysis/backtest.csv]
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import statistics as st
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 3072 = the smallest custom type Cloudflare allows at 1 vCPU (min 3 GiB/vCPU,
# min 1 vCPU for custom types) — the card-2.2 candidate; 1024 is only reachable
# via the predefined 1/4-vCPU "basic" tier.
MEMORY_MIB = [256, 512, 1024, 2048, 3072, 4096, 12288]
SLEEP_AFTER_S = [0, 30, 120, 300, 600, 1800, 3600]
CURRENT = {"memory_mib": 12288, "sleep_after_s": 30}
COLD_UPTIME_MS = 1000   # solver_uptime_ms below this = the request paid the boot
DISK_GB = 4


def _cost_module():
    spec = importlib.util.spec_from_file_location("container_cost", Path(__file__).parent / "container-cost.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------------ model ---

def simulate(calls: list[dict], sleep_after_s: float, boot_s: float) -> dict:
    """calls: [{t (s), trigger, service_s}] sorted by t. Single instance,
    serial service (arrivals during boot/service queue behind it)."""
    out, intervals = [], []
    up_start = None      # billed interval start
    busy_until = 0.0     # when the instance is next free
    sleep_at = None      # when the instance would go to sleep if nothing arrives
    for c in sorted(calls, key=lambda c: c["t"]):
        t = c["t"]
        if sleep_at is not None and t <= sleep_at:
            cold = False
            start = max(t, busy_until)
            finish = start + c["service_s"]
        else:
            if up_start is not None:
                intervals.append(sleep_at - up_start)
            cold = True
            up_start = t
            start = t + boot_s
            finish = start + c["service_s"]
        busy_until = finish
        sleep_at = finish + sleep_after_s
        out.append({**c, "cold": cold, "latency_s": finish - t})
    if up_start is not None:
        intervals.append(sleep_at - up_start)
    # Billing covers every env (the container is shared); cold % and latency
    # are reported for prod only — that's the user-facing number.
    prod = [c for c in out if c.get("env", "prod") == "prod"]
    api = [c["latency_s"] for c in prod if c["trigger"] == "api"]
    return {"calls": out, "n": len(prod), "cold": sum(c["cold"] for c in prod),
            "n_all": len(out), "cold_all": sum(c["cold"] for c in out),
            "billed_s": sum(intervals), "intervals": len(intervals), "api_latency_s": api}


def _pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


# ------------------------------------------------------------------- data ---

def _ts(s: str) -> float:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def prepare_calls(rows: list[dict]) -> tuple[list[dict], float]:
    """Turn solver-calls.csv rows into arrivals with a warm service time each,
    and derive boot_s = median(cold round trip) - median(warm round trip)."""
    rows = [r for r in rows if r.get("round_trip_ms") and r.get("solver_uptime_ms")]
    t0 = min(_ts(r["at"]) for r in rows)
    warm = [int(r["round_trip_ms"]) / 1000 for r in rows if int(r["solver_uptime_ms"]) >= COLD_UPTIME_MS]
    cold = [int(r["round_trip_ms"]) / 1000 for r in rows if int(r["solver_uptime_ms"]) < COLD_UPTIME_MS]
    warm_med = st.median(warm) if warm else 0.3
    boot_s = (st.median(cold) - warm_med) if cold else 3.5
    calls = []
    for r in sorted(rows, key=lambda r: r["at"]):
        is_cold = int(r["solver_uptime_ms"]) < COLD_UPTIME_MS
        calls.append({"t": _ts(r["at"]) - t0, "at": r["at"], "trigger": r["trigger"], "env": r.get("env", "prod"),
                      "service_s": warm_med if is_cold else int(r["round_trip_ms"]) / 1000})
    return calls, boot_s


def calibrate(calls: list[dict], usage_rows: list[dict], window: tuple[str, str], memory_gib: float,
              sleep_after_s: float, boot_s: float, tolerance: float = 0.10) -> dict:
    """Simulated memory GiB-s for the current config vs measured GiB-s over the
    same full UTC days. `window` is inclusive (YYYY-MM-DD, YYYY-MM-DD)."""
    r = simulate(calls, sleep_after_s, boot_s)
    simulated = r["billed_s"] * memory_gib
    measured = sum(float(u["memory_gib_h"]) for u in usage_rows if window[0] <= u["date"] <= window[1]) * 3600
    delta = (simulated - measured) / measured if measured else float("inf")
    return {"window": window, "simulated_gib_s": simulated, "measured_gib_s": measured, "delta": delta,
            "ok": abs(delta) <= tolerance, "cold": r["cold"], "n": r["n"], "cold_all": r["cold_all"], "n_all": r["n_all"]}


def run_grid(calls: list[dict], boot_s: float, span_days: float, cost) -> list[dict]:
    rows = []
    for mem in MEMORY_MIB:
        for sl in SLEEP_AFTER_S:
            r = simulate(calls, sl, boot_s)
            scale = 30 / span_days
            up = r["billed_s"] * scale
            c = cost.cost_from_quantities(mem / 1024 * up, cost.DEFAULT_CPU_DUTY * up, DISK_GB * up)
            rows.append({"memory_mib": mem, "sleep_after_s": sl, "up_h_per_month": up / 3600,
                         "usd_per_month": c["total"], "cold_pct": 100 * r["cold"] / max(1, r["n"]),
                         "api_p50_s": _pct(r["api_latency_s"], 0.5), "api_p95_s": _pct(r["api_latency_s"], 0.95),
                         "prod_p50_s": _pct([c_["latency_s"] for c_ in r["calls"] if c_.get("env", "prod") == "prod"], 0.5)})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calls", type=Path, default=Path("analysis/solver-calls.csv"))
    ap.add_argument("--usage", type=Path, default=Path("analysis/container-usage.csv"))
    ap.add_argument("--boot-s", default="auto")
    ap.add_argument("--out", type=Path, default=Path("analysis/backtest.csv"))
    args = ap.parse_args()
    cost = _cost_module()

    with args.calls.open() as f:
        call_rows = list(csv.DictReader(f))
    with args.usage.open() as f:
        usage_rows = list(csv.DictReader(f))
    calls, boot_auto = prepare_calls(call_rows)
    boot_s = boot_auto if args.boot_s == "auto" else float(args.boot_s)
    first, last = calls[0]["at"], calls[-1]["at"]
    span_days = (calls[-1]["t"] - calls[0]["t"]) / 86400
    by_env = {}
    for c in calls:
        by_env[c["env"]] = by_env.get(c["env"], 0) + 1
    print(f"{len(calls)} calls {first}..{last} ({span_days:.1f} d) by env {by_env}; boot_s={boot_s:.2f}")

    # Calibrate on full UTC days strictly inside the snapshot window.
    d0 = (datetime.strptime(first, "%Y-%m-%dT%H:%M:%SZ") + timedelta(days=1)).strftime("%Y-%m-%d")
    d1 = (datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ") - timedelta(days=1)).strftime("%Y-%m-%d")
    sub = [c for c in calls if d0 <= c["at"][:10] <= d1]
    cal = calibrate(sub, usage_rows, (d0, d1), CURRENT["memory_mib"] / 1024, CURRENT["sleep_after_s"], boot_s)
    print(f"calibration {d0}..{d1} @ {CURRENT}: simulated {cal['simulated_gib_s']:,.0f} GiB-s vs measured "
          f"{cal['measured_gib_s']:,.0f} GiB-s ({cal['delta']*100:+.1f}%) — {'OK' if cal['ok'] else 'OUT OF TOLERANCE'}; "
          f"simulated cold {cal['cold']}/{cal['n']} (prod), {cal['cold_all']}/{cal['n_all']} (all)")

    rows = run_grid(calls, boot_s, span_days, cost)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\n{'mem MiB':>8} {'sleep s':>8} {'up h/mo':>8} {'$/mo':>7} {'cold %':>7} {'api p50':>8} {'api p95':>8}   (cold %/latency: prod calls only)")
    for r in rows:
        print(f"{r['memory_mib']:>8} {r['sleep_after_s']:>8} {r['up_h_per_month']:>8.1f} {r['usd_per_month']:>7.2f} "
              f"{r['cold_pct']:>7.1f} {r['api_p50_s'] or 0:>8.2f} {r['api_p95_s'] or 0:>8.2f}")
    return 0 if cal["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
