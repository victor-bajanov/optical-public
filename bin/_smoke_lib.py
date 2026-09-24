# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Shared single-identity primitives for the smoke harnesses.

Extracted from bin/regression-smoke.py (Approach C). Holds the HTTP client
(bearer, proactive + on-401 refresh), the Google Calendar client, the Gmail
client (read-only, used by bin/poll-smoke.py's mailbox-first token relay),
and the Identity that parameterises them. No level/assertion logic.
"""
from __future__ import annotations

import json
import re
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx


def req(name: str) -> str:
    """A required env var, or exit with a pointer to what's missing."""
    v = os.environ.get(name)
    if not v:
        sys.exit(f"missing env: {name}")
    return v


def safe_json_body(r) -> dict:
    """r.json() with a non-JSON fallback capped small enough for terminals."""
    try:
        return r.json()
    except ValueError:
        return {"_raw": r.text[:300] if r.text else "<empty>"}


# =============================================================================
# Prod-safety guards — shared by every harness that mutates scheduler-dev.
# =============================================================================

DEV_DB_ID = "REPLACE_WITH_YOUR_DEV_D1_DATABASE_ID"   # scheduler-dev
PROD_DB_ID = "REPLACE_WITH_YOUR_PROD_D1_DATABASE_ID"  # scheduler (prod) — NEVER

_DEV_HOST = "scheduler-dev.example.com"
_PROD_HOST = "scheduler.example.com"

# The smoke envs: every D1 a harness may touch, the custom-domain hosts it may
# drive, and which wrangler env owns each D1 (d1_for_db_id). All three are
# declared together so a smoke env can't be half-registered.
SMOKE_DB_IDS = {DEV_DB_ID}
_SMOKE_HOSTS: tuple[str, ...] = (_DEV_HOST,)
_WRANGLER_ENV_BY_DB_ID: dict[str, str] = {DEV_DB_ID: "dev"}

# The prod worker's own name (worker/wrangler.toml top-level `name`) — its
# workers.dev subdomain, if it's ever live, would otherwise be blanket-
# allowed by the *.workers.dev rule below. The smoke envs' own workers.dev
# subdomains use different (suffixed) names, so this exact-match refusal
# doesn't touch them.
_PROD_WORKERS_DEV_LABEL = "weekly-scheduling-assistant"


def assert_dev_db(db_id: str) -> None:
    if db_id == PROD_DB_ID:
        raise SystemExit("REFUSING TO RUN: D1_DATABASE_ID is the PROD database.")
    if db_id not in SMOKE_DB_IDS:
        raise SystemExit(
            f"D1_DATABASE_ID {db_id!r} is not a known smoke db {sorted(SMOKE_DB_IDS)!r}; refusing."
        )


def assert_dev_url(url: str) -> None:
    """Fail closed unless SCHEDULER_URL points at a dev/smoke worker.

    This is the PRIMARY safety guard: every create/mutate/delete a harness issues
    goes through the bearer API to SCHEDULER_URL. Allowed: a smoke env's custom
    domain (_SMOKE_HOSTS), or any *.workers.dev host (every smoke worker also
    serves there). The prod host is denied. Keep this the ONLY definition in
    the module — a second, lower one previously shadowed this one and silently
    dropped its allow-list without either raising an import error or being
    caught by any test."""
    host = (urlparse(url).hostname or "").lower()
    if host == _PROD_HOST:
        raise SystemExit(f"REFUSING TO RUN: SCHEDULER_URL host {host!r} is PROD.")
    if host.endswith(".workers.dev") and host.split(".")[0] == _PROD_WORKERS_DEV_LABEL:
        raise SystemExit(
            f"REFUSING TO RUN: SCHEDULER_URL host {host!r} is PROD's own "
            f"workers.dev subdomain."
        )
    if host in _SMOKE_HOSTS or host.endswith(".workers.dev"):
        return
    raise SystemExit(
        f"SCHEDULER_URL host {host!r} is not a known dev host "
        f"({', '.join(_SMOKE_HOSTS)}, or *.workers.dev); refusing."
    )


def assert_env_consistent(url: str, db_id: str | None) -> None:
    """D8/m5: cross-check that SCHEDULER_URL and D1_DATABASE_ID name the SAME
    env. assert_dev_url and assert_dev_db each independently allow-list
    known-safe values, but neither one checks the OTHER — so a mismatched
    pair (one smoke env's host with another db id) would sail through both
    individually while a harness reads/writes the wrong D1 the whole time,
    with no error at all (see the M2/D2 bug class this complements).

    Skipped for *.workers.dev hosts: every smoke worker also serves there,
    so the host alone can't disambiguate which env is meant — the other two
    guards already restrict it to known-safe values."""
    if db_id is None:
        return
    host = (urlparse(url).hostname or "").lower()
    if host.endswith(".workers.dev"):
        return
    if host == _DEV_HOST and db_id != DEV_DB_ID:
        raise SystemExit(
            f"REFUSING TO RUN: SCHEDULER_URL host {host!r} is the dev env but "
            f"D1_DATABASE_ID {db_id!r} is not DEV_DB_ID {DEV_DB_ID!r} — mismatched env pair."
        )


def assert_url_matches_env(url: str, wrangler_env: str) -> None:
    """Cross-check that SCHEDULER_URL's host actually belongs to
    `wrangler_env` — same shape as assert_env_consistent (which cross-checks
    D1_DATABASE_ID against the host), generalised to any caller whose
    `--wrangler-env` is an independently-set flag rather than something
    derived from SCHEDULER_URL itself.

    assert_dev_url alone accepts ANY known smoke host for any caller, so a
    mismatched pair (SCHEDULER_URL pointed at one env's host with
    --wrangler-env naming another) would sail straight through it:
    bin/booking-smoke.py would then read/swap the WRONG env's
    TURNSTILE_SECRET (via `wrangler secret put --env <wrangler_env>`) while
    actually probing the OTHER env's live booking page for up to 90s, and
    only then restore the wrong secret — with no error at all.

    Skipped for *.workers.dev hosts: every smoke worker also serves there,
    so the host alone can't disambiguate which env is meant — same as
    assert_env_consistent's own workers.dev skip."""
    host = (urlparse(url).hostname or "").lower()
    if host.endswith(".workers.dev"):
        return
    if host == _DEV_HOST and wrangler_env != "dev":
        raise SystemExit(
            f"REFUSING TO RUN: SCHEDULER_URL host {host!r} is the dev env but "
            f"--wrangler-env is {wrangler_env!r} — mismatched env pair."
        )


class VisibilityError(RuntimeError):
    """A visibility-topology write returned 403 — the owner's token lacks the
    scope that write needs: Google calendar.acls (an ACL insert/delete), or
    the Graph calendarPermissions read/write (WP4's organisation-default
    permission model — see runbook §J's Microsoft accounts subsection).
    Carries the owner label and the provider's error body for a clear
    operator message."""


# Provider-neutral name introduced in WP4 (meeting-smoke on a Microsoft work
# tenant) — kept as a plain alias, not a subclass, so `except AclScopeError`
# (bin/meeting-smoke.py's run_scenario) catches a Graph VisibilityError
# identically, mirroring GmailScopeError/MailScopeError below.
AclScopeError = VisibilityError


class MailScopeError(RuntimeError):
    """A mail-read API call returned 403 — the organiser's token lacks the
    provider's mail-read scope (Google: gmail.readonly, gated by
    GOOGLE_GMAIL_READ_SCOPE_ENABLED; Microsoft: Mail.Read, gated by
    MICROSOFT_MAIL_READ_SCOPE_ENABLED — neither live on the target env, or
    the account has not re-consented since it went live). Callers should warn
    once and fall back to the env-var/interactive token relay for the rest of
    the run — see runbook.md §L and bin/mint-token.py."""


# Provider-neutral name introduced in WP2 (poll-smoke on a Microsoft
# organiser) — kept as a plain alias, not a subclass, so `except
# GmailScopeError` (bin/poll-smoke.py's circuit breaker) and `except
# MailScopeError` (GraphMailClient's callers) catch identically regardless
# of which provider's client raised it.
GmailScopeError = MailScopeError


def check_whoami_body(
    body: dict, expected_email: str, provider: str, letter: str
) -> tuple[str | None, str | None]:
    """Pure preflight guard for one identity's /v1/whoami body against the
    identity + provider we THINK we minted. `letter` names the identity slot
    (e.g. "A"/"B"/"C") — used only to name the right env var in messages.
    Returns (error, warning):

      error    None when the identity (and, if checkable, the provider)
               check out, else a string naming both sides of whichever
               check failed. Fatal — the caller should abort the run.
      warning  None unless the body has no `provider` field at all (an old
               worker, pre WP0's additive field) — then a heads-up that the
               provider guard could not run for this identity. Non-fatal.

    Email match must be EXACT, not merely case-insensitive: `expected_email`
    is used VERBATIM as a D1 subject key throughout the harnesses that call
    this (multiuser-smoke's per-user rows, meeting-smoke's per-account
    business-hours/home_tz seeding), and SQLite `=` on TEXT is case-sensitive
    (the worker stores whoami's email as-is; Microsoft returns
    `preferred_username` verbatim). A case-only difference (e.g. a mixed-case
    Entra UPN) would otherwise pass preflight and fail confusingly deep
    inside a later level, so it is its own failure here, distinct from a
    genuine wrong-account mismatch, with a message naming the exact env var
    to fix.

    Provider is checked only when the body carries one: an old worker (pre
    WP0's additive `provider` field) omits it entirely, and that's "can't
    tell", not a mismatch — surfaced as a warning, not a block.

    Shared by bin/multiuser-smoke.py (WP3) and bin/meeting-smoke.py (WP4) —
    the original guard was multiuser-smoke-local; extracted here so both
    harnesses' preflight run the identical check
    (internal design notes WP4)."""
    got_email = body.get("email")
    if not isinstance(got_email, str):
        return f"whoami email {got_email!r} != expected {expected_email!r}", None
    if got_email != expected_email:
        if got_email.casefold() == expected_email.casefold():
            lower_letter = letter.lower()
            return (
                f"whoami reports {got_email!r} — set config.toml's "
                f"[{provider}].{lower_letter} (or {letter}_EXPECTED_EMAIL when "
                f"running the harness directly) to that exact casing; it is "
                f"used verbatim as the D1 subject key",
                None,
            )
        return f"whoami email {got_email!r} != expected {expected_email!r}", None
    got_provider = body.get("provider")
    if got_provider is None:
        return None, (
            "whoami has no provider field — provider guard skipped; a Google "
            "bearer under --provider microsoft will fail later as a Graph 401"
        )
    if got_provider != provider:
        return (
            f"whoami provider {got_provider!r} != expected {provider!r} "
            f"(email {got_email!r})",
            None,
        )
    return None, None


def sql_str(value: str) -> str:
    """Single-quote-escape a string for inline SQL (harness-controlled values only)."""
    return "'" + value.replace("'", "''") + "'"


def _d1_error_message(returncode: int, stdout: str, stderr: str, sql: str) -> str:
    """Diagnostic for a failed `wrangler d1 execute`. wrangler with --json writes
    failures to STDOUT, so surface BOTH streams plus the exit code — stderr alone
    is usually blank on failure, which renders the error unreadable."""
    parts = [f"wrangler d1 execute failed (exit {returncode})"]
    err = (stderr or "").strip()
    out = (stdout or "").strip()
    if err:
        parts.append(f"stderr: {err}")
    if out:
        parts.append(f"stdout: {out}")
    parts.append(f"SQL: {sql}")
    return "\n".join(parts)


@dataclass(frozen=True)
class DevD1:
    """Runs SQL against scheduler-dev via wrangler.

    Secret injection is external: launch the harness under
    `op run --env-file=… --` so CLOUDFLARE_API_TOKEN is already in wrangler's
    environment. Do NOT wrap wrangler in its own `op run` here. Never used
    against prod — the meeting harness guards D1_DATABASE_ID at startup."""
    repo_root: Path
    # wrangler environment whose `DB` binding to hit ([env.<env_name>] in
    # worker/wrangler.toml). Using the binding rather than a database name
    # means the same helper targets whichever smoke env's D1 is meant
    # (d1_for_db_id) — the D1_DATABASE_ID guard upstream still decides what
    # is allowed. Default from SMOKE_WRANGLER_ENV so every harness picks it up.
    env_name: str = field(default_factory=lambda: os.environ.get("SMOKE_WRANGLER_ENV", "dev"))

    def _cmd(self, sql: str) -> list[str]:
        return [
            "npx", "wrangler", "d1", "execute", "DB",
            "--remote", "--env", self.env_name, "--json", "--command", sql,
        ]

    def _run(self, sql: str) -> dict:
        cmd = self._cmd(sql)
        proc = subprocess.run(
            cmd, cwd=str(self.repo_root / "worker"),
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                _d1_error_message(proc.returncode, proc.stdout, proc.stderr, sql)
            )
        out = proc.stdout.strip()
        start = out.find("[")
        parsed = json.loads(out[start:]) if start >= 0 else []
        return parsed[0] if parsed else {"results": []}

    def query(self, sql: str) -> list[dict]:
        return self._run(sql).get("results", []) or []

    def execute(self, sql: str) -> None:
        self._run(sql)


def d1_for_db_id(db_id: str, repo_root: Path) -> DevD1:
    """The DevD1 for whichever wrangler env owns `db_id` — precedence:
    an explicit SMOKE_WRANGLER_ENV always wins; otherwise the env that owns
    the db id (_WRANGLER_ENV_BY_DB_ID), anything else -> "dev". Shared by
    every harness that constructs a DevD1 from a D1_DATABASE_ID, so one smoke
    env's D1 is never silently mistaken for another's (D8/M2: reset-smoke-
    env.py's poll wipe and ms-smoke.py's step-5 done-category seeding both
    had this bug independently before routing through this one helper)."""
    env_name = os.environ.get("SMOKE_WRANGLER_ENV") or _WRANGLER_ENV_BY_DB_ID.get(db_id, "dev")
    return DevD1(repo_root=repo_root, env_name=env_name)


def seed_business_hours(d1: DevD1, subject: str, start_hhmm: str, end_hhmm: str,
                        days: list[str] | None = None) -> None:
    """Set Mon–Fri business hours [start,end] for `subject` (= the user's email)."""
    body = json.dumps({
        "days": days or ["mon", "tue", "wed", "thu", "fri"],
        "start": start_hhmm, "end": end_hhmm,
    })
    d1.execute(
        f"INSERT OR REPLACE INTO config_business_hours (owner_subject, body) "
        f"VALUES ({sql_str(subject)}, {sql_str(body)})"
    )


def set_home_tz(d1: DevD1, subject: str, home_tz: str | None) -> None:
    val = "NULL" if home_tz is None else sql_str(home_tz)
    d1.execute(f"UPDATE users SET home_tz = {val} WHERE subject = {sql_str(subject)}")


def set_done_color_id(d1: DevD1, subject: str, done_color_id: str | None) -> None:
    """Per-user done-marking override (see runbook §I). For Microsoft-provider
    subjects this must be the exact Outlook category name (graph-event-mapping.ts
    OPTICAL_DONE_CATEGORY, "Optical Done") — the mapping module compares against
    that literal string regardless of what DONE_COLOR_ID/this column holds, so a
    numeric Google colorId here would leave MS done-marking permanently silent."""
    val = "NULL" if done_color_id is None else sql_str(done_color_id)
    d1.execute(f"UPDATE users SET done_color_id = {val} WHERE subject = {sql_str(subject)}")


def get_done_color_id(d1: DevD1, subject: str) -> str | None:
    """Read the current users.done_color_id for `subject` (None when unset, or
    when the row doesn't exist yet — same NULL-is-legitimate reading
    set_done_color_id uses). Companion to set_done_color_id: ms-smoke.py
    step 5 captures the prior value with this BEFORE seeding
    OPTICAL_DONE_CATEGORY, so its cleanup can restore exactly that value
    instead of unconditionally nulling the column, which was the root cause
    of the 2026-08-21 Microsoft L6/L7 done-marking outage (see
    internal design notes and runbook §O)."""
    rows = d1.query(f"SELECT done_color_id FROM users WHERE subject = {sql_str(subject)}")
    if not rows:
        return None
    return rows[0].get("done_color_id")


def clear_config(d1: DevD1, subject: str) -> None:
    for tbl in ("config_business_hours", "config_weights", "config_contexts"):
        d1.execute(f"DELETE FROM {tbl} WHERE owner_subject = {sql_str(subject)}")


@dataclass(frozen=True)
class Identity:
    """One authenticated scheduler user: the connected calendar/subject."""
    scheduler_url: str
    bearer: str
    refresh_token: str
    expected_email: str
    client_id: str = "smoke-cli"


class RefreshRejected(RuntimeError):
    """The scheduler's /oauth/token refused a refresh_token grant (4xx).

    In practice this means the identity's tokens were revoked out from under
    the shell that minted them — multiuser M7 offboards B (revoking B's
    bearer + refresh), a provider switch resets the subject, or the token
    simply aged past the refresh window. Nothing a harness can recover from:
    the fix is a re-mint. Carries the identity (never the token) so a
    preflight can turn it into a one-line "re-mint X" exit instead of an
    httpx traceback (seen live 2026-09-17: meeting-smoke ran after M7 with
    B's dead token and died in preflight on a raw HTTPStatusError)."""

    def __init__(self, expected_email: str, status: int, error: str):
        self.expected_email = expected_email
        self.status = status
        self.error = error
        super().__init__(
            f"refresh token rejected by /oauth/token for {expected_email}: {status} {error}"
        )


def refresh_rejected_message(exc: RefreshRejected, label: str, provider: str) -> str:
    """The one-line operator message every preflight prints for a
    RefreshRejected: which identity, why, and the exact re-mint command."""
    return (
        f"identity {label} ({exc.expected_email}): refresh token rejected by "
        f"/oauth/token ({exc.status} {exc.error}) — its tokens were revoked "
        f"(an M7 offboard rotates B's; a provider switch resets the subject). "
        f're-mint: eval "$(bin/mu-smoke-login.py {label} --provider {provider})"'
    )


class SchedulerClient:
    """Wraps httpx.Client. Carries the OAuth bearer and refreshes it
    proactively when < 5 min to expiry, and on 401. A refresh the worker
    refuses (4xx) raises RefreshRejected, not httpx.HTTPStatusError."""

    def __init__(self, identity: Identity):
        self._id = identity
        self._bearer = identity.bearer
        self._refresh = identity.refresh_token
        self._expires_at: datetime | None = None
        self._client = httpx.Client(
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0),
        )

    @property
    def scheduler_url(self) -> str:
        return self._id.scheduler_url

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self._bearer}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _maybe_refresh_bearer(self) -> None:
        if self._expires_at is None:
            return
        if (self._expires_at - datetime.now(tz=timezone.utc)) > timedelta(minutes=5):
            return
        self._do_refresh()

    def _do_refresh(self) -> None:
        url = f"{self._id.scheduler_url}/oauth/token"
        r = self._client.post(
            url,
            data={
                "grant_type": "refresh_token",
                "refresh_token": self._refresh,
                "client_id": self._id.client_id,
            },
        )
        if 400 <= r.status_code < 500:
            try:
                error = str(r.json().get("error") or r.text[:120])
            except Exception:
                error = r.text[:120]
            raise RefreshRejected(self._id.expected_email, r.status_code, error)
        r.raise_for_status()
        body = r.json()
        self._bearer = body["access_token"]
        self._refresh = body.get("refresh_token", self._refresh)
        self._expires_at = datetime.now(tz=timezone.utc) + timedelta(
            seconds=int(body.get("expires_in", 3600))
        )

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        self._maybe_refresh_bearer()
        url = f"{self._id.scheduler_url}{path}"
        headers = self._headers(kwargs.pop("headers", None))
        r = self._client.request(method, url, headers=headers, **kwargs)
        if r.status_code == 401:
            self._do_refresh()
            headers = self._headers(kwargs.pop("headers", None))
            r = self._client.request(method, url, headers=headers, **kwargs)
        return r

    def close(self) -> None:
        self._client.close()


