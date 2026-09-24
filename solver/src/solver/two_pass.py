"""Two-pass solve orchestration.

Pass 1: drop minimisation. On UNSAT, extract minimal unsat core (via the
        reference assumption model) and run the guarded-demotion loop.
Pass 2: with scheduled/dropped frozen, minimise the full objective.

Both passes run on the FAST models (fast_model.py): hard placement
constraints pre-compiled into variable domains, soft costs folded into one
table per chunk, pass-1 placements hinted into pass 2. model.py remains the
reference implementation and is still used for unsat-core extraction and for
isolation-feasibility checks; any unexpected failure of the fast path falls
back to the legacy solve so behaviour can never be worse than the reference.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass

from ortools.sat.python import cp_model

from solver.fast_model import build_pass1_model, build_pass2_model
from solver.fit_curve import FitCurveEvaluator
from solver.model import (
    ASSUMPTION_TASK_PRESENT,
    AssumptionInfo,
    ModelArtifacts,
    build_model,
)
from solver.objective import (
    ObjectiveTerms,
    attach_full_objective,
    drop_penalty_terms,
)
from solver.placements import (
    ProblemPlacements,
    churn_cost_at,
    compute_placements,
    fit_cost_at,
    preferred_window_cost_at,
)
from solver.schema import (
    Diagnostics,
    DroppedTask,
    ObjectiveBreakdown,
    ObjectiveComponents,
    Problem,
    ScheduledChunk,
    Solution,
    Task,
    UnsatItem,
)
from solver.slots import SLOTS_PER_DAY, datetime_to_slot, slot_to_datetime

log = logging.getLogger("solver.two_pass")

PASS1_TIME_LIMIT_S = 20.0
PASS2_TIME_LIMIT_S = 20.0


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _pass1_limit() -> float:
    return _env_float("SOLVER_PASS1_TIME_LIMIT_S", PASS1_TIME_LIMIT_S)


def _pass2_limit() -> float:
    return _env_float("SOLVER_PASS2_TIME_LIMIT_S", PASS2_TIME_LIMIT_S)


def _stall_limit() -> float:
    """Seconds without an improving solution before the search is stopped and
    the best incumbent returned. 0 disables stall detection. Hard constraints
    are never affected — this only truncates the optimality-proof tail."""
    return _env_float("SOLVER_STALL_LIMIT_S", 5.0)


class _ImprovementTracker(cp_model.CpSolverSolutionCallback):
    """Records the wall time of the last objective improvement."""

    def __init__(self) -> None:
        super().__init__()
        self.best: float | None = None
        self.last_improvement: float | None = None

    def on_solution_callback(self) -> None:
        obj = self.ObjectiveValue()
        if self.best is None or obj < self.best:
            self.best = obj
            self.last_improvement = time.perf_counter()


def _solve_with_stall_stop(
    solver: cp_model.CpSolver, model: cp_model.CpModel, time_limit: float
) -> int:
    """Solve with a hard time limit plus stall-based early stop: once an
    incumbent exists and no improvement lands for _stall_limit() seconds, stop
    and keep the incumbent (status FEASIBLE)."""
    solver.parameters.max_time_in_seconds = time_limit
    stall = _stall_limit()
    if stall <= 0:
        return solver.Solve(model)

    tracker = _ImprovementTracker()
    done = threading.Event()

    def watch() -> None:
        while not done.wait(0.25):
            last = tracker.last_improvement
            if last is not None and time.perf_counter() - last > stall:
                solver.stop_search()
                return

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        return solver.Solve(model, tracker)
    finally:
        done.set()
        watcher.join(timeout=1.0)


@dataclass
class SolveResult:
    solution: Solution | None
    unsat_core: list[UnsatItem] | None


ISOLATION_TIME_LIMIT_S = 5.0


def _isolation_feasible(problem: Problem, task: Task) -> bool:
    """Could this task be placed if it were the only TASK, given the fixed
    external calendar and its own hard constraints? Cross-task dependencies are
    meaningless in isolation and are stripped. Used by the guarded-demotion pass
    to tell a config error (unplaceable alone → demote) from genuine contention
    (placeable alone but crowded → 422)."""
    solo = task.model_copy(update={"dependencies": []})
    sub = problem.model_copy(update={"tasks": [solo]})
    art = build_model(sub, fix_assumptions=False)
    for lit, _info in art.assumptions:
        art.model.AddAssumption(lit)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = ISOLATION_TIME_LIMIT_S
    status = solver.Solve(art.model)
    return status in {cp_model.OPTIMAL, cp_model.FEASIBLE}


def solve(problem: Problem) -> SolveResult:
    try:
        return _solve_fast(problem)
    except Exception:
        log.exception("fast solve path failed; falling back to reference solver")
        return _solve_legacy(problem)


# ---------------------------------------------------------------------------
# Fast path
# ---------------------------------------------------------------------------


def _drop_weight(problem: Problem, task: Task) -> int:
    return problem.weights.base_drop_penalty + task.priority * problem.weights.priority_unit


def _solve_fast(problem: Problem) -> SolveResult:
    task_by_id = {t.id: t for t in problem.tasks}
    placements = compute_placements(problem)
    demoted: set[str] = set()
    pass1_wall = 0.0

    while True:
        art1 = build_pass1_model(problem, placements, frozenset(demoted))
        art1.model.Minimize(
            sum(art1.task_dropped[t.id] * _drop_weight(problem, t) for t in problem.tasks)
        )
        solver1 = cp_model.CpSolver()
        t0 = time.perf_counter()
        status1 = _solve_with_stall_stop(solver1, art1.model, _pass1_limit())
        pass1_wall += time.perf_counter() - t0

        if status1 == cp_model.INFEASIBLE:
            # The fast model has no assumption literals; re-prove on the
            # reference model to get the minimal core (rare path: genuine 422s
            # and must-include demotions only).
            t0 = time.perf_counter()
            core = _reference_unsat_core(problem, frozenset(demoted))
            pass1_wall += time.perf_counter() - t0
            if core is None:
                # Reference model disagrees — never expected; use legacy path.
                raise RuntimeError("fast pass1 INFEASIBLE but reference model is satisfiable")
            core_must = {
                it.task_id
                for it in core
                if it.type == ASSUMPTION_TASK_PRESENT and it.task_id is not None
            }
            newly = {
                tid
                for tid in core_must
                if tid not in demoted and not _isolation_feasible(problem, task_by_id[tid])
            }
            if newly:
                demoted |= newly
                continue
            return SolveResult(solution=None, unsat_core=core)

        if status1 not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
            # Treat unknown / model-error as infeasible-with-empty-core
            # (mirrors the legacy path).
            return SolveResult(solution=None, unsat_core=[])
        break

    scheduled_ids: set[str] = set()
    dropped_ids: set[str] = set()
    for task in problem.tasks:
        if solver1.Value(art1.task_dropped[task.id]) == 1:
            dropped_ids.add(task.id)
        else:
            scheduled_ids.add(task.id)

    pass1_starts = {
        (task.id, chunk.chunk_id): solver1.Value(art1.chunk_starts[(task.id, chunk.chunk_id)])
        for task in problem.tasks
        if task.id in scheduled_ids
        for chunk in task.chunks
    }

    # ---- Pass 2: full objective with partition frozen, warm-started ----
    art2, _obj2 = build_pass2_model(
        problem, placements, scheduled_ids, dropped_ids, hints=pass1_starts
    )
    solver2 = cp_model.CpSolver()
    t0 = time.perf_counter()
    status2 = _solve_with_stall_stop(solver2, art2.model, _pass2_limit())
    pass2_wall = time.perf_counter() - t0

    if status2 not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
        # Pass 2 should not fail (pass 1 proved the partition feasible and its
        # placements are hinted in). Fall back to the pass-1 placements.
        return _build_fast_solution(
            problem, placements, pass1_starts, dropped_ids, demoted,
            pass1_wall, 0.0, "PASS1_FALLBACK",
        )

    final_starts = {key: solver2.Value(var) for key, var in art2.chunk_starts.items()}
    return _build_fast_solution(
        problem, placements, final_starts, dropped_ids, demoted,
        pass1_wall, pass2_wall, solver2.StatusName(status2),
    )


def _reference_unsat_core(
    problem: Problem, demoted: frozenset[str]
) -> list[UnsatItem] | None:
    """Solve the reference assumption model; return its unsat core, or None if
    it unexpectedly turns out satisfiable."""
    art = build_model(problem, fix_assumptions=False, demoted_must_include=demoted)
    for lit, _info in art.assumptions:
        art.model.AddAssumption(lit)
    art.model.Minimize(sum(v * w for v, w in drop_penalty_terms(art)))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = _pass1_limit()
    status = solver.Solve(art.model)
    if status != cp_model.INFEASIBLE:
        return None
    return _extract_unsat_core(solver, art)


def _components_from_starts(
    problem: Problem,
    placements: ProblemPlacements,
    starts: dict[tuple[str, str], int],
    dropped_ids: set[str],
) -> ObjectiveComponents:
    """Recompute every objective component from concrete placements, mirroring
    objective.py term definitions exactly."""
    weights = problem.weights
    horizon = placements.tables.horizon

    lateness = fit = churn = daily_cap = streak_cap = drop = preferred = 0
    evaluators: dict[str, FitCurveEvaluator] = {}

    for task in problem.tasks:
        if task.id in dropped_ids:
            drop += _drop_weight(problem, task)
            continue

        # lateness (soft deadlines only)
        if task.deadline is not None and not task.deadline.hard:
            dl_slot = datetime_to_slot(task.deadline.at, problem.window.start)
            if task.group_policy.ordered:
                lk = (task.id, task.chunks[-1].chunk_id)
                ends = [starts[lk] + placements.by_chunk[lk].duration_slots]
            else:
                ends = [
                    starts[(task.id, c.chunk_id)]
                    + placements.by_chunk[(task.id, c.chunk_id)].duration_slots
                    for c in task.chunks
                ]
            late = max(0, max(ends) - dl_slot)
            lateness += late * task.deadline.penalty_per_15min

        cfg = placements.ctx_lookup.get(task.context)
        for chunk in task.chunks:
            key = (task.id, chunk.chunk_id)
            s = starts[key]
            place = placements.by_chunk[key]

            if weights.time_of_day_fit_per_15min and cfg is not None:
                if task.context not in evaluators:
                    evaluators[task.context] = FitCurveEvaluator(cfg.fit_curve)
                fit += weights.time_of_day_fit_per_15min * fit_cost_at(
                    problem, placements, task, place.duration_minutes, s, evaluators[task.context]
                )
            churn += churn_cost_at(problem, placements, task, chunk.chunk_id, s)
            preferred += preferred_window_cost_at(
                problem, placements, task, place.duration_minutes, s
            )
            if cfg is not None and cfg.max_contiguous_minutes is not None:
                cap_slots = cfg.max_contiguous_minutes // 15
                if place.duration_slots > cap_slots:
                    streak_cap += (
                        (place.duration_slots - cap_slots)
                        * cfg.over_streak_cap_penalty_per_15min
                    )

    # daily caps: exact slot overlap per (context, day)
    days = horizon // SLOTS_PER_DAY
    by_ctx: dict[str, list[tuple[str, str]]] = {}
    for task in problem.tasks:
        if task.id in dropped_ids:
            continue
        for chunk in task.chunks:
            by_ctx.setdefault(task.context, []).append((task.id, chunk.chunk_id))
    for ctx_name, chunk_keys in by_ctx.items():
        cfg = placements.ctx_lookup.get(ctx_name)
        if cfg is None or cfg.max_minutes_per_day is None:
            continue
        if cfg.over_daily_cap_penalty_per_15min == 0:
            continue
        cap_slots = cfg.max_minutes_per_day // 15
        for d in range(days):
            lo, hi = d * SLOTS_PER_DAY, (d + 1) * SLOTS_PER_DAY
            used = 0
            for key in chunk_keys:
                s = starts[key]
                e = s + placements.by_chunk[key].duration_slots
                used += max(0, min(e, hi) - max(s, lo))
            daily_cap += max(0, used - cap_slots) * cfg.over_daily_cap_penalty_per_15min

    return ObjectiveComponents(
        lateness=lateness,
        fit=fit,
        churn=churn,
        daily_cap=daily_cap,
        streak_cap=streak_cap,
        drop=drop,
        preferred_window=preferred,
    )


def _build_fast_solution(
    problem: Problem,
    placements: ProblemPlacements,
    starts: dict[tuple[str, str], int],
    dropped_ids: set[str],
    demoted_ids: set[str],
    pass1_wall: float,
    pass2_wall: float,
    status: str,
) -> SolveResult:
    schedule: list[ScheduledChunk] = []
    for task in problem.tasks:
        if task.id in dropped_ids:
            continue
        for chunk in task.chunks:
            schedule.append(
                ScheduledChunk(
                    task_id=task.id,
                    chunk_id=chunk.chunk_id,
                    start=slot_to_datetime(starts[(task.id, chunk.chunk_id)], problem.window.start),
                    duration_minutes=chunk.duration_minutes,
                    context=task.context,
                )
            )

    dropped: list[DroppedTask] = []
    for task in problem.tasks:
        if task.id not in dropped_ids:
            continue
        reason = (
            "must_include_unplaceable_in_isolation"
            if task.id in demoted_ids
            else "drop_was_cheaper_than_alternatives"
        )
        dropped.append(
            DroppedTask(
                task_id=task.id,
                title=task.title,
                drop_cost=_drop_weight(problem, task),
                reason=reason,
                contributing_constraints=_drop_contributing(task),
            )
        )

    comps = _components_from_starts(problem, placements, starts, dropped_ids)
    total = (
        comps.lateness + comps.fit + comps.churn + comps.daily_cap
        + comps.streak_cap + comps.drop + comps.preferred_window
    )
    solution = Solution(
        schedule=schedule,
        dropped=dropped,
        objective=ObjectiveBreakdown(total=total, components=comps),
        diagnostics=Diagnostics(
            pass1_wall_seconds=pass1_wall,
            pass2_wall_seconds=pass2_wall,
            status=status,
        ),
    )
    return SolveResult(solution=solution, unsat_core=None)


# ---------------------------------------------------------------------------
# Legacy path (reference implementation; fallback + unsat-core machinery)
# ---------------------------------------------------------------------------


def _solve_legacy(problem: Problem) -> SolveResult:
    task_by_id = {t.id: t for t in problem.tasks}
    demoted: set[str] = set()  # must_include tasks proven unplaceable in isolation
    pass1_wall = 0.0

    while True:
        # ---- Pass 1: drop minimisation under assumptions ----
        art1 = build_model(problem, fix_assumptions=False, demoted_must_include=frozenset(demoted))
        for lit, _info in art1.assumptions:
            art1.model.AddAssumption(lit)
        drop_terms = drop_penalty_terms(art1)
        art1.model.Minimize(sum(v * w for v, w in drop_terms))

        solver1 = cp_model.CpSolver()
        solver1.parameters.max_time_in_seconds = PASS1_TIME_LIMIT_S
        t0 = time.perf_counter()
        status1 = solver1.Solve(art1.model)
        pass1_wall += time.perf_counter() - t0

        if status1 == cp_model.INFEASIBLE:
            core = _extract_unsat_core(solver1, art1)
            # Demote any must-include task in the core that is unplaceable in
            # isolation; if we demoted at least one, re-solve. Otherwise the
            # remaining conflict is genuine over-subscription of mutually-feasible
            # mandatory work → return the core (422).
            core_must = {
                it.task_id for it in core
                if it.type == ASSUMPTION_TASK_PRESENT and it.task_id is not None
            }
            newly = {
                tid for tid in core_must
                if tid not in demoted and not _isolation_feasible(problem, task_by_id[tid])
            }
            if newly:
                demoted |= newly
                continue
            return SolveResult(solution=None, unsat_core=core)

        if status1 not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
            # Treat unknown / model-error as infeasible-with-empty-core.
            return SolveResult(solution=None, unsat_core=[])
        break

    scheduled_ids: set[str] = set()
    dropped_ids: set[str] = set()
    for task in problem.tasks:
        if task.id not in art1.task_dropped:
            continue
        if solver1.Value(art1.task_dropped[task.id]) == 1:
            dropped_ids.add(task.id)
        else:
            scheduled_ids.add(task.id)

    # ---- Pass 2: full objective with partition frozen ----
    art2 = build_model(problem, demoted_must_include=frozenset(demoted))
    terms2 = attach_full_objective(art2, scheduled_task_ids=scheduled_ids, dropped_task_ids=dropped_ids)

    solver2 = cp_model.CpSolver()
    solver2.parameters.max_time_in_seconds = PASS2_TIME_LIMIT_S
    t0 = time.perf_counter()
    status2 = solver2.Solve(art2.model)
    pass2_wall = time.perf_counter() - t0
    if status2 not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
        # Pass 2 should not fail because partition was proven feasible in pass 1.
        # Fall back to pass-1 placements. We cannot rebuild the full objective
        # on art1 to populate the breakdown — that would create new variables
        # solver1 has no values for (IndexError on solver.Value). Report only
        # the drop component, which was already part of pass 1's objective.
        fallback_terms = ObjectiveTerms()
        fallback_terms.drop = drop_penalty_terms(art1)
        return _build_solution_from(
            problem, art1, solver1, fallback_terms, dropped_ids, demoted, pass1_wall, 0.0, "PASS1_FALLBACK"
        )

    return _build_solution_from(
        problem,
        art2,
        solver2,
        terms2,
        dropped_ids,
        demoted,
        pass1_wall,
        pass2_wall,
        solver2.StatusName(),
    )


def _extract_unsat_core(solver: cp_model.CpSolver, art: ModelArtifacts) -> list[UnsatItem]:
    """Convert SufficientAssumptionsForInfeasibility into UnsatItems."""
    core_indices = solver.SufficientAssumptionsForInfeasibility()
    info_by_index: dict[int, AssumptionInfo] = {}
    for lit, info in art.assumptions:
        info_by_index[lit.Index()] = info
    out: list[UnsatItem] = []
    for idx in core_indices:
        if idx in info_by_index:
            info = info_by_index[idx]
            out.append(
                UnsatItem(type=info.type, task_id=info.task_id, ref=info.ref, value=info.value)
            )
    return out


def _build_solution_from(
    problem: Problem,
    art: ModelArtifacts,
    solver: cp_model.CpSolver,
    terms: ObjectiveTerms,
    dropped_ids: set[str],
    demoted_ids: set[str],
    pass1_wall: float,
    pass2_wall: float,
    status: str,
) -> SolveResult:
    schedule: list[ScheduledChunk] = []
    for task in problem.tasks:
        if task.id in dropped_ids:
            continue
        for chunk in task.chunks:
            start_slot = solver.Value(art.chunk_starts[chunk.chunk_id])
            schedule.append(
                ScheduledChunk(
                    task_id=task.id,
                    chunk_id=chunk.chunk_id,
                    start=slot_to_datetime(start_slot, problem.window.start),
                    duration_minutes=chunk.duration_minutes,
                    context=task.context,
                )
            )

    dropped: list[DroppedTask] = []
    for task in problem.tasks:
        if task.id not in dropped_ids:
            continue
        drop_cost = problem.weights.base_drop_penalty + task.priority * problem.weights.priority_unit
        reason = (
            "must_include_unplaceable_in_isolation"
            if task.id in demoted_ids
            else "drop_was_cheaper_than_alternatives"
        )
        dropped.append(
            DroppedTask(
                task_id=task.id,
                title=task.title,
                drop_cost=drop_cost,
                reason=reason,
                contributing_constraints=_drop_contributing(task),
            )
        )

    comps = ObjectiveComponents(
        lateness=_sum_terms(solver, terms.lateness),
        fit=_sum_terms(solver, terms.fit),
        churn=_sum_terms(solver, terms.churn),
        daily_cap=_sum_terms(solver, terms.daily_cap),
        streak_cap=_sum_terms(solver, terms.streak_cap),
        drop=_sum_terms(solver, terms.drop),
        preferred_window=_sum_terms(solver, terms.preferred_window),
    )
    total = (
        comps.lateness + comps.fit + comps.churn + comps.daily_cap
        + comps.streak_cap + comps.drop + comps.preferred_window
    )

    solution = Solution(
        schedule=schedule,
        dropped=dropped,
        objective=ObjectiveBreakdown(total=total, components=comps),
        diagnostics=Diagnostics(
            pass1_wall_seconds=pass1_wall,
            pass2_wall_seconds=pass2_wall,
            status=status,
        ),
    )
    return SolveResult(solution=solution, unsat_core=None)


def _sum_terms(solver: cp_model.CpSolver, terms: list[tuple[cp_model.IntVar, int]]) -> int:
    total = 0
    for var, weight in terms:
        total += solver.Value(var) * weight
    return total


def _drop_contributing(task) -> list[str]:
    out: list[str] = []
    if task.deadline is not None and not task.deadline.hard:
        out.append("soft_deadline")
    if any(not w.hard for w in task.preferred_windows):
        out.append("preferred_window")
    return out
