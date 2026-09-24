#!/usr/bin/env python3
"""Dump per-chunk baked domains + combined soft-cost vectors for a Problem.

Single source of regeneration for the TS engine's cross-language golden
fixtures (worker/test/engine/fixtures/domains/). Run from solver/ so the
package env resolves:

    cd solver && uv run python bin/dump-domains.py < problem.json

Input: a bare Problem JSON on stdin, or a bench wrapper {id, meta, problem}.
Output: {"<chunk_id>": {"task_id", "duration_slots", "allowed_starts",
"cost"}} where cost[i] is the combined (weighted fit + soft-window miss +
churn) cost at allowed_starts[i], exactly as placements.combined_cost_table
computes it for the fast pass-2 model. Chunk ids must be globally unique
(they are, everywhere the worker builds problems).
"""
import json
import sys

from solver.placements import combined_cost_table, compute_placements
from solver.schema import Problem


def main() -> int:
    raw = json.loads(sys.stdin.read())
    if "problem" in raw and "window" not in raw:
        raw = raw["problem"]
    problem = Problem.model_validate(raw)
    placements = compute_placements(problem)
    out: dict[str, dict] = {}
    for task in problem.tasks:
        for chunk in task.chunks:
            place = placements.by_chunk[(task.id, chunk.chunk_id)]
            table = combined_cost_table(problem, placements, task, chunk.chunk_id)
            cost = [0 if table is None else table[s] for s in place.allowed_starts]
            if chunk.chunk_id in out:
                raise SystemExit(f"duplicate chunk_id {chunk.chunk_id!r} across tasks")
            out[chunk.chunk_id] = {
                "task_id": task.id,
                "duration_slots": place.duration_slots,
                "allowed_starts": place.allowed_starts,
                "cost": cost,
            }
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
