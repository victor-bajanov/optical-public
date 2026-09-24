import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { runPollSweep, type BookAtDeadline } from "../../src/cron/poll-sweep";
import { dispatchScheduled, __setHandlersForTests, POLL_CRON } from "../../src/cron/scheduled-entry";
import {
  createPoll,
  getPoll,
  insertInvitee,
  newInviteeId,
  listInvitees,
  setPollDeadline,
  type CreatePollInput,
} from "../../src/db/polls";
import { upsertUser } from "../../src/db/users";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { mountPollRoutes } from "../../src/polls/route";
import { saveBookingPage } from "../../src/db/booking-page";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";
import type { BusinessHours } from "../../src/planning/solver-contract";

const SUBJECT = "organiser@example.com";

async function seedSubject(subject: string = SUBJECT): Promise<void> {
  await upsertUser(env.DB, subject);
}

async function seedPoll(overrides: Partial<CreatePollInput> = {}) {
  return createPoll(env.DB, {
    subject: SUBJECT,
    title: "Kickoff",
    durationMin: 30,
    rangeStart: "2026-08-01",
    rangeEnd: "2026-08-31",
    deadlineUtc: "2026-08-20T00:00:00Z",
    location: { kind: "gmeet" },
    guestTokenHash: null,
    now: "2026-08-01T00:00:00Z",
    ...overrides,
  });
}

async function seedInvitee(pollId: string, email: string) {
  return insertInvitee(env.DB, {
    id: newInviteeId(),
    pollId,
    email,
    name: email,
    kind: "invited",
    tokenHash: `hash-${email}`,
    pseudonym: `anon-${email}`,
    now: "2026-08-01T00:00:00Z",
  });
}

function makeConstantNotification(provider: NotificationProvider) {
  return (_subject: string) => provider;
}

// Pulls the invitee's personal link out of a rendered nudge email's plain-text
// body ("Mark when you're free: <url>") and the token out of its `t=` param —
// the end-to-end proof that the link the sweep actually emailed is presentable
// to the grid route, not a reconstruction of what it might have emailed.
function extractInviteeUrl(email: { text: string }): string {
  const match = email.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error("no URL found in nudge email text");
  return match[0];
}

function tokenFromUrl(url: string): string {
  const t = new URL(url).searchParams.get("t");
  if (!t) throw new Error("no t= query param in URL");
  return t;
}

const ALL_DAY_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  start: "00:00",
  end: "23:45",
};

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

function appWithMockCalendar(): App {
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", new MockCalendarProvider({ events: [] }));
    await next();
  });
  mountPollRoutes(app);
  return app;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM poll_responses"),
    env.DB.prepare("DELETE FROM poll_invitees"),
    env.DB.prepare("DELETE FROM bookings"),
    env.DB.prepare("DELETE FROM polls"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  __setHandlersForTests(null);
});

