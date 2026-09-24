# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Declarative harness registry + env composition + result parsing for the
unified smoke runner (bin/smoke-runner.py, WP4). Pure functions, no
subprocess, no network, no Textual — fully unit-tested by
bin/test_smoke_runner_registry.py and bin/test_smoke_runner_results.py.

Import-only dependency on httpx: this module imports bin/_smoke_lib.py (for
the canonical smoke-env db ids/hosts and guard functions — never re-declare
them here), and _smoke_lib.py itself imports httpx at
module scope even though nothing in THIS module calls into httpx directly.

Layering (internal design notes, WP1 section): imports
_smoke_lib but NOT bin/_smoke_identity.py (WP2). The identity/config objects
compose_env takes are duck-typed against WP2's structural contract:
  IdentityTokens: .slot .bearer .refresh .email .client_id .minted_at
  RunnerConfig:   .target .google .google_primary .microsoft .microsoft_primary
                  .microsoft_attendee .poll_invitee_a .poll_invitee_b
Nothing here imports harness code, ever — harnesses are spawned as
subprocesses by WP4, never called into directly.

Provider axis (internal design notes, WP1.3): every `Mode`
declares `provider` — a concrete provider string on every registered mode
(since 2026-09-17: config-smoke/engine-smoke were `None` as "resolve-only",
but a resolve writes chunk events onto the signed-in calendar, so they
touch the provider too and now carry google + microsoft modes; `None`
remains a supported shape for a genuinely calendar-free harness).
`Target.providers` says which providers a deployment hosts; `compose_env`
blocks a mode's provider the target doesn't host, the same way it already
blocks a mode run against a target outside `Mode.targets`. Microsoft grew a
signed-in letter cast mirroring Google's (`microsoft:a/b/c`,
`microsoft:primary` a letter sentinel like `google:primary`); those letters'
tokens are seeded from a distinct `MS_<L>_*` env family so one shell can
hold both a Google and a Microsoft cast at once, but `project_identity`
still projects onto the plain `<L>_*` names every harness already reads —
no harness ever learns the `MS_` names, and project_identity itself needs
no provider awareness at all.

`Mode.advisories` is informational, mode-level advisory text (distinct from
the harness-level `Harness.advisories` and from the run_days gate, which IS
a Blocked). compose_env prefixes a missing-identity Blocked reason with it
(see compose_env step 4) so an operator sees WHY the identity is probably
missing, not just a login-command hint; the TUI (WP1.5) additionally renders
`Mode.advisories` as its own info line in the harness drawer.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Mapping, Sequence

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
assert _spec and _spec.loader, "could not load _smoke_lib module"
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)


# =============================================================================
# Targets
# =============================================================================


@dataclass(frozen=True)
class Target:
    name: str
    scheduler_url: str
    db_id: str
    wrangler_env: str
    # Which providers this deployment hosts sign-in for — compose_env blocks
    # a mode whose provider isn't in this tuple (see _smoke_registry docstring
    # "Provider axis").
    providers: tuple[str, ...] = ("google",)


# dev hosts both providers (MS_PROVIDER_ENABLED="true" there), so the
# Microsoft modes run on dev, side by side with the Google ones.
# _MICROSOFT_TARGETS is where every Microsoft mode runs; _SHARED_TARGETS is
# where a Google mode that also makes sense next to them runs.
_DEV_PROVIDERS: tuple[str, ...] = ("google", "microsoft")
_MICROSOFT_TARGETS: tuple[str, ...] = ("dev",)
_SHARED_TARGETS: tuple[str, ...] = ("dev",)

# booking-smoke microsoft-decline: the owner's Sent Items are read over Graph.
_MICROSOFT_MAIL_READ_ADVISORY = ("needs MICROSOFT_MAIL_READ_SCOPE_ENABLED live on dev with "
                                 "microsoft:a re-consented — the owner's Sent Items are read "
                                 "over Graph Mail.Read")

TARGETS: dict[str, Target] = {
    "dev": Target(
        name="dev",
        scheduler_url="https://scheduler-dev.example.com",
        db_id=_smoke_lib.DEV_DB_ID,
        wrangler_env="dev",
        providers=_DEV_PROVIDERS,
    ),
}


# =============================================================================
# Harness registry
# =============================================================================


# Sentinel used as a Mode.identities value for the single-identity harnesses
# (regression-smoke, reset-smoke-env) whose SCHEDULER_* projection must come
# from whichever google letter the operator has configured as primary
# (RunnerConfig.google_primary) rather than a fixed letter — resolved by
# _resolve_slot() at compose_env time. The microsoft mode of those same
# harnesses uses the mirror sentinel "microsoft:primary", resolved the same
# way off RunnerConfig.microsoft_primary (a letter, like google_primary) —
# Microsoft is no longer a single fixed identity; see the module docstring's
# "Provider axis" note.
_GOOGLE_PRIMARY_SENTINEL = "google:primary"
_MICROSOFT_PRIMARY_SENTINEL = "microsoft:primary"


@dataclass(frozen=True)
class Mode:
    name: str
    args: tuple[str, ...] = ()
    identities: dict[str, str] = field(default_factory=dict)  # env-var prefix -> slot (or a primary sentinel)
    targets: tuple[str, ...] = ()
    needs: tuple[str, ...] = ()
    levels: tuple[str, ...] | None = None  # per-mode override of Harness.levels/default_levels (meeting-smoke)
    # Which provider this mode exercises. None means the harness never
    # touches a calendar, so no target-hosts-provider gate applies and no
    # --provider is ever appended to argv — a supported shape no registered
    # harness uses since 2026-09-17 (Decision 8 amended: config-smoke and
    # engine-smoke resolve, and a resolve writes onto the provider's
    # calendar). Every registered mode names one explicitly.
    provider: str | None = None
    # Purely informational, mode-level advisory text (e.g. meeting-smoke's
    # Microsoft modes: "needs a work tenant ..."), shown alongside the
    # harness-level `Harness.advisories` but never raised as a Blocked —
    # distinct from the run_days advisory gate, which IS overridable/Blocked.
    advisories: tuple[str, ...] = ()


