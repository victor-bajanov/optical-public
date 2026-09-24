"""Hardness and droppability are orthogonal dimensions.

A ``hard`` preferred window means "IF this task is scheduled, it must land inside
the window" — it must NOT make the task undroppable. Before the fix, any hard
preferred window forced ``task_dropped == 0`` (gated only on a feasible band in
ISOLATION), so a window that fit in isolation but was over-subscribed by
external events poisoned the whole solve with UNSAT. After the fix, such a task
is simply dropped (by the priority-weighted drop penalty) and the rest of the
week still schedules.

Replays the production "Lunch" incident (2026-06-04): a 30-min lunch with a
hard Thu 11:30-13:00 window whose only free gap (12:15-12:30) is 15 min, while
two unrelated tasks have ample room — the week must solve, dropping only lunch.
"""

from __future__ import annotations

from solver.schema import Problem
from solver.two_pass import solve

# 2026-06-01 Mon, 02 Tue, 03 Wed, 04 Thu, 05 Fri.
WINDOW = {"start": "2026-06-01T00:00:00", "end": "2026-06-08T00:00:00", "tz": "UTC"}
WEIGHTS = {
    "time_of_day_fit_per_15min": 0,
    "churn_per_15min_moved": 0,
    "priority_unit": 1,
    "base_drop_penalty": 200,
}
CONTEXTS = [
    {
        "context": "deep",
        "fit_curve": {"peak_start": "00:00", "peak_end": "23:45", "falloff_end": "23:45"},
        "max_minutes_per_day": None,
        "max_contiguous_minutes": None,
        "over_daily_cap_penalty_per_15min": 0,
        "over_streak_cap_penalty_per_15min": 0,
    },
    {
        "context": "meeting",
        "fit_curve": {"peak_start": "00:00", "peak_end": "23:45", "falloff_end": "23:45"},
        "max_minutes_per_day": None,
        "max_contiguous_minutes": None,
        "over_daily_cap_penalty_per_15min": 0,
        "over_streak_cap_penalty_per_15min": 0,
    },
]


def _task(tid: str, duration: int, *, priority: int, windows: list[dict]) -> dict:
    return {
        "id": tid,
        "title": tid,
        "context": "deep",
        "priority": priority,
        "chunks": [{"chunk_id": f"{tid}#0", "duration_minutes": duration}],
        "group_policy": {"same_day": False, "ordered": False},
        "deadline": None,
        "earliest_start": WINDOW["start"],
        "preferred_windows": windows,
        "dependencies": [],
        "pinned_at": None,
        "previous_placement": [],
    }


def _dropped_ids(result) -> set[str]:
    assert result.solution is not None, f"expected SAT, got unsat_core={result.unsat_core}"
    return {d.task_id for d in result.solution.dropped}


def test_contended_hard_window_drops_instead_of_unsat():
    lunch = _task(
        "lunch", 30, priority=70,
        windows=[{"days": ["thu"], "start": "11:30", "end": "13:00", "hard": True}],
    )
    work = _task("work", 30, priority=70, windows=[])
    # Fill the hard window so only a 15-min gap (12:15-12:30) remains for a 30-min task.
    blockers = [
        {"id": "m1", "title": "1:1", "start": "2026-06-04T11:30:00", "duration_minutes": 45, "context": "meeting"},
        {"id": "m2", "title": "Initech hold", "start": "2026-06-04T12:30:00", "duration_minutes": 30, "context": "meeting"},
    ]
    problem = Problem.model_validate(
        {
            "window": WINDOW,
            "weights": WEIGHTS,
            "contexts": CONTEXTS,
            "tasks": [lunch, work],
            "external_pinned": blockers,
        }
    )
    result = solve(problem)
    dropped = _dropped_ids(result)
    assert "lunch" in dropped, "the unplaceable hard-window task must drop"
    assert "work" not in dropped, "the placeable task must still be scheduled"
