import { describe, it, expect } from "vitest";
import { signCapability, verifyCapability } from "../src/auth/capability";

const PEPPER = "test-pepper";

describe("capability tokens", () => {
  it("verifies a freshly signed accept token", async () => {
    const t = await signCapability({ planHash: "abc", subject: "u@example.com", purpose: "accept", ttlSeconds: 60 }, PEPPER);
    const v = await verifyCapability(t, PEPPER);
    expect(v).toMatchObject({ planHash: "abc", subject: "u@example.com", purpose: "accept" });
  });
  it("rejects a tampered token", async () => {
    const t = await signCapability({ planHash: "abc", subject: "u@example.com", purpose: "accept", ttlSeconds: 60 }, PEPPER);
    expect(await verifyCapability(t.slice(0, -2) + "xx", PEPPER)).toBeNull();
  });
  it("rejects an expired token", async () => {
    const t = await signCapability({ planHash: "abc", subject: "u@example.com", purpose: "accept", ttlSeconds: -1 }, PEPPER);
    expect(await verifyCapability(t, PEPPER)).toBeNull();
  });
});
