import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { dispatchScheduled, __setHandlersForTests } from "../../src/cron/scheduled-entry";
import { upsertUser, touchLastSeen, getUser } from "../../src/db/users";
import { storeIdentityTokens } from "../../src/auth/identity-store";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { MicrosoftGraphNotificationProvider } from "../../src/providers/microsoft-graph-notification-provider";
import * as mondayResolve from "../../src/cron/monday-resolve";

describe("dispatchScheduled", () => {
  beforeEach(() => __setHandlersForTests(null));
  afterEach(() => vi.restoreAllMocks());

  it("dispatches '0 15 * * SUN' to the Monday-resolve handler", async () => {
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)",
    )
      .bind("solo@org", new Uint8Array([1]).buffer, "scope", "2026-01-01T00:00:00Z")
      .run();
    await upsertUser(env.DB, "solo@org");

    const monday = vi.fn(async () => ({ kind: "ok", planHash: "h" }));
    const cleanup = vi.fn(async () => ({ deleted: 0 }));
    __setHandlersForTests({ monday, cleanup });

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: "0 15 * * SUN", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, WEEKLY_CRON_ENABLED: "true" },
      {
        waitUntil: (p: Promise<unknown>) => {
          tasks.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);
    expect(monday).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("dispatches '0 4 * * *' to the cleanup handler", async () => {
    const monday = vi.fn(async () => ({ kind: "ok", planHash: "h" }));
    const cleanup = vi.fn(async () => ({ deleted: 0 }));
    __setHandlersForTests({ monday, cleanup });

    await dispatchScheduled(
      { cron: "0 4 * * *", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(monday).not.toHaveBeenCalled();
  });

  it("fires the subscription-renewal sweep on '0 4 * * *'", async () => {
    const monday = vi.fn(async () => ({ kind: "ok", planHash: "h" }));
    const cleanup = vi.fn(async () => ({ deleted: 0 }));
    const renew = vi.fn(async () => ({ checked: 0, renewed: 0, failed: 0 }));
    __setHandlersForTests({ monday, cleanup, renew });

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: "0 4 * * *", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      env,
      {
        waitUntil: (p: Promise<unknown>) => {
          tasks.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(monday).not.toHaveBeenCalled();
  });

  it("fires sweepInactiveUsers on '0 4 * * *' when injected=null (real wiring path)", async () => {
    // Ensure injected is null so the real sweep code path runs.
    __setHandlersForTests(null);
    await env.DB.prepare("DELETE FROM users").run();
    await upsertUser(env.DB, "stale@org");
    await touchLastSeen(env.DB, "stale@org", "2020-01-01T00:00:00Z");

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: "0 4 * * *", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, RETENTION_DAYS: "30" },
      {
        waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);

    // The sweep must have offboarded the stale user.
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(0);
    const auditRow = await env.DB.prepare("SELECT action, source FROM audit_log WHERE action = 'sweep_offboard'").first<Record<string, unknown>>();
    expect(auditRow).toEqual({ action: "sweep_offboard", source: "cron" });
  });

  it("logs and ignores unknown cron expressions", async () => {
    const monday = vi.fn();
    const cleanup = vi.fn();
    __setHandlersForTests({ monday, cleanup });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchScheduled(
      { cron: "0 0 1 1 *", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(monday).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
  });

  it("does nothing on Monday when WEEKLY_CRON_ENABLED is not 'true'", async () => {
    const monday = vi.fn(async () => ({ kind: "ok", planHash: "h" }));
    const cleanup = vi.fn(async () => ({ deleted: 0 }));
    __setHandlersForTests({ monday, cleanup });

    await dispatchScheduled(
      { cron: "0 15 * * SUN", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, WEEKLY_CRON_ENABLED: "false" },
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(monday).not.toHaveBeenCalled();
  });

  it("fans Monday resolve out once per connected subject when enabled", async () => {
    // Two connected identities.
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)",
    )
      .bind("user0@org", new Uint8Array([1]).buffer, "scope", "2026-01-02T00:00:00Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)",
    )
      .bind("user1@org", new Uint8Array([1]).buffer, "scope", "2026-01-01T00:00:00Z")
      .run();
    // listSubjects now reads from users table (Plan 4); seed both active users.
    // last_seen DESC ordering: user0 more recent than user1 to match expected order.
    await touchLastSeen(env.DB, "user0@org", "2026-01-02T00:00:00Z");
    await touchLastSeen(env.DB, "user1@org", "2026-01-01T00:00:00Z");

    const seenSubjects: string[] = [];
    const monday = vi.fn(async (...args: unknown[]) => {
      const subject = args[0] as string | undefined;
      seenSubjects.push(subject ?? "(none)");
      return { kind: "ok", planHash: "h" };
    });
    const cleanup = vi.fn(async () => ({ deleted: 0 }));
    __setHandlersForTests({ monday, cleanup });

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: "0 15 * * SUN", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, WEEKLY_CRON_ENABLED: "true" },
      {
        waitUntil: (p: Promise<unknown>) => {
          tasks.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);

    expect(monday).toHaveBeenCalledTimes(2);
    // listSubjects orders by updated_at DESC → user0@org first.
    expect(seenSubjects).toEqual(["user0@org", "user1@org"]);
  });

  it("resolves a microsoft subject to Microsoft providers on the real (non-injected) wiring path", async () => {
    const msEnv = { ...env, WEEKLY_CRON_ENABLED: "true", MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
    await storeIdentityTokens(
      msEnv,
      "ms-subject@org",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    await upsertUser(env.DB, "ms-subject@org");

    const spy = vi
      .spyOn(mondayResolve, "runMondayResolve")
      .mockResolvedValue({ kind: "ok", planHash: "h" });

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: "0 15 * * SUN", scheduledTime: Date.now() } as unknown as ScheduledEvent,
      msEnv,
      {
        waitUntil: (p: Promise<unknown>) => {
          tasks.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0];
    expect(call.calendar).toBeInstanceOf(MicrosoftCalendarProvider);
    expect(call.notification).toBeInstanceOf(MicrosoftGraphNotificationProvider);
  });
});
