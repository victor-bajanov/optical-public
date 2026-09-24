import { describe, it, expect } from "vitest";
import { hashEventUid } from "../../src/calendar-feed/uid";

describe("hashEventUid", () => {
  it("is deterministic and ends with the scheduler namespace", async () => {
    const a = await hashEventUid("evt-123", "key");
    const b = await hashEventUid("evt-123", "key");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}@scheduler\.example\.com$/);
  });

  it("does not reveal the source id and varies by id", async () => {
    const a = await hashEventUid("evt-123", "key");
    const b = await hashEventUid("evt-999", "key");
    expect(a).not.toBe(b);
    expect(a).not.toContain("evt-123");
  });
});
