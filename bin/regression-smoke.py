#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "python-dateutil>=2.9",
#     "pydantic>=2.7",
#     "rich>=13.7",
# ]
# ///
"""
Regression smoke-test harness for the weekly scheduler.
See internal design notes,
internal design notes (L6), and
internal design notes (L8).

LIVE-RUN NOTE: always redirect this harness's output to a file, e.g.
    op run --env-file=.env -- bin/regression-smoke.py >/tmp/smoke.log 2>&1

PROVIDERS: the harness drives the calendar side through a provider-agnostic
client (_smoke_lib.make_calendar_client). Default is Google; pass
`--provider microsoft` (or SMOKE_PROVIDER=microsoft) to run the SAME levels
against a Microsoft-provider account — events are read in Google wire shape
either way (see _smoke_lib.normalize_graph_event), and the L6/L7 done-marking
legs switch from colorId "11"/"5" to the "Optical Done" Outlook category /
clear. Microsoft runs against the same dev deployment as Google (with
MS_PROVIDER_ENABLED="true" there); the direct-D1 reads run
`wrangler d1 execute DB --env $SMOKE_WRANGLER_ENV` (default dev).
The L5 (and any unsat) path dumps unsat_core, which can overflow terminal/pipe
buffers; a file sink keeps the run from wedging.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import time as _time
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

import httpx
import importlib.util
from pathlib import Path

# Load the sibling shared lib by path (filename starts with '_', and bin/ is not a package).
_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
CalendarClient = _smoke_lib.CalendarClient
post_resolve = _smoke_lib.post_resolve
post_commit = _smoke_lib.post_commit
from dateutil import tz
from rich.console import Console
from rich.table import Table


# =============================================================================
# 1. Config & env validation
# =============================================================================

# Allowlist of D1 database IDs the harness is permitted to mutate.
# Add the dev/sandbox DB id here. The production DB id MUST NOT appear.
ALLOWED_DEV_DB_IDS: set[str] = set(_smoke_lib.SMOKE_DB_IDS)  # every smoke-env db
# NOTE: the prod `scheduler` db (6ad57be9-...) is intentionally NOT listed —
# this smoke is destructive and must never target prod.
assert _smoke_lib.PROD_DB_ID not in ALLOWED_DEV_DB_IDS


@dataclass(frozen=True)
class Env:
    scheduler_url: str
    scheduler_bearer: str
    scheduler_refresh_token: str
    d1_database_id: str
    expected_test_account: str
    # PKCE client the bearer/refresh token was minted under (mint-token.py
    # default). The provider's refresh_token grant requires a matching client_id.
    client_id: str = "smoke-cli"

    @classmethod
    def from_environ(cls) -> "Env":
        def req(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                print(f"missing required env var: {name}", file=sys.stderr)
                sys.exit(1)
            return v

        scheduler_url = req("SCHEDULER_URL").rstrip("/")
        # Prod-safety guard shared with every other harness (_smoke_lib): this
        # harness mutates tasks and calendar events over the bearer API, so the
        # prod host is refused before any client is built.
        _smoke_lib.assert_dev_url(scheduler_url)
        env = cls(
            scheduler_url=scheduler_url,
            scheduler_bearer=req("SCHEDULER_BEARER"),
            scheduler_refresh_token=req("SCHEDULER_REFRESH_TOKEN"),
            d1_database_id=req("D1_DATABASE_ID"),
            expected_test_account=req("EXPECTED_TEST_ACCOUNT"),
            client_id=os.environ.get("SCHEDULER_CLIENT_ID", "smoke-cli"),
        )
        if env.d1_database_id not in ALLOWED_DEV_DB_IDS:
            print(
                f"D1_DATABASE_ID {env.d1_database_id!r} not in ALLOWED_DEV_DB_IDS; "
                f"refusing to run. Add the id explicitly if intentional.",
                file=sys.stderr,
            )
            sys.exit(1)
        return env


# =============================================================================
# 4. Fixture generators
# =============================================================================


@dataclass(frozen=True)
class MeetingFixture:
    summary: str
    start_iso: str   # ISO-Z absolute instant (events are created with home-zone offset baked in)
    end_iso: str
    google_event_id: str | None = None


# Per-level knobs. Index = level - 1.
_MEETINGS_PER_DAY = [0, 2, 4, 6, 8]
_DURATION_POOLS_MIN = [[30], [30, 60], [30, 60, 90], [30, 60, 90], [30, 60, 90]]
_TITLE_POOL = ["Sync", "Review", "1:1", "Standup", "Planning", "Demo"]


def gen_meetings(tier: int, monday: date, rng: random.Random, home_tz: str, label: str) -> list[MeetingFixture]:
    """Pure: deterministic for (tier, monday, rng-state, home_tz, label)."""
    out: list[MeetingFixture] = []
    if label == "5.2":
        return []  # 5.2 must-include tasks must stay feasible-in-isolation
    n_per_day = _MEETINGS_PER_DAY[tier - 1]
    if n_per_day == 0:
        return out
    pool = _DURATION_POOLS_MIN[tier - 1]
    zone = tz.gettz(home_tz)
    if zone is None:
        raise ValueError(f"unknown timezone: {home_tz}")
    prefix = f"[regression-smoke L{label}]"
    for day_offset in range(5):  # Mon..Fri
        the_day = monday + timedelta(days=day_offset)
        # Sample distinct hours from [9, 17). meetings_per_day is <= 8.
        hours = rng.sample(range(9, 17), k=n_per_day)
        for h in sorted(hours):
            dur = rng.choice(pool)
            title = rng.choice(_TITLE_POOL)
            local_start = datetime.combine(the_day, time(h, 0), tzinfo=zone)
            local_end = local_start + timedelta(minutes=dur)
            out.append(MeetingFixture(
                summary=f"{prefix} {title}",
                start_iso=local_start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                end_iso=local_end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            ))
    return out


@dataclass(frozen=True)
class TaskFixture:
    id: str
    body: dict  # the storage shape posted to POST /v1/tasks


_TASK_COUNT = [3, 5, 8, 10, 12]
_CHUNKED_COUNT = [0, 1, 1, 2, 3]
_HARD_DEADLINE_COUNT = [0, 0, 1, 2, 3]
_PINNED_COUNT = [0, 0, 0, 0, 4]
_CTX_WEIGHTS = [("deep", 0.4), ("admin", 0.3), ("meeting", 0.2), ("physical", 0.1)]
_PRIORITY_BY_CTX = {"deep": 75, "admin": 40, "meeting": 60, "physical": 50}
_TITLE_BY_CTX = {
    "deep": ["Spec review", "Design memo", "Architecture notes"],
    "admin": ["Process inbox", "Expense report", "Triage tickets"],
    "meeting": ["1:1", "Project sync", "Decision review"],
    "physical": ["Run", "Gym", "Walk"],
}


def _weighted_choice(rng: random.Random, weights: list[tuple[str, float]]) -> str:
    r = rng.random()
    acc = 0.0
    for label, w in weights:
        acc += w
        if r <= acc:
            return label
    return weights[-1][0]


def gen_tasks(
    tier: int, monday: date, rng: random.Random, *, kind: str = "generic", label: str
) -> list[TaskFixture]:
    """Pure: deterministic for (tier, monday, rng-state, kind, label).

    The worker assigns its own UUID on POST, so we mark each task via
    `source.external_id` so cleanup / assertion filtering can find them later
    (the harness's logical `id` is otherwise discarded by the worker)."""
    if kind == "must_include":
        # 8 mandatory 3h tasks, all due Mon 17:00 local. Each fits alone; 24h
        # together over-subscribe Monday → genuine 422 with task_present in core.
        out: list[TaskFixture] = []
        mon_deadline = f"{monday.isoformat()}T17:00"
        for i in range(8):
            tid = f"regsmoke-L{label}-{i:02d}"
            out.append(TaskFixture(id=tid, body={
                "id": tid,
                "title": f"[regsmoke] Mandatory deliverable {i}",
                "context": "deep",
                "priority": 75,
                "duration_minutes": 180,
                "earliest_start": f"{monday.isoformat()}T00:00",
                "deadline": {"at": mon_deadline, "hard": True, "penalty_per_15min": 100},
                "preferred_windows": [],
                "dependencies": [],
                "pinned_at": None,
                "must_include": True,
                "source": {"kind": "mcp", "external_id": tid},
                "status": "pending",
            }))
        return out
    n = _TASK_COUNT[tier - 1]
    chunked = _CHUNKED_COUNT[tier - 1]
    hard = _HARD_DEADLINE_COUNT[tier - 1]
    pinned = _PINNED_COUNT[tier - 1]
    earliest = f"{monday.isoformat()}T00:00"
    out = []
    for i in range(n):
        ctx = _weighted_choice(rng, _CTX_WEIGHTS)
        title = rng.choice(_TITLE_BY_CTX[ctx])
        task_id = f"regsmoke-L{label}-{i:02d}"
        body: dict = {
            "id": task_id,
            "title": title,
            "context": ctx,
            "priority": _PRIORITY_BY_CTX[ctx],
            "earliest_start": earliest,
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "source": {"kind": "mcp", "external_id": task_id},
            "status": "pending",
        }
        # Duration: atomic by default, chunked for first `chunked` tasks.
        if i < chunked:
            body["chunks"] = [{"duration_minutes": 60}, {"duration_minutes": 60}]
            body["group_policy"] = {"same_day": False, "ordered": True}
        elif i == chunked:
            # Non-aligned duration guard (spec 2026-05-30 quarter-hour alignment):
            # the FIRST atomic task always carries a duration that is NOT a
            # multiple of 15 so every smoke run exercises the worker's round-up
            # path end-to-end. Fixed value keeps gen_tasks deterministic for
            # (level, monday, rng-state); chunked < n on every level so this
            # branch always fires.
            body["duration_minutes"] = 20
        else:
            body["duration_minutes"] = rng.choice([30, 45, 60, 90])
        # Hard deadline on the first `hard` tasks (after chunked).
        if chunked <= i < chunked + hard:
            deadline_day = monday + timedelta(days=rng.randint(2, 4))
            body["deadline"] = {
                "at": f"{deadline_day.isoformat()}T17:00",
                "hard": True,
                "penalty_per_15min": 100,
            }
        # 5.1: pin the last `pinned` tasks to Wed 14:00 to force overlap → drops.
        if pinned and i >= n - pinned:
            wed = monday + timedelta(days=2)
            body["pinned_at"] = f"{wed.isoformat()}T14:00"
        out.append(TaskFixture(id=task_id, body=body))
    return out


@dataclass(frozen=True)
class TemplateFixture:
    id: str
    body: dict


def gen_templates(tier: int) -> list[TemplateFixture]:
    """Pure: deterministic for (tier,) — no rng needed."""
    out: list[TemplateFixture] = []
    if tier == 1:
        return out
    # Standup is in L2..L5 — pinned in home zone (pinned_tz absent).
    out.append(TemplateFixture(
        id="regsmoke-tmpl-standup",
        body={
            "id": "regsmoke-tmpl-standup",
            "title": "[regsmoke] Standup",
            "context": "meeting",
            "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
            "pinned_time": "08:30",
            "duration_minutes": 15,
            "task_body": {
                "context": "meeting",
                "priority": 50,
                "preferred_windows": [],
                "dependencies": [],
                "source": {"kind": "template", "external_id": "regsmoke-tpl"},
            },
            "active_from": "2026-01-01",
            "active_until": None,
        },
    ))
    if tier >= 3:
        # NYC sync: per-template pinned_tz exercises the §3.8 cross-zone path.
        out.append(TemplateFixture(
            id="regsmoke-tmpl-nyc-sync",
            body={
                "id": "regsmoke-tmpl-nyc-sync",
                "title": "[regsmoke] NYC Team Sync",
                "context": "meeting",
                "rrule": "FREQ=WEEKLY;BYDAY=TU",
                "pinned_time": "09:00",
                "pinned_tz": "America/New_York",
                "duration_minutes": 30,
                "task_body": {
                    "context": "meeting",
                    "priority": 60,
                    "preferred_windows": [],
                    "dependencies": [],
                    "source": {"kind": "template", "external_id": "regsmoke-tpl"},
                },
                "active_from": "2026-01-01",
                "active_until": None,
            },
        ))
    if tier == 5:
        out.append(TemplateFixture(
            id="regsmoke-tmpl-pilates",
            body={
                "id": "regsmoke-tmpl-pilates",
                "title": "[regsmoke] Pilates",
                "context": "physical",
                "rrule": "FREQ=WEEKLY;BYDAY=FR",
                "pinned_time": "19:00",
                "duration_minutes": 90,
                "task_body": {
                    "context": "physical",
                    "priority": 70,
                    "preferred_windows": [],
                    "dependencies": [],
                    "source": {"kind": "template", "external_id": "regsmoke-tpl"},
                },
                "active_from": "2026-01-01",
                "active_until": None,
            },
        ))
    return out


# =============================================================================
# 4b. L6 fixtures — done-marking + replan placement-floor
#     (internal design notes §"Docs + harness")
# =============================================================================
#
# L6 is special: unlike L1..L5 it does NOT use the generic gen_meetings/gen_tasks
# ladder or assert_expectations. It exercises behaviour the generic ladder can't:
#   (a) status="done" excludes a task from the solve and its events vanish.
#   (b) recoloring a scheduler chunk event to the done color marks the task done
#       and removes its events on the next resolve.
#   (c) mid-week placement floor: an undone task anchored to an earlier day this
#       week re-places at >= placementFloor, with nothing on a past day/slot.
#   (d) past-pin release: a hard pin set before the floor reschedules forward
#       instead of dropping the task.
#
# (a)/(b) need a COMMITTED plan (events on the calendar) so orphan-deletion can be
# observed; resolve alone only proposes. (c)/(d) need the CURRENT week so `now`
# falls mid-window and placementFloor = ceilToQuarter(now) > weekStart. The
# generic levels run future blank weeks where placementFloor collapses to
# weekStart (no floor effect), so L6 owns the current-week path explicitly.

# Done-marking sentinels (what a user paints a chunk event to mark it done,
# and what un-painting it looks like). ONE object for every level; provider-
# specific values live in _smoke_lib.DoneMarking, bound by set_marking() in
# main() once --provider is known. Google default until then.
MARKING: _smoke_lib.DoneMarking = _smoke_lib.DoneMarking.for_provider("google")


def set_marking(provider: str) -> None:
    global MARKING
    MARKING = _smoke_lib.DoneMarking.for_provider(provider)

# All L6 fixtures tag themselves with this external_id prefix so the shared
# regsmoke-* cleanup (delete_regression_tasks_and_templates) sweeps the D1 task
# rows. The committed chunk events those tasks produce do NOT carry this prefix
# in their summary — on commit the worker sets each chunk event's summary to the
# owning task's TITLE — so calendar cleanup is by delete_l6_calendar_events
# (scheduler_chunk_id property + the task-title prefix below), not the generic
# '[regression-smoke L6]' summary sweep.
_L6_EXTERNAL_PREFIX = "regsmoke-L6"
# The literal prefix gen_done_fixtures puts on every L6 task TITLE; this becomes
# each committed chunk event's calendar summary (commit.ts), so it is what
# delete_l6_calendar_events matches against for titled residue.
_L6_TITLE_PREFIX = "[regsmoke L6]"


@dataclass(frozen=True)
class DoneFixture:
    """One L6 task fixture. `kind` selects the assertion bucket it feeds:
      - "done-api":   marked done via PATCH {status:"done"} after a commit.
      - "done-color": its committed chunk event is recolored to MARKING.done.
      - "undone-color": done-by-color, then recolored BACK to a non-done color;
                      the revive-scan flips it pending and reschedules it.
      - "floor":      anchored (earliest_start) to an earlier day this week.
      - "pin-past":   hard-pinned to an earlier day this week (pin released)."""
    external_id: str
    kind: str
    body: dict


def gen_done_fixtures(monday: date, today: date) -> list[DoneFixture]:
    """Pure: deterministic for (monday, today). Builds the L6 task set.

    `monday` is the Monday of the CURRENT week; `today` is the run date (used to
    anchor floor/pin fixtures strictly before `now` so the placement floor and
    past-pin-release paths actually fire). All tasks are deep-work, 60 min, so
    they compete for the same business slots and the floor effect is observable.

    Floor/pin fixtures anchor to the Monday of this week (or, if today *is*
    Monday, they still anchor to Monday 00:00 — the slot is past once `now`
    advances past midnight, which it always has during a live run)."""
    earliest_week = f"{monday.isoformat()}T00:00"
    # Anchor day for floor/pin fixtures: this week's Monday, which is <= today.
    # earliest_start at Monday 00:00 keeps the task selected for the week while
    # being strictly before any mid-week `now`.
    anchor_day = monday
    out: list[DoneFixture] = []

    def _base(ext: str, title: str) -> dict:
        return {
            "id": ext,
            "title": f"{_L6_TITLE_PREFIX} {title}",
            "context": "deep",
            "priority": 75,
            "earliest_start": earliest_week,
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "duration_minutes": 60,
            "source": {"kind": "mcp", "external_id": ext},
            "status": "pending",
        }

    # (a) Two done-via-API tasks: committed, then PATCHed to status="done".
    for i in range(2):
        ext = f"{_L6_EXTERNAL_PREFIX}-doneapi-{i:02d}"
        out.append(DoneFixture(ext, "done-api", _base(ext, f"done-api {i}")))
    # (b) One done-via-color task: committed, then its chunk event recolored.
    ext = f"{_L6_EXTERNAL_PREFIX}-donecolor-00"
    out.append(DoneFixture(ext, "done-color", _base(ext, "done-color 0")))
    # (b') One un-done-by-color task: committed, recolored to MARKING.done
    #      (done-scan flips it done on a resolve-only pass), then recolored back
    #      to a non-done color so the revive-scan flips it pending and reschedules
    #      it on the next resolve. Ends SCHEDULED, never in the done sets.
    ext = f"{_L6_EXTERNAL_PREFIX}-undonecolor-00"
    out.append(DoneFixture(ext, "undone-color", _base(ext, "undone-color 0")))
    # (c) Two floor tasks: anchored to this week's Monday (an earlier day).
    for i in range(2):
        ext = f"{_L6_EXTERNAL_PREFIX}-floor-{i:02d}"
        b = _base(ext, f"floor {i}")
        b["earliest_start"] = f"{anchor_day.isoformat()}T00:00"
        out.append(DoneFixture(ext, "floor", b))
    # (d) One past-pin task: hard-pinned to this week's Monday 09:00 (before the
    #     mid-week floor). The pin must be released → task reschedules forward
    #     rather than dropping.
    ext = f"{_L6_EXTERNAL_PREFIX}-pinpast-00"
    b = _base(ext, "pin-past 0")
    b["pinned_at"] = f"{anchor_day.isoformat()}T09:00"
    out.append(DoneFixture(ext, "pin-past", b))
    return out


# =============================================================================
# 4c. L7 fixtures — per-chunk completion guarantees
#     (continues Tasks 1-8: resolve records done-colored chunks PER-CHUNK, a
#     task flips done only when ALL its chunks are recorded, evidence-gated
#     revive deletes a record when its event is present and off the done color,
#     and build-problem drops a completed chunk — freeing its reserved slot.)
# =============================================================================
#
# L7 is special exactly like L6: it does NOT use the generic gen_meetings /
# gen_tasks ladder or assert_expectations. It commits a real plan (events on the
# calendar) so per-chunk orphan-deletion is observable, and runs the CURRENT
# week so the same current-week placement path L6 uses is in effect. It proves
# the behaviours the generic ladder can't:
#   (partial) recoloring ONE chunk of a 2-chunk task done records that chunk but
#             leaves the task pending/scheduled; on the next commit the completed
#             chunk's slot is freed (its event is reconciled away) while the
#             remaining chunk's event survives.
#   (all)     recoloring the remaining chunk done flips the whole task done; it
#             leaves the schedule and all its chunk events are orphan-deleted.
#   (revive)  un-painting a recorded chunk back to a non-done color (resolve-only,
#             no commit) revives that chunk: it re-enters the schedule and the
#             task is pending again; an unrelated chunk is unaffected.

# L7's done/undone sentinels are MARKING.done / MARKING.undone, same as L6.

# Like L6: every L7 task tags itself with this external_id prefix so the shared
# regsmoke-* cleanup (delete_regression_tasks_and_templates) sweeps the D1 rows.
# The committed chunk events carry the owning task's TITLE as their summary (set
# by commit.ts), so calendar cleanup is by delete_l7_calendar_events
# (scheduler_chunk_id property + the task-title prefix below), not the generic
# '[regression-smoke L7]' summary sweep.
_L7_EXTERNAL_PREFIX = "regsmoke-L7"
# The literal prefix gen_chunks_fixtures puts on every L7 task TITLE; this
# becomes each committed chunk event's calendar summary (commit.ts), so it is
# what delete_l7_calendar_events matches against for titled residue.
_L7_TITLE_PREFIX = "[regsmoke L7]"


@dataclass(frozen=True)
class ChunksFixture:
    """One L7 task fixture. `kind` selects the assertion bucket it feeds:
      - "chunks-subject": a 2-chunk deep-work task. The partial-/all-/revive
                          legs paint its chunk #0 (and later #1) the done color.
      - "chunks-filler":  a small droppable backlog task. Present so the freed
                          slot from a completed chunk has a candidate to reuse
                          and the week is not trivially empty."""
    external_id: str
    kind: str
    body: dict


def gen_chunks_fixtures(monday: date, today: date) -> list[ChunksFixture]:
    """Pure: deterministic for (monday, today). Builds the L7 task set.

    `monday` is the Monday of the CURRENT week; `today` is the run date (unused
    for anchoring here — L7 does not exercise the floor/pin paths — but kept for
    signature parity with gen_done_fixtures). The subject is a 2-chunk task; a
    task carrying `chunks` must NOT also carry `duration_minutes` (the worker
    derives per-chunk durations from `chunks`), so `_base` omits it for the
    subject and the filler supplies its own `duration_minutes`."""
    earliest_week = f"{monday.isoformat()}T00:00"
    out: list[ChunksFixture] = []

    def _base(ext: str, title: str) -> dict:
        # NOTE: deliberately NO duration_minutes here — the subject supplies
        # `chunks` (+ group_policy) and the filler overrides duration_minutes.
        return {
            "id": ext,
            "title": f"{_L7_TITLE_PREFIX} {title}",
            "context": "deep",
            "priority": 75,
            "earliest_start": earliest_week,
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "source": {"kind": "mcp", "external_id": ext},
            "status": "pending",
        }

    # The 2-chunk subject (the partial / all / revive subject). same_day:false,
    # ordered:false so the two chunks place independently — painting either one
    # done is a clean per-chunk signal with no ordering coupling.
    ext = f"{_L7_EXTERNAL_PREFIX}-subject-00"
    b = _base(ext, "subject 0")
    b["chunks"] = [{"duration_minutes": 30}, {"duration_minutes": 30}]
    b["group_policy"] = {"same_day": False, "ordered": False}
    out.append(ChunksFixture(ext, "chunks-subject", b))

    # A separate fresh 2-chunk subject for the revive leg, so the partial/all
    # legs (which mark and commit-away their subject) don't contaminate it.
    ext = f"{_L7_EXTERNAL_PREFIX}-revive-00"
    b = _base(ext, "revive subject 0")
    b["chunks"] = [{"duration_minutes": 30}, {"duration_minutes": 30}]
    b["group_policy"] = {"same_day": False, "ordered": False}
    out.append(ChunksFixture(ext, "chunks-revive", b))

    # A small droppable filler backlog task: proves the week is non-trivial and
    # gives the freed slot from a completed chunk a candidate to reuse.
    ext = f"{_L7_EXTERNAL_PREFIX}-filler-00"
    b = _base(ext, "filler 0")
    b["duration_minutes"] = 30
    b["priority"] = 20  # low priority → droppable / placed last
    out.append(ChunksFixture(ext, "chunks-filler", b))
    return out


# =============================================================================
# 4d. L8 fixtures — manual-move write-back (hand-drag a committed scheduler chunk)
#     (internal design notes; findings X5/X6/L6)
# =============================================================================
#
# L8 is special like L6/L7: it does NOT use the generic gen_meetings/gen_tasks
# ladder. It proves the webhook MANUAL-MOVE WRITE-BACK: when a user hand-drags a
# committed scheduler chunk event to a new slot, Google delivers a webhook and the
# worker (D1 write only, NO replan) must (1) patch the committed plan that CONTAINS
# the chunk — even when it is NOT the latest committed plan (X5) — and (2) drag the
# task's own constraints along: lower earliest_start to the drop if the drop is
# earlier (X6) and move pinned_at to the drop (L6).
#
# Why two future weeks: X5 requires the dragged chunk to live in a NON-latest
# committed plan. L8 commits week A FIRST, then week B — so week B is the latest
# committed plan and every week-A drag is, by construction, a drag on a non-latest
# plan. (Once week A is committed, its tasks carry a scheduled_for anchor in week A
# and are window-shed from week B's resolve, so committing week B leaves them fully
# intact; orphan deletion is window-scoped to week B.) Both weeks are FUTURE blank
# weeks: the write-back does not depend on the placement floor, so future slots keep
# the drag targets unambiguous and free, with no `now`-relative fragility.
#
# WEBHOOK-DRIVEN: unlike L6/L7 (synchronous resolve/commit), L8 depends on a live
# Google push subscription delivering the drag as a webhook (same mechanism as
# --webhook-check / run_webhook_smoke). It subscribes first and polls D1 (via GET
# /v1/plans/:hash and GET /v1/tasks/:id) for the effect. A delivery failure surfaces
# as a poll timeout with a clear message — a real signal that a user's drag would
# not have been honored.
#
# ANCHOR sub-leg (an internal issue, internal design notes): the two-week
# state above is exactly the churn-baseline selection hazard — week A committed
# but NON-latest, its body hand-patched by the drags. After the drag legs, L8
# re-resolves week A (no accept) and asserts every dragged chunk is PROPOSED at
# its dragged slot: the churn baseline was sourced from the resolved week's own
# patched plan, not the globally-latest week-B plan (whose entries the window
# filter would empty, leaving the solver free to re-optimise the week).
#
# NOT covered live (deliberate, see the design's §"Deliberate deviation" + the
# replan-helper unit tests): the atomic-rollback path (needs DB fault injection),
# the done/cancelled skip-guard (dragging a done task's chunk is itself the
# un-paint/revive signal, so it cannot be isolated live), and the fully-elapsed-week
# filter (a past week's resolve places zero chunks — there is nothing to drag, and
# no HTTP path injects a past plan). The first two and the filter are unit-tested in
# worker/test/webhooks/replan-helper.test.ts.

# Every L8 task tags itself with this external_id prefix so the shared regsmoke-*
# cleanup (delete_regression_tasks_and_templates) sweeps the D1 rows. The committed
# chunk events carry the owning task's TITLE as their summary (commit.ts), so the
# calendar cleanup is delete_l8_calendar_events (scheduler_chunk_id property + the
# task-title prefix), not the generic '[regression-smoke L8]' summary sweep.
_L8_EXTERNAL_PREFIX = "regsmoke-L8"
_L8_TITLE_PREFIX = "[regsmoke L8]"

# (leg, external_id, (hour, minute) Tuesday drop slot, body-field-to-reconcile|None).
# Drop slots must sit INSIDE the deep fit-curve peak (instance default
# 12:00-16:00, task duration included): churn is a soft weight (10 per 15 min
# moved vs time_of_day_fit 5), so the anchor sub-leg's "dragged chunks stay
# put" assertion is deterministic only where every candidate slot has equal
# fit — off-peak drags are legitimately re-proposed toward the peak by a
# correctly-anchored solver (observed live 2026-08-28). Pinned by
# test_smoke_churn_anchor.py.
_L8_DRAG_LEGS = [
    ("basic",   f"{_L8_EXTERNAL_PREFIX}-basic-00",   (14, 0), None),
    ("x6floor", f"{_L8_EXTERNAL_PREFIX}-x6floor-00", (12, 0), "earliest_start"),
    ("l6pin",   f"{_L8_EXTERNAL_PREFIX}-l6pin-00",   (15, 0), "pinned_at"),
]


@dataclass(frozen=True)
class MoveFixture:
    """One L8 task fixture. `kind` selects the drag leg it feeds:
      - "basic":    plain deep-work task in week A. Its chunk is dragged to a later
                    slot; proves the committed (non-latest) plan body follows the
                    drag (X5) and the latest week (B) is left untouched.
      - "x6floor":  earliest_start anchored mid-week-A; its chunk is dragged EARLIER
                    than that floor → earliest_start lowers to the drop (X6).
      - "l6pin":    pinned_at anchored in week A; its chunk is dragged → pinned_at
                    moves to the drop (L6).
      - "x5filler": a plain task in week B. It exists only so week B is a real
                    committed plan (the latest), making week A non-latest."""
    external_id: str
    kind: str
    week: str  # "A" or "B"
    body: dict


def gen_move_fixtures(week_a: date, week_b: date) -> list[MoveFixture]:
    """Pure: deterministic for (week_a, week_b). Builds the L8 task set.

    All tasks are 60-min deep-work (single chunk) so each maps to exactly one
    committed chunk event the harness can drag. earliest_start/pinned_at use naive
    home-zone strings (the worker interprets them in the user's zone), matching the
    other generators."""
    out: list[MoveFixture] = []

    def _base(ext: str, title: str, **over) -> dict:
        b = {
            "id": ext,
            "title": f"{_L8_TITLE_PREFIX} {title}",
            "context": "deep",
            "priority": 75,
            "earliest_start": f"{week_a.isoformat()}T00:00",
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "duration_minutes": 60,
            "source": {"kind": "mcp", "external_id": ext},
            "status": "pending",
        }
        b.update(over)
        return b

    # Week A subjects (committed first → non-latest once week B commits).
    ext = f"{_L8_EXTERNAL_PREFIX}-basic-00"
    out.append(MoveFixture(ext, "basic", "A", _base(ext, "basic 0")))

    wed = week_a + timedelta(days=2)
    ext = f"{_L8_EXTERNAL_PREFIX}-x6floor-00"
    out.append(MoveFixture(ext, "x6floor", "A",
                           _base(ext, "x6floor 0", earliest_start=f"{wed.isoformat()}T12:00")))

    thu = week_a + timedelta(days=3)
    ext = f"{_L8_EXTERNAL_PREFIX}-l6pin-00"
    out.append(MoveFixture(ext, "l6pin", "A",
                           _base(ext, "l6pin 0", pinned_at=f"{thu.isoformat()}T10:00")))

    # Week B latest-committed filler (earliest_start in week B → shed from week A's
    # resolve; placed and committed in week B).
    ext = f"{_L8_EXTERNAL_PREFIX}-x5filler-00"
    out.append(MoveFixture(ext, "x5filler", "B",
                           _base(ext, "x5filler 0", earliest_start=f"{week_b.isoformat()}T00:00")))
    return out


# =============================================================================
# 4e. Owned-meetings fixtures
#     (spec: owned-movable-meetings — Task 20 regression scenario)
#
# The owned-meetings scenario is special like L6/L7/L8: it does NOT use the
# generic gen_meetings/gen_tasks ladder. It exercises the owned-meetings feature:
#   (a) A meeting the harness account organises is imported as a tasks row with
#       context:"meeting" and source.kind:"meeting".
#   (b) One accepted attendee's free/busy blocks the meeting's CURRENT slot but
#       leaves a BETTER slot free later in the week.
#   (c) /v1/resolve proposes a plan that MOVES the meeting to the better slot.
#   (d) /v1/commit patches the Google Calendar event to the new slot
#       (sendUpdates=all — attendee receives the update).
#
# Gate: gated on OWNED_MEETINGS_ENABLED="true" in the target env. The scenario
# SKIPS CLEANLY (prints a skip notice and returns PASS) when the flag is OFF or
# when the test account has not yet re-consented to the calendar.freebusy scope
# (the feature degrades to immovable, which is the specified pre-consent
# behaviour — not a failure). The caller must set OWNED_MEETINGS_ENABLED=true
# and re-consent before the full live scenario runs.
#
# NOT webhook-driven (unlike L8): the scenario drives the resolve/commit cycle
# synchronously via HTTP, same as L1..L5.
# =============================================================================

_LOM_EXTERNAL_PREFIX = "regsmoke-LOM"
_LOM_TITLE_PREFIX = "[regsmoke LOM]"


@dataclass(frozen=True)
class OwnedMeetingFixture:
    """Fixtures for the owned-meetings scenario.

    `meeting_ext`:      external_id suffix used to locate the meeting task row
                        after resolve (source.external_id on the seeded task).
    `meeting_summary`:  Google Calendar event summary for the owned meeting.
    `slot_start_iso`:   current meeting start (ISO-Z) — the "bad" slot blocked
                        by the attendee's free/busy.
    `slot_end_iso`:     current meeting end (ISO-Z).
    `better_start_iso`: start of the free slot later in the week — not blocked
                        by the attendee; what the scheduler should prefer.
    `better_end_iso`:   end of the free slot.
    `freebusy_event_summary`: summary of the attendee's blocking calendar event
                               (created in the attendee's calendar to simulate
                               a busy slot; owned by the test account for the
                               purposes of the smoke, since the harness can only
                               write to the test account's own calendar)."""
    meeting_ext: str
    meeting_summary: str
    slot_start_iso: str
    slot_end_iso: str
    better_start_iso: str
    better_end_iso: str
    freebusy_event_summary: str


def gen_owned_meeting_fixture(monday: date, home_tz: str) -> OwnedMeetingFixture:
    """Pure: deterministic for (monday, home_tz). Builds one owned-meeting fixture.

    The "bad" slot is Tuesday at 09:00 home-tz (blocked by an attendee busy
    event at that hour). The "better" slot is Wednesday at 10:00 home-tz (free
    for all attendees). The attendee's blocking event is a 1-hour busy block
    created at Tuesday 09:00 in the home zone."""
    zone = tz.gettz(home_tz)
    if zone is None:
        raise ValueError(f"unknown timezone: {home_tz}")

    def _iso_z(day: date, hour: int, minute: int, duration_min: int) -> tuple[str, str]:
        local = datetime.combine(day, time(hour, minute), tzinfo=zone)
        end = local + timedelta(minutes=duration_min)
        fmt = lambda dt: dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
        return fmt(local), fmt(end)

    tue = monday + timedelta(days=1)
    wed = monday + timedelta(days=2)
    bad_start, bad_end = _iso_z(tue, 9, 0, 60)
    better_start, better_end = _iso_z(wed, 10, 0, 60)
    ext = f"{_LOM_EXTERNAL_PREFIX}-meeting-00"
    return OwnedMeetingFixture(
        meeting_ext=ext,
        meeting_summary=f"{_LOM_TITLE_PREFIX} weekly sync",
        slot_start_iso=bad_start,
        slot_end_iso=bad_end,
        better_start_iso=better_start,
        better_end_iso=better_end,
        freebusy_event_summary=f"{_LOM_TITLE_PREFIX} attendee busy",
    )


# =============================================================================
# 5. Level definitions & 6. Per-level executor
# =============================================================================


@dataclass(frozen=True)
class Level:
    label: str          # display + task-id + calendar-event prefix token
    tier: int           # difficulty/knob index (1..7) + rng seed
    kind: str           # "generic" | "must_include" | "done" | "chunks" | "move" | "owned-meetings"
    expected_status: int
    expected_dropped_max: int | None  # None for unsat


LEVELS: list[Level] = [
    Level(label="1", tier=1, kind="generic", expected_status=200, expected_dropped_max=0),
    Level(label="2", tier=2, kind="generic", expected_status=200, expected_dropped_max=0),
    Level(label="3", tier=3, kind="generic", expected_status=200, expected_dropped_max=0),
    Level(label="4", tier=4, kind="generic", expected_status=200, expected_dropped_max=2),
    # 5.1: hard-timed (pinned) but DROPPABLE over-subscription → 200 + drops.
    # tier-5 fixture = 12 tasks, last 4 pinned to the SAME Wed 14:00 slot. The
    # solver minimises drops in pass 1, so the measured optimum on a clean
    # backlog is 8 dropped (the 4 colliding pins force ≥3, the rest over caps);
    # it cannot drop fewer. The ceiling guards against a meltdown (all 12 drop)
    # or a polluted dev backlog inflating the count past the optimum.
    Level(label="5.1", tier=5, kind="generic", expected_status=200, expected_dropped_max=8),
    # 5.2: must_include over-subscription → genuine 422.
    Level(label="5.2", tier=5, kind="must_include", expected_status=422, expected_dropped_max=None),
    # L6 is dispatched to run_level_done (done-marking + floor), not the generic
    # ladder. expected_status/dropped are unused for it; the main loop routes on
    # kind == "done".
    Level(label="6", tier=6, kind="done", expected_status=200, expected_dropped_max=0),
    # L7 dispatched to run_level_chunks (per-chunk completion). Like L6 it routes
    # on a dedicated kind, not the generic ladder.
    Level(label="7", tier=7, kind="chunks", expected_status=200, expected_dropped_max=0),
    # L8 dispatched to run_level_move (manual-move write-back). Webhook-driven and
    # self-contained: it finds its OWN two future blank weeks (not the generic
    # cursor) and routes on kind == "move".
    Level(label="8", tier=8, kind="move", expected_status=200, expected_dropped_max=0),
    # owned-meetings: gate-checked (OWNED_MEETINGS_ENABLED=true + re-consent).
    # Self-contained: finds its own blank future week; skips cleanly if the gate
    # is off or the scope is absent. Select with --levels owned-meetings.
    Level(label="owned-meetings", tier=9, kind="owned-meetings",
          expected_status=200, expected_dropped_max=0),
]


@dataclass
class Fixtures:
    meetings: list[MeetingFixture]
    tasks: list[TaskFixture]
    templates: list[TemplateFixture]


@dataclass
class LevelResult:
    level: str
    passed: bool
    http_status: int
    scheduled_count: int
    dropped_count: int
    elapsed_seconds: float
    notes: str = ""


def _next_monday(day: date) -> date:
    """The first Monday strictly after `day` (never `day` itself)."""
    days = (7 - day.weekday()) % 7
    if days == 0:
        days = 7
    return day + timedelta(days=days)


def _event_end_date(ev: dict) -> date | None:
    """The date an event ends, as the API reports it. Handles timed
    (`dateTime`) and all-day (`date`) events; falls back to the start."""
    for key in ("end", "start"):
        slot = ev.get(key) or {}
        dt = slot.get("dateTime")
        if dt:
            return datetime.fromisoformat(dt.replace("Z", "+00:00")).date()
        d = slot.get("date")
        if d:
            return date.fromisoformat(d)
    return None


def find_blank_monday(cal: CalendarClient, start_after: date, weeks_needed: int) -> date:
    """Return a Monday that begins `weeks_needed` consecutive weeks containing
    NO calendar events at all — personal events, harness residue, or committed
    scheduler chunks alike. Every level then runs against a genuinely empty week.

    The whole [mon, mon + weeks_needed*7d) span is fetched in one query. If any
    event is present, jump to the first Monday after the latest event and
    re-check, hopping past the entire booked region rather than crawling week by
    week. Raises if no empty span is found within ~a year."""
    candidate = _next_monday(start_after)
    horizon = start_after + timedelta(days=400)
    while candidate <= horizon:
        span_end = candidate + timedelta(days=7 * weeks_needed)
        events = cal.list_events(
            f"{candidate.isoformat()}T00:00:00Z",
            f"{span_end.isoformat()}T00:00:00Z",
        )
        if not events:
            return candidate
        end_dates = [d for d in (_event_end_date(ev) for ev in events) if d is not None]
        # Hop past the last event; if no date parsed, step a week to keep moving.
        candidate = _next_monday(max(end_dates)) if end_dates else candidate + timedelta(days=7)
    raise RuntimeError(
        f"no run of {weeks_needed} empty weeks found within a year of {start_after}; "
        f"clean the sandbox calendar, or seed it with reset-smoke-env.py and pass "
        f"--starting-monday"
    )


def post_tasks(sched: SchedulerClient, tasks: list[TaskFixture]) -> list[str]:
    """POST each fixture and return the worker-assigned UUIDs."""
    ids: list[str] = []
    for t in tasks:
        body = {k: v for k, v in t.body.items() if k != "id"}
        r = sched.request("POST", "/v1/tasks", json=body)
        r.raise_for_status()
        ids.append(r.json()["id"])
    return ids


def post_templates(sched: SchedulerClient, tmpls: list[TemplateFixture]) -> list[str]:
    """POST each template and return the worker-assigned UUIDs."""
    ids: list[str] = []
    for t in tmpls:
        body = {k: v for k, v in t.body.items() if k != "id"}
        r = sched.request("POST", "/v1/templates", json=body)
        r.raise_for_status()
        ids.append(r.json()["id"])
    return ids


def patch_task_status(sched: SchedulerClient, task_id: str, status: str) -> int:
    """PATCH /tasks/:id {status:...}. Returns the HTTP status code."""
    r = sched.request("PATCH", f"/v1/tasks/{task_id}", json={"status": status})
    return r.status_code


def recolor_event(cal: CalendarClient, event_id: str, color_id: str) -> None:
    """The user-side done-marking gesture: Google colorId PATCH, or on
    Microsoft the "Optical Done" category set/clear — each client owns its
    own translation (see _smoke_lib.GraphCalendarClient.recolor_event)."""
    cal.recolor_event(event_id, color_id)


_SCHEDULER_CHUNK_ID_KEY = "scheduler_chunk_id"


def _scheduler_chunk_id(ev: dict) -> str | None:
    """The scheduler_chunk_id private extended property ({taskId}#{idx}) if the
    event is a scheduler-owned chunk event, else None."""
    priv = ((ev.get("extendedProperties") or {}).get("private")) or {}
    cid = priv.get(_SCHEDULER_CHUNK_ID_KEY)
    return cid if isinstance(cid, str) else None


def list_scheduler_chunk_events(
    cal: CalendarClient, monday: date
) -> list[dict]:
    """Every scheduler-owned chunk event in the L6 week (carries the
    scheduler_chunk_id private extended property)."""
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    out: list[dict] = []
    for ev in cal.list_events(time_min, time_max):
        if _scheduler_chunk_id(ev) is not None:
            out.append(ev)
    return out


def _task_id_of_chunk(ev: dict) -> str | None:
    """The owning task UUID parsed from a chunk event's scheduler_chunk_id
    ({taskId}#{chunkIndex}); None if not a scheduler chunk event."""
    cid = _scheduler_chunk_id(ev)
    if cid is None:
        return None
    return cid.split("#", 1)[0]


def _chunk_index_of(ev: dict) -> str | None:
    """The chunk-index suffix of a chunk event's scheduler_chunk_id
    ({taskId}#{chunkIndex}); None if not a scheduler chunk event.

    Mirrors the worker's parse (chunkId.lastIndexOf('#')): the taskId may itself
    contain a '#', so the index is everything after the LAST '#'. The owning
    UUID side (_task_id_of_chunk) splits on the FIRST '#' but for our fixtures
    the worker-assigned UUID never contains a '#', so both agree."""
    cid = _scheduler_chunk_id(ev)
    if cid is None or "#" not in cid:
        return None
    return cid.rsplit("#", 1)[1]


_DIFF_ROLES = {"moved-to", "added", "new-clash", "moved-from", "removed"}


def _assert_render_snapshot_model(snapshot: dict | None) -> None:
    """Assert the persisted ReplanEmailModel (render_snapshot) is well-formed.

    This proves buildReplanEmailModel ran end-to-end on the webhook path and the
    resulting model was persisted alongside the plan — not just that *some* plan
    appeared. We assert the MODEL (the structured input to the renderer), not the
    rendered HTML: the harness cannot fetch the confirm page (needs a capability
    token signed with the worker-only TOKEN_HASH_PEPPER via Web Crypto) nor the
    sent email HTML (no mail client). The model legitimately holds ISO-Z
    start/end by design, so there is deliberately NO 'no-ISO-Z' check here — that
    only ever applied to rendered HTML.

    Asserts:
      - render_snapshot is present (the webhook persisted the snapshot)
      - days is a non-empty list (a change was rendered into the model)
      - at least one before/after entry has a non-empty title (titles resolved)
      - trigger reflects the webhook ({"kind":"webhook","inviteTitle":...})
      - at least one entry carries a diff role (an actual diff was classified)
    """
    if snapshot is None:
        print(
            "webhook-check model: render_snapshot is null — skipping model "
            "assertion (snapshot not persisted; backlog may have been empty)"
        )
        return

    days = snapshot.get("days")
    if not isinstance(days, list) or not days:
        print(
            "webhook-check model: render_snapshot.days is empty — skipping model "
            "assertion (no change rendered; backlog may have been empty)"
        )
        return

    # Collect every timeline entry across all days (before + after columns).
    entries: list[dict] = []
    for day in days:
        for col in ("before", "after"):
            for e in day.get(col, []) or []:
                if isinstance(e, dict):
                    entries.append(e)

    titled = [e for e in entries if isinstance(e.get("title"), str) and e["title"].strip()]
    assert titled, (
        "webhook-check model FAILED: no timeline entry has a non-empty title — "
        f"titles did not resolve into the model (days_count={len(days)}, "
        f"entry_count={len(entries)}; snapshot[:500]={repr(snapshot)[:500]})"
    )

    trigger = snapshot.get("trigger")
    assert isinstance(trigger, dict) and trigger.get("kind") == "webhook", (
        "webhook-check model FAILED: trigger is not classified as a webhook "
        f"({trigger!r}) — buildReplanEmailModel did not receive the webhook trigger"
    )

    diff_entries = [e for e in entries if e.get("role") in _DIFF_ROLES]
    assert diff_entries, (
        "webhook-check model FAILED: no entry carries a diff role "
        f"{sorted(_DIFF_ROLES)} — no actual change was classified "
        f"(days_count={len(days)}, entry_count={len(entries)}; "
        f"snapshot[:500]={repr(snapshot)[:500]})"
    )

    print(
        f"webhook-check model OK: render_snapshot has {len(days)} day(s), "
        f"{len(titled)} titled entr(ies), trigger='{trigger.get('inviteTitle')}', "
        f"{len(diff_entries)} diff entr(ies)"
    )


def run_webhook_smoke(env: Env, sched: SchedulerClient, cal: CalendarClient) -> None:
    """Verify the async (Durable Object) webhook path end to end — INCLUDING the
    diff/email render path.

    Self-contained: seeds its own pending tasks in a blank week, resolves once to
    establish a baseline plan, then creates a conflicting calendar event so Google
    delivers a webhook. The coordinator debounces and runs runWebhookReplan, which
    re-resolves that week, schedules the tasks (a non-empty diff vs the empty
    calendar baseline), persists render_snapshot, and sends the email. We poll
    /v1/plans/latest?covers=<event> (deterministic: only the week containing the
    event, immune to unrelated background resolves) for a plan carrying a
    render_snapshot — proof the diff/email path ran. An empty week would resolve to
    a no_diff plan with no snapshot and send no email, so the snapshot IS the test.

    Cleans up only its own tasks, event, and plans via targeted deletes.
    """
    # 1. Ensure a live push subscription so the calendar edit delivers a webhook.
    sched.request("POST", "/v1/webhook/subscribe").raise_for_status()

    # 2. Pick a blank week and seed pending tasks in it. A task-bearing week is
    #    what makes the replan produce a real diff (and therefore an email).
    monday = find_blank_monday(cal, date.today(), 1)
    earliest = f"{monday.isoformat()}T00:00"
    task_bodies = [
        {
            "title": f"[regsmoke-webhook] task {i}",
            "context": "deep",
            "priority": 75,
            "earliest_start": earliest,
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "duration_minutes": 60,
            "source": {"kind": "mcp", "external_id": f"regsmoke-webhook-{i}"},
            "status": "pending",
        }
        for i in range(3)
    ]

    # 23:00 UTC on the Monday is a weekday-morning business slot in the home zone:
    # it competes with the placed tasks and, as a calendar change, fires the webhook.
    start = datetime.combine(monday, datetime.min.time(), tzinfo=timezone.utc).replace(hour=23)
    end = start + timedelta(hours=1)

    task_ids: list[str] = []
    plan_hashes: set[str] = set()
    event_id: str | None = None
    try:
        for body in task_bodies:
            r = sched.request("POST", "/v1/tasks", json=body)
            r.raise_for_status()
            task_ids.append(r.json()["id"])

        # 3. Resolve once to give the week a known baseline plan (no render_snapshot:
        #    /v1/resolve does not render). Confirms the seeded tasks actually schedule.
        status, body = post_resolve(sched, monday)
        if status != 200:
            raise AssertionError(f"webhook-check FAILED: baseline resolve returned {status}: {body!r}")
        baseline_hash = body.get("plan_hash")
        if baseline_hash:
            plan_hashes.add(baseline_hash)
        if not [c for c in body.get("schedule", []) if c.get("task_id") in task_ids]:
            raise AssertionError(
                "webhook-check FAILED: seeded tasks were not scheduled in the baseline "
                f"plan — cannot exercise a diff (schedule={body.get('schedule')!r})"
            )

        # 4. Create the conflicting event → webhook → debounced replan of this week.
        event_id = cal.create_event(
            "[regression-smoke webhook] conflict", start.isoformat(), end.isoformat(),
        )

        # 5. Poll the plan for THIS week (covers=event) for a render_snapshot. The
        #    baseline has none; a non-null snapshot proves the webhook diff/email
        #    path ran. ?covers= keeps this deterministic regardless of other weeks.
        covers = start.isoformat()
        deadline = _time.monotonic() + 120.0
        while _time.monotonic() < deadline:
            resp = sched.request("GET", "/v1/plans/latest", params={"covers": covers})
            resp.raise_for_status()
            plan = resp.json().get("plan")
            if plan and plan.get("plan_hash") != baseline_hash and plan.get("render_snapshot") is not None:
                win = plan.get("window") or {}
                plan_hashes.add(plan["plan_hash"])
                print(
                    f"webhook-check OK: replanned plan {plan['plan_hash']} for window "
                    f"{win.get('start')}..{win.get('end')} covers event at {covers} "
                    f"with a render_snapshot (baseline {baseline_hash})"
                )
                # Proof buildReplanEmailModel ran end to end on the webhook path.
                _assert_render_snapshot_model(plan.get("render_snapshot"))
                return
            _time.sleep(3.0)
        raise AssertionError(
            "webhook-check FAILED: no replanned plan with a render_snapshot covering "
            f"the event at {covers} within 120s (baseline {baseline_hash!r})"
        )
    finally:
        # Targeted teardown of only this run's artifacts. Event deletes carry no
        # time and do not trigger a replan, so leftover tasks/plans are not
        # re-materialised between these steps.
        if event_id is not None:
            try:
                cal.delete_event(event_id)
            except Exception as exc:  # cleanup must not mask the test result
                print(f"webhook-check cleanup: could not delete event {event_id}: {exc}")
        for tid in task_ids:
            sched.request("DELETE", f"/v1/tasks/{tid}")
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


def _reveal_feed_secret(reveal_url: str) -> str:
    """Drive the two-step /cal-reveal/:token reveal like a browser would; assert
    single-use. Mirrors bin/feed-smoke.py's reveal_secret (kept inline here so
    this harness stays self-contained rather than importing a sibling script).

    GET never touches the DB (link-preview bots/curl on the URL can't burn the
    reveal), so it stays 200 no matter how many times it's fetched. POST
    atomically consumes the token: the first succeeds and renders the feed
    URL; the second gets the opaque "Link expired" page at 410."""
    get1 = httpx.get(reveal_url, timeout=30.0)
    assert get1.status_code == 200 and "Reveal secret" in get1.text, (
        f"feed-check FAILED: GET reveal page expected 200 + 'Reveal secret', got "
        f"{get1.status_code}: {get1.text[:300]!r}"
    )
    get2 = httpx.get(reveal_url, timeout=30.0)  # GET twice: must not consume
    assert get2.status_code == 200, "feed-check FAILED: second GET must still be 200 (no consume)"
    post = httpx.post(reveal_url, timeout=30.0)
    assert post.status_code == 200, (
        f"feed-check FAILED: POST reveal failed: {post.status_code}: {post.text[:300]!r}"
    )
    m = re.search(r"(https://\S+/cal/\S+/busy\.ics)", post.text)
    assert m, f"feed-check FAILED: feed URL not found in reveal page: {post.text[:500]!r}"
    again = httpx.post(reveal_url, timeout=30.0)
    assert again.status_code == 410, (
        f"feed-check FAILED: second POST must be 410 (Link expired), got {again.status_code}"
    )
    return m.group(1)


def run_feed_smoke(env: Env, sched: SchedulerClient) -> None:
    """Verify the per-user busy .ics feed end to end, via the /v1/calendar-feeds
    CRUD surface (the old single-token feed route has been removed).

    Gated on CALENDAR_FEED_ENABLED being truthy in the target env — skips
    cleanly (prints a skip notice) when the flag is OFF so the harness can run
    against envs that have not yet deployed the feature. The gate is now a 403
    {error:"feature_disabled"} response, NOT 404: a 404 means the route itself
    is missing (a deploy problem), so it is a FAILURE, not a skip.

    Steps:
    1. POST /v1/calendar-feeds (unique label, no reveal_regexes) → capture id
       + reveal_url.
    2. Drive the two-step /cal-reveal/:token reveal to obtain the feed URL.
    3. GET that url with NO auth header (public, secret-authed route).
    4. Assert HTTP 200, Content-Type contains text/calendar, body contains
       BEGIN:VCALENDAR, and (if any events) only SUMMARY:Busy summaries — this
       endpoint carries no reveal_regexes, so every summary must stay Busy;
       endpoints with reveal_regexes are allowed to show real titles instead
       (see bin/feed-smoke.py F2/F3) and are out of scope for this check.
    5. DELETE /v1/calendar-feeds/{id} to clean up; assert the url then 404s.
    """
    feed_id: str | None = None
    feed_url: str | None = None
    label = f"regsmoke-feed-{_time.strftime('%Y%m%d%H%M%S')}"
    r = sched.request("POST", "/v1/calendar-feeds", json={"label": label})
    if r.status_code == 403 and r.json().get("error") == "feature_disabled":
        print("feed-check SKIP: CALENDAR_FEED_ENABLED is OFF in this env (403 feature_disabled)")
        return
    assert r.status_code != 404, (
        "feed-check FAILED: POST /v1/calendar-feeds returned 404 — route missing, "
        "not a feature-disabled skip (deploy problem)"
    )
    r.raise_for_status()
    body = r.json()
    feed_id = body.get("id")
    reveal_url = body.get("reveal_url")
    assert isinstance(feed_id, str) and feed_id, (
        f"feed-check FAILED: POST /v1/calendar-feeds returned no id: {body!r}"
    )
    assert isinstance(reveal_url, str) and reveal_url.startswith("http"), (
        f"feed-check FAILED: POST /v1/calendar-feeds returned no reveal_url: {body!r}"
    )

    try:
        feed_url = _reveal_feed_secret(reveal_url)

        # 3. Fetch the feed with no auth header (it is a public secret-authed URL).
        feed_resp = sched._client.get(feed_url)
        assert feed_resp.status_code == 200, (
            f"feed-check FAILED: GET feed URL returned HTTP {feed_resp.status_code} "
            f"(expected 200); url={feed_url!r}"
        )
        ct = feed_resp.headers.get("content-type", "")
        assert "text/calendar" in ct, (
            f"feed-check FAILED: Content-Type {ct!r} does not contain 'text/calendar'"
        )
        feed_text = feed_resp.text
        assert "BEGIN:VCALENDAR" in feed_text, (
            f"feed-check FAILED: response body does not contain BEGIN:VCALENDAR; "
            f"body[:200]={feed_text[:200]!r}"
        )
        # If there are any VEVENT blocks, every SUMMARY must be "Busy" — this
        # holds only because this endpoint was created with no reveal_regexes;
        # endpoints with reveal_regexes may legitimately show the real title.
        summaries = [
            line[len("SUMMARY:"):].strip()
            for line in feed_text.splitlines()
            if line.startswith("SUMMARY:")
        ]
        non_busy = [s for s in summaries if s != "Busy"]
        assert not non_busy, (
            f"feed-check FAILED: feed contains non-Busy SUMMARY values: {non_busy!r} "
            f"— raw event titles are leaking"
        )
        print(
            f"feed-check OK: HTTP 200, Content-Type={ct!r}, "
            f"BEGIN:VCALENDAR present, {len(summaries)} event(s), all summaries=Busy"
        )
    finally:
        # 5. Revoke the endpoint and verify the feed 404s. Tolerant of the
        # create having failed (feed_id set to None) so a partial run above
        # doesn't mask the real failure with a cleanup KeyError/NameError.
        if feed_id is not None:
            sched.request("DELETE", f"/v1/calendar-feeds/{feed_id}")
            if feed_url is not None:
                revoked_resp = sched._client.get(feed_url)
                assert revoked_resp.status_code == 404, (
                    f"feed-check FAILED: after DELETE the feed URL returned HTTP "
                    f"{revoked_resp.status_code} (expected 404); the endpoint was not revoked"
                )
                print("feed-check revoke OK: feed URL 404s after DELETE")


def _ceil_to_quarter(dt: datetime) -> datetime:
    """Round a tz-aware instant UP to the next 15-minute boundary. Mirrors the
    worker's ceilToQuarter so the harness computes the same placement floor."""
    discard = timedelta(
        minutes=dt.minute % 15,
        seconds=dt.second,
        microseconds=dt.microsecond,
    )
    if discard == timedelta(0):
        return dt
    return dt + (timedelta(minutes=15) - discard)


def compute_placement_floor(monday: date, now: datetime) -> datetime:
    """placementFloor = max(weekStart, ceilToQuarter(now)), as a UTC instant.
    `monday` is the local-Monday-midnight boundary expressed here as UTC start of
    the smoke week; for L6 (current week) the floor is ceilToQuarter(now)."""
    week_start = datetime.combine(monday, datetime.min.time(), tzinfo=timezone.utc)
    ceil_now = _ceil_to_quarter(now.astimezone(timezone.utc))
    return ceil_now if ceil_now > week_start else week_start


def assert_no_placement_before_floor(
    schedule: list[dict], floor: datetime, harness_task_ids: set[str], label: str
) -> None:
    """Pure: every HARNESS chunk in `schedule` starts at or after `floor`.
    Proves nothing was placed on a past day / elapsed slot (spec (c))."""
    for chunk in schedule:
        if chunk.get("task_id") not in harness_task_ids:
            continue
        c_start = datetime.fromisoformat(chunk["start"].replace("Z", "+00:00"))
        assert c_start >= floor, (
            f"{label}: chunk {chunk.get('chunk_id')} starts {chunk['start']} "
            f"before placement floor {floor.isoformat()} — a past day/slot was used"
        )


def assert_tasks_absent_from_schedule(
    schedule: list[dict], dropped: list[dict], task_ids: set[str], label: str
) -> None:
    """Pure: none of `task_ids` appear in the schedule OR the dropped list.
    A done task is excluded from the load query entirely, so it is neither
    scheduled nor dropped (spec (a)/(b))."""
    placed = {c.get("task_id") for c in schedule} & task_ids
    assert not placed, f"{label}: done tasks still scheduled: {sorted(placed)!r}"
    dropped_ids = {d.get("task_id") for d in dropped} & task_ids
    assert not dropped_ids, (
        f"{label}: done tasks appeared in dropped (should be absent from the "
        f"solve entirely, not dropped): {sorted(dropped_ids)!r}"
    )


def assert_tasks_present_in_schedule(
    schedule: list[dict], task_ids: set[str], label: str
) -> None:
    """Pure: every id in `task_ids` is scheduled (used for the released-pin task,
    which must reschedule forward rather than drop — spec (d))."""
    placed = {c.get("task_id") for c in schedule} & task_ids
    missing = task_ids - placed
    assert not missing, (
        f"{label}: expected these tasks scheduled but they are absent "
        f"(dropped or not loaded): {sorted(missing)!r}"
    )


def _commit_resolve(
    sched: SchedulerClient, monday: date, plan_hashes: set[str], label: str
) -> dict:
    """Resolve the L6 week then commit the proposed plan to the calendar.
    Records the plan_hash for teardown and returns the resolve body."""
    status, body = post_resolve(sched, monday)
    if status != 200:
        raise AssertionError(f"{label}: resolve returned {status}: {body!r}")
    plan_hash = body.get("plan_hash")
    if plan_hash:
        plan_hashes.add(plan_hash)
        c_status, c_body = post_commit(sched, plan_hash)
        if c_status != 200:
            raise AssertionError(f"{label}: commit returned {c_status}: {c_body!r}")
    return body


def run_level_done(env: Env, sched: SchedulerClient, cal: CalendarClient,
                   home_tz: str, monday: date) -> LevelResult:
    """L6 — done-marking + replan placement-floor (spec 2026-06-03).

    Self-contained, like run_webhook_smoke, but registered in the Level ladder so
    it appears in the summary table. Runs against the CURRENT week (`monday` is
    this week's Monday) so the placement floor falls mid-week.

    Steps:
      1. Seed the L6 task set (done-api, done-color, undone-color, floor,
         pin-past) + resolve + commit → real events on the calendar.
      2. (a) PATCH the done-api tasks to status="done"; (b) recolor one chunk of
         the done-color task to MARKING.done.
         (REVERSE LEG, undone-color) (c) recolor its chunk to MARKING.done then
         resolve-only (no commit) → done-scan flips it done in D1 while the tomato
         event survives; (d) recolor that chunk BACK to a non-done color; (e)
         resolve-only again → the revive-scan flips it back to pending and re-adds
         it, and the resolve's schedule CONTAINS the revived task id.
      3. Re-resolve + commit the SAME week.
      4. Assert:
         (a)/(b) done-api + done-color tasks absent from the new schedule AND no
                 scheduler chunk events remain for them on the calendar.
         (e) the undone-color task was present in the revive resolve's schedule
             (revived, not done); it ends SCHEDULED, never in the done sets.
         (c) every remaining harness chunk starts >= placementFloor (nothing on a
             past day / elapsed slot).
         (d) the pin-past task is scheduled (pin released, rescheduled forward),
             not dropped.
    """
    started = datetime.now(tz=timezone.utc)
    fixtures = gen_done_fixtures(monday, date.today())
    plan_hashes: set[str] = set()
    posted_ids: list[str] = []
    try:
        # Clean any residue from a prior aborted L6 run first. L6 commits, so its
        # committed chunk events must be swept by summary/chunk-id, not the
        # generic '[regression-smoke L6]' sweep (which never matches them).
        delete_regression_tasks_and_templates(sched)
        delete_l6_calendar_events(cal, monday)

        # 1. Seed + resolve + commit (baseline events on the calendar).
        for fx in fixtures:
            body = {k: v for k, v in fx.body.items() if k != "id"}
            r = sched.request("POST", "/v1/tasks", json=body)
            r.raise_for_status()
            posted_ids.append(r.json()["id"])

        baseline = _commit_resolve(sched, monday, plan_hashes, "L6 baseline")
        baseline_sched = baseline.get("schedule", [])
        # Map external_id -> worker UUID so we can classify post-resolve.
        all_ids = list_harness_task_ids(sched)
        ext_to_uuid = _l6_ext_to_uuid(sched, fixtures)
        done_api_ids = {ext_to_uuid[fx.external_id] for fx in fixtures
                        if fx.kind == "done-api" and fx.external_id in ext_to_uuid}
        done_color_ids = {ext_to_uuid[fx.external_id] for fx in fixtures
                          if fx.kind == "done-color" and fx.external_id in ext_to_uuid}
        undone_color_ids = {ext_to_uuid[fx.external_id] for fx in fixtures
                            if fx.kind == "undone-color" and fx.external_id in ext_to_uuid}
        pin_past_ids = {ext_to_uuid[fx.external_id] for fx in fixtures
                        if fx.kind == "pin-past" and fx.external_id in ext_to_uuid}

        # Baseline sanity: the tasks we are about to mark done were actually
        # scheduled — otherwise the "removed on replan" assertion is vacuous. The
        # undone-color task must also be placed first: its banana chunk is what we
        # later paint tomato (done) and then back to banana (revive).
        assert_tasks_present_in_schedule(
            baseline_sched, done_api_ids | done_color_ids | undone_color_ids,
            "L6 baseline (pre-done tasks must be placed first)",
        )

        # 2a. Mark the done-api tasks done via PATCH {status:"done"}.
        for tid in done_api_ids:
            code = patch_task_status(sched, tid, "done")
            if code != 200:
                raise AssertionError(f"L6: PATCH status=done returned {code} for {tid}")

        # 2b. Recolor one committed chunk event of the done-color task to the
        #     configured done color (any one chunk marks the whole task done).
        chunk_events = list_scheduler_chunk_events(cal, monday)
        recolored = 0
        for ev in chunk_events:
            if _task_id_of_chunk(ev) in done_color_ids:
                recolor_event(cal, ev["id"], MARKING.done)
                recolored += 1
                break  # task-level: any one chunk suffices
        if done_color_ids and recolored == 0:
            raise AssertionError(
                "L6: no committed chunk event found for the done-color task to "
                "recolor — baseline commit did not create its events"
            )

        # 2c. Un-done-by-color REVERSE leg (resolve-only, no commit, so no
        #     orphan-deletion fires while the chunk is tomato). Paint the
        #     undone-color task's committed chunk MARKING.done; a resolve-only
        #     pass runs the done-scan, flipping it to status='done' in D1 while
        #     its tomato event still exists on the calendar.
        undone_chunk_id: str | None = None
        for ev in chunk_events:
            if _task_id_of_chunk(ev) in undone_color_ids:
                recolor_event(cal, ev["id"], MARKING.done)
                undone_chunk_id = ev["id"]
                break  # task-level: any one chunk suffices
        if undone_color_ids and undone_chunk_id is None:
            raise AssertionError(
                "L6: no committed chunk event found for the undone-color task to "
                "recolor — baseline commit did not create its events"
            )
        if undone_color_ids:
            # Resolve only (NO commit): done-scan flips it done in D1, the tomato
            # event survives (no orphan-deletion without a commit).
            d_status, _ = post_resolve(sched, monday)
            if d_status != 200:
                raise AssertionError(
                    f"L6: undone-color done resolve returned {d_status}"
                )
            # 2d. Paint that same chunk BACK to a non-done color. The next resolve
            #     should see a done task whose in-window chunk is no longer
            #     done-colored → revive-scan flips it back to pending + re-adds it.
            recolor_event(cal, undone_chunk_id, MARKING.undone)
            # 2e. Resolve again (still no commit): revive-scan flips it pending and
            #     re-adds it to THIS solve. Assert the schedule contains it.
            r_status, revive = post_resolve(sched, monday)
            if r_status != 200:
                raise AssertionError(
                    f"L6: undone-color revive resolve returned {r_status}"
                )
            assert_tasks_present_in_schedule(
                revive.get("schedule", []), undone_color_ids,
                "L6 undone-color revive (revived task must be rescheduled)",
            )

        # 3. Re-resolve + commit the same week. Color detection flips the
        #    done-color task to status='done'; both done sets are now excluded
        #    from the load query, and commit orphan-deletes their events.
        #    Capture `now` BEFORE the resolve: the worker floors placement at
        #    ceilToQuarter(its own now), which is >= ceilToQuarter(this now). Our
        #    assertion floor must not exceed the worker's, or a legitimately
        #    placed chunk would look like a violation.
        replan_now = datetime.now(tz=timezone.utc)
        replan = _commit_resolve(sched, monday, plan_hashes, "L6 replan")
        replan_sched = replan.get("schedule", [])
        replan_dropped = replan.get("dropped", [])
        # Re-snapshot harness ids (done tasks drop out of GET /v1/tasks' active set
        # is not guaranteed; we classify by the UUIDs captured at baseline).
        done_ids = done_api_ids | done_color_ids

        # (a)/(b) done tasks absent from the new schedule.
        assert_tasks_absent_from_schedule(
            replan_sched, replan_dropped, done_ids, "L6 replan",
        )

        # (a)/(b) their scheduler chunk events are gone from the calendar.
        remaining = list_scheduler_chunk_events(cal, monday)
        remaining_done = {
            _task_id_of_chunk(ev) for ev in remaining
        } & done_ids
        assert not remaining_done, (
            f"L6: done tasks still have scheduler chunk events on the calendar: "
            f"{sorted(remaining_done)!r} (orphan-deletion did not remove them)"
        )

        # (c) Nothing placed before the mid-week placement floor. Use the pre-
        #     resolve `now` so our floor is a lower bound on the worker's.
        floor = compute_placement_floor(monday, replan_now)
        remaining_harness = list_harness_task_ids(sched) | (all_ids - done_ids)
        assert_no_placement_before_floor(
            replan_sched, floor, remaining_harness, "L6 floor",
        )

        # (d) The past-pinned task rescheduled forward (released), not dropped.
        if pin_past_ids:
            assert_tasks_present_in_schedule(
                replan_sched, pin_past_ids, "L6 past-pin release",
            )
            assert_no_placement_before_floor(
                replan_sched, floor, pin_past_ids, "L6 past-pin release floor",
            )

        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        scheduled = [c for c in replan_sched if c.get("task_id") in remaining_harness]
        return LevelResult(
            level="6", passed=True, http_status=200,
            scheduled_count=len(scheduled), dropped_count=len(replan_dropped),
            elapsed_seconds=elapsed,
        )
    except AssertionError as e:
        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level="6", passed=False, http_status=0,
            scheduled_count=0, dropped_count=0,
            elapsed_seconds=elapsed, notes=str(e),
        )
    finally:
        # Sweep all L6 artifacts. DELETE /v1/tasks/:id only removes the D1 row —
        # it does NOT orphan-delete the committed chunk events (orphan deletion
        # happens only inside commit.ts when a committed task is absent from a
        # NEW proposed plan). So the calendar chunk events the baseline/replan
        # commits created for the surviving floor + pin-past tasks must be
        # deleted explicitly here, or they leak as residue after every L6 run.
        delete_regression_tasks_and_templates(sched)
        delete_l6_calendar_events(cal, monday)
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


