#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Mint a scheduler bearer + refresh token via the federated PKCE flow.

Replaces the retired device-code flow. Runs the browser-interactive
authorization_code + PKCE grant end to end:

  1. generates a PKCE verifier/challenge and a random state
  2. opens <url>/oauth/authorize in your browser (which federates to Google)
  3. listens on http://localhost:<port>/callback for the optical code
  4. exchanges the code at <url>/oauth/token
  5. prints SCHEDULER_BEARER and SCHEDULER_REFRESH_TOKEN

You must log in (in the browser) as an account listed in the worker's
OPERATOR_EMAIL allowlist — for the regression smoke harness that is the
sandbox account (e.g. operator.alt@example.com). That account becomes the
connected calendar/subject.

One-time setup: register this CLI's localhost redirect on a PKCE client, e.g.

  ./bin/register-pkce-client.sh smoke-cli http://localhost:8976/callback

Then:

  ./bin/mint-token.py                       # defaults: smoke-cli, prod URL, :8976
  ./bin/mint-token.py --url https://scheduler.example.com \
      --client-id smoke-cli --port 8976 --scope "scheduler:read scheduler:write"

Smoke-runner config (internal design notes): if
~/.config/optical-smoke/config.toml exists it supplies the target URL and the
expected account, so no per-run flags are needed:

  [defaults] target = "dev"      →  the base URL (an explicit --url still
      wins; a plain $SCHEDULER_URL in the shell does NOT override the config —
      the stale-env retargeting lesson). Prod stays a deliberate act: with a
      config present it is only reachable via --url.
  [google] a/b/c + primary       →  the expected Google account (the primary
      letter's email); [microsoft] a/b/c + primary (a letter, mirroring
      [google]) for --provider microsoft. A legacy [microsoft].primary =
      "<email>" form still loads (mapped onto letter "a"), but is never
      written back.

When the expected account is known, the freshly minted bearer is verified via
GET /v1/whoami (wrong-account logins fail here, not 15 minutes into a smoke
run; --no-verify skips) and `export EXPECTED_TEST_ACCOUNT=<email>` is printed
alongside the tokens for the single-identity harnesses. --config points at an
alternate file; --no-config ignores any config (mu-smoke-login.py passes it —
its letters have their own emails and their own whoami check).

No secrets are read, so this does NOT need `op run`.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

# The smoke-runner's identity module owns the config schema (RunnerConfig,
# load_config, config_path) — reuse it rather than growing a second parser
# that could drift. Spec-loaded (same pattern _smoke_registry.py uses for
# _smoke_lib) so this works from any cwd; _smoke_identity is stdlib-only, so
# this script's no-third-party-deps posture is unchanged.
import importlib.util as _importlib_util

_ident_spec = _importlib_util.spec_from_file_location(
    "_smoke_identity", Path(__file__).resolve().parent / "_smoke_identity.py"
)
assert _ident_spec and _ident_spec.loader, "could not load _smoke_identity module"
_smoke_identity = _importlib_util.module_from_spec(_ident_spec)
sys.modules[_ident_spec.name] = _smoke_identity
_ident_spec.loader.exec_module(_smoke_identity)

# Hosts mirror bin/_smoke_registry.py's TARGETS (which mint-token cannot
# import — the registry needs httpx); bin/test_mint_token_config.py asserts
# the two stay identical. Prod is deliberately NOT a target name: with a
# config present, prod requires an explicit --url.
TARGET_URLS = {
    "dev": "https://scheduler-dev.example.com",
}
PROD_URL = "https://scheduler.example.com"
GOOGLE_LETTERS = ("a", "b", "c")
MICROSOFT_LETTERS = ("a", "b", "c")


# =============================================================================
# Pure logic (guarded by bin/test_mint_token_config.py)
# =============================================================================


def load_optional_config(path: Path):
    """RunnerConfig when the file exists, else None — unlike
    _smoke_identity.load_config (which maps a missing file to defaults), this
    caller must distinguish "no config" (legacy behaviour: $SCHEDULER_URL/prod,
    no account verification) from "config present". Malformed TOML or
    wrong-typed values raise ValueError naming the path — a config that exists
    but can't be read must never silently degrade to prod-defaulting."""
    if not path.exists():
        return None
    return _smoke_identity.load_config(path)