@dataclass(frozen=True)
class Harness:
    name: str
    script: str
    modes: tuple[Mode, ...]
    levels: tuple[str, ...] = ()          # every selectable label (includes e.g. regression's "owned-meetings")
    default_levels: tuple[str, ...] | None = None  # the subset run when levels=None/omitted; falls back to `levels`
    levels_flag: str = "--levels"
    needs: tuple[str, ...] = ()
    run_days: str | None = None
    advisories: tuple[str, ...] = ()
    exit_convention: str = "pass01"
    parser: str = "dash"
    interactive: bool = False
    # Levels that destroy an identity's OAuth tokens server-side (multiuser's
    # M7 offboards B, revoking B's refresh token — any later run projecting
    # B_* then dies in preflight with a 400 on /oauth/token until B is
    # re-minted). The runner's queue planner (smoke-runner.plan_queue) defers
    # these behind every other queued run, splitting the harness invocation
    # in two when needed. Must be a subset of `levels`.
    token_destructive_levels: tuple[str, ...] = ()
    # Which identity PREFIXES (e.g. "B") a token_destructive_levels run
    # destroys — harness-level because the prefix is stable across modes,
    # even though the concrete slot behind it isn't (multiuser-smoke's
    # "default" mode maps "B" to google:b, its "microsoft" mode to
    # microsoft:b). token_destructive_slots() below resolves these through
    # a specific mode to the concrete slot(s) actually at risk; the TUI
    # (WP1.5) renders the post-run re-mint advisory from THAT, not from
    # hardcoded prose. Must be a subset of the mode's own identity prefixes.
    token_destructive_prefixes: tuple[str, ...] = ()
    # When set, compose_env appends [provider_flag, mode.provider] to argv
    # for a mode with a provider (see Mode.provider). regression-smoke and
    # reset-smoke-env already carry an explicit --provider in their Mode.args
    # and keep provider_flag=None so compose_env never adds a second one.
    provider_flag: str | None = None


