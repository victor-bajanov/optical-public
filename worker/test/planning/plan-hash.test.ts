import { describe, it, expect } from "vitest";
import { computePlanHash } from "../../src/planning/plan-hash";

describe("computePlanHash", () => {
  it("returns the same hash for the same logical content regardless of key order", async () => {
    const a = await computePlanHash({
      schedule: [
        {
          task_id: "t",
          chunk_id: "t#0",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          context: "deep",
        },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    });
    const b = await computePlanHash({
      dropped: [],
      window: { end: "2026-05-25T00:00:00Z", start: "2026-05-18T00:00:00Z" },
      schedule: [
        {
          end: "2026-05-19T10:00:00Z",
          start: "2026-05-19T09:00:00Z",
          context: "deep",
          chunk_id: "t#0",
          task_id: "t",
        },
      ],
    });
    expect(a).toBe(b);
  });

  it("returns different hashes for different content", async () => {
    const a = await computePlanHash({ schedule: [{ task_id: "a" }] });
    const b = await computePlanHash({ schedule: [{ task_id: "b" }] });
    expect(a).not.toBe(b);
  });

  it("returns a 64-char hex string", async () => {
    const h = await computePlanHash({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
