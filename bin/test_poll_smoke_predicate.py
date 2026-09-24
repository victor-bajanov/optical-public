# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/poll-smoke.py's pure decision logic: harness-ownership
matching (poll titles, imported-meeting tasks, poll-tagged bookings — the
lineage-robust cleanup style of bin/test_smoke_harness_predicate.py, adapted
to the meeting-poll tables), grid-response cell selection (overlapping vs
disjoint paint pairs), the post-wave nudge-guard predicate, the client-asset /
bootstrap-attribute page checks the nudge step relies on, and the Mon-Thu run
gate (mirrors L6's weekend caveat).

Run: uv run bin/test_poll_smoke_predicate.py
"""
from __future__ import annotations

import base64
import importlib.util
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import pytest

_spec = importlib.util.spec_from_file_location(
    "poll_smoke", Path(__file__).parent / "poll-smoke.py"
)
assert _spec and _spec.loader, "could not load poll-smoke module"
poll_smoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = poll_smoke
_spec.loader.exec_module(poll_smoke)


# =============================================================================
# is_run_day_ok — Mon-Thu gate (mirrors L6's weekend caveat)
# =============================================================================


def test_monday_is_ok():
    assert poll_smoke.is_run_day_ok(date(2026, 8, 17)) is True  # Monday


def test_thursday_is_ok():
    assert poll_smoke.is_run_day_ok(date(2026, 8, 20)) is True  # Thursday


def test_friday_is_not_ok():
    assert poll_smoke.is_run_day_ok(date(2026, 8, 21)) is False  # Friday


def test_saturday_is_not_ok():
    assert poll_smoke.is_run_day_ok(date(2026, 8, 22)) is False  # Saturday


def test_sunday_is_not_ok():
    assert poll_smoke.is_run_day_ok(date(2026, 8, 23)) is False  # Sunday


# =============================================================================
# poll_title_is_harness — title-based sledgehammer match (reset-smoke-env style)
# =============================================================================


def test_pollsmoke_title_matches():
    assert poll_smoke.poll_title_is_harness("[pollsmoke] P1 create") is True


def test_foreign_title_does_not_match():
    # Must not sweep up a real user's poll that merely happens to start
    # similarly — same false-positive concern as regression-smoke's
    # test_foreign_title_with_regsmoke_prefix_is_not_matched.
    assert poll_smoke.poll_title_is_harness("Quarterly planning sync") is False


def test_title_containing_prefix_midstring_does_not_match():
    assert poll_smoke.poll_title_is_harness("Re: [pollsmoke] forwarded") is False


def test_non_string_title_does_not_match():
    assert poll_smoke.poll_title_is_harness(None) is False


# =============================================================================
# task_is_pollsmoke_meeting_import — the P6 lookup (and cleanup safety net)
# =============================================================================


def test_task_matches_by_meeting_source_and_event_id():
    t = {"source": {"kind": "meeting", "external_id": "gcal-evt-1"}}
    assert poll_smoke.task_is_pollsmoke_meeting_import(t, {"gcal-evt-1"}) is True


def test_task_does_not_match_unrelated_event_id():
    t = {"source": {"kind": "meeting", "external_id": "gcal-evt-OTHER"}}
    assert poll_smoke.task_is_pollsmoke_meeting_import(t, {"gcal-evt-1"}) is False


def test_task_does_not_match_non_meeting_kind():
    # A task with the right external_id but the wrong source.kind must not
    # match — e.g. an unrelated mcp-sourced task that happens to reuse an id.
    t = {"source": {"kind": "mcp", "external_id": "gcal-evt-1"}}
    assert poll_smoke.task_is_pollsmoke_meeting_import(t, {"gcal-evt-1"}) is False


def test_task_with_no_source_does_not_match():
    assert poll_smoke.task_is_pollsmoke_meeting_import({}, {"gcal-evt-1"}) is False


# =============================================================================
# booking_is_pollsmoke — bookings-table cleanup safety net
# =============================================================================


def test_booking_matches_known_poll_id():
    b = {"id": "bk1", "poll_id": "poll-abc"}
    assert poll_smoke.booking_is_pollsmoke(b, {"poll-abc"}) is True


def test_booking_with_no_poll_id_does_not_match():
    # An ordinary booking-page claim never sets poll_id — must never be swept.
    b = {"id": "bk2", "poll_id": None}
    assert poll_smoke.booking_is_pollsmoke(b, {"poll-abc"}) is False


def test_booking_with_unrelated_poll_id_does_not_match():
    b = {"id": "bk3", "poll_id": "poll-someone-elses"}
    assert poll_smoke.booking_is_pollsmoke(b, {"poll-abc"}) is False


# =============================================================================
# poll_booking_rows — P5's row filter, wired onto booking_is_pollsmoke
# (2026-08-17 adversarial-review finding 4: booking_is_pollsmoke was dead
# code with live tests; GET /v1/bookings now exposes poll_id (W2), so P5
# uses it directly instead of a hand-rolled `b.get("poll_id") == poll_id`.)
# =============================================================================


def test_poll_booking_rows_filters_to_the_matching_poll():
    bookings = [
        {"id": "b1", "poll_id": "poll-abc", "status": "confirmed"},
        {"id": "b2", "poll_id": None, "status": "confirmed"},
        {"id": "b3", "poll_id": "poll-other", "status": "confirmed"},
    ]
    assert poll_smoke.poll_booking_rows(bookings, "poll-abc") == [bookings[0]]


def test_poll_booking_rows_empty_when_nothing_matches():
    bookings = [{"id": "b2", "poll_id": None, "status": "confirmed"}]
    assert poll_smoke.poll_booking_rows(bookings, "poll-abc") == []


def test_poll_booking_rows_empty_list_input():
    assert poll_smoke.poll_booking_rows([], "poll-abc") == []


# =============================================================================
# booking_wait_outcome / booking_wait_timeout_message — P5's confirm-wait
# retry loop (2026-08-17 adversarial-review finding 1): the worker publishes
# poll status "booked" (casSetBooked, polls/booking.ts:609) BEFORE
# confirmBooking flips the bookings row reserving->confirmed (:625), so a
# one-shot GET /v1/bookings can catch a transient "reserving" row — that must
# read differently from no row appearing at all (a real regression/field
# drop).
# =============================================================================


def test_booking_wait_outcome_confirmed():
    assert poll_smoke.booking_wait_outcome([{"status": "confirmed"}]) == "confirmed"


def test_booking_wait_outcome_reserving():
    assert poll_smoke.booking_wait_outcome([{"status": "reserving"}]) == "reserving"


def test_booking_wait_outcome_missing_when_no_rows():
    assert poll_smoke.booking_wait_outcome([]) == "missing"


def test_booking_wait_timeout_message_reserving_names_the_documented_edge():
    msg = poll_smoke.booking_wait_timeout_message("reserving", "poll-abc", 10.0, [{"status": "reserving"}])
    assert "reserving" in msg
    assert "confirmBooking" in msg
    assert "documented edge" in msg


def test_booking_wait_timeout_message_missing_names_regression_not_wedge():
    msg = poll_smoke.booking_wait_timeout_message("missing", "poll-abc", 10.0, [])
    assert "no row" in msg
    assert "poll-abc" in msg
    assert "regression" in msg
    assert "confirmBooking" not in msg


def test_booking_wait_timeout_message_reserving_and_missing_texts_differ():
    reserving_msg = poll_smoke.booking_wait_timeout_message("reserving", "poll-abc", 10.0, [{"status": "reserving"}])
    missing_msg = poll_smoke.booking_wait_timeout_message("missing", "poll-abc", 10.0, [])
    assert reserving_msg != missing_msg


# =============================================================================
# bookings_disabled_by_flag / bookings_feature_disabled_message — P5's 403
# special case (2026-08-17 adversarial-review finding 2): GET /v1/bookings
# sits behind BOOKING_PAGE_ENABLED, which polls don't otherwise depend on —
# that 403 must read as a harness dependency, not a poll bug.
# =============================================================================


def test_bookings_disabled_by_flag_true_for_feature_disabled_403():
    assert poll_smoke.bookings_disabled_by_flag(403, {"error": "feature_disabled"}) is True


def test_bookings_disabled_by_flag_false_for_a_different_403():
    assert poll_smoke.bookings_disabled_by_flag(403, {"error": "unauthorized"}) is False


def test_bookings_disabled_by_flag_false_for_a_non_403_status():
    assert poll_smoke.bookings_disabled_by_flag(200, {"error": "feature_disabled"}) is False


def test_bookings_feature_disabled_message_names_the_flag_and_the_harness_dependency():
    msg = poll_smoke.bookings_feature_disabled_message()
    assert "BOOKING_PAGE_ENABLED" in msg
    assert "harness dependency" in msg
    assert "not a poll failure" in msg


# =============================================================================
# nudge_is_permitted — post-wave contract: manual nudge is OPEN-only
# =============================================================================


def test_nudge_permitted_when_open():
    assert poll_smoke.nudge_is_permitted("open") is True


def test_nudge_not_permitted_when_needs_attention():
    # Pre-wave-3 behaviour allowed this; the post-wave contract this harness
    # is written against (decision D4 / M5) narrows nudge to OPEN only.
    assert poll_smoke.nudge_is_permitted("needs_attention") is False


def test_nudge_not_permitted_when_booked():
    assert poll_smoke.nudge_is_permitted("booked") is False


def test_nudge_not_permitted_when_cancelled():
    assert poll_smoke.nudge_is_permitted("cancelled") is False


# =============================================================================
# overlapping_choice / disjoint_choices — deterministic cell-pair selection
# =============================================================================


def test_overlapping_choice_is_deterministic_and_sorted():
    paintable = ["2026-08-18T02:00:00Z", "2026-08-18T01:00:00Z", "2026-08-18T03:00:00Z"]
    assert poll_smoke.overlapping_choice(paintable, count=2) == [
        "2026-08-18T01:00:00Z",
        "2026-08-18T02:00:00Z",
    ]


def test_overlapping_choice_raises_when_too_few_cells():
    import pytest

    with pytest.raises(ValueError):
        poll_smoke.overlapping_choice(["2026-08-18T01:00:00Z"], count=3)


def test_disjoint_choices_returns_two_non_overlapping_singletons():
    paintable = ["2026-08-18T02:00:00Z", "2026-08-18T01:00:00Z", "2026-08-18T03:00:00Z"]
    a, b = poll_smoke.disjoint_choices(paintable)
    assert set(a).isdisjoint(set(b))
    assert a == ["2026-08-18T01:00:00Z"]
    assert b == ["2026-08-18T03:00:00Z"]


def test_disjoint_choices_raises_when_fewer_than_two_cells():
    import pytest

    with pytest.raises(ValueError):
        poll_smoke.disjoint_choices(["2026-08-18T01:00:00Z"])


def test_disjoint_choices_raises_when_only_one_distinct_cell():
    # Guards against a caller accidentally passing duplicate entries for what
    # is really a single paintable cell — deduped, that is still len < 2.
    import pytest

    with pytest.raises(ValueError):
        poll_smoke.disjoint_choices(["2026-08-18T01:00:00Z", "2026-08-18T01:00:00Z"])


# =============================================================================
# edit_invitee_c_email — EDIT mode's third invitee reuses A's mailbox via a
# '+' subaddress (Card D: poll-smoke only has two real invitee mailboxes)
# =============================================================================


def test_edit_invitee_c_email_tags_the_local_part():
    assert poll_smoke.edit_invitee_c_email("invitee-a@example.com") == "invitee-a+editc@example.com"


def test_edit_invitee_c_email_is_distinct_from_the_base_address():
    base = "invitee-a@example.com"
    assert poll_smoke.edit_invitee_c_email(base) != base


def test_edit_invitee_c_email_preserves_the_domain():
    tagged = poll_smoke.edit_invitee_c_email("someone@sub.example.org")
    assert tagged.endswith("@sub.example.org")


def test_edit_invitee_c_email_is_deterministic():
    # Same input -> same output every call (no randomness/uniqueness suffix),
    # so a re-run's cleanup sweep and a mid-run resolve_token call agree on
    # the same address without threading it through extra state.
    a = "invitee-a@example.com"
    assert poll_smoke.edit_invitee_c_email(a) == poll_smoke.edit_invitee_c_email(a)


# =============================================================================
# deadline_extension_target — EDIT mode's deadline-arm PATCH target, derived
# from the poll's ACTUAL current deadline (not an assumed/hardcoded value),
# capped so it never crosses validateDeadline's own rangeEnd ceiling
# =============================================================================


def test_deadline_extension_target_extends_by_the_requested_hours():
    got = poll_smoke.deadline_extension_target("2026-08-18T10:00:00Z", "2026-08-25", extend_hours=1.0)
    assert got == "2026-08-18T11:00:00Z"


def test_deadline_extension_target_is_strictly_later_than_current():
    current = "2026-08-18T10:00:00Z"
    got = poll_smoke.deadline_extension_target(current, "2026-08-25", extend_hours=1.0)
    from datetime import datetime

    assert datetime.fromisoformat(got.replace("Z", "+00:00")) > datetime.fromisoformat(current.replace("Z", "+00:00"))


def test_deadline_extension_target_caps_at_rangeend_ceiling():
    # current + 1h would cross into the next day; the ceiling
    # (rangeEnd 23:59:00Z, a minute of margin short of validateDeadline's own
    # 23:59:59Z bound) must win instead.
    got = poll_smoke.deadline_extension_target("2026-08-18T23:30:00Z", "2026-08-18", extend_hours=1.0)
    assert got == "2026-08-18T23:59:00Z"


def test_deadline_extension_target_raises_when_no_room_left():
    # current is already AT the ceiling — there is nothing left to extend
    # into within rangeEnd, which is a setup bug (an operator-widened
    # POLL_SMOKE_DEADLINE_HOURS eating the whole range), not something to
    # silently paper over with a same-or-earlier "extension".
    import pytest

    with pytest.raises(AssertionError):
        poll_smoke.deadline_extension_target("2026-08-18T23:59:00Z", "2026-08-18", extend_hours=1.0)


def test_deadline_extension_target_output_ends_with_z():
    got = poll_smoke.deadline_extension_target("2026-08-18T10:00:00Z", "2026-08-25", extend_hours=1.0)
    assert got.endswith("Z")
    assert "+00:00" not in got


# =============================================================================
# bookbest_poll_range / bookbest_cell_choice — T2 (2026-08-17 hardening):
# BOOKBEST gets its own +3->+9-day range and a robust, slack-y cell pick
# instead of paintableCells[0] (the zero-slack lone-hole bug in todo.md
# "poll-smoke BOOKBEST stakes its only candidate on a zero-slack slot")
# =============================================================================

_NOW = datetime(2026, 8, 17, 0, 0, 0, tzinfo=timezone.utc)  # Monday 00:00Z


def test_bookbest_poll_range_is_three_to_nine_days_out():
    start, end = poll_smoke.bookbest_poll_range(_NOW)
    assert (start, end) == ("2026-08-20", "2026-08-26")


def test_bookbest_poll_range_differs_from_shared_poll_range():
    # The shared poll_range stays +1 -> +7 for every other mode — BOOKBEST's
    # own range must not collide with it.
    assert poll_smoke.poll_range(_NOW) == ("2026-08-18", "2026-08-24")
    assert poll_smoke.bookbest_poll_range(_NOW) != poll_smoke.poll_range(_NOW)


def test_bookbest_cell_choice_picks_the_slack_middle_cell_over_a_lone_hole():
    paintable = [
        "2026-08-19T09:00:00Z",
        "2026-08-19T09:30:00Z",  # slack: both neighbours (09:00/10:00) present
        "2026-08-19T10:00:00Z",
        "2026-08-20T14:00:00Z",  # lone hole: 13:30/14:30 both absent
    ]
    # 14:00 on the 20th is chronologically later but has no neighbours, so
    # despite the "prefer latest" rule it must be skipped in favour of the
    # slack cell.
    assert poll_smoke.bookbest_cell_choice(paintable, _NOW) == "2026-08-19T09:30:00Z"


def test_bookbest_cell_choice_respects_the_48h_floor():
    paintable = [
        # < 48h out from _NOW (2026-08-17T00:00Z), even though it has slack
        # on both sides — must be excluded.
        "2026-08-17T00:30:00Z",
        "2026-08-17T01:00:00Z",
        "2026-08-17T01:30:00Z",
        # >= 48h out, also with slack on both sides — the only eligible pick.
        "2026-08-20T15:00:00Z",
        "2026-08-20T15:30:00Z",
        "2026-08-20T16:00:00Z",
    ]
    assert poll_smoke.bookbest_cell_choice(paintable, _NOW) == "2026-08-20T15:30:00Z"


def test_bookbest_cell_choice_prefers_latest_qualifying_day_and_time():
    paintable = [
        "2026-08-19T09:00:00Z",
        "2026-08-19T09:30:00Z",
        "2026-08-19T10:00:00Z",
        "2026-08-20T15:00:00Z",
        "2026-08-20T15:30:00Z",
        "2026-08-20T16:00:00Z",
    ]
    assert poll_smoke.bookbest_cell_choice(paintable, _NOW) == "2026-08-20T15:30:00Z"


def test_bookbest_cell_choice_is_deterministic_regardless_of_input_order():
    paintable = [
        "2026-08-19T09:00:00Z",
        "2026-08-19T09:30:00Z",
        "2026-08-19T10:00:00Z",
        "2026-08-20T15:00:00Z",
        "2026-08-20T15:30:00Z",
        "2026-08-20T16:00:00Z",
    ]
    forward = poll_smoke.bookbest_cell_choice(paintable, _NOW)
    backward = poll_smoke.bookbest_cell_choice(list(reversed(paintable)), _NOW)
    assert forward == backward == "2026-08-20T15:30:00Z"


def test_bookbest_cell_choice_raises_when_nothing_qualifies():
    import pytest

    # Every cell is either a lone hole or inside the 48h floor.
    paintable = ["2026-08-17T09:00:00Z", "2026-08-25T09:00:00Z"]
    with pytest.raises(AssertionError) as exc:
        poll_smoke.bookbest_cell_choice(paintable, _NOW)
    assert "2026-08-17T09:00:00Z" in str(exc.value)
    assert "2026-08-25T09:00:00Z" in str(exc.value)


def test_bookbest_cell_choice_matches_worker_millisecond_precision_format():
    # worker/src/polls/grid.ts's cell list is built with
    # `new Date(t).toISOString()` (grid.ts:148-150), which ALWAYS renders
    # millisecond precision (e.g. "...T15:30:00.000Z") — the live worker
    # never emits the bare-second strings the fixtures above use as
    # shorthand. bookbest_cell_choice must compare INSTANTS, not string
    # renderings, or every real cell classifies as a lone hole (see
    # _instants_equal in bin/regression-smoke.py for the same
    # Z/offset/ms-precision trap on the calendar side).
    paintable = [
        "2026-08-20T15:00:00.000Z",
        "2026-08-20T15:30:00.000Z",  # slack: both neighbours present
        "2026-08-20T16:00:00.000Z",
    ]
    assert poll_smoke.bookbest_cell_choice(paintable, _NOW) == "2026-08-20T15:30:00.000Z"


def test_bookbest_cell_choice_handles_mixed_second_and_millisecond_formats():
    # A grid response is internally consistent (grid.ts renders every cell
    # the same way), but the choice function shouldn't assume a single
    # format — instant comparison must work regardless.
    paintable = [
        "2026-08-20T15:00:00Z",
        "2026-08-20T15:30:00.000Z",
        "2026-08-20T16:00:00Z",
    ]
    assert poll_smoke.bookbest_cell_choice(paintable, _NOW) == "2026-08-20T15:30:00.000Z"


# =============================================================================
# client_asset_referenced — the nudge step's "client JS asset is served" check
# =============================================================================


def test_client_asset_referenced_matches_hashed_src():
    html = '<script type="module" src="/poll/_static/poll.a1b2c3d4.js"></script>'
    assert poll_smoke.client_asset_referenced(html) is True


def test_client_asset_referenced_false_when_absent():
    assert poll_smoke.client_asset_referenced("<html><body>nothing here</body></html>") is False


def test_client_asset_referenced_false_for_flat_unhashed_path():
    # The flat, unhashed path stopped existing when content-hashing landed
    # (same regression booking-smoke.py's BOOKING_CLIENT_SRC_RE guards
    # against) — a stale flat reference must not read as present.
    html = '<script src="/poll/_static/poll.js"></script>'
    assert poll_smoke.client_asset_referenced(html) is False


# =============================================================================
# bootstrap_attrs_present — the nudge step's data-poll-id/data-token check
# =============================================================================


def test_bootstrap_attrs_present_when_both_match():
    html = '<div id="app" data-poll-id="poll-abc" data-token="tok.sig">'
    assert poll_smoke.bootstrap_attrs_present(html, "poll-abc", "tok.sig") is True


def test_bootstrap_attrs_present_false_when_token_is_stale():
    # This is exactly the "every automatic nudge emailed a dead link" bug the
    # additions doc calls out (wave3-additions.md item 5) — the page must
    # bootstrap with the FRESHLY nudged token, not a superseded one.
    html = '<div id="app" data-poll-id="poll-abc" data-token="OLD.sig">'
    assert poll_smoke.bootstrap_attrs_present(html, "poll-abc", "tok.sig") is False


def test_bootstrap_attrs_present_false_when_poll_id_mismatches():
    html = '<div id="app" data-poll-id="poll-OTHER" data-token="tok.sig">'
    assert poll_smoke.bootstrap_attrs_present(html, "poll-abc", "tok.sig") is False


# =============================================================================
# grid_response_has_who_arrays — decision D3 / M3 grid contract (freeWho/ifNeededWho)
# =============================================================================


def test_grid_response_has_who_arrays_true():
    aggregate = {
        "2026-08-18T01:00:00Z": {"free": 2, "ifNeeded": 0, "freeWho": ["Alice", "quiet-heron"], "ifNeededWho": []},
    }
    assert poll_smoke.grid_response_has_who_arrays(aggregate) is True


def test_grid_response_has_who_arrays_false_when_missing():
    # Pre-T11 shape (no freeWho/ifNeededWho) — must be detected as NOT
    # carrying the contract, not silently accepted.
    aggregate = {"2026-08-18T01:00:00Z": {"free": 2, "ifNeeded": 0}}
    assert poll_smoke.grid_response_has_who_arrays(aggregate) is False


def test_grid_response_has_who_arrays_false_when_empty_aggregate():
    assert poll_smoke.grid_response_has_who_arrays({}) is False


def test_grid_response_has_who_arrays_false_when_wrong_type():
    aggregate = {"2026-08-18T01:00:00Z": {"free": 2, "ifNeeded": 0, "freeWho": "Alice", "ifNeededWho": []}}
    assert poll_smoke.grid_response_has_who_arrays(aggregate) is False


# =============================================================================
# expected_attendee_emails — decision D2: hidden invitees excluded from the event
# =============================================================================


def test_expected_attendee_emails_excludes_hidden_and_dropped():
    invitees = [
        {"email": "a@example.com", "dropped": False, "hideName": False},
        {"email": "hidden@example.com", "dropped": False, "hideName": True},
        {"email": "dropped@example.com", "dropped": True, "hideName": False},
        {"email": "b@example.com", "dropped": False, "hideName": False},
    ]
    assert poll_smoke.expected_attendee_emails(invitees) == {"a@example.com", "b@example.com"}


def test_expected_attendee_emails_all_hidden_is_empty_set():
    # Card's documented edge case: all invitees hidden -> no attendees beyond
    # the organiser, and that is correct (not a bug the harness should flag).
    invitees = [{"email": "a@example.com", "dropped": False, "hideName": True}]
    assert poll_smoke.expected_attendee_emails(invitees) == set()


# =============================================================================
# extract_poll_token — accepts either a raw capability token or a pasted
# personal-link URL (both are what an operator might copy out of an invite/
# nudge email when hand-relaying it into the harness — see the module
# docstring's "no email-read capability" note)
# =============================================================================


def test_extract_poll_token_passes_through_a_raw_token():
    assert poll_smoke.extract_poll_token("abc123.def456") == "abc123.def456"


def test_extract_poll_token_pulls_t_param_from_a_full_url():
    url = "https://scheduler-dev.example.com/poll/poll-abc?t=abc123.def456"
    assert poll_smoke.extract_poll_token(url) == "abc123.def456"


def test_extract_poll_token_url_decodes_the_t_param():
    # signCapabilityWithEnv's payload/sig segments are base64url (no '+', '/',
    # '='), but the email link itself percent-encodes '.' boundaries the same
    # way inviteeUrlFor's encodeURIComponent does — round-trip that.
    url = "https://scheduler-dev.example.com/poll/poll-abc?t=abc%2Ddef.ghi"
    assert poll_smoke.extract_poll_token(url) == "abc-def.ghi"


def test_extract_poll_token_strips_surrounding_whitespace():
    assert poll_smoke.extract_poll_token("  abc123.def456  \n") == "abc123.def456"


def test_extract_poll_token_raises_when_url_has_no_t_param():
    import pytest

    with pytest.raises(ValueError):
        poll_smoke.extract_poll_token("https://scheduler-dev.example.com/poll/poll-abc")


def test_extract_poll_token_raises_on_empty_string():
    import pytest

    with pytest.raises(ValueError):
        poll_smoke.extract_poll_token("   ")


# =============================================================================
# status_page_has_landmarks / status_page_mentions — R4-M3: the organiser
# status page (T11's worker/src/web/poll-status-page.ts, not yet merged into
# this worktree when this file was written — see the STATUS step's comment).
# Split into a HARD check (real page + title + invitee names, which the smoke
# controls and can be certain of) and a SOFT keyword-mention check (roster/
# candidates section wording, which is a best-effort guess at T11's actual
# copy) — same "assert what you're sure of, note what you're not" split as
# the P6 imported-task check.
# =============================================================================


def test_status_page_has_landmarks_true_for_a_real_page():
    html = (
        "<html><body><h1>[pollsmoke] P1 happy</h1>"
        "<table><tr><td>Poll Smoke A</td></tr><tr><td>Poll Smoke B</td></tr></table>"
        "</body></html>"
    )
    assert poll_smoke.status_page_has_landmarks(html, "[pollsmoke] P1 happy", ["Poll Smoke A", "Poll Smoke B"]) is True


def test_status_page_has_landmarks_false_for_a_json_error_body():
    # requireOwner / a 401-403 miss returns JSON, not a page — must not be
    # mistaken for a (very sparse) HTML page.
    html = '{"error":"unauthorized"}'
    assert poll_smoke.status_page_has_landmarks(html, "[pollsmoke] P1 happy", ["Poll Smoke A"]) is False


def test_status_page_has_landmarks_false_when_title_missing():
    html = "<html><body><table><tr><td>Poll Smoke A</td></tr></table></body></html>"
    assert poll_smoke.status_page_has_landmarks(html, "[pollsmoke] P1 happy", ["Poll Smoke A"]) is False


def test_status_page_has_landmarks_false_when_an_invitee_name_missing():
    html = "<html><body><h1>[pollsmoke] P1 happy</h1><table><tr><td>Poll Smoke A</td></tr></table></body></html>"
    assert poll_smoke.status_page_has_landmarks(html, "[pollsmoke] P1 happy", ["Poll Smoke A", "Poll Smoke B"]) is False


def test_status_page_mentions_true_when_any_hint_present():
    html = "<html><body><h2>Roster</h2></body></html>"
    assert poll_smoke.status_page_mentions(html, ("roster", "invitee", "respondent")) is True


def test_status_page_mentions_is_case_insensitive():
    html = "<html><body><h2>CANDIDATES</h2></body></html>"
    assert poll_smoke.status_page_mentions(html, ("candidate", "best time", "score")) is True


def test_status_page_mentions_false_when_no_hint_present():
    html = "<html><body><h1>nothing relevant here</h1></body></html>"
    assert poll_smoke.status_page_mentions(html, ("candidate", "best time", "score")) is False


# =============================================================================
# safe_json_body — defensive response-body decode (found live: a fake bearer
# against the real dev host got a plain-text "404 Not Found" body, not JSON,
# and crashed post_poll with an unhandled JSONDecodeError before this fix)
# =============================================================================


def test_safe_json_body_decodes_valid_json():
    assert poll_smoke.safe_json_body('{"id": "poll-1"}') == {"id": "poll-1"}


def test_safe_json_body_empty_string_is_empty_dict():
    assert poll_smoke.safe_json_body("") == {}


def test_safe_json_body_non_json_text_is_preserved_under_raw():
    result = poll_smoke.safe_json_body("404 Not Found")
    assert result == {"_raw": "404 Not Found"}


def test_safe_json_body_truncates_a_long_non_json_body():
    long_text = "x" * 1000
    result = poll_smoke.safe_json_body(long_text)
    assert result["_raw"] == long_text[:300]


# =============================================================================
# grid_is_unlocked — 2026-08-16 fix-pass (Card B): GET /poll/:id/grid and PUT
# /poll/:id/response both return the FULL grid payload for an open OR
# needs_attention poll now (worker/src/polls/route.ts:520/548), not the closed
# `{status:...}` shape that used to gate needs_attention shut. Mirrors the
# client's own (poll.client.js) "does this payload carry paintableCells" check
# — same reasoning as status_page_has_landmarks: assert the shape the harness
# can be certain of.
# =============================================================================


def test_grid_is_unlocked_true_for_a_full_open_grid_payload():
    payload = {
        "paintableCells": ["2026-08-18T01:00:00Z"],
        "durationMin": 30,
        "aggregate": {},
        "respondents": [],
        "you": {"cells": [], "hideName": False, "name": ""},
        "ownerTz": "UTC",
    }
    assert poll_smoke.grid_is_unlocked(payload) is True


def test_grid_is_unlocked_false_for_closed_needs_attention_shape():
    # Pre-fix-pass behaviour: needs_attention used to return exactly this.
    assert poll_smoke.grid_is_unlocked({"status": "needs_attention"}) is False


def test_grid_is_unlocked_false_for_closed_booked_shape():
    assert poll_smoke.grid_is_unlocked({"status": "booked"}) is False


def test_grid_is_unlocked_false_when_paintable_cells_missing():
    assert poll_smoke.grid_is_unlocked({"you": {}}) is False


def test_grid_is_unlocked_false_when_paintable_cells_not_a_list():
    assert poll_smoke.grid_is_unlocked({"paintableCells": "oops", "you": {}}) is False


def test_grid_is_unlocked_false_when_you_key_missing():
    assert poll_smoke.grid_is_unlocked({"paintableCells": []}) is False


# =============================================================================
# poll_status_stayed — the pure decision behind hold_poll_status's live
# polling loop (2026-08-16 fix-pass: needs_attention no longer auto-books on
# an unlocked edit, and a guestLink poll no longer auto-books/escalates
# early — both are asserted by holding a status across a window rather than a
# one-shot check). An empty observation list must NOT pass: it proves the
# caller's loop never actually sampled anything.
# =============================================================================


def test_poll_status_stayed_true_when_every_observation_matches():
    assert poll_smoke.poll_status_stayed(["open", "open", "open"], "open") is True


def test_poll_status_stayed_false_when_any_observation_diverges():
    assert poll_smoke.poll_status_stayed(["open", "open", "booked"], "open") is False


def test_poll_status_stayed_false_when_no_observations_taken():
    assert poll_smoke.poll_status_stayed([], "open") is False


def test_poll_status_stayed_true_for_a_single_matching_observation():
    assert poll_smoke.poll_status_stayed(["needs_attention"], "needs_attention") is True


# =============================================================================
# status_page_has_icon_aggregate — Card A (2026-08-16 fix-pass): the status
# page's aggregate table now renders icon spans (class="av av-free"/
# "av-ifneeded", role="img") plus a legend and a two-tier (colspanned date +
# time-only) header, replacing the old literal "Free"/"If needed" cell text.
# HARD check (worker/src/web/poll-status-page.ts is merged, its markup is
# known) — but only meaningful once at least one response has been painted;
# an empty aggregate renders "No responses yet." instead of a table.
# =============================================================================


def test_status_page_has_icon_aggregate_true_for_real_markup():
    html = (
        '<table class="agg"><tr><th rowspan="2">Invitee</th>'
        '<th class="date" colspan="2">2026-08-18</th></tr>'
        '<tr><th class="time">09:00</th><th class="time">09:30</th></tr>'
        '<tr><td>Poll Smoke A</td><td class="av-cell">'
        '<span class="av av-free" role="img" title="Free" aria-label="Free">&#10003;</span>'
        '</td><td class="av-cell"></td></tr></table>'
        '<p class="legend">'
        '<span class="av av-free" aria-hidden="true" title="Free">&#10003;</span> free'
        ' &middot; <span class="av av-ifneeded" aria-hidden="true" title="If needed">&#9681;</span> if needed</p>'
    )
    assert poll_smoke.status_page_has_icon_aggregate(html) is True


def test_status_page_has_icon_aggregate_false_when_no_responses_painted_yet():
    html = '<h2>Aggregate</h2><p class="muted">No responses yet.</p>'
    assert poll_smoke.status_page_has_icon_aggregate(html) is False


def test_status_page_has_icon_aggregate_false_for_pre_fix_pass_text_markup():
    # The old literal-text shape (bug 1) — must not be mistaken for the icon
    # markup just because a table with invitee rows is present.
    html = (
        '<table><tr><th>Invitee</th><th>2026-08-18 09:00 UTC</th></tr>'
        '<tr><td>Poll Smoke A</td><td>Free</td></tr></table>'
    )
    assert poll_smoke.status_page_has_icon_aggregate(html) is False


def test_status_page_has_icon_aggregate_false_when_legend_missing():
    html = (
        '<table class="agg"><tr><th rowspan="2">Invitee</th>'
        '<th class="date" colspan="1">2026-08-18</th></tr><tr><th class="time">09:00</th></tr>'
        '<tr><td>A</td><td class="av-cell">'
        '<span class="av av-free" role="img" title="Free" aria-label="Free">&#10003;</span>'
        '</td></tr></table>'
    )
    assert poll_smoke.status_page_has_icon_aggregate(html) is False


# =============================================================================
# gmail_query / decode_message_bodies / find_poll_link / newest_matching_link
# — the mailbox-first token relay (T3)
# =============================================================================


def _b64u(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii")


def _gmail_msg(parts: list[tuple[str, str]] | None, internal_date_ms: int,
               *, simple_mime: str | None = None, simple_text: str | None = None) -> dict:
    """Build a realistic (trimmed) Gmail users.messages.get(format="full")
    fixture. Either pass `parts` (a list of (mimeType, text) leaves, wrapped
    in a multipart/alternative payload) or `simple_mime`/`simple_text` for a
    non-multipart message."""
    if parts is not None:
        payload = {
            "mimeType": "multipart/alternative",
            "parts": [{"mimeType": mime, "body": {"data": _b64u(text)}} for mime, text in parts],
        }
    else:
        payload = {"mimeType": simple_mime, "body": {"data": _b64u(simple_text)}}
    return {"id": "m1", "internalDate": str(internal_date_ms), "payload": payload}


def test_gmail_query_shape():
    q = poll_smoke.gmail_query("bob@example.com", 1755300000)
    assert q == "in:sent to:bob@example.com subject:[pollsmoke] after:1755300000"


def test_decode_message_bodies_simple_text_plain():
    msg = _gmail_msg(None, 1, simple_mime="text/plain", simple_text="hello world")
    assert poll_smoke.decode_message_bodies(msg) == ["hello world"]


def test_decode_message_bodies_multipart_alternative_both_parts():
    msg = _gmail_msg(
        [("text/plain", "plain body"), ("text/html", "<p>html body</p>")],
        1,
    )
    bodies = poll_smoke.decode_message_bodies(msg)
    assert "plain body" in bodies
    assert "<p>html body</p>" in bodies


def test_decode_message_bodies_skips_non_text_parts():
    msg = {
        "id": "m2",
        "internalDate": "1",
        "payload": {
            "mimeType": "multipart/mixed",
            "parts": [
                {"mimeType": "text/plain", "body": {"data": _b64u("the actual body")}},
                {"mimeType": "application/octet-stream", "body": {"data": _b64u("\x00\x01binary")}},
            ],
        },
    }
    bodies = poll_smoke.decode_message_bodies(msg)
    assert bodies == ["the actual body"]


def test_decode_message_bodies_recurses_nested_multipart():
    # multipart/mixed(attachment, multipart/alternative(text/plain, text/html))
    # — the real shape a Gmail client produces for an HTML email with an ICS
    # attachment (the booked-confirmation email).
    msg = {
        "id": "m3",
        "internalDate": "1",
        "payload": {
            "mimeType": "multipart/mixed",
            "parts": [
                {
                    "mimeType": "multipart/alternative",
                    "parts": [
                        {"mimeType": "text/plain", "body": {"data": _b64u("nested plain")}},
                        {"mimeType": "text/html", "body": {"data": _b64u("<p>nested html</p>")}},
                    ],
                },
                {"mimeType": "text/calendar", "body": {"data": _b64u("BEGIN:VCALENDAR")}},
            ],
        },
    }
    bodies = poll_smoke.decode_message_bodies(msg)
    assert "nested plain" in bodies
    assert "<p>nested html</p>" in bodies
    assert "BEGIN:VCALENDAR" in bodies


def test_find_poll_link_matches_specific_poll_id():
    bodies = [
        'Mark your availability: https://scheduler-dev.example.com/poll/POLL-A?t=tok-A-1',
    ]
    link = poll_smoke.find_poll_link(bodies, "POLL-A")
    assert link == "https://scheduler-dev.example.com/poll/POLL-A?t=tok-A-1"


def test_find_poll_link_ignores_a_different_poll_id():
    # A run has many concurrent polls; a link for a DIFFERENT poll id in the
    # same mailbox must never be picked up as a match.
    bodies = [
        'Mark your availability: https://scheduler-dev.example.com/poll/POLL-B?t=tok-B-1',
    ]
    assert poll_smoke.find_poll_link(bodies, "POLL-A") is None


def test_find_poll_link_picks_the_right_one_among_several():
    bodies = [
        '<a href="https://scheduler-dev.example.com/poll/POLL-B?t=tok-B-1">link</a>'
        ' and <a href="https://scheduler-dev.example.com/poll/POLL-A?t=tok-A-1">link</a>',
    ]
    link = poll_smoke.find_poll_link(bodies, "POLL-A")
    assert link == "https://scheduler-dev.example.com/poll/POLL-A?t=tok-A-1"


def test_find_poll_link_no_match_returns_none():
    bodies = ["nothing relevant here"]
    assert poll_smoke.find_poll_link(bodies, "POLL-A") is None


def test_find_poll_link_matches_a_link_inside_an_html_anchor_href():
    # WP2 review finding 1: the worker's poll emails are HTML-only with the
    # link living only in a <a href="…"> (no plaintext alternative) —
    # find_poll_link must extract it straight from raw markup, no plaintext
    # conversion involved.
    body = (
        '<html><body><p>Mark your availability</p>'
        '<div style="margin-top:18px">'
        '<a href="https://scheduler-dev.example.com/poll/POLL-A?t=tok-A-1" '
        'style="display:inline-block">Mark your availability</a></div>'
        '</body></html>'
    )
    link = poll_smoke.find_poll_link([body], "POLL-A")
    assert link == "https://scheduler-dev.example.com/poll/POLL-A?t=tok-A-1"


def test_find_poll_link_unescapes_html_entities_in_the_matched_url():
    # Belt-and-braces (WP2 review finding 1): the token suffix's own char
    # class already excludes '&' (protects against a trailing query param
    # after t=…), but the URL's host/path segment BEFORE /poll/ is
    # unconstrained and could legitimately carry an escaped '&' (e.g. a
    # future link-wrapping prefix) — html.unescape() on the whole match
    # rather than relying on the regex's exclusion set to be sufficient
    # forever.
    body = '<a href="https://s.example.com/r?a=1&amp;b=2/poll/POLL-A?t=tok123">link</a>'
    link = poll_smoke.find_poll_link([body], "POLL-A")
    assert link == "https://s.example.com/r?a=1&b=2/poll/POLL-A?t=tok123"


# newest_matching_link now takes the READER PROTOCOL's shape —
# list[tuple[sent_at_epoch_seconds, body_text]] — not raw Gmail message
# dicts, so the same function drives both GmailReader (Gmail's internalDate
# ms -> epoch s, bodies joined with "\n") and GraphReader (Graph's
# sentDateTime -> epoch s, body.content as text). See GmailReader/GraphReader
# below for the provider-specific construction of these tuples.


def test_newest_matching_link_picks_the_latest_message():
    # Nudges rotate the invitee's token — the OLDER message's link is dead, so
    # the newest matching message must win even though both match.
    older = (1000, "https://s.example.com/poll/POLL-A?t=old-token")
    newer = (2000, "https://s.example.com/poll/POLL-A?t=new-token")
    link = poll_smoke.newest_matching_link([older, newer], "POLL-A")
    assert link == "https://s.example.com/poll/POLL-A?t=new-token"


def test_newest_matching_link_ignores_messages_for_other_polls():
    other_poll = (3000, "https://s.example.com/poll/POLL-B?t=other-token")
    match = (1000, "https://s.example.com/poll/POLL-A?t=the-token")
    link = poll_smoke.newest_matching_link([other_poll, match], "POLL-A")
    assert link == "https://s.example.com/poll/POLL-A?t=the-token"


def test_newest_matching_link_returns_none_when_nothing_matches():
    msg = (1, "https://s.example.com/poll/POLL-B?t=x")
    assert poll_smoke.newest_matching_link([msg], "POLL-A") is None


# --- not_before_epoch filtering (T3 adversarial-review finding 1) -----------
# newest_matching_link is "newest among what's landed", which is NOT the same
# as "newest overall" when a stale message (the pre-nudge invite) has already
# landed but a fresher one (the nudge) hasn't been indexed yet — the day-level
# granularity of Gmail's own `after:` query operator can't tell them apart, so
# the filter has to happen here, in code, on the exact sent-at timestamp.


def test_newest_matching_link_excludes_a_message_before_not_before_epoch():
    not_before = 1_700_000_000
    stale = (not_before - 60, "https://s.example.com/poll/POLL-A?t=stale-token")
    assert poll_smoke.newest_matching_link([stale], "POLL-A", not_before_epoch=not_before) is None


def test_newest_matching_link_includes_a_message_at_or_after_not_before_epoch():
    not_before = 1_700_000_000
    fresh = (not_before + 60, "https://s.example.com/poll/POLL-A?t=fresh-token")
    link = poll_smoke.newest_matching_link([fresh], "POLL-A", not_before_epoch=not_before)
    assert link == "https://s.example.com/poll/POLL-A?t=fresh-token"


def test_newest_matching_link_prefers_the_freshest_message_even_when_a_stale_one_also_matches():
    not_before = 1_700_000_000
    stale = (not_before - 60, "https://s.example.com/poll/POLL-A?t=stale-invite-token")
    fresh = (not_before + 60, "https://s.example.com/poll/POLL-A?t=fresh-nudge-token")
    link = poll_smoke.newest_matching_link([stale, fresh], "POLL-A", not_before_epoch=not_before)
    assert link == "https://s.example.com/poll/POLL-A?t=fresh-nudge-token"


def test_newest_matching_link_default_not_before_epoch_keeps_everything():
    # Backward-compat default (0): every existing caller/test that doesn't
    # pass not_before_epoch must keep working unchanged.
    old = (1, "https://s.example.com/poll/POLL-A?t=x")
    assert poll_smoke.newest_matching_link([old], "POLL-A") == "https://s.example.com/poll/POLL-A?t=x"


# =============================================================================
# GmailReader / GraphReader — the two-method mailbox-reader protocol
# (messages_to(invitee_email, not_before) -> list[(sent_at_epoch, body_text)])
# poll-smoke's mailbox-first token relay drives through make_mail_reader.
# =============================================================================


class _FakeGmailClientForReader:
    """Duck-types _smoke_lib.GmailClient's two call sites (list_messages,
    get_message) — no HTTP involved, GmailReader is exercised directly
    against canned Gmail-shaped payloads."""

    def __init__(self, stubs_by_query: dict[str, list[dict]], full_by_id: dict[str, dict]):
        self._stubs_by_query = stubs_by_query
        self._full_by_id = full_by_id

    def list_messages(self, q: str) -> list[dict]:
        return self._stubs_by_query.get(q, [])

    def get_message(self, message_id: str, format: str = "full") -> dict:
        return self._full_by_id[message_id]


def test_gmail_reader_messages_to_uses_gmail_query_and_joins_bodies():
    query = poll_smoke.gmail_query("bob@example.com", 500)
    full = _gmail_msg(
        [("text/plain", "plain body"), ("text/html", "<p>html body</p>")],
        1_700_000_000_000,
    )
    fake = _FakeGmailClientForReader({query: [{"id": "m1"}]}, {"m1": full})
    reader = poll_smoke.GmailReader(fake)
    out = reader.messages_to("bob@example.com", 500)
    assert len(out) == 1
    sent_at, body = out[0]
    assert sent_at == 1_700_000_000  # internalDate ms -> epoch seconds
    assert "plain body" in body and "<p>html body</p>" in body


def test_gmail_reader_messages_to_empty_when_query_has_no_stubs():
    fake = _FakeGmailClientForReader({}, {})
    reader = poll_smoke.GmailReader(fake)
    assert reader.messages_to("nobody@example.com", 0) == []


class _FakeGraphMailClientForReader:
    """Duck-types _smoke_lib.GraphMailClient.list_sent_since — GraphReader is
    exercised directly against canned Graph-shaped messages (no HTTP)."""

    def __init__(self, messages: list[dict]):
        self.messages = messages
        self.seen_not_before: int | None = None

    def list_sent_since(self, not_before_epoch: int) -> list[dict]:
        self.seen_not_before = not_before_epoch
        return self.messages


def _graph_mail_msg(subject: str, sent_iso: str, to_email: str, content: str) -> dict:
    return {
        "subject": subject,
        "sentDateTime": sent_iso,
        "toRecipients": [{"emailAddress": {"address": to_email}}],
        "body": {"contentType": "html", "content": content},
    }


def _rendered_invite_html(url: str, label: str = "Mark your availability") -> str:
    """A representative rendered poll-invite email body (WP2 review finding
    7) — mirrors worker/src/polls/emails.ts's emailShell(ctaButton(url,
    label)) output: the worker sends poll mail HTML-only, and the link
    lives ONLY inside this anchor's href, never as bare text."""
    return (
        '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fc">'
        '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">'
        "<p>Sam Organiser wants to find a time for <strong>Poll Smoke Happy</strong> (30 minutes).</p>"
        "<p>Window: Mon 6 July – Mon 13 July<br>Responses close: Mon 6 July, 11:00 AM UTC</p>"
        f'<div style="margin-top:18px"><a href="{url}" '
        'style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;'
        f'font-size:14px;font-weight:600;padding:11px 24px;border-radius:6px">{label}</a></div>'
        "</div></body></html>"
    )


