#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "rich>=13.7"]
# ///
"""Regression guards for bin/multiuser-smoke.py's task/window admissibility.

Since worker commit 994ccde ("fix(planning): future weeks no longer capture
unanchored backlog", an internal PR), an unanchored task (no template) with no
deadline is admitted to a FUTURE resolve window only when its
`earliest_start` is at or after the window start
(worker/src/planning/task-window.ts, taskBelongsInWindow). M3/M4 resolve
against next Monday but seeded tasks with `earliest_start = today`, so the
worker shed them from the solver input (solver_calls n_tasks=0) and both
levels failed deterministically — root-caused 2026-09-01. M6 always passed
its own monday-based earliest_start; these tests pin M3/M4 (and the shared
helpers) to the same rule, offline, with fake clients.

Run: uv run bin/test_multiuser_smoke_window.py
"""
from __future__ import annotations

import importlib.util
import sys
import uuid
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

BIN = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("multiuser_smoke", BIN / "multiuser-smoke.py")
assert _spec and _spec.loader, "could not load multiuser-smoke module"
mu = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mu
_spec.loader.exec_module(mu)


# =============================================================================
# Fakes — enough SchedulerClient/D1 surface for run_m3/run_m4 to complete
# =============================================================================


class FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class FakeScheduler:
    """Records every POST /v1/tasks body; answers /v1/resolve with a schedule
    chunk per recorded task at a fixed local-time `chunk_start` so M4's
    business-hours assertions have something real to check."""

    def __init__(self, chunk_start: datetime):
        self.posted_tasks: list[dict] = []          # raw bodies, in order
        self._ids: list[str] = []
        self._chunk_start = chunk_start.astimezone(timezone.utc)

    def request(self, method: str, path: str, json: dict | None = None):
        if method == "POST" and path == "/v1/tasks":
            self.posted_tasks.append(json)
            new_id = str(uuid.uuid4())
            self._ids.append(new_id)
            return FakeResponse({"id": new_id})
        if method == "POST" and path == "/v1/resolve":
            start_iso = self._chunk_start.strftime("%Y-%m-%dT%H:%M:%SZ")
            return FakeResponse({
                "schedule": [{"task_id": tid, "start": start_iso} for tid in self._ids],
                "plan_hash": None,  # cleanup skips the plan DELETE
            })
        if method == "GET" and path == "/v1/tasks":
            return FakeResponse({"tasks": [
                {"id": tid, "source": body.get("source")}
                for tid, body in zip(self._ids, self.posted_tasks)
            ]})
        return FakeResponse({})


class FakeD1:
    def execute(self, sql: str) -> None:
        return None

    def query(self, sql: str) -> list[dict]:
        return []


def _window_monday() -> date:
    return mu._next_monday(date.today())


def _expected_earliest() -> str:
    return f"{_window_monday().isoformat()}T00:00"


# =============================================================================
# Helper contract — _task_body/_post_task earliest override
# =============================================================================


def test_task_body_default_earliest_is_today():
    # M1/M2/M7 don't resolve; their current-week semantics must not shift.
    body = mu._task_body("musmoke-x")
    assert body["earliest_start"] == f"{date.today().isoformat()}T00:00"


def test_task_body_accepts_an_explicit_earliest_date():
    body = mu._task_body("musmoke-x", earliest=date(2026, 9, 7))
    assert body["earliest_start"] == "2026-09-07T00:00"


# =============================================================================
# M3/M4 — every seeded task must be admissible to the future resolve window
# =============================================================================


def _assert_all_admissible(fake: FakeScheduler) -> None:
    assert fake.posted_tasks, "level posted no tasks at all"
    expected = _expected_earliest()
    for body in fake.posted_tasks:
        assert body["earliest_start"] == expected, (
            f"task {body['source']['external_id']} has earliest_start "
            f"{body['earliest_start']!r} — before the {expected!r} window start, "
            f"the future-week backlog guard (worker 994ccde) sheds it"
        )


def test_m3_seeds_tasks_admissible_to_its_resolve_window():
    monday = _window_monday()
    local_9am = datetime.combine(monday, time(9, 0), tzinfo=ZoneInfo("Australia/Sydney"))
    sa, sb = FakeScheduler(local_9am), FakeScheduler(local_9am)
    mu.run_m3(None, FakeD1(), sa, sb, None, None)
    _assert_all_admissible(sa)
    _assert_all_admissible(sb)


def test_m4_seeds_tasks_admissible_to_its_resolve_window():
    monday = _window_monday()
    sydney_9am = datetime.combine(monday, time(9, 0), tzinfo=ZoneInfo("Australia/Sydney"))
    ny_2pm = datetime.combine(monday, time(14, 0), tzinfo=ZoneInfo("America/New_York"))
    sa, sb = FakeScheduler(sydney_9am), FakeScheduler(ny_2pm)

    class Ident:
        expected_email = "x@example.com"

    class MEnv:
        a = Ident()
        b = Ident()

    mu.run_m4(MEnv(), FakeD1(), sa, sb, None, None)
    _assert_all_admissible(sa)
    _assert_all_admissible(sb)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
