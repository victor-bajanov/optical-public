import type { Env } from "../env";
import { parseEnvNumberWithFloor } from "../util/env-parse";
import type { CalendarProvider } from "../providers/calendar-provider";
import { runRecurrenceSweep } from "../recurrence/sweep";
import { getCalendarSync, upsertCalendarSync, PRIMARY_CALENDAR_ID } from "../db/calendar-sync";
import { buildSolverProblem, realDurationsByChunkId } from "./build-problem";
import { computePlacementFloor, isWeekFullyPast } from "./datetime";
import { debugLog } from "../log";
import { taskBelongsInWindow } from "./task-window";
import type { SolverWeights, ContextConfig } from "./build-problem";
import { parseSolution, parseUnsatCore } from "./parse-solution";
import type { ParsedSolution } from "./parse-solution";
import { DEFAULT_BUDGETS, solveProblem, solveProblemFanout } from "../engine/engine";
import { fanoutEligible, fanoutFlagOn, fanoutMinChunks, makeFanoutSession, runSubsolve } from "../engine/fanout";
import type { EngineBudgets, EngineResult } from "../engine/types";
import { computePlanHash } from "./plan-hash";
import { insertProposedPlan, getCommittedPlanForWeek, supersedeOtherPendingPlansForWeek } from "./proposed-plans";
import { computeChurnBaseline } from "./churn-baseline";
import { ACCEPT_TTL_SECONDS } from "./accept-ttl";
import { loadBusinessHours } from "../db/business-hours";
import { loadEffectiveContexts, loadEffectiveWeights } from "../db/context-config";
import { getHomeTz, getDoneColorId } from "../db/users";
import { loadTasksByIds } from "../db/tasks";
import {
  recordChunkCompletionStmt,
  deleteChunkCompletionStmt,
  loadCompletionsByTask,
  loadCompletedChunkIdsByTask,
} from "../db/chunk-completions";
import { chunkIdsOfTask } from "./chunk-ids";
import type { Task } from "../types/task";
import type { ObjectiveComponents, Problem, Solution, UnsatResponse } from "./solver-contract";
import type { ScheduleEntry } from "../diff/compute-diff";
import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import type { CalendarEvent } from "../providers/types";
import { readMeetingConfig } from "../meetings/config";
import { syncOwnedMeetings } from "../meetings/sync";
import { computeAvailabilityWindows } from "../meetings/availability";
import { attendeeCountForChurn, constrainingAttendeeEmails, MEETING_SOURCE_KIND } from "../meetings/identify";
import type { AttendeeEnforcement } from "../meetings/identify";
import { stampMovableVerdicts } from "../meetings/movable-verdict";
import type { MovableVerdict, MovableVerdictReason } from "../meetings/movable-verdict";
import { loadMeetingPolicy } from "../db/meeting-policy";
import type { MeetingSolverInput } from "./build-problem";
import type { FreeBusyResult } from "../providers/calendar-provider";

/** Per-attempt budget for a single /solve call. A healthy solve returns in a
 *  few seconds; this generous ceiling exists only to bound a *stuck* call so a
 *  cold or restarting solver container yields a retriable error instead of a
 *  hang that propagates all the way to the upstream client (and its read
 *  timeout). Overridable per-environment via env.SOLVER_TIMEOUT_MS. */
export const SOLVER_TIMEOUT_MS = 45_000;
/** /solve is a pure function of its input, so retrying is safe. One retry
 *  absorbs the window where the container is briefly unready (sleepAfter
 *  idle-stop + ~30s cold boot) without doubling load on a healthy solver. */
export const SOLVER_MAX_ATTEMPTS = 2;

/** POST the problem to the solver with a per-attempt timeout and a bounded
 *  number of attempts. A 2xx/4xx response (including 422 unsat) is a definitive
 *  answer and is returned immediately. A **5xx** means the container is unready
 *  (cold-boot / restart) or crashed mid-request; `/solve` is pure, so we retry
 *  it and only return the final 5xx for the caller to surface as solver_error.
 *  A thrown error (abort-on-timeout or transport failure) is also retried.
 *  Throws only if every attempt threw (no HTTP response at all), so the caller
 *  can surface a clean solver_error (504). */
/** What fetchSolver knows about the call that the solver_calls row (card 1.1)
 *  needs: how many attempts it took and the container's uptime at the
 *  attempt that produced the returned response. */
interface SolverFetchOutcome {
  res: Response;
  attempts: number;
  uptimeMs: number | null;
}

