// Pass 2 — placement branch-and-bound (card C).
//
// The kept/dropped partition is fixed by pass 1; this layer decides WHERE the
// survivors land, minimising the soft objective. Semantics are a port of the
// Python authority, never re-derived:
//
//   - the separable per-start costs (fit + churn + soft preferred window) are
//     already baked into BakedChunk.cost by substrate.ts — evaluated here,
//     never recomputed (solver/src/solver/placements.combined_cost_table);
//   - the coupling terms are evaluated incrementally with O(1) amortised
//     update and undo: per-(context, day) cap overruns and per-task lateness
//     (solver/src/solver/objective.daily_cap_terms / lateness_terms);
//   - the streak cap is NOT a contiguity computation: objective.streak_cap_terms
//     prices it per PRESENT CHUNK whose own duration exceeds the cap, so over a
//     fixed kept set it is a placement-independent constant folded into the
//     bound base;
//   - the hard constraints are those of fast_model.build_pass2_model: baked
//     domains, no-overlap against externals and each other, group same_day /
//     ordered, hard dependencies between kept tasks, plus the interchangeable-
//     chunk symmetry break.
//
// Search: fail-first variable order (smallest live domain, ties by largest cost
// spread, then by index), ascending-cost value order, and an admissible bound
// with three parts — Σ min live separable cost, an ENERGETIC CAP FLOOR, and a
// PER-TASK LATENESS FLOOR. The separable tables are exact per chunk and both
// coupling terms are monotone non-decreasing as chunks land, so g itself is a
// floor; the two extra terms price coupling the separable sum cannot see. No
// RNG and total tie-breaking everywhere, so two identical runs return the
// identical placement.
//
// Without the energetic floor a daily-cap overrun is invisible until the slots
// are actually placed, so an instance whose optimum is entirely cap penalty
// cannot be closed at all (12 tasks × 120 min under a 240 min/day cap: 500k
// nodes, bound stuck at zero). With it the same instance proves its optimum of
// 400 in 22 nodes.
//
// No-overlap contention is priced by the D1 Lagrangian term (lagrangian.ts):
// Σ min live cost happily assumes every chunk gets its own cheapest slot even
// when they all want the same one, so on a crowded plateau it sits at zero
// however tight the week is. L(λ) charges a per-slot price for that shared
// demand, and max(Σ min live cost, L(λ)) is admissible for either — at λ = 0
// the two coincide. λ* is optimised once at the root by a budgeted subgradient
// loop and only EVALUATED below it; the evaluation is fused into scan()'s
// existing pass over the live domains, so an interior node pays two array
// lookups per candidate start and nothing else.
//
// The loop itself runs only when the greedy incumbent fails to meet the
// separable root bound, so the root-shortcut path (the prod shape: an
// incumbent that already matches the bound, zero search nodes) never pays for
// it.
//
// Pure, dependency-free TypeScript over typed arrays: no Cloudflare imports, no
// Node imports. Every array the search touches is allocated during setup.

import type {
  Baked,
  Budget,
  ImproveResult,
  Pass2Result,
  PlaceOptions,
  Placement,
  RemainderBoundHook,
  Residual,
} from "./types";
import { SLOTS_PER_DAY } from "./substrate";
import { intBound, LAMBDA_SCALE, optimizeMultipliers } from "./lagrangian";
import { improve } from "./improve";

// Binary constraint kinds, all relative to the chunk that carries them ("this
// chunk starts at s"; `o` is the other chunk's start, `durO` its duration).
const K_SAME_DAY = 0; // day(s) === day(o)
const K_BEFORE = 1; // s + dur <= o
const K_AFTER = 2; // s >= o + durO
const K_LE = 3; // s <= o  (symmetry break, earlier member)
const K_GE = 4; // s >= o  (symmetry break, later member)

/** Nodes between wall-clock checks — Date.now() is far dearer than a node. */
const CLOCK_STRIDE = 64;

/** How far the phase's limited-discrepancy probes go. Each k costs roughly a
 * factor of (domain size) more than the last, so the schedule is short and
 * fixed: k = 1 is the one that pays (a single wrong turn near the root is the
 * greedy descent's characteristic failure), k = 2 is the cheap follow-up, and
 * everything past that is the LNS loop's job. */
const LDS_MAX_DISCREPANCY = 2;

/** Nodes one probe may spend. A probe searches the WHOLE instance, so without
 * a cap of its own it would happily swallow the entire phase reserve and leave
 * the LNS loop — which is where the corpus improvements actually come from —
 * with nothing. Capping it in nodes rather than in wall keeps the phase's
 * schedule a function of the problem and its budgets. */
const PROBE_NODE_CAP = 50_000;

/** Share of the pass-2 budget the phase gets when no controller says
 * otherwise. Deliberately blunt — card F's D4 controller replaces the rule,
 * and the three public budget vars stay the whole tuning surface. */
const IMPROVE_SHARE = 0.4;

const NO_RESERVE: Budget = { wallMs: 0, nodeCap: 0 };

// The Infinity guard is redundant against today's IMPROVE_SHARE (0.4 propagates
// Infinity through both `*` and Math.floor unaided); it stays as insurance
// against a future share of 0, where `total * 0` would otherwise yield NaN.
function shareOf(total: number): number {
  return total === Infinity ? Infinity : Math.floor(total * IMPROVE_SHARE);
}

function subtractBudget(total: number, reserved: number): number {
  if (total === Infinity) return Infinity;
  return Math.max(0, total - reserved);
}

function addBudget(base: number, extra: number): number {
  if (base === Infinity || extra === Infinity) return Infinity;
  return base + extra;
}

/** The budget fields the search reads live and a sub-phase re-points for the
 * duration of one step. `Pass2Search` declares them un-private so `withBudget`
 * can name them structurally; the class is module-local, so nothing widens
 * past this file. */
interface BudgetScope {
  wallMs: number;
  nodeCap: number;
  startedAt: number;
  discrepancyLimit: number;
}

/** Run `fn` with `scope`'s budget fields re-pointed by `patch`, handing every
 * one of them back afterwards — on a throw too, the leg the three
 * hand-written save/restore sites this replaces never had. Nesting is safe:
 * each call restores what IT found, not some outermost entry state. */
export function withBudget<T>(
  scope: BudgetScope,
  patch: Partial<BudgetScope>,
  fn: () => T,
): T {
  const wallMs = scope.wallMs;
  const nodeCap = scope.nodeCap;
  const startedAt = scope.startedAt;
  const discrepancyLimit = scope.discrepancyLimit;
  if (patch.wallMs !== undefined) scope.wallMs = patch.wallMs;
  if (patch.nodeCap !== undefined) scope.nodeCap = patch.nodeCap;
  if (patch.startedAt !== undefined) scope.startedAt = patch.startedAt;
  if (patch.discrepancyLimit !== undefined) scope.discrepancyLimit = patch.discrepancyLimit;
  try {
    return fn();
  } finally {
    scope.wallMs = wallMs;
    scope.nodeCap = nodeCap;
    scope.startedAt = startedAt;
    scope.discrepancyLimit = discrepancyLimit;
  }
}

/** Place the kept tasks' chunks minimizing soft cost (fit + churn +
 * soft-window + lateness + cap penalties; drop cost excluded — see
 * Pass2Result.cost). Fail-first variable order, ascending-cost value order,
 * admissible separable bound + incremental coupling terms. `warmStart` is a
 * chunk-indexed placement to seed the incumbent (-1 = no hint for that
 * chunk); when null, pass 2 falls back to each chunk's baked prevSlot
 * projection, else a greedy descent. Root shortcut: greedy incumbent equal
 * to the root bound proves OPTIMAL with zero search nodes.
 *
 * `options` (card A seam, internal design notes):
 * `remainderBoundHook` is live — an extra admissible lower bound on the
 * residual, max'ed into the node bound (a hook returning 0, or none at all,
 * leaves every result bit-identical, since the remainder is never negative).
 * discrepancyLimit/frozenChunks stay inert until the card D improvement
 * phase. */
