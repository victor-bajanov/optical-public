import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { ensureSubscriptionOnSignIn } from "../../src/webhooks/sign-in-subscribe";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { getCalendarSync } from "../../src/db/calendar-sync";
import { logPseudonym } from "../../src/util/log-redact";
import type { Env } from "../../src/env";

const TEST_ENV = { ...env, OAUTH_ISSUER: "https://scheduler.test" };

// Trial finding 1: nothing created a push channel for a new user, so webhook
// replans never fired until someone called subscribeWebhook by hand. The OAuth
// callback now runs this best-effort after storing the grant.
describe("ensureSubscriptionOnSignIn", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    // A channel write needs a stored grant (casCalendarSyncChannel); the OAuth
    // callback stores it before this runs.
    for (const s of ["new@org", "ms@org", "synced@org", "back@org"]) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
      ).bind(s, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", `sub-${s}`).run();
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates a Google push channel for a subject with none, on the Google webhook URL", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const built: Array<[string, string]> = [];
    await ensureSubscriptionOnSignIn(TEST_ENV, "new@org", "google", (subject, provider) => {
      built.push([subject, provider]);
      return new MockCalendarProvider();
    });
    expect(built).toEqual([["new@org", "google"]]);
    const row = await getCalendarSync(env.DB, "new@org", "primary");
    expect(row?.channel_id).toMatch(/^mock-channel-/);
    expect(row?.channel_callback_url).toBe("https://scheduler.test/v1/webhook/google-calendar");
    expect(info).toHaveBeenCalledWith("sign_in_subscribe", { provider: "google", subscribed: true });
  });

  it("uses the Microsoft webhook URL for a Microsoft subject", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await ensureSubscriptionOnSignIn(TEST_ENV, "ms@org", "microsoft", () => new MockCalendarProvider());
    const row = await getCalendarSync(env.DB, "ms@org", "primary");
    expect(row?.channel_callback_url).toBe("https://scheduler.test/v1/webhook/microsoft-calendar");
  });

  it("keeps a sync-token-only row's sync token when adding the channel", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token) VALUES ('synced@org', 'primary', 'tok-1')",
    ).run();
    await ensureSubscriptionOnSignIn(TEST_ENV, "synced@org", "google", () => new MockCalendarProvider());
    const row = await getCalendarSync(env.DB, "synced@org", "primary");
    expect(row?.channel_id).toMatch(/^mock-channel-/);
    expect(row?.next_sync_token).toBe("tok-1");
  });

  it("is a no-op on a fresh channel: a repeat sign-in does not rotate it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const cal = new MockCalendarProvider();
    await ensureSubscriptionOnSignIn(TEST_ENV, "back@org", "google", () => cal);
    const first = (await getCalendarSync(env.DB, "back@org", "primary"))?.channel_id;
    await ensureSubscriptionOnSignIn(TEST_ENV, "back@org", "google", () => cal);
    expect(cal.getSubscribeCallCount()).toBe(1);
    expect((await getCalendarSync(env.DB, "back@org", "primary"))?.channel_id).toBe(first);
    expect(info).toHaveBeenLastCalledWith("sign_in_subscribe", { provider: "google", subscribed: false });
  });

  it("never throws when the provider's subscribe fails; logs one failure line without the subject", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cal = new MockCalendarProvider();
    cal.subscribeToChanges = async () => {
      throw new Error("google 403");
    };
    await expect(
      ensureSubscriptionOnSignIn(TEST_ENV, "fails@org", "google", () => cal),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("sign_in_subscribe_failed", { provider: "google", error: "Error: google 403" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fails@org");
    expect((await getCalendarSync(env.DB, "fails@org", "primary"))).toBeNull();
  });

  it("logs the error with whitespace collapsed, capped at 200 characters (security F3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cal = new MockCalendarProvider();
    cal.subscribeToChanges = async () => {
      throw new Error(`google 400 ${"z".repeat(300)}\nrequest body: {"id":"multi@org"}`);
    };
    await ensureSubscriptionOnSignIn(TEST_ENV, "multi@org", "google", () => cal);
    const fields = warn.mock.calls.find(([m]) => m === "sign_in_subscribe_failed")![1] as { error: string };
    expect(fields.error.length).toBe(200);
    expect(fields.error.startsWith("Error: google 400 zzz")).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("multi@org");
  });

  it("replaces the subject in the error text with its pseudonym", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureSubscriptionOnSignIn(TEST_ENV, "named@org", "google", () => {
      throw new Error("no identity tokens for named@org");
    });
    const fields = warn.mock.calls.find(([m]) => m === "sign_in_subscribe_failed")![1] as { error: string };
    expect(fields.error).toBe(`Error: no identity tokens for ${await logPseudonym(TEST_ENV as Env, "named@org")}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("named@org");
  });

  it("never throws when building the provider fails (e.g. the Microsoft kill switch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      ensureSubscriptionOnSignIn(TEST_ENV, "ms-off@org", "microsoft", () => {
        throw new Error("ms_provider_disabled");
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("sign_in_subscribe_failed", {
      provider: "microsoft",
      error: "Error: ms_provider_disabled",
    });
  });
});
