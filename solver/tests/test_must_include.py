"""must_include: orthogonal mandatory-inclusion flag."""
from __future__ import annotations

from solver.schema import Task


def _task(**over) -> dict:
    base = {
        "id": "t1",
        "title": "T",
        "context": "deep",
        "priority": 75,
        "chunks": [{"chunk_id": "t1#0", "duration_minutes": 60}],
        "group_policy": {"same_day": False, "ordered": False},
        "earliest_start": "2026-05-18T00:00:00",
        "preferred_windows": [],
        "dependencies": [],
        "previous_placement": [],
    }
    base.update(over)
    return base


def test_must_include_defaults_false():
    t = Task.model_validate(_task())
    assert t.must_include is False


def test_must_include_accepts_true():
    t = Task.model_validate(_task(must_include=True))
    assert t.must_include is True


from solver.schema import Problem
from solver.two_pass import solve


def _two_pinned_problem(must_include: bool) -> Problem:
    """Two 60-min tasks pinned to the SAME slot. Each fits alone; together they
    violate NoOverlap. With must_include both forced present → UNSAT; without,
    one drops → SAT."""
    def pin(i: str) -> dict:
        return {
            "id": i,
            "title": f"Pinned {i}",
            "context": "meeting",
            "priority": 90,
            "chunks": [{"chunk_id": f"{i}#0", "duration_minutes": 60}],
            "group_policy": {"same_day": False, "ordered": False},
            "deadline": None,
            "earliest_start": "2026-05-18T00:00:00",
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": "2026-05-19T11:00:00",
            "previous_placement": [],
            "must_include": must_include,
        }
    return Problem.model_validate({
        "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
        "weights": {"time_of_day_fit_per_15min": 0, "churn_per_15min_moved": 0, "priority_unit": 1, "base_drop_penalty": 200},
        "contexts": [{
            "context": "meeting",
            "fit_curve": {"peak_start": "10:00", "peak_end": "11:00", "falloff_end": "17:00"},
            "max_minutes_per_day": None, "max_contiguous_minutes": None,
            "over_daily_cap_penalty_per_15min": 0, "over_streak_cap_penalty_per_15min": 0,
        }],
        "tasks": [pin("pin-a"), pin("pin-b")],
        "external_pinned": [],
        "business_hours": None,
    })


def test_droppable_pins_collide_then_one_drops_sat():
    # Baseline: must_include=False → contention drops one, SAT (today's behavior).
    res = solve(_two_pinned_problem(must_include=False))
    assert res.unsat_core is None, f"expected SAT, got core={res.unsat_core}"
    assert len(res.solution.dropped) == 1


from solver.model import ASSUMPTION_TASK_PRESENT


def test_must_include_pins_collide_unsat_with_present_in_core():
    # must_include=True on both → both forced present → genuine UNSAT.
    res = solve(_two_pinned_problem(must_include=True))
    assert res.solution is None
    assert res.unsat_core is not None
    present = [it for it in res.unsat_core if it.type == ASSUMPTION_TASK_PRESENT]
    assert present, f"expected a task_present entry in core, got {res.unsat_core}"


def test_must_include_kept_when_soft_task_would_drop():
    # A narrow window fits exactly ONE 60-min task. The must-include task must be
    # kept and the higher-priority soft task dropped instead.
    def task(i: str, must: bool, prio: int) -> dict:
        return {
            "id": i, "title": i, "context": "meeting", "priority": prio,
            "chunks": [{"chunk_id": f"{i}#0", "duration_minutes": 60}],
            "group_policy": {"same_day": False, "ordered": False}, "deadline": None,
            "earliest_start": "2026-05-18T10:00:00",
            "preferred_windows": [{"days": ["mon"], "start": "10:00", "end": "11:00", "hard": True}],
            "dependencies": [], "pinned_at": None, "previous_placement": [], "must_include": must,
        }
    problem = Problem.model_validate({
        "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
        "weights": {"time_of_day_fit_per_15min": 0, "churn_per_15min_moved": 0, "priority_unit": 1, "base_drop_penalty": 200},
        "contexts": [{
            "context": "meeting",
            "fit_curve": {"peak_start": "10:00", "peak_end": "11:00", "falloff_end": "17:00"},
            "max_minutes_per_day": None, "max_contiguous_minutes": None,
            "over_daily_cap_penalty_per_15min": 0, "over_streak_cap_penalty_per_15min": 0,
        }],
        # soft task has HIGHER priority but is droppable; must task is mandatory.
        "tasks": [task("soft", must=False, prio=99), task("must", must=True, prio=10)],
        "external_pinned": [], "business_hours": None,
    })
    res = solve(problem)
    assert res.unsat_core is None, f"expected SAT, got core={res.unsat_core}"
    dropped_ids = {d.task_id for d in res.solution.dropped}
    assert "must" not in dropped_ids
    assert "soft" in dropped_ids


