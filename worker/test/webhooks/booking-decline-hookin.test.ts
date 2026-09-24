import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runWebhookReplan } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { claimSlot, confirmBooking } from "../../src/db/bookings";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// Card C — webhook-side detection hook-in. Exercises detectBookingDeclines
// wired into runWebhookReplan (google-calendar.ts, right before the week
// bucketing) rather than the pure detector directly (see
// test/booking/decline-cancel.test.ts for that), so this is deliberately a
// thin, single-purpose file: one happy-path proof the hook fires at all, and
// one proof that a detection-side failure can never break the replan itself.

const OWNER = "primary";

const stubOkSolver = {
  fetch: async () =>
    new Response(
      JSON.stringify({
        schedule: [
          { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" },
        ],
        dropped: [],
        objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
        diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
} as unknown as Fetcher;

function makeEnv() {
  return { ...env, SOLVER: stubOkSolver, OAUTH_ISSUER: "https://scheduler.example.com", DONE_COLOR_ID: "11" };
}

async function seedDb(): Promise<void> {
  await env.DB.prepare("DELETE FROM calendar_sync").run();
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare("DELETE FROM chunk_completions").run();
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  await env.DB.prepare("DELETE FROM config_weights").run();
  await env.DB.prepare("DELETE FROM config_contexts").run();
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER).run();
  await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
    .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 }))
    .run();
  await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
    .bind("deep", JSON.stringify({
      context: "deep",
      fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
      max_minutes_per_day: 240,
      max_contiguous_minutes: 90,
      over_daily_cap_penalty_per_15min: 25,
      over_streak_cap_penalty_per_15min: 25,
    }))
    .run();
  await seedMissingDefaultContexts();
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  )
    .bind("t1", OWNER, JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z")
    .run();
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', 'tok-old', 'ch-1', 'shared-secret', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/google-calendar')",
  ).bind(OWNER).run();
}

/** Booking-page fixture: a confirmed booking whose event id matches the
 *  fabricated Google event the tests feed through the webhook. Well in the
 *  future relative to the frozen 2026-05-18 clock, and independent of the
 *  scheduler's own resolve window. */
async function confirmedBooking(
  eventId: string,
  over: Partial<Parameters<typeof claimSlot>[1]> = {},
): Promise<string> {
  const claim = await claimSlot(env.DB, {
    ownerSubject: OWNER,
    slug: "victor",
    startUtc: "2026-05-25T09:00:00Z",
    endUtc: "2026-05-25T09:30:00Z",
    durationMinutes: 30,
    bookerName: "Sam",
    bookerEmail: "sam@x.com",
    bookerNote: null,
    ipHash: "iphash",
    guardStartUtc: "2026-05-25T09:00:00Z",
    guardEndUtc: "2026-05-25T09:40:00Z",
    now: new Date("2026-05-17T00:00:00Z"),
    locationKind: "meet",
    locationDetail: null,
    ...over,
  });
  if (!claim) throw new Error("claimSlot returned null — fixture slot collided");
  await confirmBooking(env.DB, claim.id, eventId, new Date("2026-05-17T00:01:00Z"));
  return claim.id;
}

async function stampOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT cancel_pending_at FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ cancel_pending_at: string | null }>();
  return row?.cancel_pending_at ?? null;
}

describe("runWebhookReplan: booking-decline detection hook-in", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await seedDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps cancel_pending_at on the matching booking when a declined booking-page event arrives in the changed-event list", async () => {
    const bookingId = await confirmedBooking("gcal-hookin-1");
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "gcal-hookin-1",
            summary: "Booked meeting",
            start: "2026-05-25T09:00:00Z",
            end: "2026-05-25T09:30:00Z",
            attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
            extendedProperties: { private: { optical_booking: bookingId } },
          },
        },
      ],
      nextSyncToken: "tok-decline-1",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: OWNER,
      oauthIssuer: "https://scheduler.example.com",
      dryRun: true,
    });

    // The hook-in is additive to the normal replan flow — it still resolves
    // and reports the same result shape as any other non-scheduler-owned
    // change (finding #1: booking events pass isSignal unmodified).
    expect(result.kind).toBe("replanned");
    expect(await stampOf(bookingId)).toBe("2026-05-18T00:00:00Z");
  });

  it("a detection-side failure (throwing DB read) is caught and never breaks the replan", async () => {
    const bookingId = await confirmedBooking("gcal-hookin-2");
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "gcal-hookin-2",
            summary: "Booked meeting",
            start: "2026-05-25T09:00:00Z",
            end: "2026-05-25T09:30:00Z",
            attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
            extendedProperties: { private: { optical_booking: bookingId } },
          },
        },
      ],
      nextSyncToken: "tok-decline-2",
      syncTokenInvalidated: false,
    });

    // Only the bookings-table write the detector performs is broken; every
    // other query runWebhookReplan issues (calendar_sync, tasks, config_*,
    // proposed_plans) passes through untouched, so a real replan can still
    // complete around the failure.
    const realDb = env.DB;
    const throwingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("bookings")) throw new Error("simulated D1 outage on bookings");
            return Reflect.get(target, prop, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...makeEnv(), DB: throwingDb },
      calendar: cal,
      notify,
      accountEmail: OWNER,
      oauthIssuer: "https://scheduler.example.com",
      dryRun: true,
    });

    // The replan completes exactly as it would without the throwing DB —
    // detection's failure is fully isolated by its own try/catch.
    expect(result.kind).toBe("replanned");

    // And, as a consequence of the same throwing proxy, no stamp landed.
    const row = await realDb.prepare("SELECT cancel_pending_at FROM bookings WHERE id = ?").bind(bookingId).first<{ cancel_pending_at: string | null }>();
    expect(row?.cancel_pending_at ?? null).toBeNull();
  });

  it("also stamps via the full-window fallback fetch (no sync token → fetchEventsInWindow, not fetchIncrementalChanges)", async () => {
    // seedDb() leaves a real sync token in place (the incremental path,
    // exercised by the tests above); null it here so runWebhookReplan takes
    // the "full_notoken" branch and calls calendar.fetchEventsInWindow
    // instead — the fallback path used on first sync / after a token was
    // never issued, distinct in code from the incremental delivery path.
    await env.DB.prepare("UPDATE calendar_sync SET next_sync_token = NULL WHERE owner_subject = ?").bind(OWNER).run();

    // Inside the fallback's DEFAULT_DETECT_DAYS=7 window from the frozen
    // 2026-05-18 clock (which ends 2026-05-25T00:00:00Z) — the confirmedBooking
    // default fixture (2026-05-25T09:00) falls just outside it, so this test
    // needs its own, earlier slot.
    const bookingId = await confirmedBooking("gcal-hookin-4", {
      startUtc: "2026-05-20T09:00:00Z", endUtc: "2026-05-20T09:30:00Z",
      guardStartUtc: "2026-05-20T09:00:00Z", guardEndUtc: "2026-05-20T09:40:00Z",
    });

    // Constructor-supplied events are what fetchEventsInWindow filters and
    // returns; deliberately do NOT override fetchIncrementalChanges — with no
    // sync token, runWebhookReplan never calls it.
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "gcal-hookin-4",
          summary: "Booked meeting",
          start: "2026-05-20T09:00:00Z",
          end: "2026-05-20T09:30:00Z",
          attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
          extendedProperties: { private: { optical_booking: bookingId } },
        },
      ],
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: OWNER,
      oauthIssuer: "https://scheduler.example.com",
      dryRun: true,
    });

    expect(result.kind).toBe("replanned");
    expect(await stampOf(bookingId)).toBe("2026-05-18T00:00:00Z");
  });
});
