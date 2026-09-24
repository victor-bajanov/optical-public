// D3 — incumbent improvement phase: deterministic LNS repair over ranked
// neighbourhoods (internal design notes §D3).
//
// The engine is its own sub-solver. Each iteration takes the incumbent, frees
// one ranked neighbourhood, pins everything else, and re-solves the freed set
// EXACTLY with a small sub-budget; a strictly cheaper answer replaces the
// incumbent and the ranking is recomputed against it. The neighbourhood menu
// is the spec's four families, iterated round-robin, plus a fifth this card
// had to add (see `displacement` for the measurement that forced it):
//
//   (e) displacement — the costliest chunk, moved to where it would cost
//       least once the eviction it causes is priced, together with exactly
//       the chunks it evicts;
//   (a) the day carrying the highest incumbent cost,
//   (b) the capped context with the largest overrun penalty,
//   (c) the k costliest-placed chunks,
//   (d) the k largest churn contributions (replans).
//
// (e) leads the round because it is both the cheapest to solve and the only
// one that can move anything at all once a week is packed solid.
//
// Everything here is ranked, never sampled: no RNG, total tie-breaks on every
// comparison (cost descending, then chunk index ascending), a fixed family
// order, and a fixed sweep schedule. Two runs over the same incumbent issue
// the same sub-solve requests in the same order — which is also what makes
// card E's fan-out safe to point at this seam, since collecting a batch out of
// order cannot change which requests were made.
//
// `subsolve` defaults to the in-process `place()`. An INJECTED subsolve is
// treated as untrusted: its answer is re-costed against the engine's own model
// before it can displace the incumbent, so a broken or lying leaf can waste
// budget but never corrupt a plan.
//
// The LDS probes the spec pairs with this loop live in pass2.ts, where the
// search that runs them is: they reuse the incumbent as their pruning bound
// rather than paying for a fresh instance.

import { place } from "./pass2";
import { SLOTS_PER_DAY, maskGet } from "./substrate";
import type {
  Baked,
  Budget,
  ImproveResult,
  Placement,
  SubsolveFn,
  SubsolveRequest,
  SubsolveResult,
} from "./types";

/** Chunks freed per neighbourhood, for the four families that free a set
 * rather than a swap. Large enough to reshuffle a day, small enough that the
 * sub-solve's greedy descent lands somewhere sensible before the node cap
 * stops it — these are the neighbourhoods that routinely do NOT close, and
 * their value is the descent, not the proof. */
const MAX_FREED = 8;

/** A neighbourhood must be a PROPER subset of the kept chunks: freeing
 * everything is not a repair, it is the same solve again at a smaller budget,
 * and it would spend the phase re-deriving the incumbent it started from. */
function freedCap(keptChunks: number): number {
  return Math.max(1, Math.min(MAX_FREED, keptChunks - 1));
}

/** Per-iteration node ceiling. The point of a neighbourhood is that it is
 * cheap to prove; an iteration that cannot close in this many nodes is one the
 * budget is better off spending on the next neighbourhood. Deliberately small:
 * the phase's value is the NUMBER of repairs it lands, and a single 8-chunk
 * day neighbourhood will happily absorb an entire phase budget without
 * returning anything. */
const SUBSOLVE_NODE_CAP = 1_000;

/** Ranked neighbourhoods per family, per sweep. Families (c) and (d) walk
 * disjoint windows of their ranking, so this also bounds how deep into a
 * ranking one sweep reaches. */
const MAX_ROUNDS = 32;

/** Sweeps over the whole menu. A sweep that accepts nothing ends the loop, so
 * this only caps a pathological improve-forever instance. */
const MAX_SWEEPS = 16;

/** Improve `incumbent` (cost `incumbentCost`) over the kept set within
 * `budget`, keeping strict improvements only. Default subsolve is the
 * in-process `place()`.
 *
 * ROUND-BATCHED (card F): the schedule is generated in rounds — one freed
 * set per family, all built against the incumbent AS OF ROUND START — and
 * results are applied in fixed menu order against the evolving incumbent.
 * The sync driver here and `improveAsync` below iterate the SAME generator,
 * so a fan-out batch answered out of order (or in parallel isolates) cannot
 * produce a different answer than the in-process loop: the flag changes
 * wall clock, never the result. */
export function improve(
  baked: Baked,
  keptTaskIndices: readonly number[],
  incumbent: Placement,
  incumbentCost: number,
  budget: Budget,
  subsolve?: SubsolveFn,
): ImproveResult {
  const injected = subsolve ?? null;
  const run = injected ?? inProcessSubsolve(baked);
  const gen = improveRounds(
    baked,
    keptTaskIndices,
    incumbent,
    incumbentCost,
    budget,
    injected !== null,
  );
  let step = gen.next();
  while (!step.done) {
    step = gen.next(step.value.map((request) => run(request)));
  }
  return step.value;
}

