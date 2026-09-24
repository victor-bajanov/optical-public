# Solver performance notes (2026-07-05 optimization pass)

## Summary

The solve path was rebuilt for speed without changing the JSON contract or the
hard-constraint guarantees. `model.py`/`objective.py` remain the reference
implementation (still used for unsat-core extraction, isolation checks, and as
a runtime fallback); the hot path now runs on `placements.py` + `fast_model.py`
orchestrated by `two_pass.py`.

## Baseline (pre-optimization, 30s time limit per pass, 4-core box)

| scenario (synthetic) | total | pass1 | pass2 | status |
|---|---|---|---|---|
| small (10 tasks) | 2.5s | 1.2s | 1.2s | OPTIMAL |
| typical (20 tasks, prev placements) | 33s | 2.9s | 30s (limit) | FEASIBLE |
| heavy (35 tasks) | 60s | 30s (limit) | 30s (limit) | FEASIBLE |
| oversubscribed (50 tasks) | 61s | 30s (limit) | 30s (limit) | FEASIBLE |

Model *build* was never the problem (<150 ms); CP-SAT search over a heavy
encoding was: every chunk start ranged over the full ~672-slot week with hard
constraints expressed as enforcement-literal table constraints
(`AddAllowedAssignments(...).OnlyEnforceIf(...)`), plus per-term
`AddElement`/`AddMultiplicationEquality` objective machinery.

## What changed

1. **Placement pre-compilation** (`placements.py`). All hard placement rules
   (pin, earliest_start, hard deadline, hard preferred windows, availability
   windows, business hours) are evaluated in plain Python once per problem
   into a per-chunk *allowed-start set*, using per-slot lookup tables instead
   of per-slot datetime arithmetic.

2. **Domain baking** (`fast_model.py`). Allowed starts become the start
   variable's *domain*. Search never visits forbidden placements, and the
   table constraints disappear. An empty allowed set forces the task to drop
   (same demotion/422 semantics as before, still proven through the reference
   assumption model when a core is needed).

3. **Pass-specific model specialization.** Pass 1 minimises only drop
   penalties, so it gets no objective machinery at all: one presence literal
   per task, optional fixed-size intervals, NoOverlap, and redundant
   business-hours capacity cuts (global + earliest-start/deadline band cuts)
   that let the LP bound *which* tasks must drop. Pass 2 receives the frozen
   partition, so dropped tasks vanish from the model entirely, presence
   gating disappears, and each chunk's start-dependent soft costs (fit +
   soft-window miss + churn) fold into **one** `AddElement` table per chunk.
   Daily caps use a cheap day-membership encoding for chunks that cannot span
   midnight (the exact interval-overlap decomposition is kept for the rare
   chunk that can). Streak-cap and drop terms are constants in pass 2.

4. **Warm starts + symmetry.** Pass 2 is hinted with pass 1's placements;
   pass 1 is hinted with previous placements. Interchangeable chunks of the
   same task (equal duration, no per-chunk prev placement, no pin, unordered,
   dependency-free task) get an ordering symmetry break in both passes.

5. **Stall-based early stop** (`two_pass.py`). CP-SAT often finds the final
   incumbent in seconds and then spends tens of seconds *proving* optimality
   (plateaus of equal-cost placements). A watcher thread stops the search
   after `SOLVER_STALL_LIMIT_S` seconds without an improving incumbent; the
   hard ceilings (`SOLVER_PASS1_TIME_LIMIT_S`, `SOLVER_PASS2_TIME_LIMIT_S`)
   remain as backstops. Hard constraints are unaffected — this only trades
   the tail of the quality curve for latency, and the perf tests pin quality
   with per-scenario objective ceilings.

6. **Objective reporting from placements.** The solution's component
   breakdown is recomputed exactly from the chosen starts in Python
   (`_components_from_starts`), mirroring `objective.py` term for term; the
   test-suite oracle (`tests/support/invariants.py`) independently verifies
   it on every scenario.