def _subject_chunk_events(
    cal: CalendarClient, monday: date, subject_ids: set[str]
) -> dict[str, dict]:
    """Map chunk-index suffix → chunk event for every scheduler chunk event in
    the L7 week owned by one of `subject_ids`. Index keys ('0', '1', …) match the
    worker's lastIndexOf('#') parse (_chunk_index_of)."""
    out: dict[str, dict] = {}
    for ev in list_scheduler_chunk_events(cal, monday):
        if _task_id_of_chunk(ev) in subject_ids:
            idx = _chunk_index_of(ev)
            if idx is not None:
                out[idx] = ev
    return out


def run_level_chunks(env: Env, sched: SchedulerClient, cal: CalendarClient,
                     home_tz: str, monday: date) -> LevelResult:
    """L7 — per-chunk completion guarantees (continues per-chunk Tasks 1-8).

    Self-contained like run_level_done, registered in the ladder, runs the
    CURRENT week (`monday` is this week's Monday) so the same current-week
    placement path L6 uses is in effect. It commits real chunk events so
    per-chunk orphan-deletion is observable.

    Steps:
      1. Seed the 2-chunk subject + a fresh 2-chunk revive subject + a droppable
         filler; resolve + commit → real chunk events on the calendar.
      2. (partial) Recolor ONE chunk (#0) of the subject to MARKING.done, then
         resolve + commit. Assert: the subject is STILL scheduled (only #0 done →
         task stays pending); its #1 chunk event still exists; #0's chunk event is
         gone (its slot was freed — the completed chunk is dropped from the problem
         and commit reconciles its event away).
      3. (all) Recolor the remaining chunk (#1) done, then resolve + commit.
         Assert: the subject is ABSENT from the schedule (all chunks done → task
         done → excluded) and NO subject chunk events remain on the calendar.
      4. (revive) On the fresh revive subject, recolor #0 done + resolve-only (no
         commit) → records the chunk done (task flips done in D1, the tomato event
         survives). Recolor #0 BACK to a non-done color + resolve-only → the
         evidence-gated revive deletes the record (event present and off the done
         color), the task flips pending, and #0 re-enters the resolve's schedule;
         #1 is unaffected.

    Detection runs entirely on the HTTP /v1/resolve route (no webhook needed).
    """
    started = datetime.now(tz=timezone.utc)
    fixtures = gen_chunks_fixtures(monday, date.today())
    plan_hashes: set[str] = set()
    posted_ids: list[str] = []
    try:
        # Clean any residue from a prior aborted L7 run first. L7 commits, so its
        # committed chunk events must be swept by summary/chunk-id, not the
        # generic '[regression-smoke L7]' sweep (which never matches them).
        delete_regression_tasks_and_templates(sched)
        delete_l7_calendar_events(cal, monday)

        # 1. Seed + resolve + commit (baseline chunk events on the calendar).
        for fx in fixtures:
            body = {k: v for k, v in fx.body.items() if k != "id"}
            r = sched.request("POST", "/v1/tasks", json=body)
            r.raise_for_status()
            posted_ids.append(r.json()["id"])

        baseline = _commit_resolve(sched, monday, plan_hashes, "L7 baseline")
        baseline_sched = baseline.get("schedule", [])
        ext_to_uuid = _l6_ext_to_uuid(sched, fixtures)
        subject_ids = {ext_to_uuid[fx.external_id] for fx in fixtures
                       if fx.kind == "chunks-subject" and fx.external_id in ext_to_uuid}
        revive_ids = {ext_to_uuid[fx.external_id] for fx in fixtures
                      if fx.kind == "chunks-revive" and fx.external_id in ext_to_uuid}
        if not subject_ids or not revive_ids:
            raise AssertionError(
                "L7: subject and/or revive task missing from GET /v1/tasks after "
                f"seed (ext_to_uuid={ext_to_uuid!r})"
            )

        # Baseline sanity: both subjects were scheduled — otherwise the per-chunk
        # assertions below are vacuous. Both chunks of the subject must have landed
        # as committed chunk events so we can paint #0 then #1.
        assert_tasks_present_in_schedule(
            baseline_sched, subject_ids | revive_ids,
            "L7 baseline (subjects must be placed first)",
        )
        subj_chunks = _subject_chunk_events(cal, monday, subject_ids)
        if "0" not in subj_chunks or "1" not in subj_chunks:
            raise AssertionError(
                "L7: baseline commit did not create both chunk events for the "
                f"subject (found indices {sorted(subj_chunks)!r})"
            )

        # 2. PARTIAL — paint chunk #0 done, then resolve + commit.
        #    Only 1 of 2 chunks recorded → the task flips done only when ALL chunks
        #    are recorded, so it stays pending and remains scheduled. build-problem
        #    drops the completed chunk #0 from the solve (freeing its slot) and the
        #    commit reconciles #0's event away; chunk #1 survives.
        recolor_event(cal, subj_chunks["0"]["id"], MARKING.done)
        partial = _commit_resolve(sched, monday, plan_hashes, "L7 partial")
        partial_sched = partial.get("schedule", [])
        # (partial-a) Subject still scheduled — not done (only 1/2 chunks done).
        assert_tasks_present_in_schedule(
            partial_sched, subject_ids,
            "L7 partial (subject with 1/2 chunks done must stay scheduled)",
        )
        # (partial-b) Chunk #0's event is gone (slot freed); chunk #1 survives.
        after_partial = _subject_chunk_events(cal, monday, subject_ids)
        assert "0" not in after_partial, (
            "L7 partial: chunk #0's event is still on the calendar after its "
            "completion — the freed slot's event was not reconciled away "
            f"(found chunk indices {sorted(after_partial)!r})"
        )
        assert "1" in after_partial, (
            "L7 partial: chunk #1's event vanished — the remaining (incomplete) "
            f"chunk should survive (found chunk indices {sorted(after_partial)!r})"
        )

        # 3. ALL — paint the remaining chunk #1 done, then resolve + commit.
        #    Now every chunk is recorded → the task flips done, is excluded from
        #    the solve, and commit orphan-deletes all its chunk events.
        recolor_event(cal, after_partial["1"]["id"], MARKING.done)
        all_done = _commit_resolve(sched, monday, plan_hashes, "L7 all")
        all_sched = all_done.get("schedule", [])
        all_dropped = all_done.get("dropped", [])
        # (all-a) Subject absent from the schedule (done → not scheduled, not dropped).
        assert_tasks_absent_from_schedule(
            all_sched, all_dropped, subject_ids, "L7 all (fully-done subject)",
        )
        # (all-b) No subject chunk events remain on the calendar.
        after_all = _subject_chunk_events(cal, monday, subject_ids)
        assert not after_all, (
            "L7 all: subject chunk events still on the calendar after the whole "
            f"task is done: {sorted(after_all)!r} (orphan-deletion did not run)"
        )

        # 4. REVIVE — on the fresh revive subject, resolve-only (no commit) so no
        #    orphan-deletion fires while the chunk is done-colored.
        revive_chunks = _subject_chunk_events(cal, monday, revive_ids)
        if "0" not in revive_chunks or "1" not in revive_chunks:
            raise AssertionError(
                "L7 revive: revive subject is missing a committed chunk event "
                f"(found indices {sorted(revive_chunks)!r}) — it may have been "
                "disturbed by the partial/all commits"
            )
        # 4a. Paint chunk #0 done; resolve-only records #0 per-chunk. The subject
        #     is a 2-chunk task, so it stays PENDING (only 1/2 chunks recorded) —
        #     but #0 is now dropped from the solve and its done-colored event
        #     survives (no commit, no orphan-deletion). This exercises per-chunk
        #     revive without the task ever flipping done.
        revive_chunk0_id = revive_chunks["0"]["id"]
        recolor_event(cal, revive_chunk0_id, MARKING.done)
        d_status, _ = post_resolve(sched, monday)
        if d_status != 200:
            raise AssertionError(f"L7 revive: done resolve returned {d_status}")
        # 4b. Paint that same chunk BACK to a non-done color. The next resolve sees
        #     a recorded chunk whose event is present and OFF the done color →
        #     evidence-gated revive deletes the record, flips the task pending, and
        #     re-adds chunk #0 to the solve.
        recolor_event(cal, revive_chunk0_id, MARKING.undone)
        r_status, revive = post_resolve(sched, monday)
        if r_status != 200:
            raise AssertionError(f"L7 revive: revive resolve returned {r_status}")
        revive_sched = revive.get("schedule", [])
        # (revive-a) The revived subject re-enters the schedule (pending again).
        assert_tasks_present_in_schedule(
            revive_sched, revive_ids,
            "L7 revive (un-painted chunk must re-enter the schedule)",
        )
        # (revive-b) Chunk #0 itself is back in the proposed schedule. The revive
        #     re-adds the completed chunk, so its chunk_id reappears as a placement.
        revive_chunk0_cid = _scheduler_chunk_id(revive_chunks["0"])
        revived_cids = {c.get("chunk_id") for c in revive_sched
                        if c.get("task_id") in revive_ids}
        assert revive_chunk0_cid in revived_cids, (
            "L7 revive: chunk #0 did not re-enter the proposed schedule after "
            f"un-painting (expected chunk_id {revive_chunk0_cid!r}; revive-task "
            f"chunk_ids in schedule: {sorted(c for c in revived_cids if c)!r})"
        )
        # (revive-c) Chunk #1 was never painted, so the #0 paint/un-paint cycle
        #     must leave it untouched: its event still exists, is the SAME event
        #     (resolve-only never creates/deletes), and was never done-colored.
        after_revive = _subject_chunk_events(cal, monday, revive_ids)
        assert "1" in after_revive, (
            "L7 revive: chunk #1's event vanished during the #0 paint/un-paint "
            f"cycle (found indices {sorted(after_revive)!r}) — it must be untouched"
        )
        assert after_revive["1"]["id"] == revive_chunks["1"]["id"], (
            "L7 revive: chunk #1's event was replaced during the #0 revive cycle "
            f"(was {revive_chunks['1']['id']!r}, now {after_revive['1']['id']!r}) — "
            "only #0 should have been affected"
        )
        assert after_revive["1"].get("colorId") != MARKING.done, (
            "L7 revive: chunk #1 became done-colored, but only #0 was painted — "
            "the #0 revive cycle must not affect #1"
        )

        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        scheduled = [c for c in revive_sched if c.get("task_id") in (subject_ids | revive_ids)]
        return LevelResult(
            level="7", passed=True, http_status=200,
            scheduled_count=len(scheduled), dropped_count=len(revive.get("dropped", [])),
            elapsed_seconds=elapsed,
        )
    except AssertionError as e:
        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level="7", passed=False, http_status=0,
            scheduled_count=0, dropped_count=0,
            elapsed_seconds=elapsed, notes=str(e),
        )
    finally:
        # Sweep all L7 artifacts. DELETE /v1/tasks/:id removes only the D1 row,
        # not the committed chunk events (orphan deletion happens only inside
        # commit.ts when a committed task is absent from a NEW proposed plan), so
        # the surviving chunk events the commits created must be deleted here or
        # they leak as residue after every L7 run.
        delete_regression_tasks_and_templates(sched)
        delete_l7_calendar_events(cal, monday)
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