/** The async driver over a BATCHED sub-solver (card E's fan-out session).
 * Identical schedule to `improve` by construction — both drive
 * `improveRounds`; only who executes a round's requests differs. */
export async function improveAsync(
  baked: Baked,
  keptTaskIndices: readonly number[],
  incumbent: Placement,
  incumbentCost: number,
  budget: Budget,
  batch: (requests: readonly SubsolveRequest[]) => Promise<SubsolveResult[]>,
): Promise<ImproveResult> {
  const gen = improveRounds(baked, keptTaskIndices, incumbent, incumbentCost, budget, true);
  let step = gen.next();
  while (!step.done) {
    step = gen.next(await batch(step.value));
  }
  return step.value;
}

/** The shared schedule: yields one round's requests, receives that round's
 * results (index-aligned), returns the final `ImproveResult`. Never yields
 * an empty batch. */
function* improveRounds(
  baked: Baked,
  keptTaskIndices: readonly number[],
  incumbent: Placement,
  incumbentCost: number,
  budget: Budget,
  external: boolean,
): Generator<SubsolveRequest[], ImproveResult, SubsolveResult[]> {
  const kept = Array.from(keptTaskIndices).sort((a, b) => a - b);
  const keptChunks: number[] = [];
  for (const ti of kept) {
    for (const ci of baked.tasks[ti]!.chunkIndices) keptChunks.push(ci);
  }

  let best = Int32Array.from(incumbent);
  let bestCost = incumbentCost;
  let iterations = 0;
  let accepted = 0;
  let nodes = 0;

  const done = (): ImproveResult => ({
    placement: best,
    cost: bestCost,
    iterations,
    accepted,
    fanoutSubsolves: external ? iterations : 0,
    nodes,
  });

  // Nothing to repair from: an incomplete incumbent is not a starting point,
  // it is the pass-1 cliff the LDS probes in pass2.ts handle instead.
  if (keptChunks.length === 0) return done();
  for (const ci of keptChunks) {
    if (best[ci]! < 0) return done();
  }

  // NODES ONLY, deliberately (adjudicated at card E's review). Both the
  // stopping rule and every sub-budget below are derived from node accounting,
  // never from the clock: card E runs these same sub-solves in parallel
  // isolates, and a schedule that asked the wall how much was left would issue
  // a different number of iterations there than here — the fan-out flag is
  // allowed to change wall clock and nothing else. `budget.wallMs` is
  // therefore not read at all; the phase driver owns the wall.
  //
  // Budget checks happen at ROUND granularity, and every request in a round
  // gets the same cap, computed from the count at round start: a parallel
  // batch cannot know its siblings' spend, so a sequential driver must not
  // use it either. The phase can overshoot by at most one round of caps.
  const nodesLeft = (): number =>
    budget.nodeCap === Infinity ? Infinity : budget.nodeCap - nodes;

  if (nodesLeft() <= 0) return done();

  // A neighbourhood already tried against THIS incumbent would re-solve an
  // identical subproblem and get an identical answer, so the cost is keyed in:
  // once the incumbent moves, the same freed set is a different question.
  const tried = new Set<string>();
  const cap = freedCap(keptChunks.length);
  // The menu outlives the pass that built it. A round asks for one whether or
  // not the last was accepted, and an acceptance moves only the chunks it
  // freed, so the cache repairs those rows and hands back everything else
  // untouched — bit-identically, by construction (see `createMenuCache`).
  const menus = createMenuCache(baked, kept, keptChunks, best);

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let improvedThisSweep = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // A round REPEATS with a fresh menu while it keeps accepting: the
      // displacement family's value is an iterated chain of evictions, each
      // priced against the incumbent the previous one produced, and moving
      // straight on after one acceptance would abandon the chain. Strict
      // integer cost decrease per acceptance bounds the repeats.
      let acceptedThisPass = true;
      while (acceptedThisPass) {
        acceptedThisPass = false;
        if (nodesLeft() <= 0) return done();
        const menu = menus.menu(round, cap);
        if (menu.length === 0) break;

        const requests: SubsolveRequest[] = [];
        const frozens: Placement[] = [];
        for (const freed of menu) {
          const key = `${bestCost}|${freed.join(",")}`;
          if (tried.has(key)) continue;
          tried.add(key);
          const frozen = Int32Array.from(best);
          for (const ci of freed) frozen[ci] = -1;
          frozens.push(frozen);
          requests.push({
            problem: baked.problem,
            kept,
            frozen,
            // No wall on a sub-solve: a leaf budgeted in wall time answers
            // differently on a slower machine.
            wallMs: Infinity,
            nodeCap: 0, // assigned below, once the round's size is known
          });
        }
        if (requests.length === 0) break;
        // Split what remains across the round so the phase can never exceed
        // its budget: the whole round is dispatched at once (fan-out), so the
        // cap must come from round-start accounting, not a sibling's spend.
        const perRequestCap = Math.min(
          SUBSOLVE_NODE_CAP,
          Math.floor(nodesLeft() / requests.length),
        );
        if (perRequestCap <= 0) return done();
        for (const request of requests) request.nodeCap = perRequestCap;

        iterations += requests.length;
        const results = yield requests;

        for (let i = 0; i < requests.length; i++) {
          const result = results[i];
          if (result === undefined) continue;
          if (Number.isFinite(result.nodes) && result.nodes > 0) nodes += result.nodes;
          const candidateCost = admit(
            baked,
            kept,
            keptChunks,
            frozens[i]!,
            result,
            bestCost,
            external,
          );
          if (candidateCost === null) continue;
          // Copy only what the kept set owns. Everything else in the
          // incumbent — the -1s of dropped tasks — stays as it was, so an
          // injected leaf cannot smuggle a start into a chunk that is not in
          // this solve.
          const next = Int32Array.from(best);
          for (const ci of keptChunks) next[ci] = result.placement[ci]!;
          best = next;
          bestCost = candidateCost;
          menus.accept(next);
          accepted++;
          acceptedThisPass = true;
          improvedThisSweep = true;
        }
      }
    }
    if (!improvedThisSweep) break;
  }

  return done();
}

