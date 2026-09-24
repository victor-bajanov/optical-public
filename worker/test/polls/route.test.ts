import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
// test/setup.ts's shared migration list is out of T11's file fence, same
// reasoning db.test.ts already documents for 0032. Applying 0033 here,
// additively, is idempotent per applyD1Migrations' own contract.
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import joinAttemptsSql from "../../migrations/0034_poll_join_attempts.sql?raw";
import { mountPollRoutes, __setMaybeBookOnAllInForTests } from "../../src/polls/route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { saveBookingPage } from "../../src/db/booking-page";
import {
  createPoll,
  insertInvitee,
  newInviteeId,
  setHideName,
  dropInvitee,
  setPollStatus,
  getPoll,
  type Poll,
} from "../../src/db/polls";
import { signCapabilityWithEnv } from "../../src/auth/capability";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { POLL_CLIENT_HASH } from "../../src/polls/poll-client-source.generated";
import { POLL_PAGE_CSP, POLL_JOIN_PAGE_CSP } from "../../src/polls/page";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";
import type { BusinessHours } from "../../src/planning/solver-contract";

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const OWNER = "poll-owner@org";
// Near-round-the-clock, every day: the grid/response handlers always use the
// REAL current time (no injected `now`), so tests need a window that is
// guaranteed to have candidates regardless of which wall-clock instant the
// suite actually runs at — the same reason booking/route.test.ts computes
// slots live via firstSlot() rather than hard-coding dates.
const ALL_DAY_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  start: "00:00",
  end: "23:45",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function appWith(provider: MockCalendarProvider, notification?: MockNotificationProvider): App {
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", provider);
    if (notification) c.set("notificationProvider", notification);
    await next();
  });
  mountPollRoutes(app);
  return app;
}

const TEST_ENV = env as unknown as Env;
const ON: Env = { ...TEST_ENV, MEETING_POLL_ENABLED: "true", TURNSTILE_SECRET: "s" };
const OFF: Env = { ...ON, MEETING_POLL_ENABLED: "false" };

async function seedPoll(over: Partial<Parameters<typeof createPoll>[1]> = {}, guestSecret?: string) {
  const now = new Date();
  const rangeStart = isoDate(now);
  const rangeEnd = isoDate(new Date(now.getTime() + 60 * 86_400_000));
  const deadlineUtc = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  const guestTokenHash = guestSecret ? await hashToken(guestSecret, hashingKey(TEST_ENV)) : null;
  return createPoll(env.DB, {
    subject: OWNER,
    title: "Weekly sync",
    durationMin: 30,
    rangeStart,
    rangeEnd,
    deadlineUtc,
    location: { kind: "meet" },
    guestTokenHash,
    now: now.toISOString(),
    ...over,
  });
}

async function seedInvitee(
  poll: Poll,
  email: string,
  opts: { name?: string | null; kind?: "invited" | "guest"; hideName?: boolean; dropped?: boolean; pseudonym?: string } = {},
) {
  const inviteeId = newInviteeId();
  const token = await signCapabilityWithEnv(
    { purpose: "poll-response", pollId: poll.id, inviteeId, subject: poll.subject, ttlSeconds: 3600 },
    TEST_ENV,
  );
  const tokenHash = await hashToken(token, hashingKey(TEST_ENV));
  const invitee = await insertInvitee(env.DB, {
    id: inviteeId,
    pollId: poll.id,
    email,
    name: opts.name === undefined ? "Sam" : opts.name,
    kind: opts.kind ?? "invited",
    tokenHash,
    pseudonym: opts.pseudonym ?? `curious-${Math.random().toString(36).slice(2)}`,
    now: new Date().toISOString(),
  });
  if (opts.hideName) await setHideName(env.DB, invitee.id, true);
  if (opts.dropped) await dropInvitee(env.DB, invitee.id);
  return { invitee, token };
}

function turnstileVerdict(success: boolean, hostname = "localhost") {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ success, hostname }), { status: 200 }),
  );
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] },
    { name: "0034_poll_join_attempts.sql", queries: [joinAttemptsSql] },
  ]);
});

beforeEach(async () => {
  for (const t of ["polls", "poll_invitees", "poll_responses", "poll_join_attempts", "config_booking_page"]) {
    await env.DB.prepare(
      t === "poll_responses" || t === "poll_invitees" || t === "poll_join_attempts"
        ? `DELETE FROM ${t}`
        : t === "config_booking_page"
          ? `DELETE FROM ${t} WHERE owner_subject = ?`
          : `DELETE FROM ${t} WHERE subject = ?`,
    )
      .bind(...(t === "poll_responses" || t === "poll_invitees" || t === "poll_join_attempts" ? [] : [OWNER]))
      .run();
  }
  await saveBookingPage(env.DB, OWNER, {
    enabled: true,
    hours: ALL_DAY_HOURS,
    horizon_days: 90,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
  turnstileVerdict(true);
  __setMaybeBookOnAllInForTests(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  __setMaybeBookOnAllInForTests(null);
});

describe("feature flag", () => {
  it("404s every poll route when MEETING_POLL_ENABLED is not exactly 'true'", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const routes: Array<[string, RequestInit?]> = [
      [`/poll/${poll.id}?t=${encodeURIComponent(token)}`],
      [`/poll/_static/poll.${POLL_CLIENT_HASH}.js`],
      [`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`],
      [`/poll/${poll.id}/response?t=${encodeURIComponent(token)}`, { method: "PUT", body: "{}" }],
      [`/poll/${poll.id}/join`, { method: "POST", body: "{}" }],
      [`/poll/${poll.id}/status`, { headers: { Authorization: "Bearer whatever" } }],
    ];
    for (const [path, init] of routes) {
      const res = await app.request(path, init ?? {}, OFF);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});

describe("GET /poll/:id", () => {
  it("serves the invitee shell for a valid token", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Fix 1: bootstrap travels as data-* attributes, not an inline script
    // (which the CSP's script-src 'self' would silently refuse to run).
    expect(html).toContain(`data-poll-id="${poll.id}"`);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it("renders the content security policy and refuses to be framed", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.headers.get("content-security-policy")).toBe(POLL_PAGE_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("renders a friendly 200 'expired' page for a missing token, never a data leak", async () => {
    const poll = await seedPoll();
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}`, {}, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("__POLL__");
    expect(html.toLowerCase()).toContain("expired");
  });

  it("renders the same friendly page for a token signed for a DIFFERENT poll (IDOR)", async () => {
    const pollA = await seedPoll();
    const pollB = await seedPoll();
    const { token: tokenForB } = await seedInvitee(pollB, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${pollA.id}?t=${encodeURIComponent(tokenForB)}`, {}, ON);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("expired");
  });

  it("renders the friendly page for a dropped invitee's token", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { dropped: true });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("expired");
  });

  it("renders the friendly page for a tampered token", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?t=${encodeURIComponent(token)}x`, {}, ON);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("expired");
  });
});

describe("GET /poll/_static/poll.<hash>.js", () => {
  it("serves the client module immutably", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/_static/poll.${POLL_CLIENT_HASH}.js`, {}, ON);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("immutable");
  });

  it("404s for any other hash", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request("/poll/_static/poll.0123456789abcdef.js", {}, ON);
    expect(res.status).toBe(404);
  });
});

