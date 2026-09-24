// D1 — time-indexed Lagrangian contention bound (card B;
// internal design notes §D1).
//
// The LP relaxation of the placement problem is the classic time-indexed
// formulation; relaxing the slot-capacity rows gives
//
//   L(λ) = Σ_c min_{s ∈ dom(c)} ( cost[c][s] + Σ_{t ∈ [s, s+dur_c)} λ[t] )
//          − Σ_t λ[t]·cap[t]        with λ ≥ 0
//
// where cap[t] is 1 on a free slot and 0 on an occupied one. Any λ ≥ 0 is a
// valid lower bound (weak duality): for a feasible completion x,
//
//   L(λ) ≤ Σ_c cost[c][s_c] + Σ_t λ[t]·(usage[t] − cap[t]) ≤ cost(x)
//
// since usage never exceeds capacity and λ ≥ 0. TWO consequences the callers
// lean on: the bound stays admissible for ANY superset of the true live
// domains (a superset only lowers the per-chunk min), and it stays admissible
// at every interior node for a λ optimised once at the root — which is why
// `evaluateBound` never re-optimises.
//
// The inner minimisation decomposes per chunk and is O(|domain|) given a
// prefix sum of λ, so a start's covered-slot total is one subtraction.
//
// ARITHMETIC. λ is held in SCALED INTEGERS (`LAMBDA_SCALE` per unit of the
// engine's integer cost domain) and every operation in this module — the
// subgradient step included — is integer-valued. Float64 would very likely be
// bit-stable too (single-threaded V8, no transcendentals), but the plan
// requires two-platform evidence for that claim and scaled integers make it
// unnecessary: determinism here is a property of the arithmetic, not of the
// runtime. Values are accumulated in plain `number`s, which hold integers
// exactly to 2^53 — far above anything a 672-slot horizon can reach.

import type { Baked, LagrangianState, Residual } from "./types";

/** Fixed-point denominator for λ. One λ unit is 1/64 of an engine cost unit:
 * a chunk's covered-slot total then resolves to a fraction of a cost unit,
 * which is finer than the bound's own integer rounding, while leaving Int32
 * headroom for the multipliers a crowded plateau actually needs (a slot price
 * has to reach the cost of being displaced off that slot, which on the
 * fit-weighted corpus is six figures, not four). */
export const LAMBDA_SCALE = 64;

/** Ceiling on a single slot's multiplier — 2^30 scaled, i.e. ~16.7 M cost
 * units. Bounds the prefix sums well inside exact-integer range and stops a
 * runaway step from poisoning λ, without clipping a legitimate price. */
const LAMBDA_MAX = 1 << 30;

/** Polyak step numerator, and the non-improvement patience after which it is
 * halved. Both fixed: the schedule must not depend on wall clock. */
const STEP_NUM = 2;
const STEP_PATIENCE = 8;
/** Give up once the step multiplier has decayed past usefulness. */
const STEP_DEN_MAX = 1 << 20;

/** Budgeted subgradient ascent at the root: fixed iteration count and step
 * schedule (deterministic), keeping the best L(λ) seen. The returned λ* is
 * retained for evaluate-only interior-node bounds and improvement-phase
 * sub-solves.
 *
 * `residual.upperBound`, when the caller knows one, is the Polyak target; it
 * only ever scales the step, never the bound, so a wrong one costs quality and
 * cannot cost admissibility. */
