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

describe("confirm-action capability (O9.1)", () => {
  it("round-trips actionId and subject under purpose confirm-action", async () => {
    const t = await signCapability(
      { purpose: "confirm-action", actionId: "act-1", subject: "a@x.com", ttlSeconds: 300 },
      PEPPER,
    );
    const claims = await verifyCapability(t, PEPPER);
    expect(claims?.purpose).toBe("confirm-action");
    if (claims?.purpose !== "confirm-action") throw new Error("narrow");
    expect(claims.actionId).toBe("act-1");
    expect(claims.subject).toBe("a@x.com");
    // Nothing from the other purposes leaks into the claims.
    expect(claims).not.toHaveProperty("planHash");
    expect(claims).not.toHaveProperty("pollId");
  });

  it("an accept token never carries an actionId", async () => {
    const t = await signCapability(BASE, PEPPER);
    const claims = await verifyCapability(t, PEPPER);
    expect(claims?.purpose).toBe("accept");
    expect(claims).not.toHaveProperty("actionId");
  });
});
