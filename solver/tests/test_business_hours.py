"""Business-hours global placement constraint.

Business hours bounds *where* a task lands (if scheduled) but must NOT
make it mandatory: an overloaded week drops low-priority work instead of
returning unsat. A genuinely mandatory task (hard deadline) that cannot
fit inside business hours still returns unsat, surfacing a `business_hours`
core entry.
"""

from __future__ import annotations

from solver.schema import Problem
from solver.two_pass import solve

# 2026-05-18 is a Monday; window is one week.
_WINDOW = {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"}
_WEIGHTS = {
    "time_of_day_fit_per_15min": 0,
    "churn_per_15min_moved": 0,
    "priority_unit": 1,
    "base_drop_penalty": 200,
}
_CONTEXTS = [
    {
        "context": "deep",
        "fit_curve": {"peak_start": "09:00", "peak_end": "12:00", "falloff_end": "16:00"},
        "max_minutes_per_day": None,
        "max_contiguous_minutes": None,
        "over_daily_cap_penalty_per_15min": 0,
        "over_streak_cap_penalty_per_15min": 0,
    }
]


def _soft_task(tid: str, duration: int) -> dict:
    return {
        "id": tid,
        "title": tid,
        "context": "deep",
        "priority": 50,
        "chunks": [{"chunk_id": f"{tid}#0", "duration_minutes": duration}],
        "group_policy": {"same_day": False, "ordered": False},
        "deadline": None,
        "earliest_start": _WINDOW["start"],
        "preferred_windows": [],
        "dependencies": [],
        "pinned_at": None,
        "previous_placement": [],
    }


def test_business_hours_drops_overflow_instead_of_unsat():
    # Business hours: Monday only, 09:00-11:00 (120 min capacity). Two 90-min
    # soft tasks can't both fit without overlap, so one must drop. The task is
    # NOT mandatory, so the solver returns a solution with a drop — not unsat.
    problem = Problem.model_validate(
        {
            "window": _WINDOW,
            "weights": _WEIGHTS,
            "contexts": _CONTEXTS,
            "tasks": [_soft_task("a", 90), _soft_task("b", 90)],
            "external_pinned": [],
            "business_hours": {"days": ["mon"], "start": "09:00", "end": "11:00"},
        }
    )
    result = solve(problem)
    assert result.unsat_core is None, "business hours must not force unsat"
    assert result.solution is not None
    assert len(result.solution.dropped) == 1
    assert len(result.solution.schedule) == 1
    # The surviving chunk lands inside Monday 09:00-11:00.
    chunk = result.solution.schedule[0]
    assert chunk.start.weekday() == 0  # Monday
    start_min = chunk.start.hour * 60 + chunk.start.minute
    assert start_min >= 9 * 60
    assert start_min + 90 <= 11 * 60


def test_business_hours_constrains_task_with_soft_window():
    # A soft window no longer exempts a task from the floor. BH is Monday only;
    # the task's soft window is Tuesday. The task must land inside business
    # hours (Monday), NOT on its soft Tuesday window.
    task = _soft_task("soft", 60)
    task["preferred_windows"] = [
        {"days": ["tue"], "start": "13:00", "end": "15:00", "hard": False}
    ]
    problem = Problem.model_validate(
        {
            "window": _WINDOW,
            "weights": _WEIGHTS,
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [],
            "business_hours": {"days": ["mon"], "start": "09:00", "end": "17:00"},
        }
    )
    result = solve(problem)
    assert result.unsat_core is None
    assert result.solution is not None
    assert len(result.solution.dropped) == 0
    assert len(result.solution.schedule) == 1
    chunk = result.solution.schedule[0]
    assert chunk.start.weekday() == 0, "soft-window task must land Monday (in BH)"
    start_min = chunk.start.hour * 60 + chunk.start.minute
    assert start_min >= 9 * 60
    assert start_min + 60 <= 17 * 60


def test_business_hours_exempts_task_with_hard_window():
    # A HARD window still exempts: BH is Monday, but the task's hard window is
    # Tuesday — it lands Tuesday, outside business hours.
    task = _soft_task("hard", 60)
    task["preferred_windows"] = [
        {"days": ["tue"], "start": "13:00", "end": "15:00", "hard": True}
    ]
    problem = Problem.model_validate(
        {
            "window": _WINDOW,
            "weights": _WEIGHTS,
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [],
            "business_hours": {"days": ["mon"], "start": "09:00", "end": "17:00"},
        }
    )
    result = solve(problem)
    assert result.unsat_core is None
    assert result.solution is not None
    assert len(result.solution.dropped) == 0
    assert len(result.solution.schedule) == 1
    assert result.solution.schedule[0].start.weekday() == 1  # Tuesday


def test_hard_deadline_unfittable_in_business_hours_drops():
    # Hard deadline (Tuesday) but business hours only allow Wed-Fri, so the task
    # has no legal slot before its deadline. Hardness does not make it mandatory
    # (orthogonality), so it is DROPPED rather than poisoning the solve into
    # UNSAT.
    task = _soft_task("deadline", 60)
    task["deadline"] = {"at": "2026-05-19T17:00:00", "hard": True, "penalty_per_15min": 0}
    problem = Problem.model_validate(
        {
            "window": _WINDOW,
            "weights": _WEIGHTS,
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [],
            "business_hours": {"days": ["wed", "thu", "fri"], "start": "09:00", "end": "17:00"},
        }
    )
    result = solve(problem)
    assert result.solution is not None, f"expected SAT, got unsat_core={result.unsat_core}"
    assert "deadline" in {d.task_id for d in result.solution.dropped}