export function optimizeMultipliers(
  baked: Baked,
  residual: Residual,
  iterations: number,
): LagrangianState {
  const horizon = baked.horizon;
  const lambda = new Int32Array(horizon);
  const bestLambda = new Int32Array(horizon);
  const prefix = new Float64Array(horizon + 1);
  const usage = new Int32Array(horizon);
  const free = freeMask(baked, residual);
  const freePrefix = spanPrefix(free);
  const domains = chunkDomains(baked, residual);
  const target = targetScaled(residual, freePrefix, domains);

  // Iteration 0 evaluates λ = 0, so the returned bound is never worse than the
  // separable Σ-min term the search already had — and the ascent gets its
  // first real subgradient from the same pass rather than paying for a
  // throwaway one.
  let bestScaled = -Infinity;
  let stepDen = 1;
  let sinceImprove = 0;
  const iters = iterations < 1 ? 1 : iterations;

  for (let iter = 0; iter < iters; iter++) {
    usage.fill(0);
    const current = scaledBound(domains, freePrefix, prefix, lambda, usage);
    if (current > bestScaled) {
      bestScaled = current;
      bestLambda.set(lambda);
      sinceImprove = 0;
    } else if (++sinceImprove >= STEP_PATIENCE) {
      // Shorten the step and resume from the best point rather than from
      // wherever the overshoot landed — the standard restart, and the
      // difference between converging and orbiting on a degenerate instance.
      stepDen *= 2;
      sinceImprove = 0;
      if (stepDen > STEP_DEN_MAX) break;
      lambda.set(bestLambda);
      continue;
    }
    if (current >= target) break; // no gap left to close

    // Projected subgradient: g[t] = usage[t] − cap[t]. A slot already at
    // λ = 0 whose gradient points down cannot move, so it is left out of the
    // norm — otherwise the hundreds of untouched free slots would swamp it and
    // the step would collapse to nothing.
    let normSq = 0;
    for (let t = 0; t < horizon; t++) {
      const g = usage[t]! - (free[t] === 1 ? 1 : 0);
      if (g === 0) continue;
      if (g < 0 && lambda[t]! === 0) continue;
      normSq += g * g;
    }
    if (normSq === 0) break; // complementary slackness: λ is dual-optimal here

    let step = Math.floor((STEP_NUM * (target - current)) / (stepDen * normSq));
    if (step < 1) step = 1;
    for (let t = 0; t < horizon; t++) {
      const g = usage[t]! - (free[t] === 1 ? 1 : 0);
      if (g === 0) continue;
      let next = lambda[t]! + step * g;
      if (next < 0) next = 0;
      else if (next > LAMBDA_MAX) next = LAMBDA_MAX;
      lambda[t] = next;
    }
  }

  return { lambda: bestLambda, bound: intBound(bestScaled) };
}

/** Evaluate L(λ) for a residual problem at a fixed λ ≥ 0 — no
 * re-optimisation. Admissible for every residual subproblem, rounded into the
 * int cost domain. */
export function evaluateBound(
  baked: Baked,
  residual: Residual,
  lambda: Int32Array,
): number {
  const prefix = new Float64Array(baked.horizon + 1);
  const freePrefix = spanPrefix(freeMask(baked, residual));
  return intBound(
    scaledBound(chunkDomains(baked, residual), freePrefix, prefix, lambda, null),
  );
}

/** L(λ) is a real-valued bound on a sum of INTEGER costs, so the least integer
 * at or above it bounds them too — and rounding the other way discards exactly
 * the case that matters, a dual that has converged onto the optimum and lands
 * a fraction below it (a saturated week's bound comes out one unit short, and
 * the certificate with it). LAMBDA_SCALE is a power of two, so dividing an
 * exact integer by it is exact and the ceiling is not a floating-point
 * judgement call. */
export function intBound(scaled: number): number {
  return Math.ceil(scaled / LAMBDA_SCALE);
}

/** Per-slot capacity of the residual: 1 where free, 0 where occupied. */
function freeMask(baked: Baked, residual: Residual): Uint8Array {
  const free = new Uint8Array(baked.horizon);
  const occ = residual.occ;
  for (let t = 0; t < baked.horizon; t++) {
    free[t] = ((occ[t >> 5]! >>> (t & 31)) & 1) === 1 ? 0 : 1;
  }
  return free;
}

/** Running count of free slots, horizon + 1 entries. A span is wholly free iff
 * it contains `dur` free slots, so the O(dur) walk per candidate start becomes
 * one subtraction — which matters twice over: it is the inner loop of every
 * iteration, and it is what makes the loop's cost genuinely
 * O(iterations × Σ|domain|) rather than that times the mean duration. Entry
 * [horizon] doubles as Σ cap, the second half of L(λ)'s capacity term. */
function spanPrefix(free: Uint8Array): Int32Array {
  const prefix = new Int32Array(free.length + 1);
  let run = 0;
  for (let t = 0; t < free.length; t++) {
    run += free[t]!;
    prefix[t + 1] = run;
  }
  return prefix;
}

function spanFree(freePrefix: Int32Array, start: number, dur: number): boolean {
  const end = start + dur;
  if (end >= freePrefix.length) return false;
  return freePrefix[end]! - freePrefix[start]! === dur;
}

