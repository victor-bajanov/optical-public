# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/register-pkce-client.sh.

The script runs against a stub `npx` placed first on PATH that logs its argv,
so nothing here reaches the real wrangler or Cloudflare.

The contract under test (inventory §4, card O9.7):
- on `--env trial`, a client whose scopes include `calendar:raw-token` is
  refused with a non-zero exit before any wrangler call, since the scope isn't
  role-gated and every member signing in through that client would get raw
  IdP tokens;
- every other env (and trial without raw-token) is unchanged.
"""
import json, os, pathlib, subprocess, sys

import pytest

BIN = pathlib.Path(__file__).resolve().parent
SCRIPT = BIN / "register-pkce-client.sh"

STUB = r"""#!/usr/bin/env bash
python3 -c '
import json, os, sys
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
' "$@"
"""


@pytest.fixture
def run(tmp_path):
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    for name in ("npx", "wrangler"):
        p = stub_dir / name
        p.write_text(STUB)
        p.chmod(0o755)
    log = tmp_path / "calls.jsonl"
    log.touch()
    env = {**os.environ, "PATH": f"{stub_dir}:{os.environ['PATH']}", "STUB_LOG": str(log)}

    def _run(*args):
        r = subprocess.run(
            ["bash", str(SCRIPT), "c1", "https://example.test/cb", *args],
            env=env, capture_output=True, text=True,
        )
        calls = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
        return r, calls

    return _run


@pytest.mark.parametrize("env_args", [["--env", "trial"], ["--env=trial"]])
@pytest.mark.parametrize(
    "scopes",
    [
        "calendar:raw-token",
        "scheduler:read scheduler:write calendar:raw-token",
        "scheduler:read calendar:raw-token admin",
    ],
)
def test_trial_refuses_raw_token_before_any_wrangler_call(run, env_args, scopes):
    r, calls = run(*env_args, "--scopes", scopes)
    assert r.returncode != 0
    assert calls == []
    assert "calendar:raw-token" in r.stderr
    assert "trial" in r.stderr


def test_trial_refusal_holds_with_equals_scopes_form(run):
    r, calls = run("--env", "trial", "--scopes=scheduler:read calendar:raw-token")
    assert r.returncode != 0
    assert calls == []


def test_trial_default_scopes_registers(run):
    r, calls = run("--env", "trial")
    assert r.returncode == 0, r.stderr
    assert len(calls) == 1
    argv = calls[0]
    assert argv[:4] == ["wrangler", "d1", "execute", "scheduler-trial"]
    assert "'scheduler:read scheduler:write'" in argv[-1]


def test_trial_cli_client_scopes_register(run):
    r, calls = run("--env", "trial", "--scopes", "scheduler:read scheduler:write admin")
    assert r.returncode == 0, r.stderr
    assert len(calls) == 1
    assert "'scheduler:read scheduler:write admin'" in calls[0][-1]


def test_trial_lookalike_scope_is_not_refused(run):
    # Whole-token match: a different scope that merely contains the substring
    # isn't the raw-token scope.
    r, calls = run("--env", "trial", "--scopes", "scheduler:read calendar:raw-token-x")
    assert r.returncode == 0, r.stderr
    assert len(calls) == 1


OTHER_ENVS = [[], ["--env", "dev"], ["--local"]]


@pytest.mark.parametrize("env_args", OTHER_ENVS)
def test_other_envs_still_allow_raw_token(run, env_args):
    r, calls = run(*env_args, "--scopes", "scheduler:read calendar:raw-token")
    assert r.returncode == 0, r.stderr
    assert len(calls) == 1
    assert "calendar:raw-token" in calls[0][-1]


MALFORMED_SCOPES = [
    "scheduler:read '||'calendar:raw-token",  # quote: splices into the SQL literal
    "scheduler:read; DROP TABLE oauth_clients",
    "scheduler:read\ncalendar:raw-token",
    "scheduler:read\tcalendar:raw-token",
    "scheduler:read  scheduler:write",  # double space
    " scheduler:read",
    "",
]


@pytest.mark.parametrize("env_args", [["--env", "trial"], [], ["--env", "dev"], ["--local"]])
@pytest.mark.parametrize("scopes", MALFORMED_SCOPES)
def test_malformed_scopes_refused_on_every_env_before_any_wrangler_call(run, env_args, scopes):
    r, calls = run(*env_args, "--scopes", scopes)
    assert r.returncode != 0
    assert calls == []
    assert "--scopes" in r.stderr


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, *sys.argv[1:]]))
