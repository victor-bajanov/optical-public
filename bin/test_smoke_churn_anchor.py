# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "pydantic>=2.7", "rich>=13.7"]
# ///
"""Guard for L8's churn-anchor predicate (the "anchor" arrangement sub-leg).

Regression context: an internal issue / internal design notes. L8 already
builds the exact adversarial state for the churn-baseline selection bug — week A
committed first, week B committed second (globally latest), week A's plan then
hand-patched by the drag legs — but stopped without ever RESOLVING week A again.
The anchor sub-leg re-resolves week A and asserts every dragged chunk is
proposed at its dragged slot: proof that the baseline came from the resolved
week's (patched) plan, not the globally-latest one and not an empty baseline.
_churn_anchor_mismatches is the pure comparison that leg runs on the resolve
response; these tests pin its matching and reporting semantics.
"""
import importlib.util, pathlib, sys

_spec = importlib.util.spec_from_file_location(
    "regsmoke", pathlib.Path(__file__).parent / "regression-smoke.py"
)
assert _spec and _spec.loader, "could not load regression-smoke module"
regsmoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = regsmoke
_spec.loader.exec_module(regsmoke)

UUID_BASIC = "11111111-1111-4111-8111-111111111111"
UUID_FLOOR = "22222222-2222-4222-8222-222222222222"


def _entry(task_id: str, chunk_id: str, start: str) -> dict:
    return {"task_id": task_id, "chunk_id": chunk_id, "start": start}


def test_all_anchored_returns_no_mismatches():
    schedule = [
        _entry(UUID_BASIC, f"{UUID_BASIC}#0", "2026-09-08T04:00:00Z"),
        _entry(UUID_FLOOR, f"{UUID_FLOOR}#0", "2026-09-07T23:00:00Z"),
    ]
    want = {
        UUID_BASIC: ("basic", "2026-09-08T04:00:00Z"),
        UUID_FLOOR: ("x6floor", "2026-09-07T23:00:00Z"),
    }
    assert regsmoke._churn_anchor_mismatches(schedule, want) == []


def test_offset_and_z_forms_of_the_same_instant_match():
    # The worker renders plan starts in the home zone's offset form; the harness
    # computes drag targets as ISO-Z. Same instant must compare equal.
    schedule = [_entry(UUID_BASIC, f"{UUID_BASIC}#0", "2026-09-08T14:00:00+10:00")]
    want = {UUID_BASIC: ("basic", "2026-09-08T04:00:00Z")}
    assert regsmoke._churn_anchor_mismatches(schedule, want) == []


def test_moved_chunk_is_reported_with_leg_want_and_seen():
    # The discriminating failure: with no baseline (the #83 state), the solver
    # re-optimises and proposes the chunk back at its fit-optimal slot.
    schedule = [_entry(UUID_BASIC, f"{UUID_BASIC}#0", "2026-09-07T23:00:00Z")]
    want = {UUID_BASIC: ("basic", "2026-09-08T04:00:00Z")}
    msgs = regsmoke._churn_anchor_mismatches(schedule, want)
    assert len(msgs) == 1
    assert "basic" in msgs[0]
    assert "2026-09-08T04:00:00Z" in msgs[0]
    assert "2026-09-07T23:00:00Z" in msgs[0]


def test_task_absent_from_schedule_is_reported():
    # A dropped/unplaced task is a mismatch too, not a silent pass.
    want = {UUID_BASIC: ("basic", "2026-09-08T04:00:00Z")}
    msgs = regsmoke._churn_anchor_mismatches([], want)
    assert len(msgs) == 1
    assert "basic" in msgs[0]
    assert "absent" in msgs[0]


def test_unrelated_schedule_entries_are_ignored():
    # The week-A resolve may legitimately place other harness tasks; only the
    # tracked drag targets are asserted.
    schedule = [
        _entry("99999999-9999-4999-8999-999999999999", "x#0", "2026-09-09T00:00:00Z"),
        _entry(UUID_BASIC, f"{UUID_BASIC}#0", "2026-09-08T04:00:00Z"),
    ]
    want = {UUID_BASIC: ("basic", "2026-09-08T04:00:00Z")}
    assert regsmoke._churn_anchor_mismatches(schedule, want) == []


def test_multiple_mismatches_reported_one_per_task():
    schedule = [_entry(UUID_BASIC, f"{UUID_BASIC}#0", "2026-09-07T23:00:00Z")]
    want = {
        UUID_BASIC: ("basic", "2026-09-08T04:00:00Z"),
        UUID_FLOOR: ("x6floor", "2026-09-07T23:00:00Z"),
    }
    msgs = regsmoke._churn_anchor_mismatches(schedule, want)
    assert len(msgs) == 2


def test_drag_targets_sit_inside_the_deep_fit_peak():
    # The anchor assertion must sit on fit-flat ground so it tests baseline
    # SOURCING, not weight calibration: churn is a soft weight (dev/prod
    # instance default 10 per 15 min moved vs time_of_day_fit 5), so a chunk
    # dragged into off-peak territory is legitimately re-proposed toward the
    # peak — moving 11 quarters costs 110 churn and gains more fit (observed
    # live 2026-08-28: the 09:00 x6floor drag was re-proposed at 11:45 by a
    # correctly-anchored solver). Inside the deep peak (instance default
    # 12:00-16:00) every slot has equal fit, so holding the drag is strictly
    # cheaper than any move and the anchor assertion is deterministic.
    peak_start, peak_end = 12, 16  # instance-default deep fit_curve peak hours
    for leg, _ext, (hh, mm), _field in regsmoke._L8_DRAG_LEGS:
        drop_min = hh * 60 + mm
        assert peak_start * 60 <= drop_min, f"{leg} drop {hh}:{mm:02d} starts before the deep peak"
        assert drop_min + 60 <= peak_end * 60, f"{leg} drop {hh}:{mm:02d} ends after the deep peak"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
