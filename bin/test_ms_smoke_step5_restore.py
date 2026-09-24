# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "rich>=13.7"]
# ///
"""Card H (internal design notes), H5.

Root cause of a 2026-08-21 L6/L7 regression-smoke failure on a Microsoft
identity: the ONLY
NULL-writer for users.done_color_id in this codebase was ms-smoke.py step 5's
`finally` (`set_done_color_id(d1, subject, None)`), which ran after every
step-5 attempt and unconditionally wiped whatever the login callback had just
seeded. The worker then silently fell back to env.DONE_COLOR_ID ("11", a
Google colorId meaningless for Outlook categories) until the next sign-in
re-seeded the column — done-marking stopped working for the account in the
meantime.

Fix: `_smoke_lib.get_done_color_id` reads the column's current value, and
step 5 now captures it BEFORE seeding "Optical Done" and restores exactly
that value (which may legitimately be NULL, e.g. a Google-provider subject on
dev) in its `finally`, instead of unconditionally nulling. These tests exercise
that restore logic directly, without any live scheduler/Graph calls.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest

BIN = pathlib.Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


lib = _load("ms_smoke_step5_restore_test_lib", "_smoke_lib.py")
ms_smoke = _load("ms_smoke_step5_restore_test", "ms-smoke.py")


class _FakeD1:
    """Stand-in for _smoke_lib.DevD1 that keeps a single users row in memory
    and records every SQL statement `execute`d against it, instead of
    shelling out to wrangler."""

    def __init__(self, initial_done_color_id: str | None):
        self.done_color_id: str | None = initial_done_color_id
        self.executed: list[str] = []

    def query(self, sql: str) -> list[dict]:
        self.executed.append(sql)
        return [{"done_color_id": self.done_color_id}]

    def execute(self, sql: str) -> None:
        self.executed.append(sql)
        if "SET done_color_id = NULL" in sql:
            self.done_color_id = None
        else:
            # UPDATE users SET done_color_id = 'value' WHERE ...
            start = sql.index("done_color_id = '") + len("done_color_id = '")
            end = sql.index("'", start)
            self.done_color_id = sql[start:end]


# =============================================================================
# get_done_color_id — reads the column via the existing DevD1 query path
# =============================================================================


def test_get_done_color_id_reads_a_set_value():
    d1 = _FakeD1(initial_done_color_id=lib.OPTICAL_DONE_CATEGORY)
    assert lib.get_done_color_id(d1, "user@example.com") == lib.OPTICAL_DONE_CATEGORY


def test_get_done_color_id_reads_null_as_none():
    d1 = _FakeD1(initial_done_color_id=None)
    assert lib.get_done_color_id(d1, "user@example.com") is None


# =============================================================================
# step 5's restore — captures the prior value and restores exactly that,
# even when the step body raises
# =============================================================================


def test_step5_restore_recovers_a_prior_set_value():
    d1 = _FakeD1(initial_done_color_id="some-prior-value")

    ms_smoke._step5_body_with_done_color_restore(
        d1, "user@example.com", lib.OPTICAL_DONE_CATEGORY, lambda: None,
    )

    assert d1.done_color_id == "some-prior-value"


def test_step5_restore_recovers_a_prior_null_value():
    # A Google-provider subject on dev legitimately has no done_color_id row
    # value at all; the restore must put it BACK to NULL, not leave it seeded.
    d1 = _FakeD1(initial_done_color_id=None)

    ms_smoke._step5_body_with_done_color_restore(
        d1, "user@example.com", lib.OPTICAL_DONE_CATEGORY, lambda: None,
    )

    assert d1.done_color_id is None


def test_step5_restore_seeds_the_category_for_the_duration_of_the_body():
    d1 = _FakeD1(initial_done_color_id=None)
    seen_during_body: list[str | None] = []

    def body():
        seen_during_body.append(d1.done_color_id)

    ms_smoke._step5_body_with_done_color_restore(
        d1, "user@example.com", lib.OPTICAL_DONE_CATEGORY, body,
    )

    assert seen_during_body == [lib.OPTICAL_DONE_CATEGORY]
    assert d1.done_color_id is None


def test_step5_restore_runs_even_when_the_body_raises():
    d1 = _FakeD1(initial_done_color_id="prior-value")

    def body():
        raise AssertionError("step5 body failed")

    with pytest.raises(AssertionError, match="step5 body failed"):
        ms_smoke._step5_body_with_done_color_restore(
            d1, "user@example.com", lib.OPTICAL_DONE_CATEGORY, body,
        )

    assert d1.done_color_id == "prior-value"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
