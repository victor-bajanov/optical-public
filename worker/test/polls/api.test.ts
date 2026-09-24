import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  mountMeetingPollRoutes,
  __setPollBookingEngineForTests,
  type BookOutcome,
  type PollBookingEngine,
} from "../../src/handlers/polls";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { PollEmail } from "../../src/providers/notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { verifyCapabilityWithEnv } from "../../src/auth/capability";
import { saveBookingPage } from "../../src/db/booking-page";
import { bookAtDeadline, resolveMeetingFitCurve, __setForTests } from "../../src/polls/booking";
import { organiserFit } from "../../src/polls/scoring";
import { getHomeTz } from "../../src/db/users";
import { runPollSweep } from "../../src/cron/poll-sweep";
import { upsertUser } from "../../src/db/users";
import { createPoll as dbCreatePoll, insertInvitee as dbInsertInvitee, newInviteeId, dropInvitee as dbDropInvitee, setHideName, replaceResponses } from "../../src/db/polls";
import { mountPollRoutes } from "../../src/polls/route";
import { ACCESS_PREFIX } from "../../src/auth/identity-store";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";

const OWNER = "poll-owner@org";
const OTHER = "someone-else@org";

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

function makeApp(notification: MockNotificationProvider, calendar = new MockCalendarProvider()): App {
  const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "validation_failed", issues: result.error.issues }, 400);
    },
  });
  mountMeetingPollRoutes(v1);
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("notificationProvider", notification);
    c.set("calendarProvider", calendar);
    await next();
  });
  app.route("/v1", v1);
  return app;
}

/** Like makeApp, but also mounts T7's public poll routes (route.ts) at root
 *  alongside the authenticated /v1 API — used ONLY to prove a guest-link
 *  disable (Card C) actually kills the public join route, per the plan's
 *  "reuse the join-route harness assertion" note. Every other PATCH test
 *  uses plain makeApp; the public routes are otherwise out of this file's
 *  fence (T7's own route.test.ts owns their behaviour). */
function makeAppWithJoinRoute(notification: MockNotificationProvider, calendar = new MockCalendarProvider()): App {
  const app = makeApp(notification, calendar);
  mountPollRoutes(app);
  return app;
}

/** A MockNotificationProvider whose `sendPollEmail` throws once armFailure(n)
 *  is called, on the n-th send AFTER arming (not counting sends before it,
 *  e.g. a poll's own invite emails) — regression harness for R1-F4. */
class FlakyNotificationProvider extends MockNotificationProvider {
  private armedAtCall: number | null = null;
  private callsSinceArm = 0;

  armFailure(nthCallFromNow: number): void {
    this.armedAtCall = nthCallFromNow;
    this.callsSinceArm = 0;
  }

  async sendPollEmail(email: PollEmail): Promise<void> {
    if (this.armedAtCall !== null) {
      this.callsSinceArm += 1;
      if (this.callsSinceArm === this.armedAtCall) throw new Error("smtp unavailable (R1-F4 regression harness)");
    }
    await super.sendPollEmail(email);
  }
}

async function seedBearer(token: string, subject: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

const TEST_ENV: Env = { ...(env as unknown as Env), MEETING_POLL_ENABLED: "true" };
const FLAG_OFF_ENV: Env = { ...TEST_ENV, MEETING_POLL_ENABLED: "false" };
const AUTH = { Authorization: "Bearer fake" };

// Nine weeks from "now" would be flaky against a fixed poll range; use dates
// comfortably in the future relative to any plausible test run.
const RANGE_START = "2027-01-04"; // Monday
const RANGE_END = "2027-01-15"; // 11 days later, well within 6 weeks
const DEADLINE = "2027-01-14T00:00:00Z";

const VALID_BODY = {
  title: "Roadmap sync",
  invitees: [
    { email: "alice@example.com", name: "Alice" },
    { email: "bob@example.com", name: "Bob" },
  ],
  durationMin: 30,
  rangeStart: RANGE_START,
  rangeEnd: RANGE_END,
  deadlineUtc: DEADLINE,
  location: { kind: "meet" },
  guestLink: false,
};

async function clearPollTables() {
  for (const t of ["poll_responses", "poll_invitees", "polls"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM config_booking_page WHERE owner_subject != '__default__'").run();
}

beforeEach(async () => {
  await clearPollTables();
  await seedBearer("fake", OWNER);
  __setPollBookingEngineForTests(null);
  // Wide-open booking page config so candidate ranking in getMeetingPoll/
  // resolve isn't accidentally starved by min-notice/hours defaults.
  await saveBookingPage(env.DB, OWNER, {
    enabled: true,
    hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "23:45" },
    horizon_days: 21,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
});

describe("POST /v1/polls (createMeetingPoll)", () => {
  it("creates a poll and sends one invite per invitee, each with its own token URL", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const res = await app.request("/v1/polls", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(VALID_BODY) }, TEST_ENV);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; statusUrl: string; guestUrl?: string };
    expect(body.id).toMatch(/^p_/);
    expect(body.guestUrl).toBeUndefined();

    expect(notification.sentPollEmails).toHaveLength(2);
    const urls = notification.sentPollEmails.map((e) => {
      const match = e.html.match(/href="([^"]+)"/);
      return match![1]!;
    });
    // Two distinct token URLs, no cross-leak of one invitee's token in the other's email.
    expect(new Set(urls).size).toBe(2);
    for (let i = 0; i < urls.length; i++) {
      for (let j = 0; j < urls.length; j++) {
        if (i === j) continue;
        expect(urls[i]).not.toContain(new URL(urls[j]!).searchParams.get("t"));
      }
    }
    for (const email of notification.sentPollEmails) {
      expect(["alice@example.com", "bob@example.com"]).toContain(email.to);
    }

    const invitees = await env.DB.prepare("SELECT id, email FROM poll_invitees WHERE poll_id = ?").bind(body.id).all<{ id: string; email: string }>();
    expect(invitees.results).toHaveLength(2);

    // Each URL's token verifies to the CORRECT invitee id for this poll.
    for (const url of urls) {
      const t = new URL(url).searchParams.get("t")!;
      const claims = await verifyCapabilityWithEnv(t, TEST_ENV);
      expect(claims?.purpose).toBe("poll-response");
      if (claims?.purpose === "poll-response") {
        expect(claims.pollId).toBe(body.id);
        expect(claims.subject).toBe(OWNER);
        const row = invitees.results!.find((r) => r.id === claims.inviteeId);
        expect(row).toBeDefined();
      }
    }
  });

  it("a transient send failure mid-loop doesn't fail poll creation — the organiser still gets the poll id/statusUrl", async () => {
    const notification = new FlakyNotificationProvider();
    notification.armFailure(2); // the 2nd of 3 invite sends throws
    const app = makeApp(notification);
    const res = await app.request(
      "/v1/polls",
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }, { email: "carol@example.com" }],
        }),
      },
      TEST_ENV,
    );

    // Create must still succeed — without this, the organiser never learns
    // the poll id/statusUrl (no list op to rediscover it), and a retry would
    // create a DUPLICATE poll and re-email everyone who already got one.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; statusUrl: string };
    expect(body.id).toMatch(/^p_/);
    expect(body.statusUrl).toContain(`/poll/${body.id}/status?t=`);

    // A send was attempted for all three invitees (2 succeeded, 1 threw) —
    // not just the ones before the failure.
    expect(notification.sentPollEmails).toHaveLength(2);
    const invitees = await env.DB.prepare("SELECT email FROM poll_invitees WHERE poll_id = ?").bind(body.id).all<{ email: string }>();
    expect(invitees.results).toHaveLength(3);
  });

  it("statusUrl carries a poll-status capability token so it opens directly for the organiser", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(VALID_BODY) },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; statusUrl: string };
    expect(body.statusUrl).toContain(`/poll/${body.id}/status?t=`);

    const token = new URL(body.statusUrl).searchParams.get("t")!;
    const claims = await verifyCapabilityWithEnv(token, TEST_ENV);
    expect(claims?.purpose).toBe("poll-status");
    if (claims?.purpose === "poll-status") {
      expect(claims.pollId).toBe(body.id);
      expect(claims.subject).toBe(OWNER);
    }
  });

  it("mints a guest link only when guestLink is true", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, guestLink: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { guestUrl?: string };
    expect(body.guestUrl).toMatch(/\?g=/);
  });

  it("rejects a malformed invitee email (zod)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, invitees: [{ email: "not-an-email" }] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("rejects more than 20 invitees (zod)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const invitees = Array.from({ length: 21 }, (_, i) => ({ email: `person${i}@example.com` }));
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, invitees }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate invitee email", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ ...VALID_BODY, invitees: [{ email: "alice@example.com" }, { email: "ALICE@example.com" }] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "duplicate_invitee" });
  });

  it("rejects a deadline after the range end", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, deadlineUtc: "2027-02-01T00:00:00Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_deadline" });
  });

  it("rejects in_person location with no detail", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, location: { kind: "in_person" } }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_location" });
  });

  it("accepts in_person location with a detail", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ ...VALID_BODY, location: { kind: "in_person", detail: "Room 4B" } }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
  });

  it("rejects a range spanning more than 6 weeks", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, rangeEnd: "2027-03-01" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_range" });
  });
});

