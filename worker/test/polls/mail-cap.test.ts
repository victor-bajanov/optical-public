import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountMeetingPollRoutes, __setPollBookingEngineForTests } from "../../src/handlers/polls";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { mountPollRoutes } from "../../src/polls/route";
import { runPollSweep, type BookAtDeadline } from "../../src/cron/poll-sweep";
import { createPoll as dbCreatePoll, insertInvitee, newInviteeId } from "../../src/db/polls";
import { upsertUser } from "../../src/db/users";
import { OutboundMailCapExceeded, utcDay, withOutboundMailCap } from "../../src/mail/outbound-cap";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";

// O9.8: /v1 poll ops whose request would mail third parties from the
// organiser's mailbox answer 429 {error:"mail_cap_exceeded"} once the
// per-subject daily cap is spent — before committing anything — and the
// cron sweep skips without throwing.

const OWNER = "cap-owner@org";
const AUTH = { Authorization: "Bearer cap-fake" };
const TEST_ENV: Env = { ...(env as unknown as Env), MEETING_POLL_ENABLED: "true", OUTBOUND_MAIL_DAILY_CAP: "3" };

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

function makeApp(notification: NotificationProvider): App {
  const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "validation_failed", issues: result.error.issues }, 400);
    },
  });
  mountMeetingPollRoutes(v1);
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("notificationProvider", notification);
    c.set("calendarProvider", new MockCalendarProvider());
    await next();
  });
  app.route("/v1", v1);
  return app;
}

const BODY = {
  title: "Roadmap sync",
  invitees: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
  durationMin: 30,
  rangeStart: "2027-01-04",
  rangeEnd: "2027-01-15",
  deadlineUtc: "2027-01-14T00:00:00Z",
  location: { kind: "meet" },
  guestLink: false,
};

async function setSentToday(count: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?, ?, ?) ON CONFLICT (subject, utc_day) DO UPDATE SET count = excluded.count",
  ).bind(OWNER, utcDay(new Date()), count).run();
}

async function pollCount(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls WHERE subject = ?").bind(OWNER).first<{ n: number }>();
  return r?.n ?? -1;
}

async function createViaApi(app: App, invitees = BODY.invitees): Promise<string> {
  const res = await app.request("/v1/polls", {
    method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ ...BODY, invitees }),
  }, TEST_ENV);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeEach(async () => {
  for (const t of ["poll_responses", "poll_invitees", "polls", "outbound_mail_counts", "users"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const hashed = await hashToken("cap-fake", env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  ).bind(hashed, OWNER).run();
  __setPollBookingEngineForTests(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMeetingPoll under the mail cap", () => {
  it("creates and sends while the invitees fit in today's budget", async () => {
    const mock = new MockNotificationProvider();
    await setSentToday(1);
    await createViaApi(makeApp(mock));
    expect(mock.sentPollEmails).toHaveLength(2);
  });

  it("429s mail_cap_exceeded with nothing created or sent when the invitees would cross the cap", async () => {
    const mock = new MockNotificationProvider();
    await setSentToday(2);
    const res = await makeApp(mock).request("/v1/polls", {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(BODY),
    }, TEST_ENV);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "mail_cap_exceeded" });
    expect(await pollCount()).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(0);
  });
});

describe("nudgeMeetingPoll under the mail cap", () => {
  it("429s before rotating any token when the non-responders would cross the cap", async () => {
    const mock = new MockNotificationProvider();
    const app = makeApp(mock);
    const pollId = await createViaApi(app);
    const before = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE poll_id = ? ORDER BY id").bind(pollId).all();
    await setSentToday(2);
    mock.sentPollEmails.length = 0;

    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "mail_cap_exceeded" });
    expect(mock.sentPollEmails).toHaveLength(0);
    const after = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE poll_id = ? ORDER BY id").bind(pollId).all();
    expect(after.results).toEqual(before.results);
  });

  it("maps a cap refusal raised mid-send (a concurrent request spent the budget) to 429, not 500", async () => {
    const pollId = await createViaApi(makeApp(new MockNotificationProvider()));
    const refusing: NotificationProvider = {
      sendReplanNotification: async () => {},
      sendPollEmail: async () => { throw new OutboundMailCapExceeded(3, 3); },
    };
    const res = await makeApp(refusing).request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "mail_cap_exceeded" });
  });
});