def test_graph_reader_matches_subject_prefix_and_recipient_and_maps_epoch():
    rendered = _rendered_invite_html("https://s.example.com/poll/POLL-A?t=tok")
    fake = _FakeGraphMailClientForReader([
        _graph_mail_msg(
            "[pollsmoke] Poll Smoke Happy — you're invited", "2026-07-06T09:00:00Z",
            "Bob@Example.com", rendered,
        ),
    ])
    reader = poll_smoke.GraphReader(fake)
    out = reader.messages_to("bob@example.com", 0)  # recipient match is casefolded
    assert len(out) == 1
    sent_at, body = out[0]
    assert sent_at == int(datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc).timestamp())
    assert body == rendered
    # And the harness's real extraction path finds the link inside the href,
    # not as bare text (WP2 review finding 1/7).
    link = poll_smoke.find_poll_link([body], "POLL-A")
    assert link == "https://s.example.com/poll/POLL-A?t=tok"


def test_graph_reader_excludes_messages_missing_the_subject_prefix():
    fake = _FakeGraphMailClientForReader([
        _graph_mail_msg("not ours", "2026-07-06T09:00:00Z", "bob@example.com", "irrelevant"),
    ])
    reader = poll_smoke.GraphReader(fake)
    assert reader.messages_to("bob@example.com", 0) == []


