#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Live smoke for the admin identity rebind (`POST /admin/identity-rebind`,
runbook §S "Admin rebind"), smoke envs only, never prod.

Account A is the admin (its bearer carries the `admin` scope, as for
multiuser-smoke M7's offboard); account B is a test account that gets rebound
and then signs in again. A is never rebound: a rebind revokes every token of
the account it names, so rebinding A would kill the bearer driving the run.

Steps, each checked in D1 (columns per worker/src/auth/identity-rebind.ts):

  I1  preflight: A and B whoami; A an active admin, B not; B's
      identity_tokens row anchored (provider_subject) with an undrifted
      login_email. Read-only (this is all --dry-run does).
  I2  seed B: a done marker task, a push channel, a pending_actions row, an
      oauth_codes row, a pending (uncommitted) proposed_plans row and a live
      calendar_feed_tokens row, so the session purge, the accept-link and
      feed kill, and the data keep are observable.
  I3  refusals: missing/blank subject and a non-JSON body (400
      validation_failed), an unknown subject (404 unknown_subject), B's
      non-admin bearer (403 forbidden_not_admin), and a drifted login_email
      (409 subject_drifted, nothing written; login_email restored).
  I4  rebind B as A: the 200 body.
  I5  after the rebind: anchor cleared, refresh credential wiped (zero
      length; the account is idle until the next sign-in), sync token and
      channel reset, every B token revoked (and nobody else's), codes and
      pending actions gone,
      B's pending plans gone and no live feed left, one identity_rebind audit
      row with actor A, B's data kept; B's old bearer
      401s, its old refresh token is refused, A still works.
  I6  re-mint B (interactive browser sign-in via bin/mu-smoke-login.py): the
      same IdP identity re-anchors (provider_subject as before), a refresh
      credential stored again, login_email recorded, data kept, B sees its
      marker task.

Cleanup always runs: login_email restored if the drift step couldn't confirm
it, seeded rows and the marker task removed, B's push channel re-subscribed
with the new bearer. The shell's B tokens are revoked by the run, so re-mint
B afterwards; so are any calendar feeds B had, so re-create those too. `--provider microsoft` runs the same steps with A and B as
Microsoft accounts.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import httpx

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
assert_dev_db = _smoke_lib.assert_dev_db
assert_dev_url = _smoke_lib.assert_dev_url
assert_env_consistent = _smoke_lib.assert_env_consistent
d1_for_db_id = _smoke_lib.d1_for_db_id
sql_str = _smoke_lib.sql_str
safe_json_body = _smoke_lib.safe_json_body

MU_LOGIN = Path(__file__).resolve().parent / "mu-smoke-login.py"

REBIND_PATH = "/admin/identity-rebind"
TASK_PREFIX = "id-smoke"
STEPS = ("I1", "I2", "I3", "I4", "I5", "I6")
# The registry's single selectable level (bin/_smoke_registry.py); the steps
# depend on each other, so they aren't separately selectable.
LEVELS = ("rebind",)
# D1 read-after-write through `wrangler d1 execute` can lag the worker's own
# write (multiuser M7 hit it), so post-write SQL checks retry.
ATTEMPTS = 6
DELAY_S = 2.0
SEED_TTL = timedelta(hours=1)

REBIND_KEYS = {"ok", "subject", "previous_provider", "previous_provider_subject", "login_email", "forced"}
# B's data the rebind and the re-sign-in must keep. tasks isn't counted (the
# recurrence sweep may add occurrences mid-run); the marker task stands in.
# calendar_feed_tokens counts every row, revoked or not: the rebind revokes
# B's feeds (revoked_at) but keeps the rows; b_live_feeds checks the revoke.
FINGERPRINT_COUNT_TABLES = (
    "task_templates", "config_business_hours", "config_weights", "config_contexts",
    "calendar_feed_tokens",
)
FINGERPRINT_KEYS = (
    "b_role", "b_active", "b_created_at", "b_home_tz", "b_done_color_id",
    *(f"fp_{t}" for t in FINGERPRINT_COUNT_TABLES),
    "marker_present",
)
_SYNC_COLUMNS = (
    "next_sync_token", "channel_id", "channel_token", "channel_expires_at",
    "channel_resource_id", "channel_callback_url",
)


@dataclass(frozen=True)
class SmokeEnv:
    url: str
    a: Identity
    b: Identity
    db_id: str
    repo_root: Path
    provider: str = "google"

    @classmethod
    def from_environ(cls, provider: str = "google") -> "SmokeEnv":
        url = _smoke_lib.req("SCHEDULER_URL").rstrip("/")
        assert_dev_url(url)
        db_id = _smoke_lib.req("D1_DATABASE_ID")
        assert_dev_db(db_id)
        assert_env_consistent(url, db_id)

        def identity(pfx: str) -> Identity:
            return Identity(
                scheduler_url=url,
                bearer=_smoke_lib.req(f"{pfx}_BEARER"),
                refresh_token=_smoke_lib.req(f"{pfx}_REFRESH"),
                expected_email=_smoke_lib.req(f"{pfx}_EXPECTED_EMAIL"),
                client_id=os.environ.get(f"{pfx}_CLIENT_ID", "smoke-cli"),
            )

        a, b = identity("A"), identity("B")
        if a.expected_email.strip().casefold() == b.expected_email.strip().casefold():
            raise SystemExit(
                "REFUSING TO RUN: A and B are the same account. The rebind revokes every "
                "token of B, so B must be a separate test account, never the admin."
            )
        return cls(url=url, a=a, b=b, db_id=db_id,
                   repo_root=Path(__file__).resolve().parent.parent, provider=provider)


# =============================================================================
# State SQL — one row of scalars per read, so each check is one wrangler call
# =============================================================================


def _present(sql_from_where: str | None, alias: str) -> str:
    if sql_from_where is None:
        return f"0 AS {alias}"
    return f"(SELECT COUNT(*) {sql_from_where}) AS {alias}"


def state_sql(a: str, b: str, marker_id: str | None = None, pending_id: str | None = None,
              code_hash: str | None = None, plan_hash: str | None = None,
              feed_id: str | None = None) -> str:
    sa, sb = sql_str(a), sql_str(b)
    ident = f"FROM identity_tokens WHERE account_email = {sb}"
    dirty = " OR ".join(f"{c} IS NOT NULL" for c in _SYNC_COLUMNS)
    cols = [
        f"(SELECT role FROM users WHERE subject = {sa}) AS a_role",
        f"(SELECT is_active FROM users WHERE subject = {sa}) AS a_active",
        f"(SELECT role FROM users WHERE subject = {sb}) AS b_role",
        f"(SELECT is_active FROM users WHERE subject = {sb}) AS b_active",
        f"(SELECT created_at FROM users WHERE subject = {sb}) AS b_created_at",
        f"(SELECT home_tz FROM users WHERE subject = {sb}) AS b_home_tz",
        f"(SELECT done_color_id FROM users WHERE subject = {sb}) AS b_done_color_id",
        f"(SELECT COUNT(*) {ident}) AS b_ident_rows",
        f"(SELECT provider {ident}) AS b_provider",
        f"(SELECT provider_subject {ident}) AS b_provider_subject",
        f"(SELECT login_email {ident}) AS b_login_email",
        # The credential's size only, never its bytes: 0 once the rebind
        # wiped it (X''), positive while a grant is stored.
        f"(SELECT length(refresh_token_encrypted) {ident}) AS b_cred_bytes",
        f"(SELECT COUNT(*) FROM oauth_tokens WHERE subject = {sb} AND revoked_at IS NULL) AS b_live_tokens",
        f"(SELECT COUNT(*) FROM oauth_codes WHERE subject = {sb}) AS b_codes",
        f"(SELECT COUNT(*) FROM pending_actions WHERE owner_subject = {sb}) AS b_pending",
        f"(SELECT COUNT(*) FROM proposed_plans WHERE subject = {sb} AND committed_at IS NULL) AS b_pending_plans",
        f"(SELECT COUNT(*) FROM calendar_feed_tokens WHERE owner_subject = {sb} AND revoked_at IS NULL) AS b_live_feeds",
        f"(SELECT COUNT(*) FROM calendar_sync WHERE owner_subject = {sb}) AS b_sync_rows",
        f"(SELECT COUNT(*) FROM calendar_sync WHERE owner_subject = {sb} AND ({dirty})) AS b_sync_dirty",
        f"(SELECT COUNT(*) FROM calendar_sync WHERE owner_subject = {sb} AND channel_id IS NOT NULL) AS b_channels",
        f"(SELECT COUNT(*) FROM audit_log WHERE subject = {sb} "
        f"AND action IN ('identity_rebind', 'identity_rebind_forced')) AS b_rebind_audits",
        *(f"(SELECT COUNT(*) FROM {t} WHERE owner_subject = {sb}) AS fp_{t}" for t in FINGERPRINT_COUNT_TABLES),
        _present(None if marker_id is None
                 else f"FROM tasks WHERE id = {sql_str(marker_id)} AND owner_subject = {sb}", "marker_present"),
        _present(None if pending_id is None
                 else f"FROM pending_actions WHERE id = {sql_str(pending_id)}", "seeded_pending_present"),
        _present(None if code_hash is None
                 else f"FROM oauth_codes WHERE code_hash = {sql_str(code_hash)}", "seeded_code_present"),
        _present(None if plan_hash is None
                 else f"FROM proposed_plans WHERE plan_hash = {sql_str(plan_hash)}", "seeded_plan_present"),
        _present(None if feed_id is None
                 else f"FROM calendar_feed_tokens WHERE id = {sql_str(feed_id)} AND revoked_at IS NULL",
                 "seeded_feed_live"),
    ]
    return "SELECT " + ", ".join(cols)


# =============================================================================
# Pure predicates — each returns the failures (empty = pass)
# =============================================================================


def _provider(value) -> str:
    # NULL reads as google everywhere (identity-store.ts, readRebindTarget).
    return value or "google"


def _has_credential(state: dict) -> bool:
    n = state.get("b_cred_bytes")
    return isinstance(n, int) and n > 0


def _same(email_a, email_b) -> bool:
    return isinstance(email_a, str) and isinstance(email_b, str) and email_a.casefold() == email_b.casefold()


def check_preflight(state: dict, b_email: str, provider: str) -> list[str]:
    errs: list[str] = []
    if state.get("a_role") != "admin" or state.get("a_active") != 1:
        errs.append(f"A is not an active admin (role={state.get('a_role')!r}, "
                    f"is_active={state.get('a_active')!r}); the rebind needs an admin bearer")
    if state.get("b_role") == "admin":
        errs.append("B is an admin: use a non-admin test account (the non-admin refusal "
                    "case runs on B's bearer)")
    if state.get("b_active") != 1:
        errs.append(f"B is not active (is_active={state.get('b_active')!r})")
    if state.get("b_ident_rows") != 1:
        errs.append("B has no identity_tokens row: mint B first")
        return errs
    if _provider(state.get("b_provider")) != provider:
        errs.append(f"B's identity_tokens provider is {_provider(state.get('b_provider'))!r}, "
                    f"not {provider!r}")
    if state.get("b_provider_subject") is None:
        errs.append("B's provider_subject is NULL (a pre-0037 row or an earlier rebind): "
                    "re-mint B so the anchor is set before rebinding it")
    if state.get("b_login_email") is None:
        errs.append("B's login_email is NULL (no sign-in since migration 0046): re-mint B first")
    elif not _same(state.get("b_login_email"), b_email):
        errs.append(f"B's login_email {state.get('b_login_email')!r} differs from its subject "
                    f"{b_email!r} (a renamed account): the plain rebind would answer "
                    f"409 subject_drifted; use an account that was never renamed")
    if not state.get("b_live_tokens"):
        errs.append("B has no live oauth_tokens row")
    if not _has_credential(state):
        errs.append("B has no stored refresh credential (an earlier rebind wiped it): re-mint B first")
    return errs


def check_error_response(status: int, body: dict, want_status: int, want_error: str,
                         what: str) -> str | None:
    if status == want_status and body.get("error") == want_error:
        return None
    return f"{what}: expected {want_status} {want_error}, got {status} {body}"


def check_drift_response(status: int, body: dict, subject: str, drift_email: str) -> str | None:
    want = {"error": "subject_drifted", "subject": subject, "login_email": drift_email}
    if status == 409 and all(body.get(k) == v for k, v in want.items()):
        return None
    return f"drifted login_email: expected 409 {want}, got {status} {body}"


def check_drift_untouched(before: dict, after: dict, drift_email: str) -> list[str]:
    """A 409 subject_drifted refusal writes nothing."""
    errs: list[str] = []
    if after.get("b_provider_subject") != before.get("b_provider_subject"):
        errs.append("drift refusal changed provider_subject")
    if after.get("b_login_email") != drift_email:
        errs.append(f"drift refusal changed login_email (now {after.get('b_login_email')!r})")
    if after.get("b_rebind_audits") != before.get("b_rebind_audits"):
        errs.append("drift refusal wrote an identity_rebind audit row")
    for key, table in (("b_live_tokens", "oauth_tokens"), ("b_pending", "pending_actions"),
                       ("b_codes", "oauth_codes"), ("b_sync_dirty", "calendar_sync"),
                       ("b_pending_plans", "proposed_plans"), ("b_live_feeds", "calendar_feed_tokens")):
        if after.get(key) != before.get(key):
            errs.append(f"drift refusal changed {table} ({before.get(key)!r} -> {after.get(key)!r})")
    return errs


def check_rebind_body(body: dict, subject: str, before: dict) -> list[str]:
    errs: list[str] = []
    if set(body) != REBIND_KEYS:
        errs.append(f"response keys {sorted(body)} != {sorted(REBIND_KEYS)}")
    want = {
        "ok": True,
        "subject": subject,
        "previous_provider": _provider(before.get("b_provider")),
        "previous_provider_subject": before.get("b_provider_subject"),
        "login_email": before.get("b_login_email"),
        "forced": False,
    }
    for key, value in want.items():
        if key in body and body[key] != value:
            errs.append(f"response {key} = {body[key]!r}, expected {value!r}")
    return errs


def _fingerprint_errors(before: dict, after: dict, when: str) -> list[str]:
    return [f"{when}: B's {k} changed ({before.get(k)!r} -> {after.get(k)!r})"
            for k in FINGERPRINT_KEYS if before.get(k) != after.get(k)]


def check_after_rebind(before: dict, after: dict) -> list[str]:
    errs: list[str] = []
    if after.get("b_ident_rows") != 1:
        errs.append("B's identity_tokens row is gone (the row stays, only its credential is wiped)")
    if after.get("b_cred_bytes") != 0:
        errs.append(f"B's refresh credential not wiped (length {after.get('b_cred_bytes')!r}, expected 0): "
                    f"crons would keep refreshing with the previous holder's grant")
    if after.get("b_provider_subject") is not None:
        errs.append("provider_subject not cleared")
    if after.get("b_provider") != before.get("b_provider"):
        errs.append("provider changed")
    if after.get("b_login_email") != before.get("b_login_email"):
        errs.append("login_email changed")
    if after.get("b_sync_rows") != before.get("b_sync_rows"):
        errs.append("calendar_sync rows were added or deleted (only the columns reset)")
    if after.get("b_sync_dirty"):
        errs.append("calendar_sync sync token / push-channel columns not reset")
    if after.get("b_live_tokens"):
        errs.append(f"{after.get('b_live_tokens')} oauth_tokens row(s) of B still live")
    if after.get("b_codes") or after.get("seeded_code_present"):
        errs.append("oauth_codes of B not deleted")
    if after.get("b_pending") or after.get("seeded_pending_present"):
        errs.append("pending_actions of B not deleted")
    # The accept links the previous holder was emailed name these plans.
    if after.get("b_pending_plans") or after.get("seeded_plan_present"):
        errs.append("pending (uncommitted) proposed_plans of B not deleted")
    if after.get("b_live_feeds") or after.get("seeded_feed_live"):
        errs.append(f"{after.get('b_live_feeds')} calendar_feed_tokens row(s) of B still live (not revoked)")
    if after.get("b_rebind_audits") != (before.get("b_rebind_audits") or 0) + 1:
        errs.append(f"expected exactly one new identity_rebind audit row "
                    f"({before.get('b_rebind_audits')!r} -> {after.get('b_rebind_audits')!r})")
    if after.get("a_role") != before.get("a_role") or after.get("a_active") != before.get("a_active"):
        errs.append("A's users row changed")
    errs += _fingerprint_errors(before, after, "after rebind")
    return errs


def check_audit_row(row: dict | None, a_subject: str) -> list[str]:
    if row is None:
        return ["no identity_rebind audit row"]
    want = {"action": "identity_rebind", "table_name": "identity_tokens", "source": "admin",
            "actor": a_subject}
    return [f"audit {k} = {row.get(k)!r}, expected {v!r}" for k, v in want.items() if row.get(k) != v]


def check_old_bearer_refusal(status: int, body: dict) -> str | None:
    """requireBearer: revoked_token for a revoked row (expired_token would mean
    it lapsed, which proves nothing about the rebind)."""
    if status == 401 and body.get("error") == "revoked_token":
        return None
    return f"B's old bearer: expected 401 revoked_token on /v1/whoami, got {status} {body.get('error')!r}"


def check_old_refresh_refusal(status: int, body: dict) -> str | None:
    """/oauth/token refuses a revoked refresh token with invalid_grant
    "revoked". Only the error fields are echoed: a 200 body carries tokens."""
    if status == 400 and body.get("error") == "invalid_grant" and body.get("error_description") == "revoked":
        return None
    return (f"B's old refresh token: expected 400 invalid_grant (revoked), got {status} "
            f"{body.get('error')!r} {body.get('error_description')!r}")


def check_after_remint(before: dict, after: dict, b_email: str) -> list[str]:
    """`before` is B's state just before the rebind."""
    errs: list[str] = []
    if after.get("b_provider_subject") != before.get("b_provider_subject"):
        errs.append(f"provider_subject {after.get('b_provider_subject')!r} is not the "
                    f"pre-rebind anchor {before.get('b_provider_subject')!r}")
    if after.get("b_provider") != before.get("b_provider"):
        errs.append(f"provider changed ({before.get('b_provider')!r} -> {after.get('b_provider')!r})")
    if not _same(after.get("b_login_email"), b_email):
        errs.append(f"login_email {after.get('b_login_email')!r} is not B's email {b_email!r}")
    if not after.get("b_live_tokens"):
        errs.append("no live oauth_tokens row for B after the re-mint")
    if not _has_credential(after):
        errs.append(f"no refresh credential stored for B after the re-mint "
                    f"(length {after.get('b_cred_bytes')!r})")
    errs += _fingerprint_errors(before, after, "after re-mint")
    return errs


def eventually(check: Callable[[], list[str]], attempts: int = ATTEMPTS, delay: float = DELAY_S,
               sleep: Callable[[float], None] = time.sleep) -> list[str]:
    errs = check()
    for _ in range(attempts - 1):
        if not errs:
            break
        sleep(delay)
        errs = check()
    return errs


# =============================================================================
# Re-mint — bin/mu-smoke-login.py does the browser sign-in and its own whoami
# check; its stdout (the exports) is captured, never printed or stored
# =============================================================================


class RemintFailed(RuntimeError):
    pass


def remint_argv(url: str, provider: str, a_email: str, b_email: str, client_id: str) -> list[str]:
    argv = [str(MU_LOGIN), "B", "--url", url, "--provider", provider,
            "--email-a", a_email, "--email-b", b_email, "--no-config"]
    if client_id != "smoke-cli":
        argv += ["--client-id", client_id]
    return argv


def parse_login_exports(stdout: str, letter: str, provider: str) -> tuple[str, str]:
    prefix = "MS_" if provider == "microsoft" else ""
    found: dict[str, str] = {}
    for line in stdout.splitlines():
        for suffix in ("BEARER", "REFRESH"):
            head = f"export {prefix}{letter}_{suffix}="
            if line.startswith(head):
                found[suffix] = line[len(head):]
    if not found.get("BEARER") or not found.get("REFRESH"):
        raise ValueError(f"mu-smoke-login printed no {prefix}{letter}_BEARER/_REFRESH pair")
    return found["BEARER"], found["REFRESH"]


def default_remint(url: str, provider: str, a_email: str, b_email: str, client_id: str,
                   run=subprocess.run) -> tuple[str, str]:
    proc = run(remint_argv(url, provider, a_email, b_email, client_id),
               stdout=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RemintFailed(f"mu-smoke-login exited {proc.returncode}")
    try:
        return parse_login_exports(proc.stdout, "B", provider)
    except ValueError as e:
        raise RemintFailed(str(e)) from None


# =============================================================================
# Steps
# =============================================================================


def _iso_ms(when: datetime) -> str:
    """The worker's own timestamp shape (Date.toISOString), so text compares hold."""
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{when.microsecond // 1000:03d}Z"


def _drift_email() -> str:
    return f"{TASK_PREFIX}-drift-{uuid.uuid4().hex[:12]}@example.invalid"


def _unknown_subject() -> str:
    return f"{TASK_PREFIX}-unknown-{uuid.uuid4().hex[:12]}@example.invalid"


def _require(errs: list[str]) -> None:
    if errs:
        raise AssertionError("; ".join(errs))


class IdentitySmoke:
    def __init__(self, env: SmokeEnv, d1, sa, sb, http, remint, sleep=time.sleep):
        self.env = env
        self.d1 = d1
        self.sa = sa
        self.sb = sb
        self.http = http
        self.remint = remint
        self.sleep = sleep
        self.before: dict = {}
        self.marker_id: str | None = None
        self.pending_id: str | None = None
        self.code_hash: str | None = None
        self.plan_hash: str | None = None
        self.feed_id: str | None = None
        # (subject, drift value) while a drift UPDATE may still be in D1.
        self.login_email_to_restore: tuple[str, str] | None = None
        self.original_login_email: str | None = None
        self.rebind_attempted = False
        self.old_b_tokens: tuple[str, str] | None = None
        self.old_b_hashes: list[str] = []
        self.sb2 = None
        self.make_client: Callable[[Identity], object] = SchedulerClient

    @property
    def a_email(self) -> str:
        return self.env.a.expected_email

    @property
    def b_email(self) -> str:
        return self.env.b.expected_email

    def read_state(self) -> dict:
        rows = self.d1.query(state_sql(self.a_email, self.b_email, self.marker_id,
                                       self.pending_id, self.code_hash, self.plan_hash, self.feed_id))
        return rows[0] if rows else {}

    def _eventually(self, check: Callable[[], list[str]]) -> list[str]:
        return eventually(check, sleep=self.sleep)

    def _rebind(self, sched, **kw):
        r = sched.request("POST", REBIND_PATH, **kw)
        return r.status_code, safe_json_body(r)

    # -- I1 -------------------------------------------------------------------

    def preflight(self) -> None:
        for who, sched, ident in (("A", self.sa, self.env.a), ("B", self.sb, self.env.b)):
            try:
                r = sched.request("GET", "/v1/whoami")
            except _smoke_lib.RefreshRejected as e:
                raise AssertionError(_smoke_lib.refresh_rejected_message(e, who, self.env.provider)) from None
            if r.status_code != 200:
                raise AssertionError(f"{who} whoami: {r.status_code} {r.text[:200]}")
            err, warning = _smoke_lib.check_whoami_body(safe_json_body(r), ident.expected_email,
                                                        self.env.provider, who)
            if err:
                raise AssertionError(f"{who}: {err}")
            if warning:
                print(f"identity {who}: {warning}", file=sys.stderr)
        self.before = self.read_state()
        _require(check_preflight(self.before, self.b_email, self.env.provider))
        self.original_login_email = self.before["b_login_email"]

    # -- I2 -------------------------------------------------------------------

    def seed(self) -> None:
        tag = uuid.uuid4().hex[:12]
        r = self.sb.request("POST", "/v1/tasks", json={
            "title": f"[{TASK_PREFIX}] rebind marker", "context": "deep", "priority": 10,
            "earliest_start": f"{date.today().isoformat()}T00:00", "deadline": None,
            "preferred_windows": [], "dependencies": [], "pinned_at": None, "duration_minutes": 15,
            "source": {"kind": "mcp", "external_id": f"{TASK_PREFIX}-{tag}"},
            # done: nothing ever schedules it, so it can't land on B's calendar.
            "status": "done",
        })
        if r.status_code not in (200, 201):
            raise AssertionError(f"marker task: {r.status_code} {r.text[:200]}")
        self.marker_id = r.json()["id"]
        # `subscribed` is true when a live channel is stored after the call,
        # including one B's sign-in already made; false means B has no working
        # push channel. The D1 read in seeded() below checks the row as well.
        r = self.sb.request("POST", "/v1/webhook/subscribe")
        if r.status_code != 200 or r.json().get("subscribed") is not True:
            raise AssertionError(f"push subscribe: {r.status_code} {r.text[:200]}")
        # A confirm link and an unredeemed authorization code, as a connected
        # client would leave them. The code hash has no preimage, so it can't
        # be redeemed.
        # Both expire an hour out (the run takes minutes): a run killed before
        # the rebind leaves rows the sweeps remove, rather than one holding a
        # slot of B's pending-action cap for ever.
        now = datetime.now(timezone.utc)
        created, expires = _iso_ms(now), _iso_ms(now + SEED_TTL)
        self.pending_id = f"{TASK_PREFIX}-pa-{tag}"
        self.d1.execute(
            "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) "
            f"VALUES ({sql_str(self.pending_id)}, {sql_str(self.b_email)}, 'identity-smoke.noop', '{{}}', '{{}}', "
            f"{sql_str(created)}, {sql_str(expires)}, NULL)"
        )
        self.code_hash = f"{TASK_PREFIX}-code-{tag}"
        self.d1.execute(
            "INSERT INTO oauth_codes (code_hash, client_id, kind, scopes, expires_at, subject) "
            f"VALUES ({sql_str(self.code_hash)}, {sql_str(self.env.b.client_id)}, 'auth', 'scheduler:read', "
            f"{sql_str(expires)}, {sql_str(self.b_email)})"
        )
        # A pending plan an emailed accept link would name, for a long-past
        # week so no accept page or resolve treats it as a live week, and a
        # live feed whose token hash has no preimage (it can't be fetched).
        self.plan_hash = f"{TASK_PREFIX}-plan-{tag}"
        ws, we = "2000-01-03T00:00:00Z", "2000-01-10T00:00:00Z"
        body = f'{{"schedule":[],"dropped":[],"window":{{"start":"{ws}","end":"{we}"}}}}'
        self.d1.execute(
            "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, "
            f"window_start, window_end) VALUES ({sql_str(self.plan_hash)}, {sql_str(body)}, {sql_str(created)}, "
            f"{sql_str(expires)}, NULL, {sql_str(self.b_email)}, {sql_str(ws)}, {sql_str(we)})"
        )
        self.feed_id = f"{TASK_PREFIX}-feed-{tag}"
        self.d1.execute(
            "INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, label, reveal_rules, created_at) "
            f"VALUES ({sql_str(self.feed_id)}, {sql_str(self.b_email)}, {sql_str(f'{TASK_PREFIX}-feed-hash-{tag}')}, "
            f"{sql_str(f'{TASK_PREFIX}-{tag}')}, '[]', {sql_str(created)})"
        )

        def seeded() -> list[str]:
            self.before = self.read_state()
            s = self.before
            errs = []
            if not s.get("marker_present"):
                errs.append("marker task not in D1")
            if not s.get("b_channels"):
                errs.append("no push channel in calendar_sync")
            if not s.get("seeded_pending_present"):
                errs.append("seeded pending_actions row missing")
            if not s.get("seeded_code_present"):
                errs.append("seeded oauth_codes row missing")
            if not s.get("seeded_plan_present"):
                errs.append("seeded proposed_plans row missing")
            if not s.get("seeded_feed_live"):
                errs.append("seeded calendar_feed_tokens row missing or not live")
            return errs

        _require(self._eventually(seeded))

    # -- I3 -------------------------------------------------------------------

    def check_refusals(self) -> None:
        unknown = _unknown_subject()
        cases = (
            ("missing subject", dict(json={}), 400, "validation_failed"),
            ("blank subject", dict(json={"subject": "   "}), 400, "validation_failed"),
            ("non-JSON body", dict(content=b"not json"), 400, "validation_failed"),
            ("unknown subject", dict(json={"subject": unknown}), 404, "unknown_subject"),
        )
        for what, kw, want_status, want_error in cases:
            status, body = self._rebind(self.sa, **kw)
            if status == 200:
                self.rebind_attempted = True
            err = check_error_response(status, body, want_status, want_error, what)
            if err:
                raise AssertionError(err)
        # Aimed at a subject that doesn't exist, so a broken admin gate
        # answers 404 rather than rebinding anything.
        status, body = self._rebind(self.sb, json={"subject": unknown})
        err = check_error_response(status, body, 403, "forbidden_not_admin", "non-admin bearer")
        if err:
            raise AssertionError(err)

    def check_drift(self) -> None:
        drift = _drift_email()
        subject = self.b_email
        self.login_email_to_restore = (subject, drift)
        self.d1.execute(f"UPDATE identity_tokens SET login_email = {sql_str(drift)} "
                        f"WHERE account_email = {sql_str(subject)}")
        try:
            status, body = self._rebind(self.sa, json={"subject": subject})
            if status == 200:
                self.rebind_attempted = True
            err = check_drift_response(status, body, subject, drift)
            if err:
                raise AssertionError(err)
            _require(self._eventually(lambda: check_drift_untouched(self.before, self.read_state(), drift)))
        finally:
            self._restore_login_email()
        if self.login_email_to_restore is not None:
            raise AssertionError("could not confirm login_email was restored after the drift case")

    def _restore_login_email(self) -> None:
        if self.login_email_to_restore is None:
            return
        subject, drift = self.login_email_to_restore
        # CAS on the drift value: a sign-in that landed meanwhile wrote the
        # real address, which must not be clobbered.
        self.d1.execute(f"UPDATE identity_tokens SET login_email = {sql_str(self.original_login_email or subject)} "
                        f"WHERE account_email = {sql_str(subject)} AND login_email = {sql_str(drift)}")

        def restored() -> list[str]:
            got = self.read_state().get("b_login_email")
            return [] if got != drift else ["login_email still the drift value"]

        if not self._eventually(restored):
            self.login_email_to_restore = None

    def refusals(self) -> None:
        self.check_refusals()
        self.check_drift()

    # -- I4 -------------------------------------------------------------------

    def rebind_b(self) -> None:
        if _same(self.b_email, self.a_email):
            raise AssertionError("refusing to rebind A")
        self.before = self.read_state()
        self.old_b_tokens = (self.sb.bearer, self.sb.refresh_token)
        rows = self.d1.query(f"SELECT hashed_token FROM oauth_tokens WHERE subject = {sql_str(self.b_email)} "
                             "AND revoked_at IS NULL")
        self.old_b_hashes = [r["hashed_token"] for r in rows]
        self.rebind_attempted = True
        # Trimmed and case-folded on the way in; the response names the stored subject.
        status, body = self._rebind(self.sa, json={"subject": f" {self.b_email.upper()} "})
        if status != 200:
            raise AssertionError(f"rebind: expected 200, got {status} {body}")
        _require(check_rebind_body(body, self.b_email, self.before))

    # -- I5 -------------------------------------------------------------------

    def after_rebind(self) -> None:
        _require(self._eventually(lambda: check_after_rebind(self.before, self.read_state())))
        row = self.d1.query(
            f"SELECT action, table_name, source, actor FROM audit_log WHERE subject = {sql_str(self.b_email)} "
            "AND action IN ('identity_rebind', 'identity_rebind_forced') ORDER BY created_at DESC LIMIT 1"
        )
        _require(check_audit_row(row[0] if row else None, self.a_email))
        # Only B's sessions end: no other subject's token carries the batch's
        # revoked_at stamp.
        if self.old_b_hashes:
            hashes = ", ".join(sql_str(h) for h in self.old_b_hashes)
            stamps = [r["revoked_at"] for r in self.d1.query(
                f"SELECT DISTINCT revoked_at FROM oauth_tokens WHERE hashed_token IN ({hashes})")]
            if None in stamps:
                raise AssertionError("a pre-rebind B token is still live")
            stamp_list = ", ".join(sql_str(s) for s in stamps)
            n = self.d1.query(f"SELECT COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IN ({stamp_list}) "
                              f"AND (subject IS NULL OR subject != {sql_str(self.b_email)})")
            if n and n[0]["n"]:
                raise AssertionError(f"the rebind revoked {n[0]['n']} token(s) of other subjects")
        bearer, refresh = self.old_b_tokens
        r = self.http.get(f"{self.env.url}/v1/whoami", headers={"Authorization": f"Bearer {bearer}"})
        err = check_old_bearer_refusal(r.status_code, safe_json_body(r))
        if err:
            raise AssertionError(err)
        r = self.http.post(f"{self.env.url}/oauth/token", data={
            "grant_type": "refresh_token", "refresh_token": refresh, "client_id": self.env.b.client_id})
        err = check_old_refresh_refusal(r.status_code, safe_json_body(r))
        if err:
            raise AssertionError(err)
        r = self.sa.request("GET", "/v1/whoami")
        err, _warning = _smoke_lib.check_whoami_body(safe_json_body(r), self.a_email, self.env.provider, "A")
        if r.status_code != 200 or err:
            raise AssertionError(f"A after the rebind: {r.status_code} {err}")

    # -- I6 -------------------------------------------------------------------

    def remint_b(self) -> None:
        print(f"\n>>> Sign in as B ({self.b_email}) in the browser window that opens "
              f"(switch accounts or use a private window so you don't reuse A's session).",
              file=sys.stderr, flush=True)
        bearer, refresh = self.remint(self.env.url, self.env.provider, self.a_email, self.b_email,
                                      self.env.b.client_id)
        client = self.make_client(Identity(self.env.url, bearer, refresh, self.b_email, self.env.b.client_id))
        r = client.request("GET", "/v1/whoami")
        err, _warning = _smoke_lib.check_whoami_body(safe_json_body(r), self.b_email, self.env.provider, "B")
        if r.status_code != 200 or err:
            raise AssertionError(f"re-minted B whoami: {r.status_code} {err}")
        # Only a verified B: cleanup deletes the marker and re-subscribes through it.
        self.sb2 = client
        _require(self._eventually(lambda: check_after_remint(self.before, self.read_state(), self.b_email)))
        r = self.sb2.request("GET", f"/v1/tasks/{self.marker_id}")
        if r.status_code != 200:
            raise AssertionError(f"re-minted B can't read its marker task: {r.status_code}")

    # -- cleanup ----------------------------------------------------------------

    def cleanup(self) -> None:
        steps: list[tuple[str, Callable[[], None]]] = [("login_email", self._restore_login_email)]
        if self.pending_id:
            steps.append(("pending_actions", lambda: self.d1.execute(
                f"DELETE FROM pending_actions WHERE id = {sql_str(self.pending_id)}")))
        if self.code_hash:
            steps.append(("oauth_codes", lambda: self.d1.execute(
                f"DELETE FROM oauth_codes WHERE code_hash = {sql_str(self.code_hash)}")))
        if self.plan_hash:
            steps.append(("proposed_plans", lambda: self.d1.execute(
                f"DELETE FROM proposed_plans WHERE plan_hash = {sql_str(self.plan_hash)} "
                f"AND subject = {sql_str(self.b_email)}")))
        if self.feed_id:
            steps.append(("calendar_feed_tokens", lambda: self.d1.execute(
                f"DELETE FROM calendar_feed_tokens WHERE id = {sql_str(self.feed_id)} "
                f"AND owner_subject = {sql_str(self.b_email)}")))
        if self.marker_id:
            steps.append(("marker task", self._delete_marker))
        if self.sb2 is not None:
            steps.append(("push channel", lambda: self.sb2.request("POST", "/v1/webhook/subscribe")))
        for what, fn in steps:
            try:
                fn()
            except Exception as e:
                print(f"cleanup: {what} failed: {type(e).__name__}: {e}", file=sys.stderr)
        if self.login_email_to_restore is not None:
            subject, drift = self.login_email_to_restore
            print(f"cleanup: login_email may still be {drift!r}; run: UPDATE identity_tokens SET "
                  f"login_email = {sql_str(self.original_login_email or subject)} WHERE account_email = "
                  f"{sql_str(subject)} AND login_email = {sql_str(drift)}", file=sys.stderr)

    def _delete_marker(self) -> None:
        if self.sb2 is not None:
            r = self.sb2.request("DELETE", f"/v1/tasks/{self.marker_id}")
            if r.status_code in (200, 204):
                return
        self.d1.execute(f"DELETE FROM tasks WHERE id = {sql_str(self.marker_id)} "
                        f"AND owner_subject = {sql_str(self.b_email)}")

    def steps(self) -> list[tuple[str, Callable[[], None]]]:
        return list(zip(STEPS, (self.preflight, self.seed, self.refusals, self.rebind_b,
                                self.after_rebind, self.remint_b)))


# =============================================================================
# Sequencing and output (the smoke runner's colon grammar)
# =============================================================================


@dataclass(frozen=True)
class StepResult:
    label: str
    passed: bool
    seconds: float
    notes: str = ""


def run_steps(steps: list[tuple[str, Callable[[], None]]],
              clock: Callable[[], float] = time.monotonic) -> list[StepResult]:
    """Run in order; stop at the first failure (every step builds on the last)."""
    results: list[StepResult] = []
    for label, fn in steps:
        print(f"{label} starting...", file=sys.stderr, flush=True)
        started = clock()
        try:
            fn()
            results.append(StepResult(label, True, clock() - started))
        except AssertionError as e:
            results.append(StepResult(label, False, clock() - started, str(e)))
            break
        except Exception as e:
            results.append(StepResult(label, False, clock() - started, f"{type(e).__name__}: {e}"))
            break
    return results


def format_summary(results: list[StepResult], total: int) -> list[str]:
    lines = [f"  {r.label}: {'PASS' if r.passed else 'FAIL'}  ({r.seconds:.1f}s)  {r.notes}".rstrip()
             for r in results]
    done = {r.label for r in results}
    not_run = [s for s in STEPS[:total] if s not in done]
    if not_run:
        lines.append(f"not run: {', '.join(not_run)}")
    lines.append(f"TOTAL {sum(r.passed for r in results)}/{total}")
    return lines


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Admin identity-rebind smoke (smoke envs only, never prod).")
    p.add_argument("--provider", choices=list(_smoke_lib.PROVIDERS),
                   default=os.environ.get("SMOKE_PROVIDER") or "google",
                   help="Provider BOTH identities are signed in under (default: $SMOKE_PROVIDER or google).")
    p.add_argument("--levels", choices=list(LEVELS), default=LEVELS[0],
                   help="The one level, for the smoke runner; the steps aren't separately selectable.")
    p.add_argument("--dry-run", action="store_true",
                   help="run the read-only preflight (I1) only; no writes, no rebind")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    env = SmokeEnv.from_environ(args.provider)
    d1 = d1_for_db_id(env.db_id, env.repo_root)
    sa, sb = SchedulerClient(env.a), SchedulerClient(env.b)
    http = httpx.Client(timeout=30.0)
    smoke = IdentitySmoke(env, d1=d1, sa=sa, sb=sb, http=http, remint=default_remint)
    print(f"A={env.a.expected_email} (admin)  B={env.b.expected_email} (rebound)  "
          f"provider={env.provider}  url={env.url}", file=sys.stderr)
    steps = smoke.steps()[:1] if args.dry_run else smoke.steps()
    try:
        results = run_steps(steps)
    finally:
        if not args.dry_run:
            smoke.cleanup()
        for c in (sa, sb, smoke.sb2):
            if c is not None:
                c.close()
        http.close()
    for line in format_summary(results, total=len(steps)):
        print(line)
    if smoke.rebind_attempted:
        print(f"B's tokens from before the run are revoked: re-mint B in your shell "
              f'(eval "$(bin/mu-smoke-login.py B --provider {env.provider} --url {env.url})").',
              file=sys.stderr)
    return 0 if len(results) == len(steps) and all(r.passed for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
