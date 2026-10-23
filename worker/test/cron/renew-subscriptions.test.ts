import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runRenewSubscriptions } from "../../src/cron/renew-subscriptions";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { getCalendarSync } from "../../src/db/calendar-sync";
import { storeIdentityTokens } from "../../src/auth/identity-store";
import { ProviderDisabledError } from "../../src/index-providers";
import { logPseudonym } from "../../src/util/log-redact";
import type { Env } from "../../src/env";

const TEST_ENV = { ...env, OAUTH_ISSUER: "https://scheduler.test" };

// Seeds the stored grant too: a channel write needs one (casCalendarSyncChannel).
async function seedChannelRow(owner: string, expiresAt: string, channelId = `ch-${owner}`) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
  ).bind(owner, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", `sub-${owner}`).run();
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', 'tok', ?, 'secret', ?, ?, 'https://scheduler.test/v1/webhook/google-calendar')",
  )
    .bind(owner, channelId, expiresAt, `res-${owner}`)
    .run();
}

describe("runRenewSubscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("renews expired and near-expiry channels and leaves fresh ones alone", async () => {
    const expired = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const fresh = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await seedChannelRow("dead@org", expired, "ch-dead");
    await seedChannelRow("alive@org", fresh, "ch-alive");

    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());

    expect(result).toEqual({ checked: 2, renewed: 1, created: 0, create_failed: 0, failed: 0 });
    const deadRow = await getCalendarSync(env.DB, "dead@org", "primary");
    expect(deadRow?.channel_id).not.toBe("ch-dead");
    expect(deadRow?.channel_callback_url).toBe("https://scheduler.test/v1/webhook/google-calendar");
    const aliveRow = await getCalendarSync(env.DB, "alive@org", "primary");
    expect(aliveRow?.channel_id).toBe("ch-alive");
  });

  it("one owner's failure does not abort the others", async () => {
    const expired = new Date(Date.now() - 3600 * 1000).toISOString();
    await seedChannelRow("boom@org", expired, "ch-boom");
    await seedChannelRow("ok@org", expired, "ch-ok");

    const result = await runRenewSubscriptions(TEST_ENV, new Date(), (subject) => {
      if (subject === "boom@org") {
        const cal = new MockCalendarProvider();
        cal.subscribeToChanges = async () => {
          throw new Error("google 500");
        };
        return cal;
      }
      return new MockCalendarProvider();
    });

    expect(result).toEqual({ checked: 2, renewed: 1, created: 0, create_failed: 0, failed: 1 });
    const okRow = await getCalendarSync(env.DB, "ok@org", "primary");
    expect(okRow?.channel_id).not.toBe("ch-ok");
  });

  it("skips rows that never had a push channel when the owner holds no stored grant", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token) VALUES ('feedonly@org', 'primary', 'tok')",
    ).run();

    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());

    expect(result).toEqual({ checked: 0, renewed: 0, created: 0, create_failed: 0, failed: 0 });
    const row = await getCalendarSync(env.DB, "feedonly@org", "primary");
    expect(row?.channel_id).toBeNull();
  });

  it("is a no-op when calendar_sync is empty", async () => {
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());
    expect(result).toEqual({ checked: 0, renewed: 0, created: 0, create_failed: 0, failed: 0 });
  });

  it("resolves a microsoft subject to the microsoft provider and webhook callback", async () => {
    const msEnv = { ...TEST_ENV, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(
      msEnv,
      "ms-owner@org",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    const expired = new Date(Date.now() - 3600 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('ms-owner@org', 'primary', 'tok', 'ch-ms', 'secret', ?, 'res-ms', 'https://scheduler.test/v1/webhook/google-calendar')",
    )
      .bind(expired)
      .run();

    const seenProviders: string[] = [];
    const result = await runRenewSubscriptions(msEnv, new Date(), (_subject, provider) => {
      seenProviders.push(provider);
      return new MockCalendarProvider();
    });

    expect(result).toEqual({ checked: 1, renewed: 1, created: 0, create_failed: 0, failed: 0 });
    expect(seenProviders).toEqual(["microsoft"]);
    const row = await getCalendarSync(env.DB, "ms-owner@org", "primary");
    expect(row?.channel_callback_url).toBe("https://scheduler.test/v1/webhook/microsoft-calendar");
  });
});

