"""Two-pass solve tests."""

from __future__ import annotations

import json

from solver.schema import Problem
from solver.two_pass import SolveResult, solve


def test_feasible_single_task_scheduled(load_fixture):
    problem = Problem.model_validate(load_fixture("single_task.json"))
    result = solve(problem)
    assert isinstance(result, SolveResult)
    assert result.solution is not None
    assert result.unsat_core is None
    assert len(result.solution.schedule) == 1
    assert result.solution.schedule[0].chunk_id == "task-1#0"
    assert result.solution.dropped == []
    # Objective breakdown sums to total
    comps = result.solution.objective.components
    total = comps.lateness + comps.fit + comps.churn + comps.daily_cap + comps.streak_cap + comps.drop
    assert total == result.solution.objective.total


def test_chunked_task_same_day(load_fixture):
    problem = Problem.model_validate(load_fixture("chunked_task.json"))
    result = solve(problem)
    assert result.solution is not None
    # Two chunks on same day; group_policy.same_day=True
    starts = sorted(c.start for c in result.solution.schedule)
    assert starts[0].date() == starts[1].date()


def test_previous_placement_outside_window_does_not_crash(load_fixture):
    """A previous_placement from a prior window (a typical case after the user
    commits a plan and then resolves the next week) used to make pass 2
    infeasible — its churn diff variable couldn't hold |start - prev_slot|
    when prev_slot was outside [0, horizon) — and the PASS1_FALLBACK path
    then crashed with IndexError. Bug:
    internal design notes
    """
    data = json.loads(json.dumps(load_fixture("single_task.json")))
    chunk_id = data["tasks"][0]["chunks"][0]["chunk_id"]
    # Window is 2026-05-18 to 2026-05-25. Place prev one year earlier.
    data["tasks"][0]["previous_placement"] = [
        {"chunk_id": chunk_id, "start": "2025-05-19T10:00:00"}
    ]
    problem = Problem.model_validate(data)
    result = solve(problem)
    assert result.solution is not None
    # Out-of-window prev placement contributes no churn (nothing to compare to).
    assert result.solution.objective.components.churn == 0


def test_pass1_fallback_does_not_crash_when_pass2_times_out(monkeypatch, load_fixture):
    """If pass 2 returns a non-feasible status (e.g. timeout → UNKNOWN), we
    fall back to pass-1 placements. That fallback previously crashed because
    it re-built objective terms on the already-solved pass-1 model, adding
    variables solver1 had no values for.
    """
    monkeypatch.setattr("solver.two_pass.PASS2_TIME_LIMIT_S", 0.0)
    problem = Problem.model_validate(load_fixture("single_task.json"))
    result = solve(problem)
    assert result.solution is not None
    assert result.solution.diagnostics.status == "PASS1_FALLBACK"
    # Schedule comes from pass 1.
    assert len(result.solution.schedule) == 1
