# smoke_runner result-parsing fixtures

Combined-stream (stdout+stderr merged, as the runner's
`subprocess.run(..., stderr=subprocess.STDOUT)` tee produces) excerpts, one
per grammar family x outcome, built from the exact format strings verified
against harness source during the WP1 audit (see
internal design notes). Each file's expected exit code
is noted below (WP1's tests pass `exit_code` alongside the fixture text —
the fixture itself carries no exit code).

Every fixture except the two `regression_*.txt` files is still hand-typed
text (real format strings, real print-call ordering, but not captured from a
live process). The two `regression_*.txt` files are the one exception: they
were regenerated for MINOR-1 (see below) by actually invoking
`regression-smoke.py`'s own `render_summary()` through `rich`, so their
box-drawing is byte-real, not hand-copied ASCII art.

These are **not** captures of a real live run. `classify_run`'s exit-code
cross-check is deliberately the guard for that gap until then — re-validate
this set against a real captured log during the first live campaign
against the smoke envs, and update any fixture whose real output has
drifted from what's hand-copied here.

## MINOR-1 — COLUMNS=200 and the regenerated regression fixtures

`compose_env` now sets `COLUMNS=200` in every composed child environment.
Without it, `rich`'s `Console` falls back to 80 columns when piped (no tty,
no `COLUMNS` env var) — confirmed by actually rendering
`regression-smoke.py`'s `render_summary()` at both widths: at 80, the
`owned-meetings` row's label truncates to `Lowned-meeti…` (an ellipsis,
U+2026, which isn't in `_REGRESSION_ROW_RE`'s label character class), so the
row silently fails to parse; long `Notes` cells also word-wrap onto
continuation rows. At `COLUMNS=200` neither happens — confirmed against the
real `render_summary()` output, not assumed. `regression_pass.txt` and
`regression_fail.txt` below are that width-200 output verbatim (plus the
`active account: ...` line `main()` prints before the table), captured via a
scratch script that loads `regression-smoke.py` with the repo's own
`importlib.util.spec_from_file_location` pattern, builds `LevelResult`
rows, and renders them through `rich.console.Console(file=StringIO(),
width=200, no_color=True)`. Re-run that same approach if `render_summary`'s
column set or spacing ever changes, rather than hand-editing these two
files.

