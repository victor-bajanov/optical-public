import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { mountBookingRoutes, MAX_CLAIM_BODY_BYTES } from "../../src/booking/route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { saveBookingPage } from "../../src/db/booking-page";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { MAX_CLAIMS_PER_IP_24H } from "../../src/booking/turnstile";
import { MAX_LOCATION_LENGTH } from "../../src/booking/location";
import { BOOKING_PAGE_CSP } from "../../src/booking/page";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";
import type { BusinessHours } from "../../src/planning/solver-contract";

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const OWNER = "route-owner@org";
const HOURS = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "10:00",
  end: "16:00",
} as BusinessHours;

function appWith(provider: MockCalendarProvider): App {
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", provider);
    await next();
  });
  mountBookingRoutes(app);
  return app;
}

const TEST_ENV = env as unknown as Env;
const ON: Env = { ...TEST_ENV, BOOKING_PAGE_ENABLED: "true", TURNSTILE_SECRET: "s" };
const OFF: Env = { ...ON, BOOKING_PAGE_ENABLED: "false" };

/** A start far enough ahead to clear min notice, on a weekday inside hours. */
async function firstSlot(app: App): Promise<string> {
  const res = await app.request("/book/routes/slots?duration=30", {}, ON);
  const body = (await res.json()) as { slots: string[] };
  return body.slots[0]!;
}

async function bookingRows(): Promise<Array<{ status: string }>> {
  const r = await env.DB.prepare("SELECT status FROM bookings WHERE owner_subject = ?")
    .bind(OWNER)
    .all<{ status: string }>();
  return r.results ?? [];
}

