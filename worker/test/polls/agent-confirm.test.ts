// O9.3: meeting-poll ops called by an agent-confirm client (AGENT_CONFIRM_CLIENT_IDS)
// are deferred through the O9.1 confirm mechanism. A gated call answers 202
// awaiting_confirmation, stores the request, and sends nothing to invitees and
// writes nothing to the calendar; the user's browser confirm replays it exactly
// once after re-checking live state. Ungated clients are unchanged (api.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  mountMeetingPollRoutes,
  __setPollBookingEngineForTests,
  type PollBookingEngine,
  type BookBestOutcome,
} from "../../src/handlers/polls";
import { mountConfirmRoutes } from "../../src/confirm/route";
import { getConfirmableOp } from "../../src/confirm/registry";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { saveBookingPage } from "../../src/db/booking-page";
import { insertInvitee, newInviteeId, setPollStatus, setGuestTokenHash } from "../../src/db/polls";
import { utcDay } from "../../src/mail/outbound-cap";
import { upsertUser } from "../../src/db/users";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";

const OWNER = "o93-owner@org";
const AGENT = "agent-client";
const ISSUER = "https://scheduler.example.com";
const AGENT_AUTH = { Authorization: "Bearer o93-agent" };
const HUMAN_AUTH = { Authorization: "Bearer o93-cli" };
const EVIL = `<script>alert("x")</script>`;

const BASE_ENV: Env = {
  ...(env as unknown as Env),
  MEETING_POLL_ENABLED: "true",
  OAUTH_ISSUER: ISSUER,
  OUTBOUND_MAIL_DAILY_CAP: "50",
};
const GATED: Env = { ...BASE_ENV, AGENT_CONFIRM_CLIENT_IDS: AGENT };

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

function makeApp(notify: MockNotificationProvider, calendar = new MockCalendarProvider()): App {
  const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "validation_failed", issues: result.error.issues }, 400);
    },
  });
  mountMeetingPollRoutes(v1);
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("notificationProvider", notify);
    c.set("calendarProvider", calendar);
    await next();
  });
  mountConfirmRoutes(app);
  app.route("/v1", v1);
  return app;
}

async function seedBearer(token: string, clientId: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)",
  ).bind(h, clientId, "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, OWNER).run();
}

const BODY = {
  title: `Roadmap ${EVIL}`,
  invitees: [
    { email: "alice@example.com", name: "Alice" },
    { email: "bob@example.com", name: "Bob" },
  ],
  durationMin: 30,
  rangeStart: "2027-01-04",
  rangeEnd: "2027-01-15",
  deadlineUtc: "2027-01-14T00:00:00Z",
  location: { kind: "meet" },
  guestLink: false,
};
const SLOT = "2027-01-05T09:00:00.000Z";

