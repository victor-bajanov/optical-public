"""Standalone benchmark: print a markdown table of per-scenario timings.

Usage:
    uv run python tests/perf/bench.py
    # or
    uv run python -m tests.perf.bench

Columns: scenario | build_s | pass1_s | pass2_s | total_s | status | scheduled |
dropped | objective_total. `build_s` is the problem generation + validation time;
`pass1_s`/`pass2_s` come from solution.diagnostics; `total_s` is the wall time
around solve(). Use before/after optimisation for documentation.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

# Allow `python tests/perf/bench.py` (add repo tests/ and src/ to path).
_TESTS_DIR = Path(__file__).resolve().parents[1]
_SRC_DIR = _TESTS_DIR.parent / "src"
for _p in (_TESTS_DIR, _SRC_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from support import generators as g  # noqa: E402

from solver.schema import Problem  # noqa: E402
from solver.two_pass import solve  # noqa: E402

SCENARIOS = [
    ("small", g.scenario_small, 1),
    ("typical", g.scenario_typical, 1),
    ("fresh_week", g.scenario_fresh_week, 1),
    ("heavy", g.scenario_heavy, 7),
    ("meetings", g.scenario_meetings, 1),
    ("oversubscribed", g.scenario_oversubscribed, 7),
    ("adversarial_churn", g.scenario_adversarial_churn, 1),
]


def main() -> None:
    rows = []
    for name, builder, seed in SCENARIOS:
        t0 = time.perf_counter()
        problem = Problem.model_validate(builder(seed))
        build_s = time.perf_counter() - t0

        t1 = time.perf_counter()
        result = solve(problem)
        total_s = time.perf_counter() - t1

        if result.solution is None:
            rows.append((name, build_s, 0.0, 0.0, total_s, "UNSAT", 0, 0, 0))
            continue
        s = result.solution
        rows.append((
            name,
            build_s,
            s.diagnostics.pass1_wall_seconds,
            s.diagnostics.pass2_wall_seconds,
            total_s,
            s.diagnostics.status,
            len(s.schedule),
            len(s.dropped),
            s.objective.total,
        ))

    header = (
        "| scenario | build_s | pass1_s | pass2_s | total_s | status | "
        "scheduled | dropped | objective_total |"
    )
    sep = "|" + "|".join(["---"] * 9) + "|"
    print(header)
    print(sep)
    for (name, build_s, p1, p2, total_s, status, sched, dropped, obj) in rows:
        print(
            f"| {name} | {build_s:.3f} | {p1:.2f} | {p2:.2f} | {total_s:.2f} | "
            f"{status} | {sched} | {dropped} | {obj} |"
        )


if __name__ == "__main__":
    main()