def preflight_whoami(sched: SchedulerClient, expected_email: str, provider: str, letter: str) -> None:
    """Shared preflight for every provider-aware harness (feed-smoke,
    booking-smoke, …): abort (SystemExit) if the identity or provider don't
    match what the caller thinks it minted — before the harness's first real
    call, so a wrong cast fails here rather than as a confusing Graph/Google
    401 deep inside the run. Closes `sched` before raising on failure; the
    caller remains responsible for closing it on the success path, same as
    every other _smoke_lib helper that doesn't own the client it's given.

    Extracted from bin/feed-smoke.py's original inline preflight (2026-09-17)
    so bin/booking-smoke.py's run_base_mode/run_decline_mode share the exact
    same check rather than a second, driftable copy."""
    try:
        r = sched.request("GET", "/v1/whoami")
    except RefreshRejected as e:
        sched.close()
        raise SystemExit(refresh_rejected_message(e, letter, provider)) from None
    if r.status_code != 200:
        sched.close()
        raise SystemExit(
            f"preflight GET /v1/whoami failed for {letter}: {r.status_code} {r.text[:300]}"
        )
    whoami_err, whoami_warning = check_whoami_body(safe_json_body(r), expected_email, provider, letter)
    if whoami_err:
        sched.close()
        raise SystemExit(f"preflight whoami check failed for {letter}: {whoami_err}")
    if whoami_warning:
        print(f"warning: {whoami_warning}", file=sys.stderr)


