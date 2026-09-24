#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""
One-off utility to reset the sandbox calendar to a known 5-week pattern.

Wipes every event in [today, today + 1 year), then seeds a synthetic
"realistic operator week" across 5 consecutive Mondays. The harness then
runs L1..L5 against one week each, starting at the seeded Monday.

Also wipes the harness's D1 footprint across all three smoke harness families —
bin/regression-smoke.py ("[regsmoke"-titled must_include tasks + templates, and
its generic tasks via "regsmoke-" source.external_id), bin/meeting-smoke.py
("[mtg-smoke]" titles — both its filler tasks and its imported-meeting tasks,
whose title is copied verbatim from the Google event summary), and
bin/multiuser-smoke.py ("[mu-smoke]" template titles, defence in depth only;
its own tasks carry a generic title and are matched instead by their
"mu-smoke-" source.external_id prefix) — as a title/external_id-based
sledgehammer. This is the catch-all that mops up orphaned recurrence-sweep
occurrences (template already deleted, so the per-level loop in
regression-smoke.py can no longer reach them by template_id) and any harness
run that crashed or was Ctrl-C'd before its own cleanup ran. reset-and-seed
truly "deletes everything"; each harness's own per-level/per-run cleanup is
the precise, orphan-free cleanup during normal operation.

CAVEAT: the D1 sweep runs as ONE identity (/v1/tasks and /v1/templates are
owner-scoped), so it only sees and deletes rows owned by whichever account
this script authenticates as (SCHEDULER_BEARER/SCHEDULER_REFRESH_TOKEN/
EXPECTED_TEST_ACCOUNT below) — not a multi-identity loop. multiuser-smoke
seeds tasks on its "A" identity, and meeting-smoke seeds fillers on all of
its "A"/"B"/"C" identities; to clear a given letter's residue, re-run this
script once per letter with that letter's tokens mapped onto
SCHEDULER_BEARER/SCHEDULER_REFRESH_TOKEN/EXPECTED_TEST_ACCOUNT.

This is NOT for production calendars — it deletes everything in range.
Refuses to run unless the active account matches EXPECTED_TEST_ACCOUNT.

All scheduler + Google Calendar access is bearer-authenticated via the shared
_smoke_lib clients (same plumbing as regression-smoke.py): /v1/whoami for the
account gate, and /v1/calendar-access-token (requires the calendar:raw-token
scope) for the raw Google token CalendarClient uses. No CF Access JWT.

Env: SCHEDULER_URL, EXPECTED_TEST_ACCOUNT,
     SCHEDULER_BEARER, SCHEDULER_REFRESH_TOKEN (for the bearer-gated /v1 routes),
     SCHEDULER_CLIENT_ID (optional, default "smoke-cli")
Args:
  --starting-monday YYYY-MM-DD  Monday to seed week 1 on (default: next Monday)
  --clear-all                   Wipe the whole primary calendar (all events, all
                                time) via an all-time list+delete instead of the
                                default windowed [today, +1yr) list+delete, then
                                reseed.
  --l6-current-week             Also blank the CURRENT week [thisMonday, nextMonday)
                                so regression-smoke.py L6 (done-marking + placement
                                floor) runs against an empty current week. The
                                default windowed wipe only deletes from `today`
                                forward, leaving earlier-this-week events; L6's
                                floor/floor-release placement is cleanest with the
                                whole current week clear. No-op under --clear-all
                                (already wiped). The L6 level seeds and tears down
                                its own regsmoke-tagged tasks/events; this flag only
                                clears pre-existing personal residue from its week.
  --dry-run                     Report what would happen; change nothing.
