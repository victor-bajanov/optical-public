import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  getCalendarSync,
  upsertCalendarSync,
  getCalendarSyncByChannelId,
  listCalendarSyncChannelOwnersWithProvider,
  PRIMARY_CALENDAR_ID,
} from "../../src/db/calendar-sync";
import { storeIdentityTokens } from "../../src/auth/identity-store";

describe("calendar_sync helpers (owner-scoped)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });

  it("returns null when no row exists for the owner", async () => {
    const r = await getCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID);
    expect(r).toBeNull();
  });

  it("upsert then get round-trips fields for an owner", async () => {
    await upsertCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID, {
      next_sync_token: "tok-1",
      channel_id: "ch-1",
      channel_token: "secret",
      channel_expires_at: "2026-05-25T00:00:00Z",
    });
    const r = await getCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID);
    expect(r?.owner_subject).toBe("a@org");
    expect(r?.next_sync_token).toBe("tok-1");
    expect(r?.channel_id).toBe("ch-1");
  });

  it("upsert partially updates only provided fields", async () => {
    await upsertCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID, {
      next_sync_token: "tok-1",
      channel_id: "ch-1",
      channel_token: "t",
      channel_expires_at: null,
    });
    await upsertCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID, { next_sync_token: "tok-2" });
    const r = await getCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID);
    expect(r?.next_sync_token).toBe("tok-2");
    expect(r?.channel_id).toBe("ch-1");
  });

  it("isolates owners: A's upsert does not touch B's row", async () => {
    await upsertCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID, { next_sync_token: "tok-a", channel_id: "ch-a" });
    await upsertCalendarSync(env.DB, "b@org", PRIMARY_CALENDAR_ID, { next_sync_token: "tok-b", channel_id: "ch-b" });
    await upsertCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID, { next_sync_token: "tok-a2" });
    expect((await getCalendarSync(env.DB, "a@org", PRIMARY_CALENDAR_ID))?.next_sync_token).toBe("tok-a2");
    expect((await getCalendarSync(env.DB, "b@org", PRIMARY_CALENDAR_ID))?.next_sync_token).toBe("tok-b");
  });

  it("fails closed on an empty owner for get", async () => {
    await expect(getCalendarSync(env.DB, "", PRIMARY_CALENDAR_ID)).rejects.toThrow("owner_scope_missing");
  });

  it("fails closed on an empty owner for upsert", async () => {
    await expect(
      upsertCalendarSync(env.DB, "", PRIMARY_CALENDAR_ID, { next_sync_token: "x" }),
    ).rejects.toThrow("owner_scope_missing");
  });

  it("getCalendarSyncByChannelId resolves the owner from a channel id", async () => {
    await upsertCalendarSync(env.DB, "b@org", PRIMARY_CALENDAR_ID, {
      channel_id: "ch-b",
      channel_token: "secret-b",
    });
    const row = await getCalendarSyncByChannelId(env.DB, "ch-b");
    expect(row?.owner_subject).toBe("b@org");
    expect(row?.channel_token).toBe("secret-b");
  });

  it("getCalendarSyncByChannelId returns null for an unknown channel id", async () => {
    const row = await getCalendarSyncByChannelId(env.DB, "ch-nope");
    expect(row).toBeNull();
  });
});

describe("listCalendarSyncChannelOwnersWithProvider", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
  });

  it("coalesces an owner with no identity_tokens row to google", async () => {
    await upsertCalendarSync(env.DB, "no-identity@org", PRIMARY_CALENDAR_ID, { channel_id: "ch-1" });
    const owners = await listCalendarSyncChannelOwnersWithProvider(env.DB);
    expect(owners).toEqual([{ owner_subject: "no-identity@org", provider: "google" }]);
  });

  it("reports the stored provider for a microsoft owner", async () => {
    const msEnv = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(
      msEnv,
      "ms-owner@org",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    await upsertCalendarSync(env.DB, "ms-owner@org", PRIMARY_CALENDAR_ID, { channel_id: "ch-ms" });
    const owners = await listCalendarSyncChannelOwnersWithProvider(env.DB);
    expect(owners).toEqual([{ owner_subject: "ms-owner@org", provider: "microsoft" }]);
  });

  it("reports google explicitly for a google owner with an identity_tokens row", async () => {
    await storeIdentityTokens(
      env,
      "google-owner@org",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "google",
    );
    await upsertCalendarSync(env.DB, "google-owner@org", PRIMARY_CALENDAR_ID, { channel_id: "ch-g" });
    const owners = await listCalendarSyncChannelOwnersWithProvider(env.DB);
    expect(owners).toEqual([{ owner_subject: "google-owner@org", provider: "google" }]);
  });

  it("excludes rows without a channel_id (feed/sync-token-only)", async () => {
    await upsertCalendarSync(env.DB, "feedonly@org", PRIMARY_CALENDAR_ID, { next_sync_token: "tok" });
    const owners = await listCalendarSyncChannelOwnersWithProvider(env.DB);
    expect(owners).toEqual([]);
  });
});