describe("runPollSweep", () => {
  it("routes a deadline-passed poll to the injected bookAtDeadline and does not nudge it", async () => {
    await seedSubject();
    const poll = await seedPoll({ deadlineUtc: "2026-08-10T00:00:00Z" });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();

    const result = await runPollSweep(env, new Date("2026-08-10T00:00:01Z"), {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(bookAtDeadline).toHaveBeenCalledTimes(1);
    expect(bookAtDeadline).toHaveBeenCalledWith(env, poll.id);
    expect(result.deadlineProcessed).toBe(1);
    expect(result.nudgedFinal).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(0);
  });

  it("counts a deadline-triggered escalation as deadlineProcessed, not as a booking (bookAtDeadline's outcome isn't observable here)", async () => {
    await seedSubject();
    const poll = await seedPoll({ deadlineUtc: "2026-08-10T00:00:00Z" });
    await seedInvitee(poll.id, "a@example.com");

    // A stub that escalates (leaves the poll needs_attention) rather than
    // booking — bookAtDeadline's fixed signature returns void, so the sweep
    // cannot distinguish "booked" from "escalated" without reading it back;
    // the field name must not claim it can.
    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();

    const result = await runPollSweep(env, new Date("2026-08-10T00:00:01Z"), {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.deadlineProcessed).toBe(1);
    expect(result).not.toHaveProperty("booked");
  });

  it("fires the final nudge at deadline-24h to every non-responder and stamps nudged_final_at", async () => {
    await seedSubject();
    const poll = await seedPoll({ deadlineUtc: "2026-08-20T00:00:00Z" });
    await seedInvitee(poll.id, "a@example.com");
    await seedInvitee(poll.id, "b@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-19T06:00:00Z"); // 18h before deadline: inside the 24h window

    const result = await runPollSweep(env, now, {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.nudgedFinal).toBe(1);
    expect(mock.sentPollEmails.map((e) => e.to).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(bookAtDeadline).not.toHaveBeenCalled();

    const reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedFinalAt).toBe(now.toISOString());
  });

  it("is idempotent across two consecutive sweeps: the final nudge fires only once", async () => {
    await seedSubject();
    const poll = await seedPoll({ deadlineUtc: "2026-08-20T00:00:00Z" });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-19T06:00:00Z");
    const deps = { bookAtDeadline, makeNotification: makeConstantNotification(mock) };

    await runPollSweep(env, now, deps);
    await runPollSweep(env, now, deps);

    expect(mock.sentPollEmails).toHaveLength(1);
  });

  it("fires the midpoint nudge for a poll whose lifetime exceeds 7 days, once past the midpoint", async () => {
    await seedSubject();
    // created 2026-08-01, deadline 2026-08-20 -> 19-day lifetime, midpoint ~2026-08-10T12:00:00Z
    const poll = await seedPoll({ now: "2026-08-01T00:00:00Z", deadlineUtc: "2026-08-20T00:00:00Z" });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-11T00:00:00Z"); // past midpoint, well before deadline-24h

    const result = await runPollSweep(env, now, {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.nudgedMidpoint).toBe(1);
    expect(mock.sentPollEmails).toHaveLength(1);
    const reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedMidpointAt).toBe(now.toISOString());
  });

  it("does NOT fire a midpoint nudge for a poll whose lifetime is 7 days or less, even past its arithmetic midpoint", async () => {
    await seedSubject();
    // created 2026-08-14, deadline 2026-08-18 -> 4-day lifetime, arithmetic midpoint 2026-08-16T00:00:00Z
    const poll = await seedPoll({ now: "2026-08-14T00:00:00Z", deadlineUtc: "2026-08-18T00:00:00Z" });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-16T12:00:00Z"); // past the arithmetic midpoint, not yet in the final-24h window

    const result = await runPollSweep(env, now, {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.nudgedMidpoint).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(0);
    const reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedMidpointAt).toBeNull();
  });

  it("does NOT fire the final nudge for a poll whose entire lifetime is under the 24h lead — the invite already carries the urgency, and firing would rotate the just-emailed token (regression, todo.md 'a poll created inside the 24h nudge window')", async () => {
    await seedSubject();
    const createdAt = "2026-08-17T22:00:00Z";
    const deadlineUtc = "2026-08-18T00:00:00Z"; // 2h lifetime, entirely inside the 24h lead
    const poll = await seedPoll({ now: createdAt, deadlineUtc });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-17T23:00:00Z"); // 1h after creation, 1h before deadline

    const result = await runPollSweep(env, now, {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.nudgedFinal).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(0);
    const reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedFinalAt).toBeNull();
    // No rotation: the invitee's stored token_hash is untouched, so the link
    // emailed at creation time keeps resolving.
    const invitees = await listInvitees(env.DB, poll.id);
    expect(invitees[0]?.tokenHash).toBe("hash-a@example.com");
  });

  it("boundary: a poll created exactly at deadline-24h is suppressed, not just polls created after it", async () => {
    await seedSubject();
    const deadlineUtc = "2026-08-20T00:00:00Z";
    const createdAt = "2026-08-19T00:00:00Z"; // exactly deadline - 24h
    const poll = await seedPoll({ now: createdAt, deadlineUtc });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-19T06:00:00Z"); // inside the 24h window

    const result = await runPollSweep(env, now, {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.nudgedFinal).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(0);
    const reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedFinalAt).toBeNull();
  });

  it("regression (finding 1): an ordinary poll born just outside the 24h window still must not final-nudge minutes after creation — the sweep must wait out a minimum age, not just the born-inside-window case", async () => {
    await seedSubject();
    // 24h05m lifetime — an entirely ordinary shape (validateDeadline only
    // requires 1h lead), created 5min before deadline-24h so it's born
    // OUTSIDE the window and the earlier guard alone doesn't suppress it.
    const createdAt = "2026-08-17T08:55:00Z";
    const deadlineUtc = "2026-08-18T09:00:00Z";
    const poll = await seedPoll({ now: createdAt, deadlineUtc });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const deps = { bookAtDeadline, makeNotification: makeConstantNotification(mock) };

    // The window opens at deadline-24h = 08-17T09:00Z, i.e. 5 minutes after
    // creation — the very next hourly tick. Without a minimum-age floor this
    // fires and rotates the invitee's token 5 minutes after the invite email
    // went out (the exact bug).
    const resultAt5Min = await runPollSweep(env, new Date("2026-08-17T09:00:00Z"), deps);
    expect(resultAt5Min.nudgedFinal).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(0);
    let reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedFinalAt).toBeNull();
    const invitees = await listInvitees(env.DB, poll.id);
    expect(invitees[0]?.tokenHash).toBe("hash-a@example.com"); // untouched

    // Once the poll has aged past the 6h floor, with the window still open,
    // the final nudge fires for real — the floor delays, it doesn't suppress.
    const resultAt6h = await runPollSweep(env, new Date("2026-08-17T15:00:00Z"), deps);
    expect(resultAt6h.nudgedFinal).toBe(1);
    expect(mock.sentPollEmails).toHaveLength(1);
    reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedFinalAt).toBe(new Date("2026-08-17T15:00:00Z").toISOString());
  });

  it("a 48h-lifetime poll still gets exactly one final nudge inside the window, and a later tick doesn't re-fire", async () => {
    await seedSubject();
    const createdAt = "2026-08-17T00:00:00Z";
    const deadlineUtc = "2026-08-19T00:00:00Z"; // 48h lifetime
    const poll = await seedPoll({ now: createdAt, deadlineUtc });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-18T12:00:00Z"); // inside the final 24h window
    const deps = { bookAtDeadline, makeNotification: makeConstantNotification(mock) };

    const result1 = await runPollSweep(env, now, deps);
    expect(result1.nudgedFinal).toBe(1);
    expect(mock.sentPollEmails).toHaveLength(1);

    const result2 = await runPollSweep(env, now, deps);
    expect(result2.nudgedFinal).toBe(0);
    expect(mock.sentPollEmails).toHaveLength(1); // no re-fire on the second tick

    const reloaded = await getPoll(env.DB, poll.id);
    expect(reloaded?.nudgedFinalAt).toBe(now.toISOString());
  });

  it("extension interplay: a suppressed short-lived poll becomes eligible for a real final nudge once its deadline is extended far enough out", async () => {
    // Exercises the guard's arithmetic against a raw deadline change
    // (setPollDeadline, same DB helper the other tests here use) — the real
    // extendDeadline HTTP handler path (which also clears nudge stamps) is
    // covered separately in api.test.ts:1247 ("re-arms the deadline-24h
    // nudge cadence after a short extension").
    await seedSubject();
    const createdAt = "2026-08-17T22:00:00Z";
    const deadlineUtc = "2026-08-18T00:00:00Z"; // 2h lifetime, suppressed
    const poll = await seedPoll({ now: createdAt, deadlineUtc });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const deps = { bookAtDeadline, makeNotification: makeConstantNotification(mock) };

    // First tick, still short-lived: suppressed, exactly like the regression case above.
    await runPollSweep(env, new Date("2026-08-17T23:00:00Z"), deps);
    expect(mock.sentPollEmails).toHaveLength(0);

    // Organiser extends the deadline (resolveMeetingPoll's extendDeadline action)
    // far enough that created_at is now before newDeadline - 24h.
    const extendedDeadline = "2026-08-25T00:00:00Z";
    await setPollDeadline(env.DB, poll.id, extendedDeadline);

    // Tick inside the NEW final-nudge window: fires for real this time.
    const result = await runPollSweep(env, new Date("2026-08-24T06:00:00Z"), deps);
    expect(result.nudgedFinal).toBe(1);
    expect(mock.sentPollEmails).toHaveLength(1);
  });

  it("isolates one poll's failure: a throwing bookAtDeadline for one poll does not abort the sweep for the rest", async () => {
    await seedSubject();
    const failing = await seedPoll({ deadlineUtc: "2026-08-10T00:00:00Z" });
    const ok = await seedPoll({ deadlineUtc: "2026-08-20T00:00:00Z" });
    await seedInvitee(ok.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async (_env, pollId) => {
      if (pollId === failing.id) throw new Error("boom");
    });
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-19T06:00:00Z"); // past failing's deadline; inside ok's final-nudge window

    const result = await runPollSweep(env, now, {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    expect(result.failed).toBe(1);
    expect(result.nudgedFinal).toBe(1);
    expect(mock.sentPollEmails).toHaveLength(1);
    const reloadedOk = await getPoll(env.DB, ok.id);
    expect(reloadedOk?.nudgedFinalAt).not.toBeNull();
  });

  it("runs one indexed query per idle subject (no open polls)", async () => {
    await seedSubject("idle-a@example.com");
    await seedSubject("idle-b@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const prepareSpy = vi.spyOn(env.DB, "prepare");

    await runPollSweep(env, new Date("2026-08-11T00:00:00Z"), {
      bookAtDeadline,
      makeNotification: makeConstantNotification(mock),
    });

    // 1 query for listSubjects + 1 listOpenPollsDue query per idle subject.
    expect(prepareSpy).toHaveBeenCalledTimes(3);
    prepareSpy.mockRestore();
  });

  it("mints a fresh token and stores its hash on nudge, so the emailed link's hash matches the invitee's current token_hash", async () => {
    await seedSubject();
    const poll = await seedPoll({ deadlineUtc: "2026-08-20T00:00:00Z" });
    // seedInvitee's stored tokenHash is an arbitrary placeholder, not a real
    // signed token's hash — a re-signed-and-never-stored link would never
    // match it, exactly the dead-link bug this guards against.
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const now = new Date("2026-08-19T06:00:00Z");

    await runPollSweep(env, now, { bookAtDeadline, makeNotification: makeConstantNotification(mock) });

    expect(mock.sentPollEmails).toHaveLength(1);
    const token = tokenFromUrl(extractInviteeUrl(mock.sentPollEmails[0]!));
    const expectedHash = await hashToken(token, hashingKey(env));

    const invitees = await listInvitees(env.DB, poll.id);
    const invitee = invitees.find((i) => i.email === "a@example.com");
    expect(invitee?.tokenHash).toBe(expectedHash);
  });
});

describe("nudge link end-to-end (correction: mint-and-store, not re-sign)", () => {
  beforeEach(async () => {
    await saveBookingPage(env.DB, SUBJECT, {
      enabled: true,
      hours: ALL_DAY_HOURS,
      horizon_days: 90,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 0 },
    });
  });

  it("the emailed nudge link resolves 200 (not 401) against GET /poll/:id/grid", async () => {
    await seedSubject();
    const now = new Date();
    const rangeStart = now.toISOString().slice(0, 10);
    const rangeEnd = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const deadlineUtc = new Date(now.getTime() + 23 * 3_600_000).toISOString(); // inside the 24h final-nudge window
    // Created well before the window (48h before deadline), so this is a
    // real due nudge, not the born-inside-the-window case (suppressed).
    const createdAt = new Date(Date.parse(deadlineUtc) - 48 * 3_600_000).toISOString();
    const poll = await seedPoll({ rangeStart, rangeEnd, deadlineUtc, now: createdAt });
    await seedInvitee(poll.id, "a@example.com");

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    await runPollSweep(env, now, { bookAtDeadline, makeNotification: makeConstantNotification(mock) });

    expect(mock.sentPollEmails).toHaveLength(1);
    const token = tokenFromUrl(extractInviteeUrl(mock.sentPollEmails[0]!));

    const app = appWithMockCalendar();
    const ON: Env = { ...(env as unknown as Env), MEETING_POLL_ENABLED: "true" };
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);

    expect(res.status).toBe(200);
  });

  it("the nudged link still resolves after the deadline was extended before the sweep ran", async () => {
    await seedSubject();
    const now = new Date();
    const rangeStart = now.toISOString().slice(0, 10);
    const rangeEnd = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const deadlineUtc = new Date(now.getTime() + 23 * 3_600_000).toISOString();
    const poll = await seedPoll({ rangeStart, rangeEnd, deadlineUtc, now: now.toISOString() });
    await seedInvitee(poll.id, "a@example.com");

    // Extend the deadline BEFORE the sweep runs, as resolveMeetingPoll's
    // extendDeadline action would. The stored token_hash from creation is
    // now stale against the NEW deadline's target expiry — the sweep must
    // still mint-and-store, not assume a prior reconstruction still holds.
    const extendedDeadline = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    await setPollDeadline(env.DB, poll.id, extendedDeadline);

    const bookAtDeadline = vi.fn<BookAtDeadline>(async () => {});
    const mock = new MockNotificationProvider();
    const sweepNow = new Date(Date.parse(extendedDeadline) - 3_600_000); // 1h before the extended deadline
    await runPollSweep(env, sweepNow, { bookAtDeadline, makeNotification: makeConstantNotification(mock) });

    expect(mock.sentPollEmails).toHaveLength(1);
    const token = tokenFromUrl(extractInviteeUrl(mock.sentPollEmails[0]!));

    const app = appWithMockCalendar();
    const ON: Env = { ...(env as unknown as Env), MEETING_POLL_ENABLED: "true" };
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);

    expect(res.status).toBe(200);
  });
});

describe("dispatchScheduled — POLL_CRON", () => {
  it("is inert when MEETING_POLL_ENABLED is not 'true' (mirrors WEEKLY_CRON_ENABLED)", async () => {
    const pollSweep = vi.fn(async () => ({ checked: 0, deadlineProcessed: 0, nudgedFinal: 0, nudgedMidpoint: 0, failed: 0 }));
    __setHandlersForTests({ monday: vi.fn(), cleanup: vi.fn(), pollSweep });

    await dispatchScheduled(
      { cron: POLL_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, MEETING_POLL_ENABLED: undefined },
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );

    expect(pollSweep).not.toHaveBeenCalled();
  });

  it("dispatches to the injected pollSweep handler when the flag is 'true'", async () => {
    const pollSweep = vi.fn(async () => ({ checked: 0, deadlineProcessed: 0, nudgedFinal: 0, nudgedMidpoint: 0, failed: 0 }));
    __setHandlersForTests({ monday: vi.fn(), cleanup: vi.fn(), pollSweep });

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: POLL_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, MEETING_POLL_ENABLED: "true" },
      {
        waitUntil: (p: Promise<unknown>) => {
          tasks.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);

    expect(pollSweep).toHaveBeenCalledTimes(1);
  });
});