function json(body: unknown, headers: Record<string, string>) {
  return { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Creates a poll as the ungated (human CLI) client; clears the mailbox. */
async function createDirect(app: App, notify: MockNotificationProvider, body: object = BODY): Promise<string> {
  const res = await app.request("/v1/polls", { method: "POST", ...json(body, HUMAN_AUTH) }, GATED);
  expect(res.status).toBe(201);
  notify.sentPollEmails.length = 0;
  return ((await res.json()) as { id: string }).id;
}

function confirmMails(notify: MockNotificationProvider) {
  return notify.sentPollEmails.filter((m) => m.to === OWNER && m.subject.startsWith("Confirm:"));
}
function inviteeMails(notify: MockNotificationProvider) {
  return notify.sentPollEmails.filter((m) => m.to !== OWNER);
}

function linkFrom(notify: MockNotificationProvider): { id: string; t: string } {
  const mail = confirmMails(notify).at(-1);
  if (!mail) throw new Error("no confirm mail");
  const m = /https:\/\/scheduler\.example\.com\/confirm\/([0-9a-f-]+)\?t=([^\s"<]+)/.exec(mail.text);
  if (!m) throw new Error("no confirm link in mail");
  return { id: m[1]!, t: decodeURIComponent(m[2]!) };
}

function getPage(app: App, l: { id: string; t: string }, e: Env = GATED) {
  return app.request(`/confirm/${l.id}?t=${encodeURIComponent(l.t)}`, { method: "GET" }, e);
}
function postConfirm(app: App, l: { id: string; t: string }, e: Env = GATED) {
  return app.request(
    `/confirm/${l.id}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(l.t)}` },
    e,
  );
}

async function pendingRows(): Promise<Array<{ op: string; consumed_at: string | null }>> {
  return (await env.DB.prepare("SELECT op, consumed_at FROM pending_actions").all<{ op: string; consumed_at: string | null }>()).results;
}
async function pollRow(id: string) {
  return env.DB.prepare("SELECT status, title, deadline_utc, guest_token_hash FROM polls WHERE id = ?").bind(id).first<{
    status: string; title: string; deadline_utc: string; guest_token_hash: string | null;
  }>();
}
async function tokenHashes(pollId: string) {
  return (await env.DB.prepare("SELECT id, token_hash FROM poll_invitees WHERE poll_id = ? ORDER BY id").bind(pollId).all()).results;
}
async function setSentToday(count: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?, ?, ?) ON CONFLICT (subject, utc_day) DO UPDATE SET count = excluded.count",
  ).bind(OWNER, utcDay(new Date()), count).run();
}

function expectAwaiting(body: unknown) {
  expect(body).toMatchObject({ status: "awaiting_confirmation", action_id: expect.any(String), expires_at: expect.any(String) });
}

interface EngineCalls { book: string[]; best: number; allIn: number }
function stubEngine(best: BookBestOutcome = { ok: true, slotStartUtc: SLOT, eventId: "evt-best" }): EngineCalls {
  const calls: EngineCalls = { book: [], best: 0, allIn: 0 };
  const engine: PollBookingEngine = {
    bookPollSlot: async (_e, _id, slot) => { calls.book.push(slot); return { ok: true, eventId: "evt-1" }; },
    maybeBookOnAllIn: async () => { calls.allIn += 1; },
    bookBestNow: async () => { calls.best += 1; return best; },
  };
  __setPollBookingEngineForTests(engine);
  return calls;
}

beforeEach(async () => {
  for (const t of ["poll_responses", "poll_invitees", "polls", "pending_actions", "outbound_mail_counts", "oauth_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("DELETE FROM config_booking_page WHERE owner_subject != '__default__'").run();
  await seedBearer("o93-agent", AGENT);
  await seedBearer("o93-cli", "cli-client");
  await upsertUser(env.DB, OWNER); // the confirm route requires an active account
  __setPollBookingEngineForTests(null);
  await saveBookingPage(env.DB, OWNER, {
    enabled: true,
    hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "23:45" },
    horizon_days: 21,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  __setPollBookingEngineForTests(null);
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("confirm/ops wires all five poll ops into the registry", async () => {
    await import("../../src/confirm/ops");
    for (const op of ["createMeetingPoll", "updateMeetingPoll", "nudgeMeetingPoll", "cancelMeetingPoll", "resolveMeetingPoll"]) {
      expect(getConfirmableOp(op), op).toBeDefined();
    }
  });
});

// ── createMeetingPoll ────────────────────────────────────────────────────────
describe("createMeetingPoll (gated)", () => {
  it("answers 202, stores the request, creates no poll and emails only the user", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const res = await app.request("/v1/polls", { method: "POST", ...json(BODY, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(202);
    expectAwaiting(await res.json());
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(inviteeMails(notify)).toHaveLength(0);
    expect(confirmMails(notify)).toHaveLength(1);
    expect(await pendingRows()).toEqual([{ op: "createMeetingPoll", consumed_at: null }]);
  });

  it("still validates up front: a bad body is a 400 with nothing stored or sent", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const res = await app.request("/v1/polls", { method: "POST", ...json({ ...BODY, rangeEnd: "2027-03-30" }, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(400);
    expect(await pendingRows()).toHaveLength(0);
    expect(notify.sentPollEmails).toHaveLength(0);
  });

  it("still pre-flights the mail cap: over the cap is a 429 with nothing stored", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    await setSentToday(49);
    const res = await app.request("/v1/polls", { method: "POST", ...json(BODY, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(429);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("the confirm page shows the recipients, the title and the invite text, escaped", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    await app.request("/v1/polls", { method: "POST", ...json(BODY, AGENT_AUTH) }, GATED);
    const res = await getPage(app, linkFrom(notify));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("bob@example.com");
    expect(html).not.toContain(EVIL);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/pick your availability/); // the invite email's subject
    expect(html).toMatch(/Responses close/);
  });

  it("confirming creates the poll and sends the invites exactly once", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    await app.request("/v1/polls", { method: "POST", ...json({ ...BODY, guestLink: true }, AGENT_AUTH) }, GATED);
    const link = linkFrom(notify);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`${ISSUER}/poll/`); // status page and guest link for the user
    expect(html).toContain("?g=");
    // Real links, not URLs pasted into the message text.
    expect(html).toMatch(new RegExp(`<a class="btn" href="${ISSUER.replace(/\./g, "\\.")}/poll/[^"]+">Open your poll status page</a>`));
    expect(html).toMatch(/<input class="copy"[^>]*readonly[^>]*value="https:[^"]*\?g=/);
    expect(html).toContain("Guest link to share");
    const message = /<h1>Done<\/h1><p>([^<]*)<\/p>/.exec(html)?.[1] ?? "";
    expect(message).toMatch(/created/);
    expect(message).not.toContain("http");
    const polls = await env.DB.prepare("SELECT id, title FROM polls").all<{ id: string; title: string }>();
    expect(polls.results).toHaveLength(1);
    expect(polls.results[0]!.title).toBe(BODY.title);
    expect(inviteeMails(notify).map((m) => m.to).sort()).toEqual(["alice@example.com", "bob@example.com"]);

    const again = await postConfirm(app, link);
    expect(again.status).toBe(409);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect(inviteeMails(notify)).toHaveLength(2);
  });

  it("a feature flag turned off before confirm does nothing", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    await app.request("/v1/polls", { method: "POST", ...json(BODY, AGENT_AUTH) }, GATED);
    const res = await postConfirm(app, linkFrom(notify), { ...GATED, MEETING_POLL_ENABLED: "false" });
    expect(res.status).toBe(409);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("a mail cap spent before confirm creates nothing (the O9.8 pre-flight runs again)", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    await app.request("/v1/polls", { method: "POST", ...json(BODY, AGENT_AUTH) }, GATED);
    await setSentToday(49);
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/mail/i);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("an ungated client still creates immediately (201, no pending row)", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const res = await app.request("/v1/polls", { method: "POST", ...json(BODY, HUMAN_AUTH) }, GATED);
    expect(res.status).toBe(201);
    expect(await pendingRows()).toHaveLength(0);
    expect(inviteeMails(notify)).toHaveLength(2);
  });
});

// ── nudgeMeetingPoll ─────────────────────────────────────────────────────────
describe("nudgeMeetingPoll (gated)", () => {
  it("answers 202 without emailing or rotating any invitee link", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const before = await tokenHashes(pollId);
    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(res.status).toBe(202);
    expectAwaiting(await res.json());
    expect(inviteeMails(notify)).toHaveLength(0);
    expect(await tokenHashes(pollId)).toEqual(before);
    expect(await pendingRows()).toEqual([{ op: "nudgeMeetingPoll", consumed_at: null }]);
  });

  it("runs directly when there is nobody to nudge, and 409s directly on a non-open poll", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await env.DB.prepare("UPDATE poll_invitees SET responded_at = '2026-10-01T00:00:00Z' WHERE poll_id = ?").bind(pollId).run();
    const none = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ nudged: [] });
    await setPollStatus(env.DB, pollId, "cancelled", new Date().toISOString());
    const closed = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(closed.status).toBe(409);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("the confirm page lists the non-responders and the reminder text", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toContain("alice@example.com");
    expect(html).toMatch(/Reminder:/);
    expect(html).not.toContain(EVIL);
  });

  it("confirming nudges each non-responder once with a fresh link", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(200);
    expect(inviteeMails(notify).map((m) => m.to).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    for (const m of inviteeMails(notify)) expect(m.text).toContain(`${ISSUER}/poll/${pollId}?t=`);
  });

  it("a poll cancelled before confirm is not nudged", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    await setPollStatus(env.DB, pollId, "cancelled", new Date().toISOString());
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/cancelled/);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("refuses when someone not shown on the confirm page would now be emailed", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    await insertInvitee(env.DB, {
      id: newInviteeId(), pollId, email: "mallory@example.com", name: null, kind: "guest",
      tokenHash: "h-mallory", pseudonym: "Teal Otter", now: new Date().toISOString(),
    });
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("a mail cap spent before confirm sends nothing and rotates nothing", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const before = await tokenHashes(pollId);
    await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    await setSentToday(50);
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(inviteeMails(notify)).toHaveLength(0);
    expect(await tokenHashes(pollId)).toEqual(before);
  });
});

// ── cancelMeetingPoll ────────────────────────────────────────────────────────
describe("cancelMeetingPoll (gated)", () => {
  it("answers 202 and leaves the poll open with nobody emailed", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(res.status).toBe(202);
    expectAwaiting(await res.json());
    expect((await pollRow(pollId))?.status).toBe("open");
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("an already-terminal poll still 409s directly (nothing to confirm)", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await setPollStatus(env.DB, pollId, "booked", new Date().toISOString());
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(res.status).toBe(409);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("the confirm page lists who gets the cancellation notice and its text", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toContain("bob@example.com");
    expect(html).toMatch(/[Cc]ancel/);
    expect(html).not.toContain(EVIL);
  });

  it("confirming cancels and notifies every invitee once", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(200);
    expect((await pollRow(pollId))?.status).toBe("cancelled");
    expect(inviteeMails(notify)).toHaveLength(2);
  });

  it("a poll booked before confirm stays booked and nobody is told it was cancelled", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    await setPollStatus(env.DB, pollId, "booked", new Date().toISOString());
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/booked/);
    expect((await pollRow(pollId))?.status).toBe("booked");
    expect(inviteeMails(notify)).toHaveLength(0);
  });
});

// ── resolveMeetingPoll ───────────────────────────────────────────────────────
describe("resolveMeetingPoll (gated)", () => {
  it("book: validates the slot, then answers 202 without booking", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    const res = await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "book", slotStartUtc: SLOT }, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(202);
    expectAwaiting(await res.json());
    expect(calls.book).toEqual([]);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("book: an infeasible slot is still a direct 400 with nothing stored", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    stubEngine();
    const res = await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "book", slotStartUtc: "2027-01-05T09:00:01Z" }, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(400);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("book: the confirm page shows the slot, the event title and the attendees", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    stubEngine();
    await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "book", slotStartUtc: SLOT }, AGENT_AUTH) }, GATED);
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toContain("alice@example.com");
    expect(html).toMatch(/<h2>When<\/h2>/);
    expect(html).toMatch(/January/);
    expect(html).not.toContain(EVIL);
  });

  it("book: confirming books the slot once", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "book", slotStartUtc: "2027-01-05T09:00:00Z" }, AGENT_AUTH) }, GATED);
    const link = linkFrom(notify);
    expect((await postConfirm(app, link)).status).toBe(200);
    expect(calls.book).toEqual([SLOT]);
    expect((await postConfirm(app, link)).status).toBe(409);
    expect(calls.book).toEqual([SLOT]);
  });

  it("book: a poll cancelled before confirm is not booked", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "book", slotStartUtc: SLOT }, AGENT_AUTH) }, GATED);
    await setPollStatus(env.DB, pollId, "cancelled", new Date().toISOString());
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/cancelled/);
    expect(calls.book).toEqual([]);
  });

  it("bookBest: answers 202, then books once on confirm", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    const res = await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "bookBest" }, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(202);
    expect(calls.best).toBe(0);
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toMatch(/when you confirm/i);
    expect((await postConfirm(app, linkFrom(notify))).status).toBe(200);
    expect(calls.best).toBe(1);
  });

  it("bookBest: an engine refusal at confirm is reported, not retried", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine({ ok: false, reason: "no_qualifying_slot" });
    await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "bookBest" }, AGENT_AUTH) }, GATED);
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(calls.best).toBe(1);
  });

  it("refuses to book when an attendee not shown on the confirm page has joined", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "bookBest" }, AGENT_AUTH) }, GATED);
    await insertInvitee(env.DB, {
      id: newInviteeId(), pollId, email: "mallory@example.com", name: null, kind: "guest",
      tokenHash: "h-mallory2", pseudonym: "Teal Otter", now: new Date().toISOString(),
    });
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(calls.best).toBe(0);
  });
});

