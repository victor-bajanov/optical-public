#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guards for bin/_smoke_registry.py's result-parsing surface: parse_results
(per-grammar-family level extraction) and classify_run (exit-code cross-check
-> PASS/FAIL/ALL_SKIPPED/SUSPECT). Fixtures are hand-built combined-stream
excerpts under bin/fixtures/smoke_runner/ (see that dir's README for the
per-file provenance and exit code each was built against) — TDD per repo
practice: written first, red against a module that doesn't exist yet.

Run: uv run bin/test_smoke_runner_results.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

BIN = Path(__file__).resolve().parent
FIXTURES = BIN / "fixtures" / "smoke_runner"

_spec = importlib.util.spec_from_file_location("_smoke_registry", BIN / "_smoke_registry.py")
assert _spec and _spec.loader, "could not load _smoke_registry module"
reg = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = reg
_spec.loader.exec_module(reg)


def fx(name: str) -> str:
    return (FIXTURES / name).read_text()


def labels(levels) -> list[str]:
    return [lv.label for lv in levels]


def statuses(levels) -> dict[str, str]:
    return {lv.label: lv.status for lv in levels}


# =============================================================================
# dash family — booking-smoke, config-smoke, engine-smoke, feed-smoke, poll-smoke
# =============================================================================


def test_dash_booking_base_pass_parses_b3_and_b6():
    levels = reg.parse_results("booking-smoke", fx("dash_booking_base_pass.txt"))
    assert labels(levels) == ["B3", "B6"]
    assert all(lv.status == "PASS" for lv in levels)
    assert "4 bookable slot(s)" in levels[0].notes


def test_dash_booking_base_pass_all_pass_terminal_not_a_level():
    levels = reg.parse_results("booking-smoke", fx("dash_booking_base_pass.txt"))
    assert "ALL" not in labels(levels)


def test_dash_booking_decline_pass_includes_a3_a4_skipped():
    levels = reg.parse_results("booking-smoke", fx("dash_booking_decline_pass.txt"))
    by_label = statuses(levels)
    assert by_label["A3/A4"] == "SKIP"
    assert by_label["D5"] == "PASS"


def test_dash_booking_decline_pass_decline_pass_terminal_not_a_level():
    levels = reg.parse_results("booking-smoke", fx("dash_booking_decline_pass.txt"))
    assert "DECLINE" not in labels(levels)


def test_dash_config_c7_unsat_note_variant_parses_as_pass():
    levels = reg.parse_results("config-smoke", fx("dash_config_pass_with_unsat_note.txt"))
    by_label = statuses(levels)
    assert by_label["C7"] == "PASS"
    c7 = [lv for lv in levels if lv.label == "C7"][0]
    assert "unsat" not in c7.notes  # the (note: unsat) parenthetical is stripped from notes, not embedded
    assert "feasible schedule" in c7.notes


def test_dash_config_c7_note_line_is_not_a_level():
    # "C7 NOTE — ..." (tag=NOTE) is not in the PASS|FAIL|SKIP|SKIPPED alternation.
    levels = reg.parse_results("config-smoke", fx("dash_config_pass_with_unsat_note.txt"))
    c7_entries = [lv for lv in levels if lv.label == "C7"]
    assert len(c7_entries) == 1


def test_dash_feed_fail_parses_f1_pass_f2_fail():
    levels = reg.parse_results("feed-smoke", fx("dash_feed_fail.txt"))
    by_label = statuses(levels)
    assert by_label["F1"] == "PASS"
    assert by_label["F2"] == "FAIL"


def test_dash_poll_pass_parses_p_labels_and_hyphenated_label():
    levels = reg.parse_results("poll-smoke", fx("dash_poll_pass.txt"))
    by_label = statuses(levels)
    for lbl in ("P1", "P2", "P3", "P4", "P5", "P6", "P7"):
        assert by_label[lbl] == "PASS"
    assert by_label["NUDGE-send"] == "PASS"