def resolve_url(cli_url: str | None, cfg, environ: dict[str, str]) -> str:
    """Base URL precedence: --url > config target > $SCHEDULER_URL > prod.
    The config target outranks $SCHEDULER_URL on purpose: a leftover export
    from an earlier campaign must not retarget a run once the config declares
    where smokes go by default. `cfg` is a RunnerConfig or None (no config
    file); a file without [defaults] carries RunnerConfig's "dev" default."""
    if cli_url:
        return cli_url
    if cfg is not None:
        url = TARGET_URLS.get(cfg.target)
        if url is None:
            raise ValueError(
                f"config [defaults].target is {cfg.target!r} — expected one of "
                f"{sorted(TARGET_URLS)} (prod needs an explicit --url)"
            )
        return url
    return environ.get("SCHEDULER_URL") or PROD_URL


def resolve_expected_email(cfg, provider: str) -> str | None:
    """The account this mint should authenticate as, per the config's cast:
    [google]'s primary-letter email, or [microsoft]'s primary-letter email
    (mirrors google — Decision 2, letter-indexed for both providers). None
    when the config (or the provider's email for that letter) is absent —
    the mint then runs unverified, as it always did. A primary letter
    outside a/b/c is loud, for either provider."""
    if cfg is None:
        return None
    if provider == "microsoft":
        letter = cfg.microsoft_primary.strip().lower()
        if letter not in MICROSOFT_LETTERS:
            raise ValueError(
                f"config [microsoft].primary is {letter!r} — expected one of "
                f"{'/'.join(MICROSOFT_LETTERS)}"
            )
        return (cfg.microsoft.get(letter) or "").strip() or None
    letter = cfg.google_primary.strip().lower()
    if letter not in GOOGLE_LETTERS:
        raise ValueError(
            f"config [google].primary is {letter!r} — expected one of {'/'.join(GOOGLE_LETTERS)}"
        )
    return (cfg.google.get(letter) or "").strip() or None


def whoami_matches(got: str, expected: str) -> bool:
    """Same semantics as mu-smoke-login.py's guard: case-insensitive (a
    case-only difference is the same mailbox), and an empty `got` never
    matches."""
    g = (got or "").strip().casefold()
    e = (expected or "").strip().casefold()
    return bool(g) and bool(e) and g == e


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_pkce() -> tuple[str, str]:
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def token_export_lines(
    access: str, refresh: str, minted_at: str, expected_email: str | None = None
) -> list[str]:
    """The full `export K=V` stdout block for a successful token exchange —
    the one thing every eval-consuming caller (a bare shell `eval`,
    mu-smoke-login.py, the future smoke-runner) depends on. MINTED_AT is
    non-secret (a UTC ISO timestamp) and purely additive: existing callers
    that don't read it are unaffected. EXPECTED_TEST_ACCOUNT (what
    regression-smoke / reset-smoke-env / ms-smoke preflight against) rides
    along only when the config supplied an expected account."""
    lines = [
        f"export SCHEDULER_BEARER={access}",
        f"export SCHEDULER_REFRESH_TOKEN={refresh}",
        f"export SCHEDULER_MINTED_AT={minted_at}",
    ]
    if expected_email:
        lines.append(f"export EXPECTED_TEST_ACCOUNT={expected_email}")
    return lines


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    # Populated on the server instance once the callback arrives.
    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != self.server.expected_path:  # type: ignore[attr-defined]
            self.send_error(404)
            return
        self.server.query = urllib.parse.parse_qs(parsed.query)  # type: ignore[attr-defined]
        body = (
            b"<!doctype html><html><body><h2>Token captured.</h2>"
            b"<p>You can close this tab and return to the terminal.</p></body></html>"
        )
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:  # silence default request logging
        pass


def fetch_whoami_email(url: str, bearer: str, timeout: float = 15.0) -> str | None:
    """`GET /v1/whoami`'s email for `bearer`, or None if the call itself failed
    (network error, non-JSON body). None means "could not check" — the caller
    warns rather than aborting, so a whoami hiccup never blocks an otherwise
    good mint. Same posture as mu-smoke-login.py."""
    req = urllib.request.Request(
        f"{url}/v1/whoami",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
            "user-agent": "optical-mint-token/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        print(f"# NOTE: /v1/whoami check could not run ({e}) — skipping account verification",
              file=sys.stderr)
        return None
    email = body.get("email")
    return email if isinstance(email, str) else None


