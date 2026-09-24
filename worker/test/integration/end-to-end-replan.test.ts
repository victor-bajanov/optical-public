import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountResolveRoute } from "../../src/planning/resolve";
import { mountCommitRoute } from "../../src/planning/commit";
import { mountGoogleCalendarWebhookRoute } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { __setReplanRunnerForTests } from "../../src/durable-objects/resolve-coordinator";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// The webhook handler reads the next-7-day window from `new Date()`. We pin
// system time in beforeEach so fixtures inside 2026-05-20 .. 2026-05-27 stay
// inside that window regardless of the real wall-clock date.
const FIXED_NOW = new Date("2026-05-20T08:00:00Z");
const WINDOW_START = "2026-05-20T00:00:00Z";
const WINDOW_END = "2026-05-27T00:00:00Z";

const taskBody = {
  id: "e2e-task-1",
  title: "E2E deep work",
  context: "deep",
  priority: 70,
  duration_minutes: 60,
  earliest_start: "2026-05-20T00:00:00Z",
  preferred_windows: [],
  dependencies: [],
  pinned_at: null,
  template_id: null,
  project_id: null,
  source: { kind: "mcp", external_id: null },
  status: "pending",
  created_at: "2026-05-19T00:00:00Z",
  updated_at: "2026-05-19T00:00:00Z",
};

async function seedBearer(token: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES ('test-client', 'test', 'device_code', '[]', '2026-05-19T00:00:00Z')",
    )
    .run();
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
    )
    .bind(hashed, "primary")
    .run();
}

