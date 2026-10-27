// tz-matrix mirror of the week-bucketing in test/webhooks/replan-helper.test.ts:
// a changed calendar event must re-resolve the LOCAL week it falls in, for a
// timed event and for an all-day event (whose provider shape is
// "<date>T00:00:00Z" from both Google and Graph).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runWebhookReplan } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { CalendarEvent } from "../../src/providers/types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, wall, wallIso } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const OK = { schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } };

async function seedDb() {
  for (const t of ["calendar_sync", "users", "tasks", "chunk_completions", "proposed_plans", "config_weights", "config_contexts"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
  await seedMissingDefaultContexts();
  await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', 'primary', ?, 'pending', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')")
    .bind(JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }))
    .run();
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok-old', 'ch-1', 'shared-secret', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/google-calendar')",
  ).run();
}

async function resolvedWeekStarts(tz: string, changed: CalendarEvent): Promise<string[]> {
  const starts: string[] = [];
  const solver = {
    fetch: async (_i: RequestInfo | URL, init?: RequestInit) => {
      starts.push((JSON.parse(init!.body as string) as { window: { start: string } }).window.start);
      return new Response(JSON.stringify(OK), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  const cal = new MockCalendarProvider({ events: [changed] });
  cal.fetchIncrementalChanges = async () => ({ changes: [{ kind: "upsert", event: changed }], nextSyncToken: "tok-new", syncTokenInvalidated: false });
  await runWebhookReplan({
    env: { ...env, SCHEDULER_TZ: tz, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com", DONE_COLOR_ID: "11" },
    calendar: cal,
    notify: new MockNotificationProvider(),
    accountEmail: "primary",
    oauthIssuer: "https://scheduler.example.com",
    dryRun: true,
  });
  return starts;
}

describe.each(ALL_ZONES)("runWebhookReplan week bucketing in %s", (tz) => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Sat 2026-07-11 12:00 local: the current local week is that of Mon 07-06.
    vi.setSystemTime(new Date(wall("2026-07-11", "12:00", tz)));
    await seedDb();
  });
  afterEach(() => vi.useRealTimers());

  it("a timed event on Mon 2026-07-13 11:00 local re-resolves the week of Mon 07-13", async () => {
    const ev = { id: "ext-1", summary: "Standup", start: wallIso("2026-07-13", "11:00", tz), end: wallIso("2026-07-13", "12:00", tz), extendedProperties: {} } as CalendarEvent;
    expect(await resolvedWeekStarts(tz, ev)).toEqual(["2026-07-13T00:00:00"]);
  });

  it("an all-day event on Mon 2026-07-13 re-resolves the week of Mon 07-13", async () => {
    const ev = { id: "ext-ad", summary: "Offsite", isAllDay: true, start: "2026-07-13T00:00:00.000Z", end: "2026-07-14T00:00:00.000Z", extendedProperties: {} } as CalendarEvent;
    expect(await resolvedWeekStarts(tz, ev)).toEqual(["2026-07-13T00:00:00"]);
  });
});
