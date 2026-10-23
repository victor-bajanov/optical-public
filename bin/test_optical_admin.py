#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guards for bin/optical-admin.py (the operator CLI, hosted-trial card O13)
and bin/_env_hosts.py (the per-env host table it targets).

Every HTTP call and every subprocess is mocked: nothing here reaches a real
worker or runs wrangler.

Run: uv run bin/test_optical_admin.py
"""
from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

BIN = Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader, f"could not load {filename}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


hosts = _load("env_hosts_admin_test", "_env_hosts.py")
admin = _load("optical_admin", "optical-admin.py")

EXPECTED_HOSTS = {
    "prod": "scheduler.example.com",
    "dev": "scheduler-dev.example.com",
}
EXPECTED_WRANGLER_ENVS = {"prod": None, "dev": "dev"}

TOKEN = "tok-abc123"


# =============================================================================
# Fakes
# =============================================================================

class FakeHttp:
    """Records every request; returns a canned (status, body)."""

    def __init__(self, status: int = 200, body: dict | None = None):
        self.calls: list = []
        self.status = status
        self.body = body if body is not None else {"ok": True}

    def __call__(self, req):
        self.calls.append(req)
        return self.status, json.dumps(self.body)


class FakeRun:
    """Stands in for subprocess.run; replays scripted CompletedProcess results."""

    def __init__(self, results: list[subprocess.CompletedProcess]):
        self.results = list(results)
        self.calls: list[dict] = []

    def __call__(self, cmd, **kwargs):
        self.calls.append({"cmd": cmd, **kwargs})
        return self.results.pop(0)


def _ok(rows: list[dict]) -> subprocess.CompletedProcess:
    out = json.dumps([{"results": rows, "success": True}])
    return subprocess.CompletedProcess([], 0, stdout=out, stderr="")


def _run_main(argv, *, http=None, run=None, environ=None):
    out, err = io.StringIO(), io.StringIO()
    env = {"OPTICAL_ADMIN_TOKEN": TOKEN} if environ is None else environ
    code = admin.main(
        argv, http=http or FakeHttp(), run=run or FakeRun([]),
        environ=env, stdout=out, stderr=err,
    )
    return code, out.getvalue(), err.getvalue()


# =============================================================================
# _env_hosts.py — the per-env table
# =============================================================================

def test_env_hosts_table():
    assert hosts.ENV_HOSTS == EXPECTED_HOSTS
    assert hosts.WRANGLER_ENVS == EXPECTED_WRANGLER_ENVS


def test_env_hosts_is_pure():
    # A pure table: no third-party imports (mint-token-style scripts load it).
    src = (BIN / "_env_hosts.py").read_text()
    assert "import httpx" not in src and "import requests" not in src


def test_every_env_has_a_wrangler_env_entry():
    assert set(hosts.ENV_HOSTS) == set(hosts.WRANGLER_ENVS)


# =============================================================================
# Argument parsing
# =============================================================================

def test_parse_offboard():
    ns = admin.build_parser().parse_args(["offboard", "a@x.example", "--env", "dev", "--yes"])
    assert (ns.command, ns.email, ns.env, ns.yes) == ("offboard", "a@x.example", "dev", True)


def test_parse_offboard_yes_defaults_false():
    ns = admin.build_parser().parse_args(["offboard", "a@x.example", "--env", "dev"])
    assert ns.yes is False


def test_parse_run_cron():
    ns = admin.build_parser().parse_args(
        ["run-cron", "monday-resolve", "--subject", "a@x.example", "--env", "dev"])
    assert (ns.command, ns.name, ns.subject, ns.env) == (
        "run-cron", "monday-resolve", "a@x.example", "dev")


def test_parse_run_cron_rejects_unknown_cron_name():
    with pytest.raises(SystemExit):
        admin.build_parser().parse_args(
            ["run-cron", "nightly", "--subject", "a@x.example", "--env", "dev"])


def test_parse_run_cron_requires_subject():
    with pytest.raises(SystemExit):
        admin.build_parser().parse_args(["run-cron", "monday-resolve", "--env", "dev"])


def test_parse_list_users():
    ns = admin.build_parser().parse_args(["list-users", "--env", "prod"])
    assert (ns.command, ns.env) == ("list-users", "prod")


def test_env_is_required():
    with pytest.raises(SystemExit):
        admin.build_parser().parse_args(["list-users"])


def test_unknown_env_is_rejected():
    with pytest.raises(SystemExit):
        admin.build_parser().parse_args(["list-users", "--env", "staging"])


def test_env_choices_are_the_table():
    for env in EXPECTED_HOSTS:
        admin.build_parser().parse_args(["list-users", "--env", env])


# =============================================================================
# offboard
# =============================================================================

def test_offboard_without_yes_refuses_before_any_http():
    http = FakeHttp()
    code, _, err = _run_main(["offboard", "a@x.example", "--env", "dev"], http=http)
    assert code != 0
    assert http.calls == []
    assert "--yes" in err


def test_offboard_without_yes_still_echoes_subject_env_and_host():
    code, _, err = _run_main(["offboard", "a@x.example", "--env", "dev"])
    assert "a@x.example" in err
    assert "env=dev" in err
    assert EXPECTED_HOSTS["dev"] in err


@pytest.mark.parametrize("env", sorted(EXPECTED_HOSTS))
def test_offboard_posts_to_the_env_host_with_subject_body(env):
    http = FakeHttp(body={"ok": True, "subject": "a@x.example"})
    code, out, err = _run_main(["offboard", "a@x.example", "--env", env, "--yes"], http=http)
    assert code == 0
    assert len(http.calls) == 1
    req = http.calls[0]
    assert req.get_method() == "POST"
    assert req.full_url == f"https://{EXPECTED_HOSTS[env]}/admin/offboard"
    assert json.loads(req.data) == {"subject": "a@x.example"}
    assert req.get_header("Content-type") == "application/json"
    assert f"env={env}" in err and EXPECTED_HOSTS[env] in err and "a@x.example" in err


def test_offboard_request_carries_bearer_and_user_agent():
    http = FakeHttp()
    _run_main(["offboard", "a@x.example", "--env", "dev", "--yes"], http=http)
    req = http.calls[0]
    assert req.get_header("Authorization") == f"Bearer {TOKEN}"
    ua = req.get_header("User-agent")
    assert ua and ua.startswith("optical-admin/")


def test_offboard_trims_the_email():
    http = FakeHttp()
    _run_main(["offboard", "  a@x.example ", "--env", "dev", "--yes"], http=http)
    assert json.loads(http.calls[0].data) == {"subject": "a@x.example"}


def test_missing_token_refuses_before_any_http():
    http = FakeHttp()
    code, _, err = _run_main(["offboard", "a@x.example", "--env", "dev", "--yes"],
                             http=http, environ={})
    assert code != 0
    assert http.calls == []
    assert "OPTICAL_ADMIN_TOKEN" in err


def test_offboard_non_2xx_exits_nonzero_and_shows_body():
    http = FakeHttp(status=403, body={"error": "insufficient_scope"})
    code, _, err = _run_main(["offboard", "a@x.example", "--env", "dev", "--yes"], http=http)
    assert code != 0
    assert "403" in err and "insufficient_scope" in err


def test_offboard_token_never_printed():
    http = FakeHttp(status=401, body={"error": "invalid_token"})
    _, out, err = _run_main(["offboard", "a@x.example", "--env", "dev", "--yes"], http=http)
    assert TOKEN not in out and TOKEN not in err


# =============================================================================
# run-cron
# =============================================================================

def test_run_cron_posts_subject_as_query_param():
    http = FakeHttp(body={"kind": "ok"})
    code, out, err = _run_main(
        ["run-cron", "monday-resolve", "--subject", "a+b@x.example", "--env", "dev"], http=http)
    assert code == 0
    req = http.calls[0]
    assert req.get_method() == "POST"
    assert req.full_url == (
        f"https://{EXPECTED_HOSTS['dev']}/admin/run-cron?subject=a%2Bb%40x.example")
    assert req.get_header("Authorization") == f"Bearer {TOKEN}"
    assert req.get_header("User-agent").startswith("optical-admin/")
    assert "env=dev" in err and EXPECTED_HOSTS["dev"] in err
    assert json.loads(out) == {"kind": "ok"}


def test_run_cron_500_exits_nonzero():
    http = FakeHttp(status=500, body={"kind": "solver_error"})
    code, _, err = _run_main(
        ["run-cron", "monday-resolve", "--subject", "a@x.example", "--env", "dev"], http=http)
    assert code != 0
    assert "solver_error" in err


# =============================================================================
# The default HTTP transport
# =============================================================================

def test_default_http_returns_status_and_body_for_http_errors(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {},
                                     io.BytesIO(b'{"error":"nope"}'))
    monkeypatch.setattr(admin.urllib.request, "urlopen", fake_urlopen)
    req = admin.urllib.request.Request("https://h.example/x", method="POST")
    assert admin.default_http(req) == (403, '{"error":"nope"}')


# =============================================================================
# list-users
# =============================================================================

ROWS = [{"subject": "a@x.example", "role": "admin", "is_active": 1,
         "last_seen": "2026-10-01", "retention_warned_at": None}]


def test_list_users_dev_command_shape():
    run = FakeRun([_ok(ROWS)])
    code, out, _ = _run_main(["list-users", "--env", "dev"], run=run, environ={})
    assert code == 0
    call = run.calls[0]
    assert call["cmd"] == [
        "npx", "wrangler", "d1", "execute", "DB", "--env", "dev", "--remote", "--json",
        "--command",
        "SELECT subject, role, is_active, last_seen, retention_warned_at, deactivated_at FROM users",
    ]
    assert Path(call["cwd"]) == BIN.parent / "worker"
    assert "a@x.example" in out


def test_list_users_prod_has_no_env_flag():
    run = FakeRun([_ok(ROWS)])
    _run_main(["list-users", "--env", "prod"], run=run, environ={})
    assert "--env" not in run.calls[0]["cmd"]


def test_list_users_query_is_read_only_select():
    run = FakeRun([_ok(ROWS)])
    _run_main(["list-users", "--env", "dev"], run=run, environ={})
    sql = run.calls[0]["cmd"][-1]
    assert sql.startswith("SELECT ") and ";" not in sql


def test_list_users_falls_back_without_retention_column():
    # A pre-0041 env also lacks 0043's deactivated_at: two misses, then legacy.
    missing = subprocess.CompletedProcess(
        [], 1, stdout='{"error":{"text":"no such column: retention_warned_at"}}', stderr="")
    rows = [{k: v for k, v in ROWS[0].items() if k != "retention_warned_at"}]
    run = FakeRun([missing, missing, _ok(rows)])
    code, out, _ = _run_main(["list-users", "--env", "dev"], run=run, environ={})
    assert code == 0
    assert len(run.calls) == 3
    assert run.calls[2]["cmd"][-1] == "SELECT subject, role, is_active, last_seen FROM users"
    assert "a@x.example" in out


def test_list_users_other_wrangler_failure_exits_nonzero_without_retry():
    bad = subprocess.CompletedProcess([], 1, stdout="", stderr="Authentication error")
    run = FakeRun([bad])
    code, _, err = _run_main(["list-users", "--env", "dev"], run=run, environ={})
    assert code != 0
    assert len(run.calls) == 1
    assert "Authentication error" in err


def test_list_users_makes_no_http_call():
    http = FakeHttp()
    _run_main(["list-users", "--env", "dev"], http=http, run=FakeRun([_ok(ROWS)]), environ={})
    assert http.calls == []


# =============================================================================
# list-users: overdue-unwarned (decision E)
#
# The sweep never deletes a user whose retention warning could not be sent,
# so a user whose mail keeps failing sits idle forever. list-users flags them:
# active, last_seen older than RETENTION_DAYS, retention_warned_at NULL.
# =============================================================================

NOW = admin.datetime(2026, 10, 9, tzinfo=admin.timezone.utc)

TOML = """
[vars]
RETENTION_DAYS = ""

