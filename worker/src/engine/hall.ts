// D2 — interval Hall cuts (internal design notes §D2).
//
// Generalises pass 1's per-deadline-band capacity cuts to arbitrary envelope
// windows: for each window W over the sorted distinct domain-envelope
// boundaries, if the total duration of chunks whose entire envelope lies in
// W exceeds W's free capacity, no keep-set containing all those tasks is
// feasible — prune before any DFS. A necessary-condition check only; the
// pack DFS remains the completeness closer.
//
// Two differences from the pass-1 bands this strengthens:
//
//   - the bands are a STATIC list capped at MAX_BANDS_PER_FAMILY and filtered
//     against the whole task set, so a window that only binds for some subset
//     may never have been emitted; every window is evaluated here, against
//     the actual keep-set;
//   - the bands span TASK envelopes and see only external occupancy. Here the
//     unit is the chunk (a multi-chunk task's hull is looser than its chunks'
//     own envelopes) and already-committed placements are charged against
//     capacity, which is what makes the check useful inside a pack in
//     progress rather than only at its root.
//
// Everything is a necessary condition on the RELAXATION that forgets
// contiguity, group policy and dependencies: a violated window refutes, a
// satisfied one proves nothing.

import { maskGet } from "./substrate";
import type { Baked, HallCut, Placement } from "./types";

/** Ceiling on the boundary set. The sweep and its two scratch matrices are
 * quadratic in it, so an unbounded boundary set would put a problem's chunk
 * count on the memory gate: 105-chunk bench heavies reach ~100 boundaries.
 * Three arrays scale with |B|²: cellOffsets (|B|² + 1 entries) and the two
 * scratch matrices, so ~3.1 MB of Int32 at the 512 ceiling, against a 30 MB
 * budget.
 *
 * Thinning stays SOUND because a chunk whose envelope endpoints are no longer
 * boundaries is rounded OUTWARDS — start down to the nearest kept boundary,
 * end up. Its recorded envelope then contains its real one, so it is counted
 * in strictly fewer windows: the check gets weaker, never wrong. */
const MAX_BOUNDARIES = 512;

/** Precomputed window machinery: sorted distinct envelope boundaries,
 * external-occupancy prefix sums, chunks bucketed by envelope. Card C owns
 * the internals; the type is exported so pass 1 can hold one.
 *
 * Everything the check needs per call is preallocated here as scratch, so a
 * `hallViolation` in the selection search's inner loop allocates nothing. */
export interface HallIndex {
  /** Sorted distinct domain-envelope boundary slots (≤ 2 per chunk), always
   * including 0 and the horizon. */
  boundaries: Int32Array;
  horizon: number;
  /** freePrefix[s] = slots in [0, s) no external occupies. */
  freePrefix: Int32Array;
  /** Boundary index of each chunk's envelope start/end; -1 for a chunk with
   * an empty domain (it can never be kept, so it never carries demand). */
  chunkLoIndex: Int32Array;
  chunkHiIndex: Int32Array;
  chunkDuration: Int32Array;
  chunkTask: Int32Array;
  /** CSR over boundary cells: cell (lo, hi) is `boundaries.length * lo + hi`. */
  cellOffsets: Int32Array;
  cellChunks: Int32Array;
  /** Cells that hold at least one chunk — the reset list for the scratch
   * demand matrix, so a call costs O(occupied cells) not O(|B|²) to clear. */
  occupiedCells: Int32Array;
  /** Task index → its chunk indices (CSR). */
  taskChunkOffsets: Int32Array;
  taskChunks: Int32Array;

  // ---- scratch (reused across calls; no meaning between them) ----
  /** Per-cell demand of the current keep-set. */
  scratchCellDemand: Int32Array;
  /** 2D cumulative demand: contained(i, j) = Σ_{i' ≥ i, j' ≤ j} cell(i', j'). */
  scratchContained: Int32Array;
  /** Free-slot prefix sums including committed placements. */
  scratchFreePrefix: Int32Array;
  scratchKept: Uint8Array;
  scratchTaskSeen: Uint8Array;
}

