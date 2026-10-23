# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "pydantic>=2.7", "rich>=13.7"]
# ///
"""Guard for the regression-smoke webhook leg's render_snapshot check (O9.6).

GET /v1/plans/latest now returns a REDACTED render_snapshot: every timeline
entry carries an `origin`, entries not from the user's own tasks/events read
"Busy", and a webhook trigger whose invite the user doesn't organise reads
"Busy". _assert_render_snapshot_model asserts those shape invariants on the live
response; these tests pin them.
"""
import importlib.util, pathlib, sys

import pytest

_spec = importlib.util.spec_from_file_location(
    "regsmoke", pathlib.Path(__file__).parent / "regression-smoke.py"
)
assert _spec and _spec.loader, "could not load regression-smoke module"
regsmoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = regsmoke
_spec.loader.exec_module(regsmoke)


def _snapshot(*, entries=None, trigger=None) -> dict:
    return {
        "trigger": trigger or {"kind": "webhook", "inviteTitle": "[regression-smoke webhook] conflict", "inviteOrganizedBySelf": True},
        "days": [{
            "date": "2026-10-12",
            "before": entries if entries is not None else [
                {"title": "[regsmoke-webhook] task 0", "role": "moved-from", "origin": "task"},
                {"title": "[regression-smoke webhook] conflict", "role": "new-clash", "origin": "own_event"},
                {"title": "Busy", "role": "existing", "origin": "others_event"},
            ],
            "after": [],
        }],
    }


def test_redacted_snapshot_passes():
    regsmoke._assert_render_snapshot_model(_snapshot())


def test_unredacted_foreign_title_fails():
    entries = [
        {"title": "[regsmoke-webhook] task 0", "role": "moved-from", "origin": "task"},
        {"title": "Someone's invite", "role": "existing", "origin": "others_event"},
    ]
    with pytest.raises(AssertionError, match="Busy"):
        regsmoke._assert_render_snapshot_model(_snapshot(entries=entries))


def test_entry_without_origin_fails():
    entries = [{"title": "[regsmoke-webhook] task 0", "role": "moved-from"}]
    with pytest.raises(AssertionError, match="origin"):
        regsmoke._assert_render_snapshot_model(_snapshot(entries=entries))


def test_foreign_trigger_title_must_be_busy():
    leak = {"kind": "webhook", "inviteTitle": "Someone's invite", "inviteOrganizedBySelf": False}
    with pytest.raises(AssertionError, match="inviteTitle"):
        regsmoke._assert_render_snapshot_model(_snapshot(trigger=leak))
    ok = {"kind": "webhook", "inviteTitle": "Busy", "inviteOrganizedBySelf": False}
    regsmoke._assert_render_snapshot_model(_snapshot(trigger=ok))


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
