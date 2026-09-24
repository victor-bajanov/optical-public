#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/reset-smoke-env.py's harness-row D1 sledgehammer (WP5,
internal design notes).

`wipe_harness_d1` used to match only "[regsmoke"-titled tasks/templates. That
already missed most of regression-smoke.py's own tasks, and two other
harnesses leave D1 residue it never touched at all:

- bin/regression-smoke.py's generic L1-L5 tasks get a realistic-looking title
  ("Spec review", "Gym", "Run", "1:1", "Process inbox", ... — see
  `_TITLE_BY_CTX` there) and are identifiable ONLY by their
  `source.external_id` starting with "regsmoke-" (its own `_task_is_harness`
  keys on exactly that). Only the "must_include" family
  ("[regsmoke] Mandatory deliverable N") and templates carry the title
  prefix.
- bin/meeting-smoke.py tags its filler tasks AND its imported-meeting tasks
  (title inherited verbatim from the Google event summary, per
  worker/src/meetings/sync.ts:85) with the "[mtg-smoke]" title prefix.
- bin/multiuser-smoke.py's templates use the "[mu-smoke]" title prefix
  defensively (it never actually POSTs a template today), but its TASKS are
  posted with a generic title ("iso task" — see bin/multiuser-smoke.py's
  `_task_body`) and are instead identifiable only by their
  `source.external_id` starting with "mu-smoke-". A title-only sweep would
  silently leave every orphaned mu-smoke task behind.

This file pins the pure selection predicates (`is_harness_row`,
`is_harness_task`) against fixture rows, and `wipe_harness_d1` end-to-end
against a mocked SchedulerClient transport.

Caveat pinned by test_wipe_harness_d1_deletes_exactly_the_harness_rows_in_order:
the sweep runs as ONE identity (`/v1/tasks` is owner-scoped), so it only
ever sees and deletes rows owned by whichever account reset-smoke-env.py
authenticates as.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import httpx
import pytest

BIN = Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


rse = _load("reset_smoke_env_test", "reset-smoke-env.py")


# ---------------------------------------------------------------------------
# is_harness_row: pure title-prefix predicate, shared by tasks + templates.
# ---------------------------------------------------------------------------

def test_regsmoke_title_is_harness_row():
    row = {"title": "[regsmoke] Mandatory deliverable 1"}
    assert rse.is_harness_row(row, rse.HARNESS_TITLE_PREFIXES) is True


def test_mtg_smoke_title_is_harness_row():
    # Both the filler-task title and an imported-meeting task's title (copied
    # from the calendar event summary) start with "[mtg-smoke]".
    row = {"title": "[mtg-smoke] filler my-label"}
    assert rse.is_harness_row(row, rse.HARNESS_TITLE_PREFIXES) is True


def test_mu_smoke_template_title_is_harness_row():
    row = {"title": "[mu-smoke] weekly sync"}
    assert rse.is_harness_row(row, rse.HARNESS_TITLE_PREFIXES) is True


def test_real_user_row_is_not_harness_row():
    row = {"title": "Write memo"}
    assert rse.is_harness_row(row, rse.HARNESS_TITLE_PREFIXES) is False


def test_title_merely_containing_prefix_midstring_is_not_harness_row():
    row = {"title": "Notes about [regsmoke stuff, ignore"}
    assert rse.is_harness_row(row, rse.HARNESS_TITLE_PREFIXES) is False


def test_non_string_title_is_not_harness_row():
    assert rse.is_harness_row({"title": None}, rse.HARNESS_TITLE_PREFIXES) is False
    assert rse.is_harness_row({}, rse.HARNESS_TITLE_PREFIXES) is False


# ---------------------------------------------------------------------------
# is_harness_task: title check plus the mu-smoke source.external_id fallback.
# ---------------------------------------------------------------------------

def test_mu_smoke_task_matched_by_external_id_despite_generic_title():
    task = {"title": "iso task", "source": {"kind": "mcp", "external_id": "mu-smoke-a-0"}}
    assert rse.is_harness_task(task) is True


def test_regsmoke_task_still_matched_by_title():
    task = {"title": "[regsmoke] Mandatory deliverable 1",
            "source": {"kind": "rest", "external_id": "regsmoke-L2-00"}}
    assert rse.is_harness_task(task) is True


def test_regsmoke_generic_titled_task_matched_by_external_id():
    # The generic L1-L5 family: a realistic title ("Gym"), matched only via
    # source.external_id ("regsmoke-L<label>-<nn>") like regression-smoke.py's
    # own _task_is_harness does.
    task = {"title": "Gym", "source": {"kind": "mcp", "external_id": "regsmoke-L3-05"}}
    assert rse.is_harness_task(task) is True


def test_real_task_with_generic_title_and_unrelated_source_not_matched():
    task = {"title": "iso task", "source": {"kind": "rest", "external_id": "user-1"}}
    assert rse.is_harness_task(task) is False


def test_task_missing_source_entirely_not_matched():
    assert rse.is_harness_task({"title": "Write memo"}) is False


def test_task_with_non_dict_source_not_matched_and_does_not_raise():
    task = {"title": "Write memo", "source": "not-a-dict"}
    assert rse.is_harness_task(task) is False


