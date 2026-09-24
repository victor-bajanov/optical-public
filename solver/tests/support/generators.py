"""Deterministic, seeded problem generators for the correctness + perf harness.

Every generator returns a plain JSON-shaped ``dict`` that ``Problem.model_validate``
accepts. All randomness flows through a ``random.Random(seed)`` instance passed in
or created from an integer seed — there is NO reliance on global ``random`` or on
wall-clock time, so a given ``(scenario, seed)`` is byte-for-byte reproducible.

Key invariants the generators uphold (mirroring the Worker guarantees the solver
relies on, see build-problem.ts / CLAUDE.md):

- external_pinned events are mutually disjoint (grid-placed on hourly cells).
- movable-meeting availability_windows always include the meeting's current slot,
  and every meeting's current slot is disjoint from all externals and from each
  other, so the must_include set is jointly feasible (no spurious 422).
- previous placements and pins are 15-minute aligned and inside the window,
  landing on weekdays within 08:00-17:00.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta

# ----- window / calendar constants (Mon 2026-05-18 .. Mon 2026-05-25) -----
WINDOW_START = datetime(2026, 5, 18, 0, 0, 0)
WINDOW_END = datetime(2026, 5, 25, 0, 0, 0)
TZ = "Australia/Sydney"

# Monday..Friday of the planning window.
WEEKDAY_DATES = [datetime(2026, 5, d) for d in (18, 19, 20, 21, 22)]
WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri"]

_TASK_CONTEXTS = ["deep", "admin", "physical"]

# Soft preferred-window time-of-day per task context.
_SOFT_WINDOW = {
    "deep": ("09:00", "12:00"),
    "admin": ("13:00", "17:00"),
    "physical": ("16:00", "18:00"),
}


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _weights() -> dict:
    return {
        "time_of_day_fit_per_15min": 5,
        "churn_per_15min_moved": 10,
        "priority_unit": 1,
        "base_drop_penalty": 200,
        "preferred_day_miss": 40,
        "preferred_time_miss_per_15min": 5,
    }


def _contexts() -> list[dict]:
    return [
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
        {
            "context": "meeting",
            "fit_curve": {"peak_start": "10:00", "peak_end": "11:00", "falloff_end": "17:00"},
            "max_minutes_per_day": 180,
            "max_contiguous_minutes": 120,
            "over_daily_cap_penalty_per_15min": 25,
            "over_streak_cap_penalty_per_15min": 25,
        },
    ]


def _business_hours() -> dict:
    return {"days": list(WEEKDAY_NAMES), "start": "08:00", "end": "18:00"}


def _cell_pool(rng: random.Random) -> list[datetime]:
    """Hourly cells 08:00..16:00 on each weekday, shuffled. A 60-minute event
    placed on a cell never overlaps its neighbour, so any prefix of this list
    is a set of mutually-disjoint start times."""
    cells = [d.replace(hour=h) for d in WEEKDAY_DATES for h in range(8, 17)]
    rng.shuffle(cells)
    return cells


def _external(idx: int, start: datetime, dur_min: int, context: str = "meeting") -> dict:
    return {
        "id": f"ext-{idx}",
        "title": f"External {idx}",
        "start": _iso(start),
        "duration_minutes": dur_min,
        "context": context,
    }


def _rand_prev_start(rng: random.Random) -> datetime:
    day = rng.choice(WEEKDAY_DATES)
    hour = rng.randint(8, 16)
    minute = rng.choice([0, 15, 30, 45])
    return day.replace(hour=hour, minute=minute)


def _make_task(
    rng: random.Random,
    tid: str,
    *,
    context: str,
    multichunk: bool,
    soft_deadline: bool,
    hard_deadline: bool,
    soft_window: bool,
    hard_window: bool,
) -> dict:
    priority = rng.randint(30, 90)

    if multichunk:
        n_chunks = rng.choice([2, 3])
        dur = rng.choice([30, 45, 60])
    else:
        n_chunks = 1
        dur = rng.choice([30, 45, 60, 90])

    chunks = [{"chunk_id": f"{tid}#{i}", "duration_minutes": dur} for i in range(n_chunks)]

    group_policy = {"same_day": False, "ordered": False}
    if multichunk:
        group_policy["ordered"] = rng.random() < 0.4
        group_policy["same_day"] = rng.random() < 0.4

    deadline = None
    if hard_deadline:
        # Comfortable: Friday 17:00 — placeable Mon-Fri with room to spare.
        deadline = {"at": "2026-05-22T17:00:00", "hard": True, "penalty_per_15min": 0}
    elif soft_deadline:
        # Mid/late-week soft deadline: always >> total task duration in slots, so
        # a dropped task's independent lateness minimum is 0 (see invariants oracle).
        at = rng.choice(
            ["2026-05-20T17:00:00", "2026-05-21T17:00:00", "2026-05-22T17:00:00"]
        )
        deadline = {"at": at, "hard": False, "penalty_per_15min": rng.choice([15, 21, 30])}

    earliest_start = _iso(WINDOW_START)
    if rng.random() < 0.15:
        earliest_start = "2026-05-19T08:00:00"

    preferred_windows: list[dict] = []
    if hard_window:
        preferred_windows.append(
            {"days": list(WEEKDAY_NAMES), "start": "08:00", "end": "18:00", "hard": True}
        )
    elif soft_window:
        ws, we = _SOFT_WINDOW[context]
        preferred_windows.append(
            {"days": list(WEEKDAY_NAMES), "start": ws, "end": we, "hard": False}
        )

    return {
        "id": tid,
        "title": f"Task {tid}",
        "context": context,
        "priority": priority,
        "chunks": chunks,
        "group_policy": group_policy,
        "deadline": deadline,
        "earliest_start": earliest_start,
        "preferred_windows": preferred_windows,
        "dependencies": [],
        "pinned_at": None,
        "previous_placement": [],
    }


def _assign_packed_prevs(rng: random.Random, tasks: list[dict], prev_prob: float) -> None:
    """Assign REALISTIC previous placements: a prior solve's schedule packed onto
    a mutually-disjoint grid inside business hours (Mon-Fri 08:00-17:00). This is
    what a real replan's previous_placement looks like — disjoint intervals near
    the current calendar, NOT randomly scattered overlaps (which would force an
    artificial churn-vs-everything shuffle that never happens in production).

    Chunks are placed greedily in task order, advancing a day cursor and wrapping
    to the next weekday when a chunk would spill past 17:00. Tasks are opted in
    per prev_prob; once the week's grid is exhausted, remaining tasks get none.
    """
    day_idx = 0
    minute = 8 * 60  # 08:00
    day_end = 17 * 60
    for task in tasks:
        if rng.random() >= prev_prob:
            continue
        for chunk in task["chunks"]:
            dur = chunk["duration_minutes"]
            # Occasional organic gap between prior meetings.
            if rng.random() < 0.25:
                minute += 15
            if minute + dur > day_end:
                day_idx += 1
                minute = 8 * 60
            if day_idx >= len(WEEKDAY_DATES):
                return  # grid exhausted; leave the rest without prevs
            start = WEEKDAY_DATES[day_idx].replace(hour=minute // 60, minute=minute % 60)
            task["previous_placement"].append(
                {"chunk_id": chunk["chunk_id"], "start": _iso(start)}
            )
            minute += dur


def _assign_scattered_prevs(rng: random.Random, tasks: list[dict], prev_prob: float) -> None:
    """Adversarial previous placements: independently random weekday slots that
    freely OVERLAP each other. Used only by scenario_adversarial_churn as a stress
    case — it makes churn contend against everything at once."""
    for task in tasks:
        for chunk in task["chunks"]:
            if rng.random() < prev_prob:
                task["previous_placement"].append(
                    {"chunk_id": chunk["chunk_id"], "start": _iso(_rand_prev_start(rng))}
                )


def _gen_tasks(
    rng: random.Random,
    n: int,
    *,
    prefix: str,
    n_hard_deadlines: int,
    n_hard_windows: int,
    prev_prob: float,
    prev_mode: str,  # "packed" | "scatter" | "none"
    multichunk_frac: float,
    soft_deadline_frac: float,
    soft_window_frac: float,
) -> list[dict]:
    tasks: list[dict] = []
    for i in range(n):
        context = _TASK_CONTEXTS[i % len(_TASK_CONTEXTS)]
        multichunk = rng.random() < multichunk_frac
        hard_deadline = i < n_hard_deadlines
        # Assign hard windows to a disjoint band of indices from the hard deadlines.
        hard_window = n_hard_deadlines <= i < (n_hard_deadlines + n_hard_windows)
        soft_deadline = (not hard_deadline) and rng.random() < soft_deadline_frac
        soft_window = (not hard_window) and rng.random() < soft_window_frac
        tasks.append(
            _make_task(
                rng,
                f"{prefix}-{i}",
                context=context,
                multichunk=multichunk,
                soft_deadline=soft_deadline,
                hard_deadline=hard_deadline,
                soft_window=soft_window,
                hard_window=hard_window,
            )
        )
    if prev_mode == "packed":
        _assign_packed_prevs(rng, tasks, prev_prob)
    elif prev_mode == "scatter":
        _assign_scattered_prevs(rng, tasks, prev_prob)
    return tasks


def _base_problem(tasks: list[dict], externals: list[dict]) -> dict:
    return {
        "window": {"start": _iso(WINDOW_START), "end": _iso(WINDOW_END), "tz": TZ},
        "weights": _weights(),
        "contexts": _contexts(),
        "tasks": tasks,
        "external_pinned": externals,
        "business_hours": _business_hours(),
    }


def _add_dependencies(rng: random.Random, tasks: list[dict], externals: list[dict]) -> None:
    """Add a few feasible hard dependencies to exercise the invariant paths.

    after_task/before_task chained across two adjacent single-chunk tasks, and an
    after_event anchored to the earliest external. All hard=True. A dropped ref
    makes the constraint vacuous (mirrors model.py), so these never force UNSAT.
    """
    if len(tasks) >= 4:
        # after_task: task[3] runs after task[2].
        tasks[3]["dependencies"].append(
            {"type": "after_task", "ref": tasks[2]["id"], "hard": True}
        )
    if externals:
        earliest = min(externals, key=lambda e: e["start"])
        tasks[1]["dependencies"].append(
            {"type": "after_event", "ref": earliest["id"], "hard": True}
        )


# --------------------------------------------------------------------------
# Named scenario builders
# --------------------------------------------------------------------------

def scenario_small(seed: int) -> dict:
    """~10 tasks, 5 disjoint externals, no previous placements."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        10,
        prefix="s",
        n_hard_deadlines=0,
        n_hard_windows=0,
        prev_prob=0.0,
        prev_mode="none",
        multichunk_frac=0.2,
        soft_deadline_frac=0.4,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([30, 45, 60])) for i in range(5)]
    return _base_problem(tasks, externals)


