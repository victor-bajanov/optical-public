#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Mint a Cloudflare Turnstile widget and install its secret on a Worker.

A Turnstile pair is *issued*, not generated: Cloudflare creates a widget bound
to a hostname and hands back a sitekey (public, embedded in the served page) and
a secret (used server-side by `verifyTurnstile` against siteverify). There is no
local equivalent of `openssl rand -hex 32` the way there is for
`TOKEN_HASH_PEPPER` — which is why bin/bootstrap-secrets.sh cannot cover this
one and this script exists.

The secret is never printed, never written to disk and never passed in argv. It
lives in this process's memory for exactly as long as it takes to hand it to
`wrangler secret put` on stdin. Only the sitekey reaches a terminal, on stdout,
alone, so it can be captured:

    SITEKEY=$(op run --env-file=.env -- bin/create-turnstile-widget.py \
                --hostname scheduler.example.com \
                --name 'Optical booking page (prod)' \
                --wrangler-env prod)

Then paste that into the matching `TURNSTILE_SITE_KEY` in worker/wrangler.toml
and deploy. (The sitekey is public by design; it ships in the page HTML.)

Requires CLOUDFLARE_API_TOKEN in the environment — inject it externally
(`op run --env-file=.env -- ...`); this script deliberately knows nothing about
1Password. The token needs Turnstile Sites Read+Write; if it lacks them the
Cloudflare API answers `10000 Authentication error`. Add them by re-running
infra/create-api-token.sh, which updates the existing token in place.

Cloudflare retains the secret — it is readable later from the Turnstile
dashboard, and rotatable there — so nothing is lost by never displaying it here.
"""
import argparse
import os
import pathlib
import subprocess
import sys

API_BASE = "https://api.cloudflare.com/client/v4"
SECRET_NAME = "TURNSTILE_SECRET"
WORKER_DIR = pathlib.Path(__file__).resolve().parent.parent / "worker"


class TurnstileError(Exception):
    """Anything that must abort before a half-configured deploy exists."""


def build_widget_payload(name: str, hostname: str) -> dict:
    """`domains` is what binds a sitekey to a site: a token minted for this
    sitekey elsewhere fails the hostname check in verifyTurnstile. One hostname
    per widget — prod and dev get separate widgets, never a shared one."""
    return {"name": name, "domains": [hostname], "mode": "managed"}


def find_widget_for_domain(widgets: list[dict], hostname: str) -> dict | None:
    for widget in widgets:
        if hostname in (widget.get("domains") or []):
            return widget
    return None


def create_pair(api, name: str, hostname: str, force: bool = False) -> tuple[str, str]:
    """Create the widget and return (sitekey, secret).

    Refuses by default if the hostname already has a widget: minting a second
    one silently strands the first: its sitekey stays live in any deployed page
    while the secret this script installs belongs to the new widget, so every
    claim would fail closed with no obvious cause."""
    if not force:
        existing = find_widget_for_domain(api.list_widgets(), hostname)
        if existing:
            raise TurnstileError(
                f"{hostname} already has a Turnstile widget "
                f"(sitekey {existing.get('sitekey')}). Rotate its secret in the "
                f"dashboard, or pass --force to mint a second one anyway."
            )

    body = api.create_widget(build_widget_payload(name, hostname))
    if not body.get("success"):
        detail = "; ".join(
            e.get("message", "?") for e in (body.get("errors") or [])
        ) or "no error detail"
        raise TurnstileError(f"Cloudflare refused the widget: {detail}")

    result = body.get("result") or {}
    sitekey, secret = result.get("sitekey"), result.get("secret")
    if not sitekey or not secret:
        raise TurnstileError(
            "Cloudflare reported success but returned no sitekey/secret pair"
        )
    return sitekey, secret


def secret_put_command(wrangler_env: str) -> list[str]:
    """`--env` is inheritable in wrangler: omitting it targets the top-level
    (prod) config, which is exactly what prod wants. Passing the wrong one
    installs prod's secret onto scheduler-dev (runbook, Deploy)."""
    cmd = ["npx", "wrangler", "secret", "put", SECRET_NAME]
    if wrangler_env != "prod":
        cmd += ["--env", wrangler_env]
    return cmd