def test_graph_reader_excludes_messages_to_a_different_recipient():
    fake = _FakeGraphMailClientForReader([
        _graph_mail_msg("[pollsmoke] invite", "2026-07-06T09:00:00Z", "carol@example.com", "irrelevant"),
    ])
    reader = poll_smoke.GraphReader(fake)
    assert reader.messages_to("bob@example.com", 0) == []


def test_graph_reader_forwards_not_before_to_the_client():
    fake = _FakeGraphMailClientForReader([])
    poll_smoke.GraphReader(fake).messages_to("bob@example.com", 12345)
    assert fake.seen_not_before == 12345


def test_graph_reader_html_only_body_link_inside_href_survives_to_full_token():
    # WP2 review finding 1 end-to-end: the worker sends contentType HTML
    # with no plaintext alternative, and the poll URL exists only inside the
    # CTA button's href. With GraphMailClient no longer requesting a text
    # conversion (see _smoke_lib.GraphMailClient.list_sent_since), the FULL
    # token must round-trip through GraphReader -> newest_matching_link ->
    # extract_poll_token, unmangled and untruncated.
    long_token = "abc123" + "x" * 300 + ".fine-sig"
    html_body = _rendered_invite_html(f"https://s.example.com/poll/POLL-A?t={long_token}")
    fake = _FakeGraphMailClientForReader([
        _graph_mail_msg(
            "[pollsmoke] Poll Smoke Happy — you're invited", "2026-07-06T09:00:00Z",
            "bob@example.com", html_body,
        ),
    ])
    reader = poll_smoke.GraphReader(fake)
    messages = reader.messages_to("bob@example.com", 0)
    link = poll_smoke.newest_matching_link(messages, "POLL-A")
    assert link is not None
    assert poll_smoke.extract_poll_token(link) == long_token