type PollOverrides = Partial<Omit<typeof VALID_BODY, "invitees">> & { invitees?: { email: string; name?: string }[] };

async function createPoll(app: App, overrides: PollOverrides = {}): Promise<string> {
  const res = await app.request(
    "/v1/polls",
    { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ ...VALID_BODY, ...overrides }) },
    TEST_ENV,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("R4-H1: notificationProvider production wiring", () => {
  // Production never sets c.var.notificationProvider (only test middleware
  // does — see makeApp above); every real caller falls through to
  // defaultNotificationProvider(env, subject). Reproduce that exact wiring:
  // mount the routes with ONLY a calendar provider injected, so any
  // unguarded `c.var.notificationProvider` read is undefined, same as on a
  // real deploy.
  function makeAppNoNotificationProvider(): App {
    const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>({
      defaultHook: (result, c) => {
        if (!result.success) return c.json({ error: "validation_failed", issues: result.error.issues }, 400);
      },
    });
    mountMeetingPollRoutes(v1);
    const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("calendarProvider", new MockCalendarProvider());
      await next();
    });
    app.route("/v1", v1);
    return app;
  }

  const realFetch = globalThis.fetch;
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await env.GOOGLE_TOKEN_CACHE.delete(ACCESS_PREFIX + OWNER);
  });

  it("createMeetingPoll: falls back to defaultNotificationProvider and actually sends, instead of 500ing on an undefined provider", async () => {
    // Short-circuits getAccessToken's identity_tokens/refresh path entirely
    // (see auth/identity-store.ts) — this test is about the notification
    // PROVIDER fallback, not the OAuth token machinery.
    await env.GOOGLE_TOKEN_CACHE.put(ACCESS_PREFIX + OWNER, "fake-access-token");
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("gmail/v1/users/me/messages/send")) {
        sent.push(url);
        return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
      }
      throw new Error(`unexpected fetch in R4-H1 regression test: ${url}`);
    }) as typeof fetch;

    const app = makeAppNoNotificationProvider();
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(VALID_BODY) },
      TEST_ENV,
    );

    expect(res.status).toBe(201);
    // Both invitees' invite emails actually went out via the fallback provider.
    expect(sent).toHaveLength(2);
  });
});

describe("GET /v1/polls/:id (getMeetingPoll)", () => {
  it("returns full status with per-invitee detail and a score breakdown", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);

    const res = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      invitees: { email: string; responded: boolean }[];
      candidates: { slotStartUtc: string; score: number; organiserFit: number; weights: { inviteeId: string; weight: number }[] }[];
      intersection: { allIn: boolean; qualifyingCount: number };
    };
    expect(body.status).toBe("open");
    expect(body.invitees.map((i) => i.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    expect(body.invitees.every((i) => i.responded === false)).toBe(true);
    // Nobody has painted anything yet: no candidate qualifies for both invitees.
    expect(body.candidates).toEqual([]);
    expect(body.intersection).toEqual({ allIn: false, qualifyingCount: 0 });
  });

  it("candidate ranking reflects painted responses (T3 rankCandidates)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });

    const invitee = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ id: string }>();
    // Paint a Tuesday-morning slot free, wide enough to cover a 30-min booking.
    for (const cell of ["2027-01-05T09:00:00.000Z", "2027-01-05T09:30:00.000Z"]) {
      await env.DB.prepare("INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, 'free')").bind(invitee!.id, cell).run();
    }

    const res = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    const body = (await res.json()) as { candidates: { slotStartUtc: string; weights: { inviteeId: string; weight: number }[] }[]; intersection: { allIn: boolean } };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.candidates.some((c) => c.slotStartUtc === "2027-01-05T09:00:00.000Z")).toBe(true);
    const match = body.candidates.find((c) => c.slotStartUtc === "2027-01-05T09:00:00.000Z")!;
    expect(match.weights).toEqual([{ inviteeId: invitee!.id, weight: 1.0 }]);
  });

  it("returns 404 for a poll owned by another subject", async () => {
    await seedBearer("other-token", OTHER);
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(`/v1/polls/${pollId}`, { headers: { Authorization: "Bearer other-token" } }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown poll id", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request("/v1/polls/p_does-not-exist", { headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("L5: caps candidates at the top 20 by score, but qualifyingCount reports the total", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });
    const invitee = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ id: string }>();

    // Paint the first 3 days of the (wide-open, min_notice 0) range entirely
    // free at 30-min steps — comfortably more than 20 qualifying half-hour
    // starts for a 30-min poll.
    const cells: { id: string; c: string }[] = [];
    let t = Date.parse("2027-01-04T00:00:00Z");
    const end = Date.parse("2027-01-07T00:00:00Z");
    while (t < end) {
      cells.push({ id: invitee!.id, c: new Date(t).toISOString() });
      t += 30 * 60_000;
    }
    for (const { id, c } of cells) {
      await env.DB.prepare("INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, 'free')").bind(id, c).run();
    }

    const res = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[]; intersection: { qualifyingCount: number } };
    expect(body.candidates).toHaveLength(20);
    expect(body.intersection.qualifyingCount).toBeGreaterThan(20);
  });
});

describe("POST /v1/polls/:id/nudge (nudgeMeetingPoll)", () => {
  it("emails only non-dropped non-responders and reports progress", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }, { email: "carol@example.com" }] });
    notification.sentPollEmails.length = 0; // clear the invite sends

    const rows = await env.DB.prepare("SELECT id, email FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; email: string }>();
    const bob = rows.results!.find((r) => r.email === "bob@example.com")!;
    const carol = rows.results!.find((r) => r.email === "carol@example.com")!;
    await env.DB.prepare("UPDATE poll_invitees SET responded_at = ? WHERE id = ?").bind(new Date().toISOString(), bob.id).run();
    await env.DB.prepare("UPDATE poll_invitees SET dropped = 1 WHERE id = ?").bind(carol.id).run();

    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nudged: string[]; respondedCount: number; totalCount: number };
    expect(body.nudged).toEqual(["alice@example.com"]);
    // carol is dropped, so the required-set total excludes her.
    expect(body).toMatchObject({ respondedCount: 1, totalCount: 2 });
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe("alice@example.com");
  });

  it("409s on a cancelled poll without emailing or rotating any token", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });
    notification.sentPollEmails.length = 0; // clear the invite send

    const invitee = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ id: string; token_hash: string }>();
    await env.DB.prepare("UPDATE polls SET status = 'cancelled' WHERE id = ?").bind(pollId).run();

    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(409);
    expect(notification.sentPollEmails).toHaveLength(0);
    const after = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE id = ?").bind(invitee!.id).first<{ token_hash: string }>();
    expect(after!.token_hash).toBe(invitee!.token_hash); // the original invite link must still work
  });

  it("409s on an already-booked poll without emailing", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });
    notification.sentPollEmails.length = 0;
    await env.DB.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(pollId).run();

    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(409);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("409s on a needs_attention poll without emailing or rotating any token (decision D4 / M5)", async () => {
    // needs_attention is CLOSED to invitees (route.ts treats any non-open
    // status as closed) — a nudge link would open a dead page, and would
    // also rotate the invitee's token for nothing. The organiser's remedy is
    // resolveMeetingPoll (book/bookBest) or updateMeetingPoll
    // (deadlineUtc/removeInviteeIds), not nudge.
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });
    notification.sentPollEmails.length = 0;
    const invitee = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ id: string; token_hash: string }>();
    await env.DB.prepare("UPDATE polls SET status = 'needs_attention' WHERE id = ?").bind(pollId).run();

    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_status" });
    expect(notification.sentPollEmails).toHaveLength(0);
    const after = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE id = ?").bind(invitee!.id).first<{ token_hash: string }>();
    expect(after!.token_hash).toBe(invitee!.token_hash);
  });
});

