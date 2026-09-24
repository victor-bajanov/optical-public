// E — fan-out escape hatch: batched sub-solves over a service-binding RPC
// (internal design notes §E).
//
// The engine stays pure dependency-free TS, so the binding is typed
// structurally, not as a Cloudflare Fetcher. The returned subsolve batches
// requests, fans out, COLLECTS ALL, and combines in fixed request order —
// the flag may change wall clock, never the answer. Any RPC failure
// degrades to the in-process sequential path for the remainder of the
// solve.

import { parseEnvNumberWithFloor } from "../util/env-parse";
import { place } from "./pass2";
import { bakeProblem } from "./substrate";
import type { Budget, Placement, SubsolveFn, SubsolveRequest, SubsolveResult } from "./types";

/** Structural view of the EngineRpc WorkerEntrypoint — keeps this module
 * free of Cloudflare types. */
export interface EngineRpcBinding {
  subsolve(request: SubsolveRequest): Promise<SubsolveResult>;
}

/** Batched async sub-solve: results are returned in request order,
 * regardless of arrival order. */
export type AsyncSubsolveFn = (
  requests: readonly SubsolveRequest[],
) => Promise<SubsolveResult[]>;

/** Hard ceiling on RPC sub-solves for one resolve.
 *
 * The governing limit is NOT the 1000-subrequest ceiling: the binding targets
 * this same Worker, and the platform caps invocations of the same Worker at 32
 * per request. Past that the binding throws, which this session would absorb
 * as `rpc_error` — correct, but only after wasting up to 32 round trips on a
 * resolve a user is waiting for. 24 stops short of the limit with room for the
 * SOLVER binding call a shadow/fallback resolve also makes, and for whatever
 * bindings this worker grows later.
 *
 * Miniflare does not enforce the 32 limit, so no test in this repo can catch a
 * value set above it — this constant is the only guard until card H's dev
 * smoke measures the real ceiling against a deployment. */
export const MAX_SUBSOLVES_PER_RESOLVE = 24;

/** Sub-solves dispatched concurrently per batch. Concurrency is bounded so a
 * long neighbourhood list cannot put its whole width in flight at once; the
 * batch boundary has no effect on the combined answer. */
export const DEFAULT_FANOUT_BATCH_CAP = 8;

/** Default for SOLVER_ENGINE_FANOUT_MIN_CHUNKS. Below this many chunks the
 * RPC overhead exceeds an in-process sub-solve (spec: "at n = 1 and small n,
 * in-process beats fan-out"). */
export const FANOUT_MIN_CHUNKS_DEFAULT = 24;

/** Why a session stopped fanning out. Contractual — read by the smoke and the
 * soak analysis off the `engine_fanout_degraded` line. */
export type FanoutDegradeReason = "rpc_error" | "subsolve_cap";

export interface FanoutStats {
  subsolves: number;
  batches: number;
  degraded: boolean;
}

/** Minimal log sink so this module stays testable without a console spy;
 * production passes nothing and gets console. */
export interface FanoutLog {
  info(line: string): void;
  warn(line: string): void;
}

const CONSOLE_LOG: FanoutLog = {
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
};

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/** Coerce a chunk-indexed placement that has crossed a serialization boundary
 * back into an Int32Array.
 *
 * workerd's RPC uses structured clone, which round-trips a typed array as a
 * typed array — the identity case below is what actually happens today, and
 * `test/planning/engine-fanout.test.ts` pins it. The other shapes are the
 * cheap insurance: were the boundary ever to become JSON (a debug proxy, a
 * captured request replayed from a log), a plain array or an object with
 * numeric keys would otherwise flow into the cost arithmetic as `undefined`
 * and NaN-poison the objective silently. Coercing loudly beats that. */
