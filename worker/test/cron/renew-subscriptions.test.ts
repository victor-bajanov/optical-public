import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runRenewSubscriptions } from "../../src/cron/renew-subscriptions";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { getCalendarSync } from "../../src/db/calendar-sync";
import { storeIdentityTokens } from "../../src/auth/identity-store";

const TEST_ENV = { ...env, OAUTH_ISSUER: "https://scheduler.test" };

async function seedChannelRow(owner: string, expiresAt: string, channelId = `ch-${owner}`) {
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', 'tok', ?, 'secret', ?, ?, 'https://scheduler.test/v1/webhook/google-calendar')",
  )
    .bind(owner, channelId, expiresAt, `res-${owner}`)
    .run();
}

describe("runRenewSubscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });

  it("renews expired and near-expiry channels and leaves fresh ones alone", async () => {
    const expired = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const fresh = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await seedChannelRow("dead@org", expired, "ch-dead");
    await seedChannelRow("alive@org", fresh, "ch-alive");

    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());

    expect(result).toEqual({ checked: 2, renewed: 1, failed: 0 });
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

    expect(result).toEqual({ checked: 2, renewed: 1, failed: 1 });
    const okRow = await getCalendarSync(env.DB, "ok@org", "primary");
    expect(okRow?.channel_id).not.toBe("ch-ok");
  });

  it("skips rows that never had a push channel", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token) VALUES ('feedonly@org', 'primary', 'tok')",
    ).run();

    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());

    expect(result).toEqual({ checked: 0, renewed: 0, failed: 0 });
    const row = await getCalendarSync(env.DB, "feedonly@org", "primary");
    expect(row?.channel_id).toBeNull();
  });

  it("is a no-op when calendar_sync is empty", async () => {
    const result = await runRenewSubscriptions(TEST_ENV, new Date(), () => new MockCalendarProvider());
    expect(result).toEqual({ checked: 0, renewed: 0, failed: 0 });
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

    expect(result).toEqual({ checked: 1, renewed: 1, failed: 0 });
    expect(seenProviders).toEqual(["microsoft"]);
    const row = await getCalendarSync(env.DB, "ms-owner@org", "primary");
    expect(row?.channel_callback_url).toBe("https://scheduler.test/v1/webhook/microsoft-calendar");
  });
});