describe("POST /v1/polls/:id/cancel (cancelMeetingPoll)", () => {
  it("cancels an open poll", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "cancelled" });
  });

  it("returns 409 cancelling an already-booked poll", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    await env.DB.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(pollId).run();
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(409);
  });

  it("emails every non-dropped invitee — invited and guest kinds, hidden included — but not a dropped invitee", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }] });
    notification.sentPollEmails.length = 0; // clear the invite sends

    const rows = await env.DB.prepare("SELECT id, email FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; email: string }>();
    const bob = rows.results!.find((r) => r.email === "bob@example.com")!;
    await env.DB.prepare("UPDATE poll_invitees SET dropped = 1 WHERE id = ?").bind(bob.id).run();

    const guest = await dbInsertInvitee(env.DB, {
      id: newInviteeId(),
      pollId,
      email: "guest@example.com",
      name: "Guest",
      kind: "guest",
      tokenHash: "hash-guest-cancel",
      pseudonym: "pseudo-guest-cancel",
      now: new Date().toISOString(),
    });

    const hidden = await dbInsertInvitee(env.DB, {
      id: newInviteeId(),
      pollId,
      email: "hidden@example.com",
      name: "Hidden",
      kind: "invited",
      tokenHash: "hash-hidden-cancel",
      pseudonym: "pseudo-hidden-cancel",
      now: new Date().toISOString(),
    });
    await setHideName(env.DB, hidden.id, true);

    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "cancelled" });

    // alice, guest, and hidden are notified — bob (dropped) is not. The
    // cancellation email is private per recipient (no BCC).
    expect(notification.sentPollEmails).toHaveLength(3);
    const recipients = notification.sentPollEmails.map((e) => e.to).sort();
    expect(recipients).toEqual(["alice@example.com", "guest@example.com", "hidden@example.com"]);
    for (const email of notification.sentPollEmails) {
      expect(email.subject).toContain("Cancelled:");
    }
  });

  it("logs a per-invitee send failure by invitee id only (never the email address) and still returns 200", async () => {
    const notification = new FlakyNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }] });
    notification.sentPollEmails.length = 0; // clear the invite sends
    notification.armFailure(1); // the 1st of 2 cancellation sends throws

    const invitees = await env.DB.prepare("SELECT id, email FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; email: string }>();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "cancelled" });

    // One send failed, one succeeded — a send failure never blocks cancel.
    expect(notification.sentPollEmails).toHaveLength(1);

    const loggedText = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(loggedText).toMatch(/invitee [^\s]+/);
    for (const inv of invitees.results!) {
      expect(loggedText).not.toContain(inv.email);
    }
    errSpy.mockRestore();
  });

  it("CASes the status write: a concurrent booking landing between the read and the write must not be clobbered, and no cancellation email must go out", async () => {
    // Simulates the real race: bookAtDeadline (or the all-in path) can flip
    // the poll to 'booked' via casSetBooked AFTER this handler's initial
    // getPollForSubject read but BEFORE its own status write lands. A DB
    // wrapper intercepts the handler's poll-status UPDATE (the only
    // "UPDATE polls SET status" statement this single request issues) and,
    // the first time it's seen, runs a real concurrent booking UPDATE
    // through the underlying D1 first — then lets the original statement
    // proceed against that now-changed row.
    function makeRacingDb(real: D1Database, pollId: string): D1Database {
      let intercepted = false;
      const wrap = (sql: string): D1PreparedStatement => {
        let boundArgs: unknown[] = [];
        const stmt = {
          bind: (...args: unknown[]) => {
            boundArgs = args;
            return stmt;
          },
          run: async () => {
            if (!intercepted && /UPDATE polls SET status/.test(sql)) {
              intercepted = true;
              await real.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(pollId).run();
            }
            return real.prepare(sql).bind(...boundArgs).run();
          },
          first: async (col?: string) => real.prepare(sql).bind(...boundArgs).first(col as never),
          all: async () => real.prepare(sql).bind(...boundArgs).all(),
        } as unknown as D1PreparedStatement;
        return stmt;
      };
      return { prepare: wrap } as unknown as D1Database;
    }

    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });
    notification.sentPollEmails.length = 0; // clear the invite send

    const racingEnv: Env = { ...TEST_ENV, DB: makeRacingDb(env.DB, pollId) };
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, racingEnv);

    expect(res.status).toBe(409);
    const row = await env.DB.prepare("SELECT status FROM polls WHERE id = ?").bind(pollId).first<{ status: string }>();
    expect(row!.status).toBe("booked"); // NOT clobbered to 'cancelled'
    expect(notification.sentPollEmails).toHaveLength(0); // no false "no meeting will be booked" broadcast
  });

  it("cancelling a needs_attention poll also notifies its invitees", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });
    notification.sentPollEmails.length = 0; // clear the invite send
    await env.DB.prepare("UPDATE polls SET status = 'needs_attention' WHERE id = ?").bind(pollId).run();

    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe("alice@example.com");
  });
});

