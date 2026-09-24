import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("migration 0030", () => {
  it("creates config_booking_page with a seeded defaults row", async () => {
    const row = await env.DB.prepare(
      "SELECT slug, body FROM config_booking_page WHERE owner_subject = '__default__'",
    ).first<{ slug: string | null; body: string }>();
    expect(row).not.toBeNull();
    expect(row!.slug).toBeNull();
    const body = JSON.parse(row!.body);
    expect(body.enabled).toBe(false);
    expect(body.durations_minutes).toEqual([30, 60]);
    expect(body.bookable_over_movable_meetings).toBe(false);
    expect(body.buffer_minutes).toEqual({ before: 0, after: 10 });
    // `location` is owned by 0031 now (migrations apply cumulatively before
    // every test, so this row is already rewritten) — see the "migration
    // 0031" suite below for the assertion on that shape.
  });

  it("allows many NULL slugs but rejects duplicate real slugs", async () => {
    await env.DB.prepare(
      "INSERT INTO config_booking_page (owner_subject, slug, body) VALUES ('a@org', NULL, '{}')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO config_booking_page (owner_subject, slug, body) VALUES ('b@org', 'victor', '{}')",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO config_booking_page (owner_subject, slug, body) VALUES ('c@org', 'victor', '{}')",
      ).run(),
    ).rejects.toThrow();
  });

  it("creates the bookings table", async () => {
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, created_at, updated_at)
       VALUES ('b1','o@org','victor','2026-08-04T00:00:00Z','2026-08-04T00:30:00Z',30,
         'Sam','sam@x.com','hash','reserving','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`,
    ).run();
    const got = await env.DB.prepare("SELECT status FROM bookings WHERE id = 'b1'").first<{ status: string }>();
    expect(got!.status).toBe("reserving");
  });
});

describe("migration 0031", () => {
  it("adds the booker's location answer to bookings", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(bookings)").all<{ name: string }>();
    const names = cols.results.map((c) => c.name);
    expect(names).toContain("location_kind");
    expect(names).toContain("location_detail");
  });

  it("rewrites the __default__ config row to the array shape", async () => {
    const row = await env.DB.prepare(
      "SELECT body FROM config_booking_page WHERE owner_subject = '__default__'",
    ).first<{ body: string }>();
    const location = JSON.parse(row!.body).location;
    expect(location.modes).toEqual([{ kind: "meet" }, { kind: "phone" }, { kind: "in_person" }]);
    expect(location.mode).toBeUndefined();
  });
});
