"""Fit-curve evaluation tests."""

from __future__ import annotations

from datetime import time

import pytest

from solver.fit_curve import FitCurveEvaluator
from solver.schema import FitCurve


@pytest.fixture
def deep_curve() -> FitCurve:
    return FitCurve(peak_start=time(9, 0), peak_end=time(12, 0), falloff_end=time(16, 0))


def test_zero_inside_peak(deep_curve):
    ev = FitCurveEvaluator(deep_curve)
    assert ev.score_at_minute_of_day(9 * 60) == 0
    assert ev.score_at_minute_of_day(10 * 60 + 30) == 0
    assert ev.score_at_minute_of_day(12 * 60) == 0


def test_ramp_after_peak_end(deep_curve):
    ev = FitCurveEvaluator(deep_curve)
    # 14:00 is halfway between 12:00 and 16:00 → 50
    assert ev.score_at_minute_of_day(14 * 60) == 50
    # 16:00 → 100
    assert ev.score_at_minute_of_day(16 * 60) == 100
    # after falloff_end stays at 100
    assert ev.score_at_minute_of_day(20 * 60) == 100


def test_ramp_before_peak_start(deep_curve):
    ev = FitCurveEvaluator(deep_curve)
    # 00:00 → 100 (max distance from peak)
    assert ev.score_at_minute_of_day(0) == 100
    # 04:30 → halfway from midnight to 09:00 → 50
    assert ev.score_at_minute_of_day(4 * 60 + 30) == 50
    # 09:00 → 0
    assert ev.score_at_minute_of_day(9 * 60) == 0


def test_flat_curve_when_peak_spans_day():
    flat = FitCurve(peak_start=time(0, 0), peak_end=time(23, 45), falloff_end=time(23, 45))
    ev = FitCurveEvaluator(flat)
    for minute in (0, 8 * 60, 12 * 60, 20 * 60):
        assert ev.score_at_minute_of_day(minute) == 0


def test_score_for_chunk_sums_each_slot(deep_curve):
    ev = FitCurveEvaluator(deep_curve)
    # Chunk starting at 11:00 for 90 minutes (6 slots).
    # slots: 11:00, 11:15, 11:30, 11:45 → all in peak → 0
    #        12:00 → boundary, in peak → 0
    #        12:15 → just past peak → small positive value
    total = ev.score_for_chunk(start_minute_of_day=11 * 60, duration_minutes=90)
    # last slot 12:15 maps to 15/240 of the ramp = 6.25 → rounded down to 6
    assert total == 6
