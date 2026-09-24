"""Correctness oracle: hard-guarantee invariants + an independent objective
recomputation that must match the solver's reported breakdown EXACTLY.

Everything here mirrors the solver source line-by-line:
  - hard constraints: solver/model.py
  - objective components: solver/objective.py + solver/two_pass.py
  - slot arithmetic: solver/slots.py (reused directly, not reimplemented)
  - fit curve: solver/fit_curve.py (reused directly)

If the solver output ever fails this oracle, suspect the oracle first and
re-derive from source — the solver is presumed correct.
"""

from __future__ import annotations

from collections import defaultdict

from solver.fit_curve import FitCurveEvaluator
from solver.schema import Problem, Solution
from solver.slots import (
    SLOTS_PER_DAY,
    datetime_to_slot,
    duration_to_slots,
    slot_to_day_index,
    slot_to_time_of_day_minutes,
    slot_to_weekday,
    total_slots,
)

MINUTES_PER_DAY = 24 * 60


def _tod_minutes(time_obj) -> int:
    return time_obj.hour * 60 + time_obj.minute


# --------------------------------------------------------------------------
# Hard-guarantee invariants
# --------------------------------------------------------------------------

def assert_solution_valid(problem: Problem, solution: Solution) -> None:
    origin = problem.window.start
    horizon = total_slots(origin, problem.window.end)
    tasks_by_id = {t.id: t for t in problem.tasks}

    sched_by_task: dict[str, list] = defaultdict(list)
    for sc in solution.schedule:
        sched_by_task[sc.task_id].append(sc)
    dropped_ids = {d.task_id for d in solution.dropped}
    dropped_by_id = {d.task_id: d for d in solution.dropped}
    scheduled_ids = set(sched_by_task)

    # ---- partition: schedule ∪ dropped == tasks, disjoint ----
    all_ids = {t.id for t in problem.tasks}
    assert scheduled_ids.isdisjoint(dropped_ids), (
        f"task(s) both scheduled and dropped: {scheduled_ids & dropped_ids}"
    )
    assert scheduled_ids | dropped_ids == all_ids, (
        f"partition mismatch: extra={scheduled_ids | dropped_ids - all_ids} "
        f"missing={all_ids - (scheduled_ids | dropped_ids)}"
    )
    # Each dropped task appears at most once.
    assert len(dropped_ids) == len(solution.dropped), "duplicate dropped task"

    # ---- each scheduled task contributes exactly its chunk list, once each ----
    start_slot: dict[str, int] = {}
    end_slot: dict[str, int] = {}
    for tid in scheduled_ids:
        task = tasks_by_id[tid]
        expected = sorted(c.chunk_id for c in task.chunks)
        got = sorted(sc.chunk_id for sc in sched_by_task[tid])
        assert got == expected, f"task {tid}: chunk set {got} != {expected}"

    for sc in solution.schedule:
        s = datetime_to_slot(sc.start, origin)  # raises if misaligned
        d = duration_to_slots(sc.duration_minutes)
        assert s >= 0, f"chunk {sc.chunk_id} starts before window: slot {s}"
        assert s + d <= horizon, f"chunk {sc.chunk_id} ends after window end"
        start_slot[sc.chunk_id] = s
        end_slot[sc.chunk_id] = s + d

    # ---- NO overlap among scheduled chunks and external_pinned intervals ----
    intervals: list[tuple[int, int, str]] = []
    for sc in solution.schedule:
        intervals.append((start_slot[sc.chunk_id], end_slot[sc.chunk_id], sc.chunk_id))
    for ext in problem.external_pinned:
        es = datetime_to_slot(ext.start, origin)
        intervals.append((es, es + duration_to_slots(ext.duration_minutes), f"ext:{ext.id}"))
    intervals.sort()
    for (s1, e1, id1), (s2, e2, id2) in zip(intervals, intervals[1:], strict=False):
        assert e1 <= s2, f"overlap between {id1} [{s1},{e1}) and {id2} [{s2},{e2})"

    # ---- per-task hard constraints (only for SCHEDULED tasks) ----
    ext_slots = {
        ext.id: (datetime_to_slot(ext.start, origin),
                 datetime_to_slot(ext.start, origin) + duration_to_slots(ext.duration_minutes))
        for ext in problem.external_pinned
    }

    for tid in scheduled_ids:
        task = tasks_by_id[tid]
        chunk_ids = [c.chunk_id for c in task.chunks]
        first_id = chunk_ids[0]
        last_id = chunk_ids[-1]

        # pinned_at: first chunk starts exactly at pinned_at.
        if task.pinned_at is not None:
            pin = datetime_to_slot(task.pinned_at, origin)
            assert start_slot[first_id] == pin, (
                f"task {tid} pinned at slot {pin} but first chunk at {start_slot[first_id]}"
            )

        # hard deadline: every chunk ends <= deadline.
        if task.deadline is not None and task.deadline.hard:
            dl = datetime_to_slot(task.deadline.at, origin)
            for cid in chunk_ids:
                assert end_slot[cid] <= dl, f"task {tid} chunk {cid} misses hard deadline"

        # earliest_start: every chunk starts >= earliest_start.
        es = datetime_to_slot(task.earliest_start, origin)
        for cid in chunk_ids:
            assert start_slot[cid] >= es, f"task {tid} chunk {cid} before earliest_start"

        # hard preferred windows: each chunk fits entirely in EACH hard window.
        for w in task.preferred_windows:
            if not w.hard:
                continue
            win_start = _tod_minutes(w.start)
            win_end = _tod_minutes(w.end)
            for cid, chunk in zip(chunk_ids, task.chunks, strict=True):
                s = start_slot[cid]
                tod = slot_to_time_of_day_minutes(s, origin)
                wd = slot_to_weekday(s, origin)
                dur = chunk.duration_minutes
                assert wd in w.days, f"task {tid} chunk {cid} hard-window weekday {wd} not allowed"
                assert tod >= win_start, f"task {tid} chunk {cid} starts before hard window"
                assert tod + dur <= win_end, f"task {tid} chunk {cid} extends past hard window"
                assert tod + dur <= MINUTES_PER_DAY

        # availability_windows: each chunk fits entirely inside >= 1 window.
        if task.availability_windows:
            win_slots = [
                (datetime_to_slot(w.start, origin), datetime_to_slot(w.end, origin))
                for w in task.availability_windows
            ]
            for cid in chunk_ids:
                s, e = start_slot[cid], end_slot[cid]
                assert any(ws <= s and e <= we for ws, we in win_slots), (
                    f"task {tid} chunk {cid} outside all availability windows"
                )

        # business hours: only when no pin, no hard window, no availability mask.
        bh = problem.business_hours
        if (
            bh is not None
            and task.pinned_at is None
            and not any(pw.hard for pw in task.preferred_windows)
            and not task.availability_windows
        ):
            bh_start = _tod_minutes(bh.start)
            bh_end = _tod_minutes(bh.end)
            for cid, chunk in zip(chunk_ids, task.chunks, strict=True):
                s = start_slot[cid]
                tod = slot_to_time_of_day_minutes(s, origin)
                wd = slot_to_weekday(s, origin)
                dur = chunk.duration_minutes
                assert wd in bh.days, f"task {tid} chunk {cid} business-hours weekday {wd}"
                assert tod >= bh_start, f"task {tid} chunk {cid} before business hours"
                assert tod + dur <= bh_end, f"task {tid} chunk {cid} past business hours"
                assert tod + dur <= MINUTES_PER_DAY

        # group_policy.same_day / ordered.
        if len(chunk_ids) > 1:
            if task.group_policy.same_day:
                days = {start_slot[cid] // SLOTS_PER_DAY for cid in chunk_ids}
                assert len(days) == 1, f"task {tid} same_day violated: day-indices {days}"
            if task.group_policy.ordered:
                for prev, nxt in zip(chunk_ids, chunk_ids[1:], strict=False):
                    assert end_slot[prev] <= start_slot[nxt], (
                        f"task {tid} ordered violated: {prev} !<= {nxt}"
                    )

        # hard dependencies: enforced only when BOTH endpoints are scheduled
        # (a dropped ref makes the constraint vacuous; events are always present).
        my_first = start_slot[first_id]
        my_last_end = end_slot[last_id]
        for dep in task.dependencies:
            if not dep.hard:
                continue
            if dep.type == "after_task":
                if dep.ref in scheduled_ids:
                    other = tasks_by_id[dep.ref]
                    other_last_end = end_slot[other.chunks[-1].chunk_id]
                    assert my_first >= other_last_end, (
                        f"task {tid} after_task {dep.ref} violated"
                    )
            elif dep.type == "before_task":
                if dep.ref in scheduled_ids:
                    other = tasks_by_id[dep.ref]
                    other_first = start_slot[other.chunks[0].chunk_id]
                    assert my_last_end <= other_first, (
                        f"task {tid} before_task {dep.ref} violated"
                    )
            elif dep.type == "after_event":
                if dep.ref in ext_slots:
                    assert my_first >= ext_slots[dep.ref][1], (
                        f"task {tid} after_event {dep.ref} violated"
                    )
            elif dep.type == "before_event":
                if dep.ref in ext_slots:
                    assert my_last_end <= ext_slots[dep.ref][0], (
                        f"task {tid} before_event {dep.ref} violated"
                    )

    # ---- must_include: scheduled UNLESS demoted-unplaceable ----
    for task in problem.tasks:
        if not task.must_include:
            continue
        if task.id in scheduled_ids:
            continue
        assert task.id in dropped_ids, f"must_include task {task.id} neither scheduled nor dropped"
        assert dropped_by_id[task.id].reason == "must_include_unplaceable_in_isolation", (
            f"must_include task {task.id} dropped for wrong reason: "
            f"{dropped_by_id[task.id].reason}"
        )


# --------------------------------------------------------------------------
# Objective oracle
# --------------------------------------------------------------------------

def assert_objective_consistent(problem: Problem, solution: Solution) -> None:
    """Independently recompute every objective component from the returned
    schedule and compare EXACTLY to solution.objective.components."""
    origin = problem.window.start
    horizon = total_slots(origin, problem.window.end)
    w = problem.weights
    ctx_lookup = {c.context: c for c in problem.contexts}

    dropped_ids = {d.task_id for d in solution.dropped}
    scheduled_ids = {sc.task_id for sc in solution.schedule}
    start_slot = {sc.chunk_id: datetime_to_slot(sc.start, origin) for sc in solution.schedule}

    # ---- drop ----
    drop = 0
    for task in problem.tasks:
        if task.id in dropped_ids:
            drop += w.base_drop_penalty + task.priority * w.priority_unit

    # ---- lateness (soft deadlines only) ----
    lateness = 0
    for task in problem.tasks:
        if task.deadline is None or task.deadline.hard:
            continue
        dl = datetime_to_slot(task.deadline.at, origin)
        pen = task.deadline.penalty_per_15min
        if task.id in scheduled_ids:
            if task.group_policy.ordered:
                last = task.chunks[-1]
                end_max = start_slot[last.chunk_id] + duration_to_slots(last.duration_minutes)
            else:
                end_max = max(
                    start_slot[c.chunk_id] + duration_to_slots(c.duration_minutes)
                    for c in task.chunks
                )
        else:
            # Dropped: its start vars appear ONLY in the (ungated) lateness term,
            # so the minimiser drives end to its independent minimum.
            if task.group_policy.ordered:
                end_max = sum(duration_to_slots(c.duration_minutes) for c in task.chunks)
            else:
                end_max = max(duration_to_slots(c.duration_minutes) for c in task.chunks)
        lateness += max(0, end_max - dl) * pen

    # ---- fit (scheduled chunks only; dropped gated to 0) ----
    fit = 0
    if w.time_of_day_fit_per_15min:
        for sc in solution.schedule:
            cfg = ctx_lookup.get(sc.context)
            if cfg is None:
                continue
            ev = FitCurveEvaluator(cfg.fit_curve)
            s = start_slot[sc.chunk_id]
            mod = slot_to_time_of_day_minutes(s, origin)
            dur_min = sc.duration_minutes
            if mod + dur_min > MINUTES_PER_DAY:
                score = 100 * (dur_min // 15)
            else:
                score = ev.score_for_chunk(mod, dur_min) + ev.score_at_minute_of_day(mod + dur_min)
            fit += score * w.time_of_day_fit_per_15min

    # ---- churn (scheduled chunks with an in-window previous placement) ----
    churn = 0
    if w.churn_per_15min_moved:
        for task in problem.tasks:
            if task.id not in scheduled_ids:
                continue
            tw = w.churn_per_15min_moved * task.churn_multiplier
            if tw == 0:
                continue
            prev_by = {p.chunk_id: p for p in task.previous_placement}
            for chunk in task.chunks:
                p = prev_by.get(chunk.chunk_id)
                if p is None:
                    continue
                prev_slot = datetime_to_slot(p.start, origin)
                if prev_slot < 0 or prev_slot >= horizon:
                    continue
                churn += abs(start_slot[chunk.chunk_id] - prev_slot) * tw

    # ---- daily_cap ----
    daily_cap = 0
    days = horizon // SLOTS_PER_DAY
    ctx_chunks: dict[str, list] = defaultdict(list)
    for sc in solution.schedule:
        ctx_chunks[sc.context].append(sc)
    for ctx_name, cfg in ctx_lookup.items():
        if cfg.max_minutes_per_day is None:
            continue
        penalty = cfg.over_daily_cap_penalty_per_15min
        if penalty == 0:
            continue
        cap_slots = cfg.max_minutes_per_day // 15
        for day in range(days):
            day_start = day * SLOTS_PER_DAY
            day_end = (day + 1) * SLOTS_PER_DAY
            used = 0
            for sc in ctx_chunks.get(ctx_name, []):
                s = start_slot[sc.chunk_id]
                e = s + duration_to_slots(sc.duration_minutes)
                used += max(0, min(e, day_end) - max(s, day_start))
            daily_cap += max(0, used - cap_slots) * penalty

    # ---- streak_cap ----
    streak_cap = 0
    for sc in solution.schedule:
        cfg = ctx_lookup.get(sc.context)
        if cfg is None or cfg.max_contiguous_minutes is None:
            continue
        cap_slots = cfg.max_contiguous_minutes // 15
        dur_slots = duration_to_slots(sc.duration_minutes)
        if dur_slots > cap_slots:
            streak_cap += (dur_slots - cap_slots) * cfg.over_streak_cap_penalty_per_15min

    # ---- preferred_window (soft windows; scheduled chunks only) ----
    preferred_window = 0
    day_w = w.preferred_day_miss
    time_w = w.preferred_time_miss_per_15min
    if day_w or time_w:
        days_in_horizon = max(horizon // SLOTS_PER_DAY, 1)
        weekday_of_day = [
            slot_to_weekday(d * SLOTS_PER_DAY, origin) for d in range(days_in_horizon)
        ]
        max_day_gap = days_in_horizon
        max_time_units = MINUTES_PER_DAY // 15
        for task in problem.tasks:
            if task.id not in scheduled_ids:
                continue
            soft = [pw for pw in task.preferred_windows if not pw.hard]
            if not soft:
                continue
            win_minutes = [
                (_tod_minutes(pw.start), _tod_minutes(pw.end), set(pw.days)) for pw in soft
            ]
            for chunk in task.chunks:
                s = start_slot[chunk.chunk_id]
                dur_min = chunk.duration_minutes
                tod = slot_to_time_of_day_minutes(s, origin)
                wd = slot_to_weekday(s, origin)
                day_idx = slot_to_day_index(s, origin)
                if tod + dur_min > MINUTES_PER_DAY:
                    preferred_window += day_w * max_day_gap + time_w * max_time_units
                    continue
                best = None
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
                    tgap = max(0, win_start - tod) + max(0, (tod + dur_min) - win_end)
                    cost = day_w * dgap + time_w * (tgap // 15)
                    best = cost if best is None else min(best, cost)
                preferred_window += best if best is not None else 0

    comps = solution.objective.components
    computed = {
        "drop": drop,
        "lateness": lateness,
        "fit": fit,
        "churn": churn,
        "daily_cap": daily_cap,
        "streak_cap": streak_cap,
        "preferred_window": preferred_window,
    }
    reported = {
        "drop": comps.drop,
        "lateness": comps.lateness,
        "fit": comps.fit,
        "churn": comps.churn,
        "daily_cap": comps.daily_cap,
        "streak_cap": comps.streak_cap,
        "preferred_window": comps.preferred_window,
    }
    for key in computed:
        assert computed[key] == reported[key], (
            f"objective component {key}: oracle {computed[key]} != solver {reported[key]}"
        )

    total = sum(computed.values())
    assert total == solution.objective.total, (
        f"objective total: oracle {total} != solver {solution.objective.total}"
    )
    assert total == sum(reported.values()), "reported components do not sum to reported total"