export function asInt32Array(value: unknown, length: number): Int32Array {
  if (value instanceof Int32Array) return checkLength(value, length);

  if (value instanceof ArrayBuffer) {
    let view: Int32Array;
    try {
      view = new Int32Array(value);
    } catch (e) {
      // A byteLength that is not a multiple of 4 throws a bare RangeError from
      // the constructor; re-word it so the failure names what is actually
      // wrong with the payload.
      throw new Error(`engine: sub-solve placement buffer is not Int32-aligned (${String(e)})`);
    }
    return checkLength(view, length);
  }

  // Any other view is REJECTED rather than reinterpreted: reading a
  // Uint32Array's or Float64Array's bytes as Int32 yields a placement that is
  // silently, plausibly wrong — far worse than a throw.
  if (ArrayBuffer.isView(value)) {
    throw new Error(
      `engine: sub-solve placement is a ${value.constructor.name}, not an Int32Array`,
    );
  }

  if (Array.isArray(value)) {
    const out = new Int32Array(length);
    checkLength(value as unknown[], length);
    for (let i = 0; i < length; i++) {
      out[i] = checkEntry((value as unknown[])[i], i);
    }
    return out;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const out = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = checkEntry(record[String(i)], i);
    }
    return out;
  }

  throw new Error("engine: sub-solve placement is not an Int32Array");
}

/** Length is enforced on every shape: a short placement is a truncated one,
 * and padding it would fill the missing chunks with slot 0 — a real, cheap
 * slot the cost model would happily accept. */
function checkLength<T extends { length: number }>(value: T, length: number): T {
  if (value.length !== length) {
    throw new Error(
      `engine: sub-solve placement length ${value.length} does not match ${length} chunks`,
    );
  }
  return value;
}

function checkEntry(entry: unknown, index: number): number {
  if (typeof entry !== "number" || !Number.isInteger(entry)) {
    throw new Error(`engine: sub-solve placement entry ${index} is not an integer`);
  }
  return entry;
}

/** The leaf. Re-bakes the wire problem (baking is deterministic, so a leaf
 * needs nothing from the master beyond the request) and runs the same
 * `place()` the in-process path runs. Frozen chunks ride in as PlaceOptions;
 * they are inert until card D honours them, and this function must not
 * simulate the echo-back in the meantime — a placement stitched together
 * outside the search would not match the `cost` the search reported. */
/** One bake per Problem OBJECT per isolate. Every request of a resolve's
 * improve loop carries the same `problem` reference, so the degraded
 * sequential path (which routes through `runSubsolve` once per remaining
 * sub-solve) pays the full bake once instead of once per neighbourhood —
 * exactly the path already slowed by the RPC failure that degraded it. An
 * RPC leaf never hits the cache twice (each request deserializes a fresh
 * object), which is fine: the entrypoint's cost is one bake per call either
 * way. `bakeProblem` is pure, so caching cannot change any answer. */
const bakedByProblem = new WeakMap<object, ReturnType<typeof bakeProblem>>();

function bakeCached(problem: SubsolveRequest["problem"]): ReturnType<typeof bakeProblem> {
  const hit = bakedByProblem.get(problem);
  if (hit !== undefined) return hit;
  const baked = bakeProblem(problem);
  bakedByProblem.set(problem, baked);
  return baked;
}

export function runSubsolve(request: SubsolveRequest): SubsolveResult {
  // Validate before baking: everything here crossed a serialization boundary,
  // and a NaN budget or a fractional task index would otherwise surface as a
  // wrong answer rather than an error (`outOfTime()` compares against NaN and
  // never fires; a bad index reads past the kept set). Same posture as
  // asInt32Array — loud beats plausible.
  const wallMs = requirePositive(request.wallMs, "wallMs");
  const nodeCap = requirePositive(request.nodeCap, "nodeCap");
  if (!Array.isArray(request.kept)) {
    throw new Error("engine: sub-solve kept is not an array of task indices");
  }
  for (let i = 0; i < request.kept.length; i++) {
    const index = request.kept[i];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new Error(`engine: sub-solve kept[${i}] is not a task index`);
    }
  }

  const baked = bakeCached(request.problem);
  const frozen: Placement = asInt32Array(request.frozen, baked.chunks.length);
  const budget: Budget = { wallMs, nodeCap };
  const result = place(baked, request.kept, null, budget, { frozenChunks: frozen });
  return {
    placement: result.placement,
    cost: result.cost,
    proved: result.proved,
    nodes: result.nodes,
    // Carried so the caller can tell "no incumbent" (descents 0, cost 0) from
    // a genuine cost-0 optimum — see SubsolveResult.descents in types.ts.
    descents: result.descents,
  };
}

