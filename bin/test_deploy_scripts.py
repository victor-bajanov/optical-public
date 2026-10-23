# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/deploy.sh and bin/bootstrap-secrets.sh.

Both scripts are driven against stub `npx` / `wrangler` executables placed
first on PATH. The stubs record every argv (and, for `secret put`, the value
piped on stdin) to a log, so nothing here ever reaches the real wrangler or
Cloudflare.

The contract under test:
- no `--env` flag = exactly today's prod invocation, byte for byte;
- `--env <name>` threads `--env <name>` through every wrangler call, and the
  migration uses the binding form (`d1 migrations apply DB --env <name>`),
  since a non-prod D1 only exists under its `[env.<name>]` block;
- a non-prod bootstrap pushes only from env vars: it never generates, never
  prompts, and a missing var is a non-zero exit with no `secret put` at all.
"""
import json, os, pathlib, subprocess, sys

import pytest

BIN = pathlib.Path(__file__).resolve().parent
DEPLOY = BIN / "deploy.sh"
BOOTSTRAP = BIN / "bootstrap-secrets.sh"

TRIAL_SECRETS = (
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "MICROSOFT_OAUTH_CLIENT_SECRET",
    "SYSTEM_MAIL_API_KEY",
    "TOKEN_HASH_PEPPER",
    "HASHING_KEY",
    "ENCRYPTION_KEY",
    "HMAC_KEY",
)

# Each stub appends one JSON record per invocation: its name, argv, and (for
# `secret put`) whatever arrived on stdin. `secret list` prints STUB_SECRET_LIST
# in wrangler's pretty-printed JSON shape.
STUB = r"""#!/usr/bin/env bash
stdin=""
if [[ " $* " == *" secret put "* ]]; then stdin=$(cat); fi
if [[ " $* " == *" secret list"* && -n "${STUB_SECRET_LIST_FAIL:-}" ]]; then
  echo "stub: secret list failed" >&2
  STUB_NAME="$(basename "$0")" python3 -c '
import json, os, sys
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps({"bin": os.environ["STUB_NAME"], "argv": sys.argv[1:], "stdin": ""}) + "\n")
' "$@"
  exit 1
fi
if [[ " $* " == *" secret list"* ]]; then
  printf '[\n'
  for n in ${STUB_SECRET_LIST:-}; do printf '  {\n    "name": "%s",\n    "type": "secret_text"\n  },\n' "$n"; done
  printf ']\n'
