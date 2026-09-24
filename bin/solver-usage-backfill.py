#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Snapshot every solver call from Workers Logs into analysis/solver-calls.csv.

Pairs each `solver_fetch` log line (one per attempt) with its
`solver_diagnostics` line (one per successful solve) by Worker requestId, and
derives the trigger from the event shape (HTTP /v1/resolve -> api,
ResolveCoordinator alarm/rpc -> webhook, scheduled -> cron).

Workers Logs keep 7 days, so run this at least weekly. The `solver_calls` D1
table (migration 0038, card 1.1) now records every call live, but per env's
own D1; this script stays the all-env snapshot until the cost scripts read
D1 directly (internal design notes). Rows are merged
into the existing CSV by call_id (requestId#n), so re-runs are idempotent.

Caveat: the telemetry endpoint's `events` view silently returns only a
fraction of a multi-day window (observed: 9 of 102 over 7 d, 13 of 13 over
1 d), so the window is pulled in 6-hour slices. The script prints the
`calculations`-view count for the whole window next to the rows it got, and
exits non-zero if they disagree.

Usage (read-only; needs Workers Observability: Read on the token):
  op run --env-file=.env -- bin/solver-usage-backfill.py [--days 7] [--out analysis/solver-calls.csv]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ACCOUNT_ID = "REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID"
# Every worker that calls the (single, shared) solver container. Their traffic
# all lands on the same instance and the same bill, so the backtest needs all
# of them, not just prod.
SERVICES = ["weekly-scheduling-assistant", "weekly-scheduling-assistant-dev"]
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/observability/telemetry/query"
COLUMNS = [
    "at", "env", "call_id", "request_id", "trigger", "attempts", "http_status", "round_trip_ms",
    "solver_uptime_ms", "pass1_ms", "pass2_ms", "status", "source",
]


def env_for_service(service: str) -> str:
    suffix = service.removeprefix("weekly-scheduling-assistant")
    return suffix.lstrip("-") or "prod"


def filters_for(service: str) -> list[dict]:
    return [
        {"key": "$metadata.service", "operation": "eq", "type": "string", "value": service},
        {"key": "$metadata.message", "operation": "includes", "type": "string", "value": "solver_"},
    ]


def window_chunks(frm: datetime, to: datetime, step: timedelta) -> list[tuple[datetime, datetime]]:
    out, a = [], frm
    while a < to:
        b = min(a + step, to)
        out.append((a, b))
        a = b
    return out


def classify_trigger(event: dict) -> str:
    meta, w = event.get("$metadata", {}), event.get("$workers", {})
    origin = meta.get("origin") or w.get("eventType")
    if origin == "scheduled":
        return "cron"
    if w.get("entrypoint") == "ResolveCoordinator":
        return "webhook"
    if origin == "fetch" and (meta.get("trigger") or "").endswith("/v1/resolve"):
        return "api"
    return "other"


def _iso(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _payload(msg: str) -> tuple[str, dict]:
    kind, _, rest = msg.partition(" ")
    return kind, json.loads(rest)


def pair_events(events: list[dict], env: str = "prod") -> list[dict]:
    """Group log lines by requestId and fold each group into one solver-call row."""
    seen: set[str] = set()
    groups: dict[str, list[dict]] = {}
    # Fetch and diagnostics lines for one solve can share a millisecond, so
    # break timestamp ties by kind: the fetch line must come first.
    def order(e: dict) -> tuple[int, int]:
        return (e["timestamp"], 0 if e["$metadata"]["message"].startswith("solver_fetch ") else 1)

    for e in sorted(events, key=order):
        key = e.get("$metadata", {}).get("id") or f"{e['timestamp']}|{e['$metadata']['message']}"
        if key in seen:
            continue
        seen.add(key)
        rid = e["$metadata"].get("requestId") or e["$workers"].get("requestId")
        groups.setdefault(rid, []).append(e)

    rows = []
    for rid, evs in groups.items():
        # One requestId can carry several solves (a webhook alarm iterates
        # weeks), so split the group into calls: a fetch with attempt==1 opens
        # a call; a diagnostics line closes it; a later attempt==1 fetch also
        # closes the previous call (the 422 case has no diagnostics line).
        calls: list[tuple[list[tuple[dict, dict]], dict | None]] = []
        for e in evs:
            kind, payload = _payload(e["$metadata"]["message"])
            if kind == "solver_fetch":
                if payload.get("attempt") == 1 or not calls or calls[-1][1] is not None:
                    calls.append(([], None))
                calls[-1][0].append((e, payload))
            elif kind == "solver_diagnostics" and calls and calls[-1][1] is None:
                calls[-1] = (calls[-1][0], payload)
        for n, (fetches, diag) in enumerate(calls, start=1):
            if not fetches:
                continue
            first_e, _ = fetches[0]
            _, last = fetches[-1]
            http_status = last.get("status")
            rows.append({
                "at": _iso(first_e["timestamp"]),
                "env": env,
                "call_id": f"{rid}#{n}",
                "request_id": rid,
                "trigger": classify_trigger(first_e),
                "attempts": len(fetches),
                "http_status": http_status,
                "round_trip_ms": diag["round_trip_ms"] if diag else last.get("ms"),
                "solver_uptime_ms": last.get("solver_uptime_ms"),
                "pass1_ms": round(diag["pass1_wall_seconds"] * 1000, 3) if diag else None,
                "pass2_ms": round(diag["pass2_wall_seconds"] * 1000, 3) if diag else None,
                "status": diag["status"] if diag else ("UNSAT" if http_status == 422 else None),
                "source": "logs",
            })
    rows.sort(key=lambda r: r["at"])
    return rows


# ---------------------------------------------------------------- network ---

def _post(body: dict) -> dict:
    import httpx

    tok = os.environ["CLOUDFLARE_API_TOKEN"]
    r = httpx.post(API, headers={"Authorization": f"Bearer {tok}"}, json=body, timeout=120)
    r.raise_for_status()
    return r.json()["result"]


def _timeframe(a: datetime, b: datetime) -> dict:
    return {"from": int(a.timestamp() * 1000), "to": int(b.timestamp() * 1000)}


def fetch_events(service: str, frm: datetime, to: datetime) -> list[dict]:
    out: list[dict] = []
    for a, b in window_chunks(frm, to, timedelta(hours=6)):
        res = _post({"view": "events", "queryId": "solver-usage", "limit": 2000, "dry": False,
                     "parameters": {"datasets": ["cloudflare-workers"], "filters": filters_for(service)},
                     "timeframe": _timeframe(a, b)})["events"]
        out.extend(res["events"])
    return out


def expected_count(service: str, frm: datetime, to: datetime) -> int:
    res = _post({"view": "calculations", "queryId": "solver-usage-count", "dry": False,
                 "parameters": {"datasets": ["cloudflare-workers"], "filters": filters_for(service),
                                "calculations": [{"operator": "count", "alias": "n"}]},
                 "timeframe": _timeframe(frm, to)})
    calcs = res.get("calculations") or []
    return int(calcs[0]["aggregates"][0]["count"]) if calcs and calcs[0].get("aggregates") else 0


def merge_csv(path: Path, rows: list[dict]) -> tuple[int, int]:
    existing: dict[str, dict] = {}
    if path.exists():
        with path.open() as f:
            for r in csv.DictReader(f):
                existing[(r.get("env", "prod"), r["call_id"])] = r
    new = sum(1 for r in rows if (r["env"], r["call_id"]) not in existing)
    for r in rows:
        existing[(r["env"], r["call_id"])] = {k: ("" if r[k] is None else r[k]) for k in COLUMNS}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in sorted(existing.values(), key=lambda r: r["at"]):
            w.writerow(r)
    return new, len(existing)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", type=Path, default=Path("analysis/solver-calls.csv"))
    args = ap.parse_args()
    to = datetime.now(timezone.utc)
    frm = to - timedelta(days=args.days)

    rc = 0
    for service in SERVICES:
        env = env_for_service(service)
        events = fetch_events(service, frm, to)
        want = expected_count(service, frm, to)
        rows = pair_events(events, env=env)
        new, total = merge_csv(args.out, rows)
        print(f"{env}: events {len(events)} (calculations-view count {want}); calls {len(rows)} ({new} new; {total} total in {args.out})")
        if len(events) != want:
            print(f"WARNING [{env}]: event count mismatch — slices too coarse or retention clipped the window", file=sys.stderr)
            rc = 2
    return rc


if __name__ == "__main__":
    sys.exit(main())
