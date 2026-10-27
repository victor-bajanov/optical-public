// tz-matrix mirror of test/cron/monday-resolve.test.ts's home_tz cases: the
// Monday cron (fires Sun 15:00Z) must resolve each user's upcoming local week,
// keep their backlog, and carry their recurring Monday occurrence.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runMondayResolve } from "../../src/cron/monday-resolve";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, addDays, dayStartIso, local } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const FIRES = ["2026-05-17T15:00:00Z", "2026-01-11T15:00:00Z"];
const OK = { schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } };

async function seed(tz: string) {
  for (const t of ["users", "tasks", "task_templates", "proposed_plans", "config_weights", "config_contexts"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
  await seedMissingDefaultContexts();
  await env.DB.prepare("INSERT INTO users (subject, home_tz, created_at) VALUES ('primary', ?, '2025-12-01T00:00:00Z')").bind(tz).run();
  await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', 'primary', ?, 'pending', '2025-12-01T00:00:00Z', '2025-12-01T00:00:00Z')")
    .bind(JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 })).run();
  await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES ('tpl-mon', 'primary', ?, '2025-12-01', NULL)")
    .bind(JSON.stringify({ title: "Weekly review", context: "admin", rrule: "FREQ=WEEKLY;BYDAY=MO", duration_minutes: 30, active_from: "2025-12-01" })).run();
}

describe.each(ALL_ZONES)("runMondayResolve for a %s home_tz user", (tz) => {
  afterEach(() => vi.useRealTimers());

  it.each(FIRES)("fire at %s: upcoming local week, backlog kept, this week's recurring Monday present", async (fire) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fire));
    await seed(tz);
    const l = local(Date.parse(fire), tz);
    const mon = l.weekday === 1 ? l.date : addDays(l.date, 1);
    let tasks: Array<{ id: string; earliest_start?: string }> = [];
    const solver = { fetch: async (_i: RequestInfo | URL, init?: RequestInit) => {
      tasks = (JSON.parse(init!.body as string) as { tasks: typeof tasks }).tasks;
      return new Response(JSON.stringify(OK), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    const fetched: string[][] = [];
    const orig = cal.fetchEventsInWindow.bind(cal);
    cal.fetchEventsInWindow = async (s: string, e: string, o?: { syncToken?: boolean }) => {
      fetched.push([new Date(s).toISOString(), new Date(e).toISOString()]);
      return orig(s, e, o);
    };
    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: new MockNotificationProvider(),
      accountEmail: "primary",
      now: new Date(fire),
    });
    expect(result.kind).toBe("ok");
    expect(fetched).toContainEqual([dayStartIso(mon, tz), dayStartIso(addDays(mon, 7), tz)]);
    expect.soft(tasks.map((t) => t.id), "backlog").toContain("t1");
    const recurring = tasks.filter((t) => t.id !== "t1").map((t) => t.earliest_start);
    expect.soft(recurring, "recurring Monday").toEqual([`${mon}T00:00:00`]);
  });
});
