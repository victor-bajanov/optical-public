#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Operator CLI for an optical deployment: wraps the existing admin routes so
uninviting someone or re-running the Monday resolve isn't a hand-written curl.

    uv run bin/optical-admin.py offboard <email> --env <env> --yes
    uv run bin/optical-admin.py rebind <email> --env <env> --yes [--force]
    uv run bin/optical-admin.py run-cron monday-resolve --subject <email> --env <env>
    uv run bin/optical-admin.py list-users --env <env>

`offboard` -> POST /admin/offboard {"subject": <email>} (hard delete; refuses
without --yes, before any HTTP). `rebind` -> POST /admin/identity-rebind
{"subject": <email>, "force"?: true} (clears the account's identity anchor so
its next sign-in may bind a different IdP identity; whoever signs in next as
that address gets the account. It also wipes the stored IdP refresh
credential, so the account is idle (no cron, webhook or booking calendar
access) until that next sign-in, and with UPSTREAM_REVOKE_ENABLED revokes the
grant at the IdP; resets the calendar sync state; and revokes the account's
Optical sessions, as offboard does: bearer and refresh tokens, unredeemed auth
codes and pending confirm links, so every connected client must re-authorise.
Only for envs with REFUSE_PROVIDER_REBIND on.
Refuses without --yes, before any HTTP. A
409 subject_drifted means the owner now signs in under another address
(login_email): confirm the person at the subject address IS the owner before
re-running with --force; "force" is sent only with --force). `run-cron` ->
POST /admin/run-cron?subject= (the route runs the Monday resolve for ONE named
subject). `list-users` is a read-only `wrangler d1 execute` SELECT on `users`
(no HTTP, no token); run it with CLOUDFLARE_API_TOKEN injected from outside.

list-users shows each user's `login_email` (identity_tokens, migration 0046):
the address they last signed in with, where owner mail goes. Membership stays
keyed on the subject, so a renamed user still passes on their original
address; this column is how an operator sees who signs in under which. Older
schemas without the column fall back to the users-only SELECT.

list-users adds `overdue_unwarned` to every row: true for an ACTIVE user idle
longer than RETENTION_DAYS whose retention warning was never stamped. The
sweep never deletes an unwarned user, so these are users whose warning mail
keeps failing (the worker's daily `retention_unwarnable {count}` log line
counts the same set). R comes from the env's block in worker/wrangler.toml,
the config that deploy ships, so it can't drift from what the sweep runs
with; `--retention-days N` overrides it (e.g. for a var changed out of band
in the dashboard). R unset/"0" means the sweep is off and nobody is overdue.

The bearer for the HTTP commands comes ONLY from the OPTICAL_ADMIN_TOKEN env
var, minted with the `admin` scope by an admin subject via bin/mint-token.py.
It is never written to disk or printed. Secret injection stays external
(launch under your own secret runner); this script never invokes one.

Hosts come from bin/_env_hosts.py, so `--env E` can only reach env E's
host. Every request sets a User-Agent (some hosts 403 urllib's default).
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
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Mapping, TextIO

_BIN = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("_env_hosts", _BIN / "_env_hosts.py")
assert _spec and _spec.loader, "could not load _env_hosts module"
_env_hosts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_env_hosts)

ENV_HOSTS: dict[str, str] = _env_hosts.ENV_HOSTS
WRANGLER_ENVS: dict[str, str | None] = _env_hosts.WRANGLER_ENVS

USER_AGENT = "optical-admin/1"
TOKEN_VAR = "OPTICAL_ADMIN_TOKEN"
# The crons POST /admin/run-cron can trigger: the route runs only the Monday
# resolve (worker/src/admin/run-cron-route.ts).
CRON_NAMES = ("monday-resolve",)

# Newest schema first; on "no such column" fall back one tier. Pre-0046 envs
# lack identity_tokens.login_email, pre-0043 envs also lack
# users.deactivated_at, pre-0041 envs also lack retention_warned_at.
USERS_SQL_TIERS = (
    "SELECT u.subject AS subject, u.role AS role, u.is_active AS is_active, "
    "u.last_seen AS last_seen, u.retention_warned_at AS retention_warned_at, "
    "u.deactivated_at AS deactivated_at, i.login_email AS login_email "
    "FROM users u LEFT JOIN identity_tokens i ON i.account_email = u.subject",
    "SELECT subject, role, is_active, last_seen, retention_warned_at, deactivated_at FROM users",
    "SELECT subject, role, is_active, last_seen, retention_warned_at FROM users",
    "SELECT subject, role, is_active, last_seen FROM users",
)
WRANGLER_TOML = _BIN.parent / "worker" / "wrangler.toml"