# --- graph_datetime_to_epoch usage / warn-and-skip on unparseable ------------
# WP2 review finding 4: a naive fromisoformat(sentDateTime.replace("Z",
# "+00:00")) rejects Graph's 7-fractional-digit sentDateTime, and the old
# `except ValueError: continue` swallowed the drop with no diagnostic —
# every message silently vanishes, 90s timeout, no clue why.


def test_graph_reader_tolerates_seven_fractional_digits_in_sent_date_time():
    fake = _FakeGraphMailClientForReader([
        _graph_mail_msg(
            "[pollsmoke] invite", "2026-07-06T09:00:00.1234567Z",
            "bob@example.com", "https://s.example.com/poll/POLL-A?t=tok",
        ),
    ])
    reader = poll_smoke.GraphReader(fake)
    out = reader.messages_to("bob@example.com", 0)
    assert len(out) == 1
    sent_at, body = out[0]
    assert sent_at == int(datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc).timestamp())


def test_graph_reader_warns_and_skips_an_unparseable_sent_date_time(capsys):
    fake = _FakeGraphMailClientForReader([
        _graph_mail_msg("[pollsmoke] invite", "not-a-date", "bob@example.com", "irrelevant"),
    ])
    reader = poll_smoke.GraphReader(fake)
    out = reader.messages_to("bob@example.com", 0)
    assert out == []
    err = capsys.readouterr().err
    assert "not-a-date" in err
    assert "warning" in err.lower()


