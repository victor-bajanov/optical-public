#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Pull the solver container's billed usage into analysis/container-usage.csv.

Source: GraphQL `containersUsageAdaptiveGroups` — the dataset the Cloudflare
dashboard uses for billing estimates — summed per day per instance
(allocatedMemory / allocatedDisk in byte-seconds, cpuTimeSec), joined with
`containersMetricsAdaptiveGroups` max containerUptime per day. This is the
ground truth the cost model (card 1.4) reconciles against the invoice and the
backtest (card 1.5) calibrates against.

Usage (read-only; needs Account Analytics: Read on the token):
  op run --env-file=.env -- bin/container-usage.py [--days 31] [--out analysis/container-usage.csv]
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ACCOUNT_ID = "REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID"
GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
COLUMNS = ["date", "instance_id", "memory_gib_h", "vcpu_s", "disk_gb_h", "max_uptime_ms", "samples"]
GIB = 2**30
# The analytics API rejects a single query spanning more than 4w4d, and also
# refuses data older than 4w4d — so history beyond ~32 days exists only in
# the CSV this script accumulates. Pull at least every 4 weeks.
MAX_WINDOW_DAYS = 28
MAX_HISTORY_DAYS = 31
QUERY = """
query($acct: String!, $start: Date!, $end: Date!) {
  viewer { accounts(filter: {accountTag: $acct}) {
    usage: containersUsageAdaptiveGroups(limit: 1000, filter: {date_geq: $start, date_leq: $end}, orderBy: [date_ASC]) {
      dimensions { date instanceId applicationId }
      sum { allocatedMemory cpuTimeSec allocatedDisk }
    }
    metrics: containersMetricsAdaptiveGroups(limit: 1000, filter: {date_geq: $start, date_leq: $end}) {
      dimensions { date instanceId }
      max { containerUptime }
      count
    }
  } }
}
"""


def rows_from_response(resp: dict) -> list[dict]:
    if resp.get("errors"):
        raise RuntimeError("; ".join(e.get("message", "?") for e in resp["errors"]))
    acct = resp["data"]["viewer"]["accounts"][0]
    metrics = {(m["dimensions"]["date"], m["dimensions"]["instanceId"]): m for m in acct.get("metrics", [])}
    rows = []
    for u in acct["usage"]:
        d, inst = u["dimensions"]["date"], u["dimensions"]["instanceId"]
        m = metrics.get((d, inst))
        rows.append({
            "date": d,
            "instance_id": inst,
            "memory_gib_h": u["sum"]["allocatedMemory"] / GIB / 3600,
            "vcpu_s": u["sum"]["cpuTimeSec"],
            "disk_gb_h": u["sum"]["allocatedDisk"] / 1e9 / 3600,
            "max_uptime_ms": m["max"]["containerUptime"] if m else None,
            "samples": m["count"] if m else None,
        })
    rows.sort(key=lambda r: (r["date"], r["instance_id"]))
    return rows


def date_windows(start, end) -> list[tuple]:
    """Inclusive [start, end] split into contiguous windows of <= MAX_WINDOW_DAYS."""
    out, a = [], start
    while a <= end:
        b = min(a + timedelta(days=MAX_WINDOW_DAYS), end)
        out.append((a, b))
        a = b + timedelta(days=1)
    return out


def fetch_rows(days: int) -> list[dict]:
    import httpx

    to = datetime.now(timezone.utc).date()
    rows: list[dict] = []
    for a, b in date_windows(to - timedelta(days=days), to):
        variables = {"acct": ACCOUNT_ID, "start": str(a), "end": str(b)}
        r = httpx.post(GRAPHQL, headers={"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"},
                       json={"query": QUERY, "variables": variables}, timeout=60)
        r.raise_for_status()
        rows.extend(rows_from_response(r.json()))
    return rows


def merge_csv(path: Path, rows: list[dict]) -> int:
    existing: dict[tuple[str, str], dict] = {}
    if path.exists():
        with path.open() as f:
            for r in csv.DictReader(f):
                existing[(r["date"], r["instance_id"])] = r
    for r in rows:
        existing[(r["date"], r["instance_id"])] = {k: ("" if r[k] is None else r[k]) for k in COLUMNS}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in sorted(existing.values(), key=lambda r: (r["date"], r["instance_id"])):
            w.writerow(r)
    return len(existing)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=31)
    ap.add_argument("--out", type=Path, default=Path("analysis/container-usage.csv"))
    args = ap.parse_args()
    if args.days > MAX_HISTORY_DAYS:
        print(f"clamping --days {args.days} to {MAX_HISTORY_DAYS}: the API keeps only 4w4d of history", file=sys.stderr)
        args.days = MAX_HISTORY_DAYS
    rows = fetch_rows(args.days)
    total = merge_csv(args.out, rows)
    mem = sum(r["memory_gib_h"] for r in rows)
    print(f"{len(rows)} day-rows pulled ({total} in {args.out}); memory {mem:.1f} GiB-h over {args.days} d")
    return 0


if __name__ == "__main__":
    sys.exit(main())