export function buildHallIndex(baked: Baked): HallIndex {
  const horizon = baked.horizon;
  const nChunks = baked.chunks.length;
  const nTasks = baked.tasks.length;

  const chunkLo = new Int32Array(nChunks).fill(-1);
  const chunkHi = new Int32Array(nChunks).fill(-1);
  const chunkDuration = new Int32Array(nChunks);
  const chunkTask = new Int32Array(nChunks);

  const boundarySet = new Set<number>([0, horizon]);
  for (const chunk of baked.chunks) {
    chunkDuration[chunk.index] = chunk.durationSlots;
    chunkTask[chunk.index] = chunk.taskIndex;
    const starts = chunk.allowedStarts;
    if (starts.length === 0) continue;
    const lo = starts[0]!;
    const hi = starts[starts.length - 1]! + chunk.durationSlots;
    chunkLo[chunk.index] = lo;
    chunkHi[chunk.index] = hi;
    boundarySet.add(lo);
    boundarySet.add(hi);
  }
  const boundaries = thin([...boundarySet].sort((a, b) => a - b), horizon);
  const nB = boundaries.length;

  // Round each envelope outwards onto the kept boundaries (a no-op when
  // nothing was thinned, since both endpoints are boundaries by construction).
  const chunkLoIndex = new Int32Array(nChunks).fill(-1);
  const chunkHiIndex = new Int32Array(nChunks).fill(-1);
  for (let c = 0; c < nChunks; c++) {
    if (chunkLo[c]! < 0) continue;
    chunkLoIndex[c] = floorBoundary(boundaries, chunkLo[c]!);
    chunkHiIndex[c] = ceilBoundary(boundaries, chunkHi[c]!);
  }

  // Chunks bucketed by envelope cell (CSR, chunk indices ascending per cell).
  const nCells = nB * nB;
  const cellOffsets = new Int32Array(nCells + 1);
  for (let c = 0; c < nChunks; c++) {
    if (chunkLoIndex[c]! < 0) continue;
    cellOffsets[chunkLoIndex[c]! * nB + chunkHiIndex[c]! + 1]!++;
  }
  for (let i = 0; i < nCells; i++) cellOffsets[i + 1]! += cellOffsets[i]!;
  const cellChunks = new Int32Array(cellOffsets[nCells]!);
  const cursor = Int32Array.from(cellOffsets.subarray(0, nCells));
  for (let c = 0; c < nChunks; c++) {
    if (chunkLoIndex[c]! < 0) continue;
    cellChunks[cursor[chunkLoIndex[c]! * nB + chunkHiIndex[c]!]!++] = c;
  }
  const occupied: number[] = [];
  for (let i = 0; i < nCells; i++) {
    if (cellOffsets[i + 1]! > cellOffsets[i]!) occupied.push(i);
  }

  const freePrefix = new Int32Array(horizon + 1);
  for (let s = 0; s < horizon; s++) {
    const busy = maskGet(baked.externalMask, s) ? 1 : 0;
    freePrefix[s + 1] = freePrefix[s]! + (busy === 1 ? 0 : 1);
  }

  const taskChunkOffsets = new Int32Array(nTasks + 1);
  for (const task of baked.tasks) {
    taskChunkOffsets[task.index + 1] = task.chunkIndices.length;
  }
  for (let t = 0; t < nTasks; t++) taskChunkOffsets[t + 1]! += taskChunkOffsets[t]!;
  const taskChunks = new Int32Array(taskChunkOffsets[nTasks]!);
  for (const task of baked.tasks) {
    let at = taskChunkOffsets[task.index]!;
    for (const c of task.chunkIndices) taskChunks[at++] = c;
  }

  return {
    boundaries,
    horizon,
    freePrefix,
    chunkLoIndex,
    chunkHiIndex,
    chunkDuration,
    chunkTask,
    cellOffsets,
    cellChunks,
    occupiedCells: Int32Array.from(occupied),
    taskChunkOffsets,
    taskChunks,
    scratchCellDemand: new Int32Array(nCells),
    scratchContained: new Int32Array(nCells),
    scratchFreePrefix: new Int32Array(horizon + 1),
    scratchKept: new Uint8Array(nTasks),
    scratchTaskSeen: new Uint8Array(nTasks),
  };
}