def test_must_include_unplaceable_in_isolation_is_demoted_not_unsat():
    # A must-include task pinned 11:00-12:00 onto an IMMOVABLE external event at
    # the same time: impossible even alone → demoted to droppable → SAT, reported
    # dropped with the isolation reason. The week does NOT melt down.
    problem = Problem.model_validate({
        "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
        "weights": {"time_of_day_fit_per_15min": 0, "churn_per_15min_moved": 0, "priority_unit": 1, "base_drop_penalty": 200},
        "contexts": [{
            "context": "meeting",
            "fit_curve": {"peak_start": "10:00", "peak_end": "11:00", "falloff_end": "17:00"},
            "max_minutes_per_day": None, "max_contiguous_minutes": None,
            "over_daily_cap_penalty_per_15min": 0, "over_streak_cap_penalty_per_15min": 0,
        }],
        "tasks": [{
            "id": "must-on-ext", "title": "Pinned onto a meeting", "context": "meeting", "priority": 90,
            "chunks": [{"chunk_id": "must-on-ext#0", "duration_minutes": 60}],
            "group_policy": {"same_day": False, "ordered": False}, "deadline": None,
            "earliest_start": "2026-05-18T00:00:00", "preferred_windows": [], "dependencies": [],
            "pinned_at": "2026-05-19T11:00:00", "previous_placement": [], "must_include": True,
        }],
        "external_pinned": [
            {"id": "ext-1", "title": "Immovable", "start": "2026-05-19T11:00:00", "duration_minutes": 60, "context": "meeting"},
        ],
        "business_hours": None,
    })
    res = solve(problem)
    assert res.unsat_core is None, f"expected SAT after demotion, got core={res.unsat_core}"
    dropped = {d.task_id: d for d in res.solution.dropped}
    assert "must-on-ext" in dropped
    assert dropped["must-on-ext"].reason == "must_include_unplaceable_in_isolation"


import pytest


@pytest.mark.parametrize("must_include,expect_unsat", [(False, False), (True, True)])
def test_hard_window_inclusion_orthogonal(must_include, expect_unsat):
    # Two tasks each with a HARD preferred window that only fits one of them in
    # the single shared hour. Hard window governs WHERE; must_include governs
    # WHETHER. must_include=False → one drops (SAT); True → 422.
    def t(i: str) -> dict:
        return {
            "id": i, "title": i, "context": "meeting", "priority": 50,
            "chunks": [{"chunk_id": f"{i}#0", "duration_minutes": 60}],
            "group_policy": {"same_day": False, "ordered": False}, "deadline": None,
            "earliest_start": "2026-05-18T00:00:00",
            "preferred_windows": [{"days": ["mon"], "start": "10:00", "end": "11:00", "hard": True}],
            "dependencies": [], "pinned_at": None, "previous_placement": [], "must_include": must_include,
        }
    problem = Problem.model_validate({
        "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
        "weights": {"time_of_day_fit_per_15min": 0, "churn_per_15min_moved": 0, "priority_unit": 1, "base_drop_penalty": 200},
        "contexts": [{
            "context": "meeting",
            "fit_curve": {"peak_start": "10:00", "peak_end": "11:00", "falloff_end": "17:00"},
            "max_minutes_per_day": None, "max_contiguous_minutes": None,
            "over_daily_cap_penalty_per_15min": 0, "over_streak_cap_penalty_per_15min": 0,
        }],
        "tasks": [t("w1"), t("w2")],
        "external_pinned": [], "business_hours": None,
    })
    res = solve(problem)
    if expect_unsat:
        assert res.solution is None and res.unsat_core
    else:
        assert res.unsat_core is None and len(res.solution.dropped) == 1