def scenario_typical(seed: int) -> dict:
    """~20 tasks mixed contexts, ~35% multi-chunk, ~50% soft deadlines + a couple
    hard, ~30% preferred windows (mostly soft, 1-2 hard), previous placements for
    most chunks, 10 disjoint externals."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        20,
        prefix="t",
        n_hard_deadlines=2,
        n_hard_windows=2,
        prev_prob=0.75,
        prev_mode="packed",
        multichunk_frac=0.35,
        soft_deadline_frac=0.5,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([30, 45, 60])) for i in range(10)]
    _add_dependencies(rng, tasks, externals)
    return _base_problem(tasks, externals)


def scenario_fresh_week(seed: int) -> dict:
    """scenario_typical WITHOUT any previous placements — the first plan of the
    week. A real, distinct workload: with no churn anchor the objective surface is
    a plateau, so CP-SAT reaches a (near-)optimal incumbent quickly but proving
    optimality is slow. Perf asserts a time budget + quality ceiling, not OPTIMAL."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        20,
        prefix="fw",
        n_hard_deadlines=2,
        n_hard_windows=2,
        prev_prob=0.0,
        prev_mode="none",
        multichunk_frac=0.35,
        soft_deadline_frac=0.5,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([30, 45, 60])) for i in range(10)]
    _add_dependencies(rng, tasks, externals)
    return _base_problem(tasks, externals)