fi
STUB_NAME="$(basename "$0")" STUB_STDIN="$stdin" python3 -c '
import json, os, sys
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps({"bin": os.environ["STUB_NAME"], "argv": sys.argv[1:], "stdin": os.environ["STUB_STDIN"]}) + "\n")
' "$@"
"""


@pytest.fixture
def stubs(tmp_path):
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    for name in ("npx", "wrangler"):
        p = stub_dir / name
        p.write_text(STUB)
        p.chmod(0o755)
    log = tmp_path / "calls.jsonl"
    log.touch()
    base = {
        k: v
        for k, v in os.environ.items()
        if k not in TRIAL_SECRETS and k not in ("WEBHOOK_CHANNEL_TOKEN", "WRANGLER_CONFIG")
    }
    base["PATH"] = f"{stub_dir}{os.pathsep}{os.environ['PATH']}"
    base["STUB_LOG"] = str(log)

    def run(script, *args, env=None):
        proc = subprocess.run(
            ["bash", str(script), *args],
            env={**base, **(env or {})},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
        )
        calls = [json.loads(line) for line in log.read_text().splitlines() if line]
        log.write_text("")
        return proc, calls

    return run


def argvs(calls):
    return [[c["bin"], *c["argv"]] for c in calls]


# ---- deploy.sh -------------------------------------------------------------


def test_deploy_without_env_is_todays_prod_invocation(stubs):
    proc, calls = stubs(DEPLOY)
    assert proc.returncode == 0, proc.stderr
    assert argvs(calls) == [
        ["npx", "wrangler", "d1", "migrations", "apply", "scheduler", "--remote"],
        ["npx", "wrangler", "deploy"],
    ]


def test_deploy_with_env_uses_binding_form_and_threads_env(stubs):
    proc, calls = stubs(DEPLOY, "--env", "trial")
    assert proc.returncode == 0, proc.stderr
    assert argvs(calls) == [
        ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--env", "trial", "--remote"],
        ["npx", "wrangler", "deploy", "--env", "trial"],
    ]


def test_deploy_accepts_env_equals_form(stubs):
    proc, calls = stubs(DEPLOY, "--env=dev")
    assert proc.returncode == 0, proc.stderr
    assert argvs(calls)[-1] == ["npx", "wrangler", "deploy", "--env", "dev"]


@pytest.mark.parametrize(
    "args", [("--env",), ("--env", ""), ("--env", "prod"), ("--bogus",), ("trial",)]
)
def test_deploy_rejects_bad_args_before_any_wrangler_call(stubs, args):
    # `--env prod` is refused: prod is the top-level config, so the only way
    # to target it is to omit the flag (wrangler has no [env.prod]).
    proc, calls = stubs(DEPLOY, *args)
    assert proc.returncode != 0
    assert calls == []


# ---- bootstrap-secrets.sh: prod (no flag) ----------------------------------


def test_bootstrap_without_env_is_todays_prod_behaviour(stubs):
    proc, calls = stubs(BOOTSTRAP, env={"GOOGLE_OAUTH_CLIENT_SECRET": "g-secret"})
    assert proc.returncode == 0, proc.stderr
    put_calls = [c for c in calls if "put" in c["argv"]]
    assert [c["argv"] for c in put_calls] == [
        ["--config", "worker/wrangler.toml", "secret", "put", name]
        for name in ("TOKEN_HASH_PEPPER", "WEBHOOK_CHANNEL_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET")
    ]
    assert all(c["bin"] == "wrangler" for c in calls)
    assert not any("--env" in c["argv"] for c in calls)
    # Generated values: 64 hex chars from `openssl rand -hex 32`.
    for c in put_calls[:2]:
        assert len(c["stdin"]) == 64 and all(ch in "0123456789abcdef" for ch in c["stdin"])
    assert put_calls[2]["stdin"] == "g-secret"


def test_bootstrap_without_env_skips_already_set_secrets(stubs):
    proc, calls = stubs(
        BOOTSTRAP,
        env={
            "GOOGLE_OAUTH_CLIENT_SECRET": "g-secret",
            "STUB_SECRET_LIST": "TOKEN_HASH_PEPPER WEBHOOK_CHANNEL_TOKEN",
        },
    )
    assert proc.returncode == 0, proc.stderr
    assert [c["argv"][-1] for c in calls if "put" in c["argv"]] == ["GOOGLE_OAUTH_CLIENT_SECRET"]


# ---- bootstrap-secrets.sh: non-prod (--env) --------------------------------


def trial_env():
    return {name: f"value-of-{name}" for name in TRIAL_SECRETS}


def test_bootstrap_trial_pushes_exactly_the_trial_set_from_env_vars(stubs):
    proc, calls = stubs(BOOTSTRAP, "--env", "trial", env=trial_env())
    assert proc.returncode == 0, proc.stderr
    assert calls, "expected wrangler calls"
    for c in calls:
        assert c["bin"] == "wrangler"
        i = c["argv"].index("--env")
        assert c["argv"][i + 1] == "trial"
    put_calls = [c for c in calls if "put" in c["argv"]]
    assert [c["argv"][c["argv"].index("put") + 1] for c in put_calls] == list(TRIAL_SECRETS)
    for c in put_calls:
        name = c["argv"][c["argv"].index("put") + 1]
        assert c["stdin"] == f"value-of-{name}"
    assert not any("WEBHOOK_CHANNEL_TOKEN" in c["argv"] for c in calls)


def test_bootstrap_trial_secret_values_never_reach_output(stubs):
    proc, _ = stubs(BOOTSTRAP, "--env", "trial", env=trial_env())
    assert proc.returncode == 0, proc.stderr
    assert "value-of-" not in proc.stdout + proc.stderr


def test_bootstrap_trial_skips_already_set_secrets(stubs):
    env = {**trial_env(), "STUB_SECRET_LIST": "HASHING_KEY HMAC_KEY"}
    proc, calls = stubs(BOOTSTRAP, "--env", "trial", env=env)
    assert proc.returncode == 0, proc.stderr
    pushed = [c["argv"][c["argv"].index("put") + 1] for c in calls if "put" in c["argv"]]
    assert pushed == [n for n in TRIAL_SECRETS if n not in ("HASHING_KEY", "HMAC_KEY")]


@pytest.mark.parametrize("missing", TRIAL_SECRETS)
def test_bootstrap_trial_missing_var_fails_with_no_secret_put(stubs, missing):
    env = trial_env()
    del env[missing]
    proc, calls = stubs(BOOTSTRAP, "--env", "trial", env=env)
    assert proc.returncode != 0
    assert missing in proc.stderr
    assert not any("put" in c["argv"] for c in calls)


def test_bootstrap_trial_empty_var_counts_as_missing(stubs):
    env = {**trial_env(), "HMAC_KEY": ""}
    proc, calls = stubs(BOOTSTRAP, "--env", "trial", env=env)
    assert proc.returncode != 0
    assert not any("put" in c["argv"] for c in calls)


def test_bootstrap_trial_missing_var_fails_even_if_secret_already_set(stubs):
    # The vault is the source of truth for a non-prod env; a missing var is a
    # broken `op run` env file, so fail loudly rather than half-bootstrap.
    env = {**trial_env(), "STUB_SECRET_LIST": "HMAC_KEY"}
    del env["HMAC_KEY"]
    proc, calls = stubs(BOOTSTRAP, "--env", "trial", env=env)
    assert proc.returncode != 0
    assert not any("put" in c["argv"] for c in calls)


def test_bootstrap_trial_failed_secret_list_fails_loudly_with_no_secret_put(stubs):
    # Auth/network failure, or the trial Worker not existing yet (bootstrap
    # before the first deploy): fail closed with a message, never silently.
    env = {**trial_env(), "STUB_SECRET_LIST_FAIL": "1"}
    proc, calls = stubs(BOOTSTRAP, "--env", "trial", env=env)
    assert proc.returncode != 0
    assert "secret list failed for env trial" in proc.stderr
    assert "bin/deploy.sh --env trial" in proc.stderr
    assert any("list" in c["argv"] for c in calls)
    assert not any("put" in c["argv"] for c in calls)


def test_bootstrap_env_without_a_defined_secret_set_is_refused(stubs):
    proc, calls = stubs(BOOTSTRAP, "--env", "staging", env=trial_env())
    assert proc.returncode != 0
    assert calls == []


@pytest.mark.parametrize("args", [("--env",), ("--env", "prod"), ("--bogus",)])
def test_bootstrap_rejects_bad_args_before_any_wrangler_call(stubs, args):
    proc, calls = stubs(BOOTSTRAP, *args, env=trial_env())
    assert proc.returncode != 0
    assert calls == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, *sys.argv[1:]]))
