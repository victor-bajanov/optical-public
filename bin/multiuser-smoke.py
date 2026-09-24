#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "python-dateutil>=2.9",
#     "rich>=13.7",
# ]
# ///
"""Multi-user smoke harness for the weekly scheduler (smoke envs only, never prod).

Exercises owner-scoped isolation, resolve scoping, per-user config/home_tz,
fail-closed subject, per-user webhook routing, offboarding+audit, and push-channel
renewal, using TWO
real identities. See internal design notes

`--provider microsoft` runs the same ladder with A and B as two Microsoft
accounts (Outlook calendars, Graph-driven), against dev with
MS_PROVIDER_ENABLED="true" there.
Both letters must be signed in under the SAME provider — there is no
mixed-provider mode. M6 (per-user webhook routing) depends on a Graph change
notification reaching a consumer-mailbox subscription; see the runbook's
"Multi-user smoke" section for the gate that decides whether M6 runs or is
skipped under `--provider microsoft`.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time as _time
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

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
# No module-level CalendarClient binding: calendar clients are built per-run
# via _smoke_lib.make_calendar_client(sched, provider), which returns either
# _smoke_lib.CalendarClient (Google) or _smoke_lib.GraphCalendarClient
# (Microsoft) — both share the verbs this harness uses. Annotations that used
# to read `cal: CalendarClient` now use this duck-typed alias instead.
CalendarClientLike = _smoke_lib.CalendarClient | _smoke_lib.GraphCalendarClient

# This harness WRITES to D1 (seeds per-user config, re-onboards). It must only
# ever touch a smoke database; prod is hard-denied by the shared guards, and
# the URL/db pair must name the SAME env (assert_env_consistent) so one env's
# API calls can never be paired with another env's D1 reads.
# D1 access goes through the env-aware shared DevD1 (d1_for_db_id) — the old
# local copy hardcoded `wrangler d1 execute scheduler-dev --env dev`.
DEV_DB_ID = _smoke_lib.DEV_DB_ID     # scheduler-dev
PROD_DB_ID = _smoke_lib.PROD_DB_ID   # scheduler (prod) — NEVER
assert_dev_db = _smoke_lib.assert_dev_db
assert_dev_url = _smoke_lib.assert_dev_url
assert_env_consistent = _smoke_lib.assert_env_consistent
DevD1 = _smoke_lib.DevD1
d1_for_db_id = _smoke_lib.d1_for_db_id

TASK_PREFIX = "mu-smoke"          # source.external_id prefix
TEMPLATE_PREFIX = "[mu-smoke]"    # template title prefix
EVENT_PREFIX = "[mu-smoke"        # calendar summary prefix


def sql_str(value: str) -> str:
    """Single-quote-escape a string for inline SQL (harness-controlled values only)."""
    return "'" + value.replace("'", "''") + "'"


@dataclass(frozen=True)
class MultiEnv:
    a: Identity
    b: Identity
    d1_database_id: str
    repo_root: Path
    # The campaign provider (--provider). Levels whose expectations differ by
    # provider (M8: Google rotates a push channel on renewal, Graph renews the
    # same subscription in place) read it from here.
    provider: str = "google"

    @classmethod
    def from_environ(cls, provider: str = "google") -> "MultiEnv":
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

        db_id = req("D1_DATABASE_ID")
        assert_dev_db(db_id)
        assert_env_consistent(url, db_id)
        return cls(a=identity("A"), b=identity("B"), d1_database_id=db_id,
                   repo_root=Path(__file__).resolve().parent.parent,
                   provider=provider)

    def d1(self) -> DevD1:
        """The DevD1 for whichever env owns D1_DATABASE_ID (SMOKE_WRANGLER_ENV
        wins when set — the runner sets it as part of the target triple)."""
        return d1_for_db_id(self.d1_database_id, self.repo_root)


@dataclass
class LevelResult:
    level: str
    passed: bool
    elapsed_seconds: float
    notes: str = ""


# Preflight guard for one identity's /v1/whoami body against the identity +
# provider we THINK we minted — extracted to _smoke_lib.py as check_whoami_body
# (WP4, internal design notes) so bin/meeting-smoke.py can
# share the IDENTICAL check rather than reimplementing it. See
# _smoke_lib.check_whoami_body's docstring for the full contract (email must
# match EXACTLY — it's used verbatim as a D1 subject key throughout this
# harness — and provider is checked only when the body carries one).
check_whoami = _smoke_lib.check_whoami_body


def preflight(menv: MultiEnv, sa: SchedulerClient, sb: SchedulerClient, provider: str) -> None:
    """Confirm each client authenticates as the expected identity (and, when
    the worker's whoami reports one, the expected provider) via /v1/whoami."""
    for who, sched, ident in (("A", sa, menv.a), ("B", sb, menv.b)):
        try:
            r = sched.request("GET", "/v1/whoami")
        except _smoke_lib.RefreshRejected as e:
            # B's tokens are revoked by M7 (offboard) — the next run must
            # re-mint B, and the message says exactly how.
            raise SystemExit(_smoke_lib.refresh_rejected_message(e, who, provider)) from None
        r.raise_for_status()
        err, warning = check_whoami(r.json(), ident.expected_email, provider, who)
        if err:
            raise SystemExit(f"identity {who}: {err}")
        if warning:
            print(f"identity {who}: {warning}", file=sys.stderr)


def _baseline_path(root: Path) -> Path:
    d = root / "bin" / "mu-smoke-baselines"
    d.mkdir(parents=True, exist_ok=True)
    return d / "levels.json"


def _record_baseline(root: Path, results: list[LevelResult]) -> None:
    payload = {r.level: {"passed": r.passed} for r in results}
    _baseline_path(root).write_text(json.dumps(payload, indent=2, sort_keys=True))


def _check_baseline(root: Path, results: list[LevelResult]) -> bool:
    p = _baseline_path(root)
    if not p.exists():
        print("no baseline recorded; run --baseline-record first", file=sys.stderr)
        return False
    base = json.loads(p.read_text())
    ok = True
    for r in results:
        want = base.get(r.level, {}).get("passed")
        if want is not None and want != r.passed:
            print(f"M{r.level}: baseline passed={want}, now passed={r.passed}", file=sys.stderr)
            ok = False
    return ok


def run_live(args: argparse.Namespace) -> int:
    menv = MultiEnv.from_environ(provider=args.provider)
    d1 = menv.d1()
    sa, sb = SchedulerClient(menv.a), SchedulerClient(menv.b)
    ca = _smoke_lib.make_calendar_client(sa, args.provider)
    cb = _smoke_lib.make_calendar_client(sb, args.provider)
    console = Console(stderr=True)
    levels = [s.strip() for s in args.levels.split(",") if s.strip()]
    # LEVELS registry is populated in later tasks: {"1": run_m1, ...}
    results: list[LevelResult] = []
    try:
        preflight(menv, sa, sb, args.provider)
        console.print(
            f"[dim]A={menv.a.expected_email}  B={menv.b.expected_email}  "
            f"provider: {args.provider}[/]"
        )
        if args.dry_run:
            console.print(f"[bold]levels:[/] {levels}")
            return 0
        for lv in levels:
            fn = LEVELS.get(lv)
            if fn is None:
                console.print(f"[yellow]skip unknown level M{lv}[/]")
                continue
            started = datetime.now(tz=timezone.utc)
            console.print(f"[bold]M{lv} starting...[/]")
            try:
                fn(menv, d1, sa, sb, ca, cb)
                ok, notes = True, ""
            except AssertionError as e:
                ok, notes = False, str(e)
            elapsed = (datetime.now(tz=timezone.utc) - started).total_seconds()
            results.append(LevelResult(level=lv, passed=ok, elapsed_seconds=elapsed, notes=notes))
        passed = sum(1 for r in results if r.passed)
        for r in results:
            tag = "PASS" if r.passed else "FAIL"
            console.print(f"  M{r.level}: {tag}  ({r.elapsed_seconds:.1f}s)  {r.notes}")
        console.print(f"TOTAL {passed}/{len(results)}")
        if args.baseline_record:
            _record_baseline(menv.repo_root, results)
            console.print("[dim]baseline recorded[/]")
        if args.baseline_check and not _check_baseline(menv.repo_root, results):
            return 1
        return 0 if passed == len(results) else 1
    finally:
        for c in (ca, cb):
            c.close()
        for s in (sa, sb):
            s.close()


LEVELS: dict[str, object] = {}


def _task_body(ext: str, title: str = "iso task", earliest: date | None = None) -> dict:
    # `earliest` matters for any level that RESOLVES: since worker 994ccde
    # (an internal PR, future-week backlog guard) an unanchored task (no template)
    # with no deadline is shed from a future window unless its
    # earliest_start is at/after the window start — a level resolving
    # _next_monday must pass that monday here (as M6 always did), or the
    # worker silently excludes the task and the level fails with
    # "was not scheduled". Levels that never resolve (M1/M2/M7) keep the
    # today default.
    start_day = earliest if earliest is not None else date.today()
    return {
        "title": title, "context": "deep", "priority": 75,
        "earliest_start": f"{start_day.isoformat()}T00:00",
        "deadline": None, "preferred_windows": [], "dependencies": [],
        "pinned_at": None, "duration_minutes": 60,
        "source": {"kind": "mcp", "external_id": ext}, "status": "pending",
    }


def _post_task(s: SchedulerClient, ext: str, title: str = "iso task",
               earliest: date | None = None) -> str:
    r = s.request("POST", "/v1/tasks", json=_task_body(ext, title, earliest=earliest))
    r.raise_for_status()
    return r.json()["id"]


def _list_task_exts(s: SchedulerClient) -> dict[str, str]:
    """external_id -> uuid for this caller's harness-tagged tasks."""
    r = s.request("GET", "/v1/tasks")
    r.raise_for_status()
    out: dict[str, str] = {}
    for t in r.json().get("tasks", []):
        src = t.get("source") or {}
        ext = src.get("external_id")
        if isinstance(ext, str) and ext.startswith(f"{TASK_PREFIX}-"):
            out[ext] = t["id"]
    return out


def _cleanup_tasks(s: SchedulerClient) -> None:
    for uuid in _list_task_exts(s).values():
        s.request("DELETE", f"/v1/tasks/{uuid}")


def _cleanup_templates(s: SchedulerClient) -> None:
    r = s.request("GET", "/v1/templates")
    r.raise_for_status()
    for t in r.json().get("templates", []):
        if isinstance(t.get("title"), str) and t["title"].startswith(TEMPLATE_PREFIX):
            s.request("DELETE", f"/v1/templates/{t['id']}")


def run_m1(menv, d1, sa, sb, ca, cb) -> None:
    """Read isolation: each caller sees only their own tasks."""
    try:
        a_ext = {f"{TASK_PREFIX}-a-{i}" for i in range(3)}
        b_ext = {f"{TASK_PREFIX}-b-{i}" for i in range(3)}
        for e in a_ext:
            _post_task(sa, e)
        for e in b_ext:
            _post_task(sb, e)
        a_seen = set(_list_task_exts(sa))
        b_seen = set(_list_task_exts(sb))
        assert a_ext <= a_seen, f"M1: A missing its own tasks: {a_ext - a_seen}"
        assert not (a_seen & b_ext), f"M1: A SEES B's tasks (LEAK): {a_seen & b_ext}"
        assert b_ext <= b_seen, f"M1: B missing its own tasks: {b_ext - b_seen}"
        assert not (b_seen & a_ext), f"M1: B SEES A's tasks (LEAK): {b_seen & a_ext}"
    finally:
        _cleanup_tasks(sa)
        _cleanup_tasks(sb)


def run_m2(menv, d1, sa, sb, ca, cb) -> None:
    """Write default-deny: A cannot read or delete B's task by id."""
    try:
        b_uuid = _post_task(sb, f"{TASK_PREFIX}-b-target")
        # A reads B's task by id -> 404.
        r = sa.request("GET", f"/v1/tasks/{b_uuid}")
        assert r.status_code == 404, f"M2: A GET B's task expected 404, got {r.status_code}"
        # A deletes B's task by id -> 404, and B's task survives.
        r = sa.request("DELETE", f"/v1/tasks/{b_uuid}")
        assert r.status_code == 404, f"M2: A DELETE B's task expected 404, got {r.status_code}"
        still = sb.request("GET", f"/v1/tasks/{b_uuid}")
        assert still.status_code == 200, (
            f"M2: B's task was destroyed by A's cross-user delete (got {still.status_code})"
        )
    finally:
        _cleanup_tasks(sb)


LEVELS["1"] = run_m1
LEVELS["2"] = run_m2


def _next_monday(day: date) -> date:
    days = (7 - day.weekday()) % 7
    return day + timedelta(days=days or 7)


def _resolve(s: SchedulerClient, monday: date) -> dict:
    r = s.request("POST", "/v1/resolve", json={
        "window_start": f"{monday.isoformat()}T00:00",
        "window_end": f"{(monday + timedelta(days=7)).isoformat()}T00:00",
    })
    r.raise_for_status()
    return r.json()


def run_m3(menv, d1, sa, sb, ca, cb) -> None:
    """Resolve scoping: A's solve schedules only A's tasks, never B's."""
    monday = _next_monday(date.today())
    try:
        a_uuids = {_post_task(sa, f"{TASK_PREFIX}-a-{i}", earliest=monday) for i in range(3)}
        b_uuids = {_post_task(sb, f"{TASK_PREFIX}-b-{i}", earliest=monday) for i in range(3)}
        a_plan = _resolve(sa, monday)
        sched_ids = {c.get("task_id") for c in a_plan.get("schedule", [])}
        assert a_uuids & sched_ids, "M3: A's own tasks were not scheduled in A's plan"
        leaked = b_uuids & sched_ids
        assert not leaked, f"M3: A's plan scheduled B's tasks (LEAK): {leaked}"
        # Symmetric: B's plan never contains A's tasks.
        b_plan = _resolve(sb, monday)
        b_sched = {c.get("task_id") for c in b_plan.get("schedule", [])}
        assert not (a_uuids & b_sched), f"M3: B's plan scheduled A's tasks (LEAK): {a_uuids & b_sched}"
    finally:
        for h in (sa, sb):
            _cleanup_tasks(h)
        # Drop any plans the resolves committed for this window.
        for h in (sa, sb):
            try:
                plan = _resolve(h, monday)
                if plan.get("plan_hash"):
                    h.request("DELETE", f"/v1/plans/{plan['plan_hash']}")
            except Exception:
                pass


LEVELS["3"] = run_m3


def _seed_business_hours(d1: DevD1, subject: str, start_hhmm: str, end_hhmm: str) -> None:
    body = json.dumps({"days": ["mon", "tue", "wed", "thu", "fri"],
                       "start": start_hhmm, "end": end_hhmm})
    d1.execute(
        f"INSERT OR REPLACE INTO config_business_hours (owner_subject, body) "
        f"VALUES ({sql_str(subject)}, {sql_str(body)})"
    )


def _set_home_tz(d1: DevD1, subject: str, home_tz: str | None) -> None:
    val = "NULL" if home_tz is None else sql_str(home_tz)
    d1.execute(f"UPDATE users SET home_tz = {val} WHERE subject = {sql_str(subject)}")


def _cleanup_config(d1: DevD1, subject: str) -> None:
    for tbl in ("config_business_hours", "config_weights", "config_contexts"):
        d1.execute(f"DELETE FROM {tbl} WHERE owner_subject = {sql_str(subject)}")


def run_m4(menv, d1, sa, sb, ca, cb) -> None:
    """Per-user config + home_tz: A and B get their own config in resolve."""
    a_sub, b_sub = menv.a.expected_email, menv.b.expected_email
    monday = _next_monday(date.today())
    try:
        # A: mornings only, Sydney. B: afternoons only, New York.
        _seed_business_hours(d1, a_sub, "08:00", "12:00")
        _set_home_tz(d1, a_sub, "Australia/Sydney")
        _seed_business_hours(d1, b_sub, "13:00", "17:00")
        _set_home_tz(d1, b_sub, "America/New_York")

        a_task_id = _post_task(sa, f"{TASK_PREFIX}-a-cfg", earliest=monday)
        b_task_id = _post_task(sb, f"{TASK_PREFIX}-b-cfg", earliest=monday)
        a_plan = _resolve(sa, monday)
        b_plan = _resolve(sb, monday)

        # Assert only on the chunk(s) of the task THIS level created, keyed by
        # task_id. A and B are the operators' real dev accounts and may carry an
        # unrelated backlog — including *pinned* tasks, which legitimately
        # override business hours — so asserting over the entire resolved
        # schedule is wrong (a pinned-afternoon task would spuriously fail the
        # mornings-only check). Scoping to our own task verifies the per-user
        # business-hours config without coupling to whatever else is in the
        # account.
        def _local_hours(plan: dict, zone_name: str, task_id: str) -> list[int]:
            zone = tz.gettz(zone_name)
            hrs = []
            for c in plan.get("schedule", []):
                if c.get("task_id") != task_id:
                    continue
                t = datetime.fromisoformat(c["start"].replace("Z", "+00:00")).astimezone(zone)
                hrs.append(t.hour)
            return hrs

        a_hours = _local_hours(a_plan, "Australia/Sydney", a_task_id)
        b_hours = _local_hours(b_plan, "America/New_York", b_task_id)
        assert a_hours, "M4: A's own config task was not scheduled"
        assert b_hours, "M4: B's own config task was not scheduled"
        assert all(8 <= h < 12 for h in a_hours), f"M4: A's task placed outside its mornings: {a_hours}"
        assert all(13 <= h < 17 for h in b_hours), f"M4: B's task placed outside its afternoons: {b_hours}"

        # Fallback: a user with no override resolves against '__default__' (no crash, schedules).
        _cleanup_config(d1, a_sub)
        _set_home_tz(d1, a_sub, None)
        _post_task(sa, f"{TASK_PREFIX}-a-default", earliest=monday)
        a_default_plan = _resolve(sa, monday)
        assert a_default_plan.get("schedule"), "M4: A with no override failed to resolve against default"
    finally:
        _cleanup_config(d1, a_sub)
        _cleanup_config(d1, b_sub)
        _set_home_tz(d1, a_sub, None)
        _set_home_tz(d1, b_sub, None)
        for h in (sa, sb):
            _cleanup_tasks(h)
            try:
                plan = _resolve(h, monday)
                if plan.get("plan_hash"):
                    h.request("DELETE", f"/v1/plans/{plan['plan_hash']}")
            except Exception:
                pass


LEVELS["4"] = run_m4


def run_m5(menv, d1, sa, sb, ca, cb) -> None:
    """Fail-closed auth: no/invalid bearer is rejected; members succeed."""
    url = menv.a.scheduler_url
    raw = httpx.Client(timeout=30.0)
    try:
        # No Authorization header at all -> rejected (401).
        r = raw.get(f"{url}/v1/tasks")
        assert r.status_code in (401, 403), f"M5: missing bearer expected 401/403, got {r.status_code}"
        # Garbage bearer -> rejected (401).
        r = raw.get(f"{url}/v1/tasks", headers={"Authorization": "Bearer not-a-real-token"})
        assert r.status_code in (401, 403), f"M5: garbage bearer expected 401/403, got {r.status_code}"
        # Allow path: both members can list their own tasks (200).
        for who, s in (("A", sa), ("B", sb)):
            ok = s.request("GET", "/v1/tasks")
            assert ok.status_code == 200, f"M5: member {who} GET /v1/tasks expected 200, got {ok.status_code}"
    finally:
        raw.close()


LEVELS["5"] = run_m5


def _find_blank_monday(cal: CalendarClientLike, start_after: date) -> date:
    candidate = _next_monday(start_after)
    horizon = start_after + timedelta(days=400)
    while candidate <= horizon:
        span_end = candidate + timedelta(days=7)
        events = cal.list_events(f"{candidate.isoformat()}T00:00:00Z",
                                 f"{span_end.isoformat()}T00:00:00Z")
        if not events:
            return candidate
        candidate = candidate + timedelta(days=7)
    raise RuntimeError("M6: no blank week found within a year")


def _latest_plan(s: SchedulerClient, covers_iso: str) -> dict | None:
    r = s.request("GET", "/v1/plans/latest", params={"covers": covers_iso})
    r.raise_for_status()
    return r.json().get("plan")


def run_m6(menv, d1, sa, sb, ca, cb) -> None:
    """Per-user webhook routing: a push on B's calendar replans B only, not A."""
    sb.request("POST", "/v1/webhook/subscribe").raise_for_status()
    sa.request("POST", "/v1/webhook/subscribe").raise_for_status()

    monday = _find_blank_monday(cb, date.today())
    earliest = f"{monday.isoformat()}T00:00"
    b_task_ids: list[str] = []
    a_task_ids: list[str] = []
    event_id: str | None = None
    b_hashes: set[str] = set()
    a_base_hash: str | None = None
    b_base_hash: str | None = None
    try:
        # Seed both A and B a pending-task week; baseline-resolve each.
        for i in range(3):
            r = sb.request("POST", "/v1/tasks", json={**_task_body(f"{TASK_PREFIX}-b-wh-{i}"),
                                                      "earliest_start": earliest})
            r.raise_for_status(); b_task_ids.append(r.json()["id"])
            r = sa.request("POST", "/v1/tasks", json={**_task_body(f"{TASK_PREFIX}-a-wh-{i}"),
                                                      "earliest_start": earliest})
            r.raise_for_status(); a_task_ids.append(r.json()["id"])
        b_base = _resolve(sb, monday); b_base_hash = b_base.get("plan_hash")
        a_base = _resolve(sa, monday); a_base_hash = a_base.get("plan_hash")
        if b_base_hash: b_hashes.add(b_base_hash)

        # Conflicting event on B's calendar -> webhook on B's channel.
        start = datetime.combine(monday, datetime.min.time(), tzinfo=timezone.utc).replace(hour=23)
        end = start + timedelta(hours=1)
        event_id = cb.create_event(f"{EVENT_PREFIX} routing conflict]", start.isoformat(), end.isoformat())
        covers = start.isoformat()

        deadline = _time.monotonic() + 120.0
        replanned = None
        while _time.monotonic() < deadline:
            plan = _latest_plan(sb, covers)
            if plan and plan.get("plan_hash") != b_base_hash and plan.get("render_snapshot") is not None:
                replanned = plan; b_hashes.add(plan["plan_hash"]); break
            _time.sleep(3.0)
        assert replanned is not None, "M6: B's calendar push did not replan B within 120s"

        # A must be untouched: A's latest plan hash for the same week is unchanged.
        a_now = _latest_plan(sa, covers)
        a_now_hash = a_now.get("plan_hash") if a_now else None
        assert a_now_hash == a_base_hash, (
            f"M6: A was replanned by B's push (LEAK): {a_base_hash} -> {a_now_hash}"
        )
    finally:
        if event_id:
            try: cb.delete_event(event_id)
            except Exception: pass
        for tid in b_task_ids: sb.request("DELETE", f"/v1/tasks/{tid}")
        for tid in a_task_ids: sa.request("DELETE", f"/v1/tasks/{tid}")
        for h in b_hashes: sb.request("DELETE", f"/v1/plans/{h}")
        if a_base_hash: sa.request("DELETE", f"/v1/plans/{a_base_hash}")


LEVELS["6"] = run_m6


def _count(d1: DevD1, table: str, subject: str) -> int:
    rows = d1.query(f"SELECT COUNT(*) AS n FROM {table} WHERE owner_subject = {sql_str(subject)}")
    return int(rows[0]["n"]) if rows else 0


def run_m7(menv, d1, sa, sb, ca, cb) -> None:
    """Offboarding: admin A offboards B; B's data is purged + audited; then re-onboard B.

    Covers the offboard-completeness fixes (fix/offboard-security): besides
    tasks/templates/calendar_sync, the purge must also clear B's busy-feed
    endpoint + its pending reveal (OS2, calendar_feed_tokens and
    calendar_feed_reveals — the multi-endpoint /v1/calendar-feeds surface) and
    per-user config (L9, the three config_* tables).

    Under --provider microsoft, the calendar-side cleanup in this same path
    runs because MS_PROVIDER_ENABLED is on for the target env — offboard
    treats a Microsoft subject like any other provider, not a special case.
    B's bearer is revoked by the offboard either way, so B must be re-minted
    before any B-dependent level runs again: `eval "$(bin/mu-smoke-login.py B
    --provider microsoft)"` under this provider, plain `B` (no flag) under
    Google."""
    b_sub = menv.b.expected_email
    monday = _next_monday(date.today())
    empty = sql_str("{}")
    try:
        # Give B some assets so the purge is observable.
        _post_task(sb, f"{TASK_PREFIX}-b-offb-0")
        _post_task(sb, f"{TASK_PREFIX}-b-offb-1")
        sb.request("POST", "/v1/webhook/subscribe").raise_for_status()
        # OS2: mint a real busy-feed endpoint via the API (exercises the hash
        # path). Creating a feed also stages a calendar_feed_reveals row (the
        # single-use reveal token for the label below), so both tables have a
        # row to purge — asserted in the OS2/L9 precondition + purge loops.
        sb.request("POST", "/v1/calendar-feeds", json={"label": f"{TASK_PREFIX}-b-offb-feed"}).raise_for_status()
        # L9: seed a row in each of the three per-user config_* tables.
        _seed_business_hours(d1, b_sub, "09:00", "17:00")
        d1.execute(f"INSERT OR REPLACE INTO config_weights (owner_subject, body) VALUES ({sql_str(b_sub)}, {empty})")
        d1.execute(f"INSERT OR REPLACE INTO config_contexts (owner_subject, context, body) VALUES ({sql_str(b_sub)}, {sql_str('deep')}, {empty})")

        assert _count(d1, "tasks", b_sub) >= 2, "M7: precondition — B has no tasks to purge"
        # OS2/L9 preconditions: the new owner-scoped tables actually hold B rows.
        # calendar_feed_reveals is included because creating a feed above also
        # stages a reveal row for the same owner; offboard must purge both.
        for table in (
            "calendar_feed_tokens", "calendar_feed_reveals",
            "config_weights", "config_contexts", "config_business_hours",
        ):
            assert _count(d1, table, b_sub) >= 1, f"M7: precondition — B has no {table} row to purge"

        # Admin A offboards B.
        r = sa.request("POST", "/admin/offboard", json={"subject": b_sub})
        assert r.status_code == 200, f"M7: offboard expected 200, got {r.status_code}: {r.text[:200]}"

        # B's owned rows are gone — incl. OS2 feed tokens/reveals + L9 per-user config.
        for table in (
            "tasks", "task_templates", "calendar_sync",
            "calendar_feed_tokens", "calendar_feed_reveals",
            "config_weights", "config_contexts", "config_business_hours",
        ):
            n = _count(d1, table, b_sub)
            assert n == 0, f"M7: B still has {n} rows in {table} after offboard"
        # B deactivated.
        urow = d1.query(f"SELECT is_active FROM users WHERE subject = {sql_str(b_sub)}")
        assert urow and int(urow[0]["is_active"]) == 0, f"M7: B not deactivated: {urow}"
        # Audit row written for the offboard, actor = A's email, source = admin.
        audit = d1.query(
            f"SELECT actor, source FROM audit_log WHERE subject = {sql_str(b_sub)} "
            f"AND source = 'admin' ORDER BY rowid DESC LIMIT 5"
        )
        assert any(a.get("actor") == menv.a.expected_email for a in audit), (
            f"M7: no admin offboard audit row by actor {menv.a.expected_email}: {audit}"
        )
    finally:
        # Offboarding revokes B's OAuth tokens, so B's bearer is now dead — teardown
        # must not touch the API as B (it would 401 -> refresh -> 400 and mask the
        # result). Offboard already purged B's tasks/templates/calendar_sync, so the
        # only repeatability step is reactivating B's users row via D1. B must be
        # re-minted (`eval "$(bin/mu-smoke-login.py B)"`, or under --provider
        # microsoft `eval "$(bin/mu-smoke-login.py B --provider microsoft)"`)
        # before any B-dependent level is run again.
        try:
            d1.execute(f"UPDATE users SET is_active = 1 WHERE subject = {sql_str(b_sub)}")
            # On a mid-level failure offboard may not have run; drop any seeded
            # feed/config rows so a re-run starts clean (on success these are no-ops,
            # already purged). Bound to B's real subject — __default__ is untouched.
            _cleanup_config(d1, b_sub)
            d1.execute(f"DELETE FROM calendar_feed_tokens WHERE owner_subject = {sql_str(b_sub)}")
            d1.execute(f"DELETE FROM calendar_feed_reveals WHERE owner_subject = {sql_str(b_sub)}")
        except Exception:
            pass


LEVELS["7"] = run_m7


def m8_renewal_verdict(provider: str, old_channel: str, new_channel: str,
                       expires_at: datetime, now: datetime | None = None) -> str | None:
    """None when B's calendar_sync row shows the renewal the sweep is expected
    to perform for `provider`, else the failure message.

    The worker's ensureSubscription (worker/src/webhooks/subscription-manager.ts)
    is provider-aware: Google has no renew verb, so a lapsed channel is
    ROTATED (new channel_id); Graph supports PATCH /subscriptions/{id}, so a
    lapsed subscription is renewed IN PLACE (same channel_id, later expiry) —
    except on UTC Sunday, when the sweep forces the rotate path so the
    channel_token/clientState still cycles weekly. Either way the new expiry
    must be in the future (the level backdated it to an hour ago first)."""
    now = now or datetime.now(tz=timezone.utc)
    rows = f"channel_id {old_channel!r} -> {new_channel!r}, expires {expires_at.isoformat()}"
    if expires_at <= now:
        return f"M8: renewed channel already expired: {rows}"
    if provider == "microsoft" and now.weekday() != 6:
        if new_channel != old_channel:
            return (f"M8: Graph subscription should be renewed in place but was rotated "
                    f"(non-Sunday): {rows}")
        return None
    if new_channel == old_channel:
        why = "UTC Sunday forces the rotate path" if provider == "microsoft" else "Google rotates"
        return f"M8: channel not rotated ({why}): {rows}"
    return None


def run_m8(menv, d1, sa, sb, ca, cb) -> None:
    """Channel renewal: a lapsed push channel is renewed by the sweep — rotated
    on Google, renewed in place on Graph (see m8_renewal_verdict)."""
    b_sub = menv.b.expected_email
    sb.request("POST", "/v1/webhook/subscribe").raise_for_status()
    rows = d1.query(
        f"SELECT channel_id FROM calendar_sync WHERE owner_subject = {sql_str(b_sub)}"
    )
    assert rows and rows[0]["channel_id"], "M8: precondition — B has no push channel"
    old_channel = rows[0]["channel_id"]

    # Backdate B's channel so the sweep sees it as lapsed (push subscriptions
    # expire silently — Google channels after ~7 days, Graph subscriptions
    # within <= 4230 minutes; the renew sweep is provider-aware. This
    # simulates the lapse without waiting either way).
    past = (datetime.now(tz=timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    d1.execute(
        f"UPDATE calendar_sync SET channel_expires_at = {sql_str(past)} "
        f"WHERE owner_subject = {sql_str(b_sub)}"
    )

    # The sweep is fan-out (not caller-scoped): A's call must renew B's channel.
    r = sa.request("POST", "/admin/renew-subscriptions")
    assert r.status_code == 200, f"M8: renew expected 200, got {r.status_code}: {r.text[:200]}"
    body = r.json()
    assert body.get("ok") is True and body.get("renewed", 0) >= 1, f"M8: bad sweep result: {body}"

    rows = d1.query(
        f"SELECT channel_id, channel_expires_at FROM calendar_sync "
        f"WHERE owner_subject = {sql_str(b_sub)}"
    )
    assert rows and rows[0]["channel_id"], f"M8: B's channel row vanished after the sweep: {rows}"
    expires = datetime.fromisoformat(rows[0]["channel_expires_at"].replace("Z", "+00:00"))
    verdict = m8_renewal_verdict(menv.provider, old_channel, rows[0]["channel_id"], expires)
    assert verdict is None, verdict


LEVELS["8"] = run_m8


def self_test() -> int:
    """Pure checks, no network."""
    # DB-id guard.
    assert_dev_db(DEV_DB_ID)  # ok
    for bad in (PROD_DB_ID, "deadbeef"):
        try:
            assert_dev_db(bad)
            raise AssertionError(f"assert_dev_db must reject {bad!r}")
        except SystemExit:
            pass
    # sql_str escaping.
    assert sql_str("a'b") == "'a''b'", sql_str("a'b")
    # DevD1 JSON parse from a wrangler-style payload.
    d1 = DevD1(repo_root=Path("/nonexistent"))
    parsed = json.loads('[{"results":[{"n":1}]}]'[0:])
    assert parsed[0]["results"][0]["n"] == 1
    # MultiEnv rejects the prod DB id.
    saved = dict(os.environ)
    try:
        os.environ.update({
            "SCHEDULER_URL": "https://scheduler-dev.example.com", "A_BEARER": "x", "A_REFRESH": "x",
            "A_EXPECTED_EMAIL": "a@x",
            "B_BEARER": "x", "B_REFRESH": "x",
            "B_EXPECTED_EMAIL": "b@x", "D1_DATABASE_ID": PROD_DB_ID,
        })
        try:
            MultiEnv.from_environ()
            raise AssertionError("MultiEnv must refuse the prod DB id")
        except SystemExit:
            pass
    finally:
        os.environ.clear()
        os.environ.update(saved)
    print("self-test: OK", file=sys.stderr)
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Multi-user smoke harness (smoke envs only, never prod).")
    p.add_argument("--provider", choices=list(_smoke_lib.PROVIDERS),
                   default=os.environ.get("SMOKE_PROVIDER") or "google",
                   help="Calendar provider BOTH identities (A and B) are signed in "
                        "under (default: $SMOKE_PROVIDER or google). microsoft drives "
                        "Graph for both accounts; there is no mixed-provider mode.")
    # M7 (offboard) is destructive to B — it purges B's identity/bearer and is NOT
    # re-onboarded in-run — so every B-dependent level (incl. M8's webhook subscribe)
    # must precede it. Levels run in the given order, so M7 runs LAST by default.
    p.add_argument("--levels", type=str, default="1,2,3,4,5,6,8,7",
                   help="comma-separated M-level numbers, run in this order "
                        "(default: all; destructive M7/offboard runs last)")
    p.add_argument("--self-test", action="store_true",
                   help="run pure functions with synthetic inputs; no network")
    p.add_argument("--baseline-record", action="store_true")
    p.add_argument("--baseline-check", action="store_true")
    p.add_argument("--dry-run", action="store_true",
                   help="print the planned identities/levels; no mutations")
    return p.parse_args(argv)


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    return run_live(args)


if __name__ == "__main__":
    sys.exit(main())