def scenario_adversarial_churn(seed: int) -> dict:
    """~15 tasks with deliberately scattered, mutually OVERLAPPING previous
    placements — a churn stress case (looser budget). Every chunk is pulled toward
    a random prior slot, so churn contends against fit, caps and each other at once.
    Not representative of a real replan; kept purely to stress the solver."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        15,
        prefix="ac",
        n_hard_deadlines=1,
        n_hard_windows=1,
        prev_prob=1.0,
        prev_mode="scatter",
        multichunk_frac=0.4,
        soft_deadline_frac=0.5,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([30, 45, 60])) for i in range(8)]
    _add_dependencies(rng, tasks, externals)
    return _base_problem(tasks, externals)


def scenario_heavy(seed: int) -> dict:
    """~35 tasks + 15 disjoint externals + previous placements."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        35,
        prefix="h",
        n_hard_deadlines=2,
        n_hard_windows=2,
        prev_prob=0.7,
        prev_mode="packed",
        multichunk_frac=0.35,
        soft_deadline_frac=0.5,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([30, 45, 60])) for i in range(15)]
    _add_dependencies(rng, tasks, externals)
    return _base_problem(tasks, externals)


def scenario_meetings(seed: int) -> dict:
    """scenario_typical + 5 owned movable meetings. Each meeting: must_include,
    context meeting, availability_windows = 3 random 2h windows UNIONED with the
    meeting's current 1h slot (current slot MUST be present), previous_placement
    at current slot, churn_multiplier 5-10. Meeting current slots are disjoint
    from externals and from each other (drawn from the same shuffled cell pool)."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        20,
        prefix="m",
        n_hard_deadlines=2,
        n_hard_windows=2,
        prev_prob=0.75,
        prev_mode="packed",
        multichunk_frac=0.35,
        soft_deadline_frac=0.5,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([30, 45, 60])) for i in range(10)]
    _add_dependencies(rng, tasks, externals)

    # Meeting current slots: next 5 cells (disjoint from the 10 externals).
    for k in range(5):
        current = cells[10 + k]  # a weekday 08:00..16:00 hour cell
        current_end = current + timedelta(minutes=60)
        mid = f"meet-{k}"
        # 3 random 2h availability windows on weekdays.
        avail: list[dict] = []
        for _ in range(3):
            day = rng.choice(WEEKDAY_DATES)
            hour = rng.randint(8, 15)  # 2h window ends by 17:00
            ws = day.replace(hour=hour)
            avail.append({"start": _iso(ws), "end": _iso(ws + timedelta(hours=2))})
        # Union with the current 1h slot (worker guarantee: staying put feasible).
        avail.append({"start": _iso(current), "end": _iso(current_end)})
        tasks.append(
            {
                "id": mid,
                "title": f"Meeting {k}",
                "context": "meeting",
                "priority": rng.randint(50, 90),
                "chunks": [{"chunk_id": f"{mid}#0", "duration_minutes": 60}],
                "group_policy": {"same_day": False, "ordered": False},
                "deadline": None,
                "earliest_start": _iso(WINDOW_START),
                "preferred_windows": [],
                "dependencies": [],
                "pinned_at": None,
                "previous_placement": [{"chunk_id": f"{mid}#0", "start": _iso(current)}],
                "must_include": True,
                "availability_windows": avail,
                "churn_multiplier": rng.randint(5, 10),
            }
        )
    return _base_problem(tasks, externals)


def scenario_oversubscribed(seed: int) -> dict:
    """~50 tasks + 20 externals — more work than fits in business hours, so drops
    are expected."""
    rng = random.Random(seed)
    tasks = _gen_tasks(
        rng,
        50,
        prefix="o",
        n_hard_deadlines=1,
        n_hard_windows=1,
        prev_prob=0.6,
        prev_mode="packed",
        multichunk_frac=0.35,
        soft_deadline_frac=0.5,
        soft_window_frac=0.3,
    )
    cells = _cell_pool(rng)
    externals = [_external(i, cells[i], rng.choice([45, 60])) for i in range(20)]
    return _base_problem(tasks, externals)


def scenario_unsat(seed: int) -> dict:
    """Two must_include tasks pinned at the SAME slot (both individually feasible)
    → genuine 422 whose unsat core contains task_present items for both."""
    _ = random.Random(seed)  # kept for signature symmetry; layout is fixed.
    pin = "2026-05-19T10:00:00"  # Tuesday 10:00
    tasks = []
    for k in range(2):
        tid = f"u-{k}"
        tasks.append(
            {
                "id": tid,
                "title": f"Pinned {k}",
                "context": "deep",
                "priority": 80,
                "chunks": [{"chunk_id": f"{tid}#0", "duration_minutes": 60}],
                "group_policy": {"same_day": False, "ordered": False},
                "deadline": None,
                "earliest_start": _iso(WINDOW_START),
                "preferred_windows": [],
                "dependencies": [],
                "pinned_at": pin,
                "previous_placement": [],
                "must_include": True,
            }
        )
    return _base_problem(tasks, [])


ALL_FEASIBLE_SCENARIOS = {
    "small": scenario_small,
    "typical": scenario_typical,
    "fresh_week": scenario_fresh_week,
    "adversarial_churn": scenario_adversarial_churn,
    "heavy": scenario_heavy,
    "meetings": scenario_meetings,
    "oversubscribed": scenario_oversubscribed,
}
