#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "tzdata>=2024.1"]
# ///
"""Offline tests for bin/timezone-smoke.py's pure logic: the leftover-task
predicate, the error hint, the far-zone pick, the vacuity guard, the local-Monday window, and the shape-level
band invariants the behaviour leg asserts (internal design notes,
Card D). No network.

Run: uv run bin/test_timezone_smoke.py -q
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("timezone_smoke", BIN / "timezone-smoke.py")
assert _spec and _spec.loader, "could not load timezone-smoke module"
tzs = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = tzs
_spec.loader.exec_module(tzs)


# --- leftover sweep + error hint ---------------------------------------------


def test_is_tzsmoke_task_by_title_or_external_id():
    assert tzs.is_tzsmoke_task({"title": "[tzsmoke] task 0"})
    assert tzs.is_tzsmoke_task({"title": "renamed", "source": {"kind": "mcp", "external_id": "tzsmoke-ab12-3"}})
    assert not tzs.is_tzsmoke_task({"title": "Write memo", "source": {"external_id": "user-1"}})
    assert not tzs.is_tzsmoke_task({"title": "notes on [tzsmoke]", "source": "junk"})
    assert not tzs.is_tzsmoke_task({})


def test_task_bodies_are_recognised_by_the_sweep():
    for b in tzs.task_bodies("run1", "2026-10-18T13:00:00Z"):
        assert tzs.is_tzsmoke_task(b)


def test_tz_failure_names_the_missing_users_row():
    msg = tzs.tz_failure("STARTUP", "DELETE", 404, {"error": "no_user_row"})
    assert "no_user_row" in msg and "users row" in msg and "404" in msg


def test_tz_failure_plain_for_other_errors():
    msg = tzs.tz_failure("Z4", "PATCH", 500, {"error": "boom"})
    assert msg.startswith("Z4: PATCH /v1/timezone: 500") and "users row" not in msg


# --- far-zone pick -----------------------------------------------------------

AT = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)


def test_far_zone_maximises_the_circular_wall_clock_gap():
    # From Sydney (+11 in Oct) LA (-7) is 18 h behind, i.e. only 6 h round the
    # clock: Sydney 09-17 lands on LA 15-23, half inside LA business hours, so
    # a worker still applying Sydney hours could slip past the band check.
    # London (+1, 10 h gap) puts Sydney's day on London's night.
    assert tzs.far_zone("Australia/Sydney", AT) == "Europe/London"


def test_far_zone_from_los_angeles_is_not_los_angeles_and_is_far():
    z = tzs.far_zone("America/Los_Angeles", AT)
    assert z != "America/Los_Angeles"
    gap = abs(tzs.utc_offset_minutes(z, AT) - tzs.utc_offset_minutes("America/Los_Angeles", AT))
    assert min(gap, 1440 - gap) >= 8 * 60


def test_far_zone_from_utc_is_at_least_eight_hours_away():
    z = tzs.far_zone("UTC", AT)
    gap = abs(tzs.utc_offset_minutes(z, AT))
    assert min(gap, 1440 - gap) >= 8 * 60


def test_utc_offset_minutes_tracks_dst():
    # Sydney is AEDT (+11) in October, AEST (+10) in July.
    assert tzs.utc_offset_minutes("Australia/Sydney", AT) == 660
    assert tzs.utc_offset_minutes("Australia/Sydney", datetime(2026, 7, 1, tzinfo=timezone.utc)) == 600


# --- local Monday + window ---------------------------------------------------


def test_next_local_monday_is_a_monday_at_least_21_local_days_out():
    now = datetime(2026, 9, 28, 1, 0, tzinfo=timezone.utc)  # Mon 11:00 Sydney
    m = tzs.next_local_monday(now, "Australia/Sydney")
    assert m == date(2026, 10, 19)
    assert m.weekday() == 0


def test_next_local_monday_uses_the_local_date_not_utc():
    # 20:00 UTC on Mon 28 Sep is already Tue 29 Sep 06:00 in Sydney (AEST)
    # but still Mon 28 Sep 13:00 in LA. +21 local days: Sydney Tue 20 Oct ->
    # Mon 26 Oct; LA Mon 19 Oct is itself a Monday.
    now = datetime(2026, 9, 28, 20, 0, tzinfo=timezone.utc)
    syd = tzs.next_local_monday(now, "Australia/Sydney")
    la = tzs.next_local_monday(now, "America/Los_Angeles")
    assert syd == date(2026, 10, 26)
    assert la == date(2026, 10, 19)
    assert syd != la


def test_local_week_window_is_local_midnight_to_local_midnight_in_utc():
    start, end = tzs.local_week_window(date(2026, 10, 19), "Australia/Sydney")
    assert start == "2026-10-18T13:00:00Z"
    assert end == "2026-10-25T13:00:00Z"
    start, end = tzs.local_week_window(date(2026, 10, 19), "America/Los_Angeles")
    assert start == "2026-10-19T07:00:00Z"
    assert end == "2026-10-26T07:00:00Z"


def test_local_week_window_across_a_dst_change_is_not_168_hours():
    # LA falls back on Sun 1 Nov 2026: the week of Mon 26 Oct is 169 h long.
    start, end = tzs.local_week_window(date(2026, 10, 26), "America/Los_Angeles")
    assert start == "2026-10-26T07:00:00Z"
    assert end == "2026-11-02T08:00:00Z"


def test_local_week_window_rejects_a_non_monday():
    with pytest.raises(ValueError):
        tzs.local_week_window(date(2026, 10, 20), "UTC")


# --- chunk local spans, band derivation, band check --------------------------


def chunk(start: str, end: str, task_id: str = "t1") -> dict:
    return {"task_id": task_id, "chunk_id": f"{task_id}:0", "start": start, "end": end, "context": "deep"}


def test_chunk_local_span_in_sydney():
    # 2026-10-18T22:00Z = Mon 19 Oct 09:00 AEDT.
    c = chunk("2026-10-18T22:00:00.000Z", "2026-10-18T23:00:00.000Z")
    assert tzs.chunk_local_span(c, "Australia/Sydney") == (0, 9 * 60, 10 * 60)


def test_chunk_local_span_ending_at_local_midnight_is_1440():
    c = chunk("2026-10-19T12:00:00Z", "2026-10-19T13:00:00Z")  # Mon 23:00-24:00 AEDT
    assert tzs.chunk_local_span(c, "Australia/Sydney") == (0, 23 * 60, 24 * 60)


def test_derive_band_is_the_envelope_of_the_placed_chunks():
    tz = "Australia/Sydney"
    chunks = [
        chunk("2026-10-18T22:00:00Z", "2026-10-18T23:00:00Z", "a"),  # Mon 09-10
        chunk("2026-10-21T03:00:00Z", "2026-10-21T04:30:00Z", "b"),  # Wed 14:00-15:30
    ]
    band = tzs.derive_band(chunks, tz)
    assert band == tzs.Band(start_min=9 * 60, end_min=15 * 60 + 30)
    assert band.width_min == 6 * 60 + 30


def test_derive_band_needs_at_least_one_chunk():
    with pytest.raises(ValueError):
        tzs.derive_band([], "UTC")


BAND = tzs.Band(start_min=9 * 60, end_min=17 * 60)


def test_band_violations_empty_when_every_chunk_is_inside_in_its_own_tz():
    # Tue 20 Oct 10:00-11:00 PDT (-7).
    c = chunk("2026-10-20T17:00:00Z", "2026-10-20T18:00:00Z")
    assert tzs.band_violations([c], "America/Los_Angeles", BAND) == []


def test_band_violations_ignore_the_weekday():
    # Sun 25 Oct 10:00-11:00 PDT: time of day inside, weekday irrelevant.
    c = chunk("2026-10-25T17:00:00Z", "2026-10-25T18:00:00Z")
    assert tzs.band_violations([c], "America/Los_Angeles", BAND) == []


def test_sydney_business_hours_read_in_the_far_zone_are_all_flagged():
    # The regression the smoke exists to catch: a worker still applying
    # Sydney 09-17 after the switch. Every hour of Mon 19 Oct 09-17 AEDT
    # (+11), read in far_zone("Australia/Sydney"), must leave a 09-17 band.
    far = tzs.far_zone("Australia/Sydney", AT)
    chunks = []
    for h in range(8):  # 09:00 AEDT = 18 Oct 22:00Z
        s = datetime(2026, 10, 18, 22, tzinfo=timezone.utc) + timedelta(hours=h)
        e = s + timedelta(hours=1)
        chunks.append(chunk(s.strftime("%Y-%m-%dT%H:%M:%SZ"), e.strftime("%Y-%m-%dT%H:%M:%SZ"), f"t{h}"))
    assert tzs.band_violations(chunks, "Australia/Sydney", BAND) == []
    out = tzs.band_violations(chunks, far, BAND)
    assert len(out) == 8 and "t0" in out[0]


# --- vacuity guard ---------------------------------------------------------------


def test_inconclusive_when_the_gap_is_narrower_than_the_band():
    # Sydney vs London is 10 h round the clock in October; a 12 h band would
    # let shifted placements overlap it, so the band check proves nothing.
    wide = tzs.Band(start_min=7 * 60, end_min=19 * 60)
    reason = tzs.inconclusive_reason("Australia/Sydney", "Europe/London", AT, wide)
    assert reason is not None and "inconclusive" in reason


def test_conclusive_when_the_gap_covers_the_band():
    assert tzs.inconclusive_reason("Australia/Sydney", "Europe/London", AT, BAND) is None
    exact = tzs.Band(start_min=8 * 60, end_min=18 * 60)  # 10 h == gap
    assert tzs.inconclusive_reason("Australia/Sydney", "Europe/London", AT, exact) is None


def test_band_violations_flags_time_of_day_outside_the_band():
    c = chunk("2026-10-20T14:00:00Z", "2026-10-20T15:00:00Z")  # Tue 07:00-08:00 PDT
    assert len(tzs.band_violations([c], "America/Los_Angeles", BAND)) == 1


def test_band_violations_flags_a_chunk_ending_past_the_band():
    c = chunk("2026-10-20T23:30:00Z", "2026-10-21T00:30:00Z")  # Tue 16:30-17:30 PDT
    assert len(tzs.band_violations([c], "America/Los_Angeles", BAND)) == 1


# --- instants + harness filtering --------------------------------------------


def test_start_instants_normalise_iso_spellings():
    a = [chunk("2026-10-19T00:00:00.000Z", "2026-10-19T01:00:00Z")]
    b = [chunk("2026-10-19T00:00:00Z", "2026-10-19T01:00:00Z")]
    c = [chunk("2026-10-19T00:00:00+00:00", "2026-10-19T01:00:00Z")]
    assert tzs.start_instants(a) == tzs.start_instants(b) == tzs.start_instants(c)


def test_start_instants_differ_for_shifted_placements():
    a = [chunk("2026-10-18T22:00:00Z", "2026-10-18T23:00:00Z")]
    b = [chunk("2026-10-19T16:00:00Z", "2026-10-19T17:00:00Z")]
    assert tzs.start_instants(a) != tzs.start_instants(b)


def test_harness_chunks_keeps_only_this_runs_tasks():
    schedule = [chunk("2026-10-19T00:00:00Z", "2026-10-19T01:00:00Z", "mine"),
                chunk("2026-10-19T02:00:00Z", "2026-10-19T03:00:00Z", "other")]
    assert [c["task_id"] for c in tzs.harness_chunks(schedule, {"mine"})] == ["mine"]


# --- task bodies ---------------------------------------------------------------


def test_task_bodies_fill_most_of_a_working_week():
    # 12-16 h of work, so the placed envelope approaches the real
    # business-hours hull rather than one morning.
    total = sum(b["duration_minutes"] for b in tzs.task_bodies("run1", "2026-10-18T13:00:00Z"))
    assert 12 * 60 <= total <= 16 * 60


def test_task_bodies_are_free_floating_and_tagged():
    bodies = tzs.task_bodies("run1", "2026-10-18T13:00:00Z")
    assert len(bodies) >= 3
    for b in bodies:
        assert b["pinned_at"] is None and b["deadline"] is None
        assert b["earliest_start"] == "2026-10-18T13:00:00Z"
        assert b["source"]["kind"] == "mcp"
        assert b["source"]["external_id"].startswith("tzsmoke-run1-")
        assert "duration_minutes" in b and "chunks" not in b



# --- Z2 invalid zones ---------------------------------------------------------


def test_invalid_zones_cover_an_unknown_name_an_offset_and_a_bare_legacy_name():
    # Intl accepts "+10:00" and "EST" (→ America/Panama); the server must 400 both.
    assert "Not/AZone" in tzs.INVALID_ZONES
    assert "+10:00" in tzs.INVALID_ZONES
    assert "EST" in tzs.INVALID_ZONES

if __name__ == "__main__":
    sys.exit(pytest.main([__file__, *(sys.argv[1:] or ["-v"])]))