def main() -> int:
    p = argparse.ArgumentParser(description="Mint a scheduler bearer/refresh token via PKCE.")
    p.add_argument("--url", default=None,
                   help="Scheduler base URL / OAUTH_ISSUER. Default: the config's "
                        "[defaults].target, else $SCHEDULER_URL, else prod.")
    p.add_argument("--client-id", default="smoke-cli",
                   help="PKCE client_id whose redirect_uris include the localhost callback (default: smoke-cli).")
    p.add_argument("--provider", choices=["google", "microsoft"], default="google",
                   help="Federated identity provider to authorize against (default: google). "
                        "Requires MS_PROVIDER_ENABLED=true on the target worker for \"microsoft\".")
    p.add_argument("--port", type=int, default=8976, help="Localhost port for the callback listener (default: 8976).")
    p.add_argument("--scope", default="scheduler:read scheduler:write calendar:raw-token admin",
                   help="Requested scope string (server narrows to the client's allowed_scopes and the subject's role).")
    p.add_argument("--config", default=None,
                   help="Smoke-runner config file (default: ~/.config/optical-smoke/config.toml "
                        "if it exists; format in internal design notes).")
    p.add_argument("--no-config", action="store_true",
                   help="Ignore any smoke-runner config (mu-smoke-login.py passes this — "
                        "its letters carry their own emails and whoami check).")
    p.add_argument("--no-verify", action="store_true",
                   help="Skip the post-mint /v1/whoami check against the config's expected account.")
    args = p.parse_args()

    config = None
    if not args.no_config:
        config_path = Path(args.config) if args.config else _smoke_identity.config_path()
        try:
            config = load_optional_config(config_path)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        if args.config and config is None:
            print(f"error: --config {config_path} does not exist.", file=sys.stderr)
            return 2
        if config is not None:
            print(f"# using smoke config: {config_path}", file=sys.stderr)

    try:
        url = resolve_url(args.url, config, dict(os.environ))
        expected_email = resolve_expected_email(config, args.provider)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    base = url.rstrip("/")
    redirect_uri = f"http://localhost:{args.port}/callback"
    verifier, challenge = make_pkce()
    state = secrets.token_urlsafe(16)

    authorize = base + "/oauth/authorize?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": args.client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "scope": args.scope,
        "state": state,
        "provider": args.provider,
    })

    server = http.server.HTTPServer(("127.0.0.1", args.port), _CallbackHandler)
    server.expected_path = "/callback"  # type: ignore[attr-defined]
    server.query = None  # type: ignore[attr-defined]

    print(f"Opening browser for authorization (client_id={args.client_id}, provider={args.provider}).", file=sys.stderr)
    if expected_email:
        print(f"Log in as {expected_email} (the config's {args.provider} account).\n", file=sys.stderr)
    else:
        print(f"Log in as an OPERATOR_EMAIL-allowlisted {args.provider.capitalize()} account.\n", file=sys.stderr)
    print(f"If the browser does not open, visit:\n  {authorize}\n", file=sys.stderr)
    webbrowser.open(authorize)

    # Block until the single callback request arrives.
    server.handle_request()
    query: dict[str, list[str]] | None = server.query  # type: ignore[attr-defined]
    server.server_close()

    if not query:
        print("No callback received.", file=sys.stderr)
        return 1
    if "error" in query:
        err = query["error"][0]
        print(f"Authorization failed: {err}", file=sys.stderr)
        if err == "access_denied":
            print("The Google account you logged in as is not in the worker's "
                  "OPERATOR_EMAIL allowlist.", file=sys.stderr)
        return 1
    if query.get("state", [None])[0] != state:
        print("State mismatch — possible CSRF; aborting.", file=sys.stderr)
        return 1
    code = query.get("code", [None])[0]
    if not code:
        print("Callback carried no authorization code.", file=sys.stderr)
        return 1

    token_body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "client_id": args.client_id,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }).encode("ascii")
    req = urllib.request.Request(
        base + "/oauth/token",
        data=token_body,
        headers={
            "content-type": "application/x-www-form-urlencoded",
            # Cloudflare's Browser Integrity Check returns 1010 for the default
            # urllib UA; any descriptive UA reaches the Worker.
            "user-agent": "optical-mint-token/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            tok = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"Token exchange failed ({e.code}): {e.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 1

    access = tok.get("access_token")
    refresh = tok.get("refresh_token")
    if not access or not refresh:
        print(f"Unexpected token response: {tok}", file=sys.stderr)
        return 1

    minted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"# granted scope: {tok.get('scope','')}", file=sys.stderr)

    if expected_email and not args.no_verify:
        got = fetch_whoami_email(base, access)
        if got is not None:
            if not whoami_matches(got, expected_email):
                print(
                    f"error: minted as {got!r}, but the config expects {expected_email!r}. "
                    f"You logged in as the wrong {args.provider.capitalize()} account — re-run "
                    f"and switch accounts (account chooser or an incognito window).",
                    file=sys.stderr,
                )
                return 1
            print(f"# verified: authenticates as {got}", file=sys.stderr)

    # Tokens to stdout (so `eval $(... )` or copy-paste into 1Password works);
    # diagnostics go to stderr above.
    for line in token_export_lines(access, refresh, minted_at, expected_email):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
