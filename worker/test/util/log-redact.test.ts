import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { logPseudonym, logErrorText } from "../../src/util/log-redact";
import { auditPseudonym } from "../../src/lifecycle/purge-deleted";
import { hashingKey } from "../../src/auth/crypto-keys";
import type { Env } from "../../src/env";

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Security F3: per-owner failure lines logged the subject (an email) daily.
// They now carry a keyed pseudonym an operator can recompute for a known
// address, domain-separated from the audit-log purge pseudonym.
describe("logPseudonym", () => {
  it("is subj: + HMAC-SHA256(hashingKey, 'log-pseudonym:' + subject), hex", async () => {
    const p = await logPseudonym(env as Env, "someone@org");
    expect(p).toMatch(/^subj:[0-9a-f]{64}$/);
    expect(p).toBe(`subj:${await hmacHex(hashingKey(env as Env), "log-pseudonym:someone@org")}`);
    expect(p).not.toContain("someone");
  });

  it("is stable per subject, differs across subjects and keys", async () => {
    const a = await logPseudonym(env as Env, "a@org");
    expect(await logPseudonym(env as Env, "a@org")).toBe(a);
    expect(await logPseudonym(env as Env, "b@org")).not.toBe(a);
    expect(await logPseudonym({ ...env, HASHING_KEY: "another-key" } as Env, "a@org")).not.toBe(a);
  });

  it("can't be confused with the audit pseudonym: different prefix and different MAC", async () => {
    const log = await logPseudonym(env as Env, "a@org");
    const audit = await auditPseudonym(env as Env, "a@org");
    expect(audit.startsWith("deleted:")).toBe(true);
    expect(log.slice("subj:".length)).not.toBe(audit.slice("deleted:".length));
  });

  it("never throws: without a hashing key it returns a fixed marker, never the subject", async () => {
    const keyless = { ...env, HASHING_KEY: "", TOKEN_HASH_PEPPER: "" } as Env;
    await expect(logPseudonym(keyless, "a@org")).resolves.toBe("subj:unavailable");
  });
});

describe("logErrorText", () => {
  it("collapses every whitespace run to one space, so a pretty-printed JSON body keeps its reason", () => {
    const e = new Error('google refresh failed: {\n  "error": "invalid_grant",\n  "error_description": "Token has been expired or revoked."\n}');
    const out = logErrorText(e);
    expect(out).toBe('Error: google refresh failed: { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }');
    expect(out).not.toMatch(/\s{2,}|\n/);
  });

  it("caps the text at 200 characters", () => {
    const out = logErrorText(new Error("x".repeat(500)));
    expect(out.length).toBe(200);
    expect(out.startsWith("Error: xxx")).toBe(true);
  });

  it("stringifies non-Error values the same way", () => {
    expect(logErrorText("plain\n  second")).toBe("plain second");
    expect(logErrorText(42)).toBe("42");
  });

  it("replaces every occurrence of the subject, case-insensitively, with its pseudonym", () => {
    const e = new Error("no identity tokens for Leak@Org (leak@org)");
    const out = logErrorText(e, { subject: "leak@org", pseudonym: "subj:abc" });
    expect(out).toBe("Error: no identity tokens for subj:abc (subj:abc)");
  });

  it("treats the subject literally, not as a pattern", () => {
    const out = logErrorText(new Error("for a+b.c@org and aab.c@org"), { subject: "a+b.c@org", pseudonym: "subj:x" });
    expect(out).toBe("Error: for subj:x and aab.c@org");
  });

  it("redacts before capping, so an address straddling the cap never leaks a prefix", () => {
    const subject = "straddle@org";
    const out = logErrorText(new Error(`${"y".repeat(184)} ${subject}`), { subject, pseudonym: "subj:p" });
    expect(out).not.toContain("straddle");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
