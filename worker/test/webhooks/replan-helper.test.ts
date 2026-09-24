import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runWebhookReplan } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import { localWeekWindow } from "../../src/planning/datetime";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

const stubOkSolver = {
  fetch: async () =>
    new Response(
      JSON.stringify({
        schedule: [
          {
            task_id: "t1",
            chunk_id: "t1#0",
            start: "2026-05-19T09:00:00",
            duration_minutes: 90,
            context: "deep",
          },
        ],
        dropped: [],
        objective: {
          total: 0,
          components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 },
        },
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
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare("DELETE FROM chunk_completions").run();
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  await env.DB.prepare("DELETE FROM config_weights").run();
  await env.DB.prepare("DELETE FROM config_contexts").run();
  await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
    .bind(
      JSON.stringify({
        time_of_day_fit_per_15min: 5,
        churn_per_15min_moved: 10,
        priority_unit: 1,
        base_drop_penalty: 200,
      }),
    )
    .run();
  await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
    .bind(
      "deep",
      JSON.stringify({
        context: "deep",
        fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
        max_minutes_per_day: 240,
        max_contiguous_minutes: 90,
        over_daily_cap_penalty_per_15min: 25,
        over_streak_cap_penalty_per_15min: 25,
      }),
    )
    .run();
  await seedMissingDefaultContexts();
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  )
    .bind(
      "t1",
      "primary",
      JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }),
      "2026-05-17T00:00:00Z",
      "2026-05-17T00:00:00Z",
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok-old', 'ch-1', 'shared-secret', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/google-calendar')",
  ).run();
}

