import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  claimSlot, confirmBooking, markCancelPending, clearCancelPending,
  listCancelPendingDue, markCancelled, listBookings, listBookingsForOwner,
} from "../../src/db/bookings";

const OWNER = "cancel-pending-owner@org";
const OTHER_OWNER = "other-cancel-owner@org";

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
    guardEndUtc: "2026-08-04T00:40:00Z",
    now: new Date("2026-08-01T00:00:00Z"),
    locationKind: "meet",
    locationDetail: null,
    ...over,
  };
}

async function confirmedBooking(
  eventId = "gcal-decline-1",
  over: Partial<Parameters<typeof claimSlot>[1]> = {},
): Promise<string> {
  const claim = await claimSlot(env.DB, req(over));
  if (!claim) throw new Error(`claimSlot returned null for ${eventId} — slot override probably overlaps another test fixture`);
  await confirmBooking(env.DB, claim.id, eventId, new Date("2026-08-01T00:01:00Z"));
  return claim.id;
}

async function stampOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT cancel_pending_at FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ cancel_pending_at: string | null }>();
  return row?.cancel_pending_at ?? null;
}

async function statusOf(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row!.status;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject IN (?, ?)").bind(OWNER, OTHER_OWNER).run();
});

describe("0035 migration", () => {
  it("adds a nullable cancel_pending_at column to bookings", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(bookings)").all<{ name: string; notnull: number }>();
    const col = cols.results.find((c) => c.name === "cancel_pending_at");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("leaves existing rows with a NULL stamp", async () => {
    const id = await confirmedBooking();
    expect(await stampOf(id)).toBeNull();
  });

  it("adds a partial index on cancel_pending_at so the 5-min global sweep doesn't full-scan bookings", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bookings' AND name = 'bookings_cancel_pending'",
    ).first<{ sql: string }>();
    expect(row).toBeDefined();
    expect(row!.sql.toLowerCase()).toContain("where cancel_pending_at is not null");
  });
});

describe("markCancelPending", () => {
  it("stamps a confirmed, matching, non-poll row", async () => {
    const id = await confirmedBooking("gcal-decline-2");
    const changed = await markCancelPending(env.DB, id, OWNER, "gcal-decline-2", "2026-08-02T00:00:00Z");
    expect(changed).toBe(true);
    expect(await stampOf(id)).toBe("2026-08-02T00:00:00Z");
  });

  it("does not stamp when the event id doesn't match", async () => {
    const id = await confirmedBooking("gcal-decline-3");
    const changed = await markCancelPending(env.DB, id, OWNER, "some-other-event", "2026-08-02T00:00:00Z");
    expect(changed).toBe(false);
    expect(await stampOf(id)).toBeNull();
  });

  it("does not stamp a non-confirmed row", async () => {
    const claim = await claimSlot(env.DB, req({ startUtc: "2026-08-05T00:00:00Z", endUtc: "2026-08-05T00:30:00Z", guardStartUtc: "2026-08-05T00:00:00Z", guardEndUtc: "2026-08-05T00:40:00Z" }));
    // still 'reserving', never confirmed
    const changed = await markCancelPending(env.DB, claim!.id, OWNER, "irrelevant", "2026-08-02T00:00:00Z");
    expect(changed).toBe(false);
  });

  it("does not stamp a 'reserving' row even when its event id genuinely matches", async () => {
    // The plain "does not stamp a non-confirmed row" test above uses a
    // 'reserving' claim with a NULL google_event_id, so a broken query with
    // no status guard could still fail via the event-id clause alone and the
    // suite would stay green. Give the reserving row a REAL event id (as if
    // written directly, standing in for some other future write path) so
    // only the `status = 'confirmed'` clause can be the thing stopping this.
    const claim = await claimSlot(env.DB, req({ startUtc: "2026-08-10T00:00:00Z", endUtc: "2026-08-10T00:30:00Z", guardStartUtc: "2026-08-10T00:00:00Z", guardEndUtc: "2026-08-10T00:40:00Z" }));
    await env.DB.prepare("UPDATE bookings SET google_event_id = ? WHERE id = ?")
      .bind("gcal-still-reserving", claim!.id).run();
    const changed = await markCancelPending(env.DB, claim!.id, OWNER, "gcal-still-reserving", "2026-08-02T00:00:00Z");
    expect(changed).toBe(false);
    expect(await stampOf(claim!.id)).toBeNull();
  });

  it("does not stamp a poll-booked row", async () => {
    const claim = await claimSlot(env.DB, req({
      startUtc: "2026-08-06T00:00:00Z", endUtc: "2026-08-06T00:30:00Z",
      guardStartUtc: "2026-08-06T00:00:00Z", guardEndUtc: "2026-08-06T00:40:00Z",
      pollId: "poll-1",
    }));
    await confirmBooking(env.DB, claim!.id, "gcal-poll-event", new Date("2026-08-01T00:01:00Z"));
    const changed = await markCancelPending(env.DB, claim!.id, OWNER, "gcal-poll-event", "2026-08-02T00:00:00Z");
    expect(changed).toBe(false);
    expect(await stampOf(claim!.id)).toBeNull();
  });

  it("never resets an existing stamp (clock does not restart)", async () => {
    const id = await confirmedBooking("gcal-decline-4");
    const first = await markCancelPending(env.DB, id, OWNER, "gcal-decline-4", "2026-08-02T00:00:00Z");
    expect(first).toBe(true);
    const second = await markCancelPending(env.DB, id, OWNER, "gcal-decline-4", "2026-08-02T00:05:00Z");
    expect(second).toBe(false);
    expect(await stampOf(id)).toBe("2026-08-02T00:00:00Z");
  });

  it("stamps updated_at, like confirmBooking/failBooking/syncBookingTime do", async () => {
    const id = await confirmedBooking("gcal-decline-updated-at");
    await markCancelPending(env.DB, id, OWNER, "gcal-decline-updated-at", "2026-08-02T01:00:00Z");
    const row = await env.DB.prepare("SELECT updated_at FROM bookings WHERE id = ?")
      .bind(id).first<{ updated_at: string }>();
    expect(row!.updated_at).toBe("2026-08-02T01:00:00Z");
  });
});