def test_dash_poll_pass_summary_block_lines_are_not_levels():
    # Two-space "PASS  label  notes" lines must not parse — only the single-
    # space "label PASS — notes" lines from the live run do.
    levels = reg.parse_results("poll-smoke", fx("dash_poll_pass.txt"))
    assert len(levels) == 8  # P1-P7 + NUDGE-send, each exactly once (not doubled by SUMMARY)


def test_dash_poll_fail_parses_the_fail_step():
    levels = reg.parse_results("poll-smoke", fx("dash_poll_fail.txt"))
    by_label = statuses(levels)
    assert by_label["P3"] == "FAIL"
    assert by_label["P1"] == "PASS"


def test_dash_poll_all_skipped_parses_no_levels():
    levels = reg.parse_results("poll-smoke", fx("dash_poll_all_skipped.txt"))
    assert levels == ()


# =============================================================================
# colon family — multiuser-smoke, meeting-smoke, ms-smoke
# =============================================================================


def test_colon_multiuser_pass_parses_all_eight_levels_in_harness_order():
    levels = reg.parse_results("multiuser-smoke", fx("colon_multiuser_pass.txt"))
    assert labels(levels) == ["M1", "M2", "M3", "M4", "M5", "M6", "M8", "M7"]
    assert all(lv.status == "PASS" for lv in levels)


def test_colon_multiuser_fail_parses_the_fail_level_with_notes():
    levels = reg.parse_results("multiuser-smoke", fx("colon_multiuser_fail.txt"))
    by_label = statuses(levels)
    assert by_label["M2"] == "FAIL"
    m2 = [lv for lv in levels if lv.label == "M2"][0]
    assert "freebusy" in m2.notes


def test_colon_meeting_skip_is_pass_with_skip_prefixed_notes():
    levels = reg.parse_results("meeting-smoke", fx("colon_meeting_pass_with_skip.txt"))
    by_label = statuses(levels)
    assert by_label["2B"] == "SKIP"
    assert by_label["2D"] == "SKIP"
    assert by_label["2A"] == "PASS"


def test_colon_meeting_bare_skip_stdout_line_is_not_a_second_level():
    # "2B SKIP: ..." (no colon right after the label) must not also parse —
    # only the "  2B: PASS  (0.1s)  SKIP: ..." status line should.
    levels = reg.parse_results("meeting-smoke", fx("colon_meeting_pass_with_skip.txt"))
    assert labels(levels).count("2B") == 1


def test_colon_meeting_all_skipped_every_level_is_skip():
    levels = reg.parse_results("meeting-smoke", fx("colon_meeting_all_skipped.txt"))
    assert len(levels) == 6
    assert all(lv.status == "SKIP" for lv in levels)


def test_colon_ms_pass_parses_digit_labels():
    levels = reg.parse_results("ms-smoke", fx("colon_ms_pass.txt"))
    assert labels(levels) == ["1", "2", "3", "4", "5", "6"]
    assert all(lv.status == "PASS" for lv in levels)


def test_colon_ms_fail_gates_level_4_into_skip():
    levels = reg.parse_results("ms-smoke", fx("colon_ms_fail.txt"))
    by_label = statuses(levels)
    assert by_label["3"] == "FAIL"
    assert by_label["4"] == "SKIP"


# =============================================================================
# regression family
# =============================================================================


def test_regression_pass_parses_every_level_including_fractional_labels():
    levels = reg.parse_results("regression-smoke", fx("regression_pass.txt"))
    by_label = statuses(levels)
    for lbl in ("1", "2", "3", "4", "5.1", "5.2", "6", "7", "8"):
        assert by_label[lbl] == "PASS", lbl


def test_regression_fail_parses_l6_fail_and_owned_meetings_quirk():
    levels = reg.parse_results("regression-smoke", fx("regression_fail.txt"))
    by_label = statuses(levels)
    assert by_label["6"] == "FAIL"
    # The rich table renders the owned-meetings row as "Lowned-meetings" (no
    # space between the L prefix and the label) — the row must still parse
    # with label "owned-meetings", not "owned-meetings" mangled some other way.
    assert by_label["owned-meetings"] == "PASS"


# =============================================================================
# none family — reset-smoke-env has no level-line grammar at all
# =============================================================================