/** The in-process default: the engine solving its own sub-problem. A sub-solve
 * that produced no descent at all (an unrealisable freeze, or a budget spent
 * before the first leaf) reports `Infinity` rather than the zero-cost empty
 * placement `place()` returns on that path, which would read as the best
 * improvement ever found. `descents` carries the same fact in the field the
 * acceptance gate reads, which is the one an RPC leaf can also honour.
 *
 * No clock is threaded in and none is needed: requests carry `wallMs:
 * Infinity`, so a sub-solve is bounded by its node cap alone. */
function inProcessSubsolve(baked: Baked): SubsolveFn {
  return (request) => {
    const result = place(
      baked,
      request.kept,
      null,
      { wallMs: request.wallMs, nodeCap: request.nodeCap },
      { frozenChunks: request.frozen },
    );
    if (result.descents === 0) {
      return {
        placement: request.frozen,
        cost: Infinity,
        proved: false,
        nodes: result.nodes,
        descents: 0,
      };
    }
    return {
      placement: result.placement,
      cost: result.cost,
      proved: result.proved,
      nodes: result.nodes,
      descents: result.descents,
    };
  };
}

/** The cost at which a sub-solve's answer may displace the incumbent, or null
 * to reject it. Four gates, cheapest first: the leaf must have completed a
 * descent at all, it must claim an improvement, it
 * must be a COMPLETE placement that left every frozen chunk exactly where it
 * was, and — when it came from an injected (RPC) subsolve — its claimed cost
 * must survive re-costing against the engine's own model, which also refutes
 * an illegal placement (an illegal freeze collapses a domain, so the re-solve
 * reports no descent). */
function admit(
  baked: Baked,
  kept: readonly number[],
  keptChunks: readonly number[],
  frozen: Placement,
  result: SubsolveResult,
  bestCost: number,
  verify: boolean,
): number | null {
  // No completed descent ⇒ no incumbent ⇒ nothing to accept, whatever the
  // other fields say. A starved leaf reports cost 0, and pass-2 cost excludes
  // drop cost, so 0 is an ordinary objective value rather than a sentinel:
  // this field is the only honest way to tell the two apart.
  if (result.descents <= 0) return null;
  if (!(result.cost < bestCost)) return null;
  const p = result.placement;
  if (p === undefined || p === null || p.length !== baked.chunks.length) return null;
  for (const ci of keptChunks) {
    const start = p[ci]!;
    if (start < 0) return null;
    const pinned = frozen[ci]!;
    if (pinned >= 0 && start !== pinned) return null;
  }
  if (!verify) return result.cost;
  // Re-cost by pinning the whole answer: pass 2 then has nothing to branch on
  // and returns that placement's exact cost in zero nodes, or reports no
  // descent because some start is not in its chunk's domain / overlaps.
  const check = place(baked, kept, null, { wallMs: Infinity, nodeCap: 0 }, { frozenChunks: p });
  if (check.descents === 0) return null;
  if (!(check.cost < bestCost)) return null;
  return check.cost;
}

// ---------------------------------------------------------------------------
// neighbourhood ranking
// ---------------------------------------------------------------------------

/** The menu the accept-loop reads, held across passes.
 *
 * The five families share three inputs — the per-(context, day) daily-cap
 * overrun table, the attributed cost of every kept chunk, and the ranking that
 * orders them. Building all three is a scan of the kept chunks per capped cell
 * plus two sorts, and the loop asks for a menu once per round whether or not
 * the last one was accepted (32 rounds a sweep, 16 sweeps), so nearly every
 * build was re-deriving inputs nothing had touched.
 *
 * An acceptance moves only the chunks the sub-solve was handed, so `accept`
 * records what that diff invalidated and the next `menu` repairs exactly those
 * rows. Repaired rows are RE-DERIVED by the same arithmetic a from-scratch
 * build uses, never delta-adjusted, so bit-identity holds by construction
 * rather than by float bookkeeping. Two invalidation rules carry the coupling
 * terms:
 *
 *   - a task's lateness is charged to whichever chunk decides its end, so a
 *     moved chunk dirties every chunk of its task;
 *   - a cell's overrun is split across its occupants by slot share, so a moved
 *     chunk dirties every (context, day) cell it left or joined, and with them
 *     every chunk still on one of those cells.
 *
 * `improve-incremental.test.ts` audits an aged cache against a fresh one at
 * every round along real accept trajectories. */