def post_resolve(sched: SchedulerClient, monday: date) -> tuple[int, dict]:
    body = {
        "window_start": f"{monday.isoformat()}T00:00",
        "window_end": f"{(monday + timedelta(days=7)).isoformat()}T00:00",
    }
    r = sched.request("POST", "/v1/resolve", json=body)
    try:
        return r.status_code, r.json()
    except ValueError:
        # Non-JSON body (e.g. 502 from Cloudflare with HTML, or empty 5xx).
        snippet = r.text[:200] if r.text else "<empty>"
        return r.status_code, {"_raw": snippet}


def post_commit(sched: SchedulerClient, plan_hash: str) -> tuple[int, dict]:
    """Commit a proposed plan to the calendar (creates/updates/deletes events).
    /v1/resolve only proposes; several harness levels need committed events so
    calendar-visible effects (chunk placement, orphan-deletion, write-back) are
    observable."""
    r = sched.request("POST", "/v1/commit", json={"plan_hash": plan_hash})
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {"_raw": r.text[:200] if r.text else "<empty>"}


class TokenAuthedClient:
    """Base for HTTP clients that authenticate via a bearer token minted from
    the scheduler's /v1/calendar-access-token route (proactive cache, retried
    once on 401 with a forced refresh). Subclasses set self._scheduler and
    self._client in their own __init__ and call _authed() for outbound calls."""

    _scheduler: SchedulerClient
    _client: httpx.Client
    _token: str | None

    def _get_token(self, force_refresh: bool = False) -> str:
        if self._token and not force_refresh:
            return self._token
        r = self._scheduler.request("GET", "/v1/calendar-access-token")
        r.raise_for_status()
        self._token = r.json()["access_token"]
        return self._token

    def _authed(self, method: str, url: str, **kwargs) -> httpx.Response:
        token = self._get_token()
        headers = kwargs.pop("headers", {}) or {}
        headers["Authorization"] = f"Bearer {token}"
        r = self._client.request(method, url, headers=headers, **kwargs)
        if r.status_code == 401:
            token = self._get_token(force_refresh=True)
            headers["Authorization"] = f"Bearer {token}"
            r = self._client.request(method, url, headers=headers, **kwargs)
        return r