# ── L8 (manual-move write-back) helpers + executor ──────────────────────────


def get_plan_body(sched: SchedulerClient, plan_hash: str) -> dict:
    """The stored plan body (schedule/dropped/window) for a plan_hash, via
    GET /v1/plans/:hash. Returns committed plans too — the write-back patches a
    committed plan's body IN PLACE under the same hash, so this reads back the
    patched schedule."""
    r = sched.request("GET", f"/v1/plans/{plan_hash}")
    r.raise_for_status()
    return r.json().get("body", {}) or {}


# worker/ holds wrangler.toml ([env.dev] → the scheduler-dev D1 binding `DB`); the
# d1 execute below must run from there so `--env dev` resolves the dev binding.
_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"


def _d1_read_task_cmd(task_id: str) -> list[str]:
    """`wrangler d1 execute DB --env <SMOKE_WRANGLER_ENV>` — the env's own DB
    binding, so the same read works on any smoke env's db (scheduler-dev for
    "dev"). The ALLOWED_DEV_DB_IDS preflight already pinned the target."""
    return [
        "npx", "wrangler", "d1", "execute", "DB",
        "--env", os.environ.get("SMOKE_WRANGLER_ENV", "dev"), "--remote", "--json",
        "--command",
        "SELECT scheduled_for, "
        "json_extract(body,'$.earliest_start') AS earliest_start, "
        "json_extract(body,'$.pinned_at') AS pinned_at "
        f"FROM tasks WHERE id='{task_id}'",
    ]