// Card C (decision C, O14b #3): channel renewal is a cron acting for the
// owner (a watch/subscription call with their grant), so a delisted-but-not-
// offboarded owner's channel is NOT renewed while an allow-list is set. It
// lapses (Google ~7 d, Graph ~3 d), which also stops pushes for them. Safe
// to skip: the D1 row keeps channel_id, so once re-listed the very next
// daily run sees an expired channel and re-subscribes (rotate path).
describe("runRenewSubscriptions — delisted owner (card C)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("does not renew a delisted owner's channel (no provider built); a listed owner's still renews", async () => {
    const expired = new Date(Date.now() - 3600 * 1000).toISOString();
    await seedChannelRow("delisted@org", expired, "ch-delisted");
    await seedChannelRow("listed@org", expired, "ch-listed");
    const built: string[] = [];

    const result = await runRenewSubscriptions(
      { ...TEST_ENV, MEMBERSHIP_ALLOWLIST: "listed@org", OPERATOR_EMAIL: "" },
      new Date(),
      (subject) => {
        built.push(subject);
        return new MockCalendarProvider();
      },
    );

    expect(built).toEqual(["listed@org"]);
    expect(result).toEqual({ checked: 2, renewed: 1, created: 0, create_failed: 0, failed: 0 });
    expect((await getCalendarSync(env.DB, "delisted@org", "primary"))?.channel_id).toBe("ch-delisted");
    expect((await getCalendarSync(env.DB, "listed@org", "primary"))?.channel_id).not.toBe("ch-listed");
  });

  it("self-heals once re-listed: the lapsed channel is re-subscribed on the next run", async () => {
    const expired = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    await seedChannelRow("relisted@org", expired, "ch-lapsed");
    const result = await runRenewSubscriptions(
      { ...TEST_ENV, MEMBERSHIP_ALLOWLIST: "relisted@org", OPERATOR_EMAIL: "" },
      new Date(),
      () => new MockCalendarProvider(),
    );
    expect(result).toEqual({ checked: 1, renewed: 1, created: 0, create_failed: 0, failed: 0 });
    expect((await getCalendarSync(env.DB, "relisted@org", "primary"))?.channel_id).not.toBe("ch-lapsed");
  });
});

