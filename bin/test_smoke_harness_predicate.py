# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "pydantic>=2.7", "rich>=13.7"]
# ///
"""Guard for the smoke harness's task-ownership predicate.

Regression context: RC4 made `source` a materialiser-owned reserved key, so
recurrence-sweep occurrences carry source {kind:"cron", external_id:None} — the
old `regsmoke-` source tag no longer survives materialisation. The harness must
still recognise those occurrences as harness-owned, but by LINEAGE (their
template_id ∈ the harness's live templates), not by a title regex. Lineage
matching is precise: it cannot sweep up an unrelated user's task that merely
shares the "[regsmoke" title prefix, and it leaves true orphans (template
already deleted) for reset-smoke-env.py's title-based catch-all to mop up.
"""
import importlib.util, pathlib, sys

_spec = importlib.util.spec_from_file_location(
    "regsmoke", pathlib.Path(__file__).parent / "regression-smoke.py"
)
assert _spec and _spec.loader, "could not load regression-smoke module"
regsmoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = regsmoke
_spec.loader.exec_module(regsmoke)

TEMPLATE_ID = "10ae3074-e940-466b-9531-0296649d960d"


def test_posted_task_with_regsmoke_source_is_harness():
    # A task the harness POSTed directly keeps its regsmoke- source tag — matched
    # regardless of which templates are live.
    t = {"title": "[regsmoke] Mandatory deliverable 1",
         "source": {"kind": "rest", "external_id": "regsmoke-L2-00"}}
    assert regsmoke._task_is_harness(t, set()) is True


def test_materialised_occurrence_is_harness_by_template_id():
    # Recurrence-sweep occurrence: source is materialiser-owned (RC4), so the
    # regsmoke- source tag is GONE — recognised by its template_id lineage.
    t = {"title": "[regsmoke] Standup",
         "template_id": TEMPLATE_ID,
         "source": {"kind": "cron", "external_id": None}}
    assert regsmoke._task_is_harness(t, {TEMPLATE_ID}) is True


def test_orphan_occurrence_is_not_matched_by_loop():
    # Same occurrence but its template is no longer live (not in the set) → an
    # orphan. The per-level loop must NOT match it (matching it after the
    # template is gone is exactly the orphaning hazard the ordering prevents);
    # orphans are reset-smoke-env.py's responsibility, not the loop's.
    t = {"title": "[regsmoke] Standup",
         "template_id": TEMPLATE_ID,
         "source": {"kind": "cron", "external_id": None}}
    assert regsmoke._task_is_harness(t, set()) is False


def test_l6_posted_task_is_harness_by_source():
    # The L6 family is POSTed (source-tagged regsmoke-L6…), so it matches by
    # source even though L6 has no templates.
    t = {"title": "[regsmoke L6] done-api 0",
         "source": {"kind": "mcp", "external_id": "regsmoke-L6-done-api-0"}}
    assert regsmoke._task_is_harness(t, set()) is True


def test_unrelated_cron_task_is_not_harness():
    # A genuine non-harness cron task must NOT be swept up (no false positives,
    # which would make the harness delete a real user's task).
    t = {"title": "Daily backup", "source": {"kind": "cron", "external_id": None}}
    assert regsmoke._task_is_harness(t, set()) is False


def test_foreign_title_with_regsmoke_prefix_is_not_matched():
    # A task that merely SHARES the "[regsmoke" title prefix but is neither
    # source-tagged nor a live-template occurrence is NOT harness-owned. This is
    # the false-positive the old title regex risked and lineage matching avoids.
    t = {"title": "[regsmoke] impostor", "source": {"kind": "rest", "external_id": "user-task"}}
    assert regsmoke._task_is_harness(t, set()) is False


def _full_env(monkeypatch, url):
    for k, v in {
        "SCHEDULER_URL": url, "SCHEDULER_BEARER": "b", "SCHEDULER_REFRESH_TOKEN": "r",
        "D1_DATABASE_ID": regsmoke._smoke_lib.DEV_DB_ID, "EXPECTED_TEST_ACCOUNT": "x@y",
    }.items():
        monkeypatch.setenv(k, v)


def test_env_refuses_prod_scheduler_url(monkeypatch):
    # regression-smoke mutates tasks/calendar over the bearer API; the prod host
    # must be refused at startup like every other harness (assert_dev_url).
    _full_env(monkeypatch, "https://scheduler.example.com")
    import pytest
    with pytest.raises(SystemExit):
        regsmoke.Env.from_environ()


def test_env_accepts_dev_scheduler_url(monkeypatch):
    _full_env(monkeypatch, "https://scheduler-dev.example.com/")
    assert regsmoke.Env.from_environ().scheduler_url == "https://scheduler-dev.example.com"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
