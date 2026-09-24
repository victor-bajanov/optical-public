#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "python-dateutil>=2.9",
#     "rich>=13.7",
# ]
# ///
"""Multi-account meeting smoke harness for the weekly scheduler (smoke envs only, never prod).

Tests the owned-meetings free/busy path under a deterministic, competition-driven
geometry. A meeting never moves merely because an attendee is busy at its current
slot (the C1 fallback keeps the current slot feasible); it moves only when a
PINNED competitor occupies the slot, and then it AVOIDS attendee-busy slots when
choosing the destination. So free/busy honouring is observable in WHERE a
forced-to-move meeting lands (Y1 = nearest free vs Y2 = next, when Y1 is blocked).

`--provider microsoft` (WP4, internal design notes) runs the
same scenarios with every active account signed in as Microsoft (Outlook
calendars, driven through Graph), against dev with MS_PROVIDER_ENABLED="true"
there — and only once all active accounts are in ONE work tenant.
A personal Microsoft account (MSA) cannot run ANY of these scenarios, including 2C (review fix
#7, 2026-09-03 — corrects an earlier claim that 2C, "stays put, no
competition", would be exempt because it never reads free/busy): every
scenario, 2C included, still calls grant_and_wait/revoke_and_wait to set up
its topology, which sets the organisation-default calendarPermissions entry
(set_visibility) and polls getSchedule via wait_for_visibility — neither
concept exists on an MSA, so 2C fails in setup exactly like every other
scenario, just for a different reason (VisibilityError or a visibility poll
that never converges, rather than an unknown-attendee assertion). A work
tenant is required for this harness, full stop. Visibility topology on
Graph has no per-grantee ACL the way Google does — it is modelled via the
tenant's ORGANISATION-DEFAULT calendar permission (see runbook §J's
"Microsoft accounts (work tenant)" subsection), so a grant/revoke in this
harness is org-wide, not scoped to the one grantee named in a scenario's
docstring, even though the scenario code still names one for readability.
Graph also has no `sendUpdates=none` equivalent: every event this harness
creates with attendees under `--provider microsoft` sends them a real
invitation email, and every RSVP accept/decline call sends real RSVP email
too (Graph's RSVP action IS the response message) — acceptable for the
smoke mailboxes this runs against, called out again on the scenarios that
create attendee-facing events.

Two modes (selected by --accounts):
  2 (default): organiser B, attendee C; the only relationship is C grants B.
     Scenarios 2A/2C/2D (placement) + 2B (degrade-to-immovable: an attendee whose
     free/busy is unreadable freezes the meeting at its slot) + 2E (attendee-
     enforcement: a needsAction attendee still constrains under the not_declined
     default) + 2F (cascade stability: a freshly-committed move is frozen on the
     immediate re-resolve).
  3: A, B, C with the partial-visibility topology (C sees B, not A).
     Scenarios M1 (commit path) / M2 (unknown-attendee warning) / M3 (mixed
     visibility: ONE unreadable attendee freezes the meeting even though the
     other attendee's free/busy is readable — partial visibility never moves).

The harness is hermetic: it isolates a blank week across the active calendars,
sets the free/busy topology via the Calendar ACL API (freeBusyReader grants),
seeds business hours + home_tz in D1, runs, and tears everything down. The only
manual prerequisite is auth: the owner accounts must be re-consented on dev with
the calendar.acls scope (two-account: C; three-account: A, B, C).

NOTE: most scenarios RESOLVE (propose) only and assert on the proposed plan, so
no Google notifications are sent. The exceptions are M1 (three-account) and 2F
(two-account), which COMMIT the proposed move — sending sendUpdates=all to the
attendee — to exercise the commit path end to end (M1 verifies the Google event
was patched off its slot; 2F verifies the committed meeting is then frozen).

Requires:
  SCHEDULER_URL, D1_DATABASE_ID (dev db)
  B_BEARER/B_REFRESH/B_EXPECTED_EMAIL, C_BEARER/C_REFRESH/C_EXPECTED_EMAIL
  (three-account mode also requires A_BEARER/A_REFRESH/A_EXPECTED_EMAIL)

Usage:
  op run --env-file=.env -- uv run bin/meeting-smoke.py            # two-account
  op run --env-file=.env -- uv run bin/meeting-smoke.py --accounts 3
  op run --env-file=.env -- uv run bin/meeting-smoke.py --self-test
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import time as _time
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from dateutil import tz
from rich.console import Console

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
# No module-level CalendarClient binding: calendar clients are built per-run
# via _smoke_lib.make_calendar_client(sched, provider), which returns either
# _smoke_lib.CalendarClient (Google) or _smoke_lib.GraphCalendarClient
# (Microsoft) — both share the verbs this harness uses (WP4, mirroring
# bin/multiuser-smoke.py's WP3 change). Type hints that used to read
# `cal: CalendarClient` now use this duck-typed alias instead.
CalendarClientLike = _smoke_lib.CalendarClient | _smoke_lib.GraphCalendarClient
AclScopeError = _smoke_lib.AclScopeError
DevD1 = _smoke_lib.DevD1
sql_str = _smoke_lib.sql_str
seed_business_hours = _smoke_lib.seed_business_hours
set_home_tz = _smoke_lib.set_home_tz
clear_config = _smoke_lib.clear_config
assert_dev_db = _smoke_lib.assert_dev_db
assert_dev_url = _smoke_lib.assert_dev_url
post_resolve = _smoke_lib.post_resolve
post_commit = _smoke_lib.post_commit
set_self_response = _smoke_lib.set_self_response
rsvp_as_attendee = _smoke_lib.rsvp_as_attendee
# Shared preflight guard (WP4): bin/multiuser-smoke.py's check_whoami became
# a thin binding to this same _smoke_lib helper — see its own module for the
# minimal change. Both harnesses' preflight now run the identical check.
check_whoami = _smoke_lib.check_whoami_body

# =============================================================================
# Constants
# =============================================================================

# Prod-safety guards (assert_dev_db/assert_dev_url) live in _smoke_lib.py —
# shared with ms-smoke.py. Re-export the IDs here since the self-test below
# exercises them directly.
DEV_DB_ID = _smoke_lib.DEV_DB_ID
PROD_DB_ID = _smoke_lib.PROD_DB_ID

HOME_TZ = "Australia/Sydney"

# Geometry for the competition-driven scenarios. The meeting is 30 min; the
# organiser's business hours are narrowed to BH_START..BH_END (seeded in D1)
# so exactly three adjacent 30-min slots are exposed on the meeting's day:
#   X  = Tue 10:00 (current slot), Y1 = Tue 10:30, Y2 = Tue 11:00.
#
# The slots sit INSIDE the default `meeting` context fit-curve plateau
# (peak_start 10:00 .. peak_end 11:00, per migration 0005). This is load-bearing:
# X and Y1 score IDENTICAL time-of-day fit, so placement is driven purely by
# competition (the pinned organiser task), accepted-attendee free/busy, and churn
# — never by the solver preferring a "better-fit" hour. Earlier this window was
# 09:00–10:30, on the fit curve's RISING edge, so the solver legitimately drifted
# the meeting toward the 10:00 peak (2C 09:00→10:00, 2D 09:30→09:45) and every
# scenario failed for a reason unrelated to free/busy. Keep X/Y1 within the
# meeting peak if that curve ever changes.
MEETING_DURATION_MIN = 30
BH_START = "10:00"
BH_END = "11:30"

# Prefix for all harness-created calendar events. Used for cleanup.
_MS_EVENT_PREFIX = "[mtg-smoke]"
# Prefix for harness-seeded D1 tasks (source.external_id).
_MS_TASK_PREFIX = "mtg-smoke"


# =============================================================================
# Env
# =============================================================================


@dataclass(frozen=True)
class MeetingEnv:
    """Identities for the active accounts, keyed by label ("A"/"B"/"C"). In
    two-account mode only B and C are loaded; three-account mode adds A."""
    identities: dict[str, Identity]
    d1_database_id: str
    repo_root: Path

    @property
    def labels(self) -> list[str]:
        return [l for l in ("A", "B", "C") if l in self.identities]

    def email(self, label: str) -> str:
        return self.identities[label].expected_email

    @classmethod
    def from_environ(cls, accounts: int) -> "MeetingEnv":
        def req(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                print(f"missing required env var: {name}", file=sys.stderr)
                raise SystemExit(1)
            return v

        url = req("SCHEDULER_URL").rstrip("/")
        assert_dev_url(url)

        def identity(pfx: str) -> Identity:
            return Identity(
                scheduler_url=url,
                bearer=req(f"{pfx}_BEARER"),
                refresh_token=req(f"{pfx}_REFRESH"),
                expected_email=req(f"{pfx}_EXPECTED_EMAIL"),
                client_id=os.environ.get(f"{pfx}_CLIENT_ID", "smoke-cli"),
            )

        labels = active_labels(accounts)
        # D1_DATABASE_ID is REQUIRED now (the harness writes business hours/home_tz
        # to D1). Validate it is the dev db (defence-in-depth; assert_dev_url is the
        # primary guard for the bearer API path).
        db_id = req("D1_DATABASE_ID")
        assert_dev_db(db_id)
        return cls(
            identities={l: identity(l) for l in labels},
            d1_database_id=db_id,
            repo_root=Path(__file__).resolve().parent.parent,
        )


# =============================================================================
# Calendar helpers
# =============================================================================


def set_self_accepted(attendees: list[dict], self_email: str) -> list[dict]:
    """Thin wrapper over the shared `set_self_response` (bin/_smoke_lib.py),
    pinned to response='accepted' for this file's existing call sites/self-test."""
    return set_self_response(attendees, self_email, "accepted")