# --- make_mail_reader ---------------------------------------------------------


def test_make_mail_reader_google_wraps_gmail_client():
    class FakeSched:
        def request(self, method, path, **kw):
            import httpx as _httpx
            return _httpx.Response(200, json={"access_token": "t"},
                                   request=_httpx.Request("GET", "https://sched/v1/calendar-access-token"))
    reader = poll_smoke.make_mail_reader(FakeSched(), "google")
    assert isinstance(reader, poll_smoke.GmailReader)


def test_make_mail_reader_microsoft_wraps_graph_mail_client():
    class FakeSched:
        def request(self, method, path, **kw):
            import httpx as _httpx
            return _httpx.Response(200, json={"access_token": "t"},
                                   request=_httpx.Request("GET", "https://sched/v1/calendar-access-token"))
    reader = poll_smoke.make_mail_reader(FakeSched(), "microsoft")
    assert isinstance(reader, poll_smoke.GraphReader)


def test_make_mail_reader_rejects_unknown_provider():
    with pytest.raises(ValueError):
        poll_smoke.make_mail_reader(None, "icloud")


# =============================================================================
# resolve_token / _mailbox_token with a stub GmailClient (T3 adversarial
# review, findings 1-3) — configure_gmail_client + resolve_token end to end,
# scaling _MAILBOX_POLL_TIMEOUT_S/_MAILBOX_POLL_INTERVAL_S down so these run
# fast. Every test restores both the timing constants and the gmail client to
# a clean state in a finally block so test order never leaks state.
# =============================================================================


