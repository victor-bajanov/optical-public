import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  claimSlot, confirmBooking, failBooking, listBookings, countRecentByIp, countTodayByOwner,
} from "../../src/db/bookings";

const OWNER = "claim-owner@org";

function req(over: Partial<Parameters<typeof claimSlot>[1]> = {}) {
  return {
    ownerSubject: OWNER,
    slug: "victor",
    startUtc: "2026-08-04T00:00:00Z",
    endUtc: "2026-08-04T00:30:00Z",
    durationMinutes: 30,
    bookerName: "Sam",
    bookerEmail: "sam@x.com",
    bookerNote: null,
    ipHash: "iphash",
    guardStartUtc: "2026-08-04T00:00:00Z",
    guardEndUtc: "2026-08-04T00:40:00Z", // buffer-expanded
    now: new Date("2026-08-01T00:00:00Z"),
    locationKind: "meet",
    locationDetail: null,
    ...over,
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER).run();
});

describe("claimSlot", () => {
  it("claims a free slot as 'reserving'", async () => {
    const claim = await claimSlot(env.DB, req());
    expect(claim).not.toBeNull();
    const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(claim!.id).first<{ status: string }>();
    expect(row!.status).toBe("reserving");
  });

  it("lets exactly one of two identical concurrent claims win", async () => {
    const [a, b] = await Promise.all([claimSlot(env.DB, req()), claimSlot(env.DB, req())]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("rejects a claim that overlaps a longer existing booking", async () => {
    await claimSlot(env.DB, req({ endUtc: "2026-08-04T01:00:00Z", guardEndUtc: "2026-08-04T01:10:00Z", durationMinutes: 60 }));
    const later = await claimSlot(env.DB, req({
      startUtc: "2026-08-04T00:30:00Z", endUtc: "2026-08-04T01:00:00Z",
      guardStartUtc: "2026-08-04T00:30:00Z", guardEndUtc: "2026-08-04T01:10:00Z",
    }));
    expect(later).toBeNull();
  });

  it("rejects a claim that only overlaps the buffer", async () => {
    await claimSlot(env.DB, req());
    const adjacent = await claimSlot(env.DB, req({
      startUtc: "2026-08-04T00:35:00Z", endUtc: "2026-08-04T01:05:00Z",
      guardStartUtc: "2026-08-04T00:35:00Z", guardEndUtc: "2026-08-04T01:15:00Z",
    }));
    expect(adjacent).toBeNull(); // first booking's row ends 00:30 but guard ran to 00:40
  });

  it("allows a claim starting exactly where the previous booking's padding ends", async () => {
    await claimSlot(env.DB, req()); // 00:00-00:30, padded to 00:40
    const abutting = await claimSlot(env.DB, req({
      startUtc: "2026-08-04T00:40:00Z", endUtc: "2026-08-04T01:10:00Z",
      guardStartUtc: "2026-08-04T00:40:00Z", guardEndUtc: "2026-08-04T01:20:00Z",
    }));
    expect(abutting).not.toBeNull(); // touching padding is not overlapping it
  });

  it("rejects a claim that fully contains an existing booking", async () => {
    await claimSlot(env.DB, req());
    const engulfing = await claimSlot(env.DB, req({
      startUtc: "2026-08-03T23:00:00Z", endUtc: "2026-08-04T02:00:00Z",
      guardStartUtc: "2026-08-03T23:00:00Z", guardEndUtc: "2026-08-04T02:10:00Z",
      durationMinutes: 180,
    }));
    expect(engulfing).toBeNull();
  });

  it("allows the touching earlier slot when bounds carry milliseconds", async () => {
    // `new Date(ms).toISOString()` — exactly the form the route passes — yields
    // '...:00.000Z'. Under BINARY collation '.' sorts before 'Z', so a guard
    // that compares mixed precisions reads a touching pair as overlapping.
    const later = await claimSlot(env.DB, req({
      startUtc: "2026-08-04T10:30:00.000Z", endUtc: "2026-08-04T11:00:00.000Z",
      guardStartUtc: "2026-08-04T10:30:00.000Z", guardEndUtc: "2026-08-04T11:00:00.000Z",
    }));
    expect(later).not.toBeNull();
    const earlier = await claimSlot(env.DB, req({
      startUtc: "2026-08-04T10:00:00.000Z", endUtc: "2026-08-04T10:30:00.000Z",
      guardStartUtc: "2026-08-04T10:00:00.000Z", guardEndUtc: "2026-08-04T10:30:00.000Z",
    }));
    expect(earlier).not.toBeNull(); // 10:00-10:30 only touches 10:30-11:00
  });

  it("stores bounds in one canonical format regardless of input precision", async () => {
    const claim = await claimSlot(env.DB, req({
      startUtc: "2026-08-04T10:00:00.000Z", endUtc: "2026-08-04T10:30:00.000Z",
      guardStartUtc: "2026-08-04T10:00:00.000Z", guardEndUtc: "2026-08-04T10:40:00.000Z",
    }));
    const row = await env.DB.prepare("SELECT start_utc, end_utc, created_at FROM bookings WHERE id = ?")
      .bind(claim!.id).first<{ start_utc: string; end_utc: string; created_at: string }>();
    expect(row).toEqual({
      start_utc: "2026-08-04T10:00:00Z",
      end_utc: "2026-08-04T10:30:00Z",
      created_at: "2026-08-01T00:00:00Z",
    });
  });

  it("does not block on a failed row", async () => {
    const first = await claimSlot(env.DB, req());
    await failBooking(env.DB, first!.id, new Date("2026-08-01T00:01:00Z"));
    expect(await claimSlot(env.DB, req())).not.toBeNull();
  });

  it("stores the booker's location choice", async () => {
    const claim = await claimSlot(env.DB, req({
      locationKind: "phone",
      locationDetail: "+61 400 000 000",
    }));
    expect(claim).not.toBeNull();
    const row = await env.DB.prepare("SELECT location_kind, location_detail FROM bookings WHERE id = ?")
      .bind(claim!.id)
      .first<{ location_kind: string; location_detail: string | null }>();
    expect(row).toEqual({ location_kind: "phone", location_detail: "+61 400 000 000" });
  });

  it("stores a null detail for a kind that collects nothing", async () => {
    const claim = await claimSlot(env.DB, req({
      locationKind: "meet",
      locationDetail: null,
    }));
    expect(claim).not.toBeNull();
    const row = await env.DB.prepare("SELECT location_detail FROM bookings WHERE id = ?")
      .bind(claim!.id)
      .first<{ location_detail: string | null }>();
    expect(row!.location_detail).toBeNull();
  });
});

describe("confirmBooking", () => {
  it("stores the google event id and flips status", async () => {
    const claim = await claimSlot(env.DB, req());
    await confirmBooking(env.DB, claim!.id, "gcal-1", new Date("2026-08-01T00:02:00Z"));
    const row = await env.DB.prepare("SELECT status, google_event_id FROM bookings WHERE id = ?")
      .bind(claim!.id).first<{ status: string; google_event_id: string }>();
    expect(row).toEqual({ status: "confirmed", google_event_id: "gcal-1" });
  });
});

describe("rate-limit counters", () => {
  it("counts recent claims by ip and today's claims by owner", async () => {
    await claimSlot(env.DB, req());
    const now = new Date("2026-08-01T00:05:00Z");
    expect(await countRecentByIp(env.DB, "iphash", now, 24)).toBe(1);
    expect(await countRecentByIp(env.DB, "other", now, 24)).toBe(0);
    expect(await countTodayByOwner(env.DB, OWNER, now)).toBe(1);
  });
});

describe("listBookings", () => {
  it("returns confirmed and reserving rows in a window, ascending", async () => {
    await claimSlot(env.DB, req());
    const rows = await listBookings(env.DB, OWNER, "2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.booker_email).toBe("sam@x.com");
  });

  it("surfaces NULL location columns from a pre-migration row unaltered", async () => {
    // ClaimRequest.locationKind is now required, so claimSlot can no longer
    // produce a null-location row — insert directly to stand in for a row
    // written before migration 0031 added the columns.
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, booker_note, ip_hash, status, google_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL, ?, ?)`,
    )
      .bind(
        "pre-migration-row", OWNER, "victor",
        "2026-08-05T00:00:00Z", "2026-08-05T00:30:00Z", 30,
        "Legacy", "legacy@x.com", null, "iphash-legacy",
        "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z",
      )
      .run();

    const rows = await listBookings(env.DB, OWNER, "2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z");
    const row = rows.find((r) => r.id === "pre-migration-row");
    expect(row).toBeDefined();
    expect(row!.location_kind).toBeNull();
    expect(row!.location_detail).toBeNull();
  });
});