// ── updateMeetingPoll ────────────────────────────────────────────────────────
describe("updateMeetingPoll (gated)", () => {
  async function patch(app: App, pollId: string, body: object, auth = AGENT_AUTH) {
    return app.request(`/v1/polls/${pollId}`, { method: "PATCH", ...json(body, auth) }, GATED);
  }

  it("a title edit is gated (decision J): 202, title unchanged until the user confirms", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { title: `Renamed ${EVIL}` });
    expect(res.status).toBe(202);
    expectAwaiting(await res.json());
    expect((await pollRow(pollId))?.title).toBe(BODY.title);
    expect(await pendingRows()).toEqual([{ op: "updateMeetingPoll", consumed_at: null }]);
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toMatch(/New title/);
    expect(html).not.toContain(EVIL);
    expect((await postConfirm(app, linkFrom(notify))).status).toBe(200);
    expect((await pollRow(pollId))?.title).toBe(`Renamed ${EVIL}`);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("a location edit is gated too, and applies on confirm", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { location: { kind: "phone", detail: "+61 2 0000 0000" } });
    expect(res.status).toBe(202);
    const before = await env.DB.prepare("SELECT location FROM polls WHERE id = ?").bind(pollId).first<{ location: string }>();
    expect(JSON.parse(before!.location).kind).toBe("meet");
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toMatch(/New location/);
    expect(html).toContain("+61 2 0000 0000");
    expect((await postConfirm(app, linkFrom(notify))).status).toBe(200);
    const after = await env.DB.prepare("SELECT location FROM polls WHERE id = ?").bind(pollId).first<{ location: string }>();
    expect(JSON.parse(after!.location)).toMatchObject({ kind: "phone", detail: "+61 2 0000 0000" });
  });

  it("re-sending the current title and location is a no-op and runs directly", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { title: BODY.title, location: { kind: "meet" } });
    expect(res.status).toBe(200);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("a deferred rename does nothing if the poll was booked before confirm", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await patch(app, pollId, { title: "Renamed" });
    await setPollStatus(env.DB, pollId, "booked", new Date().toISOString());
    const res = await postConfirm(app, linkFrom(notify));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/booked/);
    expect((await pollRow(pollId))?.title).toBe(BODY.title);
  });

  it("a deferred rename is refused if the title changed meanwhile (the summary no longer matches)", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await patch(app, pollId, { title: "Renamed" });
    const link = linkFrom(notify);
    expect((await patch(app, pollId, { title: "Other name" }, HUMAN_AUTH)).status).toBe(200);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect((await pollRow(pollId))?.title).toBe("Other name");
  });

  it("an ungated client's title edit still applies immediately", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { title: "Renamed" }, HUMAN_AUTH);
    expect(res.status).toBe(200);
    expect((await pollRow(pollId))?.title).toBe("Renamed");
    expect(await pendingRows()).toHaveLength(0);
  });

  it("no-op toggles and an already-dropped removal run directly", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const alice = (await env.DB.prepare("SELECT id FROM poll_invitees WHERE email = 'alice@example.com'").first<{ id: string }>())!.id;
    await env.DB.prepare("UPDATE poll_invitees SET dropped = 1 WHERE id = ?").bind(alice).run();
    const res = await patch(app, pollId, { guestLink: false, removeInviteeIds: [alice], addInvitees: [] });
    expect(res.status).toBe(200);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("adding an invitee answers 202 and defers the WHOLE edit: no row, no mail, no rename", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { title: "Renamed", addInvitees: [{ email: "carol@example.com" }] });
    expect(res.status).toBe(202);
    expectAwaiting(await res.json());
    expect((await pollRow(pollId))?.title).toBe(BODY.title);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ n: number }>();
    expect(n?.n).toBe(2);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("validation still runs up front (400 directly, nothing stored)", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { addInvitees: [{ email: "alice@example.com" }] });
    expect(res.status).toBe(400);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("the confirm page shows the new invitee, the rename and the invite text", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await patch(app, pollId, { title: `New ${EVIL}`, addInvitees: [{ email: "carol@example.com" }] });
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toContain("carol@example.com");
    expect(html).toMatch(/pick your availability/);
    expect(html).not.toContain(EVIL);
  });

  it("confirming applies the edit once: invitee added, invite sent, title changed", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await patch(app, pollId, { title: "Renamed", addInvitees: [{ email: "carol@example.com" }] });
    const link = linkFrom(notify);
    expect((await postConfirm(app, link)).status).toBe(200);
    expect((await pollRow(pollId))?.title).toBe("Renamed");
    expect(inviteeMails(notify).map((m) => m.to)).toEqual(["carol@example.com"]);
    expect((await postConfirm(app, link)).status).toBe(409);
    expect(inviteeMails(notify)).toHaveLength(1);
  });

  it("a deadline change is gated; a poll booked before confirm is left untouched", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { deadlineUtc: "2027-01-15T00:00:00Z" });
    expect(res.status).toBe(202);
    expect((await pollRow(pollId))?.deadline_utc).toBe(BODY.deadlineUtc);
    const html = await (await getPage(app, linkFrom(notify))).text();
    expect(html).toContain("alice@example.com");
    await setPollStatus(env.DB, pollId, "booked", new Date().toISOString());
    const conf = await postConfirm(app, linkFrom(notify));
    expect(conf.status).toBe(409);
    expect((await pollRow(pollId))?.deadline_utc).toBe(BODY.deadlineUtc);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("enabling the guest link is gated; confirming shows the new link to the user", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { guestLink: true });
    expect(res.status).toBe(202);
    expect((await pollRow(pollId))?.guest_token_hash).toBeNull();
    const conf = await postConfirm(app, linkFrom(notify));
    expect(conf.status).toBe(200);
    const html = await conf.text();
    expect(html).toMatch(/<input class="copy"[^>]*readonly[^>]*value="https:[^"]*\?g=/);
    expect(/<h1>Done<\/h1><p>([^<]*)<\/p>/.exec(html)?.[1]).not.toContain("http");
    expect((await pollRow(pollId))?.guest_token_hash).not.toBeNull();
  });

  it("disabling the guest link (which can book) is gated; the booking re-attempt runs only on confirm", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await setGuestTokenHash(env.DB, pollId, "h-guest");
    const calls = stubEngine();
    const res = await patch(app, pollId, { guestLink: false });
    expect(res.status).toBe(202);
    expect(calls.allIn).toBe(0);
    expect((await postConfirm(app, linkFrom(notify))).status).toBe(200);
    expect(calls.allIn).toBe(1);
    expect((await pollRow(pollId))?.guest_token_hash).toBeNull();
  });

  it("removing an invitee is gated: no drop, no removal email, no booking until confirm", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    const bob = (await env.DB.prepare("SELECT id FROM poll_invitees WHERE email = 'bob@example.com'").first<{ id: string }>())!.id;
    const res = await patch(app, pollId, { removeInviteeIds: [bob] });
    expect(res.status).toBe(202);
    const dropped = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE id = ?").bind(bob).first<{ dropped: number }>();
    expect(dropped?.dropped).toBe(0);
    expect(calls.allIn).toBe(0);
    expect(inviteeMails(notify)).toHaveLength(0);
    expect((await postConfirm(app, linkFrom(notify))).status).toBe(200);
    expect(inviteeMails(notify).map((m) => m.to)).toEqual(["bob@example.com"]);
    expect(calls.allIn).toBe(1);
  });

  it("an ungated client's emailing edit still applies immediately", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await patch(app, pollId, { addInvitees: [{ email: "carol@example.com" }] }, HUMAN_AUTH);
    expect(res.status).toBe(200);
    expect(inviteeMails(notify).map((m) => m.to)).toEqual(["carol@example.com"]);
    expect(await pendingRows()).toHaveLength(0);
  });
});

