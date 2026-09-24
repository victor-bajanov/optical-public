"""CP-SAT model construction: variables, intervals, NoOverlap, hard constraints.

The model exposes assumption literals for every hard constraint so pass 1
can call SufficientAssumptionsForInfeasibility to extract a minimal unsat core.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time

from ortools.sat.python import cp_model

from solver.schema import (
    Chunk,
    Problem,
    Task,
)
from solver.slots import (
    SLOTS_PER_DAY,
    datetime_to_slot,
    duration_to_slots,
    slot_to_time_of_day_minutes,
    slot_to_weekday,
    total_slots,
)

# ----- assumption literal kinds (mirror UnsatItem.type) -----
ASSUMPTION_PINNED_AT = "pinned_at"
ASSUMPTION_HARD_DEADLINE = "hard_deadline"
ASSUMPTION_EARLIEST_START = "earliest_start"
ASSUMPTION_HARD_DEPENDENCY = "hard_dependency"
ASSUMPTION_HARD_PREFERRED_WINDOW = "hard_preferred_window"
ASSUMPTION_BUSINESS_HOURS = "business_hours"
ASSUMPTION_GROUP_SAME_DAY = "group_same_day"
ASSUMPTION_GROUP_ORDERED = "group_ordered"
ASSUMPTION_TASK_PRESENT = "task_present"  # only used for hard-task force-on
ASSUMPTION_EXTERNAL_PINNED = "external_pinned"
ASSUMPTION_AVAILABILITY_WINDOW = "availability_window"


@dataclass
class AssumptionInfo:
    """Metadata for one assumption literal, used to render the unsat core."""

    type: str
    task_id: str | None = None
    chunk_id: str | None = None
    ref: str | None = None
    value: str | None = None


@dataclass
class ModelArtifacts:
    model: cp_model.CpModel
    problem: Problem
    horizon_slots: int
    chunk_ids: list[str] = field(default_factory=list)
    chunk_starts: dict[str, cp_model.IntVar] = field(default_factory=dict)
    chunk_ends: dict[str, cp_model.IntVar] = field(default_factory=dict)
    chunk_presence: dict[str, cp_model.IntVar] = field(default_factory=dict)
    chunk_intervals: dict[str, cp_model.IntervalVar] = field(default_factory=dict)
    chunk_duration_slots: dict[str, int] = field(default_factory=dict)
    chunk_task_id: dict[str, str] = field(default_factory=dict)
    chunk_context: dict[str, str] = field(default_factory=dict)
    task_dropped: dict[str, cp_model.IntVar] = field(default_factory=dict)
    """1 if the whole task is dropped (no chunk present)."""
    assumptions: list[tuple[cp_model.IntVar, AssumptionInfo]] = field(default_factory=list)
    """Each entry: (literal, metadata). Pass 1 collects these for unsat-core extraction."""


def _add_assumption(
    art: ModelArtifacts, info: AssumptionInfo, fix_to_true: bool | None = None
) -> cp_model.IntVar:
    lit = art.model.NewBoolVar(f"assume:{info.type}:{info.task_id}:{info.chunk_id}:{info.ref}")
    if fix_to_true is None:
        fix_to_true = getattr(art, "_fix_assumptions", True)
    if fix_to_true:
        art.model.Add(lit == 1)  # always true; OnlyEnforceIf chains gate the constraint
    art.assumptions.append((lit, info))
    return lit


def _time_to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def build_model(
    problem: Problem,
    *,
    fix_assumptions: bool = True,
    demoted_must_include: frozenset[str] = frozenset(),
) -> ModelArtifacts:
    """Build a CP-SAT model with hard constraints, NoOverlap, and assumption literals.

    If ``fix_assumptions`` is False, the assumption literals are left free so the
    caller can register them via ``model.AddAssumption`` for unsat-core extraction.
    """
    model = cp_model.CpModel()
    horizon = total_slots(problem.window.start, problem.window.end)
    art = ModelArtifacts(model=model, problem=problem, horizon_slots=horizon)
    art._fix_assumptions = fix_assumptions  # type: ignore[attr-defined]

    intervals_for_no_overlap: list[cp_model.IntervalVar] = []

    # ----- task chunks -----
    for task in problem.tasks:
        task_dropped = model.NewBoolVar(f"dropped:{task.id}")
        art.task_dropped[task.id] = task_dropped
        # Hardness and droppability are ORTHOGONAL. A hard constraint (pin, hard
        # deadline, hard preferred window) only governs WHERE a task goes when it
        # is scheduled — every such constraint is gated OnlyEnforceIf(presence)
        # below, and presence == 1 - task_dropped. Droppability is governed
        # solely by the priority-weighted drop penalty in the objective. So we
        # never force task_dropped == 0: an over-subscribed week (a hard window
        # blocked by meetings, two hard-deadline tasks contending for one slot)
        # drops the lowest-value task rather than returning UNSAT for the lot.

        # must_include forces presence: a task_present assumption pins
        # task_dropped == 0 so the task cannot be shed to relieve contention.
        # Droppable tasks (the default) are unchanged. A task demoted by the
        # guarded-demotion pass (two_pass.solve) is treated as droppable here.
        if task.must_include and task.id not in demoted_must_include:
            present_lit = _add_assumption(
                art, AssumptionInfo(type=ASSUMPTION_TASK_PRESENT, task_id=task.id)
            )
            model.Add(task_dropped == 0).OnlyEnforceIf(present_lit)

        for chunk in task.chunks:
            _add_chunk(art, task, chunk, intervals_for_no_overlap)

        _add_group_policy(art, task)
        _add_deadline(art, task)
        _add_earliest_start(art, task)
        _add_preferred_windows(art, task)
        _add_availability_windows(art, task)
        _add_business_hours(art, task)

    # ----- external pinned events -----
    for ext in problem.external_pinned:
        start_slot = datetime_to_slot(ext.start, problem.window.start)
        dur_slots = duration_to_slots(ext.duration_minutes)
        start_var = model.NewConstant(start_slot)
        end_var = model.NewConstant(start_slot + dur_slots)
        ivar = model.NewIntervalVar(start_var, dur_slots, end_var, f"ext:{ext.id}")
        intervals_for_no_overlap.append(ivar)
        _add_assumption(
            art,
            AssumptionInfo(
                type=ASSUMPTION_EXTERNAL_PINNED,
                task_id=ext.id,
                value=ext.start.isoformat(),
            ),
        )

    # ----- NoOverlap across ALL scheduled intervals -----
    model.AddNoOverlap(intervals_for_no_overlap)

    # ----- dependencies (after all chunk variables exist) -----
    for task in problem.tasks:
        _add_dependencies(art, task)

    return art


def _add_chunk(
    art: ModelArtifacts,
    task: Task,
    chunk: Chunk,
    intervals_for_no_overlap: list,
) -> None:
    model = art.model
    horizon = art.horizon_slots
    dur_slots = duration_to_slots(chunk.duration_minutes)
    cid = chunk.chunk_id

    start = model.NewIntVar(0, horizon - dur_slots, f"start:{cid}")
    end = model.NewIntVar(dur_slots, horizon, f"end:{cid}")
    presence = model.NewBoolVar(f"present:{cid}")
    model.Add(end == start + dur_slots)

    # Every chunk's presence tracks its task's dropped flag: present iff the
    # task is not dropped. No task is ever forced on (see build_model), so any
    # task — hard or soft — can be dropped when it cannot be placed, and its
    # hard constraints below are gated OnlyEnforceIf(presence) so a dropped
    # chunk is unconstrained.
    model.Add(presence == 1 - art.task_dropped[task.id])

    ivar = model.NewOptionalIntervalVar(start, dur_slots, end, presence, f"int:{cid}")
    intervals_for_no_overlap.append(ivar)

    art.chunk_ids.append(cid)
    art.chunk_starts[cid] = start
    art.chunk_ends[cid] = end
    art.chunk_presence[cid] = presence
    art.chunk_intervals[cid] = ivar
    art.chunk_duration_slots[cid] = dur_slots
    art.chunk_task_id[cid] = task.id
    art.chunk_context[cid] = task.context

    # pinned_at: constrain start exactly
    if task.pinned_at is not None:
        pinned_slot = datetime_to_slot(task.pinned_at, art.problem.window.start)
        # Only the first chunk gets pinned at the exact start; multi-chunk pinned
        # tasks are uncommon but we pin chunk[0] and let group_policy.ordered
        # serialise the rest. The Worker is responsible for not pinning multi-chunk
        # tasks ambiguously.
        if chunk.chunk_id == task.chunks[0].chunk_id:
            lit = _add_assumption(
                art,
                AssumptionInfo(
                    type=ASSUMPTION_PINNED_AT,
                    task_id=task.id,
                    chunk_id=cid,
                    value=task.pinned_at.isoformat(),
                ),
            )
            # Gate on presence like every other hard placement constraint
            # (hardness ⊥ droppability): a DROPPED pinned task must not keep
            # its frozen start, or it leaks constraints into the rest of the
            # week through ungated couplings (a dependency partner was forced
            # to schedule around a task that isn't even kept — same blast-
            # radius class as the 2026-06-04 hard-window incident).
            model.Add(start == pinned_slot).OnlyEnforceIf([lit, presence])


def _add_group_policy(art: ModelArtifacts, task: Task) -> None:
    if len(task.chunks) < 2:
        return
    model = art.model
    chunk_ids = [c.chunk_id for c in task.chunks]

    if task.group_policy.same_day:
        # day = start // SLOTS_PER_DAY ; force all chunks onto the same day index
        day_vars: list[cp_model.IntVar] = []
        for cid in chunk_ids:
            dvar = model.NewIntVar(0, art.horizon_slots // SLOTS_PER_DAY, f"day:{cid}")
            model.AddDivisionEquality(dvar, art.chunk_starts[cid], SLOTS_PER_DAY)
            day_vars.append(dvar)
        lit = _add_assumption(
            art,
            AssumptionInfo(type=ASSUMPTION_GROUP_SAME_DAY, task_id=task.id),
        )
        for d in day_vars[1:]:
            model.Add(d == day_vars[0]).OnlyEnforceIf(lit)

    if task.group_policy.ordered:
        lit = _add_assumption(
            art,
            AssumptionInfo(type=ASSUMPTION_GROUP_ORDERED, task_id=task.id),
        )
        for prev, nxt in zip(chunk_ids, chunk_ids[1:]):
            model.Add(art.chunk_ends[prev] <= art.chunk_starts[nxt]).OnlyEnforceIf(lit)


def _add_deadline(art: ModelArtifacts, task: Task) -> None:
    if task.deadline is None:
        return
    if not task.deadline.hard:
        return  # soft deadlines handled in objective.py
    deadline_slot = datetime_to_slot(task.deadline.at, art.problem.window.start)
    for chunk in task.chunks:
        lit = _add_assumption(
            art,
            AssumptionInfo(
                type=ASSUMPTION_HARD_DEADLINE,
                task_id=task.id,
                chunk_id=chunk.chunk_id,
                value=task.deadline.at.isoformat(),
            ),
        )
        # Gate on presence so a DROPPED chunk (a demoted hard task whose band
        # is infeasible, or a soft task) is not constrained by its own deadline.
        presence = art.chunk_presence[chunk.chunk_id]
        end_var = art.chunk_ends[chunk.chunk_id]
        art.model.Add(end_var <= deadline_slot).OnlyEnforceIf([lit, presence])


def _add_earliest_start(art: ModelArtifacts, task: Task) -> None:
    es_slot = datetime_to_slot(task.earliest_start, art.problem.window.start)
    if es_slot <= 0:
        return
    for chunk in task.chunks:
        lit = _add_assumption(
            art,
            AssumptionInfo(
                type=ASSUMPTION_EARLIEST_START,
                task_id=task.id,
                chunk_id=chunk.chunk_id,
                value=task.earliest_start.isoformat(),
            ),
        )
        # Gate on presence so a DROPPED chunk is not constrained by its own
        # earliest_start (which is what lets an unplaceable hard task demote).
        presence = art.chunk_presence[chunk.chunk_id]
        art.model.Add(art.chunk_starts[chunk.chunk_id] >= es_slot).OnlyEnforceIf([lit, presence])


def _add_preferred_windows(art: ModelArtifacts, task: Task) -> None:
    origin = art.problem.window.start
    horizon = art.horizon_slots

    for window in task.preferred_windows:
        if not window.hard:
            continue
        # Build the set of allowed slot indices for each chunk's start such that
        # the chunk fits entirely inside an allowed [start_time, end_time) on an
        # allowed weekday. Express as: start is in union of intervals.
        win_start = _time_to_minutes(window.start)
        win_end = _time_to_minutes(window.end)
        for chunk in task.chunks:
            dur_min = chunk.duration_minutes
            allowed_intervals: list[tuple[int, int]] = []
            for slot in range(0, horizon):
                slot_min = slot_to_time_of_day_minutes(slot, origin)
                day = slot_to_weekday(slot, origin)
                if day not in window.days:
                    continue
                # chunk runs [slot_min, slot_min + dur_min); must fit in [win_start, win_end)
                if slot_min < win_start:
                    continue
                if slot_min + dur_min > win_end:
                    continue
                # also must not span midnight
                if (slot_min + dur_min) > 24 * 60:
                    continue
                allowed_intervals.append((slot, slot + 1))
            # Gate on presence so a DROPPED chunk is not constrained by its own
            # hard window — this is what lets an unplaceable / over-subscribed
            # hard-window task demote instead of poisoning the whole solve into
            # UNSAT (hardness ⊥ droppability, like _add_deadline / _add_business_hours).
            presence = art.chunk_presence[chunk.chunk_id]
            if not allowed_intervals:
                # No slots satisfy this window → infeasibility under this assumption
                # WHEN PRESENT; a dropped chunk escapes via the presence gate.
                lit = _add_assumption(
                    art,
                    AssumptionInfo(
                        type=ASSUMPTION_HARD_PREFERRED_WINDOW,
                        task_id=task.id,
                        chunk_id=chunk.chunk_id,
                    ),
                )
                art.model.Add(art.chunk_starts[chunk.chunk_id] == -1).OnlyEnforceIf([lit, presence])
                continue
            lit = _add_assumption(
                art,
                AssumptionInfo(
                    type=ASSUMPTION_HARD_PREFERRED_WINDOW,
                    task_id=task.id,
                    chunk_id=chunk.chunk_id,
                ),
            )
            # AddAllowedAssignments on a single var with a tuple of allowed values
            start_var = art.chunk_starts[chunk.chunk_id]
            allowed_values = [(s,) for s, _ in allowed_intervals]
            art.model.AddAllowedAssignments([start_var], allowed_values).OnlyEnforceIf([lit, presence])


def _add_availability_windows(art: ModelArtifacts, task: Task) -> None:
    """Hard allowed-placement mask from concrete datetime intervals. A chunk's
    start slot is restricted to slots where the WHOLE chunk fits inside one
    availability window. Presence-gated like a hard PreferredWindow so a dropped
    chunk is unconstrained (hardness ⊥ droppability). Empty list = no mask.

    The Worker builds these windows already unioned with the meeting's current
    slot, so a movable meeting can always stay put → the mask is never empty for
    a meeting and the problem never goes infeasible because of it."""
    if not task.availability_windows:
        return
    origin = art.problem.window.start
    horizon = art.horizon_slots

    # Precompute each window's [start_slot, end_slot) in horizon slot units.
    win_slots: list[tuple[int, int]] = []
    for w in task.availability_windows:
        ws = datetime_to_slot(w.start, origin)
        we = datetime_to_slot(w.end, origin)
        win_slots.append((ws, we))

    for chunk in task.chunks:
        dur_slots = duration_to_slots(chunk.duration_minutes)
        allowed: set[int] = set()
        for ws, we in win_slots:
            # start s is allowed iff ws <= s and s + dur_slots <= we, clamped to
            # the schedulable horizon [0, horizon - dur_slots].
            lo = max(ws, 0)
            hi = min(we - dur_slots, horizon - dur_slots)
            for s in range(lo, hi + 1):
                allowed.add(s)
        presence = art.chunk_presence[chunk.chunk_id]
        start_var = art.chunk_starts[chunk.chunk_id]
        lit = _add_assumption(
            art,
            AssumptionInfo(
                type=ASSUMPTION_AVAILABILITY_WINDOW,
                task_id=task.id,
                chunk_id=chunk.chunk_id,
            ),
        )
        if not allowed:
            # No slot fits → the chunk can only be dropped (presence forced 0
            # under the assumption). For a meeting the Worker always includes the
            # current slot, so this branch is unreachable for meetings; it exists
            # for correctness/symmetry with _add_preferred_windows.
            art.model.Add(start_var == -1).OnlyEnforceIf([lit, presence])
            continue
        allowed_values = [(s,) for s in sorted(allowed)]
        art.model.AddAllowedAssignments([start_var], allowed_values).OnlyEnforceIf(
            [lit, presence]
        )


def _add_business_hours(art: ModelArtifacts, task: Task) -> None:
    """Global placement floor/ceiling. If a task has no pin and no
    preferred_windows of its own, each of its chunks — when present — must
    start so it fits entirely inside the business-hours window on an
    allowed weekday. Gated on chunk presence so a dropped task is NOT
    constrained: business hours bounds *where* a task lands, never
    *whether* it is scheduled."""
    bh = art.problem.business_hours
    if bh is None:
        return
    # Explicit beats implicit: a pin or a HARD own window overrides the floor.
    # A soft window does NOT exempt — it is a preference (see objective.py
    # preferred_window_terms), not an opt-out of business hours.
    # An availability mask is the authoritative placement constraint (the Worker
    # has already clipped it to business hours AND unioned the meeting's current
    # slot, which may legitimately sit outside business hours — e.g. a 07:30
    # standup). Applying business hours on TOP would forbid the current-slot
    # fallback and break the always-feasible guarantee.
    if (
        task.pinned_at is not None
        or any(w.hard for w in task.preferred_windows)
        or task.availability_windows
    ):
        return

    origin = art.problem.window.start
    horizon = art.horizon_slots
    win_start = _time_to_minutes(bh.start)
    win_end = _time_to_minutes(bh.end)

    for chunk in task.chunks:
        dur_min = chunk.duration_minutes
        allowed: list[tuple[int]] = []
        for slot in range(0, horizon):
            slot_min = slot_to_time_of_day_minutes(slot, origin)
            if slot_to_weekday(slot, origin) not in bh.days:
                continue
            if slot_min < win_start:
                continue
            if slot_min + dur_min > win_end:
                continue
            if (slot_min + dur_min) > 24 * 60:
                continue
            allowed.append((slot,))

        lit = _add_assumption(
            art,
            AssumptionInfo(
                type=ASSUMPTION_BUSINESS_HOURS,
                task_id=task.id,
                chunk_id=chunk.chunk_id,
            ),
        )
        presence = art.chunk_presence[chunk.chunk_id]
        start_var = art.chunk_starts[chunk.chunk_id]
        if not allowed:
            # No slot fits this chunk inside business hours → it can only be
            # dropped (presence forced to 0 under the assumption).
            art.model.Add(start_var == -1).OnlyEnforceIf([lit, presence])
            continue
        art.model.AddAllowedAssignments([start_var], allowed).OnlyEnforceIf([lit, presence])


def _add_dependencies(art: ModelArtifacts, task: Task) -> None:
    """after_task: this task's first chunk starts >= referenced task's last chunk end.
    before_task: symmetric. after_event / before_event: anchor to external_pinned id.
    """
    model = art.model
    problem = art.problem

    def task_first_start(task_id: str) -> cp_model.IntVar | None:
        for t in problem.tasks:
            if t.id == task_id and t.chunks:
                return art.chunk_starts[t.chunks[0].chunk_id]
        return None

    def task_last_end(task_id: str) -> cp_model.IntVar | None:
        for t in problem.tasks:
            if t.id == task_id and t.chunks:
                return art.chunk_ends[t.chunks[-1].chunk_id]
        return None

    def event_slot(event_id: str) -> tuple[int, int] | None:
        for ext in problem.external_pinned:
            if ext.id == event_id:
                s = datetime_to_slot(ext.start, problem.window.start)
                return s, s + duration_to_slots(ext.duration_minutes)
        return None

    def task_presence(task_id: str) -> cp_model.IntVar | None:
        for t in problem.tasks:
            if t.id == task_id and t.chunks:
                return art.chunk_presence[t.chunks[0].chunk_id]
        return None

    if not task.chunks:
        return
    my_first_start = art.chunk_starts[task.chunks[0].chunk_id]
    my_last_end = art.chunk_ends[task.chunks[-1].chunk_id]
    # A dependency binds only while BOTH endpoints are scheduled (hardness ⊥
    # droppability, like every other hard constraint). Without the presence
    # gates a DROPPED endpoint still participates: benign when its variables
    # float, but a dropped PINNED task used to propagate its frozen start into
    # the partner's placement — or 422 the whole solve on an impossible
    # pin/dependency combination that should simply drop a task.
    my_presence = art.chunk_presence[task.chunks[0].chunk_id]

    for dep in task.dependencies:
        if not dep.hard:
            continue
        lit = _add_assumption(
            art,
            AssumptionInfo(
                type=ASSUMPTION_HARD_DEPENDENCY,
                task_id=task.id,
                ref=dep.ref,
            ),
        )
        if dep.type == "after_task":
            other_end = task_last_end(dep.ref)
            if other_end is None:
                continue
            gates = [lit, my_presence, task_presence(dep.ref)]
            model.Add(my_first_start >= other_end).OnlyEnforceIf(gates)
        elif dep.type == "before_task":
            other_start = task_first_start(dep.ref)
            if other_start is None:
                continue
            gates = [lit, my_presence, task_presence(dep.ref)]
            model.Add(my_last_end <= other_start).OnlyEnforceIf(gates)
        elif dep.type == "after_event":
            ev = event_slot(dep.ref)
            if ev is None:
                continue
            model.Add(my_first_start >= ev[1]).OnlyEnforceIf([lit, my_presence])
        elif dep.type == "before_event":
            ev = event_slot(dep.ref)
            if ev is None:
                continue
            model.Add(my_last_end <= ev[0]).OnlyEnforceIf([lit, my_presence])
