import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { ensureSubscription } from "../../src/webhooks/subscription-manager";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { getCalendarSync, casCalendarSyncChannel } from "../../src/db/calendar-sync";

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

/** A channel write needs the subject to hold a stored grant (casCalendarSyncChannel). */
async function seedGrant(subject: string) {
  await env.DB.prepare(
    "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
  ).bind(subject, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", `sub-${subject}`).run();
}

describe("ensureSubscription", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await seedGrant("operator@org");
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

// Two writers racing on one owner (a sign-in's waitUntil against the daily
// sweep, two quick sign-ins, two rotations): both read the same channel state
// and both create a channel. Only the first write may land; the loser must
// stop the channel it just made, or it stays live at Google until expiry.
describe("ensureSubscription — concurrent writers (CAS on channel_id)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await seedGrant("racer@org");
  });

  /** Holds every subscribeToChanges call until `n` have arrived, so both
   *  callers have read calendar_sync before either writes. */
  function barrierCalendar(n: number) {
    const cal = new MockCalendarProvider();
    const real = cal.subscribeToChanges.bind(cal);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    cal.subscribeToChanges = async (url: string, token: string) => {
      const sub = await real(url, token);
      if (++arrived === n) open();
      await gate;
      return sub;
    };
    return cal;
  }

  async function race(cal: MockCalendarProvider) {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const args = {
      db: env.DB,
      ownerSubject: "racer@org",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date("2026-05-18T00:00:00Z"),
    };
    const results = await Promise.all([ensureSubscription(args), ensureSubscription(args)]);
    return { results, warn };
  }

  it("two first-time callers: exactly one channel stored, the loser's channel stopped", async () => {
    const cal = barrierCalendar(2);
    const { results, warn } = await race(cal);
    expect(cal.getSubscribeCallCount()).toBe(2);
    const row = await getCalendarSync(env.DB, "racer@org", "primary");
    const stored = row?.channel_id;
    expect(["mock-channel-1", "mock-channel-2"]).toContain(stored);
    const loser = stored === "mock-channel-1" ? "mock-channel-2" : "mock-channel-1";
    expect(cal.getStoppedChannels()).toEqual([{ channelId: loser, resourceId: "mock-resource" }]);
    expect(results.map((r) => r.subscribed).sort()).toEqual([false, true]);
    expect(warn).toHaveBeenCalledWith("ensureSubscription: lost a concurrent write, stopping own channel", { channelId: loser });
  });

  it("a race on a sync-token-only row keeps its sync token and stops the loser's channel", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token) VALUES ('racer@org', 'primary', 'tok-1')",
    ).run();
    const cal = barrierCalendar(2);
    await race(cal);
    const row = await getCalendarSync(env.DB, "racer@org", "primary");
    expect(row?.next_sync_token).toBe("tok-1");
    expect(cal.getStoppedChannels()).toHaveLength(1);
  });

  it("two rotations of the same expired channel: one wins, the old channel and the loser's are both stopped", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('racer@org', 'primary', 'tok', 'ch-old', 'secret', '2026-05-17T00:00:00Z', 'res-old', 'https://x/v1/webhook/google-calendar')",
    ).run();
    const cal = barrierCalendar(2);
    await race(cal);
    const stored = (await getCalendarSync(env.DB, "racer@org", "primary"))?.channel_id;
    const loser = stored === "mock-channel-1" ? "mock-channel-2" : "mock-channel-1";
    expect(cal.getStoppedChannels()).toEqual(
      expect.arrayContaining([
        { channelId: "ch-old", resourceId: "res-old" },
        { channelId: loser, resourceId: "mock-resource" },
      ]),
    );
    // The old channel is stopped once, by the winner only.
    expect(cal.getStoppedChannels().filter((s) => s.channelId === "ch-old")).toHaveLength(1);
  });
});