// ── review fixes: confirmed content must be what is sent ─────────────────────
describe("replay refuses when the poll's content changed after deferral", () => {
  const RENAME = { title: "Click https://evil.example/reveal" };
  async function renameAsAgent(app: App, pollId: string, body: object = RENAME) {
    // Since decision J an agent's own rename is itself gated; an ungated
    // client (or a confirmed rename) can still change the content meanwhile.
    const res = await app.request(`/v1/polls/${pollId}`, { method: "PATCH", ...json(body, HUMAN_AUTH) }, GATED);
    expect(res.status).toBe(200);
  }

  it("nudge: a title edited after deferral is not sent", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const link = linkFrom(notify);
    await renameAsAgent(app, pollId);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("cancel: a title edited after deferral is not sent", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const link = linkFrom(notify);
    await renameAsAgent(app, pollId);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect((await pollRow(pollId))?.status).toBe("open");
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("resolve: a location edited after deferral is not booked", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    await app.request(`/v1/polls/${pollId}/resolve`, { method: "POST", ...json({ action: "book", slotStartUtc: SLOT }, AGENT_AUTH) }, GATED);
    const link = linkFrom(notify);
    await renameAsAgent(app, pollId, { location: { kind: "custom", detail: "https://evil.example/join" } });
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect(calls.book).toEqual([]);
  });

  it("update: a title edited after deferral is not sent with the confirmed edit", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}`, { method: "PATCH", ...json({ addInvitees: [{ email: "carol@example.com" }] }, AGENT_AUTH) }, GATED);
    const link = linkFrom(notify);
    await renameAsAgent(app, pollId);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect(inviteeMails(notify)).toHaveLength(0);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ n: number }>();
    expect(n?.n).toBe(2);
  });
});

describe("update replay recipient guards", () => {
  async function joinGuest(pollId: string, email = "mallory@example.com") {
    await insertInvitee(env.DB, {
      id: newInviteeId(), pollId, email, name: null, kind: "guest",
      tokenHash: `h-${email}`, pseudonym: "Teal Otter", now: new Date().toISOString(),
    });
  }

  it("refuses a deadline change whose emails would now reach someone not shown", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}`, { method: "PATCH", ...json({ deadlineUtc: "2027-01-15T00:00:00Z" }, AGENT_AUTH) }, GATED);
    const link = linkFrom(notify);
    await joinGuest(pollId);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/changed/i);
    expect((await pollRow(pollId))?.deadline_utc).toBe(BODY.deadlineUtc);
    expect(inviteeMails(notify)).toHaveLength(0);
  });

  it("an edit that can book lists who the calendar invite would go to, and refuses if that set grew", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const calls = stubEngine();
    const bob = (await env.DB.prepare("SELECT id FROM poll_invitees WHERE email = 'bob@example.com'").first<{ id: string }>())!.id;
    await app.request(`/v1/polls/${pollId}`, { method: "PATCH", ...json({ removeInviteeIds: [bob] }, AGENT_AUTH) }, GATED);
    const link = linkFrom(notify);
    const html = await (await getPage(app, link)).text();
    expect(html).toMatch(/calendar invite goes to/i);
    expect(html).toContain("alice@example.com");
    await joinGuest(pollId);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(409);
    expect(calls.allIn).toBe(0);
    expect(inviteeMails(notify)).toHaveLength(0);
    const dropped = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE id = ?").bind(bob).first<{ dropped: number }>();
    expect(dropped?.dropped).toBe(0);
  });

  it("cancel is exempt: a guest who joined since is still told it was cancelled", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    const link = linkFrom(notify);
    await joinGuest(pollId);
    const res = await postConfirm(app, link);
    expect(res.status).toBe(200);
    expect((await pollRow(pollId))?.status).toBe("cancelled");
    expect(inviteeMails(notify).map((m) => m.to).sort()).toEqual(["alice@example.com", "bob@example.com", "mallory@example.com"]);
  });
});

