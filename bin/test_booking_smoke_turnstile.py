# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for booking-smoke.py's Turnstile secret swap-run-restore wrapper.

install_turnstile_secret reuses secret_put_command and subprocess_runner from
create-turnstile-widget.py — both already covered by
test_create_turnstile_widget.py — so what's new here is only the wrapping:
does a non-zero wrangler exit raise, and does that raise avoid leaking the
secret value it was passed (the property that actually matters, per
test_secret_never_reaches_stdout_or_stderr in that file).
"""
import importlib.util
import pathlib
import sys
import tomllib

import pytest

_spec = importlib.util.spec_from_file_location(
    "booking_smoke", pathlib.Path(__file__).parent / "booking-smoke.py"
)
assert _spec and _spec.loader, "could not load booking-smoke module"
booking_smoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = booking_smoke
_spec.loader.exec_module(booking_smoke)

SECRET = "REPLACE_WITH_YOUR_TURNSTILE_SITE_KEYfffGGGhhhIIIjjjKKK"
REPO_ROOT = pathlib.Path("/repo")


def test_install_turnstile_secret_succeeds_when_wrangler_exits_zero(monkeypatch):
    calls = {}

    def fake_runner(cmd, stdin_text):
        calls["cmd"] = cmd
        calls["stdin"] = stdin_text
        return 0

    monkeypatch.setattr(booking_smoke._ct, "subprocess_runner", fake_runner)
    booking_smoke.install_turnstile_secret(REPO_ROOT, SECRET)
    assert calls["stdin"] == SECRET
    assert calls["cmd"][:5] == ["npx", "wrangler", "secret", "put", "TURNSTILE_SECRET"]
    assert calls["cmd"][-2:] == ["--env", "dev"]




def test_install_turnstile_secret_raises_when_wrangler_exits_nonzero(monkeypatch):
    monkeypatch.setattr(booking_smoke._ct, "subprocess_runner", lambda cmd, stdin_text: 1)
    with pytest.raises(RuntimeError):
        booking_smoke.install_turnstile_secret(REPO_ROOT, SECRET)


def test_install_turnstile_secret_error_never_contains_the_secret(monkeypatch):
    monkeypatch.setattr(booking_smoke._ct, "subprocess_runner", lambda cmd, stdin_text: 1)
    with pytest.raises(RuntimeError) as exc:
        booking_smoke.install_turnstile_secret(REPO_ROOT, SECRET)
    assert SECRET not in str(exc.value)


# restore_turnstile_secret wraps install_turnstile_secret for the finally-block
# restore specifically. These monkeypatch booking_smoke.install_turnstile_secret
# directly rather than _ct.subprocess_runner underneath it: what's under test is
# restore_turnstile_secret's own control flow (what it appends to cleaned/
# not_cleaned, whether it prints, whether it re-raises) given a success/failure
# from install_turnstile_secret, not wrangler's command shape — that's already
# covered by the tests above.


def test_restore_turnstile_secret_success_records_cleaned_and_raises_nothing(monkeypatch):
    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", lambda repo_root, secret, wrangler_env="dev": None)
    cleaned: list[str] = []
    not_cleaned: list[str] = []
    booking_smoke.restore_turnstile_secret(REPO_ROOT, SECRET, cleaned, not_cleaned)
    assert cleaned == ["TURNSTILE_SECRET restored to the real dev secret"]
    assert not_cleaned == []


def test_restore_turnstile_secret_ordinary_exception_records_not_cleaned_and_does_not_raise(monkeypatch):
    def raise_runtime_error(repo_root, secret, wrangler_env="dev"):
        raise RuntimeError("`npx wrangler secret put ...` exited 1")

    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", raise_runtime_error)
    cleaned: list[str] = []
    not_cleaned: list[str] = []
    booking_smoke.restore_turnstile_secret(REPO_ROOT, SECRET, cleaned, not_cleaned)
    assert cleaned == []
    assert len(not_cleaned) == 1
    assert "CRITICAL" in not_cleaned[0]
    assert "TURNSTILE_SECRET" in not_cleaned[0]


def test_restore_turnstile_secret_keyboard_interrupt_prints_and_reraises(monkeypatch, capsys):
    def raise_keyboard_interrupt(repo_root, secret, wrangler_env="dev"):
        raise KeyboardInterrupt()

    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", raise_keyboard_interrupt)
    cleaned: list[str] = []
    not_cleaned: list[str] = []
    with pytest.raises(KeyboardInterrupt):
        booking_smoke.restore_turnstile_secret(REPO_ROOT, SECRET, cleaned, not_cleaned)
    assert cleaned == []
    assert len(not_cleaned) == 1
    assert "CRITICAL" in not_cleaned[0]
    printed = capsys.readouterr().out
    assert "CRITICAL" in printed
    assert not_cleaned[0] in printed


def test_restore_turnstile_secret_error_never_contains_the_secret(monkeypatch, capsys):
    # Uses the real install_turnstile_secret (only _ct.subprocess_runner is
    # faked), mirroring test_install_turnstile_secret_error_never_contains_the_secret
    # above: that's what actually proves the property against the true code
    # path, rather than against a stand-in that could leak the secret in ways
    # the real function never would.
    monkeypatch.setattr(booking_smoke._ct, "subprocess_runner", lambda cmd, stdin_text: 1)
    cleaned: list[str] = []
    not_cleaned: list[str] = []
    booking_smoke.restore_turnstile_secret(REPO_ROOT, SECRET, cleaned, not_cleaned)
    assert SECRET not in not_cleaned[0]
    assert SECRET not in capsys.readouterr().out


def test_restore_failure_message_still_carries_the_manual_recovery_command(monkeypatch):
    # The rest of the suite only substring-matches "CRITICAL", so the recovery
    # command itself could drift unnoticed. It's the one thing an operator reads
    # off this line at 3am to un-stick dev, so pin it verbatim — and pin it
    # against _ct.secret_put_command, the code that actually builds the command,
    # so the two can't diverge silently either.
    def raise_runtime_error(repo_root, secret, wrangler_env="dev"):
        raise RuntimeError("`npx wrangler secret put ...` exited 1")

    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", raise_runtime_error)
    not_cleaned: list[str] = []
    booking_smoke.restore_turnstile_secret(REPO_ROOT, SECRET, [], not_cleaned)
    assert "cd worker && " + " ".join(booking_smoke._ct.secret_put_command("dev")) in not_cleaned[0]
    assert "Turnstile Secret - Dev" in not_cleaned[0]


def test_client_module_pattern_matches_the_hashed_path_not_the_old_flat_one():
    # The client module moved from /book/_static/booking.js to a content-hashed
    # /book/_static/booking.<hash>.js inside an internal PR, which updated page.ts,
    # route.ts and the vitest suite but not this harness — B2 then asserted a
    # string the product deliberately never emits (worker/test/booking/
    # static.test.ts asserts the flat path is ABSENT). Match the shape, not a
    # literal: the hash changes on every booking.client.js edit, so pinning one
    # would just re-break on the next client change.
    hashed = '<script type="module" src="/book/_static/booking.d02dc18baf7f91df.js"></script>'
    assert booking_smoke.BOOKING_CLIENT_SRC_RE.search(hashed)
    assert not booking_smoke.BOOKING_CLIENT_SRC_RE.search(
        '<script type="module" src="/book/_static/booking.js"></script>'
    )


def test_wait_for_turnstile_swap_returns_immediately_when_already_live():
    slept: list[float] = []
    waited = booking_smoke.wait_for_turnstile_swap(
        probe=lambda: 400, sleep=slept.append, deadline_s=60
    )
    assert waited == 0.0
    assert slept == []


def test_wait_for_turnstile_swap_polls_until_the_swap_lands():
    codes = iter([403, 403, 400])
    slept: list[float] = []
    waited = booking_smoke.wait_for_turnstile_swap(
        probe=lambda: next(codes), sleep=slept.append, deadline_s=60
    )
    assert len(slept) == 2
    assert waited == sum(slept)


def test_wait_for_turnstile_swap_gives_up_and_names_the_cause():
    slept: list[float] = []
    with pytest.raises(RuntimeError) as exc:
        booking_smoke.wait_for_turnstile_swap(
            probe=lambda: 403, sleep=slept.append, deadline_s=4
        )
    # The operator has to be able to tell this apart from a real B4 failure.
    assert "challenge_failed" in str(exc.value)
    assert slept, "should have waited before giving up"


# --- _decline_invite / _accept_invite: thin wrappers over the shared,
# provider-neutral rsvp_as_attendee (2026-09-17 review fix). Decline mode used
# to call rsvp_invite directly, which is Google-only (builds a Google REST URL
# off attendee_cal.BASE/_calendar_id and PATCHes a Google attendees array) —
# AttributeError on a GraphCalendarClient, and Graph gives each attendee's
# copy a DIFFERENT event id from the organiser's, so the organiser's id
# wouldn't even locate the right copy. rsvp_as_attendee (bin/_smoke_lib.py)
# resolves that per provider; these wrappers just pin the response value,
# same shape as bin/meeting-smoke.py's accept_invite.


def test_decline_invite_routes_through_rsvp_as_attendee_with_declined(monkeypatch):
    calls = []

    def fake_rsvp_as_attendee(organiser_cal, attendee_cal, event_id, self_email, response, **kwargs):
        calls.append((organiser_cal, attendee_cal, event_id, self_email, response))

    monkeypatch.setattr(booking_smoke, "rsvp_as_attendee", fake_rsvp_as_attendee)
    owner_cal, attendee_cal = object(), object()
    booking_smoke._decline_invite(owner_cal, attendee_cal, "evt-1", "attendee@x")

    assert calls == [(owner_cal, attendee_cal, "evt-1", "attendee@x", "declined")]


def test_accept_invite_routes_through_rsvp_as_attendee_with_accepted(monkeypatch):
    calls = []

    def fake_rsvp_as_attendee(organiser_cal, attendee_cal, event_id, self_email, response, **kwargs):
        calls.append((organiser_cal, attendee_cal, event_id, self_email, response))

    monkeypatch.setattr(booking_smoke, "rsvp_as_attendee", fake_rsvp_as_attendee)
    owner_cal, attendee_cal = object(), object()
    booking_smoke._accept_invite(owner_cal, attendee_cal, "evt-2", "attendee@x")

    assert calls == [(owner_cal, attendee_cal, "evt-2", "attendee@x", "accepted")]


def test_gmail_sent_query_pins_the_search_syntax():
    query = booking_smoke.gmail_sent_query("booker@example.com", "Cancelled: your", 1700000000)
    assert query == 'in:sent to:booker@example.com subject:"Cancelled: your" after:1700000000'


# --- wait_for_sent_email: calls reader.find_sent(...), provider-agnostic ---
# (2026-09-17: generalised from a direct GmailClient.list_messages call so
# the decline mode's D10a/D10b checks work identically against a
# GmailSentReader or a GraphSentReader — see bin/test_booking_smoke_guard.py
# for the reader classes themselves.)


def test_wait_for_sent_email_returns_as_soon_as_find_sent_is_true():
    calls: list[tuple] = []

    class FakeReader:
        def find_sent(self, to_email, subject_substring, after_epoch):
            calls.append((to_email, subject_substring, after_epoch))
            return True

    booking_smoke.wait_for_sent_email(
        FakeReader(), "bob@example.com", "Cancelled: your", 1700000000, "booker cancellation",
    )
    assert calls == [("bob@example.com", "Cancelled: your", 1700000000)]


def test_wait_for_sent_email_polls_before_succeeding(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr(booking_smoke.time, "sleep", slept.append)
    results = iter([False, False, True])

    class FakeReader:
        def find_sent(self, *a, **k):
            return next(results)

    booking_smoke.wait_for_sent_email(
        FakeReader(), "bob@example.com", "Cancelled", 0, "label", timeout=60.0, interval=1.0,
    )
    assert slept == [1.0, 1.0]


def test_wait_for_sent_email_raises_after_timeout_naming_the_label():
    class AlwaysFalseReader:
        def find_sent(self, *a, **k):
            return False

    with pytest.raises(AssertionError) as exc:
        booking_smoke.wait_for_sent_email(
            AlwaysFalseReader(), "bob@example.com", "Cancelled", 0, "booker cancellation",
            timeout=0.05, interval=0.01,
        )
    assert "booker cancellation" in str(exc.value)


# The sweep applies the grace cutoff ITSELF (listCancelPendingDue only returns
# rows with cancel_pending_at <= now - grace) — force-firing the cron does not
# bypass it. The harness must therefore wait out the grace before firing; this
# helper computes how long. First live run failed exactly here: fired inside
# the 1-minute dev grace, sweep found zero due rows, D8 timed out.
def test_seconds_until_sweep_due_waits_out_the_grace():
    # Stamp at t=1000s, grace 1 min, buffer 10s: due at 1000+60+10=1070.
    wait = booking_smoke.seconds_until_sweep_due(
        "2026-08-17T22:42:26Z", now_epoch=1787006546.0 + 30.0,
        grace_minutes=1, buffer_s=10.0,
    )
    # 2026-08-17T22:42:26Z == epoch 1787006546; 30s already elapsed → 40 left.
    assert wait == 40.0


def test_seconds_until_sweep_due_returns_zero_once_due():
    wait = booking_smoke.seconds_until_sweep_due(
        "2026-08-17T22:42:26Z", now_epoch=1787006546.0 + 300.0,
        grace_minutes=1, buffer_s=10.0,
    )
    assert wait == 0.0


# --- force_scheduled_cron: wrangler_env must reach the actual `wrangler dev
# --env <wrangler_env>` argv, not a hardcoded "dev" (2026-09-17 review nit —
# no test previously covered this, even though run_decline_mode already
# passes wrangler_env=wrangler_env through). ---


class _FakeSchedProc:
    """Stand-in for subprocess.Popen's return value: never exits on its own
    (poll() -> None), terminate/wait are no-ops — force_scheduled_cron's
    readiness loop proceeds straight to the (also-faked) httpx probes."""

    def poll(self):
        return None

    def terminate(self):
        pass

    def wait(self, timeout=None):
        pass


class _FakeSchedResponse:
    def __init__(self, status_code: int = 200):
        self.status_code = status_code
        self.text = ""


class _FakeSchedClient:
    """Stand-in for httpx.Client: every GET (the readiness probe AND the
    /__scheduled call) succeeds immediately — no real network, no real
    sleep."""

    def __init__(self, *a, **k):
        pass

    def get(self, url, **kwargs):
        return _FakeSchedResponse(200)

    def close(self):
        pass


def test_force_scheduled_cron_passes_wrangler_env_through_to_the_argv(monkeypatch):
    captured: dict = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeSchedProc()

    monkeypatch.setattr(booking_smoke.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(booking_smoke.httpx, "Client", _FakeSchedClient)

    env = "dev"
    resp = booking_smoke.force_scheduled_cron(
        pathlib.Path("/repo"), "*/5 * * * *", wrangler_env=env,
    )

    assert resp.status_code == 200
    cmd = captured["cmd"]
    assert cmd[cmd.index("--env") + 1] == env


# --- SMOKE_GRACE_MINUTES must actually match worker/wrangler.toml's
# BOOKING_DECLINE_GRACE_MINUTES under every smoke env's vars
# (2026-09-17 review nit — the module docstring claimed this but nothing
# tested it; a drift here means force_scheduled_cron fires the sweep before
# the real grace has elapsed and D8 times out, as happened on the first live
# run). Top-level (prod) vars must NOT set it at all — prod keeps env.ts's
# 10-minute default. ---


def test_smoke_grace_minutes_matches_wrangler_toml_smoke_envs():
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    with open(repo_root / "worker" / "wrangler.toml", "rb") as f:
        toml = tomllib.load(f)

    expected = str(booking_smoke.SMOKE_GRACE_MINUTES)
    assert toml["env"]["dev"]["vars"]["BOOKING_DECLINE_GRACE_MINUTES"] == expected
    # Top-level (prod) vars must never set this — prod keeps env.ts's real
    # (10-minute) default; setting it there would silently shorten prod's
    # grace period to match the smoke harness's own.
    assert "BOOKING_DECLINE_GRACE_MINUTES" not in toml.get("vars", {})


def test_force_scheduled_cron_default_wrangler_env_is_dev(monkeypatch):
    captured: dict = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeSchedProc()

    monkeypatch.setattr(booking_smoke.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(booking_smoke.httpx, "Client", _FakeSchedClient)

    booking_smoke.force_scheduled_cron(pathlib.Path("/repo"), "*/5 * * * *")

    cmd = captured["cmd"]
    assert cmd[cmd.index("--env") + 1] == "dev"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