beforeEach(async () => {
  for (const t of ["bookings", "config_booking_page", "tasks"]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE owner_subject = ?`).bind(OWNER).run();
  }
  await saveBookingPage(env.DB, OWNER, {
    slug: "routes",
    enabled: true,
    hours: HOURS,
    horizon_days: 14,
    min_notice_minutes: 0,
    // Buffers OFF for route tests: with the seeded default (after: 10) a claim
    // at 10:00 reserves through 10:40, so consecutive 30-minute slots would
    // correctly 409 and the rate-limit test could never reach its cap. Buffer
    // behaviour is covered by test/booking/claim.test.ts and slots.test.ts.
    buffer_minutes: { before: 0, after: 0 },
  });
  turnstileAccepts();
});

afterEach(async () => {
  await env.DB.prepare("DROP TRIGGER IF EXISTS test_block_confirm").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS test_lose_claim").run();
  vi.restoreAllMocks();
});

/** Make the post-calendar-write UPDATE fail for real, without mocking the DB
 *  module: only the transition to 'confirmed' aborts, so claimSlot's INSERT and
 *  failBooking's UPDATE still work. */
async function blockConfirmWrites() {
  await env.DB.prepare(
    `CREATE TRIGGER test_block_confirm BEFORE UPDATE ON bookings
     WHEN NEW.status = 'confirmed'
     BEGIN SELECT RAISE(ABORT, 'd1 unavailable'); END`,
  ).run();
}

/** Turn claimSlot's INSERT into a silent no-op, which is exactly what the row
 *  count looks like to the loser of a real race: `RAISE(IGNORE)` skips the row
 *  without raising, so `meta.changes` is 0 and claimSlot returns null. Lets the
 *  race-loser branch be exercised without mocking the db module. */
async function loseEveryClaim() {
  await env.DB.prepare(
    "CREATE TRIGGER test_lose_claim BEFORE INSERT ON bookings BEGIN SELECT RAISE(IGNORE); END",
  ).run();
}

/** `ip = null` omits `cf-connecting-ip` entirely — a request that did not reach
 *  the worker through Cloudflare's edge. */
function claimBody(start: string, over: Record<string, unknown> = {}, ip: string | null = "9.9.9.9") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip !== null) headers["cf-connecting-ip"] = ip;
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      start,
      duration_minutes: 30,
      name: "Sam",
      email: "sam@x.com",
      note: "hello",
      // Every claim must now name a meeting type the page offers. `meet` is in
      // the seeded default set, so this is the do-nothing choice for the tests
      // that are about something else entirely.
      location_kind: "meet",
      location_detail: null,
      turnstile_token: "tok",
      ...over,
    }),
  };
}

/** A fresh Response per call: a single mocked Response can only have its body
 *  read once, and verifyTurnstile fails closed on the second read. `hostname`
 *  is the host `app.request` builds its URL on, so the route's hostname check
 *  passes — see the mismatch test below for the other side of that. */
function turnstileVerdict(success: boolean, hostname = "localhost") {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ success, hostname }), { status: 200 }),
  );
}

function turnstileAccepts() {
  turnstileVerdict(true);
}

function turnstileRejects() {
  turnstileVerdict(false);
}

describe("GET /book/:slug", () => {
  it("serves the page shell for an enabled page", async () => {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request("/book/routes", {}, ON);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("404s when the feature flag is off", async () => {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      "/book/routes",
      {},
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("is not cached, so the page always points at the current client hash", async () => {
    // The client asset is immutable-cached under a content-hashed name, which
    // only reaches a booker if the HTML naming it is fresh. Cache the shell and
    // the cache-busting is defeated: the browser keeps asking for the old hash.
    // Previously the shell sent no cache-control at all, leaving it to browser
    // heuristics.
    const res = await appWith(new MockCalendarProvider({ events: [] })).request("/book/routes", {}, ON);
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });

  it("serves the content security policy and refuses to be framed", async () => {
    // An unauthenticated public form whose success sends an invitation from the
    // owner's account: it must not be loadable inside somebody else's page.
    const res = await appWith(new MockCalendarProvider({ events: [] })).request("/book/routes", {}, ON);
    expect(res.headers.get("content-security-policy")).toBe(BOOKING_PAGE_CSP);
    expect(BOOKING_PAGE_CSP).toContain("frame-ancestors 'none'");
    // X-Frame-Options for browsers that predate frame-ancestors.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("GET /book/:slug/slots", () => {
  it("404s when the feature flag is off", async () => {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      "/book/routes/slots?duration=30",
      {},
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("404s for an unknown slug", async () => {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      "/book/nosuch/slots?duration=30",
      {},
      ON,
    );
    expect(res.status).toBe(404);
  });

  it("404s when the page exists but is disabled", async () => {
    await saveBookingPage(env.DB, OWNER, { enabled: false });
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      "/book/routes/slots?duration=30",
      {},
      ON,
    );
    expect(res.status).toBe(404);
  });

  it("400s for a duration the page does not offer", async () => {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      "/book/routes/slots?duration=45",
      {},
      ON,
    );
    expect(res.status).toBe(400);
  });

  // Stored slugs are always lowercase (validateSlug enforces it) but the URL is
  // retyped off a business card or an email signature, so the lookup must not
  // care about case.
  it("resolves the same page for a slug typed in upper case", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const upper = await app.request("/book/ROUTES/slots?duration=30", {}, ON);
    const lower = await app.request("/book/routes/slots?duration=30", {}, ON);
    expect(upper.status).toBe(200);
    const up = (await upper.json()) as { slots: string[] };
    const low = (await lower.json()) as { slots: string[] };
    expect(up.slots).toEqual(low.slots);
  });

  it("returns slots for an offered duration", async () => {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      "/book/routes/slots?duration=30",
      {},
      ON,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: string[]; timezone: string };
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.timezone).toBeTruthy();
  });
});

describe("GET /book/:slug/slots — paging", () => {
  const DAY = 86_400_000;
  type SlotsBody = {
    slots: string[];
    page: number;
    has_more: boolean;
    window: { start: string; end: string };
    error?: string;
  };
  async function slots(query: string) {
    const res = await appWith(new MockCalendarProvider({ events: [] })).request(
      `/book/routes/slots?duration=30${query}`,
      {},
      ON,
    );
    return { status: res.status, body: (await res.json()) as SlotsBody };
  }

  it("serves page 0 by default, and says so", async () => {
    const r = await slots("");
    expect(r.status).toBe(200);
    expect(r.body.page).toBe(0);
    expect(r.body.has_more).toBe(false);
    expect(Date.parse(r.body.window.end) - Date.parse(r.body.window.start)).toBe(14 * DAY);
  });

  it("400s a page past the reach — one page when max_horizon_days is unset", async () => {
    const r = await slots("&page=1");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("page_out_of_range");
  });

  it("serves a later page once the owner has set a reach, sized to its own window", async () => {
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 28 });
    const first = await slots("");
    expect(first.body.has_more).toBe(true);

    const r = await slots("&page=1");
    expect(r.status).toBe(200);
    expect(r.body.page).toBe(1);
    expect(r.body.has_more).toBe(false);
    expect(r.body.slots.length).toBeGreaterThan(0);
    const start = Date.parse(r.body.window.start);
    const end = Date.parse(r.body.window.end);
    expect(end - start).toBe(14 * DAY);
    expect(r.body.slots.every((s) => Date.parse(s) >= start && Date.parse(s) < end)).toBe(true);
    // Page 1 starts where page 0 ended — to within the clock drift between
    // two requests, each taking its own `new Date()`. Pages are exact and
    // contiguous for ONE `now`; across requests they drift by the time
    // between them, which the client's splice-by-window tolerates.
    expect(Math.abs(Date.parse(r.body.window.start) - Date.parse(first.body.window.end))).toBeLessThan(5_000);

    expect((await slots("&page=2")).body.error).toBe("page_out_of_range");
  });

  it("400s a page that is not a non-negative integer", async () => {
    for (const bad of ["abc", "-1", "1.5", ""]) {
      const r = await slots(`&page=${bad}`);
      expect([bad, r.status, r.body.error]).toEqual([bad, 400, "invalid_page"]);
    }
  });
});

describe("POST /book/:slug — paging", () => {
  async function pageOneSlot(app: App): Promise<{ start: string; window: { start: string; end: string } }> {
    const res = await app.request("/book/routes/slots?duration=30&page=1", {}, ON);
    const body = (await res.json()) as { slots: string[]; window: { start: string; end: string } };
    return { start: body.slots[0]!, window: body.window };
  }

  it("claims a slot from a later page — the check recomputes that page, not page 0", async () => {
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 28 });
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const { start } = await pageOneSlot(app);
    const fetch = vi.spyOn(provider, "fetchEventsInWindow");

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(201);
    // One calendar read for the claim's availability check, sized to page 1.
    const [from, to] = fetch.mock.calls[0]!;
    expect(Date.parse(from) <= Date.parse(start)).toBe(true);
    expect(Date.parse(to) > Date.parse(start)).toBe(true);
    expect(Date.parse(to) - Date.parse(from)).toBe(14 * 86_400_000);
  });

  it("a 409 on a later page carries that page's fresh list, labelled with the page", async () => {
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 28 });
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const { start, window } = await pageOneSlot(app);
    expect((await app.request("/book/routes", claimBody(start), ON)).status).toBe(201);

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string; slots: string[]; page: number; window: { start: string; end: string };
    };
    expect(body.error).toBe("slot_unavailable");
    expect(body.page).toBe(1);
    // Same page 1 window as the fetch, modulo the clock drift between requests.
    expect(Math.abs(Date.parse(body.window.start) - Date.parse(window.start))).toBeLessThan(5_000);
    expect(Math.abs(Date.parse(body.window.end) - Date.parse(window.end))).toBeLessThan(5_000);
    expect(body.slots).not.toContain(start);
    expect(body.slots.every((s) => Date.parse(s) >= Date.parse(window.start))).toBe(true);
  });

  it("409s a start past the reach without a list and without reading the calendar", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const fetch = vi.spyOn(provider, "fetchEventsInWindow");
    const res = await appWith(provider).request("/book/routes", claimBody("2099-01-04T00:00:00.000Z"), ON);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; slots?: string[] };
    expect(body.error).toBe("slot_unavailable");
    expect(body.slots).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("opaque 404s", () => {
  /** Feature off, unknown slug and disabled page must be indistinguishable:
   *  probing the public surface must not reveal that a slug exists. */
  it("are byte-identical across feature-off, unknown-slug and disabled-page", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const featureOff = await app.request(
      "/book/routes/slots?duration=30",
      {},
      OFF,
    );
    const unknown = await app.request("/book/nosuch/slots?duration=30", {}, ON);
    await saveBookingPage(env.DB, OWNER, { enabled: false });
    const disabled = await app.request("/book/routes/slots?duration=30", {}, ON);

    const shape = async (r: Response) => ({
      status: r.status,
      body: await r.text(),
      contentType: r.headers.get("content-type"),
    });
    const a = await shape(featureOff);
    expect(await shape(unknown)).toEqual(a);
    expect(await shape(disabled)).toEqual(a);
  });

  it("hide an existing slug on the claim route too", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const known = await app.request("/book/routes", claimBody("2026-08-03T00:00:00.000Z"), OFF);
    const unknown = await app.request("/book/nosuch", claimBody("2026-08-03T00:00:00.000Z"), ON);
    expect(known.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await known.text()).toBe(await unknown.text());
  });
});

describe("POST /book/:slug", () => {
  it("creates a calendar event with the booker invited", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(201);

    const created = provider.getCreated().at(-1)!;
    expect(created.attendees).toEqual([{ email: "sam@x.com" }]);
    expect(created.extendedProperties?.private?.optical_booking).toBeTruthy();
    expect(provider.createOptions.at(-1)?.notifyAttendees).toBe(true);

    const row = await env.DB.prepare(
      "SELECT status, google_event_id FROM bookings WHERE owner_subject = ?",
    )
      .bind(OWNER)
      .first<{ status: string; google_event_id: string }>();
    expect(row!.status).toBe("confirmed");
    expect(row!.google_event_id).toBe(created.id);
  });

  it("accepts a claim on a mixed-case slug and stores the canonical one", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);

    const res = await app.request("/book/RoUtEs", claimBody(start), ON);
    expect(res.status).toBe(201);

    const row = await env.DB.prepare("SELECT slug FROM bookings WHERE owner_subject = ?")
      .bind(OWNER)
      .first<{ slug: string }>();
    expect(row!.slug).toBe("routes");
  });

  it("409s on a double claim and returns fresh slots", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    expect((await app.request("/book/routes", claimBody(start), ON)).status).toBe(201);

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; slots: string[] };
    expect(body.error).toBe("slot_unavailable");
    expect(body.slots).not.toContain(start);
  });

  it("409s for a start that is not an offered slot", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request("/book/routes", claimBody("2026-08-03T02:07:00.000Z"), ON);
    expect(res.status).toBe(409);
  });

  it("409s for an offered start once an external event covers it, without writing a row", async () => {
    // The client may hold a stale slot list; the server recomputes and refuses.
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    const busy = new MockCalendarProvider({
      events: [
        {
          id: "evt-busy",
          summary: "client call",
          start,
          end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
          extendedProperties: {},
        },
      ],
    });

    const res = await appWith(busy).request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(409);
    expect(await bookingRows()).toHaveLength(0);
    expect(busy.getCreated()).toHaveLength(0);
  });

  it("403s when Turnstile rejects the token", async () => {
    turnstileRejects();
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request("/book/routes", claimBody("2026-08-03T00:00:00.000Z"), ON);
    expect(res.status).toBe(403);
  });

  it("403s when the token is missing entirely", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      "/book/routes",
      claimBody("2026-08-03T00:00:00.000Z", { turnstile_token: undefined }),
      ON,
    );
    expect(res.status).toBe(403);
  });

  it("checks Turnstile BEFORE the rate-limit counters", async () => {
    // Same IP is already over its cap. A bad token must still surface as 403,
    // proving the challenge ran first rather than the cheaper counter query.
    const ip = "7.7.7.7";
    const ipHash = await hashToken(ip, hashingKey(TEST_ENV));
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    for (let i = 0; i < MAX_CLAIMS_PER_IP_24H; i++) {
      await env.DB.prepare(
        `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
           booker_name, booker_email, ip_hash, status, created_at, updated_at)
         VALUES (?,?,'routes','2030-01-01T00:00:00Z','2030-01-01T00:30:00Z',30,'S','s@x.com',?,'confirmed',?,?)`,
      )
        .bind(`rl-${i}`, OWNER, ipHash, now, now)
        .run();
    }

    const app = appWith(new MockCalendarProvider({ events: [] }));
    turnstileRejects();
    const rejected = await app.request(
      "/book/routes",
      claimBody("2026-08-03T00:00:00.000Z", {}, ip),
      ON,
    );
    expect(rejected.status).toBe(403);

    // With the challenge satisfied the very same request reaches the counters.
    turnstileAccepts();
    const limited = await app.request(
      "/book/routes",
      claimBody("2026-08-03T00:00:00.000Z", {}, ip),
      ON,
    );
    expect(limited.status).toBe(429);
  });

  it("checks Turnstile BEFORE touching the calendar or the bookings table", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    let fetched = 0;
    provider.fetchEventsInWindow = async () => {
      fetched++;
      throw new Error("calendar must not be reached");
    };
    turnstileRejects();

    const res = await appWith(provider).request(
      "/book/routes",
      claimBody("2026-08-03T00:00:00.000Z"),
      ON,
    );
    expect(res.status).toBe(403);
    expect(fetched).toBe(0);
    expect(await bookingRows()).toHaveLength(0);
  });

  it("400s on a malformed body", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      "/book/routes",
      claimBody("2026-08-03T00:00:00.000Z", { email: "not-an-email" }),
      ON,
    );
    expect(res.status).toBe(400);
  });

  it("400s for a duration the page does not offer", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    const res = await app.request("/book/routes", claimBody(start, { duration_minutes: 45 }), ON);
    expect(res.status).toBe(400);
    expect(await bookingRows()).toHaveLength(0);
  });

  it("400s on oversized free-text fields", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    for (const over of [
      { name: "n".repeat(121) },
      { note: "x".repeat(2001) },
      { email: `${"e".repeat(300)}@x.com` },
    ]) {
      const label = Object.keys(over)[0]!;
      const res = await app.request("/book/routes", claimBody(start, over), ON);
      expect([label, res.status]).toEqual([label, 400]);
    }
    expect(await bookingRows()).toHaveLength(0);
  });

  it("400s on a body that is not JSON at all", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res = await app.request(
      "/book/routes",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
        body: "{not json",
      },
      ON,
    );
    expect(res.status).toBe(400);
  });

  it("502s and releases the reservation when the calendar write fails", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    provider.createEvent = async () => {
      throw new Error("google down");
    };

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(502);

    const row = await env.DB.prepare("SELECT status FROM bookings WHERE owner_subject = ?")
      .bind(OWNER)
      .first<{ status: string }>();
    expect(row!.status).toBe("failed");
  });

  it("re-opens the slot after a failed calendar write", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    const create = provider.createEvent.bind(provider);
    provider.createEvent = async () => {
      throw new Error("google down");
    };
    expect((await app.request("/book/routes", claimBody(start), ON)).status).toBe(502);

    provider.createEvent = create;
    const retry = await app.request("/book/routes", claimBody(start), ON);
    expect(retry.status).toBe(201);
  });

  it("keeps the slot reserved when the event was created but the confirm failed", async () => {
    // The calendar is authoritative: the event exists and the booker has been
    // invited, so releasing the row would re-offer a slot that is really taken.
    // The reservation must survive as 'reserving', not be marked 'failed'.
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    await blockConfirmWrites();

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(502);
    expect(provider.getCreated()).toHaveLength(1);

    const rows = await bookingRows();
    expect(rows.map((r) => r.status)).toEqual(["reserving"]);

    // And the slot must not come back on offer.
    await env.DB.prepare("DROP TRIGGER IF EXISTS test_block_confirm").run();
    const after = await app.request("/book/routes/slots?duration=30", {}, ON);
    const { slots } = (await after.json()) as { slots: string[] };
    expect(slots).not.toContain(start);
  });

  it("429s once the per-IP cap is exceeded", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res0 = await app.request("/book/routes/slots?duration=30", {}, ON);
    const { slots } = (await res0.json()) as { slots: string[] };
    for (let i = 0; i < MAX_CLAIMS_PER_IP_24H; i++) {
      expect((await app.request("/book/routes", claimBody(slots[i]!), ON)).status).toBe(201);
    }
    const res = await app.request("/book/routes", claimBody(slots[MAX_CLAIMS_PER_IP_24H]!), ON);
    expect(res.status).toBe(429);
  });

  it("409s, not 500s, when the post-claim recompute cannot reach the calendar", async () => {
    // The loser of a race whose token refresh fails a millisecond later. The
    // recompute only exists to hand back a fresh slot list; the claim is
    // already known to have lost, so the answer is still 409 — the status the
    // client knows how to recover from — not an unhandled throw.
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    await loseEveryClaim();

    const real = provider.fetchEventsInWindow.bind(provider);
    let calls = 0;
    provider.fetchEventsInWindow = async (from: string, to: string) => {
      calls += 1;
      if (calls > 1) throw new Error("token refresh failed");
      return real(from, to);
    };

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("slot_unavailable");
  });

  it("still returns the fresh slot list when the post-claim recompute succeeds", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    await loseEveryClaim();

    const res = await app.request("/book/routes", claimBody(start), ON);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; slots?: string[] };
    expect(body.error).toBe("slot_unavailable");
    expect(Array.isArray(body.slots)).toBe(true);
  });

  it("refuses a claim carrying no client IP rather than pooling every caller into one bucket", async () => {
    // `cf-connecting-ip` absent means the request did not come through
    // Cloudflare's edge, so there is no IP to count against — and hashing the
    // empty string would file every such caller under one constant bucket,
    // turning MAX_CLAIMS_PER_IP_24H into a global cap of 5.
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);

    const res = await app.request("/book/routes", claimBody(start, {}, null), ON);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "client_ip_required" });
    expect(await bookingRows()).toHaveLength(0);
    expect(provider.getCreated()).toHaveLength(0);
  });

  it("never files two IP-less callers under the same rate-limit bucket", async () => {
    // The regression the refusal exists to prevent: five IP-less claims used to
    // exhaust the shared bucket and 429 every unrelated caller after them.
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const res0 = await app.request("/book/routes/slots?duration=30", {}, ON);
    const { slots } = (await res0.json()) as { slots: string[] };
    for (let i = 0; i < MAX_CLAIMS_PER_IP_24H; i++) {
      expect((await app.request("/book/routes", claimBody(slots[i]!, {}, null), ON)).status).toBe(400);
    }
    // A real, edge-delivered claim is untouched by them.
    expect((await app.request("/book/routes", claimBody(slots[0]!), ON)).status).toBe(201);
  });

  it("403s when the challenge was solved on a different hostname", async () => {
    // Same sitekey, someone else's page: siteverify says success, and only the
    // hostname tells the two apart.
    turnstileVerdict(true, "evil.example");
    const provider = new MockCalendarProvider({ events: [] });
    const res = await appWith(provider).request(
      "/book/routes",
      claimBody("2026-08-03T00:00:00.000Z"),
      ON,
    );
    expect(res.status).toBe(403);
    expect(provider.getCreated()).toHaveLength(0);
    expect(await bookingRows()).toHaveLength(0);
  });
});

describe("POST /book/:slug — request body bounds", () => {
  /** A body of `bytes` total that is still valid JSON, so a route that parses
   *  before checking the size gets all the way through the parse. */
  function padded(bytes: number): string {
    const skeleton = JSON.stringify({
      start: "2026-08-03T00:00:00.000Z",
      duration_minutes: 30,
      name: "Sam",
      email: "sam@x.com",
      location_kind: "meet",
      location_detail: null,
      turnstile_token: "tok",
      note: "",
    });
    return skeleton.replace('"note":""', `"note":"${"x".repeat(Math.max(0, bytes - skeleton.length))}"`);
  }

  function sized(body: string, ip = "9.9.9.9") {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cf-connecting-ip": ip,
      },
      body,
    };
  }

  it("400s an over-cap body without parsing it or verifying the challenge", async () => {
    let verified = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      verified++;
      return new Response(JSON.stringify({ success: true, hostname: "localhost" }), { status: 200 });
    });
    const app = appWith(new MockCalendarProvider({ events: [] }));

    const res = await app.request("/book/routes", sized(padded(MAX_CLAIM_BODY_BYTES + 1)), ON);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    // The whole point: no siteverify round trip, so an unauthenticated caller
    // cannot make the worker buffer and parse megabytes ahead of the gate.
    expect(verified).toBe(0);
    expect(await bookingRows()).toHaveLength(0);
  });

  it("still accepts a body that is large but under the cap", async () => {
    // The cap must not be so tight that a real claim with a full-length note
    // is rejected — otherwise the fix breaks the feature.
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    const body = JSON.stringify({
      start,
      duration_minutes: 30,
      name: "Sam",
      email: "sam@x.com",
      note: "x".repeat(2000),
      location_kind: "meet",
      location_detail: null,
      turnstile_token: "tok",
    });
    expect(body.length).toBeLessThanOrEqual(MAX_CLAIM_BODY_BYTES);
    const res = await app.request("/book/routes", sized(body), ON);
    expect(res.status).toBe(201);
  });
});

describe("POST /book/:slug — booker text reaching the owner's calendar", () => {
  async function claim(over: Record<string, unknown>) {
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    const res = await app.request("/book/routes", claimBody(start, over), ON);
    return { res, created: provider.getCreated().at(-1) };
  }

  it("strips markup from the name before it reaches the event title", async () => {
    // The booker's email is never verified, so this title rides an invitation
    // Google sends, DKIM-signed, from the owner's own account.
    const name = '<a href="https://evil.example/pay">Invoice overdue</a>';
    const { res, created } = await claim({ name });
    expect(res.status).toBe(201);
    expect(created!.summary).not.toContain("<");
    expect(created!.summary).not.toContain(">");
    expect(created!.summary).toContain("Invoice overdue");
  });

  it("collapses newlines and runs of whitespace in the name — a title is one line", async () => {
    const { res, created } = await claim({ name: "Sam\n\nURGENT: wire\ttransfer   now" });
    expect(res.status).toBe(201);
    expect(created!.summary).toBe("Meeting with Sam URGENT: wire transfer now");
  });

  it("strips control characters from the name", async () => {
    const { res, created } = await claim({ name: "Sam\u0000\u001b[31mRED" });
    expect(res.status).toBe(201);
    expect(created!.summary).toBe("Meeting with Sam[31mRED");
  });

  it("strips markup from the note before it reaches the event description", async () => {
    // Google renders a limited HTML subset in event descriptions, so an anchor
    // here is likely to become a live, clickable link in the invitation.
    const { res, created } = await claim({ note: '<a href="https://evil.example/pay">Pay now</a>' });
    expect(res.status).toBe(201);
    expect(created!.description).not.toContain("<a");
    expect(created!.description).not.toContain("</a>");
    expect(created!.description).toContain("Pay now");
  });

  it("keeps the note's own line breaks", async () => {
    const { res, created } = await claim({ note: "line one\nline two" });
    expect(res.status).toBe(201);
    expect(created!.description).toContain("line one\nline two");
  });

  it("inserts the name literally, not as a replacement pattern", async () => {
    // `$'`, "$`" and `$&` are String.replace directives in the REPLACEMENT
    // string: unescaped they let a booker duplicate or displace whatever the
    // owner put in their own title template.
    const name = "$`$`$'$'$&";
    const { res, created } = await claim({ name });
    expect(res.status).toBe(201);
    expect(created!.summary).toBe(`Meeting with ${name}`);
  });

  it("substitutes EVERY {booker_name} in the owner's title template", async () => {
    // A string first argument to String.replace substitutes one occurrence, so
    // an owner using the placeholder twice used to get a literal
    // "{booker_name}" in the subject line of every invitation.
    await saveBookingPage(env.DB, OWNER, { event_title: "{booker_name} intro with {booker_name}" });
    const { res, created } = await claim({ name: "Sam" });
    expect(res.status).toBe(201);
    expect(created!.summary).toBe("Sam intro with Sam");
  });

  it("keeps the name literal in every position, not just the first", async () => {
    // Both properties at once: a global substitution that reverted to a
    // replacement STRING would let `$'` displace the owner's template text.
    await saveBookingPage(env.DB, OWNER, { event_title: "{booker_name} / {booker_name}" });
    const name = "$`$'$&";
    const { res, created } = await claim({ name });
    expect(res.status).toBe(201);
    expect(created!.summary).toBe(`${name} / ${name}`);
  });

  it("stores what the booker actually submitted, unsanitised, in D1", async () => {
    // The owner must see the real text; sanitising is about what Google
    // renders, not about rewriting the record.
    const name = "<b>Sam</b>";
    const note = "<i>hello</i>";
    const { res } = await claim({ name, note });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT booker_name, booker_note FROM bookings WHERE owner_subject = ?",
    )
      .bind(OWNER)
      .first<{ booker_name: string; booker_note: string }>();
    expect(row).toEqual({ booker_name: name, booker_note: note });
  });
});

