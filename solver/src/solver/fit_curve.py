"""Evaluate the §3.4 fit_curve shape into a per-slot 'distance from peak' score."""

from __future__ import annotations

from solver.schema import FitCurve
from solver.slots import SLOT_MINUTES

MAX_SCORE = 100


def _time_to_minutes(t) -> int:
    return t.hour * 60 + t.minute


class FitCurveEvaluator:
    """Piecewise-linear distance-from-peak score in [0, 100].

    - inside [peak_start, peak_end] -> 0 (best)
    - in (peak_end, falloff_end] -> linear ramp 0 -> 100
    - before peak_start -> linear ramp 100 (at 00:00) -> 0 (at peak_start)
    - after falloff_end -> 100
    """

    def __init__(self, curve: FitCurve) -> None:
        self._peak_start = _time_to_minutes(curve.peak_start)
        self._peak_end = _time_to_minutes(curve.peak_end)
        self._falloff_end = _time_to_minutes(curve.falloff_end)

    def score_at_minute_of_day(self, minute: int) -> int:
        if self._peak_start <= minute <= self._peak_end:
            return 0
        if minute < self._peak_start:
            if self._peak_start == 0:
                return 0
            ratio = (self._peak_start - minute) / self._peak_start
            return int(round(ratio * MAX_SCORE))
        # minute > peak_end
        if minute >= self._falloff_end:
            return MAX_SCORE
        span = self._falloff_end - self._peak_end
        if span <= 0:
            return MAX_SCORE
        ratio = (minute - self._peak_end) / span
        return int(round(ratio * MAX_SCORE))

    def score_for_chunk(self, start_minute_of_day: int, duration_minutes: int) -> int:
        """Sum the per-slot scores across the chunk's slots within one day.

        Caller must ensure the chunk does not cross midnight; the model
        will not place chunks across midnight.
        """
        total = 0
        for offset in range(0, duration_minutes, SLOT_MINUTES):
            total += self.score_at_minute_of_day(start_minute_of_day + offset)
        return total
