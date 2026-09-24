import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { ensureSubscription } from "../../src/webhooks/subscription-manager";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { getCalendarSync } from "../../src/db/calendar-sync";

/** Wraps env.DB so the upsertCalendarSync write (INSERT INTO calendar_sync)
 *  throws — simulates a D1 write failure right after a new Graph
 *  subscription was created, to prove the new channelId is logged BEFORE
 *  that write, not only after it succeeds. */
function throwingUpsertDB(realDb: typeof env.DB) {
  const proxy = {
    prepare(sql: string) {
      if (sql.includes("INSERT INTO calendar_sync")) {
        return {
          bind: () => ({
            run: async () => {
              throw new Error("D1 write failed");
            },
          }),
        };
      }
      return realDb.prepare(sql);
    },
  } as unknown as typeof env.DB;
  return proxy;
}

describe("ensureSubscription", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });

  it("subscribes when no row exists", async () => {
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date("2026-05-18T00:00:00Z"),
    });
    expect(r.subscribed).toBe(true);
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).toMatch(/^mock-channel-/);
    expect(row?.channel_token).toBeTruthy();
    expect(row?.channel_expires_at).toBeTruthy();
  });

  it("logs the new channelId immediately after subscribeToChanges succeeds, before the upsert — so an orphaned Graph subscription (upsert failure) stays recoverable", async () => {
    const cal = new MockCalendarProvider();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      ensureSubscription({
        db: throwingUpsertDB(env.DB),
        ownerSubject: "operator@org",
        calendar: cal,
        callbackUrl: "https://x/v1/webhook/google-calendar",
        now: new Date("2026-05-18T00:00:00Z"),
      }),
    ).rejects.toThrow("D1 write failed");

    const loggedFields = consoleInfo.mock.calls.find((c) => String(c[0]).includes("subscription"))?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(loggedFields?.channelId).toMatch(/^mock-channel-/);

    consoleInfo.mockRestore();
  });

  it("does nothing if the existing channel is not near expiry", async () => {
    const farFuture = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-1', 'https://x/v1/webhook/google-calendar')").bind(farFuture).run();
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(false);
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).toBe("ch-old");
  });

  it("renews when channel_expires_at is inside the 48h renewal threshold", async () => {
    // 36h out: beyond the old 24h threshold, inside the 48h one. The daily
    // renewal cron needs >24h of headroom so one missed run can't go dark.
    const soon = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-1', 'https://x/v1/webhook/google-calendar')").bind(soon).run();
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(true);
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).not.toBe("ch-old");
  });

  it("renews when channel_expires_at is inside the next 24h", async () => {
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-1', 'https://x/v1/webhook/google-calendar')").bind(soon).run();
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(true);
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).not.toBe("ch-old");
  });

  it("stops the previous channel when renewing", async () => {
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-old', 'https://x/v1/webhook/google-calendar')").bind(soon).run();
    const cal = new MockCalendarProvider();
    await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-old", resourceId: "res-old" }]);
  });

  it("does not call stopChannel on first subscribe (no prior channel)", async () => {
    const cal = new MockCalendarProvider();
    await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date("2026-05-18T00:00:00Z"),
    });
    expect(cal.getStoppedChannels()).toEqual([]);
  });

  it("swallows stopChannel errors and still rotates", async () => {
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-old', 'https://x/v1/webhook/google-calendar')").bind(soon).run();
    const cal = new MockCalendarProvider();
    cal.stopChannel = async () => { throw new Error("boom"); };
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(true);
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).not.toBe("ch-old");
  });

  it("force:true bypasses the freshness gate even when the row is far from expiry", async () => {
    const farFuture = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-1', 'https://x/v1/webhook/google-calendar')").bind(farFuture).run();
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
      force: true,
    });
    expect(r.subscribed).toBe(true);
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).not.toBe("ch-old");
  });

  it("without force, a far-from-expiry row is left alone (freshness gate intact)", async () => {
    const farFuture = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-1', 'https://x/v1/webhook/google-calendar')").bind(farFuture).run();
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(false);
  });

  it("does not call stopChannel with an empty channel_id (truthiness on channelId, != null on resourceId)", async () => {
    // A row can legitimately carry channel_id: "" (needSubscribe forces true
    // via !existing.channel_id) alongside a non-null channel_resource_id —
    // the old `priorChannelId != null` gate treated "" as present ("" !=
    // null is true) and attempted a doomed stopChannel("", "res-1") call.
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', '', 'secret', ?, 'res-1', 'https://x/v1/webhook/google-calendar')").bind(new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString()).run();
    const cal = new MockCalendarProvider();
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(true);
    expect(cal.getStoppedChannels()).toEqual([]);
  });

  it("fails closed when ownerSubject is empty", async () => {
    const cal = new MockCalendarProvider();
    await expect(
      ensureSubscription({
        db: env.DB,
        calendar: cal,
        callbackUrl: "https://x/v1/webhook/google-calendar",
        ownerSubject: "",
        now: new Date(),
      }),
    ).rejects.toThrow("owner_scope_missing");
  });

  it("renews in place when the provider supports renewSubscription (no rotate)", async () => {
    // Pinned to a non-Sunday `now`: real wall-clock Date.now() would make
    // this test flaky once a week (the weekly forced-rotate window below).
    const fixedNow = new Date("2026-08-19T12:00:00Z"); // UTC Wednesday
    const soon = new Date(fixedNow.getTime() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'sub-old', 'secret', ?, '', 'https://x/v1/webhook/microsoft-calendar')").bind(soon).run();
    const cal = new MockCalendarProvider({ supportsRenew: true });
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/microsoft-calendar",
      now: fixedNow,
    });
    expect(r.subscribed).toBe(true);
    expect(cal.renewedChannelIds).toEqual(["sub-old"]);
    expect(cal.getSubscribeCallCount()).toBe(0); // subscribeToChanges NOT called
    expect(cal.getStoppedChannels()).toEqual([]); // stopChannel NOT called
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).toBe("sub-old"); // unchanged — renewed in place
    expect(row?.channel_expires_at).not.toBe(soon);
  });

  it("falls back to rotate when renewSubscription throws", async () => {
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'sub-old', 'secret', ?, '', 'https://x/v1/webhook/microsoft-calendar')").bind(soon).run();
    const cal = new MockCalendarProvider({ supportsRenew: true });
    cal.renewSubscription = async () => { throw new Error("404 subscription expired"); };
    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "operator@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/microsoft-calendar",
      now: new Date(),
    });
    expect(r.subscribed).toBe(true);
    expect(cal.getSubscribeCallCount()).toBe(1); // fell through to rotate
    const row = await getCalendarSync(env.DB, "operator@org", "primary");
    expect(row?.channel_id).not.toBe("sub-old"); // rotated to a new channel id
    expect(row?.channel_id).toMatch(/^mock-channel-/);
    // Microsoft subscriptions always have an empty channel_resource_id (Graph
    // has no analogue of Google's resourceId) — the old channel must still be
    // stopped on rotate-fallback, not leaked.
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "sub-old", resourceId: "" }]);
  });

  describe("weekly forced rotate (clientState/webhook-secret rotation)", () => {
    // In-place renewal (PATCH) keeps the same channel_token/clientState
    // forever — the webhook secret would never rotate. Force the full
    // rotate path (new token) once a week, on UTC Sundays, regardless of
    // whether the channel is otherwise renewable.
    it("forces a full rotate (not in-place renew) when `now` is a UTC Sunday, even though renewSubscription would otherwise apply", async () => {
      const sundayNow = new Date("2026-08-16T12:00:00Z"); // UTC Sunday
      // 2h inside the 48h renewal threshold, relative to sundayNow (NOT
      // wall-clock `now`) — otherwise the freshness gate itself makes
      // needSubscribe false and this test would pass for the wrong reason.
      const soon = new Date(sundayNow.getTime() + 2 * 3600 * 1000).toISOString();
      await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'sub-old', 'secret', ?, '', 'https://x/v1/webhook/microsoft-calendar')").bind(soon).run();
      const cal = new MockCalendarProvider({ supportsRenew: true });
      const r = await ensureSubscription({
        db: env.DB,
        ownerSubject: "operator@org",
        calendar: cal,
        callbackUrl: "https://x/v1/webhook/microsoft-calendar",
        now: sundayNow,
      });
      expect(r.subscribed).toBe(true);
      expect(cal.renewedChannelIds).toEqual([]); // renewSubscription NOT called
      expect(cal.getSubscribeCallCount()).toBe(1); // rotated instead
      const row = await getCalendarSync(env.DB, "operator@org", "primary");
      expect(row?.channel_id).not.toBe("sub-old");
    });

    it("still renews in place on a UTC Wednesday (unaffected by the weekly rotation)", async () => {
      const wednesdayNow = new Date("2026-08-19T12:00:00Z"); // UTC Wednesday
      const soon = new Date(wednesdayNow.getTime() + 2 * 3600 * 1000).toISOString();
      await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('operator@org', 'primary', 'tok', 'sub-old', 'secret', ?, '', 'https://x/v1/webhook/microsoft-calendar')").bind(soon).run();
      const cal = new MockCalendarProvider({ supportsRenew: true });
      const r = await ensureSubscription({
        db: env.DB,
        ownerSubject: "operator@org",
        calendar: cal,
        callbackUrl: "https://x/v1/webhook/microsoft-calendar",
        now: wednesdayNow,
      });
      expect(r.subscribed).toBe(true);
      expect(cal.renewedChannelIds).toEqual(["sub-old"]);
      expect(cal.getSubscribeCallCount()).toBe(0);
      const row = await getCalendarSync(env.DB, "operator@org", "primary");
      expect(row?.channel_id).toBe("sub-old");
    });
  });
});
