import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
// Shared migration list (test/setup.ts) is out of T11's file fence — same
// reasoning route.test.ts and db.test.ts already document for 0032/0033.
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import { mountPollRoutes } from "../../src/polls/route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { saveBookingPage } from "../../src/db/booking-page";
import {
  createPoll,
  insertInvitee,
  newInviteeId,
  setHideName,
  setPollStatus,
  setBooked,
  type Poll,
} from "../../src/db/polls";
import { hashToken } from "../../src/auth/tokens";
import { signCapabilityWithEnv } from "../../src/auth/capability";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";
import type { BusinessHours } from "../../src/planning/solver-contract";

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const OWNER = "poll-owner@org";
const OTHER = "someone-else@org";

const ALL_DAY_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  start: "00:00",
  end: "23:45",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function appWith(provider = new MockCalendarProvider({ events: [] })): App {
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", provider);
    await next();
  });
  mountPollRoutes(app);
  return app;
}

async function seedBearer(token: string, subject: string) {
  // Same resolver api.test.ts already uses for handlers/polls.ts's own
  // requireOwner-gated routes — hashingKey(env) falls back to
  // TOKEN_HASH_PEPPER when HASHING_KEY is unset, which is how the test env
  // is configured, so this matches what requireBearer actually checks.
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

const TEST_ENV = env as unknown as Env;
const ON: Env = { ...TEST_ENV, MEETING_POLL_ENABLED: "true" };
const AUTH = { Authorization: "Bearer fake" };

async function seedPoll(over: Partial<Parameters<typeof createPoll>[1]> = {}) {
  const now = new Date();
  const rangeStart = isoDate(now);
  const rangeEnd = isoDate(new Date(now.getTime() + 60 * 86_400_000));
  const deadlineUtc = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  return createPoll(env.DB, {
    subject: OWNER,
    title: "Weekly sync",
    durationMin: 30,
    rangeStart,
    rangeEnd,
    deadlineUtc,
    location: { kind: "meet" },
    guestTokenHash: null,
    now: now.toISOString(),
    ...over,
  });
}

async function seedInvitee(
  poll: Poll,
  email: string,
  opts: { name?: string | null; kind?: "invited" | "guest"; hideName?: boolean; pseudonym?: string } = {},
) {
  const inviteeId = newInviteeId();
  const invitee = await insertInvitee(env.DB, {
    id: inviteeId,
    pollId: poll.id,
    email,
    name: opts.name === undefined ? "Sam" : opts.name,
    kind: opts.kind ?? "invited",
    tokenHash: `hash-${inviteeId}`,
    pseudonym: opts.pseudonym ?? `curious-${Math.random().toString(36).slice(2)}`,
    now: new Date().toISOString(),
  });
  if (opts.hideName) await setHideName(env.DB, invitee.id, true);
  return invitee;
}

// Isolates the aggregate <table class="agg"> itself, excluding the legend
// below it — the legend always carries one of each icon regardless of the
// seeded data, so assertions that must depend on the actual painted cells
// (not just "the legend rendered") need to be scoped to this slice.
function sliceAggTable(html: string): string {
  const start = html.indexOf('<table class="agg">');
  return html.slice(start, html.indexOf("</table>", start));
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, [{ name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] }]);
});

beforeEach(async () => {
  for (const t of ["polls", "poll_invitees", "poll_responses", "config_booking_page", "oauth_tokens"]) {
    await env.DB.prepare(
      t === "config_booking_page" ? `DELETE FROM ${t} WHERE owner_subject != '__default__'` : `DELETE FROM ${t}`,
    ).run();
  }
  await saveBookingPage(env.DB, OWNER, {
    enabled: true,
    hours: ALL_DAY_HOURS,
    horizon_days: 90,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
  await seedBearer("fake", OWNER);
});

describe("GET /poll/:id/status feature flag", () => {
  it("404s when MEETING_POLL_ENABLED is not exactly 'true'", async () => {
    const poll = await seedPoll();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, { ...ON, MEETING_POLL_ENABLED: "false" });
    expect(res.status).toBe(404);
  });
});

describe("GET /poll/:id/status auth", () => {
  it("401s with no bearer — same shape as every other requireOwner-gated poll route", async () => {
    const poll = await seedPoll();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, {}, ON);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_bearer" });
  });

  it("404s for a bearer belonging to a different subject — ownership-checked, never 403", async () => {
    const poll = await seedPoll();
    await seedBearer("other-token", OTHER);
    const app = appWith();
    const res = await app.request(
      `/poll/${poll.id}/status`,
      { headers: { Authorization: "Bearer other-token" } },
      ON,
    );
    expect(res.status).toBe(404);
  });

  it("404s for an unknown poll id", async () => {
    const app = appWith();
    const res = await app.request(`/poll/p_does_not_exist/status`, { headers: AUTH }, ON);
    expect(res.status).toBe(404);
  });
});