describe("POST /v1/polls/:id/resolve (resolveMeetingPoll)", () => {
  it("book: validates the slot then delegates to the T9 booking engine", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);

    // Discover a real organiser-feasible slot via getMeetingPoll's candidates
    // is empty (nobody responded), so probe the raw grid directly instead:
    // pick a slot known to satisfy the wide-open test config.
    const slot = "2027-01-05T09:00:00.000Z";

    let calledWith: { pollId: string; slotStartUtc: string } | undefined;
    const stub: PollBookingEngine = {
      bookPollSlot: async (_env, id, slotStartUtc): Promise<BookOutcome> => {
        calledWith = { pollId: id, slotStartUtc };
        return { ok: true, eventId: "evt-1" };
      },
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    };
    __setPollBookingEngineForTests(stub);

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "book", slotStartUtc: slot }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; bookedSlotUtc: string; gcalEventId: string };
    expect(body).toMatchObject({ status: "booked", bookedSlotUtc: slot, gcalEventId: "evt-1" });
    expect(calledWith).toEqual({ pollId, slotStartUtc: slot });
  });

  it("book: accepts a millisecond-less rendering of a feasible slot, booking (and returning) the canonical feasible-list string", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);

    // Feasible list stores the canonical "...000Z" form; the caller sends an
    // equal instant without the milliseconds component.
    const canonical = "2027-01-05T09:00:00.000Z";
    const callerVariant = "2027-01-05T09:00:00Z";

    let calledWith: { pollId: string; slotStartUtc: string } | undefined;
    const stub: PollBookingEngine = {
      bookPollSlot: async (_env, id, slotStartUtc): Promise<BookOutcome> => {
        calledWith = { pollId: id, slotStartUtc };
        return { ok: true, eventId: "evt-1" };
      },
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    };
    __setPollBookingEngineForTests(stub);

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "book", slotStartUtc: callerVariant }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; bookedSlotUtc: string; gcalEventId: string };
    // Downstream (booking engine + response) must see the CANONICAL
    // feasible-list string, not the caller's variant rendering.
    expect(body).toMatchObject({ status: "booked", bookedSlotUtc: canonical, gcalEventId: "evt-1" });
    expect(calledWith).toEqual({ pollId, slotStartUtc: canonical });
  });

  it("book: an instant genuinely not in the feasible list still 400s invalid_slot (regression pin)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: true, eventId: "should-not-be-called" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });
    // One second off a real feasible slot — must not be treated as equal.
    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "book", slotStartUtc: "2027-01-05T09:00:01Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_slot");
  });

  it("book: a calendar failure while ranking candidates 502s (not 500s), leaving the poll unchanged", async () => {
    const notification = new MockNotificationProvider();
    const calendar = new MockCalendarProvider();
    calendar.fetchEventsInWindow = async () => {
      throw new Error("google down");
    };
    const app = makeApp(notification, calendar);
    const pollId = await createPoll(app);

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "book", slotStartUtc: "2027-01-05T09:00:00.000Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(502);

    const row = await env.DB.prepare("SELECT status, booked_slot_utc, gcal_event_id FROM polls WHERE id = ?").bind(pollId).first<{
      status: string;
      booked_slot_utc: string | null;
      gcal_event_id: string | null;
    }>();
    expect(row).toMatchObject({ status: "open", booked_slot_utc: null, gcal_event_id: null });
  });

  it("book: rejects a slot the organiser cannot actually offer", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: true, eventId: "should-not-be-called" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });
    // Outside the poll's range entirely.
    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "book", slotStartUtc: "2028-06-01T09:00:00Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("book: 409s when the booking engine can't claim it", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "slot_taken" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });
    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "book", slotStartUtc: "2027-01-05T09:00:00.000Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
  });

  it("bookBest: delegates to the T9 booking engine's bookBestNow and reports the booked slot", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);

    let calledWith: string | undefined;
    const stub: PollBookingEngine = {
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async (_env, id) => {
        calledWith = id;
        return { ok: true, slotStartUtc: "2027-01-05T09:00:00.000Z", eventId: "evt-best" };
      },
    };
    __setPollBookingEngineForTests(stub);

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; bookedSlotUtc: string; gcalEventId: string; deadlineUtc: string };
    expect(body).toMatchObject({ status: "booked", bookedSlotUtc: "2027-01-05T09:00:00.000Z", gcalEventId: "evt-best", deadlineUtc: DEADLINE });
    expect(calledWith).toBe(pollId);
  });

  it("bookBest: end-to-end with the real engine — books whoever has responded, pre-deadline", async () => {
    // The real engine (unlike the handler's own `book` action) resolves its
    // calendar/notification providers through booking.ts's own __setForTests
    // seam, not c.var.calendarProvider — see booking.ts's "Test injection"
    // comment for why that indirection exists.
    __setForTests({ calendar: new MockCalendarProvider(), notification: new MockNotificationProvider(), now: () => new Date() });
    try {
      const app = makeApp(new MockNotificationProvider());
      const pollId = await createPoll(app);
      const invitees = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string }>();
      const responder = invitees.results![0]!.id;
      await replaceResponses(env.DB, responder, [{ cellStartUtc: "2027-01-05T09:00:00.000Z", state: "free" }]);
      await env.DB.prepare("UPDATE poll_invitees SET responded_at = ? WHERE id = ?").bind(new Date().toISOString(), responder).run();

      const res = await app.request(
        `/v1/polls/${pollId}/resolve`,
        { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
        TEST_ENV,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; bookedSlotUtc: string | null; gcalEventId: string | null };
      expect(body.status).toBe("booked");
      expect(body.bookedSlotUtc).toBeTruthy();
      expect(body.gcalEventId).toBeTruthy();

      const row = await env.DB.prepare("SELECT status FROM polls WHERE id = ?").bind(pollId).first<{ status: string }>();
      expect(row!.status).toBe("booked");
    } finally {
      __setForTests(null);
    }
  });

  it("bookBest: 400 no_responders when nobody has responded yet, poll left open", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_responders");

    const row = await env.DB.prepare("SELECT status FROM polls WHERE id = ?").bind(pollId).first<{ status: string }>();
    expect(row!.status).toBe("open");
  });

  it("bookBest: 409 book_failed/no_qualifying_slot when the engine finds nothing bookable, poll stays open (no escalation)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "no_qualifying_slot" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body).toMatchObject({ error: "book_failed", detail: "no_qualifying_slot" });

    const row = await env.DB.prepare("SELECT status FROM polls WHERE id = ?").bind(pollId).first<{ status: string }>();
    expect(row!.status).toBe("open");
  });

  it("bookBest: 502 calendar_unavailable when the engine can't reach the calendar", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "calendar_unavailable" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("calendar_unavailable");
  });

  it("bookBest: 409 invalid_status on an already-booked poll (top-of-handler pre-check, engine never called)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    await env.DB.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(pollId).run();
    let engineCalled = false;
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => {
        engineCalled = true;
        return { ok: false, reason: "poll_not_actionable" };
      },
    });

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_status");
    expect(engineCalled).toBe(false);
  });

  it("bookBest: 404 not_found when the engine reports poll_not_found (race past the top-of-handler pre-check)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {},
      bookBestNow: async () => ({ ok: false, reason: "poll_not_found" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 409 for any action once the poll is booked", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    await env.DB.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(pollId).run();
    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for a poll owned by another subject", async () => {
    await seedBearer("other-token", OTHER);
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      {
        method: "POST",
        headers: { Authorization: "Bearer other-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "bookBest" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("Card C resolve slimming: extendDeadline/dropInvitee are no longer valid resolve actions (400 zod rejection)", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);

    const extend = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "extendDeadline", deadlineUtc: "2027-01-20T00:00:00Z" }) },
      TEST_ENV,
    );
    expect(extend.status).toBe(400);

    const invitees = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string }>();
    const drop = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "dropInvitee", inviteeId: invitees.results![0]!.id }) },
      TEST_ENV,
    );
    expect(drop.status).toBe(400);
  });
});

const FIX3_NOW = new Date("2027-01-01T00:00:00Z");

