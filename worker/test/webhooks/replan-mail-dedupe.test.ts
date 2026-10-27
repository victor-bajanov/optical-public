import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runWebhookReplan } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import { localWeekWindow } from "../../src/planning/datetime";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { PENDING_ACTION_LIVE_CAP, SYSTEM_FALLBACK_DAILY_LIMIT } from "../../src/db/pending-actions";

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

// Decision L (L3): replanNow mails the user a fresh diff and accept link on
// every call. With dedupeMail (set only by the replanNow route) that email is
// sent at most once per plan_hash while its link is live, and counts toward
// the decision-K live cap and system-fallback limit, through the same
// plan.commit-mail marker gated commit/acceptPlan use. Webhook and cron
// replans are unchanged.
const EVENT = {
  id: "ext-1", summary: "Surprise standup", start: "2026-05-19T11:00:00Z", end: "2026-05-19T12:00:00Z", extendedProperties: {},
};

function calendar(): MockCalendarProvider {
  const cal = new MockCalendarProvider({ events: [EVENT] });
  cal.fetchIncrementalChanges = async () => ({
    changes: [{ kind: "upsert", event: EVENT }], nextSyncToken: "tok-new", syncTokenInvalidated: false,
  });
  return cal;
}

function run(notify: NotificationProvider, opts: { dedupeMail?: boolean; dryRun?: boolean; env?: Record<string, unknown> } = {}) {
  return runWebhookReplan({
    env: { ...makeEnv(), ...(opts.env ?? {}) } as typeof env,
    calendar: calendar(),
    notify,
    accountEmail: "primary",
    oauthIssuer: "https://scheduler.example.com",
    dryRun: opts.dryRun ?? false,
    dedupeMail: opts.dedupeMail,
  });
}

async function markers(): Promise<Array<{ payload: string; consumed_at: string | null; mail_channel: string | null }>> {
  const r = await env.DB.prepare("SELECT payload, consumed_at, mail_channel FROM pending_actions WHERE owner_subject = 'primary' AND op = 'plan.commit-mail'")
    .all<{ payload: string; consumed_at: string | null; mail_channel: string | null }>();
  return r.results;
}

async function seedLive(n: number, channel: string | null = null) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at, mail_channel) VALUES (?,?,?,?,?,?,?,NULL,?)",
    ).bind(`live-${i}`, "primary", "test.op", `{"i":${i}}`, "{}", new Date().toISOString(), "2099-01-01T00:00:00.000Z", channel).run();
  }
}

