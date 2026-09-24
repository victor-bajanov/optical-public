"""availability_windows + churn_multiplier: additive Task fields."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from solver.schema import Task


def _task(**over) -> dict:
    base = {
        "id": "t1",
        "title": "T",
        "context": "meeting",
        "priority": 100,
        "chunks": [{"chunk_id": "t1#0", "duration_minutes": 60}],
        "group_policy": {"same_day": False, "ordered": False},
        "earliest_start": "2026-05-18T00:00:00",
        "preferred_windows": [],
        "dependencies": [],
        "previous_placement": [],
    }
    base.update(over)
    return base


def test_availability_windows_default_empty():
    t = Task.model_validate(_task())
    assert t.availability_windows == []


def test_churn_multiplier_default_one():
    t = Task.model_validate(_task())
    assert t.churn_multiplier == 1


def test_availability_windows_parsed():
    t = Task.model_validate(
        _task(
            availability_windows=[
                {"start": "2026-05-19T09:00:00", "end": "2026-05-19T12:00:00"}
            ]
        )
    )
    assert len(t.availability_windows) == 1
    assert t.availability_windows[0].start.hour == 9


def test_churn_multiplier_rejects_zero():
    with pytest.raises(ValidationError):
        Task.model_validate(_task(churn_multiplier=0))


from solver.schema import Problem
from solver.two_pass import solve


def _problem(task_over: dict) -> Problem:
    task = {
        "id": "m1",
        "title": "Standup",
        "context": "meeting",
        "priority": 100,
        "chunks": [{"chunk_id": "m1#0", "duration_minutes": 30}],
        "group_policy": {"same_day": False, "ordered": False},
        "deadline": None,
        "earliest_start": "2026-05-18T00:00:00",
        "preferred_windows": [],
        "dependencies": [],
        "pinned_at": None,
        "previous_placement": [],
        "must_include": True,
    }
    task.update(task_over)
    return Problem.model_validate(
        {
            "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
            "weights": {
                "time_of_day_fit_per_15min": 0,
                "churn_per_15min_moved": 0,
                "priority_unit": 1,
                "base_drop_penalty": 200,
            },
            "contexts": [],
            "tasks": [task],
            "external_pinned": [],
        }
    )


def test_meeting_confined_to_availability_window():
    # Only Tue 2026-05-19 10:00-10:30 is allowed → the meeting must land there.
    p = _problem(
        {
            "availability_windows": [
                {"start": "2026-05-19T10:00:00", "end": "2026-05-19T10:30:00"}
            ]
        }
    )
    sol = solve(p)
    placed = [c for c in sol.solution.schedule if c.task_id == "m1"]
    assert len(placed) == 1
    assert placed[0].start.isoformat() == "2026-05-19T10:00:00"


def test_meeting_outside_window_cannot_be_placed_there():
    # Allowed window is Tue 10:00-10:30; a 30-min chunk cannot start at 10:15
    # (would end 10:45, outside the window). Only 10:00 fits.
    p = _problem(
        {
            "availability_windows": [
                {"start": "2026-05-19T10:00:00", "end": "2026-05-19T10:30:00"}
            ]
        }
    )
    sol = solve(p)
    placed = [c for c in sol.solution.schedule if c.task_id == "m1"]
    assert placed[0].start.isoformat() == "2026-05-19T10:00:00"


def test_empty_availability_windows_is_unconstrained():
    # No mask → the meeting may be placed anywhere feasible (just not dropped).
    p = _problem({"availability_windows": []})
    sol = solve(p)
    assert any(c.task_id == "m1" for c in sol.solution.schedule)
