# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""One-time backfill/dedup for recurrence occurrence_date.

Run AFTER deploying migration 0021 + the new worker code, BEFORE the occurrence
UNIQUE index exists. Steps:
  1. Read all template_id-bearing task rows + each owner's home_tz.
  2. Derive occurrence_date = local date of (pinned_at or earliest_start) in home_tz.
  3. Collapse RC1 duplicates: one survivor per (owner, template, occurrence_date).
  4. Stamp occurrence_date on survivors.
  5. Write migrations/0022_tasks_occurrence_unique_index.sql and apply it via wrangler.

Usage:
  op run --env-file=.env -- uv run bin/backfill-occurrence-date.py            # dry-run (prod)
  op run --env-file=.env -- uv run bin/backfill-occurrence-date.py --apply    # writes (prod)
  # Target a non-default env (e.g. dev) — pass both --db and --env:
  op run --env-file=.env -- uv run bin/backfill-occurrence-date.py --db scheduler-dev --env dev
  op run --env-file=.env -- uv run bin/backfill-occurrence-date.py --db scheduler-dev --env dev --apply
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# MUST stay byte-identical to OCCURRENCE_UNIQUE_INDEX_DDL in
# worker/src/recurrence/occurrence-index.ts (guard test asserts the wording).
INDEX_DDL = (
    "CREATE UNIQUE INDEX tasks_template_occurrence "
    "ON tasks(owner_subject, template_id, occurrence_date);"
)
MIGRATION_PATH = "worker/migrations/0022_tasks_occurrence_unique_index.sql"
MIGRATION_BODY = (
    "-- 0022_tasks_occurrence_unique_index.sql — recurrence dedupe UNIQUE index.\n"
    "-- Authored + applied by bin/backfill-occurrence-date.py at cutover (see 0021).\n"
    f"{INDEX_DDL}\n"
)


def local_date(iso: str, tz: str) -> str:
    """Local YYYY-MM-DD of an ISO instant in tz (no 15-min alignment guard)."""
    instant = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return instant.astimezone(ZoneInfo(tz)).date().isoformat()


def pick_survivor(rows: list[dict]) -> dict:
    """One survivor per occurrence group: prefer non-pending, then oldest created_at."""
    def rank(r: dict) -> tuple:
        return (0 if r["status"] != "pending" else 1, r["created_at"])
    return sorted(rows, key=rank)[0]


def plan_backfill(task_rows: list[dict], home_tz_by_owner: dict[str, str], default_tz: str):
    """Pure planning: returns (stamps, deletes). task_rows need id, owner_subject,
    template_id, status, created_at, body(dict)."""
    groups: dict[tuple, list[dict]] = {}
    for r in task_rows:
        body = r["body"]
        iso = body.get("pinned_at") or body.get("earliest_start")
        if not iso:
            continue
        tz = home_tz_by_owner.get(r["owner_subject"]) or default_tz
        occ = local_date(iso, tz)
        groups.setdefault((r["owner_subject"], r["template_id"], occ), []).append({**r, "_occ": occ})

    stamps: list[tuple] = []   # (id, occurrence_date)
    deletes: list[str] = []    # task ids to remove
    for (_owner, _tpl, occ), rows in groups.items():
        survivor = pick_survivor(rows)
        stamps.append((survivor["id"], occ))
        deletes.extend(r["id"] for r in rows if r["id"] != survivor["id"])
    return stamps, deletes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--db", default="scheduler", help="wrangler D1 database name")
    ap.add_argument(
        "--env",
        default=None,
        help="wrangler env to target (e.g. 'dev'); omit for the default/prod env. "
        "Required for envs whose D1 binding only exists under [env.<name>] in wrangler.toml "
        "(d1 migrations apply cannot otherwise resolve the database).",
    )
    ap.add_argument("--default-tz", default="Australia/Sydney")
    args = ap.parse_args()

    # Pass --env through to every wrangler call so non-default envs (e.g. dev,
    # whose binding lives under [env.dev]) resolve for both execute and migrations.
    env_args = ["--env", args.env] if args.env else []

    def d1(sql: str) -> list[dict]:
        out = subprocess.run(
            ["npx", "wrangler", "d1", "execute", args.db, *env_args, "--remote", "--json", "--command", sql],
            cwd="worker", capture_output=True, text=True, check=True,
        )
        parsed = json.loads(out.stdout)
        return parsed[0]["results"] if isinstance(parsed, list) else parsed["results"]

    task_raw = d1(
        "SELECT id, owner_subject, template_id, status, created_at, body "
        "FROM tasks WHERE template_id IS NOT NULL"
    )
    for r in task_raw:
        r["body"] = json.loads(r["body"])
    owners = d1("SELECT subject, home_tz FROM users")
    home_tz_by_owner = {o["subject"]: o["home_tz"] for o in owners if o.get("home_tz")}

    stamps, deletes = plan_backfill(task_raw, home_tz_by_owner, args.default_tz)
    # skipped = template rows with neither pinned_at nor earliest_start, so no
    # occurrence_date can be derived (should be 0 — materialise always sets timing).
    skipped = len(task_raw) - len(stamps) - len(deletes)
    print(
        f"rows={len(task_raw)} survivors={len(stamps)} "
        f"duplicates_to_delete={len(deletes)} skipped_no_timing={skipped}"
    )
    if skipped:
        print(f"WARNING: {skipped} template rows had no derivable occurrence_date and were left NULL")
    if not args.apply:
        print("dry-run: no changes written. Re-run with --apply.")
        return 0

    for tid in deletes:
        assert UUID_RE.match(tid), f"refusing to DELETE on malformed task id: {tid!r}"
    for tid, occ in stamps:
        assert UUID_RE.match(tid), f"refusing to UPDATE on malformed task id: {tid!r}"
        assert DATE_RE.match(occ), f"refusing to UPDATE with malformed occurrence_date: {occ!r}"

    for tid in deletes:
        d1(f"DELETE FROM tasks WHERE id = '{tid}'")
    for tid, occ in stamps:
        d1(f"UPDATE tasks SET occurrence_date = '{occ}' WHERE id = '{tid}'")

    with open(MIGRATION_PATH, "w") as f:
        f.write(MIGRATION_BODY)
    subprocess.run(["npx", "wrangler", "d1", "migrations", "apply", args.db, *env_args, "--remote"], cwd="worker", check=True)
    print(f"applied {MIGRATION_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