/** Infinity passes: an unbounded wall is the expected sub-budget shape (see
 * the invariant at SubsolveRequest.wallMs). NaN does not — it would make
 * every comparison against it false. */
function requirePositive(value: unknown, name: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new Error(`engine: sub-solve ${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Batched fan-out
// ---------------------------------------------------------------------------

/** Reports work that actually completed, batch by batch, so a call that
 * ultimately throws still leaves an accurate record behind. `fulfilled` counts
 * sub-solves that returned in this batch — including in the batch that carried
 * the rejection. */
export type FanoutProgressFn = (fulfilled: number) => void;

/** Batch `requests` over the binding and combine in fixed request order.
 *
 * Rejections are surfaced to the caller (the session above adds the degrade
 * policy), but only after every promise in the batch has settled: a
 * fire-and-forget rejection mid-batch would leave sibling sub-solves running
 * against an isolate that is already unwinding. */
export function makeRpcSubsolve(
  binding: EngineRpcBinding,
  batchCap: number,
  onBatch?: FanoutProgressFn,
): AsyncSubsolveFn {
  const cap = Math.max(1, Math.floor(batchCap));
  return async (requests) => {
    const out: SubsolveResult[] = [];
    for (let start = 0; start < requests.length; start += cap) {
      const batch = requests.slice(start, start + cap);
      const settled = await Promise.allSettled(batch.map((r) => binding.subsolve(r)));
      let fulfilled = 0;
      for (const entry of settled) if (entry.status === "fulfilled") fulfilled++;
      // Record the round trips before deciding whether to throw: a session
      // that spent them must be able to say so (an `engine_fanout_degraded`
      // reporting subsolves 0 is indistinguishable from never engaging).
      onBatch?.(fulfilled);

      // Combine in REQUEST order — `settled` is index-aligned with `batch` by
      // Promise.allSettled's contract, never by arrival. This is the whole
      // determinism argument (spec forward rule 4, distributed case).
      for (let i = 0; i < settled.length; i++) {
        const entry = settled[i]!;
        if (entry.status === "rejected") throw asError(entry.reason);
        const result = entry.value;
        out.push({
          placement: asInt32Array(result.placement, batch[i]!.frozen.length),
          cost: result.cost,
          proved: result.proved,
          nodes: result.nodes,
          descents: result.descents,
        });
      }
    }
    return out;
  };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export interface FanoutSessionOptions {
  binding: EngineRpcBinding;
  /** In-process sub-solve used before fan-out and after a degrade. */
  sequential: SubsolveFn;
  batchCap?: number;
  maxSubsolves?: number;
  now?: () => number;
  log?: FanoutLog;
}

export interface FanoutSession {
  /** Batched sub-solve honouring the degrade latch and the per-resolve cap. */
  readonly subsolve: AsyncSubsolveFn;
  /** Emit the `engine_fanout` summary. Idempotent, and a no-op on a session
   * that never dispatched a batch. */
  finish(): void;
  stats(): FanoutStats;
}

/** One resolve's worth of fan-out: batching plus the degrade policy.
 *
 * Degrading recomputes the WHOLE call sequentially rather than filling in the
 * failed sub-solves, so a degraded answer is the pure sequential answer and
 * not a mixture whose composition depends on which leaf happened to fail.
 * Correctness over the wasted work — a degrade is exceptional by
 * construction. Once latched it stays latched for the rest of the solve: an
 * isolate that failed one sub-solve is not a thing to keep retrying inside a
 * user-facing resolve.
 *
 * Bit-identity with the sequential path rests on the sub-budget invariant
 * documented at `SubsolveRequest.wallMs`: sub-solves are NODE-capped, with
 * `wallMs` as a non-binding safety valve. A wall that actually binds makes a
 * leaf's answer a function of how fast its isolate ran, and the fan-out and
 * sequential paths would then disagree legitimately. Card F wires the budgets;
 * nothing here can enforce it. */
export function makeFanoutSession(options: FanoutSessionOptions): FanoutSession {
  const batchCap = Math.max(1, Math.floor(options.batchCap ?? DEFAULT_FANOUT_BATCH_CAP));
  const maxSubsolves = Math.max(1, Math.floor(options.maxSubsolves ?? MAX_SUBSOLVES_PER_RESOLVE));
  const now = options.now ?? Date.now;
  const log = options.log ?? CONSOLE_LOG;

  let subsolves = 0;
  let batches = 0;
  let wallMs = 0;
  let degraded = false;
  let finished = false;

  // Counters advance as batches settle, not when a call returns successfully,
  // so a call that ends in a degrade still leaves the round trips it spent on
  // the record.
  const rpc = makeRpcSubsolve(options.binding, batchCap, (fulfilled) => {
    subsolves += fulfilled;
    batches++;
  });

  const degrade = (reason: FanoutDegradeReason, error?: unknown): void => {
    if (degraded) return;
    degraded = true;
    log.warn(
      `engine_fanout_degraded ${JSON.stringify({
        reason,
        subsolves,
        batches,
        ...(error === undefined ? {} : { error: String(error) }),
      })}`,
    );
  };

  const subsolve: AsyncSubsolveFn = async (requests) => {
    if (requests.length === 0) return [];
    if (!degraded && subsolves + requests.length > maxSubsolves) {
      degrade("subsolve_cap");
    }
    if (degraded) return requests.map(options.sequential);

    // Timed around the fan-out ONLY. The sequential recompute below is work
    // the in-process path would have done anyway; charging it to `wall_ms`
    // would make a degraded session look like slow fan-out in the soak.
    const t0 = now();
    try {
      const results = await rpc(requests);
      wallMs += now() - t0;
      return results;
    } catch (e) {
      wallMs += now() - t0;
      degrade("rpc_error", e);
      return requests.map(options.sequential);
    }
  };

  return {
    subsolve,
    finish: () => {
      // Guard on batches, not subsolves: a session whose every sub-solve
      // failed still engaged, and that is exactly the case worth seeing.
      if (finished || batches === 0) return;
      finished = true;
      log.info(`engine_fanout ${JSON.stringify({ subsolves, batches, wall_ms: wallMs })}`);
    },
    stats: () => ({ subsolves, batches, degraded }),
  };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/** House posture for boolean Worker vars: exactly "true", trimmed so a
 * dashboard paste with trailing whitespace still reads as on. */
export function fanoutFlagOn(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() === "true";
}

/** House parse-with-floor posture (BOOKING_DECLINE_GRACE_MINUTES,
 * SOLVER_ENGINE_WALL_GUARD_MS): unset/blank/unparseable falls back to the
 * default; a value that parses but sits below the floor clamps UP to the
 * floor rather than falling back — the low override is exactly what lets the
 * dev smoke trigger fan-out on a problem far smaller than the real
 * threshold. */
export function fanoutMinChunks(raw: string | undefined): number {
  return parseEnvNumberWithFloor(raw, FANOUT_MIN_CHUNKS_DEFAULT, 1, true);
}

export interface FanoutGate {
  /** env.SOLVER_ENGINE_FANOUT */
  flag: string | undefined;
  /** env.ENGINE_RPC — absent on any deployment without the service binding. */
  binding: EngineRpcBinding | undefined;
  /** The improvement phase is the only caller with independent sub-problems;
   * the proof search is inherently sequential. */
  improvementPhaseActive: boolean;
  chunkCount: number;
  minChunks: number;
}

/** All four conditions, in the plan's order. Card F owns the call site. */
export function fanoutEligible(gate: FanoutGate): boolean {
  return (
    fanoutFlagOn(gate.flag) &&
    gate.binding !== undefined &&
    gate.improvementPhaseActive &&
    gate.chunkCount >= gate.minChunks
  );
}