describe("GET /poll/:id/status?t= (capability-token browser entry point)", () => {
  async function mintStatusToken(pollId: string, subject: string, ttlSeconds = 3600) {
    return signCapabilityWithEnv({ purpose: "poll-status", pollId, subject, ttlSeconds }, TEST_ENV);
  }

  it("a valid status token renders the same organiser page (real names), no bearer needed", async () => {
    const poll = await seedPoll();
    await seedInvitee(poll, "hidden@x.com", {
      name: "Victoria Confidential", hideName: true, pseudonym: "curious sea otter",
    });
    const token = await mintStatusToken(poll.id, OWNER);
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Victoria Confidential"); // organiser sees real names, same as the bearer path
  });

  it("a status token minted for a DIFFERENT poll 404s", async () => {
    const pollA = await seedPoll();
    const pollB = await seedPoll();
    const tokenForB = await mintStatusToken(pollB.id, OWNER);
    const app = appWith();
    const res = await app.request(`/poll/${pollA.id}/status?t=${encodeURIComponent(tokenForB)}`, {}, ON);
    expect(res.status).toBe(404);
  });

  it("a status token minted for a subject that does NOT own this poll 404s (ownership re-checked against the DB, not just trusted from the token)", async () => {
    const poll = await seedPoll(); // owned by OWNER
    const forgedToken = await mintStatusToken(poll.id, "attacker@org");
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(forgedToken)}`, {}, ON);
    expect(res.status).toBe(404);
  });

  it("an INVITEE (poll-response) token presented as a status token 404s — the two purposes are not interchangeable", async () => {
    const poll = await seedPoll();
    const inviteeId = newInviteeId();
    const inviteeToken = await signCapabilityWithEnv(
      { purpose: "poll-response", pollId: poll.id, inviteeId, subject: OWNER, ttlSeconds: 3600 },
      TEST_ENV,
    );
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(inviteeToken)}`, {}, ON);
    expect(res.status).toBe(404);
  });

  it("a tampered status token 404s", async () => {
    const poll = await seedPoll();
    const token = await mintStatusToken(poll.id, OWNER);
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(token)}x`, {}, ON);
    expect(res.status).toBe(404);
  });

  it("an expired status token 404s", async () => {
    const poll = await seedPoll();
    const token = await mintStatusToken(poll.id, OWNER, -1);
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(token)}`, {}, ON);
    expect(res.status).toBe(404);
  });

  it("the bearer path still works when no ?t= is present (unchanged)", async () => {
    const poll = await seedPoll();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    expect(res.status).toBe(200);
  });
});

describe("GET /poll/:id/status content", () => {
  it("is read-only: no forms, no client script", async () => {
    const poll = await seedPoll();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");
  });

  it("shows the roster with real names, and a hidden invitee's pseudonym alongside their real name", async () => {
    const poll = await seedPoll();
    await seedInvitee(poll, "open@x.com", { name: "Olivia Open" });
    await seedInvitee(poll, "hidden@x.com", {
      name: "Victoria Confidential", hideName: true, pseudonym: "curious sea otter",
    });
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html).toContain("Olivia Open");
    // The organiser sees the REAL name (never just the pseudonym) plus the
    // pseudonym in parentheses, since that's what the hidden invitee's peers
    // see on the poll page itself — cross-referencing needs both.
    expect(html).toContain("Victoria Confidential");
    expect(html).toContain("curious sea otter");
  });

  it("shows an 'open' state banner and the poll title, escaped", async () => {
    const poll = await seedPoll({ title: '<b>Hostile</b> title & co' });
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("open");
    expect(html).not.toContain("<b>Hostile</b>");
    expect(html).toContain("&lt;b&gt;Hostile&lt;/b&gt; title &amp; co");
  });

  it("renders a booked poll's state and booked slot", async () => {
    const poll = await seedPoll();
    const slot = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await setBooked(env.DB, poll.id, slot, "gcal-evt-1");
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("booked");
  });

  it("renders a needs_attention poll's state", async () => {
    const poll = await seedPoll();
    await setPollStatus(env.DB, poll.id, "needs_attention", new Date().toISOString());
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("needs attention");
  });

  it("gives plain-text pointers to the nudge/cancel/resolve API operations, not mutating forms", async () => {
    const poll = await seedPoll();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html).toContain(`/v1/polls/${poll.id}/nudge`);
    expect(html).toContain(`/v1/polls/${poll.id}/cancel`);
    expect(html).toContain(`/v1/polls/${poll.id}/resolve`);
  });

  it("lists top candidates with a score for an open poll with a response", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "a@x.com", { name: "Ann" });
    // A response is needed for the fit-curve scorer to have anything to
    // weigh — an empty response set still produces organiser-feasible
    // candidates (curve-only fit), so this isn't strictly required for the
    // section to render, but it exercises the real aggregation path.
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, new Date(Date.now() + 2 * 86_400_000).toISOString(), "free")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("candidate");
  });
});

