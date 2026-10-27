// tz-matrix for the resolve path (mirrors the tz-relevant parts of
// test/planning/resolve-internal.test.ts, test/planning/build-problem.test.ts
// "expands an all-day busy event", test/recurrence/sweep.test.ts and
// test/planning/parse-solution.test.ts). Each zone is the deployment
// SCHEDULER_TZ (no users row, so getHomeTz falls back to it), and the window is
// that zone's local week, exactly as the cron/webhook callers derive it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { parseSolution } from "../../src/planning/parse-solution";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, addDays, dayStart, dayStartIso, local, midnightGapDate, wallIso } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const OWNER = "primary";
const OK = { objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } };

interface Captured {
  tasks: Array<{ id: string; earliest_start?: string; pinned_at?: string | null }>;
  external_pinned: Array<{ id: string; start: string; duration_minutes: number }>;
}

function solver(schedule: unknown[] = [], sink?: (p: Captured) => void): Fetcher {
  return {
    fetch: async (_i: RequestInfo | URL, init?: RequestInit) => {
      sink?.(JSON.parse(init!.body as string) as Captured);
      return new Response(JSON.stringify({ schedule, dropped: [], ...OK }), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
}

async function reset() {
  for (const t of ["users", "tasks", "task_templates", "chunk_completions", "proposed_plans", "config_weights", "config_contexts", "template_exclusions"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
  await seedMissingDefaultContexts();
}

async function addTemplate(id: string, body: Record<string, unknown>) {
  await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, '2026-01-01', NULL)")
    .bind(id, OWNER, JSON.stringify({ title: id, context: "admin", duration_minutes: 30, active_from: "2026-01-01", ...body }))
    .run();
}

// MockCalendarProvider.fetchEventsInWindow keeps only events wholly INSIDE the
// window; Google and Graph return every event that OVERLAPS it. Use overlap here
// so an all-day event on a week's Sunday (which ends after a +offset week end)
// isn't silently dropped by the harness.
class OverlapCalendar extends MockCalendarProvider {
  constructor(private readonly all: CalendarEvent[]) {
    super({ events: all });
  }
  override async fetchEventsInWindow(start: string, end: string) {
    const s = Date.parse(start);
    const e = Date.parse(end);
    return { events: this.all.filter((ev) => Date.parse(ev.end) > s && Date.parse(ev.start) < e), nextSyncToken: "overlap-1" };
  }
}

async function resolveWeek(tz: string, mon: string, opts: { events?: CalendarEvent[]; schedule?: unknown[] } = {}) {
  let captured: Captured | undefined;
  const r = await runResolve({
    env: { ...env, SCHEDULER_TZ: tz, SOLVER: solver(opts.schedule ?? [], (p) => (captured = p)) },
    calendar: new OverlapCalendar(opts.events ?? []),
    windowStart: dayStartIso(mon, tz),
    windowEnd: dayStartIso(addDays(mon, 7), tz),
    accountEmail: OWNER,
    trigger: "api",
  });
  return { r, captured };
}

const MON = "2026-07-13";

describe.each(ALL_ZONES)("runResolve over the local week in %s", (tz) => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Just before the week starts locally (Sun 23:00 local), so the week is current/upcoming.
    vi.setSystemTime(new Date(dayStart(MON, tz) - 3_600_000));
    await reset();
  });
  afterEach(() => vi.useRealTimers());

  it("a weekly Monday template (unpinned) reaches the solver as THIS week's Monday", async () => {
    await addTemplate("tpl-mon", { rrule: "FREQ=WEEKLY;BYDAY=MO" });
    const { r, captured } = await resolveWeek(tz, MON);
    expect(r.kind).toBe("ok");
    const occ = await env.DB.prepare("SELECT occurrence_date FROM tasks WHERE template_id = 'tpl-mon' ORDER BY occurrence_date").all<{ occurrence_date: string }>();
    expect(occ.results.map((x) => x.occurrence_date)).toEqual([MON]);
    expect(captured!.tasks.map((t) => t.earliest_start)).toEqual([`${MON}T00:00:00`]);
  });

  it("a weekly Monday template pinned 09:30 reaches the solver pinned at this Monday 09:30 local", async () => {
    await addTemplate("tpl-mon-p", { rrule: "FREQ=WEEKLY;BYDAY=MO", pinned_time: "09:30" });
    const { r, captured } = await resolveWeek(tz, MON);
    expect(r.kind).toBe("ok");
    expect(captured!.tasks.map((t) => t.pinned_at)).toEqual([`${MON}T09:30:00`]);
  });

  it("a DAILY template yields seven occurrences in the week, Mon..Sun local", async () => {
    await addTemplate("tpl-daily", { rrule: "FREQ=DAILY" });
    const { captured } = await resolveWeek(tz, MON);
    expect(captured!.tasks.map((t) => t.earliest_start!.slice(0, 10)).sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(MON, i)));
  });

  it("two consecutive weekly resolves: each week's solver problem carries its own Monday", async () => {
    await addTemplate("tpl-mon", { rrule: "FREQ=WEEKLY;BYDAY=MO" });
    const w1 = await resolveWeek(tz, MON);
    vi.setSystemTime(new Date(dayStart(addDays(MON, 7), tz) - 3_600_000));
    const w2 = await resolveWeek(tz, addDays(MON, 7));
    expect.soft(w1.captured!.tasks.map((t) => t.earliest_start), "week 1").toEqual([`${MON}T00:00:00`]);
    expect.soft(w2.captured!.tasks.map((t) => t.earliest_start), "week 2").toEqual([`${addDays(MON, 7)}T00:00:00`]);
  });

  it("an all-day 'Vacation' on Tue reaches the solver as Tue 00:00 local for 1440 minutes", async () => {
    const vac = { id: "vac", summary: "Vacation", isAllDay: true, start: "2026-07-14T00:00:00.000Z", end: "2026-07-15T00:00:00.000Z", extendedProperties: {} } as CalendarEvent;
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', ?, ?, 'pending', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')")
      .bind(OWNER, JSON.stringify({ title: "Deep", context: "deep", priority: 80, duration_minutes: 60, earliest_start: dayStartIso(MON, tz) }))
      .run();
    const { captured } = await resolveWeek(tz, MON, { events: [vac] });
    expect(captured!.external_pinned).toEqual([
      expect.objectContaining({ id: "vac", start: "2026-07-14T00:00:00", duration_minutes: 1440 }),
    ]);
  });

  it("a solver placement at Tue 10:00 local parses back to the zone's instant", async () => {
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', ?, ?, 'pending', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')")
      .bind(OWNER, JSON.stringify({ title: "Deep", context: "deep", priority: 80, duration_minutes: 60, earliest_start: dayStartIso(MON, tz) }))
      .run();
    const { r } = await resolveWeek(tz, MON, {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-07-14T10:00:00", duration_minutes: 60, context: "deep" }],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.body.schedule.map((s: { start: string }) => s.start)).toEqual([wallIso("2026-07-14", "10:00", tz)]);
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("runResolve over the week containing the midnight-gap date in %s", (tz) => {
  const gap = midnightGapDate(tz, 2026)!;
  const wd = new Date(`${gap}T12:00:00Z`).getUTCDay();
  const mon = addDays(gap, -((wd + 6) % 7));

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(dayStart(mon, tz) - 3_600_000));
    await reset();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', ?, ?, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
      .bind(OWNER, JSON.stringify({ title: "Deep", context: "deep", priority: 80, duration_minutes: 60, earliest_start: dayStartIso(mon, tz) }))
      .run();
  });
  afterEach(() => vi.useRealTimers());

  it("baseline: a plain week with one task resolves", async () => {
    const { r } = await resolveWeek(tz, mon);
    expect(r.kind).toBe("ok");
  });

  it("a DAILY unpinned template does not make the resolve throw", async () => {
    await addTemplate("tpl-daily", { rrule: "FREQ=DAILY" });
    await expect(resolveWeek(tz, mon)).resolves.toMatchObject({ r: { kind: "ok" } });
  });

  it("an all-day event on the gap date does not make the resolve throw", async () => {
    const ev = { id: "vac", summary: "Vacation", isAllDay: true, start: `${gap}T00:00:00.000Z`, end: `${addDays(gap, 1)}T00:00:00.000Z`, extendedProperties: {} } as CalendarEvent;
    await expect(resolveWeek(tz, mon, { events: [ev] })).resolves.toMatchObject({ r: { kind: "ok" } });
  });

  it("an all-day event on the day BEFORE the gap date does not make the resolve throw", async () => {
    const prev = addDays(gap, -1);
    const ev = { id: "vac", summary: "Vacation", isAllDay: true, start: `${prev}T00:00:00.000Z`, end: `${gap}T00:00:00.000Z`, extendedProperties: {} } as CalendarEvent;
    await expect(resolveWeek(tz, mon, { events: [ev] })).resolves.toMatchObject({ r: { kind: "ok" } });
  });

  it("a timed outOfOffice on the day before the gap date does not make the resolve throw", async () => {
    const prev = addDays(gap, -1);
    const ev = { id: "ooo", summary: "OOO", eventType: "outOfOffice", start: wallIso(prev, "10:00", tz), end: wallIso(prev, "15:00", tz), extendedProperties: {} } as CalendarEvent;
    await expect(resolveWeek(tz, mon, { events: [ev] })).resolves.toMatchObject({ r: { kind: "ok" } });
  });

  it("parseSolution: a placement at the nonexistent 00:30 local on the gap date does not throw", () => {
    const body = { schedule: [{ task_id: "t1", chunk_id: "t1#0", start: `${gap}T00:30:00`, duration_minutes: 60, context: "deep" }], dropped: [], ...OK };
    expect(() => parseSolution(body, tz, new Map())).not.toThrow();
  });

  it("the gap date's week window is derived without throwing and starts on a local Monday", () => {
    expect(local(dayStart(mon, tz), tz).weekday).toBe(1);
  });
});
