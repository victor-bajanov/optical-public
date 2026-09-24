# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
import sys, importlib.util, pathlib

spec = importlib.util.spec_from_file_location("bf", pathlib.Path(__file__).parent / "backfill-occurrence-date.py")
assert spec and spec.loader, "could not load backfill module"
bf = importlib.util.module_from_spec(spec); spec.loader.exec_module(bf)


def test_index_ddl_matches_typescript_constant():
    # Guard: keep INDEX_DDL byte-identical to OCCURRENCE_UNIQUE_INDEX_DDL in
    # worker/src/recurrence/occurrence-index.ts.
    expected = (
        "CREATE UNIQUE INDEX tasks_template_occurrence "
        "ON tasks(owner_subject, template_id, occurrence_date);"
    )
    assert bf.INDEX_DDL == expected
    # Catch drift on the TS side too. The TS constant builds the index name via a
    # ${...} template literal, so the fully-expanded string is not a verbatim
    # substring; assert the parts that ARE literal in the TS source instead: the
    # index name and the table/column clause.
    ts_path = pathlib.Path(__file__).parent.parent / "worker" / "src" / "recurrence" / "occurrence-index.ts"
    ts_src = ts_path.read_text()
    assert "CREATE UNIQUE INDEX" in ts_src, f"UNIQUE index DDL not found in {ts_path}"
    assert "tasks_template_occurrence" in ts_src, f"index name not found in {ts_path}"
    assert "ON tasks(owner_subject, template_id, occurrence_date);" in ts_src, (
        f"DDL table/column clause not found verbatim in {ts_path}"
    )


def test_local_date_sydney_pre_10am_is_next_day():
    # 09:30 Sydney on 2026-06-15 stored as 2026-06-14T23:30:00Z.
    assert bf.local_date("2026-06-14T23:30:00.000Z", "Australia/Sydney") == "2026-06-15"


def test_local_date_utc_identity():
    assert bf.local_date("2026-06-15T09:30:00.000Z", "UTC") == "2026-06-15"


def test_pick_survivor_prefers_non_pending_then_oldest():
    rows = [
        {"id": "a", "status": "pending", "created_at": "2026-01-01"},
        {"id": "b", "status": "committed", "created_at": "2026-02-01"},
        {"id": "c", "status": "committed", "created_at": "2026-01-15"},
    ]
    assert bf.pick_survivor(rows)["id"] == "c"  # non-pending, oldest


def test_plan_backfill_collapses_duplicates():
    body = {"pinned_at": "2026-06-14T23:30:00.000Z"}
    rows = [
        {"id": "x", "owner_subject": "o", "template_id": "t", "status": "pending", "created_at": "2026-01-02", "body": body},
        {"id": "y", "owner_subject": "o", "template_id": "t", "status": "pending", "created_at": "2026-01-01", "body": body},
    ]
    stamps, deletes = bf.plan_backfill(rows, {"o": "Australia/Sydney"}, "UTC")
    assert stamps == [("y", "2026-06-15")]  # oldest pending survives
    assert deletes == ["x"]


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
