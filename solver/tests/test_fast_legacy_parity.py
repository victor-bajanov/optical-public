"""Differential parity: the fast solve path must agree with the legacy
reference implementation wherever both prove optimality.

On any problem where both paths return OPTIMAL, pass 1's optimal drop COST and
pass 2's optimal objective TOTAL are model properties, not tie-breaks — they
must match exactly. (Drop SETS and concrete placements may differ between
equally-optimal solutions; those are not asserted.)
"""

from __future__ import annotations

import random

import pytest

from solver.schema import Problem
from solver.two_pass import _solve_fast, _solve_legacy

WINDOW = {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"}
WEIGHTS = {
    "time_of_day_fit_per_15min": 5,
    "churn_per_15min_moved": 10,
    "priority_unit": 1,
    "base_drop_penalty": 200,
    "preferred_day_miss": 40,
    "preferred_time_miss_per_15min": 5,
}
CONTEXTS = [
    {
        "context": "deep",
        "fit_curve": {"peak_start": "09:00", "peak_end": "12:00", "falloff_end": "16:00"},
        "max_minutes_per_day": 240,
        "max_contiguous_minutes": 90,
        "over_daily_cap_penalty_per_15min": 25,
        "over_streak_cap_penalty_per_15min": 25,
    },
    {
        "context": "admin",
        "fit_curve": {"peak_start": "13:00", "peak_end": "17:00", "falloff_end": "17:00"},
        "max_minutes_per_day": 120,
        "max_contiguous_minutes": 60,
        "over_daily_cap_penalty_per_15min": 25,
        "over_streak_cap_penalty_per_15min": 25,
    },
    {
        "context": "physical",
        "fit_curve": {"peak_start": "16:00", "peak_end": "20:00", "falloff_end": "22:00"},
        "max_minutes_per_day": None,
        "max_contiguous_minutes": None,
        "over_daily_cap_penalty_per_15min": 0,
        "over_streak_cap_penalty_per_15min": 0,
    },
]
BH = {"days": ["mon", "tue", "wed", "thu", "fri"], "start": "08:00", "end": "18:00"}


def _gen(seed: int) -> dict:
    rng = random.Random(seed)
    tasks = []
    n = rng.randint(4, 7)
    for i in range(n):
        ctx = rng.choice(["deep", "admin", "physical"])
        nch = rng.choice([1, 1, 2])
        chunks = [
            {"chunk_id": f"t{i}#{j}", "duration_minutes": rng.choice([30, 60, 90])}
            for j in range(nch)
        ]
        t = {
            "id": f"t{i}",
            "title": f"T{i}",
            "context": ctx,
            "priority": rng.randint(10, 95),
            "chunks": chunks,
            "group_policy": {
                "same_day": nch > 1 and rng.random() < 0.3,
                "ordered": nch > 1 and rng.random() < 0.4,
            },
            "earliest_start": "2026-05-18T00:00:00",
            "preferred_windows": [],
            "dependencies": [],
            "previous_placement": [],
        }
        if rng.random() < 0.4:
            t["deadline"] = {
                "at": f"2026-05-{rng.randint(19, 23)}T17:00:00",
                "hard": rng.random() < 0.3,
                "penalty_per_15min": 30,
            }
        if rng.random() < 0.35:
            t["preferred_windows"] = [
                {
                    "days": rng.sample(["mon", "tue", "wed", "thu", "fri"], rng.randint(1, 3)),
                    "start": "09:00",
                    "end": "13:00",
                    "hard": rng.random() < 0.3,
                }
            ]
        if rng.random() < 0.4:
            d, h = rng.randint(0, 4), rng.randint(9, 15)
            mins = rng.choice(["00", "15", "30", "45"])
            t["previous_placement"] = [
                {"chunk_id": c["chunk_id"], "start": f"2026-05-{18 + d}T{h:02d}:{mins}:00"}
                for c in chunks
            ]
        if rng.random() < 0.15:
            d, h = rng.randint(0, 4), rng.randint(9, 15)
            t["pinned_at"] = f"2026-05-{18 + d}T{h:02d}:00:00"
            t["previous_placement"] = []
        if rng.random() < 0.15:
            t["must_include"] = True
        tasks.append(t)
    if rng.random() < 0.5 and n >= 2:
        tasks[1]["dependencies"] = [{"type": "after_task", "ref": "t0", "hard": True}]
    ext, used = [], set()
    for k in range(rng.randint(0, 4)):
        d = h = None
        for _ in range(30):
            d, h = rng.randint(0, 4), rng.randint(8, 16)
            if (d, h) not in used:
                used.add((d, h))
                break
        ext.append(
            {
                "id": f"e{k}",
                "title": "E",
                "start": f"2026-05-{18 + d}T{h:02d}:00:00",
                "duration_minutes": 60,
                "context": "meeting",
            }
        )
    return {
        "window": WINDOW,
        "weights": WEIGHTS,
        "contexts": CONTEXTS,
        "tasks": tasks,
        "external_pinned": ext,
        "business_hours": BH if rng.random() < 0.8 else None,
    }


@pytest.mark.parametrize("seed", range(12))
def test_fast_matches_legacy_at_optimum(seed: int) -> None:
    problem = Problem.model_validate(_gen(seed))
    fast = _solve_fast(problem)
    legacy = _solve_legacy(problem)

    assert (fast.solution is None) == (legacy.solution is None), (
        f"SAT/UNSAT disagreement: fast={fast.unsat_core} legacy={legacy.unsat_core}"
    )
    if fast.solution is None:
        return  # both 422; core contents covered by dedicated unsat-core tests

    sf, sl = fast.solution, legacy.solution
    if sf.diagnostics.status != "OPTIMAL" or sl.diagnostics.status != "OPTIMAL":
        pytest.skip(f"not both optimal ({sf.diagnostics.status}/{sl.diagnostics.status})")

    assert sf.objective.components.drop == sl.objective.components.drop
    assert sf.objective.total == sl.objective.total
