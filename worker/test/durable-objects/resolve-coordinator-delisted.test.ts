import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { defaultRunner, __setWebhookReplanForTests } from "../../src/durable-objects/resolve-coordinator";

// Card C (decision C, O14b #3): webhook-driven replans for BOTH providers
// funnel through the per-owner ResolveCoordinator's defaultRunner (the
// Google route and the Microsoft route both call notifyChange; the alarm
// runs defaultRunner). A delisted-but-not-offboarded owner is skipped there,
// before any provider is built, so no calendar read, no solve, no booking-
// decline detection and no replan email happen on their behalf. Gating at
// the runner rather than the two routes also covers a delisting that lands
// inside the debounce window.
describe("defaultRunner — delisted owner (card C)", () => {
  afterEach(() => {
    __setWebhookReplanForTests(null);
    vi.restoreAllMocks();
  });

  function captureReplans(): string[] {
    const seen: string[] = [];
    __setWebhookReplanForTests(async (args) => {
      seen.push(args.accountEmail);
      return { kind: "no_diff" };
    });
    return seen;
  }

  it("does not replan for an owner off a configured allow-list, and logs delisted_skip", async () => {
    const seen = captureReplans();
    const info = vi.spyOn(console, "info");
    await defaultRunner({ ...env, MEMBERSHIP_ALLOWLIST: "listed@org", OPERATOR_EMAIL: "" }, "delisted@org");
    expect(seen).toEqual([]);
    expect(info).toHaveBeenCalledWith("delisted_skip", { path: "webhook_replan" });
    expect(info).not.toHaveBeenCalledWith("resolve_coordinator_fired", expect.anything());
  });

  it("replans for a listed owner", async () => {
    const seen = captureReplans();
    await defaultRunner({ ...env, MEMBERSHIP_ALLOWLIST: "listed@org", OPERATOR_EMAIL: "" }, "listed@org");
    expect(seen).toEqual(["listed@org"]);
  });

  it("replans for any owner when no allow-list is set (prod parity)", async () => {
    const seen = captureReplans();
    await defaultRunner({ ...env, MEMBERSHIP_ALLOWLIST: undefined, OPERATOR_EMAIL: "" }, "delisted@org");
    expect(seen).toEqual(["delisted@org"]);
  });
});
