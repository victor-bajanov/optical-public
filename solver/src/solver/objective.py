"""Soft objective terms for the CP-SAT model.

Each function returns a list of (cp_model.IntVar, weight) tuples that should
be summed into the model's Minimize. Component-wise accumulators are exposed
so the post-solve report can break the objective down.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from solver.fit_curve import FitCurveEvaluator
from solver.model import ModelArtifacts
from solver.schema import ContextConfig
from solver.slots import (
    SLOTS_PER_DAY,
    datetime_to_slot,
    duration_to_slots,
    slot_to_day_index,
    slot_to_time_of_day_minutes,
    slot_to_weekday,
)


@dataclass
class ObjectiveTerms:
    lateness: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)
    fit: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)
    churn: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)
    daily_cap: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)
    streak_cap: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)
    drop: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)
    preferred_window: list[tuple[cp_model.IntVar, int]] = field(default_factory=list)

    def all_terms(self) -> list[tuple[cp_model.IntVar, int]]:
        return [
            *self.lateness,
            *self.fit,
            *self.churn,
            *self.daily_cap,
            *self.streak_cap,
            *self.drop,
            *self.preferred_window,
        ]


def drop_penalty_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """Pass 1 objective: sum of base_drop_penalty + priority * priority_unit for dropped tasks."""
    base = art.problem.weights.base_drop_penalty
    pu = art.problem.weights.priority_unit
    out: list[tuple[cp_model.IntVar, int]] = []
    for task in art.problem.tasks:
        if task.id in art.task_dropped:
            weight = base + task.priority * pu
            out.append((art.task_dropped[task.id], weight))
    return out


def lateness_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """For each soft deadline: sum of ceil((end - deadline)/15) * penalty_per_15min, clamped >= 0."""
    model = art.model
    horizon = art.horizon_slots
    out: list[tuple[cp_model.IntVar, int]] = []
    for task in art.problem.tasks:
        if task.deadline is None or task.deadline.hard:
            continue
        dl_slot = datetime_to_slot(task.deadline.at, art.problem.window.start)
        # Only the last chunk's end matters for lateness (the task is "done" when
        # the final chunk ends). For multi-chunk tasks we use the max end across
        # chunks — equivalent under ordered=False since any chunk could be the
        # latest one and CP-SAT will minimise the worst.
        last_end = task.chunks[-1].chunk_id if task.group_policy.ordered else None
        if last_end is not None:
            chunk_ends = [art.chunk_ends[last_end]]
        else:
            chunk_ends = [art.chunk_ends[c.chunk_id] for c in task.chunks]
        end_max = model.NewIntVar(0, horizon, f"end_max:{task.id}")
        model.AddMaxEquality(end_max, chunk_ends)
        late = model.NewIntVar(0, horizon, f"late:{task.id}")
        model.AddMaxEquality(late, [end_max - dl_slot, 0])
        # Gate on presence so a DROPPED task pays only its drop penalty. An
        # unpinned dropped task's chunks float and zero this out anyway, but a
        # PINNED dropped task's start is fixed (pins are not presence-gated),
        # which used to charge phantom lateness — a constant that never changed
        # placements, only inflated the reported objective.
        presence = art.chunk_presence[task.chunks[0].chunk_id]
        gated = model.NewIntVar(0, horizon, f"late_g:{task.id}")
        model.AddMultiplicationEquality(gated, [late, presence])
        out.append((gated, task.deadline.penalty_per_15min))
    return out


def _context_lookup(art: ModelArtifacts) -> dict[str, ContextConfig]:
    return {c.context: c for c in art.problem.contexts}


def fit_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """For each chunk, fit_score = sum over slots of fit_curve_distance(context, slot_min_of_day).

    We pre-compute a table fit_score[start_slot] for each chunk (it depends only on
    chunk duration and starting slot's time-of-day), then bind a per-chunk fit_var
    via AddElement. Multiply by time_of_day_fit_per_15min and presence.
    """
    model = art.model
    origin = art.problem.window.start
    horizon = art.horizon_slots
    fit_weight = art.problem.weights.time_of_day_fit_per_15min
    ctx_lookup = _context_lookup(art)

    out: list[tuple[cp_model.IntVar, int]] = []
    if fit_weight == 0:
        return out

    for cid in art.chunk_ids:
        ctx_name = art.chunk_context[cid]
        if ctx_name not in ctx_lookup:
            continue
        ctx_cfg = ctx_lookup[ctx_name]
        evaluator = FitCurveEvaluator(ctx_cfg.fit_curve)
        dur_min = art.chunk_duration_slots[cid] * 15
        dur_slots = art.chunk_duration_slots[cid]
        table = []
        for s in range(horizon - dur_slots + 1):
            minute_of_day = slot_to_time_of_day_minutes(s, origin)
            # forbid crossing midnight: clip if (minute_of_day + dur_min) > 1440
            if minute_of_day + dur_min > 24 * 60:
                table.append(100 * (dur_min // 15))  # max penalty for crossing midnight
            else:
                # Score the chunk's slots plus its trailing edge so that a chunk
                # ending exactly at peak_end (e.g. 12:00) is preferred over one
                # whose tail extends past peak_end.
                score = evaluator.score_for_chunk(minute_of_day, dur_min)
                score += evaluator.score_at_minute_of_day(minute_of_day + dur_min)
                table.append(score)
        # pad the end (start values that violate `start <= horizon - dur`) with sentinel
        while len(table) < horizon:
            table.append(table[-1] if table else 0)
        fit_var = model.NewIntVar(0, max(table) if table else 0, f"fit:{cid}")
        model.AddElement(art.chunk_starts[cid], table, fit_var)
        # Multiply by presence: weighted = fit_var iff present, else 0
        weighted = model.NewIntVar(0, max(table) if table else 0, f"fit_w:{cid}")
        model.AddMultiplicationEquality(weighted, [fit_var, art.chunk_presence[cid]])
        out.append((weighted, fit_weight))
    return out


def churn_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """For each chunk with a previous_placement, |new_start - previous_start| / 15 * weight."""
    model = art.model
    weight = art.problem.weights.churn_per_15min_moved
    out: list[tuple[cp_model.IntVar, int]] = []
    if weight == 0:
        return out
    horizon = art.horizon_slots
    for task in art.problem.tasks:
        task_weight = weight * task.churn_multiplier
        if task_weight == 0:
            continue
        prev_by_chunk = {p.chunk_id: p for p in task.previous_placement}
        for chunk in task.chunks:
            prev = prev_by_chunk.get(chunk.chunk_id)
            if prev is None:
                continue
            prev_slot = datetime_to_slot(prev.start, art.problem.window.start)
            # A previous_placement outside the current window — typical when
            # the last committed plan was for a different week — has no
            # meaningful churn distance to a slot inside this window, and
            # |start - prev_slot| exceeds diff's domain → pass 2 becomes
            # infeasible. Skip silently rather than blow up.
            if prev_slot < 0 or prev_slot >= horizon:
                continue
            start = art.chunk_starts[chunk.chunk_id]
            diff = model.NewIntVar(-art.horizon_slots, art.horizon_slots, f"diff:{chunk.chunk_id}")
            model.Add(diff == start - prev_slot)
            abs_diff = model.NewIntVar(0, art.horizon_slots, f"abs:{chunk.chunk_id}")
            model.AddAbsEquality(abs_diff, diff)
            # multiply by presence (dropped tasks should not pay churn)
            gated = model.NewIntVar(0, art.horizon_slots, f"churn_g:{chunk.chunk_id}")
            model.AddMultiplicationEquality(gated, [abs_diff, art.chunk_presence[chunk.chunk_id]])
            out.append((gated, task_weight))
    return out


def daily_cap_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """For each (context, day): over_cap_slots = max(0, slots_used - cap_slots) * penalty."""
    model = art.model
    horizon = art.horizon_slots
    days = horizon // SLOTS_PER_DAY
    ctx_lookup = _context_lookup(art)
    out: list[tuple[cp_model.IntVar, int]] = []

    # Group chunks by context
    by_ctx: dict[str, list[str]] = {}
    for cid in art.chunk_ids:
        by_ctx.setdefault(art.chunk_context[cid], []).append(cid)

    for ctx_name, chunk_ids in by_ctx.items():
        cfg = ctx_lookup.get(ctx_name)
        if cfg is None or cfg.max_minutes_per_day is None:
            continue
        cap_slots = cfg.max_minutes_per_day // 15
        penalty = cfg.over_daily_cap_penalty_per_15min
        if penalty == 0:
            continue
        for day in range(days):
            day_start = day * SLOTS_PER_DAY
            day_end = (day + 1) * SLOTS_PER_DAY
            # slots_used = sum over chunks of overlap-with-day
            overlap_vars: list[cp_model.IntVar] = []
            for cid in chunk_ids:
                ov = _overlap_with_window(art, cid, day_start, day_end)
                overlap_vars.append(ov)
            total = model.NewIntVar(0, SLOTS_PER_DAY, f"used:{ctx_name}:{day}")
            model.Add(total == sum(overlap_vars))
            over = model.NewIntVar(0, SLOTS_PER_DAY, f"over:{ctx_name}:{day}")
            model.AddMaxEquality(over, [total - cap_slots, 0])
            out.append((over, penalty))
    return out


def _overlap_with_window(
    art: ModelArtifacts,
    cid: str,
    win_start: int,
    win_end: int,
) -> cp_model.IntVar:
    """Number of slots chunk `cid` overlaps with [win_start, win_end), 0 if absent."""
    model = art.model
    dur = art.chunk_duration_slots[cid]
    start = art.chunk_starts[cid]
    end = art.chunk_ends[cid]
    present = art.chunk_presence[cid]

    # raw overlap = max(0, min(end, win_end) - max(start, win_start))
    min_end = model.NewIntVar(0, art.horizon_slots, f"me:{cid}:{win_start}")
    model.AddMinEquality(min_end, [end, model.NewConstant(win_end)])
    max_start = model.NewIntVar(0, art.horizon_slots, f"ms:{cid}:{win_start}")
    model.AddMaxEquality(max_start, [start, model.NewConstant(win_start)])
    raw = model.NewIntVar(-art.horizon_slots, art.horizon_slots, f"raw:{cid}:{win_start}")
    model.Add(raw == min_end - max_start)
    clipped = model.NewIntVar(0, dur, f"clip:{cid}:{win_start}")
    model.AddMaxEquality(clipped, [raw, 0])
    # gate by presence
    gated = model.NewIntVar(0, dur, f"olg:{cid}:{win_start}")
    model.AddMultiplicationEquality(gated, [clipped, present])
    return gated


def streak_cap_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """Penalise contiguous runs of same-context chunks exceeding the streak cap.

    We approximate by per-chunk excess: any single chunk whose duration exceeds
    the streak cap pays (duration - cap) * penalty. (Multi-chunk runs without
    an intervening different-context gap are rare in practice — the daily cap
    plus chunk-duration penalty together handle most of this. The Worker is
    expected to chunk long deep-work tasks into <= streak-cap sized pieces.)
    """
    out: list[tuple[cp_model.IntVar, int]] = []
    model = art.model
    ctx_lookup = _context_lookup(art)
    for cid in art.chunk_ids:
        ctx_name = art.chunk_context[cid]
        cfg = ctx_lookup.get(ctx_name)
        if cfg is None or cfg.max_contiguous_minutes is None:
            continue
        cap_slots = cfg.max_contiguous_minutes // 15
        dur = art.chunk_duration_slots[cid]
        if dur <= cap_slots:
            continue
        # Constant over_slots; gated by presence so dropped chunks pay nothing.
        excess = dur - cap_slots
        var = model.NewIntVar(0, excess, f"streak:{cid}")
        model.AddMultiplicationEquality(var, [model.NewConstant(excess), art.chunk_presence[cid]])
        out.append((var, cfg.over_streak_cap_penalty_per_15min))
    return out


def preferred_window_terms(art: ModelArtifacts) -> list[tuple[cp_model.IntVar, int]]:
    """Distance-graded penalty for placing a chunk away from a task's soft
    preferred_windows. PASS-2 ONLY (wired via build_terms into the full
    objective; pass 1 minimises only drop_penalty_terms), so it biases *where*
    a kept task lands and never causes a drop.

    Per candidate start slot s, penalty =
        min over soft windows w of
            preferred_day_miss            * day_gap_days(s, w)
          + preferred_time_miss_per_15min * (time_gap_minutes(s, w) // 15)
    The weights are baked into the precomputed table; the term weight is 1.
    """
    model = art.model
    origin = art.problem.window.start
    horizon = art.horizon_slots
    day_w = art.problem.weights.preferred_day_miss
    time_w = art.problem.weights.preferred_time_miss_per_15min

    out: list[tuple[cp_model.IntVar, int]] = []
    if day_w == 0 and time_w == 0:
        return out

    days_in_horizon = max(horizon // SLOTS_PER_DAY, 1)
    weekday_of_day = [slot_to_weekday(d * SLOTS_PER_DAY, origin) for d in range(days_in_horizon)]
    max_day_gap = days_in_horizon  # unreachable preferred day → flat max day gap
    max_time_units = (24 * 60) // 15

    for task in art.problem.tasks:
        soft = [w for w in task.preferred_windows if not w.hard]
        if not soft:
            continue
        # Pre-extract each window's [start, end) minutes and preferred-day set.
        win_minutes = [
            (w.start.hour * 60 + w.start.minute, w.end.hour * 60 + w.end.minute, set(w.days))
            for w in soft
        ]
        for chunk in task.chunks:
            dur_min = chunk.duration_minutes
            dur_slots = duration_to_slots(dur_min)
            table: list[int] = []
            for s in range(horizon - dur_slots + 1):
                tod = slot_to_time_of_day_minutes(s, origin)
                wd = slot_to_weekday(s, origin)
                day_idx = slot_to_day_index(s, origin)
                if tod + dur_min > 24 * 60:
                    # Crosses midnight: never a valid placement. Max-penalise so
                    # it is chosen only when nothing else is feasible (no BH).
                    table.append(day_w * max_day_gap + time_w * max_time_units)
                    continue
                best: int | None = None
                for win_start, win_end, win_days in win_minutes:
                    if wd in win_days:
                        dgap = 0
                    else:
                        cands = [
                            abs(d - day_idx)
                            for d in range(days_in_horizon)
                            if weekday_of_day[d] in win_days
                        ]
                        dgap = min(cands) if cands else max_day_gap
                    tgap_min = max(0, win_start - tod) + max(0, (tod + dur_min) - win_end)
                    cost = day_w * dgap + time_w * (tgap_min // 15)
                    best = cost if best is None else min(best, cost)
                table.append(best if best is not None else 0)
            # pad invalid tail starts so the table length covers the AddElement domain
            while len(table) < horizon:
                table.append(table[-1] if table else 0)

            upper = max(table) if table else 0
            cid = chunk.chunk_id
            miss = model.NewIntVar(0, upper, f"pwmiss:{cid}")
            model.AddElement(art.chunk_starts[cid], table, miss)
            gated = model.NewIntVar(0, upper, f"pwmiss_g:{cid}")
            model.AddMultiplicationEquality(gated, [miss, art.chunk_presence[cid]])
            out.append((gated, 1))
    return out


def build_terms(art: ModelArtifacts) -> ObjectiveTerms:
    t = ObjectiveTerms()
    t.drop = drop_penalty_terms(art)
    t.lateness = lateness_terms(art)
    t.fit = fit_terms(art)
    t.churn = churn_terms(art)
    t.daily_cap = daily_cap_terms(art)
    t.streak_cap = streak_cap_terms(art)
    t.preferred_window = preferred_window_terms(art)
    return t


def attach_full_objective(
    art: ModelArtifacts,
    scheduled_task_ids: set[str] | None,
    dropped_task_ids: set[str],
) -> ObjectiveTerms:
    """Attach the full §4 objective. If scheduled/dropped are frozen (pass 2),
    add constraints that lock task_dropped to that partition.
    """
    if scheduled_task_ids is not None:
        for tid in scheduled_task_ids:
            if tid in art.task_dropped:
                art.model.Add(art.task_dropped[tid] == 0)
        for tid in dropped_task_ids:
            if tid in art.task_dropped:
                art.model.Add(art.task_dropped[tid] == 1)
    terms = build_terms(art)
    expr = sum(v * w for v, w in terms.all_terms())
    art.model.Minimize(expr)
    return terms