/** The live domain the bound minimises over, per unplaced chunk. Callers who
 * have narrowed a chunk's starts (pass 2 folds unary event-dependency bounds
 * into its working domains) pass those in; everyone else gets the baked
 * envelope. Narrower is both admissible and STRONGER — every completion's
 * start is in the narrower set — so this is not just a speed choice. */
interface LiveDomain {
  slots: Int32Array;
  costs: Int32Array;
  dur: number;
}

function chunkDomains(baked: Baked, residual: Residual): LiveDomain[] {
  const supplied = residual.domains;
  const out = new Array<LiveDomain>(residual.unplaced.length);
  for (let k = 0; k < residual.unplaced.length; k++) {
    const chunk = baked.chunks[residual.unplaced[k]!]!;
    const given = supplied === undefined ? undefined : supplied[k];
    out[k] =
      given === undefined
        ? { slots: chunk.allowedStarts, costs: chunk.cost, dur: chunk.durationSlots }
        : { slots: given.slots, costs: given.costs, dur: chunk.durationSlots };
  }
  return out;
}

/** L(λ) in λ-scaled units, reusing the caller's scratch. When `usage` is
 * non-null it is filled with the argmin assignment's slot occupancy — the
 * subgradient's positive half.
 *
 * A chunk with no free start contributes nothing: the residual then has no
 * completion at all, so every value is vacuously a lower bound on it and the
 * cheap answer is the safe one. */
function scaledBound(
  domains: readonly LiveDomain[],
  freePrefix: Int32Array,
  prefix: Float64Array,
  lambda: Int32Array,
  usage: Int32Array | null,
): number {
  const horizon = lambda.length;
  let run = 0;
  prefix[0] = 0;
  for (let t = 0; t < horizon; t++) {
    run += lambda[t]!;
    prefix[t + 1] = run;
  }

  let total = 0;
  for (const domain of domains) {
    const { slots, costs, dur } = domain;
    let best = Infinity;
    let bestStart = -1;
    let bestCrowd = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (!spanFree(freePrefix, s, dur)) continue;
      const v = LAMBDA_SCALE * costs[i]! + (prefix[s + dur]! - prefix[s]!);
      // strict <, and starts ascend, so ties keep the earliest slot: the
      // tie-break that makes the whole ascent reproducible.
      if (v < best) {
        best = v;
        bestStart = s;
        bestCrowd = usage === null ? 0 : crowding(usage, s, dur);
      } else if (v === best && usage !== null && bestStart >= 0) {
        // Identical chunks share an argmin, and a dozen of them piling onto
        // one start produces a subgradient that says nothing except "spread
        // out". Ties cost the SAME, so steering one to the least-claimed of
        // them leaves L(λ) untouched and hands the ascent a direction it can
        // actually use.
        const crowd = crowding(usage, s, dur);
        if (crowd < bestCrowd) {
          bestStart = s;
          bestCrowd = crowd;
        }
      }
    }
    if (bestStart < 0) continue;
    total += best;
    if (usage !== null) {
      for (let t = bestStart; t < bestStart + dur; t++) usage[t]!++;
    }
  }

  // − Σ_t λ[t]·cap[t]: cap is 1 exactly on the free slots.
  for (let t = 0; t < horizon; t++) {
    if (freePrefix[t + 1]! > freePrefix[t]!) total -= lambda[t]!;
  }
  return total;
}

/** How much of this span the argmin assignment has already claimed. */
function crowding(usage: Int32Array, start: number, dur: number): number {
  let total = 0;
  for (let t = start; t < start + dur; t++) total += usage[t]!;
  return total;
}

/** Polyak target in λ-scaled units: the caller's upper bound when it has one,
 * else Σ_c max live cost — loose, but a genuine ceiling on any assignment's
 * separable cost, which is all the step schedule needs. */
function targetScaled(
  residual: Residual,
  freePrefix: Int32Array,
  domains: readonly LiveDomain[],
): number {
  let ceiling = 0;
  for (const domain of domains) {
    let max = 0;
    for (let i = 0; i < domain.slots.length; i++) {
      if (!spanFree(freePrefix, domain.slots[i]!, domain.dur)) continue;
      if (domain.costs[i]! > max) max = domain.costs[i]!;
    }
    ceiling += max;
  }
  const supplied = residual.upperBound;
  if (supplied !== undefined && Number.isFinite(supplied) && supplied < ceiling) {
    ceiling = Math.max(0, Math.floor(supplied));
  }
  return LAMBDA_SCALE * ceiling;
}
