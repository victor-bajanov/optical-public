"""A task that cannot be placed is DROPPED, never rendered UNSAT — regardless of
why it cannot be placed.

Hardness (pin / hard deadline / hard preferred window) and droppability are
orthogonal: a hard constraint only governs WHERE a task goes when scheduled. A
task is dropped purely by the priority-weighted drop penalty when it has no legal
placement — whether the obstruction is its OWN bounds (earliest_start past the
window, a hard deadline before the window, a band shorter than the chunk) or
CONTENTION from other tasks / external events (an over-subscribed week). The
solver therefore never returns UNSAT for task contention; it drops the
lowest-value tasks and schedules the rest.
"""

from __future__ import annotations

from solver.schema import Problem
from solver.two_pass import solve

WINDOW = {"start": "2026-05-18T00:00:00", "end": "2026-05-25T00:00:00", "tz": "UTC"}
WEIGHTS = {
    "time_of_day_fit_per_15min": 0,
    "churn_per_15min_moved": 0,
    "priority_unit": 1,
    "base_drop_penalty": 200,
}
CONTEXTS = [
    {
        "context": "deep",
        "fit_curve": {"peak_start": "09:00", "peak_end": "12:00", "falloff_end": "16:00"},
        "max_minutes_per_day": None,
        "max_contiguous_minutes": None,
        "over_daily_cap_penalty_per_15min": 0,
        "over_streak_cap_penalty_per_15min": 0,
    }
]


def _task(**overrides) -> dict:
    base = {
        "id": "t",
        "title": "T",
        "context": "deep",
        "priority": 90,
        "chunks": [{"chunk_id": "t#0", "duration_minutes": 60}],
        "group_policy": {"same_day": False, "ordered": False},
        "deadline": None,
        "earliest_start": "2026-05-18T00:00:00",
        "preferred_windows": [],
        "dependencies": [],
        "pinned_at": None,
        "previous_placement": [],
    }
    base.update(overrides)
    return base


def _problem(tasks: list[dict], **overrides) -> Problem:
    data = {
        "window": WINDOW,
        "weights": WEIGHTS,
        "contexts": CONTEXTS,
        "tasks": tasks,
        "external_pinned": [],
    }
    data.update(overrides)
    return Problem.model_validate(data)


def _dropped_ids(result) -> set[str]:
    assert result.solution is not None, f"expected SAT, got unsat_core={result.unsat_core}"
    return {d.task_id for d in result.solution.dropped}


# ---------------------------------------------------------------------------
# Own-bounds obstructions: the task can never be placed in isolation.
# ---------------------------------------------------------------------------


def test_earliest_start_past_window_demotes_instead_of_unsat():
    problem = _problem([_task(id="late", earliest_start="2026-05-26T00:00:00")])
    result = solve(problem)
    assert "late" in _dropped_ids(result)


def test_hard_deadline_before_window_start_demotes():
    problem = _problem(
        [
            _task(
                id="early-dl",
                deadline={"at": "2026-05-17T00:00:00", "hard": True, "penalty_per_15min": 0},
            )
        ]
    )
    result = solve(problem)
    assert "early-dl" in _dropped_ids(result)


def test_feasible_band_shorter_than_duration_demotes():
    problem = _problem(
        [
            _task(
                id="tight",
                earliest_start="2026-05-18T16:00:00",
                deadline={"at": "2026-05-18T17:00:00", "hard": True, "penalty_per_15min": 0},
                chunks=[{"chunk_id": "tight#0", "duration_minutes": 90}],
            )
        ]
    )
    result = solve(problem)
    assert "tight" in _dropped_ids(result)


def test_unplaceable_hard_preferred_window_demotes():
    """A hard preferred window narrower than the chunk has NO satisfying slot in
    the horizon (the empty-allowed branch of _add_preferred_windows). Like every
    other own-bounds obstruction it must DROP the task, never poison the whole
    solve into UNSAT. Regression for the prod 2026-06-04 422: the preferred-window
    constraint forced start == -1 gated only on its assumption literal, NOT on
    chunk presence, so the task could not be dropped to relieve it."""
    problem = _problem(
        [
            _task(
                id="narrow",
                preferred_windows=[{"days": ["thu"], "start": "12:00", "end": "12:30", "hard": True}],
            )
        ]
    )
    result = solve(problem)
    assert "narrow" in _dropped_ids(result)


def test_unplaceable_hard_preferred_window_does_not_nuke_neighbours():
    """The prod incident's real damage: one undroppable hard-window task made the
    ENTIRE week UNSAT, nuking every other task's plan. A placeable task sharing
    the solve must still schedule (SAT) while the unplaceable one drops."""
    problem = _problem(
        [
            _task(
                id="narrow",
                preferred_windows=[{"days": ["thu"], "start": "12:00", "end": "12:30", "hard": True}],
            ),
            _task(id="fine"),
        ]
    )
    result = solve(problem)
    dropped = _dropped_ids(result)
    assert "narrow" in dropped
    assert "fine" not in dropped


def test_feasible_hard_task_alongside_unplaceable_one_is_kept():
    """A perfectly placeable hard task must NOT drop just because another
    impossible hard task shares the solve."""
    problem = _problem(
        [
            _task(
                id="good",
                deadline={"at": "2026-05-25T00:00:00", "hard": True, "penalty_per_15min": 0},
            ),
            _task(id="late", earliest_start="2026-05-26T00:00:00"),
        ]
    )
    result = solve(problem)
    dropped = _dropped_ids(result)
    assert "late" in dropped
    assert "good" not in dropped


# ---------------------------------------------------------------------------
# Contention: feasible-in-isolation hard tasks that cannot all fit drop the
# excess rather than poisoning the whole solve into UNSAT.
# ---------------------------------------------------------------------------


def test_contended_hard_tasks_with_feasible_bands_drop_the_excess():
    """Two hard-deadline tasks each have a legal band of their own, but only one
    day of slots exists before the shared deadline, so they cannot both fit.
    Under orthogonality the solver keeps one and DROPS the other (SAT) — it does
    NOT return UNSAT for the pair (the pre-2026-06-04 behaviour)."""
    deadline = {"at": "2026-05-19T00:00:00", "hard": True, "penalty_per_15min": 0}
    problem = _problem(
        [
            _task(id="a", deadline=deadline, chunks=[{"chunk_id": "a#0", "duration_minutes": 1440}]),
            _task(id="b", deadline=deadline, chunks=[{"chunk_id": "b#0", "duration_minutes": 1440}]),
        ]
    )
    result = solve(problem)
    dropped = _dropped_ids(result)
    assert len(dropped & {"a", "b"}) == 1, "exactly one of the contending pair drops"
