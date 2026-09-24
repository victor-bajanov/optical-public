// Card B — the LNS neighbourhood menu (internal design notes):
// stage B1 holds it across passes and repairs it row by row instead of
// rebuilding it (finding (a)); stage B2 fixes how `costliestDay` credits a
// chunk that spans midnight (finding (b)). B2's cases are the last describe
// block; everything above it is B1's.
//
// B1's change has two ways to be wrong, so there are two gates:
//
//   - STALENESS. A cache that has absorbed a run of acceptances must produce
//     exactly the menu a cache built from scratch on the same incumbent
//     produces — at EVERY round, not only the one the loop happens to be
//     asking for. That is `menu equivalence`, driven along real accept
//     trajectories on three fixture classes so each coupling term is actually
//     invalidated: daily caps (a cell's overrun and the slot share that splits
//     it), churn (a per-chunk term with no coupling at all), and lateness-only
//     (`deadline_soft`, whose separable table is zero everywhere and whose
//     entire ranking rides on which chunk decides its task's end).
//   - DRIFT. The repair must be the arithmetic the from-scratch build did, in
//     the same order — bit-identical, not merely close. `improve-payoff.test.ts`
//     pins the phase's payoff numbers and is the trajectory tripwire;
//     `characterization` here is the finer one, pinning the exact result
//     `improve()` returns on each fixture as captured from the pre-change
//     engine (feature/efp-card-b @ c9ca90f).
//
// Both gates run on the heavy tier deliberately: the mediums converge before
// the phase accepts anything at all, and a trajectory with no acceptance
// exercises no invalidation.

import { describe, expect, it } from "vitest";
import { createMenuCache, improve } from "../../src/engine/improve";
import { selectTasks } from "../../src/engine/pass1";
import { place } from "../../src/engine/pass2";
import { bakeProblem } from "../../src/engine/substrate";
import type { Baked, Budget, Placement, Problem } from "../../src/engine/types";

import churnHeavy from "../../../bench/problems/churn-heavy.json";
import contextCapsHeavy from "../../../bench/problems/context_caps-heavy.json";
import deadlineSoftHeavy from "../../../bench/problems/deadline_soft-heavy.json";

const PHASE_OFF: Budget = { wallMs: 0, nodeCap: 0 };

/** improve.ts's own MAX_ROUNDS. Not exported, and the audit wants the whole
 * menu surface rather than the round in play, so it is restated here. */
const ROUNDS = 32;

/** improve.ts's MAX_FREED, likewise. */
const CAP = 8;

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

interface Scenario {
  baked: Baked;
  kept: number[];
  keptChunks: number[];
  placement: Placement;
  cost: number;
}

/** Pass 1's kept set with pass 2's greedy descent under it and the improvement
 * phase switched off — the incumbent the phase is actually handed. */
function scenario(fixture: unknown): Scenario {
  const baked = bakeProblem(benchProblem(fixture));
  const p1 = selectTasks(baked, { wallMs: Infinity, nodeCap: 500_000 });
  const seeded = place(baked, p1.kept, p1.witness, { wallMs: Infinity, nodeCap: 0 }, {
    improveBudget: PHASE_OFF,
  });
  const keptChunks: number[] = [];
  for (const ti of p1.kept) for (const ci of baked.tasks[ti]!.chunkIndices) keptChunks.push(ci);
  return {
    baked,
    kept: p1.kept,
    keptChunks,
    placement: seeded.placement,
    cost: seeded.cost,
  };
}

/** A 32-bit FNV-1a over the placement: a pin that fails loudly on any moved
 * chunk without carrying 105 starts in the source. */
function fnv(p: Placement): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h ^= (p[i]! + 1) & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// fixture — a two-chunk soft deadline, for the coupling the corpus cannot show
// ---------------------------------------------------------------------------

const SPLIT_WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "Australia/Sydney",
};

function slot(day: number, hour: number): number {
  return day * 96 + hour * 4;
}

/** `split` carries two unordered 60-minute chunks and a soft deadline at
 * Monday 06:00; every weight is zero, so the ONLY thing any chunk costs is the
 * lateness charged to whichever of the two ends last. Three fillers give the
 * menu something to rank. */
