import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../../src/env";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import { tasksApp } from "../../src/handlers/tasks";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import { runResolve } from "../../src/planning/resolve-internal";

const OWNER = "owner-dc1@org";

// Mount tasksApp directly with injected ownerSubject + calendarProvider so the
// handler's c.var.calendarProvider resolves to our mock (otherwise it falls
// through to defaultCalendarProvider, which needs real Google creds). Same
// pattern as the done-recolor block in test/handlers-tasks.test.ts.
function mount(cal: CalendarProvider) {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { ownerSubject: string; calendarProvider?: CalendarProvider } }>();
  app.use("*", async (c, next) => {
    c.set("ownerSubject", OWNER);
    c.set("calendarProvider", cal);
    await next();
  });
  app.route("/", tasksApp);
  return app;
}

function schedulerEvent(id: string, chunkId: string, start: string, end: string, colorId?: string) {
  return {
    id,
    summary: "Deep work",
    start,
    end,
    colorId,
    extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: chunkId } },
  } as any;
}

async function seedTask(id: string, status: string, body: Record<string, unknown>) {
  await env.DB
    .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(id, OWNER, JSON.stringify({ id, ...body }), status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    .run();
}

async function completionsOf(taskId: string) {
  const r = await env.DB
    .prepare("SELECT chunk_id, source, color_confirmed_at, event_id FROM chunk_completions WHERE owner_subject = ? AND task_id = ? ORDER BY chunk_id")
    .bind(OWNER, taskId)
    .all<{ chunk_id: string; source: string; color_confirmed_at: string | null; event_id: string | null }>();
  return r.results ?? [];
}

// A stub solver that always returns an empty OPTIMAL solution (so runResolve's
// reconcile runs without a real solver). Mirrors per-chunk-completion.test.ts.
function makeSolver(): Fetcher {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({
          schedule: [],
          dropped: [],
          objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  } as unknown as Fetcher;
}

describe("PATCH /tasks/:id done/pending — per-chunk records + inverse recolor (DC1)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM chunk_completions").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });
  afterEach(() => vi.useRealTimers());

  it("status=done writes a completion record for EVERY chunk and best-effort recolors to DONE", async () => {
    // Atomic task → single chunk <id>#0.
    await seedTask("atom", "pending", {
      title: "Atomic",
      context: "deep",
      priority: 60,
      duration_minutes: 30,
      earliest_start: "2026-06-15T00:00:00Z",
    });
    // 2-chunk task → <id>#0, <id>#1.
    await seedTask("multi", "pending", {
      title: "Multi",
      context: "deep",
      priority: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: "2026-06-15T00:00:00Z",
    });

    const cal = new MockCalendarProvider({
      events: [
        schedulerEvent("e-atom-0", "atom#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", "5"),
        schedulerEvent("e-multi-0", "multi#0", "2026-06-16T10:00:00.000Z", "2026-06-16T10:30:00.000Z", "5"),
        schedulerEvent("e-multi-1", "multi#1", "2026-06-17T10:00:00.000Z", "2026-06-17T10:30:00.000Z", "5"),
      ],
    });
    const app = mount(cal);

    for (const id of ["atom", "multi"]) {
      const res = await app.request(
        `/${id}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
        { ...env, DONE_COLOR_ID: "11" },
      );
      expect(res.status).toBe(200);
    }

    // One record per chunk with the correct chunk_id (NOT undefined#0), source
    // 'api', and color_confirmed_at non-null (the mock recolor succeeded).
    const atomRows = await completionsOf("atom");
    expect(atomRows.map((r) => r.chunk_id)).toEqual(["atom#0"]);
    expect(atomRows.every((r) => r.source === "api")).toBe(true);
    expect(atomRows.every((r) => r.color_confirmed_at !== null)).toBe(true);

    const multiRows = await completionsOf("multi");
    expect(multiRows.map((r) => r.chunk_id)).toEqual(["multi#0", "multi#1"]);
    expect(multiRows.every((r) => r.source === "api")).toBe(true);
    expect(multiRows.every((r) => r.color_confirmed_at !== null)).toBe(true);

    // The chunks were repainted to the done color "11".
    const recolored = cal.getUpdated();
    expect(recolored.every((u) => u.changes.colorId === "11")).toBe(true);
    expect(recolored.map((u) => u.eventId).sort()).toEqual(["e-atom-0", "e-multi-0", "e-multi-1"]);
  });

  it("status=done with a FAILING recolor still records every chunk but leaves color_confirmed_at NULL (DC2 gate)", async () => {
    // The security-critical branch: if the best-effort recolor throws, the
    // records must still be written (records are authoritative) but with
    // color_confirmed_at NULL, so the revive-scan can never mis-read this as a
    // user un-paint and silently re-open the task.
    await seedTask("flaky", "pending", {
      title: "Flaky recolor",
      context: "deep",
      priority: 60,
      duration_minutes: 30,
      earliest_start: "2026-06-15T00:00:00Z",
    });
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-flaky-0", "flaky#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", "5")],
    });
    // Make the recolor throw (Calendar outage) — the PATCH must still succeed.
    cal.updateEvent = async () => {
      throw new Error("calendar unavailable");
    };
    const app = mount(cal);

    const res = await app.request(
      "/flaky",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200); // best-effort recolor failure never fails the PATCH

    const rows = await completionsOf("flaky");
    expect(rows.map((r) => r.chunk_id)).toEqual(["flaky#0"]);
    expect(rows.every((r) => r.source === "api")).toBe(true);
    expect(rows.every((r) => r.color_confirmed_at === null)).toBe(true); // NOT confirmed
  });

  it("status=pending clears completion records and repaints chunks to the create color (DC1)", async () => {
    // Seed a done atomic task with a completion record + a done-colored chunk
    // event in the mock calendar.
    await seedTask("undo", "done", {
      title: "Undo",
      context: "deep",
      priority: 60,
      duration_minutes: 30,
      earliest_start: "2026-06-15T00:00:00Z",
    });
    await env.DB
      .prepare("INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES (?,?,?,?,?,?)")
      .bind(OWNER, "undo", "undo#0", "2026-06-14T12:00:00Z", "2026-06-14T12:00:00Z", "api")
      .run();

    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-undo-0", "undo#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", "11")],
    });
    const app = mount(cal);

    const res = await app.request(
      "/undo",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "pending" }) },
      { ...env, DONE_COLOR_ID: "11" }, // CREATE_COLOR_ID unset → code defaults to "5"
    );
    expect(res.status).toBe(200);

    // 1. completion records for the task are empty.
    expect(await completionsOf("undo")).toHaveLength(0);

    // 2. the mock calendar received updateEvent(..., { colorId: "5" }) (the
    //    default CREATE_COLOR_ID).
    const recolored = cal.getUpdated();
    expect(recolored).toHaveLength(1);
    expect(recolored[0]!.eventId).toBe("e-undo-0");
    expect(recolored[0]!.changes.colorId).toBe("5");

    // 3. a subsequent runResolve does NOT re-mark the task done. The chunk is now
    //    create-colored ("5"), so the done-scan never records it.
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: "2026-06-15T00:00:00Z",
      windowEnd: "2026-06-20T00:00:00Z",
      accountEmail: OWNER,
      trigger: "api",
    });
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("undo", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
    expect(await completionsOf("undo")).toHaveLength(0);
  });

  it("status=done stamps the confirming event id on each confirmed record", async () => {
    await seedTask("stamp", "pending", {
      title: "Stamp",
      context: "deep",
      priority: 60,
      duration_minutes: 30,
      earliest_start: "2026-06-15T00:00:00Z",
    });
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-stamp-0", "stamp#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", "5")],
    });
    const app = mount(cal);
    const res = await app.request(
      "/stamp",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);
    const rows = await completionsOf("stamp");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.color_confirmed_at).not.toBeNull();
    expect(rows[0]!.event_id).toBe("e-stamp-0");
  });

  it("PATCH that changes chunks drops the task's completion records", async () => {
    // A partially-done 2-chunk task: pending/scheduled with a completion record
    // for <id>#0 only. Editing the chunks array re-defines chunk identity (records
    // are keyed by index), so the stale record must be dropped (re-plan from scratch).
    await seedTask("reshape", "pending", {
      title: "Reshape",
      context: "deep",
      priority: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: "2026-06-15T00:00:00Z",
    });
    await env.DB
      .prepare("INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES (?,?,?,?,?,?)")
      .bind(OWNER, "reshape", "reshape#0", "2026-06-14T12:00:00Z", "2026-06-14T12:00:00Z", "api")
      .run();
    expect(await completionsOf("reshape")).toHaveLength(1);

    const cal = new MockCalendarProvider({ events: [] });
    const app = mount(cal);

    const res = await app.request(
      "/reshape",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }, { duration_minutes: 30 }],
        }),
      },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);

    // The completion records for the task are dropped (re-shaped task re-plans).
    expect(await completionsOf("reshape")).toHaveLength(0);
  });
});

describe("PATCH done — per-chunk colour confirmation with past/absent events (incident 2026-07-06)", () => {
  // The incident shape: "Dirt moving" was done-marked on 26 June while its only
  // chunk event sat on 19 June — a week in the PAST. The old recolor scan
  // started at the current week, silently recoloured nothing, and yet the
  // record was stamped colour-confirmed. Any later resolve covering the event's
  // week then read "confirmed record + event off the done colour" as a user
  // un-paint and revived the done task.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T03:00:00.000Z")); // Fri 26 Jun; Sydney week starts Mon 22 Jun
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM chunk_completions").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });
  afterEach(() => vi.useRealTimers());

  it("recolours a chunk event in a recent past week (the incident's exact shape)", async () => {
    await seedTask("late", "pending", {
      title: "Done late",
      context: "physical",
      priority: 50,
      duration_minutes: 60,
    });
    // Event a week before the done-mark — inside the widened backward scan.
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-late-0", "late#0", "2026-06-19T01:00:00.000Z", "2026-06-19T02:00:00.000Z", "5")],
    });
    const app = mount(cal);
    const res = await app.request(
      "/late",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);

    // The past-week event IS repainted to the done colour…
    const recolored = cal.getUpdated();
    expect(recolored.map((u) => u.eventId)).toEqual(["e-late-0"]);
    expect(recolored[0]!.changes.colorId).toBe("11");
    // …and only then is the record colour-confirmed, stamped with the event.
    const rows = await completionsOf("late");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.color_confirmed_at).not.toBeNull();
    expect(rows[0]!.event_id).toBe("e-late-0");
  });

  it("leaves the record UNCONFIRMED when the chunk event is beyond the scan window", async () => {
    await seedTask("ancient", "pending", {
      title: "Done very late",
      context: "physical",
      priority: 50,
      duration_minutes: 60,
    });
    // Event ~8 weeks in the past — beyond even the widened scan. The recolor
    // cannot reach it, so its record must NOT claim colour confirmation.
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-anc-0", "ancient#0", "2026-05-01T01:00:00.000Z", "2026-05-01T02:00:00.000Z", "5")],
    });
    const app = mount(cal);
    const res = await app.request(
      "/ancient",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);

    expect(cal.getUpdated()).toHaveLength(0); // nothing reachable to repaint
    const rows = await completionsOf("ancient");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.color_confirmed_at).toBeNull(); // recolor covered nothing → no confirmation
    expect(rows[0]!.event_id).toBeNull();
  });

  it("confirms per chunk: reachable chunk confirmed, event-less chunk unconfirmed", async () => {
    await seedTask("split", "pending", {
      title: "Split",
      context: "deep",
      priority: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: false, ordered: false },
    });
    // Only chunk #0 has a calendar event in the scan; #1 has none anywhere.
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-split-0", "split#0", "2026-06-24T09:00:00.000Z", "2026-06-24T09:30:00.000Z", "5")],
    });
    const app = mount(cal);
    const res = await app.request(
      "/split",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);

    const rows = await completionsOf("split");
    expect(rows.map((r) => r.chunk_id)).toEqual(["split#0", "split#1"]);
    expect(rows[0]!.color_confirmed_at).not.toBeNull();
    expect(rows[0]!.event_id).toBe("e-split-0");
    expect(rows[1]!.color_confirmed_at).toBeNull(); // no event seen for #1
    expect(rows[1]!.event_id).toBeNull();
  });

  it("a later resolve over the unreachable event's week does NOT revive the done task (end-to-end regression)", async () => {
    await seedTask("dirt", "pending", {
      title: "Dirt moving",
      context: "physical",
      priority: 50,
      duration_minutes: 60,
    });
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("e-dirt-0", "dirt#0", "2026-05-01T01:00:00.000Z", "2026-05-01T02:00:00.000Z", "5")],
    });
    const app = mount(cal);
    const res = await app.request(
      "/dirt",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);

    // The incident's detonation: a webhook-bucketed resolve of the (fully past)
    // week that still holds the never-recoloured, create-coloured event. With a
    // truthful (unconfirmed) record this must be a no-op — no revival.
    await runResolve({
      env: { ...env, DONE_COLOR_ID: "11", SOLVER: makeSolver() },
      calendar: cal,
      windowStart: "2026-04-27T00:00:00Z",
      windowEnd: "2026-05-04T00:00:00Z",
      accountEmail: OWNER,
      trigger: "api",
    });

    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("dirt", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("done"); // NOT revived
    const rows = await completionsOf("dirt");
    expect(rows).toHaveLength(1); // record survives
  });
});
