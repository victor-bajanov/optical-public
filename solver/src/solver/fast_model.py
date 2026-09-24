"""Fast CP-SAT model builders.

These build behaviourally-equivalent but much lighter models than model.py:

- Hard placement constraints are pre-compiled to per-chunk allowed-start sets
  (placements.py) and baked into variable DOMAINS instead of enforcement-
  literal table constraints. CP-SAT search then never explores forbidden
  starts.
- Pass 1 keeps one presence literal per TASK (chunk presence always equals
  task presence in model.py) and optional fixed-size intervals.
- Pass 2 receives a frozen scheduled/dropped partition, so it models ONLY the
  scheduled tasks, with no presence machinery at all, and folds every
  start-indexed soft cost (fit + soft preferred windows + churn) into a single
  AddElement table per chunk.

model.py remains the reference/fallback implementation: it is still used for
unsat-core extraction (assumption literals) and isolation-feasibility checks.

Semantic notes (equivalence with model.py):

- Every hard constraint binds only while its task is SCHEDULED (hardness ⊥
  droppability). Dependencies are presence-gated on BOTH endpoints — in
  model.py too, after the dropped-pinned-task blast-radius fix — so a dropped
  task never constrains the rest of the week, and a contradictory
  pin/dependency combination drops a task instead of 422ing the solve.
- With that, baking each chunk's allowed starts into its variable domain is
  observationally safe for ALL tasks: a dropped task's chunk variables appear
  only in presence-gated constraints and absent optional intervals.
- Group (same_day/ordered) constraints are presence-gated here; model.py
  leaves them unconditional but a dropped task's floating chunks always
  satisfy them, so outcomes agree.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from solver.placements import (
    ChunkKey,
    ProblemPlacements,
    combined_cost_table,
)
from solver.schema import Problem, Task
from solver.slots import SLOTS_PER_DAY, datetime_to_slot, duration_to_slots


@dataclass
class FastPass1Artifacts:
    model: cp_model.CpModel
    task_dropped: dict[str, cp_model.IntVar] = field(default_factory=dict)
    chunk_starts: dict[ChunkKey, cp_model.IntVar] = field(default_factory=dict)
    """Keyed by (task_id, chunk_id): chunk ids are only unique within a task."""


@dataclass
class FastPass2Artifacts:
    model: cp_model.CpModel
    chunk_starts: dict[ChunkKey, cp_model.IntVar] = field(default_factory=dict)
    """Start vars for chunks of SCHEDULED tasks only, keyed by (task_id, chunk_id)."""


def _dependency_involved_task_ids(problem: Problem) -> set[str]:
    """Tasks that participate in any HARD dependency, as source or target."""
    involved: set[str] = set()
    task_ids = {t.id for t in problem.tasks}
    for task in problem.tasks:
        for dep in task.dependencies:
            if not dep.hard:
                continue
            involved.add(task.id)
            if dep.type in ("after_task", "before_task") and dep.ref in task_ids:
                involved.add(dep.ref)
    return involved


def _symmetric_chunk_pairs(task: Task) -> list[tuple[str, str]]:
    """Consecutive chunk pairs that are interchangeable: equal duration, no
    per-chunk previous placement, task not ordered/pinned/dependency-involved
    (the caller checks the task-level conditions). Ordering their starts is a
    pure symmetry break."""
    prev_ids = {p.chunk_id for p in task.previous_placement}
    pairs: list[tuple[ChunkKey, ChunkKey]] = []
    for a, b in zip(task.chunks, task.chunks[1:], strict=False):
        if (
            a.duration_minutes == b.duration_minutes
            and a.chunk_id not in prev_ids
            and b.chunk_id not in prev_ids
        ):
            pairs.append(((task.id, a.chunk_id), (task.id, b.chunk_id)))
    return pairs


def _add_symmetry_breaking(
    model: cp_model.CpModel,
    task: Task,
    starts: dict[ChunkKey, cp_model.IntVar],
    dep_involved: set[str],
) -> None:
    if len(task.chunks) < 2:
        return
    if task.id in dep_involved or task.group_policy.ordered or task.pinned_at is not None:
        return
    for a, b in _symmetric_chunk_pairs(task):
        model.Add(starts[a] <= starts[b])


def _external_intervals(model: cp_model.CpModel, problem: Problem) -> list:
    out = []
    origin = problem.window.start
    for ext in problem.external_pinned:
        s = datetime_to_slot(ext.start, origin)
        d = duration_to_slots(ext.duration_minutes)
        out.append(model.NewFixedSizeIntervalVar(s, d, f"ext:{ext.id}"))
    return out


def build_pass1_model(
    problem: Problem,
    placements: ProblemPlacements,
    demoted_must_include: frozenset[str] = frozenset(),
) -> FastPass1Artifacts:
    """Drop-minimisation model: baked domains, per-task presence, optional
    intervals. Objective is attached by the caller (drop penalty terms)."""
    model = cp_model.CpModel()
    art = FastPass1Artifacts(model=model)
    horizon = placements.tables.horizon
    dep_involved = _dependency_involved_task_ids(problem)

    intervals = _external_intervals(model, problem)

    for task in problem.tasks:
        dropped = model.NewBoolVar(f"dropped:{task.id}")
        art.task_dropped[task.id] = dropped
        present = dropped.Not()

        if task.must_include and task.id not in demoted_must_include:
            model.Add(dropped == 0)

        for chunk in task.chunks:
            key = (task.id, chunk.chunk_id)
            place = placements.by_chunk[key]
            dur = place.duration_slots
            allowed = place.allowed_starts
            if not allowed:
                # Unplaceable chunk: the task can only be dropped (with
                # must_include above this makes the model infeasible — the
                # caller falls back to model.py for core extraction/demotion).
                model.Add(dropped == 1)
                start = model.NewIntVar(
                    0, max(horizon - dur, 0), f"start:{task.id}:{chunk.chunk_id}"
                )
            else:
                start = model.NewIntVarFromDomain(
                    cp_model.Domain.FromValues(allowed), f"start:{task.id}:{chunk.chunk_id}"
                )
            art.chunk_starts[key] = start
            intervals.append(
                model.NewOptionalFixedSizeIntervalVar(
                    start, dur, present, f"int:{task.id}:{chunk.chunk_id}"
                )
            )

        _add_group_constraints(model, task, art.chunk_starts, placements, gate=present)
        _add_symmetry_breaking(model, task, art.chunk_starts, dep_involved)

    model.AddNoOverlap(intervals)
    presence_by_task = {tid: var.Not() for tid, var in art.task_dropped.items()}
    _add_dependency_constraints(
        model, problem, placements, art.chunk_starts,
        scheduled_only=None, presence_by_task=presence_by_task,
    )
    _add_capacity_cut(model, problem, placements, art)

    # Hints: keep everything and return to the previous placement when known.
    origin = problem.window.start
    for task in problem.tasks:
        model.AddHint(art.task_dropped[task.id], 0)
        for prev in task.previous_placement:
            key = (task.id, prev.chunk_id)
            if key not in art.chunk_starts:
                continue
            slot = datetime_to_slot(prev.start, origin)
            place = placements.by_chunk.get(key)
            if place is not None and slot in set(place.allowed_starts):
                model.AddHint(art.chunk_starts[key], slot)

    return art


def _add_capacity_cut(
    model: cp_model.CpModel,
    problem: Problem,
    placements: ProblemPlacements,
    art: FastPass1Artifacts,
) -> None:
    """Redundant valid inequality for pass-1 drop minimisation.

    Every task whose placement mask was clipped to business hours occupies only
    business-hours slots, and external events consume some of those slots. So
    the summed duration of the KEPT business-hours tasks can never exceed the
    free business-hours capacity. NoOverlap implies this, but only through
    search; stating it linearly lets the LP relaxation prove drop lower bounds
    immediately (oversubscribed weeks are knapsacks to the LP, not mysteries).
    """
    bh = problem.business_hours
    if bh is None:
        return
    tables = placements.tables
    bh_start = bh.start.hour * 60 + bh.start.minute
    bh_end = bh.end.hour * 60 + bh.end.minute
    bh_days = set(bh.days)
    bh_slots = [
        s
        for s in range(tables.horizon)
        if tables.weekday[s] in bh_days and bh_start <= tables.tod_minutes[s] < bh_end
    ]
    if not bh_slots:
        return
    origin = problem.window.start
    ext_slots = set()
    for ext in problem.external_pinned:
        s0 = datetime_to_slot(ext.start, origin)
        ext_slots.update(range(s0, s0 + duration_to_slots(ext.duration_minutes)))
    free_bh = [s for s in bh_slots if s not in ext_slots]

    # Prefix sums of free business-hours capacity so band capacity is O(1).
    free_prefix = [0] * (tables.horizon + 1)
    free_set = set(free_bh)
    for s in range(tables.horizon):
        free_prefix[s + 1] = free_prefix[s] + (1 if s in free_set else 0)

    def free_capacity(lo: int, hi: int) -> int:
        lo = max(lo, 0)
        hi = min(hi, tables.horizon)
        if hi <= lo:
            return 0
        return free_prefix[hi] - free_prefix[lo]

    # Per-task occupancy band [es, dl) and total duration, BH-clipped tasks only.
    bands: list[tuple[int, int, int, str]] = []  # (es, dl, dur, task_id)
    for task in problem.tasks:
        if not placements.task_used_bh.get(task.id, False):
            continue
        total_dur = sum(
            placements.by_chunk[(task.id, c.chunk_id)].duration_slots for c in task.chunks
        )
        if total_dur == 0:
            continue
        es = max(0, datetime_to_slot(task.earliest_start, origin))
        dl = tables.horizon
        if task.deadline is not None and task.deadline.hard:
            dl = min(dl, datetime_to_slot(task.deadline.at, origin))
        bands.append((es, dl, total_dur, task.id))

    if not bands:
        return

    # Energetic cuts: for each (band-start, band-end) pair drawn from the
    # distinct earliest-starts and hard deadlines, every kept task whose whole
    # band fits inside must fit in that band's free capacity. The global cut is
    # the (0, horizon) member. Valid by construction — NoOverlap implies each —
    # but stated linearly they give the LP the knapsack structure that decides
    # WHICH tasks drop, not just how many.
    band_starts = sorted({0, *(es for es, _dl, _d, _t in bands)})
    band_ends = sorted({tables.horizon, *(dl for _es, dl, _d, _t in bands)})
    for lo in band_starts:
        for hi in band_ends:
            if hi <= lo:
                continue
            members = [
                (dur, tid) for es, dl, dur, tid in bands if es >= lo and dl <= hi
            ]
            if len(members) < 2 and not (lo == 0 and hi == tables.horizon):
                continue
            cap = free_capacity(lo, hi)
            total = sum(d for d, _ in members)
            if total <= cap:
                continue  # never binding; skip the noise
            model.Add(
                sum(dur * art.task_dropped[tid].Not() for dur, tid in members) <= cap
            )


def _add_group_constraints(
    model: cp_model.CpModel,
    task: Task,
    starts: dict[ChunkKey, cp_model.IntVar],
    placements: ProblemPlacements,
    gate,
) -> None:
    """same_day / ordered constraints; ``gate=None`` = unconditional."""
    if len(task.chunks) < 2:
        return
    horizon = placements.tables.horizon
    keys = [(task.id, c.chunk_id) for c in task.chunks]

    if task.group_policy.same_day:
        day_vars = []
        for key in keys:
            dvar = model.NewIntVar(0, horizon // SLOTS_PER_DAY, f"day:{key[0]}:{key[1]}")
            model.AddDivisionEquality(dvar, starts[key], SLOTS_PER_DAY)
            day_vars.append(dvar)
        for d in day_vars[1:]:
            ct = model.Add(d == day_vars[0])
            if gate is not None:
                ct.OnlyEnforceIf(gate)

    if task.group_policy.ordered:
        for prev_key, next_key in zip(keys, keys[1:], strict=False):
            dur_prev = placements.by_chunk[prev_key].duration_slots
            ct = model.Add(starts[prev_key] + dur_prev <= starts[next_key])
            if gate is not None:
                ct.OnlyEnforceIf(gate)


def _add_dependency_constraints(
    model: cp_model.CpModel,
    problem: Problem,
    placements: ProblemPlacements,
    starts: dict[ChunkKey, cp_model.IntVar],
    scheduled_only: set[str] | None,
    presence_by_task: dict | None = None,
) -> None:
    """Hard dependencies, mirroring model.py _add_dependencies: a dependency
    binds only while BOTH endpoint tasks are scheduled.

    ``scheduled_only=None`` (pass 1): gate each constraint on the endpoints'
    presence literals (``presence_by_task``). ``scheduled_only=set`` (pass 2):
    only scheduled tasks exist; a dependency whose ref is dropped or missing
    is skipped (vacuous).
    """
    task_by_id = {t.id: t for t in problem.tasks}
    ext_by_id = {e.id: e for e in problem.external_pinned}
    origin = problem.window.start

    def first_start(t: Task):
        return starts[(t.id, t.chunks[0].chunk_id)]

    def last_end(t: Task):
        key = (t.id, t.chunks[-1].chunk_id)
        return starts[key] + placements.by_chunk[key].duration_slots

    for task in problem.tasks:
        if scheduled_only is not None and task.id not in scheduled_only:
            continue
        if not task.chunks:
            continue
        for dep in task.dependencies:
            if not dep.hard:
                continue
            if dep.type in ("after_task", "before_task"):
                other = task_by_id.get(dep.ref)
                if other is None or not other.chunks:
                    continue
                if scheduled_only is not None and other.id not in scheduled_only:
                    continue
                gates = []
                if presence_by_task is not None:
                    gates = [presence_by_task[task.id], presence_by_task[other.id]]
                if dep.type == "after_task":
                    ct = model.Add(first_start(task) >= last_end(other))
                else:
                    ct = model.Add(last_end(task) <= first_start(other))
                if gates:
                    ct.OnlyEnforceIf(gates)
            else:
                ev = ext_by_id.get(dep.ref)
                if ev is None:
                    continue
                ev_start = datetime_to_slot(ev.start, origin)
                ev_end = ev_start + duration_to_slots(ev.duration_minutes)
                if dep.type == "after_event":
                    ct = model.Add(first_start(task) >= ev_end)
                else:
                    ct = model.Add(last_end(task) <= ev_start)
                if presence_by_task is not None:
                    ct.OnlyEnforceIf(presence_by_task[task.id])


@dataclass
class Pass2Objective:
    """CP variables/exprs needed to reconstruct the minimised expression."""

    terms: list = field(default_factory=list)  # linear exprs
    constant: int = 0


def build_pass2_model(
    problem: Problem,
    placements: ProblemPlacements,
    scheduled_task_ids: set[str],
    dropped_task_ids: set[str],
    hints: dict[ChunkKey, int] | None = None,
) -> tuple[FastPass2Artifacts, Pass2Objective]:
    """Full-objective model over the frozen partition: scheduled tasks only."""
    model = cp_model.CpModel()
    art = FastPass2Artifacts(model=model)
    obj = Pass2Objective()
    horizon = placements.tables.horizon
    weights = problem.weights
    origin = problem.window.start
    dep_involved = _dependency_involved_task_ids(problem)

    # Dropped tasks: constant drop penalty (partition frozen).
    for task in problem.tasks:
        if task.id in dropped_task_ids:
            obj.constant += weights.base_drop_penalty + task.priority * weights.priority_unit

    intervals = _external_intervals(model, problem)
    scheduled_tasks = [t for t in problem.tasks if t.id in scheduled_task_ids]

    for task in scheduled_tasks:
        for chunk in task.chunks:
            key = (task.id, chunk.chunk_id)
            place = placements.by_chunk[key]
            if not place.allowed_starts:
                raise RuntimeError(
                    f"pass2: scheduled chunk {key} has no allowed start (pass1 disagreement)"
                )
            start = model.NewIntVarFromDomain(
                cp_model.Domain.FromValues(place.allowed_starts),
                f"start:{task.id}:{chunk.chunk_id}",
            )
            art.chunk_starts[key] = start
            intervals.append(
                model.NewFixedSizeIntervalVar(
                    start, place.duration_slots, f"int:{task.id}:{chunk.chunk_id}"
                )
            )

            # ---- single combined soft-cost table (fit + soft windows + churn) ----
            table = combined_cost_table(problem, placements, task, chunk.chunk_id)
            if table is not None:
                ub = max(table[s] for s in place.allowed_starts)
                if ub > 0:
                    cost = model.NewIntVar(0, ub, f"cost:{task.id}:{chunk.chunk_id}")
                    model.AddElement(start, table, cost)
                    obj.terms.append(cost)

            # ---- streak cap: constant for a present chunk ----
            cfg = placements.ctx_lookup.get(task.context)
            if cfg is not None and cfg.max_contiguous_minutes is not None:
                cap_slots = cfg.max_contiguous_minutes // 15
                if place.duration_slots > cap_slots:
                    obj.constant += (
                        (place.duration_slots - cap_slots) * cfg.over_streak_cap_penalty_per_15min
                    )

        _add_group_constraints(model, task, art.chunk_starts, placements, gate=None)
        _add_symmetry_breaking(model, task, art.chunk_starts, dep_involved)

        # ---- lateness (soft deadline) ----
        if task.deadline is not None and not task.deadline.hard and task.deadline.penalty_per_15min:
            dl_slot = datetime_to_slot(task.deadline.at, origin)
            if task.group_policy.ordered:
                lkeys = [(task.id, task.chunks[-1].chunk_id)]
            else:
                lkeys = [(task.id, c.chunk_id) for c in task.chunks]
            ends = [
                art.chunk_starts[k] + placements.by_chunk[k].duration_slots for k in lkeys
            ]
            end_max = model.NewIntVar(0, horizon, f"end_max:{task.id}")
            model.AddMaxEquality(end_max, ends)
            late = model.NewIntVar(0, horizon, f"late:{task.id}")
            model.AddMaxEquality(late, [end_max - dl_slot, 0])
            obj.terms.append(late * task.deadline.penalty_per_15min)

    model.AddNoOverlap(intervals)
    _add_dependency_constraints(
        model, problem, placements, art.chunk_starts, scheduled_only=scheduled_task_ids
    )
    _add_daily_cap_terms(model, problem, placements, scheduled_tasks, art.chunk_starts, obj)

    model.Minimize(sum(obj.terms) + obj.constant)

    if hints:
        for key, slot in hints.items():
            var = art.chunk_starts.get(key)
            if var is not None:
                model.AddHint(var, slot)

    return art, obj


def _add_daily_cap_terms(
    model: cp_model.CpModel,
    problem: Problem,
    placements: ProblemPlacements,
    scheduled_tasks: list[Task],
    starts: dict[ChunkKey, cp_model.IntVar],
    obj: Pass2Objective,
) -> None:
    """Per-(context, day) over-cap penalties.

    Chunks that cannot span midnight (every realistic case: business hours or
    any window forbids it) use a cheap day-membership encoding: one day var per
    chunk, overlap-with-day = duration * [day == d]. Chunks that CAN span
    midnight fall back to the exact min/max interval-overlap decomposition of
    objective.py so slot accounting stays identical.
    """
    horizon = placements.tables.horizon
    days = horizon // SLOTS_PER_DAY

    by_ctx: dict[str, list[ChunkKey]] = {}
    for task in scheduled_tasks:
        for chunk in task.chunks:
            by_ctx.setdefault(task.context, []).append((task.id, chunk.chunk_id))

    for ctx_name, chunk_keys in by_ctx.items():
        cfg = placements.ctx_lookup.get(ctx_name)
        if cfg is None or cfg.max_minutes_per_day is None:
            continue
        penalty = cfg.over_daily_cap_penalty_per_15min
        if penalty == 0:
            continue
        cap_slots = cfg.max_minutes_per_day // 15

        # overlap expression per (chunk, day)
        overlaps: dict[ChunkKey, list] = {key: [] for key in chunk_keys}
        for key in chunk_keys:
            place = placements.by_chunk[key]
            dur = place.duration_slots
            start = starts[key]
            name = f"{key[0]}:{key[1]}"
            if not place.can_span_midnight and dur <= SLOTS_PER_DAY:
                day_var = model.NewIntVar(0, max(days - 1, 0), f"capday:{name}")
                model.AddDivisionEquality(day_var, start, SLOTS_PER_DAY)
                for d in range(days):
                    b = model.NewBoolVar(f"on:{name}:{d}")
                    model.Add(day_var == d).OnlyEnforceIf(b)
                    model.Add(day_var != d).OnlyEnforceIf(b.Not())
                    overlaps[key].append(dur * b)
            else:
                end = start + dur
                for d in range(days):
                    lo, hi = d * SLOTS_PER_DAY, (d + 1) * SLOTS_PER_DAY
                    min_end = model.NewIntVar(0, horizon, f"me:{name}:{d}")
                    model.AddMinEquality(min_end, [end, hi])
                    max_start = model.NewIntVar(0, horizon, f"ms:{name}:{d}")
                    model.AddMaxEquality(max_start, [start, lo])
                    clipped = model.NewIntVar(0, dur, f"clip:{name}:{d}")
                    model.AddMaxEquality(clipped, [min_end - max_start, 0])
                    overlaps[key].append(clipped)

        for d in range(days):
            used = sum(overlaps[key][d] for key in chunk_keys)
            over = model.NewIntVar(0, SLOTS_PER_DAY, f"over:{ctx_name}:{d}")
            model.Add(over >= used - cap_slots)
            obj.terms.append(over * penalty)
