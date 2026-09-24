"""15-minute slot arithmetic."""

from __future__ import annotations

from datetime import datetime, timedelta

SLOT_MINUTES = 15
SLOTS_PER_HOUR = 60 // SLOT_MINUTES
SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR

_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def datetime_to_slot(dt: datetime, origin: datetime) -> int:
    """Convert a datetime aligned to a 15-min boundary into a slot index from origin."""
    delta = dt - origin
    total_minutes = int(delta.total_seconds() // 60)
    if total_minutes % SLOT_MINUTES != 0 or delta.total_seconds() % 60 != 0:
        raise ValueError(f"{dt!r} is not aligned to a {SLOT_MINUTES}-minute slot from {origin!r}")
    return total_minutes // SLOT_MINUTES


def slot_to_datetime(slot: int, origin: datetime) -> datetime:
    return origin + timedelta(minutes=slot * SLOT_MINUTES)


def duration_to_slots(minutes: int) -> int:
    if minutes % SLOT_MINUTES != 0:
        raise ValueError(f"duration {minutes} is not a multiple of {SLOT_MINUTES}")
    return minutes // SLOT_MINUTES


def total_slots(start: datetime, end: datetime) -> int:
    return datetime_to_slot(end, start)


def slot_to_weekday(slot: int, origin: datetime) -> str:
    dt = slot_to_datetime(slot, origin)
    return _WEEKDAYS[dt.weekday()]


def slot_to_time_of_day_minutes(slot: int, origin: datetime) -> int:
    """Minutes-of-day [0, 1440) for the start of the slot."""
    dt = slot_to_datetime(slot, origin)
    return dt.hour * 60 + dt.minute


def slot_to_day_index(slot: int, origin: datetime) -> int:
    """0 for the first day of the window, 1 for the next, etc."""
    dt = slot_to_datetime(slot, origin)
    return (dt.date() - origin.date()).days
