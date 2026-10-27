// tz-matrix for saved poll cells read across an organiser tz move
// (polls/scoring.ts alignCellsToGrid). A saved cell is keyed by its exact UTC
// start on the organiser's half-hour grid at save time; every whole- and
// half-hour zone's grid is the UTC :00/:30 lattice, Kathmandu's :15/:45. For
// every pair of zones, a run painted on `from`'s grid is read on `to`'s.
import { describe, it, expect } from "vitest";
import { alignCellsToGrid } from "../../src/polls/scoring";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, local, offsetMinutes, wall } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const CELL = 30 * 60_000;
const Q = 15 * 60_000;

describe.each(ALL_ZONES)("saved cells painted on the %s grid", (from) => {
  // from's local 10:00-14:00 on 2026-07-14: eight free half-hour cells.
  const spanStart = wall("2026-07-14", "10:00", from);
  const spanEnd = spanStart + 8 * CELL;
  const saved = new Map<string, "free">();
  for (let t = spanStart; t < spanEnd; t += CELL) saved.set(new Date(t).toISOString(), "free");

  it.each(ALL_ZONES)("read on the %s grid", (to) => {
    const r = alignCellsToGrid(saved, to);
    const shift = (offsetMinutes(spanStart, from) - offsetMinutes(spanStart, to)) % 30;
    expect(r.misaligned).toBe(shift !== 0);
    if (!r.misaligned) {
      expect([...r.cells.entries()]).toEqual([...saved.entries()]);
      return;
    }
    for (const k of r.cells.keys()) {
      expect(Date.parse(k)).toBeGreaterThanOrEqual(spanStart);
      expect(Date.parse(k) + CELL).toBeLessThanOrEqual(spanEnd);
    }
    // Every `to`-grid cell fully inside the painted span carries over, free.
    for (let g = spanStart; g + CELL <= spanEnd; g += Q) {
      if (!/:(00|30)$/.test(local(g, to).time)) continue;
      expect(r.cells.get(new Date(g).toISOString()), new Date(g).toISOString()).toBe("free");
    }
  });
});