HARNESSES: dict[str, Harness] = {
    "regression-smoke": Harness(
        name="regression-smoke",
        script="bin/regression-smoke.py",
        modes=(
            Mode(name="google", args=("--provider", "google"), provider="google",
                identities={"SCHEDULER": _GOOGLE_PRIMARY_SENTINEL}, targets=("dev",)),
            Mode(name="microsoft", args=("--provider", "microsoft"), provider="microsoft",
                identities={"SCHEDULER": _MICROSOFT_PRIMARY_SENTINEL}, targets=_MICROSOFT_TARGETS),
            Mode(name="webhook-check", args=("--provider", "google", "--webhook-check"), provider="google",
                identities={"SCHEDULER": _GOOGLE_PRIMARY_SENTINEL}, targets=("dev",)),
            Mode(name="feed-check", args=("--provider", "google", "--feed-check"), provider="google",
                identities={"SCHEDULER": _GOOGLE_PRIMARY_SENTINEL}, targets=("dev",)),
        ),
        # levels is every selectable label, including "owned-meetings"
        # (gate-checked, off by default); default_levels is the harness's
        # own argparse default (--levels default="1,2,3,4,5.1,5.2,6,7,8"),
        # which is what runs when the caller passes levels=None/omitted and
        # what the omit-flag-when-default comparison in compose_env uses.
        levels=("1", "2", "3", "4", "5.1", "5.2", "6", "7", "8", "owned-meetings"),
        default_levels=("1", "2", "3", "4", "5.1", "5.2", "6", "7", "8"),
        needs=("d1",),
        advisories=("reset recommended before running the L-ladder (shared-D1 backlog contention)",),
        exit_convention="pass01",
        parser="regression",
    ),
    "reset-smoke-env": Harness(
        name="reset-smoke-env",
        script="bin/reset-smoke-env.py",
        modes=(
            Mode(name="google", args=("--provider", "google"), provider="google",
                identities={"SCHEDULER": _GOOGLE_PRIMARY_SENTINEL}, targets=("dev",)),
            Mode(name="microsoft", args=("--provider", "microsoft"), provider="microsoft",
                identities={"SCHEDULER": _MICROSOFT_PRIMARY_SENTINEL}, targets=_MICROSOFT_TARGETS),
        ),
        # D1 is not universally optional here — only the falsy-D1_DATABASE_ID
        # degradation path is graceful (wipe_harness_polls: "D1_DATABASE_ID
        # not set — poll rows NOT wiped automatically", then prints a manual
        # command and returns). The runner can never hit that path: compose_env's
        # target triple (step 2) always sets D1_DATABASE_ID. A missing
        # CLOUDFLARE_API_TOKEN does NOT degrade the same way — wipe_harness_polls
        # shells out `wrangler d1 execute` via _smoke_lib.d1_for_db_id, which
        # raises RuntimeError (uncaught by main()) on a nonzero wrangler exit,
        # crashing the run mid-teardown (after the D1 tasks wipe, before the
        # calendar wipe). needs stays () per the plan regardless — this comment
        # just states the real failure mode truthfully rather than implying
        # every D1 absence degrades cleanly. --clear-all/--l6-current-week/
        # --dry-run are WP4-level flag-picker choices (design doc: "bound to
        # the R action with a flag-picker modal, not a harness checkbox") —
        # out of this registry's Mode.args, which only carries the provider
        # split; see compose_env's extra_args parameter.
        needs=(),
        exit_convention="pass01",
        parser="none",
    ),
    "multiuser-smoke": Harness(
        name="multiuser-smoke",
        script="bin/multiuser-smoke.py",
        modes=(
            Mode(name="default", identities={"A": "google:a", "B": "google:b"},
                targets=_SHARED_TARGETS, provider="google"),
            # B here is microsoft:b, not google:b — token_destructive_slots()
            # below resolves the harness-level "B" prefix through WHICHEVER
            # mode actually ran to the concrete slot at risk, so neither this
            # registry nor the harness-level advisory string has to hardcode
            # a provider-specific slot name.
            Mode(name="microsoft", identities={"A": "microsoft:a", "B": "microsoft:b"},
                targets=_MICROSOFT_TARGETS, provider="microsoft",
                advisories=("M6 gated on ms-smoke step 4 being green — deselect "
                            "level 6 until confirmed (runbook, Multi-user smoke → "
                            "Microsoft accounts)",)),
        ),
        provider_flag="--provider",
        levels=("1", "2", "3", "4", "5", "6", "8", "7"),  # M7 destructive — harness's own default keeps it last
        token_destructive_levels=("7",),  # M7 offboard revokes B's tokens — B needs a re-mint afterwards
        token_destructive_prefixes=("B",),
        needs=("d1",),
        advisories=(
            "reset recommended before running the ladder (shared-D1 backlog contention)",
            "M7 offboard destroys the B identity's token and is queued last — "
            "re-mint the slot named by token_destructive_slots after it runs",
        ),
        exit_convention="pass01",
        parser="colon",
    ),
    "meeting-smoke": Harness(
        name="meeting-smoke",
        script="bin/meeting-smoke.py",
        modes=(
            Mode(name="2-account", args=("--accounts", "2"), provider="google",
                identities={"B": "google:b", "C": "google:c"}, targets=_SHARED_TARGETS,
                levels=("2A", "2B", "2C", "2D", "2E", "2F")),
            Mode(name="3-account", args=("--accounts", "3"), provider="google",
                identities={"A": "google:a", "B": "google:b", "C": "google:c"}, targets=_SHARED_TARGETS,
                levels=("M1", "M2", "M3")),
            Mode(name="microsoft-2-account", args=("--accounts", "2"), provider="microsoft",
                identities={"B": "microsoft:b", "C": "microsoft:c"}, targets=_MICROSOFT_TARGETS,
                levels=("2A", "2B", "2C", "2D", "2E", "2F"),
                advisories=("needs a work tenant (all letters in one M365 tenant) — "
                            "MSAs cannot read attendee freebusy",)),
            Mode(name="microsoft-3-account", args=("--accounts", "3"), provider="microsoft",
                identities={"A": "microsoft:a", "B": "microsoft:b", "C": "microsoft:c"}, targets=_MICROSOFT_TARGETS,
                levels=("M1", "M2", "M3"),
                advisories=("needs a work tenant (all letters in one M365 tenant) — "
                            "MSAs cannot read attendee freebusy",)),
        ),
        # WP4: bin/meeting-smoke.py now accepts --provider, so provider_flag
        # is set — every mode's own Mode.provider (google/microsoft) is
        # appended to argv, same as multiuser-smoke and poll-smoke below.
        provider_flag="--provider",
        needs=("d1",),
        exit_convention="pass012",
        parser="colon",
    ),
    "booking-smoke": Harness(
        name="booking-smoke",
        script="bin/booking-smoke.py",
        # 2026-09-17: bin/booking-smoke.py takes --provider and --wrangler-env
        # (TURNSTILE_SECRET_<ENV>, env-pinned D1 cleanup, provider clients,
        # whoami preflight, Graph Sent Items for the decline mode's owner
        # notification checks on Microsoft). "decline" (google) stays
        # dev-only: it reads the owner's Sent folder over Gmail, which needs
        # GOOGLE_GMAIL_READ_SCOPE_ENABLED (on in dev).
        modes=(
            Mode(name="base", args=("--mode", "base"), provider="google",
                identities={"A": "google:a"}, targets=_SHARED_TARGETS),
            Mode(name="decline", args=("--mode", "decline"), provider="google",
                identities={"A": "google:a", "C": "google:c"}, targets=("dev",), needs=("d1",)),
            Mode(name="microsoft-base", args=("--mode", "base"), provider="microsoft",
                identities={"A": "microsoft:a"}, targets=_MICROSOFT_TARGETS),
            Mode(name="microsoft-decline", args=("--mode", "decline"), provider="microsoft",
                identities={"A": "microsoft:a", "C": "microsoft:c"}, targets=_MICROSOFT_TARGETS, needs=("d1",),
                advisories=(_MICROSOFT_MAIL_READ_ADVISORY,)),
        ),
        provider_flag="--provider",
        needs=("turnstile",),  # every mode
        exit_convention="pass01",
        parser="dash",
    ),
    "config-smoke": Harness(
        name="config-smoke",
        script="bin/config-smoke.py",
        # Pure API surface plus resolves; the bearer alone selects the
        # calendar the chunks land on, so no --provider (provider_flag stays
        # None) — the provider only picks the identity and gates the target
        # (Decision 8 amended 2026-09-17).
        modes=(
            Mode(name="default", identities={"A": "google:a"}, targets=_SHARED_TARGETS, provider="google"),
            Mode(name="microsoft", identities={"A": "microsoft:a"}, targets=_MICROSOFT_TARGETS, provider="microsoft"),
        ),
        exit_convention="pass01",
        parser="dash",
    ),
    "engine-smoke": Harness(
        name="engine-smoke",
        script="bin/engine-smoke.py",
        # No --provider here either (same reasoning as config-smoke): the
        # phase is read off the deployed worker (`<name>-<env>`, so any
        # target works as-is), and the resolve lands on whichever calendar
        # the bearer is.
        modes=(
            # `auto` passes no --phase: the harness reads the deployed
            # SOLVER_ENGINE posture off the Workers settings API and asserts
            # the matching phase (container/shadow/fallback/worker). A pinned
            # phase the deployment doesn't match just fails S1/F1 — the
            # 2026-09-02 "shadow" default did exactly that against a
            # fallback-deployed dev.
            Mode(name="auto", identities={"A": "google:a"}, targets=_SHARED_TARGETS, provider="google"),
            # fanout stays explicit: it needs a week crowded enough to leave
            # the root gap open (its engine_fanout summary line is required),
            # so it can't be inferred from the flags alone.
            # fanout stays dev-only: it expects SOLVER_ENGINE_FANOUT_MIN_CHUNKS="1",
            # which only dev overrides.
            Mode(name="fanout", args=("--phase", "fanout"), identities={"A": "google:a"}, targets=("dev",),
                 provider="google"),
            # auto-phase with the Microsoft cast (Decision 8 amended
            # 2026-09-17).
            Mode(name="microsoft", identities={"A": "microsoft:a"}, targets=_MICROSOFT_TARGETS, provider="microsoft"),
        ),
        needs=("d1",),  # also spawns `wrangler tail`; same CLOUDFLARE_API_TOKEN requirement covers both
        exit_convention="pass01",
        parser="dash",
    ),
    "feed-smoke": Harness(
        name="feed-smoke",
        script="bin/feed-smoke.py",
        # 2026-09-17: bin/feed-smoke.py takes --provider (F2 hold through
        # the provider's client + whoami preflight); the worker's feed
        # route is provider-agnostic and CALENDAR_FEED_ENABLED is on
        # wherever Microsoft is, so the google mode runs there too.
        modes=(
            Mode(name="default", identities={"A": "google:a"}, targets=_SHARED_TARGETS, provider="google"),
            Mode(name="microsoft", identities={"A": "microsoft:a"}, targets=_MICROSOFT_TARGETS, provider="microsoft"),
        ),
        provider_flag="--provider",
        exit_convention="pass01",
        parser="dash",
    ),
    "poll-smoke": Harness(
        name="poll-smoke",
        script="bin/poll-smoke.py",
        modes=(
            Mode(name="default", identities={"A": "google:a"}, targets=_SHARED_TARGETS, provider="google"),
            Mode(name="microsoft", identities={"A": "microsoft:a"}, targets=_MICROSOFT_TARGETS, provider="microsoft"),
        ),
        provider_flag="--provider",
        # D1 is optional for this harness (its own cleanup degrades to a
        # printed manual command) — needs stays empty, same reasoning as
        # reset-smoke-env above.
        run_days="mon-thu",
        exit_convention="pass012",
        parser="dash",
        # Captured like every other harness (2026-09-02). The mailbox relay
        # resolves invitee links with no operator; the runner detaches the
        # child's stdin (smoke-runner.default_execute), so a relay miss hits
        # the harness's own "stdin is not a TTY" exit rather than a prompt
        # the TUI would swallow. The relay's mail-read scope is per-provider:
        # the google mode needs GOOGLE_GMAIL_READ_SCOPE_ENABLED, the
        # microsoft mode needs MICROSOFT_MAIL_READ_SCOPE_ENABLED — a target
        # without the matching flag hits the stdin-detached prompt exit above.
        interactive=False,
    ),
    "ms-smoke": Harness(
        name="ms-smoke",
        script="bin/ms-smoke.py",
        modes=(Mode(name="default", identities={"SCHEDULER": _MICROSOFT_PRIMARY_SENTINEL},
                    targets=_MICROSOFT_TARGETS, provider="microsoft"),),
        levels=("1", "2", "3", "4", "5", "6"),
        # D1 (CLOUDFLARE_API_TOKEN) is required only when level 5 is in the
        # effective level set, and MS2_ATTENDEE_EMAIL only when level 6 is —
        # both are level-gated, not a static harness-level `needs`, so they
        # are special-cased in compose_env's "harness extras"/"requirement
        # checks" steps rather than declared here.
        exit_convention="pass012",
        parser="colon",
    ),
}


