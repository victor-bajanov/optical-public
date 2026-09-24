import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTurnstile } from "../../src/booking/turnstile";

afterEach(() => vi.restoreAllMocks());

/** The host the token is expected to have been solved on. Every call passes one
 *  — the parameter is not optional, so a caller cannot silently skip the check. */
const HOST = "book.example.com";

describe("verifyTurnstile", () => {
  it("returns false when no token is supplied", async () => {
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "", "1.2.3.4", HOST)).toBe(false);
  });

  it("returns true when siteverify succeeds", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: HOST }), { status: 200 }),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("challenges.cloudflare.com");
  });

  it("returns false when siteverify rejects the token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 }),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });

  it("fails closed when siteverify itself errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });

  it("fails closed when TURNSTILE_SECRET is not configured", async () => {
    // siteverify would say yes if we asked it — the point is that we must not
    // ask. An unconfigured deployment denies rather than letting the claim
    // through unverified.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: HOST }), { status: 200 }),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: undefined } as any, "tok", "1.2.3.4", HOST)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when siteverify responds non-2xx", async () => {
    // The body claims success on the right hostname, so only the status check
    // can deny this — the test cannot pass by accident via the `success !==
    // true` or hostname branches.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: HOST }), { status: 500 }),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });

  it("fails closed when siteverify returns a 2xx body that is not JSON", async () => {
    const malformed = () =>
      new Response("<html>Bad Gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
    // Pin the premise: this body makes res.json() reject, so we are exercising
    // the parse-failure branch, not merely a body with no `success` field.
    await expect(malformed().json()).rejects.toThrow();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => malformed());
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });

  it("fails closed when the token was solved on a different hostname", async () => {
    // A token solved for this sitekey on an attacker's own page verifies with
    // `success: true`; only the hostname distinguishes it from a real one.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: "evil.example" }), { status: 200 }),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });

  it("fails closed when siteverify succeeds but reports no hostname", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });

  it("accepts a testing-key verdict whose hostname is Cloudflare's placeholder", async () => {
    // Verbatim from a live siteverify call with the published always-passes
    // secret `1x0000000000000000000000000000000AA`: it answers for
    // 'example.com' whatever host asked, and flags itself in `metadata`. Only
    // that flag waives the hostname check, so a real secret never can.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          "error-codes": [],
          hostname: "example.com",
          metadata: { result_with_testing_key: true },
        }),
        { status: 200 },
      ),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(true);
  });

  it("still fails closed on a testing-key verdict that did not succeed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          "error-codes": ["invalid-input-response"],
          metadata: { result_with_testing_key: true },
        }),
        { status: 200 },
      ),
    );
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: "s" } as any, "tok", "1.2.3.4", HOST)).toBe(false);
  });
});
