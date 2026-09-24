"""Soft objective tests: drop penalty, lateness, fit, churn."""

from __future__ import annotations

from datetime import datetime

from ortools.sat.python import cp_model

from solver.model import build_model
from solver.objective import attach_full_objective, drop_penalty_terms
from solver.schema import Problem


def _solve(model: cp_model.CpModel) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    solver.Solve(model)
    return solver


def test_drop_penalty_scheduled_when_room_exists(load_fixture):
    problem = Problem.model_validate(load_fixture("single_task.json"))
    art = build_model(problem)
    terms = drop_penalty_terms(art)
    art.model.Minimize(sum(v * w for v, w in terms))
    solver = _solve(art.model)
    # one task, lots of room → must be scheduled (dropped = 0)
    assert solver.Value(art.task_dropped["task-1"]) == 0


def test_drop_when_pinned_blocks_all_space():
    # 1-day window; one hard pinned event 09:00-23:45; one soft task 60min.
    # No room → soft task should be dropped.
    problem = Problem.model_validate(
        {
            "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-19T00:00:00", "tz": "UTC"},
            "weights": {
                "time_of_day_fit_per_15min": 0,
                "churn_per_15min_moved": 0,
                "priority_unit": 1,
                "base_drop_penalty": 200,
            },
            "contexts": [
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
            ],
            "tasks": [
                {
                    "id": "blocker",
                    "title": "Big meeting",
                    "context": "meeting",
                    "priority": 90,
                    "chunks": [{"chunk_id": "blocker#0", "duration_minutes": 24 * 60 - 15}],
                    "group_policy": {"same_day": False, "ordered": False},
                    "deadline": None,
                    "earliest_start": "2026-05-18T00:00:00",
                    "preferred_windows": [],
                    "dependencies": [],
                    "pinned_at": "2026-05-18T00:00:00",
                    "previous_placement": [],
                },
                {
                    "id": "task-soft",
                    "title": "Drop me",
                    "context": "deep",
                    "priority": 50,
                    "chunks": [{"chunk_id": "task-soft#0", "duration_minutes": 60}],
                    "group_policy": {"same_day": False, "ordered": False},
                    "deadline": None,
                    "earliest_start": "2026-05-18T00:00:00",
                    "preferred_windows": [],
                    "dependencies": [],
                    "pinned_at": None,
                    "previous_placement": [],
                },
            ],
            "external_pinned": [],
        }
    )
    art = build_model(problem)
    terms = drop_penalty_terms(art)
    art.model.Minimize(sum(v * w for v, w in terms))
    solver = _solve(art.model)
    assert solver.Value(art.task_dropped["task-soft"]) == 1


def test_lateness_penalty_pushes_task_before_deadline(load_fixture):
    # Single task, soft deadline at 12:00 on day 0, 60min duration.
    # Without lateness it could go anywhere; with lateness, end <= 12:00.
    data = load_fixture("single_task.json")
    data["tasks"][0]["deadline"] = {
        "at": "2026-05-18T12:00:00",
        "hard": False,
        "penalty_per_15min": 1000,
    }
    problem = Problem.model_validate(data)
    art = build_model(problem)
    attach_full_objective(art, scheduled_task_ids=None, dropped_task_ids=set())
    solver = _solve(art.model)
    assert solver.StatusName() in {"OPTIMAL", "FEASIBLE"}
    # task-1#0 60min ends at start+4 → must be <= 48 (slot 48 == 12:00)
    end_slot = solver.Value(art.chunk_starts["task-1#0"]) + art.chunk_duration_slots["task-1#0"]
    assert end_slot <= 48


def test_fit_pulls_into_peak_window(load_fixture):
    data = load_fixture("single_task.json")
    # No deadline; only fit term active. Peak 09:00-12:00.
    data["tasks"][0]["deadline"] = None
    data["weights"]["time_of_day_fit_per_15min"] = 100
    problem = Problem.model_validate(data)
    art = build_model(problem)
    attach_full_objective(art, scheduled_task_ids=None, dropped_task_ids=set())
    solver = _solve(art.model)
    # Task should land inside [09:00, 12:00) on some day.
    start_slot = solver.Value(art.chunk_starts["task-1#0"])
    minute_of_day = (start_slot % 96) * 15
    assert 9 * 60 <= minute_of_day
    assert minute_of_day + 60 <= 12 * 60


def test_churn_penalises_movement_from_previous(load_fixture):
    data = load_fixture("single_task.json")
    # Pin previous placement to 10:00 on day 0; very high churn weight.
    data["tasks"][0]["previous_placement"] = [
        {"chunk_id": "task-1#0", "start": "2026-05-18T10:00:00"}
    ]
    data["weights"]["churn_per_15min_moved"] = 10_000
    data["weights"]["time_of_day_fit_per_15min"] = 0
    data["tasks"][0]["deadline"] = None
    problem = Problem.model_validate(data)
    art = build_model(problem)
    attach_full_objective(art, scheduled_task_ids=None, dropped_task_ids=set())
    solver = _solve(art.model)
    start_slot = solver.Value(art.chunk_starts["task-1#0"])
    assert start_slot == 40  # 10:00 = slot 40
