#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Offline guards for bin/identity-smoke.py, the live admin-rebind smoke
(runbook §S "Admin rebind"): env guards (prod denied, mismatched env pair,
A and B the same account), the pure predicates every step asserts with, the
re-mint argv and export parsing, the drift step's login_email restore, step
sequencing, and the summary lines the smoke runner's colon parser reads.

The live run needs real tokens and a browser sign-in, so it is the operator's;
everything here runs with fakes.

Run: uv run bin/test_identity_smoke.py
"""
from __future__ import annotations

import importlib.util
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ids = _load("identity_smoke_test", "identity-smoke.py")
reg = _load("_smoke_registry_for_identity_test", "_smoke_registry.py")
smoke_lib = ids._smoke_lib

DEV_URL = "https://scheduler-dev.example.com"
A = "a@x.example"
B = "b@x.example"


# =============================================================================
# Env guards
# =============================================================================


def test_binds_the_shared_guards():
    assert ids.assert_dev_url is smoke_lib.assert_dev_url
    assert ids.assert_dev_db is smoke_lib.assert_dev_db
    assert ids.assert_env_consistent is smoke_lib.assert_env_consistent
    assert ids.d1_for_db_id is smoke_lib.d1_for_db_id


def _set_env(monkeypatch, url=DEV_URL, db_id=None, a=A, b=B):
    for k in ("SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL", "A_CLIENT_ID",
              "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL", "B_CLIENT_ID", "D1_DATABASE_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SCHEDULER_URL", url)
    for k in ("A_BEARER", "A_REFRESH", "B_BEARER", "B_REFRESH"):
        monkeypatch.setenv(k, "x")
    monkeypatch.setenv("A_EXPECTED_EMAIL", a)
    monkeypatch.setenv("B_EXPECTED_EMAIL", b)
    monkeypatch.setenv("D1_DATABASE_ID", db_id or smoke_lib.DEV_DB_ID)


def test_env_accepts_dev(monkeypatch):
    _set_env(monkeypatch)
    env = ids.SmokeEnv.from_environ("google")
    assert env.a.expected_email == A
    assert env.b.expected_email == B
    assert env.b.client_id == "smoke-cli"
    assert env.provider == "google"


def test_env_reads_the_client_ids(monkeypatch):
    _set_env(monkeypatch)
    monkeypatch.setenv("B_CLIENT_ID", "other-cli")
    assert ids.SmokeEnv.from_environ("google").b.client_id == "other-cli"


def test_env_refuses_the_prod_url(monkeypatch):
    _set_env(monkeypatch, url="https://scheduler.example.com")
    with pytest.raises(SystemExit):
        ids.SmokeEnv.from_environ("google")


def test_env_refuses_the_prod_db(monkeypatch):
    _set_env(monkeypatch, db_id=smoke_lib.PROD_DB_ID)
    with pytest.raises(SystemExit):
        ids.SmokeEnv.from_environ("google")




@pytest.mark.parametrize("b", [A, A.upper(), f" {A} "])
def test_env_refuses_b_being_the_admin_account(monkeypatch, b):
    # A rebind revokes every token of the account it names: rebinding A
    # would kill the admin bearer driving the run.
    _set_env(monkeypatch, b=b)
    with pytest.raises(SystemExit) as ei:
        ids.SmokeEnv.from_environ("google")
    assert "same account" in str(ei.value)


def test_env_requires_every_var(monkeypatch):
    _set_env(monkeypatch)
    monkeypatch.delenv("B_REFRESH")
    with pytest.raises(SystemExit):
        ids.SmokeEnv.from_environ("google")


# =============================================================================
# State SQL — table/column names checked against the migrations and
# worker/src/auth/identity-rebind.ts, not guessed.
# =============================================================================


def test_state_sql_names_the_real_columns():
    sql = ids.state_sql(A, B, marker_id="t1", pending_id="p1", code_hash="c1", plan_hash="pl1", feed_id="f1")
    assert "FROM identity_tokens WHERE account_email = 'b@x.example'" in sql
    assert "FROM oauth_tokens WHERE subject = 'b@x.example' AND revoked_at IS NULL" in sql
    assert "FROM oauth_codes WHERE subject = 'b@x.example'" in sql
    assert "FROM pending_actions WHERE owner_subject = 'b@x.example'" in sql
    assert "FROM calendar_sync WHERE owner_subject = 'b@x.example'" in sql
    for col in ("next_sync_token", "channel_id", "channel_token", "channel_expires_at",
                "channel_resource_id", "channel_callback_url"):
        assert col in sql
    assert "FROM audit_log WHERE subject = 'b@x.example'" in sql
    assert "FROM users WHERE subject = 'a@x.example'" in sql
    assert "FROM tasks WHERE id = 't1' AND owner_subject = 'b@x.example'" in sql
    assert "FROM pending_actions WHERE id = 'p1'" in sql
    assert "FROM oauth_codes WHERE code_hash = 'c1'" in sql
    assert "FROM proposed_plans WHERE subject = 'b@x.example' AND committed_at IS NULL" in sql
    assert "FROM calendar_feed_tokens WHERE owner_subject = 'b@x.example' AND revoked_at IS NULL" in sql
    assert "FROM proposed_plans WHERE plan_hash = 'pl1'" in sql
    assert "FROM calendar_feed_tokens WHERE id = 'f1' AND revoked_at IS NULL" in sql


def test_state_sql_reads_the_credential_length_never_the_ciphertext():
    sql = ids.state_sql(A, B)
    assert "(SELECT length(refresh_token_encrypted) FROM identity_tokens WHERE account_email = 'b@x.example') AS b_cred_bytes" in sql
    assert "hex(refresh_token_encrypted)" not in sql
    assert "SELECT refresh_token_encrypted" not in sql


def test_state_sql_escapes_quotes():
    sql = ids.state_sql(A, "o'brien@x.example")
    assert "'o''brien@x.example'" in sql


def test_state_sql_without_seeds_reads_zero_for_them():
    sql = ids.state_sql(A, B)
    assert "0 AS marker_present" in sql
    assert "0 AS seeded_pending_present" in sql
    assert "0 AS seeded_code_present" in sql
    assert "0 AS seeded_plan_present" in sql
    assert "0 AS seeded_feed_live" in sql


# =============================================================================
# Pure predicates
# =============================================================================


def good_state(**over) -> dict:
    s = {
        "a_role": "admin", "a_active": 1,
        "b_role": "member", "b_active": 1, "b_created_at": "2026-01-01T00:00:00Z",
        "b_home_tz": None, "b_done_color_id": None,
        "b_ident_rows": 1, "b_provider": "google", "b_provider_subject": "10987",
        "b_login_email": B, "b_cred_bytes": 120,
        "b_live_tokens": 2, "b_codes": 1, "b_pending": 1,
        "b_sync_rows": 1, "b_sync_dirty": 1, "b_channels": 1,
        "b_rebind_audits": 0,
        "fp_task_templates": 3, "fp_config_business_hours": 1, "fp_config_weights": 0,
        "fp_config_contexts": 0, "fp_calendar_feed_tokens": 1,
        "marker_present": 1, "seeded_pending_present": 1, "seeded_code_present": 1,
        "b_pending_plans": 1, "b_live_feeds": 1, "seeded_plan_present": 1, "seeded_feed_live": 1,
    }
    s.update(over)
    return s


def test_preflight_passes_a_good_state():
    assert ids.check_preflight(good_state(), B, "google") == []


@pytest.mark.parametrize("over,needle", [
    ({"a_role": "member"}, "A is not an active admin"),
    ({"a_active": 0}, "A is not an active admin"),
    ({"b_role": "admin"}, "B is an admin"),
    ({"b_active": 0}, "B is not active"),
    ({"b_ident_rows": 0}, "no identity_tokens row"),
    ({"b_provider": "microsoft"}, "provider"),
    ({"b_provider_subject": None}, "provider_subject"),
    ({"b_login_email": None}, "login_email is NULL"),
    ({"b_login_email": "renamed@x.example"}, "subject_drifted"),
    ({"b_live_tokens": 0}, "no live oauth_tokens"),
    ({"b_cred_bytes": 0}, "refresh credential"),
    ({"b_cred_bytes": None}, "refresh credential"),
])
def test_preflight_names_each_bad_precondition(over, needle):
    errs = ids.check_preflight(good_state(**over), B, "google")
    assert errs and any(needle in e for e in errs), errs


def test_preflight_null_provider_reads_as_google():
    assert ids.check_preflight(good_state(b_provider=None), B, "google") == []


def test_preflight_login_email_case_only_difference_is_not_drift():
    assert ids.check_preflight(good_state(b_login_email=B.upper()), B, "google") == []


def test_error_response_matches():
    assert ids.check_error_response(400, {"error": "validation_failed", "issues": []},
                                    400, "validation_failed", "blank") is None


@pytest.mark.parametrize("status,body", [
    (200, {"ok": True}),
    (400, {"error": "subject_required"}),
    (403, {"error": "validation_failed"}),
])
def test_error_response_mismatch_names_the_case(status, body):
    err = ids.check_error_response(status, body, 400, "validation_failed", "blank subject")
    assert err and "blank subject" in err and str(status) in err


def test_drift_response():
    body = {"error": "subject_drifted", "subject": B, "login_email": "d@x.example"}
    assert ids.check_drift_response(409, body, B, "d@x.example") is None
    assert ids.check_drift_response(200, {"ok": True}, B, "d@x.example")
    assert ids.check_drift_response(409, {**body, "login_email": B}, B, "d@x.example")
    assert ids.check_drift_response(409, {**body, "subject": A}, B, "d@x.example")


def test_drift_untouched_passes_when_nothing_changed():
    before = good_state()
    after = good_state(b_login_email="d@x.example")
    assert ids.check_drift_untouched(before, after, "d@x.example") == []


@pytest.mark.parametrize("over,needle", [
    ({"b_provider_subject": None}, "provider_subject"),
    ({"b_rebind_audits": 1}, "audit"),
    ({"b_live_tokens": 0}, "oauth_tokens"),
    ({"b_pending": 0}, "pending_actions"),
    ({"b_codes": 0}, "oauth_codes"),
    ({"b_sync_dirty": 0}, "calendar_sync"),
    ({"b_login_email": B}, "login_email"),
    ({"b_pending_plans": 0}, "proposed_plans"),
    ({"b_live_feeds": 0}, "calendar_feed_tokens"),
])
def test_drift_untouched_flags_any_write(over, needle):
    after = good_state(b_login_email="d@x.example")
    after.update(over)
    errs = ids.check_drift_untouched(good_state(), after, "d@x.example")
    assert errs and any(needle in e for e in errs), errs


def good_rebind_body(**over) -> dict:
    b = {"ok": True, "subject": B, "previous_provider": "google",
         "previous_provider_subject": "10987", "login_email": B, "forced": False}
    b.update(over)
    return b


def test_rebind_body_passes():
    assert ids.check_rebind_body(good_rebind_body(), B, good_state()) == []


@pytest.mark.parametrize("over,needle", [
    ({"ok": False}, "ok"),
    ({"subject": B.upper()}, "subject"),
    ({"previous_provider": "microsoft"}, "previous_provider"),
    ({"previous_provider_subject": None}, "previous_provider_subject"),
    ({"login_email": None}, "login_email"),
    ({"forced": True}, "forced"),
    ({"extra": 1}, "keys"),
])
def test_rebind_body_flags_each_field(over, needle):
    errs = ids.check_rebind_body(good_rebind_body(**over), B, good_state())
    assert errs and any(needle in e for e in errs), errs


def test_rebind_body_missing_key():
    body = good_rebind_body()
    del body["forced"]
    errs = ids.check_rebind_body(body, B, good_state())
    assert any("keys" in e for e in errs), errs


def cleared_state(**over) -> dict:
    s = good_state(b_provider_subject=None, b_live_tokens=0, b_codes=0, b_pending=0,
                   b_sync_dirty=0, b_channels=0, b_rebind_audits=1,
                   seeded_pending_present=0, seeded_code_present=0,
                   b_pending_plans=0, b_live_feeds=0, seeded_plan_present=0, seeded_feed_live=0,
                   b_cred_bytes=0)
    s.update(over)
    return s


def test_after_rebind_passes():
    assert ids.check_after_rebind(good_state(), cleared_state()) == []


@pytest.mark.parametrize("over,needle", [
    ({"b_provider_subject": "10987"}, "provider_subject"),
    ({"b_provider": "microsoft"}, "provider"),
    ({"b_login_email": None}, "login_email"),
    ({"b_sync_dirty": 1}, "calendar_sync"),
    ({"b_sync_rows": 0}, "calendar_sync"),
    ({"b_live_tokens": 1}, "oauth_tokens"),
    ({"b_codes": 1}, "oauth_codes"),
    ({"seeded_code_present": 1}, "oauth_codes"),
    ({"b_pending": 1}, "pending_actions"),
    ({"seeded_pending_present": 1}, "pending_actions"),
    ({"b_pending_plans": 1}, "proposed_plans"),
    ({"seeded_plan_present": 1}, "proposed_plans"),
    ({"b_live_feeds": 1}, "calendar_feed_tokens"),
    ({"seeded_feed_live": 1}, "calendar_feed_tokens"),
    ({"b_rebind_audits": 2}, "audit"),
    ({"b_rebind_audits": 0}, "audit"),
    ({"fp_task_templates": 2}, "fp_task_templates"),
    ({"marker_present": 0}, "marker_present"),
    ({"b_done_color_id": "11"}, "b_done_color_id"),
    ({"a_role": "member"}, "A"),
    ({"b_ident_rows": 0}, "identity_tokens"),
    ({"b_cred_bytes": 120}, "refresh credential"),
    ({"b_cred_bytes": None}, "refresh credential"),
])
def test_after_rebind_flags_each_regression(over, needle):
    errs = ids.check_after_rebind(good_state(), cleared_state(**over))
    assert errs and any(needle in e for e in errs), errs


def test_audit_row():
    row = {"action": "identity_rebind", "table_name": "identity_tokens", "source": "admin", "actor": A}
    assert ids.check_audit_row(row, A) == []
    assert ids.check_audit_row(None, A)
    assert ids.check_audit_row({**row, "action": "identity_rebind_forced"}, A)
    assert ids.check_audit_row({**row, "actor": B}, A)
    assert ids.check_audit_row({**row, "source": "api"}, A)
    assert ids.check_audit_row({**row, "table_name": "users"}, A)


def reanchored_state(**over) -> dict:
    s = cleared_state(b_provider_subject="10987", b_live_tokens=1, b_cred_bytes=131)
    s.update(over)
    return s


def test_after_remint_passes():
    assert ids.check_after_remint(good_state(), reanchored_state(), B) == []


def test_after_remint_login_email_case_only_difference_passes():
    assert ids.check_after_remint(good_state(), reanchored_state(b_login_email=B.upper()), B) == []


@pytest.mark.parametrize("over,needle", [
    ({"b_provider_subject": None}, "provider_subject"),
    ({"b_provider_subject": "other"}, "provider_subject"),
    ({"b_provider": "microsoft"}, "provider"),
    ({"b_login_email": None}, "login_email"),
    ({"b_login_email": "else@x.example"}, "login_email"),
    ({"b_live_tokens": 0}, "oauth_tokens"),
    ({"fp_config_business_hours": 0}, "fp_config_business_hours"),
    ({"marker_present": 0}, "marker_present"),
    ({"b_cred_bytes": 0}, "refresh credential"),
    ({"b_cred_bytes": None}, "refresh credential"),
])
def test_after_remint_flags_each_regression(over, needle):
    errs = ids.check_after_remint(good_state(), reanchored_state(**over), B)
    assert errs and any(needle in e for e in errs), errs


def test_old_bearer_refusal_must_say_revoked():
    # requireBearer answers revoked_token for a revoked row, expired_token for
    # an expired one: only the first proves the rebind ended the session.
    assert ids.check_old_bearer_refusal(401, {"error": "revoked_token"}) is None
    assert ids.check_old_bearer_refusal(401, {"error": "expired_token"})
    assert ids.check_old_bearer_refusal(200, {"email": B})


def test_old_refresh_refusal_must_say_revoked():
    # "revoked" proves the rebind killed it, not an expiry or a client mismatch.
    assert ids.check_old_refresh_refusal(400, {"error": "invalid_grant", "error_description": "revoked"}) is None
    assert ids.check_old_refresh_refusal(400, {"error": "invalid_grant", "error_description": "expired"})
    assert ids.check_old_refresh_refusal(400, {"error": "invalid_grant"})
    assert ids.check_old_refresh_refusal(200, {"access_token": "x"})


def test_old_refresh_refusal_message_never_echoes_tokens():
    err = ids.check_old_refresh_refusal(200, {"access_token": "leaky", "refresh_token": "leaky2"})
    assert "leaky" not in err


def test_eventually_retries_until_clean():
    calls = []
    answers = [["lagging"], ["lagging"], []]

    def check():
        calls.append(1)
        return answers[len(calls) - 1]

    slept = []
    assert ids.eventually(check, attempts=5, delay=0.5, sleep=slept.append) == []
    assert len(calls) == 3
    assert slept == [0.5, 0.5]


def test_eventually_returns_the_last_errors():
    assert ids.eventually(lambda: ["still bad"], attempts=3, delay=0, sleep=lambda _s: None) == ["still bad"]


# =============================================================================
# Re-mint: argv and export parsing. Tokens never reach an error message.
# =============================================================================


def test_remint_argv_google():
    argv = ids.remint_argv(DEV_URL, "google", A, B, "smoke-cli")
    assert argv[0].endswith("mu-smoke-login.py")
    assert argv[1:] == ["B", "--url", DEV_URL, "--provider", "google",
                        "--email-a", A, "--email-b", B, "--no-config"]


def test_remint_argv_passes_a_non_default_client_id():
    argv = ids.remint_argv(DEV_URL, "microsoft", A, B, "other-cli")
    assert argv[-2:] == ["--client-id", "other-cli"]
    assert "microsoft" in argv


LOGIN_OUT_GOOGLE = "\n".join([
    f"export SCHEDULER_URL={DEV_URL}",
    "export D1_DATABASE_ID=x",
    "export B_BEARER=bear-new",
    "export B_REFRESH=refr-new",
    f"export B_EXPECTED_EMAIL={B}",
    "export B_MINTED_AT=2026-10-24T00:00:00+00:00",
    f"export A_EXPECTED_EMAIL={A}",
])


def test_parse_login_exports_google():
    assert ids.parse_login_exports(LOGIN_OUT_GOOGLE, "B", "google") == ("bear-new", "refr-new")


def test_parse_login_exports_microsoft_reads_the_ms_family():
    out = "export MS_B_BEARER=msb\nexport MS_B_REFRESH=msr\nexport B_BEARER=wrong\n"
    assert ids.parse_login_exports(out, "B", "microsoft") == ("msb", "msr")


def test_parse_login_exports_missing_never_echoes_tokens():
    with pytest.raises(ValueError) as ei:
        ids.parse_login_exports("export B_BEARER=secret-bearer\n", "B", "google")
    assert "secret-bearer" not in str(ei.value)


def test_default_remint_runs_the_login_and_parses(monkeypatch):
    seen = {}

    class Proc:
        returncode = 0
        stdout = LOGIN_OUT_GOOGLE

    def fake_run(argv, **kw):
        seen["argv"] = argv
        seen["kw"] = kw
        return Proc()

    got = ids.default_remint(DEV_URL, "google", A, B, "smoke-cli", run=fake_run)
    assert got == ("bear-new", "refr-new")
    assert seen["argv"][1] == "B"
    # stdout captured (the exports), stderr inherited (the browser prompts).
    assert seen["kw"].get("stdout") is not None
    assert "stderr" not in seen["kw"]


def test_default_remint_failure_raises(monkeypatch):
    class Proc:
        returncode = 1
        stdout = ""

    with pytest.raises(ids.RemintFailed):
        ids.default_remint(DEV_URL, "google", A, B, "smoke-cli", run=lambda argv, **kw: Proc())


# =============================================================================
# Step sequencing and output
# =============================================================================


def test_run_steps_stops_at_the_first_failure():
    ran = []

    def ok(label):
        return lambda: ran.append(label)

    def boom():
        ran.append("I2")
        raise AssertionError("nope")

    results = ids.run_steps([("I1", ok("I1")), ("I2", boom), ("I3", ok("I3"))], clock=lambda: 0.0)
    assert ran == ["I1", "I2"]
    assert [(r.label, r.passed) for r in results] == [("I1", True), ("I2", False)]
    assert results[1].notes == "nope"


def test_run_steps_turns_an_unexpected_exception_into_a_failure():
    def crash():
        raise RuntimeError("wrangler exploded")

    results = ids.run_steps([("I1", crash)], clock=lambda: 0.0)
    assert not results[0].passed
    assert "RuntimeError" in results[0].notes and "wrangler exploded" in results[0].notes


def test_summary_lines_parse_with_the_runner_colon_grammar():
    results = [ids.StepResult("I1", True, 1.25, ""), ids.StepResult("I2", False, 0.5, "bad 404")]
    text = "\n".join(ids.format_summary(results, total=len(ids.STEPS)))
    parsed = reg._parse_colon(text)
    assert [(p.label, p.status) for p in parsed] == [("I1", "PASS"), ("I2", "FAIL")]
    assert "TOTAL 1/6" in text
    assert "not run: I3, I4, I5, I6" in text


def test_summary_all_pass_has_the_terminal_marker():
    results = [ids.StepResult(s, True, 0.1, "") for s in ids.STEPS]
    text = "\n".join(ids.format_summary(results, total=len(ids.STEPS)))
    assert reg._COLON_MULTIUSER_TOTAL_RE.search(text)
    assert "not run" not in text


# =============================================================================
# The drift step: login_email is restored even when the call goes wrong.
# =============================================================================


class FakeD1:
    def __init__(self, states):
        self.states = list(states)
        self.executed: list[str] = []

    def query(self, sql):
        assert self.states, f"unexpected query: {sql}"
        return [self.states.pop(0)]

    def execute(self, sql):
        self.executed.append(sql)


class FakeResp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


class FakeSched:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, path, **kw):
        self.calls.append((method, path, kw))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _smoke(d1, sa, sb=None):
    env = ids.SmokeEnv(
        url=DEV_URL,
        a=smoke_lib.Identity(DEV_URL, "ab", "ar", A),
        b=smoke_lib.Identity(DEV_URL, "bb", "br", B),
        db_id=smoke_lib.DEV_DB_ID, repo_root=BIN.parent, provider="google",
    )
    s = ids.IdentitySmoke(env, d1=d1, sa=sa, sb=sb or FakeSched([]), http=None,
                          remint=None, sleep=lambda _s: None)
    s.before = good_state()
    return s


def _restore_sql(s):
    return [q for q in s.d1.executed if "SET login_email = 'b@x.example'" in q]


def test_drift_step_passes_and_restores_login_email(monkeypatch):
    drift_holder = {}
    d1 = FakeD1([])
    sa = FakeSched([])

    def respond(method, path, **kw):
        drift = kw["json"]["subject"]
        assert drift == B
        email = drift_holder["email"]
        return FakeResp(409, {"error": "subject_drifted", "subject": B, "login_email": email})

    s = _smoke(d1, sa)
    monkeypatch.setattr(ids, "_drift_email", lambda: drift_holder.setdefault("email", "id-smoke-drift-1@example.invalid"))
    sa.request = respond
    d1.states = [good_state(b_login_email="id-smoke-drift-1@example.invalid"), good_state()]
    s.check_drift()
    assert any("SET login_email = 'id-smoke-drift-1@example.invalid'" in q for q in d1.executed)
    restore = _restore_sql(s)
    assert len(restore) == 1
    # CAS on the drift value, so a sign-in that landed meanwhile isn't clobbered.
    assert "AND login_email = 'id-smoke-drift-1@example.invalid'" in restore[0]
    assert s.login_email_to_restore is None


def test_drift_step_restores_even_when_the_call_raises(monkeypatch):
    d1 = FakeD1([good_state()])
    sa = FakeSched([RuntimeError("network down")])
    s = _smoke(d1, sa)
    monkeypatch.setattr(ids, "_drift_email", lambda: "id-smoke-drift-2@example.invalid")
    with pytest.raises(RuntimeError):
        s.check_drift()
    assert len(_restore_sql(s)) == 1
    assert s.login_email_to_restore is None


def test_drift_step_fails_on_a_200(monkeypatch):
    d1 = FakeD1([good_state()])
    sa = FakeSched([FakeResp(200, good_rebind_body(forced=False))])
    s = _smoke(d1, sa)
    monkeypatch.setattr(ids, "_drift_email", lambda: "id-smoke-drift-3@example.invalid")
    with pytest.raises(AssertionError) as ei:
        s.check_drift()
    assert "subject_drifted" in str(ei.value)
    assert len(_restore_sql(s)) == 1
    # The rebind ran, so the summary must tell the operator to re-mint B.
    assert s.rebind_attempted is True


def test_unverified_restore_is_left_for_cleanup(monkeypatch):
    d1 = FakeD1([good_state(b_login_email="id-smoke-drift-4@example.invalid")] * 20)
    sa = FakeSched([FakeResp(409, {"error": "subject_drifted", "subject": B,
                                   "login_email": "id-smoke-drift-4@example.invalid"})])
    s = _smoke(d1, sa)
    monkeypatch.setattr(ids, "_drift_email", lambda: "id-smoke-drift-4@example.invalid")
    with pytest.raises(AssertionError):
        s.check_drift()
    assert s.login_email_to_restore == (B, "id-smoke-drift-4@example.invalid")
    d1.executed.clear()
    s.cleanup()
    assert len(_restore_sql(s)) == 1


def test_negative_cases_send_the_non_admin_call_at_an_unknown_subject():
    # A broken admin gate must not be able to rebind anything: B's bearer is
    # aimed at a subject that doesn't exist, so a 404 (not 200) is the worst
    # case.
    sa = FakeSched([
        FakeResp(400, {"error": "validation_failed", "issues": []}),
        FakeResp(400, {"error": "validation_failed", "issues": []}),
        FakeResp(400, {"error": "validation_failed", "issues": []}),
        FakeResp(404, {"error": "unknown_subject"}),
    ])
    sb = FakeSched([FakeResp(403, {"error": "forbidden_not_admin"})])
    s = _smoke(FakeD1([]), sa, sb)
    s.check_refusals()
    assert [c[1] for c in sa.calls] == [ids.REBIND_PATH] * 4
    (_m, path, kw), = sb.calls
    assert path == ids.REBIND_PATH
    assert kw["json"]["subject"] != B and kw["json"]["subject"].endswith(".invalid")


def test_negative_cases_fail_on_a_wrong_status():
    sa = FakeSched([FakeResp(200, {"ok": True})])
    s = _smoke(FakeD1([]), sa)
    with pytest.raises(AssertionError) as ei:
        s.check_refusals()
    assert "missing subject" in str(ei.value)


def test_rebind_never_names_a():
    sa = FakeSched([])
    s = _smoke(FakeD1([]), sa)
    s.env = ids.SmokeEnv(url=DEV_URL, a=s.env.a,
                         b=smoke_lib.Identity(DEV_URL, "bb", "br", A.upper()),
                         db_id=s.env.db_id, repo_root=s.env.repo_root, provider="google")
    with pytest.raises(AssertionError):
        s.rebind_b()
    assert sa.calls == []


# =============================================================================
# I4-I6 against a routed fake D1
# =============================================================================


class RoutedD1:
    """Answers each query by what it reads; `state` is the next read_state row."""

    def __init__(self, state, stamps=("2026-10-24T00:00:00.000Z",), collateral=0, audit=None):
        self.state = state
        self.stamps = list(stamps)
        self.collateral = collateral
        self.audit = audit if audit is not None else {
            "action": "identity_rebind", "table_name": "identity_tokens", "source": "admin", "actor": A}
        self.queries: list[str] = []
        self.executed: list[str] = []

    def query(self, sql):
        self.queries.append(sql)
        if sql.startswith("SELECT (SELECT role FROM users"):
            return [self.state]
        if sql.startswith("SELECT hashed_token"):
            return [{"hashed_token": "h1"}, {"hashed_token": "h2"}]
        if sql.startswith("SELECT DISTINCT revoked_at"):
            return [{"revoked_at": st} for st in self.stamps]
        if "COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IN" in sql:
            return [{"n": self.collateral}]
        if "FROM audit_log" in sql:
            return [self.audit] if self.audit else []
        raise AssertionError(f"unexpected query: {sql}")

    def execute(self, sql):
        self.executed.append(sql)


class FakeHttp:
    def __init__(self, bearer_resp=(401, {"error": "revoked_token"}),
                 refresh_resp=(400, {"error": "invalid_grant", "error_description": "revoked"})):
        self.bearer_resp = bearer_resp
        self.refresh_resp = refresh_resp
        self.calls = []

    def get(self, url, headers):
        self.calls.append(("GET", url, headers))
        return FakeResp(*self.bearer_resp)

    def post(self, url, data):
        self.calls.append(("POST", url, data))
        return FakeResp(*self.refresh_resp)


class TokenSched(FakeSched):
    bearer = "old-bearer"
    refresh_token = "old-refresh"


def _whoami(email, provider="google"):
    return FakeResp(200, {"email": email, "home_tz": "UTC", "provider": provider})


def _rebound(d1, http=None, sa_responses=(), sb=None):
    s = _smoke(d1, FakeSched(list(sa_responses)), sb or TokenSched([]))
    s.http = http or FakeHttp()
    s.old_b_tokens = ("old-bearer", "old-refresh")
    s.old_b_hashes = ["h1", "h2"]
    return s


def test_preflight_checks_both_whoamis_and_the_state():
    d1 = RoutedD1(good_state())
    s = _smoke(d1, FakeSched([_whoami(A)]), FakeSched([_whoami(B)]))
    s.before = {}
    s.preflight()
    assert s.before == good_state()
    assert s.original_login_email == B


def test_preflight_refuses_a_bad_precondition():
    s = _smoke(RoutedD1(good_state(b_role="admin")), FakeSched([_whoami(A)]), FakeSched([_whoami(B)]))
    with pytest.raises(AssertionError) as ei:
        s.preflight()
    assert "B is an admin" in str(ei.value)


def test_preflight_turns_a_dead_b_token_into_a_remint_hint():
    sb = FakeSched([smoke_lib.RefreshRejected(B, 400, "invalid_grant")])
    s = _smoke(RoutedD1(good_state()), FakeSched([_whoami(A)]), sb)
    with pytest.raises(AssertionError) as ei:
        s.preflight()
    assert "mu-smoke-login.py B" in str(ei.value)


def test_preflight_refuses_the_wrong_b_account():
    s = _smoke(RoutedD1(good_state()), FakeSched([_whoami(A)]), FakeSched([_whoami("c@x.example")]))
    with pytest.raises(AssertionError):
        s.preflight()


def test_seed_creates_a_done_marker_a_channel_and_the_session_rows():
    d1 = RoutedD1(good_state())
    sb = FakeSched([FakeResp(201, {"id": "task-1"}), FakeResp(200, {"ok": True, "subscribed": True})])
    s = _smoke(d1, FakeSched([]), sb)
    s.seed()
    (m1, p1, kw1), (m2, p2, _kw2) = sb.calls
    assert (m1, p1) == ("POST", "/v1/tasks")
    assert kw1["json"]["status"] == "done"
    assert kw1["json"]["source"]["external_id"].startswith("id-smoke-")
    assert (m2, p2) == ("POST", "/v1/webhook/subscribe")
    assert s.marker_id == "task-1"
    pending, code, plan, feed = d1.executed
    assert pending.startswith("INSERT INTO pending_actions") and f"'{s.pending_id}'" in pending
    assert "'b@x.example'" in pending
    assert code.startswith("INSERT INTO oauth_codes") and f"'{s.code_hash}'" in code
    assert "'b@x.example'" in code
    # A pending (uncommitted) plan the rebind must delete, and a live feed it
    # must revoke.
    assert plan.startswith("INSERT INTO proposed_plans") and f"'{s.plan_hash}'" in plan
    assert "'b@x.example'" in plan and "NULL" in plan
    assert feed.startswith("INSERT INTO calendar_feed_tokens") and f"'{s.feed_id}'" in feed
    assert "'b@x.example'" in feed
    # Both expire about an hour out: a run killed before the rebind must not
    # leave a row that holds one of B's 20 pending-action slots for ever (the
    # sweep only removes expired rows).
    for sql in (pending, code, plan):
        stamps = [datetime.fromisoformat(m.replace("Z", "+00:00"))
                  for m in re.findall(r"'(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)'", sql)]
        expires = max(stamps)
        now = datetime.now(timezone.utc)
        assert now + timedelta(minutes=50) < expires < now + timedelta(minutes=70), sql
    # read_state now carries the seeds.
    assert f"tasks WHERE id = 'task-1'" in d1.queries[-1]


@pytest.mark.parametrize("over,needle", [
    ({"seeded_plan_present": 0}, "proposed_plans"),
    ({"seeded_feed_live": 0}, "calendar_feed_tokens"),
])
def test_seed_fails_when_a_plan_or_feed_seed_did_not_land(over, needle):
    d1 = RoutedD1(good_state(**over))
    sb = FakeSched([FakeResp(201, {"id": "task-1"}), FakeResp(200, {"ok": True, "subscribed": True})])
    s = _smoke(d1, FakeSched([]), sb)
    with pytest.raises(AssertionError) as ei:
        s.seed()
    assert needle in str(ei.value)


def test_seed_fails_when_subscribe_reports_no_working_channel():
    # subscribeWebhook answers subscribed:true for an already-live channel
    # too, so false means B has no working push channel.
    d1 = RoutedD1(good_state())
    sb = FakeSched([FakeResp(201, {"id": "task-1"}), FakeResp(200, {"ok": True, "subscribed": False})])
    s = _smoke(d1, FakeSched([]), sb)
    with pytest.raises(AssertionError) as ei:
        s.seed()
    assert "push subscribe" in str(ei.value)


def test_seed_fails_when_the_channel_did_not_land():
    d1 = RoutedD1(good_state(b_channels=0))
    sb = FakeSched([FakeResp(201, {"id": "task-1"}), FakeResp(200, {"ok": True, "subscribed": True})])
    s = _smoke(d1, FakeSched([]), sb)
    with pytest.raises(AssertionError) as ei:
        s.seed()
    assert "push channel" in str(ei.value)


def test_rebind_b_snapshots_the_live_tokens_and_sends_a_folded_subject():
    d1 = RoutedD1(good_state())
    sa = FakeSched([FakeResp(200, good_rebind_body())])
    s = _smoke(d1, sa, TokenSched([]))
    s.rebind_b()
    assert s.old_b_tokens == ("old-bearer", "old-refresh")
    assert s.old_b_hashes == ["h1", "h2"]
    (_m, path, kw), = sa.calls
    assert path == ids.REBIND_PATH
    assert kw["json"]["subject"] == f" {B.upper()} "
    assert s.rebind_attempted is True


def test_after_rebind_passes_with_a_clean_world():
    d1 = RoutedD1(cleared_state())
    s = _rebound(d1, sa_responses=[_whoami(A)])
    s.after_rebind()
    get, post = s.http.calls
    assert get[2] == {"Authorization": "Bearer old-bearer"}
    assert post[2]["refresh_token"] == "old-refresh" and post[2]["grant_type"] == "refresh_token"


def test_after_rebind_fails_when_another_subjects_token_shares_the_stamp():
    s = _rebound(RoutedD1(cleared_state(), collateral=1), sa_responses=[_whoami(A)])
    with pytest.raises(AssertionError) as ei:
        s.after_rebind()
    assert "other subjects" in str(ei.value)


def test_after_rebind_fails_when_a_pre_rebind_token_is_still_live():
    s = _rebound(RoutedD1(cleared_state(), stamps=("2026-10-24T00:00:00.000Z", None)),
                 sa_responses=[_whoami(A)])
    with pytest.raises(AssertionError) as ei:
        s.after_rebind()
    assert "still live" in str(ei.value)


def test_after_rebind_fails_on_a_bad_audit_actor():
    audit = {"action": "identity_rebind", "table_name": "identity_tokens", "source": "admin", "actor": B}
    s = _rebound(RoutedD1(cleared_state(), audit=audit), sa_responses=[_whoami(A)])
    with pytest.raises(AssertionError) as ei:
        s.after_rebind()
    assert "actor" in str(ei.value)


def test_after_rebind_fails_when_the_old_bearer_still_works():
    s = _rebound(RoutedD1(cleared_state()), http=FakeHttp(bearer_resp=(200, {"email": B})),
                 sa_responses=[_whoami(A)])
    with pytest.raises(AssertionError) as ei:
        s.after_rebind()
    assert "old bearer" in str(ei.value)


def test_after_rebind_fails_when_a_is_broken():
    s = _rebound(RoutedD1(cleared_state()), sa_responses=[FakeResp(401, {"error": "revoked_token"})])
    with pytest.raises(AssertionError) as ei:
        s.after_rebind()
    assert "A after the rebind" in str(ei.value)


def test_remint_b_rebuilds_b_and_checks_the_reanchor():
    d1 = RoutedD1(reanchored_state())
    s = _rebound(d1)
    s.marker_id = "task-1"
    seen = {}

    def fake_remint(url, provider, a_email, b_email, client_id):
        seen["args"] = (url, provider, a_email, b_email, client_id)
        return "new-bearer", "new-refresh"

    built = []

    def make_client(identity):
        built.append(identity)
        return FakeSched([_whoami(B), FakeResp(200, {"id": "task-1"})])

    s.remint = fake_remint
    s.make_client = make_client
    s.remint_b()
    assert seen["args"] == (DEV_URL, "google", A, B, "smoke-cli")
    assert built[0].bearer == "new-bearer" and built[0].refresh_token == "new-refresh"
    assert [c[1] for c in s.sb2.calls] == ["/v1/whoami", "/v1/tasks/task-1"]


def test_remint_b_fails_when_the_anchor_is_a_different_identity():
    s = _rebound(RoutedD1(reanchored_state(b_provider_subject="someone-else")))
    s.marker_id = "task-1"
    s.remint = lambda *a: ("nb", "nr")
    s.make_client = lambda identity: FakeSched([_whoami(B), FakeResp(200, {})])
    with pytest.raises(AssertionError) as ei:
        s.remint_b()
    assert "provider_subject" in str(ei.value)


def test_remint_b_keeps_no_client_when_whoami_is_the_wrong_account():
    # Cleanup acts through sb2 (marker delete, channel re-subscribe), so a
    # client that isn't B must never become sb2.
    s = _rebound(RoutedD1(reanchored_state()))
    s.marker_id = "task-1"
    s.remint = lambda *a: ("nb", "nr")
    s.make_client = lambda identity: FakeSched([_whoami("c@x.example")])
    with pytest.raises(AssertionError):
        s.remint_b()
    assert s.sb2 is None


def test_cleanup_deletes_seeds_and_resubscribes_with_the_new_bearer():
    d1 = RoutedD1(good_state())
    s = _smoke(d1, FakeSched([]))
    s.pending_id, s.code_hash, s.marker_id = "pa-1", "code-1", "task-1"
    s.plan_hash, s.feed_id = "plan-1", "feed-1"
    s.sb2 = FakeSched([FakeResp(204, {}), FakeResp(200, {"ok": True, "subscribed": True})])
    s.cleanup()
    assert any("DELETE FROM pending_actions WHERE id = 'pa-1'" in q for q in d1.executed)
    assert any("DELETE FROM oauth_codes WHERE code_hash = 'code-1'" in q for q in d1.executed)
    assert any("DELETE FROM proposed_plans WHERE plan_hash = 'plan-1' AND subject = 'b@x.example'" in q
               for q in d1.executed)
    assert any("DELETE FROM calendar_feed_tokens WHERE id = 'feed-1' AND owner_subject = 'b@x.example'" in q
               for q in d1.executed)
    assert not any("DELETE FROM tasks" in q for q in d1.executed)
    assert [(c[0], c[1]) for c in s.sb2.calls] == [("DELETE", "/v1/tasks/task-1"),
                                                   ("POST", "/v1/webhook/subscribe")]


def test_cleanup_without_a_new_b_deletes_the_marker_in_d1():
    d1 = RoutedD1(good_state())
    s = _smoke(d1, FakeSched([]))
    s.marker_id = "task-1"
    s.cleanup()
    assert any("DELETE FROM tasks WHERE id = 'task-1' AND owner_subject = 'b@x.example'" in q
               for q in d1.executed)


# =============================================================================
# CLI
# =============================================================================


def test_parse_args_defaults():
    args = ids.parse_args([])
    assert args.provider == "google"
    assert args.dry_run is False


def test_parse_args_accepts_the_registry_level():
    assert ids.parse_args(["--levels", "rebind"]).levels == "rebind"


def test_parse_args_rejects_an_unknown_level():
    with pytest.raises(SystemExit):
        ids.parse_args(["--levels", "I3"])


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, *sys.argv[1:]]))
