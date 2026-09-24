# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Env-seeded, in-memory identity model for the unified smoke runner.

Companion to internal design notes ("Identity model — env-seeded,
in-memory only") and internal design notes (WP2, the
mechanical contract this module implements exactly). Stdlib only — no repo
imports, no third-party deps — so `bin/_smoke_registry.py` and
`bin/smoke-runner.py` can both sit on top of it without dragging httpx/Textual
into a module that has to import cleanly before any of that is installed.

Two things this module deliberately does NOT do, by design (see the doc):
  - it never writes a token to disk — the environment is the sole token
    channel, config.toml holds only email addresses;
  - it never refreshes a token — refresh rotates the pair server-side, and a
    proactive refresh here would strand whatever the shell still has exported.

Everything below is pure logic except `probe_whoami` (network) and
`load_config`/`save_config` (disk).
"""
from __future__ import annotations

import enum
import json
import os
import re
import tomllib
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# Verified server facts (worker/src/auth/oauth-provider.ts:45-47;
# worker/src/auth/tokens.ts:6-9) — encode them, don't re-derive them.
ACCESS_TTL_S = 3600
REFRESH_TTL_DAYS = 90
PROVIDERS = ("google", "microsoft")

DEFAULT_CLIENT_ID = "smoke-cli"
_LETTERS = ("A", "B", "C")  # env-var-prefix / IdentityTokens.slot casing


# =============================================================================
# Config file paths — $XDG_CONFIG_HOME|~/.config, $XDG_STATE_HOME|~/.local/state
# =============================================================================


def _xdg_path(env_var: str, fallback_parts: tuple[str, ...], environ: Mapping[str, str]) -> Path:
    base = environ.get(env_var)
    if base:
        return Path(base)
    return Path.home().joinpath(*fallback_parts)


def config_path(environ: Mapping[str, str] | None = None) -> Path:
    """~/.config/optical-smoke/config.toml, or $XDG_CONFIG_HOME's equivalent.
    `environ` is injectable so tests never depend on the real process env or
    home directory; omit it to read os.environ."""
    env = environ if environ is not None else os.environ
    return _xdg_path("XDG_CONFIG_HOME", (".config",), env) / "optical-smoke" / "config.toml"


def state_dir(environ: Mapping[str, str] | None = None) -> Path:
    """~/.local/state/optical-smoke, or $XDG_STATE_HOME's equivalent. WP4's
    log files and runs.jsonl live under here."""
    env = environ if environ is not None else os.environ
    return _xdg_path("XDG_STATE_HOME", (".local", "state"), env) / "optical-smoke"


# Module-level convenience constants (computed once at import, from the real
# process env) — what most callers want. Pass an explicit `path` to
# load_config/save_config to bypass these (every test does).
CONFIG_PATH = config_path()
STATE_DIR = state_dir()


# =============================================================================
# RunnerConfig — the persisted account cast (design doc "Config file")
# =============================================================================


@dataclass(frozen=True)
class RunnerConfig:
    # BLOCKING B1 (Opus review): the pinned duck-type contract (see
    # bin/_smoke_registry.py's docstring, WP1) is that `.poll_invitee_a` and
    # `.poll_invitee_b` themselves ARE the set-value-else-derived result —
    # WP1's compose_env reads them directly with no derivation step of its
    # own. So those two names are PROPERTIES below, not fields; the raw
    # stored value (what the operator actually put under [poll], or "" for
    # nothing) lives in the differently-named fields below instead.
    target: str = "dev"                      # a _smoke_registry.TARGETS key
    # Campaign provider axis (2026-09-17): which provider's mode each harness
    # defaults to in the runner ("google" | "microsoft" — PROVIDERS). Target
    # says which host; provider says which calendar cast. Independent axes:
    # a target declares the providers it hosts (Target.providers), and
    # compose_env still blocks a mode the target can't host (a microsoft
    # campaign on a Google-only target is a loud BLOCKED row per harness,
    # never a silent auto-correction).
    provider: str = "google"
    google: dict[str, str] = field(default_factory=dict)   # {"a": email, ...} — missing letters absent
    google_primary: str = "a"                 # which letter doubles as SCHEDULER_*/EXPECTED_TEST_ACCOUNT
    microsoft: dict[str, str] = field(default_factory=dict)  # {"a": email, ...} — missing letters absent
    microsoft_primary: str = "a"              # which letter (mirrors google_primary; a LETTER, not an email)
    microsoft_attendee: str = ""              # MS2_ATTENDEE_EMAIL — email only, never logs in
    poll_invitee_a_set: str = ""              # "" = operator set nothing under [poll].invitee_a
    poll_invitee_b_set: str = ""              # "" = operator set nothing under [poll].invitee_b

    @property
    def poll_invitee_a(self) -> str:
        """THE contract attribute (see class docstring): the configured
        value if the operator set one, else derived from google.b. Derivation
        happens HERE (read time), never baked into the saved file — see
        save_config, which writes poll_invitee_a_set, not this property."""
        return self.poll_invitee_a_set or self.google.get("b", "")

    @property
    def poll_invitee_b(self) -> str:
        return self.poll_invitee_b_set or self.google.get("c", "")


def default_config() -> RunnerConfig:
    return RunnerConfig()


def _toml_str(value: str) -> str:
    """TOML basic-string literal (escape backslash and double-quote; emails
    never need more than this, but it's cheap to do properly)."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _as_str(value: object, field: str, p: Path) -> str:
    """MINOR M4 (Opus review): hand-editing config.toml is a first-class
    flow, so a wrong-typed value (`a = 5` instead of `a = "5"`) must fail
    the same way malformed TOML does — a ValueError naming the path — rather
    than surfacing later as an obscure AttributeError deep inside
    seed_identities/classify. Absent (None) is not a type error; it just
    means "unset"."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"malformed config in {p}: {field} must be a string, got {value!r}")
    return value


def load_config(path: Path | None = None) -> RunnerConfig:
    """Missing file -> default_config(). Malformed TOML, or a value of the
    wrong type -> ValueError naming the path (tomllib.TOMLDecodeError is a
    ValueError subclass; we re-raise with the path attached since the
    original message doesn't carry it)."""
    p = path if path is not None else CONFIG_PATH
    if not p.exists():
        return default_config()
    try:
        data = tomllib.loads(p.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"malformed TOML in {p}: {e}") from e

    defaults_sec = data.get("defaults") or {}
    google_sec = data.get("google") or {}
    microsoft_sec = data.get("microsoft") or {}
    poll_sec = data.get("poll") or {}

    google = {}
    for L in ("a", "b", "c"):
        v = _as_str(google_sec.get(L), f"google.{L}", p)
        if v:
            google[L] = v

    microsoft = {}
    for L in ("a", "b", "c"):
        v = _as_str(microsoft_sec.get(L), f"microsoft.{L}", p)
        if v:
            microsoft[L] = v

    # Legacy `[microsoft].primary = "<email>"` (pre-letter schema, an @
    # value) stays readable: it maps onto letter "a" — UNLESS [microsoft].a
    # is ALSO explicitly set to something else, in which case the explicit
    # letter wins (RULING: explicit [microsoft].a beats a legacy
    # email-shaped primary; the legacy value is then simply discarded).
    raw_primary = _as_str(microsoft_sec.get("primary"), "microsoft.primary", p) or "a"
    if "@" in raw_primary:
        if "a" not in microsoft:
            microsoft["a"] = raw_primary
        microsoft_primary = "a"
    else:
        microsoft_primary = raw_primary

    provider = _as_str(defaults_sec.get("provider"), "defaults.provider", p) or "google"
    if provider not in PROVIDERS:
        raise ValueError(
            f"defaults.provider in {p} must be one of {', '.join(PROVIDERS)}, got {provider!r}"
        )

    return RunnerConfig(
        target=_as_str(defaults_sec.get("target"), "defaults.target", p) or "dev",
        provider=provider,
        google=google,
        google_primary=_as_str(google_sec.get("primary"), "google.primary", p) or "a",
        microsoft=microsoft,
        microsoft_primary=microsoft_primary,
        microsoft_attendee=_as_str(microsoft_sec.get("attendee"), "microsoft.attendee", p) or "",
        poll_invitee_a_set=_as_str(poll_sec.get("invitee_a"), "poll.invitee_a", p) or "",
        poll_invitee_b_set=_as_str(poll_sec.get("invitee_b"), "poll.invitee_b", p) or "",
    )


def _normalize_microsoft_primary(cfg: RunnerConfig) -> tuple[str, dict[str, str]]:
    """SHOULD-FIX (Opus review): the letter invariant used to live only in
    load_config, so a hand-built RunnerConfig (constructed directly, never
    round-tripped through load_config) with an email-shaped
    microsoft_primary would make save_config write the legacy form the docs
    promise is never written. Mirrors load_config's own legacy-mapping rule
    exactly: a blank primary defaults to "a"; an email-shaped primary maps
    onto letter "a" (written into the returned microsoft dict) UNLESS "a" is
    already set to something, in which case the explicit "a" wins and the
    email is discarded; a letter-shaped primary passes through unchanged.
    Anything else (not blank, not a/b/c, not email-shaped) is junk — raises
    ValueError naming the field, the same posture as a malformed hand-edited
    config file (_as_str's ValueErrors)."""
    raw = (cfg.microsoft_primary or "").strip()
    microsoft = dict(cfg.microsoft)
    if not raw:
        return "a", microsoft
    if "@" in raw:
        if not microsoft.get("a"):
            microsoft["a"] = raw
        return "a", microsoft
    letter = raw.lower()
    if letter not in ("a", "b", "c"):
        raise ValueError(
            f"RunnerConfig.microsoft_primary must be a letter (a/b/c) or an email, got {raw!r}"
        )
    return letter, microsoft


def save_config(cfg: RunnerConfig, path: Path | None = None) -> None:
    """Hand-serialised writer for the exact schema `load_config` parses and
    the design doc's §Config file documents — stdlib has no TOML writer, and
    this is the only schema this file ever needs to speak.

    Only fields the operator actually SET are written: an unset poll invitee
    (poll_invitee_a_set/poll_invitee_b_set — NOT the derived .poll_invitee_a/b
    properties) is left out of the file entirely rather than written as its
    derived value, so a later edit to google.b/.c keeps flowing through on
    the next load instead of being frozen by a save that happened to occur
    first."""
    p = path if path is not None else CONFIG_PATH
    p.parent.mkdir(parents=True, exist_ok=True)

    lines = ["[defaults]", f"target = {_toml_str(cfg.target)}",
             f"provider = {_toml_str(cfg.provider)}", "", "[google]"]
    for L in ("a", "b", "c"):
        v = cfg.google.get(L, "")
        if v:
            lines.append(f"{L} = {_toml_str(v)}")
    lines.append(f"primary = {_toml_str(cfg.google_primary)}")

    microsoft_primary, microsoft = _normalize_microsoft_primary(cfg)
    lines += ["", "[microsoft]"]
    for L in ("a", "b", "c"):
        v = microsoft.get(L, "")
        if v:
            lines.append(f"{L} = {_toml_str(v)}")
    lines.append(f"primary = {_toml_str(microsoft_primary)}")
    lines.append(f"attendee = {_toml_str(cfg.microsoft_attendee)}")

    if cfg.poll_invitee_a_set or cfg.poll_invitee_b_set:
        lines += ["", "[poll]"]
        if cfg.poll_invitee_a_set:
            lines.append(f"invitee_a = {_toml_str(cfg.poll_invitee_a_set)}")
        if cfg.poll_invitee_b_set:
            lines.append(f"invitee_b = {_toml_str(cfg.poll_invitee_b_set)}")

    p.write_text("\n".join(lines) + "\n", encoding="utf-8")


# =============================================================================
# Identity model
# =============================================================================


@dataclass(frozen=True)
class IdentityTokens:
    slot: str                  # "google:a" | "google:b" | "google:c" |
                                # "microsoft:a" | "microsoft:b" | "microsoft:c"
                                # — six slots total; NEVER a sentinel like
                                # "microsoft:primary" (the registry resolves
                                # that sentinel to a concrete letter via
                                # cfg.microsoft_primary before it reaches here).
    bearer: str
    refresh: str
    email: str                 # the expected email (config cast wins; env
                                # <L>_EXPECTED_EMAIL fills a letter only when
                                # config leaves it empty — config anchors
                                # WRONG_ACCOUNT, never a stale env export)
    client_id: str = DEFAULT_CLIENT_ID
    minted_at: datetime | None = None


class IdentityState(enum.Enum):
    ABSENT = "ABSENT"
    FRESH = "FRESH"
    VALID = "VALID"
    BEARER_EXPIRED = "BEARER_EXPIRED"
    STALE = "STALE"
    WRONG_ACCOUNT = "WRONG_ACCOUNT"
    PROBE_ERROR = "PROBE_ERROR"


@dataclass(frozen=True)
class IdentityStatus:
    slot: str
    state: IdentityState
    detail: str
    login_hint: str | None = None


@dataclass(frozen=True)
class SeedReport:
    """seed_identities()'s return shape (the plan leaves this to us — see the
    WP2 implementer's report for why a single dataclass beats a bare tuple).

    identities  slot -> IdentityTokens, for every fully-occupied slot.
    partial     slot -> "missing X, Y" for a GOOGLE LETTER slot with a
                genuine half-finished ENV EXPORT attempt (at least one of
                <L>_BEARER/<L>_REFRESH/<L>_EXPECTED_EMAIL is present, but the
                slot isn't fully occupied) — a typo'd partial export reads as
                a diagnosable detail instead of plain ABSENT. A letter whose
                email is known only via config, with NO env var touched at
                all, is never partial (config knowing an email isn't an
                attempted export). A slot that a SCHEDULER_* triple later
                completes is removed from here even if the letter loop had
                flagged it — occupied always wins over partial.
    warnings    caller-displayable one-line notices that don't attach to any
                single slot: an EXPECTED_TEST_ACCOUNT that matches nothing in
                the config cast, or a SCHEDULER_* triple that lost a
                same-slot collision to a letter triple with a DIFFERENT
                bearer (same bearer = no real conflict, no warning)."""
    identities: dict[str, IdentityTokens]
    partial: dict[str, str]
    warnings: tuple[str, ...] = ()


def parse_minted_at(value: str | None) -> datetime | None:
    """ISO 8601, tolerant of a trailing 'Z'. Unparseable or absent -> None,
    never raises — an old shell without *_MINTED_AT, or a hand-typed export,
    must degrade to "expiry unknown", not crash the identity pane."""
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    if v.endswith("Z") or v.endswith("z"):
        v = v[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _classify_scheduler_slot(expected_account: str, cfg: RunnerConfig) -> str | None:
    """EXPECTED_TEST_ACCOUNT (casefolded) matched against the config cast: any
    google letter's email -> "google:<letter>"; any microsoft letter's email
    -> "microsoft:<letter>" (never the "microsoft:primary" sentinel —
    IdentityTokens.slot never holds one). No match -> None (caller surfaces a
    warning)."""
    target = expected_account.strip().casefold()
    if not target:
        return None
    for L in ("a", "b", "c"):
        email = cfg.google.get(L, "").strip()
        if email and email.casefold() == target:
            return f"google:{L}"
    for L in ("a", "b", "c"):
        email = cfg.microsoft.get(L, "").strip()
        if email and email.casefold() == target:
            return f"microsoft:{L}"
    return None


def seed_identities(environ: Mapping[str, str], cfg: RunnerConfig) -> SeedReport:
    """Build one in-memory IdentityTokens per occupied slot from the runner's
    own process environment. Two idioms, letter triples processed first so
    they win any same-slot collision (see SeedReport docstring):

      <L>_BEARER/<L>_REFRESH/<L>_EXPECTED_EMAIL (+_CLIENT_ID/_MINTED_AT)
        for L in A, B, C -> google:a / google:b / google:c. A slot is
        occupied iff BOTH bearer and refresh are non-empty AND an email is
        known (cfg.google[<l>] wins; env <L>_EXPECTED_EMAIL only fills a
        letter config leaves empty — config is the WRONG_ACCOUNT comparison
        anchor, so a stale env export must never silently re-anchor it).

      MS_<L>_BEARER/MS_<L>_REFRESH/MS_<L>_EXPECTED_EMAIL
        (+MS_<L>_CLIENT_ID/MS_<L>_MINTED_AT) for L in A, B, C -> microsoft:a /
        microsoft:b / microsoft:c (Decision 3, distinct env family so one
        shell can hold both casts at once). Identical occupancy/partial
        rules as the Google letters, against cfg.microsoft instead of
        cfg.google.

      SCHEDULER_BEARER/SCHEDULER_REFRESH_TOKEN/EXPECTED_TEST_ACCOUNT
        (+SCHEDULER_CLIENT_ID/SCHEDULER_MINTED_AT) -> classified against the
        config cast (any google OR microsoft letter) by
        _classify_scheduler_slot. The stored `email` is the MATCHED config
        value (the thing it was classified against), not the raw
        EXPECTED_TEST_ACCOUNT string, so later WRONG_ACCOUNT comparisons
        compare against the canonical cast entry."""
    identities: dict[str, IdentityTokens] = {}
    partial: dict[str, str] = {}
    warnings: list[str] = []

    for env_prefix, cast, provider in (("", cfg.google, "google"), ("MS_", cfg.microsoft, "microsoft")):
        for L in _LETTERS:
            bearer = (environ.get(f"{env_prefix}{L}_BEARER") or "").strip()
            refresh = (environ.get(f"{env_prefix}{L}_REFRESH") or "").strip()
            # RULING (arbitration): config is the WRONG_ACCOUNT comparison
            # anchor — env <L>_EXPECTED_EMAIL only fills a letter config
            # leaves empty. Config never loses to a stale env export.
            env_email = (environ.get(f"{env_prefix}{L}_EXPECTED_EMAIL") or "").strip()
            email = cast.get(L.lower(), "").strip() or env_email
            slot = f"{provider}:{L.lower()}"

            if bearer and refresh and email:
                client_id = (environ.get(f"{env_prefix}{L}_CLIENT_ID") or "").strip() or DEFAULT_CLIENT_ID
                minted_at = parse_minted_at(environ.get(f"{env_prefix}{L}_MINTED_AT"))
                identities[slot] = IdentityTokens(
                    slot=slot, bearer=bearer, refresh=refresh, email=email,
                    client_id=client_id, minted_at=minted_at,
                )
            # BLOCKING B2 (Opus review): gate on ENV presence only (bearer,
            # refresh, or the raw env_email) — NOT on the config-merged
            # `email`, which can be non-empty purely from config with zero
            # env vars touched at all. Using `email` here used to flag every
            # config-known letter as "partial" even when the operator
            # exported nothing for it.
            elif bearer or refresh or env_email:
                missing = []
                if not bearer:
                    missing.append(f"{env_prefix}{L}_BEARER")
                if not refresh:
                    missing.append(f"{env_prefix}{L}_REFRESH")
                if not email:
                    missing.append(f"config {provider}.{L.lower()} (or {env_prefix}{L}_EXPECTED_EMAIL)")
                partial[slot] = "missing " + ", ".join(missing)

    scheduler_bearer = (environ.get("SCHEDULER_BEARER") or "").strip()
    scheduler_refresh = (environ.get("SCHEDULER_REFRESH_TOKEN") or "").strip()
    expected_account = (environ.get("EXPECTED_TEST_ACCOUNT") or "").strip()

    if scheduler_bearer and scheduler_refresh and expected_account:
        matched_slot = _classify_scheduler_slot(expected_account, cfg)
        if matched_slot is None:
            warnings.append(
                f"SCHEDULER_* env present but {expected_account!r} is not in the "
                f"config cast — edit config"
            )
        else:
            matched_provider, matched_letter = matched_slot.split(":", 1)
            matched_cast = cfg.microsoft if matched_provider == "microsoft" else cfg.google
            matched_email = matched_cast.get(matched_letter, "")
            client_id = (environ.get("SCHEDULER_CLIENT_ID") or "").strip() or DEFAULT_CLIENT_ID
            minted_at = parse_minted_at(environ.get("SCHEDULER_MINTED_AT"))
            scheduler_tokens = IdentityTokens(
                slot=matched_slot, bearer=scheduler_bearer, refresh=scheduler_refresh,
                email=matched_email, client_id=client_id, minted_at=minted_at,
            )
            existing = identities.get(matched_slot)
            if existing is None:
                identities[matched_slot] = scheduler_tokens
            elif existing.bearer != scheduler_bearer:
                warnings.append(
                    f"{matched_slot}: SCHEDULER_* is also present with a different "
                    f"bearer for this slot — the letter identity wins"
                )

    # BLOCKING B2 (Opus review): a slot can start out partial from the
    # letter loop (e.g. B_BEARER alone, no refresh/email) and then get
    # completed by a SCHEDULER_* triple classified onto that same slot — the
    # slot is genuinely occupied at that point, so it must not also still
    # read as partial.
    for slot in list(partial):
        if slot in identities:
            del partial[slot]

    return SeedReport(identities=identities, partial=partial, warnings=tuple(warnings))


# =============================================================================
# classify() — probe truth wins over minted_at math
# =============================================================================


def _ttl_remaining(minted_at: datetime, now: datetime) -> tuple[float, float]:
    """(bearer_remaining_s, refresh_remaining_s) at `now`, from `minted_at`.
    Pure arithmetic — exposed so the 90-day refresh edge is directly
    testable without needing the bearer to also still be alive (it never is,
    at 90 days: the bearer TTL is 1 hour).

    MINOR M1 (Opus review): `minted_at` is always UTC-aware here (it only
    ever comes from parse_minted_at, which stamps a zone), but `now` is
    caller-supplied and classify()'s pinned signature can't enforce
    awareness — a naive `now - aware minted_at` raises TypeError. Normalise
    ANY naive operand to UTC rather than trust the caller; classify() must
    never raise regardless of what it's handed."""
    if minted_at.tzinfo is None:
        minted_at = minted_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    elapsed = (now - minted_at).total_seconds()
    return ACCESS_TTL_S - elapsed, REFRESH_TTL_DAYS * 86400 - elapsed


def _emails_match(got: str, expected: str) -> bool:
    """Case-insensitive, both sides required non-empty — same posture as
    mu-smoke-login.whoami_matches (Google echoes back the account's own
    casing; empty is never a match)."""
    g = (got or "").strip().casefold()
    e = (expected or "").strip().casefold()
    return bool(g) and bool(e) and g == e


def slot_provider(slot: str) -> str:
    """The provider half of a "provider:letter" slot string, e.g.
    "microsoft" for "microsoft:a"."""
    return slot.split(":", 1)[0]


def classify(tokens: IdentityTokens | None, probe: ProbeResult | None, now: datetime) -> IdentityStatus:
    """tokens is None -> ABSENT (slot is unknown here; the caller — which
    already knows which slot it asked about — is expected to stamp the
    correct `.slot` onto the result via dataclasses.replace when needed).
    `login_hint` is always None here: computing a login command needs a
    RunnerConfig and a target URL, neither of which this function takes per
    the pinned signature — the caller attaches login_hint via
    login_command() for any state that warrants one."""
    if tokens is None:
        return IdentityStatus(slot="", state=IdentityState.ABSENT, detail="not seeded")

    slot = tokens.slot

    if probe is None or probe.status is None:
        detail = "not probed yet" if probe is None else "probe failed (network/timeout/non-JSON)"
        return IdentityStatus(slot=slot, state=IdentityState.PROBE_ERROR, detail=detail)

    if probe.status == 200:
        body = probe.body if isinstance(probe.body, dict) else {}
        got_email = body.get("email")

        # MINOR M2 (Opus review): no usable (non-empty string) email in the
        # body is not evidence of a WRONG account — it's an unreadable
        # probe (e.g. an HTML interstitial probe_whoami couldn't parse as
        # JSON, landing here as body={}). WRONG_ACCOUNT must mean "we read
        # an email and it didn't match", not "we couldn't read one at all".
        if not isinstance(got_email, str) or not got_email.strip():
            return IdentityStatus(
                slot=slot, state=IdentityState.PROBE_ERROR,
                detail="probe 200 but no usable email in the body (non-JSON/interstitial?)",
            )

        # NIT (Opus review): the provider check runs BEFORE the email match
        # check. WP0's additive `provider` field on GET /v1/whoami identifies
        # the ROOT CAUSE when a bearer is on the wrong slot entirely (e.g. a
        # Google bearer accidentally seeded onto a microsoft:* slot) — that
        # should be reported as a provider mismatch, not as an incidental
        # email mismatch (a different account happening to be configured for
        # that slot too). A body without the field (older worker) keeps
        # today's behaviour — never treated as a mismatch, falls through to
        # the ordinary email check below.
        got_provider = body.get("provider")
        expected_provider = slot_provider(slot)
        if isinstance(got_provider, str) and got_provider and got_provider != expected_provider:
            return IdentityStatus(
                slot=slot, state=IdentityState.WRONG_ACCOUNT,
                detail=f"probe reports provider {got_provider!r}, but slot {slot!r} expects "
                       f"{expected_provider!r}",
            )

        if not _emails_match(got_email, tokens.email):
            return IdentityStatus(
                slot=slot, state=IdentityState.WRONG_ACCOUNT,
                detail=f"probe authenticates as {got_email!r}, expected {tokens.email!r}",
            )

        if tokens.minted_at is not None:
            bearer_remaining, refresh_remaining = _ttl_remaining(tokens.minted_at, now)
            if bearer_remaining > 0:
                bearer_m = int(bearer_remaining // 60)
                refresh_d = int(refresh_remaining // 86400)
                return IdentityStatus(
                    slot=slot, state=IdentityState.FRESH,
                    detail=f"bearer {bearer_m}m · refresh {refresh_d}d",
                )
            return IdentityStatus(
                slot=slot, state=IdentityState.VALID,
                detail="probe ok — mint-time math says the bearer is expired, but "
                       "the server still accepts it",
            )

        return IdentityStatus(
            slot=slot, state=IdentityState.VALID,
            detail="probe ok — expiry unknown (no *_MINTED_AT)",
        )

    body = probe.body if isinstance(probe.body, dict) else {}
    error = body.get("error")

    # MINOR M3 (Opus review, supersedes the earlier ">= 500" arbitration
    # ruling): only the two named 401 forms and "any other 4xx" are TOKEN
    # verdicts. Anything else non-200 — below 400 (204, 302: not a success
    # this code understands, but also not a rejection) or >= 500 (a server
    # fault) — is not a token verdict either way and must never render
    # "re-mint needed".
    if probe.status < 400 or probe.status >= 500:
        return IdentityStatus(
            slot=slot, state=IdentityState.PROBE_ERROR,
            detail=f"probe {probe.status} — not a token verdict",
        )
    if probe.status == 401 and error == "expired_token":
        return IdentityStatus(
            slot=slot, state=IdentityState.BEARER_EXPIRED,
            detail="probe 401 expired_token — harness refresh will recover",
        )
    if probe.status == 401 and error in ("revoked_token", "invalid_token"):
        return IdentityStatus(
            slot=slot, state=IdentityState.STALE,
            detail=f"probe 401 {error} — re-mint needed",
        )
    # A 4xx WITHOUT the worker's {"error": "..."} body never came from the
    # bearer middleware — it's the edge answering (Cloudflare BIC/WAF 1010,
    # an Access page, an HTML interstitial): not a token verdict, and never
    # "re-mint needed" (a Cloudflare-fronted smoke host did exactly this to
    # the old urllib UA).
    if not isinstance(error, str) or not error:
        return IdentityStatus(
            slot=slot, state=IdentityState.PROBE_ERROR,
            detail=f"probe {probe.status} with no error body — an edge block (WAF/BIC/Access?), "
                   f"not a token verdict",
        )
    # Any other 4xx carrying a worker error (a 401 with an unrecognised
    # error, a 403 no_subject) — re-mint is a safe recovery even if the
    # actual cause was transient.
    return IdentityStatus(
        slot=slot, state=IdentityState.STALE,
        detail=f"probe {probe.status} {error!r} — re-mint needed",
    )


# =============================================================================
# probe_whoami — GET /v1/whoami, side-effect-free
# =============================================================================


@dataclass(frozen=True)
class ProbeResult:
    status: int | None   # None means the request itself never got a response
    body: dict


def probe_whoami(url: str, bearer: str, timeout: float = 10.0) -> ProbeResult:
    """GET {url}/v1/whoami with the given bearer. Mirrors mu-smoke-login's
    fetch_whoami_email posture: stdlib urllib only, a transport hiccup never
    raises — it degrades to ProbeResult(status=None, body={}) so a probe
    failure can only ever warn the identity pane, never crash it. The JSON
    body is read even on a 401 (urllib raises HTTPError there; its .read()
    still carries the {"error": "..."} the auth middleware sent)."""
    # Explicit User-Agent: a Cloudflare-fronted smoke host's zone answers
    # urllib's default "Python-urllib/3.x" with a Cloudflare 1010 block (HTTP
    # 403, text/plain "error code: 1010") before the worker sees the request
    # — which the pane used to render as STALE for a perfectly good token.
    # The harnesses (httpx) were never blocked.
    req = urllib.request.Request(
        f"{url.rstrip('/')}/v1/whoami",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
            "User-Agent": "optical-smoke-runner/1 (bin/smoke-runner.py identity probe)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return ProbeResult(status=None, body={})

    try:
        body = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    return ProbeResult(status=status, body=body)


# =============================================================================
# login_command — the exact copy-ready command per slot
# =============================================================================


def login_command(slot: str, cfg: RunnerConfig, target_url: str) -> str:
    """The exact copy-ready `eval "$(...)"` command for `slot`. Sentinels
    ("google:primary", "microsoft:primary") are NOT accepted here — the
    caller (the registry) resolves a sentinel to a concrete letter via
    cfg.google_primary/cfg.microsoft_primary before asking for a command."""
    if slot.startswith("google:") and slot.split(":", 1)[1] in ("a", "b", "c"):
        letter = slot.split(":", 1)[1].upper()
        flags = []
        for L, flag in (("a", "--email-a"), ("b", "--email-b"), ("c", "--email-c")):
            v = cfg.google.get(L, "")
            if v:
                flags.append(f"{flag} {v}")
        flag_str = (" " + " ".join(flags)) if flags else ""
        return f'eval "$(bin/mu-smoke-login.py {letter} --url {target_url}{flag_str})"'
    if slot.startswith("microsoft:") and slot.split(":", 1)[1] in ("a", "b", "c"):
        letter = slot.split(":", 1)[1].upper()
        flags = []
        for L, flag in (("a", "--email-a"), ("b", "--email-b"), ("c", "--email-c")):
            v = cfg.microsoft.get(L, "")
            if v:
                flags.append(f"{flag} {v}")
        flag_str = (" " + " ".join(flags)) if flags else ""
        return (
            f'eval "$(bin/mu-smoke-login.py {letter} --provider microsoft '
            f'--url {target_url}{flag_str})"'
        )
    raise ValueError(f"unknown identity slot {slot!r}")


# =============================================================================
# scrub_secrets — belt-and-braces log-tee guard
# =============================================================================

# Tokens are exactly 43 chars of base64url (32 random bytes, no padding —
# worker/src/auth/tokens.ts:6-9). The lookarounds require a maximal run: a
# 42- or 44-char neighbour (or a longer base64 blob a harness happens to
# print) must NOT be mangled.
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])")


def scrub_secrets(text: str) -> str:
    return _TOKEN_RE.sub("[REDACTED-TOKEN]", text)
