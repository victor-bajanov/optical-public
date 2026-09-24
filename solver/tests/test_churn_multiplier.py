"""churn_multiplier: per-task scaling of the churn coefficient."""
from __future__ import annotations

from solver.schema import Problem
from solver.two_pass import solve


def _movable_meeting(multiplier: int, prev_start: str) -> dict:
    """A meeting whose current slot (prev_start) is feasible, plus a BETTER
    (lower-fit-cost) slot it could move to. Higher churn_multiplier should make
    it stick at prev_start; multiplier 1 lets it move."""
    return {
        "id": "m1",
        "title": "Meeting",
        "context": "meeting",
        "priority": 100,
        "chunks": [{"chunk_id": "m1#0", "duration_minutes": 30}],
        "group_policy": {"same_day": False, "ordered": False},
        "deadline": None,
        "earliest_start": "2026-05-18T00:00:00",
        "preferred_windows": [],
        "dependencies": [],
        "pinned_at": None,
        # Two allowed slots: the current one (09:00) and an alternative (10:00).
        "availability_windows": [
            {"start": "2026-05-19T09:00:00", "end": "2026-05-19T09:30:00"},
            {"start": "2026-05-19T10:00:00", "end": "2026-05-19T10:30:00"},
        ],
        "previous_placement": [{"chunk_id": "m1#0", "start": prev_start}],
        "must_include": True,
        "churn_multiplier": multiplier,
    }


def _problem(task: dict, fit_peak_at_10: bool) -> Problem:
    # A meeting fit curve peaking at 10:00 makes 10:00 cheaper than 09:00 by
    # `fit_weight` per 15min — so the solver moves UNLESS churn outweighs it.
    return Problem.model_validate(
        {
            "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
            "weights": {
                "time_of_day_fit_per_15min": 5,
                "churn_per_15min_moved": 1,
                "priority_unit": 1,
                "base_drop_penalty": 200,
            },
            "contexts": [
                {
                    "context": "meeting",
                    "fit_curve": {"peak_start": "10:00", "peak_end": "10:30", "falloff_end": "18:00"},
                    "max_minutes_per_day": None,
                    "max_contiguous_minutes": None,
                    "over_daily_cap_penalty_per_15min": 0,
                    "over_streak_cap_penalty_per_15min": 0,
                }
            ],
            "tasks": [task],
            "external_pinned": [],
        }
    )


def _placed_start(task: dict) -> str:
    sol = solve(_problem(task, fit_peak_at_10=True))
    return [c for c in sol.solution.schedule if c.task_id == "m1"][0].start.isoformat()


def test_low_multiplier_allows_move_to_better_slot():
    start = _placed_start(_movable_meeting(multiplier=1, prev_start="2026-05-19T09:00:00"))
    assert start == "2026-05-19T10:00:00"  # fit gain (5 units over 2 slots) beats churn (4 units)


def test_high_multiplier_keeps_meeting_put():
    # multiplier=50 makes the move cost dwarf any fit gain → stays at 09:00.
    start = _placed_start(_movable_meeting(multiplier=50, prev_start="2026-05-19T09:00:00"))
    assert start == "2026-05-19T09:00:00"