export interface MenuCache {
  /** The `round`-th neighbourhood of each family, in the spec's family order.
   * Families that have run out contribute nothing; an empty result means the
   * whole menu is exhausted at this depth. */
  menu(round: number, cap: number): number[][];
  /** Adopt `next` as the incumbent, invalidating what its diff touched. */
  accept(next: Placement): void;
}

export function createMenuCache(
  baked: Baked,
  kept: readonly number[],
  keptChunks: readonly number[],
  incumbent: Placement,
): MenuCache {
  const days = Math.floor(baked.horizon / SLOTS_PER_DAY);
  const cells = baked.contexts.length * Math.max(days, 0);
  const placement = Int32Array.from(incumbent);

  // Kept chunks of each CAPPED context, so a repair rebuilds one context's
  // cells by touching that context's chunks instead of every kept chunk. NOT
  // an ordering device: a cell's occupancy is a sum of integer slot counts,
  // which float64 adds exactly far below 2^53, so the sum cannot depend on the
  // order it accumulates in. `attributedCost` is where order does matter.
  const cappedChunks = new Map<number, number[]>();
  for (const ci of keptChunks) {
    const cx = cappedContextOf(baked, ci);
    if (cx < 0) continue;
    const list = cappedChunks.get(cx);
    if (list === undefined) cappedChunks.set(cx, [ci]);
    else list.push(ci);
  }

  /** Slots occupied per (context, day): the cap overrun's basis, and the
   * denominator its share is split by. */
  const used = new Float64Array(cells);
  /** `overruns[cx * days + d]`: what that cell pays over its cap. Uncapped
   * contexts stay 0. */
  const overruns = new Float64Array(cells);
  /** Each cell's occupants, in keptChunks order. Read only to decide whose
   * attributed cost a change to that cell invalidated. */
  const occupants: number[][] = Array.from({ length: cells }, () => []);
  /** Lateness charged to a task's deciding chunk; absent = none charged. */
  const lateness = new Map<number, number>();
  /** Attributed cost per kept chunk — separable table entry plus the two
   * coupling shares. What every family ranks on. */
  const sep = new Map<number, number>();

  let ranked: number[] = [];
  const dayCost = new Float64Array(Math.max(days, 0));
  const dayMembers: number[][] = Array.from({ length: Math.max(days, 0) }, () => []);
  let dayOrder: number[] = [];
  let cappedRanked: Array<{ cx: number; penalty: number; days: Set<number> }> = [];
  let churnRanked: number[] = [];

  // Displacement's O(horizon) scratch, allocated once and refilled when the
  // incumbent moves. `open` never changes at all — the external mask is baked.
  const owner = new Int32Array(baked.horizon);
  const vacant = new Uint8Array(baked.horizon);
  const free = new Uint8Array(baked.horizon);
  const open = new Uint8Array(baked.horizon);
  for (let s = 0; s < baked.horizon; s++) open[s] = maskGet(baked.externalMask, s) ? 0 : 1;
  let occupancyStale = true;

  // Invalidation. `everything` forces the first build; from then on the sets
  // name exactly what the accepted diffs touched.
  let everything = true;
  let stale = true;
  const dirtyChunks = new Set<number>();
  const dirtyTasks = new Set<number>();
  const dirtyContexts = new Set<number>();
  const dirtyCells = new Set<number>();

  /** Every (context, day) cell a chunk of `dur` slots starting at `start`
   * occupies, clipped to the horizon's whole days. */
  function markCells(cx: number, start: number, dur: number): void {
    if (days <= 0) return;
    let d0 = Math.floor(start / SLOTS_PER_DAY);
    let d1 = Math.floor((start + dur - 1) / SLOTS_PER_DAY);
    if (d0 < 0) d0 = 0;
    if (d1 >= days) d1 = days - 1;
    for (let d = d0; d <= d1; d++) dirtyCells.add(cx * days + d);
  }

  /** Rebuild one capped context's occupancy and overrun rows from scratch.
   * Only this context's chunks contribute to its cells, so rebuilding one
   * context reproduces what a full build's single pass over every kept chunk
   * would have left in those cells — exactly, the sums being integer slot
   * counts. */
  function rebuildContext(cx: number): void {
    const ctx = baked.contexts[cx]!;
    const base = cx * days;
    for (let d = 0; d < days; d++) {
      used[base + d] = 0;
      occupants[base + d]!.length = 0;
    }
    for (const ci of cappedChunks.get(cx)!) {
      const chunk = baked.chunks[ci]!;
      const s = placement[ci]!;
      const end = s + chunk.durationSlots;
      let d0 = Math.floor(s / SLOTS_PER_DAY);
      let d1 = Math.floor((end - 1) / SLOTS_PER_DAY);
      if (d0 < 0) d0 = 0;
      if (d1 >= days) d1 = days - 1;
      for (let d = d0; d <= d1; d++) {
        const lo = d * SLOTS_PER_DAY;
        const overlap = Math.max(0, Math.min(end, lo + SLOTS_PER_DAY) - Math.max(s, lo));
        if (overlap > 0) {
          used[base + d]! += overlap;
          occupants[base + d]!.push(ci);
        }
      }
    }
    for (let d = 0; d < days; d++) {
      overruns[base + d] =
        Math.max(0, used[base + d]! - ctx.dailyCapSlots) * ctx.dailyCapPenaltyPer15;
    }
  }

  /** objective.lateness_terms: the last chunk's end when ordered, else the max
   * end — so exactly one chunk decides the bill, and it is the one worth
   * freeing. */
  function rebuildLateness(ti: number): void {
    const task = baked.tasks[ti]!;
    for (const ci of task.chunkIndices) lateness.delete(ci);
    if (!task.hasSoftDeadline || task.deadlinePenaltyPer15 === 0) return;
    let decider = -1;
    let endMax = -Infinity;
    if (task.ordered) {
      decider = task.chunkIndices[task.chunkIndices.length - 1]!;
      endMax = placement[decider]! + baked.chunks[decider]!.durationSlots;
    } else {
      for (const ci of task.chunkIndices) {
        const end = placement[ci]! + baked.chunks[ci]!.durationSlots;
        if (end > endMax) {
          endMax = end;
          decider = ci;
        }
      }
    }
    if (decider < 0) return;
    const late = Math.max(0, endMax - task.deadlineSlot) * task.deadlinePenaltyPer15;
    if (late > 0) lateness.set(decider, late);
  }

  /** What one kept chunk's placement actually COSTS: its separable table entry
   * (fit + churn + soft window) plus its share of the two coupling terms.
   *
   * Ranking on the separable table alone is blind on exactly the problems this
   * phase exists for: `deadline_soft-heavy`'s entire objective is lateness and
   * its separable table is zero everywhere, so every family tied and the menu
   * degenerated to chunk-index order. The shares are heuristic (a ranking, not
   * an objective) but they are deterministic and they point at the right
   * chunks.
   *
   * The addends arrive in a FIXED order — table entry, then lateness, then cap
   * shares by ascending day — which is the order the from-scratch build's three
   * passes produced them in. Float addition is not associative, so this is a
   * real constraint and not a stylistic one; unlike the cell sums above, these
   * terms are not integers.
   *
   * The CORPUS cannot police it. No bench fixture charges a fractional cap
   * share and a lateness penalty to the same chunk, so every corpus sep is
   * order-insensitive and the identity gate would pass a reordered build
   * unmoved. The pin is a purpose-built fixture — "attributedCost — addend
   * order" in improve-incremental.test.ts — which puts all three terms on one
   * chunk and ties its day against another, so a one-ulp shift flips the
   * ranking. Reorder these lines and that test, and only that test, goes red. */
  function attributedCost(ci: number): number {
    const chunk = baked.chunks[ci]!;
    const s = placement[ci]!;
    const i = indexOfStart(chunk.allowedStarts, s);
    let out = i < 0 ? 0 : chunk.cost[i]!;
    const late = lateness.get(ci);
    if (late !== undefined) out += late;
    const cx = cappedContextOf(baked, ci);
    if (cx < 0) return out;
    const base = cx * days;
    const end = s + chunk.durationSlots;
    let d0 = Math.floor(s / SLOTS_PER_DAY);
    let d1 = Math.floor((end - 1) / SLOTS_PER_DAY);
    if (d0 < 0) d0 = 0;
    if (d1 >= days) d1 = days - 1;
    for (let d = d0; d <= d1; d++) {
      const overrun = overruns[base + d]!;
      if (overrun <= 0) continue;
      const total = used[base + d]!;
      if (total === 0) continue;
      const lo = d * SLOTS_PER_DAY;
      const share = Math.max(0, Math.min(end, lo + SLOTS_PER_DAY) - Math.max(s, lo));
      if (share > 0) out += (overrun * share) / total;
    }
    return out;
  }

  /** (a)'s input: what each day is carrying, and who is on it.
   *
   * A chunk that spans midnight joins BOTH days' member lists, and its cost is
   * split between them by slot share — `cost * overlap / durationSlots`,
   * the same way `rebuildContext` prices a cell's occupancy. Crediting the
   * start day alone under-ranked the tail day, which is where most of a
   * 23:00–03:00 chunk actually sits: the day family would keep freeing the
   * evening it began on and never the morning it ran into.
   *
   * A chunk inside one day is credited whole, not `cost * dur / dur` — the
   * round trip through a multiply and a divide is not the identity in float64,
   * and the overwhelming majority of placements never cross midnight, so their
   * ranking must be untouched to the bit. */
  function rebuildDays(): void {
    dayCost.fill(0);
    for (let d = 0; d < days; d++) dayMembers[d]!.length = 0;
    for (const ci of keptChunks) {
      const start = placement[ci]!;
      const chunk = baked.chunks[ci]!;
      const end = start + chunk.durationSlots;
      let d0 = Math.floor(start / SLOTS_PER_DAY);
      let d1 = Math.floor((end - 1) / SLOTS_PER_DAY);
      if (d0 < 0) d0 = 0;
      if (d1 >= days) d1 = days - 1;
      for (let d = d0; d <= d1; d++) dayMembers[d]!.push(ci);
      const cost = sep.get(ci)!;
      if (d0 === d1) {
        if (d0 < days) dayCost[d0] = dayCost[d0]! + cost;
        continue;
      }
      // Shares are integer slot counts over an integer duration, so the split
      // is a pure function of the placement — no accumulation to drift. Slots
      // past the horizon's last WHOLE day fall outside every cell and take
      // their share of the cost with them, exactly as they do for daily caps.
      for (let d = d0; d <= d1; d++) {
        const lo = d * SLOTS_PER_DAY;
        const overlap = Math.max(0, Math.min(end, lo + SLOTS_PER_DAY) - Math.max(start, lo));
        dayCost[d] = dayCost[d]! + (cost * overlap) / chunk.durationSlots;
      }
    }
    for (let d = 0; d < days; d++) {
      let extra = 0;
      for (let cx = 0; cx < baked.contexts.length; cx++) {
        extra += overruns[cx * days + d]!;
      }
      dayCost[d] = dayCost[d]! + extra;
    }
    dayOrder = [];
    for (let d = 0; d < days; d++) if (dayMembers[d]!.length > 0) dayOrder.push(d);
    dayOrder.sort((a, b) => dayCost[b]! - dayCost[a]! || a - b);
  }

  /** (b)'s input: capped contexts by total overrun, with the days that are
   * actually over. */
  function rebuildCappedRanking(): void {
    cappedRanked = [];
    for (let cx = 0; cx < baked.contexts.length; cx++) {
      const ctx = baked.contexts[cx]!;
      if (ctx.dailyCapSlots < 0 || ctx.dailyCapPenaltyPer15 === 0) continue;
      let penalty = 0;
      const over = new Set<number>();
      for (let d = 0; d < days; d++) {
        const here = overruns[cx * days + d]!;
        if (here > 0) {
          penalty += here;
          over.add(d);
        }
      }
      if (penalty > 0) cappedRanked.push({ cx, penalty, days: over });
    }
    cappedRanked.sort((a, b) => b.penalty - a.penalty || a.cx - b.cx);
  }

  /** Who holds which slot, and which slots nobody holds. Rebuilt lazily: on a
   * round where displacement bails out early this is never needed. */
  function rebuildOccupancy(): void {
    owner.fill(-1);
    for (const ci of keptChunks) {
      const start = placement[ci]!;
      const end = start + baked.chunks[ci]!.durationSlots;
      for (let s = start; s < end && s < baked.horizon; s++) owner[s] = ci;
    }
    for (let s = 0; s < baked.horizon; s++) vacant[s] = open[s]! === 1 && owner[s]! < 0 ? 1 : 0;
    occupancyStale = false;
  }

  function refresh(): void {
    if (!stale) return;
    if (everything) {
      for (const cx of cappedChunks.keys()) rebuildContext(cx);
      lateness.clear();
      for (const ti of kept) rebuildLateness(ti);
      sep.clear();
      for (const ci of keptChunks) sep.set(ci, attributedCost(ci));
    } else {
      // A moved chunk can shift which of its task's chunks decides lateness,
      // so the whole task is dirty, not just the chunk that moved.
      for (const ti of dirtyTasks) {
        for (const ci of baked.tasks[ti]!.chunkIndices) dirtyChunks.add(ci);
      }
      // A changed cell reprices every chunk still on it, moved or not: the
      // share is that cell's whole overrun scaled by the chunk's slots over
      // the cell's occupied slots, and both ends of the fraction just moved.
      // Collecting the occupants AFTER the rebuild is enough — a chunk that
      // was on the cell and no longer is had to move to leave it, which put it
      // in `dirtyChunks` already.
      for (const cx of dirtyContexts) rebuildContext(cx);
      for (const cell of dirtyCells) {
        for (const ci of occupants[cell]!) dirtyChunks.add(ci);
      }
      for (const ti of dirtyTasks) rebuildLateness(ti);
      for (const ci of dirtyChunks) sep.set(ci, attributedCost(ci));
    }

    // The derived rankings are re-sorted whole: the scans they replaced were
    // the cost, not the sorts, and a total comparator makes the result unique
    // regardless of what order the input arrived in.
    ranked = rankNumbers(keptChunks, (ci) => sep.get(ci)!);
    rebuildDays();
    rebuildCappedRanking();
    churnRanked = rankPairs(churnContributors(baked, kept, placement));

    everything = false;
    stale = false;
    occupancyStale = true;
    dirtyChunks.clear();
    dirtyTasks.clear();
    dirtyContexts.clear();
    dirtyCells.clear();
  }

  function accept(next: Placement): void {
    for (const ci of keptChunks) {
      const from = placement[ci]!;
      const to = next[ci]!;
      if (from === to) continue;
      placement[ci] = to;
      stale = true;
      dirtyChunks.add(ci);
      const chunk = baked.chunks[ci]!;
      dirtyTasks.add(chunk.taskIndex);
      const cx = cappedContextOf(baked, ci);
      if (cx < 0) continue;
      dirtyContexts.add(cx);
      markCells(cx, from, chunk.durationSlots);
      markCells(cx, to, chunk.durationSlots);
    }
  }

  function menu(round: number, cap: number): number[][] {
    refresh();
    const out: number[][] = [];

    // Displacement leads the round. It is both the cheapest neighbourhood (two
    // or three chunks) and the only one that can move anything at all on a week
    // with no free slots left, so spending the budget on it first is what turns
    // the phase from "a few lucky repairs" into a sweep.
    const swap = displacement(round, cap);
    if (swap !== null) out.push(swap);

    const day = costliestDay(round, cap);
    if (day !== null) out.push(day);

    const context = overrunContext(round, cap);
    if (context !== null) out.push(context);

    const costly = window(ranked, round, cap);
    if (costly !== null) out.push(costly);

    const churn = window(churnRanked, round, cap);
    if (churn !== null) out.push(churn);

    return out;
  }

  /** (e) Displacement. The four families below all free chunks that are
   * ALREADY somewhere expensive; on a packed week that is not enough, because
   * the slot the costly chunk wants is occupied and freeing the chunk alone
   * just puts it back. `deadline_soft-heavy` is the extreme case: the greedy
   * descent packs slots 0–355 wall to wall, so 33 tasks miss deadlines they
   * could all have met and not one of them can move without evicting somebody.
   *
   * So: take the `round`-th costliest chunk, find the start where putting it
   * would cost least ONCE THE EVICTION IS PRICED — its own cost there plus the
   * attributed cost of whatever it would displace — and free it together with
   * exactly those occupants. That is a swap the sub-solve can then decide
   * exactly. Ties go to the earliest start, so the choice is total. */
  function displacement(round: number, cap: number): number[] | null {
    const target = ranked[round];
    if (target === undefined) return null;
    if ((sep.get(target) ?? 0) <= 0) return null; // nothing left to gain
    if (occupancyStale) rebuildOccupancy();

    const chunk = baked.chunks[target]!;
    const dur = chunk.durationSlots;
    const task = baked.tasks[chunk.taskIndex]!;

    // Where an evicted chunk could actually go: the slots nobody holds, plus
    // the interval the target is about to vacate. Pricing an eviction by the
    // occupant's CURRENT cost is the trap — on a packed week the chunk sitting
    // in the slot you want is usually costing nothing precisely BECAUSE it is
    // sitting there, and moving it is what makes it expensive.
    const vacatedFrom = placement[target]!;
    free.set(vacant);
    for (let s = vacatedFrom; s < vacatedFrom + dur && s < baked.horizon; s++) {
      if (owner[s]! === target) free[s] = open[s]!;
    }
    const relocation = new Map<number, number>();
    const relocationCost = (ci: number): number => {
      const cached = relocation.get(ci);
      if (cached !== undefined) return cached;
      const other = baked.chunks[ci]!;
      const otherTask = baked.tasks[other.taskIndex]!;
      let cheapest = Infinity;
      for (let i = 0; i < other.allowedStarts.length; i++) {
        const q = other.allowedStarts[i]!;
        if (q + other.durationSlots > baked.horizon) continue;
        let fits = true;
        for (let s = q; s < q + other.durationSlots; s++) {
          if (free[s] === 0) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        let here = other.cost[i]!;
        if (otherTask.hasSoftDeadline) {
          here +=
            Math.max(0, q + other.durationSlots - otherTask.deadlineSlot) *
            otherTask.deadlinePenaltyPer15;
        }
        if (here < cheapest) cheapest = here;
      }
      // Only the INCREASE counts: what this eviction adds to the bill.
      const delta =
        cheapest === Infinity ? Infinity : Math.max(0, cheapest - (sep.get(ci) ?? 0));
      relocation.set(ci, delta);
      return delta;
    };

    let bestScore = Infinity;
    let bestSet: number[] | null = null;
    for (let i = 0; i < chunk.allowedStarts.length; i++) {
      const p = chunk.allowedStarts[i]!;
      if (p === vacatedFrom) continue; // staying put improves nothing
      if (p + dur > baked.horizon) continue;
      let score = chunk.cost[i]!;
      if (task.hasSoftDeadline) {
        score += Math.max(0, p + dur - task.deadlineSlot) * task.deadlinePenaltyPer15;
      }
      if (score >= bestScore) continue; // the evictions can only add to it
      const displaced: number[] = [];
      let blocked = false;
      for (let s = p; s < p + dur; s++) {
        if (open[s]! === 0) {
          blocked = true;
          break;
        }
        const occupant = owner[s]!;
        if (occupant >= 0 && occupant !== target && !displaced.includes(occupant)) {
          displaced.push(occupant);
        }
      }
      if (blocked || displaced.length + 1 > cap) continue;
      for (const ci of displaced) score += relocationCost(ci);
      if (score < bestScore) {
        bestScore = score;
        bestSet = [target, ...displaced];
      }
    }
    // A move that cannot beat what the target already pays is not worth an
    // iteration; the other four families still get their turn this round.
    if (bestSet === null || bestScore >= (sep.get(target) ?? 0)) return null;
    return bestSet.sort((a, b) => a - b);
  }

  /** (a) The `round`-th costliest day: its chunks' separable cost plus
   * whatever daily-cap overrun that day is paying. Freed set = the day's
   * chunks, dearest first. */
  function costliestDay(round: number, cap: number): number[] | null {
    if (days <= 0) return null;
    const pick = dayOrder[round];
    if (pick === undefined) return null;
    return topByCost(dayMembers[pick]!, sep, cap);
  }

  /** (b) The `round`-th most-overrun capped context: free its chunks on the
   * days that are actually over, dearest first. */
  function overrunContext(round: number, cap: number): number[] | null {
    if (days <= 0) return null;
    const pick = cappedRanked[round];
    if (pick === undefined) return null;
    const members: number[] = [];
    for (const ti of kept) {
      const task = baked.tasks[ti]!;
      if (task.contextIndex !== pick.cx) continue;
      for (const ci of task.chunkIndices) {
        const d = Math.floor(placement[ci]! / SLOTS_PER_DAY);
        if (pick.days.has(d)) members.push(ci);
      }
    }
    if (members.length === 0) return null;
    return topByCost(members, sep, cap);
  }

  return { menu, accept };
}

/** The chunk's context index if that context prices a daily cap, else -1 —
 * the one test every cap-related loop here starts with. */
function cappedContextOf(baked: Baked, ci: number): number {
  const cx = baked.tasks[baked.chunks[ci]!.taskIndex]!.contextIndex;
  if (cx < 0) return -1;
  const ctx = baked.contexts[cx]!;
  if (ctx.dailyCapSlots < 0 || ctx.dailyCapPenaltyPer15 === 0) return -1;
  return cx;
}

/** (d) Each replanned chunk's churn contribution where it currently sits. */
function churnContributors(
  baked: Baked,
  kept: readonly number[],
  placement: Placement,
): Array<[number, number]> {
  const weight = baked.problem.weights.churn_per_15min_moved;
  const out: Array<[number, number]> = [];
  if (!weight) return out;
  for (const ti of kept) {
    const task = baked.tasks[ti]!;
    const perSlot = weight * task.churnMultiplier;
    if (perSlot === 0) continue;
    for (const ci of task.chunkIndices) {
      const prev = baked.chunks[ci]!.prevSlot;
      if (prev < 0) continue;
      const moved = Math.abs(placement[ci]! - prev) * perSlot;
      if (moved > 0) out.push([ci, moved]);
    }
  }
  return out;
}

/** Descending by cost, ascending by chunk index — the total order every
 * ranking here uses, so equal costs can never reorder between runs. */
function rankNumbers(chunks: readonly number[], cost: (ci: number) => number): number[] {
  return chunks.slice().sort((a, b) => cost(b) - cost(a) || a - b);
}

function rankPairs(pairs: ReadonlyArray<readonly [number, number]>): number[] {
  return pairs
    .slice()
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map((pair) => pair[0]);
}

/** The `round`-th disjoint window of a ranking, ascending inside the window so
 * the freed set has a canonical key. */
function window(ranked: readonly number[], round: number, cap: number): number[] | null {
  const from = round * cap;
  if (from >= ranked.length) return null;
  return ranked.slice(from, from + cap).sort((a, b) => a - b);
}

/** The dearest `cap` members of a list, returned ascending. */
function topByCost(
  members: readonly number[],
  sep: Map<number, number>,
  cap: number,
): number[] {
  const ranked = rankNumbers(members, (ci) => sep.get(ci) ?? 0);
  return ranked.slice(0, cap).sort((a, b) => a - b);
}

function indexOfStart(starts: Int32Array, value: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = starts[mid]!;
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
