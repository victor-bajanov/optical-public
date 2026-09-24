// Card C — D2 interval Hall cuts (internal design notes,
// internal design notes §D2).
//
// The condition under test: for a slot window W, if the chunks whose ENTIRE
// domain envelope lies inside W demand more slots than W has free, no keep-set
// containing all of them packs. It is a necessary condition only — the pack
// DFS stays the completeness closer — so the load-bearing property is the
// absence of false positives: a cut may fire only where `packFeasible` really
// returns null.

import { describe, expect, it } from "vitest";
import { bakeProblem } from "../../src/engine/substrate";
import { packFeasible } from "../../src/engine/pass1";
import { buildHallIndex, hallRefutesResidual, hallViolation } from "../../src/engine/hall";
import type { HallIndex } from "../../src/engine/hall";
import type { Baked, Problem } from "../../src/engine/types";

// ---------------------------------------------------------------------------
// helpers (same fixture conventions as pass1.test.ts)
// ---------------------------------------------------------------------------

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "UTC",
};
const SLOTS_PER_DAY = 96;
const HORIZON = 7 * SLOTS_PER_DAY;

function slot(day: number, hour: number, minute = 0): number {
  return day * SLOTS_PER_DAY + hour * 4 + minute / 15;
}

/** "2026-05-18T09:00:00" for (day 0, 09:00). */
function stamp(day: number, hour: number, minute = 0): string {
  const d = 18 + day;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `2026-05-${String(d).padStart(2, "0")}T${hh}:${mm}:00`;
}

/** Local-naive stamp of a slot index (15-minute grid from the window start). */
function slotStamp(at: number): string {
  const day = Math.floor(at / SLOTS_PER_DAY);
  const rest = at % SLOTS_PER_DAY;
  return stamp(day, Math.floor(rest / 4), (rest % 4) * 15);
}

type TaskOverrides = Partial<Problem["tasks"][number]>;

function makeTask(id: string, over: TaskOverrides = {}): Problem["tasks"][number] {
  return {
    id,
    title: id,
    context: "deep",
    priority: 50,
    chunks: [{ chunk_id: `${id}#0`, duration_minutes: 60 }],
    group_policy: { same_day: false, ordered: false },
    earliest_start: WINDOW.start as Problem["tasks"][number]["earliest_start"],
    preferred_windows: [],
    dependencies: [],
    previous_placement: [],
    must_include: false,
    ...over,
  };
}

/** A task confined to one availability window on `day`. */
function windowed(
  id: string,
  day: number,
  fromHour: number,
  toHour: number,
  durationMinutes = 60,
): Problem["tasks"][number] {
  return makeTask(id, {
    chunks: [{ chunk_id: `${id}#0`, duration_minutes: durationMinutes }],
    availability_windows: [
      {
        start: stamp(day, fromHour) as Problem["tasks"][number]["earliest_start"],
        end: stamp(day, toHour) as Problem["tasks"][number]["earliest_start"],
      },
    ],
  });
}

function makeProblem(over: Partial<Problem> = {}): Problem {
  return {
    window: WINDOW as Problem["window"],
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
        fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "15:00" },
        max_minutes_per_day: null,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 25,
        over_streak_cap_penalty_per_15min: 25,
      },
    ],
    tasks: [],
    external_pinned: [],
    business_hours: null,
    ...over,
  };
}

function bake(over: Partial<Problem> = {}): Baked {
  return bakeProblem(makeProblem(over));
}

function allTasks(baked: Baked): number[] {
  return baked.tasks.map((t) => t.index);
}

/** Chunks bucketed into the boundary cell (loIndex, hiIndex). */
function cell(index: HallIndex, loIndex: number, hiIndex: number): number[] {
  const at = loIndex * index.boundaries.length + hiIndex;
  return Array.from(index.cellChunks.subarray(index.cellOffsets[at]!, index.cellOffsets[at + 1]!));
}

// ---------------------------------------------------------------------------
// 1. window enumeration: boundaries, prefix sums, envelope bucketing
// ---------------------------------------------------------------------------