def _scaled_mailbox_timing(timeout_s: float, interval_s: float):
    """Context-manager-less save/restore helper: returns (restore_fn)."""
    orig_timeout = poll_smoke._MAILBOX_POLL_TIMEOUT_S
    orig_interval = poll_smoke._MAILBOX_POLL_INTERVAL_S
    poll_smoke._MAILBOX_POLL_TIMEOUT_S = timeout_s
    poll_smoke._MAILBOX_POLL_INTERVAL_S = interval_s

    def restore():
        poll_smoke._MAILBOX_POLL_TIMEOUT_S = orig_timeout
        poll_smoke._MAILBOX_POLL_INTERVAL_S = orig_interval
        poll_smoke.configure_gmail_client(None)

    return restore


def test_resolve_token_env_var_wins_before_touching_mailbox():
    # Finding 3(a): a pre-supplied *_TOKEN is the operator's explicit intent
    # and must be consulted BEFORE any mailbox poll, not after a timeout.
    class ShouldNotBeQueried:
        def list_messages(self, q):
            raise AssertionError("mailbox must not be queried when the env var is set")

        def get_message(self, *a, **k):
            raise AssertionError("mailbox must not be queried when the env var is set")

    restore = _scaled_mailbox_timing(0.05, 0.01)
    poll_smoke.configure_gmail_client(ShouldNotBeQueried())
    os.environ["PRECEDENCE_TEST_TOKEN"] = "OPERATOR-SUPPLIED"
    try:
        tok = poll_smoke.resolve_token("PRECEDENCE_TEST_TOKEN", "x", "P1", "a@example.com")
        assert tok == "OPERATOR-SUPPLIED"
    finally:
        os.environ.pop("PRECEDENCE_TEST_TOKEN", None)
        restore()


