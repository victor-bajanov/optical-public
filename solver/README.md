# Solver Service

Stateless CP-SAT solver service.

## Develop

```bash
uv sync --extra dev
uv run pytest -m "not perf"   # correctness suite (default green path)
uv run pytest -m perf         # wall-time budgets + quality ceilings
uv run python tests/perf/bench.py  # scenario timing table
uv run uvicorn solver.server:app --reload --port 8080
```

See `docs/perf.md` for the fast-path architecture and tuning knobs.

## Solve

```bash
curl -X POST http://localhost:8080/solve \
  -H 'content-type: application/json' \
  -d @tests/fixtures/sample_week.json
```

See `docs/contract.md` for the input/output JSON contract.
