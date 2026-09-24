#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/mu-smoke-login.py's pure logic: which of the three account
emails a given identity letter expects, whether a minted bearer's /v1/whoami
identity matches it, and the exact env block the script prints (the one thing
every live harness — multiuser-smoke, meeting-smoke, poll-smoke — consumes).

Run: uv run bin/test_mu_smoke_login.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import types
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "mu_smoke_login", Path(__file__).parent / "mu-smoke-login.py"
)
assert _spec and _spec.loader, "could not load mu-smoke-login module"
login = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = login
_spec.loader.exec_module(login)

URL = "https://scheduler-dev.example.com"
# The deployment Microsoft identities are minted against — the same dev
# deployment as Google.
MICROSOFT_URL = URL
EMAILS = {"A": "a@example.com", "B": "b@example.com", "C": "c@example.com"}
MINTED_AT = "2026-09-01T00:00:00+00:00"


def exports(lines: list[str]) -> dict[str, str]:
    """`export K=V` lines -> {K: V} (every line must be an export)."""
    out: dict[str, str] = {}
    for line in lines:
        assert line.startswith("export "), line
        k, v = line[len("export "):].split("=", 1)
        out[k] = v
    return out


# =============================================================================
# email_for_letter — the CLI's three account emails, keyed by identity letter
# =============================================================================


def test_email_for_letter_picks_the_matching_account():
    assert login.email_for_letter("B", EMAILS) == "b@example.com"


def test_email_for_letter_returns_none_when_that_letter_was_not_supplied():
    assert login.email_for_letter("C", {"A": "a@example.com"}) is None


def test_email_for_letter_ignores_blank_values():
    assert login.email_for_letter("A", {"A": "   "}) is None


# =============================================================================
# whoami_matches — did the operator log in as the account they claimed?
# =============================================================================


def test_whoami_matches_exact():
    assert login.whoami_matches("a@example.com", "a@example.com") is True


def test_whoami_matches_is_case_insensitive():
    # Google echoes back whatever casing the account carries; a case-only
    # difference is the same mailbox, not a wrong-account mint.
    assert login.whoami_matches("A@Example.com", "a@example.com") is True


def test_whoami_matches_false_on_a_different_account():
    assert login.whoami_matches("b@example.com", "a@example.com") is False


def test_whoami_matches_false_on_empty():
    assert login.whoami_matches("", "a@example.com") is False


# =============================================================================
# build_exports — the full env block every harness reads
# =============================================================================


def test_build_exports_carries_the_minted_identity():
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["A_BEARER"] == "bear"
    assert env["A_REFRESH"] == "refr"
    assert env["A_EXPECTED_EMAIL"] == "a@example.com"


def test_build_exports_carries_minted_at():
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["A_MINTED_AT"] == MINTED_AT


def test_build_exports_minted_at_line_immediately_follows_expected_email():
    # smoke-runner's expiry math depends on this exact adjacency, not just
    # presence somewhere in the block.
    lines = login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli")
    idx = lines.index("export A_EXPECTED_EMAIL=a@example.com")
    assert lines[idx + 1] == f"export A_MINTED_AT={MINTED_AT}"


def test_build_exports_sets_scheduler_url_and_dev_d1():
    # multiuser-smoke and meeting-smoke both `req()` these; poll-smoke reqs the
    # URL and uses D1_DATABASE_ID for its own row cleanup.
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["SCHEDULER_URL"] == URL
    assert env["D1_DATABASE_ID"] == login.DEV_DB_ID


def test_build_exports_never_emits_the_prod_d1_id():
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["D1_DATABASE_ID"] != login.PROD_DB_ID


def test_build_exports_sets_the_other_letters_expected_emails():
    # Minting A still exports B/C's expected emails, so a later `mu-smoke-login.py B`
    # only has to add B's bearer — and so meeting-smoke's preflight has them.
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["B_EXPECTED_EMAIL"] == "b@example.com"
    assert env["C_EXPECTED_EMAIL"] == "c@example.com"


def test_build_exports_sets_poll_smoke_invitee_mailboxes_from_b_and_c():
    # poll-smoke's INVITEE_A/B are mailboxes, NOT identities: the organiser is
    # identity A, so the two invitee mailboxes are accounts B and C.
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["INVITEE_A_EMAIL"] == "b@example.com"
    assert env["INVITEE_B_EMAIL"] == "c@example.com"


def test_build_exports_omits_invitee_vars_when_b_or_c_unknown():
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, {"A": "a@example.com"}, "smoke-cli"))
    assert "INVITEE_A_EMAIL" not in env
    assert "INVITEE_B_EMAIL" not in env
    assert "B_EXPECTED_EMAIL" not in env


def test_build_exports_omits_client_id_when_default():
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert "A_CLIENT_ID" not in env


def test_build_exports_emits_client_id_when_overridden():
    env = exports(login.build_exports("B", URL, "bear", "refr", MINTED_AT, EMAILS, "other-cli"))
    assert env["B_CLIENT_ID"] == "other-cli"


