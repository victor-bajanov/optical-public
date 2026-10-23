"""Per-env worker hosts and wrangler env names: one pure table, no third-party
imports, for operator tooling (bin/optical-admin.py) to resolve `--env E`.

This is deliberately NOT the smoke registry: an env here that serves real
users is an operator target but never a smoke target (bin/_smoke_lib.py's
_SMOKE_HOSTS / assert_dev_url refuse any host not registered there).
bin/test_smoke_lib_guards.py asserts the hosts shared with _smoke_lib agree.

WRANGLER_ENVS maps each env to its `--env` for wrangler; prod is the
top-level config, so it has none.
"""
from __future__ import annotations

ENV_HOSTS: dict[str, str] = {
    "prod": "scheduler.example.com",
    "dev": "scheduler-dev.example.com",
}
WRANGLER_ENVS: dict[str, str | None] = {"prod": None, "dev": "dev"}