// ── published contract ───────────────────────────────────────────────────────
describe("OpenAPI", () => {
  it("each gated poll op documents 202 awaiting_confirmation and 503, and says when it is deferred", async () => {
    const { v1 } = await import("../../src/v1");
    const doc: any = v1.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    const ops = new Map<string, any>();
    for (const p of Object.values<any>(doc.paths)) for (const op of Object.values<any>(p)) if (op?.operationId) ops.set(op.operationId, op);
    for (const id of ["createMeetingPoll", "updateMeetingPoll", "nudgeMeetingPoll", "cancelMeetingPoll", "resolveMeetingPoll"]) {
      const op = ops.get(id);
      expect(op.responses["202"], id).toBeDefined();
      expect(op.responses["202"].content["application/json"].schema.properties.status.enum ?? [op.responses["202"].content["application/json"].schema.properties.status.const]).toContain("awaiting_confirmation");
      expect(op.responses["503"], id).toBeDefined();
      expect(op.description, id).toMatch(/AGENT_CONFIRM_CLIENT_IDS/);
    }
    expect(ops.get("getMeetingPoll").responses["202"]).toBeUndefined();
    // updateMeetingPoll says precisely which edits are deferred: title and
    // location changes are (decision J); only no-op fields apply at once.
    const upd = ops.get("updateMeetingPoll").description as string;
    expect(upd).toMatch(/changing the title or location/i);
    expect(upd).not.toMatch(/title and\/or location[^.]*applies immediately/i);
    expect(upd).toMatch(/no-op/i);
  });
});

