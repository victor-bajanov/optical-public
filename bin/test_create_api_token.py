#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for infra/create-api-token.sh's token policies: the zone-scoped
policy covers the scheduler zone always, and the hosted-trial zone too when
CF_TRIAL_ZONE_ID is set (the trial worker's custom domain and its WAF
ruleset live on a second zone).

The script runs against a fake `curl` on PATH that serves a canned
permission-group list and records the token payload, so no request leaves
the machine.

Run: uv run bin/test_create_api_token.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "infra" / "create-api-token.sh"
TRIAL_ZONE = "0123456789abcdef0123456789abcdef"

FAKE_CURL = r"""#!/usr/bin/env bash
# Fake curl: answers the three Cloudflare endpoints create-api-token.sh calls.
url="" ; data="" ; method="GET"
while [ $# -gt 0 ]; do
  case "$1" in
    -d) data="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */user/tokens/permission_groups) cat "$FAKE_DIR/groups.json" ;;
  */user/tokens)
    if [ "$method" = "POST" ]; then
      printf '%s' "$data" > "$FAKE_DIR/payload.json"
      echo '{"success":true,"result":{"id":"tok","value":"v"}}'
    else
      echo '{"result":[]}'
    fi ;;
  *) echo "unexpected url $url" >&2; exit 1 ;;
esac
"""


def _wanted() -> list[tuple[str, str]]:
    text = SCRIPT.read_text()
    block = text[text.index("WANTED=(") : text.index("\n)\n", text.index("WANTED=("))]
    return re.findall(r'^\s*"(account|zone)\|([^"]+)"', block, re.M)


def _groups() -> dict:
    scope = {"account": "com.cloudflare.api.account", "zone": "com.cloudflare.api.account.zone"}
    return {
        "result": [
            {"id": f"pg{i:04d}", "name": name, "scopes": [scope[s]]}
            for i, (s, name) in enumerate(_wanted())
        ]
    }


def _invoke(tmp_path: Path, extra_env: dict[str, str]) -> subprocess.CompletedProcess:
    """Run the script with the fake curl first on PATH (never the real one)."""
    if not shutil.which("jq"):
        pytest.skip("jq not installed")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    curl = bindir / "curl"
    curl.write_text(FAKE_CURL)
    curl.chmod(0o755)
    (tmp_path / "groups.json").write_text(json.dumps(_groups()))
    env = {
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "FAKE_DIR": str(tmp_path),
        "CF_CREATE_TOKEN": "fake",
        **extra_env,
    }
    return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)


def _run(tmp_path: Path, extra_env: dict[str, str]) -> dict:
    proc = _invoke(tmp_path, extra_env)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads((tmp_path / "payload.json").read_text())


def _zone_resources(payload: dict) -> list[str]:
    zone_policies = [
        p for p in payload["policies"]
        if any(k.startswith("com.cloudflare.api.account.zone.") for k in p["resources"])
    ]
    assert len(zone_policies) == 1
    return sorted(zone_policies[0]["resources"])


def _main_zone_resource() -> str:
    m = re.search(r'^CF_ZONE_ID="([^"]+)"', SCRIPT.read_text(), re.M)
    assert m
    return f"com.cloudflare.api.account.zone.{m.group(1)}"


def test_zone_policy_without_trial_zone_covers_only_the_scheduler_zone(tmp_path):
    payload = _run(tmp_path, {})
    assert _zone_resources(payload) == [_main_zone_resource()]


def test_zone_policy_with_trial_zone_covers_both_zones(tmp_path):
    payload = _run(tmp_path, {"CF_TRIAL_ZONE_ID": TRIAL_ZONE})
    assert _zone_resources(payload) == sorted(
        [_main_zone_resource(), f"com.cloudflare.api.account.zone.{TRIAL_ZONE}"]
    )


def test_malformed_trial_zone_id_is_refused(tmp_path):
    proc = _invoke(tmp_path, {"CF_TRIAL_ZONE_ID": "example.com"})
    assert proc.returncode != 0
    assert "CF_TRIAL_ZONE_ID" in proc.stderr + proc.stdout
    assert not (tmp_path / "payload.json").exists()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, *sys.argv[1:]]))
