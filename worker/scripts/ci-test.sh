#!/usr/bin/env bash
# Batched vitest runner for CI (and local full-suite runs).
#
# The @cloudflare/vitest-pool-workers pool cannot collect the whole worker suite
# (~160 tests) in a single process — it hits cloudflare:test collection failures
# and exhausts the pool. So we run each test/ subdirectory and the top-level
# test/*.test.ts files as their own `vitest run`, clearing the Vite cache between
# batches, and aggregate the results. Auto-discovers directories so new test
# folders are picked up without editing this script.
#
# Run from the worker/ directory: `bash scripts/ci-test.sh` (or `npm run test:ci`).
set -uo pipefail

failed_batches=()

run_batch() {
  local label="$1"; shift
  echo "::group::vitest ${label}"
  rm -rf node_modules/.vite 2>/dev/null || true
  if npx vitest run "$@"; then
    echo "::endgroup::"
  else
    echo "::endgroup::"
    echo "::error::batch failed: ${label}"
    failed_batches+=("${label}")
  fi
}

# Per-directory batches.
for d in test/*/; do
  [ -d "$d" ] || continue
  run_batch "$d" "$d"
done

# Top-level test files as one batch.
shopt -s nullglob
toplevel=(test/*.test.ts)
shopt -u nullglob
if [ ${#toplevel[@]} -gt 0 ]; then
  run_batch "test/ (top-level files)" "${toplevel[@]}"
fi

echo
if [ ${#failed_batches[@]} -gt 0 ]; then
  echo "FAILED batches (${#failed_batches[@]}):"
  printf '  - %s\n' "${failed_batches[@]}"
  exit 1
fi
echo "All test batches passed."
