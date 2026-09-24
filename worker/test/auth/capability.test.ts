import { describe, it, expect } from "vitest";
import { signCapability, verifyCapability } from "../../src/auth/capability";

const PEPPER = "test-pepper-deadbeef";
const BASE = { planHash: "h1", subject: "a@x.com", purpose: "accept" as const, ttlSeconds: 300 };

describe("capability window claim", () => {
  it("round-trips the window claim", async () => {
    const t = await signCapability(
      { ...BASE, window: { start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z" } },
      PEPPER,
    );
    const claims = await verifyCapability(t, PEPPER);
    expect(claims?.window).toEqual({ start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z" });
  });

  it("tokens without a window claim still verify (old format)", async () => {
    const t = await signCapability(BASE, PEPPER);
    const claims = await verifyCapability(t, PEPPER);
    expect(claims?.planHash).toBe("h1");
    expect(claims?.window).toBeUndefined();
  });
});