describe("clearCancelPending", () => {
  it("nulls an existing stamp on a confirmed row", async () => {
    const id = await confirmedBooking("gcal-decline-5");
    await markCancelPending(env.DB, id, OWNER, "gcal-decline-5", "2026-08-02T00:00:00Z");
    await clearCancelPending(env.DB, id, OWNER, "gcal-decline-5", "2026-08-02T00:10:00Z");
    expect(await stampOf(id)).toBeNull();
  });

  it("stamps updated_at, like confirmBooking/failBooking/syncBookingTime do", async () => {
    const id = await confirmedBooking("gcal-decline-clear-updated-at");
    await markCancelPending(env.DB, id, OWNER, "gcal-decline-clear-updated-at", "2026-08-02T00:00:00Z");
    await clearCancelPending(env.DB, id, OWNER, "gcal-decline-clear-updated-at", "2026-08-02T02:00:00Z");
    const row = await env.DB.prepare("SELECT updated_at FROM bookings WHERE id = ?")
      .bind(id).first<{ updated_at: string }>();
    expect(row!.updated_at).toBe("2026-08-02T02:00:00Z");
  });

  it("is a no-op on a row that isn't confirmed", async () => {
    const claim = await claimSlot(env.DB, req({ startUtc: "2026-08-07T00:00:00Z", endUtc: "2026-08-07T00:30:00Z", guardStartUtc: "2026-08-07T00:00:00Z", guardEndUtc: "2026-08-07T00:40:00Z" }));
    // 'reserving' row, no stamp to clear, should not throw
    await expect(clearCancelPending(env.DB, claim!.id, OWNER, "irrelevant", "2026-08-02T00:00:00Z")).resolves.not.toThrow();
  });

  it("does not touch a stamp on a row that has already been cancelled (stamp survives as history)", async () => {
    // Without the `status = 'confirmed'` clause this test would still pass
    // if clearCancelPending only checked owner+event-id — it specifically
    // pins that a CANCELLED row's stamp is left alone.
    const id = await confirmedBooking("gcal-decline-6");
    await markCancelPending(env.DB, id, OWNER, "gcal-decline-6", "2026-08-02T00:00:00Z");
    await markCancelled(env.DB, id, "2026-08-02T00:10:00Z");
    await clearCancelPending(env.DB, id, OWNER, "gcal-decline-6", "2026-08-02T00:20:00Z");
    expect(await stampOf(id)).toBe("2026-08-02T00:00:00Z");
  });

  it("is a no-op — no row change, updated_at NOT bumped — on a confirmed row with no stamp running", async () => {
    // A high-volume caller (the webhook detector fires this on every
    // not-all-declined delivery of a tagged event, including the common case
    // where no clock was ever started) must not churn updated_at on a row
    // that has nothing to clear.
    const id = await confirmedBooking("gcal-decline-noop-clear");
    const before = await env.DB.prepare("SELECT updated_at FROM bookings WHERE id = ?")
      .bind(id).first<{ updated_at: string }>();
    const changed = await clearCancelPending(env.DB, id, OWNER, "gcal-decline-noop-clear", "2026-08-02T05:00:00Z");
    expect(changed).toBe(false);
    const after = await env.DB.prepare("SELECT updated_at FROM bookings WHERE id = ?")
      .bind(id).first<{ updated_at: string }>();
    expect(after!.updated_at).toBe(before!.updated_at);
  });

  it("returns true when it actually clears a running stamp", async () => {
    const id = await confirmedBooking("gcal-decline-clear-returns-true");
    await markCancelPending(env.DB, id, OWNER, "gcal-decline-clear-returns-true", "2026-08-02T00:00:00Z");
    const changed = await clearCancelPending(env.DB, id, OWNER, "gcal-decline-clear-returns-true", "2026-08-02T00:10:00Z");
    expect(changed).toBe(true);
  });
});