export function place(
  baked: Baked,
  keptTaskIndices: readonly number[],
  warmStart: Placement | null,
  budget: Budget,
  options?: PlaceOptions,
): Pass2Result {
  return new Pass2Search(baked, keptTaskIndices, warmStart, budget, options).run();
}

class Pass2Search implements BudgetScope {
  // ----- problem shape -----
  private readonly baked: Baked;
  private readonly n: number; // kept chunks
  private readonly globalOf: Int32Array; // local chunk → baked.chunks index
  private readonly durOf: Int32Array;
  private readonly taskOf: Int32Array; // local chunk → local task
  private readonly domSlots: Int32Array[];
  private readonly domCosts: Int32Array[];
  private readonly domOrder: Int32Array[]; // positions, ascending cost then slot
  private readonly conOffset: Int32Array;
  private readonly conOther: Int32Array;
  private readonly conKind: Uint8Array;

  // ----- per-task (kept only) -----
  private readonly nt: number;
  private readonly taskChunkOffset: Int32Array;
  private readonly taskLastChunk: Int32Array;
  private readonly taskOrdered: Uint8Array;
  /** 1 = this task prices lateness. Separate from taskDeadline because the
   * deadline SLOT may legitimately be negative (already passed). */
  private readonly taskHasDeadline: Uint8Array;
  private readonly taskDeadline: Int32Array;
  private readonly taskPenalty: Int32Array;

  // ----- daily caps -----
  private readonly days: number;
  private readonly nCtx: number;
  private readonly capSlots: Int32Array;
  private readonly capPenalty: Int32Array;
  private readonly ctxOf: Int32Array; // local chunk → capped context, else -1
  private readonly dayUsed: Int32Array;
  private readonly hasCappedContext: boolean;
  /** Scan scratch for the energetic cap bound: unplaced slot demand per capped
   * context, and the days that demand can still reach. */
  private readonly remainSlots: Int32Array;
  private readonly dayReach: Uint8Array;
  /** Scan scratch: each unplaced chunk's earliest live start, for the lateness
   * floor. Only meaningful for chunks the current scan visited. */
  private readonly liveMinStart: Int32Array;
  /** Scan scratch: each unplaced chunk's minimum live separable cost, so a
   * child can be given a cheap admissible remainder without rescanning. */
  private readonly liveMinCost: Int32Array;

  // ----- mutable search state -----
  private readonly assign: Int32Array; // local chunk → start slot, -1 unassigned
  private readonly assignPos: Int32Array; // position within domSlots
  private readonly occ: Uint32Array;
  private readonly taskLate: Int32Array;
  private readonly incumbent: Int32Array;
  private readonly hint: Int32Array;
  private gSep = 0;
  private gCap = 0;
  private gLate = 0;
  /** Admissible lower bound on the cost still to be incurred by the unplaced
   * chunks: Σ min live separable cost + the energetic cap floor + the
   * per-task lateness floor. Set by every scan(). */
  private remainderBound = 0;
  /** The separable half of remainderBound (Σ min live cost), kept apart so the
   * cheap child pre-test can use it without the floors. Set by every scan(). */
  private sumMinSep = 0;
  /** remainderBound WITHOUT any caller-injected hook contribution — the
   * engine's own bound. `bound_lift` is measured off this: the diagnostic
   * means "what the Lagrangian added over the separable term", and a card-D
   * sub-solve handing us someone else's bound is neither half of that. Set by
   * every scan(). */
  private remainderNoHook = 0;

  // ----- D1 Lagrangian contention bound (lagrangian.ts) -----
  /** Root-optimised multipliers, scaled integers; null until the subgradient
   * loop runs (and it only runs when the greedy incumbent misses the separable
   * root bound). */
  private lambda: Int32Array | null = null;
  /** Running sum of λ, horizon + 1 entries, so a chunk's covered-slot total is
   * one subtraction. Integer-valued throughout. */
  private readonly lambdaPrefix: Float64Array;
  /** Per-chunk λ-augmented cost table, parallel to domSlots/domCosts:
   * LAMBDA_SCALE × separable cost + Σ λ over the covered slots. Folded once
   * when λ is installed, because scan() is the engine's hottest loop and the
   * inner minimisation must stay one load and one compare per candidate. */
  private lagCost: Float64Array[] | null = null;
  /** Σ λ[t] over the slots still FREE — the −Σ λ·cap term of L(λ). Maintained
   * incrementally: placements never overlap each other or the externals, so
   * every apply subtracts a disjoint span and every undo restores it. */
  private freeLambda = 0;
  /** Extra admissible remainder bound injected by the caller (card D's
   * sub-solves), max'ed in alongside the Lagrangian term. */
  private readonly remainderHook: RemainderBoundHook | null;
  private readonly base: number; // streak-cap constant over the kept set
  private incumbentCost = Infinity;
  private nodes = 0;
  private clockTick = 0;
  private timedOut = false;
  private descents = 0;
  private aborted = false;
  private minAbandoned = Infinity;
  private hasHint = false;

  // ----- D3: LDS probes and the improvement phase (improve.ts) -----
  /** Max deviations from the ascending-cost value order; -1 = unlimited (the
   * complete search). Mutable because the phase's own probes drive it up from
   * k = 1 inside this instance, reusing the incumbent as their pruning bound.
   * Part of `BudgetScope` — re-pointed only through `withBudget`. */
  discrepancyLimit: number;
  private readonly keptTaskIndices: readonly number[];
  /** Set when discrepancy pruning actually cut a branch, so the search is no
   * longer complete and may not claim a certificate on exhaustion alone. The
   * cut branches' bounds go into `minAbandoned` exactly as a budget-abandoned
   * subtree's do, so a gap that closes anyway still certifies honestly. */
  private truncated = false;
  /** Local indices of the chunks a caller pinned, and how many. They are
   * PRE-APPLIED by every reset() instead of being branched on: an LNS
   * sub-solve is 2–8 free chunks against a hundred fixed ones, and leaving the
   * fixed ones in the search as singleton-domain variables made scan() — the
   * engine's hottest loop — walk the whole problem at every node. Pre-applying
   * them makes an iteration cost what its neighbourhood costs. */
  private readonly frozenLocal: Int32Array;
  private readonly frozenCount: number;
  /** A pinned start that is not in its chunk's domain, or collides with
   * another pin: the sub-problem has no completion at all, which run() reports
   * as "no incumbent" rather than by quietly relaxing the pin. */
  private frozenUnrealisable = false;
  /** Chunks currently assigned, frozen included — the search's own depth plus
   * the frozen prefix. */
  private assignedCount = 0;
  /** False for a sub-solve (frozen chunks or a discrepancy limit): the phase
   * is built out of those two options and must never recurse into itself. */
  private readonly phaseEnabled: boolean;
  private readonly improveBudgetOption: Budget | null | undefined;
  /** Card F: the caller drives the LNS loop itself (sync or fan-out async);
   * the in-run phase then stops after the LDS probe steps. */
  private readonly externalLns: boolean;
  private improveIterations = 0;
  private improveAccepted = 0;
  private fanoutSubsolves = 0;

  // ----- budget (mutable: the phase reserve is carved out of it) -----
  // The three below plus `discrepancyLimit` are the `BudgetScope`: assigned
  // here once, then only ever re-pointed for the duration of one step by
  // `withBudget`, which hands them back in a `finally`.
  nodeCap: number;
  wallMs: number;
  private readonly now: () => number;
  startedAt: number;