async function seedConfig() {
  // Migration 0002 seeds these, but the suite-wide setup runs once; some
  // sibling tests DELETE these rows in their own beforeEach. Re-insert
  // idempotently so this test is self-sufficient regardless of run order.
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO config_weights (owner_subject, body) VALUES ('__default__', ?)",
    )
    .bind(
      JSON.stringify({
        time_of_day_fit_per_15min: 5,
        churn_per_15min_moved: 10,
        priority_unit: 1,
        base_drop_penalty: 200,
      }),
    )
    .run();
  await env.DB
    .prepare("INSERT OR REPLACE INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
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
  await env.DB
    .prepare("INSERT OR REPLACE INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
    .bind(
      "meeting",
      JSON.stringify({
        context: "meeting",
        fit_curve: { peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" },
        max_minutes_per_day: 180,
        max_contiguous_minutes: 120,
        over_daily_cap_penalty_per_15min: 25,
        over_streak_cap_penalty_per_15min: 25,
      }),
    )
    .run();
  await seedMissingDefaultContexts();
}

describe("integration: end-to-end replan loop", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM oauth_clients").run();
    await seedConfig();
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .bind(taskBody.id, "primary", JSON.stringify(taskBody), taskBody.created_at, taskBody.updated_at)
      .run();
    await seedBearer("e2e-bearer");
  });

  afterEach(async () => {
    vi.useRealTimers();
    __setReplanRunnerForTests(null);
    // Clean up any DO storage to avoid isolated-storage teardown failures
    // when an alarm fires after the test ends.
    const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName("primary"));
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });

  it("seed → resolve → commit → external invite → webhook → re-resolve → diff email", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();

    // Solver stub: first invocation places the task at 09:00; the second
    // (post-invite) invocation places it at 13:00 so the diff is non-empty
    // and the email body lists a "Moved" entry.
    let solverCallCount = 0;
    const stubSolver: Fetcher = {
      fetch: async () => {
        solverCallCount += 1;
        // local-naive (UTC, since SCHEDULER_TZ defaults to "Australia/Sydney" in
        // wrangler.toml; but the actual TZ used here is Sydney so these times are
        // Sydney-local). To keep the diff assertions (09:00 → 13:00) working, we
        // use UTC-equivalent times (SCHEDULER_TZ="UTC" is not set in this test so
        // we use times that parse correctly in Sydney for the given dates).
        // 2026-05-21 09:00 Sydney = 2026-05-20T23:00:00Z
        // 2026-05-21 13:00 Sydney = 2026-05-21T03:00:00Z
        const start =
          solverCallCount === 1 ? "2026-05-21T09:00:00" : "2026-05-21T13:00:00";
        const duration_minutes = 60;
        return new Response(
          JSON.stringify({
            schedule: [
              {
                task_id: taskBody.id,
                chunk_id: `${taskBody.id}#0`,
                start,
                duration_minutes,
                context: "deep",
              },
            ],
            dropped: [],
            objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
            diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const stubEnv = { ...env, SOLVER: stubSolver };

    // The webhook now delegates to the ResolveCoordinator DO, which calls its
    // defaultRunner (using real providers). Inject a test runner that uses the
    // test's mocks so the e2e assertions on notify.sent remain valid.
    const { runWebhookReplan } = await import("../../src/webhooks/google-calendar");
    __setReplanRunnerForTests(async (_doEnv, accountEmail) => {
      await runWebhookReplan({
        env: stubEnv,
        calendar: cal,
        notify,
        accountEmail,
        oauthIssuer: "https://scheduler.example.com",
      });
    });

    const v1 = new OpenAPIHono<{
      Bindings: typeof env;
      Variables: {
        calendarProvider: CalendarProvider;
        notificationProvider: NotificationProvider;
      };
    }>();
    v1.use("*", async (c, next) => {
      c.set("calendarProvider", cal);
      c.set("notificationProvider", notify);
      await next();
    });
    mountResolveRoute(v1);
    mountCommitRoute(v1);
    mountGoogleCalendarWebhookRoute(v1, { accountEmail: "primary" });
    const app = new Hono<{
      Bindings: typeof env;
      Variables: {
        calendarProvider: CalendarProvider;
        notificationProvider: NotificationProvider;
      };
    }>();
    app.route("/v1", v1);

    // Register a Google webhook channel: the handler will only proceed when
    // the inbound X-Goog-Channel-Token matches the persisted row.
    const channelToken = "e2e-channel-token";
    await env.DB
      .prepare(
        `INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url)
         VALUES ('primary', 'primary', NULL, 'ch-e2e', ?, '2026-06-01T00:00:00Z', 'res-e2e', 'https://scheduler.test/v1/webhook/google-calendar')`,
      )
      .bind(channelToken)
      .run();

    // 1. First resolve.
    const r1 = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer e2e-bearer" },
        body: JSON.stringify({ window_start: WINDOW_START, window_end: WINDOW_END, account_email: "test@example.com" }),
      },
      stubEnv,
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { plan_hash: string };
    expect(j1.plan_hash).toBeTruthy();

    // 2. Commit.
    const r2 = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer e2e-bearer" },
        body: JSON.stringify({ plan_hash: j1.plan_hash }),
      },
      stubEnv,
    );
    expect(r2.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);

    // 3. Simulate an external Google Calendar invite landing.
    cal.injectExternalEvent({
      id: "ext-invite-1",
      summary: "Surprise meeting",
      start: "2026-05-22T10:00:00Z",
      end: "2026-05-22T11:00:00Z",
    });

    // The first resolve persisted a `next_sync_token` from the mock; clear it
    // so the webhook handler takes its NULL-token fallback path and replays
    // the full window via `fetchEventsInWindow` (which surfaces the injected
    // event). The incremental-changes path on the mock returns no changes,
    // and exercising it would require additional plumbing not in scope.
    await env.DB
      .prepare("UPDATE calendar_sync SET next_sync_token = NULL WHERE owner_subject = 'primary' AND calendar_id = 'primary'")
      .run();

    // 4. Fire the webhook (Google would do this on calendar change).
    //    The handler now returns immediately with queued:true and schedules
    //    the resolve via the ResolveCoordinator DO alarm.
    const hook = await app.request(
      "/v1/webhook/google-calendar",
      {
        method: "POST",
        headers: {
          "X-Goog-Channel-Token": channelToken,
          "X-Goog-Resource-State": "exists",
          "X-Goog-Channel-Id": "ch-e2e",
          "X-Goog-Resource-Id": "res-e2e",
        },
      },
      stubEnv,
    );
    expect(hook.status).toBe(200);
    const hookBody = (await hook.json()) as { ok: boolean; queued?: boolean };
    expect(hookBody.ok).toBe(true);
    expect(hookBody.queued).toBe(true);

    // 4b. Trigger the DO alarm synchronously (simulates debounce expiry).
    // Delete the real miniflare alarm first so it cannot fire again after we
    // invoke alarm() directly below — otherwise miniflare fires it a second
    // time during cleanup and trips the isolated-storage teardown assertion.
    const coordStub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName("primary"));
    await runInDurableObject(coordStub, async (_inst, state) => {
      await state.storage.deleteAlarm();
    });
    await runInDurableObject(coordStub, (inst) => (inst as unknown as { alarm(): Promise<void> }).alarm());

    // 5. The alarm-triggered resolve must have called the solver again (>= 2).
    // We fake `Date` (FIXED_NOW) but miniflare schedules/fires DO alarms on the
    // REAL clock, so the webhook's debounce alarm is already-due and may fire on
    // its own before our deleteAlarm() above wins the race — giving a third
    // solver call. That extra fire is a fake-timer artifact (prod uses real time
    // + debounce, so it fires exactly once); the manual invoke guarantees the
    // re-resolve happened, and >= 2 tolerates the benign double-fire. Asserting
    // === 2 made this flaky on slower CI runners where the real alarm wins.
    expect(solverCallCount).toBeGreaterThanOrEqual(2);

    // 6. Notification mock must have captured a replan email.
    expect(notify.sent.length).toBeGreaterThanOrEqual(1);
    const sent = notify.sent[notify.sent.length - 1]!;
    expect(sent.to).toBe("primary");
    // trigger is a webhook; inviteTitle comes from the changed event summary.
    // The load-bearing assertion is that a replan-style notification was sent.
    const trigger = sent.model.trigger as { kind: string; inviteTitle: string };
    expect(trigger.kind).toBe("webhook");
    // acceptUrl is built by the webhook path with /v1/plans/<hash>/accept
    expect(sent.opts.acceptUrl).toMatch(/\/v1\/plans\//);
    // Model should reflect the move (09:00 -> 13:00) of the deep-work task,
    // proving the re-resolve actually re-planned (rather than a no-op).
    const movedEntry = sent.model.days.flatMap((d) => d.after).find((e) => e.role === "moved-to");
    expect(movedEntry).toBeDefined();
    expect(movedEntry?.title).toMatch(/E2E deep work/i);
  });
});
