import { describe, it, expect } from "vitest";
import { ResolveBodySchema } from "../../src/planning/resolve";

const base = { window_start: "2026-05-18T00:00:00Z", window_end: "2026-05-25T00:00:00Z" };

describe("ResolveBodySchema window bounds", () => {
  it("accepts a normal one-week window", () => {
    expect(ResolveBodySchema.safeParse(base).success).toBe(true);
  });
  it("rejects a reversed window", () => {
    expect(ResolveBodySchema.safeParse({ window_start: base.window_end, window_end: base.window_start }).success).toBe(false);
  });
  it("rejects an equal start/end window", () => {
    expect(ResolveBodySchema.safeParse({ window_start: base.window_start, window_end: base.window_start }).success).toBe(false);
  });
  it("rejects a span over 366 days", () => {
    expect(ResolveBodySchema.safeParse({ window_start: "2026-01-01T00:00:00Z", window_end: "2027-06-01T00:00:00Z" }).success).toBe(false);
  });
  it("rejects an unparseable instant", () => {
    expect(ResolveBodySchema.safeParse({ window_start: "not-a-date", window_end: base.window_end }).success).toBe(false);
  });
});
