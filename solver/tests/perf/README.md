# Performance harness

Wall-clock budgets for the CP-SAT scheduling solver. These are the optimisation
target and are **expected to fail (TDD red)** on the current, un-optimised solver.

## Default green path (perf excluded)

The perf tests are marked `@pytest.mark.perf`. Run everything else — the existing
suite plus the correctness harness — with:

```bash
uv run pytest -m "not perf"
```

`-m "not perf"` is intentionally **not** baked into `addopts` (CI selects markers
explicitly), so remember the flag when you want the fast green path.

## Running the perf budgets

```bash
uv run pytest -m perf tests/perf/test_perf.py -s
```

`-s` lets the end-of-run timing table print to stdout. Each budget assertion
reports measured-vs-budget so the gap is readable.

Budgets:

| scenario       | budget | required status         |
|----------------|--------|-------------------------|
| small          | 2.0s   | OPTIMAL                 |
| typical        | 5.0s   | OPTIMAL                 |
| heavy          | 12.0s  | OPTIMAL                 |
| meetings       | 12.0s  | OPTIMAL                 |
| oversubscribed | 20.0s  | solution + non-empty drops |

## Baseline / regression table

```bash
uv run python tests/perf/bench.py
```

Prints a markdown table (`scenario | build_s | pass1_s | pass2_s | total_s |
status | scheduled | dropped | objective_total`) for before/after documentation.