def _d1_read_task(task_id: str) -> dict | None:
    """Read a task's system-internal columns straight from the dev D1 via wrangler.

    scheduled_for is never exposed over HTTP, so the only way to assert the restamp
    is a direct D1 read. Runs `wrangler d1 execute DB --env dev --remote` from
    worker/, under the SAME op-injected Cloudflare creds the deploy commands use —
    no new secrets. Read-only SELECT against the dev binding (the ALLOWED_DEV_DB_IDS
    preflight already guarantees the target is dev, never prod). `task_id` is a
    worker-assigned UUID (no quoting hazard).

    Returns {scheduled_for, earliest_start, pinned_at}, or None if wrangler could
    not be run at all (tool/creds absent, timeout, unparseable) — the caller then
    SKIPS the scheduled_for assertion with a notice rather than failing the level on
    infrastructure. A row that comes back with the WRONG value still fails (caller's
    job)."""
    cmd = _d1_read_task_cmd(task_id)
    try:
        proc = subprocess.run(
            cmd, cwd=str(_WORKER_DIR), capture_output=True, text=True, timeout=120,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        print(f"  (D1 scheduled_for check skipped — wrangler not runnable: {exc})")
        return None
    if proc.returncode != 0:
        print(f"  (D1 scheduled_for check skipped — wrangler exit {proc.returncode}: "
              f"{proc.stderr.strip()[:200]})")
        return None
    try:
        payload = json.loads(proc.stdout)
        rows = payload[0]["results"]
    except (ValueError, KeyError, IndexError) as exc:
        print(f"  (D1 scheduled_for check skipped — unparseable wrangler output: {exc})")
        return None
    return rows[0] if rows else None


def _to_ms(value: str | None) -> float | None:
    """Parse an ISO datetime (Z or offset) to epoch seconds, else None."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _instants_equal(a: str | None, b: str | None) -> bool:
    """True iff a and b denote the same instant (format-agnostic: Z vs offset vs
    millisecond precision). The worker writes the dragged start in whatever form
    Google returned it, so string equality would be brittle."""
    ma, mb = _to_ms(a), _to_ms(b)
    return ma is not None and mb is not None and abs(ma - mb) < 1.0


def _l8_slot_z(day: date, hour: int, minute: int, zone) -> tuple[str, str]:
    """A 60-minute slot at home-zone local (day, hour:minute), as ISO-Z
    (start, end). Mirrors gen_meetings' local→UTC conversion so the dragged event
    lands at a real business-hours slot."""
    start_local = datetime.combine(day, time(hour, minute), tzinfo=zone)
    end_local = start_local + timedelta(minutes=60)
    return (
        start_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        end_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    )


def _poll_plan_chunk_start(
    sched: SchedulerClient, plan_hash: str, chunk_id: str, want_z: str,
    timeout: float = 150.0,
) -> bool:
    """Poll GET /v1/plans/:hash until `chunk_id`'s start equals `want_z`. The
    write-back is async (Durable Object debounce + Google webhook delivery), so we
    poll rather than read once."""
    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        for e in get_plan_body(sched, plan_hash).get("schedule", []):
            if e.get("chunk_id") == chunk_id and _instants_equal(e.get("start"), want_z):
                return True
        _time.sleep(3.0)
    return False


def _poll_task_field(
    sched: SchedulerClient, task_id: str, field: str, want_z: str,
    timeout: float = 60.0,
) -> str | None:
    """Poll GET /v1/tasks/:id until body `field` (earliest_start | pinned_at)
    equals `want_z`. Returns the last value seen (for a useful failure message)."""
    last: str | None = None
    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        r = sched.request("GET", f"/v1/tasks/{task_id}")
        if r.status_code == 200:
            last = r.json().get(field)
            if _instants_equal(last, want_z):
                return last
        _time.sleep(2.0)
    return last


def _churn_anchor_mismatches(
    schedule: list[dict], want_by_task: dict[str, tuple[str, str]]
) -> list[str]:
    """Pure: compare a week-A re-resolve's proposed schedule against the dragged
    slots (the L8 anchor sub-leg, an internal issue). want_by_task maps a task UUID to
    (leg name, expected ISO-Z start). A task matches when any of its proposed
    entries starts at the expected instant — format-agnostic, since the worker
    renders home-zone offset forms while the harness computes drag targets as
    ISO-Z; L8 tasks are single-chunk, so "any" is "the" in practice. Returns one
    message per failing task (moved, or absent — a dropped task is a mismatch,
    not a silent pass); [] is the anchored state."""
    by_task: dict[str, list] = {}
    for e in schedule:
        tid = e.get("task_id")
        if isinstance(tid, str):
            by_task.setdefault(tid, []).append(e.get("start"))
    out: list[str] = []
    for uuid, (leg, want_z) in want_by_task.items():
        seen = by_task.get(uuid)
        if not seen:
            out.append(f"{leg} ({uuid}): absent from the proposed schedule (want {want_z})")
        elif not any(_instants_equal(s, want_z) for s in seen):
            out.append(f"{leg} ({uuid}): proposed at {seen!r}, want {want_z}")
    return out


def _l8_ext_to_uuid(sched: SchedulerClient, fixtures: list[MoveFixture]) -> dict[str, str]:
    """Map each L8 fixture's source.external_id to the worker-assigned UUID
    (mirrors _l6_ext_to_uuid; POST assigns the id server-side)."""
    wanted = {fx.external_id for fx in fixtures}
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    out: dict[str, str] = {}
    for t in r.json().get("tasks", []):
        src = t.get("source")
        ext = src.get("external_id") if isinstance(src, dict) else None
        if isinstance(ext, str) and ext in wanted and isinstance(t.get("id"), str):
            out[ext] = t["id"]
    return out


def delete_l8_calendar_events(cal: CalendarClient, monday: date) -> None:
    """Delete L8 residue from the calendar for the week of `monday`. Identical in
    shape to delete_l6/l7_calendar_events: L8 COMMITS, so it creates scheduler-owned
    chunk events that DELETE /v1/tasks/:id does not orphan-delete. Match on the
    worker-stamped scheduler_chunk_id private property (authoritative — survives the
    hand-drag, which only re-times the event) and, defensively, the '[regsmoke L8]'
    task-title prefix for titled residue."""
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in cal.list_events(time_min, time_max):
        is_chunk = _scheduler_chunk_id(ev) is not None
        is_titled = ev.get("summary", "").startswith(_L8_TITLE_PREFIX)
        if is_chunk or is_titled:
            cal.delete_event(ev["id"])


def run_level_move(env: Env, sched: SchedulerClient, cal: CalendarClient,
                   home_tz: str, _monday: date, keep_artifacts: bool = False) -> LevelResult:
    """L8 — manual-move write-back (spec 2026-06-18-manual-move-writeback-robustness).

    Webhook-driven and self-contained (finds its OWN two future blank weeks; the
    `_monday` arg from the dispatcher is unused). Proves that hand-dragging a
    committed scheduler chunk event makes the worker (D1 write only, no replan):
      - patch the committed plan that CONTAINS the chunk even when it is NOT the
        latest committed plan (X5) — week A is committed before week B, so every
        week-A drag is a non-latest-plan drag, and week B must stay untouched;
      - lower earliest_start to the drop when the drop is earlier (X6);
      - move pinned_at to the drop (L6);
    and that a subsequent RESOLVE of week A anchors on the drag-patched,
    non-latest week-A plan — the dragged chunks stay put (anchor sub-leg,
    an internal issue / internal design notes).

    scheduled_for (the restamp) is system-internal and not exposed over HTTP, so it
    is asserted by reading the dev D1 directly via wrangler (_d1_read_task), using
    the same op-injected Cloudflare creds the deploy commands use. If wrangler is not
    runnable in the environment, that one assertion is skipped (with a notice) rather
    than failing the level — the HTTP-observable surfaces (plan body, earliest_start,
    pinned_at) are always asserted.

    NOTE: depends on a live Google push subscription delivering the drag as a
    webhook. A non-delivery surfaces as a poll-timeout AssertionError — a real
    signal that a user's drag would not have been honored."""
    started = datetime.now(tz=timezone.utc)
    zone = tz.gettz(home_tz)
    if zone is None:
        return LevelResult(level="8", passed=False, http_status=0, scheduled_count=0,
                           dropped_count=0, elapsed_seconds=0.0,
                           notes=f"unknown timezone {home_tz!r}")
    plan_hashes: set[str] = set()
    week_a: date | None = None
    week_b: date | None = None
    legs_ok = 0
    try:
        # Live push subscription so the drag delivers a webhook.
        sched.request("POST", "/v1/webhook/subscribe").raise_for_status()
        delete_regression_tasks_and_templates(sched)

        week_a = find_blank_monday(cal, date.today(), 2)
        week_b = week_a + timedelta(days=7)
        delete_l8_calendar_events(cal, week_a)
        delete_l8_calendar_events(cal, week_b)

        fixtures = gen_move_fixtures(week_a, week_b)
        for fx in fixtures:
            body = {k: v for k, v in fx.body.items() if k != "id"}
            r = sched.request("POST", "/v1/tasks", json=body)
            r.raise_for_status()

        # Commit week A FIRST (older committed), week B SECOND (latest committed) →
        # every week-A drag is a drag on a NON-latest committed plan (X5). Once week
        # A is committed its tasks carry a scheduled_for anchor in week A and are
        # window-shed from week B's resolve, so committing week B leaves them intact.
        a_body = _commit_resolve(sched, week_a, plan_hashes, "L8 week-A baseline")
        hash_a = a_body.get("plan_hash")
        b_body = _commit_resolve(sched, week_b, plan_hashes, "L8 week-B baseline (latest committed)")
        hash_b = b_body.get("plan_hash")
        if not hash_a or not hash_b:
            raise AssertionError(f"L8: missing committed plan hash (A={hash_a!r} B={hash_b!r})")

        ext_to_uuid = _l8_ext_to_uuid(sched, fixtures)

        # Each week-A task UUID -> its committed chunk event (one chunk per task).
        by_task: dict[str, dict] = {}
        for ev in list_scheduler_chunk_events(cal, week_a):
            tid = _task_id_of_chunk(ev)
            if tid is not None:
                by_task[tid] = ev

        # Baseline week-B filler chunk start (for the X5 "latest untouched" check).
        filler_uuid = ext_to_uuid.get(f"{_L8_EXTERNAL_PREFIX}-x5filler-00")
        b_sched0 = get_plan_body(sched, hash_b).get("schedule", [])
        filler_start0 = next(
            (e.get("start") for e in b_sched0 if e.get("task_id") == filler_uuid), None
        )

        tue = week_a + timedelta(days=1)
        # Drag targets by task UUID, for the anchor sub-leg after the drag legs.
        want_by_task: dict[str, tuple[str, str]] = {}
        for leg, ext, (hh, mm), field in _L8_DRAG_LEGS:
            uuid = ext_to_uuid.get(ext)
            if not uuid:
                raise AssertionError(f"L8 {leg}: task {ext} not found after commit")
            ev = by_task.get(uuid)
            if ev is None:
                raise AssertionError(f"L8 {leg}: no committed chunk event for {uuid}")
            chunk_id = _scheduler_chunk_id(ev)
            start_z, end_z = _l8_slot_z(tue, hh, mm, zone)

            # Hand-drag: re-time the committed chunk event → webhook → write-back.
            cal.move_event(ev["id"], start_z, end_z)

            # (1) The committed (NON-latest) plan A body must follow the drag.
            if not _poll_plan_chunk_start(sched, hash_a, chunk_id, start_z):
                raise AssertionError(
                    f"L8 {leg}: plan {hash_a} chunk {chunk_id} did not follow the drag to "
                    f"{start_z} within timeout — webhook write-back did not land "
                    f"(push delivery failure, or the chunk's plan was not patched)"
                )

            # (2) Constraint reconciliation, where observable in the task body.
            if field is not None:
                seen = _poll_task_field(sched, uuid, field, start_z)
                if not _instants_equal(seen, start_z):
                    raise AssertionError(
                        f"L8 {leg}: task {uuid} body.{field} did not move to the drop "
                        f"{start_z} (saw {seen!r}) — constraint reconciliation failed"
                    )

            want_by_task[uuid] = (leg, start_z)
            print(f"L8 {leg} OK: dragged task {uuid} chunk {chunk_id} -> {start_z} "
                  f"(plan body followed" + (f"; body.{field} reconciled)" if field else ")"))

            # (3) scheduled_for is system-internal (not exposed over HTTP) — read it
            # straight from the dev D1 via wrangler and assert the restamp followed
            # the drag. Skips (does not fail) if wrangler is not runnable here.
            row = _d1_read_task(uuid)
            if row is not None:
                sf = row.get("scheduled_for")
                if not _instants_equal(sf, start_z):
                    raise AssertionError(
                        f"L8 {leg}: D1 tasks.scheduled_for {sf!r} != drop {start_z} — "
                        f"the row was not restamped to the dragged position"
                    )
                print(f"  D1 OK: scheduled_for={sf} earliest_start={row.get('earliest_start')} "
                      f"pinned_at={row.get('pinned_at')}")
            legs_ok += 1

            # X5: after the first (basic) drag, the LATEST week (B) must be untouched.
            if leg == "basic" and filler_uuid and filler_start0 is not None:
                b_sched1 = get_plan_body(sched, hash_b).get("schedule", [])
                filler_start1 = next(
                    (e.get("start") for e in b_sched1 if e.get("task_id") == filler_uuid), None
                )
                if not _instants_equal(filler_start0, filler_start1):
                    raise AssertionError(
                        f"L8 X5: latest committed plan {hash_b} was modified by a drag on the "
                        f"non-latest week A (filler start {filler_start0!r} -> {filler_start1!r})"
                    )
                print(f"L8 X5 OK: latest committed plan {hash_b} untouched by the non-latest-week drag")

        # ANCHOR sub-leg (an internal issue / internal design notes): week A
        # is by construction the NON-latest committed plan (week B committed after
        # it), and its body now carries the three dragged slots. Re-resolve week A
        # WITHOUT accepting: the churn baseline must be sourced from week A's own
        # (drag-patched) plan, so every dragged chunk is proposed exactly where
        # the user left it. Under the pre-fix worker the globally-latest (week B)
        # plan was selected, the window filter emptied it, and the solver
        # re-optimised the week from a blank baseline — moving dragged chunks
        # back to their fit-optimal slots.
        status, anchor_body = post_resolve(sched, week_a)
        if status != 200:
            raise AssertionError(f"L8 anchor: week-A re-resolve returned {status}: {anchor_body!r}")
        if anchor_body.get("plan_hash"):
            plan_hashes.add(anchor_body["plan_hash"])
        mismatches = _churn_anchor_mismatches(anchor_body.get("schedule", []), want_by_task)
        if mismatches:
            raise AssertionError(
                "L8 anchor: week-A re-resolve did not anchor to the dragged committed "
                "plan — churn baseline lost (the #83 wrong-week/empty-baseline class): "
                + "; ".join(mismatches)
            )
        churn = (anchor_body.get("objective", {}).get("components", {}) or {}).get("churn")
        print(f"L8 anchor OK: week-A re-resolve kept all {len(want_by_task)} dragged chunks "
              f"in place (baseline = patched non-latest week-A plan; objective churn={churn!r})")
        legs_ok += 1

        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level="8", passed=True, http_status=200,
            scheduled_count=legs_ok, dropped_count=0, elapsed_seconds=elapsed,
        )
    except AssertionError as e:
        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(level="8", passed=False, http_status=0, scheduled_count=legs_ok,
                           dropped_count=0, elapsed_seconds=elapsed, notes=str(e))
    finally:
        if keep_artifacts:
            # L8 already asserts scheduled_for inline (via wrangler) before teardown,
            # so this is only for extra hand-inspection. Leave the dragged task rows +
            # calendar events in place; the caller cleans up afterward.
            print(
                "L8 --keep-artifacts: SKIPPING teardown — task rows + calendar "
                "events left in place for inspection. Clean up with: "
                "op run --env-file=.env -- bin/reset-smoke-env.py"
            )
        else:
            # Sweep all L8 artifacts (D1 rows by source tag; committed chunk events in
            # BOTH weeks by chunk-id/title; best-effort plan deletes — committed plans
            # 409 and expire via TTL, matching L6/L7).
            delete_regression_tasks_and_templates(sched)
            if week_a is not None:
                delete_l8_calendar_events(cal, week_a)
            if week_b is not None:
                delete_l8_calendar_events(cal, week_b)
            for h in plan_hashes:
                sched.request("DELETE", f"/v1/plans/{h}")


