#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pull captured solver Problem JSON out of R2 into a local corpus for the
Stage 3 parity harness (internal design notes, card 3.0).

The worker stamps one `solver_calls` D1 row per solve (migration 0038) and,
when SOLVER_CAPTURE_PROBLEMS is "true", puts the raw Problem payload to R2 at
`problems/<solver_calls.id>.json` as an envelope `{env, call_id, captured_at,
problem}`. This script joins the two: it lists rows for a date range from one
env's own D1 (`wrangler d1 execute DB`, dev needs `--env dev`, prod has no
--env flag — same convention as every other repo script), downloads each
row's R2 object, asserts the envelope's `env` field agrees with the env it
was pulled for ("unknown" included — that's the config-drift alarm the write
path deliberately allows through rather than dropping the capture), and
writes:

  - analysis/corpus/<env>/<at>-<id>.json   — the full envelope, one per call
  - analysis/corpus/manifest.csv           — id, at, env, trigger, status,
    n_tasks, n_chunks, round_trip_ms, merged idempotently by (env, id)

`analysis/corpus/manifest.csv` is committed (no titles, no owner — just ids
and shape/outcome columns); the env payload subdirectories underneath it are
gitignored (see .gitignore's `analysis/corpus/*` / `!analysis/corpus/manifest.csv`
pair). The manifest indexes only the LOCAL downloaded corpus — a row whose R2
object is missing is skipped and never enters the manifest at all, so it is
not a complete index of every solver_calls row, only of what this machine has
actually pulled.

`--env` is dev or prod, the envs that capture (SOLVER_CAPTURE binding; see
the plan's card 3.0). The D1 query also filters to
`source = 'live'` — rows backfilled from Workers Logs (source='logs', ids
like "requestId#n") never had a capture put, so pulling them would spend a
wrangler spawn per row for a guaranteed miss.

A missing R2 object (capture predates deploy, or the put failed) is a
warning + skip, not a crash — best-effort, matching the write path's own
best-effort stance.

Known limitation: an envelope env/D1-source-env mismatch (EnvMismatchError,
"unknown" included) aborts the WHOLE run before the manifest is written at
all — deliberate, since drift is meant to be an alarm state a partial/silent
manifest would hide, not something to route around.

Usage (needs `op` Cloudflare creds and D1/R2 access on the token; run from
the repo root — this script cd's into worker/ itself for wrangler):
  op run --env-file=.env -- bin/solver-capture-pull.py --env dev --since 2026-08-20
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO_ROOT / "worker"
BUCKET = "optical-solver-capture"

# --since/--until are interpolated straight into the D1 --command string, so
# they're validated at parse time rather than passed through free-form (repo
# convention for anything that reaches a shell-adjacent command line).
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$")

D1_COLUMNS = [
    "id", "at", "owner", "trigger", "window_start", "attempts", "http_status",
    "round_trip_ms", "solver_uptime_ms", "pass1_ms", "pass2_ms", "status",
    "n_tasks", "n_chunks", "n_external", "n_dropped", "source",
]
MANIFEST_COLUMNS = [
    "id", "at", "env", "trigger", "status", "n_tasks", "n_chunks", "round_trip_ms",
]


class EnvMismatchError(RuntimeError):
    """The envelope's `env` field disagrees with the D1 source env the row
    was pulled from — including "unknown". A mislabelled capture beats a
    lost one at write time (see card 3.0), but at pull time it means either
    DEPLOY_ENV drifted or the row was queried against the wrong D1 — either
    way it must stop the run, not be silently written into the wrong corpus
    partition."""


# =============================================================================
# pure mappings
# =============================================================================


def r2_key(row_id: str) -> str:
    """D1 solver_calls.id -> the flat R2 key the worker put it at."""
    return f"problems/{row_id}.json"


def _fs_safe(at: str) -> str:
    """ISO timestamps carry ':' — not safe in filenames on every filesystem."""
    return at.replace(":", "-")


def output_path(root: Path, env: str, row_id: str, at: str) -> Path:
    return root / env / f"{_fs_safe(at)}-{row_id}.json"


def manifest_row_from(d1_row: dict, env: str) -> dict:
    return {
        "id": d1_row["id"],
        "at": d1_row["at"],
        "env": env,
        "trigger": d1_row.get("trigger"),
        "status": d1_row.get("status"),
        "n_tasks": d1_row.get("n_tasks"),
        "n_chunks": d1_row.get("n_chunks"),
        "round_trip_ms": d1_row.get("round_trip_ms"),
    }


def merge_manifest(path: Path, rows: list[dict]) -> tuple[int, int]:
    """Merge manifest rows keyed by (env, id) so re-running the puller over an
    overlapping date range never duplicates a row (idempotent), while still
    picking up a changed status/outcome for the same id on a later pull."""
    existing: dict[tuple[str, str], dict] = {}
    if path.exists():
        with path.open() as f:
            for r in csv.DictReader(f):
                existing[(r.get("env", ""), r["id"])] = r
    new = sum(1 for r in rows if (r["env"], r["id"]) not in existing)
    for r in rows:
        existing[(r["env"], r["id"])] = {k: ("" if r.get(k) is None else r[k]) for k in MANIFEST_COLUMNS}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=MANIFEST_COLUMNS)
        w.writeheader()
        for r in sorted(existing.values(), key=lambda r: r["at"]):
            w.writerow(r)
    return new, len(existing)


def assert_envelope_env(row_id: str, expected_env: str, envelope_env: str) -> None:
    if envelope_env != expected_env:
        raise EnvMismatchError(
            f"row {row_id}: envelope env={envelope_env!r} does not match "
            f"the D1 source env {expected_env!r} pulled for"
        )


# =============================================================================
# wrangler command builders (thin — actual subprocess calls stay in main())
# =============================================================================


def _until_bound(until: str) -> tuple[str, str]:
    """Return (operator, value) for the upper bound on `at`.

    A bare ISO date (--until documented as inclusive) means "through the end
    of that day", so it's turned into an EXCLUSIVE `<` bound on the following
    day. Comparing `at <= '<date>'` directly is the MAJOR bug this avoids:
    SQLite compares TEXT lexicographically, so a full timestamp on the
    --until day (e.g. '2026-08-20T10:15:03Z') sorts GREATER than the bare
    date '2026-08-20' — the longer string that shares the date prefix always
    sorts after the shorter one — so `<=` against the bare date silently
    drops the entire end day. A full datetime --until is already exact and
    is compared with `<=` directly, no adjustment."""
    if _ISO_DATE_RE.fullmatch(until):
        return "<", (date.fromisoformat(until) + timedelta(days=1)).isoformat()
    return "<=", until


def d1_query_cmd(env: str, since: str | None, until: str | None) -> list[str]:
    # source='live' excludes bin/solver-usage-backfill.py's backfilled rows
    # (source='logs', ids like "requestId#n") — those never had a capture
    # put, so pulling them would cost a wrangler spawn per row for a
    # guaranteed miss.
    conditions = ["source = 'live'"]
    if since:
        conditions.append(f"at >= '{since}'")
    if until:
        op, bound = _until_bound(until)
        conditions.append(f"at {op} '{bound}'")
    sql = f"SELECT {', '.join(D1_COLUMNS)} FROM solver_calls WHERE {' AND '.join(conditions)} ORDER BY at"
    cmd = ["npx", "wrangler", "d1", "execute", "DB"]
    if env != "prod":
        cmd += ["--env", env]
    cmd += ["--remote", "--json", "--command", sql]
    return cmd


def r2_get_cmd(row_id: str, dest: Path) -> list[str]:
    return [
        "npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{r2_key(row_id)}",
        "--file", str(dest), "--remote",
    ]


# =============================================================================
# CLI
# =============================================================================


def _iso_date_or_datetime(value: str) -> str:
    """argparse `type=` for --since/--until: reject anything that isn't a
    plain ISO date or datetime BEFORE it reaches the D1 --command string —
    these values are interpolated directly into SQL, so free-form input
    (including a bare SQL-injection attempt) must fail here, not at wrangler
    or, worse, silently inside the query."""
    if not (_ISO_DATE_RE.fullmatch(value) or _ISO_DATETIME_RE.fullmatch(value)):
        raise argparse.ArgumentTypeError(
            f"must be an ISO date (YYYY-MM-DD) or datetime (YYYY-MM-DDTHH:MM:SS[.ffffff][Z]), got {value!r}"
        )
    return value


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--env", required=True, choices=["dev", "prod"],
                     help="D1/R2 source env (the envs that capture)")
    ap.add_argument("--since", type=_iso_date_or_datetime,
                     help="ISO date/datetime, inclusive lower bound on solver_calls.at")
    ap.add_argument("--until", type=_iso_date_or_datetime,
                     help="ISO date/datetime, inclusive upper bound on solver_calls.at "
                          "(a bare date covers the whole day)")
    ap.add_argument("--out", type=Path, default=REPO_ROOT / "analysis" / "corpus",
                     help="corpus output root (default: <repo root>/analysis/corpus)")
    return ap


