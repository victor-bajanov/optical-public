import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { recordChunkCompletionStmt, deleteTaskCompletionsStmt, loadCompletedChunkIdsByTask } from "../../src/db/chunk-completions";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";

const OWNER = "user@example.com";
const WIN_START = "2026-06-15T00:00:00Z";
const WIN_END = "2026-06-20T00:00:00Z";

// A stub solver that always returns an empty OPTIMAL solution and captures the
// task ids it was handed (so a test can assert what survived the reconcile).
function makeSolver(onIds?: (ids: string[]) => void): Fetcher {
  return {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (onIds) {
        const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
        onIds(body.tasks.map((t) => t.id));
      }
      return new Response(
        JSON.stringify({
          schedule: [],
          dropped: [],
          objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Fetcher;
}

async function seedTask(id: string, body: Record<string, unknown>) {
  const now = "2026-06-14T00:00:00Z";
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  )
    .bind(id, OWNER, JSON.stringify({ id, ...body }), now, now)
    .run();
}

async function seedCompletion(
  taskId: string,
  chunkId: string,
  opts: { colorConfirmedAt: string | null; source: "color" | "api"; eventId?: string | null },
) {
  await env.DB.prepare(
    "INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(OWNER, taskId, chunkId, "2026-06-14T12:00:00Z", opts.colorConfirmedAt, opts.source, opts.eventId ?? null)
    .run();
}

function schedulerEvent(chunkId: string, start: string, end: string, colorId?: string) {
  return {
    id: `ev-${chunkId}`,
    summary: "chunk",
    start,
    end,
    colorId,
    extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: chunkId } },
  } as any;
}

async function resetState() {
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare("DELETE FROM chunk_completions").run();
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  await env.DB.prepare("DELETE FROM calendar_sync").run();
}

// env.DONE_COLOR_ID is "11" (wrangler.toml [vars]); a scheduler-owned event
// painted that color records the chunk as done during resolve.
const DONE = env.DONE_COLOR_ID;

describe("per-chunk done-scan", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    await resetState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records only the done-colored chunk and keeps a multi-chunk task pending", async () => {
    await seedTask("t1", {
      title: "Multi",
      context: "deep",
      priority: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: WIN_START,
    });
    const cal = new MockCalendarProvider({
      events: [
        schedulerEvent("t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE),
        schedulerEvent("t1#1", "2026-06-17T09:00:00.000Z", "2026-06-17T09:30:00.000Z", undefined),
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t1", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("flips an atomic task to done when its only chunk is done-colored", async () => {
    await seedTask("t2", {
      title: "Atomic",
      context: "deep",
      priority: 60,
      duration_minutes: 30,
      earliest_start: WIN_START,
    });
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("t2#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE)],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t2", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("flips a multi-chunk task to done only when EVERY chunk is done-colored", async () => {
    await seedTask("t3", {
      title: "Multi all done",
      context: "deep",
      priority: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: WIN_START,
    });
    const cal = new MockCalendarProvider({
      events: [
        schedulerEvent("t3#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE),
        schedulerEvent("t3#1", "2026-06-17T09:00:00.000Z", "2026-06-17T09:30:00.000Z", DONE),
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t3", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("done");
  });
});

describe("per-chunk revive (evidence-gated)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    await resetState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("revives (deletes record + flips pending) on a confirmed record with an off-done event present", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color" });
    let capturedIds: string[] = [];
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", undefined)],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver((ids) => (capturedIds = ids)) },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toBeUndefined();
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t1", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
    expect(capturedIds).toContain("t1");
  });

  it("does NOT revive an unconfirmed (api) record even with an off-done event present", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: null, source: "api" });
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", undefined)],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
  });

  it("does NOT revive a confirmed record when no event for the chunk is present", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color" });
    const cal = new MockCalendarProvider({ events: [] });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
  });
});

describe("same-event revive gate (duplicate chunk events — incident 2026-07-06)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    await resetState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Two calendar events can end up sharing one scheduler_chunk_id (a commit
  // recreated a revived chunk in another week during the incident). The revive
  // must be evidence about the EVENT THAT CONFIRMED the completion — a stray
  // sibling's colour is not evidence the user re-opened the work.
  function eventWithChunk(id: string, chunkId: string, start: string, end: string, colorId?: string) {
    return {
      id,
      summary: "chunk",
      start,
      end,
      colorId,
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: chunkId } },
    } as any;
  }

  it("does NOT revive while the confirming event stays done-colored, even with an off-color duplicate in-window", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color", eventId: "ev-orig" });
    const cal = new MockCalendarProvider({
      events: [
        eventWithChunk("ev-orig", "t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE),
        eventWithChunk("ev-dupe", "t1#0", "2026-06-18T09:00:00.000Z", "2026-06-18T09:30:00.000Z", "5"),
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"])); // record survives
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t1", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("done"); // NOT revived
  });

  it("does NOT revive when the confirming event is absent, even though a stray off-color event carries the chunk id", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color", eventId: "ev-orig" });
    const cal = new MockCalendarProvider({
      events: [eventWithChunk("ev-dupe", "t1#0", "2026-06-18T09:00:00.000Z", "2026-06-18T09:30:00.000Z", "5")],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
  });

  it("revives when the confirming event itself is repainted off the done color", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color", eventId: "ev-orig" });
    const cal = new MockCalendarProvider({
      events: [eventWithChunk("ev-orig", "t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", "5")],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toBeUndefined();
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t1", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("legacy record (no event_id): does NOT revive while ANY in-window event with the chunk id is still done-colored", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", OWNER).run();
    await seedCompletion("t1", "t1#0", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color" });
    const cal = new MockCalendarProvider({
      events: [
        eventWithChunk("ev-a", "t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE),
        eventWithChunk("ev-b", "t1#0", "2026-06-18T09:00:00.000Z", "2026-06-18T09:30:00.000Z", "5"),
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
  });

  it("the colour-scan RECORD stamps the confirming event id", async () => {
    await seedTask("t9", { title: "T9", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    const cal = new MockCalendarProvider({
      events: [eventWithChunk("ev-t9", "t9#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE)],
    });
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    const row = await env.DB.prepare(
      "SELECT event_id, color_confirmed_at FROM chunk_completions WHERE owner_subject = ? AND chunk_id = ?",
    )
      .bind(OWNER, "t9#0")
      .first<{ event_id: string | null; color_confirmed_at: string | null }>();
    expect(row?.event_id).toBe("ev-t9");
    expect(row?.color_confirmed_at).not.toBeNull();
  });
});

describe("cross-week per-chunk revive independence (DC3)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z")); // inside W2 → live path
    await resetState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // DC3: the revive is per-chunk_id, not task/window scoped. An off-color chunk
  // whose event is in THIS window must not revive a sibling chunk whose own
  // done-colored event lives in a DIFFERENT week (and is therefore out of this
  // resolve's window). A task-level / window-scoped revive would wrongly delete
  // the sibling's record too; the per-chunk contract leaves it untouched.
  it("an off-color chunk in W2 does not revive a sibling whose done event is in W1", async () => {
    // ONE task, TWO chunks, fully done: both records CONFIRMED, status='done'.
    await seedTask("tx", {
      title: "Cross-week",
      context: "deep",
      priority: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: WIN_START,
    });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("tx", OWNER).run();
    await seedCompletion("tx", "tx#0", { colorConfirmedAt: "2026-06-09T12:00:00Z", source: "color" });
    await seedCompletion("tx", "tx#1", { colorConfirmedAt: "2026-06-14T12:00:00Z", source: "color" });

    // tx#0's done-colored event lands in W1 (week before W2 → out of the W2
    // resolve window); tx#1's event is UN-painted and lands in W2 (in-window).
    const cal = new MockCalendarProvider({
      events: [
        schedulerEvent("tx#0", "2026-06-09T09:00:00.000Z", "2026-06-09T09:30:00.000Z", DONE), // W1, done-colored
        schedulerEvent("tx#1", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", undefined), // W2, off-done
      ],
    });

    // Resolve W2 ONLY: only tx#1's event is in-window; tx#0's W1 event is not
    // fetched, so the per-chunk revive never even evaluates tx#0.
    await runResolve({
      env: { ...env, SOLVER: makeSolver() },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });

    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["tx"]);
    // tx#1 revived (in-window, off-done, confirmed) → record deleted.
    // tx#0 SURVIVES — its done-colored event is in W1, outside this window, so
    // the revive scan never sees it. A task-level revive would delete it too.
    expect(completed.get("tx")).toEqual(new Set(["tx#0"]));

    // Explicit row-level assertion: prove the surviving tx#0 record is still in
    // chunk_completions (the discriminating check vs. a task-level revive).
    const survivor = await env.DB.prepare(
      "SELECT chunk_id FROM chunk_completions WHERE owner_subject = ? AND task_id = ? AND chunk_id = ?",
    )
      .bind(OWNER, "tx", "tx#0")
      .first<{ chunk_id: string }>();
    expect(survivor?.chunk_id).toBe("tx#0");
    // And the revived tx#1 record is gone.
    const revived = await env.DB.prepare(
      "SELECT chunk_id FROM chunk_completions WHERE owner_subject = ? AND task_id = ? AND chunk_id = ?",
    )
      .bind(OWNER, "tx", "tx#1")
      .first<{ chunk_id: string }>();
    expect(revived).toBeNull();
  });
});

describe("past-week color scan (DC4)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T08:00:00.000Z")); // after WIN_END → week fully past
    await resetState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records and flips done on the fully-past-week early-return path", async () => {
    await seedTask("t1", { title: "T", context: "deep", priority: 60, duration_minutes: 30, earliest_start: WIN_START });
    let solverCalled = false;
    const solver = {
      fetch: async () => {
        solverCalled = true;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [schedulerEvent("t1#0", "2026-06-16T09:00:00.000Z", "2026-06-16T09:30:00.000Z", DONE)],
    });
    const r = await runResolve({
      env: { ...env, SOLVER: solver },
      calendar: cal,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      accountEmail: OWNER,
      trigger: "api",
    });
    // Fully-past early return: solver never called, empty plan.
    expect(solverCalled).toBe(false);
    expect(r.kind).toBe("ok");
    // But the reconcile still ran: chunk recorded, task flipped done.
    const completed = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?")
      .bind("t1", OWNER)
      .first<{ status: string }>();
    expect(row?.status).toBe("done");
  });
});

describe("deleteTaskCompletionsStmt", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM chunk_completions").run();
  });

  it("deletes every completion row for the task when run in a batch", async () => {
    await env.DB.batch([
      recordChunkCompletionStmt(env.DB, "o@org", "t1", "t1#0", "2026-06-20T00:00:00Z", "api", null),
      recordChunkCompletionStmt(env.DB, "o@org", "t1", "t1#1", "2026-06-20T00:00:00Z", "api", null),
    ]);
    await env.DB.batch([deleteTaskCompletionsStmt(env.DB, "o@org", "t1")]);
    const remaining = await loadCompletedChunkIdsByTask(env.DB, "o@org", ["t1"]);
    expect(remaining.get("t1") ?? []).toHaveLength(0);
  });
});