function splitDeadlineProblem(): Problem {
  const wide = [{ start: "2026-05-18T00:00:00", end: "2026-05-25T00:00:00" }];
  const task = (id: string, over: Record<string, unknown>) =>
    ({
      id,
      title: id,
      context: "deep",
      priority: 50,
      chunks: [{ chunk_id: `${id}#0`, duration_minutes: 60 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: SPLIT_WINDOW.start,
      preferred_windows: [],
      dependencies: [],
      previous_placement: [],
      must_include: false,
      availability_windows: wide,
      ...over,
    }) as unknown as Problem["tasks"][number];

  return {
    window: SPLIT_WINDOW,
    weights: {
      time_of_day_fit_per_15min: 0,
      churn_per_15min_moved: 0,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 0,
      preferred_time_miss_per_15min: 0,
    },
    contexts: [
      {
        context: "deep",
        fit_curve: { peak_start: "00:00", peak_end: "23:45", falloff_end: "23:45" },
        max_minutes_per_day: null,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 0,
        over_streak_cap_penalty_per_15min: 0,
      },
    ],
    tasks: [
      task("split", {
        chunks: [
          { chunk_id: "split#0", duration_minutes: 60 },
          { chunk_id: "split#1", duration_minutes: 60 },
        ],
        deadline: { at: "2026-05-18T06:00:00", hard: false, penalty_per_15min: 10 },
      }),
      task("f0", {}),
      task("f1", {}),
      task("f2", {}),
    ],
    external_pinned: [],
    business_hours: null,
  } as unknown as Problem;
}

/** split#1 sits on Wednesday and owns the lateness bill. */
const SPLIT_LATE: Record<string, number> = {
  "split split#0": slot(0, 9),
  "split split#1": slot(2, 9),
};

/** split#1 has been pulled back to Monday 07:00, so split#0 — which never
 * moved — now ends last and owes the bill. */
const SPLIT_EARLY: Record<string, number> = {
  "split split#0": slot(0, 9),
  "split split#1": slot(0, 7),
};

const SPLIT_FILLERS: Record<string, number> = {
  "f0 f0#0": slot(1, 9),
  "f1 f1#0": slot(3, 9),
  "f2 f2#0": slot(4, 9),
};

function splitPlacement(baked: Baked, starts: Record<string, number>): Placement {
  const p = new Int32Array(baked.chunks.length).fill(-1);
  for (const [key, start] of Object.entries({ ...SPLIT_FILLERS, ...starts })) {
    const ci = baked.chunkIndexByKey.get(key);
    expect(ci, `unknown chunk ${key}`).not.toBeUndefined();
    p[ci!] = start;
  }
  return p;
}

// ---------------------------------------------------------------------------
// 1. menu equivalence — an aged cache is a fresh cache
// ---------------------------------------------------------------------------

/** Walk a real accept trajectory, auditing the WHOLE menu surface at every
 * pass: for each round, the aged cache's neighbourhoods must deep-equal those
 * of a cache built from scratch on the same incumbent.
 *
 * The driver is the accept-loop's shape — free the round's neighbourhoods,
 * solve each exactly, adopt a strict improvement, repeat the round while it
 * keeps accepting — run from outside so the menu can be inspected between
 * steps. It is deliberately more eager than `improveRounds` (no `tried` set,
 * no node budget), which only means more acceptances and therefore more
 * invalidation per fixture. */
function auditTrajectory(s: Scenario): { audits: number; accepted: number } {
  const cache = createMenuCache(s.baked, s.kept, s.keptChunks, s.placement);
  let best = Int32Array.from(s.placement);
  let bestCost = s.cost;
  let audits = 0;
  let accepted = 0;

  const audit = (): void => {
    const fresh = createMenuCache(s.baked, s.kept, s.keptChunks, best);
    for (let round = 0; round < ROUNDS; round++) {
      expect(cache.menu(round, CAP), `round ${round} after ${accepted} acceptances`).toEqual(
        fresh.menu(round, CAP),
      );
    }
    audits++;
  };

  audit();
  for (let round = 0; round < 6; round++) {
    for (let pass = 0; pass < 6; pass++) {
      const menu = cache.menu(round, CAP);
      if (menu.length === 0) break;
      let acceptedThisPass = false;
      for (const freed of menu) {
        const frozen = Int32Array.from(best);
        for (const ci of freed) frozen[ci] = -1;
        const res = place(s.baked, s.kept, null, { wallMs: Infinity, nodeCap: 2_000 }, {
          frozenChunks: frozen,
        });
        if (res.descents <= 0 || !(res.cost < bestCost)) continue;
        const next = Int32Array.from(best);
        for (const ci of s.keptChunks) next[ci] = res.placement[ci]!;
        best = next;
        bestCost = res.cost;
        cache.accept(next);
        accepted++;
        acceptedThisPass = true;
        audit();
      }
      if (!acceptedThisPass) break;
    }
  }
  return { audits, accepted };
}

describe("menu equivalence", () => {
  const cases: Array<[string, unknown]> = [
    ["context_caps-heavy (daily-cap coupling)", contextCapsHeavy],
    ["churn-heavy (separable, no coupling)", churnHeavy],
    ["deadline_soft-heavy (lateness-only)", deadlineSoftHeavy],
  ];
  for (const [name, fixture] of cases) {
    it(`an aged cache matches a fresh build at every round — ${name}`, () => {
      const out = auditTrajectory(scenario(fixture));
      // A trajectory that accepted nothing would have audited nothing but the
      // first build, and proved nothing about invalidation.
      expect(out.accepted, "the fixture must actually accept").toBeGreaterThan(0);
      expect(out.audits).toBe(out.accepted + 1);
    }, 180_000);
  }

  it("reprices a task's other chunks when a move hands the lateness bill to one of them", () => {
    // The corpus cannot reach this: every heavy fixture's tasks are
    // single-chunk, so "the chunk that moved" and "the chunk that decides the
    // task's lateness" are always the same chunk and the coupling is invisible.
    // Here `split` has two, unordered, so the decider is whichever ends last:
    // pulling the late one back to Monday morning hands the whole bill to a
    // chunk that did not move at all.
    const baked = bakeProblem(splitDeadlineProblem());
    const kept = baked.tasks.map((t) => t.index);
    const keptChunks = kept.flatMap((ti) => baked.tasks[ti]!.chunkIndices);
    const cap = Math.max(1, Math.min(CAP, keptChunks.length - 1));
    const before = splitPlacement(baked, SPLIT_LATE);
    const after = splitPlacement(baked, SPLIT_EARLY);

    const aged = createMenuCache(baked, kept, keptChunks, before);
    const wasted = Array.from({ length: ROUNDS }, (_, r) => aged.menu(r, cap));
    aged.accept(after);

    const fresh = createMenuCache(baked, kept, keptChunks, after);
    const expected = Array.from({ length: ROUNDS }, (_, r) => fresh.menu(r, cap));
    // Vacuous unless the move actually changed the menu.
    expect(expected).not.toEqual(wasted);
    expect(Array.from({ length: ROUNDS }, (_, r) => aged.menu(r, cap))).toEqual(expected);
  });

  it("is a pure function of round: menus do not depend on the order they are asked for", () => {
    const s = scenario(contextCapsHeavy);
    const cache = createMenuCache(s.baked, s.kept, s.keptChunks, s.placement);
    const ascending = Array.from({ length: ROUNDS }, (_, r) => cache.menu(r, CAP));
    const descending: number[][][] = [];
    for (let r = ROUNDS - 1; r >= 0; r--) descending[r] = cache.menu(r, CAP);
    expect(descending).toEqual(ascending);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. characterization — the phase's exact answer, captured pre-change
// ---------------------------------------------------------------------------

describe("characterization", () => {
  // Captured from the pre-change engine on feature/efp-card-b @ c9ca90f, with
  // the seed and budget `scenario()` builds. `nodes` is in the pin on purpose:
  // an identical placement reached through a different sub-solve schedule is
  // still a behaviour change, and card E's corpus identity run gates on the
  // same field.
  const cases: Array<[string, unknown, { cost: number; iterations: number; accepted: number; nodes: number; hash: string }]> = [
    [
      "context_caps-heavy",
      contextCapsHeavy,
      { cost: 5625, iterations: 71, accepted: 5, nodes: 609, hash: "9243c9f5" },
    ],
    [
      "churn-heavy",
      churnHeavy,
      { cost: 28_550, iterations: 84, accepted: 16, nodes: 9273, hash: "1f5999d1" },
    ],
    [
      "deadline_soft-heavy",
      deadlineSoftHeavy,
      { cost: 0, iterations: 76, accepted: 22, nodes: 25_585, hash: "79c7e51f" },
    ],
  ];
  for (const [name, fixture, pin] of cases) {
    it(`${name} returns exactly what the pre-change phase returned`, () => {
      const s = scenario(fixture);
      const out = improve(s.baked, s.kept, Int32Array.from(s.placement), s.cost, {
        wallMs: Infinity,
        nodeCap: 60_000,
      });
      expect({
        cost: out.cost,
        iterations: out.iterations,
        accepted: out.accepted,
        nodes: out.nodes,
        hash: fnv(out.placement),
      }).toEqual(pin);
    }, 180_000);
  }
});

// ---------------------------------------------------------------------------
// 3. stage B2 — a chunk that spans midnight belongs to both days' bills
// ---------------------------------------------------------------------------

/** `span` is a 4-hour chunk pinned across Monday midnight (23:00 → 03:00) and
 * carrying the fixture's whole cost as churn; `mon` and `tue` are free
 * one-hour anchors that give each day a second, cost-free member. Every chunk
 * has exactly ONE legal start, which is what keeps the menu readable: with
 * nowhere to move anything, displacement contributes nothing, and with no
 * capped context neither does the overrun family — so `menu()[0]` is the
 * costliest-day family's pick. */
function spanProblem(spanStart: string, spanEnd: string): Problem {
  const task = (id: string, minutes: number, from: string, to: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      title: id,
      context: "deep",
      priority: 50,
      chunks: [{ chunk_id: `${id}#0`, duration_minutes: minutes }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: SPLIT_WINDOW.start,
      preferred_windows: [],
      dependencies: [],
      previous_placement: [],
      must_include: false,
      availability_windows: [{ start: from, end: to }],
      ...over,
    }) as unknown as Problem["tasks"][number];

  return {
    window: SPLIT_WINDOW,
    weights: {
      time_of_day_fit_per_15min: 0,
      churn_per_15min_moved: 25,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 0,
      preferred_time_miss_per_15min: 0,
    },
    contexts: [
      {
        context: "deep",
        fit_curve: { peak_start: "00:00", peak_end: "23:45", falloff_end: "23:45" },
        max_minutes_per_day: null,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 0,
        over_streak_cap_penalty_per_15min: 0,
      },
    ],
    tasks: [
      task("span", 240, spanStart, spanEnd, {
        previous_placement: [{ chunk_id: "span#0", start: "2026-05-18T00:00:00" }],
      }),
      task("mon", 60, "2026-05-18T09:00:00", "2026-05-18T10:00:00"),
      task("tue", 60, "2026-05-19T09:00:00", "2026-05-19T10:00:00"),
    ],
    external_pinned: [],
    business_hours: null,
  } as unknown as Problem;
}

/** The only placement `spanProblem` admits: every chunk's domain is a single
 * start, so this is what a solve would return. */
function onlyPlacement(baked: Baked): Placement {
  const p = new Int32Array(baked.chunks.length).fill(-1);
  for (const chunk of baked.chunks) {
    expect(chunk.allowedStarts.length, `${chunk.chunkId} is not pinned`).toBe(1);
    p[chunk.index] = chunk.allowedStarts[0]!;
  }
  return p;
}

function spanCase(spanStart: string, spanEnd: string) {
  const baked = bakeProblem(spanProblem(spanStart, spanEnd));
  const kept = baked.tasks.map((t) => t.index);
  const keptChunks = kept.flatMap((ti) => baked.tasks[ti]!.chunkIndices);
  const id = (key: string): number => baked.chunkIndexByKey.get(key)!;
  return {
    baked,
    kept,
    keptChunks,
    placement: onlyPlacement(baked),
    span: id("span span#0"),
    mon: id("mon mon#0"),
    tue: id("tue tue#0"),
  };
}

/** Two `deep` chunks share Monday over a 120-minute cap, so each is charged a
 * FRACTIONAL slot-share of the day's overrun; one `admin` chunk sits alone on
 * Tuesday carrying an exact integer churn cost that ties Monday's total. Every
 * chunk is pinned to one legal start, as in `spanProblem`, so `menu()[0]` is
 * the costliest-day family's pick.
 *
 * `wideOver` loads extra separable cost onto the Monday 6-slot chunk and
 * `movedPrev` retunes Tuesday's churn to keep the two days tied; the two tests
 * that read this pick their own values and derive them in their comments. */
function capShareProblem(
  wideOver: Record<string, unknown>,
  movedPrev: string,
): Problem {
  const task = (
    id: string,
    context: string,
    minutes: number,
    from: string,
    to: string,
    over: Record<string, unknown> = {},
  ) =>
    ({
      id,
      title: id,
      context,
      priority: 50,
      chunks: [{ chunk_id: `${id}#0`, duration_minutes: minutes }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: SPLIT_WINDOW.start,
      preferred_windows: [],
      dependencies: [],
      previous_placement: [],
      must_include: false,
      availability_windows: [{ start: from, end: to }],
      ...over,
    }) as unknown as Problem["tasks"][number];

  const uncapped = {
    max_minutes_per_day: null,
    max_contiguous_minutes: null,
    over_daily_cap_penalty_per_15min: 0,
    over_streak_cap_penalty_per_15min: 0,
    fit_curve: { peak_start: "00:00", peak_end: "23:45", falloff_end: "23:45" },
  };

  return {
    window: SPLIT_WINDOW,
    weights: {
      time_of_day_fit_per_15min: 0,
      churn_per_15min_moved: 11,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 0,
      preferred_time_miss_per_15min: 0,
    },
    contexts: [
      {
        ...uncapped,
        context: "deep",
        max_minutes_per_day: 120,
        over_daily_cap_penalty_per_15min: 11,
      },
      { ...uncapped, context: "admin" },
    ],
    tasks: [
      // 6 slots and 13 slots — 19 against a cap of 8, so 11 slots over.
      task("wide", "deep", 90, "2026-05-18T09:00:00", "2026-05-18T10:30:00", wideOver),
      task("narrow", "deep", 195, "2026-05-18T12:00:00", "2026-05-18T15:15:00"),
      task("moved", "admin", 60, "2026-05-19T09:00:00", "2026-05-19T10:00:00", {
        previous_placement: [{ chunk_id: "moved#0", start: movedPrev }],
      }),
    ],
    external_pinned: [],
    business_hours: null,
  } as unknown as Problem;
}

function capShareCase(wideOver: Record<string, unknown> = {}, movedPrev = "2026-05-19T03:30:00") {
  const baked = bakeProblem(capShareProblem(wideOver, movedPrev));
  const kept = baked.tasks.map((t) => t.index);
  const keptChunks = kept.flatMap((ti) => baked.tasks[ti]!.chunkIndices);
  const id = (key: string): number => baked.chunkIndexByKey.get(key)!;
  return {
    baked,
    kept,
    keptChunks,
    placement: onlyPlacement(baked),
    wide: id("wide wide#0"),
    narrow: id("narrow narrow#0"),
    moved: id("moved moved#0"),
  };
}

const ASC = (a: number, b: number): number => a - b;

describe("costliestDay — chunks that span midnight", () => {
  it("credits the spanned days by slot share, so the tail day can lead", () => {
    // span sits 23:00 Mon → 03:00 Tue: 4 of its 16 slots on Monday, 12 on
    // Tuesday. It is 92 slots from its previous placement, so it costs
    // 92 * 25 = 2300 and every other chunk costs nothing. Crediting the start
    // day alone reads Monday 2300 / Tuesday 0; by slot share it is Monday 575
    // / Tuesday 1725, and Tuesday — which carries three quarters of the chunk
    // — leads the ranking it used to be invisible to.
    const c = spanCase("2026-05-18T23:00:00", "2026-05-19T03:00:00");
    const cache = createMenuCache(c.baked, c.kept, c.keptChunks, c.placement);
    expect(cache.menu(0, 2)[0]).toEqual([c.span, c.tue].sort(ASC));
    expect(cache.menu(1, 2)[0]).toEqual([c.span, c.mon].sort(ASC));
  });

  it("leaves the ranking untouched when nothing spans midnight", () => {
    // The same fixture with span moved inside Monday. Its cost is credited
    // whole to one day either way, so the split must not perturb it — the
    // corpus-scale claim that (b)'s churn is limited to genuinely
    // cross-midnight placements rests on exactly this.
    //
    // Readable, but blunt: every cost here is a small integer, so the round
    // trip through the split arithmetic would be exact anyway and this case
    // alone does not prove the whole-credit fast path is load-bearing. The
    // next one does.
    const c = spanCase("2026-05-18T12:00:00", "2026-05-18T16:00:00");
    const cache = createMenuCache(c.baked, c.kept, c.keptChunks, c.placement);
    expect(cache.menu(0, 2)[0]).toEqual([c.span, c.mon].sort(ASC));
    expect(cache.menu(1, 2)[0]).toEqual([c.tue]); // Tuesday holds only its anchor
    expect(cache.menu(2, 2)[0]).toBeUndefined(); // only two days have members
  });

  it("credits a single-day chunk WHOLE, not through cost * dur / dur", () => {
    // The fast path in `rebuildDays` is a float64 claim, so it needs a case
    // where the round trip is genuinely inexact — an integer cost over a
    // power-of-two duration survives it by luck and pins nothing.
    //
    // Monday carries two `deep` chunks, 6 slots (90 min) and 13 slots
    // (195 min), against a 120-minute cap at 11 per 15 min over: 19 slots
    // used, 11 over, so the day's overrun is 121 and it is split by slot
    // share into 121*6/19 = 38.21052631578947 and 121*13/19 =
    // 82.78947368421052. Neither is representable, but their sum is exactly
    // 121, so Monday's bill comes to exactly 242. Tuesday carries one
    // uncapped chunk 22 slots from where it used to be, at 11 per 15 min
    // moved: exactly 242 as an integer. The two days TIE, and the ranking's
    // tie-break puts Monday first.
    //
    // Route those two Monday chunks through (cost * 6) / 6 and (cost * 13) /
    // 13 and Monday lands on 241.99999999999997 — one ulp low, tie broken,
    // Tuesday leads. One ulp is the entire margin, which is the point: the
    // fast path is not an optimization, it is what makes claim 5 true.
    const c = capShareCase();
    const cache = createMenuCache(c.baked, c.kept, c.keptChunks, c.placement);
    expect(cache.menu(0, 2)[0]).toEqual([c.wide, c.narrow].sort(ASC));
    expect(cache.menu(1, 2)[0]).toEqual([c.moved]);
  });

  it("splits deterministically: two builds of the same spanning placement agree", () => {
    // The share is a rational of integer slot counts evaluated the same way
    // every time, so there is no accumulation order to drift.
    const c = spanCase("2026-05-18T23:00:00", "2026-05-19T03:00:00");
    const a = createMenuCache(c.baked, c.kept, c.keptChunks, c.placement);
    const b = createMenuCache(c.baked, c.kept, c.keptChunks, c.placement);
    for (let round = 0; round < ROUNDS; round++) {
      expect(a.menu(round, 2)).toEqual(b.menu(round, 2));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. the addend order inside one chunk's attributed cost
// ---------------------------------------------------------------------------

describe("attributedCost — addend order", () => {
  it("adds the table entry, then lateness, then cap shares — and the order shows", () => {
    // `attributedCost` reproduces the from-scratch build's three passes by
    // adding a chunk's terms in a fixed order, because float addition is not
    // associative. Nothing in the corpus can catch a reordering: no bench
    // fixture puts a fractional cap share on the same chunk as a lateness
    // charge, so every corpus sep is order-insensitive and the identity gate
    // would pass a swapped build just as happily.
    //
    // This fixture puts all three terms on one chunk. `wide` is 90 slots from
    // its previous placement at 11 per 15 min moved (990), ends 33 slots past
    // a soft deadline at 31 per 15 min (1023), and takes 121*6/19 =
    // 38.21052631578947 of Monday's cap overrun. Added in that order Monday
    // totals exactly 2255, which Tuesday ties as pure integer churn
    // (205 * 11 = 2255), so the tie-break puts Monday first. Add the cap share
    // BEFORE the lateness and Monday becomes 2254.9999999999995 — one ulp low,
    // tie broken, Tuesday leads.
    const c = capShareCase(
      {
        previous_placement: [{ chunk_id: "wide#0", start: "2026-05-19T07:30:00" }],
        deadline: { at: "2026-05-18T02:15:00", hard: false, penalty_per_15min: 31 },
      },
      "2026-05-21T12:15:00",
    );
    const cache = createMenuCache(c.baked, c.kept, c.keptChunks, c.placement);
    expect(cache.menu(0, 2)[0]).toEqual([c.wide, c.narrow].sort(ASC));
    expect(cache.menu(1, 2)[0]).toEqual([c.moved]);
  });
});