describe("GET /poll/:id/status aggregate table — availability icons (Card A)", () => {
  it("renders a free cell as an icon span with class, title, and aria-label — never the literal word 'Free' (assertions scoped to the table itself, not satisfiable by the legend alone)", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "free@x.com", { name: "Freda" });
    const cell = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, cell, "free")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    const tableHtml = sliceAggTable(html);
    expect(tableHtml).toContain('class="av av-free"');
    expect(tableHtml).toContain('title="Free"');
    expect(tableHtml).toContain('aria-label="Free"');
    // The old literal-text rendering must be gone from the aggregate cells
    // (scoped to the table — unrelated future page copy elsewhere mustn't
    // be able to break this).
    expect(tableHtml).not.toContain(">Free<");
    expect(tableHtml).not.toContain(">If needed<");
  });

  // A-R2: this test used to assert against the whole page, which the
  // always-present legend (one of each icon) satisfies regardless of what
  // the table itself renders — rendering "" for if_needed cells would still
  // pass. Pin the count *inside the table slice* so it actually depends on
  // the seeded if_needed response.
  it("renders an if_needed cell with a distinct icon/class from free, pinned inside the aggregate table itself", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "maybe@x.com", { name: "Maybe" });
    const cell = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, cell, "if_needed")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    const tableHtml = sliceAggTable(html);
    const ifNeededIcons = tableHtml.match(/class="av av-ifneeded"/g) ?? [];
    expect(ifNeededIcons.length).toBe(1); // exactly the one seeded if_needed response
    expect(tableHtml).not.toContain(">Free<");
    expect(tableHtml).not.toContain(">If needed<");
  });

  it("leaves an unpainted cell empty (no icon) while a sibling cell for the same invitee is painted", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "partial@x.com", { name: "Partial" });
    const paintedCell = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const otherInviteeOnlyCell = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const other = await seedInvitee(poll, "other@x.com", { name: "Other" });
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, paintedCell, "free")
      .run();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(other.id, otherInviteeOnlyCell, "free")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    const tableHtml = sliceAggTable(html);
    // Exactly the two actually-painted (invitee, cell) pairs get a "free"
    // icon; the other two combinations in the 2x2 grid stay unpainted (no
    // icon span at all — an unpainted cell is empty, never a "no" icon).
    const freeIcons = tableHtml.match(/class="av av-free"/g) ?? [];
    expect(freeIcons.length).toBe(2);
    expect(tableHtml).not.toContain("av-ifneeded");
  });

  it("shows a legend beneath the aggregate table explaining the icons", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "a@x.com", { name: "Ann" });
    const cell = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, cell, "free")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html).toContain('class="legend"');
    expect(html.toLowerCase()).toContain("free");
    expect(html.toLowerCase()).toContain("if needed");
  });

  // A-R1 (blocker): column width was pinned by the header, not the cells —
  // every <th> rendered the full "YYYY-MM-DD HH:MM UTC" string with
  // white-space:nowrap, so icon-only cells changed nothing. A two-tier
  // header (colspanned date, then per-cell time-only headers) is what
  // actually narrows it. Pixel width isn't measurable in vitest, so this
  // pins the structure instead. Dates/times are the ORGANISER'S local zone
  // (Australia/Sydney via the test env's SCHEDULER_TZ; fixed June dates so
  // AEST +10:00 applies regardless of when the test runs).
  it("uses a two-tier header — a colspanned local-date row above per-cell time-only headers — instead of repeating a full date+time string in every column", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "a@x.com", { name: "Ann" });
    // 2026-06-08T23:00Z / 23:30Z are Sydney 2026-06-09 09:00 / 09:30;
    // 2026-06-09T23:00Z is Sydney 2026-06-10 09:00.
    const cells = ["2026-06-08T23:00:00.000Z", "2026-06-08T23:30:00.000Z", "2026-06-09T23:00:00.000Z"];
    for (const cell of cells) {
      await env.DB.prepare(
        "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
      )
        .bind(invitee.id, cell, "free")
        .run();
    }
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    const tableHtml = sliceAggTable(html);

    // (a) the shared local date gets a colspan matching its 2 cells...
    expect(tableHtml).toContain(`<th class="date" colspan="2">2026-06-09</th>`);
    // ...and the lone second local date gets colspan="1".
    expect(tableHtml).toContain(`<th class="date" colspan="1">2026-06-10</th>`);
    // (b) time-only headers in the organiser's zone, not the UTC hour.
    expect(tableHtml).toContain(">09:00<");
    expect(tableHtml).toContain(">09:30<");
    expect(tableHtml).not.toContain(">23:00<");
    // (c) no full date+time string anywhere in the table slice.
    expect(tableHtml).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // (d) row 2 has exactly one time header per cell.
    const timeHeaders = tableHtml.match(/<th class="time">/g) ?? [];
    expect(timeHeaders.length).toBe(cells.length);
  });

  // The header line has always SAID "times shown in <ownerTz>", but every
  // timestamp was actually rendered UTC — the caption lied. All times on the
  // page (deadline, booked slot, candidates, aggregate header) must render
  // in the organiser's home zone.
  it("renders the deadline in the organiser's home timezone, not UTC", async () => {
    // 2026-06-10T07:00Z is Sydney 2026-06-10 17:00 (AEST, no DST in June).
    const poll = await seedPoll({ deadlineUtc: "2026-06-10T07:00:00.000Z" });
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html).toContain("responses close 2026-06-10 17:00");
    expect(html).toContain("times shown in Australia/Sydney");
    // No UTC-rendered timestamp survives anywhere on the page.
    expect(html).not.toMatch(/\d{2}:\d{2} UTC/);
    expect(html).not.toContain("07:00");
  });

  // A-R3 (minor): #c9a227 on white is 2.42:1, below the 3:1 WCAG SC 1.4.11
  // floor for an information-carrying glyph. Darkened to #8f6b00 (~4.6:1).
  it("darkens --if-needed to meet WCAG 1.4.11 contrast for an information-carrying glyph", async () => {
    const poll = await seedPoll();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    expect(html).toContain("--if-needed:#8f6b00");
  });

  // A-R4/A-R5 (minor/nit): a bare <span> has no implicit ARIA role, so a
  // screen reader ignores its aria-label unless role="img" is present. The
  // legend's icons are decorative copies (aria-hidden, no aria-label) so
  // they don't double-announce alongside the labelled table icons.
  it("table icon spans carry role=\"img\" so their aria-label is actually honoured", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "a@x.com", { name: "Ann" });
    const cell = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, cell, "free")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    const tableHtml = sliceAggTable(html);
    const roleImgCount = (tableHtml.match(/role="img"/g) ?? []).length;
    expect(roleImgCount).toBe(1); // exactly the one painted cell
  });

  it("legend icons are decorative (aria-hidden, no aria-label) so they don't double-announce alongside the table's labelled icons", async () => {
    const poll = await seedPoll();
    const invitee = await seedInvitee(poll, "a@x.com", { name: "Ann" });
    const cell = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)",
    )
      .bind(invitee.id, cell, "free")
      .run();
    const app = appWith();
    const res = await app.request(`/poll/${poll.id}/status`, { headers: AUTH }, ON);
    const html = await res.text();
    const legendStart = html.indexOf('class="legend"');
    const legendHtml = html.slice(legendStart, html.indexOf("</p>", legendStart));
    const ariaHiddenCount = (legendHtml.match(/aria-hidden="true"/g) ?? []).length;
    expect(ariaHiddenCount).toBe(2); // one free icon, one if-needed icon
    expect(legendHtml).not.toContain("aria-label");
  });
});
