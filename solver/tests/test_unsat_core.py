"""UNSAT-core extraction via SufficientAssumptionsForInfeasibility."""

from __future__ import annotations

from solver.schema import Problem
from solver.two_pass import solve


def test_pinned_collides_with_pinned_drops_one(load_fixture):
    # Two tasks pinned to the SAME instant can't both be placed. Under
    # hardness-droppability orthogonality a pin governs WHERE-if-placed but does
    # not make the task mandatory, so the solver drops one and schedules the
    # other (SAT) rather than returning UNSAT for the pair.
    problem = Problem.model_validate(load_fixture("infeasible_hard.json"))
    result = solve(problem)
    assert result.solution is not None, f"expected SAT, got unsat_core={result.unsat_core}"
    dropped = {d.task_id for d in result.solution.dropped}
    assert len(dropped & {"pin-a", "pin-b"}) == 1, "exactly one pinned task drops"


def test_hard_deadline_before_earliest_start_demotes_instead_of_unsat():
    # A hard task whose earliest_start (05-20) falls AFTER its own hard deadline
    # (05-19) has an empty feasible band, so it can never be placed in this
    # window. Rather than forcing it on — which poisons the whole solve into
    # UNSAT — it is demoted (dropped). See the unplaceable-hard-task fix
    # (internal design notes).
    problem = Problem.model_validate(
        {
            "window": {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"},
            "weights": {
                "time_of_day_fit_per_15min": 0,
                "churn_per_15min_moved": 0,
                "priority_unit": 1,
                "base_drop_penalty": 200,
            },
            "contexts": [
                {
                    "context": "deep",
                    "fit_curve": {"peak_start": "09:00", "peak_end": "12:00", "falloff_end": "16:00"},
                    "max_minutes_per_day": None,
                    "max_contiguous_minutes": None,
                    "over_daily_cap_penalty_per_15min": 0,
                    "over_streak_cap_penalty_per_15min": 0,
                }
            ],
            "tasks": [
                {
                    "id": "impossible",
                    "title": "Can't fit",
                    "context": "deep",
                    "priority": 90,
                    "chunks": [{"chunk_id": "impossible#0", "duration_minutes": 60}],
                    "group_policy": {"same_day": False, "ordered": False},
                    "deadline": {"at": "2026-05-19T12:00:00", "hard": True, "penalty_per_15min": 0},
                    "earliest_start": "2026-05-20T00:00:00",
                    "preferred_windows": [],
                    "dependencies": [],
                    "pinned_at": None,
                    "previous_placement": [],
                }
            ],
            "external_pinned": [],
        }
    )
    result = solve(problem)
    assert result.solution is not None, f"expected SAT, got unsat_core={result.unsat_core}"
    assert "impossible" in {d.task_id for d in result.solution.dropped}