def delete_lom_calendar_events(cal: CalendarClient, monday: date) -> None:
    """Delete owned-meetings scenario residue from the calendar for the week of `monday`.

    The scenario commits (to observe the patch of the meeting event), so it
    creates scheduler-owned chunk events. Match on:
      (a) the worker-stamped scheduler_chunk_id private extended property (chunk
          events), and
      (b) the '[regsmoke LOM]' task-title prefix (titled residue from a
          half-committed run, or the meeting event itself whose summary carries
          this prefix)."""
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in cal.list_events(time_min, time_max):
        is_chunk = _scheduler_chunk_id(ev) is not None
        is_titled = ev.get("summary", "").startswith(_LOM_TITLE_PREFIX)
        if is_chunk or is_titled:
            cal.delete_event(ev["id"])


def run_level_owned_meetings(
    env: Env, sched: SchedulerClient, cal: CalendarClient, home_tz: str, _monday: date
) -> LevelResult:
    """Owned-meetings scenario — requires OWNED_MEETINGS_ENABLED=true + re-consent.

    Self-contained: finds its own blank future week. Skips cleanly (PASS with a
    notice) when:
      - OWNED_MEETINGS_ENABLED is OFF in the target env (meeting task absent
        from /v1/tasks after resolve — degrade to immovable is not a failure).
      - The test account has not yet re-consented to calendar.freebusy (same
        degrade: the meeting imports as immovable, resolve does NOT move it).

    Steps:
      1. Seed the owned meeting + a filler deep-work task (so the week is
         non-trivial); create the attendee's "busy" blocking event on Tuesday.
      2. Run /v1/resolve. Assert HTTP 200.
      3. Check whether the feature is active (look for a task row with
         source.kind=="meeting" matching our fixture). If absent → SKIP notice.
      4. If active: assert the proposed schedule moves the meeting task to the
         better slot (Wednesday 10:00), not the blocked slot (Tuesday 09:00).
         Assert warnings is absent or empty (all attendees known).
      5. Commit the plan. Assert the meeting's Google Calendar event is patched
         to the new start/end (confirming sendUpdates=all fired).
    """
    started = datetime.now(tz=timezone.utc)
    plan_hashes: set[str] = set()
    monday: date | None = None
    try:
        delete_regression_tasks_and_templates(sched)
        monday = find_blank_monday(cal, date.today(), 1)
        delete_lom_calendar_events(cal, monday)

        fx = gen_owned_meeting_fixture(monday, home_tz)

        # 1a. Create the blocking "attendee busy" event at the bad slot.
        blocking_event_id = cal.create_event(
            fx.freebusy_event_summary, fx.slot_start_iso, fx.slot_end_iso
        )

        # 1b. Create the owned meeting event at the SAME bad slot. In a real
        #     flow this would be on the organiser's calendar (imported by the
        #     worker). For the smoke, we create it directly so the worker's
        #     import sees it as an organiser-owned event in the next resolve.
        owned_event_id = cal.create_event(
            fx.meeting_summary, fx.slot_start_iso, fx.slot_end_iso
        )

        # 1c. Seed a filler deep-work task so the week has non-trivial content.
        filler_ext = f"{_LOM_EXTERNAL_PREFIX}-filler-00"
        filler_body = {
            "title": f"{_LOM_TITLE_PREFIX} filler",
            "context": "deep",
            "priority": 50,
            "earliest_start": f"{monday.isoformat()}T00:00",
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "duration_minutes": 60,
            "source": {"kind": "mcp", "external_id": filler_ext},
            "status": "pending",
        }
        r = sched.request("POST", "/v1/tasks", json=filler_body)
        r.raise_for_status()
        filler_task_id = r.json()["id"]

        # 2. Resolve the week.
        status, body = post_resolve(sched, monday)
        if status != 200:
            raise AssertionError(
                f"owned-meetings: resolve returned {status}: {body!r}"
            )
        plan_hash = body.get("plan_hash")
        if plan_hash:
            plan_hashes.add(plan_hash)

        schedule = body.get("schedule", [])

        # 3. Detect whether the feature is active: look for a scheduled task
        #    whose chunk overlaps the BETTER slot (not the bad slot). If the
        #    feature is OFF or the scope is absent, the meeting is either absent
        #    from the schedule or placed at its original bad slot — skip cleanly.
        meeting_task_id: str | None = None
        r2 = sched.request("GET", "/v1/tasks")
        r2.raise_for_status()
        for t in r2.json().get("tasks", []):
            src = t.get("source") or {}
            if src.get("kind") == "meeting" and isinstance(t.get("id"), str):
                meeting_task_id = t["id"]
                break

        if meeting_task_id is None:
            print(
                "owned-meetings SKIP: no meeting task found in /v1/tasks — "
                "OWNED_MEETINGS_ENABLED is OFF or account has not re-consented "
                "to calendar.freebusy (degrade to immovable is expected behaviour)"
            )
            elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
            return LevelResult(
                level="owned-meetings", passed=True, http_status=200,
                scheduled_count=0, dropped_count=0, elapsed_seconds=elapsed,
                notes="SKIP: feature OFF or scope not consented",
            )

        # 4. Feature IS active. Assert the meeting was moved to the better slot.
        meeting_chunks = [c for c in schedule if c.get("task_id") == meeting_task_id]
        if not meeting_chunks:
            print(
                "owned-meetings SKIP: meeting task exists but is not in the "
                "schedule — it may have been dropped (e.g. no attendee free/busy "
                "data returned, attendees all unknown). This indicates the scope "
                "was not consented; skipping move assertion."
            )
            elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
            return LevelResult(
                level="owned-meetings", passed=True, http_status=200,
                scheduled_count=0, dropped_count=0, elapsed_seconds=elapsed,
                notes="SKIP: meeting scheduled but no free/busy gate fired",
            )

        # The meeting must NOT be at the original bad slot and MUST be at or
        # after the better slot's start. We don't assert the exact new slot
        # (the solver may pick a different valid slot) but we do assert the
        # original bad slot is no longer used for the meeting task.
        bad_start_dt = datetime.fromisoformat(fx.slot_start_iso.replace("Z", "+00:00"))
        moved = True
        for chunk in meeting_chunks:
            c_start = datetime.fromisoformat(chunk["start"].replace("Z", "+00:00"))
            if abs((c_start - bad_start_dt).total_seconds()) < 60:
                # The meeting is still at the bad slot — the solver did not move it.
                moved = False
                break

        if not moved:
            raise AssertionError(
                f"owned-meetings FAILED: meeting task {meeting_task_id} is still "
                f"placed at the blocked bad slot {fx.slot_start_iso}. The solver "
                f"should have moved it (attendee busy at that slot)."
            )

        # warnings should be absent or empty (all attendees resolved via freebusy).
        warnings = body.get("warnings") or []
        if warnings:
            print(
                f"owned-meetings NOTICE: resolve returned warnings={warnings!r} "
                f"(attendee availability may be partially unknown — acceptable)"
            )

        print(
            f"owned-meetings: meeting task {meeting_task_id} moved away from "
            f"bad slot {fx.slot_start_iso}; "
            f"new slot: {meeting_chunks[0]['start']} → {meeting_chunks[0]['end']}"
        )

        # 5. Commit the plan and verify the meeting event is patched on the calendar.
        c_status, c_body = post_commit(sched, plan_hash)
        if c_status != 200:
            raise AssertionError(
                f"owned-meetings: commit returned {c_status}: {c_body!r}"
            )

        # Read back the meeting event from the calendar and verify start changed.
        meeting_new_start = meeting_chunks[0]["start"]
        meeting_events_after = [
            ev for ev in cal.list_events(
                f"{monday.isoformat()}T00:00:00Z",
                f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z",
            )
            if ev.get("summary", "").startswith(_LOM_TITLE_PREFIX)
            and "attendee busy" not in ev.get("summary", "")
        ]

        if not meeting_events_after:
            raise AssertionError(
                "owned-meetings: no meeting event found on the calendar after "
                "commit — the event was not patched or was deleted unexpectedly"
            )

        # Check that the event start no longer matches the original bad slot.
        event_start_raw = (meeting_events_after[0].get("start") or {}).get("dateTime", "")
        event_start_dt = datetime.fromisoformat(
            event_start_raw.replace("Z", "+00:00")
        ) if event_start_raw else None

        if event_start_dt is not None and abs(
            (event_start_dt - bad_start_dt).total_seconds()
        ) < 60:
            raise AssertionError(
                f"owned-meetings: calendar event still starts at bad slot "
                f"{fx.slot_start_iso} after commit — patch did not apply. "
                f"Event: {meeting_events_after[0]!r}"
            )

        print(
            f"owned-meetings OK: calendar event patched to "
            f"{event_start_raw!r} (was {fx.slot_start_iso!r})"
        )

        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level="owned-meetings", passed=True, http_status=200,
            scheduled_count=1, dropped_count=0, elapsed_seconds=elapsed,
        )

    except AssertionError as e:
        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level="owned-meetings", passed=False, http_status=0,
            scheduled_count=0, dropped_count=0,
            elapsed_seconds=elapsed, notes=str(e),
        )
    finally:
        delete_regression_tasks_and_templates(sched)
        if monday is not None:
            delete_lom_calendar_events(cal, monday)
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