def accept_invite(
    organiser_cal: CalendarClientLike, attendee_cal: CalendarClientLike,
    event_id: str, self_email: str, timeout: float = 30.0,
) -> None:
    """Thin wrapper over the shared `rsvp_as_attendee` (bin/_smoke_lib.py),
    pinned to response='accepted' for this file's existing call sites. The
    worker's accepted-attendee mask (identify.ts) only reads attendees whose
    responseStatus=='accepted', so without this step the meeting's free/busy
    constraints are never applied. Provider-neutral (WP4): rsvp_as_attendee
    resolves whichever identifier `attendee_cal`'s provider needs
    (organiser's event id on Google, the event's iCalUId on Graph) without
    this call site branching on provider itself."""
    rsvp_as_attendee(organiser_cal, attendee_cal, event_id, self_email, "accepted", timeout=timeout)


def wait_for_attendee_accept(
    organiser_cal: CalendarClientLike, event_id: str, attendee_emails: list[str],
    timeout: float = 60.0,
) -> None:
    """Poll the ORGANISER's copy of `event_id` until every email in
    `attendee_emails` shows responseStatus=='accepted'.

    `accept_invite` RSVPs on the *attendee's* own copy; that acceptance then has
    to propagate back to the organiser's copy, which is the copy the worker reads
    when it builds the accepted-attendee free/busy mask (identify.ts only counts
    responseStatus=='accepted'). Without waiting here the resolve can run before
    propagation completes, so the attendee is silently dropped from the mask: the
    attendee's free/busy is ignored and no attendee_availability_unknown warning
    fires. This is the organiser-side mirror of wait_for_visibility (which only
    covers the ACL/permission free/busy grant, a different propagation). WP4:
    reads via organiser_cal.attendee_responses instead of a raw GET, so this
    works identically for a Google or Graph organiser copy."""
    want = {e.lower() for e in attendee_emails}
    deadline = _time.monotonic() + timeout
    pending = set(want)
    while _time.monotonic() < deadline:
        by_email = organiser_cal.attendee_responses(event_id)
        pending = {e for e in want if by_email.get(e) != "accepted"}
        if not pending:
            return
        _time.sleep(2.0)
    raise AssertionError(
        f"wait_for_attendee_accept: attendees {sorted(pending)} never reached "
        f"responseStatus=accepted on the organiser's copy of {event_id} within "
        f"{timeout}s (the worker would drop them from the free/busy mask)"
    )


def is_calendar_invisible(freebusy_calendars: dict, email: str) -> bool:
    """True iff `email`'s free/busy is unreadable by the querying account: the
    calendar entry is absent, or carries an `errors` array. A present entry with
    a `busy` list (even empty) means it IS visible (the worker would treat empty
    as 'free', NOT unknown — see resolve-internal.ts:584)."""
    entry = freebusy_calendars.get(email)
    if entry is None:
        return True
    return bool(entry.get("errors"))


def organiser_home_tz(prefix: str, environ: dict) -> str:
    """The home tz to build the fixture in for the organiser identified by
    `prefix` (A/B/C). Override via <PREFIX>_HOME_TZ; defaults to HOME_TZ, which
    matches the worker's SCHEDULER_TZ fallback when home_tz is NULL."""
    return environ.get(f"{prefix}_HOME_TZ", HOME_TZ)