describe("updateMeetingPoll deadlineUtc — episode stamps (Fix 3, ported from resolveMeetingPoll extendDeadline)", () => {
  afterEach(() => {
    __setForTests(null);
  });

  it("clears escalated_at/nudged_final_at/nudged_midpoint_at so a second failure escalates again", async () => {
    const cal = new MockCalendarProvider();
    const notification = new MockNotificationProvider();
    // bookAtDeadline re-checks the fresh deadline itself, so the pinned clock
    // must be advanced to each episode's deadline before calling it directly.
    let clock = FIX3_NOW;
    __setForTests({ calendar: cal, notification, now: () => clock });

    const poll = await dbCreatePoll(env.DB, {
      subject: OWNER,
      title: "Fix 3 escalation",
      durationMin: 30,
      rangeStart: "2027-01-01",
      rangeEnd: "2027-01-31",
      deadlineUtc: "2027-01-02T00:00:00Z",
      location: { kind: "meet" },
      guestTokenHash: null,
      now: FIX3_NOW.toISOString(),
    });
    await dbInsertInvitee(env.DB, {
      id: newInviteeId(),
      pollId: poll.id,
      email: "alice@example.com",
      name: "Alice",
      kind: "invited",
      tokenHash: "hash-alice-f3a",
      pseudonym: "pseudo-alice-f3a",
      now: FIX3_NOW.toISOString(),
    });

    // Episode 1: nobody has responded, so bookAtDeadline can only escalate.
    clock = new Date("2027-01-02T00:00:00Z");
    await bookAtDeadline(TEST_ENV, poll.id);
    expect(notification.sentPollEmails).toHaveLength(1);
    let row = await env.DB
      .prepare("SELECT status, escalated_at FROM polls WHERE id = ?")
      .bind(poll.id)
      .first<{ status: string; escalated_at: string | null }>();
    expect(row!.status).toBe("needs_attention");
    expect(row!.escalated_at).not.toBeNull();

    // Organiser extends the deadline via the REAL HTTP handler (now
    // updateMeetingPoll, not resolveMeetingPoll's extendDeadline) — a SHORT
    // extension (well under the 7-day midpoint threshold), so a pass can't
    // be an accident of the midpoint cadence reviving instead of the fix.
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      `/v1/polls/${poll.id}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ deadlineUtc: "2027-01-03T00:00:00Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    row = (await env.DB
      .prepare("SELECT status, escalated_at, nudged_midpoint_at, nudged_final_at FROM polls WHERE id = ?")
      .bind(poll.id)
      .first()) as any;
    expect(row).toMatchObject({ status: "open", escalated_at: null, nudged_midpoint_at: null, nudged_final_at: null });

    // Episode 2: still nobody responds — the organiser must be told again.
    clock = new Date("2027-01-03T00:00:00Z");
    await bookAtDeadline(TEST_ENV, poll.id);
    const after = await env.DB.prepare("SELECT status FROM polls WHERE id = ?").bind(poll.id).first<{ status: string }>();
    expect(after!.status).toBe("needs_attention");
    expect(notification.sentPollEmails).toHaveLength(2); // organiser told twice
  });

  it("re-arms the deadline-24h nudge cadence after a short extension", async () => {
    await upsertUser(env.DB, OWNER);
    const notification = new MockNotificationProvider();

    // Created well before the original deadline-24h boundary (unlike
    // FIX3_NOW, which sits exactly ON it) — a poll born inside the 24h lead
    // never final-nudges at all (born-inside-the-window suppression), so
    // this fixture needs real pre-window age for sweep 1 to have anything to
    // re-arm.
    const created = new Date("2026-12-30T00:00:00Z");

    const poll = await dbCreatePoll(env.DB, {
      subject: OWNER,
      title: "Fix 3 nudge",
      durationMin: 30,
      rangeStart: "2027-01-01",
      rangeEnd: "2027-01-31",
      deadlineUtc: "2027-01-02T00:00:00Z",
      location: { kind: "meet" },
      guestTokenHash: null,
      now: created.toISOString(),
    });
    await dbInsertInvitee(env.DB, {
      id: newInviteeId(),
      pollId: poll.id,
      email: "alice@example.com",
      name: "Alice",
      kind: "invited",
      tokenHash: "hash-alice-f3b",
      pseudonym: "pseudo-alice-f3b",
      now: created.toISOString(),
    });

    // Sweep 1, 24h before the original deadline: final nudge fires + stamps.
    // This poll's lifetime (3 days) is well under the 7-day midpoint
    // threshold, so only the final-nudge cadence is in play here.
    await runPollSweep(TEST_ENV, new Date("2027-01-01T00:30:00Z"), {
      bookAtDeadline: async () => {},
      makeNotification: () => notification,
    });
    expect(notification.sentPollEmails).toHaveLength(1);

    // Organiser extends the deadline by 3 days via the REAL HTTP handler (now
    // updateMeetingPoll) — the new lifetime-from-creation (6 days) is STILL
    // under the 7-day midpoint threshold, so a second email here can only be
    // the deadline-24h cadence firing again, not the midpoint cadence being
    // revived instead.
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      `/v1/polls/${poll.id}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ deadlineUtc: "2027-01-05T00:00:00Z" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    // Sweep 2, 24h before the NEW deadline.
    await runPollSweep(TEST_ENV, new Date("2027-01-04T00:30:00Z"), {
      bookAtDeadline: async () => {},
      makeNotification: () => notification,
    });

    expect(notification.sentPollEmails).toHaveLength(2);
  });
});

describe("getMeetingPoll fit-curve unification (Fix 7)", () => {
  it("ranks with the booking engine's curve (resolveMeetingFitCurve), which now applies the per-context merge", async () => {
    // Give OWNER its own config_contexts rows WITHOUT a 'meeting' row among
    // them. Under the per-user cost-curve customisation change, BOTH the
    // display ranking and the booking engine resolve this via the
    // per-context merge (db/context-config.ts): own row per context, else
    // '__default__' — so a subject who customised only 'admin' still gets
    // the default 'meeting' curve (peak 10:00-11:00, seeded by migration
    // 0005), NOT the FLAT_CURVE the old own-wholesale-or-default policy
    // produced (and which this test used to pin). The invariant pinned here
    // is unchanged: the fit shown to the organiser is exactly the fit the
    // booking engine ranks/books with.
    await env.DB
      .prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES (?, 'admin', ?)")
      .bind(
        OWNER,
        JSON.stringify({
          context: "admin",
          fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "18:00" },
          max_minutes_per_day: null,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 0,
          over_streak_cap_penalty_per_15min: 0,
        }),
      )
      .run();

    // The booking engine resolves the merged default 'meeting' curve — not
    // FLAT_CURVE — for this partially-customised subject.
    const curve = await resolveMeetingFitCurve(env.DB, OWNER);
    expect(curve).toEqual({ peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" });

    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }] });

    const invitee = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ id: string }>();
    // 09:00 UTC sits outside the curve's 10:00-11:00 local peak, so the real
    // curve scores it below FLAT_CURVE's flat 1.0 — proving which curve is
    // in play.
    for (const cell of ["2027-01-05T09:00:00.000Z", "2027-01-05T09:30:00.000Z"]) {
      await env.DB.prepare("INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, 'free')").bind(invitee!.id, cell).run();
    }

    const res = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: { slotStartUtc: string; organiserFit: number }[] };
    const match = body.candidates.find((c) => c.slotStartUtc === "2027-01-05T09:00:00.000Z");
    expect(match).toBeDefined();
    // Unification: the displayed fit equals the booking engine's own scoring
    // of the same slot (same curve, duration, tz as the handler uses).
    const tz = await getHomeTz(env.DB, OWNER, TEST_ENV.SCHEDULER_TZ);
    expect(match!.organiserFit).toBe(organiserFit(curve, "2027-01-05T09:00:00.000Z", 30, tz));
    expect(match!.organiserFit).toBeLessThan(1); // the merged curve, not FLAT_CURVE
  });
});