"""
from __future__ import annotations
import argparse, os, sys
from datetime import date, timedelta
import importlib.util
from typing import Iterable
from pathlib import Path

# Load the sibling shared lib by path (filename starts with '_', and bin/ is not
# a package). Reuses the harness's bearer clients so every scheduler + calendar
# call authenticates exactly like regression-smoke.py does.
_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
CalendarClient = _smoke_lib.CalendarClient
DevD1 = _smoke_lib.DevD1
sql_str = _smoke_lib.sql_str
assert_dev_url = _smoke_lib.assert_dev_url
assert_env_consistent = _smoke_lib.assert_env_consistent

# Poll title prefix bin/poll-smoke.py creates every harness poll under
# (HARNESS_TITLE_PREFIX there). Duplicated as a literal rather than imported:
# poll-smoke.py is a separate PEP 723 script with its own dependency block,
# and importing script-to-script the way this file already does with
# _smoke_lib would pull poll-smoke.py's `httpx`-only module-level code in
# just for one constant. Keep the two in sync by hand if it ever changes.
POLL_TITLE_PREFIX = "[pollsmoke]"

# Dev/prod D1 ids, per bin/meeting-smoke.py / bin/booking-smoke.py.
_SMOKE_DB_IDS = _smoke_lib.SMOKE_DB_IDS   # every smoke-env db
_PROD_DB_ID = _smoke_lib.PROD_DB_ID        # scheduler (prod) — NEVER

# Title prefixes the harness D1 sledgehammer (wipe_harness_d1) matches
# against, one entry per harness family. Covers templates for all three
# families, but NOT bin/regression-smoke.py's generic tasks or any
# bin/multiuser-smoke.py task — both are posted with a realistic/generic
# title (not this prefix) and so need the source.external_id fallback in
# HARNESS_EXTERNAL_ID_PREFIXES / is_harness_task below instead.
HARNESS_TITLE_PREFIXES: tuple[str, ...] = (
    "[regsmoke",    # bin/regression-smoke.py — the "must_include" task
                    # family ("[regsmoke] Mandatory deliverable N") + template
                    # titles ONLY. Its generic L1-L5 tasks get a realistic
                    # title instead ("Spec review", "Gym", ...) and are
                    # matched via HARNESS_EXTERNAL_ID_PREFIXES below.
    "[mtg-smoke]",  # bin/meeting-smoke.py — filler task titles, AND imported
                    # meeting task titles (copied verbatim from the Google
                    # event summary by worker/src/meetings/sync.ts, so a
                    # meeting task this harness's own event created keeps the
                    # same prefix)
    "[mu-smoke]",   # bin/multiuser-smoke.py — defence in depth only: it
                    # never actually POSTs a template today, but cleans up
                    # any "[mu-smoke]"-titled one it finds
)

# Tasks identifiable only by source.external_id, not by title — for
# regression-smoke's generic tasks (realistic titles) and every
# multiuser-smoke task (posted with the generic title "iso task"; see
# TASK_PREFIX / _post_task / _task_body there). Both harnesses' own cleanup
# keys on the identical prefix (regression-smoke.py's `_task_is_harness`,
# ~line 2571; multiuser-smoke.py's TASK_PREFIX). Keep in sync by hand — see
# the POLL_TITLE_PREFIX comment above for why these aren't imported directly.
HARNESS_EXTERNAL_ID_PREFIXES: tuple[str, ...] = (
    "regsmoke-",  # bin/regression-smoke.py — task source.external_id
    "mu-smoke-",  # bin/multiuser-smoke.py — task source.external_id
)


def is_harness_row(row: dict, prefixes: Iterable[str]) -> bool:
    """True iff row's title is a string starting with one of prefixes.

    Pure and side-effect-free so it's directly unit-testable. Used for both
    tasks and templates; does not look at source.external_id — see
    is_harness_task for the task-only external_id fallback that
    regression-smoke's and multiuser-smoke's generically-titled tasks need."""
    title = row.get("title")
    return isinstance(title, str) and any(title.startswith(p) for p in prefixes)


def is_harness_task(task: dict) -> bool:
    """True iff task is harness-owned: either its title matches
    HARNESS_TITLE_PREFIXES, or its source.external_id starts with one of
    HARNESS_EXTERNAL_ID_PREFIXES (regression-smoke's generic tasks and every
    multiuser-smoke task, neither title-tagged)."""
    if is_harness_row(task, HARNESS_TITLE_PREFIXES):
        return True
    src = task.get("source")
    ext = src.get("external_id") if isinstance(src, dict) else None
    return isinstance(ext, str) and any(ext.startswith(p) for p in HARNESS_EXTERNAL_ID_PREFIXES)


# The 22-event pattern of one realistic synthetic
# week. Times are wall-clock in Australia/Sydney (AEST in June,
# +10:00). Two events were timing-broken by an earlier worker bug and are
# re-anchored at their *intended* wall-clock times here.
#
# Each entry is (weekday: 0=Mon..6=Sun, start "HH:MM", end "HH:MM", summary).
PATTERN: list[tuple[int, str, str, str]] = [
    # Standup and Pilates were broken-TZ residue from the regsmoke standup/pilates
    # templates (now fixed). They aren't truly "personal" events — they're what
    # the harness's templates produce. Omitted here so the harness's own
    # template materialisations (Standup 08:30, NYC Tue 23:00, Pilates Fri 19:00)
    # have clear slots.
    (0, "09:00", "10:30", "Quarterly review"),
    (0, "10:30", "11:30", "Write client update memo"),
    (0, "13:00", "14:00", "Vendor demo: ACME"),
    (0, "14:00", "14:45", "Process inbox"),
    (0, "16:00", "16:45", "Run"),
    (1, "09:30", "11:00", "Strategy offsite prep"),
    (1, "11:00", "12:00", "Write client update memo"),
    (1, "15:00", "16:00", "All hands"),
    (1, "20:00", "20:30", "1:1 with Sam"),
    (2, "10:00", "12:00", "Board meeting"),
    (2, "14:00", "15:30", "Workshop: AI policy"),
    (3, "09:00", "10:30", "Client onsite"),
    (3, "10:30", "12:00", "Review APOLLO quarterly draft"),
    (3, "13:00", "14:00", "Lunch with mentor"),
    (3, "15:00", "17:00", "Project deep dive"),
    (4, "10:00", "11:30", "Sprint planning"),
]

TZ_OFFSET = "+10:00"  # Australia/Sydney AEST (June is winter)
# Read leniently at import (so the module is importable by tests / --help);
# main() fails loudly if any of the four required ones is missing.
SCHEDULER_URL = os.environ.get("SCHEDULER_URL", "").rstrip("/")
EXPECTED_TEST_ACCOUNT = os.environ.get("EXPECTED_TEST_ACCOUNT", "")
# Bearer credentials for the /v1 routes (requireBearer). The same bearer also
# unlocks /v1/calendar-access-token, which the calendar client uses for the
# raw provider token — so it must carry the calendar:raw-token scope.
SCHEDULER_BEARER = os.environ.get("SCHEDULER_BEARER", "")
SCHEDULER_REFRESH_TOKEN = os.environ.get("SCHEDULER_REFRESH_TOKEN", "")
_REQUIRED_ENV = ("SCHEDULER_URL", "EXPECTED_TEST_ACCOUNT", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN")
SCHEDULER_CLIENT_ID = os.environ.get("SCHEDULER_CLIENT_ID", "smoke-cli")

# Wide bounds for the "all time" wipe. The scheduler's Google token carries only
# the `calendar.events` scope, so the calendars.clear API (which needs the full
# `calendar` scope) 403s. A list+delete over a very wide window stays within the
# events scope and achieves the same "wipe everything" intent for the sandbox.
ALL_TIME_MIN = "2000-01-01T00:00:00Z"
ALL_TIME_MAX = "2100-01-01T00:00:00Z"


def get_active_account(sched: SchedulerClient) -> str:
    r = sched.request("GET", "/v1/whoami")
    r.raise_for_status()
    return r.json()["email"]


def clear_calendar(cal: CalendarClient) -> int:
    """Delete *every* event on the primary calendar over an all-time window.

    Lists [2000, 2100) (singleEvents-expanded) and deletes each one. Unlike the
    default [today, +1yr) windowed wipe this also removes past events and events
    beyond the 1-year horizon. CalendarClient uses events.delete (events scope)
    rather than calendars.clear, which requires the broader `calendar` scope the
    scheduler token does not hold. Returns the number of events deleted."""
    existing = cal.list_events(ALL_TIME_MIN, ALL_TIME_MAX)
    for i, ev in enumerate(existing, 1):
        cal.delete_event(ev["id"])
        if i % 25 == 0:
            print(f"  deleted {i}/{len(existing)}")
    return len(existing)


def wipe_harness_d1(sched: SchedulerClient, dry_run: bool) -> None:
    """Delete every harness-tagged task + template from D1 across all three
    harness families (regsmoke/mtg-smoke/mu-smoke), title- (and, for
    regsmoke's generic tasks and every mu-smoke task, source.external_id-)
    based.

    This is the sledgehammer half of the harness cleanup split: it matches by
    prefix (which survives materialisation), so it catches ORPHANED occurrences
    whose template is already gone — the residue the per-level template_id loop
    in regression-smoke.py cannot reach — and residue any harness left behind
    from a crashed or Ctrl-C'd run. Tasks are deleted before templates for
    symmetry with that loop, though prefix matching makes the order immaterial
    here.

    CAVEAT: sched is a single identity, and /v1/tasks + /v1/templates are
    owner-scoped, so this only sees and deletes rows owned by whichever
    account sched authenticates as — not every identity a multi-account
    harness (multiuser-smoke, meeting-smoke) may have seeded. Re-run this
    script once per letter, with that letter's tokens, to clear each one.

    Uses the bearer-carrying SchedulerClient: /v1/tasks and /v1/templates are
    requireBearer-gated."""
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    tasks = [
        t for t in r.json().get("tasks", [])
        if is_harness_task(t) and isinstance(t.get("id"), str)
    ]
    r = sched.request("GET", "/v1/templates")
    r.raise_for_status()
    templates = [
        t for t in r.json().get("templates", [])
        if is_harness_row(t, HARNESS_TITLE_PREFIXES) and isinstance(t.get("id"), str)
    ]
    if dry_run:
        print(f"would wipe harness D1: {len(tasks)} task(s) + {len(templates)} template(s)")
        return
    for t in tasks:
        dr = sched.request("DELETE", f"/v1/tasks/{t['id']}")
        if dr.status_code not in (200, 204, 404):
            dr.raise_for_status()
    for t in templates:
        dr = sched.request("DELETE", f"/v1/templates/{t['id']}")
        if dr.status_code not in (200, 204, 404):
            dr.raise_for_status()
    print(f"wiped harness D1: {len(tasks)} task(s) + {len(templates)} template(s)")


def wipe_harness_polls(db_id: str | None, repo_root: Path, dry_run: bool) -> None:
    """Delete every poll bin/poll-smoke.py created (title LIKE
    '[pollsmoke]%'), cascading through poll_responses -> poll_invitees ->
    bookings -> polls. Direct D1, like cleanup_booking_row in
    bin/booking-smoke.py: none of these four tables has a DELETE endpoint (a
    poll can only be cancelled, never removed, and there is no
    per-invitee/per-response REST surface at all), so there is no REST
    sledgehammer equivalent to wipe_harness_d1's /v1/tasks DELETE loop above.

    D1_DATABASE_ID is OPTIONAL (unlike the rest of this script's required
    env): poll-smoke.py already does its own D1 cleanup when it has
    D1_DATABASE_ID, so this is the catch-all for whatever a crashed or
    Ctrl-C'd poll-smoke.py run left behind — the same "title-based sledgehammer
    mops up orphans" split this file already draws for regsmoke tasks vs.
    regression-smoke.py's own per-level cleanup."""
    if not db_id:
        print(
            "D1_DATABASE_ID not set — poll rows NOT wiped automatically. Clean up manually:\n"
            "    cd worker && npx wrangler d1 execute scheduler-dev --env dev --remote --command "
            f'"DELETE FROM poll_responses WHERE invitee_id IN (SELECT id FROM poll_invitees '
            f"WHERE poll_id IN (SELECT id FROM polls WHERE title LIKE '{POLL_TITLE_PREFIX}%')); "
            f"DELETE FROM poll_invitees WHERE poll_id IN (SELECT id FROM polls WHERE title LIKE "
            f"'{POLL_TITLE_PREFIX}%'); DELETE FROM bookings WHERE poll_id IN (SELECT id FROM polls "
            f"WHERE title LIKE '{POLL_TITLE_PREFIX}%'); DELETE FROM polls WHERE title LIKE "
            f"'{POLL_TITLE_PREFIX}%'\""
        )
        return
    if db_id == _PROD_DB_ID:
        print("REFUSING to wipe polls: D1_DATABASE_ID is the PROD database.", file=sys.stderr)
        return
    if db_id not in _SMOKE_DB_IDS:
        print(f"REFUSING to wipe polls: D1_DATABASE_ID {db_id!r} is not a known smoke db.", file=sys.stderr)
        return

    # D8/M2: route through the shared helper (db id -> its wrangler env,
    # SMOKE_WRANGLER_ENV still wins) instead of re-deriving env_name here —
    # ms-smoke.py's run_live had the identical bug independently; one helper
    # means the derivation logic can't drift out of sync between the two.
    d1 = _smoke_lib.d1_for_db_id(db_id, repo_root)
    like = sql_str(f"{POLL_TITLE_PREFIX}%")
    rows = d1.query(f"SELECT id FROM polls WHERE title LIKE {like}")
    poll_ids = [r["id"] for r in rows if isinstance(r.get("id"), str)]
    if dry_run:
        print(f"would wipe harness polls: {len(poll_ids)} poll(s) (+ cascaded invitees/responses/bookings)")
        return
    if not poll_ids:
        print("wiped harness polls: 0 poll(s)")
        return
    id_list = ",".join(sql_str(pid) for pid in poll_ids)
    d1.execute(
        f"DELETE FROM poll_responses WHERE invitee_id IN "
        f"(SELECT id FROM poll_invitees WHERE poll_id IN ({id_list}))"
    )
    d1.execute(f"DELETE FROM poll_invitees WHERE poll_id IN ({id_list})")
    d1.execute(f"DELETE FROM bookings WHERE poll_id IN ({id_list})")
    d1.execute(f"DELETE FROM polls WHERE id IN ({id_list})")
    print(f"wiped harness polls: {len(poll_ids)} poll(s) (+ cascaded invitees/responses/bookings)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Reset the sandbox calendar to a known 5-week pattern, and wipe "
            "harness-owned D1 rows (tasks/templates) left by any of the three "
            "smoke harness families: bin/regression-smoke.py ([regsmoke)-titled "
            "tasks/templates, plus regsmoke-tagged generic tasks), "
            "bin/meeting-smoke.py ([mtg-smoke]), and bin/multiuser-smoke.py "
            "([mu-smoke] templates + mu-smoke-tagged tasks). The D1 sweep runs "
            "as ONE identity "
            "(SCHEDULER_BEARER/SCHEDULER_REFRESH_TOKEN/EXPECTED_TEST_ACCOUNT), "
            "so it only clears that identity's rows — re-run once per letter "
            "(A/B/C) with that letter's tokens to clear multi-account residue "
            "from multiuser-smoke.py / meeting-smoke.py."
        )
    )
    p.add_argument("--provider", choices=list(_smoke_lib.PROVIDERS),
                   default=os.environ.get("SMOKE_PROVIDER") or "google",
                   help="Calendar provider of the test account (default: $SMOKE_PROVIDER or google).")
    p.add_argument("--starting-monday", type=str, default=None,
                   help="YYYY-MM-DD Monday to seed week 1 on (default: next Monday)")
    p.add_argument("--clear-all", action="store_true",
                   help="Wipe the ENTIRE primary calendar (all events, all time — "
                        "not just [today, +1yr)) via an all-time list+delete, then "
                        "reseed. Default is the [today, +1yr) windowed list+delete.")
    p.add_argument("--l6-current-week", action="store_true",
                   help="Also blank the CURRENT week [thisMonday, nextMonday) so "
                        "regression-smoke.py L6 (done-marking + placement floor) "
                        "runs against an empty current week. No-op under --clear-all.")
    p.add_argument("--dry-run", action="store_true")
    return p


