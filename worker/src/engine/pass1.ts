// Pass 1 — selection branch-and-bound (card B).
//
// Chooses the kept/dropped partition minimizing Σ dropWeight over dropped
// tasks, subject to every HARD constraint and the shared timeline. Soft costs
// play no part here: pass 2 (pass2.ts) places the survivors. This mirrors the
// Python fast path's pass-1 semantics (solver/src/solver/two_pass.py drop
// minimisation over solver/src/solver/fast_model.py's build_pass1_model),
// which is the executable spec for everything below.
//
// The two exported functions are the card's seams:
//
//   selectTasks   — the branch-and-bound itself.
//   packFeasible  — "can exactly these tasks be packed?", with a witness
//                   placement. Also the MUS layer's deletion test and
//                   isolation primitive (mus.ts), so it is correct and
//                   deterministic standalone, not merely as a search
//                   subroutine.
//
// Hardness ⊥ droppability: an unplaceable task (empty domain, hard window it
// cannot satisfy, contention it loses) is DROPPED. Infeasibility is reachable
// only when must_include removes a task's drop branch — plus the overlapping-
// externals case, which substrate.ts returns before any search.
//
// Pure, dependency-free TypeScript over typed arrays: no Cloudflare imports,
// no Node imports. The per-problem context is built once and cached; the
// search loops themselves allocate nothing, though the selection tree does
// take a typed-array snapshot per keep branch and hands out subarray views
// when it restores one.

import { buildHallIndex, hallRefutesResidual } from "./hall";
import type { HallIndex } from "./hall";
import type { Baked, Budget, Pass1Result, Placement } from "./types";

const SLOTS_PER_DAY = 96;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Cap on each band family (see buildBands). The lattice is quadratic in the
 * task count; prod instances have a handful of tasks, so the cap only bites on
 * the synthetic heavy tier — where the bands most likely to bind (the global
 * one, then the narrowest windows) are the ones emitted first, and each family
 * gets its own allowance so neither can starve the other. */
const MAX_BANDS_PER_FAMILY = 128;

const EMPTY_DOMAIN = new Int32Array(0);

const INFEASIBLE = 0;
const FEASIBLE = 1;
const BUDGET_HIT = -1;
/** One feasibility check gave up (see PACK_NODE_CAP). */
const PACK_LIMIT = -2;

/** Node ceiling on a SINGLE feasibility check inside the selection search.
 * Proving a crowded kept set infeasible is the expensive direction, and one
 * such proof can otherwise swallow the whole wall-clock budget while the
 * selection tree stands still. Hitting it inside the search abandons that keep
 * branch and costs the solve its certificate (`proved: false`) but not its
 * correctness — the incumbent was verified before that branch was tried. On
 * the must_include SEED pack there is no verified incumbent to fall back on;
 * see selectTasks for what `proved: false` means there.
 *
 * The exported `packFeasible` is deliberately NOT capped: the MUS layer needs
 * a definite answer. That leaves its CPU unbounded on a crowded set the bands
 * cannot refute — a budgeted three-valued variant is the follow-up. */
const PACK_NODE_CAP = 20000;

/** A bounded keep-branch REPAIR — free only the placed chunks standing on the
 * new task's domain and re-place them, instead of re-packing the whole kept
 * set from cold — was built and measured here, and is deliberately NOT shipped
 * (it is one commit back on this branch if it is wanted).
 *
 * It works: it improves pass 1's own objective on every problem it touches
 * (preferred_window_hard-heavy 40 → 38 drops, combo_deadline_window-heavy
 * 42290 → 37891 — and note 42290 is not a good number to start from, it is
 * itself a regression from that problem's 34778 baseline, taken while its
 * drops fall 64 → 49, past CP-SAT's 50; card D's improvement phase is the
 * recovery path for the placement cost). But keeping more tasks is not free
 * downstream — on
 * preferred_window_hard-heavy the two extra tasks push the kept set from 65 to
 * 67, which is more than pass 2 can complete a single descent over, so the
 * solve falls back to serving the pass-1 witness (FEASIBLE → PASS1_FALLBACK).
 * The cliff is pass 2's, not pass 1's, and it applies to any lever that makes
 * pass 1 keep more. Revisit once D1/D3 give pass 2 the descent capacity. */

/** The interval Hall cut is evaluated once per pack ATTEMPT (packSearch), not
 * at every node of the pack DFS. That was measured, not assumed: a per-node
 * sweep costs O(horizon + |B|²) — ~10k operations on the crowded heavy
 * problems — against a DFS node that costs a fraction of that, and on the two
 * class-B acceptance problems it changed no answer at all while pushing pass 1
 * from its node cap (6.2 s / 7.2 s) to its 20 s wall. The states a pack DFS
 * reaches are refuted by per-chunk propagation or not at all; the cut earns
 * its keep on the SET question, which is asked once per attempt.
 *
 * Be honest about what the cut is worth on THIS corpus: isolated, it has zero
 * measured effect on all four target heavies. It is consulted on every one of
 * them and fires on none, because their envelopes carry no window structure to
 * exploit — business_hours-heavy and combo_oversubscribed-heavy have |B| = 4,
 * and the two class-B problems' domains are so fragmented that their hulls are
 * near-horizon-wide (an exact max-flow Hall check, which subsumes every cut
 * this module can produce, also refutes 0 of 40 of their pack-limited sets).
 * Every heavy-tier number on this branch — business_hours-heavy's OPTIMAL
 * included — comes from the branching order below, not from the cut. The cut
 * is kept because it is sound and near-free, and the randomised suite shows it
 * firing on the fragmented multi-chunk structures the corpus's heavies happen
 * not to have. */

// ---------------------------------------------------------------------------
// Static per-problem context (built once per Baked, cached)
// ---------------------------------------------------------------------------

interface Ctx {
  baked: Baked;
  nTasks: number;
  nChunks: number;
  horizon: number;

  chunkTask: Int32Array;
  chunkDur: Int32Array;
  /** Position of the chunk within its task's chunk list. */
  chunkOrdinal: Int32Array;

  /** Filtered domains, concatenated; slice of chunk c is [domOff[c], domOff[c+1]). */
  domOff: Int32Array;
  domVals: Int32Array;

  taskDurSlots: Int32Array;
  taskDropWeight: Int32Array;
  taskMustInclude: Uint8Array;
  /** Some chunk of this task has an empty domain: it can never be kept. */
  taskUnplaceable: Uint8Array;

  /** Binary hard-dependency constraints, start[a] >= start[b] + k, active only
   * while BOTH endpoint tasks are in the set. */
  binA: Int32Array;
  binB: Int32Array;
  binK: Int32Array;
  binByChunkOff: Int32Array;
  binByChunk: Int32Array;

  /** Symmetry break between interchangeable consecutive chunks: start[a] <=
   * start[b] (mirrors fast_model._add_symmetry_breaking). */
  symA: Int32Array;
  symB: Int32Array;
  symByChunkOff: Int32Array;
  symByChunk: Int32Array;