Http = Callable[[urllib.request.Request], "tuple[int, str]"]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="optical-admin", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    def add_env(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--env", required=True, choices=sorted(ENV_HOSTS))

    off = sub.add_parser("offboard", help="hard-delete a user (POST /admin/offboard)")
    off.add_argument("email")
    add_env(off)
    off.add_argument("--yes", action="store_true", help="confirm the irreversible delete")

    rb = sub.add_parser("rebind", help="clear a user's identity anchor (POST /admin/identity-rebind)",
                        description="Clear the account's identity anchor, wipe its stored IdP "
                                    "refresh credential (the account is idle until the next "
                                    "sign-in) and revoke its Optical sessions; connected "
                                    "clients must re-authorise.")
    rb.add_argument("email")
    add_env(rb)
    rb.add_argument("--yes", action="store_true",
                    help="confirm: the next sign-in as this address gets the account")
    rb.add_argument("--force", action="store_true",
                    help="rebind even though the owner now signs in under another address "
                         "(409 subject_drifted); confirm ownership first")

    cron = sub.add_parser("run-cron", help="run a cron for one subject (POST /admin/run-cron)")
    cron.add_argument("name", choices=CRON_NAMES)
    cron.add_argument("--subject", required=True)
    add_env(cron)

    lu = sub.add_parser("list-users", help="read-only SELECT on users via wrangler d1")
    add_env(lu)
    lu.add_argument("--retention-days", type=int, default=None, metavar="N",
                    help="RETENTION_DAYS for the overdue-unwarned flag "
                         "(default: the env's value in worker/wrangler.toml)")
    return p


def default_http(req: urllib.request.Request) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _request(url: str, token: str, body: dict | None) -> urllib.request.Request:
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("User-Agent", USER_AGENT)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    return req


def _send(http: Http, req: urllib.request.Request, stdout: TextIO, stderr: TextIO,
          hint: Callable[[int, str], str | None] | None = None) -> int:
    status, text = http(req)
    if 200 <= status < 300:
        print(text, file=stdout)
        return 0
    print(f"HTTP {status}: {text}", file=stderr)
    note = hint(status, text) if hint else None
    if note:
        print(note, file=stderr)
    return 1


def _rebind_hint(status: int, text: str) -> str | None:
    """409 subject_drifted: the owner now signs in under login_email, so the
    person refused at the subject address is probably a new holder."""
    if status != 409:
        return None
    try:
        body = json.loads(text)
    except ValueError:
        return None
    if not isinstance(body, dict) or body.get("error") != "subject_drifted":
        return None
    return (f"hint: this account's owner now signs in as {body.get('login_email')}, so whoever "
            "is refused at the subject address is probably a new holder of a reassigned "
            "address. Confirm the person signing in there IS the account owner before "
            "re-running with --force.")


def _wrangler_cmd(env: str, sql: str) -> list[str]:
    cmd = ["npx", "wrangler", "d1", "execute", "DB"]
    wenv = WRANGLER_ENVS[env]
    if wenv:
        cmd += ["--env", wenv]
    return cmd + ["--remote", "--json", "--command", sql]


def _positive_int(raw) -> int | None:
    """The worker's parseRetentionDays: a positive integer, else None (off)."""
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw if raw > 0 else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        n = int(raw.strip())
    except ValueError:
        return None
    return n if n > 0 else None


def retention_days_from_toml(path: Path, env: str) -> int | None:
    """RETENTION_DAYS as the env's worker sees it: top-level [vars] for prod
    (no --env), [env.<name>.vars] otherwise. Wrangler does not inherit vars
    into an env block, so a missing key there means unset."""
    data = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    wenv = WRANGLER_ENVS.get(env)
    block = data.get("vars", {}) if not wenv else data.get("env", {}).get(wenv, {}).get("vars", {})
    return _positive_int(block.get("RETENTION_DAYS"))


def _parse_ts(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def overdue_unwarned(row: dict, days: int | None, now: datetime) -> bool | None:
    """Active, idle strictly longer than R days, never stamped as warned.
    None when the schema predates retention_warned_at (can't tell)."""
    if "retention_warned_at" not in row:
        return None
    if days is None or int(row.get("is_active") or 0) != 1 or not row.get("last_seen"):
        return False
    if row.get("retention_warned_at") is not None:
        return False
    return _parse_ts(row["last_seen"]) < now - timedelta(days=days)


def _list_users(env: str, run, stdout: TextIO, stderr: TextIO, *,
                days: int | None, days_source: str, now: datetime) -> int:
    cwd = str(_BIN.parent / "worker")
    for i, sql in enumerate(USERS_SQL_TIERS):
        proc = run(_wrangler_cmd(env, sql), cwd=cwd, capture_output=True, text=True)
        if proc.returncode == 0:
            out = (proc.stdout or "").strip()
            start = out.find("[")
            parsed = json.loads(out[start:]) if start >= 0 else []
            rows = (parsed[0].get("results") if parsed else None) or []
            for row in rows:
                row["overdue_unwarned"] = overdue_unwarned(row, days, now)
            print(json.dumps(rows, indent=2), file=stdout)
            if days is None:
                print(f"retention sweep off (RETENTION_DAYS unset or 0, {days_source}): "
                      "overdue-unwarned not applicable", file=stderr)
            else:
                n = sum(1 for r in rows if r["overdue_unwarned"])
                print(f"overdue-unwarned: {n} (RETENTION_DAYS={days} from {days_source})",
                      file=stderr)
            return 0
        both = f"{proc.stdout or ''}\n{proc.stderr or ''}"
        if i + 1 < len(USERS_SQL_TIERS) and "no such column" in both:
            print(f"note: users column missing (older schema); retrying: {USERS_SQL_TIERS[i + 1]}",
                  file=stderr)
            continue
        print(f"wrangler d1 execute failed (exit {proc.returncode})\n{both.strip()}",
              file=stderr)
        return 1
    return 1  # unreachable


def main(
    argv: list[str] | None = None,
    *,
    http: Http = default_http,
    run=subprocess.run,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    now: datetime | None = None,
    wrangler_toml: Path = WRANGLER_TOML,
) -> int:
    args = build_parser().parse_args(argv)
    environ = os.environ if environ is None else environ
    host = ENV_HOSTS[args.env]
    hint = None

    if args.command == "list-users":
        print(f"list-users env={args.env} host={host}", file=stderr)
        if args.retention_days is not None:
            days, source = _positive_int(args.retention_days), "--retention-days"
        else:
            days = retention_days_from_toml(wrangler_toml, args.env)
            source = f"wrangler.toml env {args.env}"
        return _list_users(args.env, run, stdout, stderr, days=days, days_source=source,
                           now=now or datetime.now(timezone.utc))

    if args.command == "offboard":
        subject = args.email.strip()
        print(f"offboard subject={subject} env={args.env} host={host}", file=stderr)
        if not args.yes:
            print("refusing: offboard is an irreversible delete; re-run with --yes", file=stderr)
            return 2
        url, body = f"https://{host}/admin/offboard", {"subject": subject}
    elif args.command == "rebind":
        subject = args.email.strip()
        force = " force" if args.force else ""
        print(f"rebind subject={subject} env={args.env} host={host}{force}", file=stderr)
        if not args.yes:
            print("refusing: rebind hands the account to whoever signs in next as this "
                  "address; re-run with --yes", file=stderr)
            return 2
        url, body = f"https://{host}/admin/identity-rebind", {"subject": subject}
        if args.force:
            body["force"] = True
        hint = _rebind_hint
    else:  # run-cron
        subject = args.subject.strip()
        print(f"run-cron {args.name} subject={subject} env={args.env} host={host}", file=stderr)
        url = f"https://{host}/admin/run-cron?" + urllib.parse.urlencode({"subject": subject})
        body = None

    token = environ.get(TOKEN_VAR, "").strip()
    if not token:
        print(f"refusing: {TOKEN_VAR} is not set (mint an admin-scoped bearer)", file=stderr)
        return 2
    return _send(http, _request(url, token, body), stdout, stderr, hint)


if __name__ == "__main__":
    sys.exit(main())
