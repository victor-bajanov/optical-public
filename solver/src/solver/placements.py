"""Shared placement pre-computation for the fast solve path.

Everything here is plain Python over slot indices — no CP-SAT. It is computed
once per problem and shared by the fast pass-1 and pass-2 model builders
(fast_model.py) and by the post-solve objective-component report.

Semantics mirror model.py / objective.py EXACTLY; those modules remain the
reference implementation (and the fallback path for unsat-core extraction).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time

from solver.fit_curve import FitCurveEvaluator
from solver.schema import ContextConfig, Problem, Task
from solver.slots import (
    SLOTS_PER_DAY,
    datetime_to_slot,
    duration_to_slots,
    slot_to_day_index,
    slot_to_time_of_day_minutes,
    slot_to_weekday,
    total_slots,
)


def _time_to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute


@dataclass
class SlotTables:
    """Per-slot lookups computed once per problem (O(horizon) datetime work)."""

    horizon: int
    tod_minutes: list[int]  # minute-of-day of each slot's start
    weekday: list[str]  # "mon".."sun" of each slot
    day_index: list[int]  # 0 for the window's first day, 1 for the next, ...


def build_slot_tables(problem: Problem) -> SlotTables:
    origin = problem.window.start
    horizon = total_slots(origin, problem.window.end)
    return SlotTables(
        horizon=horizon,
        tod_minutes=[slot_to_time_of_day_minutes(s, origin) for s in range(horizon)],
        weekday=[slot_to_weekday(s, origin) for s in range(horizon)],
        day_index=[slot_to_day_index(s, origin) for s in range(horizon)],
    )


@dataclass
class ChunkPlacement:
    """Everything the fast builders need to know about one chunk."""

    chunk_id: str
    task_id: str
    duration_slots: int
    duration_minutes: int
    allowed_starts: list[int]
    """Sorted start slots satisfying ALL the chunk's hard placement constraints
    (pin, earliest_start, hard deadline, hard preferred windows, availability
    windows, business hours). Empty = the chunk cannot be placed at all; when
    present it would violate a hard constraint, so the task can only drop."""
    can_span_midnight: bool
    """True if some allowed start puts the chunk across a midnight boundary
    (possible only without business hours / windows). Forces the exact
    daily-cap overlap encoding for this chunk."""


ChunkKey = tuple[str, str]
"""(task_id, chunk_id) — chunk_id alone is only unique WITHIN a task."""


@dataclass
class ProblemPlacements:
    tables: SlotTables
    by_chunk: dict[ChunkKey, ChunkPlacement] = field(default_factory=dict)
    ctx_lookup: dict[str, ContextConfig] = field(default_factory=dict)
    task_used_bh: dict[str, bool] = field(default_factory=dict)
    """True if the task's placement mask was clipped to business hours (no pin,
    no hard window, no availability mask). Such a task's whole occupancy lies
    inside the business-hours slot set — used for the redundant capacity cut."""


def compute_placements(
    problem: Problem, *, demoted_must_include: frozenset[str] = frozenset()
) -> ProblemPlacements:
    """Compute each chunk's allowed start set. ``demoted_must_include`` is
    accepted for signature symmetry with the model builders but does not change
    placement sets (demotion changes droppability, never placement)."""
    tables = build_slot_tables(problem)
    out = ProblemPlacements(
        tables=tables, ctx_lookup={c.context: c for c in problem.contexts}
    )
    for task in problem.tasks:
        _compute_task_placements(problem, task, tables, out)
    return out


def _compute_task_placements(
    problem: Problem, task: Task, tables: SlotTables, out: ProblemPlacements
) -> None:
    origin = problem.window.start
    horizon = tables.horizon
    tod = tables.tod_minutes
    wd = tables.weekday

    hard_windows = [w for w in task.preferred_windows if w.hard]
    hard_window_specs = [
        (_time_to_minutes(w.start), _time_to_minutes(w.end), set(w.days)) for w in hard_windows
    ]
    avail_slots = [
        (datetime_to_slot(w.start, origin), datetime_to_slot(w.end, origin))
        for w in task.availability_windows
    ]
    es_slot = max(0, datetime_to_slot(task.earliest_start, origin))
    dl_slot: int | None = None
    if task.deadline is not None and task.deadline.hard:
        dl_slot = datetime_to_slot(task.deadline.at, origin)

    bh = problem.business_hours
    # Mirror model.py _add_business_hours: explicit beats implicit — a pin, a
    # hard own window, or an availability mask exempts the task from the
    # business-hours floor.
    use_bh = (
        bh is not None
        and task.pinned_at is None
        and not hard_windows
        and not task.availability_windows
    )
    out.task_used_bh[task.id] = use_bh
    bh_spec = None
    if use_bh:
        bh_spec = (_time_to_minutes(bh.start), _time_to_minutes(bh.end), set(bh.days))

    pinned_slot: int | None = None
    if task.pinned_at is not None:
        pinned_slot = datetime_to_slot(task.pinned_at, origin)

    for ci, chunk in enumerate(task.chunks):
        dur_slots = duration_to_slots(chunk.duration_minutes)
        dur_min = chunk.duration_minutes
        allowed: list[int] = []
        can_span_midnight = False
        # model.py pins only the FIRST chunk of a pinned task.
        pin_here = pinned_slot if (pinned_slot is not None and ci == 0) else None
        lo = max(es_slot, 0)
        hi = horizon - dur_slots
        if pin_here is not None:
            lo = max(lo, pin_here)
            hi = min(hi, pin_here)
        if dl_slot is not None:
            hi = min(hi, dl_slot - dur_slots)
        for s in range(lo, hi + 1):
            m = tod[s]
            crosses_midnight = m + dur_min > 24 * 60
            if bh_spec is not None:
                bh_start, bh_end, bh_days = bh_spec
                # _add_business_hours also rejects midnight-crossing starts
                # (m + dur > bh_end >= 24h is impossible, but keep the explicit
                # check to mirror the reference loop).
                if wd[s] not in bh_days or m < bh_start or m + dur_min > bh_end or crosses_midnight:
                    continue
            ok = True
            for win_start, win_end, win_days in hard_window_specs:
                # Intersection semantics: EACH hard window constrains the start
                # (mirrors model.py adding one AddAllowedAssignments per window).
                if (
                    wd[s] not in win_days
                    or m < win_start
                    or m + dur_min > win_end
                    or crosses_midnight
                ):
                    ok = False
                    break
            if not ok:
                continue
            if avail_slots:
                if not any(ws <= s and s + dur_slots <= we for ws, we in avail_slots):
                    continue
            allowed.append(s)
            if crosses_midnight:
                can_span_midnight = True
        out.by_chunk[(task.id, chunk.chunk_id)] = ChunkPlacement(
            chunk_id=chunk.chunk_id,
            task_id=task.id,
            duration_slots=dur_slots,
            duration_minutes=dur_min,
            allowed_starts=allowed,
            can_span_midnight=can_span_midnight,
        )


# ---------------------------------------------------------------------------
# Per-chunk soft-cost tables (pass 2 objective) and component evaluators.
#
# The COMBINED table folds fit + soft-preferred-window + churn into one value
# per candidate start so the model needs a single AddElement per chunk. The
# individual evaluators below recompute each component from a chosen start for
# the post-solve objective breakdown — each mirrors its objective.py
# counterpart exactly.
# ---------------------------------------------------------------------------


def fit_cost_at(
    problem: Problem,
    placements: ProblemPlacements,
    task: Task,
    dur_min: int,
    start_slot: int,
    evaluator: FitCurveEvaluator,
) -> int:
    """Unweighted fit score for one chunk at one start (mirror fit_terms)."""
    m = placements.tables.tod_minutes[start_slot]
    if m + dur_min > 24 * 60:
        return 100 * (dur_min // 15)
    return evaluator.score_for_chunk(m, dur_min) + evaluator.score_at_minute_of_day(m + dur_min)


def preferred_window_cost_at(
    problem: Problem,
    placements: ProblemPlacements,
    task: Task,
    dur_min: int,
    start_slot: int,
) -> int:
    """Soft preferred-window miss cost (weights baked in; mirror
    preferred_window_terms)."""
    soft = [w for w in task.preferred_windows if not w.hard]
    if not soft:
        return 0
    day_w = problem.weights.preferred_day_miss
    time_w = problem.weights.preferred_time_miss_per_15min
    if day_w == 0 and time_w == 0:
        return 0
    tables = placements.tables
    horizon = tables.horizon
    days_in_horizon = max(horizon // SLOTS_PER_DAY, 1)
    weekday_of_day = [tables.weekday[d * SLOTS_PER_DAY] for d in range(days_in_horizon)]
    max_day_gap = days_in_horizon
    max_time_units = (24 * 60) // 15

    m = tables.tod_minutes[start_slot]
    wd = tables.weekday[start_slot]
    day_idx = tables.day_index[start_slot]
    if m + dur_min > 24 * 60:
        return day_w * max_day_gap + time_w * max_time_units
    best: int | None = None
    for w in soft:
        win_start = _time_to_minutes(w.start)
        win_end = _time_to_minutes(w.end)
        win_days = set(w.days)
        if wd in win_days:
            dgap = 0
        else:
            cands = [
                abs(d - day_idx) for d in range(days_in_horizon) if weekday_of_day[d] in win_days
            ]
            dgap = min(cands) if cands else max_day_gap
        tgap_min = max(0, win_start - m) + max(0, (m + dur_min) - win_end)
        cost = day_w * dgap + time_w * (tgap_min // 15)
        best = cost if best is None else min(best, cost)
    return best if best is not None else 0


def churn_cost_at(
    problem: Problem,
    placements: ProblemPlacements,
    task: Task,
    chunk_id: str,
    start_slot: int,
) -> int:
    """Weighted churn cost for one chunk at one start (mirror churn_terms)."""
    weight = problem.weights.churn_per_15min_moved * task.churn_multiplier
    if weight == 0:
        return 0
    prev = next((p for p in task.previous_placement if p.chunk_id == chunk_id), None)
    if prev is None:
        return 0
    prev_slot = datetime_to_slot(prev.start, problem.window.start)
    # Out-of-window previous placements carry no churn (mirror churn_terms).
    if prev_slot < 0 or prev_slot >= placements.tables.horizon:
        return 0
    return weight * abs(start_slot - prev_slot)


def combined_cost_table(
    problem: Problem,
    placements: ProblemPlacements,
    task: Task,
    chunk_id: str,
) -> list[int] | None:
    """Full-horizon table of (weighted fit + soft-window miss + churn) per start.

    Returns None when the chunk has no start-dependent soft cost at all. Values
    at non-allowed indices are 0 — they are never selectable because the start
    variable's domain is restricted to allowed starts.
    """
    place = placements.by_chunk[(task.id, chunk_id)]
    tables = placements.tables
    dur_min = place.duration_minutes

    fit_w = problem.weights.time_of_day_fit_per_15min
    ctx_cfg = placements.ctx_lookup.get(task.context)
    evaluator = FitCurveEvaluator(ctx_cfg.fit_curve) if (fit_w and ctx_cfg) else None
    has_soft_windows = any(not w.hard for w in task.preferred_windows) and (
        problem.weights.preferred_day_miss or problem.weights.preferred_time_miss_per_15min
    )
    prev = next((p for p in task.previous_placement if p.chunk_id == chunk_id), None)
    churn_w = problem.weights.churn_per_15min_moved * task.churn_multiplier
    prev_slot: int | None = None
    if prev is not None and churn_w:
        ps = datetime_to_slot(prev.start, problem.window.start)
        if 0 <= ps < tables.horizon:
            prev_slot = ps

    if evaluator is None and not has_soft_windows and prev_slot is None:
        return None

    table = [0] * tables.horizon
    for s in place.allowed_starts:
        cost = 0
        if evaluator is not None:
            cost += fit_w * fit_cost_at(problem, placements, task, dur_min, s, evaluator)
        if has_soft_windows:
            cost += preferred_window_cost_at(problem, placements, task, dur_min, s)
        if prev_slot is not None:
            cost += churn_w * abs(s - prev_slot)
        table[s] = cost
    return table