// Trial finding 1: nothing ever created a first channel (only an explicit
// subscribeWebhook did), so trial invitees never got webhook replans. The
// sweep now also creates a channel for every active user holding a stored
// grant who has none: no calendar_sync row, or a row with a NULL channel_id
// (sync-token only, or nulled by a provider switch).
describe("runRenewSubscriptions — creates missing channels (trial finding 1)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  async function seedGrant(subject: string, provider: "google" | "microsoft" = "google") {
    await storeIdentityTokens(
      TEST_ENV,
      subject,
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      provider,
      `sub-${subject}`,
    );
  }

  it("creates a channel for a grant holder with no calendar_sync row", async () => {
    await seedGrant("new@org");
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());
    expect(result).toEqual({ checked: 1, renewed: 0, created: 1, create_failed: 0, failed: 0 });
    const row = await getCalendarSync(env.DB, "new@org", "primary");
    expect(row?.channel_id).toMatch(/^mock-channel-/);
    expect(row?.channel_callback_url).toBe("https://scheduler.test/v1/webhook/google-calendar");
  });

  it("creates a channel on a sync-token-only row and keeps its sync token", async () => {
    await seedGrant("synced@org");
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token) VALUES ('synced@org', 'primary', 'tok-1')",
    ).run();
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());
    expect(result).toEqual({ checked: 1, renewed: 0, created: 1, create_failed: 0, failed: 0 });
    const row = await getCalendarSync(env.DB, "synced@org", "primary");
    expect(row?.channel_id).toMatch(/^mock-channel-/);
    expect(row?.next_sync_token).toBe("tok-1");
  });

  it("creates on the subject's own provider: a Microsoft grant gets the Microsoft webhook URL", async () => {
    await seedGrant("ms@org", "microsoft");
    const seen: string[] = [];
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), (_s, provider) => {
      seen.push(provider);
      return new MockCalendarProvider();
    });
    expect(result).toEqual({ checked: 1, renewed: 0, created: 1, create_failed: 0, failed: 0 });
    expect(seen).toEqual(["microsoft"]);
    expect((await getCalendarSync(env.DB, "ms@org", "primary"))?.channel_callback_url)
      .toBe("https://scheduler.test/v1/webhook/microsoft-calendar");
  });

  it("renews and creates in one run, and never creates twice for an owner who already has a channel", async () => {
    await seedGrant("has@org");
    await seedChannelRow("has@org", new Date(Date.now() - 3600 * 1000).toISOString(), "ch-has");
    await seedGrant("none@org");
    const built: string[] = [];
    // One shared mock: each MockCalendarProvider numbers its channels from 1,
    // and calendar_sync.channel_id is UNIQUE.
    const cal = new MockCalendarProvider();
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), (subject) => {
      built.push(subject);
      return cal;
    });
    expect(result).toEqual({ checked: 2, renewed: 1, created: 1, create_failed: 0, failed: 0 });
    expect(built.sort()).toEqual(["has@org", "none@org"]);
  });

  it("leaves a fresh channel alone and does not count it as created", async () => {
    await seedGrant("fresh@org");
    await seedChannelRow("fresh@org", new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(), "ch-fresh");
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());
    expect(result).toEqual({ checked: 1, renewed: 0, created: 0, create_failed: 0, failed: 0 });
    expect((await getCalendarSync(env.DB, "fresh@org", "primary"))?.channel_id).toBe("ch-fresh");
  });

  it("skips a deactivated user even if a grant row survived", async () => {
    await seedGrant("gone@org");
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE subject = 'gone@org'").run();
    const built: string[] = [];
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), (s) => {
      built.push(s);
      return new MockCalendarProvider();
    });
    expect(built).toEqual([]);
    expect(result).toEqual({ checked: 0, renewed: 0, created: 0, create_failed: 0, failed: 0 });
    expect(await getCalendarSync(env.DB, "gone@org", "primary")).toBeNull();
  });

  it("skips a delisted grant holder while an allow-list is set (no provider built, counted in checked only)", async () => {
    await seedGrant("delisted@org");
    await seedGrant("listed@org");
    const built: string[] = [];
    const result = await runRenewSubscriptions(
      { ...TEST_ENV, MEMBERSHIP_ALLOWLIST: "listed@org", OPERATOR_EMAIL: "" },
      new Date(),
      (s) => {
        built.push(s);
        return new MockCalendarProvider();
      },
    );
    expect(built).toEqual(["listed@org"]);
    expect(result).toEqual({ checked: 2, renewed: 0, created: 1, create_failed: 0, failed: 0 });
    expect(await getCalendarSync(env.DB, "delisted@org", "primary")).toBeNull();
  });

  it("one owner's create failure does not abort the others and is counted as create_failed, not failed", async () => {
    await seedGrant("boom@org");
    await seedGrant("ok@org");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), (subject) => {
      const cal = new MockCalendarProvider();
      if (subject === "boom@org") {
        cal.subscribeToChanges = async () => {
          throw new Error("google 403");
        };
      }
      return cal;
    });
    expect(result).toEqual({ checked: 2, renewed: 0, created: 1, create_failed: 1, failed: 0 });
    expect(err).toHaveBeenCalledWith("subscription-create failed", {
      subject: await logPseudonym(TEST_ENV as Env, "boom@org"),
      error: "Error: google 403",
    });
    expect(JSON.stringify(err.mock.calls)).not.toContain("boom@org");
    expect((await getCalendarSync(env.DB, "ok@org", "primary"))?.channel_id).toMatch(/^mock-channel-/);
    err.mockRestore();
  });

  // Security F3: both per-owner failure lines carry a keyed pseudonym, never
  // the subject (an email), and only the first line of the error, capped.
  for (const pass of ["renewal", "create"] as const) {
    it(`the subscription-${pass} failed line carries a pseudonym and a capped one-line error, never the email`, async () => {
      if (pass === "renewal") await seedChannelRow("leak@org", new Date(Date.now() - 3600 * 1000).toISOString());
      else await seedGrant("leak@org");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await runRenewSubscriptions(TEST_ENV, new Date(), () => {
        const cal = new MockCalendarProvider();
        cal.subscribeToChanges = async () => {
          throw new Error(`google 400 ${"y".repeat(300)}\nrequest body: {"id":"leak@org"}`);
        };
        return cal;
      });
      const calls = err.mock.calls.filter(([msg]) => msg === `subscription-${pass} failed`);
      expect(calls).toHaveLength(1);
      const fields = calls[0]![1] as { subject: string; error: string };
      expect(fields.subject).toMatch(/^subj:[0-9a-f]{64}$/);
      expect(fields.subject).toBe(await logPseudonym(TEST_ENV as Env, "leak@org"));
      expect(fields.error.length).toBe(200);
      expect(fields.error.startsWith("Error: google 400 yyy")).toBe(true);
      expect(JSON.stringify(err.mock.calls)).not.toContain("leak@org");
      err.mockRestore();
    });
  }

  // Review: errors such as identity-store's "no identity tokens for <subject>"
  // carry the address in their text, so the error is redacted too.
  for (const pass of ["renewal", "create"] as const) {
    it(`the subscription-${pass} failed error has the subject replaced by its pseudonym`, async () => {
      if (pass === "renewal") await seedChannelRow("named@org", new Date(Date.now() - 3600 * 1000).toISOString());
      else await seedGrant("named@org");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await runRenewSubscriptions(TEST_ENV, new Date(), () => {
        throw new Error("no identity tokens for Named@Org");
      });
      const fields = err.mock.calls.find(([m]) => m === `subscription-${pass} failed`)![1] as { error: string };
      const p = await logPseudonym(TEST_ENV as Env, "named@org");
      expect(fields.error).toBe(`Error: no identity tokens for ${p}`);
      expect(JSON.stringify(err.mock.calls).toLowerCase()).not.toContain("named@org");
      err.mockRestore();
    });
  }

  it("a disabled provider (Microsoft kill switch) is skipped, not failed: the switch is deliberate", async () => {
    await seedGrant("ms-off@org", "microsoft");
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => {
      throw new ProviderDisabledError();
    });
    expect(result).toEqual({ checked: 1, renewed: 0, created: 0, create_failed: 0, failed: 0 });
    expect(await getCalendarSync(env.DB, "ms-off@org", "primary")).toBeNull();
  });

  it("logs the summary with the created count", async () => {
    await seedGrant("new@org");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());
    expect(info).toHaveBeenCalledWith("subscription_renewal", { checked: 1, renewed: 0, created: 1, create_failed: 0, failed: 0 });
    info.mockRestore();
  });
});