describe("MEETING_POLL_ENABLED gate", () => {
  it("all six ops return 401 with no bearer token", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const noAuth = { "content-type": "application/json" };

    const get = await app.request(`/v1/polls/${pollId}`, {}, TEST_ENV);
    expect(get.status).toBe(401);
    const create = await app.request("/v1/polls", { method: "POST", headers: noAuth, body: JSON.stringify(VALID_BODY) }, TEST_ENV);
    expect(create.status).toBe(401);
    const nudge = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST" }, TEST_ENV);
    expect(nudge.status).toBe(401);
    const cancel = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST" }, TEST_ENV);
    expect(cancel.status).toBe(401);
    const resolve = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: noAuth, body: JSON.stringify({ action: "bookBest" }) },
      TEST_ENV,
    );
    expect(resolve.status).toBe(401);
    const update = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: noAuth, body: JSON.stringify({ title: "New title" }) },
      TEST_ENV,
    );
    expect(update.status).toBe(401);
  });


  it("createMeetingPoll: 403 feature_disabled when the flag is off", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request(
      "/v1/polls",
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(VALID_BODY) },
      FLAG_OFF_ENV,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "feature_disabled" });
  });

  it("getMeetingPoll: 403 feature_disabled when the flag is off", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, FLAG_OFF_ENV);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "feature_disabled" });
  });

  it("nudgeMeetingPoll: 403 feature_disabled when the flag is off", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, FLAG_OFF_ENV);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "feature_disabled" });
  });

  it("cancelMeetingPoll: 403 feature_disabled when the flag is off", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, FLAG_OFF_ENV);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "feature_disabled" });
  });

  it("resolveMeetingPoll: 403 feature_disabled when the flag is off", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(
      `/v1/polls/${pollId}/resolve`,
      { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ action: "bookBest" }) },
      FLAG_OFF_ENV,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "feature_disabled" });
  });

  it("updateMeetingPoll: 403 feature_disabled when the flag is off", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "New title" }) },
      FLAG_OFF_ENV,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "feature_disabled" });
  });

  it("gate runs before a downstream not_found would matter", async () => {
    const app = makeApp(new MockNotificationProvider());
    const res = await app.request("/v1/polls/p_nope", { headers: AUTH }, FLAG_OFF_ENV);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /v1/polls/:id (updateMeetingPoll)", () => {
  it("1. empty body -> 400 no_changes", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({}) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_changes" });
  });

  it("2. 404 on unknown poll id; 409 invalid_status on booked/cancelled", async () => {
    const app = makeApp(new MockNotificationProvider());

    const notFound = await app.request(
      `/v1/polls/p_does-not-exist`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "New title" }) },
      TEST_ENV,
    );
    expect(notFound.status).toBe(404);

    const bookedId = await createPoll(app);
    await env.DB.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(bookedId).run();
    const bookedRes = await app.request(
      `/v1/polls/${bookedId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "New title" }) },
      TEST_ENV,
    );
    expect(bookedRes.status).toBe(409);
    expect((await bookedRes.json()) as { error: string }).toMatchObject({ error: "invalid_status" });

    const cancelledId = await createPoll(app);
    await env.DB.prepare("UPDATE polls SET status = 'cancelled' WHERE id = ?").bind(cancelledId).run();
    const cancelledRes = await app.request(
      `/v1/polls/${cancelledId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "New title" }) },
      TEST_ENV,
    );
    expect(cancelledRes.status).toBe(409);
  });

  it("3. location change persists, sends zero emails; invalid location 400s, nothing written", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app);
    notification.sentPollEmails.length = 0; // clear invite sends

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ location: { kind: "in_person", detail: "Room 4B" } }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { location: { kind: string; detail: string | null } };
    expect(body.location).toEqual({ kind: "in_person", detail: "Room 4B" });
    expect(notification.sentPollEmails).toHaveLength(0);

    const get1 = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    const getBody1 = (await get1.json()) as { location: { kind: string; detail: string | null } };
    expect(getBody1.location).toEqual({ kind: "in_person", detail: "Room 4B" });

    // Invalid: missing detail for phone.
    const invalid1 = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ location: { kind: "phone" } }) },
      TEST_ENV,
    );
    expect(invalid1.status).toBe(400);
    expect((await invalid1.json()) as { error: string }).toMatchObject({ error: "invalid_location" });

    // Invalid: detail on meet.
    const invalid2 = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ location: { kind: "meet", detail: "should not be here" } }) },
      TEST_ENV,
    );
    expect(invalid2.status).toBe(400);

    // Invalid: unknown kind.
    const invalid3 = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ location: { kind: "carrier_pigeon" } }) },
      TEST_ENV,
    );
    expect(invalid3.status).toBe(400);

    // Invalid: over-length detail.
    const invalid4 = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ location: { kind: "custom", detail: "x".repeat(201) } }) },
      TEST_ENV,
    );
    expect(invalid4.status).toBe(400);

    // Nothing was written by any of the failed attempts.
    const after = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    const afterBody = (await after.json()) as { location: { kind: string; detail: string | null } };
    expect(afterBody.location).toEqual({ kind: "in_person", detail: "Room 4B" });
  });

  it("4. title change persists, zero emails", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app);
    notification.sentPollEmails.length = 0;

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "Renamed sync" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Renamed sync");
    expect(notification.sentPollEmails).toHaveLength(0);

    const get = await app.request(`/v1/polls/${pollId}`, { headers: AUTH }, TEST_ENV);
    const getBody = (await get.json()) as { title: string };
    expect(getBody.title).toBe("Renamed sync");
  });

  it("5. addInvitees inserts fresh pseudonyms+tokens; only new invitees emailed; existing tokens untouched", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    notification.sentPollEmails.length = 0;

    const before = await env.DB.prepare("SELECT id, email, token_hash, pseudonym FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; email: string; token_hash: string; pseudonym: string }>();

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: [{ email: "carol@example.com", name: "Carol" }] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe("carol@example.com");

    const after = await env.DB.prepare("SELECT id, email, token_hash, pseudonym FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; email: string; token_hash: string; pseudonym: string }>();
    expect(after.results).toHaveLength(3);
    const carol = after.results!.find((r) => r.email === "carol@example.com")!;
    expect(carol).toBeDefined();
    expect(before.results!.some((r) => r.pseudonym === carol.pseudonym)).toBe(false);

    // Existing invitees' token_hash values are byte-identical before/after.
    for (const b of before.results!) {
      const a = after.results!.find((r) => r.id === b.id)!;
      expect(a.token_hash).toBe(b.token_hash);
    }
  });

  it("5b. the taken-set is seeded from the whole current roster: adding 18 invitees to a 2-invitee poll yields 20 pairwise-distinct pseudonyms", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app); // alice + bob (2 pseudonyms already taken)

    const newInvitees = Array.from({ length: 18 }, (_, i) => ({ email: `person${i}@example.com` }));
    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: newInvitees }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    const rows = await env.DB.prepare("SELECT pseudonym FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ pseudonym: string }>();
    expect(rows.results).toHaveLength(20);
    const pseudonyms = rows.results!.map((r) => r.pseudonym);
    expect(new Set(pseudonyms).size).toBe(20); // pairwise distinct — no collision with alice/bob or each other
  });

  it("6. duplicate/in-batch-duplicate/too-many-invitees all 400 with nothing written", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app); // alice + bob

    // Existing non-dropped email.
    const dup = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: [{ email: "alice@example.com" }] }) },
      TEST_ENV,
    );
    expect(dup.status).toBe(400);
    expect((await dup.json()) as { error: string }).toMatchObject({ error: "duplicate_invitee" });

    // In-batch duplicate.
    const batchDup = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: [{ email: "carol@example.com" }, { email: "CAROL@example.com" }] }) },
      TEST_ENV,
    );
    expect(batchDup.status).toBe(400);
    expect((await batchDup.json()) as { error: string }).toMatchObject({ error: "duplicate_invitee" });

    // Pushes the non-dropped count past 20 (2 existing + 19 new = 21).
    const tooMany = Array.from({ length: 19 }, (_, i) => ({ email: `person${i}@example.com` }));
    const overCap = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: tooMany }) },
      TEST_ENV,
    );
    expect(overCap.status).toBe(400);
    expect((await overCap.json()) as { error: string }).toMatchObject({ error: "too_many_invitees" });

    // Nothing was written by any of the failed attempts.
    const rows = await env.DB.prepare("SELECT email FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ email: string }>();
    expect(rows.results!.map((r) => r.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("6b. validate-first across arms: a duplicate_invitee failure in addInvitees leaves an UNRELATED removeInviteeIds arm entirely unapplied", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app); // alice + bob
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();

    // alice is an existing non-dropped invitee and is NOT one of the ids
    // being removed — this must 400 as a plain duplicate, and the removal
    // of bob (a completely different, otherwise-valid part of the same
    // body) must not have been applied either, since validation runs for
    // every field before any write.
    const res = await app.request(
      `/v1/polls/${pollId}`,
      {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ removeInviteeIds: [bob!.id], addInvitees: [{ email: "alice@example.com" }] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "duplicate_invitee" });

    const bobRow = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE id = ?").bind(bob!.id).first<{ dropped: number }>();
    expect(bobRow!.dropped).toBe(0); // bob still NOT dropped
  });

  it("7. adding a dropped invitee's email restores that row: same id, rotated token, painted cells retained, one invite email", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    const bob = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string; token_hash: string }>();
    await replaceResponses(env.DB, bob!.id, [{ cellStartUtc: "2027-01-05T09:00:00.000Z", state: "free" }]);
    await dbDropInvitee(env.DB, bob!.id);
    notification.sentPollEmails.length = 0;

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: [{ email: "bob@example.com", name: "Bob Renamed" }] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invitees: { id: string; email: string; name: string | null; dropped: boolean }[] };
    const restored = body.invitees.find((i) => i.email === "bob@example.com")!;
    expect(restored.id).toBe(bob!.id); // same row, not a new one
    expect(restored.dropped).toBe(false);
    expect(restored.name).toBe("Bob Renamed"); // a supplied name updates the stored name

    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe("bob@example.com");

    // A FRESH token was minted and stored: the invite email's own link
    // verifies to bob's invitee id, and its hash matches what's now stored
    // (not left as some stale, unrelated hash) — a stronger and less
    // timing-fragile proof of rotation than a byte-inequality check against
    // the pre-drop hash (the token signer is deterministic at 1s
    // granularity keyed on (pollId, inviteeId, subject, deadlineUtc), which
    // is unchanged here, so two mints within the same wall-clock second
    // could coincidentally collide).
    const url = notification.sentPollEmails[0]!.html.match(/href="([^"]+)"/)![1]!;
    const emailedToken = new URL(url).searchParams.get("t")!;
    const claims = await verifyCapabilityWithEnv(emailedToken, TEST_ENV);
    expect(claims?.purpose).toBe("poll-response");
    if (claims?.purpose === "poll-response") expect(claims.inviteeId).toBe(bob!.id);
    const emailedHash = await hashToken(emailedToken, hashingKey(TEST_ENV));
    const after = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE id = ?").bind(bob!.id).first<{ token_hash: string }>();
    expect(after!.token_hash).toBe(emailedHash);

    const cells = await env.DB.prepare("SELECT cell_start_utc FROM poll_responses WHERE invitee_id = ?").bind(bob!.id).all<{ cell_start_utc: string }>();
    expect(cells.results).toHaveLength(1); // painted cells retained

    // Restoring WITHOUT a name (omitted) keeps the existing name rather than
    // clearing it — only a SUPPLIED name overwrites.
    await dbDropInvitee(env.DB, bob!.id);
    const res2 = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ addInvitees: [{ email: "bob@example.com" }] }) },
      TEST_ENV,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { invitees: { email: string; name: string | null }[] };
    const restored2 = body2.invitees.find((i) => i.email === "bob@example.com")!;
    expect(restored2.name).toBe("Bob Renamed"); // kept, not cleared to null
  });

  it("8. removeInviteeIds drops the row and emails ONE removal notice; unknown id 404s; already-dropped id is a no-op", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();
    notification.sentPollEmails.length = 0;

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ removeInviteeIds: [bob!.id] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe("bob@example.com");
    expect(notification.sentPollEmails[0]!.subject).toContain("Removed:");

    const row = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE id = ?").bind(bob!.id).first<{ dropped: number }>();
    expect(row!.dropped).toBe(1);

    // Unknown id.
    const unknown = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ removeInviteeIds: ["pi_does-not-exist"] }) },
      TEST_ENV,
    );
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as { error: string }).toMatchObject({ error: "invitee_not_found" });

    // Already-dropped id: idempotent no-op, no email.
    notification.sentPollEmails.length = 0;
    const again = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ removeInviteeIds: [bob!.id] }) },
      TEST_ENV,
    );
    expect(again.status).toBe(200);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("8b. a duplicate id within removeInviteeIds emails the removal notice exactly once and fires the engine exactly once", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();
    notification.sentPollEmails.length = 0;

    let calls = 0;
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {
        calls += 1;
      },
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ removeInviteeIds: [bob!.id, bob!.id] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(notification.sentPollEmails).toHaveLength(1); // not twice
    expect(notification.sentPollEmails[0]!.to).toBe("bob@example.com");
    expect(calls).toBe(1); // not twice

    const row = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE id = ?").bind(bob!.id).first<{ dropped: number }>();
    expect(row!.dropped).toBe(1);
  });

  it("9. a remove fires ONE maybeBookOnAllIn (engine failure is non-fatal); response reflects the re-read booking", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();

    let calls = 0;
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async (_env, id) => {
        calls += 1;
        await env.DB.prepare("UPDATE polls SET status = 'booked', booked_slot_utc = ?, gcal_event_id = ? WHERE id = ?").bind("2027-01-05T09:00:00.000Z", "evt-patch-1", id).run();
      },
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ removeInviteeIds: [bob!.id] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    const body = (await res.json()) as { status: string; bookedSlotUtc: string | null; gcalEventId: string | null };
    expect(body).toMatchObject({ status: "booked", bookedSlotUtc: "2027-01-05T09:00:00.000Z", gcalEventId: "evt-patch-1" });
  });

  it("9b. maybeBookOnAllIn failure doesn't fail the PATCH", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();

    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {
        throw new Error("calendar unreachable");
      },
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ removeInviteeIds: [bob!.id] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("removing an invitee then re-adding them by email in the same call is a re-invite, not a remove-then-invite (only ONE email, the invite)", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    const bob = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string; token_hash: string }>();
    notification.sentPollEmails.length = 0;

    const res = await app.request(
      `/v1/polls/${pollId}`,
      {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ removeInviteeIds: [bob!.id], addInvitees: [{ email: "bob@example.com" }] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    // Only the invite email — no separate "you've been removed" notice for
    // someone whose net effect in this call is that they're still invited.
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.subject).not.toContain("Removed:");
    expect(notification.sentPollEmails[0]!.to).toBe("bob@example.com");

    const row = await env.DB.prepare("SELECT id, dropped, token_hash FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string; dropped: number; token_hash: string }>();
    expect(row!.id).toBe(bob!.id);
    expect(row!.dropped).toBe(0);

    // A fresh token was minted and stored (see test 7's comment on why this
    // checks the emailed token's hash against storage rather than a raw
    // byte-inequality against the pre-call hash).
    const url = notification.sentPollEmails[0]!.html.match(/href="([^"]+)"/)![1]!;
    const emailedToken = new URL(url).searchParams.get("t")!;
    const emailedHash = await hashToken(emailedToken, hashingKey(TEST_ENV));
    expect(row!.token_hash).toBe(emailedHash);
  });

  it("10. deadlineUtc: non-later 400s; past-rangeEnd 400s; success rotates+emails every non-dropped invitee, reopens needs_attention, clears episode stamps", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, { invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }, { email: "carol@example.com" }] });
    notification.sentPollEmails.length = 0;

    const rows = await env.DB.prepare("SELECT id, email, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; email: string; token_hash: string }>();
    const alice = rows.results!.find((r) => r.email === "alice@example.com")!;
    const carol = rows.results!.find((r) => r.email === "carol@example.com")!;
    await env.DB.prepare("UPDATE poll_invitees SET responded_at = ? WHERE id = ?").bind(new Date().toISOString(), alice.id).run();
    await env.DB.prepare("UPDATE poll_invitees SET dropped = 1 WHERE id = ?").bind(carol.id).run();
    await env.DB.prepare("UPDATE polls SET status = 'needs_attention' WHERE id = ?").bind(pollId).run();

    // Non-later.
    const nonLater = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ deadlineUtc: DEADLINE }) },
      TEST_ENV,
    );
    expect(nonLater.status).toBe(400);

    // Past rangeEnd.
    const pastRangeEnd = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ deadlineUtc: "2027-02-01T00:00:00Z" }) },
      TEST_ENV,
    );
    expect(pastRangeEnd.status).toBe(400);
    expect((await pastRangeEnd.json()) as { error: string }).toMatchObject({ error: "invalid_deadline" });
    const unchangedRow = await env.DB.prepare("SELECT deadline_utc FROM polls WHERE id = ?").bind(pollId).first<{ deadline_utc: string }>();
    expect(unchangedRow!.deadline_utc).toBe(DEADLINE); // unchanged by the rejected attempt

    const newDeadline = "2027-01-14T12:00:00Z";
    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ deadlineUtc: newDeadline }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; deadlineUtc: string };
    expect(body).toMatchObject({ status: "open", deadlineUtc: newDeadline });

    const row = await env.DB.prepare("SELECT status, deadline_utc, escalated_at, nudged_midpoint_at, nudged_final_at FROM polls WHERE id = ?").bind(pollId).first<{
      status: string; deadline_utc: string; escalated_at: string | null; nudged_midpoint_at: string | null; nudged_final_at: string | null;
    }>();
    expect(row).toMatchObject({ status: "open", deadline_utc: newDeadline, escalated_at: null, nudged_midpoint_at: null, nudged_final_at: null });

    // Emailed alice + bob (non-dropped), not carol (dropped).
    const notifiedTo = notification.sentPollEmails.map((e) => e.to).sort();
    expect(notifiedTo).toEqual(["alice@example.com", "bob@example.com"]);

    // Tokens rotated for both notified invitees; carol's untouched.
    const after = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; token_hash: string }>();
    const afterAlice = after.results!.find((r) => r.id === alice.id)!;
    const afterCarol = after.results!.find((r) => r.id === carol.id)!;
    expect(afterAlice.token_hash).not.toBe(alice.token_hash);
    expect(afterCarol.token_hash).toBe(carol.token_hash);
  });

  it("10b. R1-F4 (ported from resolveMeetingPoll extendDeadline): a transient send failure mid-loop doesn't fail the PATCH, and a retry path (nudge) exists", async () => {
    const notification = new FlakyNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app, {
      invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }, { email: "carol@example.com" }],
    });
    notification.sentPollEmails.length = 0; // clear the 3 invite sends
    // Fail on the SECOND deadline-extended send (bob, alphabetically) — a
    // realistic "transient hiccup mid-loop", not the first or last invitee.
    notification.armFailure(2);

    const before = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; token_hash: string }>();

    const newDeadline = "2027-01-14T12:00:00Z";
    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ deadlineUtc: newDeadline }) },
      TEST_ENV,
    );

    // The PATCH itself must succeed even though one invitee's send failed —
    // the deadline/status/episode-stamp writes already committed before the
    // email loop runs, and a retry is refused (deadlineUtc must be strictly
    // later), so throwing here would leave the poll half-notified with no
    // way back.
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, deadline_utc FROM polls WHERE id = ?").bind(pollId).first<{ status: string; deadline_utc: string }>();
    expect(row).toMatchObject({ status: "open", deadline_utc: newDeadline });

    // Every non-dropped invitee's token is rotated regardless of send outcome
    // — rotation isn't gated on the (best-effort) email succeeding.
    const after = await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ id: string; token_hash: string }>();
    for (const b of before.results!) {
      const a = after.results!.find((r) => r.id === b.id)!;
      expect(a.token_hash).not.toBe(b.token_hash);
    }
    // 2 of 3 sends succeeded (the one in the middle failed).
    expect(notification.sentPollEmails).toHaveLength(2);

    // Retry path: the poll is still open, so a manual nudge — which re-issues
    // + re-sends to non-responders — is how the organiser recovers the
    // invitee whose deadline-extended email failed above.
    const nudgeRes = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(nudgeRes.status).toBe(200);
  });

  it("11. CAS regression: 409s when a concurrent booking lands between the read and the deadline write", async () => {
    function makeRacingDb(real: D1Database, pollId: string): D1Database {
      let intercepted = false;
      const wrap = (sql: string): D1PreparedStatement => {
        let boundArgs: unknown[] = [];
        const stmt = {
          bind: (...args: unknown[]) => {
            boundArgs = args;
            return stmt;
          },
          run: async () => {
            if (!intercepted && /UPDATE polls SET status/.test(sql)) {
              intercepted = true;
              await real.prepare("UPDATE polls SET status = 'booked' WHERE id = ?").bind(pollId).run();
            }
            return real.prepare(sql).bind(...boundArgs).run();
          },
          first: async (col?: string) => real.prepare(sql).bind(...boundArgs).first(col as never),
          all: async () => real.prepare(sql).bind(...boundArgs).all(),
        } as unknown as D1PreparedStatement;
        return stmt;
      };
      return { prepare: wrap } as unknown as D1Database;
    }

    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();
    notification.sentPollEmails.length = 0;

    // A combined body: if the CAS check ran anywhere other than FIRST in the
    // apply phase, a 409 here would still leave the title changed, bob
    // dropped, and/or carol inserted — a renamed, mutated poll masquerading
    // as an aborted request. The CAS must be the very first write, so a 409
    // leaves EVERY field exactly as it was.
    const racingEnv: Env = { ...TEST_ENV, DB: makeRacingDb(env.DB, pollId) };
    const res = await app.request(
      `/v1/polls/${pollId}`,
      {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          deadlineUtc: "2027-01-14T12:00:00Z",
          title: "Renamed under a race",
          removeInviteeIds: [bob!.id],
          addInvitees: [{ email: "carol@example.com" }],
        }),
      },
      racingEnv,
    );
    expect(res.status).toBe(409);

    const row = await env.DB
      .prepare("SELECT status, title, deadline_utc FROM polls WHERE id = ?")
      .bind(pollId)
      .first<{ status: string; title: string; deadline_utc: string }>();
    expect(row!.status).toBe("booked"); // not clobbered
    expect(row!.title).toBe(VALID_BODY.title); // NOT renamed
    expect(row!.deadline_utc).toBe(DEADLINE); // NOT changed

    const bobRow = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE id = ?").bind(bob!.id).first<{ dropped: number }>();
    expect(bobRow!.dropped).toBe(0); // NOT dropped

    const allInvitees = await env.DB.prepare("SELECT email FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ email: string }>();
    expect(allInvitees.results!.map((r) => r.email).sort()).toEqual(["alice@example.com", "bob@example.com"]); // carol NOT inserted

    expect(notification.sentPollEmails).toHaveLength(0); // zero emails
  });

  it("12. deadline + add in one call: the added invitee gets ONE email (invite); pre-existing get deadline-extended; nobody gets two", async () => {
    const notification = new MockNotificationProvider();
    const app = makeApp(notification);
    const pollId = await createPoll(app); // alice + bob
    notification.sentPollEmails.length = 0;

    const newDeadline = "2027-01-14T12:00:00Z";
    const res = await app.request(
      `/v1/polls/${pollId}`,
      {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ deadlineUtc: newDeadline, addInvitees: [{ email: "carol@example.com" }] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    expect(notification.sentPollEmails).toHaveLength(3); // alice, bob, carol — each exactly once
    const byRecipient = new Map(notification.sentPollEmails.map((e) => [e.to, e]));
    expect(byRecipient.size).toBe(3);
    expect(byRecipient.get("carol@example.com")!.subject).toContain("invited");
    expect(byRecipient.get("alice@example.com")!.subject.toLowerCase()).toContain("extend");
    expect(byRecipient.get("bob@example.com")!.subject.toLowerCase()).toContain("extend");
  });

  it("13. guestLink:true mints+stores a hash and returns guestUrl; true-when-enabled is a no-op", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app); // guestLink: false at create

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ guestLink: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { guestUrl?: string };
    expect(body.guestUrl).toMatch(/\?g=/);
    const token = new URL(body.guestUrl!).searchParams.get("g")!;
    const expectedHash = await hashToken(token, hashingKey(TEST_ENV));
    const row = await env.DB.prepare("SELECT guest_token_hash FROM polls WHERE id = ?").bind(pollId).first<{ guest_token_hash: string }>();
    expect(row!.guest_token_hash).toBe(expectedHash);

    // Already enabled: no-op, no guestUrl, hash unchanged.
    const again = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ guestLink: true }) },
      TEST_ENV,
    );
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { guestUrl?: string };
    expect(againBody.guestUrl).toBeUndefined();
    const rowAfter = await env.DB.prepare("SELECT guest_token_hash FROM polls WHERE id = ?").bind(pollId).first<{ guest_token_hash: string }>();
    expect(rowAfter!.guest_token_hash).toBe(row!.guest_token_hash);
  });

  it("14. guestLink:false NULLs the hash and fires ONE maybeBookOnAllIn; false-when-disabled is a no-op with no engine call", async () => {
    const app = makeAppWithJoinRoute(new MockNotificationProvider());
    const pollId = await createPoll(app, { guestLink: true });

    let calls = 0;
    __setPollBookingEngineForTests({
      bookPollSlot: async (): Promise<BookOutcome> => ({ ok: false, reason: "unused" }),
      maybeBookOnAllIn: async () => {
        calls += 1;
      },
      bookBestNow: async () => ({ ok: false, reason: "poll_not_actionable" }),
    });

    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ guestLink: false }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    const row = await env.DB.prepare("SELECT guest_token_hash FROM polls WHERE id = ?").bind(pollId).first<{ guest_token_hash: string | null }>();
    expect(row!.guest_token_hash).toBeNull();

    // The disabled link is actually dead, not just NULL in storage: T7's
    // public join route 404s unconditionally once guestTokenHash is null
    // (route.ts checks `!poll.guestTokenHash` before even looking at the
    // presented token), so any join attempt against this poll now fails.
    const joinRes = await app.request(
      `/poll/${pollId}/join`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Dave", email: "dave@example.com", guestToken: "irrelevant", turnstileToken: "irrelevant" }) },
      TEST_ENV,
    );
    expect(joinRes.status).toBe(404);

    // Already disabled: no-op, no engine call.
    const again = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ guestLink: false }) },
      TEST_ENV,
    );
    expect(again.status).toBe(200);
    expect(calls).toBe(1); // unchanged — no second call
  });

  it("returns 404 for a poll owned by another subject", async () => {
    await seedBearer("other-token", OTHER);
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createPoll(app);
    const res = await app.request(
      `/v1/polls/${pollId}`,
      { method: "PATCH", headers: { Authorization: "Bearer other-token", "content-type": "application/json" }, body: JSON.stringify({ title: "hijack" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });
});
