import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { resolveBookableOverIds, RESOLVE_HEADROOM_MINUTES } from "../../src/booking/bookable-over";
import { MOVABLE_VERDICT_MAX_AGE_MS, type MovableVerdict } from "../../src/meetings/movable-verdict";
import type { CalendarEvent } from "../../src/providers/types";

const OWNER = "over-owner@org";
const NOW = new Date("2026-08-01T00:00:00Z");
const SOON = "2026-08-01T00:30:00Z";   // inside a 60-minute notice window
const LATER = "2026-08-05T00:00:00Z";  // well beyond it

/** A fresh "the planner really can move this" verdict, as the last resolve
 *  would have stamped it. */
const FRESH_OK: MovableVerdict = { at: "2026-07-31T23:00:00Z", ok: true, reason: null };

/** An owned movable meeting: organiser is self, one external attendee. */
function meeting(id: string, start: string): CalendarEvent {
  return {
    id,
    summary: "1:1",
    start,
    end: new Date(Date.parse(start) + 1800_000).toISOString(),
    organizer: { self: true },
    attendees: [{ email: "teammate@org" }],
  } as CalendarEvent;
}

async function seedMeetingTask(
  id: string,
  eventId: string,
  pinned: boolean,
  verdict: MovableVerdict | null = FRESH_OK,
  status = "committed",
) {
  const body = JSON.stringify({
    title: "1:1",
    pinned_at: pinned ? "2026-07-30T00:00:00Z" : null,
    source: { kind: "meeting", external_id: eventId },
    ...(verdict ? { movable_verdict: verdict } : {}),
  });
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, OWNER, body, status, "2026-07-30T00:00:00Z", "2026-07-30T00:00:00Z").run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tasks WHERE owner_subject = ?").bind(OWNER).run();
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER).run();
});