# =============================================================================
# is_smoke_var — the scrub scope for compose_env step 1.
# =============================================================================


# Whole suffix set for the A_/B_/C_ letter prefixes — closed, so an
# unrelated shell var like A_TEAM or A_CUSTOM_THING is never nuked.
_LETTER_SUFFIXES = ("_BEARER", "_REFRESH", "_EXPECTED_EMAIL", "_CLIENT_ID", "_MINTED_AT", "_HOME_TZ")

# Exact names that don't fit a wildcard prefix (NUDGE_INVITEE_EMAIL doesn't
# start with "NUDGE_INVITEE" the way the *_TOKEN vars share a common prefix
# with their own family; EDIT_C_EMAIL sits alongside the EDIT_*_TOKEN family
# but isn't itself a token). D1_DATABASE_ID/EXPECTED_TEST_ACCOUNT are named
# here rather than wildcarded since they don't share a "SCHEDULER_"/"SMOKE_"
# prefix with anything else.
_EXACT_SMOKE_VARS = frozenset({
    "EXPECTED_TEST_ACCOUNT", "D1_DATABASE_ID", "MS2_ATTENDEE_EMAIL",
    "POLL_SMOKE_ALLOW_ANY_DAY", "POLL_SMOKE_DEADLINE_HOURS",
    "NUDGE_INVITEE_EMAIL", "EDIT_C_EMAIL",
    "NUDGE_TOKEN",
    "UNHAPPY_A_TOKEN", "UNHAPPY_B_TOKEN",
    "HIDDEN_A_TOKEN", "HIDDEN_B_TOKEN",
    "GUESTWAIT_A_TOKEN", "GUESTWAIT_B_TOKEN",
    "BOOKBEST_A_TOKEN",
    "EDIT_A_TOKEN", "EDIT_B_TOKEN", "EDIT_C_TOKEN", "EDIT_D_TOKEN",
})

# Wildcard prefixes. SCHEDULER_*/SMOKE_* are unambiguous enough for a blanket
# scrub (unlike A_*/B_*/C_*, which collide with plausible unrelated shell
# vars); INVITEE_* covers both INVITEE_[AB]_EMAIL and INVITEE_[AB]_TOKEN.
_WILDCARD_PREFIXES = ("SCHEDULER_", "SMOKE_", "INVITEE_")