describe("runWebhookReplan", () => {
  // Freeze the wall clock at 2026-05-18 so none of the fixed event windows these
  // tests derive (May weeks current; June weeks future) are classified as
  // fully-past by runResolve's windowEnd <= now guard, which would otherwise
  // short-circuit the resolve before the solver and break the diff assertions.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await seedDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dry run: composes the email but does not send and returns the body", async () => {
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "ext-1",
          summary: "Surprise standup",
          start: "2026-05-19T11:00:00Z",
          end: "2026-05-19T12:00:00Z",
          extendedProperties: {},
        },
      ],
    });
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "ext-1",
            summary: "Surprise standup",
            start: "2026-05-19T11:00:00Z",
            end: "2026-05-19T12:00:00Z",
            extendedProperties: {},
          },
        },
      ],
      nextSyncToken: "tok-new",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      dryRun: true,
    });

    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    expect(result.sent).toBe(false);
    expect(notify.sent).toHaveLength(0);
    expect((result.model.trigger as { kind: string; inviteTitle: string }).inviteTitle).toContain("Surprise standup");
    expect(result.model.days.length).toBeGreaterThan(0);
    expect(result.planHash).toMatch(/^[0-9a-f]+$/);
  });

  it("forceResolve: resolves and sends even when there are no incremental changes", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [],
      nextSyncToken: "tok-fresh",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
      triggerInviteTitle: "manual replan",
    });

    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    expect(result.sent).toBe(true);
    expect(notify.sent).toHaveLength(1);
    expect((notify.sent[0]!.model.trigger as { kind: string; inviteTitle: string }).inviteTitle).toContain("manual replan");
  });

  it("no_changes: returns early when nothing changed and forceResolve is false", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [],
      nextSyncToken: "tok-fresh",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);

    const sync = await env.DB.prepare(
      "SELECT next_sync_token FROM calendar_sync WHERE owner_subject = 'primary' AND calendar_id = 'primary'",
    ).first<{ next_sync_token: string }>();
    expect(sync?.next_sync_token).toBe("tok-fresh");
  });

  it("scheduler-only incremental upserts → no_changes, no resolve, token persisted", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Email triage — vendor follow-ups",
            start: "2026-05-26T09:00:00Z",
            end: "2026-05-26T10:00:00Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
      ],
      nextSyncToken: "tok-after-commit",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);

    const sync = await env.DB.prepare(
      "SELECT next_sync_token FROM calendar_sync WHERE owner_subject = 'primary' AND calendar_id = 'primary'",
    ).first<{ next_sync_token: string }>();
    expect(sync?.next_sync_token).toBe("tok-after-commit");
  });

  it("done-recolour of a scheduler-owned chunk triggers a resolve and marks the task done", async () => {
    // A "done" recolour IS an update to a scheduler-owned event, so the plain
    // !isSchedulerOwned filter drops it → no_changes → the done-scan never runs.
    // A chunk painted the done color must instead trigger its week's resolve so
    // the scan (resolve-internal) flips the task to 'done'. The provider returns
    // the same done-coloured chunk from fetchEventsInWindow so the scan sees it.
    const doneChunk = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "11",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [doneChunk] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: doneChunk }],
      nextSyncToken: "tok-after-recolour",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    // The recolour is a real signal — it must NOT be filtered away as no_changes.
    expect(result.kind).not.toBe("no_changes");
    // The done-scan inside the triggered resolve flips the task to 'done'.
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("done-recolour with a Microsoft-shaped provider and a NULL done_color_id row uses the provider's defaultDoneColorId (Card H)", async () => {
    // users.done_color_id is unset for 'primary'; env.DONE_COLOR_ID ("11") is a
    // Google colorId. Pre-fix, the webhook's pinhole compares against "11" and
    // never recognises the "Optical Done" category repaint as a signal, so the
    // recolour is filtered away as no_changes and the done-scan never runs.
    const doneChunk = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "Optical Done",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [doneChunk] });
    (cal as { defaultDoneColorId?: string }).defaultDoneColorId = "Optical Done";
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: doneChunk }],
      nextSyncToken: "tok-after-ms-recolour",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).not.toBe("no_changes");
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("done-colored chunk whose task is ALREADY done → dropped as our own recolor echo (no resolve)", async () => {
    // The PATCH-done handler recolors chunks to the done color; that recolor
    // comes back as a push. Because the task is already 'done' in D1, it is our
    // own echo and must NOT trigger another resolve.
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();
    const doneChunk = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "11",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [doneChunk] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: doneChunk }],
      nextSyncToken: "tok-echo",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);
    // The echo did not revive or re-flip the task: it stays done.
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("un-done round-trip: banana repaint of a done chunk revives the task and includes it in the diff", async () => {
    // The reverse of the done-recolour test: seed t1 as 'done' in D1, then a
    // scheduler-owned chunk is repainted tomato→banana (NON-done color "5").
    // The webhook's pinhole (b) lets the repaint through; the revive scan inside
    // the triggered resolve flips t1 done→pending, re-adds it to the solve, and
    // the task reappears in the proposed plan / email model.
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();
    // Per-chunk revive needs a color-confirmed completion record to delete; the
    // off-done present event (banana) is the un-paint evidence that clears it.
    await env.DB.prepare("INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES ('primary', 't1', 't1#0', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z', 'color')").run();

    const bananaChunk = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "5",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [bananaChunk] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: bananaChunk }],
      nextSyncToken: "tok-after-revive",
      syncTokenInvalidated: false,
    });

    // Place the revived t1#0 inside the resolved week (05-24…05-31), at a slot
    // that differs from the existing banana event (05-26 09:00) so the diff is
    // non-empty with t1 surfacing as the new placement.
    const reviveSolver = {
      fetch: async () =>
        new Response(
          JSON.stringify({
            schedule: [
              {
                task_id: "t1",
                chunk_id: "t1#0",
                start: "2026-05-27T09:00:00",
                duration_minutes: 90,
                context: "deep",
              },
            ],
            dropped: [],
            objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
            diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    } as unknown as Fetcher;

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...makeEnv(), SOLVER: reviveSolver },
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    // The repaint is a real signal — it must NOT be filtered away as no_changes,
    // and the revived task must surface as a real plan (non-empty diff → email).
    expect(result.kind).not.toBe("no_changes");
    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;

    // The revive scan flips the task back to 'pending'.
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>();
    expect(row?.status).toBe("pending");

    // The revived task is re-added to the solve and surfaces in the diff/model as
    // a real change (moved/added), rendered with the seeded task title "Deep work".
    const changedTitles = result.model.days
      .flatMap((d) => [...d.before, ...d.after])
      .filter((e) => e.role !== "existing")
      .map((e) => e.title);
    expect(changedTitles).toContain("Deep work");
  });

  it("per-chunk un-paint of a recorded chunk on a still-PENDING task → resolves (not no_changes)", async () => {
    // The partial-completion gap (bug 2026-06-15): a chunk was marked done (a
    // CONFIRMED chunk_completions record), but its task is still status='pending'
    // — the real case is a multi-chunk task with only some chunks recorded; here
    // we seed the equivalent state directly (a pending task carrying a confirmed
    // chunk record). The user repaints that chunk OFF the done color to un-mark
    // it. The task-level doneInDb set MISSES this (the task is not status='done'),
    // so pinhole (b) alone classifies it no_changes and the evidence-gated
    // per-chunk revive never fires. The confirmed-chunk signal must let it through.
    await env.DB.prepare(
      "INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES ('primary', 't1', 't1#0', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z', 'color')",
    ).run();
    // Task stays pending (seedDb default) while carrying a confirmed chunk record.

    const banana = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "5", // NOT the done color 11
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [banana] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: banana }],
      nextSyncToken: "tok-partial-unpaint",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    // The per-chunk un-paint is a real signal — must NOT be filtered to no_changes.
    expect(result.kind).not.toBe("no_changes");
    // The evidence-gated revive deleted the chunk's completion record.
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chunk_completions WHERE owner_subject = 'primary' AND chunk_id = 't1#0'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("echo-safety: scheduler chunk OFF the done color with NO completion record → no_changes", async () => {
    // Guards the DC1-undo repaint echo and freshly-committed chunks. The DC1
    // done→pending undo DELETES the task's completion records BEFORE repainting
    // chunks to the create color, so the repaint echo arrives with NO record and
    // must NOT be treated as a signal. A freshly committed create-colored chunk
    // (also no record) must likewise stay a non-signal. Task is pending, off-done
    // color, and — crucially — no chunk_completions row exists.
    const createColored = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "5", // create color, NOT the done color
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [createColored] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: createColored }],
      nextSyncToken: "tok-echo-norecord",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);
  });

  it("mixed incremental upserts → resolves with the human event as inviteTitle", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Email triage — vendor follow-ups",
            start: "2026-05-26T09:00:00Z",
            end: "2026-05-26T10:00:00Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
        {
          kind: "upsert",
          event: {
            id: "ext-1",
            summary: "Surprise standup",
            start: "2026-05-26T11:00:00Z",
            end: "2026-05-26T12:00:00Z",
            extendedProperties: {},
          },
        },
      ],
      nextSyncToken: "tok-new",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    const trigger = result.model.trigger as { kind: string; inviteTitle: string };
    expect(trigger.inviteTitle).toContain("Surprise standup");
    expect(trigger.inviteTitle).not.toContain("Email triage");
  });

  it("sync-invalidated full-fetch with only scheduler-owned events → no_changes", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [],
      nextSyncToken: "tok-ignored",
      syncTokenInvalidated: true,
    });
    cal.fetchEventsInWindow = async () => ({
      events: [
        {
          id: "sched-1",
          summary: "Email triage — vendor follow-ups",
          start: "2026-05-26T09:00:00Z",
          end: "2026-05-26T10:00:00Z",
          extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
        },
      ],
      nextSyncToken: "tok-full",
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);

    const sync = await env.DB.prepare(
      "SELECT next_sync_token FROM calendar_sync WHERE owner_subject = 'primary' AND calendar_id = 'primary'",
    ).first<{ next_sync_token: string }>();
    expect(sync?.next_sync_token).toBe("tok-full");
  });

  it("no prior sync token: full-fetch with only scheduler-owned events → no_changes", async () => {
    // Drives the else branch (no next_sync_token → full fetch via
    // fetchEventsInWindow). The same scheduler-owned filter must apply here too.
    await env.DB.prepare(
      "UPDATE calendar_sync SET next_sync_token = NULL WHERE owner_subject = 'primary' AND calendar_id = 'primary'",
    ).run();

    const cal = new MockCalendarProvider();
    cal.fetchEventsInWindow = async () => ({
      events: [
        {
          id: "sched-1",
          summary: "Email triage — vendor follow-ups",
          start: "2026-05-26T09:00:00Z",
          end: "2026-05-26T10:00:00Z",
          extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
        },
      ],
      nextSyncToken: "tok-full-noprior",
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);

    const sync = await env.DB.prepare(
      "SELECT next_sync_token FROM calendar_sync WHERE owner_subject = 'primary' AND calendar_id = 'primary'",
    ).first<{ next_sync_token: string }>();
    expect(sync?.next_sync_token).toBe("tok-full-noprior");
  });

  it("forceResolve resolves but still filters the scheduler title (falls back to manual replan)", async () => {
    // No triggerInviteTitle override here: inviteTitle is derived from
    // changedTitles. The only change is a scheduler-owned upsert, so the filter
    // must drop it, leaving changedTitles empty → inviteTitle falls back to
    // "manual replan". If the filter regressed, the scheduler title would leak
    // into the subject instead.
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Email triage — vendor follow-ups",
            start: "2026-05-26T09:00:00Z",
            end: "2026-05-26T10:00:00Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
      ],
      nextSyncToken: "tok-after-commit",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
    });

    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    expect(notify.sent).toHaveLength(1);
    const sentTrigger = notify.sent[0]!.model.trigger as { kind: string; inviteTitle: string };
    expect(sentTrigger.inviteTitle).toContain("manual replan");
    expect(sentTrigger.inviteTitle).not.toContain("Email triage");
  });

  it("suppresses the email and returns no_diff when the proposed plan matches the calendar (empty diff)", async () => {
    const emptySolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({ changes: [], nextSyncToken: "tok-fresh", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...env, SOLVER: emptySolver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
    });
    expect(result.kind).toBe("no_diff");
    expect(notify.sent).toHaveLength(0);
    // An empty-diff resolve must NOT leave a phantom pending plan behind: such a
    // row is never emailed yet would later surface on the accept page as the
    // "latest pending" plan (bare Accept button, no body). See the internal backlog.
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM proposed_plans WHERE committed_at IS NULL",
    ).first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it("drop-only replan: a task already dropped in the last accepted plan and still dropped → no_diff, no email", async () => {
    // Regression (2026-07-07 incident): an unrelated calendar edit fired a replan
    // whose plan moved nothing but the solver re-dropped a persistently-unfittable
    // task (Lunch, "drop_was_cheaper_than_alternatives"). Because `dropped` counted
    // toward the no-op gate, an email fired with an identical BEFORE/AFTER. If that
    // task was ALREADY dropped in the last accepted plan for the window, it is not a
    // change and must NOT email.
    const window = localWeekWindow(new Date().toISOString(), "Australia/Sydney");
    const drop = { task_id: "t1", title: "Deep work", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    // Last accepted (committed) plan for THIS window already dropped t1.
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "committed-drop",
        JSON.stringify({ schedule: [], dropped: [drop], window }),
        "2026-05-17T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        "2026-05-17T01:00:00.000Z",
        "primary",
        window.start,
        window.end,
      )
      .run();

    const dropSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [drop], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider(); // no scheduler-owned events on the calendar
    cal.fetchIncrementalChanges = async () => ({ changes: [], nextSyncToken: "tok-fresh", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...env, SOLVER: dropSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
    });
    expect(result.kind).toBe("no_diff");
    expect(notify.sent).toHaveLength(0);
  });

  it("drop-only replan: the drop baseline buckets the week in SCHEDULER_TZ, even for a home_tz user", async () => {
    // Week identity must use the tz that produced the window — every producer
    // anchors on SCHEDULER_TZ. A Sydney week straddles two UTC weeks, so
    // bucketing a UTC user's lookup in home_tz splits it and the mid-week
    // committed plan below stops matching this Mon-anchored resolve.
    await env.DB.prepare("INSERT INTO users (subject, home_tz, created_at) VALUES ('primary', 'UTC', '2026-05-01T00:00:00Z')").run();
    const week = localWeekWindow(new Date().toISOString(), "Australia/Sydney");
    // A mid-week-narrowed commit of the same Sydney week (Wed 09:00 local) —
    // the shape week-identity matching exists for.
    const midWeek = {
      start: new Date(Date.parse(week.start) + 2 * 86_400_000 + 9 * 3_600_000).toISOString(),
      end: week.end,
    };
    const drop = { task_id: "t1", title: "Deep work", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "committed-drop-midweek",
        JSON.stringify({ schedule: [], dropped: [drop], window: midWeek }),
        "2026-05-17T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        "2026-05-17T01:00:00.000Z",
        "primary",
        midWeek.start,
        midWeek.end,
      )
      .run();

    const dropSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [drop], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({ changes: [], nextSyncToken: "tok-fresh", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...env, SOLVER: dropSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
    });
    expect(result.kind).toBe("no_diff");
    expect(notify.sent).toHaveLength(0);
  });

  it("drop-only replan: a NEWLY dropped task (not dropped in the last accepted plan) → replanned, email sent", async () => {
    // The counterpart: if the task was not dropped last time (or there is no
    // accepted plan yet), a fresh drop IS news and must still email. Guards against
    // over-suppressing the fix above.
    const drop = { task_id: "t1", title: "Deep work", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    const dropSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [drop], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider(); // no committed plan seeded → drop is new
    cal.fetchIncrementalChanges = async () => ({ changes: [], nextSyncToken: "tok-fresh", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...env, SOLVER: dropSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
      triggerInviteTitle: "manual replan",
    });
    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    expect(notify.sent).toHaveLength(1);
    // The dropped task is still surfaced in the email for context.
    expect(result.model.dropped.map((d) => d.title)).toContain("Deep work");
  });

  it("no-diff resolve also supersedes an older pending plan for the same window, leaving zero pending rows", async () => {
    // Composition of two independently-tested cleanups: runResolve's window-scoped
    // supersede (deletes other pending plans for the same subject+window) runs
    // BEFORE this no-diff handler deletes its own just-inserted row. A stale
    // pending plan from an earlier resolve of this window must not survive either
    // cleanup — the week should end with zero pending rows, not one.
    const window = localWeekWindow(new Date().toISOString(), "Australia/Sydney");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
    )
      .bind(
        "stale-hash-1",
        JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T02:00:00", duration_minutes: 90, context: "deep" }], dropped: [], window }),
        "2026-05-17T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        "primary",
        window.start,
        window.end,
      )
      .run();

    const emptySolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({ changes: [], nextSyncToken: "tok-fresh", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: { ...env, SOLVER: emptySolver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
    });
    expect(result.kind).toBe("no_diff");
    expect(notify.sent).toHaveLength(0);

    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM proposed_plans WHERE subject = 'primary' AND window_start = ? AND window_end = ? AND committed_at IS NULL",
    )
      .bind(window.start, window.end)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it("sets proposed-plan expires_at to created_at + 72h", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [],
      nextSyncToken: "tok-fresh",
      syncTokenInvalidated: false,
    });
    const notify = new MockNotificationProvider();
    await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
    });
    const row = await env.DB.prepare(
      "SELECT created_at, expires_at FROM proposed_plans ORDER BY created_at DESC LIMIT 1",
    ).first<{ created_at: string; expires_at: string }>();
    expect(row).not.toBeNull();
    const delta = Date.parse(row!.expires_at) - Date.parse(row!.created_at);
    expect(delta).toBe(72 * 3600 * 1000);
  });

  it("resolves the local week the changed event falls in, not a fixed [now,+7d) window", async () => {
    // Repro of the 2026-05-26 production bug: an edit ~3 weeks out fired a real
    // resolve, but the webhook only ever resolved [now, now+7d) — an empty
    // window — so the diff was empty and no email/accept-link was produced.
    // It must instead resolve the (local) week CONTAINING the edited event.
    const eventStart = "2026-06-15T01:30:00.000Z"; // Mon 11:30 AEST, ~3 weeks ahead
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "clash-1",
            summary: "Another meeting",
            start: eventStart,
            end: "2026-06-15T02:30:00.000Z",
            extendedProperties: {},
          },
        },
      ],
      nextSyncToken: "tok-new",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    const trigger = result.model.trigger as { kind: string; inviteTitle: string };
    expect(trigger.inviteTitle).toContain("Another meeting");
    expect(notify.sent).toHaveLength(1);
    // The Sydney week of Mon 2026-06-15 — exactly the window a manual resolve uses.
    expect(result.model.window).toEqual({
      start: "2026-06-14T14:00:00.000Z",
      end: "2026-06-21T14:00:00.000Z",
    });
  });

  it("accumulates triggerEventIds for multiple changed events in the SAME week (both render as new-clash)", async () => {
    // Guards the `existing.triggerEventIds.push(e.id)` accumulation branch:
    // two human events landing in one local week must BOTH be collected for
    // that week and BOTH surface as new-clash in the model (an if/else
    // inversion would silently drop the second).
    const eventA = {
      id: "clash-a",
      summary: "Clash A",
      start: "2026-06-15T01:30:00.000Z", // Mon 11:30 AEST
      end: "2026-06-15T02:30:00.000Z",
      extendedProperties: {},
    };
    const eventB = {
      id: "clash-b",
      summary: "Clash B",
      start: "2026-06-17T03:00:00.000Z", // Wed 13:00 AEST, same Sydney week
      end: "2026-06-17T04:00:00.000Z",
      extendedProperties: {},
    };
    // Seed both into the provider so fetchEventsInWindow surfaces them as
    // external events; deliver both as incremental upserts so both ids are
    // bucketed into the single week's triggerEventIds.
    const cal = new MockCalendarProvider({ events: [eventA, eventB] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        { kind: "upsert", event: eventA },
        { kind: "upsert", event: eventB },
      ],
      nextSyncToken: "tok-new",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    // Single week → single email.
    expect(notify.sent).toHaveLength(1);
    expect(result.model.window).toEqual({
      start: "2026-06-14T14:00:00.000Z",
      end: "2026-06-21T14:00:00.000Z",
    });
    // Both changed events must render as new-clash in the before column.
    const clashTitles = result.model.days
      .flatMap((d) => d.before)
      .filter((e) => e.role === "new-clash")
      .map((e) => e.title)
      .sort();
    expect(clashTitles).toContain("Clash A");
    expect(clashTitles).toContain("Clash B");
  });

  it("re-resolves every distinct local week touched by a debounced burst", async () => {
    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: { id: "a", summary: "Week A clash", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T02:30:00.000Z", extendedProperties: {} },
        },
        {
          kind: "upsert",
          event: { id: "b", summary: "Week B clash", start: "2026-06-23T01:30:00.000Z", end: "2026-06-23T02:30:00.000Z", extendedProperties: {} },
        },
      ],
      nextSyncToken: "tok-new",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("replanned");
    // One email per affected week.
    expect(notify.sent).toHaveLength(2);
    // Assert on the new model surface: each sent email carries its own week's
    // window, and the two windows are distinct.
    const modelStarts = notify.sent.map((s) => s.model.window.start).sort();
    expect(new Set(modelStarts).size).toBe(2);
    expect(modelStarts).toContain("2026-06-14T14:00:00.000Z"); // week of Mon 06-15
    expect(modelStarts).toContain("2026-06-21T14:00:00.000Z"); // week of Mon 06-22
    const rows = await env.DB.prepare(
      "SELECT json_extract(body,'$.window.start') AS s FROM proposed_plans ORDER BY s",
    ).all<{ s: string }>();
    const starts = rows.results.map((r) => r.s);
    expect(starts).toContain("2026-06-14T14:00:00.000Z"); // week of Mon 06-15
    expect(starts).toContain("2026-06-21T14:00:00.000Z"); // week of Mon 06-22
  });

  it("un-done pinhole: scheduler-owned NON-done-colored chunk for a task that is done in D1 → resolves (not no_changes)", async () => {
    // Repaint tomato→banana: the chunk is scheduler-owned and color 5 (NOT the
    // done color 11), so pinhole (a) does not match. But the task is status='done'
    // in D1, so pinhole (b) must let it through to trigger the week's resolve.
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();

    const banana = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "5",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [banana] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: banana }],
      nextSyncToken: "tok-after-unrecolour",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    // The repaint is a real signal (task is done in D1) — must NOT be filtered.
    expect(result.kind).not.toBe("no_changes");
  });

  describe("feedback-storm guard: only the two pinholes pass", () => {
    // For each combination of (event colorId, D1 task status) drive a single
    // scheduler-owned change through the filter and assert that ONLY the two
    // pinholes (done-color event = (a); non-done color + done task = (b)) get
    // past it. Everything else scheduler-owned is dropped → no_changes.
    async function driveSingleSchedChange(opts: {
      colorId: string;
      status: string;
    }): Promise<ReturnType<typeof runWebhookReplan> extends Promise<infer R> ? R : never> {
      await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = 't1'").bind(opts.status).run();
      const chunk = {
        id: "sched-1",
        summary: "Deep work",
        start: "2026-05-26T09:00:00Z",
        end: "2026-05-26T10:00:00Z",
        colorId: opts.colorId,
        extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
      };
      const cal = new MockCalendarProvider({ events: [chunk] });
      cal.fetchIncrementalChanges = async () => ({
        changes: [{ kind: "upsert", event: chunk }],
        nextSyncToken: "tok-storm",
        syncTokenInvalidated: false,
      });
      const notify = new MockNotificationProvider();
      return runWebhookReplan({
        env: makeEnv(),
        calendar: cal,
        notify,
        accountEmail: "primary",
        oauthIssuer: "https://scheduler.example.com",
      });
    }

    it("color-5 event, task pending → no_changes", async () => {
      const r = await driveSingleSchedChange({ colorId: "5", status: "pending" });
      expect(r.kind).toBe("no_changes");
    });
    it("color-5 event, task scheduled → no_changes", async () => {
      const r = await driveSingleSchedChange({ colorId: "5", status: "scheduled" });
      expect(r.kind).toBe("no_changes");
    });
    it("color-5 event, task committed → no_changes", async () => {
      const r = await driveSingleSchedChange({ colorId: "5", status: "committed" });
      expect(r.kind).toBe("no_changes");
    });
    it("non-done non-5 color (2), task pending → no_changes", async () => {
      const r = await driveSingleSchedChange({ colorId: "2", status: "pending" });
      expect(r.kind).toBe("no_changes");
    });
    it("non-done non-5 color (2), task scheduled → no_changes", async () => {
      const r = await driveSingleSchedChange({ colorId: "2", status: "scheduled" });
      expect(r.kind).toBe("no_changes");
    });
    it("done-color (11) event, task pending → NOT no_changes (pinhole a)", async () => {
      const r = await driveSingleSchedChange({ colorId: "11", status: "pending" });
      expect(r.kind).not.toBe("no_changes");
    });
    it("done-color (11) event, task done → no_changes (echo-drop: our own recolor echo, not a fresh user paint)", async () => {
      const r = await driveSingleSchedChange({ colorId: "11", status: "done" });
      expect(r.kind).toBe("no_changes");
    });
    it("non-done color (2), task done → NOT no_changes (pinhole b)", async () => {
      const r = await driveSingleSchedChange({ colorId: "2", status: "done" });
      expect(r.kind).not.toBe("no_changes");
    });
  });

  it("no-op self-write: a normal scheduler-owned color-5 event for a PENDING task → no_changes", async () => {
    const banana = {
      id: "sched-1",
      summary: "Deep work",
      start: "2026-05-26T09:00:00Z",
      end: "2026-05-26T10:00:00Z",
      colorId: "5",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [banana] });
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: banana }],
      nextSyncToken: "tok-self-write",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);
  });

  it("manual move of a scheduler-owned event: no replan, but the committed plan baseline is updated", async () => {
    await env.DB.prepare(
      `INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject)
       VALUES ('committed-1', ?, '2026-05-17T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-17T01:00:00Z', 'primary')`,
    ).bind(JSON.stringify({
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" }],
      dropped: [],
      window: { start: "2026-05-18T00:00:00.000Z", end: "2026-05-25T00:00:00.000Z" },
    })).run();

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Deep work",
            start: "2026-05-19T11:00:00.000Z",
            end: "2026-05-19T12:30:00.000Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
      ],
      nextSyncToken: "tok-moved",
      syncTokenInvalidated: false,
    });

    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(result.kind).toBe("no_changes");
    expect(notify.sent).toHaveLength(0);

    const row = await env.DB.prepare(
      "SELECT body FROM proposed_plans WHERE plan_hash = 'committed-1'",
    ).first<{ body: string }>();
    const sched = JSON.parse(row!.body).schedule;
    expect(sched[0].start).toBe("2026-05-19T11:00:00.000Z");
    expect(sched[0].end).toBe("2026-05-19T12:30:00.000Z");
  });

  it("ignores the global committed plan as the diff baseline (no spurious removed)", async () => {
    // A committed plan for a different week. Pre-fix it was the diff baseline and
    // showed up entirely as "Removed". Now the baseline is the in-window calendar.
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "old-committed",
      JSON.stringify({ schedule: [{ task_id: "t-old", chunk_id: "t-old#0", start: "2026-01-05T09:00:00.000Z", end: "2026-01-05T10:00:00.000Z", context: "deep" }], dropped: [], window: { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" } }),
      "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", "2026-01-05T00:00:00Z",
    ).run();
    const cal = new MockCalendarProvider(); // no scheduler events in the window
    cal.fetchIncrementalChanges = async () => ({ changes: [], nextSyncToken: "tok-fresh", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify,
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
      forceResolve: true,
      triggerInviteTitle: "manual replan",
    });
    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    // t1#0 from the stub solver is "added"; nothing is removed.
    // The model's dropped array should be empty and no removed-role entries.
    expect(result.model.dropped).toHaveLength(0);
    const removedEntries = result.model.days.flatMap((d) => [...d.before, ...d.after]).filter((e) => e.role === "removed");
    expect(removedEntries).toHaveLength(0);
  });

  it("manual move re-stamps the task row (scheduled_for + updated_at) alongside the plan body", async () => {
    const planBody = {
      schedule: [
        { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hp1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(planBody)).run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'committed', scheduled_for = '2026-05-19T09:00:00.000Z' WHERE id = 't1'",
    ).run();

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Deep work",
            start: "2026-05-19T13:00:00Z",
            end: "2026-05-19T14:30:00Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
      ],
      nextSyncToken: "tok-2",
      syncTokenInvalidated: false,
    });

    const result = await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify: new MockNotificationProvider(),
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });
    // Scheduler-only change: no replan, but the writeback fires before the early return.
    expect(result.kind).toBe("no_changes");

    const row = await env.DB.prepare("SELECT scheduled_for, updated_at FROM tasks WHERE id = 't1'")
      .first<{ scheduled_for: string | null; updated_at: string }>();
    expect(row?.scheduled_for).toBe("2026-05-19T13:00:00.000Z");
    expect(row?.updated_at).toBe("2026-05-18T00:00:00.000Z"); // frozen clock = write time
  });

  it("manual-move write-back is atomic: a failing re-stamp rolls back the plan-body patch (X4)", async () => {
    // X4: the body patch and the row re-stamp must commit together. If they run as
    // two independent writes and the re-stamp throws AFTER the body update, the
    // plan body is left ahead of the row — and the echo guard then reads the
    // already-patched body as "unchanged" on re-delivery, so the re-stamp never
    // heals. Issuing both in one atomic db.batch() means a re-stamp failure rolls
    // the body patch back too, so re-delivery sees changed=true and retries cleanly.
    const planBody = {
      schedule: [
        { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hp1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(planBody)).run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'committed', scheduled_for = '2026-05-19T09:00:00.000Z' WHERE id = 't1'",
    ).run();

    // Poison ONLY the re-stamp UPDATE so it fails at execution, leaving the body
    // patch as the lone successful write under the buggy (sequential) path.
    const poisoned = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) =>
            /SET scheduled_for = \?, updated_at = \?/.test(sql)
              ? target.prepare("UPDATE no_such_table SET a = ?, b = ? WHERE c = ? AND d = ?")
              : target.prepare(sql);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof env.DB;

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Deep work",
            start: "2026-05-19T13:00:00Z",
            end: "2026-05-19T14:30:00Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
      ],
      nextSyncToken: "tok-2",
      syncTokenInvalidated: false,
    });

    // The write-back failure surfaces (thrown or swallowed) — either way, assert DB state.
    await runWebhookReplan({
      env: { ...makeEnv(), DB: poisoned },
      calendar: cal,
      notify: new MockNotificationProvider(),
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    }).catch(() => undefined);

    // Atomic: the body patch must NOT have landed without the re-stamp.
    const planRow = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'hp1'")
      .first<{ body: string }>();
    expect(JSON.parse(planRow!.body).schedule[0].start).toBe("2026-05-19T09:00:00.000Z");
    // And the row stamp is untouched too — both surfaces stay at the pre-move value.
    const taskRow = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = 't1'")
      .first<{ scheduled_for: string | null }>();
    expect(taskRow?.scheduled_for).toBe("2026-05-19T09:00:00.000Z");
  });

  it("patches an OLDER committed plan whose chunk is dragged, not just the latest (X5)", async () => {
    // Week N (May) committed BEFORE week N+1 (June). A drag on the week-N chunk must
    // patch week N's body even though N+1 is the latest committed plan.
    const weekN = {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" }],
      dropped: [], window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    const weekNPlus1 = {
      schedule: [{ task_id: "t2", chunk_id: "t2#0", start: "2026-06-02T09:00:00.000Z", end: "2026-06-02T10:30:00.000Z", context: "deep" }],
      dropped: [], window: { start: "2026-06-01T00:00:00Z", end: "2026-06-08T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hN', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(weekN)).run();
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hN1', ?, '2026-05-25T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-25T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(weekNPlus1)).run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'committed', scheduled_for = '2026-05-19T09:00:00.000Z' WHERE id = 't1'",
    ).run();

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: {
        id: "sched-1", summary: "Deep work", start: "2026-05-19T13:00:00Z", end: "2026-05-19T14:30:00Z",
        extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
      } }],
      nextSyncToken: "tok-2", syncTokenInvalidated: false,
    });

    await runWebhookReplan({
      env: makeEnv(), calendar: cal, notify: new MockNotificationProvider(),
      accountEmail: "primary", oauthIssuer: "https://scheduler.example.com",
    });

    // Week N body patched to the dragged position…
    const nBody = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'hN'").first<{ body: string }>();
    expect(JSON.parse(nBody!.body).schedule[0].start).toBe("2026-05-19T13:00:00.000Z");
    // …week N+1 untouched…
    const n1Body = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'hN1'").first<{ body: string }>();
    expect(JSON.parse(n1Body!.body).schedule[0].start).toBe("2026-06-02T09:00:00.000Z");
    // …and the row re-stamped.
    const row = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = 't1'").first<{ scheduled_for: string | null }>();
    expect(row?.scheduled_for).toBe("2026-05-19T13:00:00.000Z");
  });

  it("dragging earlier than earliest_start lowers the floor instead of stranding the task (X6)", async () => {
    await env.DB.prepare(
      "UPDATE tasks SET body = ?, status = 'committed', scheduled_for = '2026-05-19T11:00:00.000Z' WHERE id = 't1'",
    ).bind(JSON.stringify({
      id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90,
      earliest_start: "2026-05-19T11:00:00.000Z",
    })).run();
    const planBody = {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T11:00:00.000Z", end: "2026-05-19T12:30:00.000Z", context: "deep" }],
      dropped: [], window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hp1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(planBody)).run();

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: {
        id: "sched-1", summary: "Deep work", start: "2026-05-19T08:00:00Z", end: "2026-05-19T09:30:00Z", // earlier than the floor
        extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
      } }],
      nextSyncToken: "tok-2", syncTokenInvalidated: false,
    });

    await runWebhookReplan({
      env: makeEnv(), calendar: cal, notify: new MockNotificationProvider(),
      accountEmail: "primary", oauthIssuer: "https://scheduler.example.com",
    });

    const row = await env.DB.prepare("SELECT scheduled_for, body FROM tasks WHERE id = 't1'")
      .first<{ scheduled_for: string | null; body: string }>();
    expect(row?.scheduled_for).toBe("2026-05-19T08:00:00.000Z");
    expect(JSON.parse(row!.body).earliest_start).toBe("2026-05-19T08:00:00.000Z"); // floor lowered to the drop
  });

  it("write-back is atomic across multiple patched plans: a poisoned task write rolls back every plan body", async () => {
    // Two committed weeks, both with a chunk that moves; poison the task UPDATE so
    // the batch fails. Neither plan body may be left ahead of the row.
    const weekN = {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" }],
      dropped: [], window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hN', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(weekN)).run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'committed', scheduled_for = '2026-05-19T09:00:00.000Z' WHERE id = 't1'",
    ).run();

    const poisoned = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) =>
            /UPDATE tasks SET scheduled_for = \?, updated_at = \?, body = \?/.test(sql)
              ? target.prepare("UPDATE no_such_table SET a = ?, b = ?, c = ? WHERE d = ? AND e = ?")
              : target.prepare(sql);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof env.DB;

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: {
        id: "sched-1", summary: "Deep work", start: "2026-05-19T13:00:00Z", end: "2026-05-19T14:30:00Z",
        extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
      } }],
      nextSyncToken: "tok-2", syncTokenInvalidated: false,
    });

    await runWebhookReplan({
      env: { ...makeEnv(), DB: poisoned }, calendar: cal, notify: new MockNotificationProvider(),
      accountEmail: "primary", oauthIssuer: "https://scheduler.example.com",
    }).catch(() => undefined);

    const nBody = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'hN'").first<{ body: string }>();
    expect(JSON.parse(nBody!.body).schedule[0].start).toBe("2026-05-19T09:00:00.000Z"); // rolled back
    const row = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = 't1'").first<{ scheduled_for: string | null }>();
    expect(row?.scheduled_for).toBe("2026-05-19T09:00:00.000Z");
  });

  it("a drag on a fully-elapsed committed week is skipped — body not patched, row not restamped (elapsed-week filter)", async () => {
    // frozen now = 2026-05-18T00:00:00.000Z
    // Elapsed window: end 2026-05-11T00:00:00Z — unambiguously before now.
    // Non-elapsed window: end 2026-05-25T00:00:00Z — after now.
    // Both plans carry t1#0; the drag moves it from 09:00 to 13:00.
    // Assert: elapsed plan is NOT patched; non-elapsed plan IS patched.
    const elapsedPlanBody = {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-05T09:00:00.000Z", end: "2026-05-05T10:30:00.000Z", context: "deep" }],
      dropped: [],
      window: { start: "2026-05-04T00:00:00Z", end: "2026-05-11T00:00:00Z" },
    };
    const activePlanBody = {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" }],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('elapsed-1', ?, '2026-05-04T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-04T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(elapsedPlanBody)).run();
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('active-1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(activePlanBody)).run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'committed', scheduled_for = '2026-05-19T09:00:00.000Z' WHERE id = 't1'",
    ).run();

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "sched-1",
            summary: "Deep work",
            // Drag lands in the active (non-elapsed) week — matches active plan's chunk by chunk_id.
            start: "2026-05-19T13:00:00Z",
            end: "2026-05-19T14:30:00Z",
            extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
          },
        },
      ],
      nextSyncToken: "tok-elapsed",
      syncTokenInvalidated: false,
    });

    await runWebhookReplan({
      env: makeEnv(),
      calendar: cal,
      notify: new MockNotificationProvider(),
      accountEmail: "primary",
      oauthIssuer: "https://scheduler.example.com",
    });

    // Elapsed week: body NOT patched — still at the original 09:00 start.
    const elapsedRow = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'elapsed-1'")
      .first<{ body: string }>();
    expect(JSON.parse(elapsedRow!.body).schedule[0].start).toBe("2026-05-05T09:00:00.000Z");

    // Active week: body IS patched to the dragged position.
    const activeRow = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'active-1'")
      .first<{ body: string }>();
    expect(JSON.parse(activeRow!.body).schedule[0].start).toBe("2026-05-19T13:00:00.000Z");

    // Task row re-stamped to the active week's new position.
    const taskRow = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = 't1'")
      .first<{ scheduled_for: string | null }>();
    expect(taskRow?.scheduled_for).toBe("2026-05-19T13:00:00.000Z");
  });

  it("a moved task that is done patches the plan body but leaves the row untouched (skip guard)", async () => {
    const planBody = {
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" }],
      dropped: [], window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hp1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'primary')",
    ).bind(JSON.stringify(planBody)).run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'done', scheduled_for = '2026-05-19T09:00:00.000Z' WHERE id = 't1'",
    ).run();

    const cal = new MockCalendarProvider();
    cal.fetchIncrementalChanges = async () => ({
      changes: [{ kind: "upsert", event: {
        id: "sched-1", summary: "Deep work", start: "2026-05-19T13:00:00Z", end: "2026-05-19T14:30:00Z",
        extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } },
      } }],
      nextSyncToken: "tok-2", syncTokenInvalidated: false,
    });

    await runWebhookReplan({
      env: makeEnv(), calendar: cal, notify: new MockNotificationProvider(),
      accountEmail: "primary", oauthIssuer: "https://scheduler.example.com",
    });

    const body = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'hp1'").first<{ body: string }>();
    expect(JSON.parse(body!.body).schedule[0].start).toBe("2026-05-19T13:00:00.000Z"); // baseline follows calendar
    const row = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = 't1'").first<{ scheduled_for: string | null }>();
    expect(row?.scheduled_for).toBe("2026-05-19T09:00:00.000Z"); // done row untouched
  });
});