// A channel write is only valid while the subject still holds a stored grant.
// An offboard (admin, self-serve or the retention sweep, which the trial cron
// runs next to channel renewal) deletes identity_tokens and calendar_sync; a
// sign-in waitUntil subscribe or a sweep pass already in flight must not then
// recreate the calendar_sync row (keyed by email, it would outlive the purge)
// or leave a live provider channel behind.
describe("ensureSubscription — subject offboarded mid-flight (no stored grant)", () => {
  const fields = {
    channel_id: "ch-new",
    channel_token: "tok",
    channel_expires_at: "2026-05-25T00:00:00Z",
    channel_resource_id: "res-new",
    channel_callback_url: "https://x/v1/webhook/google-calendar",
  };

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
  });

  it("B1: casCalendarSyncChannel refuses to insert a row for a subject with no identity_tokens row", async () => {
    const won = await casCalendarSyncChannel(env.DB, "gone@example.com", "primary", null, fields);
    expect(won).toBe(false);
    expect(await getCalendarSync(env.DB, "gone@example.com", "primary")).toBeNull();
  });

  it("B2: an offboard landing between subscribeToChanges and the write leaves no row and stops the new channel", async () => {
    await seedGrant("leaver@example.com");
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('leaver@example.com', 'primary', 'tok', 'ch-old', 'secret', ?, 'res-old', 'https://x/v1/webhook/google-calendar')",
    ).bind(soon).run();
    const cal = new MockCalendarProvider();
    cal.subscribeToChanges = async (_url: string, token: string) => {
      // What offboardUser's D1 batch does to this subject.
      await env.DB.prepare("DELETE FROM identity_tokens WHERE account_email = ?").bind("leaver@example.com").run();
      await env.DB.prepare("DELETE FROM calendar_sync WHERE owner_subject = ?").bind("leaver@example.com").run();
      return { channelId: "ch-new", channelToken: token, resourceId: "res-new", expiresAt: soon };
    };
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "leaver@example.com",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/google-calendar",
      now: new Date(),
    });

    expect(r).toEqual({ subscribed: false });
    expect(await getCalendarSync(env.DB, "leaver@example.com", "primary")).toBeNull();
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-new", resourceId: "res-new" }]);
    expect(warn).toHaveBeenCalledWith("ensureSubscription: lost a concurrent write, stopping own channel", { channelId: "ch-new" });
  });

  it("B4: an offboard landing during an in-place renew does not recreate the row; the renewed channel is stopped", async () => {
    await seedGrant("leaver@example.com");
    const fixedNow = new Date("2026-08-19T12:00:00Z"); // UTC Wednesday (no forced rotate)
    const soon = new Date(fixedNow.getTime() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('leaver@example.com', 'primary', 'tok', 'sub-old', 'secret', ?, '', 'https://x/v1/webhook/microsoft-calendar')",
    ).bind(soon).run();
    const cal = new MockCalendarProvider({ supportsRenew: true });
    cal.renewSubscription = async (channelId: string) => {
      cal.renewedChannelIds.push(channelId);
      await env.DB.prepare("DELETE FROM identity_tokens WHERE account_email = ?").bind("leaver@example.com").run();
      await env.DB.prepare("DELETE FROM calendar_sync WHERE owner_subject = ?").bind("leaver@example.com").run();
      return { expiresAt: "2026-08-26T12:00:00Z" };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "leaver@example.com",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/microsoft-calendar",
      now: fixedNow,
    });

    expect(r).toEqual({ subscribed: false });
    expect(await getCalendarSync(env.DB, "leaver@example.com", "primary")).toBeNull();
    expect(cal.getSubscribeCallCount()).toBe(0);
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "sub-old", resourceId: "" }]);
    expect(warn).toHaveBeenCalledWith("ensureSubscription: renewed channel no longer stored, stopping it", { channelId: "sub-old" });
  });

  it("B4b: an in-place renew never overwrites a channel a concurrent rotation stored", async () => {
    await seedGrant("holder@example.com");
    const fixedNow = new Date("2026-08-19T12:00:00Z");
    const soon = new Date(fixedNow.getTime() + 2 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('holder@example.com', 'primary', 'tok', 'sub-old', 'secret', ?, '', 'https://x/v1/webhook/microsoft-calendar')",
    ).bind(soon).run();
    const cal = new MockCalendarProvider({ supportsRenew: true });
    cal.renewSubscription = async (channelId: string) => {
      cal.renewedChannelIds.push(channelId);
      // A concurrent rotation won and stored its own channel meanwhile.
      await env.DB.prepare(
        "UPDATE calendar_sync SET channel_id = 'sub-rotated', channel_expires_at = '2026-08-26T00:00:00Z' WHERE owner_subject = ?",
      ).bind("holder@example.com").run();
      return { expiresAt: "2026-08-26T12:00:00Z" };
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await ensureSubscription({
      db: env.DB,
      ownerSubject: "holder@example.com",
      calendar: cal,
      callbackUrl: "https://x/v1/webhook/microsoft-calendar",
      now: fixedNow,
    });

    expect(r).toEqual({ subscribed: false });
    const row = await getCalendarSync(env.DB, "holder@example.com", "primary");
    expect(row?.channel_id).toBe("sub-rotated");
    expect(row?.channel_expires_at).toBe("2026-08-26T00:00:00Z");
  });

  it("B1b: a surviving row whose grant is gone is not updated either (the conflict update is refused too)", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('gone@example.com', 'primary', 'tok', 'ch-old', 'secret', '2026-05-20T00:00:00Z', 'res-old', 'https://x/v1/webhook/google-calendar')",
    ).run();
    const won = await casCalendarSyncChannel(env.DB, "gone@example.com", "primary", "ch-old", fields);
    expect(won).toBe(false);
    const row = await getCalendarSync(env.DB, "gone@example.com", "primary");
    expect(row).toEqual({
      owner_subject: "gone@example.com",
      calendar_id: "primary",
      next_sync_token: "tok",
      channel_id: "ch-old",
      channel_token: "secret",
      channel_expires_at: "2026-05-20T00:00:00Z",
      channel_resource_id: "res-old",
      channel_callback_url: "https://x/v1/webhook/google-calendar",
    });
  });

  it("B3: a grant holder with no calendar_sync row still gets one inserted", async () => {
    await seedGrant("holder@example.com");
    const won = await casCalendarSyncChannel(env.DB, "holder@example.com", "primary", null, fields);
    expect(won).toBe(true);
    const row = await getCalendarSync(env.DB, "holder@example.com", "primary");
    expect(row?.channel_id).toBe("ch-new");
    expect(row?.channel_resource_id).toBe("res-new");
  });
});