## Semantics fixes found by differential fuzzing

Fuzzing the fast path against the reference model (they must agree exactly on
optimal drop cost and objective total whenever both prove OPTIMAL) surfaced
three related pre-existing defects, all the same class: a **dropped** task
still constrained the week, contradicting the documented "hardness ⊥
droppability" principle:

- a dropped *pinned* task kept its frozen start, and through an ungated
  dependency forced a partner task away from its previous placement (observed:
  churn 3030 vs 60 on the same drop set);
- a contradictory pin/dependency pair returned 422 for the whole week instead
  of dropping one task;
- a dropped pinned task with a soft deadline charged phantom lateness (report
  inflation only).

Fix: pins, dependencies (both endpoints), and lateness are now presence-gated
in the reference model, matching the fast path. Dependency *cycles* now
resolve by dropping a task instead of 422 — consistent with "the solver never
returns UNSAT for task contention". `tests/test_fast_legacy_parity.py` keeps
the two implementations honest (12 seeded problems; 120 more seeds checked
during development, zero mismatches).

## Test harness

- `tests/support/generators.py` — seeded, representative scenario builders
  (fresh week, realistic replan, movable meetings, oversubscribed week,
  adversarial churn stress, genuine 422). External events are disjoint and
  previous placements form a plausible prior plan, mirroring what the Worker
  actually sends (`build-problem.ts`).
- `tests/support/invariants.py` — validates every hard guarantee of a
  returned schedule and recomputes all seven objective components exactly.
- `tests/test_solver_correctness.py` — scenarios × seeds through the
  invariants + oracle.
- `tests/perf/` — `pytest -m perf` wall-time budgets with quality ceilings
  (`baselines.py`); `python tests/perf/bench.py` prints the scenario table.

## Results (harness scenarios, 4-core box, 2026-07-05)

| scenario | before (wall / status) | after (wall / status) | objective |
|---|---|---|---|
| small | 2.5s OPTIMAL | **0.8s OPTIMAL** | equal (100) |
| typical replan | ~33s FEASIBLE (limit) | **16s OPTIMAL** | exact optimum 5080 |
| fresh_week | ~30s+ FEASIBLE | **4.3s OPTIMAL** | exact optimum 215 |
| adversarial_churn | ~30s+ FEASIBLE | **4.7s OPTIMAL** | exact optimum 10420 |
| meetings | 30s FEASIBLE (limit) | **20s FEASIBLE** | better (≤17525 ceiling) |
| heavy | 52s FEASIBLE (limits) | **28s FEASIBLE** | much better and far less noisy (10.9-11.6k vs 11.5-31k spread) |
| oversubscribed | 56s FEASIBLE (limits) | **36s FEASIBLE** | better (≤36911 ceiling) |

Pass 1 (drop minimisation) is ~10 ms on any feasible week (was 3-30s).
Feasible/realistic workloads now finish with optimality certificates in
seconds. Genuinely oversubscribed stress weeks remain bounded by the packing
hardness of *proving* which tasks to drop; they spend their (reduced) caps and
return strictly better incumbents than the old encoding did at 30s caps.
Instrumented notes: the multi-worker CP-SAT portfolio ignores solution hints
for its first incumbent, so greedy warm-start hints do not speed the default
path (measured: hinting the known optimum still produced a cold first
incumbent); parameter sweeps (workers 1/2/4/8, linearization 0/1/2, presolve
off) produced no repeatable win over portfolio defaults.

## Knobs

| env var | default | meaning |
|---|---|---|
| `SOLVER_PASS1_TIME_LIMIT_S` | 20 | hard ceiling, pass 1 |
| `SOLVER_PASS2_TIME_LIMIT_S` | 20 | hard ceiling, pass 2 |
| `SOLVER_STALL_LIMIT_S` | 5 | stop after this many seconds without an improving incumbent (0 disables) |


## Memory footprint and CPU sensitivity (container-retirement card 2.1, 2026-08-23)

