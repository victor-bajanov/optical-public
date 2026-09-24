"""Schema tests."""

from __future__ import annotations

from datetime import datetime

import pytest
from pydantic import ValidationError

from solver.schema import Problem, Task


def test_minimal_problem_parses(load_fixture):
    data = load_fixture("single_task.json")
    problem = Problem.model_validate(data)
    assert problem.window.start == datetime(2026, 5, 18, 0, 0)
    assert problem.window.end == datetime(2026, 5, 25, 0, 0)
    assert len(problem.tasks) == 1
    assert problem.tasks[0].id == "task-1"
    assert len(problem.tasks[0].chunks) == 1
    assert problem.tasks[0].chunks[0].duration_minutes == 60


def test_task_with_no_chunks_is_rejected():
    with pytest.raises(ValidationError):
        Task.model_validate(
            {
                "id": "x",
                "title": "x",
                "context": "deep",
                "priority": 50,
                "chunks": [],
                "earliest_start": "2026-05-18T00:00:00",
            }
        )


def test_chunk_duration_must_be_multiple_of_15():
    with pytest.raises(ValidationError):
        Task.model_validate(
            {
                "id": "x",
                "title": "x",
                "context": "deep",
                "priority": 50,
                "chunks": [{"chunk_id": "x#0", "duration_minutes": 17}],
                "earliest_start": "2026-05-18T00:00:00",
            }
        )


def test_window_must_align_to_15_minute_slots():
    with pytest.raises(ValidationError):
        Problem.model_validate(
            {
                "window": {
                    "start": "2026-05-18T00:07:00",
                    "end": "2026-05-25T00:00:00",
                    "tz": "UTC",
                },
                "weights": {
                    "time_of_day_fit_per_15min": 5,
                    "churn_per_15min_moved": 10,
                    "priority_unit": 1,
                    "base_drop_penalty": 200,
                },
                "contexts": [],
                "tasks": [],
                "external_pinned": [],
            }
        )


def test_weights_default_new_preference_fields_to_zero():
    from solver.schema import Weights

    w = Weights(
        time_of_day_fit_per_15min=5,
        churn_per_15min_moved=10,
        priority_unit=1,
        base_drop_penalty=200,
    )
    assert w.preferred_day_miss == 0
    assert w.preferred_time_miss_per_15min == 0


def test_objective_components_has_preferred_window():
    from solver.schema import ObjectiveComponents

    c = ObjectiveComponents(
        lateness=0, fit=0, churn=0, daily_cap=0, streak_cap=0, drop=0,
        preferred_window=0,
    )
    assert c.preferred_window == 0