describe("updateMeetingPoll under the mail cap", () => {
  it("429s with no writes when addInvitees would cross the cap", async () => {
    const mock = new MockNotificationProvider();
    const app = makeApp(mock);
    const pollId = await createViaApi(app);
    await setSentToday(3);
    mock.sentPollEmails.length = 0;

    const res = await app.request(`/v1/polls/${pollId}`, {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed", addInvitees: [{ email: "carol@example.com" }] }),
    }, TEST_ENV);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "mail_cap_exceeded" });
    expect(mock.sentPollEmails).toHaveLength(0);
    const poll = await env.DB.prepare("SELECT title FROM polls WHERE id = ?").bind(pollId).first<{ title: string }>();
    expect(poll?.title).toBe("Roadmap sync");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("an edit that mails nobody (title only) still succeeds at the cap", async () => {
    const mock = new MockNotificationProvider();
    const app = makeApp(mock);
    const pollId = await createViaApi(app);
    await setSentToday(3);
    const res = await app.request(`/v1/polls/${pollId}`, {
      method: "PATCH", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Renamed" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
  });
});

describe("cancelMeetingPoll at the cap", () => {
  it("still cancels (a protective action is never refused); capped notices are skipped and logged", async () => {
    const app = makeApp(new MockNotificationProvider());
    const pollId = await createViaApi(app);
    await setSentToday(3);
    const inner = new MockNotificationProvider();
    const capped = makeApp(withOutboundMailCap(TEST_ENV, OWNER, inner));
    const res = await capped.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(inner.sentPollEmails).toHaveLength(0);
  });
});

describe("poll-sweep cron at the cap", () => {
  it("skips the capped nudge without throwing, logs outbound_mail_capped without PII, and leaves the poll un-stamped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await upsertUser(env.DB, OWNER);
    const poll = await dbCreatePoll(env.DB, {
      subject: OWNER, title: "Kickoff", durationMin: 30, rangeStart: "2026-08-01", rangeEnd: "2026-08-31",
      deadlineUtc: "2026-08-20T00:00:00Z", location: { kind: "gmeet" }, guestTokenHash: null, now: "2026-08-01T00:00:00Z",
    });
    await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "a@example.com", name: null, kind: "invited",
      tokenHash: "h-a", pseudonym: "anon-a", now: "2026-08-01T00:00:00Z",
    });
    await setSentToday(3);
    const inner = new MockNotificationProvider();

    const result = await runPollSweep(TEST_ENV, new Date("2026-08-19T06:00:00Z"), {
      bookAtDeadline: vi.fn<BookAtDeadline>(async () => {}),
      makeNotification: (s) => withOutboundMailCap(TEST_ENV, s, inner),
    });

    expect(result).toMatchObject({ checked: 1, nudgedFinal: 0, failed: 1 });
    expect(inner.sentPollEmails).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("outbound_mail_capped", { count: 3, cap: 3 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("@");
    const row = await env.DB.prepare("SELECT nudged_final_at FROM polls WHERE id = ?").bind(poll.id).first<{ nudged_final_at: string | null }>();
    expect(row?.nudged_final_at).toBeNull();
    // Capped BEFORE rotating: the invitee's existing link still works.
    const inv = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE poll_id = ?").bind(poll.id).first<{ token_hash: string }>();
    expect(inv?.token_hash).toBe("h-a");
  });

  it("skips the whole nudge (no partial rotation) when only some non-responders fit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await upsertUser(env.DB, OWNER);
    const poll = await dbCreatePoll(env.DB, {
      subject: OWNER, title: "Kickoff", durationMin: 30, rangeStart: "2026-08-01", rangeEnd: "2026-08-31",
      deadlineUtc: "2026-08-20T00:00:00Z", location: { kind: "gmeet" }, guestTokenHash: null, now: "2026-08-01T00:00:00Z",
    });
    for (const x of ["a", "b"]) {
      await insertInvitee(env.DB, {
        id: newInviteeId(), pollId: poll.id, email: `${x}@example.com`, name: null, kind: "invited",
        tokenHash: `h-${x}`, pseudonym: `anon-${x}`, now: "2026-08-01T00:00:00Z",
      });
    }
    await setSentToday(2);
    const inner = new MockNotificationProvider();
    await runPollSweep(TEST_ENV, new Date("2026-08-19T06:00:00Z"), {
      bookAtDeadline: vi.fn<BookAtDeadline>(async () => {}),
      makeNotification: (s) => withOutboundMailCap(TEST_ENV, s, inner),
    });
    expect(inner.sentPollEmails).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE poll_id = ? ORDER BY email").bind(poll.id).all<{ token_hash: string }>();
    expect(rows.results.map((r) => r.token_hash)).toEqual(["h-a", "h-b"]);
  });
});