def test_resolve_token_mailbox_ignores_pre_nudge_invite_and_falls_back():
    # Regression for finding 1 (probe.py): the Sent folder is frozen at "only
    # the pre-nudge invite has landed" for the whole scaled poll window. With
    # not_before correctly excluding it, resolve_token must NOT hand back the
    # invite's (dead-after-nudge) token — it must exhaust its retries and fall
    # through to the interactive prompt, which raises SystemExit under pytest
    # (no TTY, no env var) rather than silently returning the wrong token.
    stale_invite = _gmail_msg(
        [("text/plain", "Mark when you're free: "
          "https://s.example.com/poll/POLL-N?t=INVITE-TOKEN-DEAD-AFTER-NUDGE")],
        1_000_000,
    )

    class StaleOnlyMailbox:
        def list_messages(self, q):
            return [{"id": "invite"}]

        def get_message(self, mid, format="full"):
            return stale_invite

    restore = _scaled_mailbox_timing(0.05, 0.01)
    poll_smoke.configure_gmail_client(StaleOnlyMailbox())
    os.environ.pop("NUDGE_TEST_TOKEN_UNSET", None)
    try:
        with pytest.raises(SystemExit):
            poll_smoke.resolve_token(
                "NUDGE_TEST_TOKEN_UNSET", "the nudge target", "POLL-N", "b@example.com",
                not_before=2_000,
            )
    finally:
        restore()