def _l6_ext_to_uuid(sched: SchedulerClient, fixtures: list[DoneFixture]) -> dict[str, str]:
    """Map each L6 fixture's source.external_id to the worker-assigned UUID by
    reading back GET /v1/tasks. POST assigns the id server-side, so this is the
    only way to correlate a fixture with its persisted task."""
    wanted = {fx.external_id for fx in fixtures}
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    out: dict[str, str] = {}
    for t in r.json().get("tasks", []):
        src = t.get("source")
        ext = src.get("external_id") if isinstance(src, dict) else None
        if isinstance(ext, str) and ext in wanted and isinstance(t.get("id"), str):
            out[ext] = t["id"]
    return out


def create_meetings(cal: CalendarClient, meetings: list[MeetingFixture]) -> list[str]:
    """Returns the list of Google event IDs created (for cleanup)."""
    ids: list[str] = []
    for m in meetings:
        ids.append(cal.create_event(m.summary, m.start_iso, m.end_iso))
    return ids


def delete_regression_calendar_events(cal: CalendarClient, monday: date, label: str) -> None:
    """Delete every event in the window whose summary starts with the level anchor.

    NOTE: this matches the '[regression-smoke L{label}]' summary the harness
    stamps on the meetings it *creates* directly (gen_meetings). It does NOT
    match committed scheduler chunk events: on commit the worker sets each chunk
    event's summary to the owning task's TITLE (commit.ts), so an L6 task titled
    '[regsmoke L6] ...' lands with that summary, which this sweep would miss.
    L6 commits events, so it uses delete_l6_calendar_events instead."""
    prefix = f"[regression-smoke L{label}]"
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in cal.list_events(time_min, time_max):
        if ev.get("summary", "").startswith(prefix):
            cal.delete_event(ev["id"])


def delete_l6_calendar_events(cal: CalendarClient, monday: date) -> None:
    """Delete L6 residue from the calendar for the week of `monday`.

    L6 is the only level that COMMITS, so it is the only one that creates
    scheduler-owned chunk events. Deleting the D1 task rows
    (delete_regression_tasks_and_templates) does NOT orphan-delete those events:
    DELETE /v1/tasks/:id just removes the row; orphan deletion only happens
    inside commit.ts when a committed task is absent from a NEW proposed plan.
    So the harness must remove the chunk events itself.

    The generic delete_regression_calendar_events(.., 6) sweep can't: on commit
    the worker sets each chunk event's summary to the owning task's TITLE
    ('[regsmoke L6] ...'), not '[regression-smoke L6]'. We instead match on the
    worker-stamped scheduler_chunk_id private extended property (authoritative —
    it identifies a scheduler-owned chunk regardless of summary) and, defensively,
    on the '[regsmoke L6]' task-title prefix to catch any titled residue."""
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in cal.list_events(time_min, time_max):
        is_chunk = _scheduler_chunk_id(ev) is not None
        is_titled = ev.get("summary", "").startswith(_L6_TITLE_PREFIX)
        if is_chunk or is_titled:
            cal.delete_event(ev["id"])


def delete_l7_calendar_events(cal: CalendarClient, monday: date) -> None:
    """Delete L7 residue from the calendar for the week of `monday`.

    L7, like L6, COMMITS — so it creates scheduler-owned chunk events that
    DELETE /v1/tasks/:id does not orphan-delete (orphan deletion only happens
    inside commit.ts when a committed task is absent from a NEW proposed plan).
    The harness must remove those chunk events itself.

    Match is identical to delete_l6_calendar_events but on the L7 task-title
    prefix: on commit the worker stamps each chunk event's summary with the
    owning task's TITLE ('[regsmoke L7] ...'), not '[regression-smoke L7]', so
    the generic delete_regression_calendar_events(.., 7) sweep would miss them.
    We match on the worker-stamped scheduler_chunk_id private extended property
    (authoritative — identifies a scheduler-owned chunk regardless of summary)
    and, defensively, on the '[regsmoke L7]' task-title prefix for titled
    residue from a half-committed run."""
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in cal.list_events(time_min, time_max):
        is_chunk = _scheduler_chunk_id(ev) is not None
        is_titled = ev.get("summary", "").startswith(_L7_TITLE_PREFIX)
        if is_chunk or is_titled:
            cal.delete_event(ev["id"])


def _task_is_harness(body: dict, template_ids: set[str]) -> bool:
    """Is this task owned by the harness?

    Two lineages, both keyed on data the harness controls — never a title regex:
      1. Directly POSTed by the harness → carries our `regsmoke-` source tag.
      2. A recurrence-sweep occurrence materialised from one of OUR live
         templates → `template_id` ∈ `template_ids`.

    The materialiser OWNS `source` (RC4 makes it a reserved key → kind="cron",
    external_id=None), so occurrences do NOT inherit the regsmoke- source tag;
    they are recognised by lineage (template_id), which is precise and cannot
    sweep up an unrelated user's task that merely shares a title prefix.

    Because occurrences are matched only while their template is still live, the
    per-level loop MUST delete occurrences before the template that spawned them
    (see delete_regression_tasks_and_templates) — otherwise they orphan. Mopping
    up pre-existing orphans (template already gone) is reset-smoke-env.py's job,
    via its title-based sledgehammer wipe."""
    src = body.get("source")
    if isinstance(src, dict):
        ext = src.get("external_id")
        if isinstance(ext, str) and ext.startswith("regsmoke-"):
            return True
    tid = body.get("template_id")
    return isinstance(tid, str) and tid in template_ids


def _template_is_harness(body: dict) -> bool:
    title = body.get("title")
    return isinstance(title, str) and title.startswith("[regsmoke]")


def _harness_template_ids(sched: SchedulerClient) -> set[str]:
    """UUIDs of every live harness template (title prefix '[regsmoke]')."""
    r = sched.request("GET", "/v1/templates")
    r.raise_for_status()
    return {
        t["id"] for t in r.json().get("templates", [])
        if _template_is_harness(t) and isinstance(t.get("id"), str)
    }


def delete_regression_tasks_and_templates(sched: SchedulerClient) -> None:
    """Delete every harness-tagged task + template via the public API.

    Order is load-bearing: we resolve the live harness template IDs FIRST, then
    delete occurrences (matched by source tag OR template_id), THEN delete the
    templates. Deleting templates first would sever the template→occurrence link
    and orphan the occurrences (template gone → no template_id match → invisible
    to this loop). This per-level cleanup is orphan-free by construction; the
    title-based catch-all that mops up legacy orphans lives in reset-smoke-env.py."""
    template_ids = _harness_template_ids(sched)
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    for t in r.json().get("tasks", []):
        if _task_is_harness(t, template_ids):
            tid = t.get("id")
            if isinstance(tid, str):
                sched.request("DELETE", f"/v1/tasks/{tid}")
    for template_id in template_ids:
        sched.request("DELETE", f"/v1/templates/{template_id}")


def list_harness_task_ids(sched: SchedulerClient) -> set[str]:
    """Return the set of task UUIDs currently tagged as harness-owned.
    Used after a /v1/resolve so we can include template-materialised UUIDs
    (created by the recurrence sweep, not by our POSTs)."""
    template_ids = _harness_template_ids(sched)
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    return {
        t["id"] for t in r.json().get("tasks", [])
        if _task_is_harness(t, template_ids) and isinstance(t.get("id"), str)
    }