/** Evenly thin a sorted boundary list to MAX_BOUNDARIES, always keeping the
 * first and last (0 and the horizon). */
function thin(sorted: number[], horizon: number): Int32Array {
  if (sorted.length <= MAX_BOUNDARIES) return Int32Array.from(sorted);
  const kept = new Set<number>([sorted[0]!, horizon]);
  const stride = (sorted.length - 1) / (MAX_BOUNDARIES - 1);
  for (let i = 0; i < MAX_BOUNDARIES; i++) kept.add(sorted[Math.round(i * stride)]!);
  return Int32Array.from([...kept].sort((a, b) => a - b));
}

/** Index of the largest boundary ≤ `value` (boundaries always start at 0). */
function floorBoundary(boundaries: Int32Array, value: number): number {
  let lo = 0;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boundaries[mid]! <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the smallest boundary ≥ `value` (boundaries always end at the
 * horizon, and no envelope reaches past it). */
function ceilBoundary(boundaries: Int32Array, value: number): number {
  let lo = 0;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid]! >= value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** First violated window over the candidate keep-set, given the placements
 * already committed (null = none), or null when no window is violated.
 *
 * Windows are scanned by ascending start boundary then ascending end, so the
 * cut returned for a given input is deterministic (and is the leftmost,
 * narrowest violated window — the most informative one to report).
 *
 * A committed chunk is charged against capacity for exactly the slots it
 * holds and is excluded from demand, so a chunk already placed inside the
 * window is never counted twice. */
export function hallViolation(
  index: HallIndex,
  keptTaskIndices: readonly number[],
  committed: Placement | null,
): HallCut | null {
  const kept = index.scratchKept;
  kept.fill(0);
  for (const t of keptTaskIndices) {
    if (t >= 0 && t < kept.length) kept[t] = 1;
  }
  return scan(index, kept, committed, committedFreePrefix(index, committed), true);
}

/** Allocation-free hot-path form used inside the pack search: `keptMask[t]`
 * marks the kept tasks, `placed` is the live chunk-indexed placement (-1 =
 * still to place, i.e. still carrying demand) and `occ` is the live
 * occupancy — externals plus every placed chunk — which is what the search
 * already maintains. Reports only whether some window is violated; the cut's
 * identity is never needed inside a search that just has to fail.
 *
 * Pass both `placed` and `occ` as null for the pure SET-level question ("can
 * this keep-set pack at all, under any placement?"), which reuses the index's
 * externals-only prefix sums and so costs nothing per call beyond the sweep. */
export function hallRefutesResidual(
  index: HallIndex,
  keptMask: Uint8Array,
  placed: Placement | null,
  occ: Uint8Array | null,
): boolean {
  let freePrefix = index.freePrefix;
  if (occ !== null) {
    freePrefix = index.scratchFreePrefix;
    let acc = 0;
    freePrefix[0] = 0;
    for (let s = 0; s < index.horizon; s++) {
      if (occ[s]! === 0) acc++;
      freePrefix[s + 1] = acc;
    }
  }
  return scan(index, keptMask, placed, freePrefix, false) !== null;
}

/** The window sweep both entries share. `wantCut` trades the (allocating)
 * contributing-task list for a bare verdict. */
function scan(
  index: HallIndex,
  kept: Uint8Array,
  committed: Placement | null,
  freePrefix: Int32Array,
  wantCut: boolean,
): HallCut | null {
  const nB = index.boundaries.length;
  if (nB < 2) return null;

  // ---- demand: kept, not-yet-committed chunks, bucketed by envelope cell ----
  const demand = index.scratchCellDemand;
  for (const cellId of index.occupiedCells) demand[cellId] = 0;
  let anyDemand = false;
  for (const cellId of index.occupiedCells) {
    let total = 0;
    for (let i = index.cellOffsets[cellId]!; i < index.cellOffsets[cellId + 1]!; i++) {
      const c = index.cellChunks[i]!;
      if (kept[index.chunkTask[c]!] === 0) continue;
      if (committed !== null && committed[c]! >= 0) continue;
      total += index.chunkDuration[c]!;
    }
    demand[cellId] = total;
    if (total > 0) anyDemand = true;
  }
  if (!anyDemand) return null;

  // ---- contained(i, j): chunks with envelope ⊆ [b_i, b_j) ----
  //
  // A cell (i', j') contributes to every window with i ≤ i' and j ≥ j', so the
  // cumulative runs down the start axis and up the end axis.
  const contained = index.scratchContained;
  for (let i = nB - 1; i >= 0; i--) {
    const row = i * nB;
    const below = (i + 1) * nB;
    for (let j = 0; j < nB; j++) {
      let acc = demand[row + j]!;
      if (i + 1 < nB) acc += contained[below + j]!;
      if (j > 0) {
        acc += contained[row + j - 1]!;
        if (i + 1 < nB) acc -= contained[below + j - 1]!;
      }
      contained[row + j] = acc;
    }
  }

  for (let i = 0; i < nB - 1; i++) {
    const lo = index.boundaries[i]!;
    const row = i * nB;
    for (let j = i + 1; j < nB; j++) {
      const demandSlots = contained[row + j]!;
      if (demandSlots === 0) continue;
      const hi = index.boundaries[j]!;
      const capacitySlots = freePrefix[hi]! - freePrefix[lo]!;
      if (demandSlots <= capacitySlots) continue;
      return {
        startSlot: lo,
        endSlot: hi,
        demandSlots,
        capacitySlots,
        taskIndices: wantCut ? contributingTasks(index, kept, committed, i, j) : [],
      };
    }
  }
  return null;
}

/** Free-slot prefix sums with the committed placements charged in. Returns
 * the index's own external-only prefix when nothing is committed. */
function committedFreePrefix(index: HallIndex, committed: Placement | null): Int32Array {
  if (committed === null) return index.freePrefix;
  const horizon = index.horizon;
  const out = index.scratchFreePrefix;
  out.set(index.freePrefix);
  // Committed chunks sit on slots the externals left free (the search only
  // ever places them there), so each one costs its whole duration.
  for (let c = 0; c < committed.length; c++) {
    const start = committed[c]!;
    if (start < 0) continue;
    const end = Math.min(start + index.chunkDuration[c]!, horizon);
    for (let s = start; s < end; s++) out[s + 1]! = -1; // marked; fixed up below
  }
  // Re-derive the prefix in one pass, treating marked slots as occupied.
  let acc = 0;
  for (let s = 0; s < horizon; s++) {
    const free = out[s + 1]! === -1 ? 0 : index.freePrefix[s + 1]! - index.freePrefix[s]!;
    acc += free;
    out[s + 1] = acc;
  }
  out[0] = 0;
  return out;
}

/** Tasks whose chunks make up the demand of window [b_i, b_j), ascending. */
function contributingTasks(
  index: HallIndex,
  kept: Uint8Array,
  committed: Placement | null,
  i: number,
  j: number,
): number[] {
  const seen = index.scratchTaskSeen;
  seen.fill(0);
  const out: number[] = [];
  for (let c = 0; c < index.chunkLoIndex.length; c++) {
    const lo = index.chunkLoIndex[c]!;
    if (lo < i) continue;
    if (lo < 0 || index.chunkHiIndex[c]! > j) continue;
    const t = index.chunkTask[c]!;
    if (kept[t] === 0) continue;
    if (committed !== null && committed[c]! >= 0) continue;
    if (seen[t] === 1) continue;
    seen[t] = 1;
    out.push(t);
  }
  out.sort((a, b) => a - b);
  return out;
}
