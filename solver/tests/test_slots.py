"""Slot math tests."""

from __future__ import annotations

from datetime import datetime

import pytest

from solver.slots import (
    SLOT_MINUTES,
    datetime_to_slot,
    duration_to_slots,
    slot_to_datetime,
    slot_to_time_of_day_minutes,
    slot_to_weekday,
    total_slots,
)

ORIGIN = datetime(2026, 5, 18, 0, 0)  # Monday 00:00


def test_slot_minutes_is_15():
    assert SLOT_MINUTES == 15


def test_datetime_to_slot_at_origin():
    assert datetime_to_slot(ORIGIN, ORIGIN) == 0


def test_datetime_to_slot_offset():
    assert datetime_to_slot(datetime(2026, 5, 18, 9, 30), ORIGIN) == 9 * 4 + 2


def test_slot_to_datetime_roundtrip():
    assert slot_to_datetime(38, ORIGIN) == datetime(2026, 5, 18, 9, 30)


def test_datetime_to_slot_rejects_unaligned():
    with pytest.raises(ValueError):
        datetime_to_slot(datetime(2026, 5, 18, 9, 7), ORIGIN)


def test_duration_to_slots():
    assert duration_to_slots(90) == 6


def test_duration_to_slots_rejects_unaligned():
    with pytest.raises(ValueError):
        duration_to_slots(17)


def test_total_slots_for_7_days():
    end = datetime(2026, 5, 25, 0, 0)
    assert total_slots(ORIGIN, end) == 7 * 24 * 4


def test_slot_to_weekday_monday():
    # ORIGIN is Monday → "mon"
    assert slot_to_weekday(0, ORIGIN) == "mon"
    assert slot_to_weekday(4 * 24, ORIGIN) == "tue"
    assert slot_to_weekday(4 * 24 * 6, ORIGIN) == "sun"


def test_slot_to_time_of_day_minutes():
    assert slot_to_time_of_day_minutes(0, ORIGIN) == 0
    assert slot_to_time_of_day_minutes(38, ORIGIN) == 9 * 60 + 30
    # slot 96 is start of day 2 → 00:00
    assert slot_to_time_of_day_minutes(96, ORIGIN) == 0