def test_external_id_without_trailing_hyphen_is_not_matched():
    # Negative pin on the trailing hyphen in the prefix: neither a bare
    # "mu-smoke" nor an unrelated "mu-smokeX" should match "mu-smoke-".
    assert rse.is_harness_task({"title": "x", "source": {"external_id": "mu-smoke"}}) is False
    assert rse.is_harness_task({"title": "x", "source": {"external_id": "mu-smokeX"}}) is False


# ---------------------------------------------------------------------------
# wipe_harness_d1: end-to-end against a mocked SchedulerClient transport.
# ---------------------------------------------------------------------------

TASKS = [
    {"id": "t-regsmoke", "title": "[regsmoke] Mandatory deliverable 1",
     "source": {"kind": "rest", "external_id": "regsmoke-L2-00"}},
    {"id": "t-regsmoke-generic", "title": "Gym",
     "source": {"kind": "mcp", "external_id": "regsmoke-L3-05"}},
    {"id": "t-mtgsmoke", "title": "[mtg-smoke] filler my-label",
     "source": {"kind": "mcp", "external_id": "mtg-smoke-filler-my-label"}},
    {"id": "t-mtgsmoke-meeting", "title": "[mtg-smoke] owned meeting my-label",
     "source": {"kind": "meeting", "external_id": "evt_abc123"}},
    {"id": "t-musmoke", "title": "iso task",
     "source": {"kind": "mcp", "external_id": "mu-smoke-a-0"}},
    {"id": "t-real", "title": "Write memo",
     "source": {"kind": "rest", "external_id": "user-1"}},
    # A poll-smoke leftover in the tasks table (unrealistic in practice — poll
    # rows live in the `polls` table, wiped separately by wipe_harness_polls
    # — but proves "[pollsmoke]" is deliberately NOT in HARNESS_TITLE_PREFIXES).
    {"id": "t-pollsmoke", "title": "[pollsmoke] leftover",
     "source": {"kind": "rest", "external_id": "user-2"}},
]
TEMPLATES = [
    {"id": "tpl-regsmoke", "title": "[regsmoke] Standup"},
    {"id": "tpl-musmoke", "title": "[mu-smoke] weekly sync"},
    {"id": "tpl-real", "title": "Gym"},
]


def _make_client(calls: list[tuple[str, str]]) -> "rse.SchedulerClient":
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append((request.method, path))
        if request.method == "GET" and path == "/v1/tasks":
            return httpx.Response(200, json={"tasks": TASKS})
        if request.method == "GET" and path == "/v1/templates":
            return httpx.Response(200, json={"templates": TEMPLATES})
        if request.method == "DELETE":
            return httpx.Response(200, json={})
        raise AssertionError(f"unexpected request: {request.method} {path}")

    sched = rse.SchedulerClient(rse.Identity(
        scheduler_url="https://scheduler-dev.example",
        bearer="b", refresh_token="r", expected_email="x@y",
    ))
    sched._client = httpx.Client(transport=httpx.MockTransport(handler))
    return sched


def test_wipe_harness_d1_deletes_exactly_the_harness_rows_in_order():
    calls: list[tuple[str, str]] = []
    sched = _make_client(calls)
    rse.wipe_harness_d1(sched, dry_run=False)

    delete_calls = [c for c in calls if c[0] == "DELETE"]
    assert delete_calls == [
        ("DELETE", "/v1/tasks/t-regsmoke"),
        ("DELETE", "/v1/tasks/t-regsmoke-generic"),
        ("DELETE", "/v1/tasks/t-mtgsmoke"),
        ("DELETE", "/v1/tasks/t-mtgsmoke-meeting"),
        ("DELETE", "/v1/tasks/t-musmoke"),
        ("DELETE", "/v1/templates/tpl-regsmoke"),
        ("DELETE", "/v1/templates/tpl-musmoke"),
    ]
    # Real, non-harness rows are never touched, nor is a [pollsmoke] row
    # (that family is wiped from the polls table by wipe_harness_polls, not
    # from tasks/templates).
    assert ("DELETE", "/v1/tasks/t-real") not in calls
    assert ("DELETE", "/v1/tasks/t-pollsmoke") not in calls
    assert ("DELETE", "/v1/templates/tpl-real") not in calls


def test_wipe_harness_d1_dry_run_deletes_nothing(capsys):
    calls: list[tuple[str, str]] = []
    sched = _make_client(calls)
    rse.wipe_harness_d1(sched, dry_run=True)

    assert all(c[0] == "GET" for c in calls)
    out = capsys.readouterr().out
    assert "5 task(s)" in out
    assert "2 template(s)" in out


# ---------------------------------------------------------------------------
# --provider default: an exported-but-empty SMOKE_PROVIDER must not bypass
# argparse's choices= validation via `default=os.environ.get(...)` reading
# "" instead of falling back to "google".
# ---------------------------------------------------------------------------

def test_provider_default_falls_back_to_google_when_smoke_provider_is_empty(monkeypatch):
    monkeypatch.setenv("SMOKE_PROVIDER", "")
    args = rse.build_parser().parse_args([])
    assert args.provider == "google"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