Question: does the solver fit a **1 GiB** container with 2× headroom, and
how does it behave on a 1 or 0.5 vCPU cap? Measured locally (docker via
colima, Apple Silicon host) by running `tests/perf/bench.py` *inside* the
production image under `--memory=1g --memory-swap=1g` and reading the
cgroup v2 `memory.peak` / `memory.events` of the whole container (uvicorn +
bench process). Two image builds:

- `linux/amd64` — the image that actually ships (Cloudflare Containers are
  x86_64). On this host it runs under emulation, so its **timings are
  meaningless** (~10-20× slow) and its RSS carries emulator overhead; it is
  the upper bound on memory.
- `linux/arm64` — same Dockerfile, native. Timings are representative of
  one host core (not a Cloudflare vCPU, but the right order of magnitude);
  RSS is the lower bound.

| build | cpus | boot → /healthz | RSS after boot | **peak RSS (bench)** | OOM events |
|---|---|---|---|---|---|
| amd64 (emulated) | 1 | 6.0 s | 176 MiB | **465 MiB** | 0 |
| amd64 (emulated) | 0.5 | 11.8 s | 201 MiB | **454 MiB** | 0 |
| arm64 (native) | 4 (uncapped) | 0.6 s | 71 MiB | **273 MiB** | 0 |
| arm64 (native) | 1 | 0.7 s | 75 MiB | **276 MiB** | 0 |
| arm64 (native) | 0.5 | 1.1 s | 73 MiB | **218 MiB** | 0 |