def _iso_to_dt(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def wait_for_busy_at(viewer_cal: CalendarClientLike, target_email: str,
                     slot_start_iso: str, slot_end_iso: str,
                     timeout: float = 30.0) -> None:
    """Poll `viewer_cal`'s freeBusy.query until `target_email` shows a busy
    interval overlapping [slot_start, slot_end). Scenarios that don't go through
    the accept/propagation waits (e.g. a needsAction attendee) lack that latency,
    so a freshly-created blocking event may not yet be reflected in the
    organiser's freebusy view when the resolve fires — this closes that race."""
    s, e = _iso_to_dt(slot_start_iso), _iso_to_dt(slot_end_iso)
    deadline = _time.monotonic() + timeout
    last: list[dict] = []
    while _time.monotonic() < deadline:
        cals = viewer_cal.query_freebusy([target_email], slot_start_iso, slot_end_iso)
        last = (cals.get(target_email, {}) or {}).get("busy", []) or []
        for b in last:
            if _iso_to_dt(b["start"]) < e and _iso_to_dt(b["end"]) > s:
                return
        _time.sleep(2.0)
    raise AssertionError(
        f"wait_for_busy_at: {target_email}'s busy never covered "
        f"[{slot_start_iso}, {slot_end_iso}) within {timeout}s (saw {last!r})")


# =============================================================================
# ACL + visibility + placement helpers (pure)
# =============================================================================


def acl_rule_id(grantee_email: str) -> str:
    """The deterministic Google ACL rule id for a per-user grant."""
    return f"user:{grantee_email}"


def visibility_matches(fb_calendars: dict, email: str, want_visible: bool) -> bool:
    """True iff `email`'s readability in the freebusy `calendars` map equals the
    expectation. Reuses is_calendar_invisible (absent / errors == invisible)."""
    visible = not is_calendar_invisible(fb_calendars, email)
    return visible == want_visible


def assert_chunk_at(chunks: list[dict], slot_iso: str, label: str) -> None:
    """Raise AssertionError unless at least one chunk starts at slot_iso."""
    if not any(chunk_at_slot(c, slot_iso) for c in chunks):
        starts = [c.get("start") for c in chunks]
        raise AssertionError(
            f"{label}: expected a meeting chunk at {slot_iso} but chunk starts "
            f"were {starts!r}"
        )


def assert_no_chunk_at(chunks: list[dict], slot_iso: str, label: str) -> None:
    """Raise AssertionError if any chunk starts at slot_iso."""
    for c in chunks:
        if chunk_at_slot(c, slot_iso):
            raise AssertionError(
                f"{label}: a meeting chunk is at {slot_iso} but should not be "
                f"(chunk start {c.get('start')!r})"
            )


# =============================================================================
# Slot layout (X / Y1 / Y2) for competition-driven scenarios
# =============================================================================


@dataclass(frozen=True)
class SlotLayout:
    label: str
    meeting_summary: str   # the owned meeting placed at X
    block_summary: str     # an attendee's blocking event (placed at Y1 in 2A/M1/M3)
    x_start_iso: str       # ISO-Z — current slot (Tue 10:00), 30 min
    x_end_iso: str
    y1_start_iso: str      # Tue 10:30
    y1_end_iso: str
    y2_start_iso: str      # Tue 11:00
    y2_end_iso: str


def gen_layout(monday: date, label: str, home_tz: str = HOME_TZ) -> SlotLayout:
    """Pure: deterministic for (monday, label, home_tz). Builds the three 30-min
    slots on the Tuesday of `monday`'s week in the organiser's tz."""
    zone = tz.gettz(home_tz)
    if zone is None:
        raise ValueError(f"unknown timezone: {home_tz}")
    tue = monday + timedelta(days=1)

    def _slot(hour: int, minute: int) -> tuple[str, str]:
        local = datetime.combine(tue, time(hour, minute), tzinfo=zone)
        end = local + timedelta(minutes=MEETING_DURATION_MIN)
        fmt = lambda dt: dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
        return fmt(local), fmt(end)

    x_s, x_e = _slot(10, 0)
    y1_s, y1_e = _slot(10, 30)
    y2_s, y2_e = _slot(11, 0)
    return SlotLayout(
        label=label,
        meeting_summary=f"{_MS_EVENT_PREFIX} owned meeting {label}",
        block_summary=f"{_MS_EVENT_PREFIX} attendee block {label}",
        x_start_iso=x_s, x_end_iso=x_e,
        y1_start_iso=y1_s, y1_end_iso=y1_e,
        y2_start_iso=y2_s, y2_end_iso=y2_e,
    )


# =============================================================================
# Shared helpers
# =============================================================================


def _next_monday(day: date) -> date:
    days = (7 - day.weekday()) % 7
    if days == 0:
        days = 7
    return day + timedelta(days=days)


def _event_end_date(ev: dict) -> date | None:
    for key in ("end", "start"):
        slot = ev.get(key) or {}
        dt = slot.get("dateTime")
        if dt:
            return datetime.fromisoformat(dt.replace("Z", "+00:00")).date()
        d = slot.get("date")
        if d:
            return date.fromisoformat(d)
    return None


def find_blank_monday(cal: CalendarClientLike, start_after: date) -> date:
    """Return the first Monday strictly after start_after whose week (7 days)
    has no calendar events on the given calendar."""
    candidate = _next_monday(start_after)
    horizon = start_after + timedelta(days=400)
    while candidate <= horizon:
        span_end = candidate + timedelta(days=7)
        events = cal.list_events(
            f"{candidate.isoformat()}T00:00:00Z",
            f"{span_end.isoformat()}T00:00:00Z",
        )
        if not events:
            return candidate
        end_dates = [d for d in (_event_end_date(ev) for ev in events) if d is not None]
        candidate = _next_monday(max(end_dates)) if end_dates else candidate + timedelta(days=7)
    raise RuntimeError(
        f"no empty week found within a year of {start_after}; clean the sandbox calendar"
    )


def find_blank_monday_multi(cals: list[CalendarClientLike], start_after: date) -> date:
    """First Monday strictly after start_after whose 7-day week is blank on ALL
    given calendars. Generalises find_blank_monday to N calendars (the isolated
    week must be free for every active account in the run)."""
    candidate = _next_monday(start_after)
    horizon = start_after + timedelta(days=400)
    while candidate <= horizon:
        span_end = candidate + timedelta(days=7)
        time_min = f"{candidate.isoformat()}T00:00:00Z"
        time_max = f"{span_end.isoformat()}T00:00:00Z"
        all_blank = True
        for cal in cals:
            if cal.list_events(time_min, time_max):
                all_blank = False
                break
        if all_blank:
            return candidate
        candidate = candidate + timedelta(days=7)
    raise RuntimeError(
        f"no week blank across all {len(cals)} accounts within a year of "
        f"{start_after}; clean the sandbox calendars"
    )


def wait_for_visibility(viewer_cal: CalendarClientLike, target_email: str,
                        want_visible: bool, time_min: str, time_max: str,
                        timeout: float = 120.0, interval: float = 5.0) -> None:
    """Poll freeBusy.query from `viewer_cal`'s side until `target_email`'s
    readability matches want_visible, or fail with an explicit propagation
    message. Google applies an ACL change to free/busy with lag, so callers
    invoke this after every grant/revoke before relying on the new topology."""
    deadline = _time.monotonic() + timeout
    last: dict = {}
    while _time.monotonic() < deadline:
        last = viewer_cal.query_freebusy([target_email], time_min, time_max)
        if visibility_matches(last, target_email, want_visible):
            return
        _time.sleep(interval)
    state = "visible" if want_visible else "invisible"
    raise AssertionError(
        f"topology did not propagate: {target_email} expected {state} within "
        f"{timeout:.0f}s; last freebusy={last!r}"
    )


def seed_filler_task(sched: SchedulerClient, monday: date, label: str, *,
                     pinned_at: str | None = None,
                     duration_minutes: int = 60) -> str:
    """POST a filler deep-work task. With pinned_at set (an ISO-Z instant) the
    task becomes a fixed competitor that occupies that slot, forcing a meeting
    off it (the solver cannot double-book the organiser). Returns the UUID."""
    suffix = "competitor" if pinned_at else "filler"
    ext = f"{_MS_TASK_PREFIX}-{suffix}-{label}"
    body = {
        "title": f"{_MS_EVENT_PREFIX} {suffix} {label}",
        "context": "deep",
        "priority": 50,
        "earliest_start": f"{monday.isoformat()}T00:00",
        "deadline": None,
        "preferred_windows": [],
        "dependencies": [],
        "pinned_at": pinned_at,
        "duration_minutes": duration_minutes,
        "source": {"kind": "mcp", "external_id": ext},
        "status": "pending",
    }
    r = sched.request("POST", "/v1/tasks", json=body)
    r.raise_for_status()
    return r.json()["id"]


def task_is_harness_owned(task: dict, meeting_event_ids: set[str]) -> bool:
    """True iff this task is a harness artifact: either a filler task tagged with
    the mtg-smoke external_id prefix, or a meeting task whose source.external_id
    (the Google event id, per sync.ts) is one this harness created.

    NEVER matches a meeting by kind alone — that would delete the real user's
    imported meeting tasks on account A (review C4)."""
    src = task.get("source") or {}
    ext = src.get("external_id")
    if isinstance(ext, str) and ext.startswith(_MS_TASK_PREFIX):
        return True
    if src.get("kind") == "meeting" and isinstance(ext, str) and ext in meeting_event_ids:
        return True
    return False


def find_meeting_task_id_in(tasks: list[dict], meeting_event_id: str) -> str | None:
    """UUID of the meeting task whose source.external_id == meeting_event_id."""
    for t in tasks:
        src = t.get("source") or {}
        if src.get("kind") == "meeting" and src.get("external_id") == meeting_event_id:
            tid = t.get("id")
            if isinstance(tid, str):
                return tid
    return None


def find_meeting_task_id(sched: SchedulerClient, meeting_event_id: str) -> str | None:
    """Return the UUID of the meeting task this harness created (correlated by the
    Google event id), or None if the feature is OFF / not yet imported."""
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    return find_meeting_task_id_in(r.json().get("tasks", []), meeting_event_id)


def delete_mtgsmoke_tasks(sched: SchedulerClient, meeting_event_ids: set[str] = frozenset()) -> None:
    """Delete only harness-owned tasks: mtg-smoke filler tasks, plus meeting tasks
    whose external_id is one this harness created. Real meeting tasks are left
    untouched (review C4)."""
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    for t in r.json().get("tasks", []):
        if task_is_harness_owned(t, set(meeting_event_ids)) and isinstance(t.get("id"), str):
            sched.request("DELETE", f"/v1/tasks/{t['id']}")


def delete_mtgsmoke_calendar_events(cal: CalendarClientLike, monday: date) -> None:
    """Delete all harness-created calendar events in the week of monday.
    send_updates=False explicit (review fix #8: CalendarClient.delete_event's
    default is now None/no-suppression, matching every OTHER caller's pre-
    WP4 expectations) — this cleanup path folds in the old delete_event_
    quietly helper's always-quiet behaviour, since these deletes are harness
    teardown, not a real cancellation a real attendee should be notified of."""
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in cal.list_events(time_min, time_max):
        if ev.get("summary", "").startswith(_MS_EVENT_PREFIX):
            cal.delete_event(ev["id"], send_updates=False)


def _instants_close(a_iso: str, b_iso: str, tolerance_s: float = 60.0) -> bool:
    """True iff the two ISO instants are within tolerance_s of each other."""
    try:
        ta = datetime.fromisoformat(a_iso.replace("Z", "+00:00")).timestamp()
        tb = datetime.fromisoformat(b_iso.replace("Z", "+00:00")).timestamp()
        return abs(ta - tb) < tolerance_s
    except ValueError:
        return False


def select_meeting_chunks(schedule: list[dict], task_id: str) -> list[dict]:
    """Chunks in `schedule` belonging to `task_id`."""
    return [c for c in schedule if c.get("task_id") == task_id]


def chunk_at_slot(chunk: dict, slot_iso: str, tolerance_s: float = 60.0) -> bool:
    """True iff `chunk`'s start is within tolerance of `slot_iso`."""
    return _instants_close(chunk.get("start", ""), slot_iso, tolerance_s)


def assert_moved_off_slot(chunks: list[dict], bad_iso: str, label: str) -> None:
    """Raise AssertionError if ANY chunk is still at the bad slot."""
    for chunk in chunks:
        if chunk_at_slot(chunk, bad_iso):
            raise AssertionError(
                f"{label}: meeting chunk is still at the blocked slot {bad_iso} "
                f"(chunk start {chunk.get('start')!r}) — the solver should have moved it"
            )


def has_unknown_warning(warnings: list[str]) -> bool:
    """True iff any warning carries the attendee_availability_unknown token."""
    return any("attendee_availability_unknown" in w for w in warnings)


def assert_unknown_warning_present(warnings: list[str], label: str) -> None:
    if not has_unknown_warning(warnings):
        raise AssertionError(
            f"{label}: expected an attendee_availability_unknown warning but "
            f"warnings were {warnings!r}"
        )


def assert_unknown_warning_absent(warnings: list[str], label: str) -> None:
    if has_unknown_warning(warnings):
        bad = [w for w in warnings if "attendee_availability_unknown" in w]
        raise AssertionError(
            f"{label}: unexpected attendee_availability_unknown warning(s): {bad!r}"
        )


# =============================================================================
# Run modes, context, and hermetic setup/teardown spine
# =============================================================================


def active_labels(accounts: int) -> list[str]:
    if accounts == 2:
        return ["B", "C"]
    if accounts == 3:
        return ["A", "B", "C"]
    raise SystemExit(f"--accounts must be 2 or 3, got {accounts!r}")


def default_levels(accounts: int) -> list[str]:
    return ["2A", "2B", "2C", "2D", "2E", "2F"] if accounts == 2 else ["M1", "M2", "M3"]


@dataclass
class RunContext:
    menv: MeetingEnv
    d1: DevD1
    accounts: int
    monday: date
    sched: dict[str, SchedulerClient]
    cal: dict[str, CalendarClientLike]
    # (owner_label, grantee_email) grants this run added and must remove.
    acl_grants: list[tuple[str, str]]
    # owner_label -> cal[label].snapshot_visibility(), captured BEFORE
    # anything in this run (including its own startup sweep) touches
    # visibility at all — review fix #6: on Graph, visibility is a single
    # shared org-default field per owner, not an additive per-grantee ACL
    # rule the way Google's is, so restoring it means "put back the exact
    # value it had", not "undo what we granted". Google's snapshot is always
    # None (a no-op — its delete-only-what-we-created semantics via
    # acl_grants already restore exactly).
    visibility_baseline: dict[str, object]

    def email(self, label: str) -> str:
        return self.menv.email(label)


def startup_sweep(menv: MeetingEnv, sched: dict[str, SchedulerClient],
                  cal: dict[str, CalendarClientLike]) -> None:
    """Clear artifacts a crashed prior run may have left, BEFORE seeding:
    harness-owned tasks on every active account, and any freeBusyReader grant
    among the active accounts (owner→grantee both in {A,B,C}). Stray prefix
    events in some other week are harmless — week isolation simply skips weeks
    that are non-blank — so we do not scan the whole calendar for them here."""
    active_emails = {menv.email(l) for l in menv.labels}
    for label in menv.labels:
        delete_mtgsmoke_tasks(sched[label])
        try:
            for grantee in cal[label].list_freebusy_grantees():
                # On Graph, list_freebusy_grantees returns the "<org-default>"
                # sentinel (never a real email — set_visibility's grantee arg
                # is ignored there anyway), so this membership check only
                # ever matches on Google; the Graph branch always sweeps.
                if grantee in active_emails or grantee == "<org-default>":
                    cal[label].set_visibility(grantee, "none", label)
        except Exception as exc:  # visibility list may 403 if not consented — non-fatal here
            print(f"startup_sweep: could not list/clear visibility on {label}: {exc}")


def hermetic_setup(menv: MeetingEnv, d1: DevD1,
                   sched: dict[str, SchedulerClient],
                   cal: dict[str, CalendarClientLike], accounts: int) -> RunContext:
    """Isolate a blank week across all active calendars and seed deterministic
    business hours (10:00–11:30 Mon–Fri) + home_tz (Sydney) for every active
    account so the X/Y1/Y2 geometry is enumerable."""
    # Capture each owner's visibility BEFORE anything touches it, including
    # startup_sweep just below — which, on Graph, unconditionally sets every
    # active account's org-default role to "none" to clear a crashed prior
    # run's stray state (review fix #6). Capturing first means that clear
    # (and every scenario's own grant/revoke) is fully reversible in
    # hermetic_teardown, instead of silently narrowing the tenant's real
    # sharing default to "none" for good after one run.
    visibility_baseline = {l: cal[l].snapshot_visibility() for l in menv.labels}
    startup_sweep(menv, sched, cal)
    monday = find_blank_monday_multi([cal[l] for l in menv.labels], date.today())
    for label in menv.labels:
        subject = menv.email(label)
        seed_business_hours(d1, subject, BH_START, BH_END)
        # Seed the SAME tz the scenarios pass to gen_layout (env override or the
        # Sydney default) so the worker's slot math and the harness's X/Y1/Y2
        # ISO strings agree. Seeding a fixed HOME_TZ here would diverge from a
        # {LABEL}_HOME_TZ override and make assertions fail for the wrong reason.
        set_home_tz(d1, subject, organiser_home_tz(label, os.environ))
    return RunContext(menv=menv, d1=d1, accounts=accounts, monday=monday,
                      sched=sched, cal=cal, acl_grants=[],
                      visibility_baseline=visibility_baseline)


def hermetic_teardown(ctx: RunContext) -> None:
    """Reverse hermetic_setup: clear seeded config + home_tz, remove any ACL
    grants still recorded, restore each owner's visibility to its captured
    baseline, and sweep harness tasks/events on every account."""
    for label in ctx.menv.labels:
        subject = ctx.email(label)
        try:
            clear_config(ctx.d1, subject)
            set_home_tz(ctx.d1, subject, None)
        except Exception as exc:
            print(f"teardown: config cleanup failed for {label}: {exc}")
    # remove residual recorded grants (scenarios normally remove their own)
    for owner_label, grantee_email in list(ctx.acl_grants):
        try:
            ctx.cal[owner_label].set_visibility(grantee_email, "none", owner_label)
        except Exception as exc:
            print(f"teardown: visibility revoke {owner_label}->{grantee_email} failed: {exc}")
    ctx.acl_grants.clear()
    # Restore each owner's visibility to what hermetic_setup captured, LAST —
    # after the acl_grants revoke above, so it is the final authoritative
    # state regardless of what came before (review fix #6; a no-op on
    # Google, see CalendarClient.restore_visibility).
    for label, snapshot in ctx.visibility_baseline.items():
        try:
            ctx.cal[label].restore_visibility(snapshot)
        except Exception as exc:
            print(f"teardown: visibility restore failed for {label}: {exc}")
    for label in ctx.menv.labels:
        try:
            delete_mtgsmoke_tasks(ctx.sched[label])
            delete_mtgsmoke_calendar_events(ctx.cal[label], ctx.monday)
        except Exception as exc:
            print(f"teardown: artifact cleanup failed for {label}: {exc}")


# --- scenario building blocks -------------------------------------------------


def setup_meeting(ctx: RunContext, organiser_label: str,
                  attendee_labels: list[str], layout: SlotLayout,
                  accept: bool = True) -> str:
    """Create the owned meeting at X on the organiser's calendar with the given
    attendees. With `accept=True` (default) each attendee accepts and we wait for
    the acceptance to propagate to the organiser's copy. With `accept=False` the
    attendees are left at responseStatus='needsAction' on the organiser's copy —
    used to exercise the attendee-enforcement policy (under the not_declined
    default a needsAction attendee still constrains placement). Returns the
    meeting event id."""
    organiser_cal = ctx.cal[organiser_label]
    attendee_emails = [ctx.email(l) for l in attendee_labels]
    meeting_event_id = organiser_cal.create_event(
        layout.meeting_summary, layout.x_start_iso, layout.x_end_iso,
        attendee_emails=attendee_emails, send_updates=False,
    )
    if not accept:
        return meeting_event_id
    for l in attendee_labels:
        accept_invite(organiser_cal, ctx.cal[l], meeting_event_id, ctx.email(l))
    # Each accept above lands on the attendee's own copy; wait for it to propagate
    # back to the organiser's copy (the one the worker reads) before returning, so
    # the resolve never runs with a not-yet-accepted attendee silently dropped.
    if attendee_emails:
        wait_for_attendee_accept(organiser_cal, meeting_event_id, attendee_emails)
    return meeting_event_id


def grant_and_wait(ctx: RunContext, owner_label: str, grantee_label: str,
                   layout: SlotLayout) -> None:
    """Owner grants grantee freeBusyReader, then poll from the grantee's side
    until the owner's free/busy is visible. Records the grant for teardown."""
    grantee_email = ctx.email(grantee_label)
    ctx.cal[owner_label].set_visibility(grantee_email, "freeBusyReader", owner_label)
    ctx.acl_grants.append((owner_label, grantee_email))
    wait_for_visibility(ctx.cal[grantee_label], ctx.email(owner_label),
                        want_visible=True,
                        time_min=layout.x_start_iso, time_max=layout.y2_end_iso)


def revoke_and_wait(ctx: RunContext, owner_label: str, grantee_label: str,
                    layout: SlotLayout) -> None:
    """Owner revokes grantee's freeBusyReader (if any), then poll from the
    grantee's side until the owner's free/busy is invisible."""
    grantee_email = ctx.email(grantee_label)
    ctx.cal[owner_label].set_visibility(grantee_email, "none", owner_label)
    ctx.acl_grants[:] = [g for g in ctx.acl_grants
                         if g != (owner_label, grantee_email)]
    wait_for_visibility(ctx.cal[grantee_label], ctx.email(owner_label),
                        want_visible=False,
                        time_min=layout.x_start_iso, time_max=layout.y2_end_iso)


def resolve_and_gate(ctx: RunContext, organiser_label: str,
                     meeting_event_id: str, label: str
                     ) -> tuple[dict, str] | None:
    """Resolve the organiser's week and return (resolve_body, meeting_task_id),
    or None if the owned-meetings feature is OFF / not imported (caller SKIPs).
    Raises AssertionError on a non-200 resolve."""
    sched = ctx.sched[organiser_label]
    status, body = post_resolve(sched, ctx.monday)
    if status != 200:
        raise AssertionError(f"{label}: resolve returned {status}: {body!r}")
    meeting_task_id = find_meeting_task_id(sched, meeting_event_id)
    if meeting_task_id is None:
        return None
    return body, meeting_task_id


# =============================================================================
# Scenario results
# =============================================================================


@dataclass
class ScenarioResult:
    label: str
    passed: bool
    elapsed_seconds: float
    notes: str = ""
    skipped: bool = False


def compute_exit_code(results: list[ScenarioResult]) -> int:
    """0 = at least one genuine (non-skipped) pass and no failures;
    1 = any failure; 2 = nothing genuinely exercised (empty or all-skipped).
    An all-skip run must NOT read green — the whole point is the live path."""
    if any(not r.passed for r in results):
        return 1
    genuine = [r for r in results if not r.skipped]
    return 0 if genuine else 2


def _elapsed(started: datetime) -> float:
    return (datetime.now(tz=timezone.utc) - started).total_seconds()


def _pass(label: str, started: datetime) -> ScenarioResult:
    return ScenarioResult(label, passed=True, elapsed_seconds=_elapsed(started))


def _fail(label: str, started: datetime, notes: str) -> ScenarioResult:
    return ScenarioResult(label, passed=False, elapsed_seconds=_elapsed(started), notes=notes)


def _skip(label: str, started: datetime, notes: str) -> ScenarioResult:
    print(f"{label} SKIP: {notes}")
    return ScenarioResult(label, passed=True, elapsed_seconds=_elapsed(started),
                          notes=f"SKIP: {notes}", skipped=True)


# =============================================================================
# M1 / M2 / M3 — three-account scenarios (organiser A or C; attendees A/B/C)
# =============================================================================


def run_m1(ctx: RunContext) -> ScenarioResult:
    """M1 — full visibility, attendee constrains destination. A organises, B
    attends. Topology: A sees B (B→A). Meeting A+B at X; pinned competitor on A
    at X; block on B at Y1. Expect: moved off X, NOT at Y1, lands at Y2, no
    warning. Then COMMITS the move and verifies Google patched the real event off
    X — sending sendUpdates=all to B (the committed feature under test).

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "M1", organiser_home_tz("A", os.environ))
    meeting_event_id: str | None = None
    block_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="B", grantee_label="A", layout=layout)
        meeting_event_id = setup_meeting(ctx, "A", ["B"], layout)
        block_id = ctx.cal["B"].create_event(
            layout.block_summary, layout.y1_start_iso, layout.y1_end_iso)
        seed_filler_task(ctx.sched["A"], ctx.monday, "M1",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "A", meeting_event_id, "M1")
        if gated is None:
            return _skip("M1", started, "feature OFF or A not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if not chunks:
            raise AssertionError("M1: meeting was not scheduled")
        assert_moved_off_slot(chunks, layout.x_start_iso, "M1")
        assert_no_chunk_at(chunks, layout.y1_start_iso, "M1")
        assert_chunk_at(chunks, layout.y2_start_iso, "M1")
        assert_unknown_warning_absent(body.get("warnings") or [], "M1")
        print(f"M1: proposed move to {chunks[0]['start']} (Y2); B's Y1 block honoured")

        # Commit the proposed move and verify Google patched the real event off X
        # (sends sendUpdates=all to B — the committed feature under test).
        plan_hash = body.get("plan_hash")
        if not plan_hash:
            raise AssertionError("M1: resolve body had no plan_hash to commit")
        c_status, c_body = post_commit(ctx.sched["A"], plan_hash)
        if c_status != 200:
            raise AssertionError(f"M1: commit returned {c_status}: {c_body!r}")
        week_end = f"{(ctx.monday + timedelta(days=7)).isoformat()}T00:00:00Z"
        patched = [ev for ev in ctx.cal["A"].list_events(layout.x_start_iso, week_end)
                   if ev.get("summary", "") == layout.meeting_summary]
        if not patched:
            raise AssertionError(
                "M1: meeting event missing on A's calendar after commit (not patched)")
        start_raw = (patched[0].get("start") or {}).get("dateTime", "")
        if _instants_close(start_raw, layout.x_start_iso):
            raise AssertionError(
                f"M1: calendar event still at X {layout.x_start_iso!r} after commit "
                f"(patch did not apply): {patched[0]!r}")
        print(f"M1 OK: committed → event patched to {start_raw!r} (off X); "
              f"sendUpdates=all sent to B")
        return _pass("M1", started)
    except AssertionError as e:
        return _fail("M1", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "B", "A", layout)
        except Exception as exc:
            print(f"M1: ACL revoke failed: {exc}")
        _scenario_cleanup(ctx, "A", meeting_event_id,
                          [("B", block_id)] if block_id else [], plan_hashes)


def run_m2(ctx: RunContext) -> ScenarioResult:
    """M2 — invisible attendee → unknown warning. C organises, A attends.
    Topology: C cannot see A (revoke A→C). Meeting C+A at X. No competitor
    required (the warning is independent of movement). Expect:
    attendee_availability_unknown for A present.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "M2", organiser_home_tz("C", os.environ))
    meeting_event_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        revoke_and_wait(ctx, owner_label="A", grantee_label="C", layout=layout)
        meeting_event_id = setup_meeting(ctx, "C", ["A"], layout)

        gated = resolve_and_gate(ctx, "C", meeting_event_id, "M2")
        if gated is None:
            return _skip("M2", started, "feature OFF or C not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        assert_unknown_warning_present(body.get("warnings") or [], "M2")
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        where = chunks[0]["start"] if chunks else "<unscheduled>"
        print(f"M2 OK: attendee_availability_unknown present for A; meeting at {where}")
        return _pass("M2", started)
    except AssertionError as e:
        return _fail("M2", started, str(e))
    finally:
        _scenario_cleanup(ctx, "C", meeting_event_id, [], plan_hashes)


def run_m3(ctx: RunContext) -> ScenarioResult:
    """M3 — mixed visibility → freeze on ANY unknown. C organises, A and B
    attend. Topology: C sees B (B→C), not A (revoke A→C). Meeting C+A+B at X;
    pinned competitor on C at X; block on B at Y1 (C *can* see B). Because A's
    free/busy is unreadable the meeting MUST freeze at X even though B's is
    readable: one unconfirmable attendee makes the whole party unconfirmable
    (degrade-to-immovable, 8785336), so the meeting is dropped from the movable
    set and produces no schedule chunk — despite the pinned competitor that
    would push a movable meeting off X, and regardless of B's visible block.
    What M3 adds over 2B: 2B's only attendee is unknown; M3 proves PARTIAL
    visibility does not unfreeze. Expect: attendee_availability_unknown for A
    present AND no meeting chunk.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "M3", organiser_home_tz("C", os.environ))
    meeting_event_id: str | None = None
    block_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="B", grantee_label="C", layout=layout)
        revoke_and_wait(ctx, owner_label="A", grantee_label="C", layout=layout)
        meeting_event_id = setup_meeting(ctx, "C", ["A", "B"], layout)
        block_id = ctx.cal["B"].create_event(
            layout.block_summary, layout.y1_start_iso, layout.y1_end_iso)
        seed_filler_task(ctx.sched["C"], ctx.monday, "M3",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "C", meeting_event_id, "M3")
        if gated is None:
            return _skip("M3", started, "feature OFF or C not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        assert_unknown_warning_present(body.get("warnings") or [], "M3")
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if chunks:
            raise AssertionError(
                f"M3: meeting was relocated (chunk at {chunks[0]['start']!r}) despite "
                f"A's free/busy being unreadable — one unknown attendee must freeze "
                f"the meeting even though B's free/busy IS readable. It must stay "
                f"frozen at X ({layout.x_start_iso!r}), producing no chunk.")
        print("M3 OK: A invisible (B visible) → attendee_availability_unknown + "
              "meeting frozen at X (partial visibility does not unfreeze)")
        return _pass("M3", started)
    except AssertionError as e:
        return _fail("M3", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "B", "C", layout)
        except Exception as exc:
            print(f"M3: ACL revoke (B->C) failed: {exc}")
        _scenario_cleanup(ctx, "C", meeting_event_id,
                          [("B", block_id)] if block_id else [], plan_hashes)


# =============================================================================
# Two-account scenarios (organiser B, attendee C; only relationship is C→B)
# =============================================================================


def _scenario_cleanup(ctx: RunContext, organiser_label: str,
                      meeting_event_id: str | None,
                      block_specs: list[tuple[str, str]],
                      plan_hashes: set[str]) -> None:
    """Per-scenario teardown: harness tasks on the organiser (correlated by the
    meeting event id), prefix events on every involved calendar, blocking events,
    and plans. ACL grants are removed by the scenario body / hermetic_teardown."""
    sched = ctx.sched[organiser_label]
    delete_mtgsmoke_tasks(sched, {meeting_event_id} if meeting_event_id else set())
    for label, event_id in block_specs:
        try:
            ctx.cal[label].delete_event(event_id, send_updates=False)
        except Exception as exc:
            print(f"cleanup: delete block on {label} ({event_id}) failed: {exc}")
    for label in ctx.menv.labels:
        try:
            delete_mtgsmoke_calendar_events(ctx.cal[label], ctx.monday)
        except Exception as exc:
            print(f"cleanup: event sweep on {label} failed: {exc}")
    for h in plan_hashes:
        sched.request("DELETE", f"/v1/plans/{h}")


def run_2a(ctx: RunContext) -> ScenarioResult:
    """2A — visible attendee constrains the destination. ACL on (C→B); meeting
    B+C at X; pinned competitor on B at X; block on C at Y1. Expect: moved off
    X, NOT at Y1, lands at Y2, no attendee_availability_unknown.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "2A", organiser_home_tz("B", os.environ))
    meeting_event_id: str | None = None
    block_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="C", grantee_label="B", layout=layout)
        meeting_event_id = setup_meeting(ctx, "B", ["C"], layout)
        block_id = ctx.cal["C"].create_event(
            layout.block_summary, layout.y1_start_iso, layout.y1_end_iso)
        seed_filler_task(ctx.sched["B"], ctx.monday, "2A",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "B", meeting_event_id, "2A")
        if gated is None:
            return _skip("2A", started, "feature OFF or B not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if not chunks:
            raise AssertionError("2A: meeting was not scheduled")
        assert_moved_off_slot(chunks, layout.x_start_iso, "2A")
        assert_no_chunk_at(chunks, layout.y1_start_iso, "2A")
        assert_chunk_at(chunks, layout.y2_start_iso, "2A")
        assert_unknown_warning_absent(body.get("warnings") or [], "2A")
        print(f"2A OK: meeting at {chunks[0]['start']} (Y2); C's Y1 block honoured")
        return _pass("2A", started)
    except AssertionError as e:
        return _fail("2A", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "C", "B", layout)
        except Exception as exc:
            print(f"2A: ACL revoke failed: {exc}")
        _scenario_cleanup(ctx, "B", meeting_event_id,
                          [("C", block_id)] if block_id else [], plan_hashes)


def run_2b(ctx: RunContext) -> ScenarioResult:
    """2B — invisible attendee → degrade-to-immovable. ACL off (no C→B); meeting
    B+C at X; pinned competitor on B at X; block on C at Y1 (B cannot see it).
    Because C's free/busy is unreadable the meeting MUST freeze at X rather than
    move blind: it is dropped from the movable set (not promoted as a solver task)
    and produces no schedule chunk — exactly the 2F freeze signal. The pinned
    competitor at X would push a *movable* meeting off X, so the absence of any
    meeting chunk proves the freeze (a pre-fix build moved it freely, e.g. onto
    C's invisible Y1 block — prod incident 2026-06-26). Expect:
    attendee_availability_unknown present for C AND no meeting chunk.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "2B", organiser_home_tz("B", os.environ))
    meeting_event_id: str | None = None
    block_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        revoke_and_wait(ctx, owner_label="C", grantee_label="B", layout=layout)
        meeting_event_id = setup_meeting(ctx, "B", ["C"], layout)
        block_id = ctx.cal["C"].create_event(
            layout.block_summary, layout.y1_start_iso, layout.y1_end_iso)
        seed_filler_task(ctx.sched["B"], ctx.monday, "2B",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "B", meeting_event_id, "2B")
        if gated is None:
            return _skip("2B", started, "feature OFF or B not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        assert_unknown_warning_present(body.get("warnings") or [], "2B")
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if chunks:
            raise AssertionError(
                f"2B: meeting was relocated (chunk at {chunks[0]['start']!r}) despite "
                f"C's free/busy being unreadable — degrade-to-immovable did not apply. "
                f"It must stay frozen at X ({layout.x_start_iso!r}), producing no chunk.")
        print("2B OK: C invisible → attendee_availability_unknown + meeting frozen "
              "at X (no move proposed despite the pinned competitor)")
        return _pass("2B", started)
    except AssertionError as e:
        return _fail("2B", started, str(e))
    finally:
        _scenario_cleanup(ctx, "B", meeting_event_id,
                          [("C", block_id)] if block_id else [], plan_hashes)


def run_2c(ctx: RunContext) -> ScenarioResult:
    """2C — visible + uncontested → stays. ACL on (C→B); meeting B+C at X; no
    competitor, no block. Expect: meeting chunk still at X; no warning. Validates
    the C1 fallback (no move without competition).

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "2C", organiser_home_tz("B", os.environ))
    meeting_event_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="C", grantee_label="B", layout=layout)
        meeting_event_id = setup_meeting(ctx, "B", ["C"], layout)

        gated = resolve_and_gate(ctx, "B", meeting_event_id, "2C")
        if gated is None:
            return _skip("2C", started, "feature OFF or B not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if not chunks:
            raise AssertionError("2C: meeting was not scheduled")
        assert_chunk_at(chunks, layout.x_start_iso, "2C")
        assert_unknown_warning_absent(body.get("warnings") or [], "2C")
        print(f"2C OK: meeting stayed at X ({chunks[0]['start']}); no warning")
        return _pass("2C", started)
    except AssertionError as e:
        return _fail("2C", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "C", "B", layout)
        except Exception as exc:
            print(f"2C: ACL revoke failed: {exc}")
        _scenario_cleanup(ctx, "B", meeting_event_id, [], plan_hashes)


def run_2d(ctx: RunContext) -> ScenarioResult:
    """2D — capacity-driven move, attendee free. ACL on (C→B); meeting B+C at X;
    pinned competitor on B at X; C free everywhere. Expect: moved off X, lands at
    Y1 (nearest free), no warning. The 2A↔2D contrast (Y2 vs Y1) is attributable
    solely to C's free/busy.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "2D", organiser_home_tz("B", os.environ))
    meeting_event_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="C", grantee_label="B", layout=layout)
        meeting_event_id = setup_meeting(ctx, "B", ["C"], layout)
        seed_filler_task(ctx.sched["B"], ctx.monday, "2D",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "B", meeting_event_id, "2D")
        if gated is None:
            return _skip("2D", started, "feature OFF or B not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if not chunks:
            raise AssertionError("2D: meeting was not scheduled")
        assert_moved_off_slot(chunks, layout.x_start_iso, "2D")
        assert_chunk_at(chunks, layout.y1_start_iso, "2D")
        assert_unknown_warning_absent(body.get("warnings") or [], "2D")
        print(f"2D OK: meeting at {chunks[0]['start']} (Y1, nearest free); no warning")
        return _pass("2D", started)
    except AssertionError as e:
        return _fail("2D", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "C", "B", layout)
        except Exception as exc:
            print(f"2D: ACL revoke failed: {exc}")
        _scenario_cleanup(ctx, "B", meeting_event_id, [], plan_hashes)


def run_2e(ctx: RunContext) -> ScenarioResult:
    """2E — needsAction attendee constrains under the not_declined default. ACL on
    (C→B); meeting B+C at X but C is left needsAction (does NOT accept); pinned
    competitor on B at X forces a move; block on C at Y1 (visible to B). Under the
    not_declined account default C's busy still constrains, so the meeting skips Y1
    and lands at Y2 — exactly 2A's outcome despite C never accepting. Under the old
    accepted-only rule C would be dropped and the meeting would take Y1 (2D's
    outcome); asserting Y2 proves needsAction now constrains.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "2E", organiser_home_tz("B", os.environ))
    meeting_event_id: str | None = None
    block_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="C", grantee_label="B", layout=layout)
        meeting_event_id = setup_meeting(ctx, "B", ["C"], layout, accept=False)
        block_id = ctx.cal["C"].create_event(
            layout.block_summary, layout.y1_start_iso, layout.y1_end_iso)
        # C stays needsAction, so we skip the accept/propagation waits that give
        # other scenarios their latency — wait explicitly for C's Y1 block to be
        # visible in B's freebusy before resolving.
        wait_for_busy_at(ctx.cal["B"], ctx.email("C"),
                         layout.y1_start_iso, layout.y1_end_iso)
        seed_filler_task(ctx.sched["B"], ctx.monday, "2E",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "B", meeting_event_id, "2E")
        if gated is None:
            return _skip("2E", started, "feature OFF or B not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if not chunks:
            raise AssertionError("2E: meeting was not scheduled")
        assert_moved_off_slot(chunks, layout.x_start_iso, "2E")
        assert_no_chunk_at(chunks, layout.y1_start_iso, "2E")
        assert_chunk_at(chunks, layout.y2_start_iso, "2E")
        assert_unknown_warning_absent(body.get("warnings") or [], "2E")
        print(f"2E OK: needsAction C constrained placement → Y2 "
              f"({chunks[0]['start']}); not_declined default honoured")
        return _pass("2E", started)
    except AssertionError as e:
        return _fail("2E", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "C", "B", layout)
        except Exception as exc:
            print(f"2E: ACL revoke failed: {exc}")
        _scenario_cleanup(ctx, "B", meeting_event_id,
                          [("C", block_id)] if block_id else [], plan_hashes)


def run_2f(ctx: RunContext) -> ScenarioResult:
    """2F — cascade stability: a freshly-committed move is frozen. ACL on (C→B);
    meeting B+C at X; pinned competitor on B at X; C free everywhere → the first
    resolve moves the meeting off X (like 2D). We then COMMIT that move (Google
    event patched, last_committed_move_at stamped) and immediately RE-RESOLVE,
    simulating the commit's own webhook self-trigger. Because the meeting was
    committed-moved within MEETING_COMMIT_STABILITY_MINUTES it is frozen at its
    slot — excluded from the movable set, so it is NOT re-promoted as a solver task
    and produces no schedule chunk on the second resolve (it stays an
    external_pinned block at its committed slot). Asserting the second resolve
    yields no meeting chunk proves the freeze; without it the meeting would be
    promoted and placed again.

    Under --provider microsoft this scenario's create_event(...) call sends
    real invitation email to every named attendee — Graph has no
    sendUpdates=none equivalent (see the module docstring).
    """
    started = datetime.now(tz=timezone.utc)
    layout = gen_layout(ctx.monday, "2F", organiser_home_tz("B", os.environ))
    meeting_event_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        grant_and_wait(ctx, owner_label="C", grantee_label="B", layout=layout)
        meeting_event_id = setup_meeting(ctx, "B", ["C"], layout)
        seed_filler_task(ctx.sched["B"], ctx.monday, "2F",
                         pinned_at=layout.x_start_iso,
                         duration_minutes=MEETING_DURATION_MIN)

        gated = resolve_and_gate(ctx, "B", meeting_event_id, "2F")
        if gated is None:
            return _skip("2F", started, "feature OFF or B not consented")
        body, meeting_task_id = gated
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        chunks = select_meeting_chunks(body.get("schedule", []), meeting_task_id)
        if not chunks:
            raise AssertionError("2F: meeting was not scheduled on first resolve")
        assert_moved_off_slot(chunks, layout.x_start_iso, "2F")
        committed_slot = chunks[0]["start"]

        plan_hash = body.get("plan_hash")
        if not plan_hash:
            raise AssertionError("2F: first resolve had no plan_hash to commit")
        c_status, c_body = post_commit(ctx.sched["B"], plan_hash)
        if c_status != 200:
            raise AssertionError(f"2F: commit returned {c_status}: {c_body!r}")

        # Immediate re-resolve simulates the commit's own webhook self-trigger.
        gated2 = resolve_and_gate(ctx, "B", meeting_event_id, "2F")
        if gated2 is None:
            raise AssertionError("2F: meeting task vanished on the second resolve")
        body2, meeting_task_id2 = gated2
        if body2.get("plan_hash"):
            plan_hashes.add(body2["plan_hash"])
        chunks2 = select_meeting_chunks(body2.get("schedule", []), meeting_task_id2)
        if chunks2:
            raise AssertionError(
                f"2F: meeting was re-promoted on the second resolve (chunk at "
                f"{chunks2[0]['start']!r}) — the commit-stability freeze did not "
                f"apply (committed slot was {committed_slot!r})")
        print(f"2F OK: committed move → {committed_slot}; immediate re-resolve "
              f"froze the meeting (no second move proposed)")
        return _pass("2F", started)
    except AssertionError as e:
        return _fail("2F", started, str(e))
    finally:
        try:
            revoke_and_wait(ctx, "C", "B", layout)
        except Exception as exc:
            print(f"2F: ACL revoke failed: {exc}")
        _scenario_cleanup(ctx, "B", meeting_event_id, [], plan_hashes)


# =============================================================================
# Self-test
# =============================================================================


def _expect_raises(thunk) -> None:
    """self_test helper: assert that calling `thunk` raises AssertionError."""
    try:
        thunk()
    except AssertionError:
        return
    raise AssertionError("expected an AssertionError but none was raised")


def _expect_raises_systemexit(thunk) -> None:
    """self_test helper: assert that calling `thunk` raises SystemExit."""
    try:
        thunk()
    except SystemExit:
        return
    raise AssertionError("expected a SystemExit but none was raised")


def self_test() -> int:
    """Run pure functions with synthetic inputs. No network."""
    monday = date(2026, 7, 13)  # a Monday

    # _instants_close: tolerant of format differences, rejects distant instants.
    assert _instants_close("2026-07-14T23:00:00Z", "2026-07-14T23:00:00Z")
    assert _instants_close("2026-07-14T23:00:00Z", "2026-07-14T23:00:59Z")
    assert not _instants_close("2026-07-14T23:00:00Z", "2026-07-14T23:01:01Z")
    assert not _instants_close("2026-07-14T23:00:00Z", "2026-07-15T09:00:00Z")

    # _next_monday.
    assert _next_monday(date(2026, 7, 13)) == date(2026, 7, 20)  # Mon → next Mon
    assert _next_monday(date(2026, 7, 14)) == date(2026, 7, 20)  # Tue → following Mon
    assert _next_monday(date(2026, 7, 19)) == date(2026, 7, 20)  # Sun → next Mon

    # find_blank_monday with a stub calendar.
    class _StubCal:
        def __init__(self, windows: list[list[dict]]):
            self._windows = list(windows)

        def list_events(self, time_min: str, time_max: str) -> list[dict]:
            return self._windows.pop(0) if self._windows else []

    empty = _StubCal([[]])
    assert find_blank_monday(empty, date(2026, 7, 12)) == date(2026, 7, 13)

    busy = _StubCal([[{"end": {"dateTime": "2026-07-15T10:00:00Z"}}], []])
    assert find_blank_monday(busy, date(2026, 7, 12)) == date(2026, 7, 20)

    # --- assertion/selection helpers (Task 1) ---
    sched_fixture = [
        {"task_id": "m1", "start": "2026-07-14T23:00:00Z", "end": "2026-07-15T00:00:00Z"},
        {"task_id": "x", "start": "2026-07-15T01:00:00Z", "end": "2026-07-15T02:00:00Z"},
    ]
    assert [c["task_id"] for c in select_meeting_chunks(sched_fixture, "m1")] == ["m1"]
    assert select_meeting_chunks(sched_fixture, "absent") == []

    # chunk_at_slot: True only within tolerance of the bad start.
    assert chunk_at_slot({"start": "2026-07-14T23:00:00Z"}, "2026-07-14T23:00:30Z")
    assert not chunk_at_slot({"start": "2026-07-14T23:00:00Z"}, "2026-07-15T10:00:00Z")

    # assert_moved_off_slot raises when any chunk is still at the bad slot.
    _expect_raises(lambda: assert_moved_off_slot(
        [{"start": "2026-07-14T23:00:00Z"}], "2026-07-14T23:00:00Z", "t"))
    assert_moved_off_slot([{"start": "2026-07-15T01:00:00Z"}], "2026-07-14T23:00:00Z", "t")  # ok

    # warning helpers.
    assert has_unknown_warning(["x: attendee_availability_unknown"])
    assert not has_unknown_warning(["x: something_else"])
    assert_unknown_warning_present(["x: attendee_availability_unknown"], "t")  # ok
    _expect_raises(lambda: assert_unknown_warning_present([], "t"))
    assert_unknown_warning_absent([], "t")  # ok
    _expect_raises(lambda: assert_unknown_warning_absent(
        ["x: attendee_availability_unknown"], "t"))

    # --- dev-URL + dev-DB guards (Task 2) ---
    assert_dev_url("https://scheduler-dev.example.com")  # ok
    assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")  # ok
    _expect_raises_systemexit(lambda: assert_dev_url("https://scheduler.example.com"))
    _expect_raises_systemexit(lambda: assert_dev_url("https://example.com"))
    # assert_dev_db still rejects prod, accepts the known dev id.
    assert_dev_db(DEV_DB_ID)  # ok
    _expect_raises_systemexit(lambda: assert_dev_db(PROD_DB_ID))

    # --- harness-task ownership predicate (Task 3) ---
    filler = {"id": "u1", "source": {"kind": "mcp", "external_id": "mtg-smoke-filler-M1"}}
    mine_meeting = {"id": "u2", "source": {"kind": "meeting", "external_id": "evt-123"}}
    other_meeting = {"id": "u3", "source": {"kind": "meeting", "external_id": "evt-REAL"}}
    other_task = {"id": "u4", "source": {"kind": "mcp", "external_id": "something-else"}}
    ids = {"evt-123"}
    assert task_is_harness_owned(filler, ids)
    assert task_is_harness_owned(mine_meeting, ids)
    assert not task_is_harness_owned(other_meeting, ids)  # real user's meeting: untouched
    assert not task_is_harness_owned(other_task, ids)
    # find_meeting_task_id_in only matches a meeting whose external_id is ours.
    tasks = [other_meeting, mine_meeting]
    assert find_meeting_task_id_in(tasks, "evt-123") == "u2"
    assert find_meeting_task_id_in(tasks, "evt-absent") is None

    # --- attendee self-acceptance (Task 4) ---
    attendees = [
        {"email": "organiser@x", "organizer": True, "self": True, "responseStatus": "accepted"},
        {"email": "me@x", "responseStatus": "needsAction"},
        {"email": "other@x", "responseStatus": "needsAction"},
    ]
    patched = set_self_accepted(attendees, "me@x")
    by_email = {a["email"]: a for a in patched}
    assert by_email["me@x"]["responseStatus"] == "accepted"
    assert by_email["other@x"]["responseStatus"] == "needsAction"  # others untouched
    assert by_email["organiser@x"]["responseStatus"] == "accepted"
    # case-insensitive email match; original list not mutated.
    assert set_self_accepted(attendees, "ME@X")[1]["responseStatus"] == "accepted"
    assert attendees[1]["responseStatus"] == "needsAction"
    # missing self email → raises (caller bug surfaced, not silently ignored).
    _expect_raises(lambda: set_self_accepted(attendees, "absent@x"))

    # --- exit-code policy (Task 5) ---
    R = ScenarioResult
    # all genuine pass -> 0
    assert compute_exit_code([R("M1", True, 1.0), R("M2", True, 1.0)]) == 0
    # any fail -> 1
    assert compute_exit_code([R("M1", True, 1.0), R("M2", False, 1.0)]) == 1
    # all skipped -> 2 (loud: nothing was actually exercised)
    assert compute_exit_code([
        R("M1", True, 1.0, skipped=True), R("M2", True, 1.0, skipped=True)]) == 2
    # mixed skip + genuine pass -> 0 (at least one real pass)
    assert compute_exit_code([
        R("M1", True, 1.0, skipped=True), R("M2", True, 1.0)]) == 0
    # empty -> 2 (nothing ran)
    assert compute_exit_code([]) == 2

    # --- freebusy visibility predicate (Task 6) ---
    # An invisible calendar comes back with an `errors` array (e.g. notFound).
    fb_invisible = {"a@x": {"errors": [{"domain": "global", "reason": "notFound"}]}}
    fb_visible_free = {"a@x": {"busy": []}}
    fb_visible_busy = {"a@x": {"busy": [{"start": "...", "end": "..."}]}}
    assert is_calendar_invisible(fb_invisible, "a@x")
    assert not is_calendar_invisible(fb_visible_free, "a@x")
    assert not is_calendar_invisible(fb_visible_busy, "a@x")
    assert is_calendar_invisible({}, "a@x")  # absent entry → treated as invisible

    # organiser_home_tz resolves the env override then the Sydney default.
    assert organiser_home_tz("A", {"A_HOME_TZ": "America/New_York"}) == "America/New_York"
    assert organiser_home_tz("C", {}) == HOME_TZ

    # --- ACL rule-id formatting (pure) ---
    assert acl_rule_id("user@x.com") == "user:user@x.com"
    assert acl_rule_id("A+tag@x.com") == "user:A+tag@x.com"

    # --- visibility classification (pure) ---
    fb_vis = {"a@x": {"busy": []}}
    fb_invis = {"a@x": {"errors": [{"reason": "notFound"}]}}
    assert visibility_matches(fb_vis, "a@x", want_visible=True)
    assert not visibility_matches(fb_vis, "a@x", want_visible=False)
    assert visibility_matches(fb_invis, "a@x", want_visible=False)
    assert visibility_matches({}, "a@x", want_visible=False)  # absent == invisible

    # --- placement assertions (pure) ---
    at_y1 = [{"task_id": "m", "start": "2026-07-14T23:30:00Z"}]
    assert_chunk_at(at_y1, "2026-07-14T23:30:00Z", "t")            # ok: present
    _expect_raises(lambda: assert_chunk_at(at_y1, "2026-07-15T00:00:00Z", "t"))
    assert_no_chunk_at(at_y1, "2026-07-15T00:00:00Z", "t")        # ok: absent
    _expect_raises(lambda: assert_no_chunk_at(at_y1, "2026-07-14T23:30:00Z", "t"))

    # --- X/Y1/Y2 layout (pure, deterministic) ---
    lay1 = gen_layout(monday, "2A")
    lay2 = gen_layout(monday, "2A")
    assert lay1 == lay2, "gen_layout must be deterministic"
    assert lay1.label == "2A"
    assert lay1.meeting_summary.startswith(_MS_EVENT_PREFIX)
    assert lay1.block_summary.startswith(_MS_EVENT_PREFIX)

    zone = tz.gettz(HOME_TZ)
    def _local(iso: str):
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(zone)
    x, y1, y2 = _local(lay1.x_start_iso), _local(lay1.y1_start_iso), _local(lay1.y2_start_iso)
    assert x.weekday() == 1 and x.hour == 10 and x.minute == 0, f"X must be Tue 10:00, got {x}"
    assert y1.weekday() == 1 and y1.hour == 10 and y1.minute == 30, f"Y1 must be Tue 10:30, got {y1}"
    assert y2.weekday() == 1 and y2.hour == 11 and y2.minute == 0, f"Y2 must be Tue 11:00, got {y2}"
    for s_iso, e_iso in ((lay1.x_start_iso, lay1.x_end_iso),
                         (lay1.y1_start_iso, lay1.y1_end_iso),
                         (lay1.y2_start_iso, lay1.y2_end_iso)):
        s = datetime.fromisoformat(s_iso.replace("Z", "+00:00"))
        e = datetime.fromisoformat(e_iso.replace("Z", "+00:00"))
        assert (e - s) == timedelta(minutes=MEETING_DURATION_MIN), "slot must be 30 min"
    assert gen_layout(monday, "2B").meeting_summary != lay1.meeting_summary

    # --- multi-calendar blank week ---
    cal_a = _StubCal([[], []])                              # always blank
    cal_b = _StubCal([[{"end": {"dateTime": "2026-07-15T10:00:00Z"}}], []])  # busy wk1, blank wk2
    assert find_blank_monday_multi([cal_a, cal_b], date(2026, 7, 12)) == date(2026, 7, 20)
    both_blank = find_blank_monday_multi([_StubCal([[]]), _StubCal([[]])], date(2026, 7, 12))
    assert both_blank == date(2026, 7, 13)

    # --- mode → active accounts / default levels (pure) ---
    assert active_labels(2) == ["B", "C"]
    assert active_labels(3) == ["A", "B", "C"]
    assert default_levels(2) == ["2A", "2B", "2C", "2D", "2E", "2F"]
    assert default_levels(3) == ["M1", "M2", "M3"]
    _expect_raises_systemexit(lambda: active_labels(4))

    # --- DevD1 failure message surfaces stdout (wrangler --json writes errors
    # there, not stderr) so a real D1 failure is diagnosable, not blank ---
    msg = _smoke_lib._d1_error_message(
        returncode=1,
        stdout='{"error":"no such table: config_business_hours"}',
        stderr="",
        sql="INSERT INTO config_business_hours ...",
    )
    assert "exit 1" in msg, msg
    assert "no such table: config_business_hours" in msg, msg
    assert "INSERT INTO config_business_hours" in msg, msg

    print("self-test: OK")
    return 0


# =============================================================================
# CLI + live run
# =============================================================================


def preflight(menv: MeetingEnv, sched: dict[str, SchedulerClient], provider: str) -> None:
    """Confirm each active client authenticates as the expected identity (and,
    when the worker's whoami reports one, the expected provider) via
    /v1/whoami — the shared check_whoami (bin/_smoke_lib.check_whoami_body,
    WP4) also used by bin/multiuser-smoke.py's preflight."""
    for label in menv.labels:
        try:
            r = sched[label].request("GET", "/v1/whoami")
        except _smoke_lib.RefreshRejected as e:
            # A revoked token (e.g. B after multiuser M7) is a re-mint, not a
            # traceback — say which identity and the exact command.
            raise SystemExit(_smoke_lib.refresh_rejected_message(e, label, provider)) from None
        r.raise_for_status()
        err, warning = check_whoami(r.json(), menv.email(label), provider, label)
        if err:
            raise SystemExit(f"identity {label}: {err}")
        if warning:
            print(f"identity {label}: {warning}", file=sys.stderr)


SCENARIOS: dict[int, dict[str, object]] = {
    2: {"2A": run_2a, "2B": run_2b, "2C": run_2c, "2D": run_2d,
        "2E": run_2e, "2F": run_2f},
    3: {"M1": run_m1, "M2": run_m2, "M3": run_m3},
}


def run_scenario(label: str, fn, ctx: RunContext) -> ScenarioResult:
    """Run one scenario, converting a missing-ACL-scope 403 into a clear SKIP
    (the account was not re-consented with calendar.acls). The scenario's own
    finally has already run teardown by the time AclScopeError reaches here."""
    started = datetime.now(tz=timezone.utc)
    try:
        return fn(ctx)
    except AclScopeError as e:
        return _skip(label, started, str(e))


def run_live(args: argparse.Namespace) -> int:
    accounts = args.accounts
    menv = MeetingEnv.from_environ(accounts)
    sched = {l: SchedulerClient(menv.identities[l]) for l in menv.labels}
    cal = {l: _smoke_lib.make_calendar_client(sched[l], args.provider) for l in menv.labels}
    d1 = DevD1(repo_root=menv.repo_root)
    console = Console(stderr=True)

    requested = (args.levels.split(",") if args.levels else default_levels(accounts))
    labels = [s.strip().upper() for s in requested if s.strip()]
    registry = SCENARIOS[accounts]

    ctx: RunContext | None = None
    try:
        preflight(menv, sched, args.provider)
        console.print("[dim]" + "  ".join(
            f"{l}={menv.email(l)}" for l in menv.labels) +
            f"  provider: {args.provider}[/]")
        if args.dry_run:
            console.print(f"[bold]accounts={accounts} scenarios:[/] {labels}")
            return 0

        ctx = hermetic_setup(menv, d1, sched, cal, accounts)
        console.print(f"[dim]isolated week: Monday {ctx.monday.isoformat()}[/]")

        results: list[ScenarioResult] = []
        for label in labels:
            fn = registry.get(label)
            if fn is None:
                console.print(f"[yellow]skip unknown scenario {label} "
                              f"(accounts={accounts})[/]")
                continue
            console.print(f"[bold]{label} starting...[/]")
            result = run_scenario(label, fn, ctx)
            results.append(result)
            tag = "PASS" if result.passed else "FAIL"
            console.print(f"  {label}: {tag}  ({result.elapsed_seconds:.1f}s)  {result.notes}")

        genuine_pass = sum(1 for r in results if r.passed and not r.skipped)
        skipped = sum(1 for r in results if r.skipped)
        console.print(f"TOTAL pass={genuine_pass} skipped={skipped} of {len(results)}")
        code = compute_exit_code(results)
        if code == 2:
            console.print(
                "[bold yellow]ALL SCENARIOS SKIPPED[/] — the live owned-meetings "
                "path was never exercised (feature OFF, or accounts not re-consented "
                "to calendar.freebusy / calendar.acls). This is NOT a pass."
            )
        return code
    finally:
        if ctx is not None:
            hermetic_teardown(ctx)
        for c in cal.values():
            c.close()
        for s in sched.values():
            s.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Multi-account meeting smoke harness")
    parser.add_argument(
        "--accounts", type=int, choices=(2, 3), default=2,
        help="Number of accounts/topology mode: 2 (B,C — default) or 3 (A,B,C)",
    )
    parser.add_argument(
        "--levels",
        default="",
        help="Comma-separated scenario labels. Default depends on --accounts: "
             "2 → 2A,2B,2C,2D,2E,2F; 3 → M1,M2,M3.",
    )
    parser.add_argument(
        "--provider", choices=list(_smoke_lib.PROVIDERS),
        default=os.environ.get("SMOKE_PROVIDER") or "google",
        help="Calendar provider every active account is signed in under "
             "(default: $SMOKE_PROVIDER or google). microsoft drives Graph "
             "for every account; there is no mixed-provider mode. Requires "
             "a work tenant — see the module docstring's Microsoft paragraph.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print selected scenarios and exit without making network calls",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run pure-function tests only (no network)",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    if args.self_test:
        return self_test()
    return run_live(args)


if __name__ == "__main__":
    sys.exit(main())