def test_build_exports_requires_the_minted_letters_email():
    # Without it there is no expected email to check whoami against — a silent
    # empty A_EXPECTED_EMAIL would make every harness's preflight vacuous.
    try:
        login.build_exports("C", URL, "bear", "refr", MINTED_AT, {"A": "a@example.com"}, "smoke-cli")
    except ValueError:
        return
    raise AssertionError("expected ValueError when the minted letter has no email")


# =============================================================================
# build_exports — --provider microsoft (Decision 3: distinct MS_<L>_* family)
# =============================================================================


def test_build_exports_microsoft_provider_uses_ms_prefix():
    env = exports(login.build_exports("A", MICROSOFT_URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli", provider="microsoft"))
    assert env["MS_A_BEARER"] == "bear"
    assert env["MS_A_REFRESH"] == "refr"
    assert env["MS_A_EXPECTED_EMAIL"] == "a@example.com"
    assert "A_BEARER" not in env
    assert "A_REFRESH" not in env


def test_build_exports_microsoft_provider_minted_at_is_ms_prefixed():
    env = exports(login.build_exports("A", MICROSOFT_URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli", provider="microsoft"))
    assert env["MS_A_MINTED_AT"] == MINTED_AT
    assert "A_MINTED_AT" not in env


def test_build_exports_microsoft_provider_client_id_is_ms_prefixed():
    env = exports(login.build_exports("B", MICROSOFT_URL, "bear", "refr", MINTED_AT, EMAILS, "other-cli", provider="microsoft"))
    assert env["MS_B_CLIENT_ID"] == "other-cli"
    assert "B_CLIENT_ID" not in env


def test_build_exports_microsoft_provider_sets_other_letters_ms_expected_email():
    env = exports(login.build_exports("A", MICROSOFT_URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli", provider="microsoft"))
    assert env["MS_B_EXPECTED_EMAIL"] == "b@example.com"
    assert env["MS_C_EXPECTED_EMAIL"] == "c@example.com"
    assert "B_EXPECTED_EMAIL" not in env


def test_build_exports_microsoft_provider_omits_invitee_emails():
    # Poll invitees stay the Gmail smoke mailboxes from [poll] — they are
    # never Microsoft letters, even when the organiser (A) is minted under
    # --provider microsoft.
    env = exports(login.build_exports("A", MICROSOFT_URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli", provider="microsoft"))
    assert "INVITEE_A_EMAIL" not in env
    assert "INVITEE_B_EMAIL" not in env


def test_build_exports_google_provider_is_the_default():
    with_default = login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli")
    with_explicit = login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli", provider="google")
    assert with_default == with_explicit


# =============================================================================
# build_exports — D1_DATABASE_ID chosen by --url host, not hardcoded to dev
# =============================================================================


def test_build_exports_dev_host_uses_dev_db_id():
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli"))
    assert env["D1_DATABASE_ID"] == login.DEV_DB_ID


def test_build_exports_microsoft_mint_on_dev_uses_dev_db_id():
    # The db follows the --url host, never the provider: a Microsoft mint
    # against dev claims dev's D1.
    env = exports(login.build_exports("A", URL, "bear", "refr", MINTED_AT, EMAILS, "smoke-cli", provider="microsoft"))
    assert env["D1_DATABASE_ID"] == login.DEV_DB_ID




def test_build_exports_unknown_host_unsets_d1_database_id():
    # NIT (Opus review): an unrecognised host must actively `unset
    # D1_DATABASE_ID` rather than just omit the export line — a stale dev
    # id already exported earlier in the same shell (e.g. from a prior dev
    # mint) must not silently survive into a workers.dev/unknown-host run.
    lines = login.build_exports("A", "https://example.com", "bear", "refr", MINTED_AT, EMAILS, "smoke-cli")
    assert "unset D1_DATABASE_ID" in lines
    assert not any(line.startswith("export D1_DATABASE_ID=") for line in lines)


# =============================================================================
# merge_export_blocks — combines one build_exports() block per minted letter
# into a single eval-able block for multi-letter invocations
# =============================================================================


def test_merge_export_blocks_single_block_passes_through():
    block = login.build_exports("A", URL, "bearA", "refrA", MINTED_AT, EMAILS, "smoke-cli")
    assert login.merge_export_blocks([block]) == block


def test_merge_export_blocks_keeps_every_letters_bearer_and_refresh():
    block_a = login.build_exports("A", URL, "bearA", "refrA", MINTED_AT, EMAILS, "smoke-cli")
    block_b = login.build_exports("B", URL, "bearB", "refrB", MINTED_AT, EMAILS, "smoke-cli")
    merged = exports(login.merge_export_blocks([block_a, block_b]))
    assert merged["A_BEARER"] == "bearA"
    assert merged["A_REFRESH"] == "refrA"
    assert merged["B_BEARER"] == "bearB"
    assert merged["B_REFRESH"] == "refrB"


def test_merge_export_blocks_keeps_each_letters_own_minted_at():
    # A_MINTED_AT and B_MINTED_AT are per-letter (each mint happens at its own
    # moment, sequentially) — a two-letter merge must not collapse them into
    # one shared value the way SCHEDULER_URL/D1_DATABASE_ID legitimately do.
    minted_a = "2026-09-01T00:00:00+00:00"
    minted_b = "2026-09-01T00:05:00+00:00"
    block_a = login.build_exports("A", URL, "bearA", "refrA", minted_a, EMAILS, "smoke-cli")
    block_b = login.build_exports("B", URL, "bearB", "refrB", minted_b, EMAILS, "smoke-cli")
    merged = exports(login.merge_export_blocks([block_a, block_b]))
    assert merged["A_MINTED_AT"] == minted_a
    assert merged["B_MINTED_AT"] == minted_b


def test_merge_export_blocks_dedupes_shared_lines_with_later_block_winning():
    # SCHEDULER_URL, D1_DATABASE_ID, and the *_EXPECTED_EMAIL lines repeat in
    # every letter's block; a later mint's value should win, even though here
    # they're identical (the interesting case is stable values, not conflict).
    block_a = login.build_exports("A", URL, "bearA", "refrA", MINTED_AT, EMAILS, "smoke-cli")
    block_b = login.build_exports("B", URL, "bearB", "refrB", MINTED_AT, EMAILS, "smoke-cli")
    merged = exports(login.merge_export_blocks([block_a, block_b]))
    assert merged["SCHEDULER_URL"] == URL
    assert merged["D1_DATABASE_ID"] == login.DEV_DB_ID
    assert merged["A_EXPECTED_EMAIL"] == "a@example.com"
    assert merged["B_EXPECTED_EMAIL"] == "b@example.com"
    assert merged["C_EXPECTED_EMAIL"] == "c@example.com"


def test_merge_export_blocks_later_duplicate_key_overrides_earlier_value():
    earlier = ["export SCHEDULER_URL=https://stale", "export A_BEARER=bearA"]
    later = ["export SCHEDULER_URL=https://fresh", "export B_BEARER=bearB"]
    merged = exports(login.merge_export_blocks([earlier, later]))
    assert merged["SCHEDULER_URL"] == "https://fresh"


def test_merge_export_blocks_preserves_stable_first_seen_order():
    earlier = ["export SCHEDULER_URL=https://stale", "export A_BEARER=bearA"]
    later = ["export SCHEDULER_URL=https://fresh", "export B_BEARER=bearB"]
    merged = login.merge_export_blocks([earlier, later])
    keys = [line[len("export "):].split("=", 1)[0] for line in merged]
    # SCHEDULER_URL first appeared in `earlier` — even though its value is
    # overridden by `later`, its position in the merged block doesn't move.
    assert keys == ["SCHEDULER_URL", "A_BEARER", "B_BEARER"]


def test_merge_export_blocks_empty_input_returns_empty_list():
    assert login.merge_export_blocks([]) == []


def test_merge_export_blocks_three_letters_carries_all_three_pairs():
    block_a = login.build_exports("A", URL, "bearA", "refrA", MINTED_AT, EMAILS, "smoke-cli")
    block_b = login.build_exports("B", URL, "bearB", "refrB", MINTED_AT, EMAILS, "smoke-cli")
    block_c = login.build_exports("C", URL, "bearC", "refrC", MINTED_AT, EMAILS, "smoke-cli")
    merged = exports(login.merge_export_blocks([block_a, block_b, block_c]))
    for letter, bearer, refresh in (("A", "bearA", "refrA"), ("B", "bearB", "refrB"), ("C", "bearC", "refrC")):
        assert merged[f"{letter}_BEARER"] == bearer
        assert merged[f"{letter}_REFRESH"] == refresh


# =============================================================================
# merge_export_blocks — "unset K" lines (point 11: unknown-host D1 unset)
# =============================================================================


def test_merge_export_blocks_preserves_a_single_unset_line():
    block = login.build_exports("A", "https://example.com", "bear", "refr", MINTED_AT, EMAILS, "smoke-cli")
    merged = login.merge_export_blocks([block])
    assert "unset D1_DATABASE_ID" in merged


def test_merge_export_blocks_later_export_overrides_earlier_unset():
    earlier = ["unset D1_DATABASE_ID", "export A_BEARER=bearA"]
    later = ["export D1_DATABASE_ID=some-id", "export B_BEARER=bearB"]
    merged = login.merge_export_blocks([earlier, later])
    assert "export D1_DATABASE_ID=some-id" in merged
    assert "unset D1_DATABASE_ID" not in merged


def test_merge_export_blocks_later_unset_overrides_earlier_export():
    earlier = ["export D1_DATABASE_ID=some-id", "export A_BEARER=bearA"]
    later = ["unset D1_DATABASE_ID", "export B_BEARER=bearB"]
    merged = login.merge_export_blocks([earlier, later])
    assert "unset D1_DATABASE_ID" in merged
    assert "export D1_DATABASE_ID=some-id" not in merged


def test_merge_export_blocks_unset_keeps_first_seen_position():
    earlier = ["unset D1_DATABASE_ID", "export A_BEARER=bearA"]
    later = ["export D1_DATABASE_ID=some-id", "export B_BEARER=bearB"]
    merged = login.merge_export_blocks([earlier, later])
    keys = [
        line[len("unset "):] if line.startswith("unset ") else line[len("export "):].split("=", 1)[0]
        for line in merged
    ]
    assert keys == ["D1_DATABASE_ID", "A_BEARER", "B_BEARER"]


def test_merge_export_blocks_dev_and_unknown_host_mints_in_one_shell():
    # The realistic shape: a dev mint (D1_DATABASE_ID exported) followed by
    # an unknown-host mint in the same shell must end with the id unset, not
    # left over from the dev mint.
    dev_block = login.build_exports("A", URL, "bearA", "refrA", MINTED_AT, EMAILS, "smoke-cli")
    unknown_block = login.build_exports("B", "https://example.com", "bearB", "refrB", MINTED_AT, EMAILS, "smoke-cli")
    merged = login.merge_export_blocks([dev_block, unknown_block])
    assert "unset D1_DATABASE_ID" in merged
    assert not any(line.startswith("export D1_DATABASE_ID=") for line in merged)


# =============================================================================
# CLI-level validation and the mint loop, driven through main() directly.
# The usage checks below all return before run_mint() is ever called; the
# mint-loop tests monkeypatch login.run_mint/login.verify_identity so no
# subprocess or network call happens.
# =============================================================================


def _clear_letter_env_vars(monkeypatch) -> None:
    """A developer shell commonly has A_EXPECTED_EMAIL etc. persistently
    exported (see the internal design notes' "smoke needs user shell"
    lesson) — main()'s --email-a/-b/-c argparse defaults read os.environ
    directly, so a test that omits those flags to exercise the config-lookup
    fallback must first scrub any such leftover from the real environment."""
    for var in ("A_EXPECTED_EMAIL", "B_EXPECTED_EMAIL", "C_EXPECTED_EMAIL", "SCHEDULER_URL"):
        monkeypatch.delenv(var, raising=False)


def run_main(argv: list[str]) -> tuple[int, str, str]:
    """Run main() with `argv` as sys.argv[1:], capturing stdout/stderr
    separately (mirrors the script's own discipline: only exports on stdout)."""
    old_argv = sys.argv
    sys.argv = ["mu-smoke-login.py", *argv]
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = login.main()
    finally:
        sys.argv = old_argv
    return code, stdout.getvalue(), stderr.getvalue()


def test_main_rejects_duplicate_letters():
    code, _out, err = run_main(["A", "A", "--url", URL])
    assert code == 2
    assert "duplicate" in err.lower()


def test_main_rejects_deprecated_email_alias_with_multiple_letters():
    code, _out, err = run_main(["A", "B", "--url", URL, "--email", "a@example.com"])
    assert code == 2
    assert "--email" in err


def _patch_mint(run_mint, verify_identity):
    """Context-manager-less patch/restore pair for login.run_mint and
    login.verify_identity, so mint-loop tests never touch the network or
    spawn mint-token.py. Returns the (old_run_mint, old_verify) pair to
    restore in a `finally`."""
    old_run_mint, old_verify = login.run_mint, login.verify_identity
    login.run_mint, login.verify_identity = run_mint, verify_identity
    return old_run_mint, old_verify


# -- FINDING 1: a later letter's mint failure must not discard earlier mints --


def test_main_emits_completed_exports_when_a_later_letter_fails():
    # A and B mint (and verify) fine; C's run_mint fails with MintFailure(3) —
    # the same shape a wrong-account exit or a mint-token crash now takes.
    # A's and B's exports are each freshly whoami-verified and stand on their
    # own, so they must not be thrown away just because C blew up.
    order: list[str] = []

    def fake_run_mint(url, client_id, port, provider="google"):
        letter = ("A", "B", "C")[len(order)]
        order.append(letter)
        if letter == "C":
            raise login.MintFailure(3)
        return f"bear{letter}", f"refr{letter}"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, err = run_main([
            "A", "B", "C", "--url", URL,
            "--email-a", EMAILS["A"], "--email-b", EMAILS["B"], "--email-c", EMAILS["C"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 3
    env = exports(out.splitlines())
    assert env["A_BEARER"] == "bearA"
    assert env["B_BEARER"] == "bearB"
    assert "C_BEARER" not in env
    assert order == ["A", "B", "C"]  # C's mint was attempted after A and B succeeded
    assert "C did NOT mint" in err


def test_main_prints_no_stdout_when_the_first_letter_fails():
    def fake_run_mint(url, client_id, port, provider="google"):
        raise login.MintFailure(1)

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, err = run_main([
            "A", "--url", URL,
            "--email-a", EMAILS["A"], "--email-b", EMAILS["B"], "--email-c", EMAILS["C"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 1
    assert out == ""
    # Single-letter behaviour stays byte-identical to before: no new
    # "did NOT mint" note when there was only ever one letter to mint.
    assert "did NOT mint" not in err


# -- FINDING 2: the trailing hint should name the letters not minted this run --


def test_main_hint_names_the_letter_not_minted_this_run():
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main([
            "A", "B", "--url", URL,
            "--email-a", EMAILS["A"], "--email-b", EMAILS["B"], "--email-c", EMAILS["C"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "Now mint C, then:" in err
    assert "other identities" not in err


def test_main_single_letter_hint_names_both_remaining_letters():
    # Pre-fix this branch's `len(missing) < 3` was always true (the minted
    # letter's own email is guaranteed, so `missing` can hold at most the
    # other two letters) — dead code that always printed the generic "other
    # identities" text regardless of which letters were actually left.
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main([
            "A", "--url", URL,
            "--email-a", EMAILS["A"], "--email-b", EMAILS["B"], "--email-c", EMAILS["C"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "Now mint B, C, then:" in err


def test_main_hint_says_next_when_every_letter_was_minted_this_run():
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main([
            "A", "B", "C", "--url", URL,
            "--email-a", EMAILS["A"], "--email-b", EMAILS["B"], "--email-c", EMAILS["C"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "Next: op run" in err
    assert "Now mint" not in err


# -- mint ordering: letters mint in the order given on the command line --


def test_main_mints_letters_in_the_order_given_on_the_command_line():
    order: list[str] = []
    given_order = ("C", "A", "B")  # deliberately not alphabetical

    def fake_run_mint(url, client_id, port, provider="google"):
        letter = given_order[len(order)]
        order.append(letter)
        return f"bear{letter}", f"refr{letter}"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        # Each letter is verified before the next mint starts: at the moment
        # verify_identity runs, `letter` must be the one most recently minted.
        assert letter == order[-1]

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, _err = run_main([
            "C", "A", "B", "--url", URL,
            "--email-a", EMAILS["A"], "--email-b", EMAILS["B"], "--email-c", EMAILS["C"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert order == ["C", "A", "B"]
    env = exports(out.splitlines())
    assert env["A_BEARER"] == "bearA"
    assert env["B_BEARER"] == "bearB"
    assert env["C_BEARER"] == "bearC"


# =============================================================================
# run_mint — the mint-token subprocess must ignore the smoke-runner config
# =============================================================================


def test_run_mint_passes_no_config_to_mint_token(monkeypatch):
    """This script owns the letter→email mapping and does its own whoami
    verification, so mint-token must NOT load ~/.config/optical-smoke/config.toml
    — otherwise minting B or C would be checked against the config's primary
    account and abort."""
    captured: dict[str, list[str]] = {}

    class FakeProc:
        returncode = 0
        stdout = "export SCHEDULER_BEARER=bear\nexport SCHEDULER_REFRESH_TOKEN=ref\n"

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(login.subprocess, "run", fake_run)
    bearer, refresh = login.run_mint(URL, "smoke-cli", 8976)

    assert (bearer, refresh) == ("bear", "ref")
    assert "--no-config" in captured["cmd"]


def test_run_mint_passes_provider_to_mint_token(monkeypatch):
    captured: dict[str, list[str]] = {}

    class FakeProc:
        returncode = 0
        stdout = "export SCHEDULER_BEARER=bear\nexport SCHEDULER_REFRESH_TOKEN=ref\n"

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(login.subprocess, "run", fake_run)
    login.run_mint(URL, "smoke-cli", 8976, "microsoft")
    idx = captured["cmd"].index("--provider")
    assert captured["cmd"][idx + 1] == "microsoft"


def test_run_mint_defaults_to_google_provider(monkeypatch):
    captured: dict[str, list[str]] = {}

    class FakeProc:
        returncode = 0
        stdout = "export SCHEDULER_BEARER=bear\nexport SCHEDULER_REFRESH_TOKEN=ref\n"

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(login.subprocess, "run", fake_run)
    login.run_mint(URL, "smoke-cli", 8976)
    idx = captured["cmd"].index("--provider")
    assert captured["cmd"][idx + 1] == "google"


# =============================================================================
# verify_identity — error text names the provider
# =============================================================================


def test_verify_identity_microsoft_mismatch_names_microsoft(monkeypatch):
    monkeypatch.setattr(login, "fetch_whoami_email", lambda url, bearer, timeout=15.0: "wrong@x.example")
    try:
        login.verify_identity(URL, "bear", "A", "right@x.example", provider="microsoft")
    except login.MintFailure:
        pass
    else:
        raise AssertionError("expected MintFailure on a whoami mismatch")


def test_verify_identity_microsoft_mismatch_error_text(monkeypatch, capsys):
    monkeypatch.setattr(login, "fetch_whoami_email", lambda url, bearer, timeout=15.0: "wrong@x.example")
    try:
        login.verify_identity(URL, "bear", "A", "right@x.example", provider="microsoft")
    except login.MintFailure:
        pass
    err = capsys.readouterr().err
    assert "wrong Microsoft account" in err


def test_verify_identity_google_mismatch_error_text_unchanged(monkeypatch, capsys):
    monkeypatch.setattr(login, "fetch_whoami_email", lambda url, bearer, timeout=15.0: "wrong@x.example")
    try:
        login.verify_identity(URL, "bear", "A", "right@x.example")
    except login.MintFailure:
        pass
    err = capsys.readouterr().err
    assert "wrong Google account" in err


def test_verify_identity_match_does_not_raise(monkeypatch):
    monkeypatch.setattr(login, "fetch_whoami_email", lambda url, bearer, timeout=15.0: "right@x.example")
    login.verify_identity(URL, "bear", "A", "right@x.example", provider="microsoft")  # no raise


# =============================================================================
# config-default emails — before prompting, try the smoke-runner config
# =============================================================================


def test_config_email_for_letter_google():
    RunnerConfig = login._smoke_identity_module().RunnerConfig
    cfg = RunnerConfig(google={"a": "cfg-a@x.example"})
    assert login.config_email_for_letter(cfg, "google", "A") == "cfg-a@x.example"


def test_config_email_for_letter_microsoft():
    RunnerConfig = login._smoke_identity_module().RunnerConfig
    cfg = RunnerConfig(microsoft={"b": "ms.b@x.example"})
    assert login.config_email_for_letter(cfg, "microsoft", "B") == "ms.b@x.example"


def test_config_email_for_letter_unset_returns_none():
    RunnerConfig = login._smoke_identity_module().RunnerConfig
    cfg = RunnerConfig()
    assert login.config_email_for_letter(cfg, "google", "A") is None


def test_config_email_for_letter_none_config_returns_none():
    assert login.config_email_for_letter(None, "google", "A") is None


def test_load_smoke_config_reads_xdg_config_home(tmp_path):
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text('[google]\na = "a@x.example"\n')
    cfg = login.load_smoke_config(None, False, {"XDG_CONFIG_HOME": str(tmp_path)})
    assert cfg is not None
    assert cfg.google["a"] == "a@x.example"


def test_load_smoke_config_no_config_flag_returns_none(tmp_path):
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text('[google]\na = "a@x.example"\n')
    cfg = login.load_smoke_config(None, True, {"XDG_CONFIG_HOME": str(tmp_path)})
    assert cfg is None


def test_load_smoke_config_missing_file_returns_none(tmp_path):
    cfg = login.load_smoke_config(None, False, {"XDG_CONFIG_HOME": str(tmp_path)})
    assert cfg is None


def test_load_smoke_config_explicit_path_overrides_xdg(tmp_path):
    explicit = tmp_path / "explicit.toml"
    explicit.write_text('[microsoft]\na = "ms.a@x.example"\n')
    cfg = login.load_smoke_config(str(explicit), False, {})
    assert cfg is not None
    assert cfg.microsoft["a"] == "ms.a@x.example"


# =============================================================================
# resolve_emails — flag > provider-scoped env family > config > "" (prompt)
#
# REVIEW FIX (Opus review of WP1a): --email-a/-b/-c argparse defaults used to
# read A_EXPECTED_EMAIL/B_/C_ unconditionally regardless of --provider. In
# the one-shell-both-casts setup Decision 3 exists for, --provider microsoft
# then silently picked up the GOOGLE addresses before the config fallback
# ever ran. resolve_emails fixes this by choosing the env family
# (<L>_EXPECTED_EMAIL vs MS_<L>_EXPECTED_EMAIL) from args.provider.
# =============================================================================


def make_args(email_a=None, email_b=None, email_c=None, email=None, provider="google", letters=None):
    return types.SimpleNamespace(
        email_a=email_a, email_b=email_b, email_c=email_c, email=email,
        provider=provider, letters=letters or ["A"],
    )


def test_resolve_emails_flag_wins_over_env_and_config():
    args = make_args(email_a="flag-a@x.example")
    cfg = login._smoke_identity_module().RunnerConfig(google={"a": "cfg-a@x.example"})
    environ = {"A_EXPECTED_EMAIL": "env-a@x.example"}
    emails = login.resolve_emails(args, environ, cfg)
    assert emails["A"] == "flag-a@x.example"


def test_resolve_emails_google_provider_reads_plain_env_family():
    args = make_args(provider="google")
    environ = {"A_EXPECTED_EMAIL": "google-a@x.example", "MS_A_EXPECTED_EMAIL": "ms-a@x.example"}
    emails = login.resolve_emails(args, environ, None)
    assert emails["A"] == "google-a@x.example"


def test_resolve_emails_microsoft_provider_reads_ms_env_family():
    # The exact bug: a shell holding BOTH families must resolve to the
    # Microsoft address under --provider microsoft, not the Google one.
    args = make_args(provider="microsoft")
    environ = {"A_EXPECTED_EMAIL": "google-a@x.example", "MS_A_EXPECTED_EMAIL": "ms-a@x.example"}
    emails = login.resolve_emails(args, environ, None)
    assert emails["A"] == "ms-a@x.example"


def test_resolve_emails_google_provider_ignores_ms_env_family_when_plain_absent():
    args = make_args(provider="google")
    environ = {"MS_A_EXPECTED_EMAIL": "ms-a@x.example"}
    emails = login.resolve_emails(args, environ, None)
    assert emails["A"] == ""


def test_resolve_emails_microsoft_provider_ignores_plain_env_family_when_ms_absent():
    args = make_args(provider="microsoft")
    environ = {"A_EXPECTED_EMAIL": "google-a@x.example"}
    emails = login.resolve_emails(args, environ, None)
    assert emails["A"] == ""


def test_resolve_emails_env_beats_config():
    args = make_args(provider="google")
    cfg = login._smoke_identity_module().RunnerConfig(google={"a": "cfg-a@x.example"})
    environ = {"A_EXPECTED_EMAIL": "env-a@x.example"}
    emails = login.resolve_emails(args, environ, cfg)
    assert emails["A"] == "env-a@x.example"


def test_resolve_emails_falls_back_to_google_config_when_flag_and_env_absent():
    args = make_args(provider="google")
    cfg = login._smoke_identity_module().RunnerConfig(google={"a": "cfg-a@x.example"})
    emails = login.resolve_emails(args, {}, cfg)
    assert emails["A"] == "cfg-a@x.example"


def test_resolve_emails_falls_back_to_microsoft_config_when_flag_and_env_absent():
    args = make_args(provider="microsoft")
    cfg = login._smoke_identity_module().RunnerConfig(microsoft={"a": "cfg-ms-a@x.example"})
    emails = login.resolve_emails(args, {}, cfg)
    assert emails["A"] == "cfg-ms-a@x.example"


def test_resolve_emails_deprecated_alias_overrides_first_letter():
    args = make_args(email="alias@x.example", letters=["B"])
    emails = login.resolve_emails(args, {}, None)
    assert emails["B"] == "alias@x.example"


def test_resolve_emails_no_match_anywhere_is_empty_string():
    args = make_args()
    emails = login.resolve_emails(args, {}, None)
    assert emails == {"A": "", "B": "", "C": ""}


def test_resolve_emails_all_three_letters_resolved_independently():
    args = make_args(email_a="a@x.example")
    environ = {"B_EXPECTED_EMAIL": "b@x.example"}
    cfg = login._smoke_identity_module().RunnerConfig(google={"c": "c@x.example"})
    emails = login.resolve_emails(args, environ, cfg)
    assert emails == {"A": "a@x.example", "B": "b@x.example", "C": "c@x.example"}


# =============================================================================
# main() integration — a shell holding BOTH casts resolves the right family
# =============================================================================


def test_main_google_provider_uses_plain_env_family_not_ms(monkeypatch):
    monkeypatch.setenv("A_EXPECTED_EMAIL", "google-a@x.example")
    monkeypatch.setenv("MS_A_EXPECTED_EMAIL", "ms-a@x.example")

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        assert expected == "google-a@x.example"

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, _err = run_main(["A", "--url", URL, "--no-config"])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    env = exports(out.splitlines())
    assert env["A_EXPECTED_EMAIL"] == "google-a@x.example"


def test_main_microsoft_provider_uses_ms_env_family_not_plain(monkeypatch):
    # The end-to-end regression: a shell that ALSO has a Google cast
    # exported (the normal state of the operator's dev shell) must not leak a
    # Google address into a Microsoft mint.
    monkeypatch.setenv("A_EXPECTED_EMAIL", "google-a@x.example")
    monkeypatch.setenv("MS_A_EXPECTED_EMAIL", "ms-a@x.example")

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        assert expected == "ms-a@x.example"

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, _err = run_main(["A", "--provider", "microsoft", "--url", MICROSOFT_URL, "--no-config"])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    env = exports(out.splitlines())
    assert env["MS_A_EXPECTED_EMAIL"] == "ms-a@x.example"


def test_main_uses_config_default_email_when_flag_omitted(tmp_path, monkeypatch):
    _clear_letter_env_vars(monkeypatch)
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text(
        '[google]\na = "cfg-a@x.example"\nb = "cfg-b@x.example"\nc = "cfg-c@x.example"\n'
    )
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        assert expected == "cfg-a@x.example"

    def fail_prompt(label):
        raise AssertionError("prompt() should not be called when the config supplies the email")

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    old_prompt = login.prompt
    login.prompt = fail_prompt
    try:
        code, out, _err = run_main(["A", "--url", URL])
    finally:
        login.run_mint, login.verify_identity = old
        login.prompt = old_prompt

    assert code == 0
    env = exports(out.splitlines())
    assert env["A_EXPECTED_EMAIL"] == "cfg-a@x.example"


def test_main_no_config_flag_skips_config_lookup(tmp_path, monkeypatch):
    _clear_letter_env_vars(monkeypatch)
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text('[google]\na = "cfg-a@x.example"\n')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    prompted = {}

    def fake_prompt(label):
        prompted["called"] = True
        return "typed@x.example"

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        assert expected == "typed@x.example"

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    old_prompt = login.prompt
    login.prompt = fake_prompt
    try:
        code, out, _err = run_main(["A", "--url", URL, "--no-config"])
    finally:
        login.run_mint, login.verify_identity = old
        login.prompt = old_prompt

    assert code == 0
    assert prompted.get("called") is True


def test_main_explicit_email_flag_wins_over_config(tmp_path, monkeypatch):
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text('[google]\na = "cfg-a@x.example"\n')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        assert expected == "flag-a@x.example"

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, _err = run_main(["A", "--url", URL, "--email-a", "flag-a@x.example"])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    env = exports(out.splitlines())
    assert env["A_EXPECTED_EMAIL"] == "flag-a@x.example"


def test_main_microsoft_provider_uses_microsoft_config_cast(tmp_path, monkeypatch):
    # No _clear_letter_env_vars here on purpose: a real dev shell has
    # A_EXPECTED_EMAIL/B_/C_ (the GOOGLE family) persistently exported but
    # never the MS_<L>_* family — proving resolve_emails's provider-scoped
    # env lookup means that leftover no longer leaks into a microsoft mint.
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text(
        '[google]\na = "google-a@x.example"\n\n[microsoft]\na = "ms-a@x.example"\n'
    )
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        assert expected == "ms-a@x.example"

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, _err = run_main(["A", "--provider", "microsoft", "--url", MICROSOFT_URL])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    env = exports(out.splitlines())
    assert env["MS_A_EXPECTED_EMAIL"] == "ms-a@x.example"


def test_main_config_fallback_covers_letters_not_being_minted(tmp_path, monkeypatch):
    # NIT (Opus review): with [microsoft] a/b/c ALL set, minting only A must
    # still populate B and C's *_EXPECTED_EMAIL export lines from config —
    # the "other letters" block in build_exports reads whatever main()
    # resolved for every letter, not just the one(s) actually being minted.
    config_dir = tmp_path / "optical-smoke"
    config_dir.mkdir()
    (config_dir / "config.toml").write_text(
        '[microsoft]\na = "ms-a@x.example"\nb = "ms-b@x.example"\nc = "ms-c@x.example"\n'
    )
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, out, _err = run_main(["A", "--provider", "microsoft", "--url", MICROSOFT_URL])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    env = exports(out.splitlines())
    assert env["MS_A_EXPECTED_EMAIL"] == "ms-a@x.example"
    assert env["MS_B_EXPECTED_EMAIL"] == "ms-b@x.example"
    assert env["MS_C_EXPECTED_EMAIL"] == "ms-c@x.example"


# =============================================================================
# --provider microsoft — prompts, diagnostics, and the "Next:" hint
# =============================================================================


def test_main_passes_provider_through_to_run_mint():
    captured = {}

    def fake_run_mint(url, client_id, port, provider="google"):
        captured["provider"] = provider
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        run_main(["A", "--provider", "microsoft", "--url", MICROSOFT_URL, "--email-a", EMAILS["A"]])
    finally:
        login.run_mint, login.verify_identity = old
    assert captured["provider"] == "microsoft"


def test_main_microsoft_prompts_say_microsoft_account_and_inprivate():
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main([
            "A", "--provider", "microsoft", "--url", MICROSOFT_URL, "--email-a", EMAILS["A"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "Microsoft account" in err
    assert "InPrivate" in err
    assert "Google chooser" not in err


def test_main_google_prompts_unaffected_by_provider_flag():
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main(["A", "--url", URL, "--email-a", EMAILS["A"]])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "Google chooser" in err


def test_main_microsoft_next_hint_mentions_provider_flag():
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main([
            "A", "--provider", "microsoft", "--url", MICROSOFT_URL, "--email-a", EMAILS["A"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "--provider microsoft" in err


# -- next_hint: pure function, tested directly for both providers --


def test_next_hint_google_points_at_multiuser_smoke_dry_run():
    hint = login.next_hint("google", ["A"], ["A"])
    assert "op run --env-file=.env -- bin/multiuser-smoke.py --dry-run" in hint
    assert "smoke-runner.py" not in hint


def test_next_hint_microsoft_points_at_smoke_runner_and_manual_mapping():
    hint = login.next_hint("microsoft", ["A"], ["A"])
    assert "bin/smoke-runner.py" in hint
    assert "projects MS_<L>_* onto <L>_*" in hint
    assert "A_BEARER=$MS_A_BEARER" in hint
    assert "A_REFRESH=$MS_A_REFRESH" in hint
    assert "A_EXPECTED_EMAIL=$MS_A_EXPECTED_EMAIL" in hint
    assert (
        "op run --env-file=.env -- bin/multiuser-smoke.py --provider microsoft --dry-run"
        in hint
    )
    # The old google-flavoured hint (which reads plain A_*, not MS_A_*) must
    # not survive into the microsoft branch.
    assert "bin/multiuser-smoke.py --dry-run" not in hint.replace(
        "bin/multiuser-smoke.py --provider microsoft --dry-run", ""
    )


def test_main_microsoft_success_hint_uses_smoke_runner_not_plain_dry_run():
    def fake_run_mint(url, client_id, port, provider="google"):
        return "bear", "refr"

    def fake_verify_identity(url, bearer, letter, expected, provider="google"):
        return None

    old = _patch_mint(fake_run_mint, fake_verify_identity)
    try:
        code, _out, err = run_main([
            "A", "--provider", "microsoft", "--url", MICROSOFT_URL, "--email-a", EMAILS["A"],
        ])
    finally:
        login.run_mint, login.verify_identity = old

    assert code == 0
    assert "bin/smoke-runner.py" in err
    assert "A_BEARER=$MS_A_BEARER" in err


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