**Memory verdict: 1 GiB is enough, with >2× headroom.** The worst case
observed — the full scenario set including `heavy` and `oversubscribed`
(48 chunks, 20 s caps on both passes, 8-worker CP-SAT portfolio) — peaked
at 465 MiB even under emulation, and ~275 MiB native; `memory.events`
recorded no `high`/`max`/`oom` hits. A single prod solve is far smaller
than `heavy` (prod solves take 5-50 ms; see the plan's Stage 1 findings).
512 MiB would *probably* work natively but has <2× headroom against the
emulated figure, so 1 GiB is the floor to take into card 2.2.

**CPU verdict: 1 vCPU is fine for prod-shaped work; the synthetic `heavy`
class degrades below 1 vCPU.** Native timing tables (same seeds as the
2026-07-05 results above; the 20 s cap is what bounds the FEASIBLE rows):

*arm64, 4 cores (reference):*

| scenario | build_s | pass1_s | pass2_s | total_s | status | scheduled | dropped | objective_total |
|---|---|---|---|---|---|---|---|---|
| small | 0.000 | 0.00 | 0.65 | 0.66 | OPTIMAL | 13 | 0 | 100 |
| typical | 0.000 | 0.00 | 18.27 | 18.29 | FEASIBLE | 29 | 0 | 5080 |
| fresh_week | 0.000 | 0.00 | 2.05 | 2.07 | OPTIMAL | 29 | 0 | 215 |
| heavy | 0.001 | 7.76 | 20.01 | 27.79 | FEASIBLE | 47 | 4 | 19474 |
| meetings | 0.000 | 0.00 | 20.00 | 20.03 | FEASIBLE | 34 | 0 | 15270 |
| oversubscribed | 0.000 | 14.76 | 20.01 | 34.79 | FEASIBLE | 41 | 16 | 30626 |
| adversarial_churn | 0.000 | 0.00 | 1.63 | 1.65 | OPTIMAL | 24 | 0 | 10420 |

*arm64, `--cpus=1`:*

| scenario | build_s | pass1_s | pass2_s | total_s | status | scheduled | dropped | objective_total |
|---|---|---|---|---|---|---|---|---|
| small | 0.000 | 0.00 | 1.04 | 1.05 | OPTIMAL | 13 | 0 | 100 |
| typical | 0.000 | 0.00 | 16.46 | 16.48 | FEASIBLE | 29 | 0 | 5850 |
| fresh_week | 0.001 | 0.00 | 3.27 | 3.30 | OPTIMAL | 29 | 0 | 215 |
| heavy | 0.000 | 18.79 | 20.01 | 38.83 | FEASIBLE | 46 | 4 | 32360 |
| meetings | 0.000 | 0.00 | 20.01 | 20.03 | FEASIBLE | 34 | 0 | 16605 |
| oversubscribed | 0.001 | 14.53 | 20.01 | 34.57 | FEASIBLE | 39 | 17 | 29651 |
| adversarial_churn | 0.000 | 0.00 | 3.54 | 3.56 | OPTIMAL | 24 | 0 | 10420 |

*arm64, `--cpus=0.5`:*

| scenario | build_s | pass1_s | pass2_s | total_s | status | scheduled | dropped | objective_total |
|---|---|---|---|---|---|---|---|---|
| small | 0.000 | 0.00 | 5.47 | 5.49 | OPTIMAL | 13 | 0 | 100 |
| typical | 0.001 | 0.01 | 11.49 | 11.60 | FEASIBLE | 29 | 0 | 22540 |
| fresh_week | 0.000 | 0.00 | 10.58 | 10.60 | FEASIBLE | 29 | 0 | 520 |
| heavy | 0.001 | 19.28 | 0.00 | 36.20 | PASS1_FALLBACK | 46 | 5 | 55316 |
| meetings | 0.001 | 0.01 | 10.79 | 10.90 | FEASIBLE | 34 | 0 | 73120 |
| oversubscribed | 0.002 | 13.47 | 19.99 | 33.58 | FEASIBLE | 36 | 21 | 48326 |
| adversarial_churn | 0.000 | 0.00 | 19.41 | 19.43 | OPTIMAL | 24 | 0 | 10420 |

Reading: at 1 core the feasible/realistic scenarios (`small`, `fresh_week`,
`adversarial_churn`) still prove OPTIMAL in 1-4 s (vs 0.7-2 s on 4 cores);
`typical`/`meetings` hit the same 20 s pass-2 cap they hit on 4 cores with
comparable objectives (5850 vs 5080; 16605 vs 15270). `heavy` loses the
portfolio parallelism — pass 1 takes 18.8 s instead of 7.8 s and the
incumbent is worse (32360 vs 19474) though still FEASIBLE. At 0.5 core
`heavy` and `oversubscribed` stall out of pass 1 (`PASS1_FALLBACK`, pass 2
never runs, objective 55k) and `typical`/`meetings` return noticeably worse
incumbents. So: **`heavy` is not a supported class below 1 vCPU**; on a
1 vCPU tier it is supported with degraded (but feasible) quality. The
emulated amd64 tables (not reproduced — every row is cap-bound) show the
same shape one notch worse: `PASS1_FALLBACK` on most scenarios at 0.5.

Implication for card 2.2: the target is a 1 vCPU / 1 GiB instance.
Cloudflare's predefined `basic` tier is 1/4 vCPU / 1 GiB — below the
measured knee for the synthetic stress set, though prod's 5-50 ms solves
would not notice; a custom `{ vcpu = 1, memory_mib = 1024 }` (the config
already uses a custom type) keeps the stress harness inside its budgets.
Boot time on the real platform is ~3.5 s today (12 GiB, from
`solver_uptime_ms`); the native 0.6-1 s here is process start only and says
nothing about Firecracker VM boot, so card 2.3 must re-measure `boot_s`
from `solver_calls` rather than trust this table.

Reproduce: build the image (`docker build --platform=linux/amd64 -t
optical-solver:perf solver/`; swap the platform for the native build), then
per CPU level: `docker run -d --memory=1g --memory-swap=1g --cpus=<n> -v
$PWD/solver/tests:/app/tests:ro <image>`, wait for `/healthz`, `docker exec
-w /app <c> python tests/perf/bench.py`, and read
`/sys/fs/cgroup/memory.peak` + `memory.events` inside the container.