def fetch_rows(env: str, since: str | None, until: str | None) -> list[dict]:
    cmd = d1_query_cmd(env, since, until)
    proc = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            f"wrangler d1 execute failed (exit {proc.returncode})\n"
            f"stderr: {proc.stderr.strip()}\nstdout: {proc.stdout.strip()}"
        )
    payload = json.loads(proc.stdout)
    return payload[0]["results"]


def fetch_problem(row_id: str) -> dict | None:
    """Download problems/<row_id>.json to a temp file and return its parsed
    envelope, or None if the object doesn't exist / wrangler fails (warning +
    skip is the caller's job — this just reports success/failure)."""
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / f"{row_id}.json"
        cmd = r2_get_cmd(row_id, dest)
        proc = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not dest.exists():
            print(f"  WARNING: row {row_id}: R2 object not found or unreadable "
                  f"(skip) — {proc.stderr.strip()[:200]}", file=sys.stderr)
            return None
        return json.loads(dest.read_text())


def main() -> int:
    args = build_arg_parser().parse_args()
    rows = fetch_rows(args.env, args.since, args.until)
    print(f"{args.env}: {len(rows)} solver_calls row(s) in range")

    manifest_rows = []
    written = 0
    for row in rows:
        envelope = fetch_problem(row["id"])
        if envelope is None:
            continue
        assert_envelope_env(row["id"], args.env, envelope.get("env", "unknown"))

        dest = output_path(args.out, args.env, row["id"], row["at"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(envelope, indent=2))
        written += 1
        manifest_rows.append(manifest_row_from(row, args.env))

    new, total = merge_manifest(args.out / "manifest.csv", manifest_rows)
    print(f"{args.env}: wrote {written} problem file(s); manifest {new} new, {total} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