describe("resolveBookableOverIds", () => {
  it("is empty when the flag is off", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: false, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("includes an unpinned movable meeting beyond the notice window", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect([...ids]).toEqual(["evt-1"]);
  });

  it("excludes a pinned meeting", async () => {
    await seedMeetingTask("t1", "evt-1", true);
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes a meeting inside the notice window", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", SOON)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  // --- The resolve-headroom gate -----------------------------------------
  // resolve-internal.ts freezes a meeting as imminent_notice at the exact same
  // `start >= now + minNoticeMinutes` boundary this module used to offer its
  // slot on. A meeting starting right at that boundary could be offered and
  // claimed, then fall inside the notice window (and freeze) by the time the
  // webhook-triggered follow-up resolve runs — a permanent double-booking.
  // RESOLVE_HEADROOM_MINUTES pushes the offer/claim gate beyond the freeze
  // boundary so the follow-up resolve is still clear of it when it runs.

  it("excludes a meeting starting exactly at the notice boundary (no headroom)", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const atBoundary = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", atBoundary)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes a meeting one minute short of the full notice+headroom boundary", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const justUnder = new Date(NOW.getTime() + (60 + RESOLVE_HEADROOM_MINUTES) * 60_000 - 60_000).toISOString();
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", justUnder)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("includes a meeting exactly at the notice+headroom boundary", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const atHeadroom = new Date(NOW.getTime() + (60 + RESOLVE_HEADROOM_MINUTES) * 60_000).toISOString();
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", atHeadroom)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect([...ids]).toEqual(["evt-1"]);
  });

  it("excludes a meeting with no task row (never imported, or degraded)", async () => {
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes an event that already has a confirmed booking", async () => {
    // Regression: a booking is itself an owned meeting with one external
    // attendee, so without this a second booker could take a booked slot.
    await seedMeetingTask("t1", "evt-1", false);
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, google_event_id, created_at, updated_at)
       VALUES ('b1',?,'victor',?,?,30,'Sam','sam@x.com','h','confirmed','evt-1',?,?)`,
    ).bind(OWNER, LATER, LATER, NOW.toISOString(), NOW.toISOString()).run();
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("does not suppress a candidate whose only matching booking row is in the past", async () => {
    // The bookings scan is bounded to start_utc > now: rows are never deleted
    // (only offboard clears them), and every candidate event starts in the
    // future, so a past booking's google_event_id can never legitimately
    // collide with a future candidate. This pins that boundary — it is not a
    // real-world case (ids aren't reused), but it documents that only future
    // bookings can exclude a candidate.
    await seedMeetingTask("t1", "evt-1", false);
    const PAST = "2026-07-01T00:00:00Z"; // before NOW
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, google_event_id, created_at, updated_at)
       VALUES ('b1',?,'victor',?,?,30,'Sam','sam@x.com','h','confirmed','evt-1',?,?)`,
    ).bind(OWNER, PAST, PAST, NOW.toISOString(), NOW.toISOString()).run();
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect([...ids]).toEqual(["evt-1"]);
  });

  it("excludes an event that is not an owned movable meeting", async () => {
    await seedMeetingTask("t1", "evt-1", false);
    const soloEvent = { ...meeting("evt-1", LATER), attendees: [] } as CalendarEvent;
    const ids = await resolveBookableOverIds(env.DB, OWNER, [soloEvent], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  // --- The movable verdict gate ------------------------------------------
  // pinned_at was never a proxy for "the planner can move this": the planner's
  // degrade-to-immovable is in-memory per resolve and writes nothing, so a
  // meeting frozen for unreadable attendee free/busy kept a NULL pinned_at
  // forever. Only the persisted verdict says what the planner actually decided.

  it("excludes a meeting whose row carries NO verdict (never resolved, or pre-dates the verdict)", async () => {
    await seedMeetingTask("t1", "evt-1", false, null);
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes a meeting the last resolve FROZE (verdict ok:false)", async () => {
    // The headline case: attendee free/busy was unreadable, so this meeting can
    // never be relocated — offering its time would double-book permanently.
    await seedMeetingTask("t1", "evt-1", false, {
      at: "2026-07-31T23:00:00Z", ok: false, reason: "attendee_availability_unknown",
    });
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes a meeting whose ok:true verdict is stale", async () => {
    const stale = new Date(NOW.getTime() - MOVABLE_VERDICT_MAX_AGE_MS - 60_000).toISOString();
    await seedMeetingTask("t1", "evt-1", false, { at: stale, ok: true, reason: null });
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("includes a meeting whose ok:true verdict is just inside the freshness window", async () => {
    const edge = new Date(NOW.getTime() - MOVABLE_VERDICT_MAX_AGE_MS + 60_000).toISOString();
    await seedMeetingTask("t1", "evt-1", false, { at: edge, ok: true, reason: null });
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect([...ids]).toEqual(["evt-1"]);
  });

  it("excludes a meeting whose verdict timestamp is unparseable", async () => {
    await seedMeetingTask("t1", "evt-1", false, { at: "not-a-date", ok: true, reason: null });
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes a DONE meeting task even with a fresh ok:true verdict", async () => {
    // A meeting task that has gone done drops out of the resolve's solver set,
    // so it stops being re-stamped and its last ok:true verdict lingers until it
    // ages out. The verdict is only ever a claim about a task the planner is
    // still managing — a terminal one it is not — so distrust it here rather
    // than widen the resolve's write set to keep stamping dead rows.
    await seedMeetingTask("t1", "evt-1", false, FRESH_OK, "done");
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("excludes a CANCELLED meeting task even with a fresh ok:true verdict", async () => {
    // The other terminal status (syncOwnedMeetings sets it when the meeting's
    // event disappears from its window). Same reasoning.
    await seedMeetingTask("t1", "evt-1", false, FRESH_OK, "cancelled");
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it("still includes a PENDING meeting task (non-terminal statuses are unaffected)", async () => {
    // The negative control: the terminal-status gate must not swallow the
    // ordinary lifecycle states a live meeting row moves through.
    await seedMeetingTask("t1", "evt-1", false, FRESH_OK, "pending");
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect([...ids]).toEqual(["evt-1"]);
  });

  it("excludes a hand-pinned meeting even with a fresh ok:true verdict", async () => {
    // A pin set AFTER the resolve is newer information than the verdict, and
    // build-problem holds a pinned task in place — so the planner would not in
    // fact move it.
    await seedMeetingTask("t1", "evt-1", true, FRESH_OK);
    const ids = await resolveBookableOverIds(env.DB, OWNER, [meeting("evt-1", LATER)], {
      enabled: true, minNoticeMinutes: 60, now: NOW,
    });
    expect(ids.size).toBe(0);
  });
});
