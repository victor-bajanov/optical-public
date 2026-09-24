#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/mint-token.py's token_export_lines: the exact three-line
`export K=V` block every eval-consuming caller (mu-smoke-login.py,
smoke-runner.py, a bare shell `eval "$(...)"`) depends on — shape, order,
and no stray stdout lines.

Run: uv run bin/test_mint_token_exports.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "mint_token", Path(__file__).parent / "mint-token.py"
)
assert _spec and _spec.loader, "could not load mint-token module"
mint = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mint
_spec.loader.exec_module(mint)

ACCESS = "access-tok-abc"
REFRESH = "refresh-tok-xyz"
MINTED_AT = "2026-09-01T00:00:00+00:00"


def test_token_export_lines_returns_exactly_three_lines():
    lines = mint.token_export_lines(ACCESS, REFRESH, MINTED_AT)
    assert len(lines) == 3


def test_token_export_lines_bearer_line():
    lines = mint.token_export_lines(ACCESS, REFRESH, MINTED_AT)
    assert lines[0] == f"export SCHEDULER_BEARER={ACCESS}"


def test_token_export_lines_refresh_line():
    lines = mint.token_export_lines(ACCESS, REFRESH, MINTED_AT)
    assert lines[1] == f"export SCHEDULER_REFRESH_TOKEN={REFRESH}"


def test_token_export_lines_minted_at_line():
    lines = mint.token_export_lines(ACCESS, REFRESH, MINTED_AT)
    assert lines[2] == f"export SCHEDULER_MINTED_AT={MINTED_AT}"


def test_token_export_lines_order_is_bearer_then_refresh_then_minted_at():
    lines = mint.token_export_lines(ACCESS, REFRESH, MINTED_AT)
    prefixes = [line.split("=", 1)[0] for line in lines]
    assert prefixes == [
        "export SCHEDULER_BEARER",
        "export SCHEDULER_REFRESH_TOKEN",
        "export SCHEDULER_MINTED_AT",
    ]


def test_token_export_lines_every_line_is_an_export():
    for line in mint.token_export_lines(ACCESS, REFRESH, MINTED_AT):
        assert line.startswith("export "), line


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