describe("replanNow accept-email dedupe and caps (decision L)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await seedDb();
    await env.DB.prepare("DELETE FROM pending_actions").run();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the first call mails and records a marker for the plan", async () => {
    const notify = new MockNotificationProvider();
    const r = await run(notify, { dedupeMail: true });
    if (r.kind !== "replanned") throw new Error(r.kind);
    expect(r.sent).toBe(true);
    expect(r.mailSkipped).toBeUndefined();
    expect(notify.sent).toHaveLength(1);
    const m = await markers();
    expect(m).toHaveLength(1);
    expect(JSON.parse(m[0]!.payload)).toEqual({ plan_hash: r.planHash });
  });

  it("a repeat call that lands on the same plan_hash sends no second email", async () => {
    const notify = new MockNotificationProvider();
    const a = await run(notify, { dedupeMail: true });
    const b = await run(notify, { dedupeMail: true });
    if (a.kind !== "replanned" || b.kind !== "replanned") throw new Error("expected replanned");
    expect(b.planHash).toBe(a.planHash);
    expect(b.sent).toBe(false);
    expect(b.mailSkipped).toBe("duplicate");
    expect(notify.sent).toHaveLength(1);
  });

  it("webhook and cron replans (no dedupeMail) are unchanged: every call mails, no marker", async () => {
    const notify = new MockNotificationProvider();
    await run(notify);
    await run(notify);
    expect(notify.sent).toHaveLength(2);
    expect(await markers()).toHaveLength(0);
  });

  it("a dry run records nothing", async () => {
    await run(new MockNotificationProvider(), { dedupeMail: true, dryRun: true });
    expect(await markers()).toHaveLength(0);
  });

  it(`at the live cap (${20}) no email goes out: mailSkipped too_many_pending_actions, the plan is still stored`, async () => {
    expect(PENDING_ACTION_LIVE_CAP).toBe(20);
    await seedLive(PENDING_ACTION_LIVE_CAP);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = new MockNotificationProvider();
    const r = await run(notify, { dedupeMail: true });
    if (r.kind !== "replanned") throw new Error(r.kind);
    expect(r.sent).toBe(false);
    expect(r.mailSkipped).toBe("too_many_pending_actions");
    expect(notify.sent).toHaveLength(0);
    const plan = await env.DB.prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = ?").bind(r.planHash).first();
    expect(plan).not.toBeNull();
  });

  it("the system-mailer fallback counts toward the per-owner limit: past it, undeliverable and no marker", async () => {
    await seedLive(SYSTEM_FALLBACK_DAILY_LIMIT, "system");
    const failing: NotificationProvider = {
      sendReplanNotification: async () => { throw new Error("gmail 500"); },
      sendPollEmail: async () => {},
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run(failing, {
      dedupeMail: true,
      env: { SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k" },
    });
    if (r.kind !== "replanned") throw new Error(r.kind);
    expect(r.sent).toBe(false);
    expect(r.mailSkipped).toBe("undeliverable");
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("smtp2go"), expect.anything());
    expect(await markers()).toHaveLength(0);
  });

  it("within the limit, a failed own-mailbox send falls back to system mail and marks the marker 'system'", async () => {
    const failing: NotificationProvider = {
      sendReplanNotification: async () => { throw new Error("gmail 500"); },
      sendPollEmail: async () => {},
    };
    const sends: Array<{ text_body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
      sends.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(failing, {
      dedupeMail: true,
      env: { SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k" },
    });
    if (r.kind !== "replanned") throw new Error(r.kind);
    expect(r.sent).toBe(true);
    expect(sends).toHaveLength(1);
    // Static copy and the link only: no task titles through the system mailer.
    expect(sends[0]!.text_body).toContain(`/v1/plans/${r.planHash}/accept?t=`);
    expect(sends[0]!.text_body).not.toContain("Deep work");
    expect((await markers())[0]!.mail_channel).toBe("system");
  });
});

// Owner mail goes to the latest verified sign-in address (login_email,
// migration 0046), never the bare subject; NULL falls back to the subject.
// Both webhook paths, and the system fallback of the deduped one.
describe("replan email recipient (ownerNotificationEmail)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await seedDb();
    await env.DB.prepare("DELETE FROM pending_actions").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
  });

  async function seedIdentity(loginEmail: string | null) {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
    ).bind("primary", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "sub-p", loginEmail).run();
  }

  for (const [label, loginEmail, expected] of [
    ["login_email set", "owner-now@example.com", "owner-now@example.com"],
    ["login_email NULL", null, "primary"],
  ] as const) {
    it(`no-dedupe webhook replan mails ${expected} (${label})`, async () => {
      await seedIdentity(loginEmail);
      const notify = new MockNotificationProvider();
      const r = await run(notify);
      if (r.kind !== "replanned") throw new Error(r.kind);
      expect(notify.sent.map((s) => s.to)).toEqual([expected]);
    });

    it(`deduped (replanNow) replan mails ${expected} (${label}); the marker stays keyed on the subject`, async () => {
      await seedIdentity(loginEmail);
      const notify = new MockNotificationProvider();
      const r = await run(notify, { dedupeMail: true });
      if (r.kind !== "replanned") throw new Error(r.kind);
      expect(r.sent).toBe(true);
      expect(notify.sent.map((s) => s.to)).toEqual([expected]);
      expect(await markers()).toHaveLength(1);
    });

    it(`deduped replan's system fallback mails ${expected} (${label})`, async () => {
      await seedIdentity(loginEmail);
      const failing: NotificationProvider = {
        sendReplanNotification: async () => { throw new Error("gmail 500"); },
        sendPollEmail: async () => {},
      };
      const sends: Array<{ to: string[] }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
        sends.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await run(failing, {
        dedupeMail: true,
        env: { SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k" },
      });
      if (r.kind !== "replanned") throw new Error(r.kind);
      expect(r.sent).toBe(true);
      expect(sends.map((b) => b.to)).toEqual([[expected]]);
    });
  }
});

// CR4: sendPlanAcceptEmailOnce reads the owner's address before reserving the
// plan.commit-mail marker. A D1 error on that read must not leave a marker,
// or every retry is deduped onto an email that was never sent.
describe("replanNow: a failed owner-address read reserves no marker", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await seedDb();
    await env.DB.prepare("DELETE FROM pending_actions").run();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function failingLoginEmailDb(db: D1Database): D1Database {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/SELECT login_email FROM identity_tokens/.test(sql)) throw new Error("D1 unavailable");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  it("leaves no marker, and a retry with a healthy DB mails exactly once", async () => {
    const notify = new MockNotificationProvider();
    await expect(run(notify, { dedupeMail: true, env: { DB: failingLoginEmailDb(env.DB) } })).rejects.toThrow("D1 unavailable");
    expect(await markers()).toHaveLength(0);
    expect(notify.sent).toHaveLength(0);

    const r = await run(notify, { dedupeMail: true });
    if (r.kind !== "replanned") throw new Error(r.kind);
    expect(r.sent).toBe(true);
    expect(notify.sent).toHaveLength(1);
  });
});