  /** Capacity-cut bands (fast_model._add_capacity_cut arithmetic). */
  bandCount: number;
  bandCap: Int32Array;
  bandOff: Int32Array;
  /** Member task indices per band, ordered by drop weight per slot ascending. */
  bandMembers: Int32Array;
  bandTaskOff: Int32Array;
  bandTask: Int32Array;

  /** Branching order: descending drop weight per occupied slot, ties by index. */
  order: Int32Array;

  /** D2 interval Hall cuts (hall.ts). Null when the problem has no window
   * structure to exploit — a single envelope boundary pair means the only
   * window is the horizon itself, which the global capacity band already
   * prices, so the sweep would be pure overhead. */
  hall: HallIndex | null;
}

const CTX_CACHE = new WeakMap<Baked, Ctx>();

function getCtx(baked: Baked): Ctx {
  let ctx = CTX_CACHE.get(baked);
  if (ctx === undefined) {
    ctx = buildCtx(baked);
    CTX_CACHE.set(baked, ctx);
  }
  return ctx;
}

function timeToMinutes(t: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m === null) throw new Error(`invalid time of day: ${t}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function maskBit(mask: Uint32Array, bit: number): number {
  return (mask[bit >> 5]! >>> (bit & 31)) & 1;
}

function buildCtx(baked: Baked): Ctx {
  const nTasks = baked.tasks.length;
  const nChunks = baked.chunks.length;
  const horizon = baked.horizon;

  const chunkTask = new Int32Array(nChunks);
  const chunkDur = new Int32Array(nChunks);
  const chunkOrdinal = new Int32Array(nChunks);
  for (const chunk of baked.chunks) {
    chunkTask[chunk.index] = chunk.taskIndex;
    chunkDur[chunk.index] = chunk.durationSlots;
  }
  const taskFirst = new Int32Array(nTasks).fill(-1);
  const taskLast = new Int32Array(nTasks).fill(-1);
  const taskDurSlots = new Int32Array(nTasks);
  const taskDropWeight = new Int32Array(nTasks);
  const taskMustInclude = new Uint8Array(nTasks);
  for (const task of baked.tasks) {
    taskDropWeight[task.index] = task.dropWeight;
    taskMustInclude[task.index] = task.mustInclude ? 1 : 0;
    for (let i = 0; i < task.chunkIndices.length; i++) {
      const c = task.chunkIndices[i]!;
      chunkOrdinal[c] = i;
      taskDurSlots[task.index]! += chunkDur[c]!;
    }
    if (task.chunkIndices.length > 0) {
      taskFirst[task.index] = task.chunkIndices[0]!;
      taskLast[task.index] = task.chunkIndices[task.chunkIndices.length - 1]!;
    }
  }

  // ----- static domain filtering -----
  //
  // Three restrictions hold for every solution that keeps the task, so they
  // are applied once here rather than re-derived per node: external occupancy
  // (externals are always present), hard event dependencies (unary on the
  // task's first/last chunk) and the ordered chain's bound propagation.
  const extFreeRun = new Int32Array(horizon + 1);
  for (let s = horizon - 1; s >= 0; s--) {
    extFreeRun[s] = maskBit(baked.externalMask, s) === 1 ? 0 : extFreeRun[s + 1]! + 1;
  }

  const domains: Int32Array[] = new Array<Int32Array>(nChunks);
  for (const task of baked.tasks) {
    let evLo = 0;
    let evHi = horizon;
    for (const dep of task.deps) {
      if (dep.type === "after_event") {
        if (dep.eventEndSlot > evLo) evLo = dep.eventEndSlot;
      } else if (dep.type === "before_event") {
        if (dep.eventStartSlot < evHi) evHi = dep.eventStartSlot;
      }
    }
    const first = taskFirst[task.index]!;
    const last = taskLast[task.index]!;
    for (const c of task.chunkIndices) {
      const dur = chunkDur[c]!;
      // after_event bounds the task's first start; before_event its last end.
      const lo = c === first ? evLo : 0;
      const hi = c === last ? evHi - dur : horizon - dur;
      const src = baked.chunks[c]!.allowedStarts;
      const out: number[] = [];
      for (let i = 0; i < src.length; i++) {
        const s = src[i]!;
        if (s < lo || s > hi) continue;
        if (extFreeRun[s]! < dur) continue;
        out.push(s);
      }
      domains[c] = Int32Array.from(out);
    }
  }

  for (const task of baked.tasks) {
    if (!task.ordered || task.chunkIndices.length < 2) continue;
    // forward: start[i] >= start[i-1] + dur[i-1]
    let minStart = 0;
    for (const c of task.chunkIndices) {
      domains[c] = clampDomain(domains[c]!, minStart, horizon);
      if (domains[c]!.length === 0) break;
      minStart = domains[c]![0]! + chunkDur[c]!;
    }
    // backward: start[i] <= start[i+1] - dur[i]
    let maxStart = horizon;
    for (let i = task.chunkIndices.length - 1; i >= 0; i--) {
      const c = task.chunkIndices[i]!;
      domains[c] = clampDomain(domains[c]!, 0, maxStart - chunkDur[c]!);
      if (domains[c]!.length === 0) break;
      maxStart = domains[c]![domains[c]!.length - 1]!;
    }
  }

  // ----- binary hard dependencies -----
  const binA: number[] = [];
  const binB: number[] = [];
  const binK: number[] = [];
  const depInvolved = new Uint8Array(nTasks);
  for (const task of baked.tasks) {
    const first = taskFirst[task.index]!;
    const last = taskLast[task.index]!;
    for (const dep of task.deps) {
      if (dep.type === "after_event" || dep.type === "before_event") {
        depInvolved[task.index] = 1;
        continue;
      }
      const other = dep.taskIndex;
      if (other < 0 || first < 0) continue;
      const otherFirst = taskFirst[other]!;
      const otherLast = taskLast[other]!;
      if (otherFirst < 0) continue;
      depInvolved[task.index] = 1;
      depInvolved[other] = 1;
      let a: number;
      let b: number;
      if (dep.type === "after_task") {
        // start[first] >= start[otherLast] + dur[otherLast]
        a = first;
        b = otherLast;
      } else {
        // start[last] + dur[last] <= start[otherFirst]
        a = otherFirst;
        b = last;
      }
      const gap = chunkDur[b]!;
      if (a === b) {
        // start >= start + duration: no solution. A single-chunk task that
        // depends on itself is unplaceable — Python builds the same constraint
        // and its model goes UNSAT for the task, so the degenerate edge must
        // not be quietly dropped. (A multi-chunk self-dependency lands on two
        // different chunks and stays an ordinary constraint.)
        if (gap > 0) domains[a] = EMPTY_DOMAIN;
        continue;
      }
      binA.push(a);
      binB.push(b);
      binK.push(gap);
    }
  }
  const [binByChunkOff, binByChunk] = csrFromPairs(nChunks, binA, binB);

  // ----- flatten domains; a task with any empty domain can never be kept -----
  const domOff = new Int32Array(nChunks + 1);
  for (let c = 0; c < nChunks; c++) domOff[c + 1] = domOff[c]! + domains[c]!.length;
  const domVals = new Int32Array(domOff[nChunks]!);
  for (let c = 0; c < nChunks; c++) domVals.set(domains[c]!, domOff[c]!);

  const taskUnplaceable = new Uint8Array(nTasks);
  for (const task of baked.tasks) {
    for (const c of task.chunkIndices) {
      if (domains[c]!.length === 0) {
        taskUnplaceable[task.index] = 1;
        break;
      }
    }
  }

  // ----- occupancy envelope per task: [earliest possible start, latest
  // possible end) over the task's baked domains. Strictly tighter than
  // [earliest_start, hard deadline) and, unlike it, it sees availability
  // windows, hard preferred windows, pins and the business-hours floor —
  // every restriction the domains already carry. -----
  const envLo = new Int32Array(nTasks);
  const envHi = new Int32Array(nTasks);
  const banded = new Uint8Array(nTasks);
  for (const task of baked.tasks) {
    const t = task.index;
    if (taskUnplaceable[t] === 1 || taskDurSlots[t]! === 0) continue;
    let lo = horizon;
    let hi = 0;
    for (const c of task.chunkIndices) {
      const dom = domains[c]!;
      if (dom[0]! < lo) lo = dom[0]!;
      const end = dom[dom.length - 1]! + chunkDur[c]!;
      if (end > hi) hi = end;
    }
    envLo[t] = lo;
    envHi[t] = hi;
    banded[t] = 1;
  }

  // ----- symmetry breaking between interchangeable chunks -----
  const symA: number[] = [];
  const symB: number[] = [];
  for (const task of baked.tasks) {
    if (task.chunkIndices.length < 2) continue;
    if (task.ordered || task.pinnedSlot >= 0 || depInvolved[task.index] === 1) continue;
    for (let i = 1; i < task.chunkIndices.length; i++) {
      const a = task.chunkIndices[i - 1]!;
      const b = task.chunkIndices[i]!;
      if (chunkDur[a] !== chunkDur[b]) continue;
      // A chunk with a live previous placement is not interchangeable — its
      // churn cost is start-dependent (fast_model._symmetric_chunk_pairs).
      // Python disqualifies a chunk on ANY previous_placement entry; prevSlot
      // is -1 for an out-of-window one too, so the break is applied in a few
      // cases Python skips. Safe in that direction: an out-of-window previous
      // placement carries no churn, so the pair really is interchangeable.
      if (baked.chunks[a]!.prevSlot >= 0 || baked.chunks[b]!.prevSlot >= 0) continue;
      symA.push(a);
      symB.push(b);
    }
  }
  const [symByChunkOff, symByChunk] = csrFromPairs(nChunks, symA, symB);

  const bands = buildBands(baked, taskDurSlots, taskDropWeight, envLo, envHi, banded);

  // Branching order: drop weight PER OCCUPIED SLOT, descending. Pass 1
  // minimises Σ dropWeight subject to a shared timeline, so two tasks of equal
  // weight are not equally worth keeping — the longer one costs the week far
  // more capacity. This is the same fractional-knapsack ratio `buildBands`
  // already sorts its members by for its bound, now also driving the search
  // order, which makes the greedy first descent a good incumbent rather than
  // one the search has to climb out of.
  //
  // This one line is where every heavy-tier gain on this branch comes from —
  // the Hall cut above contributes nothing measurable on any of them. Measured
  // from the ordering alone: availability_windows-heavy 26 → 18 drops
  // (PASS1_FALLBACK → FEASIBLE), preferred_window_hard-heavy 51 → 40
  // (PASS1_FALLBACK → FEASIBLE), and business_hours-heavy 64 → 52 drops,
  // FEASIBLE → OPTIMAL at objective 13136 — the CP-SAT reference exactly — in
  // 0.86 s where it previously spent 5.54 s exploring 4.25M selection nodes.
  // Reordering the PACK DFS instead was measured and rejected: it is not
  // robust. Trying left-aligned starts first, and a full best-fit sort by
  // containing-free-run length, each helped availability_windows-heavy
  // (26 → 20 drops) while COSTING preferred_window_hard-heavy (51 → 52 and
  // 53); preferring the longest-duration chunk among equally-constrained ones
  // hurt both (23 and 53). Trading one acceptance problem for the other is not
  // an improvement, so the pack DFS keeps its ascending-slot value order and
  // its pure fail-first variable order, and the selection tree above is where
  // the ordering change lives.
  const order = Int32Array.from(baked.tasks.map((t) => t.index)).sort((a, b) => {
    // Cross-multiplied to stay in integers. A task with no chunks occupies
    // nothing, so it is treated as one slot rather than dividing by zero.
    const da = taskDurSlots[a]! > 0 ? taskDurSlots[a]! : 1;
    const db = taskDurSlots[b]! > 0 ? taskDurSlots[b]! : 1;
    const cross = taskDropWeight[b]! * da - taskDropWeight[a]! * db;
    return cross !== 0 ? cross : a - b;
  });

  const hallIndex = buildHallIndex(baked);

  return {
    baked,
    nTasks,
    nChunks,
    horizon,
    chunkTask,
    chunkDur,
    chunkOrdinal,
    domOff,
    domVals,
    taskDurSlots,
    taskDropWeight,
    taskMustInclude,
    taskUnplaceable,
    binA: Int32Array.from(binA),
    binB: Int32Array.from(binB),
    binK: Int32Array.from(binK),
    binByChunkOff,
    binByChunk,
    symA: Int32Array.from(symA),
    symB: Int32Array.from(symB),
    symByChunkOff,
    symByChunk,
    ...bands,
    order,
    hall: hallIndex.boundaries.length > 2 ? hallIndex : null,
  };
}

function clampDomain(dom: Int32Array, lo: number, hi: number): Int32Array {
  let keep = 0;
  for (let i = 0; i < dom.length; i++) {
    const v = dom[i]!;
    if (v >= lo && v <= hi) keep++;
  }
  if (keep === dom.length) return dom;
  const out = new Int32Array(keep);
  let j = 0;
  for (let i = 0; i < dom.length; i++) {
    const v = dom[i]!;
    if (v >= lo && v <= hi) out[j++] = v;
  }
  return out;
}

/** CSR index: for each chunk, the constraint indices it participates in (as
 * either endpoint). */
function csrFromPairs(
  nChunks: number,
  a: number[],
  b: number[],
): [Int32Array, Int32Array] {
  const counts = new Int32Array(nChunks + 1);
  for (let i = 0; i < a.length; i++) {
    counts[a[i]! + 1]!++;
    if (b[i] !== a[i]) counts[b[i]! + 1]!++;
  }
  for (let c = 0; c < nChunks; c++) counts[c + 1]! += counts[c]!;
  const off = counts;
  const cursor = Int32Array.from(off.subarray(0, nChunks));
  const flat = new Int32Array(off[nChunks]!);
  for (let i = 0; i < a.length; i++) {
    flat[cursor[a[i]!]!++] = i;
    if (b[i] !== a[i]) flat[cursor[b[i]!]!++] = i;
  }
  return [off, flat];
}

// ---------------------------------------------------------------------------
// Capacity cuts (port of fast_model._add_capacity_cut)
// ---------------------------------------------------------------------------

interface Bands {
  bandCount: number;
  bandCap: Int32Array;
  bandOff: Int32Array;
  bandMembers: Int32Array;
  bandTaskOff: Int32Array;
  bandTask: Int32Array;
}

const NO_BANDS: Bands = {
  bandCount: 0,
  bandCap: new Int32Array(0),
  bandOff: new Int32Array(1),
  bandMembers: new Int32Array(0),
  bandTaskOff: new Int32Array(1),
  bandTask: new Int32Array(0),
};

/** Energetic bands: a kept task's whole occupancy lies inside its domain
 * envelope, so for any window [lo, hi) containing that envelope, the summed
 * duration of the kept members can never exceed the window's free capacity.
 *
 * The envelope — [earliest possible start, latest possible end) over the
 * task's baked domains — is what makes this see the crowding that matters.
 * `fast_model._add_capacity_cut` spans [earliest_start, hard deadline), which
 * is blind to availability windows, hard preferred windows and pins: an
 * availability-crowded week then has no arithmetic refutation at all and only
 * enumeration can settle it. The envelope is strictly tighter and covers all
 * four restriction kinds.
 *
 * Two families are generated over the same (lo, hi) lattice:
 *
 *  - a business-hours family — the Python cut's members and capacity:
 *    BH-clipped tasks against the free BH slots. Tighter than the general
 *    family wherever business hours leave the week sparse.
 *  - a general family — every placeable task, against every slot no external
 *    holds. The same energetic argument, and the one that prices a crowded
 *    week when no business hours are configured.
 *
 * Each band prunes keep branches (kept duration over capacity ⇒ dead) and
 * prices the drops still to come (fractional knapsack over the undecided
 * droppable members). */
function buildBands(
  baked: Baked,
  taskDurSlots: Int32Array,
  taskDropWeight: Int32Array,
  envLo: Int32Array,
  envHi: Int32Array,
  banded: Uint8Array,
): Bands {
  const horizon = baked.horizon;
  const bh = baked.problem.business_hours ?? null;

  // Free-slot prefix sums: [0] general (externals only), [1] business hours.
  const freePrefix: Int32Array[] = [new Int32Array(horizon + 1)];
  let bhSpec: { start: number; end: number; days: Set<number> } | null = null;
  if (bh !== null) {
    bhSpec = {
      start: timeToMinutes(bh.start),
      end: timeToMinutes(bh.end),
      days: new Set(bh.days.map((d) => WEEKDAYS.indexOf(d))),
    };
    freePrefix.push(new Int32Array(horizon + 1));
  }
  let anyBhSlot = false;
  for (let s = 0; s < horizon; s++) {
    const free = maskBit(baked.externalMask, s) === 0;
    freePrefix[0]![s + 1] = freePrefix[0]![s]! + (free ? 1 : 0);
    if (bhSpec !== null) {
      const inBh =
        bhSpec.days.has(baked.slotWeekday[s]!) &&
        baked.slotTod[s]! >= bhSpec.start &&
        baked.slotTod[s]! < bhSpec.end;
      if (inBh) anyBhSlot = true;
      freePrefix[1]![s + 1] = freePrefix[1]![s]! + (inBh && free ? 1 : 0);
    }
  }

  const caps: number[] = [];
  const offs: number[] = [0];
  const members: number[] = [];

  for (let family = 0; family < freePrefix.length; family++) {
    if (family === 1 && !anyBhSlot) break;
    const memberTasks: number[] = [];
    for (const task of baked.tasks) {
      if (banded[task.index] === 0) continue;
      if (family === 1 && !task.usedBusinessHours) continue;
      memberTasks.push(task.index);
    }
    if (memberTasks.length === 0) continue;

    const los = Array.from(new Set([0, ...memberTasks.map((t) => envLo[t]!)])).sort(
      (a, b) => a - b,
    );
    const his = Array.from(new Set([horizon, ...memberTasks.map((t) => envHi[t]!)])).sort(
      (a, b) => a - b,
    );

    // Emission order decides which bands survive the cap, so the valuable ones
    // go first: the global band, then the narrowest windows — a narrow band is
    // the one whose capacity a crowd is most likely to exceed. Each family has
    // its own cap so a task-rich general family cannot starve the BH family.
    const candidates: Array<[number, number]> = [];
    for (const lo of los) {
      for (const hi of his) if (hi > lo) candidates.push([lo, hi]);
    }
    candidates.sort((p, q) => {
      const pGlobal = p[0] === 0 && p[1] === horizon ? 0 : 1;
      const qGlobal = q[0] === 0 && q[1] === horizon ? 0 : 1;
      if (pGlobal !== qGlobal) return pGlobal - qGlobal;
      const pWidth = p[1] - p[0];
      const qWidth = q[1] - q[0];
      if (pWidth !== qWidth) return pWidth - qWidth;
      return p[0] - q[0];
    });

    const prefix = freePrefix[family]!;
    let emitted = 0;
    for (const [lo, hi] of candidates) {
      const picked: number[] = [];
      let total = 0;
      for (const t of memberTasks) {
        if (envLo[t]! >= lo && envHi[t]! <= hi) {
          picked.push(t);
          total += taskDurSlots[t]!;
        }
      }
      const isGlobal = lo === 0 && hi === horizon;
      if (picked.length < 2 && !isGlobal) continue;
      const cap = prefix[Math.min(hi, horizon)]! - prefix[Math.max(lo, 0)]!;
      if (total <= cap) continue; // never binding — skip the noise
      // Cheapest drop weight per occupied slot first: the greedy order that
      // makes the fractional-knapsack bound a valid lower bound.
      picked.sort((x, y) => {
        const cross =
          taskDropWeight[x]! * taskDurSlots[y]! - taskDropWeight[y]! * taskDurSlots[x]!;
        return cross !== 0 ? cross : x - y;
      });
      caps.push(cap);
      for (const t of picked) members.push(t);
      offs.push(members.length);
      if (++emitted >= MAX_BANDS_PER_FAMILY) break;
    }
  }
  if (caps.length === 0) return NO_BANDS;

  const bandCount = caps.length;
  const bandOff = Int32Array.from(offs);
  const bandMembers = Int32Array.from(members);
  const counts = new Int32Array(baked.tasks.length + 1);
  for (const t of members) counts[t + 1]!++;
  for (let t = 0; t < baked.tasks.length; t++) counts[t + 1]! += counts[t]!;
  const bandTaskOff = counts;
  const cursor = Int32Array.from(bandTaskOff.subarray(0, baked.tasks.length));
  const bandTask = new Int32Array(members.length);
  for (let b = 0; b < bandCount; b++) {
    for (let i = bandOff[b]!; i < bandOff[b + 1]!; i++) {
      bandTask[cursor[bandMembers[i]!]!++] = b;
    }
  }

  return {
    bandCount,
    bandCap: Int32Array.from(caps),
    bandOff,
    bandMembers,
    bandTaskOff,
    bandTask,
  };
}

// ---------------------------------------------------------------------------
// Search state
// ---------------------------------------------------------------------------

interface SearchState {
  starts: Int32Array;
  /** Occupancy: 1 where an external or a placed chunk sits. */
  occ: Uint8Array;
  /** runFree[s] = free slots from s onwards (0 when s is occupied). */
  runFree: Int32Array;
  inSet: Uint8Array;
  /** Live domain index window per chunk, into Ctx.domVals. */
  dLo: Int32Array;
  dHi: Int32Array;
}

function newState(ctx: Ctx): SearchState {
  const st: SearchState = {
    starts: new Int32Array(ctx.nChunks).fill(-1),
    occ: new Uint8Array(ctx.horizon),
    runFree: new Int32Array(ctx.horizon + 1),
    inSet: new Uint8Array(ctx.nTasks),
    dLo: new Int32Array(ctx.nChunks),
    dHi: new Int32Array(ctx.nChunks),
  };
  for (let s = 0; s < ctx.horizon; s++) {
    st.occ[s] = maskBit(ctx.baked.externalMask, s);
  }
  refreshRuns(ctx, st);
  return st;
}

function refreshRuns(ctx: Ctx, st: SearchState): void {
  const occ = st.occ;
  const run = st.runFree;
  run[ctx.horizon] = 0;
  for (let s = ctx.horizon - 1; s >= 0; s--) {
    run[s] = occ[s]! > 0 ? 0 : run[s + 1]! + 1;
  }
}

function assign(ctx: Ctx, st: SearchState, c: number, v: number): void {
  st.starts[c] = v;
  const end = v + ctx.chunkDur[c]!;
  for (let s = v; s < end; s++) st.occ[s]!++;
  refreshRuns(ctx, st);
}

function unassign(ctx: Ctx, st: SearchState, c: number): void {
  const v = st.starts[c]!;
  const end = v + ctx.chunkDur[c]!;
  for (let s = v; s < end; s++) st.occ[s]!--;
  st.starts[c] = -1;
  refreshRuns(ctx, st);
}

/** Drop every in-set assignment (used before a full re-pack). */
function clearAssignments(ctx: Ctx, st: SearchState): void {
  for (let c = 0; c < ctx.nChunks; c++) {
    if (st.starts[c]! >= 0) {
      const v = st.starts[c]!;
      const end = v + ctx.chunkDur[c]!;
      for (let s = v; s < end; s++) st.occ[s]!--;
      st.starts[c] = -1;
    }
  }
  refreshRuns(ctx, st);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

interface BudgetState {
  now: () => number;
  deadline: number;
  nodeCap: number;
  /** Total search nodes consumed: selection nodes + placement nodes. */
  nodes: number;
  /** Selection-tree nodes only — the number reported to callers. */
  selectionNodes: number;
  /** Per-feasibility-check ceiling, and the node count that check started at. */
  packCap: number;
  packStart: number;
  stopped: boolean;
}

function newBudgetState(budget: Budget, packCap: number): BudgetState {
  const now = budget.now ?? Date.now;
  return {
    now,
    deadline: budget.wallMs === Infinity ? Infinity : now() + budget.wallMs,
    nodeCap: budget.nodeCap,
    nodes: 0,
    selectionNodes: 0,
    packCap,
    packStart: 0,
    stopped: false,
  };
}

const UNBOUNDED_BUDGET: Budget = { wallMs: Infinity, nodeCap: Infinity };

function overBudget(bg: BudgetState): boolean {
  if (bg.stopped) return true;
  if (bg.nodes > bg.nodeCap) {
    bg.stopped = true;
    return true;
  }
  if (bg.deadline !== Infinity && bg.now() > bg.deadline) {
    bg.stopped = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Placement search (the feasibility oracle)
// ---------------------------------------------------------------------------

/** Can chunk `c` start at `v` given everything already assigned? Hard
 * constraints only: occupancy, group policy, the interchangeable-chunk
 * symmetry break and hard dependencies whose other endpoint is in the set. */
function consistent(ctx: Ctx, st: SearchState, c: number, v: number): boolean {
  const dur = ctx.chunkDur[c]!;
  if (st.runFree[v]! < dur) return false;

  const t = ctx.chunkTask[c]!;
  const task = ctx.baked.tasks[t]!;
  const siblings = task.chunkIndices;
  if (siblings.length > 1 && (task.sameDay || task.ordered)) {
    const ord = ctx.chunkOrdinal[c]!;
    const day = (v / SLOTS_PER_DAY) | 0;
    for (let i = 0; i < siblings.length; i++) {
      const o = siblings[i]!;
      if (o === c) continue;
      const s = st.starts[o]!;
      if (s < 0) continue;
      if (task.sameDay && ((s / SLOTS_PER_DAY) | 0) !== day) return false;
      if (task.ordered) {
        if (ctx.chunkOrdinal[o]! < ord) {
          if (s + ctx.chunkDur[o]! > v) return false;
        } else if (v + dur > s) {
          return false;
        }
      }
    }
  }

  for (let i = ctx.symByChunkOff[c]!; i < ctx.symByChunkOff[c + 1]!; i++) {
    const k = ctx.symByChunk[i]!;
    const a = ctx.symA[k]!;
    const b = ctx.symB[k]!;
    if (a === c) {
      const sb = st.starts[b]!;
      if (sb >= 0 && v > sb) return false;
    } else {
      const sa = st.starts[a]!;
      if (sa >= 0 && sa > v) return false;
    }
  }

  for (let i = ctx.binByChunkOff[c]!; i < ctx.binByChunkOff[c + 1]!; i++) {
    const k = ctx.binByChunk[i]!;
    const a = ctx.binA[k]!;
    const b = ctx.binB[k]!;
    if (st.inSet[ctx.chunkTask[a]!] === 0 || st.inSet[ctx.chunkTask[b]!] === 0) continue;
    // start[a] >= start[b] + binK[k]
    if (a === c) {
      const sb = st.starts[b]!;
      if (sb >= 0 && v < sb + ctx.binK[k]!) return false;
    } else {
      const sa = st.starts[a]!;
      if (sa >= 0 && sa < v + ctx.binK[k]!) return false;
    }
  }
  return true;
}

/** Number of live values for `c`, giving up once `cap` is reached (the caller
 * only needs the minimum). A zero count is always exact. */
function countLive(ctx: Ctx, st: SearchState, c: number, cap: number): number {
  let n = 0;
  const hi = st.dHi[c]!;
  for (let i = st.dLo[c]!; i <= hi; i++) {
    if (consistent(ctx, st, c, ctx.domVals[i]!)) {
      n++;
      if (n >= cap) return n;
    }
  }
  return n;
}

function packDfs(ctx: Ctx, st: SearchState, bg: BudgetState, remaining: number): number {
  if (remaining === 0) return FEASIBLE;
  bg.nodes++;
  if ((bg.nodes & 63) === 0 && overBudget(bg)) return BUDGET_HIT;
  if (bg.nodes > bg.nodeCap) {
    bg.stopped = true;
    return BUDGET_HIT;
  }
  if (bg.nodes - bg.packStart > bg.packCap) return PACK_LIMIT;

  // Fail-first variable order; a singleton domain is taken immediately, which
  // is the "singleton placements place immediately" propagation.
  let best = -1;
  let bestCount = 0x7fffffff;
  for (let c = 0; c < ctx.nChunks; c++) {
    if (st.starts[c]! >= 0) continue;
    if (st.inSet[ctx.chunkTask[c]!] === 0) continue;
    const n = countLive(ctx, st, c, bestCount);
    if (n === 0) return INFEASIBLE;
    if (n < bestCount) {
      bestCount = n;
      best = c;
      if (n === 1) break;
    }
  }
  if (best < 0) return FEASIBLE;

  const hi = st.dHi[best]!;
  for (let i = st.dLo[best]!; i <= hi; i++) {
    const v = ctx.domVals[i]!;
    if (!consistent(ctx, st, best, v)) continue;
    assign(ctx, st, best, v);
    const r = packDfs(ctx, st, bg, remaining - 1);
    if (r !== INFEASIBLE) return r;
    unassign(ctx, st, best);
  }
  return INFEASIBLE;
}

/** Bound propagation across the in-set hard dependencies: tighten each
 * chunk's live domain window to a fixpoint before search. Sound because the
 * constraints are unconditional once both endpoint tasks are in the set. */
function propagateBounds(ctx: Ctx, st: SearchState): boolean {
  const nCons = ctx.binA.length;
  if (nCons === 0) return true;
  for (let round = 0; round <= nCons; round++) {
    let changed = false;
    for (let k = 0; k < nCons; k++) {
      const a = ctx.binA[k]!;
      const b = ctx.binB[k]!;
      if (st.inSet[ctx.chunkTask[a]!] === 0 || st.inSet[ctx.chunkTask[b]!] === 0) continue;
      if (st.dLo[a]! > st.dHi[a]! || st.dLo[b]! > st.dHi[b]!) return false;
      const gap = ctx.binK[k]!;
      // start[a] >= min(start[b]) + gap
      const minA = ctx.domVals[st.dLo[b]!]! + gap;
      while (st.dLo[a]! <= st.dHi[a]! && ctx.domVals[st.dLo[a]!]! < minA) {
        st.dLo[a]!++;
        changed = true;
      }
      if (st.dLo[a]! > st.dHi[a]!) return false;
      // start[b] <= max(start[a]) - gap
      const maxB = ctx.domVals[st.dHi[a]!]! - gap;
      while (st.dHi[b]! >= st.dLo[b]! && ctx.domVals[st.dHi[b]!]! > maxB) {
        st.dHi[b]!--;
        changed = true;
      }
      if (st.dHi[b]! < st.dLo[b]!) return false;
    }
    if (!changed) break;
  }
  return true;
}

/** Necessary condition for packing the current set at all: no capacity band
 * holds more member duration than it has free slots. Cheap arithmetic that
 * saves the search from re-deriving crowding by exhaustion — and it is what
 * makes `packFeasible` strong on oversubscribed weeks, not only the selection
 * search that also prunes with the same bands. */
function bandsAdmitSet(ctx: Ctx, st: SearchState): boolean {
  for (let b = 0; b < ctx.bandCount; b++) {
    let used = 0;
    for (let i = ctx.bandOff[b]!; i < ctx.bandOff[b + 1]!; i++) {
      const t = ctx.bandMembers[i]!;
      if (st.inSet[t] === 1) used += ctx.taskDurSlots[t]!;
    }
    if (used > ctx.bandCap[b]!) return false;
  }
  return true;
}

/** Assign every unassigned in-set chunk. `propagate` runs dependency bound
 * propagation first — worth it for a full pack, pointless for an extension
 * where the fixed endpoints already constrain more tightly. */
function packSearch(ctx: Ctx, st: SearchState, bg: BudgetState, propagate: boolean): number {
  bg.packStart = bg.nodes;
  let remaining = 0;
  for (let c = 0; c < ctx.nChunks; c++) {
    st.dLo[c] = ctx.domOff[c]!;
    st.dHi[c] = ctx.domOff[c + 1]! - 1;
    if (st.inSet[ctx.chunkTask[c]!] === 0) continue;
    if (st.dLo[c]! > st.dHi[c]!) return INFEASIBLE; // empty domain ⇒ unplaceable
    if (st.starts[c]! < 0) remaining++;
  }
  if (ctx.bandCount > 0 && !bandsAdmitSet(ctx, st)) return INFEASIBLE;
  // The same arithmetic the bands do, but over every window of the actual
  // in-set (not a capped static list), at chunk rather than task granularity,
  // and with whatever is already placed charged against capacity — which is
  // what makes it decide an EXTENSION pack, where the bands see only the
  // static picture.
  if (ctx.hall !== null && hallRefutesResidual(ctx.hall, st.inSet, st.starts, st.occ)) {
    return INFEASIBLE;
  }
  if (propagate && !propagateBounds(ctx, st)) return INFEASIBLE;
  if (remaining === 0) return FEASIBLE;
  return packDfs(ctx, st, bg, remaining);
}

/** Feasibility checker: can exactly the tasks in `taskIndices` all be packed
 * (hard constraints only, soft costs ignored)? Returns one witness placement
 * (chunk-indexed starts; -1 for chunks of tasks outside the set), or null.
 * Also the MUS layer's deletion test and isolation primitive (the B→D seam).
 *
 * Unbudgeted by contract — the MUS layer needs a definite answer, so this
 * never abandons a check the way the selection search's internal ones may.
 *
 * NOT interchangeable with `two_pass._isolation_feasible`, which copies the
 * task with `dependencies: []` before solving. Cross-task dependencies go
 * vacuous by themselves on a one-task set, but HARD EVENT dependencies do
 * not — they are unary, and this checker enforces them. An isolation check
 * meaning to mirror the Python must strip the dependencies from the problem
 * and re-bake, as the Python does, then call this on the single task. */
export function packFeasible(
  baked: Baked,
  taskIndices: readonly number[],
): Placement | null {
  const ctx = getCtx(baked);
  const st = newState(ctx);
  for (const t of taskIndices) {
    if (t >= 0 && t < ctx.nTasks) st.inSet[t] = 1;
  }
  const bg = newBudgetState(UNBOUNDED_BUDGET, Infinity);
  return packSearch(ctx, st, bg, true) === FEASIBLE ? st.starts : null;
}

// ---------------------------------------------------------------------------
// Selection branch-and-bound
// ---------------------------------------------------------------------------

interface Selection {
  ctx: Ctx;
  st: SearchState;
  bg: BudgetState;
  /** Decision state per task: 0 undecided, 1 kept, 2 dropped. */
  decision: Uint8Array;
  bestKept: Uint8Array;
  /** Explore only strictly below this. Seeded at the seed partition's cost + 1
   * so an equal-cost but keep-more partition still displaces the seed. */
  bound: number;
  allowDropMustInclude: boolean;
  /** A feasibility check gave up (PACK_NODE_CAP): no certificate this solve. */
  provedLost: boolean;
  /** Per-band kept / dropped duration, maintained incrementally. */
  bandKept: Int32Array;
  bandDropped: Int32Array;
  bandTotal: Int32Array;
  /** The incumbent's placement, copied from the live state at every
   * improvement. Preallocated: one Int32Array copy per improvement, which is
   * rare and never inside a hot loop. */
  bestStarts: Int32Array;
  /** Snapshot ring for the keep branch: one slot per selection depth. */
  snapStarts: Int32Array;
  snapOcc: Uint8Array;
}

function newSelection(ctx: Ctx, st: SearchState, bg: BudgetState): Selection {
  const bandTotal = new Int32Array(ctx.bandCount);
  for (let b = 0; b < ctx.bandCount; b++) {
    let total = 0;
    for (let i = ctx.bandOff[b]!; i < ctx.bandOff[b + 1]!; i++) {
      total += ctx.taskDurSlots[ctx.bandMembers[i]!]!;
    }
    bandTotal[b] = total;
  }
  const depth = ctx.nTasks + 1;
  return {
    ctx,
    st,
    bg,
    decision: new Uint8Array(ctx.nTasks),
    bestKept: new Uint8Array(ctx.nTasks),
    bestStarts: new Int32Array(ctx.nChunks).fill(-1),
    bound: 0,
    allowDropMustInclude: false,
    provedLost: false,
    bandKept: new Int32Array(ctx.bandCount),
    bandDropped: new Int32Array(ctx.bandCount),
    bandTotal,
    snapStarts: new Int32Array(depth * ctx.nChunks),
    snapOcc: new Uint8Array(depth * ctx.horizon),
  };
}

/** Lower bound on the drop cost still to be paid, from the capacity bands.
 * Returns -1 when the node is provably infeasible. */
function bandBound(sel: Selection): number {
  const ctx = sel.ctx;
  let bound = 0;
  for (let b = 0; b < ctx.bandCount; b++) {
    const cap = ctx.bandCap[b]!;
    const kept = sel.bandKept[b]!;
    if (kept > cap) return -1;
    let excess = sel.bandTotal[b]! - sel.bandDropped[b]! - cap;
    if (excess <= 0) continue;
    // Fractional-knapsack bound: cover `excess` slots with the cheapest drop
    // weight per slot among the undecided droppable members.
    let cost = 0;
    for (let i = ctx.bandOff[b]!; i < ctx.bandOff[b + 1]! && excess > 0; i++) {
      const t = ctx.bandMembers[i]!;
      if (sel.decision[t] !== 0) continue;
      if (ctx.taskMustInclude[t] === 1 && !sel.allowDropMustInclude) continue;
      const dur = ctx.taskDurSlots[t]!;
      const w = ctx.taskDropWeight[t]!;
      if (dur <= excess) {
        cost += w;
        excess -= dur;
      } else {
        cost += Math.floor((w * excess) / dur);
        excess = 0;
      }
    }
    if (excess > 0) return -1; // nothing droppable left to relieve the band
    if (cost > bound) bound = cost;
  }
  return bound;
}

function markKept(sel: Selection, t: number): void {
  sel.decision[t] = 1;
  const ctx = sel.ctx;
  const dur = ctx.taskDurSlots[t]!;
  for (let i = ctx.bandTaskOff[t]!; i < ctx.bandTaskOff[t + 1]!; i++) {
    sel.bandKept[ctx.bandTask[i]!]! += dur;
  }
}

function unmarkKept(sel: Selection, t: number): void {
  sel.decision[t] = 0;
  const ctx = sel.ctx;
  const dur = ctx.taskDurSlots[t]!;
  for (let i = ctx.bandTaskOff[t]!; i < ctx.bandTaskOff[t + 1]!; i++) {
    sel.bandKept[ctx.bandTask[i]!]! -= dur;
  }
}

function markDropped(sel: Selection, t: number): void {
  sel.decision[t] = 2;
  const ctx = sel.ctx;
  const dur = ctx.taskDurSlots[t]!;
  for (let i = ctx.bandTaskOff[t]!; i < ctx.bandTaskOff[t + 1]!; i++) {
    sel.bandDropped[ctx.bandTask[i]!]! += dur;
  }
}

function unmarkDropped(sel: Selection, t: number): void {
  sel.decision[t] = 0;
  const ctx = sel.ctx;
  const dur = ctx.taskDurSlots[t]!;
  for (let i = ctx.bandTaskOff[t]!; i < ctx.bandTaskOff[t + 1]!; i++) {
    sel.bandDropped[ctx.bandTask[i]!]! -= dur;
  }
}

/** Keep `t`: extend the incumbent placement if the new task fits around it,
 * otherwise re-pack the whole kept set. */
function tryKeep(sel: Selection, t: number): number {
  const { ctx, st, bg } = sel;
  st.inSet[t] = 1;
  const extended = packSearch(ctx, st, bg, false);
  if (extended !== INFEASIBLE) return extended;
  clearAssignments(ctx, st);
  return packSearch(ctx, st, bg, true);
}

/** Keep-branch Hall cut, evaluated BEFORE any DFS: does the kept-so-far set
 * plus `t` violate a window under EVERY placement? `st.inSet` already holds
 * the tasks kept above this level (tryKeep sets the flag and the unwind
 * clears it), so adding `t` for the duration of the check is the whole set.
 * Deliberately the set-level question — no committed placements — since a
 * particular incumbent placement refutes only itself, not the branch. */
function hallKillsKeep(sel: Selection, t: number): boolean {
  const { ctx, st } = sel;
  if (ctx.hall === null) return false;
  st.inSet[t] = 1;
  const refuted = hallRefutesResidual(ctx.hall, st.inSet, null, null);
  st.inSet[t] = 0;
  return refuted;
}

function selectDfs(sel: Selection, level: number, accCost: number): void {
  const { ctx, st, bg } = sel;
  bg.nodes++;
  bg.selectionNodes++;
  // Sampled, not read per node: Date.now() at every node was measurable at
  // tens of millions of them. `nodes` counts placement work too, so the
  // sampling interval is in total search nodes, not selection nodes.
  if ((bg.nodes & 63) === 0 || bg.nodes > bg.nodeCap || bg.stopped) {
    if (overBudget(bg)) return;
  }

  if (level === ctx.nTasks) {
    sel.bound = accCost;
    for (let t = 0; t < ctx.nTasks; t++) sel.bestKept[t] = sel.decision[t] === 1 ? 1 : 0;
    // Every kept task was packed on the way down and every dropped task's
    // chunks were restored to -1, so the live state IS this partition's
    // witness. Keep it: re-deriving it later costs an unbudgeted pack.
    sel.bestStarts.set(st.starts);
    return;
  }

  const extra = bandBound(sel);
  if (extra < 0 || accCost + extra >= sel.bound) return;

  const t = ctx.order[level]!;
  const droppable = ctx.taskMustInclude[t] === 0 || sel.allowDropMustInclude;

  if (ctx.taskUnplaceable[t] === 0) {
    // Price the keep against the capacity bands BEFORE packing: an
    // over-capacity band kills the branch for the cost of an integer scan,
    // where the packer would have to search for the same answer.
    markKept(sel, t);
    const keepBound = bandBound(sel);
    let packed = INFEASIBLE;
    if (keepBound >= 0 && accCost + keepBound < sel.bound && !hallKillsKeep(sel, t)) {
      const base = level * ctx.nChunks;
      const occBase = level * ctx.horizon;
      sel.snapStarts.set(st.starts, base);
      sel.snapOcc.set(st.occ, occBase);

      packed = tryKeep(sel, t);
      if (packed === FEASIBLE) selectDfs(sel, level + 1, accCost);

      st.inSet[t] = 0;
      st.starts.set(sel.snapStarts.subarray(base, base + ctx.nChunks));
      st.occ.set(sel.snapOcc.subarray(occBase, occBase + ctx.horizon));
      refreshRuns(ctx, st);
    }
    unmarkKept(sel, t);
    if (packed === PACK_LIMIT) sel.provedLost = true;
    if (packed === BUDGET_HIT || bg.stopped) return;
  }

  if (droppable) {
    const next = accCost + ctx.taskDropWeight[t]!;
    if (next < sel.bound) {
      markDropped(sel, t);
      selectDfs(sel, level + 1, next);
      unmarkDropped(sel, t);
    }
  }
}

function partitionFrom(ctx: Ctx, kept: Uint8Array): { kept: number[]; dropped: number[] } {
  const keptOut: number[] = [];
  const droppedOut: number[] = [];
  for (let t = 0; t < ctx.nTasks; t++) {
    if (kept[t] === 1) keptOut.push(t);
    else droppedOut.push(t);
  }
  return { kept: keptOut, dropped: droppedOut };
}

/** Choose the kept/dropped partition minimizing Σ dropWeight over dropped
 * tasks, subject to all hard constraints and the shared timeline. DFS
 * keep-first in descending drop weight per occupied slot; singleton placement, deadline-
 * band capacity cuts and dependency bound propagation; greedy first descent
 * as incumbent.
 *
 * `budget.nodeCap` backstops the TOTAL search — selection nodes plus the
 * placement nodes the feasibility checks consume; `Pass1Result.nodes` reports
 * the selection tree alone, which is the number the "closes at the root"
 * property is about.
 *
 * WHEN `proved` IS FALSE, `kept` MAY NOT BE PACKABLE. Two different things
 * produce it. If the search ran, `kept` is a verified incumbent and only the
 * optimality proof is missing. But if the must_include seed pack itself was
 * abandoned (wall clock, node cap, or the per-check ceiling), feasibility was
 * never decided at all: `kept` is the must_include set as a CANDIDATE, it can
 * be provably unpackable, and `nodes` then reports the abandoned check's work.
 * Callers must re-verify with `packFeasible` before planning on an unproved
 * result — never treat `infeasible: false` alone as "this set packs".
 *
 * `witness` carries the incumbent's own placement whenever one was verified,
 * so a caller that needs a servable placement (engine.ts's PASS1_FALLBACK)
 * takes it from here instead of re-packing. It is legal, not optimized: hard
 * constraints only. It is null exactly on the undecided-seed path. */
export function selectTasks(baked: Baked, budget: Budget): Pass1Result {
  const ctx = getCtx(baked);
  const bg = newBudgetState(budget, PACK_NODE_CAP);
  const st = newState(ctx);

  // The whole selection problem is feasible iff the must_include set alone is:
  // every other task can always be dropped. So one pack decides infeasibility
  // and, on the way, hands the search a guaranteed-valid incumbent.
  let seedCost = 0;
  for (let t = 0; t < ctx.nTasks; t++) {
    if (ctx.taskMustInclude[t] === 1) st.inSet[t] = 1;
    else seedCost += ctx.taskDropWeight[t]!;
  }
  const seed = packSearch(ctx, st, bg, true);
  if (seed === INFEASIBLE) {
    // must_include conflict: the MUS layer takes over. kept/dropped are
    // best-effort — the partition the same search finds once the mandatory
    // flags are relaxed, which is what demotion will approximate.
    const relaxed = relaxedPartition(ctx, bg);
    return {
      kept: relaxed.kept,
      dropped: relaxed.dropped,
      proved: false,
      nodes: bg.selectionNodes,
      witness: relaxed.witness,
      infeasible: true,
      seedDecided: true,
    };
  }
  if (seed !== FEASIBLE) {
    // Budget or pack ceiling: the must_include set's feasibility is undecided,
    // so neither a partition nor an infeasibility claim can be certified. The
    // must_include set comes back as a CANDIDATE, not a result — it may well
    // not pack. `proved: false` is the caller's signal to re-decide (mus.ts
    // re-verifies with packFeasible before anything plans on it). Report the
    // abandoned check's nodes rather than a misleading zero.
    const { kept, dropped } = partitionFrom(ctx, ctx.taskMustInclude);
    return {
      kept,
      dropped,
      proved: false,
      nodes: bg.nodes,
      witness: null,
      infeasible: false,
      seedDecided: false,
    };
  }

  const sel = newSelection(ctx, st, bg);
  sel.bestKept.set(ctx.taskMustInclude);
  // The seed incumbent's witness is the placement the seed pack just found;
  // capture it before the state is cleared for the search. Without this, a
  // budget that stops the search at node 0 would leave the incumbent it
  // returns with no placement at all.
  sel.bestStarts.set(st.starts);
  sel.bound = seedCost + 1;
  clearAssignments(ctx, st);
  for (let t = 0; t < ctx.nTasks; t++) st.inSet[t] = 0;

  selectDfs(sel, 0, 0);

  const { kept, dropped } = partitionFrom(ctx, sel.bestKept);
  return {
    kept,
    dropped,
    proved: !bg.stopped && !sel.provedLost,
    nodes: bg.selectionNodes,
    witness: sel.bestStarts,
    infeasible: false,
    seedDecided: true,
  };
}

/** Best-effort partition for the infeasible case: the same branch-and-bound
 * with must_include treated as droppable. */
function relaxedPartition(
  ctx: Ctx,
  bg: BudgetState,
): { kept: number[]; dropped: number[]; witness: Placement } {
  const st = newState(ctx);
  const sel = newSelection(ctx, st, bg);
  sel.allowDropMustInclude = true;
  let seedCost = 0;
  for (let t = 0; t < ctx.nTasks; t++) seedCost += ctx.taskDropWeight[t]!;
  sel.bound = seedCost + 1;
  selectDfs(sel, 0, 0);
  // The all-dropped starting incumbent needs no placement, and its buffer is
  // already all -1, so this witness is correct whether or not a leaf landed.
  return { ...partitionFrom(ctx, sel.bestKept), witness: sel.bestStarts };
}
