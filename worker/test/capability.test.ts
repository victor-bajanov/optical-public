import { describe, it, expect } from "vitest";
import { signCapability, verifyCapability } from "../src/auth/capability";

const PEPPER = "test-pepper";

/** Flip one character in the middle of the signature segment. Never the
 *  final one: its low bits are base64 padding that decoding drops, so
 *  rewriting the tail (the old slice(-2)+"xx") was a no-op whenever the
 *  signature already ended "x" + [w-z], a flake about 6 runs in 4096. */
function tamperSig(token: string): string {
  const dot = token.indexOf(".");
  const i = dot + 1 + Math.floor((token.length - dot - 1) / 2);
  return token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
}

describe("capability tokens", () => {
  it("verifies a freshly signed accept token", async () => {
    const t = await signCapability({ planHash: "abc", subject: "u@example.com", purpose: "accept", ttlSeconds: 60 }, PEPPER);
    const v = await verifyCapability(t, PEPPER);
    expect(v).toMatchObject({ planHash: "abc", subject: "u@example.com", purpose: "accept" });
  });
  it("rejects a tampered token", async () => {
    const t = await signCapability({ planHash: "abc", subject: "u@example.com", purpose: "accept", ttlSeconds: 60 }, PEPPER);
    expect(await verifyCapability(tamperSig(t), PEPPER)).toBeNull();
  });
  it("rejects an expired token", async () => {
    const t = await signCapability({ planHash: "abc", subject: "u@example.com", purpose: "accept", ttlSeconds: -1 }, PEPPER);
    expect(await verifyCapability(t, PEPPER)).toBeNull();
  });
});