describe("listCancelPendingDue", () => {
  it("returns confirmed bookings whose stamp is at or before the cutoff", async () => {
    const dueId = await confirmedBooking("gcal-due");
    await markCancelPending(env.DB, dueId, OWNER, "gcal-due", "2026-08-02T00:00:00Z");

    const notDueId = await confirmedBooking("gcal-not-due", {
      startUtc: "2026-08-09T00:00:00Z", endUtc: "2026-08-09T00:30:00Z",
      guardStartUtc: "2026-08-09T00:00:00Z", guardEndUtc: "2026-08-09T00:40:00Z",
    });
    await markCancelPending(env.DB, notDueId, OWNER, "gcal-not-due", "2026-08-02T00:20:00Z");

    const rows = await listCancelPendingDue(env.DB, "2026-08-02T00:10:00Z");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(notDueId);
  });

  it("includes owner_subject, slug, google_event_id, booker fields, bounds, and location_kind", async () => {
    const id = await confirmedBooking("gcal-fields");
    await markCancelPending(env.DB, id, OWNER, "gcal-fields", "2026-08-02T00:00:00Z");
    const rows = await listCancelPendingDue(env.DB, "2026-08-02T00:10:00Z");
    const row = rows.find((r) => r.id === id);
    expect(row).toMatchObject({
      owner_subject: OWNER,
      slug: "victor",
      google_event_id: "gcal-fields",
      booker_name: "Sam",
      booker_email: "sam@x.com",
      start_utc: "2026-08-04T00:00:00Z",
      end_utc: "2026-08-04T00:30:00Z",
      location_kind: "meet",
    });
  });

  it("is global across owners, like the poll sweep", async () => {
    // Cleanup for OTHER_OWNER's row lives in the module-level beforeEach (it
    // deletes for both OWNER and OTHER_OWNER before every test), not inline
    // here — an inline DELETE at the end of the test body never runs if an
    // earlier assertion throws, leaking the row into later tests.
    const claim = await claimSlot(env.DB, {
      ...req({ ownerSubject: OTHER_OWNER, startUtc: "2026-08-08T00:00:00Z", endUtc: "2026-08-08T00:30:00Z", guardStartUtc: "2026-08-08T00:00:00Z", guardEndUtc: "2026-08-08T00:40:00Z" }),
    });
    await confirmBooking(env.DB, claim!.id, "gcal-other-owner", new Date("2026-08-01T00:01:00Z"));
    await markCancelPending(env.DB, claim!.id, OTHER_OWNER, "gcal-other-owner", "2026-08-02T00:00:00Z");

    const rows = await listCancelPendingDue(env.DB, "2026-08-02T00:10:00Z");
    expect(rows.map((r) => r.id)).toContain(claim!.id);
  });

  // Defense-in-depth: markCancelPending's own CAS clause already refuses to
  // stamp a poll row or one with a mismatched event id, so these rows are not
  // reachable via the normal write path today. Simulate them with a direct
  // UPDATE anyway — listCancelPendingDue is the query that actually deletes a
  // live calendar event, so its own WHERE clause should not depend solely on
  // markCancelPending's CAS never having a bug.
  it("excludes a stamped row that is a poll booking", async () => {
    const claim = await claimSlot(env.DB, req({
      startUtc: "2026-08-11T00:00:00Z", endUtc: "2026-08-11T00:30:00Z",
      guardStartUtc: "2026-08-11T00:00:00Z", guardEndUtc: "2026-08-11T00:40:00Z",
      pollId: "poll-defense-in-depth",
    }));
    await confirmBooking(env.DB, claim!.id, "gcal-poll-defense", new Date("2026-08-01T00:01:00Z"));
    await env.DB.prepare("UPDATE bookings SET cancel_pending_at = ? WHERE id = ?")
      .bind("2026-08-02T00:00:00Z", claim!.id).run();

    const rows = await listCancelPendingDue(env.DB, "2026-08-02T00:10:00Z");
    expect(rows.map((r) => r.id)).not.toContain(claim!.id);
  });

  it("excludes a stamped row with no google_event_id", async () => {
    const claim = await claimSlot(env.DB, req({
      startUtc: "2026-08-12T00:00:00Z", endUtc: "2026-08-12T00:30:00Z",
      guardStartUtc: "2026-08-12T00:00:00Z", guardEndUtc: "2026-08-12T00:40:00Z",
    }));
    await env.DB.prepare("UPDATE bookings SET status = 'confirmed', cancel_pending_at = ? WHERE id = ?")
      .bind("2026-08-02T00:00:00Z", claim!.id).run();

    const rows = await listCancelPendingDue(env.DB, "2026-08-02T00:10:00Z");
    expect(rows.map((r) => r.id)).not.toContain(claim!.id);
  });
});