def is_smoke_var(name: str) -> bool:
    if name in _EXACT_SMOKE_VARS:
        return True
    if name.startswith(_WILDCARD_PREFIXES):
        return True
    if len(name) > 1 and name[0] in ("A", "B", "C") and name[1:] in _LETTER_SUFFIXES:
        return True
    # MS_<L>_* — the distinct env family Microsoft letters seed from
    # (internal design notes Decision 3). Same closed-suffix
    # discipline as the plain letter prefixes above: MS_TEAM and MSA_BEARER
    # (no underscore after MS) must NOT be caught.
    if name.startswith("MS_"):
        rest = name[len("MS_"):]
        if len(rest) > 1 and rest[0] in ("A", "B", "C") and rest[1:] in _LETTER_SUFFIXES:
            return True
    return False


# =============================================================================
# project_identity — env-var projection per prefix.
# =============================================================================


def project_identity(prefix: str, tokens) -> dict[str, str]:
    """`tokens` duck-types WP2's IdentityTokens (.bearer .refresh .email
    .client_id .minted_at). CLIENT_ID/MINTED_AT are included iff
    non-default/present — see the WP1 test list."""
    if prefix == "SCHEDULER":
        out = {
            "SCHEDULER_BEARER": tokens.bearer,
            "SCHEDULER_REFRESH_TOKEN": tokens.refresh,
            "EXPECTED_TEST_ACCOUNT": tokens.email,
        }
        if tokens.client_id != "smoke-cli":
            out["SCHEDULER_CLIENT_ID"] = tokens.client_id
        if tokens.minted_at is not None:
            out["SCHEDULER_MINTED_AT"] = tokens.minted_at.isoformat()
        return out
    if prefix in ("A", "B", "C"):
        out = {
            f"{prefix}_BEARER": tokens.bearer,
            f"{prefix}_REFRESH": tokens.refresh,
            f"{prefix}_EXPECTED_EMAIL": tokens.email,
        }
        if tokens.client_id != "smoke-cli":
            out[f"{prefix}_CLIENT_ID"] = tokens.client_id
        if tokens.minted_at is not None:
            out[f"{prefix}_MINTED_AT"] = tokens.minted_at.isoformat()
        return out
    raise ValueError(f"unknown identity prefix {prefix!r}; expected SCHEDULER, A, B, or C")


# =============================================================================
# compose_env
# =============================================================================