describe("confirm-page email previews name login_email, never the subject (identity port of #105)", () => {
  // After an IdP-side rename the subject is the owner's OLD address: the
  // preview must show invitees' real organiser name, the current address.
  const LOGIN = "o93-owner-now@example.com";

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM identity_tokens WHERE account_email = ?").bind(OWNER).run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
    ).bind(OWNER, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "sub-o93", LOGIN).run();
  });
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM identity_tokens WHERE account_email = ?").bind(OWNER).run();
  });

  // The confirm mail's recipient is another task's concern (owner recipients),
  // so find it by subject alone.
  async function previewHtml(app: App, notify: MockNotificationProvider): Promise<string> {
    const mail = notify.sentPollEmails.filter((m) => m.subject.startsWith("Confirm:")).at(-1);
    if (!mail) throw new Error("no confirm mail");
    const m = /https:\/\/scheduler\.example\.com\/confirm\/([0-9a-f-]+)\?t=([^\s"<]+)/.exec(mail.text);
    if (!m) throw new Error("no confirm link in mail");
    const res = await getPage(app, { id: m[1]!, t: decodeURIComponent(m[2]!) });
    expect(res.status).toBe(200);
    return res.text();
  }

  function expectNamesLogin(html: string): void {
    expect(html).toContain(LOGIN);
    expect(html).not.toContain(OWNER);
  }

  it("createMeetingPoll's invite preview", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const res = await app.request("/v1/polls", { method: "POST", ...json(BODY, AGENT_AUTH) }, GATED);
    expect(res.status).toBe(202);
    expectNamesLogin(await previewHtml(app, notify));
  });

  it("nudgeMeetingPoll's reminder preview", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await app.request(`/v1/polls/${pollId}/nudge`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(res.status).toBe(202);
    expectNamesLogin(await previewHtml(app, notify));
  });

  it("cancelMeetingPoll's cancellation preview", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const res = await app.request(`/v1/polls/${pollId}/cancel`, { method: "POST", headers: AGENT_AUTH }, GATED);
    expect(res.status).toBe(202);
    expectNamesLogin(await previewHtml(app, notify));
  });

  it("updateMeetingPoll's invite, removal and deadline-extended previews", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(notify);
    const pollId = await createDirect(app, notify);
    const bob = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ? AND email = 'bob@example.com'").bind(pollId).first<{ id: string }>();
    const res = await app.request(
      `/v1/polls/${pollId}`,
      {
        method: "PATCH",
        ...json(
          { addInvitees: [{ email: "carol@example.com", name: "Carol" }], removeInviteeIds: [bob!.id], deadlineUtc: "2027-01-14T12:00:00Z" },
          AGENT_AUTH,
        ),
      },
      GATED,
    );
    expect(res.status).toBe(202);
    const html = await previewHtml(app, notify);
    expect(html).toMatch(/Invite email/);
    expect(html).toMatch(/Removal email/);
    expectNamesLogin(html);
  });
});
