// Bespoke solver engine — shared types (internal design notes).
//
// The engine is pure, dependency-free TypeScript over typed arrays: no
// Cloudflare imports, no Node imports. It consumes and produces the existing
// worker↔solver wire types unchanged; everything engine-internal is indexed
// (task index / chunk index / slot index), with string ids only at the wire
// boundary.

import type {
  Problem,
  Solution,
  UnsatResponse,
  UnsatItem,
  Context,
  LocalNaive,
} from "../planning/solver-contract";

export type {
  Problem,
  Solution,
  UnsatResponse,
  UnsatItem,
  Context,
  LocalNaive,
  ScheduledChunk,
  DroppedTask,
  ObjectiveComponents,
} from "../planning/solver-contract";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface Budget {
  /** Wall-clock budget in ms; Infinity = unbounded. */
  wallMs: number;
  /** Search-node backstop; Infinity = unbounded. */
  nodeCap: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface EngineBudgets {
  pass1: Budget;
  pass2: Budget;
  /** Budget for the whole MUS/demotion layer (deletion tests + isolation). */
  mus: Budget;
}

// ---------------------------------------------------------------------------
// Baked problem (substrate.ts output)
// ---------------------------------------------------------------------------

/** Hard dependency edge, endpoints resolved to indices at bake time.
 * Unresolvable refs are skipped at bake (mirrors model.py). Soft
 * dependencies are ignored everywhere and never baked. */
export interface BakedDependency {
  type: "after_task" | "before_task" | "after_event" | "before_event";
  ref: string;
  /** Other task's index for task deps; -1 for event deps. */
  taskIndex: number;
  /** Event [start, end) slots for event deps; -1 for task deps. */
  eventStartSlot: number;
  eventEndSlot: number;
}

export interface BakedTask {
  index: number;
  id: string;
  title: string;
  context: Context;
  contextIndex: number; // into Baked.contexts; -1 if the context has no config
  priority: number;
  /** base_drop_penalty + priority * priority_unit (pass-1 objective weight). */
  dropWeight: number;
  mustInclude: boolean;
  churnMultiplier: number;
  sameDay: boolean;
  ordered: boolean;
  /** Deadline slot (end must be <= for hard); -1 = no deadline. NOT clamped to
   * the window: an already-passed deadline bakes NEGATIVE, so this sentinel is
   * ambiguous for a deadline exactly one slot before window.start. Use
   * `hasSoftDeadline` for the soft-deadline presence test, never the sign. */
  deadlineSlot: number;
  deadlineHard: boolean;
  deadlinePenaltyPer15: number;
  /** Deadline present AND not hard — the presence test objective.py's
   * lateness_terms uses (`deadline is not None and not deadline.hard`).
   * Lateness is priced off `deadlineSlot` as-is, negative included: an overdue
   * task is pulled towards the start of the window, never exempted. */
  hasSoftDeadline: boolean;
  /** earliest_start clamped to >= 0. */
  earliestStartSlot: number;
  /** Pin slot for chunk[0]; -1 = unpinned. */
  pinnedSlot: number;
  /** True when the business-hours floor applied to this task's domains. */
  usedBusinessHours: boolean;
  /** Indices into Baked.chunks, in task chunk order. */
  chunkIndices: number[];
  /** Hard dependencies only, resolved; declared on THIS task. */
  deps: BakedDependency[];
  hasHardWindows: boolean;
  hasAvailability: boolean;
}

export interface BakedChunk {
  index: number;
  taskIndex: number;
  chunkId: string;
  durationSlots: number;
  durationMinutes: number;
  /** Sorted start slots satisfying ALL hard placement constraints. */
  allowedStarts: Int32Array;
  /** Bit s set iff s ∈ allowedStarts (Baked.maskWords words). */
  allowedMask: Uint32Array;
  /** cost[i] = weighted fit + soft-window miss + churn at allowedStarts[i]. */
  cost: Int32Array;
  canSpanMidnight: boolean;
  /** previous_placement slot if inside the window, else -1 (warm start / churn). */
  prevSlot: number;
}

export interface BakedContext {
  context: Context;
  /** max_minutes_per_day / 15; -1 = uncapped. */
  dailyCapSlots: number;
  dailyCapPenaltyPer15: number;
  /** max_contiguous_minutes / 15; -1 = uncapped. */
  streakCapSlots: number;
  streakCapPenaltyPer15: number;
}

export interface Baked {
  problem: Problem;
  horizon: number;
  /** Uint32 words per horizon bitmask (ceil(horizon / 32)). */
  maskWords: number;
  /** Minute-of-day [0, 1440) of each slot's start. */
  slotTod: Int32Array;
  /** 0 for the window's first day, 1 for the next, ... per slot. */
  slotDayIndex: Int32Array;
  /** Weekday per slot: 0=mon .. 6=sun. */
  slotWeekday: Uint8Array;
  tasks: BakedTask[];
  chunks: BakedChunk[];
  contexts: BakedContext[];
  taskIndexById: Map<string, number>;
  /** Key: `${taskId} ${chunkId}` (chunk_id is only unique per task). */
  chunkIndexByKey: Map<string, number>;
  /** Occupied-slot bits from external_pinned events, clipped to the horizon. */
  externalMask: Uint32Array;
  /** Non-null ⇒ two externals overlap: immediate 422, no search. */
  externalOverlapCore: UnsatItem[] | null;
}

// ---------------------------------------------------------------------------
// Pass 1 (pass1.ts)
// ---------------------------------------------------------------------------

export interface Pass1Result {
  /** Task indices kept / dropped (ascending). Meaningless when infeasible. */
  kept: number[];
  dropped: number[];
  /** True when the partition is proved drop-cost-optimal (search exhausted
   * or closed at root). False = a budget was hit: when `seedDecided` is true
   * the search ran and `kept` is a real (if uncertified) incumbent; when it
   * is false the must_include seed pack was abandoned and `kept` is an
   * UNVERIFIED candidate that may not pack — callers must re-verify (mus.ts
   * re-decides with its own oracle). */
  proved: boolean;
  nodes: number;
  /** True when the must_include seed pack reached a definite verdict
   * (feasible or infeasible); false only when that pack was abandoned by its
   * node ceiling, leaving feasibility of the must set undecided. */
  seedDecided: boolean;
  /** The incumbent's own placement — chunk-indexed starts, -1 for chunks of
   * dropped tasks. LEGAL but not optimized: hard constraints only, soft costs
   * untouched, which is exactly what PASS1_FALLBACK serves. Pass 1 holds this
   * placement whenever it verified an incumbent, so callers never need to
   * re-derive one with `packFeasible` — a call that is unbudgeted by contract
   * and ran for minutes on heavy acceptance problems. Null ONLY on the
   * undecided-seed path, where by definition no incumbent was verified. */
  witness: Placement | null;
  /** True when no partition satisfies the must_include set — the MUS layer
   * (mus.ts) takes over. kept/dropped are meaningless in that case. */
  infeasible: boolean;
}

/** A placement is chunk-indexed: placement[chunkIndex] = start slot, or -1
 * for chunks of dropped tasks. */
export type Placement = Int32Array;

// ---------------------------------------------------------------------------
// Search strengthening seams (internal design notes).
// Card A declares the shared shapes; cards B–E fill the modules behind them.
// ---------------------------------------------------------------------------

/** Residual placement problem handed to the bound machinery: the unplaced
 * chunks against the current occupancy. Card B populates it from pass 2's
 * scan; the shape is the D1 seam. */
export interface Residual {
  /** Occupancy (externals + placed chunks), Baked.maskWords words. */
  occ: Uint32Array;
  /** Global chunk indices still unplaced. */
  unplaced: readonly number[];
  /** Optional upper bound on the residual's separable cost (card B): the
   * subgradient's Polyak target. Advisory only — it scales the step, never
   * the bound, so its absence or looseness costs dual quality and can never
   * cost admissibility. */
  upperBound?: number;
  /** Optional narrowed live domains, one per entry of `unplaced` and in the
   * same order (card B). A caller that has already restricted a chunk's starts
   * — pass 2 folds unary event-dependency bounds into its working domains —
   * passes them here so λ is tuned against slots the search can actually use.
   * Omitted entries fall back to the chunk's baked envelope. */
  domains?: readonly { slots: Int32Array; costs: Int32Array }[];
}

/** Extra admissible lower bound on the residual's remaining cost, max'ed with
 * the separable Σ-min term inside pass 2 (card B wires the call sites). */
export type RemainderBoundHook = (residual: Residual) => number;

/** D1 — retained time-indexed multipliers and the best L(λ) they proved.
 * λ is per-slot (horizon entries) in scaled integers; any λ ≥ 0 stays
 * admissible for every residual subproblem (weak duality). */
export interface LagrangianState {
  lambda: Int32Array;
  /** Best L(λ) seen, floored into the int cost domain. */
  bound: number;
}

/** D2 — one violated interval Hall condition: the chunks whose whole domain
 * envelope lies inside [startSlot, endSlot) demand more slots than the
 * window has free, so no keep-set containing all of `taskIndices` packs. */
export interface HallCut {
  startSlot: number;
  endSlot: number;
  demandSlots: number;
  capacitySlots: number;
  /** Tasks whose chunks constitute the demand (ascending). */
  taskIndices: number[];
}

/** D3 — outcome of the incumbent-improvement phase. */
export interface ImproveResult {
  placement: Placement;
  cost: number;
  /** Probe/neighbourhood iterations attempted. */
  iterations: number;
  /** Iterations that produced a strict improvement. */
  accepted: number;
  /** Sub-solve requests ISSUED to an external batch driver (0 on the
   * in-process path). On a degraded fan-out session some of these were
   * recomputed sequentially; the engine_fanout / engine_fanout_degraded log
   * lines carry the consumed-vs-degraded split (card F adjudication). */
  fanoutSubsolves: number;
  /** Search nodes the sub-solves reported, so the caller's node accounting
   * can include work done behind the seam (card D). */
  nodes: number;
}

/** E — one budgeted engine sub-solve, structured-clone-safe for the RPC
 * boundary. The freed set is encoded in `frozen`: -1 entries are freed for
 * re-solve, everything else is held fixed. */
export interface SubsolveRequest {
  /** Full wire problem; the leaf re-bakes it (baking is deterministic). */
  problem: Problem;
  /** Kept task indices (the frozen pass-1 partition), ascending. */
  kept: number[];
  /** Chunk-indexed starts to hold fixed; -1 = freed. */
  frozen: Int32Array;
  /** Sub-budget as plain numbers — no injectable clock crosses the boundary.
   *
   * INVARIANT (card E review, binding on the card F phase driver):
   * improvement-phase sub-budgets are **node-capped**, and `wallMs` is a
   * non-binding safety valve — `Infinity` is the expected value, and
   * `outOfTime()` already special-cases it to skip the clock entirely.
   *
   * This is what makes fan-out's bit-identity claim true rather than
   * probabilistic. A wall that actually binds makes a sub-solve's result a
   * function of how fast the machine ran, so the same neighbourhood would
   * answer differently in-process and over RPC (different isolate, different
   * contention) — and the combined answer would stop being reproducible. A
   * node cap is machine-independent, so every leaf returns the same result
   * wherever it ran. Not enforced at runtime: card F wires the budgets and
   * takes the invariant from here. */
  wallMs: number;
  nodeCap: number;
}

export interface SubsolveResult {
  /** Chunk-indexed placement. Frozen entries are echoed back verbatim once
   * card D honours `PlaceOptions.frozenChunks` in `place()`; until then the
   * leaf returns whatever the (frozen-blind) search produced, since stitching
   * the echo on outside the search would desync the placement from `cost`. */
  placement: Placement;
  /** Soft cost, EXCLUDING the drop component — same convention as
   * `Pass2Result.cost`. Read it together with `descents`: a sub-solve that
   * completed no descent reports cost 0, which is not an optimum. */
  cost: number;
  proved: boolean;
  nodes: number;
  /** Completed full descents (`Pass2Result.descents`). 0 ⇒ the sub-solve
   * produced NO incumbent — the budget ran out, or the frozen partition could
   * not be realised. Card D's acceptance MUST ignore a descents-0 result:
   * `cost` is then 0 (drop cost lives outside it) and `proved` is false, so
   * neither field discriminates a non-answer from a genuine cost-0 optimum,
   * and 0 is the most attractive value a strict-improvement test can see. */
  descents: number;
}

/** Sequential sub-solve seam used by the improvement phase; defaults to
 * in-process `place()`. Card E's batched async fan-out variant lives in
 * fanout.ts and is bridged in by the card F controller. */
export type SubsolveFn = (request: SubsolveRequest) => SubsolveResult;

/** Optional pass-2 knobs. All inert until their cards land: card D reads
 * discrepancyLimit/frozenChunks (LDS + LNS sub-solves), card B reads
 * remainderBoundHook (Lagrangian bound injection into sub-solves). */
export interface PlaceOptions {
  /** LDS: max deviations from the ascending-cost value order. */
  discrepancyLimit?: number;
  /** Chunk-indexed starts (global indices) to hold fixed; -1 = free. */
  frozenChunks?: Placement | null;
  remainderBoundHook?: RemainderBoundHook;
  /** D3 (card D): how much of `budget` pass 2 holds back from the proof
   * search for the improvement phase. Omitted ⇒ pass 2 picks its own
   * deterministic reserve (`improveReserve` in pass2.ts); a zero budget ⇒
   * the phase is off, which is also what a sub-solve gets
   * (`discrepancyLimit` or `frozenChunks` set), since the phase is built
   * out of those two options and must not recurse. The reserve is a SLICE
   * of `budget`, never an extension: pass 2 clamps an override to the
   * budget it was actually given (card F, review finding F1). */
  improveBudget?: Budget | null;
  /** Card F: the caller owns the LNS loop (it runs `improve()` itself, at
   * the engine level, so the fan-out path can await the identical schedule
   * asynchronously). Pass 2 then runs only the LDS probe steps of the
   * phase — incumbent recovery and k=1,2 probes — and skips step (3). */
  externalLns?: boolean;
}

// ---------------------------------------------------------------------------
// Pass 2 (pass2.ts)
// ---------------------------------------------------------------------------

export interface Pass2Result {
  placement: Placement;
  /** Soft cost of the placement: fit + churn + soft-window + lateness +
   * daily/streak cap penalties. EXCLUDES the drop component — engine.ts adds
   * Σ dropWeight over dropped tasks to form objective.total. */
  cost: number;
  proved: boolean;
  /** incumbent cost − best bound; 0 when proved. */
  boundGap: number;
  nodes: number;
  /** Completed full descents. 0 ⇒ no incumbent from search (PASS1_FALLBACK
   * condition when the greedy/warm incumbent also failed). */
  descents: number;
  /** Instrumentation (card A): the root lower bound (base + admissible
   * remainder before any branching). Absent when setup found an empty live
   * domain, i.e. no root scan completed. */
  rootBound?: number;
  /** Instrumentation: the first incumbent's cost (greedy/warm descents,
   * before search). Absent when no descent produced one. */
  rootIncumbent?: number;
  /** Instrumentation: Lagrangian root bound minus the separable root bound.
   * 0 until card B lands the multiplier optimization. Absent iff rootBound
   * is absent. */
  boundLift?: number;
  /** D3 phase counters (card D), present as hard zeros on every solution
   * path the phase did not run — including every certified one. `nodes`
   * already includes whatever the phase and its sub-solves spent. */
  improveIterations: number;
  improveAccepted: number;
  fanoutSubsolves: number;
}

// ---------------------------------------------------------------------------
// MUS / demotion (mus.ts)
// ---------------------------------------------------------------------------

export interface MusOutcome {
  /** taskIndex → demotion reason (e.g. "must_include_unplaceable_in_isolation"). */
  demoted: Map<number, string>;
  /** Non-null ⇒ genuine 422: the surviving minimal core. */
  core: UnsatItem[] | null;
  /** The successful post-demotion pass-1 result; null when core != null. */
  pass1: Pass1Result | null;
  nodes: number;
}

// ---------------------------------------------------------------------------
// Engine (engine.ts)
// ---------------------------------------------------------------------------

export type EngineStatus = "OPTIMAL" | "FEASIBLE" | "PASS1_FALLBACK";

export type EngineResult =
  | { kind: "solution"; solution: Solution }
  | { kind: "unsat"; response: UnsatResponse };
