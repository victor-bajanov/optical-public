import { describe, it, expect } from "vitest";
import {
  signCapability,
  verifyCapability,
  type PollCapabilityClaims,
  type AcceptCapabilityClaims,
} from "../../src/auth/capability";

const PEPPER = "test-pepper";

// A token signed with the OLD (pre-poll) accept claims shape, generated once
// via the unmodified signCapability({planHash, subject, purpose:"accept",
// ttlSeconds, window}, "test-pepper") and hardcoded here as a byte-compatibility
// pin. exp is ~10 years out so this literal does not expire during the life of
// this test. If this ever fails to verify, the HMAC key derivation or the
// "accept" claims shape changed in a backward-incompatible way.
const OLD_ACCEPT_TOKEN =
  "eyJwbGFuSGFzaCI6InBsYW4tb2xkLWFiYyIsInN1YmplY3QiOiJvbGQtdXNlckBleGFtcGxlLmNvbSIsInB1cnBvc2UiOiJhY2NlcHQiLCJleHAiOjIxMDIwNTA2MDYsIndpbmRvdyI6eyJzdGFydCI6IjIwMjYtMDgtMTdUMDA6MDA6MDBaIiwiZW5kIjoiMjAyNi0wOC0yM1QyMzo1OTo1OVoifX0.pfcxSjFCF9rn5biVcYGtkmcgCnAusUIri-WfSzjNmCg";

describe("capability tokens — poll purpose", () => {
  it("round-trips a poll-response token", async () => {
    const t = await signCapability(
      { purpose: "poll-response", pollId: "p_abc", inviteeId: "pi_123", subject: "org@example.com", ttlSeconds: 60 },
      PEPPER,
    );
    const v = await verifyCapability(t, PEPPER);
    expect(v).toMatchObject({ purpose: "poll-response", pollId: "p_abc", inviteeId: "pi_123", subject: "org@example.com" });
  });

  it("still verifies a token signed under the OLD accept claims shape (byte-compatibility)", async () => {
    const v = await verifyCapability(OLD_ACCEPT_TOKEN, PEPPER);
    expect(v).toMatchObject({
      purpose: "accept",
      planHash: "plan-old-abc",
      subject: "old-user@example.com",
      window: { start: "2026-08-17T00:00:00Z", end: "2026-08-23T23:59:59Z" },
    });
  });

  it("rejects an expired poll-response token", async () => {
    const t = await signCapability(
      { purpose: "poll-response", pollId: "p_abc", inviteeId: "pi_123", subject: "org@example.com", ttlSeconds: -1 },
      PEPPER,
    );
    expect(await verifyCapability(t, PEPPER)).toBeNull();
  });

  it("purpose-narrows: an accept token presented where poll-response is expected is rejected by the caller's discriminant check", async () => {
    const t = await signCapability(
      { purpose: "accept", planHash: "plan-1", subject: "u@example.com", ttlSeconds: 60 },
      PEPPER,
    );
    const claims = await verifyCapability(t, PEPPER);
    expect(claims).not.toBeNull();
    // Caller-side contract: narrow on purpose before trusting poll fields.
    if (claims && claims.purpose === "poll-response") {
      throw new Error("accept token must not narrow to poll-response");
    }
    expect(claims?.purpose).toBe("accept");
    // poll-only fields are not present on the accept variant.
    expect((claims as AcceptCapabilityClaims).planHash).toBe("plan-1");
    expect((claims as unknown as PollCapabilityClaims).pollId).toBeUndefined();
  });

  it("rejects a tampered poll-response token", async () => {
    const t = await signCapability(
      { purpose: "poll-response", pollId: "p_abc", inviteeId: "pi_123", subject: "org@example.com", ttlSeconds: 60 },
      PEPPER,
    );
    expect(await verifyCapability(t.slice(0, -2) + "xx", PEPPER)).toBeNull();
  });
});
