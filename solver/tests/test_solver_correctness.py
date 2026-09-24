"""Solver correctness harness.

For each feasible scenario x a couple of seeds: solve once (cached), then assert
the full hard-guarantee invariant set AND an independent objective recomputation
that must match the solver's reported breakdown exactly. Plus the genuine-422
scenario and a determinism-of-contract check.

Each (scenario, seed) is SOLVED ONCE via an lru_cache and asserted by several
tests, keeping the wall time bounded. The expensive scenarios (heavy,
oversubscribed, fresh_week, adversarial_churn) use a single seed to keep the whole
file comfortably under a few minutes on the current (un-optimised) solver;
small/typical/meetings use two seeds.
"""

from __future__ import annotations

from functools import lru_cache

import pytest

from solver.schema import Problem
from solver.two_pass import SolveResult, solve
from tests.support import generators as g
from tests.support.invariants import assert_objective_consistent, assert_solution_valid

_BUILDERS = {
    "small": g.scenario_small,
    "typical": g.scenario_typical,
    "fresh_week": g.scenario_fresh_week,
    "adversarial_churn": g.scenario_adversarial_churn,
    "heavy": g.scenario_heavy,
    "meetings": g.scenario_meetings,
    "oversubscribed": g.scenario_oversubscribed,
}

# Two seeds where cheap; one seed for the expensive scenarios (documented above).
_SEEDS = {
    "small": (1, 2),
    "typical": (1, 2),
    "meetings": (1, 2),
    "fresh_week": (1,),
    "adversarial_churn": (1,),
    "heavy": (7,),
    "oversubscribed": (7,),
}


@lru_cache(maxsize=None)
def _solved(scenario: str, seed: int) -> tuple[Problem, SolveResult]:
    problem = Problem.model_validate(_BUILDERS[scenario](seed))
    return problem, solve(problem)


def _cases() -> list[tuple[str, int]]:
    return [(name, seed) for name, seeds in _SEEDS.items() for seed in seeds]


@pytest.mark.parametrize("scenario,seed", _cases())
def test_scenario_returns_solution(scenario: str, seed: int) -> None:
    _problem, result = _solved(scenario, seed)
    assert result.unsat_core is None, f"{scenario}/{seed} unexpectedly infeasible"
    assert result.solution is not None
    # The full-objective breakdown must have been populated (not the drop-only
    # PASS1_FALLBACK path), otherwise the objective oracle cannot verify it.
    assert result.solution.diagnostics.status != "PASS1_FALLBACK", (
        f"{scenario}/{seed} fell back to pass-1 placements"
    )


@pytest.mark.parametrize("scenario,seed", _cases())
def test_scenario_invariants(scenario: str, seed: int) -> None:
    problem, result = _solved(scenario, seed)
    assert result.solution is not None
    assert_solution_valid(problem, result.solution)


@pytest.mark.parametrize("scenario,seed", _cases())
def test_scenario_objective_oracle(scenario: str, seed: int) -> None:
    problem, result = _solved(scenario, seed)
    assert result.solution is not None
    assert_objective_consistent(problem, result.solution)


def test_oversubscribed_actually_drops() -> None:
    _problem, result = _solved("oversubscribed", _SEEDS["oversubscribed"][0])
    assert result.solution is not None
    assert result.solution.dropped, "oversubscribed scenario should drop some tasks"


def test_meetings_all_included() -> None:
    """Every owned movable meeting is must_include and always feasible (its
    availability includes the current slot), so none should ever drop."""
    problem, result = _solved("meetings", _SEEDS["meetings"][0])
    assert result.solution is not None
    scheduled = {sc.task_id for sc in result.solution.schedule}
    for task in problem.tasks:
        if task.must_include:
            assert task.id in scheduled, f"meeting {task.id} was dropped"


def test_unsat_returns_core_with_task_present() -> None:
    problem = Problem.model_validate(g.scenario_unsat(1))
    result = solve(problem)
    assert result.solution is None, "two tasks pinned to one slot must be infeasible"
    assert result.unsat_core, "expected a non-empty unsat core"
    present = {it.task_id for it in result.unsat_core if it.type == "task_present"}
    conflicting = {t.id for t in problem.tasks if t.must_include}
    assert conflicting <= present, (
        f"unsat core missing task_present for conflicting tasks: {conflicting - present}"
    )


def test_determinism_of_contract() -> None:
    """Solving the same problem twice yields identical objective totals and the
    same dropped-task set.

    NOTE: we deliberately do NOT assert chunk-level placement equality. CP-SAT
    search interleaving is wall-clock sensitive, so two runs may land on
    different equal-cost optima (observed on the optimized solver: same total,
    same drops, different tie-broken placements). The solver CONTRACT is
    cost-level determinism: same objective total, same drop partition."""
    problem = Problem.model_validate(g.scenario_small(3))
    r1 = solve(problem)
    r2 = solve(problem)
    assert r1.solution is not None and r2.solution is not None

    def drops(res: SolveResult) -> set[str]:
        return {d.task_id for d in res.solution.dropped}

    assert r1.solution.objective.total == r2.solution.objective.total
    assert drops(r1) == drops(r2)
