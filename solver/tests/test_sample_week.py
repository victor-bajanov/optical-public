"""End-to-end sample-week test from the brief."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from solver.schema import Problem
from solver.two_pass import solve


def test_sample_week_solves_without_drops(load_fixture):
    problem = Problem.model_validate(load_fixture("sample_week.json"))
    result = solve(problem)
    assert result.unsat_core is None
    assert result.solution is not None
    sol = result.solution

    # 1. Every chunk except dropped is in the solution
    expected_chunks = {
        "deep-a#0",
        "deep-b#0",
        "deep-b#1",
        "admin-1#0",
        "admin-1#1",
        "pilates-fri#0",
        "client-meeting#0",
    }
    placed = {c.chunk_id for c in sol.schedule}
    dropped = {d.task_id for d in sol.dropped}
    # All tasks fit comfortably in a week of free time → no drops
    assert dropped == set()
    assert placed == expected_chunks

    # 2. Pinned tasks at exact times
    aik = next(c for c in sol.schedule if c.chunk_id == "pilates-fri#0")
    assert aik.start == datetime(2026, 5, 22, 19, 0)
    cm = next(c for c in sol.schedule if c.chunk_id == "client-meeting#0")
    assert cm.start == datetime(2026, 5, 19, 10, 0)

    # 3. No overlap between scheduled chunks
    intervals = [(c.start, c.duration_minutes) for c in sol.schedule]
    intervals.sort()
    for (s1, d1), (s2, d2) in zip(intervals, intervals[1:]):
        end1 = s1.timestamp() + d1 * 60
        assert end1 <= s2.timestamp(), f"overlap between {s1} and {s2}"

    # 4. Deep work falls inside [09:00, 16:00) on weekdays (fit curve says so)
    for c in sol.schedule:
        if c.context == "deep":
            minute_of_day = c.start.hour * 60 + c.start.minute
            assert minute_of_day >= 9 * 60
            assert minute_of_day + c.duration_minutes <= 16 * 60
            assert c.start.weekday() < 5

    # 5. Admin work falls inside [13:00, 17:00)
    for c in sol.schedule:
        if c.context == "admin":
            minute_of_day = c.start.hour * 60 + c.start.minute
            assert minute_of_day >= 13 * 60
            assert minute_of_day + c.duration_minutes <= 17 * 60


def test_sample_week_objective_below_threshold(load_fixture):
    """The optimal placement of a roomy week should incur minimal soft penalty.

    Bound: with weights time_of_day_fit_per_15min=5, the worst single slot
    contributes 5 * 100 = 500. Allow up to 4 slots of non-zero fit (e.g.,
    boundary effects from the meeting context curve evaluated at 10:00 → 0)
    → ceiling of 2000.
    """
    problem = Problem.model_validate(load_fixture("sample_week.json"))
    result = solve(problem)
    assert result.solution is not None
    assert result.solution.objective.total <= 2000


def test_snapshot_solution_shape(load_fixture, tmp_path):
    """Regression snapshot: ensure response JSON shape stays stable.

    We don't snapshot exact slot placements (CP-SAT may find equivalent optima),
    but we do snapshot the keys + counts + the pinned positions.
    """
    problem = Problem.model_validate(load_fixture("sample_week.json"))
    result = solve(problem)
    assert result.solution is not None
    summary = {
        "schedule_count": len(result.solution.schedule),
        "dropped_count": len(result.solution.dropped),
        "objective_keys": sorted(result.solution.objective.components.model_dump().keys()),
        "pinned_positions": {
            c.chunk_id: c.start.isoformat()
            for c in result.solution.schedule
            if c.chunk_id in {"pilates-fri#0", "client-meeting#0"}
        },
    }
    expected_path = Path(__file__).parent / "fixtures" / "sample_week.expected.json"
    expected = json.loads(expected_path.read_text())
    assert summary == expected