[env.dev.vars]
RETENTION_DAYS = "90"
"""


def _toml(tmp_path, text: str = TOML) -> Path:
    p = tmp_path / "wrangler.toml"
    p.write_text(text)
    return p


def _row(subject, *, active=1, last_seen=None, warned=None, deactivated=None):
    return {"subject": subject, "role": "member", "is_active": active, "last_seen": last_seen,
            "retention_warned_at": warned, "deactivated_at": deactivated}


def _list(argv, rows, tmp_path, toml_text: str = TOML):
    out, err = io.StringIO(), io.StringIO()
    code = admin.main(argv, http=FakeHttp(), run=FakeRun([_ok(rows)]), environ={},
                      stdout=out, stderr=err, now=NOW, wrangler_toml=_toml(tmp_path, toml_text))
    return code, out.getvalue(), err.getvalue()


def _flags(out: str) -> dict:
    return {r["subject"]: r["overdue_unwarned"] for r in json.loads(out)}


def test_parse_list_users_retention_days_override():
    ns = admin.build_parser().parse_args(["list-users", "--env", "dev", "--retention-days", "30"])
    assert ns.retention_days == 30
    ns = admin.build_parser().parse_args(["list-users", "--env", "dev"])
    assert ns.retention_days is None


def test_retention_days_reads_the_env_block_of_wrangler_toml(tmp_path):
    p = _toml(tmp_path)
    assert admin.retention_days_from_toml(p, "dev") == 90
    # Worker semantics (sweep-inactive.ts parseRetentionDays): only a positive
    # integer turns the sweep on; "", "0", absent are off.
    assert admin.retention_days_from_toml(p, "prod") is None
    (tmp_path / "zero").mkdir()
    zero = _toml(tmp_path / "zero", '[env.dev.vars]\nRETENTION_DAYS = "0"\n')
    assert admin.retention_days_from_toml(zero, "dev") is None
    assert admin.retention_days_from_toml(p, "dev") == 90  # p is still its own file
    assert admin.retention_days_from_toml(p, "ms") is None  # no block at all




def test_list_users_marks_overdue_unwarned_from_wrangler_toml(tmp_path):
    rows = [
        _row("overdue@x.example", last_seen="2026-07-01T00:00:00.000Z"),  # 100 d idle, unwarned
        _row("warned@x.example", last_seen="2026-07-01T00:00:00.000Z",
             warned="2026-09-30T00:00:00.000Z"),
        _row("fresh@x.example", last_seen="2026-09-01T00:00:00.000Z"),  # 38 d idle
        _row("never@x.example", last_seen=None),  # unknown activity is never stale
        _row("gone@x.example", active=0, last_seen="2026-01-01T00:00:00.000Z",
             deactivated="2026-02-01T00:00:00.000Z"),
    ]
    code, out, err = _list(["list-users", "--env", "dev"], rows, tmp_path)
    assert code == 0
    assert _flags(out) == {
        "overdue@x.example": True, "warned@x.example": False, "fresh@x.example": False,
        "never@x.example": False, "gone@x.example": False,
    }
    assert "overdue-unwarned: 1" in err
    assert "RETENTION_DAYS=90" in err and "wrangler.toml" in err


def test_list_users_overdue_boundary_is_strictly_older_than_r_days(tmp_path):
    rows = [_row("edge@x.example", last_seen="2026-07-11T00:00:00.000Z"),  # exactly 90 d
            _row("past@x.example", last_seen="2026-07-10T23:59:59.000Z")]
    _, out, _ = _list(["list-users", "--env", "dev"], rows, tmp_path)
    assert _flags(out) == {"edge@x.example": False, "past@x.example": True}


def test_list_users_retention_days_flag_overrides_the_toml(tmp_path):
    rows = [_row("a@x.example", last_seen="2026-09-01T00:00:00.000Z")]  # 38 d idle
    _, out, err = _list(["list-users", "--env", "dev", "--retention-days", "30"], rows, tmp_path)
    assert _flags(out) == {"a@x.example": True}
    assert "RETENTION_DAYS=30" in err and "--retention-days" in err


def test_list_users_sweep_off_flags_nothing(tmp_path):
    # prod: RETENTION_DAYS "" -> the sweep never runs, so nobody is overdue.
    rows = [_row("a@x.example", last_seen="2020-01-01T00:00:00.000Z")]
    code, out, err = _list(["list-users", "--env", "prod"], rows, tmp_path)
    assert code == 0
    assert _flags(out) == {"a@x.example": False}
    assert "retention sweep off" in err


def test_list_users_pre_0041_cannot_tell_so_reports_null(tmp_path):
    rows = [{"subject": "a@x.example", "role": "member", "is_active": 1,
             "last_seen": "2020-01-01T00:00:00.000Z"}]
    _, out, _ = _list(["list-users", "--env", "dev"], rows, tmp_path)
    assert _flags(out) == {"a@x.example": None}


def test_list_users_selects_deactivated_at():
    run = FakeRun([_ok(ROWS)])
    _run_main(["list-users", "--env", "dev"], run=run, environ={})
    assert "deactivated_at" in run.calls[0]["cmd"][-1]


def test_list_users_falls_back_without_deactivated_at_column():
    missing = subprocess.CompletedProcess(
        [], 1, stdout='{"error":{"text":"no such column: deactivated_at"}}', stderr="")
    run = FakeRun([missing, _ok(ROWS)])
    code, out, _ = _run_main(["list-users", "--env", "dev"], run=run, environ={})
    assert code == 0
    assert run.calls[1]["cmd"][-1] == (
        "SELECT subject, role, is_active, last_seen, retention_warned_at FROM users")
    assert "a@x.example" in out


# =============================================================================
# Posture
# =============================================================================

def test_script_never_calls_op_and_writes_nothing_to_disk():
    src = (BIN / "optical-admin.py").read_text()
    assert '"op"' not in src and "'op'" not in src and "op run" not in src.split('"""', 2)[-1]
    assert "open(" not in src.replace("urlopen(", "")
    assert "write_text" not in src and "write_bytes" not in src


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