describe("markCancelled", () => {
  it("flips a confirmed row to cancelled", async () => {
    const id = await confirmedBooking("gcal-cancel-1");
    const won = await markCancelled(env.DB, id, "2026-08-02T00:00:00Z");
    expect(won).toBe(true);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("stamps updated_at, like confirmBooking/failBooking/syncBookingTime do", async () => {
    const id = await confirmedBooking("gcal-cancel-updated-at");
    await markCancelled(env.DB, id, "2026-08-02T03:00:00Z");
    const row = await env.DB.prepare("SELECT updated_at FROM bookings WHERE id = ?")
      .bind(id).first<{ updated_at: string }>();
    expect(row!.updated_at).toBe("2026-08-02T03:00:00Z");
  });

  it("loses the CAS when the row is no longer confirmed", async () => {
    const id = await confirmedBooking("gcal-cancel-2");
    await markCancelled(env.DB, id, "2026-08-02T00:00:00Z"); // now cancelled
    const second = await markCancelled(env.DB, id, "2026-08-02T00:05:00Z");
    expect(second).toBe(false);
  });
});

describe("listBookings vs listBookingsForOwner with cancelled rows", () => {
  // listBookings is the slot-blocking set every availability computation
  // (booking/availability.ts, polls/route.ts, polls/booking.ts,
  // handlers/polls.ts) maps straight into a `busy` array — a cancelled row
  // must NOT appear there, or an auto-cancelled slot is never re-offered.
  it("listBookings excludes a cancelled row", async () => {
    const id = await confirmedBooking("gcal-list-1");
    await markCancelled(env.DB, id, "2026-08-02T00:00:00Z");
    const rows = await listBookings(env.DB, OWNER, "2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z");
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("does not let a cancelled row block a new claim on the same slot", async () => {
    const id = await confirmedBooking("gcal-list-2");
    await markCancelled(env.DB, id, "2026-08-02T00:00:00Z");
    const reclaim = await claimSlot(env.DB, req());
    expect(reclaim).not.toBeNull();
  });

  // listBookingsForOwner is the owner's management view ONLY
  // (handlers/booking-page.ts's GET /v1/bookings) — it deliberately widens
  // the set so the owner can see what auto-cancel did.
  it("listBookingsForOwner includes a cancelled row", async () => {
    const id = await confirmedBooking("gcal-list-3");
    await markCancelled(env.DB, id, "2026-08-02T00:00:00Z");
    const rows = await listBookingsForOwner(env.DB, OWNER, "2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z");
    expect(rows.map((r) => r.id)).toContain(id);
    expect(rows.find((r) => r.id === id)!.status).toBe("cancelled");
  });
});