def test_resolve_token_mailbox_picks_the_post_not_before_message_when_both_present():
    # Once the nudge email also lands (both now present in Sent), resolve_token
    # must pick the FRESH (post-not_before) one, not the stale invite, proving
    # not_before is actually threaded through end to end.
    invite = _gmail_msg(
        [("text/plain", "https://s.example.com/poll/POLL-N?t=INVITE-TOKEN-DEAD-AFTER-NUDGE")],
        1_000_000,
    )
    nudge = _gmail_msg(
        [("text/plain", "https://s.example.com/poll/POLL-N?t=NUDGE-TOKEN-LIVE")],
        5_000_000,
    )

    class BothLanded:
        def list_messages(self, q):
            return [{"id": "invite"}, {"id": "nudge"}]

        def get_message(self, mid, format="full"):
            return invite if mid == "invite" else nudge

    restore = _scaled_mailbox_timing(1.0, 0.01)
    poll_smoke.configure_gmail_client(BothLanded())
    os.environ.pop("NUDGE_TEST_TOKEN_UNSET2", None)
    try:
        tok = poll_smoke.resolve_token(
            "NUDGE_TEST_TOKEN_UNSET2", "the nudge target", "POLL-N", "b@example.com",
            not_before=2_000,
        )
        assert tok == "NUDGE-TOKEN-LIVE"
    finally:
        restore()


def test_mailbox_transient_http_status_error_does_not_crash_and_falls_back():
    # Finding 2: a non-403 Gmail failure (500) must not propagate and kill the
    # run — it must be retried within the polling loop and eventually fall
    # back like any other mailbox miss.
    class Failing500:
        def list_messages(self, q):
            req = httpx.Request("GET", "https://gmail.googleapis.com/x")
            raise httpx.HTTPStatusError("500", request=req, response=httpx.Response(500, request=req))

        def get_message(self, *a, **k):
            ...

    restore = _scaled_mailbox_timing(0.05, 0.01)
    poll_smoke.configure_gmail_client(Failing500())
    os.environ.pop("TRANSIENT_TEST_TOKEN", None)
    try:
        with pytest.raises(SystemExit):
            poll_smoke.resolve_token("TRANSIENT_TEST_TOKEN", "x", "P1", "a@example.com")
    finally:
        restore()


def test_mailbox_connection_error_does_not_crash_and_falls_back():
    # Finding 2: a transport-level error (DNS/connect failure) must not
    # propagate either.
    class NetDead:
        def list_messages(self, q):
            raise httpx.ConnectError("dns fail")

        def get_message(self, *a, **k):
            ...

    restore = _scaled_mailbox_timing(0.05, 0.01)
    poll_smoke.configure_gmail_client(NetDead())
    os.environ.pop("NETDEAD_TEST_TOKEN", None)
    try:
        with pytest.raises(SystemExit):
            poll_smoke.resolve_token("NETDEAD_TEST_TOKEN", "x", "P1", "a@example.com")
    finally:
        restore()


def test_mailbox_circuit_breaker_disables_after_full_timeout():
    # Finding 3(b): after the FIRST full mailbox timeout (no match found in
    # the whole window), the mailbox path must be disabled for the rest of
    # the run — a second resolve_token call must not touch the mailbox again
    # (otherwise 11 call sites x 90s is ~16 minutes of dead time).
    class NeverFinds:
        def __init__(self):
            self.calls = 0

        def list_messages(self, q):
            self.calls += 1
            return []

        def get_message(self, *a, **k):
            ...

    client = NeverFinds()
    restore = _scaled_mailbox_timing(0.05, 0.01)
    poll_smoke.configure_gmail_client(client)
    os.environ.pop("BREAKER_TEST_TOKEN", None)
    try:
        with pytest.raises(SystemExit):
            poll_smoke.resolve_token("BREAKER_TEST_TOKEN", "x", "P1", "a@example.com")
        calls_after_first = client.calls
        assert calls_after_first >= 1

        with pytest.raises(SystemExit):
            poll_smoke.resolve_token("BREAKER_TEST_TOKEN", "x", "P1", "a@example.com")
        assert client.calls == calls_after_first, "mailbox was queried again after the circuit opened"
    finally:
        restore()


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