async function fetchSolver(
  solver: Fetcher,
  problem: unknown,
  opts: { timeoutMs: number; attempts: number },
): Promise<SolverFetchOutcome> {
  const body = JSON.stringify(problem);
  let lastErr: unknown;
  let lastRetriableRes: SolverFetchOutcome | undefined;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await solver.fetch("https://solver/solve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      // Permanent per-attempt timing event (payload stringified into the
      // message — see log.ts for why). solver_uptime_ms comes from the
      // container's X-Solver-Uptime-Ms header: a small value means this
      // attempt paid a cold start, which is what separates container-boot
      // latency from actual solve time when read next to solver_diagnostics.
      const uptimeHeader = Number(res.headers.get("x-solver-uptime-ms"));
      console.info(
        `solver_fetch ${JSON.stringify({
          attempt,
          ms: Date.now() - t0,
          status: res.status,
          ...(Number.isFinite(uptimeHeader) ? { solver_uptime_ms: uptimeHeader } : {}),
        })}`,
      );
      const uptimeMs = Number.isFinite(uptimeHeader) ? uptimeHeader : null;
      if (res.status >= 500) {
        // Cold/restarting container: retry. Cancel the previously-kept 5xx body
        // (it is being discarded) and keep this one so a caller still gets the
        // real status/detail if we exhaust attempts without reaching a healthy
        // container. The finally-returned body is left intact for the call site.
        await lastRetriableRes?.res.body?.cancel();
        lastRetriableRes = { res, attempts: attempt, uptimeMs };
        continue;
      }
      return { res, attempts: attempt, uptimeMs };
    } catch (e) {
      lastErr = e;
      console.info(
        `solver_fetch ${JSON.stringify({ attempt, ms: Date.now() - t0, error: String(e) })}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastRetriableRes) return lastRetriableRes;
  throw new Error(`solver did not respond after ${opts.attempts} attempt(s): ${String(lastErr)}`);
}

/** Who initiated the solve — recorded per call in `solver_calls` so the
 *  container cost model can separate interactive (api) from background
 *  (webhook/cron) demand. Every caller must say which it is. */
export type ResolveTrigger = "api" | "webhook" | "cron";

/** Which solver answers a resolve (env.SOLVER_ENGINE, card G). See env.ts. */
export type SolverEngineMode = "container" | "worker" | "shadow" | "fallback";
const SOLVER_ENGINE_MODES: readonly SolverEngineMode[] = ["container", "worker", "shadow", "fallback"];

/** Distinct bad SOLVER_ENGINE values already warned about, so a misconfigured
 *  deployment logs once per isolate rather than once per resolve. */
const warnedEngineValues = new Set<string>();

/** Unset or unrecognised ⇒ "container": a typo must never silently promote the
 *  engine into the serving path, but it must not fail resolves either. */
export function engineMode(env: Env): SolverEngineMode {
  const raw = env.SOLVER_ENGINE;
  if (raw === undefined || raw.trim() === "") return "container";
  // Match on the trimmed value: "shadow " from a dashboard paste must start
  // the soak, not silently demote to container behind one warn line.
  const value = raw.trim();
  if ((SOLVER_ENGINE_MODES as readonly string[]).includes(value)) return value as SolverEngineMode;
  if (!warnedEngineValues.has(value)) {
    warnedEngineValues.add(value);
    console.warn(`solver_engine_unknown ${JSON.stringify({ value, using: "container" })}`);
  }
  return "container";
}

/** Which solver produced the answer that was SERVED (`solver_calls.engine`,
 *  `solver_diagnostics.engine`). A fallback that fell back reports "container". */
type ServingEngine = "container" | "worker";

/** Why a fallback-mode resolve abandoned the engine's answer and re-solved via
 *  the container. Contractual — `solver_fallback.reason` is read by the smoke
 *  and the soak analysis. */
type FallbackReason = "engine_error" | "engine_uncertified" | "engine_unsat_confirm" | "engine_timeout";

/** Per-environment engine budgets, mirroring the container's env-tunable
 *  SOLVER_PASS*_TIME_LIMIT_S posture (seconds; the bench runner honours the
 *  same knobs) so a soak can run both solvers at like-for-like budgets with a
 *  var flip instead of a code deploy. Unset ⇒ the engine's DEFAULT_BUDGETS
 *  (20 s per layer); node caps are not env-tunable (backstops, not knobs). */
export function engineBudgets(env: Env): EngineBudgets {
  const wall = (raw: string | undefined, fallback: number): number =>
    Math.max(1, Math.floor(parseEnvNumberWithFloor(raw, fallback / 1000, 0.001) * 1000));
  return {
    pass1: {
      ...DEFAULT_BUDGETS.pass1,
      wallMs: wall(env.SOLVER_ENGINE_PASS1_TIME_LIMIT_S, DEFAULT_BUDGETS.pass1.wallMs),
    },
    pass2: {
      ...DEFAULT_BUDGETS.pass2,
      wallMs: wall(env.SOLVER_ENGINE_PASS2_TIME_LIMIT_S, DEFAULT_BUDGETS.pass2.wallMs),
    },
    mus: {
      ...DEFAULT_BUDGETS.mus,
      wallMs: wall(env.SOLVER_ENGINE_MUS_TIME_LIMIT_S, DEFAULT_BUDGETS.mus.wallMs),
    },
  };
}

/** Wall-clock guard for the in-process engine in fallback mode. The engine is
 *  synchronous, so this CANNOT preempt it — the CPU is already spent by the time
 *  we look. It is a serving guard, not a timeout: an answer that took grossly
 *  longer than the engine's own budgets is treated as untrustworthy (its budget
 *  accounting is wrong, so its "OPTIMAL" is suspect) and the container re-solves.
 *  "Grossly" = twice the sum of the engine's wall budgets — the env-tuned ones,
 *  so retuning the budgets moves the guard with them. */
export const ENGINE_WALL_GUARD_MS =
  2 * (DEFAULT_BUDGETS.pass1.wallMs + DEFAULT_BUDGETS.pass2.wallMs + DEFAULT_BUDGETS.mus.wallMs);

/** Overridable per-environment (same posture as BOOKING_DECLINE_GRACE_MINUTES):
 *  unset/unparseable falls back to 2× the env-tuned budgets, a parseable value
 *  below 1 clamps UP to a 1 ms floor rather than disabling the guard. */
export function engineWallGuardMs(env: Env): number {
  const b = engineBudgets(env);
  const fallback = 2 * (b.pass1.wallMs + b.pass2.wallMs + b.mus.wallMs);
  return Math.floor(parseEnvNumberWithFloor(env.SOLVER_ENGINE_WALL_GUARD_MS, fallback, 1));
}

/** The engine call itself. Injectable so the mixed modes can be tested against
 *  exact statuses and crashes — the pool's module registry does not honour
 *  `vi.mock` for a module imported by the code under test, and the engine's own
 *  correctness is covered by test/engine/**. Production never passes one. */
export type EngineSolve = (
  problem: Problem,
  budgets: EngineBudgets,
) => EngineResult | Promise<EngineResult>;

/** Which in-process engine a resolve runs, picked per problem (card F).
 *
 *  Fan-out engages only when `fanoutEligible` says so — flag "true", the
 *  ENGINE_RPC binding bound, and the instance at/above the chunk threshold
 *  (the phase-active condition is enforced by construction: the batch is
 *  only ever invoked from the improvement phase, so an OPTIMAL solve makes
 *  zero RPC calls and `finish()` logs nothing). The fan-out answer is
 *  bit-identical to the sync path — the flag may change wall clock, never
 *  the answer (engine-fanout test suite) — and any RPC failure degrades to
 *  sequential inside the session, never failing the resolve. Shadow mode
 *  deliberately stays on the sync engine: its comparison line measures the
 *  sequential engine wall. */
export function defaultEngineSolve(
  env: Env,
  problem: Problem,
  callId?: string,
): { engine: EngineSolve; fanout: boolean; finish: () => void } {
  const binding = env.ENGINE_RPC;
  // The same count every log line and solver_calls row reports, so the
  // SOLVER_ENGINE_FANOUT_MIN_CHUNKS gate can be reasoned about from the
  // recorded data.
  const chunkCount = problemSizes(problem).nChunks;
  const minChunks = fanoutMinChunks(env.SOLVER_ENGINE_FANOUT_MIN_CHUNKS);
  const eligible = fanoutEligible({
    flag: env.SOLVER_ENGINE_FANOUT,
    binding,
    improvementPhaseActive: true,
    chunkCount,
    minChunks,
  });
  // The gate's decision, logged whether or not fan-out then engages: an
  // eligible resolve whose improvement phase stays idle emits no
  // engine_fanout summary, and threshold tuning has to be able to tell that
  // apart from a resolve the gate turned away. Only where the flag is on —
  // a dark deployment stays byte-silent.
  //
  // `call_id` joins the decision to its solver_calls row, the same reason
  // solver_engine_disagreement carries one: a multi-subject cron invocation
  // interleaves several resolves' lines in a single logs[] array.
  if (fanoutFlagOn(env.SOLVER_ENGINE_FANOUT)) {
    console.info(
      `engine_fanout_gate ${JSON.stringify({
        eligible,
        chunk_count: chunkCount,
        min_chunks: minChunks,
        binding_bound: binding !== undefined,
        call_id: callId,
      })}`,
    );
  }
  if (!eligible || binding === undefined) {
    return { engine: solveProblem, fanout: false, finish: () => {} };
  }
  const session = makeFanoutSession({ binding, sequential: runSubsolve });
  return {
    engine: (p, b) => solveProblemFanout(p, b, session.subsolve),
    fanout: true,
    finish: () => session.finish(),
  };
}

/** One in-process engine run, wall-timed, with exceptions captured rather than
 *  thrown: every mode that runs the engine treats a crash as data, not as a
 *  failed resolve (worker mode is the exception — it turns the captured error
 *  into a solver_error, since it has no fallback). */
type EngineRun =
  | { kind: "solution"; solution: Solution; status: string; wallMs: number }
  | { kind: "unsat"; response: UnsatResponse; wallMs: number }
  | { kind: "error"; error: string; wallMs: number };

async function runEngine(
  problem: Problem,
  budgets: EngineBudgets,
  engine: EngineSolve = solveProblem,
): Promise<EngineRun> {
  const t0 = Date.now();
  try {
    const result = await engine(problem, budgets);
    const wallMs = Date.now() - t0;
    if (result.kind === "unsat") return { kind: "unsat", response: result.response, wallMs };
    return {
      kind: "solution",
      solution: result.solution,
      status: result.solution.diagnostics.status,
      wallMs,
    };
  } catch (e) {
    return { kind: "error", error: String(e), wallMs: Date.now() - t0 };
  }
}

/** The one way a serving mode runs the in-process engine: pick (test seam,
 *  else `defaultEngineSolve`'s flag/binding/threshold gate), run, and close
 *  the fan-out session so its summary line is emitted exactly once. Shared
 *  by worker and fallback mode so the two can never diverge in fan-out
 *  behaviour. */
async function pickAndRunEngine(ctx: SolveContext): Promise<EngineRun> {
  const picked = ctx.engine
    ? { engine: ctx.engine, fanout: false, finish: () => {} }
    : defaultEngineSolve(ctx.env, ctx.problem, ctx.callId);
  const run = await runEngine(ctx.problem, engineBudgets(ctx.env), picked.engine);
  picked.finish();
  return run;
}

export interface ResolveArgs {
  env: Env;
  calendar: CalendarProvider;
  windowStart: string;
  windowEnd: string;
  accountEmail: string;
  trigger: ResolveTrigger;
  weightsOverride?: Partial<SolverWeights>;
}

/** One `solver_calls` row (migration 0038). Written after every solve that
 *  produced an HTTP response — success and 422 alike — so the demand dataset
 *  outlives the 7-day Workers Logs retention (container-retirement card 1.1).
 *  Never throws: observability must not fail a resolve.
 *
 *  `row.id` is the SAME `callId` used to key the captured problem in R2
 *  (card 3.0, `problems/<callId>.json`), so `solver_calls.id` joins directly
 *  to its captured request with no extra column. Known orphans — a captured
 *  problem with no matching row — arise four ways: (i) a transport failure
 *  on every fetchSolver attempt (no HTTP response at all, so this function is
 *  never called); (ii) a persistent 5xx that survives every retry;
 *  (iii) a non-422 4xx — (ii) and (iii) both return via the solver_error
 *  branch in runResolve, which likewise never calls recordSolverCall; and
 *  (iv) a 2xx whose body fails parseSolution, which throws after the capture
 *  but before the insert. All
 *  four captures still land in the bucket, reachable only via bucket list;
 *  out of scope for the puller. */
async function recordSolverCall(
  db: D1Database,
  row: {
    id: string;
    owner: string;
    trigger: ResolveTrigger;
    windowStart: string;
    /** null on an engine-served row: there was no HTTP call to attempt. */
    attempts: number | null;
    httpStatus: number | null;
    roundTripMs: number;
    solverUptimeMs: number | null;
    /** Which engine produced the SERVED answer (migration 0039). */
    engine: ServingEngine;
    pass1Ms: number | null;
    pass2Ms: number | null;
    status: string;
    nTasks: number;
    nChunks: number;
    nExternal: number;
    nDropped: number | null;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO solver_calls
           (id, at, owner, trigger, window_start, attempts, http_status, round_trip_ms,
            solver_uptime_ms, pass1_ms, pass2_ms, status, n_tasks, n_chunks, n_external, n_dropped,
            engine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        new Date().toISOString(),
        row.owner,
        row.trigger,
        row.windowStart,
        row.attempts,
        row.httpStatus,
        row.roundTripMs,
        row.solverUptimeMs,
        row.pass1Ms,
        row.pass2Ms,
        row.status,
        row.nTasks,
        row.nChunks,
        row.nExternal,
        row.nDropped,
        row.engine,
      )
      .run();
  } catch (e) {
    console.error(`solver_calls insert failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// The solve step: container HTTP hop, in-process engine, or one of the two
// mixed modes. Everything below produces the SAME three outcomes runResolve
// already handled inline, so the flag changes who answers — never what the
// caller sees.
// ---------------------------------------------------------------------------

/** Everything the solve needs, independent of which engine answers. */
export interface SolveContext {
  env: Env;
  db: D1Database;
  problem: Problem;
  /** Shared id: the `solver_calls` row AND the R2 problem-capture key. */
  callId: string;
  ownerSubject: string;
  windowStart: string;
  windowEnd: string;
  trigger: ResolveTrigger;
  homeTz: string;
  realDurationByChunkId: Map<string, number>;
  /** Test seam only — see EngineSolve. Unset ⇒ the real engine. */
  engine?: EngineSolve;
}

export type SolveOutcome =
  | { kind: "solution"; solution: ParsedSolution }
  | { kind: "unsat"; unsatCore: unknown }
  | { kind: "solver_error"; status: number; detail: string };

/** Threaded into the container solve when it is a fallback-mode re-solve: the
 *  single `solver_fallback` line carries BOTH walls, and only the container
 *  side knows its own. */
interface FallbackContext {
  reason: FallbackReason;
  engineWallMs: number;
  /** The engine's status, or "UNSAT" / "ERROR". */
  engineStatus: string;
  engineError?: string;
  /** Set when the engine said unsat — a container *plan* then contradicts it. */
  engineUnsat?: UnsatResponse;
  /** Set when the engine produced a plan (certified or not) — a container *422*
   *  then contradicts it. Parity can be falsified in either direction, so both
   *  flags exist and both raise the same error-level signal. */
  engineFoundPlan?: boolean;
}

function problemSizes(problem: Problem): { nTasks: number; nChunks: number; nExternal: number } {
  return {
    nTasks: problem.tasks.length,
    nChunks: problem.tasks.reduce((n, t) => n + t.chunks.length, 0),
    nExternal: problem.external_pinned.length,
  };
}

/** One `solver_fallback` line per fallen-back solve — reason + both walls. */
function logFallback(fb: FallbackContext | undefined, containerStatus: string, containerWallMs: number): void {
  if (!fb) return;
  console.warn(
    `solver_fallback ${JSON.stringify({
      reason: fb.reason,
      engine_status: fb.engineStatus,
      container_status: containerStatus,
      engine_wall_ms: fb.engineWallMs,
      container_wall_ms: containerWallMs,
      ...(fb.engineError !== undefined ? { engine_error: fb.engineError } : {}),
    })}`,
  );
}

/** The two solvers reached contradictory verdicts on the same problem — one
 *  planned the week the other called infeasible. Whichever direction it happens
 *  in, it falsifies the parity claim the whole promotion path rests on, so it is
 *  an ERROR, not a fallback note (the fallback line is logged too). The
 *  container's answer is the one served either way. */
function logDisagreement(
  ctx: SolveContext,
  fb: FallbackContext,
  containerStatus: string,
  cores: { engineUnsatCore?: unknown; containerUnsatCore?: unknown },
): void {
  console.error(
    `solver_engine_disagreement ${JSON.stringify({
      owner: ctx.ownerSubject,
      window_start: ctx.windowStart,
      call_id: ctx.callId,
      engine_status: fb.engineStatus,
      container_status: containerStatus,
      ...(cores.engineUnsatCore !== undefined ? { engine_unsat_core: cores.engineUnsatCore } : {}),
      ...(cores.containerUnsatCore !== undefined ? { container_unsat_core: cores.containerUnsatCore } : {}),
    })}`,
  );
}

/** Shadow mode: run the engine alongside the container's (already known) answer
 *  and log ONE comparison line. Never affects the CONTENT of the response; an
 *  engine crash becomes a field on that same line.
 *
 *  It DOES affect latency: runResolve has no ExecutionContext, so there is no
 *  waitUntil to defer this onto, and the engine is synchronous — every shadowed
 *  resolve pays the full engine wall on top of the container round trip before
 *  responding. That is the accepted price of the soak (shadow is never a
 *  steady state), and the reason the isolate's cpu_ms limit is raised in
 *  wrangler.toml: a CPU kill here would take down the container-served answer
 *  the caller was already owed. */
async function runAndLogShadow(
  ctx: SolveContext,
  containerStatus: string,
  containerObjectiveTotal: number | null,
  containerWallMs: number,
): Promise<void> {
  // Shadow always measures the SYNC engine: its line reports the sequential
  // engine wall, which is what the soak compares against the container.
  const run = await runEngine(ctx.problem, engineBudgets(ctx.env), ctx.engine);
  const common = {
    container_status: containerStatus,
    container_objective_total: containerObjectiveTotal,
    container_wall_ms: containerWallMs,
    engine_wall_ms: run.wallMs,
  };
  if (run.kind === "error") {
    console.info(`solver_shadow ${JSON.stringify({ ...common, engine_error: run.error })}`);
    return;
  }
  const engineStatus = run.kind === "unsat" ? "UNSAT" : run.status;
  const engineTotal = run.kind === "unsat" ? null : run.solution.objective.total;
  console.info(
    `solver_shadow ${JSON.stringify({
      engine_status: engineStatus,
      engine_objective_total: engineTotal,
      ...common,
      // Exact status equality — OPTIMAL vs FEASIBLE is a real (benign-looking)
      // difference the soak wants to see, so it is NOT folded into sat_agree,
      // which asks only the load-bearing question: plan or 422?
      status_agree: engineStatus === containerStatus,
      sat_agree: (engineStatus === "UNSAT") === (containerStatus === "UNSAT"),
      objective_agree: engineTotal !== null && containerObjectiveTotal !== null
        ? engineTotal === containerObjectiveTotal
        : null,
    })}`,
  );
}

/** Log + persist a served engine answer. Mirrors the container branch field for
 *  field so the two are comparable in one query; `attempts` and
 *  `solver_uptime_ms` are null because no HTTP call happened. */
async function serveEngineSolution(
  ctx: SolveContext,
  solution: Solution,
  wallMs: number,
): Promise<SolveOutcome> {
  const parsed = parseSolution(solution, ctx.homeTz, ctx.realDurationByChunkId);
  const d = solution.diagnostics;
  const sizes = problemSizes(ctx.problem);
  console.info(
    `solver_diagnostics ${JSON.stringify({
      pass1_wall_seconds: d.pass1_wall_seconds,
      pass2_wall_seconds: d.pass2_wall_seconds,
      status: d.status,
      ...(d.bound_gap !== undefined ? { bound_gap: d.bound_gap } : {}),
      ...(d.nodes !== undefined ? { nodes: d.nodes } : {}),
      // Search-strengthening instrumentation (additive, engine only —
      // internal design notes card A).
      ...(d.root_bound !== undefined ? { root_bound: d.root_bound } : {}),
      ...(d.root_incumbent !== undefined ? { root_incumbent: d.root_incumbent } : {}),
      ...(d.bound_lift !== undefined ? { bound_lift: d.bound_lift } : {}),
      ...(d.improve_iterations !== undefined
        ? { improve_iterations: d.improve_iterations }
        : {}),
      ...(d.improve_accepted !== undefined
        ? { improve_accepted: d.improve_accepted }
        : {}),
      ...(d.fanout_subsolves !== undefined
        ? { fanout_subsolves: d.fanout_subsolves }
        : {}),
      round_trip_ms: wallMs,
      trigger: ctx.trigger,
      attempts: null,
      solver_uptime_ms: null,
      engine: "worker",
      n_tasks: sizes.nTasks,
      n_chunks: sizes.nChunks,
      n_external: sizes.nExternal,
      n_dropped: parsed.dropped.length,
    })}`,
  );
  await recordSolverCall(ctx.db, {
    id: ctx.callId,
    owner: ctx.ownerSubject,
    trigger: ctx.trigger,
    windowStart: ctx.windowStart,
    attempts: null,
    httpStatus: null,
    roundTripMs: wallMs,
    solverUptimeMs: null,
    engine: "worker",
    pass1Ms: d.pass1_wall_seconds * 1000,
    pass2Ms: d.pass2_wall_seconds * 1000,
    status: d.status,
    nDropped: parsed.dropped.length,
    ...sizes,
  });
  return { kind: "solution", solution: parsed };
}

/** `SOLVER_ENGINE="worker"`: the engine is the only solver. No HTTP hop, and no
 *  second opinion — a crash is a solver_error, exactly as an unreachable
 *  container is. */
async function solveViaEngine(ctx: SolveContext): Promise<SolveOutcome> {
  const run = await pickAndRunEngine(ctx);
  if (run.kind === "error") {
    console.error(`solver_engine_error ${JSON.stringify({ error: run.error, wall_ms: run.wallMs })}`);
    return { kind: "solver_error", status: 500, detail: `solver engine failed: ${run.error}` };
  }
  if (run.kind === "unsat") {
    await recordSolverCall(ctx.db, {
      id: ctx.callId,
      owner: ctx.ownerSubject,
      trigger: ctx.trigger,
      windowStart: ctx.windowStart,
      attempts: null,
      httpStatus: null,
      roundTripMs: run.wallMs,
      solverUptimeMs: null,
      engine: "worker",
      pass1Ms: null,
      pass2Ms: null,
      status: "UNSAT",
      nDropped: null,
      ...problemSizes(ctx.problem),
    });
    // Same shape the container's 422 body takes, through the same parser, so
    // downstream (route → 422, email demotion) cannot tell the two apart.
    return { kind: "unsat", unsatCore: parseUnsatCore(run.response) };
  }
  return serveEngineSolution(ctx, run.solution, run.wallMs);
}

/** `SOLVER_ENGINE="fallback"`: serve the engine ONLY when it certifies its
 *  answer. First match wins:
 *    crash                → engine_error
 *    blew the wall guard  → engine_timeout
 *    unsat                → engine_unsat_confirm (container is the authority)
 *    FEASIBLE/PASS1_...   → engine_uncertified
 *    OPTIMAL              → served, container never called. */
async function solveWithFallback(ctx: SolveContext): Promise<SolveOutcome> {
  const run = await pickAndRunEngine(ctx);
  if (run.kind === "error") {
    return solveViaContainer(ctx, {
      fallback: { reason: "engine_error", engineWallMs: run.wallMs, engineStatus: "ERROR", engineError: run.error },
    });
  }
  // What the engine actually said, carried into EVERY fallback branch below —
  // the reason a fallback happened must not change whether a contradiction with
  // the container gets reported (a wall-guarded verdict is still a verdict).
  const verdict =
    run.kind === "unsat"
      ? { engineStatus: "UNSAT", engineUnsat: run.response }
      : { engineStatus: run.status, engineFoundPlan: true };

  if (run.wallMs > engineWallGuardMs(ctx.env)) {
    return solveViaContainer(ctx, {
      fallback: { reason: "engine_timeout", engineWallMs: run.wallMs, ...verdict },
    });
  }
  if (run.kind === "unsat") {
    return solveViaContainer(ctx, {
      fallback: { reason: "engine_unsat_confirm", engineWallMs: run.wallMs, ...verdict },
    });
  }
  if (run.status !== "OPTIMAL") {
    return solveViaContainer(ctx, {
      fallback: { reason: "engine_uncertified", engineWallMs: run.wallMs, ...verdict },
    });
  }
  return serveEngineSolution(ctx, run.solution, run.wallMs);
}

/** The container solve — today's path, unchanged except for the `engine` field
 *  and the two mixed-mode hooks (shadow comparison, fallback line). */
async function solveViaContainer(
  ctx: SolveContext,
  opts: { shadow?: boolean; fallback?: FallbackContext } = {},
): Promise<SolveOutcome> {
  const { env, db, problem } = ctx;
  let solverRes: Response;
  let solverFetch: SolverFetchOutcome;
  const solveStartedMs = Date.now();
  try {
    solverFetch = await fetchSolver(env.SOLVER, problem, {
      timeoutMs: parseEnvNumberWithFloor(env.SOLVER_TIMEOUT_MS, SOLVER_TIMEOUT_MS, 1),
      attempts: SOLVER_MAX_ATTEMPTS,
    });
    solverRes = solverFetch.res;
  } catch (e) {
    // Every attempt hit the per-attempt timeout (or a transport error): the
    // solver container is unready/restarting. Surface a clean gateway-timeout
    // (route maps solver_error → 502) instead of hanging the whole resolve.
    logFallback(opts.fallback, "transport_error", Date.now() - solveStartedMs);
    return { kind: "solver_error", status: 504, detail: `solver unavailable: ${String(e)}` };
  }

  // Problem sizes for the solver_calls row + diagnostics line. Counted from
  // the problem actually sent, not the D1 task set (completed chunks and
  // frozen meetings are already stripped by then).
  const sizes = problemSizes(problem);
  const solverCallBase = {
    id: ctx.callId,
    owner: ctx.ownerSubject,
    trigger: ctx.trigger,
    windowStart: ctx.windowStart,
    attempts: solverFetch.attempts,
    httpStatus: solverRes.status,
    solverUptimeMs: solverFetch.uptimeMs,
    engine: "container" as const,
    ...sizes,
  };

  if (solverRes.status === 422) {
    const containerWallMs = Date.now() - solveStartedMs;
    await recordSolverCall(db, {
      ...solverCallBase,
      roundTripMs: containerWallMs,
      pass1Ms: null,
      pass2Ms: null,
      status: "UNSAT",
      nDropped: null,
    });
    // The worker treats EVERY solver 422 as "unsat". That's correct for the
    // solver's infeasible signal (422 + unsat_core body) but would silently
    // mislabel a genuine FastAPI request-validation 422. Capture the raw body
    // (gated by DEBUG_LOG) so we can tell the two apart from the trace.
    const raw = await solverRes.json();
    debugLog(env, "dbg_solver_422", {
      owner: ctx.ownerSubject,
      windowStart: ctx.windowStart,
      windowEnd: ctx.windowEnd,
      body: raw,
    });
    const unsat = parseUnsatCore(raw);
    if (opts.shadow) await runAndLogShadow(ctx, "UNSAT", null, containerWallMs);
    logFallback(opts.fallback, "UNSAT", containerWallMs);
    if (opts.fallback?.engineFoundPlan) {
      // The engine planned this week and the container calls it infeasible —
      // the same falsification as the reverse case below, and the 422 is served.
      logDisagreement(ctx, opts.fallback, "UNSAT", { containerUnsatCore: unsat.unsat_core });
    }
    return { kind: "unsat", unsatCore: unsat };
  }
  if (!solverRes.ok) {
    const text = await solverRes.text();
    logFallback(opts.fallback, `http_${solverRes.status}`, Date.now() - solveStartedMs);
    return { kind: "solver_error", status: solverRes.status, detail: text };
  }

  const roundTripMs = Date.now() - solveStartedMs;
  const solution = parseSolution(
    await solverRes.json(),
    ctx.homeTz,
    ctx.realDurationByChunkId,
  );

  // Surface the solver's own two-pass timing next to the worker-side round
  // trip (all attempts + retries, up to response headers). pass1 = candidate
  // search, pass2 = optimality proof; status FEASIBLE means pass 2 was
  // abandoned (stall/time limit) before optimality was proven. Without this
  // line the diagnostics are parsed and then discarded — they appear in no
  // log and no stored plan.
  // The same fields go to D1 (solver_calls) so the dataset outlives the log
  // retention; the log line keeps live tailing useful.
  console.info(
    `solver_diagnostics ${JSON.stringify({
      pass1_wall_seconds: solution.diagnostics.pass1_wall_seconds,
      pass2_wall_seconds: solution.diagnostics.pass2_wall_seconds,
      status: solution.diagnostics.status,
      round_trip_ms: roundTripMs,
      trigger: ctx.trigger,
      attempts: solverFetch.attempts,
      solver_uptime_ms: solverFetch.uptimeMs,
      engine: "container",
      n_tasks: sizes.nTasks,
      n_chunks: sizes.nChunks,
      n_external: sizes.nExternal,
      n_dropped: solution.dropped.length,
    })}`,
  );
  await recordSolverCall(db, {
    ...solverCallBase,
    roundTripMs,
    pass1Ms: solution.diagnostics.pass1_wall_seconds * 1000,
    pass2Ms: solution.diagnostics.pass2_wall_seconds * 1000,
    status: solution.diagnostics.status,
    nDropped: solution.dropped.length,
  });

  if (opts.shadow) {
    await runAndLogShadow(ctx, solution.diagnostics.status, solution.objective.total, roundTripMs);
  }
  if (opts.fallback) {
    logFallback(opts.fallback, solution.diagnostics.status, roundTripMs);
    if (opts.fallback.engineUnsat) {
      // The engine called this week infeasible and the container planned it.
      // The container's plan is still served.
      logDisagreement(ctx, opts.fallback, solution.diagnostics.status, {
        engineUnsatCore: opts.fallback.engineUnsat.unsat_core,
      });
    }
  }
  return { kind: "solution", solution };
}

/** Route the solve to whichever engine `SOLVER_ENGINE` selects. */
export async function solveForResolve(ctx: SolveContext): Promise<SolveOutcome> {
  const mode = engineMode(ctx.env);
  if (mode === "worker") return solveViaEngine(ctx);
  if (mode === "fallback") return solveWithFallback(ctx);
  return solveViaContainer(ctx, { shadow: mode === "shadow" });
}

export interface ResolveBody {
  schedule: Array<{ task_id: string; chunk_id: string; start: string; end: string; context: string }>;
  dropped: Array<{ task_id: string; title: string; drop_cost: number; reason: string; contributing_constraints: string[] }>;
  window: { start: string; end: string };
  weights: SolverWeights;
  objective: { total: number; components: ObjectiveComponents };
  account_email: string;
  warnings?: string[];
}

export interface ExternalEvent { id: string; title: string; start: string; end: string }

export type ResolveResult =
  // meetingTaskIds: task ids of the owned-meeting rows (source.kind ===
  // "meeting") promoted into this plan's schedule — the email model keys the
  // "Meeting" chip on these, never on entry.context (also a user task category).
  | { kind: "ok"; planHash: string; body: ResolveBody; priorEvents: ScheduleEntry[]; externalEvents: ExternalEvent[]; meetingTaskIds: string[] }
  | { kind: "unsat"; unsatCore: unknown }
  | { kind: "solver_error"; status: number; detail: string };

export async function loadWeights(db: D1Database, ownerSubject: string): Promise<SolverWeights> {
  // Own row wins; else the instance default ('__default__'). Config is not
  // isolation-sensitive (brief A), so a missing user row falls back, never fails.
  return (await loadEffectiveWeights(db, ownerSubject)).weights;
}

async function loadContexts(db: D1Database, ownerSubject: string): Promise<ContextConfig[]> {
  // Per-context effective set: for each known context the owner's row if
  // present, else the '__default__' row (db/context-config.ts).
  return (await loadEffectiveContexts(db, ownerSubject)).map((e) => e.config);
}

async function loadPendingTasks(
  db: D1Database,
  ownerSubject: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<Task[]> {
  if (!ownerSubject) throw new Error("owner_scope_missing");
  // id, created_at, updated_at, template_id, scheduled_for live in columns;
  // body holds the rest. Materialised template instances store no id inside
  // body — merge from columns. template_id is read from its column (set
  // authoritatively by the recurrence sweep) and scheduled_for is the
  // system-owned commit stamp; neither is part of the user-facing Task body and
  // scheduled_for is deliberately never merged into Task (it must not reach the
  // solver problem or the resolve response).
  const r = await db
    .prepare(
      "SELECT id, body, template_id, scheduled_for, created_at, updated_at FROM tasks WHERE status IN ('pending', 'scheduled', 'committed') AND owner_subject = ?",
    )
    .bind(ownerSubject)
    .all<{
      id: string;
      body: string;
      template_id: string | null;
      scheduled_for: string | null;
      created_at: string;
      updated_at: string;
    }>();
  const rows = (r.results ?? []).map((row) => ({
    task: {
      ...(JSON.parse(row.body) as Task),
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    template_id: row.template_id,
    scheduled_for: row.scheduled_for,
  }));

  // Window-relative shedding: keep only tasks that belong to this window. A
  // shed task is excluded from the solver input only — its status and DB row
  // are untouched, so it still appears in GET /v1/tasks. See
  // internal design notes.
  const nowMs = Date.now();
  const kept = rows.filter(({ task, template_id, scheduled_for }) =>
    taskBelongsInWindow(
      {
        pinned_at: task.pinned_at,
        scheduled_for,
        earliest_start: task.earliest_start,
        template_id,
        deadline: task.deadline,
      },
      windowStartMs,
      windowEndMs,
      nowMs,
    ),
  );

  // One observability line per resolve. This counts PAST tasks excluded from
  // the window (window-relative shedding), NOT solver drop-exploration.
  // Non-dotted event name so Cloudflare logfwd does not mangle the fingerprint.
  console.info("resolve_window_shed", {
    excluded_past: rows.length - kept.length,
    kept: kept.length,
  });

  return kept.map(({ task }) => task);
}

/** Reconcile chunk_completions against the in-window calendar colors: record
 *  newly done-colored chunks, revive (delete) confirmed records whose event is
 *  present and off the done color, flip task status (fully-done → 'done';
 *  revived → 'pending'), and re-load revived tasks that belong in the window.
 *  Pure D1 + already-fetched events; no solver, no email. This is the SINGLE
 *  home for record + revive + status-flip logic, called by both the live path
 *  and the fully-past-week early-return path (per-chunk-completion DC4).
 *  The returned `completedByTask` is the post-revive chunk-level set per task; it
 *  does NOT by itself convey task-level done status (a task is done only when its
 *  full chunk set — chunkIdsOfTask — is present, which this function applies to
 *  the D1 status flip but the caller must re-derive for solver dropping). */
async function reconcileChunkCompletions(
  db: D1Database,
  env: Env,
  ownerSubject: string,
  events: CalendarEvent[],
  windowStartMs: number,
  windowEndMs: number,
  // Provider-shaped floor under users.done_color_id, above env.DONE_COLOR_ID
  // (calendar.defaultDoneColorId ?? env.DONE_COLOR_ID ?? "" — resolved by both
  // call sites, since this function receives no CalendarProvider). See
  // calendar-provider.ts's defaultDoneColorId doc comment (Card H).
  defaultDoneColorId: string,
): Promise<{ completedByTask: Map<string, Set<string>>; revivedTasks: Task[] }> {
  const nowIso = new Date().toISOString();
  // The user's done color. If misconfigured to "" we never record/keep-by-color
  // (every color comparison is gated on doneColorId !== "").
  const doneColorId = await getDoneColorId(db, ownerSubject, defaultDoneColorId);

  // Scan the window's scheduler-owned events. External events (no chunk id) are
  // ignored — their color is the user's own and unrelated to us. One chunk id
  // can map to SEVERAL events (a stray duplicate — the 2026-07-06 incident), so
  // keep them all: collapsing to one entry let whichever event happened to sort
  // last mask the others' colors.
  const schedulerTaskIds = new Set<string>();
  const inWindowChunkEvents = new Map<string, CalendarEvent[]>();
  const taskIdOfChunk = new Map<string, string>();
  for (const e of events) {
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
    if (!chunkId) continue;
    const hashIdx = chunkId.lastIndexOf("#");
    const taskId = hashIdx >= 0 ? chunkId.slice(0, hashIdx) : chunkId;
    schedulerTaskIds.add(taskId);
    const list = inWindowChunkEvents.get(chunkId) ?? [];
    list.push(e);
    inWindowChunkEvents.set(chunkId, list);
    taskIdOfChunk.set(chunkId, taskId);
  }

  // 1. RECORD: a scheduler chunk painted the done color gets an (idempotent)
  // completion record. INSERT OR IGNORE keeps re-records a no-op. One db.batch
  // for all N chunks instead of N sequential round-trips. `color_confirmed_at`
  // is set EQUAL to `done_at` for color-sourced records — the color IS the
  // confirmation, so there is no later confirmation step to wait on. The
  // confirming event's id is stamped on the record so the later revive can be
  // gated to THAT event.
  const recordStmts: D1PreparedStatement[] = [];
  for (const [chunkId, chunkEvents] of inWindowChunkEvents) {
    const doneEvent = doneColorId !== "" ? chunkEvents.find((e) => e.colorId === doneColorId) : undefined;
    if (doneEvent) {
      const taskId = taskIdOfChunk.get(chunkId)!;
      recordStmts.push(recordChunkCompletionStmt(db, ownerSubject, taskId, chunkId, nowIso, "color", nowIso, doneEvent.id));
    }
  }
  if (recordStmts.length > 0) await db.batch(recordStmts);
  const recorded = recordStmts.length;

  // 2. REVIVE: delete a chunk's record ONLY with positive evidence of an un-paint
  // — the record is color-confirmed AND the event WHOSE COLOR CONFIRMED IT is
  // present in-window AND now OFF the done color. A failed-recolor record
  // (color_confirmed_at NULL), a deleted-event record (confirming event absent),
  // or a still-done-colored chunk is never revived; nor is a record whose chunk
  // id is carried by some OTHER event (a stray duplicate's color is not evidence
  // the user re-opened the work). A legacy record with no event_id falls back to
  // the pre-0028 any-event rule, tightened to require EVERY in-window event off
  // the done color. Runs BEFORE the fully-done classification so a just-revived
  // chunk can't count toward "done".
  const completionRows = await loadCompletionsByTask(db, ownerSubject, [...schedulerTaskIds]);
  const revivedTaskIds = new Set<string>();
  const deleteStmts: D1PreparedStatement[] = [];
  for (const rows of completionRows.values()) {
    for (const row of rows) {
      if (!row.color_confirmed_at) continue; // not color-confirmed → never revive
      const chunkEvents = inWindowChunkEvents.get(row.chunk_id);
      if (!chunkEvents || chunkEvents.length === 0) continue; // event absent → never revive
      if (row.event_id) {
        const confirming = chunkEvents.find((e) => e.id === row.event_id);
        if (!confirming) continue; // confirming event not in this window → no evidence
        if (doneColorId !== "" && confirming.colorId === doneColorId) continue; // still done-colored
      } else if (doneColorId !== "" && chunkEvents.some((e) => e.colorId === doneColorId)) {
        continue; // legacy record; a surviving done-colored event says the completion stands
      }
      deleteStmts.push(deleteChunkCompletionStmt(db, ownerSubject, row.chunk_id));
      revivedTaskIds.add(row.task_id);
    }
  }
  if (deleteStmts.length > 0) await db.batch(deleteStmts);
  if (revivedTaskIds.size > 0) {
    await db.batch(
      [...revivedTaskIds].map((taskId) =>
        db
          .prepare(
            "UPDATE tasks SET status = 'pending', scheduled_for = NULL, updated_at = ? WHERE id = ? AND owner_subject = ? AND status = 'done'",
          )
          .bind(nowIso, taskId, ownerSubject),
      ),
    );
  }

  // 3. FULLY-DONE FLIP: a task flips to 'done' only when EVERY chunk id it owns
  // has a completion record (computed AFTER the revive deletes). We need the task
  // bodies to know the full chunk set, so load them by id.
  const completedByTask = await loadCompletedChunkIdsByTask(db, ownerSubject, [...schedulerTaskIds]);
  const taskBodies = await loadTasksByIds(db, ownerSubject, [...schedulerTaskIds]);
  const fullyDoneIds: string[] = [];
  for (const task of taskBodies) {
    const completed = completedByTask.get(task.id);
    if (!completed) continue;
    if (chunkIdsOfTask(task).every((cid) => completed.has(cid))) fullyDoneIds.push(task.id);
  }
  if (fullyDoneIds.length > 0) {
    await db.batch(
      fullyDoneIds.map((taskId) =>
        db
          .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND owner_subject = ?")
          .bind(nowIso, taskId, ownerSubject),
      ),
    );
  }

  // 4. REVIVED RE-LOAD: re-fetch the revived task bodies and keep only those that
  // belong in this window, so the live caller can re-feed them to the solver.
  const revivedTasks = (await loadTasksByIds(db, ownerSubject, [...revivedTaskIds])).filter((t) =>
    taskBelongsInWindow(
      {
        pinned_at: t.pinned_at,
        // A revived task's commit stamp is intentionally cleared (the revive
        // UPDATE sets scheduled_for = NULL), so it re-enters the backlog fresh.
        scheduled_for: null,
        earliest_start: t.earliest_start,
        // Pass the task's REAL template_id: a recurring occurrence stores it in
        // the body (materialiser-written), so it survives loadTasksByIds.
        // taskBelongsInWindow gates the earliest_start anchor on template_id !=
        // null, so a recurring occurrence whose only window anchor IS its
        // earliest_start would be loosely admitted under a hardcoded null.
        template_id: t.template_id ?? null,
        deadline: t.deadline,
      },
      windowStartMs,
      windowEndMs,
      Date.parse(nowIso),
    ),
  );

  debugLog(env, "dbg_resolve_chunk_reconcile", {
    owner: ownerSubject,
    doneColorId,
    schedulerTaskIds: [...schedulerTaskIds],
    recorded,
    revived: [...revivedTaskIds],
    fullyDone: fullyDoneIds,
  });

  return { completedByTask, revivedTasks };
}

export async function runResolve(args: ResolveArgs): Promise<ResolveResult> {
  const { env, calendar, windowStart, windowEnd, weightsOverride, trigger } = args;
  // The owner scope is the email = subject = owner. Server-initiated callers
  // (cron/admin/webhook) may omit it and fall back to the connected account;
  // the HTTP /resolve route always supplies the token subject, so the scope is
  // unspoofable there. `accountEmail` (the response field) is this same value.
  const ownerSubject = args.accountEmail;
  const accountEmail = ownerSubject;
  const db = env.DB;

  debugLog(env, "dbg_resolve_start", { owner: ownerSubject, windowStart, windowEnd });

  // Fully-past-week guard (spec item 4). The week-iterating callers (webhook
  // replan, Monday cron) can hand us a week whose window has already elapsed —
  // e.g. a human edit to an event in a prior local week. Resolving it would set
  // placementFloor (= ceilToQuarter(now)) past windowEnd and the solver would
  // mass-drop every task. Wiring the guard HERE (not in each caller) means every
  // caller is covered uniformly: skip the week entirely BEFORE the recurrence
  // sweep, task load, calendar fetch and solver call. We return an empty
  // diff-clean plan (no schedule, no prior events, NOT persisted) so callers'
  // existing "ok" path computes an empty diff and naturally no-ops. Current/
  // future weeks (windowEnd > now) fall through unchanged.
  if (isWeekFullyPast(windowEnd, new Date().toISOString())) {
    debugLog(env, "dbg_resolve_fully_past", { owner: ownerSubject, windowEnd });
    // A fully-past week can still carry a repaint the user made after the week
    // elapsed (a done-color paint, or an un-paint). Honor it: fetch the window
    // and run the SAME reconcile as the live path before short-circuiting. We
    // ignore the return — the past path needs only the D1 status flips, never a
    // solve. The returned body shape below is unchanged.
    const pastRead = await calendar.fetchEventsInWindow(windowStart, windowEnd);
    await reconcileChunkCompletions(
      db,
      env,
      ownerSubject,
      pastRead.events,
      Date.parse(windowStart),
      Date.parse(windowEnd),
      calendar.defaultDoneColorId ?? env.DONE_COLOR_ID ?? "",
    );
    const body: ResolveBody = {
      schedule: [],
      dropped: [],
      window: { start: windowStart, end: windowEnd },
      weights: await loadWeights(db, ownerSubject),
      objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0, preferred_window: 0 } },
      account_email: accountEmail,
    };
    // Deterministic hash of the empty plan. NOT inserted into proposed_plans —
    // a skipped week has no plan to accept; callers short-circuit on the empty
    // diff before ever using this hash to sign an accept link.
    const planHash = await computePlanHash(body as unknown as Record<string, unknown>);
    return { kind: "ok", planHash, body, priorEvents: [], externalEvents: [], meetingTaskIds: [] };
  }

  // Per-user timezone (brief B): the owner's home_tz if set, else env.SCHEDULER_TZ.
  const homeTz = await getHomeTz(db, ownerSubject, env.SCHEDULER_TZ);

  // pre-solve sweep materialises this owner's template instances before we read tasks.
  await runRecurrenceSweep(db, ownerSubject, windowStart, windowEnd, homeTz);

  const windowStartMs = Date.parse(windowStart);
  const windowEndMs = Date.parse(windowEnd);
  const [weights, contexts, tasks, businessHours] = await Promise.all([
    loadWeights(db, ownerSubject),
    loadContexts(db, ownerSubject),
    loadPendingTasks(db, ownerSubject, windowStartMs, windowEndMs),
    loadBusinessHours(db, ownerSubject),
  ]);

  const sync = await getCalendarSync(db, ownerSubject, PRIMARY_CALENDAR_ID);
  const calRead = await calendar.fetchEventsInWindow(windowStart, windowEnd);
  if (calRead.nextSyncToken && calRead.nextSyncToken !== sync?.next_sync_token) {
    await upsertCalendarSync(db, ownerSubject, PRIMARY_CALENDAR_ID, { next_sync_token: calRead.nextSyncToken });
  }

  // --- Owned movable meetings (feature-gated) -------------------------------
  // syncOwnedMeetings mirrors owned movable meetings in the fetched window into
  // tasks rows (like runRecurrenceSweep materialises templates). loadPendingTasks
  // already ran BEFORE the calendar fetch, so any rows the sweep just created are
  // not in `tasks` yet — re-load the meeting rows and stage them in
  // `extraMeetingRows` to merge into candidateTasks below. Solver inputs +
  // diff-baseline are computed after solverTasks is known.
  const meetingConfig = readMeetingConfig(env);
  const meetingInputs: MeetingSolverInput[] = [];
  const meetingWarnings: string[] = [];
  // Meeting diff-baseline entries (current calendar position), keyed like a chunk
  // `${taskId}#0`, pushed into priorEvents so an unmoved meeting shows no change.
  const meetingBaseline: ScheduleEntry[] = [];
  let extraMeetingRows: Task[] = [];

  if (meetingConfig.enabled) {
    await syncOwnedMeetings(
      db,
      calendar,
      ownerSubject,
      calRead.events,
      windowStartMs,
      windowEndMs,
      { churnMultiplierCap: meetingConfig.churnMultiplierCap },
    );
    // Re-load pending tasks to pick up meeting rows the sweep just created, and
    // keep only the meeting rows not already loaded into `tasks`.
    const reloaded = await loadPendingTasks(db, ownerSubject, windowStartMs, windowEndMs);
    const haveIds = new Set(tasks.map((t) => t.id));
    extraMeetingRows = reloaded.filter(
      (t) => t.source?.kind === MEETING_SOURCE_KIND && !haveIds.has(t.id),
    );
  }

  // The scheduler-owned events already on the calendar in this window are the
  // committed truth. They — not a global stored plan — are the diff baseline.
  const priorEvents: ScheduleEntry[] = calRead.events
    .filter((e) => e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY])
    .map((e) => {
      const chunkId = e.extendedProperties!.private![SCHEDULER_CHUNK_ID_KEY]!;
      const hashIdx = chunkId.lastIndexOf("#");
      return {
        chunk_id: chunkId,
        task_id: hashIdx >= 0 ? chunkId.slice(0, hashIdx) : chunkId,
        // Normalize to canonical ISO-Z for display consistency: the diff email
        // renders these baseline times verbatim next to the proposed schedule
        // (also .toISOString()), so an un-normalized offset-form value from
        // Google (e.g. +10:00) would render inconsistently. The diff comparison
        // itself is instant-based (computePlanDiff), so correctness no longer
        // depends on this normalization.
        start: new Date(e.start).toISOString(),
        end: new Date(e.end).toISOString(),
        context: "", // diff keys on chunk_id and compares start/end only; context unused
      };
    });

  let externalEvents: ExternalEvent[] = calRead.events
    .filter((e) => !e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY])
    .map((e) => ({
      id: e.id,
      title: e.summary,
      start: new Date(e.start).toISOString(),
      end: new Date(e.end).toISOString(),
    }));

  // Per-chunk completion reconcile (the SINGLE home for record + revive +
  // status-flip). A scheduler chunk painted the done color earns a durable
  // chunk_completions record; a color-confirmed record whose event is present
  // and now off the done color is revived (deleted). A task flips to 'done' only
  // when EVERY chunk it owns is recorded; a revived task flips back to 'pending'.
  const { completedByTask, revivedTasks } = await reconcileChunkCompletions(
    db,
    env,
    ownerSubject,
    calRead.events,
    windowStartMs,
    windowEndMs,
    calendar.defaultDoneColorId ?? env.DONE_COLOR_ID ?? "",
  );

  // Build the solver input: start from the window's pending tasks, add back any
  // revived task not already present, then drop tasks that are now fully-done
  // (every chunk recorded). The completed chunk ids of the SURVIVING tasks are
  // handed to the solver so it places only the remaining work.
  const present = new Set(tasks.map((t) => t.id));
  const candidateTasks = [
    ...tasks,
    ...extraMeetingRows,
    ...revivedTasks.filter((t) => !present.has(t.id) && !extraMeetingRows.some((m) => m.id === t.id)),
  ];
  const isFullyDone = (t: Task): boolean => {
    const completed = completedByTask.get(t.id);
    if (!completed) return false;
    return chunkIdsOfTask(t).every((cid) => completed.has(cid));
  };
  const solverTasks = candidateTasks.filter((t) => !isFullyDone(t));
  const completedChunkIds = new Set<string>();
  for (const t of solverTasks) {
    const completed = completedByTask.get(t.id);
    if (completed) for (const cid of completed) completedChunkIds.add(cid);
  }

  // Churn baseline must be THIS owner's committed plan, never another
  // tenant's — runResolve is already scoped to ownerSubject above — and it must
  // be the plan for the week being resolved, not whichever plan was committed
  // most recently (an internal issue). computeChurnBaseline window-filters it and, when
  // nothing survives, falls back to the scheduler-owned events already on the
  // calendar. Reading priorEvents BEFORE the meeting-baseline push below keeps
  // meeting entries out of the fallback; build-problem overwrites a promoted
  // meeting's anchor with its live slot regardless, so that ordering is
  // defense in depth rather than a live hazard.
  // SCHEDULER_TZ, not homeTz: week identity must use the tz that produced the
  // window, and every producer anchors on SCHEDULER_TZ (see
  // getCommittedPlanForWeek).
  const weekPlan = await getCommittedPlanForWeek(db, ownerSubject, windowStart, env.SCHEDULER_TZ);
  const previousSchedule = computeChurnBaseline({
    weekPlanSchedule: weekPlan?.body.schedule as ResolveBody["schedule"] | undefined,
    priorEvents,
    windowStartMs,
    windowEndMs,
  });

  // SELECTION and FETCH above use the full week window. PLACEMENT is floored at
  // `now`: nothing is scheduled onto an already-elapsed day or slot. For a
  // current week the floor is ceilToQuarter(now); for a future week (now <
  // windowStart) it collapses to windowStart, leaving behavior unchanged.
  const placementFloor = computePlacementFloor(windowStart, new Date().toISOString());

  // --- Build meeting solver inputs + diff baseline (feature-gated) -----------
  // Partition the solver's meeting tasks, fetch accepted-attendee free/busy in a
  // single call, compute a per-meeting availability mask, and stage a diff
  // baseline. Imminent meetings (start < now + minNotice) are NOT promoted: with
  // no MeetingSolverInput their event stays in external_pinned as a busy block.
  if (meetingConfig.enabled) {
    const meetingTasks = solverTasks.filter((t) => t.source?.kind === MEETING_SOURCE_KIND);
    const eventById = new Map(calRead.events.map((e) => [e.id, e]));
    const nowMs = Date.now();
    const userMeetingPolicy = await loadMeetingPolicy(db, ownerSubject);

    // Cascade stability: a meeting Optical committed-moved within the window is
    // held at its slot — exclude it from the movable set so it falls through to
    // the frozen (external_pinned) path. Stamp lives in a column
    // (last_committed_move_at), not the Task body, so re-query it here.
    const stabilityMs = meetingConfig.commitStabilityMinutes * 60_000;
    const moveStampById = new Map<string, number>();
    const meetingTaskIds = meetingTasks.map((t) => t.id);
    if (meetingTaskIds.length > 0) {
      const ph = meetingTaskIds.map(() => "?").join(", ");
      const { results } = await db
        .prepare(`SELECT id, last_committed_move_at FROM tasks WHERE owner_subject = ? AND id IN (${ph})`)
        .bind(ownerSubject, ...meetingTaskIds)
        .all<{ id: string; last_committed_move_at: string | null }>();
      for (const r of results) {
        if (r.last_committed_move_at) moveStampById.set(r.id, Date.parse(r.last_committed_move_at));
      }
    }

    // Every freeze below is otherwise invisible outside this resolve: it just
    // drops the meeting from the promoted set, leaving the row in D1 looking
    // exactly like a movable one. Record the verdict per task and persist it at
    // the end of the block, so the booking page can tell "Optical will move
    // this" from "Optical has frozen this" (bookable-over.ts).
    const verdictAt = new Date(nowMs).toISOString();
    const verdicts = new Map<string, MovableVerdict>();
    const freeze = (taskId: string, reason: MovableVerdictReason) =>
      verdicts.set(taskId, { at: verdictAt, ok: false, reason });

    const movable: { task: Task; event: CalendarEvent }[] = [];
    for (const task of meetingTasks) {
      const event = task.source?.external_id ? eventById.get(task.source.external_id) : undefined;
      if (event == null) {
        freeze(task.id, "event_missing");
        continue;
      }
      // Both tests are the exact negation of the keep-predicates they replace,
      // written that way round so an unparseable timestamp (NaN, every
      // comparison false) still freezes rather than sliding into the movable set.
      if (!(Date.parse(event.start) >= nowMs + meetingConfig.minNoticeMinutes * 60_000)) {
        freeze(task.id, "imminent_notice");
        continue;
      }
      const stamp = moveStampById.get(task.id);
      if (!(stamp === undefined || nowMs - stamp >= stabilityMs)) {
        freeze(task.id, "commit_stability");
        continue;
      }
      movable.push({ task, event });
    }

    // Union of attendee emails across all movable meetings under the WIDEST
    // policy (not_declined) → one queryFreeBusy call, so the data is available
    // for whatever per-meeting policy applies below. A failure (scope not
    // consented / transport) leaves the map empty so every attendee reads as
    // unknown.
    const allEmails = [...new Set(movable.flatMap((x) => constrainingAttendeeEmails(x.event, "not_declined")))];
    let freeBusy = new Map<string, FreeBusyResult>();
    if (allEmails.length > 0) {
      try {
        freeBusy = await calendar.queryFreeBusy(allEmails, { start: windowStart, end: windowEnd });
      } catch (e) {
        debugLog(env, "dbg_freebusy_failed", { owner: ownerSubject, error: String(e) });
      }
    }

    for (const { task, event } of movable) {
      const policy =
        (task.attendee_enforcement as AttendeeEnforcement | null | undefined) ?? userMeetingPolicy;
      const emails = constrainingAttendeeEmails(event, policy);
      // An EMPTY constraining set means "nobody's availability is known", never
      // "nobody's availability matters": the free/busy loop below simply does
      // not run, so hasUnknown stays false and the mask degenerates to plain
      // business hours — the solver would then relocate the meeting anywhere.
      // It happens whenever no attendee's responseStatus is in the effective
      // policy: an 'accepted'/'accepted_or_tentative' policy where nobody has
      // accepted yet (a freshly confirmed public booking is exactly this — one
      // external attendee on needsAction), or an attendee whose responseStatus
      // Google omitted, which is outside every policy. Freeze it on the same
      // path as unreadable free/busy: we know no more here than there.
      if (emails.length === 0) {
        meetingWarnings.push(`${event.summary}: attendee_availability_unknown`);
        freeze(task.id, "no_constraining_attendees");
        continue;
      }
      const busy: { start: string; end: string }[] = [];
      let hasUnknown = false;
      for (const email of emails) {
        const r = freeBusy.get(email);
        if (!r || "error" in r) hasUnknown = true;
        else busy.push(...r.busy);
      }
      // Degrade-to-immovable: if ANY constraining attendee's free/busy is
      // unreadable (calendar.freebusy not consented / 403, a private calendar /
      // notFound, a transient upstream error / 5xx, or a thrown query leaving the
      // map empty), we cannot confirm a new slot is free for the whole party — so
      // we must NOT relocate the meeting. Surface the warning and leave it frozen
      // at its real slot by dropping it from the promoted set: with no
      // MeetingSolverInput it is excluded from the solver tasks, and its real
      // event stays in external_pinned as a busy block (never re-placed, never
      // re-notified) — exactly the imminent/stability freeze path. A later
      // resolve where free/busy reads cleanly will promote it again.
      if (hasUnknown) {
        meetingWarnings.push(`${event.summary}: attendee_availability_unknown`);
        freeze(task.id, "attendee_availability_unknown");
        continue;
      }
      const durationMinutes = Math.max(15, Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000));
      const { windows, warnings } = computeAvailabilityWindows({
        tz: homeTz,
        businessHours,
        windowStartMs,
        windowEndMs,
        nowMs,
        minNoticeMs: meetingConfig.minNoticeMinutes * 60_000,
        currentStartMs: Date.parse(event.start),
        currentEndMs: Date.parse(event.end),
        durationMinutes,
        acceptedBusy: busy,
        hasUnknownAttendees: hasUnknown,
      });
      for (const w of warnings) meetingWarnings.push(`${event.summary}: ${w}`);
      // Defense in depth: a promoted meeting MUST carry a non-empty availability
      // mask. The solver reads an empty mask as UNCONSTRAINED and would relocate
      // the meeting to any business-hours slot regardless of attendee free/busy.
      // computeAvailabilityWindows unions the current slot so this cannot happen,
      // but if it ever did (e.g. a future rounding regression), freeze the meeting
      // — the same safe path as unknown free/busy — rather than emit an
      // unconstrained move.
      if (windows.length === 0) {
        meetingWarnings.push(`${event.summary}: attendee_availability_unknown`);
        freeze(task.id, "no_availability_windows");
        continue;
      }
      verdicts.set(task.id, { at: verdictAt, ok: true, reason: null });
      meetingInputs.push({
        taskId: task.id,
        eventId: event.id,
        currentStartISO: new Date(event.start).toISOString(),
        durationMinutes,
        availabilityWindowsISO: windows,
        churnMultiplier: attendeeCountForChurn(event, meetingConfig.churnMultiplierCap),
      });
      meetingBaseline.push({
        chunk_id: `${task.id}#0`,
        task_id: task.id,
        start: new Date(event.start).toISOString(),
        end: new Date(event.end).toISOString(),
        context: "",
      });
    }

    // Persist the verdicts in one batch. Best-effort: this is a read-side hint
    // for the booking page, never a precondition of the plan, so a write failure
    // must not fail the resolve — a missed stamp ages out of the freshness
    // window and the booking page falls back to offering nothing.
    try {
      await stampMovableVerdicts(db, ownerSubject, verdicts);
    } catch (e) {
      debugLog(env, "dbg_movable_verdict_stamp_failed", { owner: ownerSubject, error: String(e) });
    }
  }

  // Meeting rows are not scheduler-chunk events, so they are absent from
  // priorEvents above; seed their current calendar slot as the diff baseline so
  // a meeting that stays put renders as "no change".
  priorEvents.push(...meetingBaseline);

  // Exclude meeting task rows (source.kind === MEETING_SOURCE_KIND) from the
  // solver problem UNLESS they are being actively promoted to movable this
  // resolve (their id is a meetingInputs[].taskId). This runs UNCONDITIONALLY:
  // - flag OFF (or feature gate skipped) ⇒ meetingInputs is empty ⇒ the
  //   promoted set is empty ⇒ EVERY meeting row is dropped from the solver set.
  // - a frozen/imminent meeting (filtered out of `movable`) has no
  //   MeetingSolverInput ⇒ it is dropped too.
  // A dropped meeting's real calendar event still appears as a busy block in
  // external_pinned (build-problem only removes promoted meetings' events), so
  // it is frozen at its real slot — never re-placed, never re-notified.
  // Promoted meetings remain so build-problem can stamp mask/churn/anchor and
  // place them.
  const promotedMeetingTaskIds = new Set(meetingInputs.map((m) => m.taskId));
  const solverTasksForProblem = solverTasks.filter(
    (t) => t.source?.kind !== MEETING_SOURCE_KIND || promotedMeetingTaskIds.has(t.id),
  );

  // A promoted meeting is rendered in the diff as its own "[Meeting]" scheduler
  // card (moved-from/moved-to via meetingBaseline). Drop its raw calendar event
  // from externalEvents so the email + accept-UI don't ALSO show it as a plain
  // external entry — otherwise the meeting renders twice. Mirrors build-problem
  // stripping the same event from external_pinned. Frozen (non-promoted) meetings
  // are NOT in meetingInputs, so their event correctly stays as their sole card.
  const promotedMeetingEventIds = new Set(meetingInputs.map((m) => m.eventId));
  externalEvents = externalEvents.filter((e) => !promotedMeetingEventIds.has(e.id));

  const problem = buildSolverProblem({
    tasks: solverTasksForProblem,
    completedChunkIds,
    externalEvents: calRead.events,
    previousSchedule,
    window: { start: windowStart, end: windowEnd },
    placementFloor,
    weights,
    contexts,
    tz: homeTz,
    weightsOverride,
    businessHours,
    tentativeIsBusy: env.TENTATIVE_IS_BUSY === "true",
    meetingInputs,
    meetingMinNoticeMinutes: meetingConfig.minNoticeMinutes,
  });

  // Card 3.0: the id doubles as the R2 capture key (problems/<callId>.json)
  // and the solver_calls row id, so a captured problem always joins to its
  // recorded outcome (see recordSolverCall's doc comment for the orphan case).
  const callId = crypto.randomUUID();
  if (env.SOLVER_CAPTURE_PROBLEMS === "true" && env.SOLVER_CAPTURE) {
    // Best-effort, before the solve: a 422 or transport failure is often the
    // most valuable case for the Stage 3 parity corpus, so the put must not
    // wait on (or depend on) a successful solve. Never blocks/fails the resolve.
    try {
      await env.SOLVER_CAPTURE.put(
        `problems/${callId}.json`,
        JSON.stringify({
          env: env.DEPLOY_ENV ?? "unknown",
          call_id: callId,
          captured_at: new Date().toISOString(),
          problem,
        }),
      );
    } catch (e) {
      console.error(`solver_capture put failed: ${String(e)}`);
    }
  }

  // Who solves — container HTTP hop, in-process engine, or a mixed mode — is
  // env.SOLVER_ENGINE's call (card G). Every mode returns the same three
  // outcomes, so nothing below this point knows which one answered.
  const solveOutcome = await solveForResolve({
    env,
    db,
    problem,
    callId,
    ownerSubject,
    windowStart,
    windowEnd,
    trigger,
    homeTz,
    realDurationByChunkId: realDurationsByChunkId(solverTasks),
  });
  if (solveOutcome.kind !== "solution") return solveOutcome;
  const solution = solveOutcome.solution;

  // Warn if a must_include meeting was kept while a higher-priority task dropped.
  // (Meetings are must_include but the user may set any priority via the API;
  // surfacing this lets them re-prioritise — review Q13.)
  // Gate on the feature flag AND at least one KEPT meeting (a promoted meeting
  // present in the solver problem). With no kept meeting — always when the flag
  // is OFF — there is nothing to warn about, so skip entirely rather than let a
  // keptMeetingMaxPriority of 0 fire on every dropped priority>0 task.
  const keptMeetingTasks = solverTasksForProblem.filter(
    (t) => t.source?.kind === MEETING_SOURCE_KIND,
  );
  if (meetingConfig.enabled && keptMeetingTasks.length > 0) {
    const droppedTaskPriorities = new Map(
      solverTasks.map((t) => [t.id, t.priority]),
    );
    const keptMeetingMaxPriority = Math.max(
      0,
      ...keptMeetingTasks.map((t) => t.priority),
    );
    for (const d of solution.dropped) {
      const pr = droppedTaskPriorities.get(d.task_id);
      if (pr !== undefined && pr > keptMeetingMaxPriority) {
        meetingWarnings.push(
          `must_include_meeting_with_dropped_task: Task "${d.title}" (priority ${pr}) was dropped while a meeting was kept; re-prioritise or pin the meeting to release it.`,
        );
        break; // one summary warning is enough
      }
    }
  }

  // Derive created_at and expires_at from a single clock read so the gap is
  // exactly ACCEPT_TTL_SECONDS by construction (no two-Date.now() skew).
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ACCEPT_TTL_SECONDS * 1000).toISOString();
  const body: ResolveBody = {
    schedule: solution.schedule,
    dropped: solution.dropped,
    window: { start: windowStart, end: windowEnd },
    weights: problem.weights,
    objective: solution.objective,
    account_email: accountEmail,
    ...(meetingWarnings.length > 0 ? { warnings: meetingWarnings } : {}),
  };
  const planHash = await computePlanHash(body as unknown as Record<string, unknown>);
  await insertProposedPlan(db, planHash, body as unknown as Record<string, unknown>, now, expiresAt, accountEmail);

  // A fresh resolve makes every other pending plan for this week stale — even
  // one anchored to a different window_start (a mid-week replan narrows the
  // start to "now") — hard-delete them so the accept page's per-week view has
  // one plan per week. Runs even when the caller later no-diff-deletes THIS
  // plan: an empty diff means the calendar already matches baseline, so the
  // older pending plan was obsolete anyway (spec: no-diff interaction, intended).
  await supersedeOtherPendingPlansForWeek(db, accountEmail, windowStart, env.SCHEDULER_TZ, planHash);

  return { kind: "ok", planHash, body, priorEvents, externalEvents, meetingTaskIds: [...promotedMeetingTaskIds] };
}
