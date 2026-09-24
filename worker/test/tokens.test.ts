import { describe, it, expect } from "vitest";
import { generateOpaqueToken, hashToken, generateAuthCode } from "../src/auth/tokens";

describe("tokens", () => {
  it("generateOpaqueToken returns 43+ char url-safe string", () => {
    const t = generateOpaqueToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("hashToken is deterministic with same pepper", async () => {
    const a = await hashToken("abc", "pepper");
    const b = await hashToken("abc", "pepper");
    expect(a).toBe(b);
  });

  it("hashToken changes with pepper", async () => {
    const a = await hashToken("abc", "pepper1");
    const b = await hashToken("abc", "pepper2");
    expect(a).not.toBe(b);
  });

  it("generateAuthCode is url-safe", () => {
    expect(generateAuthCode()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

});