  constructor(
    baked: Baked,
    keptTaskIndices: readonly number[],
    warmStart: Placement | null,
    budget: Budget,
    options?: PlaceOptions,
  ) {
    this.baked = baked;
    this.lambdaPrefix = new Float64Array(baked.horizon + 1);
    this.remainderHook = options?.remainderBoundHook ?? null;
    const frozenChunks = options?.frozenChunks ?? null;
    this.keptTaskIndices = keptTaskIndices;
    this.discrepancyLimit = options?.discrepancyLimit ?? -1;
    this.phaseEnabled = frozenChunks === null && this.discrepancyLimit < 0;
    this.improveBudgetOption = options?.improveBudget;
    this.externalLns = options?.externalLns === true;
    this.nodeCap = budget.nodeCap;
    this.wallMs = budget.wallMs;
    this.now = budget.now ?? Date.now;
    this.startedAt = this.wallMs === Infinity ? 0 : this.now();

    // ---- kept tasks and chunks, in a fixed (task, chunk) order ----
    const keptTasks = Array.from(keptTaskIndices).sort((a, b) => a - b);
    this.nt = keptTasks.length;
    const globals: number[] = [];
    const taskChunkOffset = new Int32Array(this.nt + 1);
    for (let tl = 0; tl < this.nt; tl++) {
      const task = baked.tasks[keptTasks[tl]!]!;
      taskChunkOffset[tl] = globals.length;
      for (const ci of task.chunkIndices) {
        globals.push(ci);
      }
    }
    taskChunkOffset[this.nt] = globals.length;
    const n = globals.length;
    this.n = n;
    this.taskChunkOffset = taskChunkOffset;
    this.globalOf = Int32Array.from(globals);
    this.durOf = new Int32Array(n);
    this.taskOf = new Int32Array(n);
    this.taskLastChunk = new Int32Array(this.nt);
    this.taskOrdered = new Uint8Array(this.nt);
    this.taskHasDeadline = new Uint8Array(this.nt);
    this.taskDeadline = new Int32Array(this.nt);
    this.taskPenalty = new Int32Array(this.nt);

    // ---- daily-cap tables ----
    this.days = Math.floor(baked.horizon / SLOTS_PER_DAY);
    this.nCtx = baked.contexts.length;
    this.capSlots = new Int32Array(this.nCtx).fill(-1);
    this.capPenalty = new Int32Array(this.nCtx);
    for (let cx = 0; cx < this.nCtx; cx++) {
      const ctx = baked.contexts[cx]!;
      // objective.daily_cap_terms skips an uncapped context and a zero penalty.
      if (ctx.dailyCapSlots >= 0 && ctx.dailyCapPenaltyPer15 !== 0) {
        this.capSlots[cx] = ctx.dailyCapSlots;
        this.capPenalty[cx] = ctx.dailyCapPenaltyPer15;
      }
    }
    this.dayUsed = new Int32Array(this.nCtx * Math.max(this.days, 1));
    this.ctxOf = new Int32Array(n).fill(-1);
    this.remainSlots = new Int32Array(this.nCtx);
    this.dayReach = new Uint8Array(this.nCtx * Math.max(this.days, 1));
    this.liveMinStart = new Int32Array(n);
    this.liveMinCost = new Int32Array(n);

    // ---- per-task metadata, event-dependency bounds, streak constant ----
    const lo = new Int32Array(n); // inclusive start-slot floor
    const hi = new Int32Array(n).fill(baked.horizon); // inclusive start-slot ceiling
    let base = 0;
    for (let tl = 0; tl < this.nt; tl++) {
      const task = baked.tasks[keptTasks[tl]!]!;
      const from = taskChunkOffset[tl]!;
      const to = taskChunkOffset[tl + 1]!;
      this.taskOrdered[tl] = task.ordered ? 1 : 0;
      this.taskLastChunk[tl] = to - 1;
      // Presence, never the slot's sign: an already-passed deadline bakes
      // NEGATIVE and objective.lateness_terms still prices it, dragging the
      // overdue task towards the start of the window.
      if (task.hasSoftDeadline && task.deadlinePenaltyPer15 !== 0) {
        this.taskHasDeadline[tl] = 1;
        this.taskDeadline[tl] = task.deadlineSlot;
        this.taskPenalty[tl] = task.deadlinePenaltyPer15;
      }
      const ctx = task.contextIndex >= 0 ? baked.contexts[task.contextIndex]! : null;
      for (let c = from; c < to; c++) {
        const chunk = baked.chunks[this.globalOf[c]!]!;
        this.durOf[c] = chunk.durationSlots;
        this.taskOf[c] = tl;
        if (ctx !== null) {
          if (this.capSlots[task.contextIndex]! >= 0) this.ctxOf[c] = task.contextIndex;
          // objective.streak_cap_terms: a constant for every present chunk
          // longer than the cap, so it never moves with the placement.
          if (ctx.streakCapSlots >= 0 && chunk.durationSlots > ctx.streakCapSlots) {
            base += (chunk.durationSlots - ctx.streakCapSlots) * ctx.streakCapPenaltyPer15;
          }
        }
      }
      // Event dependencies are unary: fold them into the domain bounds.
      for (const dep of task.deps) {
        if (dep.type === "after_event") {
          if (dep.eventEndSlot > lo[from]!) lo[from] = dep.eventEndSlot;
        } else if (dep.type === "before_event") {
          const last = to - 1;
          const ceiling = dep.eventStartSlot - this.durOf[last]!;
          if (ceiling < hi[last]!) hi[last] = ceiling;
        }
      }
    }
    this.base = base;
    let capped = false;
    for (let c = 0; c < n; c++) {
      if (this.ctxOf[c]! >= 0) {
        capped = true;
        break;
      }
    }
    this.hasCappedContext = capped && this.days > 0;

    // ---- working domains (baked domain ∩ event-dependency bounds) ----
    this.domSlots = new Array<Int32Array>(n);
    this.domCosts = new Array<Int32Array>(n);
    this.domOrder = new Array<Int32Array>(n);
    for (let c = 0; c < n; c++) {
      const chunk = baked.chunks[this.globalOf[c]!]!;
      const all = chunk.allowedStarts;
      let floor = lo[c]!;
      let ceiling = hi[c]!;
      // LNS: a frozen chunk is a singleton domain — the search then places it
      // first (fail-first sees the smallest domain there is), no-overlap holds
      // it against everything freed, and the incumbent echoes it back
      // untouched. A frozen start outside the chunk's baked envelope collapses
      // the domain to empty, which the root scan reports as "no completion
      // exists": an unrealisable freeze yields no incumbent rather than a
      // silently relaxed one.
      const pin = frozenChunks === null ? -1 : frozenChunks[this.globalOf[c]!]!;
      if (pin >= 0) {
        if (pin > floor) floor = pin;
        if (pin < ceiling) ceiling = pin;
      }
      let count = 0;
      for (let i = 0; i < all.length; i++) {
        const s = all[i]!;
        if (s >= floor && s <= ceiling) count++;
      }
      const slots = new Int32Array(count);
      const costs = new Int32Array(count);
      let w = 0;
      for (let i = 0; i < all.length; i++) {
        const s = all[i]!;
        if (s < floor || s > ceiling) continue;
        slots[w] = s;
        costs[w] = chunk.cost[i]!;
        w++;
      }
      this.domSlots[c] = slots;
      this.domCosts[c] = costs;
      const order: number[] = [];
      for (let i = 0; i < count; i++) order.push(i);
      // ascending cost; slots are already ascending, so equal costs keep slot
      // order — the tie-break that makes the search deterministic.
      order.sort((a, b) => costs[a]! - costs[b]! || slots[a]! - slots[b]!);
      this.domOrder[c] = Int32Array.from(order);
    }

    // ---- frozen prefix (LNS sub-solves) ----
    const pinned: number[] = [];
    if (frozenChunks !== null) {
      for (let c = 0; c < n; c++) {
        if (frozenChunks[this.globalOf[c]!]! >= 0) pinned.push(c);
      }
    }
    this.frozenLocal = Int32Array.from(pinned);
    this.frozenCount = pinned.length;

    // ---- binary constraints ----
    const cFrom: number[] = [];
    const cOther: number[] = [];
    const cKind: number[] = [];
    const add = (c: number, other: number, kind: number): void => {
      cFrom.push(c);
      cOther.push(other);
      cKind.push(kind);
    };
    const depInvolved = dependencyInvolvedTasks(baked);
    for (let tl = 0; tl < this.nt; tl++) {
      const ti = keptTasks[tl]!;
      const task = baked.tasks[ti]!;
      const from = taskChunkOffset[tl]!;
      const to = taskChunkOffset[tl + 1]!;
      const len = to - from;
      if (len > 1) {
        if (task.sameDay) {
          for (let c = from + 1; c < to; c++) {
            add(c, from, K_SAME_DAY);
            add(from, c, K_SAME_DAY);
          }
        }
        if (task.ordered) {
          for (let c = from + 1; c < to; c++) {
            add(c - 1, c, K_BEFORE);
            add(c, c - 1, K_AFTER);
          }
        }
        // fast_model._add_symmetry_breaking: consecutive interchangeable chunks
        // (equal duration, neither carrying a previous placement) on a task
        // that is not ordered, pinned or dependency-involved.
        if (!task.ordered && task.pinnedSlot < 0 && !depInvolved.has(ti)) {
          const prevIds = new Set(
            baked.problem.tasks[ti]!.previous_placement.map((p) => p.chunk_id),
          );
          for (let c = from + 1; c < to; c++) {
            const a = baked.chunks[this.globalOf[c - 1]!]!;
            const b = baked.chunks[this.globalOf[c]!]!;
            if (a.durationSlots !== b.durationSlots) continue;
            if (prevIds.has(a.chunkId) || prevIds.has(b.chunkId)) continue;
            add(c - 1, c, K_LE);
            add(c, c - 1, K_GE);
          }
        }
      }
      for (const dep of task.deps) {
        if (dep.taskIndex < 0) continue; // event deps became domain bounds
        const otherLocalTask = keptTasks.indexOf(dep.taskIndex);
        if (otherLocalTask < 0) continue; // dropped endpoint ⇒ vacuous
        const oFrom = taskChunkOffset[otherLocalTask]!;
        const oTo = taskChunkOffset[otherLocalTask + 1]!;
        if (dep.type === "after_task") {
          // first_start(task) >= last_end(other)
          add(from, oTo - 1, K_AFTER);
          add(oTo - 1, from, K_BEFORE);
        } else {
          // last_end(task) <= first_start(other)
          add(to - 1, oFrom, K_BEFORE);
          add(oFrom, to - 1, K_AFTER);
        }
      }
    }
    const m = cFrom.length;
    const offset = new Int32Array(n + 1);
    for (let k = 0; k < m; k++) offset[cFrom[k]! + 1]!++;
    for (let c = 0; c < n; c++) offset[c + 1] = offset[c]! + offset[c + 1]!;
    const cursor = Int32Array.from(offset.subarray(0, n));
    const other = new Int32Array(m);
    const kind = new Uint8Array(m);
    for (let k = 0; k < m; k++) {
      const at = cursor[cFrom[k]!]!++;
      other[at] = cOther[k]!;
      kind[at] = cKind[k]!;
    }
    this.conOffset = offset;
    this.conOther = other;
    this.conKind = kind;

    // ---- mutable state ----
    this.assign = new Int32Array(n).fill(-1);
    this.assignPos = new Int32Array(n).fill(-1);
    this.occ = new Uint32Array(baked.maskWords);
    this.taskLate = new Int32Array(this.nt);
    this.incumbent = new Int32Array(n).fill(-1);

    // ---- warm-start hint: explicit placement, else the baked prevSlot ----
    this.hint = new Int32Array(n).fill(-1);
    for (let c = 0; c < n; c++) {
      const gi = this.globalOf[c]!;
      const h = warmStart !== null ? warmStart[gi]! : baked.chunks[gi]!.prevSlot;
      if (h >= 0) {
        this.hint[c] = h;
        this.hasHint = true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // orchestration
  // -------------------------------------------------------------------------

  run(): Pass2Result {
    if (this.n === 0) {
      return {
        placement: this.emptyPlacement(),
        cost: this.base,
        proved: true,
        boundGap: 0,
        nodes: 0,
        descents: 1,
        rootBound: this.base,
        rootIncumbent: this.base,
        boundLift: 0,
        ...this.phaseCounters(),
      };
    }

    this.reset();
    if (this.frozenUnrealisable) {
      return {
        placement: this.emptyPlacement(),
        cost: 0,
        proved: false,
        boundGap: 0,
        nodes: 0,
        descents: 0,
        ...this.phaseCounters(),
      };
    }
    if (this.assignedCount === this.n) {
      // Everything was pinned: there is nothing to decide, so the answer is
      // the caller's own placement at its exact cost, proved in zero nodes.
      // (This is how the improvement phase re-costs an untrusted sub-solve.)
      const cost = this.base + this.gSep + this.gCap + this.gLate;
      this.incumbent.set(this.assign);
      return {
        placement: this.materialise(),
        cost,
        proved: true,
        boundGap: 0,
        nodes: 0,
        descents: 1,
        rootBound: cost,
        rootIncumbent: cost,
        boundLift: 0,
        ...this.phaseCounters(),
      };
    }
    if (this.scan() < 0) {
      // Some chunk has no legal start at all: pass 1 handed over a partition
      // pass 2 cannot realise. No incumbent — engine.ts maps descents === 0 to
      // PASS1_FALLBACK.
      return {
        placement: this.emptyPlacement(),
        cost: 0,
        proved: false,
        boundGap: 0,
        nodes: 0,
        descents: 0,
        ...this.phaseCounters(),
      };
    }
    // Two roots: what the engine's own bound proves (the lift is measured off
    // this) and what the search will actually prune with (a caller's hook
    // included). They differ only when card D injects one.
    const separableRoot = this.base + this.remainderNoHook;
    const prunableRoot = this.base + this.remainderBound;

    if (this.hasHint) this.tryDescent(true);
    this.tryDescent(false);

    // Instrumentation (card A): the root bound, the pre-search incumbent, and
    // the Lagrangian's lift over the separable bound.
    const rootIncumbent =
      this.incumbentCost === Infinity ? undefined : this.incumbentCost;

    // D1: price no-overlap contention, but only when the greedy incumbent has
    // not already met the separable bound — the root-shortcut path must stay
    // free.
    let rootBound = prunableRoot;
    let lagrangianRoot = separableRoot;
    // A sub-solve never pays for the dual: its residual is a handful of chunks
    // against a fixed week, where the separable bound plus the two floors is
    // already tight, and the subgradient loop's fixed cost would dominate the
    // iteration it is supposed to be cheap enough to repeat.
    if (this.incumbentCost > prunableRoot && !this.timedOut && this.frozenCount === 0) {
      this.optimizeLagrangian();
      this.reset();
      if (this.scan() >= 0) {
        rootBound = this.base + this.remainderBound;
        lagrangianRoot = this.base + this.remainderNoHook;
      }
    }
    const boundLift = lagrangianRoot - separableRoot;

    // D3: hold back a slice of the budget for the improvement phase BEFORE
    // the proof search spends it. A closed root gap reserves nothing, so the
    // certificate path is untouched; everywhere else the proof search is the
    // one paying, which is only sound because it never closes there anyway
    // (measured over the corpus: every certified problem closes inside 2 % of
    // the pass-2 wall and 0.5 % of the node cap).
    const reserve = this.improveReserve(rootBound);

    // A greedy descent can dead-end on ordered / dependency-chained tasks (it
    // never backtracks), so an absent incumbent is not an absent solution —
    // the search runs anyway, just without an initial pruning bound.
    if (this.incumbentCost > rootBound) {
      withBudget(
        this,
        {
          wallMs: subtractBudget(this.wallMs, reserve.wallMs),
          nodeCap: subtractBudget(this.nodeCap, reserve.nodeCap),
        },
        () => {
          this.reset();
          this.search(this.frozenCount, -1, 0);
        },
      );
    }

    let proved = this.certified();
    if (!proved && reserve.wallMs > 0 && reserve.nodeCap > 0) {
      this.improvementPhase(reserve);
      proved = this.certified();
    }

    if (this.incumbentCost === Infinity) {
      return {
        placement: this.emptyPlacement(),
        cost: 0,
        proved: false,
        boundGap: 0,
        nodes: this.nodes,
        descents: 0,
        rootBound,
        boundLift,
        ...this.phaseCounters(),
      };
    }

    return {
      placement: this.materialise(),
      cost: this.incumbentCost,
      proved,
      boundGap: proved ? 0 : this.incumbentCost - Math.min(this.minAbandoned, this.incumbentCost),
      nodes: this.nodes,
      descents: this.descents,
      rootBound,
      ...(rootIncumbent === undefined ? {} : { rootIncumbent }),
      boundLift,
      ...this.phaseCounters(),
    };
  }

  private phaseCounters(): Pick<
    Pass2Result,
    "improveIterations" | "improveAccepted" | "fanoutSubsolves"
  > {
    return {
      improveIterations: this.improveIterations,
      improveAccepted: this.improveAccepted,
      fanoutSubsolves: this.fanoutSubsolves,
    };
  }

  /** Whether the incumbent is proved optimal: the search exhausted a COMPLETE
   * tree, or the best bound it abandoned has caught up with the incumbent. A
   * discrepancy-truncated tree proves nothing by exhaustion, but its cut
   * branches went into `minAbandoned`, so it can still close on the gap. */
  private certified(): boolean {
    if (this.incumbentCost === Infinity) return false;
    if (!this.aborted && !this.truncated) return true;
    return this.incumbentCost <= this.minAbandoned;
  }

  /** How much of the pass-2 budget the in-run phase gets.
   *
   * CARD F: on every PRODUCTION path this is decided by the caller —
   * engine.ts's pipeline passes `improveBudget: PHASE_OFF` + `externalLns`
   * (it owns probes-equivalent diversification and the LNS itself, budgeted
   * by `splitPass2Budget`), and every sub-solve sets `frozenChunks`, which
   * disables the phase via `phaseEnabled`. The IMPROVE_SHARE fallback below
   * is therefore reachable ONLY by a direct `place()` caller that passes
   * neither — tests and any future embedder — and such a caller gets a
   * self-driven phase (probes + in-run LNS at a fixed 40 % reserve) that is
   * NOT the controller pipeline and never fans out. A zero override budget
   * switches the phase off; nothing is reserved once the root gap is
   * closed. */
  private improveReserve(rootBound: number): Budget {
    if (!this.phaseEnabled) return NO_RESERVE;
    const override = this.improveBudgetOption;
    if (override !== undefined && override !== null) {
      // A reserve is a SLICE of the caller's budget, never an extension
      // (card F, review finding F1): clamp so a generous controller value
      // cannot spend more than the caller allowed.
      return {
        wallMs: Math.min(override.wallMs, this.wallMs),
        nodeCap: Math.min(override.nodeCap, this.nodeCap),
      };
    }
    // Root gap 0 ⇒ certificate territory: the root shortcut is about to prove
    // the incumbent with zero search, and improvement has nothing to add.
    if (this.incumbentCost <= rootBound) return NO_RESERVE;
    return {
      wallMs: shareOf(this.wallMs),
      nodeCap: shareOf(this.nodeCap),
    };
  }

  /** The D3 phase: recover an incumbent when the descent produced none, probe
   * around the greedy path with bounded discrepancies, then hand what we have
   * to the LNS repair loop. Every step is budgeted out of `reserve` and every
   * node it spends is added to the reported total. */
  private improvementPhase(reserve: Budget): void {
    const deadlineWall = reserve.wallMs;
    const phaseNodeCeiling = addBudget(this.nodes, reserve.nodeCap);
    // The proof search latched `timedOut` on its own (smaller) wall; the
    // reserve is fresh time, so the clock restarts against it. `aborted` is
    // NOT cleared — it records that the proof did not finish, which is still
    // true and is what `certified()` reads. Neither is budget mechanics, so
    // neither belongs inside the scope below.
    this.timedOut = false;
    // The phase is a slice of the solve, not the end of it: it runs on its own
    // reserve and the instance gets its own budget fields back either way.
    withBudget(
      this,
      {
        wallMs: deadlineWall,
        nodeCap: phaseNodeCeiling,
        startedAt: deadlineWall === Infinity ? 0 : this.now(),
      },
      () => this.runPhase(phaseNodeCeiling),
    );
  }

  /** The phase's own steps, run inside the scoped budget above. */
  private runPhase(phaseNodeCeiling: number): void {
    // (1) No incumbent at all — the card C pass-2 cliff, where one greedy
    // descent cannot complete and the solve degrades to the pass-1 witness.
    // A bounded-discrepancy search is the cheap way out: it reaches a leaf by
    // deviating from the dead-ended greedy path in one or two places instead
    // of grinding the leftmost subtree the plain DFS is stuck in.
    if (this.incumbentCost === Infinity) {
      for (let k = 1; k <= LDS_MAX_DISCREPANCY && this.incumbentCost === Infinity; k++) {
        if (this.outOfPhaseBudget()) break;
        this.probe(k);
      }
    } else {
      // (2) An incumbent exists: probe its neighbourhood for a cheaper leaf.
      for (let k = 1; k <= LDS_MAX_DISCREPANCY; k++) {
        if (this.outOfPhaseBudget()) break;
        this.probe(k);
      }
    }

    // (3) LNS repair over ranked neighbourhoods — the phase's workhorse. It is
    // handed a node budget and NO wall: its sub-solves are card E's fan-out
    // payload, and a wall-budgeted schedule would not survive being run in
    // parallel isolates bit-identically (adjudicated at card E's review). The
    // wall reserve above still bounds the phase as a whole — it is a safety
    // valve that the corpus never trips, not the stopping rule.
    if (this.externalLns) {
      // Card F: the LNS loop belongs to the caller (engine.ts drives
      // `improve`/`improveAsync` itself so the fan-out path can await the
      // identical schedule). Probes above still ran; that is the phase.
      return;
    }
    if (this.incumbentCost !== Infinity && !this.outOfPhaseBudget()) {
      const result: ImproveResult = improve(
        this.baked,
        this.keptTaskIndices,
        this.materialise(),
        this.incumbentCost,
        {
          wallMs: Infinity,
          nodeCap: subtractBudget(phaseNodeCeiling, this.nodes),
        },
      );
      this.nodes += result.nodes;
      this.improveIterations += result.iterations;
      this.improveAccepted += result.accepted;
      this.fanoutSubsolves += result.fanoutSubsolves;
      if (result.cost < this.incumbentCost) {
        this.incumbentCost = result.cost;
        for (let c = 0; c < this.n; c++) this.incumbent[c] = result.placement[this.globalOf[c]!]!;
      }
    }
  }

  private outOfPhaseBudget(): boolean {
    return this.nodes >= this.nodeCap || this.outOfTime();
  }

  /** One limited-discrepancy descent from the root, counted as an improvement
   * iteration. Runs inside THIS instance so it inherits the incumbent (and so
   * prunes against it): a probe can only ever replace the incumbent with a
   * strictly cheaper leaf. */
  private probe(k: number): void {
    this.improveIterations++;
    const before = this.incumbentCost;
    withBudget(
      this,
      {
        nodeCap: Math.min(this.nodeCap, addBudget(this.nodes, PROBE_NODE_CAP)),
        discrepancyLimit: k,
      },
      () => {
        this.reset();
        this.search(this.frozenCount, -1, 0);
      },
    );
    if (this.incumbentCost < before) this.improveAccepted++;
  }

  private emptyPlacement(): Placement {
    return new Int32Array(this.baked.chunks.length).fill(-1);
  }

  private materialise(): Placement {
    const out = this.emptyPlacement();
    for (let c = 0; c < this.n; c++) out[this.globalOf[c]!] = this.incumbent[c]!;
    return out;
  }

  /** One full greedy descent; `useHint` takes the warm-start slot whenever it
   * is legal at that step, otherwise the cheapest legal start. Records the
   * result as the incumbent when it improves on what we have. */
  private tryDescent(useHint: boolean): void {
    this.reset();
    if (this.frozenUnrealisable) return;
    for (let step = this.frozenCount; step < this.n; step++) {
      // A descent is O(chunks × domain) per step and runs BEFORE the search, so
      // it needs the clock too — otherwise a tight wallMs is not honoured until
      // the first search node, which on a large instance never arrives.
      if (this.outOfTime()) {
        this.aborted = true;
        return;
      }
      const c = this.scan();
      if (c < 0) return;
      let pos = -1;
      if (useHint) {
        const h = this.hint[c]!;
        if (h >= 0) {
          const i = this.positionOf(c, h);
          if (i >= 0 && this.legal(c, h)) pos = i;
        }
      }
      if (pos < 0) {
        const order = this.domOrder[c]!;
        const slots = this.domSlots[c]!;
        for (let k = 0; k < order.length; k++) {
          const i = order[k]!;
          if (this.legal(c, slots[i]!)) {
            pos = i;
            break;
          }
        }
      }
      if (pos < 0) return; // dead end: this descent yields nothing
      this.apply(c, pos);
    }
    this.descents++;
    const total = this.base + this.gSep + this.gCap + this.gLate;
    if (total < this.incumbentCost) {
      this.incumbentCost = total;
      this.incumbent.set(this.assign);
    }
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  private search(assigned: number, sepRemainder: number, discrepancy: number): void {
    if (assigned === this.n) {
      this.descents++;
      const total = this.base + this.gSep + this.gCap + this.gLate;
      if (total < this.incumbentCost) {
        this.incumbentCost = total;
        this.incumbent.set(this.assign);
      }
      return;
    }

    // Cheap pre-test before paying for a scan. `sepRemainder` is the parent's
    // Σ min live separable cost minus the min of the chunk it just placed: a
    // valid lower bound here, because every other chunk's live minimum can only
    // RISE as domains shrink. It deliberately omits the cap and lateness
    // floors — including them would double-count what the parent's floors
    // already charged for the chunk now sitting in g. Most children die here,
    // and scan() is the engine's dominant cost: it runs once per CANDIDATE, not
    // once per branching node.
    if (sepRemainder >= 0) {
      const cheap = this.base + this.gSep + this.gCap + this.gLate + sepRemainder;
      if (cheap >= this.incumbentCost) {
        if (cheap < this.minAbandoned) this.minAbandoned = cheap;
        return;
      }
    }

    const c = this.scan();
    if (c < 0) return; // no completion exists below here: refuted, not abandoned
    const bound = this.base + this.gSep + this.gCap + this.gLate + this.remainderBound;
    if (bound >= this.incumbentCost) {
      if (bound < this.minAbandoned) this.minAbandoned = bound;
      return;
    }
    if (this.nodes >= this.nodeCap || this.outOfTime()) {
      this.aborted = true;
      if (bound < this.minAbandoned) this.minAbandoned = bound;
      return;
    }
    this.nodes++;

    const order = this.domOrder[c]!;
    const slots = this.domSlots[c]!;
    const childSepRemainder = this.sumMinSep - this.liveMinCost[c]!;
    const limit = this.discrepancyLimit;
    // LDS: `rank` counts the LEGAL values already tried at this node, so the
    // heuristic's own choice (rank 0) is free and each step away from it costs
    // one discrepancy. A limit of 0 is therefore exactly the greedy path.
    let rank = 0;
    for (let k = 0; k < order.length; k++) {
      const pos = order[k]!;
      if (!this.legal(c, slots[pos]!)) continue;
      if (limit >= 0 && discrepancy + rank > limit) {
        // `bound` lower-bounds every completion below this node, the values
        // just cut included — the same accounting a budget abort uses.
        this.truncated = true;
        if (bound < this.minAbandoned) this.minAbandoned = bound;
        return;
      }
      this.apply(c, pos);
      this.search(assigned + 1, childSepRemainder, discrepancy + rank);
      this.undo(c);
      rank++;
      if (this.aborted) {
        // Every untried value below this node has a completion cost >= bound,
        // so `bound` is a valid lower bound for the abandoned remainder.
        if (bound < this.minAbandoned) this.minAbandoned = bound;
        return;
      }
    }
  }

  /** Sampled on its OWN counter, not on `nodes`, so the stride holds during the
   * pre-search descents (which consume no nodes) as well as inside the search.
   * Latched: once the budget is gone it stays gone, so a blown deadline is not
   * ignored for up to another CLOCK_STRIDE checks at every level of the stack. */
  private outOfTime(): boolean {
    if (this.timedOut) return true;
    if (this.wallMs === Infinity) return false;
    // A zero (or negative) budget is out of time before it is sampled — the
    // stride must not buy a phase with no wall a first free CLOCK_STRIDE of
    // work.
    if (this.wallMs <= 0) {
      this.timedOut = true;
      return true;
    }
    if (this.clockTick++ % CLOCK_STRIDE !== 0) return false;
    if (this.now() - this.startedAt < this.wallMs) return false;
    this.timedOut = true;
    return true;
  }

  /** Fail-first variable selection over the unassigned chunks; also leaves the
   * admissible remainder cost in `remainderBound`. Returns -1 when some
   * unassigned chunk has an empty live domain (dead subtree). */
  private scan(): number {
    let best = -1;
    let bestCount = 0x7fffffff;
    let bestSpread = -1;
    let sum = 0;
    let sumLag = 0;
    const lagTables = this.lagCost;
    const days = this.days;
    const energetic = this.hasCappedContext;
    if (energetic) {
      this.remainSlots.fill(0);
      this.dayReach.fill(0);
    }
    for (let c = 0; c < this.n; c++) {
      if (this.assign[c]! >= 0) continue;
      const slots = this.domSlots[c]!;
      const costs = this.domCosts[c]!;
      const lagged = lagTables === null ? null : lagTables[c]!;
      const dur = this.durOf[c]!;
      const cx = energetic ? this.ctxOf[c]! : -1;
      let count = 0;
      let min = 0x7fffffff;
      let max = -1;
      let minStart = -1;
      let minLag = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        if (!this.legal(c, s)) continue;
        if (count === 0) minStart = s; // domSlots is slot-ascending
        count++;
        const v = costs[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
        if (lagged !== null) {
          // L(λ)'s inner minimisation over the SAME live domain the separable
          // term uses — narrower than the baked envelope, and narrower is
          // still admissible (every completion's start is legal here).
          const lv = lagged[i]!;
          if (lv < minLag) minLag = lv;
        }
        if (cx >= 0) {
          // Every day this placement would occupy is a day the remaining
          // demand can still reach. All spanned days must be marked: missing
          // one would understate free capacity and overstate the bound.
          let d0 = (s / SLOTS_PER_DAY) | 0;
          let d1 = ((s + dur - 1) / SLOTS_PER_DAY) | 0;
          if (d1 >= days) d1 = days - 1;
          const row = cx * days;
          for (let d = d0; d <= d1; d++) this.dayReach[row + d] = 1;
        }
      }
      if (count === 0) return -1;
      sum += min;
      if (lagged !== null) sumLag += minLag;
      this.liveMinStart[c] = minStart;
      this.liveMinCost[c] = min;
      if (cx >= 0) this.remainSlots[cx]! += dur;
      const spread = max - min;
      if (count < bestCount || (count === bestCount && spread > bestSpread)) {
        best = c;
        bestCount = count;
        bestSpread = spread;
      }
    }
    this.sumMinSep = sum;
    // The separable sum and L(λ) are two lower bounds on the SAME quantity
    // (the unplaced chunks' remaining separable cost), so the stronger one
    // wins; the two coupling floors price disjoint components (cap overrun,
    // lateness) and stay additive on top.
    let remainder = sum;
    if (lagTables !== null) {
      const lagBound = intBound(sumLag - this.freeLambda);
      if (lagBound > remainder) remainder = lagBound;
    }
    const floors = (energetic ? this.energeticCapFloor() : 0) + this.latenessFloor();
    this.remainderNoHook = remainder + floors;
    if (this.remainderHook !== null) {
      const injected = this.remainderHook(this.residual());
      if (injected > remainder) remainder = injected;
    }
    this.remainderBound = remainder + floors;
    return best;
  }

  /** The current residual as the shared bound seam sees it: live occupancy
   * plus the global indices of everything still unplaced. Only built when a
   * caller injected a hook — it allocates. */
  private residual(): Residual {
    const unplaced: number[] = [];
    for (let c = 0; c < this.n; c++) {
      if (this.assign[c]! < 0) unplaced.push(this.globalOf[c]!);
    }
    return { occ: this.occ, unplaced };
  }

  /** Optimise λ at the root and install it for the rest of the solve. Skipped
   * entirely when the multipliers come back all-zero (no contention to price):
   * the search then keeps the cheaper separable-only scan. */
  private optimizeLagrangian(): void {
    const horizon = this.baked.horizon;
    if (horizon === 0 || this.n === 0) return;
    const unplaced = new Array<number>(this.n);
    const domains = new Array<{ slots: Int32Array; costs: Int32Array }>(this.n);
    let work = 0;
    for (let c = 0; c < this.n; c++) {
      unplaced[c] = this.globalOf[c]!;
      // the WORKING domains, not the baked envelopes: unary event-dependency
      // bounds have already been folded in, and tuning λ against slots those
      // bounds forbid only weakens the fused bound the search then uses.
      domains[c] = { slots: this.domSlots[c]!, costs: this.domCosts[c]! };
      work += this.domSlots[c]!.length;
    }
    const residual: Residual = {
      occ: this.baked.externalMask,
      unplaced,
      domains,
      // Any feasible total bounds the optimum, and every cost component is
      // non-negative, so the incumbent minus the streak constant is a ceiling
      // on the optimum's separable part — the Polyak target.
      ...(this.incumbentCost === Infinity
        ? {}
        : { upperBound: this.incumbentCost - this.base }),
    };
    const state = optimizeMultipliers(this.baked, residual, iterationBudget(work));

    let priced = false;
    for (let t = 0; t < horizon; t++) {
      if (state.lambda[t]! > 0) {
        priced = true;
        break;
      }
    }
    if (!priced) return;

    this.lambda = state.lambda;
    const prefix = this.lambdaPrefix;
    let run = 0;
    prefix[0] = 0;
    for (let t = 0; t < horizon; t++) {
      run += state.lambda[t]!;
      prefix[t + 1] = run;
    }
    const tables = new Array<Float64Array>(this.n);
    for (let c = 0; c < this.n; c++) {
      const slots = this.domSlots[c]!;
      const costs = this.domCosts[c]!;
      const dur = this.durOf[c]!;
      const table = new Float64Array(slots.length);
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        table[i] = LAMBDA_SCALE * costs[i]! + (prefix[s + dur]! - prefix[s]!);
      }
      tables[c] = table;
    }
    this.lagCost = tables;
  }

  /** Energetic lower bound on the daily-cap penalty still to be paid.
   *
   * Every completion places exactly `remain` more slots of a capped context,
   * and all of them land on days that context's unplaced chunks can still
   * reach. On such a day at most max(0, cap − used) of those slots escape the
   * cap, so at most `freeCap` of the remaining slots are unpenalised and at
   * least `remain − freeCap` each cost `penalty`. Those are exactly the future
   * increments to gCap, which prices only slots already placed — so adding
   * this to the bound double-counts nothing.
   *
   * Both relaxations (the union of reachable days rather than a per-chunk
   * assignment, and clamping an over-cap day to zero free rather than negative)
   * only ever make freeCap larger, i.e. the bound smaller. It stays admissible. */
  private energeticCapFloor(): number {
    const days = this.days;
    let extra = 0;
    for (let cx = 0; cx < this.nCtx; cx++) {
      const remain = this.remainSlots[cx]!;
      if (remain === 0) continue;
      const cap = this.capSlots[cx]!;
      if (cap < 0) continue;
      const row = cx * days;
      let freeCap = 0;
      for (let d = 0; d < days; d++) {
        if (this.dayReach[row + d] === 0) continue;
        const free = cap - this.dayUsed[row + d]!;
        if (free > 0) freeCap += free;
        if (freeCap >= remain) break; // cannot bind
      }
      if (remain > freeCap) extra += this.capPenalty[cx]! * (remain - freeCap);
    }
    return extra;
  }

  /** Per-task lower bound on the lateness still to be paid. A chunk's live
   * domain only shrinks as the search descends, so its earliest live start is a
   * floor on where it can finish; lateness is monotone in the task's end, so
   * pricing that floor is admissible. Only the part not already counted in
   * gLate is added — never both. */
  private latenessFloor(): number {
    let extra = 0;
    for (let tl = 0; tl < this.nt; tl++) {
      if (this.taskHasDeadline[tl] === 0) continue;
      let floorEnd = -1;
      if (this.taskOrdered[tl] === 1) {
        // Only the last chunk's end matters; once placed, gLate is exact.
        const c = this.taskLastChunk[tl]!;
        if (this.assign[c]! >= 0) continue;
        floorEnd = this.liveMinStart[c]! + this.durOf[c]!;
      } else {
        const from = this.taskChunkOffset[tl]!;
        const to = this.taskChunkOffset[tl + 1]!;
        let anyUnplaced = false;
        for (let c = from; c < to; c++) {
          const placed = this.assign[c]!;
          const end =
            placed >= 0 ? placed + this.durOf[c]! : this.liveMinStart[c]! + this.durOf[c]!;
          if (placed < 0) anyUnplaced = true;
          if (end > floorEnd) floorEnd = end;
        }
        if (!anyUnplaced) continue; // gLate is already exact for this task
      }
      const late = Math.max(0, floorEnd - this.taskDeadline[tl]!) * this.taskPenalty[tl]!;
      const unaccounted = late - this.taskLate[tl]!;
      if (unaccounted > 0) extra += unaccounted;
    }
    return extra;
  }

  /** Hard legality of start `s` for chunk `c` against the current partial
   * assignment: occupancy (externals + placed chunks) and every binary
   * constraint whose other endpoint is already placed. */
  private legal(c: number, s: number): boolean {
    const end = s + this.durOf[c]!;
    // Word-parallel occupancy test: a chunk spans at most a handful of words,
    // so this is 1–3 loads instead of one bit test per slot. This is the
    // hottest line in the engine — scan() runs it once per candidate start of
    // every unplaced chunk, at every node.
    const occ = this.occ;
    const wFirst = s >>> 5;
    const wLast = (end - 1) >>> 5;
    const headMask = 0xffffffff << (s & 31);
    if (wFirst === wLast) {
      const tailMask = 0xffffffff >>> (31 - ((end - 1) & 31));
      if ((occ[wFirst]! & headMask & tailMask) !== 0) return false;
    } else {
      if ((occ[wFirst]! & headMask) !== 0) return false;
      for (let w = wFirst + 1; w < wLast; w++) {
        if (occ[w]! !== 0) return false;
      }
      if ((occ[wLast]! & (0xffffffff >>> (31 - ((end - 1) & 31)))) !== 0) return false;
    }
    const from = this.conOffset[c]!;
    const to = this.conOffset[c + 1]!;
    for (let k = from; k < to; k++) {
      const o = this.conOther[k]!;
      const os = this.assign[o]!;
      if (os < 0) continue;
      switch (this.conKind[k]!) {
        case K_SAME_DAY:
          if (((s / SLOTS_PER_DAY) | 0) !== ((os / SLOTS_PER_DAY) | 0)) return false;
          break;
        case K_BEFORE:
          if (end > os) return false;
          break;
        case K_AFTER:
          if (s < os + this.durOf[o]!) return false;
          break;
        case K_LE:
          if (s > os) return false;
          break;
        default:
          if (s < os) return false;
          break;
      }
    }
    return true;
  }

  private positionOf(c: number, slotValue: number): number {
    const slots = this.domSlots[c]!;
    let lo = 0;
    let hi = slots.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = slots[mid]!;
      if (v === slotValue) return mid;
      if (v < slotValue) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // incremental state
  // -------------------------------------------------------------------------

  private reset(): void {
    this.assign.fill(-1);
    this.assignPos.fill(-1);
    this.occ.set(this.baked.externalMask);
    this.dayUsed.fill(0);
    this.taskLate.fill(0);
    this.gSep = 0;
    this.gCap = 0;
    this.gLate = 0;
    this.assignedCount = 0;
    this.frozenUnrealisable = false;
    // The frozen prefix goes down first and never comes back up. λ is null
    // whenever there is a prefix at all (optimizeLagrangian is skipped for a
    // sub-solve), so apply()'s multiplier bookkeeping is inert here and
    // freeLambda below still sees the final occupancy.
    for (let k = 0; k < this.frozenCount; k++) {
      const c = this.frozenLocal[k]!;
      const slots = this.domSlots[c]!;
      if (slots.length !== 1 || !this.legal(c, slots[0]!)) {
        this.frozenUnrealisable = true;
        return;
      }
      this.apply(c, 0);
    }
    if (this.lambda !== null) {
      const lam = this.lambda;
      const occ = this.occ;
      let sum = 0;
      for (let t = 0; t < this.baked.horizon; t++) {
        if (((occ[t >> 5]! >>> (t & 31)) & 1) === 0) sum += lam[t]!;
      }
      this.freeLambda = sum;
    }
  }

  private apply(c: number, pos: number): void {
    const s = this.domSlots[c]![pos]!;
    this.assignedCount++;
    this.assign[c] = s;
    this.assignPos[c] = pos;
    this.gSep += this.domCosts[c]![pos]!;
    const end = s + this.durOf[c]!;
    const occ = this.occ;
    for (let k = s; k < end; k++) occ[k >> 5]! |= 1 << (k & 31);
    if (this.lambda !== null) {
      this.freeLambda -= this.lambdaPrefix[end]! - this.lambdaPrefix[s]!;
    }
    this.capDelta(c, s, 1);
    this.refreshLateness(this.taskOf[c]!);
  }

  private undo(c: number): void {
    this.assignedCount--;
    const s = this.assign[c]!;
    const end = s + this.durOf[c]!;
    const occ = this.occ;
    for (let k = s; k < end; k++) occ[k >> 5]! &= ~(1 << (k & 31));
    if (this.lambda !== null) {
      this.freeLambda += this.lambdaPrefix[end]! - this.lambdaPrefix[s]!;
    }
    this.capDelta(c, s, -1);
    this.gSep -= this.domCosts[c]![this.assignPos[c]!]!;
    this.assign[c] = -1;
    this.assignPos[c] = -1;
    this.refreshLateness(this.taskOf[c]!);
  }

  /** Per-(context, day) cap accounting, mirroring objective.daily_cap_terms:
   * used = Σ slot overlap with the day, penalty = max(0, used − cap) × rate.
   * The walk covers every day the chunk touches — in practice one, or two for
   * a midnight-spanning chunk, but a chunk longer than a day is handled the
   * same way — so update and undo are O(days spanned), i.e. O(1) in practice. */
  private capDelta(c: number, s: number, sign: number): void {
    const cx = this.ctxOf[c]!;
    if (cx < 0) return;
    const days = this.days;
    let d0 = (s / SLOTS_PER_DAY) | 0;
    if (d0 >= days) return;
    const end = s + this.durOf[c]!;
    let d1 = ((end - 1) / SLOTS_PER_DAY) | 0;
    if (d1 >= days) d1 = days - 1;
    if (d0 < 0) d0 = 0;
    const cap = this.capSlots[cx]!;
    const penalty = this.capPenalty[cx]!;
    for (let d = d0; d <= d1; d++) {
      const lo = d * SLOTS_PER_DAY;
      const hi = lo + SLOTS_PER_DAY;
      const overlap = Math.min(end, hi) - Math.max(s, lo);
      if (overlap <= 0) continue;
      const at = cx * days + d;
      const before = this.dayUsed[at]!;
      const after = before + sign * overlap;
      this.dayUsed[at] = after;
      this.gCap +=
        penalty * (Math.max(0, after - cap) - Math.max(0, before - cap));
    }
  }

  /** Per-task lateness against a soft deadline. objective.lateness_terms takes
   * the LAST chunk's end for an ordered task and the max end otherwise; over a
   * partial assignment both are lower bounds on the final value (the max only
   * grows as chunks land), which keeps the node bound admissible. */
  private refreshLateness(tl: number): void {
    if (this.taskHasDeadline[tl] === 0) return;
    const deadline = this.taskDeadline[tl]!;
    let endMax = -1;
    if (this.taskOrdered[tl] === 1) {
      const c = this.taskLastChunk[tl]!;
      if (this.assign[c]! >= 0) endMax = this.assign[c]! + this.durOf[c]!;
    } else {
      const from = this.taskChunkOffset[tl]!;
      const to = this.taskChunkOffset[tl + 1]!;
      for (let c = from; c < to; c++) {
        if (this.assign[c]! < 0) continue;
        const end = this.assign[c]! + this.durOf[c]!;
        if (end > endMax) endMax = end;
      }
    }
    const late =
      endMax < 0 ? 0 : Math.max(0, endMax - deadline) * this.taskPenalty[tl]!;
    this.gLate += late - this.taskLate[tl]!;
    this.taskLate[tl] = late;
  }
}

/** Subgradient iterations for a root whose live domains total `work` starts.
 * One iteration visits each of those starts once and does O(1) work at each
 * (the module's span-free test is a prefix-sum subtraction), so the loop is
 * genuinely O(iterations × work) and this budget is an honest ceiling on
 * element visits. The count is traded against instance size to bound the
 * root's fixed overhead — deterministic, a function of the problem and never
 * of the clock — and stays inside the spec's 50–200 band throughout. */
export function iterationBudget(work: number): number {
  const ITERATION_ELEMENT_BUDGET = 20_000_000;
  const MIN_ITERATIONS = 50;
  const MAX_ITERATIONS = 200;
  if (work <= 0) return MIN_ITERATIONS;
  const scaled = Math.floor(ITERATION_ELEMENT_BUDGET / work);
  if (scaled < MIN_ITERATIONS) return MIN_ITERATIONS;
  if (scaled > MAX_ITERATIONS) return MAX_ITERATIONS;
  return scaled;
}

/** Tasks that are the source or the resolved target of any hard dependency —
 * fast_model._dependency_involved_task_ids, which disqualifies them from the
 * interchangeable-chunk symmetry break. */
function dependencyInvolvedTasks(baked: Baked): Set<number> {
  const involved = new Set<number>();
  for (const task of baked.tasks) {
    if (task.deps.length === 0) continue;
    involved.add(task.index);
    for (const dep of task.deps) {
      if (dep.taskIndex >= 0) involved.add(dep.taskIndex);
    }
  }
  return involved;
}