describe("buildHallIndex — window enumeration", () => {
  it("collects the sorted distinct envelope boundaries, 0 and the horizon included", () => {
    // a: Mon 09:00–11:00, 60 min ⇒ envelope [36, 44)
    // b: Mon 13:00–15:00, 60 min ⇒ envelope [52, 60)
    // c: unconstrained         ⇒ envelope [0, 672)
    const baked = bake({
      tasks: [windowed("a", 0, 9, 11), windowed("b", 0, 13, 15), makeTask("c")],
    });
    const index = buildHallIndex(baked);

    expect(Array.from(index.boundaries)).toEqual([
      0,
      slot(0, 9),
      slot(0, 11),
      slot(0, 13),
      slot(0, 15),
      HORIZON,
    ]);
    // Strictly ascending and distinct.
    for (let i = 1; i < index.boundaries.length; i++) {
      expect(index.boundaries[i]!).toBeGreaterThan(index.boundaries[i - 1]!);
    }
    expect(index.horizon).toBe(HORIZON);
  });

  it("records each chunk's envelope as boundary indices, with its duration", () => {
    const baked = bake({
      tasks: [windowed("a", 0, 9, 11), windowed("b", 0, 13, 15), makeTask("c")],
    });
    const index = buildHallIndex(baked);
    const b = Array.from(index.boundaries);

    for (const chunk of baked.chunks) {
      const lo = index.boundaries[index.chunkLoIndex[chunk.index]!]!;
      const hi = index.boundaries[index.chunkHiIndex[chunk.index]!]!;
      expect(lo).toBe(chunk.allowedStarts[0]!);
      expect(hi).toBe(
        chunk.allowedStarts[chunk.allowedStarts.length - 1]! + chunk.durationSlots,
      );
      expect(index.chunkDuration[chunk.index]).toBe(chunk.durationSlots);
      expect(index.chunkTask[chunk.index]).toBe(chunk.taskIndex);
    }
    expect(b.indexOf(slot(0, 9))).toBeGreaterThan(0);
  });

  it("marks a chunk with an empty domain as having no envelope", () => {
    // A hard preferred window outside its availability leaves no legal start.
    const baked = bake({
      tasks: [
        makeTask("dead", {
          availability_windows: [
            {
              start: stamp(0, 9) as Problem["tasks"][number]["earliest_start"],
              end: stamp(0, 10) as Problem["tasks"][number]["earliest_start"],
            },
          ],
          preferred_windows: [{ days: ["mon"], start: "20:00", end: "22:00", hard: true }],
        }),
      ],
    });
    const index = buildHallIndex(baked);
    expect(baked.chunks[0]!.allowedStarts.length).toBe(0);
    expect(index.chunkLoIndex[0]).toBe(-1);
    expect(index.chunkHiIndex[0]).toBe(-1);
  });

  it("prefix-sums the externally free slots", () => {
    const baked = bake({
      tasks: [makeTask("a")],
      external_pinned: [
        {
          id: "ext",
          title: "ext",
          start: stamp(0, 9) as Problem["tasks"][number]["earliest_start"],
          duration_minutes: 60,
          context: "deep",
        },
      ],
    });
    const index = buildHallIndex(baked);

    expect(index.freePrefix.length).toBe(HORIZON + 1);
    expect(index.freePrefix[0]).toBe(0);
    // Free everywhere up to 09:00.
    expect(index.freePrefix[slot(0, 9)]).toBe(slot(0, 9));
    // The external holds 09:00–10:00: four slots contribute nothing.
    expect(index.freePrefix[slot(0, 10)]).toBe(slot(0, 9));
    expect(index.freePrefix[HORIZON]).toBe(HORIZON - 4);
  });

  it("buckets chunks by their envelope cell", () => {
    const baked = bake({
      tasks: [
        windowed("a", 0, 9, 11),
        windowed("b", 0, 9, 11), // same envelope as a
        windowed("c", 0, 13, 15),
      ],
    });
    const index = buildHallIndex(baked);
    const b = Array.from(index.boundaries);
    const loA = b.indexOf(slot(0, 9));
    const hiA = b.indexOf(slot(0, 11));
    const loC = b.indexOf(slot(0, 13));
    const hiC = b.indexOf(slot(0, 15));

    expect(cell(index, loA, hiA)).toEqual([0, 1]);
    expect(cell(index, loC, hiC)).toEqual([2]);
    // Nothing lands in an unrelated cell.
    expect(cell(index, loA, hiC)).toEqual([]);
  });

  it("is deterministic: two builds over the same bake are field-identical", () => {
    const baked = bake({
      tasks: [windowed("a", 0, 9, 11), windowed("b", 1, 13, 15), makeTask("c")],
    });
    const one = buildHallIndex(baked);
    const two = buildHallIndex(baked);
    expect(Array.from(one.boundaries)).toEqual(Array.from(two.boundaries));
    expect(Array.from(one.cellOffsets)).toEqual(Array.from(two.cellOffsets));
    expect(Array.from(one.cellChunks)).toEqual(Array.from(two.cellChunks));
    expect(Array.from(one.freePrefix)).toEqual(Array.from(two.freePrefix));
  });


  it("thins a very large boundary set, rounding envelopes outwards", () => {
    // 300 tasks, each alone in its own 15-minute availability window: 600
    // distinct envelope boundaries before thinning. The sweep and its scratch
    // matrices are quadratic in the boundary count, so the index caps it —
    // and rounds each envelope OUTWARDS onto the boundaries it kept, which
    // can only weaken the check, never make it wrong.
    const tasks: Problem["tasks"][number][] = [];
    for (let i = 0; i < 300; i++) {
      const start = 2 * i;
      tasks.push(
        makeTask(`s${i}`, {
          chunks: [{ chunk_id: `s${i}#0`, duration_minutes: 15 }],
          availability_windows: [
            {
              start: slotStamp(start) as Problem["tasks"][number]["earliest_start"],
              end: slotStamp(start + 1) as Problem["tasks"][number]["earliest_start"],
            },
          ],
        }),
      );
    }
    const baked = bake({ tasks });
    const index = buildHallIndex(baked);

    expect(index.boundaries.length).toBeLessThanOrEqual(512);
    for (const chunk of baked.chunks) {
      const lo = index.boundaries[index.chunkLoIndex[chunk.index]!]!;
      const hi = index.boundaries[index.chunkHiIndex[chunk.index]!]!;
      // Outwards: the recorded envelope contains the real one.
      expect(lo).toBeLessThanOrEqual(chunk.allowedStarts[0]!);
      expect(hi).toBeGreaterThanOrEqual(
        chunk.allowedStarts[chunk.allowedStarts.length - 1]! + chunk.durationSlots,
      );
    }
    // Every task has its own slot, so nothing is crowded and nothing may fire.
    expect(hallViolation(index, allTasks(baked), null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. violation detection
// ---------------------------------------------------------------------------

describe("hallViolation — refutation without DFS", () => {
  it("returns null when every window has room", () => {
    const baked = bake({ tasks: [windowed("a", 0, 9, 11), windowed("b", 0, 13, 15)] });
    const index = buildHallIndex(baked);
    expect(hallViolation(index, allTasks(baked), null)).toBeNull();
  });

  it("fires on a crowded window that DFS could only refute by exhaustion", () => {
    // Nine 60-minute tasks confined to one 8-slot (2 h) window: demand 36
    // slots against a capacity of 8. The pack DFS would have to enumerate
    // every ordering to refute it; the cut is arithmetic.
    const tasks = [];
    for (let i = 0; i < 9; i++) tasks.push(windowed(`w${i}`, 0, 9, 11));
    const baked = bake({ tasks });
    const index = buildHallIndex(baked);

    const cut = hallViolation(index, allTasks(baked), null);
    expect(cut).not.toBeNull();
    expect(cut!.startSlot).toBe(slot(0, 9));
    expect(cut!.endSlot).toBe(slot(0, 11));
    expect(cut!.demandSlots).toBe(9 * 4);
    expect(cut!.capacitySlots).toBe(8);
    expect(cut!.taskIndices).toEqual(allTasks(baked));
  });

  it("counts externals against the window's capacity", () => {
    // Two 60-minute tasks in a 2 h window fit exactly — until an external
    // takes an hour of it.
    const tasks = [windowed("a", 0, 9, 11), windowed("b", 0, 9, 11)];
    const free = bake({ tasks });
    expect(hallViolation(buildHallIndex(free), allTasks(free), null)).toBeNull();

    const crowded = bake({
      tasks,
      external_pinned: [
        {
          id: "ext",
          title: "ext",
          start: stamp(0, 9) as Problem["tasks"][number]["earliest_start"],
          duration_minutes: 60,
          context: "deep",
        },
      ],
    });
    const cut = hallViolation(buildHallIndex(crowded), allTasks(crowded), null);
    expect(cut).not.toBeNull();
    expect(cut!.capacitySlots).toBe(4);
    expect(cut!.demandSlots).toBe(8);
  });

  it("counts committed placements against the window's capacity", () => {
    // Three tasks, one 2 h window, 12 slots of demand against 8 free — but
    // only two of them are in the keep-set, which fits. Committing one of the
    // two at 09:00 leaves 4 slots for the other's 4: still fine. Committing a
    // THIRD task's chunk there is what overruns it.
    const baked = bake({
      tasks: [windowed("a", 0, 9, 11), windowed("b", 0, 9, 11), windowed("c", 0, 9, 11)],
    });
    const index = buildHallIndex(baked);
    expect(hallViolation(index, [0, 1], null)).toBeNull();

    const committed = new Int32Array(baked.chunks.length).fill(-1);
    committed[baked.tasks[2]!.chunkIndices[0]!] = slot(0, 9);
    const cut = hallViolation(index, [0, 1], committed);
    expect(cut).not.toBeNull();
    expect(cut!.capacitySlots).toBe(4);
    expect(cut!.demandSlots).toBe(8);
    expect(cut!.taskIndices).toEqual([0, 1]);
  });

  it("ignores chunks of tasks outside the keep-set", () => {
    const tasks = [];
    for (let i = 0; i < 9; i++) tasks.push(windowed(`w${i}`, 0, 9, 11));
    const baked = bake({ tasks });
    const index = buildHallIndex(baked);
    // Two of the nine fit exactly.
    expect(hallViolation(index, [0, 1], null)).toBeNull();
    expect(hallViolation(index, [0, 1, 2], null)).not.toBeNull();
  });

  it("excludes a committed chunk from the demand it already occupies", () => {
    // Two tasks in a 2 h window fit exactly; committing one of them must not
    // double-count it (capacity down 4, demand down 4).
    const baked = bake({ tasks: [windowed("a", 0, 9, 11), windowed("b", 0, 9, 11)] });
    const index = buildHallIndex(baked);
    const committed = new Int32Array(baked.chunks.length).fill(-1);
    committed[baked.tasks[0]!.chunkIndices[0]!] = slot(0, 9);
    expect(hallViolation(index, [0, 1], committed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. no false positives (load-bearing)
//
// A cut prunes keep-sets, so a cut that fires on a PACKABLE set is a
// correctness bug, not a missed optimisation.
//
// The oracle is `extensionExists` — exhaustive enumeration written here, from
// the hard-constraint semantics, touching no engine code. It CANNOT be
// `packFeasible`: pass 1 now consults `hallRefutesResidual` at packSearch
// entry, so a firing cut makes packFeasible return null by construction and
// the check would confirm itself. (An unsound mutant — one slot of extra
// demand per chunk — passes the circular version and every anti-vacuity guard
// it carries.) packFeasible is still asserted, but against the brute force:
// that comparison is what would catch the mutant, because the cut would make
// packFeasible disagree with an oracle that does not know the cut exists.
//
// The generator is a seeded PRNG — no `Math.random` anywhere, so a failure
// reproduces exactly — and produces MULTI-CHUNK tasks over FRAGMENTED
// multi-window domains, which is where chunk-granularity envelopes differ
// from the task hull the pass-1 bands use.
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and identical on every platform. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small crowded instances: 1–3 chunks per task over 1–2 disjoint-ish
 * availability windows on one day, plus a couple of externals. Every task
 * carries availability, which keeps the domains — and so the exhaustive
 * oracle — small. No group policy and no dependencies, so the oracle needs
 * only domains and non-overlap. */
function randomProblem(rand: () => number): Problem {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const nTasks = 3 + Math.floor(rand() * 4);
  const tasks: Problem["tasks"][number][] = [];
  for (let i = 0; i < nTasks; i++) {
    const nChunks = 1 + Math.floor(rand() * 3);
    const chunks = [];
    for (let c = 0; c < nChunks; c++) {
      chunks.push({ chunk_id: `t${i}#${c}`, duration_minutes: pick([15, 30, 45, 60]) });
    }
    const windows: Array<{ start: string; end: string }> = [];
    const nWindows = 1 + Math.floor(rand() * 2);
    for (let w = 0; w < nWindows; w++) {
      const from = 8 + Math.floor(rand() * 9);
      const span = 1 + Math.floor(rand() * 2);
      windows.push({ start: stamp(0, from), end: stamp(0, Math.min(from + span, 19)) });
    }
    tasks.push(
      makeTask(`t${i}`, {
        chunks,
        availability_windows: windows as Problem["tasks"][number]["availability_windows"],
      }),
    );
  }
  const externals: Problem["external_pinned"] = [];
  const nExternals = Math.floor(rand() * 3);
  for (let e = 0; e < nExternals; e++) {
    const from = 8 + Math.floor(rand() * 10);
    externals.push({
      id: `ext${e}`,
      title: `ext${e}`,
      start: stamp(0, from) as Problem["external_pinned"][number]["start"],
      duration_minutes: pick([30, 60, 90]),
      context: "deep",
    });
  }
  return makeProblem({ tasks, external_pinned: externals });
}

/** Exhaustive: can every chunk of `taskIndices` be placed on slots that
 * `busy` leaves free, without overlapping each other? Independent of the
 * engine — hard domains and non-overlap only, which is exactly the semantics
 * for these fixtures (no group policy, no dependencies). Most-constrained
 * chunk first, purely so the enumeration terminates quickly. */
function extensionExists(
  baked: Baked,
  taskIndices: readonly number[],
  busy: Uint8Array,
): boolean {
  const chunks: number[] = [];
  for (const t of taskIndices) for (const c of baked.tasks[t]!.chunkIndices) chunks.push(c);
  chunks.sort(
    (a, b) =>
      baked.chunks[a]!.allowedStarts.length - baked.chunks[b]!.allowedStarts.length || a - b,
  );
  const occupied = Uint8Array.from(busy);

  const place = (at: number): boolean => {
    if (at === chunks.length) return true;
    const chunk = baked.chunks[chunks[at]!]!;
    for (const start of chunk.allowedStarts) {
      let free = true;
      for (let s = start; s < start + chunk.durationSlots; s++) {
        if (occupied[s] === 1) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (let s = start; s < start + chunk.durationSlots; s++) occupied[s] = 1;
      if (place(at + 1)) return true;
      for (let s = start; s < start + chunk.durationSlots; s++) occupied[s] = 0;
    }
    return false;
  };
  return place(0);
}

function externalBusy(baked: Baked): Uint8Array {
  const busy = new Uint8Array(baked.horizon);
  for (let s = 0; s < baked.horizon; s++) {
    busy[s] = (baked.externalMask[s >> 5]! >>> (s & 31)) & 1;
  }
  return busy;
}

describe("hallViolation — no false positives", () => {
  it("never cuts a keep-set that can actually be packed", () => {
    const rand = prng(0x0d2c0001);
    let cuts = 0;
    let packable = 0;
    let unpackable = 0;
    let multiChunkCuts = 0;

    for (let trial = 0; trial < 250; trial++) {
      const baked = bakeProblem(randomProblem(rand));
      const index = buildHallIndex(baked);
      const busy = externalBusy(baked);
      const n = baked.tasks.length;

      for (let mask = 1; mask < 1 << n; mask++) {
        const kept: number[] = [];
        for (let t = 0; t < n; t++) if ((mask >> t) & 1) kept.push(t);

        const cut = hallViolation(index, kept, null);
        const canPack = extensionExists(baked, kept, busy);
        if (canPack) packable++;
        else unpackable++;

        // The engine's own answer must track the independent oracle. This is
        // the assertion an unsound cut breaks: it would prune a set the brute
        // force places.
        expect(
          packFeasible(baked, kept) !== null,
          `packFeasible disagrees with exhaustive enumeration on ${JSON.stringify(kept)}`,
        ).toBe(canPack);

        if (cut !== null) {
          cuts++;
          if (kept.some((t) => baked.tasks[t]!.chunkIndices.length > 1)) multiChunkCuts++;
          expect(
            canPack,
            `cut [${cut.startSlot}, ${cut.endSlot}) demand ${cut.demandSlots} > capacity ` +
              `${cut.capacitySlots} fired on a PACKABLE keep-set ${JSON.stringify(kept)}`,
          ).toBe(false);
          expect(cut.demandSlots).toBeGreaterThan(cut.capacitySlots);
          expect(cut.taskIndices.length).toBeGreaterThan(0);
          for (const t of cut.taskIndices) expect(kept).toContain(t);
        }
      }
    }

    // Guard against a vacuous pass: both verdicts exercised, the cut firing,
    // and firing on multi-chunk tasks specifically — the granularity this
    // module claims over the pass-1 bands.
    expect(cuts).toBeGreaterThan(20);
    expect(multiChunkCuts).toBeGreaterThan(10);
    expect(packable).toBeGreaterThan(50);
    expect(unpackable).toBeGreaterThan(50);
  });

  it("never cuts a keep-set that can still be placed around committed chunks", () => {
    const rand = prng(0x0d2c0002);
    let cuts = 0;
    let extendable = 0;

    for (let trial = 0; trial < 200; trial++) {
      const baked = bakeProblem(randomProblem(rand));
      const index = buildHallIndex(baked);
      const n = baked.tasks.length;
      if (n < 3) continue;

      const committedTasks: number[] = [];
      const rest: number[] = [];
      for (let t = 0; t < n; t++) (rand() < 0.4 ? committedTasks : rest).push(t);
      if (rest.length === 0) continue;

      const witness = packFeasible(baked, committedTasks);
      if (witness === null) continue;

      const committed = new Int32Array(baked.chunks.length).fill(-1);
      const busy = externalBusy(baked);
      for (const t of committedTasks) {
        for (const c of baked.tasks[t]!.chunkIndices) {
          const start = witness[c]!;
          committed[c] = start;
          for (let s = start; s < start + baked.chunks[c]!.durationSlots; s++) busy[s] = 1;
        }
      }

      const cut = hallViolation(index, rest, committed);
      const canExtend = extensionExists(baked, rest, busy);
      if (canExtend) extendable++;

      // Both entry points answer the same question and must agree.
      const keptMask = new Uint8Array(n);
      for (const t of rest) keptMask[t] = 1;
      const occ = new Uint8Array(baked.horizon);
      occ.set(busy);
      expect(hallRefutesResidual(index, keptMask, committed, occ)).toBe(cut !== null);

      if (cut !== null) {
        cuts++;
        expect(
          canExtend,
          `cut [${cut.startSlot}, ${cut.endSlot}) fired although ${JSON.stringify(rest)} ` +
            `can still be placed around the committed chunks`,
        ).toBe(false);
      }
    }

    expect(cuts).toBeGreaterThan(5);
    expect(extendable).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 4. payoff: the two class-B problems — MOVED to bench/tests/test_class_b_gates.py
//
// The gate is candidate drops <= ceil(1.10 x reference drops), i.e. 18 and 40
// against the committed reference's 16 and 36
// (internal design notes, "Class B drop margin"), plus
// real placements rather than the pass-1 witness.
//
// It cannot live here. Both solves block the event loop for seconds at
// DEFAULT_BUDGETS (~5 s and ~9 s), and the vitest workers pool drops its
// control connection while that happens — the cases die with "Network
// connection lost" before any assertion runs, which is a harness failure
// wearing the costume of a result. The assertions now run in the bench
// sidecar, against the same runner card G measures with:
//
//   cd bench && uv run --extra dev pytest -m class_b
//
// Measured there on this branch, both gates pass in full:
//   availability_windows-heavy   FEASIBLE, 18 drops (gate 18), 87 scheduled
//   preferred_window_hard-heavy  FEASIBLE, 40 drops (gate 40), 65 scheduled
//
// Baseline for both was PASS1_FALLBACK at 26 and 51 drops
// (internal bench results).
// ---------------------------------------------------------------------------

describe("payoff — class B drop margin", () => {
  it.skip("availability_windows-heavy: FEASIBLE, 18 drops (gate 18) — see bench -m class_b", () => {});
  it.skip("preferred_window_hard-heavy: FEASIBLE, 40 drops (gate 40) — see bench -m class_b", () => {});
});