def test_none_family_parses_no_levels_regardless_of_content():
    assert reg.parse_results("reset-smoke-env", fx("none_reset_pass.txt")) == ()
    assert reg.parse_results("reset-smoke-env", fx("none_reset_fail.txt")) == ()


# =============================================================================
# classify_run — exit-code cross-check
# =============================================================================


def test_classify_dash_pass():
    outcome = reg.classify_run("booking-smoke", 0, fx("dash_booking_base_pass.txt"))
    assert outcome.status == "PASS"
    assert len(outcome.levels) == 2


def test_classify_dash_decline_pass():
    outcome = reg.classify_run("booking-smoke", 0, fx("dash_booking_decline_pass.txt"))
    assert outcome.status == "PASS"


def test_classify_dash_config_unsat_note_is_still_pass():
    outcome = reg.classify_run("config-smoke", 0, fx("dash_config_pass_with_unsat_note.txt"))
    assert outcome.status == "PASS"


def test_classify_dash_suspect_missing_terminal_marker():
    # Every level PASSed but the run never printed "ALL PASS" — exit 0 here
    # disagrees with the parsed output's own missing terminal.
    outcome = reg.classify_run("config-smoke", 0, fx("dash_config_suspect_no_terminal.txt"))
    assert outcome.status == "SUSPECT"


def test_classify_dash_feed_fail_exit_1():
    outcome = reg.classify_run("feed-smoke", 1, fx("dash_feed_fail.txt"))
    assert outcome.status == "FAIL"


def test_classify_dash_poll_pass():
    outcome = reg.classify_run("poll-smoke", 0, fx("dash_poll_pass.txt"))
    assert outcome.status == "PASS"


def test_classify_dash_poll_fail_exit_1():
    outcome = reg.classify_run("poll-smoke", 1, fx("dash_poll_fail.txt"))
    assert outcome.status == "FAIL"


def test_classify_dash_poll_all_skipped_exit_2_is_all_skipped_never_pass():
    outcome = reg.classify_run("poll-smoke", 2, fx("dash_poll_all_skipped.txt"))
    assert outcome.status == "ALL_SKIPPED"


def test_classify_dash_suspect_fail_line_present_but_exit_0():
    outcome = reg.classify_run("booking-smoke", 0, fx("dash_suspect_fail_line_exit0.txt"))
    assert outcome.status == "SUSPECT"


def test_classify_colon_multiuser_empty_stream_exit_0_is_suspect():
    # MINOR-2: an empty/truncated stream with exit 0 must not read as a
    # silent PASS on a colon harness — the missing TOTAL line is itself
    # evidence the captured output disagrees with the exit code.
    outcome = reg.classify_run("multiuser-smoke", 0, "")
    assert outcome.status == "SUSPECT"


def test_classify_colon_ms_empty_stream_exit_0_is_suspect():
    outcome = reg.classify_run("ms-smoke", 0, "")
    assert outcome.status == "SUSPECT"


def test_classify_colon_multiuser_pass():
    outcome = reg.classify_run("multiuser-smoke", 0, fx("colon_multiuser_pass.txt"))
    assert outcome.status == "PASS"


def test_classify_colon_multiuser_fail_exit_1():
    outcome = reg.classify_run("multiuser-smoke", 1, fx("colon_multiuser_fail.txt"))
    assert outcome.status == "FAIL"


def test_classify_colon_meeting_pass_with_skip_is_pass_not_all_skipped():
    outcome = reg.classify_run("meeting-smoke", 0, fx("colon_meeting_pass_with_skip.txt"))
    assert outcome.status == "PASS"


def test_classify_colon_meeting_all_skipped_exit_2():
    outcome = reg.classify_run("meeting-smoke", 2, fx("colon_meeting_all_skipped.txt"))
    assert outcome.status == "ALL_SKIPPED"


def test_classify_colon_meeting_all_skip_but_exit_0_is_suspect():
    # The harness itself should have exited 2 (compute_exit_code) whenever
    # every parsed level is SKIP — an exit-0 report of that same content is
    # evidence the parse and the exit code disagree, not a genuine pass.
    outcome = reg.classify_run("meeting-smoke", 0, fx("colon_meeting_all_skipped.txt"))
    assert outcome.status == "SUSPECT"