class CalendarClient(TokenAuthedClient):
    """Talks directly to Google Calendar API using a token fetched from the
    scheduler's /v1/calendar-access-token (bearer-authenticated)."""

    BASE = "https://www.googleapis.com/calendar/v3"

    def __init__(self, scheduler: SchedulerClient, calendar_id: str = "primary"):
        self._scheduler = scheduler
        self._calendar_id = calendar_id
        self._token: str | None = None
        self._client = httpx.Client(timeout=30.0)

    def list_events(self, time_min: str, time_max: str) -> list[dict]:
        url = f"{self.BASE}/calendars/{self._calendar_id}/events"
        params = {
            "timeMin": time_min, "timeMax": time_max,
            "singleEvents": "true", "showDeleted": "false", "maxResults": "250",
        }
        events: list[dict] = []
        page_token: str | None = None
        while True:
            if page_token:
                params["pageToken"] = page_token
            r = self._authed("GET", url, params=params)
            r.raise_for_status()
            body = r.json()
            events.extend(body.get("items", []))
            page_token = body.get("nextPageToken")
            if not page_token:
                break
        return events

    def create_event(self, summary: str, start_iso: str, end_iso: str,
                     attendee_emails: list[str] | None = None,
                     send_updates: bool | None = None) -> str:
        """Create an event, optionally with attendees (folds bin/meeting-
        smoke.py's former create_event_with_attendees in here — WP4).

        send_updates is a three-state flag (review fix #8, 2026-09-03):
        default None sends NO sendUpdates param at all — exactly the pre-
        WP4 behaviour every OTHER caller of this method already relies on
        (feed-smoke, poll-smoke, booking-smoke, regression-smoke, multiuser-
        smoke, reset-smoke-env), none of which know about this WP4-only
        kwarg and all of which need Google's own default (bookers/poll
        invitees ARE meant to receive invite email). Only an EXPLICIT
        send_updates=False maps to sendUpdates='none' (no invite email; the
        calendar entry is still registered on each attendee's calendar
        server-side, necessary for freeBusy to reflect it) — the shape
        bin/meeting-smoke.py passes explicitly, folding in the old always-
        quiet create_event_with_attendees helper. send_updates=True behaves
        the same as the None default (no param sent)."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/events"
        payload: dict = {
            "summary": summary,
            "start": {"dateTime": start_iso},
            "end": {"dateTime": end_iso},
        }
        if attendee_emails:
            payload["attendees"] = [{"email": e} for e in attendee_emails]
        params = {"sendUpdates": "none"} if send_updates is False else None
        r = self._authed("POST", url, params=params, json=payload)
        r.raise_for_status()
        return r.json()["id"]

    def move_event(self, event_id: str, start_iso: str, end_iso: str) -> None:
        """Re-time an existing event (PATCH start/end). This is what a user does
        when they hand-drag a scheduler chunk to a new slot; for a scheduler-owned
        chunk event it is the signal the webhook manual-move write-back keys on
        (the calendar start differs from the committed plan's recorded start)."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/events/{event_id}"
        r = self._authed("PATCH", url, json={
            "start": {"dateTime": start_iso},
            "end": {"dateTime": end_iso},
        })
        r.raise_for_status()

    def delete_event(self, event_id: str, send_updates: bool | None = None) -> None:
        """Delete an event. Same three-state send_updates contract as
        create_event (review fix #8): default None sends no sendUpdates
        param (Google's own default — the pre-WP4 behaviour every other
        caller of this method relies on, e.g. a booking-page cancellation
        the booker must actually be notified of); only explicit
        send_updates=False maps to sendUpdates='none' (folding in the old
        delete_event_quietly helper's always-quiet behaviour — what bin/
        meeting-smoke.py's harness-artifact cleanup passes explicitly)."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/events/{event_id}"
        params = {"sendUpdates": "none"} if send_updates is False else None
        r = self._authed("DELETE", url, params=params)
        if r.status_code not in (200, 204, 404, 410):
            r.raise_for_status()

    def recolor_event(self, event_id: str, color_id: str) -> None:
        """PATCH a Google event's colorId — the user-side done-marking gesture
        (DONE_COLOR_ID) or its reversal (the create colour)."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/events/{event_id}"
        r = self._authed("PATCH", url, json={"colorId": color_id})
        r.raise_for_status()

    def get_event_raw(self, event_id: str) -> dict:
        """Fetch the raw Google event resource for `event_id` on this
        calendar (WP4)."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/events/{event_id}"
        r = self._authed("GET", url)
        r.raise_for_status()
        return r.json()

    def get_event_icaluid(self, event_id: str) -> str:
        """The RFC 5545 iCalUID for `event_id`. Google's own event id happens
        to be shared verbatim across every attendee's calendar (unlike Graph,
        where each attendee's copy gets a DIFFERENT id), so Google callers
        rarely need this; it exists for interface parity with
        GraphCalendarClient.get_event_icaluid — rsvp_as_attendee (below) calls
        it uniformly so bin/meeting-smoke.py's level code never branches on
        provider itself (WP4)."""
        return self.get_event_raw(event_id)["iCalUID"]

    def attendee_responses(self, event_id: str) -> dict[str, str]:
        """{email.lower(): responseStatus} for every attendee on THIS
        calendar's copy of `event_id` — typically called on the organiser's
        copy, the one the worker's accepted-attendee mask reads. Generalised
        from bin/meeting-smoke.py's former wait_for_attendee_accept, which
        now polls this instead of a raw GET (WP4)."""
        ev = self.get_event_raw(event_id)
        return {
            (a.get("email") or "").lower(): a.get("responseStatus")
            for a in (ev.get("attendees") or [])
        }

    def query_freebusy(self, emails: list[str], time_min: str, time_max: str) -> dict:
        """Google freeBusy.query — moved here from bin/meeting-smoke.py's
        module-level query_freebusy (WP4) so provider-neutral callers
        (wait_for_busy_at, wait_for_visibility) can call `cal.query_freebusy(
        ...)` without knowing which provider `cal` is. Returns the
        `calendars` map: {email: {"busy":[...]} | {"errors":[...]}}."""
        url = f"{self.BASE}/freeBusy"
        r = self._authed("POST", url, json={
            "timeMin": time_min, "timeMax": time_max,
            "items": [{"id": e} for e in emails],
        })
        r.raise_for_status()
        return r.json().get("calendars", {}) or {}

    def rsvp(self, event_id: str, self_email: str, response: str,
             timeout: float = 30.0) -> None:
        """Method form of the module-level rsvp_invite (WP4) — exists so
        provider-neutral callers (rsvp_as_attendee, below) can call
        `attendee_cal.rsvp(...)` without knowing whether attendee_cal is
        Google or Graph. See rsvp_invite's docstring for the propagate-and-
        patch mechanics; unchanged here (kept as the single implementation —
        booking-smoke.py's decline mode still calls rsvp_invite directly with
        a duck-typed stand-in that has no `rsvp` method of its own)."""
        rsvp_invite(self, event_id, self_email, response, timeout=timeout)

    # --- ACL (free/busy sharing) management -------------------------------
    # These operate on the OWNER's own calendar (calendar_id="primary"), using
    # the owner's raw token. `grantee_email` is the account being granted/denied
    # visibility. Used only by bin/meeting-smoke.py to set topology in dev.

    def insert_acl(self, grantee_email: str, owner_label: str,
                   role: str = "freeBusyReader") -> None:
        """Grant `grantee_email` `role` on this (owner) calendar. Idempotent:
        a 409 / already-existing rule is treated as success. A 403 means the
        owner token lacks calendar.acls → raise AclScopeError."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/acl"
        r = self._authed("POST", url, json={
            "role": role,
            "scope": {"type": "user", "value": grantee_email},
        })
        if r.status_code in (200, 201, 409):
            return
        if r.status_code == 403:
            raise VisibilityError(
                f"owner {owner_label!r} cannot manage ACLs (calendar.acls scope "
                f"missing) — re-consent {owner_label} with calendar.acls on dev. "
                f"Google said: {r.text[:300]!r}"
            )
        r.raise_for_status()

    def delete_acl(self, grantee_email: str) -> None:
        """Remove the freeBusyReader rule for `grantee_email` on this calendar.
        404/410 (already absent) are treated as success."""
        rule_id = f"user:{grantee_email}"
        url = f"{self.BASE}/calendars/{self._calendar_id}/acl/{rule_id}"
        r = self._authed("DELETE", url)
        if r.status_code == 403:
            raise VisibilityError(
                "cannot manage ACLs (calendar.acls scope missing) — re-consent "
                f"the owner with calendar.acls on dev. Google said: {r.text[:300]!r}"
            )
        if r.status_code not in (200, 204, 404, 410):
            r.raise_for_status()

    def set_visibility(self, grantee_email: str, role: str, owner_label: str) -> None:
        """Provider-neutral entry point bin/meeting-smoke.py drives instead of
        insert_acl/delete_acl directly (WP4): role='none' revokes
        `grantee_email`'s access; any other value (e.g. 'freeBusyReader') grants
        that ACL role. Kept alongside insert_acl/delete_acl (not replacing them)
        since they carry the real per-grantee ACL semantics this method wraps."""
        if role == "none":
            self.delete_acl(grantee_email)
        else:
            self.insert_acl(grantee_email, owner_label, role=role)

    def snapshot_visibility(self):
        """No-op on Google (review fix #6, 2026-09-03): insert_acl/delete_acl
        only ever touch the one specific grantee rule a scenario itself adds,
        tracked separately by RunContext.acl_grants — 'restore' there is
        simply 'undo exactly what this run added', already correct without a
        baseline capture. Returns None (an opaque placeholder consumed only
        by restore_visibility, below); exists purely for interface parity
        with GraphCalendarClient.snapshot_visibility, so bin/meeting-smoke.py
        can call it on either provider without branching."""
        return None

    def restore_visibility(self, snapshot) -> None:
        """No-op on Google — see snapshot_visibility's docstring. Never makes
        a network call, so calling it with an unused snapshot is always safe."""
        return None

    def list_freebusy_grantees(self) -> list[str]:
        """Return the grantee emails of every freeBusyReader rule on this
        calendar. Used by the startup sweep to clear grants a crashed run left."""
        url = f"{self.BASE}/calendars/{self._calendar_id}/acl"
        r = self._authed("GET", url)
        r.raise_for_status()
        out: list[str] = []
        for rule in r.json().get("items", []) or []:
            if rule.get("role") != "freeBusyReader":
                continue
            scope = rule.get("scope") or {}
            if scope.get("type") == "user" and scope.get("value"):
                out.append(scope["value"])
        return out

    def close(self) -> None:
        self._client.close()


def set_self_response(attendees: list[dict], self_email: str, response: str) -> list[dict]:
    """Return a COPY of `attendees` with the entry matching `self_email`
    (case-insensitive) set to `responseStatus=response` (e.g. 'accepted',
    'declined', 'needsAction', 'tentative'). Other entries are preserved
    verbatim. Raises AssertionError if no entry matches.

    Generalised from bin/meeting-smoke.py's `set_self_accepted` (which is now
    a thin wrapper calling this with response='accepted') so bin/booking-
    smoke.py's decline mode can drive the same PATCH shape with
    response='declined'."""
    target = self_email.lower()
    out: list[dict] = []
    found = False
    for a in attendees:
        if (a.get("email") or "").lower() == target:
            out.append({**a, "responseStatus": response})
            found = True
        else:
            out.append(dict(a))
    if not found:
        raise AssertionError(
            f"set_self_response: no attendee entry for {self_email!r} in {attendees!r}"
        )
    return out


def rsvp_invite(
    attendee_cal: "CalendarClient", event_id: str, self_email: str, response: str,
    timeout: float = 30.0,
) -> None:
    """Have `attendee_cal`'s account RSVP `response` (e.g. 'accepted' or
    'declined') to the invite for `event_id`, on the ATTENDEE's own copy of
    the event.

    The invited copy of the event may take a moment to propagate onto the
    attendee's calendar, so we poll GET until it appears, then PATCH the
    attendees array with this account's responseStatus set to `response`
    (sendUpdates='none' — no Google email; the worker's own detection/
    notification paths are what callers are exercising, not Google's own
    RSVP-change mail).

    Generalised from bin/meeting-smoke.py's `accept_invite` (kept there as a
    thin wrapper for its existing call sites, response='accepted' pinned) so
    bin/booking-smoke.py's decline mode can reuse the same propagate-and-
    patch mechanics with response='declined'."""
    url = f"{attendee_cal.BASE}/calendars/{attendee_cal._calendar_id}/events/{event_id}"
    deadline = time.monotonic() + timeout
    last_status = None
    while time.monotonic() < deadline:
        g = attendee_cal._authed("GET", url)
        last_status = g.status_code
        if g.status_code == 200:
            attendees = g.json().get("attendees", []) or []
            patched = set_self_response(attendees, self_email, response)
            p = attendee_cal._authed(
                "PATCH", url, params={"sendUpdates": "none"}, json={"attendees": patched}
            )
            p.raise_for_status()
            return
        # 404 = the invited copy hasn't propagated to this calendar yet; keep
        # polling. Any other error (403/5xx) is not going to clear by waiting —
        # fail fast with the body rather than burning the whole timeout.
        if g.status_code != 404:
            raise AssertionError(
                f"rsvp_invite: GET {event_id} for {self_email} returned "
                f"{g.status_code}: {g.text[:300]!r}"
            )
        time.sleep(2.0)
    raise AssertionError(
        f"rsvp_invite: event {event_id} never appeared on {self_email}'s calendar "
        f"within {timeout}s (last GET status {last_status})"
    )


def rsvp_as_attendee(
    organiser_cal, attendee_cal, event_id: str, self_email: str, response: str,
    timeout: float = 30.0,
) -> None:
    """Have `attendee_cal`'s account RSVP `response` to the invite for the
    event `organiser_cal` created as `event_id` — provider-neutral (WP4):
    Google reuses the organiser's event id verbatim across every attendee's
    calendar, so `event_id` already locates it there and attendee_cal.rsvp is
    called directly; Graph gives each attendee's copy a DIFFERENT id, so the
    correlating value is the event's iCalUId instead, resolved once via
    organiser_cal.get_event_icaluid(event_id). This is the one place that
    branches on provider so bin/meeting-smoke.py's level code never has to —
    the branch is forced by that underlying protocol difference, not by
    carelessness."""
    if isinstance(attendee_cal, GraphCalendarClient):
        ical_uid = organiser_cal.get_event_icaluid(event_id)
        attendee_cal.rsvp(ical_uid, self_email, response, timeout=timeout)
    else:
        attendee_cal.rsvp(event_id, self_email, response, timeout=timeout)


# =============================================================================
# Microsoft Graph calendar client — provider-agnostic harness surface
# =============================================================================
# bin/regression-smoke.py (and friends) read events in GOOGLE wire shape. To
# drive the same levels against a Microsoft-provider account this client talks
# to Graph and normalises every event into that shape, so level code never
# branches on provider. Constants mirror worker/src/providers/graph-event-
# mapping.ts — keep them in lock-step.

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCHEDULER_PROPERTY_GUID = "7f9d5e6a-1b3c-4a8d-9e2f-6c5b4a3d2e1f"
OPTICAL_DONE_CATEGORY = "Optical Done"
# Private extended properties the worker stamps on events it owns.
# optical_poll_id: stamped by worker/src/polls/booking.ts on a poll's booked
# event — the harness needs it read back to confirm a Microsoft-organiser
# poll booked the right event (bin/poll-smoke.py's WP2 provider coverage).
_GRAPH_PRIVATE_PROPS = ("scheduler_chunk_id", "optical_meeting_task_id", "optical_poll_id")
_GRAPH_RESPONSE_MAP = {
    "accepted": "accepted", "declined": "declined",
    "tentativelyAccepted": "tentative", "organizer": "accepted",
    "none": "needsAction", "notResponded": "needsAction",
}


def graph_prop_id(name: str) -> str:
    """Graph singleValueExtendedProperties id for one of our named props."""
    return f"String {{{SCHEDULER_PROPERTY_GUID}}} Name {name}"


def _strip_graph_fraction(raw: str) -> str:
    """Strip Graph's optional fractional-seconds suffix (up to 7 digits),
    tolerating every shape Graph emits across its endpoints:

      "…T10:00:00.0000000"   bare fraction (normal calendar-event shape)
      "…T10:00:00.0000000Z"  fraction immediately before a trailing "Z"
                              (seen on getSchedule's scheduleItems — review
                              fix #9, 2026-09-03)
      "…T10:00:00Z"          no fraction, trailing "Z"
      "…T10:00:00"           no fraction, no "Z"

    A trailing "Z" is preserved if present; only the fraction is dropped.
    Shared by `_graph_instant` (calendar event start/end) and
    `graph_datetime_to_epoch` (Sent-mail timestamps) — before this factor-out
    each carried its own regex and only `_graph_instant`'s tolerated the
    fraction-before-Z shape, so a message with 7 fractional digits and no
    intervening Z-strip step could still fail to parse via the other call
    site."""
    return re.sub(r"\.\d+(Z)?$", r"\1", raw)


def _graph_instant(part: dict | None) -> str:
    """Graph `{dateTime, timeZone}` → fromisoformat-safe ISO string. Graph emits
    7 fractional digits ("…T09:00:00.0000000"), which Python 3.11's
    fromisoformat rejects; we request outlook.timezone="UTC" so the zone is
    always UTC and can be written as +00:00 (what the harness compares on).

    Fraction-stripping is handled by the shared `_strip_graph_fraction`
    (tolerant of the fraction appearing bare or immediately before a
    trailing "Z" — see its docstring); this then drops that Z too (it's
    re-added as +00:00 below)."""
    if not part or not part.get("dateTime"):
        return ""
    raw = str(part["dateTime"])
    raw = _strip_graph_fraction(raw)
    if raw.endswith("Z"):
        raw = raw[:-1]
    if part.get("timeZone", "UTC") != "UTC":
        # Not expected (we always Prefer UTC) — keep it honest rather than
        # silently mislabel the zone.
        raise ValueError(f"Graph returned non-UTC dateTime {part!r}; expected outlook.timezone=UTC")
    return raw + "+00:00"


def graph_datetime_to_epoch(value: str) -> int:
    """Parse a Graph UTC `dateTimeOffset` string (e.g. a message's
    sentDateTime) to unix epoch seconds. Graph emits up to 7 fractional
    digits ("…T09:00:00.0000000Z"), which Python 3.11's
    datetime.fromisoformat rejects outright — this strips them via the same
    shared `_strip_graph_fraction` helper `_graph_instant` uses for calendar
    event start/end (WP2 review finding 4: a naive
    fromisoformat(value.replace("Z", "+00:00")) silently dropped every
    message with fractional seconds). Raises ValueError on a value that
    still doesn't parse — the caller (bin/poll-smoke.py's GraphReader)
    decides whether to warn-and-skip or propagate, this function never
    swallows anything itself."""
    raw = _strip_graph_fraction(value)
    raw = raw.replace("Z", "+00:00")
    return int(datetime.fromisoformat(raw).timestamp())


def normalize_graph_event(g: dict) -> dict:
    """Graph event → Google-Calendar-shaped dict (the keys the harness reads).
    The raw Graph event rides along under `_graph` for provider-specific
    probes (e.g. ms-smoke's ext-prop gate)."""
    private: dict[str, str] = {}
    for p in g.get("singleValueExtendedProperties") or []:
        for name in _GRAPH_PRIVATE_PROPS:
            if p.get("id") == graph_prop_id(name) and isinstance(p.get("value"), str):
                private[name] = p["value"]
    attendees = []
    for a in g.get("attendees") or []:
        email = ((a.get("emailAddress") or {}).get("address") or "").lower()
        resp = ((a.get("status") or {}).get("response")) or "none"
        attendees.append({"email": email, "responseStatus": _GRAPH_RESPONSE_MAP.get(resp, "needsAction")})
    done = OPTICAL_DONE_CATEGORY in (g.get("categories") or [])
    return {
        "id": g.get("id"),
        "summary": g.get("subject") or "",
        "status": "cancelled" if g.get("isCancelled") else "confirmed",
        "start": {"dateTime": _graph_instant(g.get("start"))},
        "end": {"dateTime": _graph_instant(g.get("end"))},
        "colorId": OPTICAL_DONE_CATEGORY if done else None,
        "extendedProperties": {"private": private},
        "attendees": attendees,
        # location.displayName is the whole shape Graph gives back for what
        # createEvent wrote as `location: { displayName: event.location }`
        # (microsoft-calendar-provider.ts:242) — None when absent (WP2
        # review finding 9), mirroring Google's raw event dict, which simply
        # has no `location` key at all when unset (so .get("location") is
        # None there too) — level code (e.g. poll-smoke's EDIT-mode location
        # assertion) reads one key with one absent-value convention on both
        # providers.
        "location": (g.get("location") or {}).get("displayName") or None,
        "_graph": g,
    }


class GraphCalendarClient(TokenAuthedClient):
    """Microsoft Graph analogue of CalendarClient. Same verbs, same return
    shapes (see normalize_graph_event), token minted via the scheduler's
    /v1/calendar-access-token exactly like the Google client."""

    BASE = GRAPH_BASE
    _EXPAND = "singleValueExtendedProperties($filter=" + " or ".join(
        f"id eq '{graph_prop_id(n)}'" for n in _GRAPH_PRIVATE_PROPS) + ")"
    # IdType="ImmutableId": default Graph ids can change when an event moves
    # folders — worker/src/providers/microsoft-calendar-provider.ts's own
    # Graph client always sends this (see its PREFER constant); the harness
    # needs the same guarantee for the ids it records to keep resolving.
    _PREFER = 'IdType="ImmutableId", outlook.timezone="UTC"'

    def __init__(self, scheduler: SchedulerClient):
        self._scheduler = scheduler
        self._token: str | None = None
        self._client = httpx.Client(timeout=30.0)

    def _authed(self, method: str, url: str, **kwargs) -> httpx.Response:
        """D8/M3: inject Prefer on EVERY request, not just the two GETs.
        create_event/move_event/set_categories/delete_event previously went
        out with no Prefer header at all, so create_event could return a
        MUTABLE Graph id while the harness (and the worker) compare against
        the IMMUTABLE one elsewhere — e.g. ms-smoke's find_meeting_task_id
        and its own event-sweep keep-set could never match an id it had
        just created."""
        headers = kwargs.pop("headers", {}) or {}
        headers.setdefault("Prefer", self._PREFER)
        return super()._authed(method, url, headers=headers, **kwargs)

    def list_events_raw(self, time_min: str, time_max: str) -> list[dict]:
        """calendarView over [time_min, time_max) — raw Graph events, expanded
        for the scheduler's private properties, all pages followed."""
        url: str | None = f"{self.BASE}/me/calendarView"
        params: dict | None = {
            "startDateTime": time_min, "endDateTime": time_max,
            "$expand": self._EXPAND, "$top": "250",
        }
        out: list[dict] = []
        while url:
            r = self._authed("GET", url, params=params)
            r.raise_for_status()
            body = r.json()
            out.extend(body.get("value", []))
            url = body.get("@odata.nextLink")
            params = None  # nextLink is a complete absolute URL
        return out

    def list_events(self, time_min: str, time_max: str) -> list[dict]:
        return [normalize_graph_event(g) for g in self.list_events_raw(time_min, time_max)]

    def get_event_raw(self, event_id: str) -> dict:
        r = self._authed("GET", f"{self.BASE}/me/events/{event_id}",
                         params={"$expand": self._EXPAND})
        r.raise_for_status()
        return r.json()

    def create_event(self, summary: str, start_iso: str, end_iso: str,
                     attendee_emails: list[str] | None = None,
                     send_updates: bool | None = None) -> str:
        """`send_updates` is accepted for interface parity with
        CalendarClient.create_event's three-state contract (WP4, review fix
        #8) but is a documented no-op here:
        Graph has no sendUpdates=none equivalent — an event created with
        attendees always sends them an invitation email, regardless of this
        flag. Callers (bin/meeting-smoke.py) note this in their own
        docstrings under --provider microsoft."""
        payload: dict = {
            "subject": summary,
            "start": {"dateTime": start_iso, "timeZone": "UTC"},
            "end": {"dateTime": end_iso, "timeZone": "UTC"},
        }
        if attendee_emails:
            payload["attendees"] = [
                {"emailAddress": {"address": e}, "type": "required"} for e in attendee_emails
            ]
        r = self._authed("POST", f"{self.BASE}/me/events", json=payload)
        r.raise_for_status()
        return r.json()["id"]

    def move_event(self, event_id: str, start_iso: str, end_iso: str) -> None:
        r = self._authed("PATCH", f"{self.BASE}/me/events/{event_id}", json={
            "start": {"dateTime": start_iso, "timeZone": "UTC"},
            "end": {"dateTime": end_iso, "timeZone": "UTC"},
        })
        r.raise_for_status()

    def set_categories(self, event_id: str, categories: list[str]) -> None:
        r = self._authed("PATCH", f"{self.BASE}/me/events/{event_id}", json={"categories": categories})
        r.raise_for_status()

    def recolor_event(self, event_id: str, color_id: str) -> None:
        """Done-marking translation, mirroring graph-event-mapping.toGraphPatch:
        OPTICAL_DONE_CATEGORY sets the category, "" clears it. Any other value
        (a Google numeric colorId) has no Outlook meaning — the worker drops it
        silently, so the harness must refuse rather than pass vacuously."""
        if color_id == OPTICAL_DONE_CATEGORY:
            self.set_categories(event_id, [OPTICAL_DONE_CATEGORY])
        elif color_id == "":
            self.set_categories(event_id, [])
        else:
            raise ValueError(
                f"colorId {color_id!r} is meaningless on Graph; use "
                f"{OPTICAL_DONE_CATEGORY!r} (done) or '' (clear). Run the harness "
                f"with --provider microsoft so SMOKE_DONE_COLOR_ID defaults correctly."
            )

    def delete_event(self, event_id: str, send_updates: bool | None = None) -> None:
        """`send_updates` accepted for interface parity with CalendarClient.
        delete_event's three-state contract (WP4); a documented no-op on Graph."""
        r = self._authed("DELETE", f"{self.BASE}/me/events/{event_id}")
        if r.status_code not in (200, 204, 404, 410):
            r.raise_for_status()

    def get_event_icaluid(self, event_id: str) -> str:
        """The event's iCalUId — the correlating identifier rsvp_as_attendee
        (above) resolves once on the organiser's copy so it can find the
        SAME event on an attendee's calendar, where Graph gives it a
        DIFFERENT `id` (WP4)."""
        return self.get_event_raw(event_id)["iCalUId"]

    def attendee_responses(self, event_id: str) -> dict[str, str]:
        """{email: responseStatus} for every attendee on this calendar's copy
        of `event_id`, via the existing Google-shaped normalisation (WP4)."""
        ev = normalize_graph_event(self.get_event_raw(event_id))
        return {a["email"]: a["responseStatus"] for a in ev["attendees"]}

    _RSVP_ACTION = {"accepted": "accept", "declined": "decline", "tentative": "tentativelyAccept"}

    def rsvp(self, ical_uid: str, self_email: str, response: str,
             timeout: float = 30.0) -> None:
        """Have this account RSVP `response` to the invite whose iCalUId is
        `ical_uid` (WP4). Graph's attendee copy has its OWN `id`, different
        from the organiser's — so, unlike Google, this cannot GET by the
        organiser's event id directly. Instead: poll `GET /me/events?$filter=
        iCalUId eq '<ical_uid>'` until the attendee's copy lands, then POST
        the accept/decline/tentativelyAccept action with sendResponse: true.

        Unlike Google's sendUpdates='none' PATCH (which changes RSVP state
        without generating any message), Graph's RSVP action call IS the
        response message — with sendResponse:false Graph applies no response
        at all, so the organiser's copy would keep status.response == "none"
        forever and wait_for_attendee_accept (and the worker's own
        identify.ts, which reads exactly that field to build the accepted-
        attendee free/busy mask) would never see "accepted" (review fix,
        2026-09-03). This means RSVP mail to the organiser is unavoidable on
        Graph under --provider microsoft — the same acceptable-for-smoke-
        mailboxes tradeoff as the unsuppressable invitation mail on
        create_event. `self_email` is accepted for interface parity with
        CalendarClient.rsvp (Graph resolves 'self' from the bearer, not from
        an email argument)."""
        action = self._RSVP_ACTION.get(response)
        if action is None:
            raise ValueError(
                f"unsupported RSVP response {response!r} on Graph; expected "
                f"one of {sorted(self._RSVP_ACTION)}"
            )
        # OData string literals escape an embedded single quote by doubling
        # it — review fix #10: an unescaped quote in ical_uid would both
        # break the $filter query and (worse) is an injection vector.
        escaped_uid = ical_uid.replace("'", "''")
        deadline = time.monotonic() + timeout
        event_id = None
        while time.monotonic() < deadline:
            r = self._authed("GET", f"{self.BASE}/me/events",
                             params={"$filter": f"iCalUId eq '{escaped_uid}'"})
            r.raise_for_status()
            items = r.json().get("value", []) or []
            if items:
                event_id = items[0]["id"]
                break
            time.sleep(2.0)
        if event_id is None:
            raise AssertionError(
                f"rsvp: no event with iCalUId {ical_uid!r} found on "
                f"{self_email}'s calendar within {timeout}s"
            )
        p = self._authed("POST", f"{self.BASE}/me/events/{event_id}/{action}",
                         json={"sendResponse": True})
        p.raise_for_status()

    # Review fix #4 (2026-09-03): Graph error codes that plausibly mean "this
    # mailbox cannot answer getSchedule" (personal/MSA mailboxes, or a
    # sharing/access denial) — the ONLY shapes this method launders into a
    # per-email `errors` entry rather than raising. This allowlist is a
    # best guess, NOT yet confirmed against a real MSA response — WP4.3's
    # live probe must confirm the actual code(s) Graph returns and this list
    # updated accordingly. Deliberately narrow: a broken/malformed harness
    # request must raise, not silently make every attendee look "invisible"
    # and let 2B/M2 pass for the wrong reason.
    _MSA_UNREADABLE_ERROR_CODES = {
        "ErrorAccessDenied", "MailboxNotEnabledForRESTAPI",
        "ErrorInvalidUser", "ErrorInvalidRecipients",
    }

    _THIRTY_MIN = timedelta(minutes=30)

    def _busy_from_availability_view(self, view: str, time_min: str, time_max: str) -> list[dict]:
        """Derive busy blocks from getSchedule's coarse `availabilityView`
        string, exactly mirroring worker/src/providers/microsoft-calendar-
        provider.ts's queryFreeBusyBatch fallback: one character per
        `availabilityViewInterval` (30 min, matching the request below);
        '0' free, '4' workingElsewhere (free), anything else busy. The
        view's slot 0 is anchored to a 30-min boundary from the UNIX epoch,
        not to time_min verbatim, so time_min is floored down to that
        boundary before indexing — otherwise a :15/:45 time_min shifts every
        reported slot by up to 30 minutes. The final slot is clamped to
        time_max so a short trailing slot isn't reported as spanning past
        the requested window."""
        win_start = datetime.fromisoformat(time_min.replace("Z", "+00:00"))
        win_end = datetime.fromisoformat(time_max.replace("Z", "+00:00"))
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        floor_units = (win_start - epoch) // self._THIRTY_MIN
        floored_start = epoch + floor_units * self._THIRTY_MIN
        busy = []
        for i, ch in enumerate(view):
            if ch in ("0", "4"):
                continue
            slot_start = floored_start + i * self._THIRTY_MIN
            slot_end = min(slot_start + self._THIRTY_MIN, win_end)
            busy.append({
                "start": slot_start.isoformat(),
                "end": slot_end.isoformat(),
            })
        return busy

    def query_freebusy(self, emails: list[str], time_min: str, time_max: str) -> dict:
        """Graph's getSchedule, normalised to Google's freeBusy.query shape:
        {email: {"busy":[...]} | {"errors":[...]}} (WP4) — mirroring
        worker/src/providers/microsoft-calendar-provider.ts's
        queryFreeBusyBatch response handling field-for-field (review fix,
        2026-09-03), since the harness's own read of a scenario's free/busy
        topology needs to agree with what the worker itself would see during
        a real resolve:

          - results are matched to requested emails by `scheduleId`
            (casefold-compared), NOT by response list position — Graph does
            not guarantee response order matches request order;
          - an id absent from the response entirely -> errors:
            ["missing_in_response"];
          - a per-schedule `error` -> errors: [responseCode or message or
            "schedule_error"] (a STRING, not the raw error object);
          - a non-empty `scheduleItems` -> busy blocks from items whose
            status is NOT "free"/"workingElsewhere" (busy/tentative/oof all
            block, matching Google freebusy semantics — see
            isBusyGraphEvent's identical exclusion rule for calendar events);
          - an EMPTY `scheduleItems` with no `availabilityView` -> busy: []
            (Graph read the schedule and confirmed nothing — genuinely free,
            not unreadable);
          - no `scheduleItems` but a non-empty `availabilityView` ->
            _busy_from_availability_view (the coarse fallback Graph uses for
            availability-only sharing, cross-tenant, and personal mailboxes
            — exactly the cases the freeze-on-unknown policy needs
            surfaced);
          - neither field present at all -> errors: ["no_schedule_detail"].

        A getSchedule HTTP failure only degrades to `errors` for every
        requested email when the body carries a recognised personal-mailbox-
        shaped error code (_MSA_UNREADABLE_ERROR_CODES); anything else
        raises — see that constant's docstring for why."""
        r = self._authed("POST", f"{self.BASE}/me/calendar/getSchedule", json={
            "schedules": list(emails),
            "startTime": {"dateTime": time_min, "timeZone": "UTC"},
            "endTime": {"dateTime": time_max, "timeZone": "UTC"},
            "availabilityViewInterval": 30,
        })
        if not r.is_success:
            code = ((safe_json_body(r) or {}).get("error") or {}).get("code")
            if code in self._MSA_UNREADABLE_ERROR_CODES:
                return {email: {"errors": [code]} for email in emails}
            r.raise_for_status()
        by_id = {}
        for s in r.json().get("value", []) or []:
            sid = s.get("scheduleId")
            if isinstance(sid, str):
                by_id[sid.casefold()] = s
        out: dict = {}
        for email in emails:
            s = by_id.get(email.casefold())
            if s is None:
                out[email] = {"errors": ["missing_in_response"]}
                continue
            err = s.get("error")
            # JS truthiness on an object differs from Python's on a dict: an
            # empty {} is truthy in JS (the worker's `else if (s.error)`
            # branch fires), but falsy in Python — check `is not None`
            # instead of bare truthiness so an empty error object still
            # takes this branch (and correctly falls through to the generic
            # "schedule_error" string).
            if err is not None:
                out[email] = {"errors": [err.get("responseCode") or err.get("message") or "schedule_error"]}
                continue
            items = s.get("scheduleItems")
            if items:
                busy = []
                for si in items:
                    if si.get("status") in ("free", "workingElsewhere"):
                        continue
                    start, end = si.get("start"), si.get("end")
                    if not (start or {}).get("dateTime") or not (end or {}).get("dateTime"):
                        continue
                    busy.append({"start": _graph_instant(start), "end": _graph_instant(end)})
                out[email] = {"busy": busy}
                continue
            view = s.get("availabilityView")
            if view:
                out[email] = {"busy": self._busy_from_availability_view(view, time_min, time_max)}
                continue
            if "scheduleItems" in s:
                out[email] = {"busy": []}
                continue
            out[email] = {"errors": ["no_schedule_detail"]}
        return out

    _ORG_DEFAULT_PERMISSION_NAME = "My Organization"

    def _find_org_default_permission(self) -> dict | None:
        """The tenant's organisation-default sharing entry in this account's
        calendarPermissions — WP4's visibility topology analogue to Google's
        per-grantee ACL, since Graph has no per-grantee equivalent.

        Matched STRUCTURALLY (review fix #5, 2026-09-03), not by the
        localised display name: `isInsideOrganization is True` AND (no
        `emailAddress.address` OR `isRemovable is False`) — a tenant can
        localise "My Organization" to another language, so relying on that
        exact English string would silently find nothing there. The English
        name is used only as a TIEBREAKER among multiple structural matches
        (unexpected, but possible), never as the primary signal. None if no
        entry matches structurally at all."""
        r = self._authed("GET", f"{self.BASE}/me/calendar/calendarPermissions")
        if r.status_code == 403:
            raise VisibilityError(
                f"cannot read calendar permissions (scope missing): {r.text[:300]!r}"
            )
        r.raise_for_status()
        structural = []
        for entry in r.json().get("value", []) or []:
            if entry.get("isInsideOrganization") is not True:
                continue
            addr = entry.get("emailAddress") or {}
            if addr.get("address") and entry.get("isRemovable") is not False:
                continue
            structural.append(entry)
        if not structural:
            return None
        if len(structural) == 1:
            return structural[0]
        named = [
            e for e in structural
            if (e.get("emailAddress") or {}).get("name") == self._ORG_DEFAULT_PERMISSION_NAME
        ]
        return named[0] if named else structural[0]

    def _patch_org_default_role(self, raw_role: str, owner_label: str) -> None:
        """PATCH the org-default calendarPermissions entry to EXACTLY
        `raw_role` (a real Graph calendarRoleType string). Shared by
        set_visibility (which only ever passes "none" or "freeBusyRead" —
        the two states scenarios need) and restore_visibility (which passes
        back whatever exact role snapshot_visibility captured, e.g.
        "limitedRead" — review fix #6)."""
        entry = self._find_org_default_permission()
        if entry is None:
            raise VisibilityError(
                f"owner {owner_label!r} has no organisation-default "
                f"permission entry on their calendar — cannot model "
                f"visibility on Graph"
            )
        r = self._authed(
            "PATCH", f"{self.BASE}/me/calendar/calendarPermissions/{entry['id']}",
            json={"role": raw_role},
        )
        if r.status_code == 403:
            raise VisibilityError(
                f"owner {owner_label!r} cannot manage calendar permissions "
                f"(scope missing): {r.text[:300]!r}"
            )
        r.raise_for_status()

    def set_visibility(self, grantee_email: str, role: str, owner_label: str) -> None:
        """Graph analogue of CalendarClient.set_visibility (WP4). There is no
        per-grantee ACL on Graph the way Google's ACL API has one — a
        tenant's calendar sharing is controlled by the ORGANISATION-DEFAULT
        permission entry, so `grantee_email` is accepted for interface parity
        but IGNORED: the change is org-wide, affecting every tenant member's
        visibility of this account's calendar at once, not just
        grantee_email's (see runbook §J's Microsoft accounts subsection).
        role: "none" maps to Graph's "none"; any other value (e.g.
        "freeBusyReader", matching the Google role name) maps to Graph's
        "freeBusyRead". For restoring a tenant's true original role exactly
        (which may be neither of those two), see restore_visibility."""
        graph_role = "none" if role == "none" else "freeBusyRead"
        self._patch_org_default_role(graph_role, owner_label)

    def get_visibility_role(self) -> str:
        """The org-default permission's CURRENT raw role string (e.g.
        "freeBusyRead", "limitedRead", "none"), or "none" if no org-default
        entry exists at all — matches list_freebusy_grantees' none-role
        reading (review fix #6)."""
        entry = self._find_org_default_permission()
        if entry is None:
            return "none"
        return entry.get("role") or "none"

    def snapshot_visibility(self) -> str:
        """Capture the CURRENT org-default role, for restore_visibility to
        put back later (review fix #6). Graph's visibility is a single
        shared field per owner, not an additive per-grantee ACL rule the way
        Google's is — a startup sweep or teardown that just sets it to
        "none" would otherwise permanently narrow the tenant's real sharing
        default. bin/meeting-smoke.py calls this ONCE per owner, before
        anything in a run touches visibility at all (including its own
        startup sweep)."""
        return self.get_visibility_role()

    def restore_visibility(self, snapshot: str | None) -> None:
        """PATCH the org-default entry back to the EXACT raw role
        snapshot_visibility captured — unlike set_visibility (which only
        distinguishes "none" from "freeBusyRead", the two states scenarios
        need), this restores whatever the tenant's true original role was
        (e.g. "limitedRead"), so a scenario run never permanently coarsens a
        tenant's real sharing default (review fix #6). snapshot=None (never
        produced by snapshot_visibility, but accepted for interface parity
        with CalendarClient.restore_visibility) is a no-op."""
        if snapshot is None:
            return
        self._patch_org_default_role(snapshot, "restore")

    def list_freebusy_grantees(self) -> list[str]:
        """Graph analogue of CalendarClient.list_freebusy_grantees (WP4): a
        single sentinel "<org-default>" when the organisation-default
        permission is anything other than "none" (i.e. visible to the whole
        tenant), else an empty list. There is no per-grantee list on Graph —
        see set_visibility's docstring."""
        entry = self._find_org_default_permission()
        if entry is None or entry.get("role") == "none":
            return []
        return ["<org-default>"]

    def close(self) -> None:
        self._client.close()


PROVIDERS = ("google", "microsoft")


def make_calendar_client(scheduler: SchedulerClient, provider: str):
    """CalendarClient (Google) or GraphCalendarClient (Microsoft) — the two
    share every verb the harnesses use."""
    if provider == "google":
        return CalendarClient(scheduler)
    if provider == "microsoft":
        return GraphCalendarClient(scheduler)
    raise ValueError(f"unknown calendar provider {provider!r}; expected one of {PROVIDERS}")


@dataclass(frozen=True)
class DoneMarking:
    """The two calendar-side sentinels the worker's done-marking understands,
    for one provider — the single source of truth every harness level reads.

      done    what a user paints a chunk event to mark its task done
              (Google: colorId DONE_COLOR_ID "11"; Microsoft: the
              "Optical Done" Outlook category)
      undone  what un-painting it back to looks like, i.e. the state the
              worker writes on commit (Google: create colour "5";
              Microsoft: no category — "" means clear)

    SMOKE_DONE_COLOR_ID overrides `done` for a differently-configured
    instance; it must never equal `undone` or detection is a no-op."""
    done: str
    undone: str

    @classmethod
    def for_provider(cls, provider: str) -> "DoneMarking":
        if provider == "google":
            base = cls(done="11", undone="5")
        elif provider == "microsoft":
            base = cls(done=OPTICAL_DONE_CATEGORY, undone="")
        else:
            raise ValueError(f"unknown calendar provider {provider!r}; expected one of {PROVIDERS}")
        override = os.environ.get("SMOKE_DONE_COLOR_ID")
        if not override:
            # An empty (or unset) env var reads as unset here — "" can never
            # reach the microsoft guard below, since it's excluded by this
            # check first (D8/m4: it used to also appear in that guard's
            # "valid" tuple, which was dead code).
            return base
        if provider == "microsoft" and override != OPTICAL_DONE_CATEGORY:
            # A Google colorId (e.g. "11") left over from a prior run is
            # meaningless on Graph — GraphCalendarClient.recolor_event would
            # otherwise raise a confusing ValueError far from the real cause.
            # Ignore it and warn, rather than letting it silently break a
            # later --provider microsoft run.
            print(
                f"warning: SMOKE_DONE_COLOR_ID={override!r} is not a valid "
                f"Microsoft done marker ({OPTICAL_DONE_CATEGORY!r}); ignoring it",
                file=sys.stderr,
            )
            return base
        return cls(done=override, undone=base.undone)


class GmailClient:
    """Talks directly to the Gmail API using a token fetched from the
    scheduler's /v1/calendar-access-token (bearer-authenticated) — same
    raw-token + 401-refresh pattern as CalendarClient. Requires the
    organiser's token to carry gmail.readonly (GOOGLE_GMAIL_READ_SCOPE_ENABLED,
    dev only — see google-identity-provider.ts). Used by bin/poll-smoke.py to
    read the organiser's Sent mail for per-invitee poll links instead of an
    operator pasting them in."""

    BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

    def __init__(self, scheduler: SchedulerClient):
        self._scheduler = scheduler
        self._token: str | None = None
        self._client = httpx.Client(timeout=30.0)

    def _get_token(self, force_refresh: bool = False) -> str:
        if self._token and not force_refresh:
            return self._token
        r = self._scheduler.request("GET", "/v1/calendar-access-token")
        r.raise_for_status()
        self._token = r.json()["access_token"]
        return self._token

    def _authed(self, method: str, url: str, **kwargs) -> httpx.Response:
        token = self._get_token()
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {token}"
        r = self._client.request(method, url, headers=headers, **kwargs)
        if r.status_code == 401:
            token = self._get_token(force_refresh=True)
            headers["Authorization"] = f"Bearer {token}"
            r = self._client.request(method, url, headers=headers, **kwargs)
        return r

    def list_messages(self, q: str) -> list[dict]:
        """Returns the raw {id, threadId} stubs from users.messages.list —
        call get_message for each to fetch the full payload (list does not
        include the body). Raises MailScopeError on 403 (gmail.readonly
        missing from the organiser's token)."""
        url = f"{self.BASE}/messages"
        r = self._authed("GET", url, params={"q": q})
        if r.status_code == 403:
            raise MailScopeError(f"gmail.readonly scope missing: {r.text[:300]!r}")
        r.raise_for_status()
        return r.json().get("messages", []) or []

    def get_message(self, message_id: str, format: str = "full") -> dict:
        """Fetch one message's full payload (headers + multipart body tree).
        Raises MailScopeError on 403."""
        url = f"{self.BASE}/messages/{message_id}"
        r = self._authed("GET", url, params={"format": format})
        if r.status_code == 403:
            raise MailScopeError(f"gmail.readonly scope missing: {r.text[:300]!r}")
        r.raise_for_status()
        return r.json()

    def close(self) -> None:
        self._client.close()


class GraphMailClient(TokenAuthedClient):
    """Microsoft Graph analogue of GmailClient — reads the organiser's Sent
    Items instead of the Gmail API, for the same purpose: bin/poll-smoke.py's
    mailbox-first token relay on a Microsoft organiser (--provider
    microsoft). Requires the organiser's token to carry Mail.Read
    (MICROSOFT_MAIL_READ_SCOPE_ENABLED — see microsoft-identity-provider.ts).

    Unlike GmailClient's two-step list+get, Graph returns the full message
    (including body, given the right $select) in one page of results, so
    there is a single read method rather than a stub-list/full-get split.

    Subject-prefix ("[pollsmoke]") and to-recipient matching are deliberately
    NOT done here: Graph rejects a request that filters and sorts on
    DIFFERENT properties, so this filters (and sorts, WP2 review finding 2 —
    $orderby on the SAME property as $filter, sentDateTime, IS allowed) only
    on sentDateTime server-side and leaves the rest to the caller
    (bin/poll-smoke.py's GraphReader, WP2.3) — the same division GmailClient
    already has with its caller doing the subject/recipient match over
    decoded bodies.

    Deliberately requests NO `Prefer: outlook.body-content-type="text"`
    (WP2 review finding 1): the worker's poll emails go out HTML-only
    (MicrosoftGraphNotificationProvider.sendMail sends contentType: "HTML"
    with no plaintext alternative) with the poll link living only inside a
    `ctaButton`'s `<a href="…">` (worker/src/polls/emails.ts). Forcing
    Exchange to convert that to text either drops the href outright or
    line-wraps the ~320-char URL at whitespace, truncating the token —
    either way find_poll_link's regex would never see a live link.
    Requesting the native (HTML) body and matching the raw markup is what
    actually works; see GraphReader in bin/poll-smoke.py."""

    BASE = GRAPH_BASE
    _SELECT = "id,subject,sentDateTime,toRecipients,body"
    _PAGE_SIZE = "50"

    def __init__(self, scheduler: SchedulerClient):
        self._scheduler = scheduler
        self._token: str | None = None
        self._client = httpx.Client(timeout=30.0)

    def list_sent_since(self, not_before_epoch: int) -> list[dict]:
        """Raw Graph message resources from Sent Items with
        sentDateTime >= not_before_epoch (unix seconds), newest first
        ($orderby sentDateTime desc), all pages followed via @odata.nextLink.
        Raises MailScopeError on 403 (Mail.Read missing from the organiser's
        token)."""
        iso = datetime.fromtimestamp(not_before_epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        url: str | None = f"{self.BASE}/me/mailFolders/sentitems/messages"
        params: dict | None = {
            "$filter": f"sentDateTime ge {iso}",
            "$orderby": "sentDateTime desc",
            "$select": self._SELECT,
            "$top": self._PAGE_SIZE,
        }
        out: list[dict] = []
        while url:
            r = self._authed("GET", url, params=params)
            if r.status_code == 403:
                raise MailScopeError(f"Mail.Read scope missing: {r.text[:300]!r}")
            r.raise_for_status()
            body = r.json()
            out.extend(body.get("value", []) or [])
            url = body.get("@odata.nextLink")
            params = None  # nextLink is a complete absolute URL, same as GraphCalendarClient
        return out

    def close(self) -> None:
        self._client.close()
