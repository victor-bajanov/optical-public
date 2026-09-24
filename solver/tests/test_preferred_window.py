"""Distance-graded soft preferred-window preference (pass-2 objective term).

A soft window biases placement toward its days/hours but never causes a drop.
Two tunable weights (preferred_day_miss, preferred_time_miss_per_15min) set the
day-vs-hour trade-off.
"""

from __future__ import annotations

from solver.schema import Problem
from solver.two_pass import solve

# 2026-05-18 Mon, 19 Tue, 20 Wed, 21 Thu, 22 Fri.
_CONTEXTS = [
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


def _weights(day_miss: int, time_miss: int) -> dict:
    return {
        "time_of_day_fit_per_15min": 0,
        "churn_per_15min_moved": 0,
        "priority_unit": 1,
        "base_drop_penalty": 200,
        "preferred_day_miss": day_miss,
        "preferred_time_miss_per_15min": time_miss,
    }


def _task(tid: str, duration: int, windows: list[dict], start: str) -> dict:
    return {
        "id": tid,
        "title": tid,
        "context": "deep",
        "priority": 50,
        "chunks": [{"chunk_id": f"{tid}#0", "duration_minutes": duration}],
        "group_policy": {"same_day": False, "ordered": False},
        "deadline": None,
        "earliest_start": start,
        "preferred_windows": windows,
        "dependencies": [],
        "pinned_at": None,
        "previous_placement": [],
    }


def test_soft_window_pulls_chunk_into_window():
    window = {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"}
    task = _task("a", 60, [{"days": ["thu"], "start": "09:00", "end": "12:00", "hard": False}], window["start"])
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(40, 5),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [],
        }
    )
    result = solve(problem)
    assert result.solution is not None
    chunk = result.solution.schedule[0]
    assert chunk.start.weekday() == 3  # Thursday
    tod = chunk.start.hour * 60 + chunk.start.minute
    assert 9 * 60 <= tod and tod + 60 <= 12 * 60


def test_day_weight_keeps_chunk_on_preferred_day():
    window = {"start": "2026-05-20T00:00:00", "end": "2026-05-22T00:00:00", "tz": "UTC"}
    task = _task("a", 60, [{"days": ["thu"], "start": "09:00", "end": "10:00", "hard": False}], window["start"])
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(40, 5),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [
                {"id": "block", "title": "meeting", "start": "2026-05-21T09:00:00", "duration_minutes": 60, "context": "meeting"}
            ],
        }
    )
    result = solve(problem)
    assert result.solution is not None
    assert result.solution.schedule[0].start.weekday() == 3  # Thursday (right day)


def test_time_weight_moves_chunk_to_right_hour_wrong_day():
    window = {"start": "2026-05-20T00:00:00", "end": "2026-05-22T00:00:00", "tz": "UTC"}
    task = _task("a", 60, [{"days": ["thu"], "start": "09:00", "end": "10:00", "hard": False}], window["start"])
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(1, 100),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [
                {"id": "block", "title": "meeting", "start": "2026-05-21T09:00:00", "duration_minutes": 60, "context": "meeting"}
            ],
        }
    )
    result = solve(problem)
    assert result.solution is not None
    chunk = result.solution.schedule[0]
    assert chunk.start.weekday() == 2  # Wednesday
    assert chunk.start.hour * 60 + chunk.start.minute == 9 * 60  # 09:00 (right hour)


def test_soft_window_never_causes_drop():
    window = {"start": "2026-05-18T00:00:00", "end": "2026-05-20T00:00:00", "tz": "UTC"}
    task = _task("a", 60, [{"days": ["sat"], "start": "09:00", "end": "12:00", "hard": False}], window["start"])
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(40, 5),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [],
        }
    )
    result = solve(problem)
    assert result.solution is not None
    assert len(result.solution.dropped) == 0
    assert len(result.solution.schedule) == 1


def test_zero_weights_means_no_preferred_window_cost():
    window = {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"}
    task = _task("a", 60, [{"days": ["thu"], "start": "09:00", "end": "12:00", "hard": False}], window["start"])
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(0, 0),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [],
        }
    )
    result = solve(problem)
    assert result.solution is not None
    assert result.solution.objective.components.preferred_window == 0


def test_min_over_multiple_soft_windows_picks_reachable_window():
    # Two soft windows: Mon 09:00-10:00 (blocked by a meeting) and Wed
    # 14:00-15:00 (free). The min-over-windows penalty must let the chunk land
    # in the free Wednesday window at zero cost, rather than being pulled toward
    # the blocked Monday window.
    window = {"start": "2026-05-18T00:00:00", "end": "2026-05-23T00:00:00", "tz": "UTC"}
    task = _task(
        "a", 60,
        [
            {"days": ["mon"], "start": "09:00", "end": "10:00", "hard": False},
            {"days": ["wed"], "start": "14:00", "end": "15:00", "hard": False},
        ],
        window["start"],
    )
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(40, 5),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": [
                {"id": "block", "title": "meeting", "start": "2026-05-18T09:00:00", "duration_minutes": 60, "context": "meeting"}
            ],
        }
    )
    result = solve(problem)
    assert result.solution is not None
    chunk = result.solution.schedule[0]
    assert chunk.start.weekday() == 2  # Wednesday
    assert chunk.start.hour * 60 + chunk.start.minute == 14 * 60  # 14:00


def test_bug_replay_investor_pitch_stays_in_business_hours():
    # Deep 90-min task, soft window thu/fri 09:00-12:00, both preferred mornings
    # fully blocked. With business hours mon-fri 09:00-17:00 the task must land
    # inside business hours (any weekday) or drop — never at midnight.
    window = {"start": "2026-06-01T00:00:00", "end": "2026-06-08T00:00:00", "tz": "UTC"}
    # 2026-06-01 is a Monday; Thu = 2026-06-04, Fri = 2026-06-05.
    task = _task(
        "pitch", 90,
        [{"days": ["thu", "fri"], "start": "09:00", "end": "12:00", "hard": False}],
        window["start"],
    )
    task["priority"] = 78
    blockers = [
        {"id": "thu1", "title": "onsite", "start": "2026-06-04T09:00:00", "duration_minutes": 180, "context": "meeting"},
        {"id": "fri1", "title": "sprint", "start": "2026-06-05T09:00:00", "duration_minutes": 180, "context": "meeting"},
    ]
    problem = Problem.model_validate(
        {
            "window": window,
            "weights": _weights(40, 5),
            "contexts": _CONTEXTS,
            "tasks": [task],
            "external_pinned": blockers,
            "business_hours": {"days": ["mon", "tue", "wed", "thu", "fri"], "start": "09:00", "end": "17:00"},
        }
    )
    result = solve(problem)
    assert result.solution is not None
    if result.solution.schedule:
        chunk = result.solution.schedule[0]
        assert chunk.start.weekday() < 5, "must be a weekday (in BH)"
        tod = chunk.start.hour * 60 + chunk.start.minute
        assert tod >= 9 * 60, "never before 09:00"
        assert tod + 90 <= 17 * 60, "never past 17:00 — and never midnight"
    else:
        assert len(result.solution.dropped) == 1  # dropped is the acceptable alternative
