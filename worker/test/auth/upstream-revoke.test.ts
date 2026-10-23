import { describe, it, expect, vi, afterEach } from "vitest";
import { upstreamRevokeEnabled, revokeUpstreamGrant } from "../../src/auth/upstream-revoke";
import { ProviderDisabledError } from "../../src/index-providers";
import type { Env } from "../../src/env";

const ON = { UPSTREAM_REVOKE_ENABLED: "true" } as unknown as Env;
const OFF = {} as unknown as Env;
const TOKEN = "1//secret-refresh";

afterEach(() => vi.restoreAllMocks());
const warnLines = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((args: unknown[]) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));

describe("upstreamRevokeEnabled", () => {
  it("is on only for exactly \"true\"", () => {
    expect(upstreamRevokeEnabled(ON)).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "1", " true"]) {
      expect(upstreamRevokeEnabled({ UPSTREAM_REVOKE_ENABLED: v } as unknown as Env), String(v)).toBe(false);
    }
  });
});

describe("revokeUpstreamGrant", () => {
  it("flag off: touches neither the token source nor the IdP, logs nothing, returns disabled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = vi.fn(async () => TOKEN);
    const idp = vi.fn(() => ({ revokeGrant: vi.fn(async () => {}) }));
    expect(await revokeUpstreamGrant(OFF, { token, idp, logPrefix: "offboard_revoke" })).toBe("disabled");
    expect(token).not.toHaveBeenCalled();
    expect(idp).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("flag on: revokes the given token through the given IdP (plain values)", async () => {
    const revokeGrant = vi.fn(async () => {});
    expect(await revokeUpstreamGrant(ON, { token: TOKEN, idp: { revokeGrant }, logPrefix: "x" })).toBe("revoked");
    expect(revokeGrant).toHaveBeenCalledWith(TOKEN);
  });

  it("flag on: resolves lazy token and IdP factories", async () => {
    const revokeGrant = vi.fn(async () => {});
    const out = await revokeUpstreamGrant(ON, { token: async () => TOKEN, idp: async () => ({ revokeGrant }), logPrefix: "x" });
    expect(out).toBe("revoked");
    expect(revokeGrant).toHaveBeenCalledWith(TOKEN);
  });

  it("a null token is a no-op that never builds the IdP", async () => {
    const idp = vi.fn(() => ({ revokeGrant: vi.fn(async () => {}) }));
    expect(await revokeUpstreamGrant(ON, { token: async () => null, idp, logPrefix: "x" })).toBe("no_token");
    expect(idp).not.toHaveBeenCalled();
  });

  it("ProviderDisabledError logs <prefix>_skipped and resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await revokeUpstreamGrant(ON, {
      token: TOKEN, idp: () => { throw new ProviderDisabledError(); }, logPrefix: "offboard_revoke", context: { subject: "s@x" },
    });
    expect(out).toBe("provider_disabled");
    const lines = warnLines(warn);
    expect(lines.some((l) => l.includes("offboard_revoke_skipped") && l.includes("s@x"))).toBe(true);
    expect(lines.some((l) => l.includes("_failed"))).toBe(false);
  });

  it("never throws: an IdP error logs <prefix>_failed with the token redacted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await revokeUpstreamGrant(ON, {
      token: TOKEN,
      idp: { revokeGrant: async (t: string) => { throw new Error(`upstream echoed ${t}`); } },
      logPrefix: "callback_revoke",
      context: { subject: "s@x" },
    });
    expect(out).toBe("failed");
    const lines = warnLines(warn);
    expect(lines.filter((l) => l.includes("callback_revoke_failed"))).toHaveLength(1);
    for (const l of lines) expect(l).not.toContain(TOKEN);
  });

  it("never throws: a token-source error (e.g. undecryptable ciphertext) logs <prefix>_failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await revokeUpstreamGrant(ON, {
      token: async () => { throw new Error("decrypt failed"); }, idp: { revokeGrant: async () => {} }, logPrefix: "offboard_revoke",
    });
    expect(out).toBe("failed");
    expect(warnLines(warn).some((l) => l.includes("offboard_revoke_failed"))).toBe(true);
  });
});
