#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Mint one or more smoke identities (A, B, C) and print the FULL env block,
eval-able to stdout.

Used by every live harness: mu-smoke (identities A/B), meeting-smoke (B/C, plus
A in three-account mode) and poll-smoke (A is the organiser; B and C are the two
invitee mailboxes). Letter C is meeting-smoke's attendee/sharing owner.

--provider {google,microsoft} (default google) mints against the given
federated identity provider (passed through to mint-token.py). Under
--provider microsoft the printed block uses a DISTINCT env family —
MS_<L>_BEARER/_REFRESH/_EXPECTED_EMAIL/_MINTED_AT(/_CLIENT_ID) — so one shell
can hold both a Google and a Microsoft cast at once (internal design notes
"Identity model", Decision 3 of internal design notes).
poll-smoke's INVITEE_A/B_EMAIL are never emitted under --provider microsoft:
poll invitees stay the Gmail smoke mailboxes from [poll], not Microsoft
letters.

Pass all three account emails on every invocation (`--email-a/-b/-c`) — they are
what the printed `*_EXPECTED_EMAIL` vars carry, and this script checks the
freshly minted bearer against the matching one via `GET /v1/whoami`, so logging
in as the wrong Google account fails HERE rather than 15 minutes into a smoke
run.

Beyond the minted identity's own three vars, the block sets everything the
harnesses `req()` so no separate export step is needed:

  SCHEDULER_URL          — the --url given here
  D1_DATABASE_ID         — the scheduler-dev D1 (required by mu-smoke and
                           meeting-smoke, used by poll-smoke for row cleanup)
  <L>_BEARER/_REFRESH/_EXPECTED_EMAIL   — the identity minted this run
  <L>_MINTED_AT          — UTC ISO timestamp of this mint (non-secret; lets a
                           consumer compute exact bearer/refresh expiry from
                           env alone — nothing in this script reads it back)
  <other>_EXPECTED_EMAIL — the other supplied accounts (so minting B later only
                           has to add B's bearer)
  INVITEE_A_EMAIL / INVITEE_B_EMAIL     — poll-smoke's two invitee MAILBOXES,
                           which are accounts B and C (poll-smoke's organiser is
                           identity A; its INVITEE_* names are mailboxes, not
                           identity letters)

Prompts/diagnostics go to STDERR; only the exports go to STDOUT, so it is safe
under command substitution:

  eval "$(bin/mu-smoke-login.py A --url https://<dev-host> \
            --email-a a@x --email-b b@x --email-c c@x)"
  op run --env-file=.env -- bin/multiuser-smoke.py --dry-run

Or mint several identities in one shot — pass all the letters you need as one
invocation and get back a single combined env block (each mint is still its
own interactive Google OAuth dance, run sequentially; switch accounts when
prompted between identities):

  eval "$(bin/mu-smoke-login.py A B C --url https://<dev-host> \
            --email-a a@x --email-b b@x --email-c c@x)"
  op run --env-file=.env -- bin/multiuser-smoke.py --dry-run

No secrets are read, so this does NOT use `op` (secret injection stays external —
the harness's own wrangler calls inject via `op run`).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MINT = Path(__file__).resolve().parent / "mint-token.py"

LETTERS = ("A", "B", "C")
DEFAULT_CLIENT_ID = "smoke-cli"

# Same constants the harnesses guard on (multiuser-smoke.py:46, meeting-smoke.py:88,
# poll-smoke.py:134). PROD_DB_ID is here only so this script can never print it.
DEV_DB_ID = "REPLACE_WITH_YOUR_DEV_D1_DATABASE_ID"   # scheduler-dev
PROD_DB_ID = "REPLACE_WITH_YOUR_PROD_D1_DATABASE_ID"  # scheduler (prod) — NEVER
DEV_HOST = "scheduler-dev.example.com"

# Host -> D1 database id for every smoke deployment this script may mint
# against. A host missing here gets no D1_DATABASE_ID at all (d1_for_url).
_SMOKE_HOST_DBS: dict[str, str] = {DEV_HOST: DEV_DB_ID}


def eprint(*a: object) -> None:
    print(*a, file=sys.stderr, flush=True)


def prompt(label: str) -> str:
    """Prompt on stderr, read one line from the controlling terminal.

    Reading from /dev/tty (not stdin) keeps this working even when stdout is
    captured by `eval "$(...)"` and stdin is otherwise occupied."""
    eprint(label)
    try:
        with open("/dev/tty", "r") as tty:
            return tty.readline().strip()
    except OSError:
        # No tty (piped/non-interactive) — fall back to stdin.
        return sys.stdin.readline().strip()


# =============================================================================
# Pure logic (guarded by bin/test_mu_smoke_login.py)
# =============================================================================


def email_for_letter(letter: str, emails: dict[str, str]) -> str | None:
    """The account email supplied for `letter`, or None if it wasn't given (a
    blank/whitespace value counts as not given — an empty *_EXPECTED_EMAIL
    would make every harness's whoami preflight vacuous)."""
    value = (emails.get(letter) or "").strip()
    return value or None


def whoami_matches(got: str, expected: str) -> bool:
    """Does `GET /v1/whoami`'s email identify the account the operator claimed?
    Case-insensitive: Google echoes the account's own casing, and a case-only
    difference is the same mailbox, not a wrong-account mint. Empty `got` (a
    whoami that returned no email) is never a match."""
    g = (got or "").strip().casefold()
    e = (expected or "").strip().casefold()
    return bool(g) and bool(e) and g == e


def d1_for_url(url: str) -> str | None:
    """The D1 database id for `url`'s host (DEV_DB_ID for the dev host), None
    for anything else (prod, an unrecognised host) — a mint against a host
    this script doesn't know should never silently claim dev's D1.
    Previously build_exports hardcoded DEV_DB_ID regardless of --url."""
    host = urllib.parse.urlparse(url).netloc
    return _SMOKE_HOST_DBS.get(host)


def build_exports(
    letter: str,
    url: str,
    bearer: str,
    refresh: str,
    minted_at: str,
    emails: dict[str, str],
    client_id: str,
    provider: str = "google",
) -> list[str]:
    """The full `export K=V` block for this run. Raises ValueError if the minted
    letter has no email — there would be nothing to check whoami against.

    `provider="microsoft"` emits the MS_<L>_* family instead of plain <L>_*
    (Decision 3, internal design notes) and never emits
    poll-smoke's INVITEE_A/B_EMAIL — those stay the Gmail smoke mailboxes
    from [poll], not Microsoft letters."""
    mine = email_for_letter(letter, emails)
    if not mine:
        raise ValueError(
            f"identity {letter} has no email — pass --email-{letter.lower()} "
            f"(all three accounts are expected on every run)"
        )

    prefix = "MS_" if provider == "microsoft" else ""
    d1 = d1_for_url(url)

    lines = [f"export SCHEDULER_URL={url}"]
    # NIT (Opus review): an unrecognised host actively `unset`s
    # D1_DATABASE_ID rather than just omitting the export line — a stale
    # smoke-db id exported earlier in the same shell (a prior mint against a
    # known host) must not silently survive into an unknown-host run.
    lines.append(f"export D1_DATABASE_ID={d1}" if d1 else "unset D1_DATABASE_ID")
    lines += [
        f"export {prefix}{letter}_BEARER={bearer}",
        f"export {prefix}{letter}_REFRESH={refresh}",
        f"export {prefix}{letter}_EXPECTED_EMAIL={mine}",
        f"export {prefix}{letter}_MINTED_AT={minted_at}",
    ]
    if client_id != DEFAULT_CLIENT_ID:
        lines.append(f"export {prefix}{letter}_CLIENT_ID={client_id}")

    # The other accounts' expected emails, so a later mint of those letters only
    # has to add their bearer/refresh, and so a three-account harness preflight
    # has every expected email from the first run onwards.
    for other in LETTERS:
        if other == letter:
            continue
        other_email = email_for_letter(other, emails)
        if other_email:
            lines.append(f"export {prefix}{other}_EXPECTED_EMAIL={other_email}")

    if provider != "microsoft":
        # poll-smoke's invitee MAILBOXES (not identity letters): the
        # organiser is identity A, so its two invitees are accounts B and C.
        invitee_a = email_for_letter("B", emails)
        invitee_b = email_for_letter("C", emails)
        if invitee_a and invitee_b:
            lines.append(f"export INVITEE_A_EMAIL={invitee_a}")
            lines.append(f"export INVITEE_B_EMAIL={invitee_b}")

    return lines


def merge_export_blocks(blocks: list[list[str]]) -> list[str]:
    """Combine one `build_exports()` block per minted letter into a single
    eval-able block for a multi-letter invocation. Keys that repeat across
    blocks (SCHEDULER_URL, D1_DATABASE_ID, every *_EXPECTED_EMAIL,
    INVITEE_*_EMAIL) keep the value from the LATEST block that set them, but
    stay at the position where they were FIRST seen — so the combined block
    reads the same regardless of how many letters were minted, just with more
    *_BEARER/*_REFRESH pairs.

    A line may also be `unset K` (no `=`) — build_exports's unknown-host
    D1_DATABASE_ID guard — which merges by the same "latest value, first
    position" rule: an `unset` from a later block overrides an earlier
    `export` for that key (and vice versa), so a dev mint followed by an
    unknown-host mint in one shell ends with the id unset, not stale."""
    values: dict[str, str | None] = {}  # None means the key is `unset`, not exported
    order: list[str] = []
    for block in blocks:
        for line in block:
            if line.startswith("unset "):
                key, value = line[len("unset "):], None
            else:
                key, value = line[len("export "):].split("=", 1)
            if key not in values:
                order.append(key)
            values[key] = value
    return [
        f"unset {key}" if values[key] is None else f"export {key}={values[key]}"
        for key in order
    ]


# =============================================================================
# Live steps
# =============================================================================


class MintFailure(Exception):
    """Raised by run_mint/verify_identity in place of a direct sys.exit() when
    minting or verifying a letter fails. main()'s mint loop catches this so a
    failure on a LATER letter (e.g. `A B C` blowing up on C) doesn't discard
    the exports already earned by earlier, already-verified letters — it
    still exits with `returncode`, just after printing what it has."""

    def __init__(self, returncode: int):
        super().__init__(f"mint failed (exit {returncode})")
        self.returncode = returncode


def run_mint(url: str, client_id: str, port: int, provider: str = "google") -> tuple[str, str]:
    """Run mint-token.py; pass its stderr (browser prompts) straight through and
    capture its stdout (the `export SCHEDULER_*` lines — BEARER/REFRESH_TOKEN
    are the two it needs; MINTED_AT is ignored here)."""
    # --no-config: this script owns the letter→email cast and does its own
    # whoami verification; mint-token must not check B/C mints against the
    # smoke config's primary account (or re-resolve the URL from it).
    cmd = [
        str(MINT), "--url", url, "--client-id", client_id, "--port", str(port),
        "--provider", provider, "--no-config",
    ]
    eprint(f"# launching mint-token: {' '.join(cmd)}")
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        eprint("mint-token failed; aborting.")
        raise MintFailure(proc.returncode)
    bearer = refresh = ""
    for line in proc.stdout.splitlines():
        if line.startswith("export SCHEDULER_BEARER="):
            bearer = line.split("=", 1)[1]
        elif line.startswith("export SCHEDULER_REFRESH_TOKEN="):
            refresh = line.split("=", 1)[1]
    if not bearer or not refresh:
        eprint(f"could not parse bearer/refresh from mint-token output:\n{proc.stdout}")
        raise MintFailure(1)
    return bearer, refresh


# =============================================================================
# Smoke-runner config — default per-letter emails when --email-<l> is omitted
# (bin/_smoke_identity.py owns the schema; loaded via importlib, like
# mint-token.py does, so this script stays stdlib-only)
# =============================================================================

_IDENTITY_MODULE = None


def _smoke_identity_module():
    """Lazily load bin/_smoke_identity.py by file path (spec_from_file_location,
    mirroring mint-token.py's own import of the same module) — cached after
    the first call. Never third-party: _smoke_identity is stdlib-only."""
    global _IDENTITY_MODULE
    if _IDENTITY_MODULE is None:
        spec = importlib.util.spec_from_file_location(
            "_smoke_identity", Path(__file__).resolve().parent / "_smoke_identity.py"
        )
        assert spec and spec.loader, "could not load _smoke_identity module"
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        _IDENTITY_MODULE = mod
    return _IDENTITY_MODULE


def load_smoke_config(config_arg: str | None, no_config: bool, environ: dict[str, str] | None = None):
    """Best-effort load of the smoke-runner config (~/.config/optical-smoke/
    config.toml, or an XDG-relative/explicit path) for default per-letter
    emails. `environ` only steers WHERE that default path resolves to (via
    _smoke_identity.config_path's $XDG_CONFIG_HOME handling) — it never
    changes whether a load happens. Returns None in exactly two cases:
    disabled (--no-config), or the resolved file doesn't exist. Malformed
    TOML or a wrong-typed value still raises ValueError naming the path
    (same posture as _smoke_identity.load_config: a hand-edited config is a
    first-class flow, so a typo must fail loudly, not degrade into "why
    does it keep prompting me")."""
    if no_config:
        return None
    ident = _smoke_identity_module()
    path = Path(config_arg) if config_arg else ident.config_path(environ)
    if not path.exists():
        return None
    return ident.load_config(path)


def config_email_for_letter(cfg, provider: str, letter: str) -> str | None:
    """The smoke-runner config's email for `letter` under `provider`
    ("google" or "microsoft"), or None when `cfg` is None or that letter is
    unset. Mirrors cfg.google/cfg.microsoft's own letter-keyed shape."""
    if cfg is None:
        return None
    cast = cfg.microsoft if provider == "microsoft" else cfg.google
    v = (cast.get(letter.lower()) or "").strip()
    return v or None


def resolve_emails(args, environ: dict[str, str], cfg) -> dict[str, str]:
    """The three account emails for this run (A/B/C), in precedence order:

      explicit --email-<l> flag
      > the PROVIDER-SCOPED env var (<L>_EXPECTED_EMAIL for google,
        MS_<L>_EXPECTED_EMAIL for microsoft)
      > the smoke-runner config's cast for --provider
        ([google].<l> or [microsoft].<l>)
      > "" (main()'s caller then prompts)

    REVIEW FIX (Opus review of WP1a): the env step used to be baked into
    argparse's --email-a/-b/-c DEFAULTS, which always read the plain
    <L>_EXPECTED_EMAIL family regardless of --provider. Decision 3
    (internal design notes) lets one shell hold BOTH a
    Google and a Microsoft cast at once via the MS_<L>_* family precisely so
    a mixed campaign works — reading the wrong family here silently seeded
    a Microsoft mint with a Google address (loud under verify, silently
    wrong under --no-verify or for a letter not minted this run). Choosing
    the family from args.provider, resolved AFTER argparse, fixes that.

    The deprecated --email alias, if given, overrides the first positional
    letter's resolved value last (validated single-letter-only by the
    caller)."""
    prefix = "MS_" if args.provider == "microsoft" else ""
    flag_values = {"A": args.email_a, "B": args.email_b, "C": args.email_c}
    emails: dict[str, str] = {}
    for L in LETTERS:
        flag_value = (flag_values[L] or "").strip()
        env_value = (environ.get(f"{prefix}{L}_EXPECTED_EMAIL") or "").strip()
        cfg_value = config_email_for_letter(cfg, args.provider, L) or ""
        emails[L] = flag_value or env_value or cfg_value
    if args.email:
        emails[args.letters[0]] = args.email
    return emails


def fetch_whoami_email(url: str, bearer: str, timeout: float = 15.0) -> str | None:
    """`GET /v1/whoami`'s email for `bearer`, or None if the call itself failed
    (network error, non-JSON body, missing scope). None means "could not check"
    — the caller warns rather than aborting, so a whoami hiccup can never block
    an otherwise good mint. Stdlib urllib on purpose: this script has no
    third-party dependencies."""
    req = urllib.request.Request(
        f"{url}/v1/whoami",
        headers={"Authorization": f"Bearer {bearer}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        eprint(f"# NOTE: /v1/whoami check could not run ({e}) — skipping identity verification")
        return None
    email = body.get("email")
    return email if isinstance(email, str) else None


def verify_identity(
    url: str, bearer: str, letter: str, expected: str, provider: str = "google"
) -> None:
    """Abort (exit 1) if the minted bearer belongs to a different account than
    the one claimed for `letter` — the wrong-account mistake this script has
    always warned about in prose, now caught before any harness runs."""
    got = fetch_whoami_email(url, bearer)
    if got is None:
        return
    if not whoami_matches(got, expected):
        provider_name = "Microsoft" if provider == "microsoft" else "Google"
        switch_hint = (
            "an InPrivate window" if provider == "microsoft" else "the Google chooser or an incognito window"
        )
        eprint(
            f"error: identity {letter} minted as {got!r}, but --email-{letter.lower()} "
            f"says {expected!r}. You logged in as the wrong {provider_name} account — re-run and "
            f"switch accounts ({switch_hint})."
        )
        raise MintFailure(1)
    eprint(f"# verified: identity {letter} authenticates as {got}")


def next_hint(provider: str, letters: list[str], minted: list[str]) -> str:
    """The "what to do next" line printed after a successful mint.

    `letters` is the full set requested this run (drives the "Now mint
    X, Y, then:" vs "Next:" choice, same as before); `minted` is the subset
    that actually minted (used for the microsoft manual-mapping example —
    on the success path they're the same list, since `main` returns early
    on any MintFailure before reaching this call).

    Under google the closing command is unchanged: a direct
    `multiuser-smoke.py --dry-run` invocation reads plain `<L>_EXPECTED_EMAIL`
    etc., which is exactly what a google mint just exported.

    Under microsoft that same direct invocation is wrong: mu-smoke-login
    exports the `MS_<L>_*` family (not plain `<L>_*`, see the module
    docstring / Decision 3), so `multiuser-smoke.py --dry-run` run directly
    would read unset or stale plain vars. Point instead at
    `bin/smoke-runner.py`, which projects `MS_<L>_*` onto `<L>_*`
    automatically, and give the manual-mapping fallback for anyone who wants
    to run the harness directly anyway.
    """
    # Letters not touched by THIS run (as opposed to `missing` in main, which
    # is about which accounts have no known email at all) — drives the hint.
    not_run_this_time = [x for x in LETTERS if x not in letters]
    provider_reminder = " --provider microsoft" if provider == "microsoft" else ""
    if len(letters) == 1:
        lead = f"# identity {letters[0]} ready. "
    else:
        lead = f"# identities {'/'.join(letters)} ready. "
    lead += (
        f"Now mint {', '.join(not_run_this_time)}{provider_reminder}, then:"
        if not_run_this_time else "Next:"
    )
    if provider == "microsoft":
        mapping = " ".join(
            f"{L}_BEARER=$MS_{L}_BEARER {L}_REFRESH=$MS_{L}_REFRESH "
            f"{L}_EXPECTED_EMAIL=$MS_{L}_EXPECTED_EMAIL"
            for L in minted
        )
        return (
            f"{lead} run via bin/smoke-runner.py (it projects MS_<L>_* onto "
            f"<L>_* automatically), or map by hand: {mapping} "
            "… op run --env-file=.env -- bin/multiuser-smoke.py "
            "--provider microsoft --dry-run"
        )
    return (
        f"{lead} op run --env-file=.env -- bin/multiuser-smoke.py --dry-run"
        "  (or bin/meeting-smoke.py / bin/poll-smoke.py)"
    )


def main() -> int:
    p = argparse.ArgumentParser(
        description="Mint one or more smoke identities (A, B, C) and print the combined "
                     "harness env block."
    )
    p.add_argument("letters", nargs="+", choices=list(LETTERS),
                   help="Which identities to mint now, in order (e.g. `A` or `A B C`). "
                        "A/B for mu-smoke; B/C (and A) for meeting-smoke; A is poll-smoke's "
                        "organiser. Each letter may appear at most once.")
    p.add_argument("--url", default=os.environ.get("SCHEDULER_URL"),
                   help="Scheduler base URL (default: $SCHEDULER_URL). Use the DEV host.")
    p.add_argument("--provider", choices=["google", "microsoft"], default="google",
                   help="Federated identity provider (default: google). Under microsoft, "
                        "emails default to the smoke config's [microsoft].<letter> and "
                        "exports use the MS_<L>_* family instead of plain <L>_*.")
    p.add_argument("--email-a", default=None,
                   help="Account A's email (organiser for poll-smoke). Default: the "
                        "provider-scoped *_EXPECTED_EMAIL env var (A_EXPECTED_EMAIL for "
                        "google, MS_A_EXPECTED_EMAIL for microsoft), else the smoke "
                        "config, else a prompt.")
    p.add_argument("--email-b", default=None,
                   help="Account B's email (poll-smoke's INVITEE_A_EMAIL). Same "
                        "provider-scoped env/config/prompt default as --email-a.")
    p.add_argument("--email-c", default=None,
                   help="Account C's email (poll-smoke's INVITEE_B_EMAIL). Same "
                        "provider-scoped env/config/prompt default as --email-a.")
    p.add_argument("--email", default=None,
                   help="Deprecated alias for the minted letter's own email "
                        "(--email-a/-b/-c is preferred; this sets only that one). Only "
                        "valid when minting a single letter.")
    p.add_argument("--client-id", default=DEFAULT_CLIENT_ID,
                   help=f"PKCE client_id (default: {DEFAULT_CLIENT_ID}).")
    p.add_argument("--port", type=int, default=8976,
                   help="Localhost callback port (default: 8976; reuse across letters, "
                        "they run sequentially).")
    p.add_argument("--no-verify", action="store_true",
                   help="Skip the /v1/whoami identity check after minting.")
    p.add_argument("--config", default=None,
                   help="Smoke-runner config file to default per-letter emails from "
                        "(default: ~/.config/optical-smoke/config.toml if it exists).")
    p.add_argument("--no-config", action="store_true",
                   help="Don't look up default emails from the smoke-runner config — "
                        "prompt instead when --email-<l> is omitted.")
    args = p.parse_args()

    letters = args.letters
    if len(set(letters)) != len(letters):
        eprint(f"error: duplicate identity letters in {letters!r} — pass each letter once.")
        return 2

    if args.email and len(letters) > 1:
        eprint(
            "error: --email is only valid with a single letter (it's a deprecated alias "
            "for that letter's own email); use --email-a/-b/-c for multi-letter runs."
        )
        return 2

    if not args.url:
        eprint("error: --url (or $SCHEDULER_URL) is required — point it at the DEV host.")
        return 2
    url = args.url.rstrip("/")

    try:
        smoke_cfg = load_smoke_config(args.config, args.no_config, os.environ)
    except ValueError as e:
        eprint(f"error: {e}")
        return 2

    emails = resolve_emails(args, os.environ, smoke_cfg)

    for L in letters:
        if not email_for_letter(L, emails):
            emails[L] = prompt(
                f"Expected email for identity {L} (pass --email-{L.lower()} to skip this prompt):"
            )
        if not email_for_letter(L, emails):
            eprint(f"error: identity {L}'s email is required.")
            return 1

    missing = [x for x in LETTERS if not email_for_letter(x, emails)]
    if missing:
        eprint(
            f"# NOTE: no email given for {', '.join(missing)} — their *_EXPECTED_EMAIL "
            f"(and poll-smoke's INVITEE_A/B_EMAIL) will NOT be exported. Pass all three "
            f"--email-a/--email-b/--email-c to get the complete block."
        )

    blocks: list[list[str]] = []
    minted: list[str] = []
    failure: MintFailure | None = None
    provider_name = "Microsoft" if args.provider == "microsoft" else "Google"
    switch_hint = (
        "use an InPrivate window" if args.provider == "microsoft"
        else "use the Google chooser or an incognito window"
    )
    for L in letters:  # `letters` is never empty (nargs="+"), so L is always bound below
        eprint(f"# === identity {L} ({emails[L]}) against {url} ===")
        eprint(f"# Log in as identity {L}'s {provider_name} account. For B/C, switch accounts "
               f"({switch_hint}) so you don't reuse A's session.")

        try:
            bearer, refresh = run_mint(url, args.client_id, args.port, args.provider)
            # Stamped here, not parsed out of mint-token's stdout: decoupled
            # from that script's own export format, and correct within a
            # second regardless.
            minted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            if not args.no_verify:
                verify_identity(url, bearer, L, emails[L], args.provider)
            blocks.append(
                build_exports(L, url, bearer, refresh, minted_at, emails, args.client_id, args.provider)
            )
        except MintFailure as e:
            failure = e
            break
        except ValueError as e:
            eprint(f"error: {e}")
            failure = MintFailure(1)
            break
        else:
            minted.append(L)

    if failure is not None:
        # Partial output is strictly better than none: every line already
        # printed is a freshly whoami-verified export for a letter that DID
        # mint, and `eval "$(...)"` ignores this script's exit status anyway.
        if blocks:
            print("\n".join(merge_export_blocks(blocks)))
        if len(letters) > 1:
            unminted = [x for x in letters if x not in minted]
            eprint(
                f"error: minting stopped at identity {L} — {', '.join(unminted)} did NOT "
                "mint this run."
                + (f" Exports above are for {', '.join(minted)} only." if minted
                   else " No exports were produced.")
            )
        return failure.returncode

    print("\n".join(merge_export_blocks(blocks)))

    eprint(next_hint(args.provider, letters, minted))
    return 0


if __name__ == "__main__":
    sys.exit(main())