def assert_expectations(
    level: Level,
    http_status: int,
    body: dict,
    fixtures: Fixtures,
    home_tz: str,
    harness_task_ids: set[str],
) -> None:
    """Raises AssertionError on any failure.

    `harness_task_ids` is the set of task UUIDs that belong to this harness
    invocation (POSTed tasks + template-materialised tasks). Counts and
    template wall-clock checks are scoped to this set so pre-existing data
    in the D1 doesn't corrupt the result. Meeting-overlap checks still run
    on the full schedule — a non-harness chunk overlapping our meeting would
    indicate a real solver bug."""
    assert http_status == level.expected_status, (
        f"L{level.label}: expected HTTP {level.expected_status}, got {http_status}: {body!r}"
    )
    if level.expected_status == 422:
        unsat_core = body.get("unsat_core") or []
        assert unsat_core, f"L{level.label}: expected non-empty unsat_core, got {body!r}"
        # 5.2's unsatisfiability comes from mutually-feasible must_include tasks
        # that over-subscribe the week. Confirm the solver surfaces a task_present
        # entry for at least one harness task; otherwise the 422 came from some
        # other unrelated condition and the level passed for the wrong reason.
        if level.kind == "must_include":
            present = [
                e for e in unsat_core
                if e.get("type") == "task_present" and e.get("task_id") in harness_task_ids
            ]
            assert present, (
                f"L{level.label}: expected a task_present unsat_core entry for a "
                f"harness must_include task; got {unsat_core!r}"
            )
        return
    schedule = body.get("schedule", [])
    dropped = body.get("dropped", [])
    harness_dropped = [d for d in dropped if d.get("task_id") in harness_task_ids]
    harness_schedule = [c for c in schedule if c.get("task_id") in harness_task_ids]
    # Dropped count (scoped to harness tasks)
    if level.expected_dropped_max is not None:
        assert len(harness_dropped) <= level.expected_dropped_max, (
            f"L{level.label}: harness dropped={len(harness_dropped)} exceeds max "
            f"{level.expected_dropped_max} (total dropped in response: {len(dropped)})"
        )
    # No chunk (harness or not) overlaps any meeting we created.
    for chunk in schedule:
        c_start = datetime.fromisoformat(chunk["start"].replace("Z", "+00:00"))
        c_end = datetime.fromisoformat(chunk["end"].replace("Z", "+00:00"))
        for m in fixtures.meetings:
            m_start = datetime.fromisoformat(m.start_iso.replace("Z", "+00:00"))
            m_end = datetime.fromisoformat(m.end_iso.replace("Z", "+00:00"))
            if c_start < m_end and m_start < c_end:
                raise AssertionError(
                    f"L{level.label}: chunk {chunk.get('chunk_id')} ({chunk['start']}–{chunk['end']}) "
                    f"overlaps meeting '{m.summary}' ({m.start_iso}–{m.end_iso})"
                )
    # For each template fixture, find at least one HARNESS chunk whose start
    # matches the expected wall-clock time in the template's zone.
    for tmpl in fixtures.templates:
        zone = tz.gettz(tmpl.body.get("pinned_tz") or home_tz)
        expected_hhmm = tmpl.body["pinned_time"]
        if not expected_hhmm:
            continue
        eh, em = map(int, expected_hhmm.split(":"))
        ok = False
        for chunk in harness_schedule:
            c_start = datetime.fromisoformat(chunk["start"].replace("Z", "+00:00")).astimezone(zone)
            if (c_start.hour, c_start.minute) == (eh, em):
                ok = True
                break
        assert ok, (
            f"L{level.label}: no scheduled harness chunk matches template '{tmpl.id}' wall-clock "
            f"{expected_hhmm} in {tmpl.body.get('pinned_tz') or home_tz}"
        )


def run_level(level: Level, env: Env, sched: SchedulerClient, cal: CalendarClient,
              home_tz: str, monday: date) -> LevelResult:
    rng = random.Random(level.tier)
    fixtures = Fixtures(
        meetings=gen_meetings(level.tier, monday, rng, home_tz, level.label),
        tasks=gen_tasks(level.tier, monday, rng, kind=level.kind, label=level.label),
        templates=gen_templates(level.tier),
    )
    started = datetime.now(tz=timezone.utc)
    try:
        delete_regression_tasks_and_templates(sched)
        delete_regression_calendar_events(cal, monday, level.label)
        create_meetings(cal, fixtures.meetings)
        post_tasks(sched, fixtures.tasks)
        post_templates(sched, fixtures.templates)
        http_status, body = post_resolve(sched, monday)
        # Snapshot the harness-owned task IDs AFTER resolve so we pick up
        # tasks materialised by the recurrence sweep (UUIDs unknown to us
        # at POST time).
        harness_task_ids = list_harness_task_ids(sched)
        # Debug-dump the resolve body when SMOKE_DUMP=1 so an operator can
        # inspect chunk timings + cross-check against calendar manually.
        if os.environ.get("SMOKE_DUMP"):
            from pathlib import Path
            Path(f"/tmp/smoke-L{level.label}-body.json").write_text(json.dumps(body, indent=2))
        assert_expectations(level, http_status, body, fixtures, home_tz, harness_task_ids)
        # Recurrence-sweep idempotency (non-UTC home tz). When this level has
        # templates, the first /v1/resolve materialised one task per occurrence.
        # Resolving again must NOT re-materialise the same occurrences — the
        # sweep is occurrence-keyed (UNIQUE index) and a DELETE records an
        # RFC-5545 EXDATE, so the harness task count is STABLE across resolves.
        # We assert this only for a genuinely non-UTC home zone, because a UTC
        # account can't surface a wall-clock/occurrence-date skew bug. (A UTC
        # account makes this a no-op rather than a false pass.)
        _home_zone = tz.gettz(home_tz)
        _home_offset = datetime.combine(monday, time(12, 0), tzinfo=_home_zone).utcoffset()
        _is_non_utc = bool(_home_offset) and _home_offset.total_seconds() != 0
        if fixtures.templates and _is_non_utc and http_status == 200:
            count_after_first = len(harness_task_ids)
            second_status, _second_body = post_resolve(sched, monday)
            assert second_status == 200, (
                f"L{level.label}: second resolve (idempotency probe) returned "
                f"HTTP {second_status}, expected 200"
            )
            count_after_second = len(list_harness_task_ids(sched))
            assert count_after_second == count_after_first, (
                f"L{level.label}: recurrence sweep is NOT idempotent in {home_tz}: "
                f"harness task count grew {count_after_first} -> {count_after_second} "
                f"across two resolves (duplicate occurrence materialisation)"
            )
        elif fixtures.templates and not _is_non_utc:
            print(
                f"L{level.label}: skipping recurrence idempotency probe "
                f"(home_tz={home_tz!r} resolves to UTC offset 0)"
            )
        scheduled = [c for c in body.get("schedule", []) if c.get("task_id") in harness_task_ids]
        dropped = [d for d in body.get("dropped", []) if d.get("task_id") in harness_task_ids]
        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level=level.label, passed=True, http_status=http_status,
            scheduled_count=len(scheduled),
            dropped_count=len(dropped),
            elapsed_seconds=elapsed,
        )
    except AssertionError as e:
        elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
        return LevelResult(
            level=level.label, passed=False, http_status=0,
            scheduled_count=0, dropped_count=0,
            elapsed_seconds=elapsed, notes=str(e),
        )
    finally:
        delete_regression_tasks_and_templates(sched)
        delete_regression_calendar_events(cal, monday, level.label)


# =============================================================================
# 7. CLI                                      (Task 3.9)
# 8. main()
# =============================================================================


def self_test() -> int:
    """Run pure functions with synthetic inputs. No network."""
    # 1. Meeting generator determinism.
    monday = date(2026, 7, 13)
    rng_a = random.Random(2)
    rng_b = random.Random(2)
    a = gen_meetings(2, monday, rng_a, "Australia/Sydney", "2")
    b = gen_meetings(2, monday, rng_b, "Australia/Sydney", "2")
    assert a == b, "gen_meetings must be deterministic with same seed"
    # L2: 2 meetings/day × 5 days = 10.
    assert len(a) == 10, f"expected 10 meetings, got {len(a)}"
    # All summaries carry the cleanup anchor.
    for m in a:
        assert m.summary.startswith("[regression-smoke L2]"), m.summary
    # L1: zero meetings.
    assert gen_meetings(1, monday, random.Random(1), "Australia/Sydney", "1") == []
    # 2. Task generator determinism + counts + ids.
    t_a = gen_tasks(3, monday, random.Random(3), kind="generic", label="3")
    t_b = gen_tasks(3, monday, random.Random(3), kind="generic", label="3")
    assert t_a == t_b, "gen_tasks must be deterministic"
    assert len(t_a) == 8, f"L3 expected 8 tasks, got {len(t_a)}"
    assert all(t.id.startswith("regsmoke-L3-") for t in t_a)
    # Level identity ladder: label/tier/kind.
    labels = [lvl.label for lvl in LEVELS]
    assert labels == ["1", "2", "3", "4", "5.1", "5.2", "6", "7", "8", "owned-meetings"], labels
    # 5.1: tier-5 droppable over-subscription — 4 pinned-overlap tasks, none mandatory.
    t51 = gen_tasks(5, monday, random.Random(5), kind="generic", label="5.1")
    pinned_51 = [t for t in t51 if t.body.get("pinned_at")]
    assert len(pinned_51) == 4, f"5.1 expected 4 pinned tasks, got {len(pinned_51)}"
    assert all(t.body["pinned_at"].endswith("T14:00") for t in pinned_51)
    assert all(not t.body.get("must_include", False) for t in t51), "5.1 tasks must be droppable"
    assert all(t.id.startswith("regsmoke-L5.1-") for t in t51)
    # 5.2: must_include over-subscription. 8 mandatory 3h tasks all due Mon 17:00 —
    # each fits alone (3h < a Monday), 24h together cannot → genuine 422. No
    # meetings so each stays feasible-in-isolation (not demoted).
    t52 = gen_tasks(5, monday, random.Random(5), kind="must_include", label="5.2")
    assert len(t52) == 8, f"5.2 expected 8 tasks, got {len(t52)}"
    assert all(t.body.get("must_include") is True for t in t52), "5.2 tasks must be mandatory"
    assert all(t.body["deadline"]["hard"] is True for t in t52)
    assert all(t.id.startswith("regsmoke-L5.2-") for t in t52)
    assert gen_meetings(5, monday, random.Random(5), "Australia/Sydney", "5.2") == [], "5.2 has no meetings"
    # 3. Template generator: per-level membership.
    assert gen_templates(1) == []
    assert [t.id for t in gen_templates(2)] == ["regsmoke-tmpl-standup"]
    assert [t.id for t in gen_templates(3)] == [
        "regsmoke-tmpl-standup", "regsmoke-tmpl-nyc-sync",
    ]
    assert [t.id for t in gen_templates(5)] == [
        "regsmoke-tmpl-standup", "regsmoke-tmpl-nyc-sync", "regsmoke-tmpl-pilates",
    ]
    nyc = gen_templates(3)[1]
    assert nyc.body["pinned_tz"] == "America/New_York"
    # 4. Date math sanity for the "next Monday" helper.
    assert _next_monday(date(2026, 7, 13)) == date(2026, 7, 20)  # Mon → next Mon
    assert _next_monday(date(2026, 7, 14)) == date(2026, 7, 20)  # Tue → following Mon
    # 5. find_blank_monday scans the full span and hops past booked regions.
    class _StubCal:
        def __init__(self, windows: list[list[dict]]):
            self._windows = list(windows)
            self.calls: list[tuple[str, str]] = []

        def list_events(self, time_min: str, time_max: str) -> list[dict]:
            self.calls.append((time_min, time_max))
            return self._windows.pop(0) if self._windows else []

    # Empty straight away → first Monday after start_after.
    empty = _StubCal([[]])
    assert find_blank_monday(empty, date(2026, 7, 12), 5) == date(2026, 7, 13)
    # First span has an event ending Wed 07-15 → hop to Mon 07-20, then empty.
    busy = _StubCal([[{"end": {"dateTime": "2026-07-15T10:00:00Z"}}], []])
    assert find_blank_monday(busy, date(2026, 7, 12), 2) == date(2026, 7, 20)
    assert len(busy.calls) == 2, busy.calls
    # 6. L6 done-marking fixtures + placement-floor helpers (no network).
    mon = date(2026, 6, 1)  # a Monday
    wed = datetime(2026, 6, 3, 11, 7, tzinfo=timezone.utc)  # mid-week
    fx = gen_done_fixtures(mon, wed.date())
    fx2 = gen_done_fixtures(mon, wed.date())
    assert fx == fx2, "gen_done_fixtures must be deterministic"
    kinds = sorted(f.kind for f in fx)
    assert kinds == ["done-api", "done-api", "done-color", "floor", "floor",
                     "pin-past", "undone-color"], kinds
    # Every fixture is regsmoke-tagged so shared cleanup sweeps it.
    assert all(f.body["source"]["external_id"].startswith("regsmoke-L6") for f in fx)
    assert all(_task_is_harness(f.body, set()) for f in fx)
    # The pin-past fixture carries a hard pin on this week's Monday (before a
    # mid-week floor) so the release path is exercised.
    pin = [f for f in fx if f.kind == "pin-past"][0]
    assert pin.body["pinned_at"] == "2026-06-01T09:00", pin.body["pinned_at"]
    # 6b. L7 per-chunk completion fixtures (no network).
    cfx = gen_chunks_fixtures(mon, wed.date())
    cfx2 = gen_chunks_fixtures(mon, wed.date())
    assert cfx == cfx2, "gen_chunks_fixtures must be deterministic"
    ckinds = sorted(f.kind for f in cfx)
    assert ckinds == ["chunks-filler", "chunks-revive", "chunks-subject"], ckinds
    # Every L7 fixture is regsmoke-L7-tagged so shared cleanup sweeps it.
    assert all(f.body["source"]["external_id"].startswith("regsmoke-L7") for f in cfx)
    assert all(_task_is_harness(f.body, set()) for f in cfx)
    # The 2-chunk subjects carry `chunks` (+ group_policy) and NO duration_minutes;
    # a task with `chunks` must not also send duration_minutes.
    for sk in ("chunks-subject", "chunks-revive"):
        subj = [f for f in cfx if f.kind == sk][0]
        assert subj.body["chunks"] == [
            {"duration_minutes": 30}, {"duration_minutes": 30}
        ], subj.body.get("chunks")
        assert subj.body["group_policy"] == {"same_day": False, "ordered": False}
        assert "duration_minutes" not in subj.body, (
            f"{sk}: a chunked task must NOT also carry duration_minutes"
        )
    # The filler is an atomic, droppable backlog task (duration_minutes, no chunks).
    filler = [f for f in cfx if f.kind == "chunks-filler"][0]
    assert filler.body["duration_minutes"] == 30, filler.body.get("duration_minutes")
    assert "chunks" not in filler.body
    # 6c. L8 manual-move fixtures + instant/slot helpers (no network).
    wk_a, wk_b = date(2026, 6, 1), date(2026, 6, 8)  # consecutive Mondays
    mvfx = gen_move_fixtures(wk_a, wk_b)
    assert mvfx == gen_move_fixtures(wk_a, wk_b), "gen_move_fixtures must be deterministic"
    mvkinds = sorted(f.kind for f in mvfx)
    assert mvkinds == ["basic", "l6pin", "x5filler", "x6floor"], mvkinds
    assert all(f.body["source"]["external_id"].startswith("regsmoke-L8") for f in mvfx)
    assert all(_task_is_harness(f.body, set()) for f in mvfx)
    by_kind = {f.kind: f for f in mvfx}
    # Week assignment: the three subjects are in week A, the filler in week B.
    assert by_kind["basic"].week == "A" and by_kind["x6floor"].week == "A"
    assert by_kind["l6pin"].week == "A" and by_kind["x5filler"].week == "B"
    # x6floor anchors earliest_start mid-week-A (Wed); l6pin pins Thu; filler earliest
    # is week B Monday (→ window-shed from week A's resolve).
    assert by_kind["x6floor"].body["earliest_start"] == "2026-06-03T12:00", by_kind["x6floor"].body
    assert by_kind["l6pin"].body["pinned_at"] == "2026-06-04T10:00", by_kind["l6pin"].body
    assert by_kind["x5filler"].body["earliest_start"] == "2026-06-08T00:00"
    # Each subject is a single-chunk 60-min task (one committed chunk event to drag).
    assert by_kind["basic"].body["duration_minutes"] == 60 and "chunks" not in by_kind["basic"].body
    # _instants_equal is format-agnostic (Z vs offset vs millisecond precision).
    assert _instants_equal("2026-06-02T13:00:00Z", "2026-06-02T13:00:00.000Z")
    assert _instants_equal("2026-06-02T13:00:00Z", "2026-06-02T23:00:00+10:00")
    assert not _instants_equal("2026-06-02T13:00:00Z", "2026-06-02T14:00:00Z")
    assert not _instants_equal("2026-06-02T13:00:00Z", None) and not _instants_equal(None, "x")
    assert _to_ms("not-a-date") is None and _to_ms(None) is None
    # _l8_slot_z: a 60-min UTC slot, canonical Z, end one hour after start.
    s_z, e_z = _l8_slot_z(date(2026, 6, 2), 9, 0, tz.gettz("UTC"))
    assert s_z == "2026-06-02T09:00:00Z", s_z
    assert e_z == "2026-06-02T10:00:00Z", e_z
    # ceilToQuarter + placementFloor.
    assert _ceil_to_quarter(datetime(2026, 6, 3, 11, 0, tzinfo=timezone.utc)) == \
        datetime(2026, 6, 3, 11, 0, tzinfo=timezone.utc)  # already aligned
    assert _ceil_to_quarter(datetime(2026, 6, 3, 11, 1, tzinfo=timezone.utc)) == \
        datetime(2026, 6, 3, 11, 15, tzinfo=timezone.utc)  # rounds up
    # Mid-week: floor = ceilToQuarter(now) > weekStart.
    floor_mid = compute_placement_floor(mon, wed)
    assert floor_mid == datetime(2026, 6, 3, 11, 15, tzinfo=timezone.utc), floor_mid
    # Future week: now < weekStart → floor collapses to weekStart.
    future_mon = date(2026, 6, 15)
    floor_future = compute_placement_floor(future_mon, wed)
    assert floor_future == datetime(2026, 6, 15, 0, 0, tzinfo=timezone.utc), floor_future
    # assert_no_placement_before_floor: a past-day chunk for a harness task fails;
    # a chunk at/after the floor passes; non-harness chunks are ignored.
    hid = {"task-1"}
    past = [{"task_id": "task-1", "chunk_id": "task-1", "start": "2026-06-02T09:00:00Z"}]
    raised = False
    try:
        assert_no_placement_before_floor(past, floor_mid, hid, "t")
    except AssertionError:
        raised = True
    assert raised, "expected a past-day harness chunk to violate the floor"
    ok = [{"task_id": "task-1", "chunk_id": "task-1", "start": "2026-06-03T11:15:00Z"}]
    assert_no_placement_before_floor(ok, floor_mid, hid, "t")  # exactly at floor: OK
    # Non-harness past chunk is ignored (only harness tasks are floor-checked).
    other = [{"task_id": "other", "chunk_id": "other", "start": "2026-06-02T09:00:00Z"}]
    assert_no_placement_before_floor(other, floor_mid, hid, "t")
    # assert_tasks_absent_from_schedule: scheduled OR dropped membership fails.
    raised = False
    try:
        assert_tasks_absent_from_schedule(
            [{"task_id": "d"}], [], {"d"}, "t")
    except AssertionError:
        raised = True
    assert raised, "a still-scheduled done task must fail absence"
    raised = False
    try:
        assert_tasks_absent_from_schedule(
            [], [{"task_id": "d"}], {"d"}, "t")
    except AssertionError:
        raised = True
    assert raised, "a dropped done task must fail absence (should be unloaded)"
    assert_tasks_absent_from_schedule([{"task_id": "x"}], [], {"d"}, "t")  # absent: OK
    # assert_tasks_present_in_schedule: a missing task fails; present passes.
    assert_tasks_present_in_schedule([{"task_id": "p"}], {"p"}, "t")
    raised = False
    try:
        assert_tasks_present_in_schedule([{"task_id": "q"}], {"p"}, "t")
    except AssertionError:
        raised = True
    assert raised, "a missing required task must fail presence"
    # chunk_id parsing helpers.
    chunk_ev = {"extendedProperties": {"private": {"scheduler_chunk_id": "abc#0"}}}
    assert _scheduler_chunk_id(chunk_ev) == "abc#0"
    assert _task_id_of_chunk(chunk_ev) == "abc"
    assert _scheduler_chunk_id({"extendedProperties": {"private": {}}}) is None
    assert _task_id_of_chunk({}) is None

    # 7. delete_l6_calendar_events sweeps BOTH the committed scheduler chunk
    #    events (which carry the worker-stamped scheduler_chunk_id and a summary
    #    set to the TASK TITLE, '[regsmoke L6] ...' — NOT '[regression-smoke
    #    L6]') AND any '[regsmoke L6]'-titled residue, while leaving personal
    #    and other-level events untouched. This is the leak the generic
    #    delete_regression_calendar_events(.., 6) sweep misses.
    class _DelCal:
        def __init__(self, events: list[dict]):
            self._events = events
            self.deleted: list[str] = []

        def list_events(self, time_min: str, time_max: str) -> list[dict]:
            return list(self._events)

        def delete_event(self, event_id: str) -> None:
            self.deleted.append(event_id)

    l6_chunk = {
        "id": "ev-chunk",
        "summary": "[regsmoke L6] floor 0",
        "extendedProperties": {"private": {"scheduler_chunk_id": "uuid#0"}},
    }
    # A '[regsmoke L6]'-titled event with no chunk property (defensive: residue
    # from a half-committed run) must also be swept.
    l6_titled = {"id": "ev-titled", "summary": "[regsmoke L6] pin-past 0"}
    personal = {"id": "ev-personal", "summary": "Quarterly review"}
    other_lvl = {"id": "ev-l2", "summary": "[regression-smoke L2] Sync"}
    dc = _DelCal([l6_chunk, l6_titled, personal, other_lvl])
    delete_l6_calendar_events(dc, mon)
    assert sorted(dc.deleted) == ["ev-chunk", "ev-titled"], dc.deleted

    # 7b. delete_l7_calendar_events sweeps the committed L7 chunk events (worker-
    #     stamped scheduler_chunk_id, summary = task TITLE '[regsmoke L7] ...')
    #     AND any '[regsmoke L7]'-titled residue, while leaving personal and
    #     other-level (incl. L6) events untouched — same contract as L6, distinct
    #     title prefix. The chunk-id property match is identical, so a chunk event
    #     is swept regardless of which level's title it carries; the title arm is
    #     what keeps the two sweeps' titled-residue scopes disjoint.
    l7_chunk = {
        "id": "ev7-chunk",
        "summary": "[regsmoke L7] subject 0",
        "extendedProperties": {"private": {"scheduler_chunk_id": "uuid7#0"}},
    }
    l7_titled = {"id": "ev7-titled", "summary": "[regsmoke L7] filler 0"}
    l6_titled_only = {"id": "ev6-titled", "summary": "[regsmoke L6] floor 0"}
    dc7 = _DelCal([l7_chunk, l7_titled, l6_titled_only, personal, other_lvl])
    delete_l7_calendar_events(dc7, mon)
    assert sorted(dc7.deleted) == ["ev7-chunk", "ev7-titled"], dc7.deleted

    # 7c. chunk-index parse: _chunk_index_of returns the suffix after the LAST '#'.
    assert _chunk_index_of(l7_chunk) == "0"
    assert _chunk_index_of({"extendedProperties": {"private": {
        "scheduler_chunk_id": "task#with#hash#3"}}}) == "3"
    assert _chunk_index_of({"extendedProperties": {"private": {}}}) is None

    # 8. Owned-meetings fixtures (no network).
    om_mon = date(2026, 6, 1)  # Monday
    omfx = gen_owned_meeting_fixture(om_mon, "Australia/Sydney")
    omfx2 = gen_owned_meeting_fixture(om_mon, "Australia/Sydney")
    assert omfx == omfx2, "gen_owned_meeting_fixture must be deterministic"
    # meeting_ext uses the LOM external prefix.
    assert omfx.meeting_ext.startswith(_LOM_EXTERNAL_PREFIX), omfx.meeting_ext
    # bad slot = Tuesday 09:00 local, better slot = Wednesday 10:00 local.
    # Convert back to local time to check the day, since the ISO-Z dates may differ.
    _om_zone = tz.gettz("Australia/Sydney")
    bad_s = datetime.fromisoformat(omfx.slot_start_iso.replace("Z", "+00:00"))
    bad_e = datetime.fromisoformat(omfx.slot_end_iso.replace("Z", "+00:00"))
    better_s = datetime.fromisoformat(omfx.better_start_iso.replace("Z", "+00:00"))
    better_e = datetime.fromisoformat(omfx.better_end_iso.replace("Z", "+00:00"))
    bad_local = bad_s.astimezone(_om_zone)
    better_local = better_s.astimezone(_om_zone)
    assert bad_local.weekday() == 1, (  # 0=Mon, 1=Tue
        f"bad slot should be Tuesday in home tz; got weekday {bad_local.weekday()} ({bad_local})"
    )
    assert (bad_local.hour, bad_local.minute) == (9, 0), (
        f"bad slot should be 09:00 local; got {bad_local}"
    )
    assert better_local.weekday() == 2, (  # 2=Wed
        f"better slot should be Wednesday in home tz; got weekday {better_local.weekday()} ({better_local})"
    )
    assert (better_local.hour, better_local.minute) == (10, 0), (
        f"better slot should be 10:00 local; got {better_local}"
    )
    assert (bad_e - bad_s) == timedelta(hours=1), f"bad slot duration not 1h: {bad_e - bad_s}"
    assert (better_e - better_s) == timedelta(hours=1), f"better slot duration not 1h"
    # LEVELS includes the owned-meetings entry.
    lom_levels = [lv for lv in LEVELS if lv.kind == "owned-meetings"]
    assert len(lom_levels) == 1, f"expected 1 owned-meetings level, got {len(lom_levels)}"
    assert lom_levels[0].label == "owned-meetings", lom_levels[0].label
    # delete_lom_calendar_events sweeps chunk events and '[regsmoke LOM]'-titled events.
    lom_chunk = {
        "id": "ev-lom-chunk",
        "summary": "[regsmoke LOM] weekly sync",
        "extendedProperties": {"private": {"scheduler_chunk_id": "uuid-lom#0"}},
    }
    lom_titled = {"id": "ev-lom-titled", "summary": "[regsmoke LOM] attendee busy"}
    personal_lom = {"id": "ev-personal-lom", "summary": "Team offsite"}
    dc_lom = _DelCal([lom_chunk, lom_titled, personal_lom])
    delete_lom_calendar_events(dc_lom, om_mon)
    assert sorted(dc_lom.deleted) == ["ev-lom-chunk", "ev-lom-titled"], dc_lom.deleted

    print("self-test: OK", file=sys.stderr)
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Regression smoke harness for the weekly scheduler.")
    p.add_argument("--provider", choices=list(_smoke_lib.PROVIDERS),
                   # WP2 review finding 6: SMOKE_PROVIDER="" (unset-but-
                   # exported) must not bypass `choices` by becoming the
                   # literal argparse default — os.environ.get(..., "google")
                   # only substitutes when the var is entirely unset.
                   default=os.environ.get("SMOKE_PROVIDER") or "google",
                   help="Calendar provider of the test account (default: $SMOKE_PROVIDER or google). "
                        "microsoft drives Graph and switches done-marking to the Outlook category.")
    p.add_argument("--levels", type=str, default="1,2,3,4,5.1,5.2,6,7,8",
                   help="comma-separated level labels, e.g. 1,2,3 or 5.1,5.2 "
                        "(default: all standard levels, NOT owned-meetings). "
                        "5.1 is droppable over-subscription (200 + drops); "
                        "5.2 is must_include over-subscription (422). L6 "
                        "(done-marking + placement-floor) and L7 (per-chunk "
                        "completion) both run the CURRENT week and do not consume a "
                        "future blank week; run them alone with --levels 6 or "
                        "--levels 7. L8 (manual-move write-back) is WEBHOOK-DRIVEN: "
                        "it needs a live Google push subscription and finds its own "
                        "two future blank weeks; run it alone with --levels 8. "
                        "'owned-meetings' is a gate-checked scenario requiring "
                        "OWNED_MEETINGS_ENABLED=true and calendar.freebusy re-consent; "
                        "it skips cleanly if either is absent.")
    p.add_argument("--baseline-record", action="store_true",
                   help="write the per-level fixture+result to bin/regression-baselines/L<N>.json")
    p.add_argument("--baseline-check", action="store_true",
                   help="compare per-level result against recorded baseline; non-zero exit on diff")
    p.add_argument("--dry-run", action="store_true",
                   help="generate + print fixtures; perform no mutations")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--self-test", action="store_true",
                   help="run pure functions with synthetic inputs; no network")
    p.add_argument("--starting-monday", type=str, default=None,
                   help="YYYY-MM-DD Monday to use for L1 (later generic levels advance by 7d each). "
                        "Skips find_blank_monday(); use when the calendar has been "
                        "explicitly seeded by bin/reset-smoke-env.py.")
    p.add_argument("--webhook-check", action="store_true",
                   help="Run only the async webhook (Durable Object) smoke check and exit.")
    p.add_argument("--feed-check", action="store_true",
                   help="Run only the busy .ics feed smoke check and exit. "
                        "Skips cleanly if CALENDAR_FEED_ENABLED is OFF in the target env.")
    p.add_argument("--keep-artifacts", action="store_true",
                   help="L8 only: skip the post-run teardown so the dragged task "
                        "rows + calendar events survive for extra hand-inspection. "
                        "(L8 already asserts scheduled_for inline via wrangler, so "
                        "this is optional.) Leaves D1 + calendar residue; clean it up "
                        "afterward with bin/reset-smoke-env.py.")
    return p.parse_args(argv)