| file | family | harness | exit | notes |
|---|---|---|---|---|
| `dash_booking_base_pass.txt` | dash | booking-smoke (base) | 0 | B3/B6, `ALL PASS` |
| `dash_booking_decline_pass.txt` | dash | booking-smoke (decline) | 0 | full source order: D1/D3-D10b, `DECLINE PASS` (a mid-run checkpoint printed after D10b, NOT the run's actual terminal), then the abort-path A1/A2/`A3/A4 SKIPPED`, then the real terminal `ALL PASS` |
| `dash_config_pass_with_unsat_note.txt` | dash | config-smoke | 0 | `C7 PASS (note: unsat)` variant, a `C7 NOTE` line that must NOT parse as a level |
| `dash_config_suspect_no_terminal.txt` | dash | config-smoke | 0 (synthetic) | every level PASS but no `ALL PASS` line — exercises the missing-terminal-marker SUSPECT rule |
| `dash_feed_fail.txt` | dash | feed-smoke | 1 | `F2 FAIL`: `sys.exit(f"F2 FAIL ...\n{ics_regex[:2000]}")` raises SystemExit, whose message (with the embedded ICS snippet) is printed by the interpreter's default handler only AFTER the `finally` block's own cleanup has run — but that cleanup prints nothing in the common case (`cal.delete_event`/the feed-endpoint DELETEs succeed silently), so the real merged stream is just F1 PASS, then F2 FAIL + its embedded ICS snippet, with no terminal marker |
| `dash_poll_pass.txt` | dash | poll-smoke | 0 | P1-P7 + a hyphenated label (`NUDGE-send`), `=== SUMMARY ===` block (two-space `PASS  label  notes` lines must NOT parse as levels), `ALL PASS` |
| `dash_poll_fail.txt` | dash | poll-smoke | 1 | one `FAIL` step, SUMMARY block, `N step(s) FAILED` terminal |
| `dash_poll_all_skipped.txt` | dash | poll-smoke | 2 | zero steps ever ran, `nothing genuinely exercised` |
| `dash_suspect_fail_line_exit0.txt` | dash | booking-smoke | 0 (synthetic) | a `FAIL` level line present despite an exit-0 param in the test — exercises the exit-0-but-FAIL-present SUSPECT rule (real harnesses never emit this combination; the mismatch is engineered by the test) |
| `colon_multiuser_pass.txt` | colon | multiuser-smoke | 0 | all 8 levels in the harness's own run order `1,2,3,4,5,6,8,7` (M7 destructive, last), `TOTAL 8/8` |
| `colon_multiuser_fail.txt` | colon | multiuser-smoke | 1 | one `FAIL`, `TOTAL 2/3` |
| `colon_meeting_pass_with_skip.txt` | colon | meeting-smoke (2-account) | 0 | mix of genuine PASS and SKIP-via-notes (`tag==PASS`, `notes` starts `SKIP:`), the harness's own stdout `{label} SKIP: ...` line alongside the stderr status line (the former must NOT parse as a level — no colon after the label), `TOTAL pass=4 skipped=2 of 6` |
| `colon_meeting_all_skipped.txt` | colon | meeting-smoke (2-account) | 2 | every level skipped, `TOTAL pass=0 skipped=6 of 6`, `ALL SCENARIOS SKIPPED` banner. Reused with `exit_code=0` in a separate test to exercise the pass012-all-SKIP-but-exit-0 SUSPECT rule. |
| `colon_ms_pass.txt` | colon | ms-smoke | 0 | levels 1-6, `TOTAL pass=6 skipped=0 of 6` |
| `colon_ms_fail.txt` | colon | ms-smoke | 1 | level 3 FAIL gates level 4 into a SKIP (`stop=True` in `run_live`), `TOTAL pass=2 skipped=1 of 4` |
| `regression_pass.txt` | regression | regression-smoke | 0 | byte-real rich `Table` render at `COLUMNS=200` (see MINOR-1 above), `L1`..`L8` including the `L5.1`/`L5.2` labels, `TOTAL 9/9  wall=55.6s` |
| `regression_fail.txt` | regression | regression-smoke | 1 | byte-real render: an `L6 FAIL` row plus the `owned-meetings` scenario rendering as `Lowned-meetings` (no space between the `L` prefix and the label — the known quirk, and NOT truncated at width 200, unlike at the piped default of 80), `TOTAL 1/2  wall=11.0s` |
| `none_reset_pass.txt` | none | reset-smoke-env | 0 | plain prints, no level-line grammar at all — outcome comes from exit code alone |
| `none_reset_fail.txt` | none | reset-smoke-env | 1 | the harness's own `missing required env var(s): ...` message |

## Grammar notes carried in these fixtures

- **dash** (`^label PASS|FAIL|SKIP|SKIPPED` optionally followed by
  `(parenthetical)` then ` — notes`): requires exactly ONE space between the
  label and the tag, which is what naturally excludes poll-smoke's
  `=== SUMMARY ===` block (`PASS  label  notes`, two spaces) without a
  special-case rule — a second space where the tag should start can never
  match `PASS|FAIL|SKIP|SKIPPED`. `ALL PASS` / `DECLINE PASS` /
  `N step(s) FAILED` / `nothing genuinely exercised` are excluded by exact
  string, not by the grammar, since `ALL PASS` and `DECLINE PASS` otherwise
  parse as valid (label=`ALL`|`DECLINE`, tag=`PASS`) level lines.
- **colon** (`^\s*LABEL: PASS|FAIL  (N.Ns)  notes`): the meeting-smoke
  harness ALSO prints a bare stdout `{label} SKIP: {notes}` line from
  `_skip()` right before its normal stderr status line — that bare line has
  no colon immediately after the label (`2B SKIP: ...`, not `2B: SKIP...`)
  so it never matches this grammar; only the `  2B: PASS  (0.1s)  SKIP:
  ...` status line does, and SKIP is recovered from `tag==PASS and
  notes.startswith("SKIP:")`. The format string is
  `f"  {label}: {tag}  ({secs:.1f}s)  {notes}"` — the two literal spaces
  before `{notes}` are unconditional, so a level with no notes still ends
  the line with a trailing `"  "` (two spaces); the colon fixtures preserve
  that trailing whitespace verbatim rather than trimming it, since
  `classify_run`'s colon terminal-marker check (MINOR-2, below) and
  `_parse_colon` both only care that `\s*` absorbs it, but a future stricter
  grammar could care about the literal bytes.
- **colon terminal markers** (MINOR-2): multiuser's `TOTAL <p>/<n>` and
  meeting/ms-smoke's `TOTAL pass=<g> skipped=<s> of <n>` are both checked by
  `_has_terminal_marker` for the colon family now (previously colon was
  exempt) — an empty or truncated colon-family stream reporting exit 0 is
  SUSPECT, not a silent PASS, matching the dash/regression families'
  existing behaviour.
- **regression**: row grammar keys off `│` (light vertical, U+2502) around
  `L<label>` and the tag cell; Rich's header/border rows use heavy box
  characters (`┃ ━ ┏ ┓ ┡ ┩ └ ┘` etc.) that never appear in this character
  class, so header and border lines are excluded structurally, not by an
  extra skip rule. The authoritative line is always `TOTAL p/n  wall=Ws`
  plus the exit code — the per-row parse is explicitly best-effort per the
  implementation plan.
