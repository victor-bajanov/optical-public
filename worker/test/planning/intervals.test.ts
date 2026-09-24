import { describe, it, expect } from "vitest";
import { mergeIntervals, subtract, intersect } from "../../src/planning/intervals";

describe("mergeIntervals", () => {
  it("merges touching and overlapping intervals and drops empties", () => {
    expect(mergeIntervals([{ s: 10, e: 20 }, { s: 20, e: 30 }, { s: 5, e: 7 }, { s: 40, e: 40 }]))
      .toEqual([{ s: 5, e: 7 }, { s: 10, e: 30 }]);
  });
});

describe("subtract", () => {
  it("punches a hole in the middle, leaving both sides", () => {
    expect(subtract([{ s: 0, e: 100 }], [{ s: 40, e: 60 }]))
      .toEqual([{ s: 0, e: 40 }, { s: 60, e: 100 }]);
  });

  it("removes an interval covered entirely by a hole", () => {
    expect(subtract([{ s: 10, e: 20 }], [{ s: 0, e: 100 }])).toEqual([]);
  });
});

describe("intersect", () => {
  it("keeps only the overlapping portions", () => {
    expect(intersect([{ s: 0, e: 50 }, { s: 60, e: 100 }], [{ s: 40, e: 70 }]))
      .toEqual([{ s: 40, e: 50 }, { s: 60, e: 70 }]);
  });
});