describe("POST /book/:slug — non-string fields", () => {
  it("400s instead of 500ing when a claim field is not a string", async () => {
    // Each of these used to reach past validation: `{note:{}}` to .bind()
    // (D1_TYPE_ERROR) and `{name:12345}` to .trim() (TypeError) — a 500 and a
    // logged stack per attempt, each one burning a Turnstile token.
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    for (const over of [
      { note: {} },
      { note: 7 },
      { name: 12345 },
      { name: ["Sam"] },
      { email: 42 },
      { start: 5 },
    ]) {
      const label = JSON.stringify(over);
      const res = await app.request("/book/routes", claimBody(start, over), ON);
      expect([label, res.status]).toEqual([label, 400]);
      expect([label, await res.json()]).toEqual([label, { error: "invalid_body" }]);
    }
    expect(await bookingRows()).toHaveLength(0);
  });

  it("still treats a null or absent note as no note", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    expect((await app.request("/book/routes", claimBody(start, { note: null }), ON)).status).toBe(201);
  });
});

describe("POST /book/:slug — email validation", () => {
  it("400s on an address carrying markup or address-list punctuation", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    for (const email of [
      "<b>x</b>@evil.example", // lands verbatim inside `<${email}>` in the description
      'sa"m@x.com',
      "sam,other@x.com",
      "sam;other@x.com",
      "sam'@x.com",
      "sam@x<b>.com",
      "sam@x.co,m",
    ]) {
      const res = await app.request("/book/routes", claimBody(start, { email }), ON);
      expect([email, res.status]).toEqual([email, 400]);
    }
    expect(await bookingRows()).toHaveLength(0);
  });

  it("still accepts ordinary addresses", async () => {
    const app = appWith(new MockCalendarProvider({ events: [] }));
    const start = await firstSlot(app);
    const res = await app.request(
      "/book/routes",
      claimBody(start, { email: "sam.oneill+tag@sub.example.co.uk" }),
      ON,
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /book/:slug — the booker's location choice", () => {
  /** This page offers Meet and phone, and nothing else. `in_person` and
   *  `custom` are deliberately left off: the picker a booker is shown is only
   *  a hint, so the tests below post kinds the page never rendered. */
  beforeEach(async () => {
    await saveBookingPage(env.DB, OWNER, {
      location: { modes: [{ kind: "meet" }, { kind: "phone" }] },
    });
  });

  async function claim(over: Record<string, unknown>) {
    const provider = new MockCalendarProvider({ events: [] });
    const app = appWith(provider);
    const start = await firstSlot(app);
    const res = await app.request("/book/routes", claimBody(start, over), ON);
    return { res, created: provider.getCreated().at(-1), options: provider.createOptions.at(-1) };
  }

  it("rejects a kind this page does not offer", async () => {
    const { res, created } = await claim({ location_kind: "in_person", location_detail: "The Kettle" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "location_unavailable" });
    expect(created).toBeUndefined();
    // And it is refused BEFORE the slot is reserved: a row here would mean the
    // claim held time it was never going to use until something released it.
    expect(await bookingRows()).toHaveLength(0);
  });

  it("rejects a phone claim with no number", async () => {
    const { res } = await claim({ location_kind: "phone", location_detail: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects a detail supplied for a kind that collects none", async () => {
    const { res } = await claim({ location_kind: "meet", location_detail: "sneaky" });
    expect(res.status).toBe(400);
    expect(await bookingRows()).toHaveLength(0);
  });

  it("rejects a detail longer than the cap", async () => {
    const { res } = await claim({
      location_kind: "phone",
      location_detail: "9".repeat(MAX_LOCATION_LENGTH + 1),
    });
    expect(res.status).toBe(400);
  });

  it("calls a detail that sanitises away a bad body, not an unavailable location", async () => {
    // The length and emptiness checks run on the raw text, but the event and
    // the row get the sanitised copy. A detail made entirely of stripped
    // characters passes the first and vanishes by the second. The kind is
    // offered and the page is fine — the payload is the problem, so this must
    // read as invalid_body rather than blaming the page's offered set.
    const { res } = await claim({ location_kind: "phone", location_detail: "<<<<>>>>" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("400s instead of 500ing when the location fields are missing or not strings", async () => {
    for (const over of [
      { location_kind: undefined },
      { location_kind: 7 },
      { location_kind: ["phone"] },
      { location_detail: 7 },
      { location_kind: "phone", location_detail: {} },
    ]) {
      const label = JSON.stringify(over);
      const { res } = await claim(over);
      expect([label, res.status]).toEqual([label, 400]);
      expect([label, await res.json()]).toEqual([label, { error: "invalid_body" }]);
    }
    expect(await bookingRows()).toHaveLength(0);
  });

  it("asks for a Meet link, and sets no location, when the booker chose meet", async () => {
    const { res, created, options } = await claim({ location_kind: "meet", location_detail: null });
    expect(res.status).toBe(201);
    expect(created!.location).toBeUndefined();
    expect(options?.addMeet).toBe(true);
  });

  it("puts the booker's own number on the event, and asks for no Meet link", async () => {
    const { res, created, options } = await claim({
      location_kind: "phone",
      location_detail: "0400 000 000",
    });
    expect(res.status).toBe(201);
    expect(created!.location).toBe("Phone: 0400 000 000");
    expect(options?.addMeet).toBe(false);
  });

  it("never puts the OWNER's own configured detail on the event", async () => {
    // The bug this closes: every non-Meet mode used to copy the owner's own
    // `location.detail` onto an event created with `notifyAttendees: true`,
    // mailing the owner's address to whoever booked.
    await saveBookingPage(env.DB, OWNER, {
      location: { modes: [{ kind: "phone" }, { kind: "custom", detail: "Level 3, 1 Example St" }] },
    });
    const { res, created } = await claim({ location_kind: "phone", location_detail: "0400 000 000" });
    expect(res.status).toBe(201);
    expect(created!.location).toBe("Phone: 0400 000 000");
    expect(created!.location).not.toContain("Example St");
  });

  it("uses the owner's fixed text for a custom mode, which the booker cannot override", async () => {
    await saveBookingPage(env.DB, OWNER, {
      location: { modes: [{ kind: "custom", detail: "Level 3, 1 Example St" }] },
    });
    const { res, created, options } = await claim({ location_kind: "custom", location_detail: null });
    expect(res.status).toBe(201);
    expect(created!.location).toBe("Level 3, 1 Example St");
    expect(options?.addMeet).toBe(false);
  });

  it("strips markup from the detail before it reaches the event", async () => {
    // Same reasoning as the name and the note: this rides an invitation Google
    // sends from the owner's own account, and renders a limited HTML subset.
    const { res, created } = await claim({
      location_kind: "phone",
      location_detail: '<a href="https://evil.example">0400 000 000</a>',
    });
    expect(res.status).toBe(201);
    expect(created!.location).not.toContain("<");
    expect(created!.location).not.toContain(">");
    expect(created!.location).toContain("0400 000 000");
  });

  it("records the choice on the booking row", async () => {
    const { res } = await claim({ location_kind: "phone", location_detail: "0400 000 000" });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT location_kind, location_detail FROM bookings WHERE owner_subject = ?",
    )
      .bind(OWNER)
      .first<{ location_kind: string; location_detail: string | null }>();
    expect(row).toEqual({ location_kind: "phone", location_detail: "0400 000 000" });
  });

  it("records no detail for a kind that collects none", async () => {
    const { res } = await claim({ location_kind: "meet", location_detail: null });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT location_kind, location_detail FROM bookings WHERE owner_subject = ?",
    )
      .bind(OWNER)
      .first<{ location_kind: string; location_detail: string | null }>();
    expect(row).toEqual({ location_kind: "meet", location_detail: null });
  });
});