class Blocked(Exception):
    """Raised by compose_env when a run cannot be composed. `.reason` is the
    exact UI text WP4 shows in place of a run action. `.advisory` is True
    only for the overridable run-day gate (step 7) — every other Blocked is a
    hard precondition (missing identity/secret, wrong target, bad config).
    WP4 should branch on this typed flag, not on substrings of `.reason`,
    which is free-form UI text and not a stable API surface."""

    def __init__(self, reason: str, *, advisory: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.advisory = advisory


@dataclass(frozen=True)
class ComposedRun:
    argv: tuple[str, ...]
    env: dict[str, str]


def _find_mode(harness: Harness, mode_name: str) -> Mode:
    for m in harness.modes:
        if m.name == mode_name:
            return m
    raise ValueError(f"{harness.name} has no mode {mode_name!r}")


def _default_levels(harness: Harness, mode: Mode) -> tuple[str, ...]:
    if mode.levels is not None:
        return mode.levels
    if harness.default_levels is not None:
        return harness.default_levels
    return harness.levels


def split_token_destructive(
    harness: Harness, mode_name: str, levels: Sequence[str] | None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Partition a prospective run's EFFECTIVE level set — the caller's
    explicit subset, else the harness/mode default, the same resolution
    compose_env itself uses — into (safe, destructive), both order-
    preserving. `destructive` is the intersection with
    Harness.token_destructive_levels; either half may be empty. Pure
    metadata arithmetic: this function never decides queue order — that is
    smoke-runner.plan_queue's job."""
    mode_obj = _find_mode(harness, mode_name)
    effective = tuple(levels) if levels is not None else _default_levels(harness, mode_obj)
    flagged = frozenset(harness.token_destructive_levels)
    safe = tuple(lvl for lvl in effective if lvl not in flagged)
    destructive = tuple(lvl for lvl in effective if lvl in flagged)
    return safe, destructive


_LETTERS = ("a", "b", "c")


def _resolve_slot(slot_spec: str, cfg) -> str:
    if slot_spec == _GOOGLE_PRIMARY_SENTINEL:
        primary = (getattr(cfg, "google_primary", "a") or "a").strip().lower()
        if primary not in _LETTERS:
            raise Blocked(
                f"config.toml [google].primary={primary!r} is not one of "
                f"{'/'.join(_LETTERS)} — fix google_primary in config.toml"
            )
        return f"google:{primary}"
    if slot_spec == _MICROSOFT_PRIMARY_SENTINEL:
        primary = (getattr(cfg, "microsoft_primary", "a") or "a").strip().lower()
        if primary not in _LETTERS:
            raise Blocked(
                f"config.toml [microsoft].primary={primary!r} is not one of "
                f"{'/'.join(_LETTERS)} — fix microsoft_primary in config.toml"
            )
        return f"microsoft:{primary}"
    return slot_spec


def token_destructive_slots(harness: Harness, mode_name: str, cfg) -> tuple[str, ...]:
    """Which concrete identity slot(s) a run of `harness`/`mode_name` will
    destroy the tokens of, resolved through _resolve_slot() the same way
    compose_env projects an identity — e.g. multiuser-smoke's "default" mode
    resolves its "B" prefix (Harness.token_destructive_prefixes) to
    ("google:b",), its "microsoft" mode to ("microsoft:b",). This is what
    the TUI (WP1.5) renders the post-run re-mint advisory from, instead of
    a hardcoded letter/provider in the registry's advisory prose. A prefix
    not present in this particular mode's own `identities` is silently
    skipped (a harness-level prefix set is meant to be a superset across
    that harness's modes, not a per-mode guarantee)."""
    mode_obj = _find_mode(harness, mode_name)
    out: list[str] = []
    for prefix in harness.token_destructive_prefixes:
        slot_spec = mode_obj.identities.get(prefix)
        if slot_spec is None:
            continue
        out.append(_resolve_slot(slot_spec, cfg))
    return tuple(out)


def _today() -> date:
    """Wrapped so tests can monkeypatch a fixed date — compose_env's public
    signature (per the implementation plan) carries no clock parameter."""
    return date.today()


def _is_mon_thu(d: date) -> bool:
    return d.weekday() in (0, 1, 2, 3)


def _login_command_for_slot(slot: str, cfg, target_url: str) -> str:
    """A local equivalent of WP2's _smoke_identity.login_command — WP1 can't
    import _smoke_identity (layering rule), so the exact copy-ready command
    shapes from the implementation plan's WP2 section are duplicated here.
    Any drift between the two must be caught by inspection, not an import
    the layering forbids.

    Both providers now log in the same way (mu-smoke-login.py <LETTER>,
    optionally --provider microsoft) — the old microsoft:primary ->
    mint-token.py branch is gone, since "primary" is resolved to a concrete
    microsoft:<letter> slot by _resolve_slot() before this function ever
    sees it (internal design notes Decision 2).

    Both branches require the letter suffix to actually be a/b/c — an
    unresolved sentinel ("google:primary"/"microsoft:primary" reaching this
    function directly, bypassing _resolve_slot) falls through to the
    ValueError at the bottom, same as any other unrecognised slot. The
    runner relies on that ValueError (bin/smoke-runner.py's login-command
    call sites wrap this in `except ValueError`), and mirrors wp1a's
    _smoke_identity.login_command exactly."""
    if slot.startswith("google:") and slot.split(":", 1)[1] in _LETTERS:
        letter = slot.split(":", 1)[1].upper()
        google = getattr(cfg, "google", None) or {}
        flag_parts = " ".join(
            f"--email-{l.lower()} {google[l.lower()]}"
            for l in ("A", "B", "C") if google.get(l.lower())
        )
        cmd = f"bin/mu-smoke-login.py {letter} --url {target_url}"
        if flag_parts:
            cmd += f" {flag_parts}"
        return f'eval "$({cmd})"'
    if slot.startswith("microsoft:") and slot.split(":", 1)[1] in _LETTERS:
        letter = slot.split(":", 1)[1].upper()
        microsoft = getattr(cfg, "microsoft", None) or {}
        flag_parts = " ".join(
            f"--email-{l.lower()} {microsoft[l.lower()]}"
            for l in ("A", "B", "C") if microsoft.get(l.lower())
        )
        cmd = f"bin/mu-smoke-login.py {letter} --provider microsoft --url {target_url}"
        if flag_parts:
            cmd += f" {flag_parts}"
        return f'eval "$({cmd})"'
    raise ValueError(f"unknown slot {slot!r}")


def _supports_levels(harness: Harness, mode: Mode) -> bool:
    return bool(_default_levels(harness, mode)) or bool(mode.levels)


def compose_env(
    harness: Harness,
    mode: str,
    target: str,
    base_env: Mapping[str, str],
    identities: Mapping[str, object],
    cfg,
    levels: Sequence[str] | None = None,
    override_run_day: bool = False,
    extra_args: Sequence[str] = (),
) -> ComposedRun:
    mode_obj = _find_mode(harness, mode)
    tgt = TARGETS[target]

    # 1. Scrub every known smoke var from the inherited environment.
    env: dict[str, str] = {k: v for k, v in base_env.items() if not is_smoke_var(k)}

    # 2. Target triple — always, for every harness, regardless of whether it
    # reads all three vars (a stale SMOKE_WRANGLER_ENV can no longer retarget
    # anything, and D1_DATABASE_ID is harmless for a harness that ignores it).
    # Also COLUMNS=200: rich truncates/wraps table cells at the piped default
    # of 80 columns, which can mangle a label (e.g. regression-smoke's
    # "owned-meetings" row renders as "Lowned-meeti…" at width 80 — the
    # ellipsis breaks _parse_regression's label match). 200 keeps every
    # fixture's real-world label intact without depending on the operator's
    # actual terminal width, which the subprocess wouldn't inherit anyway
    # once its stdout/stderr are piped into the log tee.
    env["SCHEDULER_URL"] = tgt.scheduler_url
    env["D1_DATABASE_ID"] = tgt.db_id
    env["SMOKE_WRANGLER_ENV"] = tgt.wrangler_env
    env["COLUMNS"] = "200"

    # 3. Target allowed for this mode — checked BEFORE identity projection,
    # so a wrong-target Blocked never computes (and shows) a login command
    # built against the wrong host (MINOR-4: a mode on a target it doesn't
    # support must not suggest a login command against that target's host).
    if target not in mode_obj.targets:
        raise Blocked(
            f"{harness.name} mode {mode!r} does not support target {target!r} "
            f"(allowed: {', '.join(mode_obj.targets)})"
        )

    # 3b. Target hosts this mode's provider — also before identity
    # projection/login-command computation, for the same reason as 3. A
    # provider-agnostic mode (provider=None — a supported shape, unused by
    # any registered harness since 2026-09-17) never hits this gate.
    if mode_obj.provider is not None and mode_obj.provider not in tgt.providers:
        raise Blocked(
            f"target {target!r} does not host provider {mode_obj.provider!r} — "
            f"{harness.name} mode {mode!r} needs a target with {mode_obj.provider!r} enabled "
            f"(target hosts: {', '.join(tgt.providers)})"
        )

    # 4. Identity projection.
    for prefix, slot_spec in mode_obj.identities.items():
        slot = _resolve_slot(slot_spec, cfg)
        tokens = identities.get(slot)
        if tokens is None:
            reason = (
                f"{slot} identity required for {harness.name} (mode {mode!r}, {prefix}_*) "
                f"is not available. {_login_command_for_slot(slot, cfg, tgt.scheduler_url)}"
            )
            # A mode's own advisories (e.g. meeting-smoke's microsoft-*
            # modes: "needs a work tenant ...") explain WHY the identity is
            # likely missing, not just how to get it — prefixed ahead of the
            # login-command reason so the operator sees both.
            if mode_obj.advisories:
                reason = f"{'; '.join(mode_obj.advisories)} — {reason}"
            raise Blocked(reason)
        env.update(project_identity(prefix, tokens))

    # Effective levels: the caller's explicit subset, else the harness/mode
    # default — needed both for the level-gated extras below and for the
    # argv --levels decision at the end.
    effective_levels = tuple(levels) if levels is not None else _default_levels(harness, mode_obj)

    # 5. Harness extras.
    if harness.name == "ms-smoke" and "6" in effective_levels:
        attendee = (getattr(cfg, "microsoft_attendee", "") or "").strip()
        if not attendee:
            raise Blocked(
                "MS2_ATTENDEE_EMAIL unresolvable — set [microsoft].attendee in config.toml "
                "(level 6 needs a mailbox in a different M365 tenant; it never logs in)"
            )
        env["MS2_ATTENDEE_EMAIL"] = attendee
    if harness.name == "poll-smoke":
        inv_a = (getattr(cfg, "poll_invitee_a", "") or "").strip()
        inv_b = (getattr(cfg, "poll_invitee_b", "") or "").strip()
        if not inv_a or not inv_b:
            raise Blocked(
                "INVITEE_A_EMAIL/INVITEE_B_EMAIL unresolvable — set [poll].invitee_a/invitee_b "
                "(or [google].b/.c, which they default from) in config.toml"
            )
        env["INVITEE_A_EMAIL"] = inv_a
        env["INVITEE_B_EMAIL"] = inv_b

    # 6. Requirement checks — against base_env (the UNSCRUBBED copy), since
    # CLOUDFLARE_API_TOKEN/TURNSTILE_SECRET_<ENV> are never smoke vars anyway.
    effective_needs: set[str] = set(harness.needs) | set(mode_obj.needs)
    if harness.name == "ms-smoke" and "5" in effective_levels:
        effective_needs.add("d1")
    if "d1" in effective_needs and not base_env.get("CLOUDFLARE_API_TOKEN"):
        raise Blocked("missing CLOUDFLARE_API_TOKEN — launch under op run")
    if "turnstile" in effective_needs:
        var = f"TURNSTILE_SECRET_{tgt.wrangler_env.upper()}"
        if not base_env.get(var):
            raise Blocked(
                f"missing {var} — launch under op run (add {var} to .env: the "
                f"{target} Turnstile widget's secret)"
            )

    # 7. Advisory day gate (poll-smoke only, in the current registry).
    if harness.run_days == "mon-thu":
        if not _is_mon_thu(_today()) and not override_run_day:
            raise Blocked(
                f"{harness.name} needs Mon-Thu business-hours availability ahead in the week "
                f"(like L6's weekend caveat) — override to run anyway",
                advisory=True,
            )
        if override_run_day:
            env["POLL_SMOKE_ALLOW_ANY_DAY"] = "true"

    # 8. argv. The --levels flag is emitted only when (a) this harness/mode
    # actually supports level selection AND (b) the caller passed a non-empty
    # subset that differs from the default set — never for a harness with no
    # level concept (a caller-side bug, e.g. WP4 passing levels to
    # config-smoke) and never an empty selection (which would otherwise
    # serialise to a meaningless `--levels ""`). Both cases are silently
    # dropped rather than raised: WP4 may reasonably carry a stale level
    # selection across a harness switch, and crashing env composition over it
    # is more disruptive than just not passing the flag.
    argv: list[str] = ["uv", "run", harness.script, *mode_obj.args]
    if harness.provider_flag is not None and mode_obj.provider is not None:
        argv += [harness.provider_flag, mode_obj.provider]
    argv += list(extra_args)
    if levels is not None and len(levels) > 0 and _supports_levels(harness, mode_obj):
        default = _default_levels(harness, mode_obj)
        if tuple(levels) != default:
            argv += [harness.levels_flag, ",".join(levels)]

    return ComposedRun(argv=tuple(argv), env=env)


def blocked_reason(
    harness: Harness,
    mode: str,
    target: str,
    base_env: Mapping[str, str],
    identities: Mapping[str, object],
    cfg,
    levels: Sequence[str] | None = None,
    override_run_day: bool = False,
    extra_args: Sequence[str] = (),
) -> str | None:
    try:
        compose_env(harness, mode, target, base_env, identities, cfg,
                   levels=levels, override_run_day=override_run_day, extra_args=extra_args)
        return None
    except Blocked as e:
        return e.reason


# =============================================================================
# Result parsing
# =============================================================================


@dataclass(frozen=True)
class LevelResult:
    label: str
    status: str  # "PASS" | "FAIL" | "SKIP"
    notes: str = ""


@dataclass(frozen=True)
class RunOutcome:
    status: str  # "PASS" | "FAIL" | "ALL_SKIPPED" | "SUSPECT"
    levels: tuple[LevelResult, ...]
    detail: str


# -- dash family (booking, config, engine, feed, poll) -----------------------

_DASH_TERMINALS = frozenset({"ALL PASS", "DECLINE PASS"})
_DASH_OTHER_TERMINAL_RE = re.compile(r"^\d+ step\(s\) FAILED$")

_DASH_RE = re.compile(
    r"^(?P<label>[A-Za-z][A-Za-z0-9./+-]*) (?P<tag>PASS|FAIL|SKIP|SKIPPED)\b"
    r"(?: \([^)]*\))?"          # optional "(note: unsat)" parenthetical between tag and dash
    r"(?: — (?P<notes>.*))?$"
)


def _parse_dash(text: str) -> tuple[LevelResult, ...]:
    out: list[LevelResult] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line in _DASH_TERMINALS or line == "nothing genuinely exercised":
            continue
        if _DASH_OTHER_TERMINAL_RE.match(line):
            continue
        m = _DASH_RE.match(line)
        if not m:
            continue
        tag = m.group("tag")
        status = "SKIP" if tag in ("SKIP", "SKIPPED") else tag
        out.append(LevelResult(label=m.group("label"), status=status, notes=m.group("notes") or ""))
    return tuple(out)


# -- colon family (multiuser, meeting, ms-smoke) ------------------------------

_COLON_RE = re.compile(
    r"^\s*(?P<label>[A-Z0-9.-]+): (?P<tag>PASS|FAIL)\s+\((?P<secs>[0-9.]+)s\)\s*(?P<notes>.*)$"
)


def _parse_colon(text: str) -> tuple[LevelResult, ...]:
    out: list[LevelResult] = []
    for raw in text.splitlines():
        m = _COLON_RE.match(raw)
        if not m:
            continue
        tag = m.group("tag")
        notes = m.group("notes") or ""
        status = "SKIP" if tag == "PASS" and notes.startswith("SKIP:") else tag
        out.append(LevelResult(label=m.group("label"), status=status, notes=notes))
    return tuple(out)


# -- regression family ---------------------------------------------------------

# Best-effort row parse (rich table, column widths vary) — the authoritative
# cross-check is the TOTAL line + exit code, per the implementation plan.
_REGRESSION_ROW_RE = re.compile(r"[│|]\s*L(?P<label>[\w.-]+)\s*[│|]\s*(?P<tag>PASS|FAIL)\s*[│|]")
_REGRESSION_TOTAL_RE = re.compile(r"TOTAL \d+/\d+\s+wall=")

# -- colon family's own totals (multiuser vs meeting/ms-smoke differ in shape) --
_COLON_MULTIUSER_TOTAL_RE = re.compile(r"^TOTAL \d+/\d+$", re.MULTILINE)
_COLON_SKIP_AWARE_TOTAL_RE = re.compile(r"^TOTAL pass=\d+ skipped=\d+ of \d+$", re.MULTILINE)


def _parse_regression(text: str) -> tuple[LevelResult, ...]:
    out: list[LevelResult] = []
    for raw in text.splitlines():
        m = _REGRESSION_ROW_RE.search(raw)
        if not m:
            continue
        out.append(LevelResult(label=m.group("label"), status=m.group("tag"), notes=""))
    return tuple(out)


def parse_results(harness_name: str, text: str) -> tuple[LevelResult, ...]:
    harness = HARNESSES[harness_name]
    if harness.parser == "dash":
        return _parse_dash(text)
    if harness.parser == "colon":
        return _parse_colon(text)
    if harness.parser == "regression":
        return _parse_regression(text)
    return ()  # "none" (reset-smoke-env): no level-line grammar at all


def _has_terminal_marker(harness: Harness, text: str) -> bool:
    if harness.parser == "dash":
        lines = {ln.strip() for ln in text.splitlines()}
        return bool(lines & _DASH_TERMINALS)
    if harness.parser == "regression":
        return _REGRESSION_TOTAL_RE.search(text) is not None
    if harness.parser == "colon":
        # multiuser prints "TOTAL <p>/<n>"; meeting/ms-smoke print
        # "TOTAL pass=<g> skipped=<s> of <n>" — either shape counts, since
        # this function isn't told which specific colon harness it's
        # checking. An empty/truncated stream matches neither, so a
        # colon harness reporting exit 0 with no TOTAL line at all is
        # SUSPECT rather than a silent PASS.
        return bool(_COLON_MULTIUSER_TOTAL_RE.search(text) or _COLON_SKIP_AWARE_TOTAL_RE.search(text))
    return True  # "none" (reset-smoke-env): no terminal-marker grammar at all


def classify_run(
    harness_name: str,
    exit_code: int,
    text: str,
    output_unavailable: bool = False,
) -> RunOutcome:
    harness = HARNESSES[harness_name]

    if output_unavailable:
        # An interactive harness (run on the real TTY via App.suspend(); none
        # registered today) has no captured output to cross-check at all — the
        # only signal is the exit code, so SUSPECT (which exists precisely to
        # flag a parse/exit-code disagreement) never applies here.
        detail = "interactive run — output not captured"
        if harness.exit_convention == "pass012" and exit_code == 2:
            return RunOutcome("ALL_SKIPPED", (), detail)
        if exit_code == 0:
            return RunOutcome("PASS", (), detail)
        return RunOutcome("FAIL", (), detail)

    levels = parse_results(harness_name, text)

    is_pass012_all_skipped = harness.exit_convention == "pass012" and exit_code == 2
    is_success = exit_code == 0

    if not is_success and not is_pass012_all_skipped:
        detail = "no level line — see log" if not levels else f"exit code {exit_code} — see log"
        return RunOutcome("FAIL", levels, detail)

    if is_pass012_all_skipped:
        return RunOutcome("ALL_SKIPPED", levels, "harness reported all-skipped (exit 2) — not a pass")

    # exit_code == 0 from here.
    fails = [lv for lv in levels if lv.status == "FAIL"]
    if fails:
        return RunOutcome(
            "SUSPECT", levels,
            "parsed output disagrees with exit code — a FAIL level is present despite exit 0",
        )

    if not _has_terminal_marker(harness, text):
        return RunOutcome(
            "SUSPECT", levels,
            "parsed output disagrees with exit code — no terminal marker found despite exit 0",
        )

    if harness.exit_convention == "pass012" and levels and all(lv.status == "SKIP" for lv in levels):
        return RunOutcome(
            "SUSPECT", levels,
            "every parsed level SKIPped but exit 0 — this harness should have exited 2",
        )

    return RunOutcome("PASS", levels, "ok")
