import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 } from "../../src/v1";
import { authedApp, seedBearer, OWNER, OWNER_TOKEN } from "./helpers";

/** A second, unrelated tenant. Every route here is owner-scoped from the
 *  caller's token, so this owner's rows must stay invisible and untouched. */
const OTHER = "book-other@org";
const OTHER_TOKEN = "book-other-tok";

const json = { "Content-Type": "application/json" };

async function insertBooking(owner: string, id: string, start: string, end: string, email: string) {
  await env.DB.prepare(
    `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
       booker_name, booker_email, booker_note, ip_hash, status, google_event_id, created_at, updated_at)
     VALUES (?,?,?,?,?,30,'Sam',?,NULL,'h','confirmed',NULL,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`,
  ).bind(id, owner, "victor", start, end, email).run();
}

async function insertPollBooking(owner: string, id: string, start: string, end: string, email: string, pollId: string) {
  await env.DB.prepare(
    `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
       booker_name, booker_email, booker_note, ip_hash, status, google_event_id, created_at, updated_at, poll_id)
     VALUES (?,?,?,?,?,30,'Sam',?,NULL,'h','confirmed',NULL,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',?)`,
  ).bind(id, owner, "victor", start, end, email, pollId).run();
}

beforeEach(async () => {
  for (const t of ["bookings", "config_booking_page"]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE owner_subject IN (?, ?)`).bind(OWNER, OTHER).run();
  }
  await seedBearer(OWNER, OWNER_TOKEN);
  await seedBearer(OTHER, OTHER_TOKEN);
});

describe("BOOKING_PAGE_ENABLED", () => {
  const OFF = { ...env, BOOKING_PAGE_ENABLED: "false" };
  const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };

  it("refuses every management route when the flag is off", async () => {
    for (const [path, init] of [
      ["/booking-page", {}],
      ["/booking-page", { method: "PUT", headers: json, body: "{}" }],
      ["/bookings?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z", {}],
    ] as const) {
      const res = await v1.request(path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } }, OFF);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("feature_disabled");
    }
  });

  it("still 401s an anonymous caller when the flag is off", async () => {
    // Auth before the flag, as in calendar-feeds: an unauthenticated caller
    // learns nothing about which features this deployment runs.
    expect((await v1.request("/booking-page", {}, OFF)).status).toBe(401);
  });
});

describe("GET /v1/booking-page", () => {
  it("401s without a bearer", async () => {
    expect((await v1.request("/booking-page", {}, env)).status).toBe(401);
  });

  it("returns defaults for an owner with no page", async () => {
    const res = await authedApp().request("/booking-page");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; slug: string | null; durations_minutes: number[] };
    expect(body.enabled).toBe(false);
    expect(body.slug).toBeNull();
    expect(body.durations_minutes).toEqual([30, 60]);
  });
});

describe("PUT /v1/booking-page", () => {
  it("401s without a bearer", async () => {
    const res = await v1.request("/booking-page", { method: "PUT", headers: json, body: "{}" }, env);
    expect(res.status).toBe(401);
  });

  it("401s without a bearer even when the body is malformed", async () => {
    // The gate must precede zod-openapi's validator, or an anonymous caller
    // gets a 400 and cannot tell "malformed" from "not allowed to be here".
    const res = await v1.request("/booking-page", {
      method: "PUT", headers: json, body: JSON.stringify({ horizon_days: "soon" }),
    }, env);
    expect(res.status).toBe(401);
  });

  it("saves a valid config and echoes it back", async () => {
    const res = await authedApp().request("/booking-page", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ slug: "victor", enabled: true, durations_minutes: [30], horizon_days: 14 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; durations_minutes: number[]; horizon_days: number };
    expect(body.slug).toBe("victor");
    expect(body.durations_minutes).toEqual([30]);
    expect(body.horizon_days).toBe(14);
  });

  it("400s on an invalid slug", async () => {
    const res = await authedApp().request("/booking-page", {
      method: "PUT", headers: json, body: JSON.stringify({ slug: "Not Valid" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_slug");
  });

  it("400s on a duration that is not a multiple of 15", async () => {
    const res = await authedApp().request("/booking-page", {
      method: "PUT", headers: json, body: JSON.stringify({ durations_minutes: [20] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_duration");
  });

  describe("horizon validation", () => {
    async function put(body: Record<string, unknown>) {
      const res = await authedApp().request("/booking-page", {
        method: "PUT", headers: json, body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { error?: string; horizon_days?: number; max_horizon_days?: number | null } };
    }

    it("accepts a reach beyond one page and echoes it back", async () => {
      const r = await put({ horizon_days: 21, max_horizon_days: 180 });
      expect(r.status).toBe(200);
      expect(r.body.horizon_days).toBe(21);
      expect(r.body.max_horizon_days).toBe(180);
    });

    it("accepts null, which resets the reach to one page", async () => {
      await put({ horizon_days: 21, max_horizon_days: 180 });
      const r = await put({ max_horizon_days: null });
      expect(r.status).toBe(200);
      expect(r.body.max_horizon_days).toBeNull();
    });

    it("400s a reach shorter than one page in the same body", async () => {
      const r = await put({ horizon_days: 21, max_horizon_days: 20 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_horizon");
    });

    it("400s a page size that overtakes the reach already stored", async () => {
      // Cross-field AND cross-request: the rule holds on the merged config,
      // not just the patch, or a two-step edit would store what a one-step
      // edit is refused for.
      expect((await put({ horizon_days: 14, max_horizon_days: 30 })).status).toBe(200);
      const r = await put({ horizon_days: 60 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_horizon");
    });

    it("400s a reach past the schema ceiling", async () => {
      const r = await put({ max_horizon_days: 366 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("validation_failed");
    });
  });

  describe("hours validation", () => {
    // The shape check alone let an owner save hours that can never produce a
    // slot: "25:00" is not a time of day, and start >= end (or no days at all)
    // is an empty window. Both used to 200, then quietly publish a page that
    // offers nothing — with nothing anywhere pointing at the config.
    async function putHours(hours: unknown): Promise<Response> {
      return authedApp().request("/booking-page", {
        method: "PUT", headers: json, body: JSON.stringify({ hours }),
      });
    }

    it("400s an out-of-range clock time", async () => {
      for (const hours of [
        { days: ["mon"], start: "25:00", end: "17:00" },
        { days: ["mon"], start: "09:00", end: "17:99" },
        { days: ["mon"], start: "9:00", end: "17:00" },
      ]) {
        const label = JSON.stringify(hours);
        const res = await putHours(hours);
        expect([label, res.status]).toEqual([label, 400]);
        expect([label, ((await res.json()) as { error: string }).error]).toEqual([label, "validation_failed"]);
      }
    });

    it("400s a window that starts at or after it ends", async () => {
      for (const [start, end] of [["17:00", "09:00"], ["09:00", "09:00"]]) {
        const res = await putHours({ days: ["mon"], start, end });
        expect([start, end, res.status]).toEqual([start, end, 400]);
        const body = (await res.json()) as { error: string; detail?: string };
        expect([start, end, body.error]).toEqual([start, end, "invalid_hours"]);
        expect(body.detail).toContain(start);
      }
    });

    it("400s an empty day list", async () => {
      const res = await putHours({ days: [], start: "09:00", end: "17:00" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
    });

    it("still accepts ordinary hours, and a whole-day window", async () => {
      for (const hours of [
        { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
        { days: ["sat"], start: "00:00", end: "23:59" },
      ]) {
        const label = JSON.stringify(hours);
        const res = await putHours(hours);
        expect([label, res.status]).toEqual([label, 200]);
        expect([label, ((await res.json()) as { hours: unknown }).hours]).toEqual([label, hours]);
      }
    });

    it("still accepts null, which falls back to the owner's business hours", async () => {
      expect((await putHours(null)).status).toBe(200);
    });
  });

  describe("location validation", () => {
    async function putLocation(modes: unknown): Promise<Response> {
      return authedApp().request("/booking-page", {
        method: "PUT", headers: json, body: JSON.stringify({ location: { modes } }),
      });
    }

    it("rejects a location set that offers nothing", async () => {
      const res = await putLocation([]);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_location");
    });

    it("rejects a detail on a kind that does not use one", async () => {
      const res = await putLocation([{ kind: "phone", detail: "+61 400 000 000" }]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.error).toBe("invalid_location");
      expect(body.detail).toContain("must not carry a detail");
    });

    it("rejects custom with no detail", async () => {
      const res = await putLocation([{ kind: "custom" }]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.error).toBe("invalid_location");
      expect(body.detail).toContain("requires a non-empty detail");
    });

    it("accepts the default set", async () => {
      const res = await putLocation([{ kind: "meet" }, { kind: "phone" }, { kind: "in_person" }]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { location: { modes: Array<{ kind: string }> } };
      expect(body.location.modes).toHaveLength(3);
    });

    it("accepts custom with detail", async () => {
      const res = await putLocation([{ kind: "custom", detail: "42 Example St" }]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { location: { modes: Array<{ kind: string; detail: string | null }> } };
      expect(body.location.modes).toEqual([{ kind: "custom", detail: "42 Example St" }]);
    });
  });

  it("409s when the slug is taken by another owner", async () => {
    await env.DB.prepare(
      "INSERT INTO config_booking_page (owner_subject, slug, body) VALUES (?, 'taken', '{}')",
    ).bind(OTHER).run();
    const res = await authedApp().request("/booking-page", {
      method: "PUT", headers: json, body: JSON.stringify({ slug: "taken" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("slug_taken");
  });

  it("writes only the caller's row — another owner's config is untouched", async () => {
    await env.DB.prepare(
      "INSERT INTO config_booking_page (owner_subject, slug, body) VALUES (?, 'other-page', '{\"enabled\":true}')",
    ).bind(OTHER).run();
    const res = await authedApp().request("/booking-page", {
      method: "PUT", headers: json, body: JSON.stringify({ slug: "mine", enabled: false }),
    });
    expect(res.status).toBe(200);
    const other = await env.DB
      .prepare("SELECT slug, body FROM config_booking_page WHERE owner_subject = ?")
      .bind(OTHER).first<{ slug: string; body: string }>();
    expect(other!.slug).toBe("other-page");
    expect(JSON.parse(other!.body).enabled).toBe(true);
    // ...and the caller reads back their own row, not the other owner's.
    const mine = (await (await authedApp().request("/booking-page")).json()) as { slug: string; enabled: boolean };
    expect(mine.slug).toBe("mine");
    expect(mine.enabled).toBe(false);
  });
});

describe("GET /v1/bookings", () => {
  it("401s without a bearer", async () => {
    expect((await v1.request("/bookings?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z", {}, env)).status).toBe(401);
  });

  it("lists bookings in the requested window", async () => {
    await insertBooking(OWNER, "b1", "2026-08-03T00:00:00Z", "2026-08-03T00:30:00Z", "sam@x.com");
    const res = await authedApp().request("/bookings?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bookings: Array<{ id: string; booker_email: string }> };
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]!.booker_email).toBe("sam@x.com");
  });

  it("includes the booker's chosen location in the listing", async () => {
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, booker_note, ip_hash, status, google_event_id, created_at, updated_at,
         location_kind, location_detail)
       VALUES ('b-loc',?,'victor','2026-08-03T00:00:00Z','2026-08-03T00:30:00Z',30,'Sam',?,NULL,'h','confirmed',NULL,
         '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','phone','+61 400 000 000')`,
    ).bind(OWNER, "sam@x.com").run();
    const res = await authedApp().request("/bookings?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bookings: Array<{ id: string; location_kind: string | null; location_detail: string | null }>;
    };
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]!.location_kind).toBe("phone");
    expect(body.bookings[0]!.location_detail).toBe("+61 400 000 000");
  });

  it("surfaces poll_id for a poll-made booking, and null for a booking-page booking", async () => {
    await insertBooking(OWNER, "b-page", "2026-08-03T00:00:00Z", "2026-08-03T00:30:00Z", "page@x.com");
    await insertPollBooking(OWNER, "b-poll", "2026-08-04T00:00:00Z", "2026-08-04T00:30:00Z", "poll@x.com", "poll-123");
    const res = await authedApp().request("/bookings?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bookings: Array<{ id: string; poll_id: string | null }> };
    expect(body.bookings).toHaveLength(2);
    const byId = Object.fromEntries(body.bookings.map((b) => [b.id, b.poll_id]));
    expect(byId["b-page"]).toBeNull();
    expect(byId["b-poll"]).toBe("poll-123");
  });

  it("400s a malformed window instead of 500ing", async () => {
    // from/to reach `new Date(iso).toISOString()`, which throws RangeError on
    // junk. With no onError handler that surfaces as a bodyless 500, unlike
    // every other /v1 validation failure.
    const res = await authedApp().request("/bookings?from=not-a-date&to=2026-08-31T00:00:00Z");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
  });

  it("accepts an offset-bearing ISO 8601 window", async () => {
    // What bin/booking-smoke.py sends: datetime.isoformat() yields microseconds
    // and a +00:00 offset, never a 'Z'. Both must keep working.
    const res = await authedApp().request(
      "/bookings?from=2026-08-01T00:00:00.123456%2B00:00&to=2026-08-31T00:00:00%2B10:00",
    );
    expect(res.status).toBe(200);
  });

  it("never returns another owner's bookings", async () => {
    await insertBooking(OTHER, "b-other", "2026-08-03T00:00:00Z", "2026-08-03T00:30:00Z", "leak@x.com");
    const window = "?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z";

    const mine = await authedApp().request(`/bookings${window}`);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { bookings: unknown[] }).bookings).toHaveLength(0);

    // The row is there — it is only invisible to the wrong caller.
    const theirs = await authedApp(OTHER_TOKEN).request(`/bookings${window}`);
    const body = (await theirs.json()) as { bookings: Array<{ id: string }> };
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]!.id).toBe("b-other");
  });
});