describe("GET /poll/:id/grid", () => {
  it("401s for an invalid or wrong-poll token", async () => {
    const pollA = await seedPoll();
    const pollB = await seedPoll();
    const { token: tokenForB } = await seedInvitee(pollB, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${pollA.id}/grid?t=${encodeURIComponent(tokenForB)}`, {}, ON);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("401s for a dropped invitee", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { dropped: true });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(401);
  });

  it("returns the exact open-poll contract shape", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["aggregate", "durationMin", "ownerTz", "paintableCells", "respondents", "you"].sort(),
    );
    expect(body.durationMin).toBe(30);
    expect(Array.isArray(body.paintableCells)).toBe(true);
    expect((body.paintableCells as string[]).length).toBeGreaterThan(0);
    expect(body.respondents).toEqual([{ label: "Sam", responded: false }]);
    expect(body.you).toEqual({ cells: [], hideName: false, name: "Sam" });
    // Organiser's IANA zone (decision D3 server half / M3 support) — no
    // per-user home_tz row seeded here, so this falls back to
    // env.SCHEDULER_TZ, same as getHomeTz's own fallback everywhere else.
    expect(body.ownerTz).toBe("Australia/Sydney");
  });

  it("aggregate cells carry viewer-appropriate who-is-free/if-needed labels (decision D3 / M1 hover-who)", async () => {
    const poll = await seedPoll();
    const { token: viewerToken } = await seedInvitee(poll, "viewer@x.com", { name: "Viewer" });
    await seedInvitee(poll, "hidden@x.com", {
      name: "Victoria Confidential", hideName: true, pseudonym: "curious sea otter",
    });
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(viewerToken)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const cellA = paintableCells[0]!;
    const cellB = paintableCells[1]!;
    expect(cellB).toBeTruthy();

    await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(viewerToken)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: cellA, state: "free" }], hideName: false, name: "Viewer" }),
      },
      ON,
    );

    // Paint the hidden invitee's cell directly via DB insert (no capability
    // token available for it here — seedInvitee's returned token is per-call
    // and was consumed for the viewer; the row's stored token_hash can't be
    // turned back into a bearer token).
    const hiddenInv = await env.DB.prepare("SELECT id FROM poll_invitees WHERE email = ?")
      .bind("hidden@x.com")
      .first<{ id: string }>();
    await env.DB.prepare("INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)")
      .bind(hiddenInv!.id, cellB, "if_needed")
      .run();

    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(viewerToken)}`, {}, ON);
    const body = (await res.json()) as {
      aggregate: Record<string, { free: number; ifNeeded: number; freeWho: string[]; ifNeededWho: string[] }>;
    };
    expect(body.aggregate[cellA]).toEqual({ free: 1, ifNeeded: 0, freeWho: ["Viewer"], ifNeededWho: [] });
    // Hidden invitee's WHO label is their pseudonym, never the real name —
    // same uniform rule as `respondents`, applied here too.
    expect(body.aggregate[cellB]).toEqual({ free: 0, ifNeeded: 1, freeWho: [], ifNeededWho: ["curious sea otter"] });
  });

  it("returns {status} for a non-open poll, nothing else", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    await setPollStatus(env.DB, poll.id, "booked", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "booked" });
  });

  it("returns {status:'cancelled'} for a cancelled poll", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    await setPollStatus(env.DB, poll.id, "cancelled", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(await res.json()).toEqual({ status: "cancelled" });
  });

  // Card B: a poll that escalated to needs_attention (no common slot) must
  // stay editable — invitees keep revising until the organiser books via
  // resolveMeetingPoll. Grid GET on a needs_attention poll must therefore
  // return the full grid payload, exactly like an open poll, not the
  // {status} shorthand reserved for booked/cancelled polls.
  it("Card B: returns the full grid payload (not {status}) for a needs_attention poll", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["aggregate", "durationMin", "ownerTz", "paintableCells", "respondents", "you"].sort(),
    );
  });

  it("never includes a hidden invitee's real name in another invitee's grid response", async () => {
    const poll = await seedPoll();
    await seedInvitee(poll, "hidden@x.com", { name: "Victoria Confidential", hideName: true, pseudonym: "curious sea otter" });
    const { token: viewerToken } = await seedInvitee(poll, "viewer@x.com", { name: "Viewer" });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(viewerToken)}`, {}, ON);
    const raw = await res.text();
    expect(raw).not.toContain("Victoria Confidential");
    expect(raw).toContain("curious sea otter");
    const body = JSON.parse(raw) as { respondents: Array<{ label: string }> };
    expect(body.respondents.map((r) => r.label).sort()).toEqual(["Viewer", "curious sea otter"]);
  });

  it("correction round R1-F5: a hidden invitee's position in the public arrays does not track their email's sort position", async () => {
    const poll = await seedPoll();
    // Five colleagues at one company with the usual firstname@ convention.
    // Dana hides her name; everyone else is shown by (identical) real name,
    // so the ONLY distinguishing signal left is array position.
    for (const e of ["alice@acme.com", "bob@acme.com", "erin@acme.com", "frank@acme.com"]) {
      await seedInvitee(poll, e, { name: "Sam" });
    }
    const { token: danaToken } = await seedInvitee(poll, "dana@acme.com", {
      name: "Dana", hideName: true, pseudonym: "quiet quokka",
    });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(danaToken)}`, {}, ON);
    const body = (await res.json()) as { respondents: Array<{ label: string }> };
    const labels = body.respondents.map((r) => r.label);
    // Sorted by EMAIL, dana@ (hidden) lands at index 2 (alice, bob, dana,
    // erin, frank) — a viewer who knows their colleagues' addresses could
    // read that straight off the array. The fix orders the PUBLIC payload
    // by something decorrelated from email (pseudonym), so this must not be
    // index 2.
    expect(labels.indexOf("quiet quokka")).not.toBe(2);
  });

  it("502s, not 500s, when the calendar is unreachable", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const provider = new MockCalendarProvider({ events: [] });
    provider.fetchEventsInWindow = async () => {
      throw new Error("google down");
    };
    const app = appWith(provider);
    const res = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(502);
  });
});

