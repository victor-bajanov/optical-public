import { describe, it, expect } from "vitest";
import { ACCEPT_TTL_SECONDS } from "../../src/planning/accept-ttl";

describe("ACCEPT_TTL_SECONDS", () => {
  it("is 72 hours in seconds", () => {
    expect(ACCEPT_TTL_SECONDS).toBe(72 * 3600);
  });
});