def test_classify_colon_ms_pass():
    outcome = reg.classify_run("ms-smoke", 0, fx("colon_ms_pass.txt"))
    assert outcome.status == "PASS"


def test_classify_colon_ms_fail_exit_1():
    outcome = reg.classify_run("ms-smoke", 1, fx("colon_ms_fail.txt"))
    assert outcome.status == "FAIL"


def test_classify_regression_pass():
    outcome = reg.classify_run("regression-smoke", 0, fx("regression_pass.txt"))
    assert outcome.status == "PASS"


def test_classify_regression_fail_exit_1():
    outcome = reg.classify_run("regression-smoke", 1, fx("regression_fail.txt"))
    assert outcome.status == "FAIL"


def test_classify_regression_suspect_missing_total_line():
    # Truncate the fixture to drop the TOTAL line — exit 0 with no
    # authoritative terminal is SUSPECT even though every parsed row PASSed.
    text = fx("regression_pass.txt")
    truncated = "\n".join(
        line for line in text.splitlines() if not line.startswith("TOTAL")
    )
    outcome = reg.classify_run("regression-smoke", 0, truncated)
    assert outcome.status == "SUSPECT"


def test_classify_none_reset_smoke_env_pass_exit_0():
    outcome = reg.classify_run("reset-smoke-env", 0, fx("none_reset_pass.txt"))
    assert outcome.status == "PASS"
    assert outcome.levels == ()


def test_classify_none_reset_smoke_env_fail_exit_1():
    outcome = reg.classify_run("reset-smoke-env", 1, fx("none_reset_fail.txt"))
    assert outcome.status == "FAIL"


def test_classify_exit_2_on_a_pass01_harness_is_fail_not_all_skipped():
    # argparse usage errors (SystemExit(2)) on a plain pass01 harness are not
    # the pass012 all-skipped convention — they're a hard failure.
    outcome = reg.classify_run("config-smoke", 2, "")
    assert outcome.status == "FAIL"


def test_classify_no_level_line_at_all_with_nonzero_exit_is_fail_with_detail():
    outcome = reg.classify_run("feed-smoke", 1, "Traceback (most recent call last):\n  ...\n")
    assert outcome.status == "FAIL"
    assert outcome.levels == ()
    assert "log" in outcome.detail.lower()


def test_classify_unexpected_exit_code_is_fail():
    outcome = reg.classify_run("config-smoke", 137, "")
    assert outcome.status == "FAIL"


# =============================================================================
# classify_run(output_unavailable=True) — the interactive-harness path
# (poll-smoke run on the real TTY via App.suspend(); no captured stream to
# cross-check, so classification is exit-code-only and SUSPECT never fires).
# =============================================================================


def test_classify_output_unavailable_exit_0_is_pass():
    outcome = reg.classify_run("poll-smoke", 0, "", output_unavailable=True)
    assert outcome.status == "PASS"
    assert outcome.levels == ()
    assert "output not captured" in outcome.detail


def test_classify_output_unavailable_exit_1_is_fail():
    outcome = reg.classify_run("poll-smoke", 1, "", output_unavailable=True)
    assert outcome.status == "FAIL"
    assert outcome.levels == ()
    assert "output not captured" in outcome.detail


def test_classify_output_unavailable_exit_2_is_all_skipped():
    outcome = reg.classify_run("poll-smoke", 2, "", output_unavailable=True)
    assert outcome.status == "ALL_SKIPPED"
    assert outcome.levels == ()
    assert "output not captured" in outcome.detail


def test_classify_output_unavailable_ignores_any_text_content():
    # Even text that WOULD normally trigger SUSPECT (a FAIL line with exit 0)
    # must be ignored entirely under output_unavailable — there's nothing to
    # cross-check against.
    outcome = reg.classify_run("poll-smoke", 0, "P3 FAIL — should be irrelevant here",
                               output_unavailable=True)
    assert outcome.status == "PASS"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