describe("PUT /poll/:id/response", () => {
  it("401s for an invalid token", async () => {
    const poll = await seedPoll();
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/response?t=nope`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cells: [], hideName: false, name: "x" }) },
      ON,
    );
    expect(res.status).toBe(401);
  });

  it("409s once the deadline has passed, leaving previously-saved cells untouched", async () => {
    const poll = await seedPoll({ deadlineUtc: new Date(Date.now() - 60_000).toISOString() });
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const saved = { cellStartUtc: "2099-01-01T00:00:00.000Z", state: "free" as const };
    // Seed an existing saved response directly (grid GET has no deadline gate,
    // but we want the PRE-deadline state on the row regardless of that).
    const inviteeRow = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(inviteeRow!.id, saved.cellStartUtc, saved.state)
      .run();

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "poll_closed" });

    const rows = await env.DB.prepare("SELECT cell_start_utc, state FROM poll_responses WHERE invitee_id = ?")
      .bind(inviteeRow!.id)
      .all<{ cell_start_utc: string; state: string }>();
    expect(rows.results).toEqual([{ cell_start_utc: saved.cellStartUtc, state: saved.state }]);
  });

  it("400s when a submitted cell is outside the paintable set", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const offender = "1970-01-01T00:00:00.000Z"; // guaranteed outside any poll range
    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: offender, state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; cells: string[] };
    expect(body.error).toBe("cell_not_paintable");
    expect(body.cells).toEqual([offender]);
  });

  it("saves a valid paint and returns the fresh grid payload", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const cell = paintableCells[0]!;

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell, state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: { cells: Array<{ cell: string; state: string }> }; respondents: Array<{ responded: boolean }> };
    expect(body.you.cells).toEqual([{ cell, state: "free" }]);
    expect(body.respondents).toEqual([{ label: "Sam", responded: true }]);
  });

  it("persists a changed name, reflected in the response's own payload and on the next GET", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const putRes = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cells: [{ cell: paintableCells[0], state: "free" }],
          hideName: false,
          name: "Samantha",
        }),
      },
      ON,
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { you: { name: string }; respondents: Array<{ label: string }> };
    expect(putBody.you.name).toBe("Samantha");
    expect(putBody.respondents).toEqual([{ label: "Samantha", responded: true }]);

    // Organiser-visible row: the raw poll_invitees.name column, independent
    // of the invitee-facing grid payload's own re-derivation.
    const row = await env.DB.prepare("SELECT name FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ name: string }>();
    expect(row?.name).toBe("Samantha");

    const nextGrid = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const nextBody = (await nextGrid.json()) as { you: { name: string } };
    expect(nextBody.you.name).toBe("Samantha");
  });

  it("L8: an empty trimmed name does not overwrite a previously stored name", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Original Name" });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Whitespace-only name: trims to empty, must not blank the stored name.
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "   " }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: { name: string } };
    expect(body.you.name).toBe("Original Name");

    const row = await env.DB.prepare("SELECT name FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ name: string }>();
    expect(row?.name).toBe("Original Name");
  });

  it("revising replaces the previous selection rather than adding to it", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const [first, second] = paintableCells;
    expect(second).toBeTruthy();

    async function put(cells: Array<{ cell: string; state: string }>) {
      return app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cells, hideName: false, name: "Sam" }),
        },
        ON,
      );
    }

    await put([{ cell: first!, state: "free" }]);
    const second_res = await put([{ cell: second!, state: "if_needed" }]);
    const body = (await second_res.json()) as { you: { cells: Array<{ cell: string; state: string }> } };
    expect(body.you.cells).toEqual([{ cell: second, state: "if_needed" }]);
  });

  it("400s on an invalid state", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "maybe" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(400);
  });

  it("400s a payload that repeats one cell with two different states, writing nothing", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const cell = paintableCells[0]!;

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cells: [{ cell, state: "free" }, { cell, state: "if_needed" }],
          hideName: false,
          name: "Sam",
        }),
      },
      ON,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    const inviteeRow = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ id: string }>();
    const rows = await env.DB.prepare("SELECT 1 FROM poll_responses WHERE invitee_id = ?")
      .bind(inviteeRow!.id)
      .all();
    expect(rows.results).toEqual([]);
  });

  it("400s a PUT carrying more cells than the response body ever plausibly needs", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const cells = Array.from({ length: 4001 }, (_, i) => ({ cell: `bogus-${i}`, state: "free" }));

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells, hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns {status} without applying the write once the poll is no longer open", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    await setPollStatus(env.DB, poll.id, "cancelled", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
  });

  // Card B regression (review finding B-R3): a BOOKED poll (unlike
  // needs_attention) must stay closed to invitee writes — booking already
  // happened, there is nothing left to revise. The {status} shorthand
  // response alone doesn't prove the write path was actually skipped, so
  // this also checks the DB directly, same style as the poll_closed test
  // above (:435-468) — no response row written, and the invitee's name
  // (seeded as null, PUT posts "Sam") left untouched.
  it("Card B regression: returns {status:'booked'} without applying the write once the poll is booked", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: null });
    await setPollStatus(env.DB, poll.id, "booked", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "booked" });

    const inviteeRow = await env.DB.prepare("SELECT id, name FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ id: string; name: string | null }>();
    expect(inviteeRow?.name).toBeNull();
    const rows = await env.DB.prepare("SELECT cell_start_utc, state FROM poll_responses WHERE invitee_id = ?")
      .bind(inviteeRow!.id)
      .all<{ cell_start_utc: string; state: string }>();
    expect(rows.results).toEqual([]);
  });

  it("calls the all-in booking hook after a successful save, without failing the save if the hook throws", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const calls: Array<{ env: unknown; pollId: string }> = [];
    __setMaybeBookOnAllInForTests(async (hookEnv, pollId) => {
      calls.push({ env: hookEnv, pollId });
      throw new Error("boom");
    });

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ env: expect.anything(), pollId: poll.id }]);
  });

  describe("a saved cell that has since left the live paintable region", () => {
    /** Saves cells A and B while both are paintable, then busies out exactly
     *  B's slot on the SAME provider instance (appWith wires one provider
     *  into every request on this `app`, so a later call sees the change). */
    async function setupWithStaleB() {
      const poll = await seedPoll();
      const { token } = await seedInvitee(poll, "a@x.com");
      const provider = new MockCalendarProvider({ events: [] });
      const app = appWith(provider);

      const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
      const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
      const [a, b] = paintableCells;
      expect(b).toBeTruthy();

      const save = await app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cells: [{ cell: a!, state: "free" }, { cell: b!, state: "free" }],
            hideName: false,
            name: "Sam",
          }),
        },
        ON,
      );
      expect(save.status).toBe(200);

      provider.injectExternalEvent({
        id: "now-busy",
        summary: "organiser calendar filled in",
        start: b!,
        end: new Date(Date.parse(b!) + 30 * 60_000).toISOString(),
      });

      return { poll, token, app, a: a!, b: b! };
    }

    it("silently drops the stale cell and keeps the rest on an identical resubmission", async () => {
      const { poll, token, app, a, b } = await setupWithStaleB();

      const resubmit = await app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cells: [{ cell: a, state: "free" }, { cell: b, state: "free" }],
            hideName: false,
            name: "Sam",
          }),
        },
        ON,
      );
      expect(resubmit.status).toBe(200);
      const body = (await resubmit.json()) as { you: { cells: Array<{ cell: string }> } };
      expect(body.you.cells.map((c) => c.cell)).toEqual([a]);
    });

    it("still 400s a genuinely fresh unpaintable cell, without blaming the stale-but-saved one", async () => {
      const { poll, token, app, a, b } = await setupWithStaleB();
      const fresh = "1970-01-01T00:00:00.000Z";

      const resubmit = await app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cells: [{ cell: a, state: "free" }, { cell: b, state: "free" }, { cell: fresh, state: "free" }],
            hideName: false,
            name: "Sam",
          }),
        },
        ON,
      );
      expect(resubmit.status).toBe(400);
      const body = (await resubmit.json()) as { error: string; cells: string[] };
      expect(body.error).toBe("cell_not_paintable");
      expect(body.cells).toEqual([fresh]);
    });

    it("a hide-name-only resubmission of the same stale selection still succeeds", async () => {
      const { poll, token, app, a, b } = await setupWithStaleB();

      const resubmit = await app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cells: [{ cell: a, state: "free" }, { cell: b, state: "free" }],
            hideName: true,
            name: "Sam",
          }),
        },
        ON,
      );
      expect(resubmit.status).toBe(200);
      const body = (await resubmit.json()) as { you: { hideName: boolean } };
      expect(body.you.hideName).toBe(true);
    });
  });
});

describe("PUT /poll/:id/response — organiser notification (T-notify)", () => {
  it("emails the organiser naming the respondent, marking a first response, with the response count", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    await seedInvitee(poll, "b@x.com", { name: "Jamie" }); // never responds — still counts in the denominator
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);

    expect(notification.sentPollEmails).toHaveLength(1);
    const email = notification.sentPollEmails[0]!;
    expect(email.to).toBe(OWNER);
    expect(email.text).toContain("Sam");
    expect(email.text).toContain("1 of 2");
  });

  it("does NOT email the organiser again for an immediate second save from the same invitee (cooldown active, finding 1)", async () => {
    // defaultNotificationProvider sends AS the organiser, through their own
    // account's send quota — without a cooldown, an invitee holding a live
    // response token could loop PUT /response to burn through it. The first
    // save is a genuine first response and always notifies; a second save
    // moments later must not.
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    async function put(cell: string) {
      return app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cells: [{ cell, state: "free" }], hideName: false, name: "Sam" }),
        },
        ON,
      );
    }

    const first = await put(paintableCells[0]!);
    const second = await put(paintableCells[1]!);
    // The save itself is never affected by the notification cooldown.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.text.toLowerCase()).not.toContain("updated");
  });

  it("DOES email the organiser for an update once the per-invitee cooldown has elapsed, marked as an update (finding 1)", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    async function put(cell: string) {
      return app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cells: [{ cell, state: "free" }], hideName: false, name: "Sam" }),
        },
        ON,
      );
    }

    await put(paintableCells[0]!);
    expect(notification.sentPollEmails).toHaveLength(1);

    // Age the invitee's stored respondedAt past the 15-minute quiet period
    // directly in D1 — the handler always reads the real wall clock (no
    // injected `now`), so this simulates a genuinely later update without
    // needing to fake time. `respondedAt` is the invitee's last SAVE time
    // (markResponded stamps it on every save, notified or not — see
    // RESPONSE_NOTIFY_COOLDOWN_MS's own comment), so backdating it here
    // simulates "this invitee hasn't touched their response in 20 minutes",
    // which is exactly the condition the gate checks. No new column or
    // migration needed either way.
    const inviteeRow = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ id: string }>();
    const staleRespondedAt = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago > 15 min quiet period
    await env.DB.prepare("UPDATE poll_invitees SET responded_at = ? WHERE id = ?")
      .bind(staleRespondedAt, inviteeRow!.id)
      .run();

    await put(paintableCells[1]!);

    expect(notification.sentPollEmails).toHaveLength(2);
    expect(notification.sentPollEmails[1]!.text.toLowerCase()).toContain("updated");
    // Still the same single (non-dropped) invitee — "1 of 1", not "2 of 1".
    expect(notification.sentPollEmails[1]!.text).toContain("1 of 1");
  });

  it("sliding-window pin: a continuously-revising invitee gets exactly ONE email total, and respondedAt keeps moving forward on suppressed saves (finding 1 follow-up)", async () => {
    // Proves the gate is a QUIET-PERIOD DEBOUNCE against the invitee's last
    // SAVE: respondedAt moves forward on every save (suppressed ones
    // included), so 10-minute-spaced saves never open a ≥15-minute gap and
    // never notify again. Pins the unconditional markResponded stamp — a
    // "fix" making it stamp only on notified saves would freeze the column
    // at the backdated value and turn the monotonicity assertion red.
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    expect(paintableCells.length).toBeGreaterThanOrEqual(5);

    async function put(cell: string) {
      return app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cells: [{ cell, state: "free" }], hideName: false, name: "Sam" }),
        },
        ON,
      );
    }

    async function respondedAtOf(): Promise<string> {
      const row = await env.DB.prepare("SELECT responded_at FROM poll_invitees WHERE poll_id = ?")
        .bind(poll.id)
        .first<{ responded_at: string }>();
      return row!.responded_at;
    }

    async function backdateRespondedAtBy(minutesAgo: number): Promise<void> {
      const inviteeRow = await env.DB.prepare("SELECT id FROM poll_invitees WHERE poll_id = ?")
        .bind(poll.id)
        .first<{ id: string }>();
      await env.DB.prepare("UPDATE poll_invitees SET responded_at = ? WHERE id = ?")
        .bind(new Date(Date.now() - minutesAgo * 60_000).toISOString(), inviteeRow!.id)
        .run();
    }

    // save #1: the real first response — always notifies.
    await put(paintableCells[0]!);
    expect(notification.sentPollEmails).toHaveLength(1);
    const respondedAtAfterFirst = await respondedAtOf();

    // save #2, simulated +10min after save #1 (well inside the 15-minute
    // quiet period measured from the PREVIOUS SAVE): suppressed. Backdate
    // respondedAt to 10 minutes ago first so this save's pre-save snapshot
    // reads as "last saved 10 minutes ago", the same as if 10 real minutes
    // had passed since save #1.
    await backdateRespondedAtBy(10);
    await put(paintableCells[1]!);
    expect(notification.sentPollEmails).toHaveLength(1); // still just the first-response email
    const respondedAtAfterSecond = await respondedAtOf();
    // markResponded stamps on EVERY save, suppressed or not — the row must
    // have moved forward even though no email went out for this save.
    expect(Date.parse(respondedAtAfterSecond)).toBeGreaterThan(Date.parse(respondedAtAfterFirst));

    // saves #3 and #4, each simulated +10min after the PREVIOUS save (not
    // cumulative from save #1) — if the gate were measuring against the
    // first email's timestamp, by save #4 (~30 "minutes" after save #1)
    // it would have crossed 15 minutes and fired again. It must not: every
    // gap here is measured from a save, and every gap is only 10 minutes.
    await backdateRespondedAtBy(10);
    await put(paintableCells[2]!);
    expect(notification.sentPollEmails).toHaveLength(1);

    // Exactly one email total across a continuous ~40-minute burst of saves,
    // all suppressed after the first — not a digest, not a periodic resend.
    await backdateRespondedAtBy(10);
    await put(paintableCells[3]!);
    expect(notification.sentPollEmails).toHaveLength(1);
  });

  it("does not fail the save when the notification provider throws", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    const notification = new MockNotificationProvider();
    notification.sendPollEmail = async () => {
      throw new Error("smtp unavailable");
    };
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: { cells: Array<{ cell: string }> } };
    expect(body.you.cells).toHaveLength(1);
    expect(consoleErr).toHaveBeenCalled();

    consoleErr.mockRestore();
  });

  it("excludes a dropped invitee from the response count's denominator", async () => {
    const poll = await seedPoll();
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    await seedInvitee(poll, "b@x.com", { name: "Jamie", dropped: true });
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );

    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.text).toContain("1 of 1");
  });
});

// Card B: a poll that escalated to needs_attention (no common slot) must
// stay editable — any invitee can revise availability until the organiser
// books via the existing resolveMeetingPoll call. The PUT deadline gate
// exists only to stop invitees racing the cron's bookAtDeadline for OPEN
// polls, so it must not apply here; nor may a save on a needs_attention
// poll auto-book (that stays the organiser's manual call) — but the
// organiser response-saved notification must still fire so the organiser
// learns there's something new to look at.
/** Wraps a real D1Database so that the FIRST statement whose SQL starts
 *  with `triggerSqlPrefix` runs `onTrigger()` (against the SAME real DB,
 *  simulating a sibling request's concurrent write) immediately before its
 *  own `.run()` actually executes — everything else passes straight
 *  through to the real statement/binding, `this`-bound correctly via
 *  Proxy (a plain object spread would silently break D1's internal
 *  binding-object identity). Used by the B-R1 race test below to land a
 *  status change in the gap between the PUT handler's initial snapshot
 *  read and its later all-in gate check. */
function interceptFirstRun(realDb: D1Database, triggerSqlPrefix: string, onTrigger: () => Promise<void>): D1Database {
  let triggered = false;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.startsWith(triggerSqlPrefix)) return stmt;
          return new Proxy(stmt, {
            get(stmtTarget, stmtProp) {
              if (stmtProp === "bind") {
                return (...bindArgs: unknown[]) => {
                  const bound = stmtTarget.bind(...bindArgs);
                  return new Proxy(bound, {
                    get(boundTarget, boundProp) {
                      if (boundProp === "run") {
                        return async (...runArgs: unknown[]) => {
                          if (!triggered) {
                            triggered = true;
                            await onTrigger();
                          }
                          return (boundTarget.run as (...a: unknown[]) => unknown)(...runArgs);
                        };
                      }
                      const val = Reflect.get(boundTarget, boundProp);
                      return typeof val === "function" ? val.bind(boundTarget) : val;
                    },
                  });
                };
              }
              const val = Reflect.get(stmtTarget, stmtProp);
              return typeof val === "function" ? val.bind(stmtTarget) : val;
            },
          });
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

describe("PUT /poll/:id/response — needs_attention unlock (Card B)", () => {
  // Review finding B-R1: the `poll.status === "open"` gate before
  // fireMaybeBookOnAllIn reads the SNAPSHOT captured by resolveInvitee at
  // the top of the handler. Between that read and the gate sit a live
  // calendar fetch and four DB writes — if a SIBLING invitee's save
  // escalates the poll to needs_attention somewhere in that window, this
  // request's stale snapshot still says "open" and still fires the hook,
  // and maybeBookOnAllIn's own re-read deliberately admits needs_attention
  // (the dropInvitee rescue path), so it can book an escalated poll —
  // exactly what the unlock promises never happens. `markResponded`'s
  // `UPDATE poll_invitees SET responded_at = ?` write is the last write
  // before the gate, so intercepting IT to land the sibling's escalation
  // lands it as late as possible in the window — the tightest version of
  // the race the fix must close.
  it("B-R1: does not fire the all-in hook when a SIBLING save escalates the poll mid-request (stale-snapshot race)", async () => {
    const poll = await seedPoll({ deadlineUtc: new Date(Date.now() + 3600_000).toISOString() });
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    const calls: Array<{ pollId: string }> = [];
    __setMaybeBookOnAllInForTests(async (_hookEnv, pollId) => {
      calls.push({ pollId });
    });

    const app = appWith(new MockCalendarProvider({ events: [] }));
    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const racyEnv: Env = {
      ...ON,
      DB: interceptFirstRun(env.DB, "UPDATE poll_invitees SET responded_at = ?", async () => {
        // Simulates a sibling invitee's concurrent save escalating this
        // same poll, landing between this request's initial snapshot and
        // its all-in gate check.
        await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
      }),
    };

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      racyEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: { cells: Array<{ cell: string; state: string }> } };
    expect(body.you.cells).toEqual([{ cell: paintableCells[0], state: "free" }]);
    expect(calls).toEqual([]);
  });

  it("saves successfully past the deadline once the poll has escalated to needs_attention", async () => {
    const poll = await seedPoll({ deadlineUtc: new Date(Date.now() - 60_000).toISOString() });
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    expect(gridRes.status).toBe(200);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    expect(paintableCells.length).toBeGreaterThan(0);

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: { cells: Array<{ cell: string; state: string }> } };
    expect(body.you.cells).toEqual([{ cell: paintableCells[0], state: "free" }]);
  });

  it("does not invoke the all-in booking hook — booking stays the organiser's manual resolveMeetingPoll call", async () => {
    const poll = await seedPoll({ deadlineUtc: new Date(Date.now() - 60_000).toISOString() });
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const calls: Array<{ pollId: string }> = [];
    __setMaybeBookOnAllInForTests(async (_hookEnv, pollId) => {
      calls.push({ pollId });
    });

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("still fires the organiser response-saved notification (debounce rules unchanged)", async () => {
    const poll = await seedPoll({ deadlineUtc: new Date(Date.now() - 60_000).toISOString() });
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe(OWNER);
    expect(notification.sentPollEmails[0]!.text).toContain("Sam");
  });

  // Review finding B-R5 (pin, coverage): every test above uses a PAST
  // deadline, so an implementation that gated the all-in hook on
  // `Date.now() < poll.deadlineUtc` instead of `poll.status === "open"`
  // would pass the whole suite above — a needs_attention poll with a
  // FUTURE deadline would slip through such a wrong implementation and
  // still fire the hook. This poll also carries a guestTokenHash (the
  // guest-link case Card C's own gate cares about) so this pins the
  // status check independently of that mechanism too. Green on current
  // (correct, status-gated) code — this is a pin, not a red/green pair.
  it("B-R5 pin: needs_attention with a FUTURE deadline and a guest link still skips the all-in hook (kills a deadline-based gate)", async () => {
    const poll = await seedPoll({}, "guest-secret"); // default +90d deadline, non-null guestTokenHash
    const { token } = await seedInvitee(poll, "a@x.com", { name: "Sam" });
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const calls: Array<{ pollId: string }> = [];
    __setMaybeBookOnAllInForTests(async (_hookEnv, pollId) => {
      calls.push({ pollId });
    });

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };

    const res = await app.request(
      `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cells: [{ cell: paintableCells[0], state: "free" }], hideName: false, name: "Sam" }),
      },
      ON,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: { cells: Array<{ cell: string; state: string }> } };
    expect(body.you.cells).toEqual([{ cell: paintableCells[0], state: "free" }]);
    expect(calls).toEqual([]);
  });
});