def main() -> int:
    args = build_parser().parse_args()
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        print(f"missing required env var(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    if args.starting_monday:
        start_mon = date.fromisoformat(args.starting_monday)
        if start_mon.weekday() != 0:
            print(f"--starting-monday {start_mon} is not a Monday", file=sys.stderr)
            return 1
    else:
        today = date.today()
        delta = (7 - today.weekday()) % 7 or 7
        start_mon = today + timedelta(days=delta)

    # D8/M4: main() previously never guarded SCHEDULER_URL at all — unlike
    # every other harness's main(), --clear-all against a mistyped/prod URL
    # had no refusal here. D8/m5: also cross-check it against D1_DATABASE_ID
    # (used further down by wipe_harness_polls), so a mismatched env pair
    # can't silently read/write the wrong D1.
    assert_dev_url(SCHEDULER_URL)
    assert_env_consistent(SCHEDULER_URL, os.environ.get("D1_DATABASE_ID"))

    repo_root = Path(__file__).resolve().parent.parent
    sched = SchedulerClient(Identity(
        scheduler_url=SCHEDULER_URL,
        bearer=SCHEDULER_BEARER,
        refresh_token=SCHEDULER_REFRESH_TOKEN,
        expected_email=EXPECTED_TEST_ACCOUNT,
        client_id=SCHEDULER_CLIENT_ID,
    ))
    cal = _smoke_lib.make_calendar_client(sched, args.provider)
    try:
        active = get_active_account(sched)
        if active != EXPECTED_TEST_ACCOUNT:
            print(f"active account {active!r} != EXPECTED_TEST_ACCOUNT {EXPECTED_TEST_ACCOUNT!r}; refusing", file=sys.stderr)
            return 1
        print(f"active account: {active}")
        print(f"starting Monday: {start_mon}")

        # Harness D1 sledgehammer: wipe every "[regsmoke" task/template, incl.
        # orphaned occurrences. This is the catch-all the per-level loop can't be
        # (it matches occurrences by live-template lineage, so a deleted template
        # leaves its occurrences unreachable). Runs before the calendar wipe so a
        # dry-run reports the full picture up front.
        wipe_harness_d1(sched, args.dry_run)

        # Poll-table catch-all: wipe every "[pollsmoke]" poll (+ cascaded
        # invitees/responses/bookings) bin/poll-smoke.py left behind — its own
        # cleanup already does this when it has D1_DATABASE_ID, so this is the
        # residue of a crashed/Ctrl-C'd run, mirroring the tasks/templates split
        # just above.
        wipe_harness_polls(os.environ.get("D1_DATABASE_ID"), repo_root, args.dry_run)

        # Wipe. Default: list every event in [today, today + 1 year) and delete
        # one by one. With --clear-all: list+delete over an all-time window so
        # past events and events beyond the 1-year horizon go too.
        if args.clear_all:
            if args.dry_run:
                all_events = cal.list_events(ALL_TIME_MIN, ALL_TIME_MAX)
                print(f"would clear ENTIRE primary calendar (all events, all time): {len(all_events)} event(s)")
            else:
                n = clear_calendar(cal)
                print(f"cleared entire primary calendar (all events, all time): {n} event(s) deleted")
        else:
            time_min = f"{date.today().isoformat()}T00:00:00Z"
            time_max = f"{(date.today() + timedelta(days=365)).isoformat()}T00:00:00Z"
            existing = cal.list_events(time_min, time_max)
            print(f"existing events in next year: {len(existing)}")
            if args.dry_run:
                for ev in existing[:5]:
                    print(f"  would delete: {ev.get('start',{}).get('dateTime', ev.get('start',{}).get('date'))}  {ev.get('summary','')[:50]!r}")
                print(f"... and {max(0, len(existing)-5)} more")
            else:
                for i, ev in enumerate(existing, 1):
                    cal.delete_event(ev["id"])
                    if i % 25 == 0:
                        print(f"  deleted {i}/{len(existing)}")
                print(f"deleted {len(existing)} events")

        # L6 prep: blank the CURRENT week so the done-marking + placement-floor
        # level runs against an empty current week. The windowed wipe above only
        # deletes from `today` forward; earlier-this-week events survive. Clear
        # the full [thisMonday, nextMonday) span here. Under --clear-all the whole
        # calendar is already empty, so this is a no-op.
        if args.l6_current_week and not args.clear_all:
            today = date.today()
            cur_mon = today - timedelta(days=today.weekday())
            wk_min = f"{cur_mon.isoformat()}T00:00:00Z"
            wk_max = f"{(cur_mon + timedelta(days=7)).isoformat()}T00:00:00Z"
            wk_events = cal.list_events(wk_min, wk_max)
            if args.dry_run:
                print(
                    f"would clear current week [{cur_mon} .. {cur_mon + timedelta(days=7)}) "
                    f"for L6: {len(wk_events)} event(s)"
                )
            else:
                for ev in wk_events:
                    cal.delete_event(ev["id"])
                print(f"cleared current week for L6: {len(wk_events)} event(s)")

        # Seed: 5 weeks × 22 events = 110 events.
        if args.dry_run:
            print(f"would seed {5 * len(PATTERN)} events ({len(PATTERN)}/week × 5 weeks)")
            return 0
        seeded = 0
        for week_offset in range(5):
            week_mon = start_mon + timedelta(days=7 * week_offset)
            for weekday, start_hm, end_hm, summary in PATTERN:
                day = week_mon + timedelta(days=weekday)
                start_iso = f"{day.isoformat()}T{start_hm}:00{TZ_OFFSET}"
                end_iso = f"{day.isoformat()}T{end_hm}:00{TZ_OFFSET}"
                cal.create_event(summary, start_iso, end_iso)
                seeded += 1
            print(f"  seeded week {week_offset + 1}/{5} ({week_mon}): {len(PATTERN)} events")
        print(f"seeded {seeded} events across {start_mon} → {start_mon + timedelta(days=28)}")
    finally:
        cal.close()
        sched.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