def install_secret(runner, wrangler_env: str, secret: str) -> None:
    cmd = secret_put_command(wrangler_env)
    code = runner(cmd, secret)
    if code != 0:
        raise TurnstileError(
            f"`{' '.join(cmd)}` exited {code} — the secret was NOT installed. "
            f"The widget exists; re-run with --force=no by rotating in the "
            f"dashboard, or push the secret by hand."
        )


def run(*, api, runner, name, hostname, wrangler_env, force, stdout, stderr) -> str:
    """Everything explanatory goes to stderr so stdout carries the sitekey and
    nothing else. The secret is passed to `runner` and referenced nowhere
    else — no f-string, no log line, no exception message."""
    sitekey, secret = create_pair(api, name, hostname, force=force)
    print(f"==> Turnstile widget created for {hostname}", file=stderr)
    print(f"    sitekey (public): {sitekey}", file=stderr)

    install_secret(runner, wrangler_env, secret)
    print(
        f"==> {SECRET_NAME} installed on the {wrangler_env} worker "
        f"(piped from the API response; never displayed)",
        file=stderr,
    )
    print("", file=stderr)
    print("Next:", file=stderr)
    print(
        f'  1. set TURNSTILE_SITE_KEY = "{sitekey}" under the '
        f"{'top-level' if wrangler_env == 'prod' else f'[env.{wrangler_env}]'} "
        f"vars in worker/wrangler.toml",
        file=stderr,
    )
    print("  2. deploy, then load the page and confirm the widget renders", file=stderr)

    print(sitekey, file=stdout)
    return sitekey


class CloudflareApi:
    def __init__(self, token: str, account_id: str):
        import httpx

        self._client = httpx.Client(
            base_url=f"{API_BASE}/accounts/{account_id}/challenges",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
        )

    def list_widgets(self) -> list[dict]:
        res = self._client.get("/widgets")
        body = res.json()
        if not body.get("success"):
            detail = "; ".join(
                e.get("message", "?") for e in (body.get("errors") or [])
            ) or f"HTTP {res.status_code}"
            raise TurnstileError(
                f"could not list existing widgets: {detail}. If this is "
                f"'Authentication error', the token lacks Turnstile Sites "
                f"Read/Write — re-run infra/create-api-token.sh."
            )
        return body.get("result") or []

    def create_widget(self, payload: dict) -> dict:
        return self._client.post("/widgets", json=payload).json()


def subprocess_runner(cmd: list[str], stdin_text: str) -> int:
    """Hands the secret over a pipe. `input=` writes to the child's stdin and
    closes it; it never touches the filesystem or the process table."""
    return subprocess.run(cmd, input=stdin_text, text=True, cwd=WORKER_DIR).returncode


# 'prod' is the top-level wrangler config; every other name is an [env.<name>]
# block (secret_put_command passes --env <name>).
WRANGLER_ENVS: tuple[str, ...] = ("prod", "dev")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create a Turnstile widget and install its secret on a Worker."
    )
    parser.add_argument("--hostname", required=True, help="host that serves the widget")
    parser.add_argument("--name", required=True, help="widget name in the dashboard")
    parser.add_argument(
        "--wrangler-env",
        required=True,
        choices=list(WRANGLER_ENVS),
        help="'prod' targets the top-level wrangler config; any other env passes --env <name>",
    )
    parser.add_argument(
        "--account-id",
        default=os.environ.get("CLOUDFLARE_ACCOUNT_ID", "REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID"),
        help="Cloudflare account (default: the Optical account)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="mint a widget even if the hostname already has one",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        print(
            "CLOUDFLARE_API_TOKEN is not set. Run under "
            "`op run --env-file=.env -- ...`.",
            file=sys.stderr,
        )
        return 2

    try:
        run(
            api=CloudflareApi(token, args.account_id),
            runner=subprocess_runner,
            name=args.name,
            hostname=args.hostname,
            wrangler_env=args.wrangler_env,
            force=args.force,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
    except TurnstileError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