// Card B optional stretch: the organiser status page's candidate ranking
// (route.ts's GET /poll/:id/status) should also run for a needs_attention
// poll — matching getMeetingPoll's own `open || needs_attention` gate
// (handlers/polls.ts:633) — so a slot that becomes fully covered again
// after invitees revise (Card B's unlock) actually shows up before the
// organiser re-resolves the poll, instead of a permanent "No candidate
// times yet." until status flips back to open.
describe("GET /poll/:id/status — candidates for needs_attention (Card B stretch)", () => {
  async function mintStatusToken(pollId: string, subject: string) {
    return signCapabilityWithEnv({ purpose: "poll-status", pollId, subject, ttlSeconds: 3600 }, TEST_ENV);
  }

  it("computes and renders top candidates for a needs_attention poll once a slot has full coverage again", async () => {
    const poll = await seedPoll();
    const { token: tokenA } = await seedInvitee(poll, "a@x.com", { name: "Ash" });
    const { token: tokenB } = await seedInvitee(poll, "b@x.com", { name: "Bo" });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    // Never actually books here — this test is only about what the status
    // page COMPUTES/RENDERS, not the booking machinery.
    __setMaybeBookOnAllInForTests(async () => {});

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(tokenA)}`, {}, ON);
    const { paintableCells } = (await gridRes.json()) as { paintableCells: string[] };
    const cell = paintableCells[0]!;

    async function put(token: string, name: string) {
      return app.request(
        `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cells: [{ cell, state: "free" }], hideName: false, name }),
        },
        ON,
      );
    }
    expect((await put(tokenA, "Ash")).status).toBe(200);
    expect((await put(tokenB, "Bo")).status).toBe(200);

    // Simulate the poll having previously escalated (e.g. before this
    // revision) — the status stays needs_attention until the organiser
    // re-resolves, even though there is now a fully-covered slot.
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());

    const statusToken = await mintStatusToken(poll.id, OWNER);
    const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(statusToken)}`, {}, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("No candidate times yet.");
    // Not just `toContain("score")` — the STYLE block's `.score{…}` rule is
    // present on every status page regardless of candidates, which would
    // make that assertion pass unconditionally (review finding B-R2). This
    // matches the actual candidate markup emitted by
    // poll-status-page.ts's candidatesList (`<span class="score">score `).
    expect(html).toContain('<span class="score">score ');
  });
});

describe("GET /poll/:id?g= (guest join form)", () => {
  it("renders the real join form for a valid guest token", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?g=shared-secret`, {}, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/poll/${poll.id}/join"`);
    expect(html).toContain('name="guestToken" value="shared-secret"');
    expect(html).toContain("cf-turnstile");
  });

  it("renders the join-page CSP, not the invitee-page CSP", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?g=shared-secret`, {}, ON);
    expect(res.headers.get("content-security-policy")).toBe(POLL_JOIN_PAGE_CSP);
  });

  it("still 200s the friendly expired page for a wrong guest token", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(`/poll/${poll.id}?g=wrong`, {}, ON);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("expired");
  });
});

describe("POST /poll/:id/join", () => {
  it("404s when the poll has no guest link enabled", async () => {
    const poll = await seedPoll(); // no guestSecret -> guestTokenHash null
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ name: "Guest", email: "g@x.com", turnstileToken: "tok", guestToken: "whatever" }),
      },
      ON,
    );
    expect(res.status).toBe(404);
  });

  it("creates a guest invitee, returns 202 {sent:true} — never a url — and emails a working personal link", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ name: "Guest Gary", email: "gary@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
      },
      ON,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });

    expect(notification.sentPollEmails).toHaveLength(1);
    const email = notification.sentPollEmails[0]!;
    expect(email.to).toBe("gary@x.com");
    const linkMatch = email.html.match(new RegExp(`/poll/${poll.id}\\?t=([^"&]+)`));
    expect(linkMatch).toBeTruthy();
    const personalToken = decodeURIComponent(linkMatch![1]!);

    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(personalToken)}`, {}, ON);
    expect(gridRes.status).toBe(200);
    const body = (await gridRes.json()) as { you: { name: string } };
    expect(body.you.name).toBe("Guest Gary");
  });

  it("403s and creates no invitee when Turnstile rejects the token", async () => {
    const poll = await seedPoll({}, "shared-secret");
    turnstileVerdict(false);
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ name: "Guest", email: "g@x.com", turnstileToken: "bad", guestToken: "shared-secret" }),
      },
      ON,
    );
    expect(res.status).toBe(403);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("404s for a guest token that does not match the poll's guest link", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ name: "Guest", email: "g@x.com", turnstileToken: "tok", guestToken: "wrong" }),
      },
      ON,
    );
    expect(res.status).toBe(404);
  });

  it("a duplicate email gets the IDENTICAL 202 {sent:true} response — no membership oracle — and is re-emailed a working link", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);
    const join = (ip: string) =>
      app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({ name: "Guest", email: "dup@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
    const first = await join("1.1.1.1");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ sent: true });
    // A different IP for the second call so the per-IP rate limit (tested
    // separately below) can't be what's producing an identical status here.
    const second = await join("2.2.2.2");
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ sent: true });

    // Exactly one invitee row — the duplicate path never inserts a second.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ? AND email = ?")
      .bind(poll.id, "dup@x.com")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // Both attempts emailed dup@x.com a working link (re-issued on the
    // second, so the invitee can always click their MOST RECENT email).
    expect(notification.sentPollEmails).toHaveLength(2);
    expect(notification.sentPollEmails.every((e) => e.to === "dup@x.com")).toBe(true);
    const lastEmail = notification.sentPollEmails[1]!;
    const linkMatch = lastEmail.html.match(new RegExp(`/poll/${poll.id}\\?t=([^"&]+)`));
    const personalToken = decodeURIComponent(linkMatch![1]!);
    const gridRes = await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(personalToken)}`, {}, ON);
    expect(gridRes.status).toBe(200);
  });

  it("once the per-poll guest cap is reached, a new guest is silently refused (202, no row) — see the R1-F3 correction-round block below for the anti-oracle assertions", async () => {
    const poll = await seedPoll({}, "shared-secret");
    for (let i = 0; i < 20; i++) {
      await seedInvitee(poll, `guest${i}@x.com`, { kind: "guest", pseudonym: `p-${i}` });
    }
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ name: "Guest", email: "onemore@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
      },
      ON,
    );
    // R1-F3 fix: the cap still functions as a circuit breaker, but the
    // response is now the same 202 {sent:true} as every other outcome — see
    // "correction round: R1-F3" below for the no-oracle assertions.
    expect(res.status).toBe(202);
    const row = await env.DB.prepare("SELECT 1 FROM poll_invitees WHERE poll_id = ? AND email = ?")
      .bind(poll.id, "onemore@x.com")
      .first();
    expect(row).toBeNull();
  });

  it("dropped guests do not count toward the per-poll cap", async () => {
    // The bug this closes: dropping an abusive guest used to RAISE the count
    // toward the cap (the row stays, only `dropped` flips), eventually
    // pinning the poll at a permanent 429 — the organiser's only remedy made
    // the problem worse.
    const poll = await seedPoll({}, "shared-secret");
    for (let i = 0; i < 20; i++) {
      await seedInvitee(poll, `guest${i}@x.com`, { kind: "guest", pseudonym: `p-${i}`, dropped: true });
    }
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ name: "Guest", email: "onemore@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
      },
      ON,
    );
    expect(res.status).toBe(202);
  });

  it("429s once the same IP's windowed join count is exceeded, even across different emails", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const join = (email: string) =>
      app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
          body: JSON.stringify({ name: "Guest", email, turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await join(`ratelimit${i}@x.com`)).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 202).length).toBeLessThan(6);
  });

  it("a different IP is not affected by another IP's rate limit", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const app = appWith(new MockCalendarProvider({ events: [] }));
    for (let i = 0; i < 6; i++) {
      await app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
          body: JSON.stringify({ name: "Guest", email: `burned${i}@x.com`, turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
    }
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "8.8.8.8" },
        body: JSON.stringify({ name: "Guest", email: "fresh@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
      },
      ON,
    );
    expect(res.status).toBe(202);
  });

  it("a plain HTML form submission (implicit Turnstile) gets a 200 confirmation page, not JSON", async () => {
    const poll = await seedPoll({}, "shared-secret");
    const notification = new MockNotificationProvider();
    const app = appWith(new MockCalendarProvider({ events: [] }), notification);
    const form = new URLSearchParams({
      name: "Form Guest",
      email: "formguest@x.com",
      "cf-turnstile-response": "tok",
      guestToken: "shared-secret",
    });
    const res = await app.request(
      `/poll/${poll.id}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "3.3.3.3" },
        body: form.toString(),
      },
      ON,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("check your email");
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.to).toBe("formguest@x.com");
  });

  describe("correction round: R1-F1/R4-H2 — already-invited arm bypassed the per-IP rate limit", () => {
    it("one IP hammering a KNOWN invitee's address is throttled, not unbounded", async () => {
      const poll = await seedPoll({}, "shared-secret");
      const { token: originalLink } = await seedInvitee(poll, "victim@x.com");
      const notification = new MockNotificationProvider();
      const app = appWith(new MockCalendarProvider({ events: [] }), notification);

      // The original link works right now.
      expect((await app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(originalLink)}`, {}, ON)).status).toBe(200);

      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await app.request(
          `/poll/${poll.id}/join`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": "6.6.6.6" },
            body: JSON.stringify({ name: "Attacker", email: "victim@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
          },
          ON,
        );
        statuses.push(res.status);
      }
      // The per-IP limit (5/24h) bites well before 25 attempts.
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(notification.sentPollEmails.length).toBeLessThanOrEqual(5);
    });
  });

  describe("correction round: R1-F6 half — a failed send must not log the guest's real address", () => {
    it("logs an identifier, never the raw email, when sendPollEmail throws", async () => {
      const poll = await seedPoll({}, "shared-secret");
      class ThrowingNotificationProvider extends MockNotificationProvider {
        override async sendPollEmail(): Promise<void> {
          throw new Error("gmail 503");
        }
      }
      const app = appWith(new MockCalendarProvider({ events: [] }), new ThrowingNotificationProvider());
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
          body: JSON.stringify({ name: "Guest", email: "sensitive-address@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
      expect(res.status).toBe(202); // send failure is logged and non-fatal
      const loggedText = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(loggedText).not.toContain("sensitive-address@x.com");
      errSpy.mockRestore();
    });
  });

  describe("correction round: R1-F2/R4-H3 — dropped-invitee block and duplicate-guard were case-sensitive", () => {
    it("a dropped guest cannot rejoin by capitalising their address", async () => {
      const poll = await seedPoll({}, "shared-secret");
      await seedInvitee(poll, "mallory@x.com", { kind: "guest", dropped: true });
      const notification = new MockNotificationProvider();
      const app = appWith(new MockCalendarProvider({ events: [] }), notification);

      const res = await app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
          body: JSON.stringify({ name: "Mallory", email: "Mallory@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
      expect(res.status).toBe(202); // identical response either way — no oracle

      const rows = await env.DB.prepare("SELECT dropped FROM poll_invitees WHERE poll_id = ?").bind(poll.id).all<{ dropped: number }>();
      expect(rows.results?.every((r) => r.dropped === 1)).toBe(true); // still zero LIVE invitees
      expect(notification.sentPollEmails).toHaveLength(0);
    });

    it("a case-variant of a live invitee's address does not create a duplicate", async () => {
      const poll = await seedPoll({}, "shared-secret");
      await seedInvitee(poll, "alice@x.com");
      const app = appWith(new MockCalendarProvider({ events: [] }), new MockNotificationProvider());
      await app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
          body: JSON.stringify({ name: "Alice", email: "ALICE@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ? AND dropped = 0")
        .bind(poll.id)
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
    });
  });

  describe("correction round: R1-F3 — guest-cap arm re-opened the membership oracle", () => {
    it("at cap, a member's response is indistinguishable from a stranger's", async () => {
      const poll = await seedPoll({}, "shared-secret");
      for (let i = 0; i < 20; i++) {
        await seedInvitee(poll, `guest${i}@x.com`, { kind: "guest", pseudonym: `p-${i}` });
      }
      const app = appWith(new MockCalendarProvider({ events: [] }), new MockNotificationProvider());
      const join = (email: string, ip: string) =>
        app.request(
          `/poll/${poll.id}/join`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": ip },
            body: JSON.stringify({ name: "G", email, turnstileToken: "tok", guestToken: "shared-secret" }),
          },
          ON,
        );
      const member = await join("guest3@x.com", "10.0.0.1");
      const stranger = await join("nobody@x.com", "10.0.0.2");
      expect(member.status).toBe(stranger.status);
      expect(await member.json()).toEqual(await stranger.json());
    });

    it("no invitee row is created for a stranger once the poll is at the guest cap", async () => {
      const poll = await seedPoll({}, "shared-secret");
      for (let i = 0; i < 20; i++) {
        await seedInvitee(poll, `guest${i}@x.com`, { kind: "guest", pseudonym: `p-${i}` });
      }
      const app = appWith(new MockCalendarProvider({ events: [] }), new MockNotificationProvider());
      await app.request(
        `/poll/${poll.id}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0.3" },
          body: JSON.stringify({ name: "G", email: "nobody@x.com", turnstileToken: "tok", guestToken: "shared-secret" }),
        },
        ON,
      );
      const row = await env.DB.prepare("SELECT 1 FROM poll_invitees WHERE poll_id = ? AND email = ?")
        .bind(poll.id, "nobody@x.com")
        .first();
      expect(row).toBeNull();
    });
  });

  describe("correction round: R4-L1 — flag-off / unknown-poll / bad-guest-token bypassed the HTML-aware path", () => {
    it("a form submitter with a bad guest token gets the HTML error page, not raw text", async () => {
      const poll = await seedPoll({}, "shared-secret");
      const app = appWith(new MockCalendarProvider({ events: [] }));
      const form = new URLSearchParams({ name: "G", email: "g@x.com", "cf-turnstile-response": "tok", guestToken: "wrong" });
      const res = await app.request(
        `/poll/${poll.id}/join`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.1.1.1" }, body: form.toString() },
        ON,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("a form submitter against a poll with no guest link gets the HTML error page", async () => {
      const poll = await seedPoll(); // no guestSecret
      const app = appWith(new MockCalendarProvider({ events: [] }));
      const form = new URLSearchParams({ name: "G", email: "g@x.com", "cf-turnstile-response": "tok", guestToken: "whatever" });
      const res = await app.request(
        `/poll/${poll.id}/join`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.1.1.1" }, body: form.toString() },
        ON,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("a form submitter gets the HTML error page when the feature flag is off", async () => {
      const poll = await seedPoll({}, "shared-secret");
      const app = appWith(new MockCalendarProvider({ events: [] }));
      const form = new URLSearchParams({ name: "G", email: "g@x.com", "cf-turnstile-response": "tok", guestToken: "shared-secret" });
      const res = await app.request(
        `/poll/${poll.id}/join`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.1.1.1" }, body: form.toString() },
        OFF,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("a JSON caller still gets the plain 404 (unchanged) for the same cases", async () => {
      const app = appWith(new MockCalendarProvider({ events: [] }));
      const res = await app.request(
        `/poll/p_does_not_exist/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
          body: JSON.stringify({ name: "G", email: "g@x.com", turnstileToken: "tok", guestToken: "whatever" }),
        },
        ON,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).not.toContain("text/html");
    });
  });
});
