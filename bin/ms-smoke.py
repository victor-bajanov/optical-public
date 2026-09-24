#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "python-dateutil>=2.9",
#     "rich>=13.7",
# ]
# ///
"""ms-smoke: Microsoft 365 (Outlook) calendar provider smoke harness (scheduler-dev only).

See internal design notes (Task 15) and
docs/runbook.md §O. Mirrors bin/regression-smoke.py's per-level structure (each
step is self-contained: seeds its own fixtures, tears them down) and
bin/meeting-smoke.py's Identity/ScenarioResult conventions, adapted for a
single Microsoft-provider organiser plus one cross-tenant attendee address.

Steps (selectable via --levels, default all "1,2,3,4,5,6"; run in ascending
order — 3 is a hard gate, see below):
  1. Gate probe    — MS_PROVIDER_ENABLED is on for the target deployment.
  2. Chunks        — resolve+commit places tasks; chunk events appear in Outlook.
  3. Ext-prop gate — THE SPIKE VALIDATION (runbook §O). Fetch a created chunk
     event raw via Graph and confirm scheduler_chunk_id survives a second
     resolve (the worker's own read of it) without duplicating the event. On
     failure this step prints a loud FAIL and any later step requested in the
     same invocation is skipped — per the plan, do not build further on this
     property until it is fixed (see the open-extensions fallback, runbook §O).
  4. Webhook replan — a new conflicting Outlook event triggers the Graph
     subscription -> a replan with a rendered email (render_snapshot).
  5. Done category — tagging a committed chunk with the "Optical Done" Outlook
     category flips the owning task to status="done" on the next resolve.
  6. Meeting freebusy degrade — an owned meeting with a cross-tenant attendee
     (no Exchange org relationship, so getSchedule can't read them — this is
     the DEFAULT unshared state for two unrelated M365 tenants, unlike Google
     where an explicit ACL revoke is needed) surfaces
     attendee_availability_unknown; degrade-to-immovable is asserted by the
     needsAction attendee still not causing a hard failure (see the module
     docstring note on the bug this guards, bug_meeting_unknown_freebusy_moved).

PREREQUISITE (this harness does not, and cannot, automate it — mirrors how
meeting-smoke documents its calendar.acls re-consent prerequisite): a
Microsoft-provider identity must already be signed in. Run once, interactively:

  ./bin/mint-token.py --provider microsoft \\
      --url https://scheduler-dev.example.com --client-id smoke-cli

and export the two printed lines (SCHEDULER_BEARER, SCHEDULER_REFRESH_TOKEN)
alongside EXPECTED_TEST_ACCOUNT=<that Microsoft account's email>. Step 6 also
needs MS2_ATTENDEE_EMAIL (any mailbox address in a *different* M365 tenant —
no scheduler login required for it, it is only ever used as an attendee
address). Step 5 needs D1_DATABASE_ID (the target env's database id —
scheduler-dev's for dev) to seed
users.done_color_id="Optical Done" for the test account, since there is no API
write path for it (runbook §I); its cleanup RESTORES whatever value was there
before the step ran (NULL included) rather than unconditionally clearing it —
see Card H (internal design notes) for the 2026-08-21 outage
this fixed.

GAPS FOUND BY STATIC REVIEW WHILE BUILDING THIS HARNESS — both fixed pre-merge
(commit 5f734c3), not introduced or fixed by the harness itself:
  - worker/src/handlers/calendar-access-token.ts called
    defaultIdentityProvider(c.env) with NO provider argument, so it always
    resolved the GOOGLE IdentityProvider regardless of the caller's own
    provider. Every GraphClient call in this harness (which mints its Graph
    token via GET /v1/calendar-access-token, mirroring meeting-smoke's
    CalendarClient) would have failed or misbehaved for a Microsoft-provider
    subject. Fixed: the route now resolves the provider first
    (getSubjectProvider(...) -> defaultIdentityProvider(env, provider)).
  - worker/src/providers/microsoft-calendar-provider.ts fetchEventsInWindow
    requested only startDateTime/endDateTime on /me/calendarView/delta — no
    $expand=singleValueExtendedProperties(...). Fixed: the initial delta
    request now sends $expand=singleValueExtendedProperties($filter=...) for
    both scheduler_chunk_id and optical_meeting_task_id.
  Both fixes are unit-tested but NOT yet verified against live Graph — step 3
  below (the ext-prop round-trip gate) remains a required LIVE validation
  before this feature ships, not a settled fact.

LIVE-RUN NOTE: always redirect this harness's output to a file (memory:
buffer overflow otherwise), e.g.
    op run --env-file=.env -- uv run bin/ms-smoke.py >/tmp/ms-smoke.log 2>&1
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import time as _time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, TypeVar

import httpx
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
DevD1 = _smoke_lib.DevD1
set_done_color_id = _smoke_lib.set_done_color_id
get_done_color_id = _smoke_lib.get_done_color_id
TokenAuthedClient = _smoke_lib.TokenAuthedClient
assert_dev_db = _smoke_lib.assert_dev_db
assert_dev_url = _smoke_lib.assert_dev_url
assert_env_consistent = _smoke_lib.assert_env_consistent
post_resolve = _smoke_lib.post_resolve
post_commit = _smoke_lib.post_commit

# =============================================================================
# Constants — must stay in sync with worker/src/providers/graph-event-mapping.ts
# =============================================================================

# Single source of truth is _smoke_lib (shared with regression-smoke.py's
# --provider microsoft path); re-exported here for the self-test.
GRAPH_BASE = _smoke_lib.GRAPH_BASE
SCHEDULER_PROPERTY_GUID = _smoke_lib.SCHEDULER_PROPERTY_GUID
OPTICAL_DONE_CATEGORY = _smoke_lib.OPTICAL_DONE_CATEGORY
_CHUNK_PROP_NAME = "scheduler_chunk_id"

# Prod-safety guards (DEV_DB_ID/PROD_DB_ID, assert_dev_db/assert_dev_url) live in
# _smoke_lib.py — shared with meeting-smoke.py. Re-export the IDs here since the
# self-test below exercises them directly.
DEV_DB_ID = _smoke_lib.DEV_DB_ID
PROD_DB_ID = _smoke_lib.PROD_DB_ID

_MS_EVENT_PREFIX = "[ms-smoke]"
_MS_TASK_PREFIX = "ms-smoke"


graph_prop_id = _smoke_lib.graph_prop_id


# =============================================================================
# Env
# =============================================================================


@dataclass(frozen=True)
class MsEnv:
    scheduler_url: str
    scheduler_bearer: str
    scheduler_refresh_token: str
    expected_test_account: str
    client_id: str = "smoke-cli"
    ms2_attendee_email: str | None = None  # required only for step 6
    d1_database_id: str | None = None      # required only for step 5

    @classmethod
    def from_environ(cls, levels: list[str], url: str | None = None,
                     client_id: str | None = None) -> "MsEnv":
        """`url`/`client_id` are the CLI --url/--client-id overrides (CLI wins
        over env when given; falls back to SCHEDULER_URL/SCHEDULER_CLIENT_ID
        otherwise) — main() must pass args.url/args.client_id through here,
        not just read them for argparse's own env-default convenience."""
        def req(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                print(f"missing required env var: {name}", file=sys.stderr)
                raise SystemExit(1)
            return v

        resolved_url = url or os.environ.get("SCHEDULER_URL", "")
        if not resolved_url:
            print("missing required env var: SCHEDULER_URL (or pass --url)", file=sys.stderr)
            raise SystemExit(1)
        resolved_url = resolved_url.rstrip("/")
        assert_dev_url(resolved_url)

        ms2 = os.environ.get("MS2_ATTENDEE_EMAIL")
        if "6" in levels and not ms2:
            print("missing required env var for --levels 6: MS2_ATTENDEE_EMAIL "
                  "(a mailbox address in a DIFFERENT M365 tenant; no scheduler "
                  "login needed for it)", file=sys.stderr)
            raise SystemExit(1)

        d1_id = os.environ.get("D1_DATABASE_ID")
        if "5" in levels:
            if not d1_id:
                print("missing required env var for --levels 5: D1_DATABASE_ID "
                      "(scheduler-dev — needed to seed users.done_color_id, no "
                      "API write path exists per runbook §I)", file=sys.stderr)
                raise SystemExit(1)
            assert_dev_db(d1_id)
        # D8/m5: SCHEDULER_URL and D1_DATABASE_ID must name the SAME env — a
        # mismatched pair (one env's host with another env's db id) would
        # otherwise seed users.done_color_id into the wrong D1 with no error.
        assert_env_consistent(resolved_url, d1_id)

        return cls(
            scheduler_url=resolved_url,
            scheduler_bearer=req("SCHEDULER_BEARER"),
            scheduler_refresh_token=req("SCHEDULER_REFRESH_TOKEN"),
            expected_test_account=req("EXPECTED_TEST_ACCOUNT"),
            client_id=client_id or os.environ.get("SCHEDULER_CLIENT_ID", "smoke-cli"),
            ms2_attendee_email=ms2,
            d1_database_id=d1_id,
        )

    def identity(self) -> Identity:
        return Identity(
            scheduler_url=self.scheduler_url,
            bearer=self.scheduler_bearer,
            refresh_token=self.scheduler_refresh_token,
            expected_email=self.expected_test_account,
            client_id=self.client_id,
        )


# =============================================================================
# GraphClient — the Microsoft-Graph analogue of _smoke_lib.CalendarClient
# =============================================================================


class GraphClient(_smoke_lib.GraphCalendarClient):
    """ms-smoke's view of the shared Graph client (_smoke_lib.GraphCalendarClient,
    also what regression-smoke.py --provider microsoft drives). This harness
    inspects RAW Graph events (singleValueExtendedProperties for the step-3
    ext-prop gate), so list_events returns them un-normalised here."""

    def list_events(self, time_min_iso: str, time_max_iso: str) -> list[dict]:
        return self.list_events_raw(time_min_iso, time_max_iso)


def extract_chunk_id(graph_event: dict) -> str | None:
    """The scheduler_chunk_id ({taskId}#{idx}) off a raw Graph event's
    singleValueExtendedProperties, or None if absent/not a chunk event."""
    want = graph_prop_id(_CHUNK_PROP_NAME)
    for p in graph_event.get("singleValueExtendedProperties") or []:
        if p.get("id") == want:
            v = p.get("value")
            return v if isinstance(v, str) else None
    return None


def task_id_of_chunk(graph_event: dict) -> str | None:
    cid = extract_chunk_id(graph_event)
    return cid.split("#", 1)[0] if cid else None


# =============================================================================
# Scheduler helpers (post_resolve/post_commit live in _smoke_lib.py, shared
# with regression-smoke.py and meeting-smoke.py)
# =============================================================================


def commit_resolve(sched: SchedulerClient, monday: date, plan_hashes: set[str], label: str) -> dict:
    """resolve then commit; raises AssertionError on any non-200. Returns the
    resolve body (the committed plan's schedule)."""
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


def seed_task(sched: SchedulerClient, monday: date, label: str, external_suffix: str) -> str:
    body = {
        "title": f"{_MS_EVENT_PREFIX} {label}",
        "context": "deep",
        "priority": 75,
        "earliest_start": f"{monday.isoformat()}T00:00",
        "deadline": None,
        "preferred_windows": [],
        "dependencies": [],
        "pinned_at": None,
        "duration_minutes": 60,
        "source": {"kind": "mcp", "external_id": f"{_MS_TASK_PREFIX}-{external_suffix}"},
        "status": "pending",
    }
    r = sched.request("POST", "/v1/tasks", json=body)
    r.raise_for_status()
    return r.json()["id"]


def find_meeting_task_id(sched: SchedulerClient, meeting_event_id: str) -> str | None:
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    for t in r.json().get("tasks", []):
        src = t.get("source") or {}
        if src.get("kind") == "meeting" and src.get("external_id") == meeting_event_id:
            tid = t.get("id")
            return tid if isinstance(tid, str) else None
    return None


def sweep_ms_smoke_tasks(sched: SchedulerClient, extra_external_ids: set[str] = frozenset()) -> None:
    """Delete harness-owned tasks: anything whose source.external_id starts
    with the ms-smoke prefix, plus any explicitly-listed external ids (meeting
    tasks imported under the real Graph event id, which doesn't carry the
    prefix — mirrors meeting-smoke's task_is_harness_owned)."""
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    for t in r.json().get("tasks", []):
        src = t.get("source") or {}
        ext = src.get("external_id")
        owned = (isinstance(ext, str) and ext.startswith(_MS_TASK_PREFIX)) or ext in extra_external_ids
        if owned and isinstance(t.get("id"), str):
            sched.request("DELETE", f"/v1/tasks/{t['id']}")


def sweep_ms_smoke_events(graph: GraphClient, monday: date) -> None:
    time_min = f"{monday.isoformat()}T00:00:00Z"
    time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
    for ev in graph.list_events(time_min, time_max):
        if (ev.get("subject") or "").startswith(_MS_EVENT_PREFIX):
            graph.delete_event(ev["id"])


def find_blank_monday(graph: GraphClient, start_after: date) -> date:
    """First Monday strictly after start_after whose 7-day week has no
    Outlook events (mirrors regression-smoke.py's find_blank_monday)."""
    candidate = start_after + timedelta(days=(7 - start_after.weekday()) % 7 or 7)
    horizon = start_after + timedelta(days=400)
    while candidate <= horizon:
        time_min = f"{candidate.isoformat()}T00:00:00Z"
        time_max = f"{(candidate + timedelta(days=7)).isoformat()}T00:00:00Z"
        if not graph.list_events(time_min, time_max):
            return candidate
        candidate += timedelta(days=7)
    raise RuntimeError(
        f"no empty week found within a year of {start_after}; clean the sandbox calendar"
    )


# =============================================================================
# Scenario result bookkeeping (mirrors meeting-smoke.py)
# =============================================================================


@dataclass
class ScenarioResult:
    label: str
    passed: bool
    elapsed_seconds: float
    notes: str = ""
    skipped: bool = False


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


def compute_exit_code(results: list[ScenarioResult]) -> int:
    """0 = at least one genuine pass and no failures; 1 = any failure;
    2 = nothing genuinely exercised (empty or all-skipped) — not a pass."""
    if any(not r.passed for r in results):
        return 1
    genuine = [r for r in results if not r.skipped]
    return 0 if genuine else 2


# =============================================================================
# Step 1 — MS_PROVIDER_ENABLED gate probe
# =============================================================================


def step1_gate_probe(url: str, client_id: str) -> ScenarioResult:
    """Probe GET /oauth/authorize?provider=microsoft. D8/M1 correction:
    worker/src/auth/oauth-provider.ts actually validates client_id (:113,
    unknown_client) and the redirect_uri allow-list (:115,
    redirect_uri_not_allowed) BEFORE the provider gate (:118,
    unknown_provider) — the OPPOSITE order this docstring used to claim.
    So `unknown_provider` is the ONLY 400 that says anything about the gate
    (closed); every other 400 means the request never reached the gate at
    all — most likely `client_id` isn't a real registered client (see
    register-pkce-client.sh) or `redirect_uri` isn't on that client's
    allow-list, and this probe can't tell those apart from a closed gate.
    Non-400 (302 to Microsoft, the chooser HTML, etc.) is the only positive
    evidence the gate is open."""
    started = datetime.now(tz=timezone.utc)
    try:
        probe = httpx.get(
            f"{url}/oauth/authorize",
            params={
                "response_type": "code", "client_id": client_id,
                "redirect_uri": "http://localhost:8976/callback",
                "code_challenge": "ms-smoke-gate-probe-only",
                "code_challenge_method": "S256",
                "state": "ms-smoke-gate-probe", "scope": "scheduler:read",
                "provider": "microsoft",
            },
            follow_redirects=False, timeout=15.0,
        )
    except httpx.HTTPError as exc:
        return _fail("1", started, f"could not reach {url}/oauth/authorize: {exc}")
    if probe.status_code == 400:
        try:
            body = probe.json()
        except ValueError:
            body = None
        err = body.get("error") if isinstance(body, dict) else None
        if err == "unknown_provider":
            return _fail(
                "1", started,
                'MS_PROVIDER_ENABLED is not "true" on this deployment (or '
                "MICROSOFT_TENANT/MICROSOFT_OAUTH_CLIENT_ID missing) — see "
                "runbook §O 'Gate flag'. Set it and redeploy before running ms-smoke."
            )
        # Any OTHER 400 (parseable-but-different error, unparseable body, or
        # no "error" key) is NOT evidence of anything about the gate: the
        # client_id/redirect_uri checks run BEFORE the provider gate
        # (worker/src/auth/oauth-provider.ts :113/:115 vs :118), so the
        # request may never have reached it. Fail, showing what we got —
        # usually a harness/client misconfiguration (e.g.
        # register-pkce-client.sh never run against this env), not proof of
        # anything about MS_PROVIDER_ENABLED either way.
        detail = err if err is not None else (
            body if body is not None else (probe.text[:300] if probe.text else "<empty>")
        )
        return _fail(
            "1", started,
            f"400 before reaching the provider gate ({detail!r}) from "
            f"{url}/oauth/authorize — client/harness misconfigured for this env? "
            f"(e.g. register-pkce-client.sh not run)"
        )
    # Any non-400 outcome (302 to login.microsoftonline.com, the provider
    # chooser HTML, etc.) means the gate itself is open.
    print(f"1 OK: MS provider gate is open (probe status {probe.status_code})")
    return _pass("1", started)


# =============================================================================
# Step 2 — resolve+commit places chunks in the Outlook calendar
# =============================================================================


def step2_chunks(sched: SchedulerClient, graph: GraphClient) -> ScenarioResult:
    started = datetime.now(tz=timezone.utc)
    monday = find_blank_monday(graph, date.today())
    task_ids: list[str] = []
    plan_hashes: set[str] = set()
    try:
        task_ids.append(seed_task(sched, monday, "step2 task", "step2"))
        body = commit_resolve(sched, monday, plan_hashes, "step2")
        chunk_events = [ev for ev in graph.list_events(
            f"{monday.isoformat()}T00:00:00Z",
            f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z",
        ) if extract_chunk_id(ev) is not None]
        placed_task_ids = {c.get("task_id") for c in body.get("schedule", [])}
        if not chunk_events or not (placed_task_ids & set(task_ids)):
            raise AssertionError(
                f"step2: expected a committed chunk event in Outlook for one of "
                f"{task_ids} — found {len(chunk_events)} chunk event(s), "
                f"schedule task_ids {placed_task_ids!r}"
            )
        print(f"2 OK: {len(chunk_events)} chunk event(s) committed to Outlook "
              f"for week of {monday.isoformat()}")
        return _pass("2", started)
    except AssertionError as e:
        return _fail("2", started, str(e))
    finally:
        sweep_ms_smoke_tasks(sched)
        sweep_ms_smoke_events(graph, monday)
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


# =============================================================================
# Step 3 — extended-property round-trip gate (THE spike validation, runbook §O)
# =============================================================================

_EXT_PROP_FAIL_BANNER = (
    "\n" + "!" * 78 + "\n"
    "EXTENDED-PROPERTY ROUND-TRIP GATE FAILED (runbook §O spike validation).\n"
    "scheduler_chunk_id did not survive the round-trip the worker actually uses.\n"
    "STOP: do not proceed to steps 4-6 until this is fixed. Fallback per the\n"
    'runbook: switch to Graph "open extensions" instead of\n'
    "singleValueExtendedProperties, isolated behind graphPropId()/the mapping\n"
    "module (worker/src/providers/graph-event-mapping.ts) so no other code has\n"
    "to change.\n" + "!" * 78
)


def step3_ext_prop_gate(sched: SchedulerClient, graph: GraphClient) -> ScenarioResult:
    started = datetime.now(tz=timezone.utc)
    monday = find_blank_monday(graph, date.today())
    task_ids: list[str] = []
    plan_hashes: set[str] = set()
    try:
        task_id = seed_task(sched, monday, "step3 task", "step3")
        task_ids.append(task_id)
        commit_resolve(sched, monday, plan_hashes, "step3 baseline")

        time_min = f"{monday.isoformat()}T00:00:00Z"
        time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
        window_events = [ev for ev in graph.list_events(time_min, time_max)
                         if task_id_of_chunk(ev) == task_id]
        if not window_events:
            raise AssertionError("step3: no committed chunk event found for the seeded task")
        event = window_events[0]
        event_id = event["id"]

        # (a) Direct single-event GET with the same $expand/$filter.
        raw = graph.get_event_raw(event_id)
        raw_value = extract_chunk_id(raw)
        if raw_value is None:
            raise AssertionError(
                "step3(a): singleValueExtendedProperties came back empty on a "
                "direct GET /me/events/{id}?$expand=... — the property write "
                "itself did not stick (see graph-event-mapping.ts toGraphPatch / "
                "MicrosoftCalendarProvider.createEvent)."
            )

        # (b) calendarView-expanded value (already captured above) must agree.
        window_value = extract_chunk_id(event)
        if window_value != raw_value:
            raise AssertionError(
                f"step3(b): calendarView $expand value {window_value!r} != "
                f"single-event GET value {raw_value!r} — the property does not "
                f"round-trip consistently across Graph read surfaces."
            )

        # (c) Re-resolve the SAME week. If the worker's own read path
        # (fetchEventsInWindow) recognises the existing chunk via this
        # property, no duplicate chunk event is created for this task.
        commit_resolve(sched, monday, plan_hashes, "step3 re-resolve")
        after = [ev for ev in graph.list_events(time_min, time_max)
                if task_id_of_chunk(ev) == task_id]
        if len(after) != 1:
            raise AssertionError(
                f"step3(c): re-resolve produced {len(after)} chunk event(s) for "
                f"task {task_id} (expected 1) — the worker did not recognise the "
                f"existing chunk via scheduler_chunk_id on read-back, so it was "
                f"re-created/duplicated instead of reused."
            )

        print(f"3 OK: scheduler_chunk_id {raw_value!r} round-trips through both "
              f"a direct GET and calendarView, and is recognised on re-resolve "
              f"(no duplicate chunk created)")
        return _pass("3", started)
    except AssertionError as e:
        print(_EXT_PROP_FAIL_BANNER)
        return _fail("3", started, str(e))
    finally:
        sweep_ms_smoke_tasks(sched)
        sweep_ms_smoke_events(graph, monday)
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


# =============================================================================
# Step 4 — webhook-driven replan with a rendered email
# =============================================================================


def step4_webhook_replan(sched: SchedulerClient, graph: GraphClient) -> ScenarioResult:
    """Mirrors regression-smoke.py's run_webhook_smoke: seed pending tasks in a
    blank week, resolve+commit a baseline (no render_snapshot), then create a
    NEW conflicting Outlook event so the Graph subscription delivers a change
    notification -> debounced replan -> render_snapshot + email. This is
    distinct from "hand-dragging a committed chunk", which the write-back path
    (mirrored by regression-smoke's L8) patches silently with no replan/email —
    the plan's wording ("move a chunk ... -> replan email observed") is
    satisfied here by the full-replan path, which is the one that actually
    produces an email."""
    started = datetime.now(tz=timezone.utc)
    monday = find_blank_monday(graph, date.today())
    task_ids: list[str] = []
    plan_hashes: set[str] = set()
    event_id: str | None = None
    try:
        sched.request("POST", "/v1/webhook/subscribe").raise_for_status()
        for i in range(3):
            task_ids.append(seed_task(sched, monday, f"step4 task {i}", f"step4-{i}"))

        status, body = post_resolve(sched, monday)
        if status != 200:
            raise AssertionError(f"step4: baseline resolve returned {status}: {body!r}")
        baseline_hash = body.get("plan_hash")
        if baseline_hash:
            plan_hashes.add(baseline_hash)
        if not [c for c in body.get("schedule", []) if c.get("task_id") in task_ids]:
            raise AssertionError("step4: seeded tasks were not scheduled in the baseline plan")

        start = datetime.combine(monday, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=23)
        end = start + timedelta(hours=1)
        event_id = graph.create_event(
            f"{_MS_EVENT_PREFIX} webhook conflict", start.isoformat(), end.isoformat(),
        )

        covers = start.isoformat()
        deadline = _time.monotonic() + 120.0
        while _time.monotonic() < deadline:
            r = sched.request("GET", "/v1/plans/latest", params={"covers": covers})
            r.raise_for_status()
            plan = r.json().get("plan")
            if plan and plan.get("plan_hash") != baseline_hash and plan.get("render_snapshot") is not None:
                plan_hashes.add(plan["plan_hash"])
                win = plan.get("window") or {}
                print(f"4 OK: replanned plan {plan['plan_hash']} for window "
                      f"{win.get('start')}..{win.get('end')} carries a "
                      f"render_snapshot (baseline {baseline_hash})")
                return _pass("4", started)
            _time.sleep(3.0)
        raise AssertionError(
            f"step4: no replanned plan with a render_snapshot covering {covers} "
            f"within 120s (baseline {baseline_hash!r}) — Graph subscription "
            f"delivery may not have fired"
        )
    except AssertionError as e:
        return _fail("4", started, str(e))
    finally:
        if event_id is not None:
            try:
                graph.delete_event(event_id)
            except Exception as exc:
                print(f"step4 cleanup: could not delete event {event_id}: {exc}")
        sweep_ms_smoke_tasks(sched)
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


# =============================================================================
# Step 5 — "Optical Done" category marks the task done
# =============================================================================

_T = TypeVar("_T")


def _step5_body_with_done_color_restore(
    d1: DevD1, subject: str, category: str, body: Callable[[], _T],
) -> _T:
    """Seed `subject`'s users.done_color_id to `category` for the duration of
    `body()`, then restore whatever value was there BEFORE (which may
    legitimately be NULL — e.g. a Google-provider subject on dev) once `body`
    returns OR raises. Replaces the old unconditional
    `set_done_color_id(d1, subject, None)` cleanup, which wiped out a real
    login's seeded value regardless of what it had been — the root cause of
    a 2026-08-21 L6/L7 done-marking regression-smoke failure on a Microsoft
    identity (Card H, internal design notes, runbook §O)."""
    prior = get_done_color_id(d1, subject)
    set_done_color_id(d1, subject, category)
    try:
        return body()
    finally:
        try:
            set_done_color_id(d1, subject, prior)
        except Exception as exc:
            print(f"step5 cleanup: could not restore done_color_id: {exc}")


def step5_done_category(sched: SchedulerClient, graph: GraphClient, d1: DevD1, subject: str) -> ScenarioResult:
    started = datetime.now(tz=timezone.utc)
    monday = find_blank_monday(graph, date.today())
    plan_hashes: set[str] = set()

    def run() -> ScenarioResult:
        try:
            task_id = seed_task(sched, monday, "step5 task", "step5")
            baseline = commit_resolve(sched, monday, plan_hashes, "step5 baseline")
            if task_id not in {c.get("task_id") for c in baseline.get("schedule", [])}:
                raise AssertionError("step5: seeded task was not placed in the baseline")

            time_min = f"{monday.isoformat()}T00:00:00Z"
            time_max = f"{(monday + timedelta(days=7)).isoformat()}T00:00:00Z"
            chunk_events = [ev for ev in graph.list_events(time_min, time_max)
                            if task_id_of_chunk(ev) == task_id]
            if not chunk_events:
                raise AssertionError("step5: no committed chunk event found to tag")
            graph.set_categories(chunk_events[0]["id"], [OPTICAL_DONE_CATEGORY])

            # A resolve (no commit needed) runs the done-scan.
            status, _ = post_resolve(sched, monday)
            if status != 200:
                raise AssertionError(f"step5: post-tag resolve returned {status}")

            r = sched.request("GET", f"/v1/tasks/{task_id}")
            r.raise_for_status()
            seen_status = r.json().get("status")
            if seen_status != "done":
                raise AssertionError(
                    f"step5: task {task_id} status is {seen_status!r}, expected "
                    f'"done" after tagging its chunk with the "{OPTICAL_DONE_CATEGORY}" '
                    f"category (check users.done_color_id for {subject!r})"
                )
            print(f"5 OK: task {task_id} flipped to status=done after the "
                  f'"{OPTICAL_DONE_CATEGORY}" category tag')
            return _pass("5", started)
        except AssertionError as e:
            return _fail("5", started, str(e))
        finally:
            sweep_ms_smoke_tasks(sched)
            sweep_ms_smoke_events(graph, monday)
            for h in plan_hashes:
                sched.request("DELETE", f"/v1/plans/{h}")

    return _step5_body_with_done_color_restore(d1, subject, OPTICAL_DONE_CATEGORY, run)


# =============================================================================
# Step 6 — owned-meeting freebusy degrade-to-immovable (cross-tenant attendee)
# =============================================================================


def step6_freebusy_degrade(sched: SchedulerClient, graph: GraphClient, attendee_email: str) -> ScenarioResult:
    """Unlike the Google harness (bin/meeting-smoke.py 2B), no explicit
    unshare/ACL step is needed: two unrelated Microsoft 365 tenants have no
    Exchange Organization Relationship by default, so getSchedule cannot read
    a cross-tenant attendee's calendar out of the box — this IS the unshared
    state. The attendee is left at the default needsAction (we hold no
    credentials for their mailbox, so there is nothing to accept programmatically
    — matches 2E's demonstration that a needsAction attendee still constrains
    under the not_declined default; here it just can't be READ at all)."""
    started = datetime.now(tz=timezone.utc)
    monday = find_blank_monday(graph, date.today())
    meeting_event_id: str | None = None
    plan_hashes: set[str] = set()
    try:
        start = datetime.combine(monday, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=1, hours=23)
        end = start + timedelta(minutes=30)
        meeting_event_id = graph.create_event(
            f"{_MS_EVENT_PREFIX} owned meeting", start.isoformat(), end.isoformat(),
            attendee_emails=[attendee_email],
        )

        status, body = post_resolve(sched, monday)
        if status != 200:
            raise AssertionError(f"step6: resolve returned {status}: {body!r}")
        if body.get("plan_hash"):
            plan_hashes.add(body["plan_hash"])
        meeting_task_id = find_meeting_task_id(sched, meeting_event_id)
        if meeting_task_id is None:
            return _skip("6", started, "OWNED_MEETINGS_ENABLED is off, or the "
                        "organiser has not re-consented with calendar.freebusy "
                        "(here: the Microsoft equivalent scope)")

        warnings = body.get("warnings") or []
        if not any("attendee_availability_unknown" in w for w in warnings):
            raise AssertionError(
                f"step6: expected attendee_availability_unknown for the "
                f"cross-tenant attendee {attendee_email!r}; warnings were {warnings!r}"
            )
        print(f"6 OK: cross-tenant attendee {attendee_email!r} unreadable -> "
              f"attendee_availability_unknown present (degrade-to-immovable path)")
        return _pass("6", started)
    except AssertionError as e:
        return _fail("6", started, str(e))
    finally:
        if meeting_event_id is not None:
            try:
                graph.delete_event(meeting_event_id)
            except Exception as exc:
                print(f"step6 cleanup: could not delete meeting event: {exc}")
        sweep_ms_smoke_tasks(sched, {meeting_event_id} if meeting_event_id else set())
        for h in plan_hashes:
            sched.request("DELETE", f"/v1/plans/{h}")


# =============================================================================
# Self-test (pure functions only, no network)
# =============================================================================


def self_test() -> int:
    assert graph_prop_id("scheduler_chunk_id") == (
        f"String {{{SCHEDULER_PROPERTY_GUID}}} Name scheduler_chunk_id"
    )

    ev_with_prop = {
        "id": "evt1",
        "singleValueExtendedProperties": [
            {"id": graph_prop_id("scheduler_chunk_id"), "value": "task-123#0"},
            {"id": graph_prop_id("other_prop"), "value": "ignored"},
        ],
    }
    assert extract_chunk_id(ev_with_prop) == "task-123#0"
    assert task_id_of_chunk(ev_with_prop) == "task-123"
    assert extract_chunk_id({"id": "evt2"}) is None
    assert task_id_of_chunk({"id": "evt2"}) is None

    assert_dev_url("https://scheduler-dev.example.com")  # ok
    assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")  # ok
    try:
        assert_dev_url("https://scheduler.example.com")
        raise AssertionError("expected SystemExit")
    except SystemExit:
        pass
    assert_dev_db(DEV_DB_ID)  # ok
    try:
        assert_dev_db(PROD_DB_ID)
        raise AssertionError("expected SystemExit")
    except SystemExit:
        pass

    R = ScenarioResult
    assert compute_exit_code([R("1", True, 1.0), R("2", True, 1.0)]) == 0
    assert compute_exit_code([R("1", True, 1.0), R("2", False, 1.0)]) == 1
    assert compute_exit_code([R("1", True, 1.0, skipped=True)]) == 2
    assert compute_exit_code([]) == 2

    class _StubGraph:
        def __init__(self, windows: list[list[dict]]):
            self._windows = list(windows)

        def list_events(self, time_min: str, time_max: str) -> list[dict]:
            return self._windows.pop(0) if self._windows else []

    empty = _StubGraph([[]])
    assert find_blank_monday(empty, date(2026, 7, 12)) == date(2026, 7, 13)
    busy = _StubGraph([[{"subject": "x"}], []])
    assert find_blank_monday(busy, date(2026, 7, 12)) == date(2026, 7, 20)

    print("self-test: OK")
    return 0


# =============================================================================
# CLI + live run
# =============================================================================

_ALL_LEVELS = ["1", "2", "3", "4", "5", "6"]


def parse_levels(raw: str) -> list[str]:
    requested = [s.strip() for s in raw.split(",") if s.strip()]
    unknown = [s for s in requested if s not in _ALL_LEVELS]
    if unknown:
        raise SystemExit(f"unknown --levels entries {unknown!r}; choose from {_ALL_LEVELS}")
    # Always run in ascending order regardless of how they were listed — step 3
    # is a hard gate for anything after it in the SAME invocation.
    return [l for l in _ALL_LEVELS if l in requested]


def run_live(env: MsEnv, levels: list[str], console: Console) -> int:
    sched = SchedulerClient(env.identity())
    graph = GraphClient(sched)
    # D8/M2: route through the shared helper (db id -> its wrangler env,
    # SMOKE_WRANGLER_ENV still wins) instead of the unparameterised
    # DevD1(repo_root=...) this used to call — that always hit scheduler-dev's
    # binding regardless of env.d1_database_id, so another env's step 5
    # (done-category seeding) would silently write users.done_color_id into
    # scheduler-dev. reset-smoke-env.py's poll wipe had the identical bug
    # (D2), fixed there first; this routes both through one helper so they
    # can't drift out of sync again.
    d1 = (
        _smoke_lib.d1_for_db_id(env.d1_database_id, Path(__file__).resolve().parent.parent)
        if env.d1_database_id else None
    )

    r = sched.request("GET", "/v1/whoami")
    r.raise_for_status()
    got = r.json().get("email")
    if got != env.expected_test_account:
        raise SystemExit(f"whoami email {got!r} != expected {env.expected_test_account!r}")

    results: list[ScenarioResult] = []
    stop = False
    try:
        for level in levels:
            if stop:
                results.append(_skip(level, datetime.now(tz=timezone.utc),
                                     "step 3 (extended-property round-trip gate) failed earlier in this run"))
                continue
            console.print(f"[bold]{level} starting...[/]")
            if level == "1":
                result = step1_gate_probe(env.scheduler_url, env.client_id)
            elif level == "2":
                result = step2_chunks(sched, graph)
            elif level == "3":
                result = step3_ext_prop_gate(sched, graph)
                if not result.passed:
                    stop = True
            elif level == "4":
                result = step4_webhook_replan(sched, graph)
            elif level == "5":
                # MsEnv.from_environ already SystemExits at startup if "5" is
                # requested without D1_DATABASE_ID (same `levels` list this
                # loop dispatches over) — d1 is guaranteed non-None here.
                assert d1 is not None
                result = step5_done_category(sched, graph, d1, env.expected_test_account)
            elif level == "6":
                # Same guarantee as above, for MS2_ATTENDEE_EMAIL / level "6".
                assert env.ms2_attendee_email
                result = step6_freebusy_degrade(sched, graph, env.ms2_attendee_email)
            else:
                continue
            results.append(result)
            tag = "PASS" if result.passed else "FAIL"
            console.print(f"  {level}: {tag}  ({result.elapsed_seconds:.1f}s)  {result.notes}")

        genuine_pass = sum(1 for r in results if r.passed and not r.skipped)
        skipped = sum(1 for r in results if r.skipped)
        console.print(f"TOTAL pass={genuine_pass} skipped={skipped} of {len(results)}")
        code = compute_exit_code(results)
        if code == 2:
            console.print(
                "[bold yellow]ALL STEPS SKIPPED[/] — the live Microsoft path was "
                "never exercised. This is NOT a pass."
            )
        return code
    finally:
        graph.close()
        sched.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Microsoft 365 (Outlook) provider smoke harness")
    parser.add_argument("--url", default=os.environ.get("SCHEDULER_URL", ""),
                        help="Scheduler base URL (default: $SCHEDULER_URL).")
    parser.add_argument("--client-id", default=os.environ.get("SCHEDULER_CLIENT_ID", "smoke-cli"),
                        help="PKCE client_id the bearer/refresh token was minted under (default: smoke-cli).")
    parser.add_argument("--levels", default="1,2,3,4,5,6",
                        help="Comma-separated step numbers 1-6 (default: all). Always runs in "
                             "ascending order; step 3 gates anything after it in the same run.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the selected steps and exit without making network calls.")
    parser.add_argument("--self-test", action="store_true",
                        help="Run pure-function tests only (no network).")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    levels = parse_levels(args.levels)
    console = Console(stderr=True)

    if args.dry_run:
        console.print(f"[bold]ms-smoke steps:[/] {levels}")
        return 0

    env = MsEnv.from_environ(levels, url=args.url, client_id=args.client_id)
    return run_live(env, levels, console)


if __name__ == "__main__":
    sys.exit(main())
