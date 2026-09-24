"""Hard-constraint tests using ortools directly."""

from __future__ import annotations

from datetime import datetime

from ortools.sat.python import cp_model

from solver.model import build_model
from solver.schema import Problem
from solver.slots import datetime_to_slot


def _solve(model: cp_model.CpModel) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    solver.Solve(model)
    return solver


def test_single_task_is_placed_inside_window(load_fixture):
    problem = Problem.model_validate(load_fixture("single_task.json"))
    art = build_model(problem)
    status = _solve(art.model).StatusName() if False else None  # noqa: B015
    solver = _solve(art.model)
    assert solver.StatusName() in {"OPTIMAL", "FEASIBLE"}
    starts = [solver.Value(art.chunk_starts[ch]) for ch in art.chunk_ids]
    assert all(s >= 0 for s in starts)
    horizon = datetime_to_slot(problem.window.end, problem.window.start)
    durations = [art.chunk_duration_slots[ch] for ch in art.chunk_ids]
    assert all(start + dur <= horizon for start, dur in zip(starts, durations))


def test_pinned_task_is_fixed(load_fixture):
    problem = Problem.model_validate(load_fixture("pinned_only.json"))
    art = build_model(problem)
    # A pin binds only while the task is SCHEDULED (hardness ⊥ droppability —
    # a dropped pinned task must not keep its frozen start and leak constraints
    # through dependencies). Without an objective nothing forces presence, so
    # pin presence explicitly to assert the scheduled-case placement.
    art.model.Add(art.task_dropped["pinned-1"] == 0)
    solver = _solve(art.model)
    assert solver.StatusName() in {"OPTIMAL", "FEASIBLE"}
    pinned_slot = datetime_to_slot(datetime(2026, 5, 19, 11, 0), problem.window.start)
    assert solver.Value(art.chunk_starts["pinned-1#0"]) == pinned_slot


def test_no_overlap_between_chunks(load_fixture):
    data = load_fixture("single_task.json")
    # add a second task that must be scheduled - both 60min, with hard deadline
    # in the first slot 4 of the day; only one fits → second must be elsewhere
    data["tasks"].append(
        {
            "id": "task-2",
            "title": "Other",
            "context": "deep",
            "priority": 80,
            "chunks": [{"chunk_id": "task-2#0", "duration_minutes": 60}],
            "group_policy": {"same_day": False, "ordered": False},
            "deadline": None,
            "earliest_start": "2026-05-18T00:00:00",
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": "2026-05-18T09:00:00",
            "previous_placement": [],
        }
    )
    problem = Problem.model_validate(data)
    art = build_model(problem)
    # Force both tasks scheduled (no objective here; see test_pinned_task_is_fixed).
    art.model.Add(art.task_dropped["task-1"] == 0)
    art.model.Add(art.task_dropped["task-2"] == 0)
    solver = _solve(art.model)
    assert solver.StatusName() in {"OPTIMAL", "FEASIBLE"}
    s1 = solver.Value(art.chunk_starts["task-1#0"])
    s2 = solver.Value(art.chunk_starts["task-2#0"])
    d1 = art.chunk_duration_slots["task-1#0"]
    d2 = art.chunk_duration_slots["task-2#0"]
    assert s1 + d1 <= s2 or s2 + d2 <= s1


def test_external_pinned_blocks_overlap():
    problem = Problem.model_validate(
        {
            "window": {
                "start": "2026-05-18T00:00:00",
                "end": "2026-05-19T00:00:00",
                "tz": "UTC",
            },
            "weights": {
                "time_of_day_fit_per_15min": 0,
                "churn_per_15min_moved": 0,
                "priority_unit": 1,
                "base_drop_penalty": 200,
            },
            "contexts": [
                {
                    "context": "deep",
                    "fit_curve": {
                        "peak_start": "00:00",
                        "peak_end": "23:45",
                        "falloff_end": "23:45",
                    },
                    "max_minutes_per_day": None,
                    "max_contiguous_minutes": None,
                    "over_daily_cap_penalty_per_15min": 0,
                    "over_streak_cap_penalty_per_15min": 0,
                }
            ],
            "tasks": [
                {
                    "id": "task-1",
                    "title": "Deep",
                    "context": "deep",
                    "priority": 50,
                    "chunks": [{"chunk_id": "task-1#0", "duration_minutes": 60}],
                    "group_policy": {"same_day": False, "ordered": False},
                    "deadline": None,
                    "earliest_start": "2026-05-18T09:00:00",
                    "preferred_windows": [],
                    "dependencies": [],
                    "pinned_at": None,
                    "previous_placement": [],
                }
            ],
            "external_pinned": [
                {
                    "id": "ext-1",
                    "title": "Meeting",
                    "start": "2026-05-18T09:00:00",
                    "duration_minutes": 60,
                    "context": "meeting",
                }
            ],
        }
    )
    art = build_model(problem)
    solver = _solve(art.model)
    assert solver.StatusName() in {"OPTIMAL", "FEASIBLE"}
    # Without an objective, the solver may drop the soft task (presence=0).
    # NoOverlap on OptionalIntervalVar only binds when present; verify either way.
    if solver.Value(art.chunk_presence["task-1#0"]):
        s = solver.Value(art.chunk_starts["task-1#0"])
        # 09:00 = slot 36, 60min = 4 slots → external occupies [36, 40)
        assert s + art.chunk_duration_slots["task-1#0"] <= 36 or s >= 40