describe("rotate-then-send ordering under a concurrent spend", () => {
  /** Spends the organiser's remaining budget on its first send, as a
   *  concurrent request from the same subject would. */
  class SpendingProvider extends MockNotificationProvider {
    private first = true;
    async sendPollEmail(email: Parameters<MockNotificationProvider["sendPollEmail"]>[0]): Promise<void> {
      if (this.first) { this.first = false; await setSentToday(3); }
      await super.sendPollEmail(email);
    }
  }

  it("nudge reserves every recipient up front: an exact-budget nudge sends all, counted once each", async () => {
    const pollId = await createViaApi(makeApp(new MockNotificationProvider()));
    await setSentToday(1);
    const inner = new SpendingProvider();
    const res = await makeApp(withOutboundMailCap(TEST_ENV, OWNER, inner))
      .request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AUTH }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(inner.sentPollEmails).toHaveLength(2);
  });

  it("deadline extension: an invitee whose notice is refused keeps its old link (token not rotated)", async () => {
    const pollId = await createViaApi(makeApp(new MockNotificationProvider()));
    const before = await env.DB.prepare("SELECT email, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ email: string; token_hash: string }>();
    await setSentToday(1);
    const inner = new SpendingProvider();
    const res = await makeApp(withOutboundMailCap(TEST_ENV, OWNER, inner)).request(`/v1/polls/${pollId}`, {
      method: "PATCH", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ deadlineUtc: "2027-01-15T00:00:00Z" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(inner.sentPollEmails).toHaveLength(1);
    const sentTo = inner.sentPollEmails[0]!.to;
    const after = await env.DB.prepare("SELECT email, token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).all<{ email: string; token_hash: string }>();
    const unsent = before.results.find((r) => r.email !== sentTo)!;
    expect(after.results.find((r) => r.email === unsent.email)!.token_hash).toBe(unsent.token_hash);
  });
});

describe("guest-join at the organiser's cap (drain scenario)", () => {
  async function joinApp(notification: NotificationProvider): Promise<App> {
    const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("notificationProvider", notification);
      c.set("calendarProvider", new MockCalendarProvider());
      await next();
    });
    mountPollRoutes(app);
    return app;
  }

  it("a guest-link holder re-joining as a known invitee cannot kill that invitee's link, and no link-less guest row is created", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ success: true, hostname: "localhost" })));
    const guestSecret = "shared-secret";
    const poll = await dbCreatePoll(env.DB, {
      subject: OWNER, title: "Sync", durationMin: 30, rangeStart: "2027-01-04", rangeEnd: "2027-01-15",
      deadlineUtc: "2027-01-14T00:00:00Z", location: { kind: "meet" },
      guestTokenHash: await hashToken(guestSecret, hashingKey(TEST_ENV)), now: new Date().toISOString(),
    });
    await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "victim@example.com", name: null, kind: "invited",
      tokenHash: "h-victim", pseudonym: "anon-v", now: new Date().toISOString(),
    });
    await setSentToday(3);
    const inner = new MockNotificationProvider();
    const app = await joinApp(withOutboundMailCap(TEST_ENV, OWNER, inner));
    const env2: Env = { ...TEST_ENV, TURNSTILE_SECRET: "s" };
    const join = (email: string) => app.request(`/poll/${poll.id}/join`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
      body: JSON.stringify({ name: "G", email, turnstileToken: "tok", guestToken: guestSecret }),
    }, env2);

    const r1 = await join("victim@example.com");
    expect(r1.status).toBe(202);
    const r2 = await join("newguest@example.com");
    expect(r2.status).toBe(202);

    expect(inner.sentPollEmails).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT email, token_hash FROM poll_invitees WHERE poll_id = ?").bind(poll.id).all<{ email: string; token_hash: string }>();
    expect(rows.results).toEqual([{ email: "victim@example.com", token_hash: "h-victim" }]);
  });
});