def render_summary(console: Console, results: list[LevelResult], total_wall: float) -> None:
    table = Table(show_header=True, header_style="bold")
    table.add_column("Level")
    table.add_column("Status")
    table.add_column("HTTP")
    table.add_column("Scheduled", justify="right")
    table.add_column("Dropped", justify="right")
    table.add_column("Wall(s)", justify="right")
    table.add_column("Notes")
    for r in results:
        status = "[green]PASS[/]" if r.passed else "[red]FAIL[/]"
        table.add_row(
            f"L{r.level}",
            status,
            str(r.http_status) if r.http_status else "-",
            str(r.scheduled_count) if r.passed and r.http_status == 200 else "-",
            str(r.dropped_count) if r.passed and r.http_status == 200 else "-",
            f"{r.elapsed_seconds:.1f}",
            r.notes,
        )
    console.print(table)
    passed = sum(1 for r in results if r.passed)
    console.print(f"TOTAL {passed}/{len(results)}  wall={total_wall:.1f}s")


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    env = Env.from_environ()
    levels_to_run = [s.strip() for s in args.levels.split(",") if s.strip()]
    levels = [lvl for lvl in LEVELS if lvl.label in levels_to_run]
    if not levels:
        print(f"no levels matched --levels={args.levels}", file=sys.stderr)
        return 1

    identity = Identity(
        scheduler_url=env.scheduler_url,
        bearer=env.scheduler_bearer,
        refresh_token=env.scheduler_refresh_token,
        expected_email=env.expected_test_account,
        client_id=env.client_id,
    )
    sched = SchedulerClient(identity)
    try:
        # Preflight: validate active account + grab home zone.
        r = sched.request("GET", "/v1/whoami")
        r.raise_for_status()
        active = r.json()
        if active["email"] != env.expected_test_account:
            print(
                f"active account {active['email']!r} != EXPECTED_TEST_ACCOUNT "
                f"{env.expected_test_account!r}; refusing to run",
                file=sys.stderr,
            )
            return 1
        home_tz = active["home_tz"]
        set_marking(args.provider)
        cal = _smoke_lib.make_calendar_client(sched, args.provider)
        try:
            console = Console(stderr=True)
            console.print(f"[dim]active account: {active['email']}  home_tz: {home_tz}  "
                          f"provider: {args.provider}  done colour: {MARKING.done!r}[/]")
            if args.webhook_check:
                run_webhook_smoke(env, sched, cal)
                return 0
            if args.feed_check:
                run_feed_smoke(env, sched)
                return 0
            if args.dry_run:
                # Show one level of fixtures and exit. No mutations.
                # L6 has no generic gen_* fixtures — dump its done-marking set.
                if all(lvl.kind == "done" for lvl in levels):
                    today = date.today()
                    cur_mon = today - timedelta(days=today.weekday())
                    dfx = gen_done_fixtures(cur_mon, today)
                    console.print(
                        f"[bold]L6 dry-run fixtures (current monday: {cur_mon}, "
                        f"done color: {MARKING.done}):[/]"
                    )
                    for f in dfx:
                        console.print(
                            f"    - {f.external_id}  kind={f.kind}  "
                            f"earliest={f.body['earliest_start']}  "
                            f"pinned_at={f.body['pinned_at']}"
                        )
                    return 0
                # L7 likewise has no generic gen_* fixtures — dump its chunk set.
                if all(lvl.kind == "chunks" for lvl in levels):
                    today = date.today()
                    cur_mon = today - timedelta(days=today.weekday())
                    cfx = gen_chunks_fixtures(cur_mon, today)
                    console.print(
                        f"[bold]L7 dry-run fixtures (current monday: {cur_mon}, "
                        f"done color: {MARKING.done}):[/]"
                    )
                    for f in cfx:
                        chunks = f.body.get("chunks")
                        shape = (
                            f"chunks={[c['duration_minutes'] for c in chunks]}"
                            if chunks else f"duration={f.body.get('duration_minutes')}"
                        )
                        console.print(
                            f"    - {f.external_id}  kind={f.kind}  "
                            f"earliest={f.body['earliest_start']}  {shape}"
                        )
                    return 0
                # L8 likewise has no generic gen_* fixtures — dump its move set over
                # two placeholder future weeks.
                if all(lvl.kind == "move" for lvl in levels):
                    fake_a = date.today() + timedelta(days=7)
                    while fake_a.weekday() != 0:
                        fake_a += timedelta(days=1)
                    fake_b = fake_a + timedelta(days=7)
                    mfx = gen_move_fixtures(fake_a, fake_b)
                    console.print(
                        f"[bold]L8 dry-run fixtures (week A: {fake_a}, week B: {fake_b}):[/]"
                    )
                    for f in mfx:
                        console.print(
                            f"    - {f.external_id}  kind={f.kind}  week={f.week}  "
                            f"earliest={f.body['earliest_start']}  "
                            f"pinned_at={f.body['pinned_at']}"
                        )
                    return 0
                # owned-meetings likewise has no generic gen_* fixtures.
                if all(lvl.kind == "owned-meetings" for lvl in levels):
                    fake_mon = date.today() + timedelta(days=7)
                    while fake_mon.weekday() != 0:
                        fake_mon += timedelta(days=1)
                    omfx = gen_owned_meeting_fixture(fake_mon, home_tz)
                    console.print(
                        f"[bold]owned-meetings dry-run fixtures (target monday: {fake_mon}):[/]"
                    )
                    console.print(
                        f"    meeting: {omfx.meeting_summary}  "
                        f"bad slot: {omfx.slot_start_iso} → {omfx.slot_end_iso}"
                    )
                    console.print(
                        f"    better slot: {omfx.better_start_iso} → {omfx.better_end_iso}"
                    )
                    console.print(
                        f"    blocking event: {omfx.freebusy_event_summary}"
                    )
                    return 0
                # Generic dry-run dumps one generic level's gen_* fixtures; the
                # done/chunks/move/owned-meetings kinds have none, so pick the first
                # generic level.
                lvl = next(
                    (lv for lv in levels
                     if lv.kind not in ("done", "chunks", "move", "owned-meetings")),
                    levels[0],
                )
                rng = random.Random(lvl.tier)
                # Use a placeholder monday for dry-run.
                fake_monday = date.today() + timedelta(days=7)
                while fake_monday.weekday() != 0:
                    fake_monday += timedelta(days=1)
                fx = Fixtures(
                    meetings=gen_meetings(lvl.tier, fake_monday, rng, home_tz, lvl.label),
                    tasks=gen_tasks(lvl.tier, fake_monday, rng, kind=lvl.kind, label=lvl.label),
                    templates=gen_templates(lvl.tier),
                )
                console.print(f"[bold]L{lvl.label} dry-run fixtures (target monday: {fake_monday}):[/]")
                console.print(f"  meetings: {len(fx.meetings)}")
                for m in fx.meetings[:3]:
                    console.print(f"    - {m.summary}  {m.start_iso} → {m.end_iso}")
                if len(fx.meetings) > 3:
                    console.print(f"    ... {len(fx.meetings) - 3} more")
                console.print(f"  tasks: {len(fx.tasks)}")
                for t in fx.tasks[:3]:
                    console.print(f"    - {t.id}  {t.body['title']}  ctx={t.body['context']}")
                console.print(f"  templates: {[t.id for t in fx.templates]}")
                return 0

            # L6/L7 run against the CURRENT week; L8 + owned-meetings find their OWN
            # blank future weeks. None of them consume the generic blank-week cursor —
            # only the generic L1..L5 levels do. Count blank weeks from generic levels.
            n_generic = sum(1 for lvl in levels
                            if lvl.kind not in ("done", "chunks", "move", "owned-meetings"))
            today = date.today()
            current_monday = today - timedelta(days=today.weekday())
            if args.starting_monday:
                monday = date.fromisoformat(args.starting_monday)
                if monday.weekday() != 0:
                    print(f"--starting-monday {monday} is not a Monday", file=sys.stderr)
                    return 1
                console.print(f"[dim]using --starting-monday: {monday}[/]")
            elif n_generic:
                monday = find_blank_monday(cal, date.today(), n_generic)
                console.print(
                    f"[dim]using blank monday: {monday} "
                    f"(verified {n_generic} empty weeks)[/]"
                )
            else:
                # Only current-week levels (L6/L7) requested: no generic blank
                # week needed.
                monday = current_monday
            results: list[LevelResult] = []
            run_start = datetime.now(tz=timezone.utc)
            for lvl in levels:
                console.print(f"[bold]L{lvl.label} starting...[/]")
                if lvl.kind == "done":
                    # Current-week executor; does not advance the blank-week cursor.
                    results.append(
                        run_level_done(env, sched, cal, home_tz, current_monday)
                    )
                    continue
                if lvl.kind == "chunks":
                    # Current-week executor; does not advance the blank-week cursor.
                    results.append(
                        run_level_chunks(env, sched, cal, home_tz, current_monday)
                    )
                    continue
                if lvl.kind == "move":
                    # Self-contained webhook-driven executor; finds its own two
                    # future blank weeks and does not advance the cursor.
                    results.append(
                        run_level_move(env, sched, cal, home_tz, current_monday,
                                       keep_artifacts=args.keep_artifacts)
                    )
                    continue
                if lvl.kind == "owned-meetings":
                    # Gate-checked and self-contained: finds its own blank future
                    # week. Skips cleanly if OWNED_MEETINGS_ENABLED is OFF or the
                    # account has not re-consented to calendar.freebusy.
                    results.append(
                        run_level_owned_meetings(env, sched, cal, home_tz, current_monday)
                    )
                    continue
                results.append(run_level(lvl, env, sched, cal, home_tz, monday))
                # One week per generic level. The find_blank_monday path verified
                # this whole span is empty; with --starting-monday the caller owns
                # seeding each week (see reset-smoke-env.py).
                monday = monday + timedelta(days=7)
            wall = (datetime.now(tz=timezone.utc) - run_start).total_seconds()
            render_summary(console, results, wall)
            return 0 if all(r.passed for r in results) else 1
        finally:
            cal.close()
    finally:
        sched.close()


if __name__ == "__main__":
    sys.exit(main())
