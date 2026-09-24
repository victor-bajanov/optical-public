import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { sweepInactiveUsers } from "../../src/lifecycle/sweep-inactive";
import { upsertUser, touchLastSeen, getUser } from "../../src/db/users";
// sweepInactiveUsers calls offboardUser, whose per-user DELETE batch now
// includes the poll tables (OWNER_SCOPED_TABLES). Applied locally, same
// pattern as the rest of test/lifecycle/*, since the shared test/setup.ts
// migration list is outside this correction's file fence.
import meetingPollSql from "../../migrations/0032_meeting_poll.sql?raw";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [{ name: "0032_meeting_poll.sql", queries: [meetingPollSql] }]);
});

const NOW = new Date("2026-06-01T00:00:00Z");

// offboardUser builds a real calendar provider unless given a seam; inject a no-op.
const noopCalendar = { calendarFor: () => ({ stopChannel: async () => {} }) as any };

async function seedUser(subject: string, lastSeen: string) {
  await upsertUser(env.DB, subject);
  await touchLastSeen(env.DB, subject, lastSeen);
}

describe("sweepInactiveUsers", () => {
  beforeEach(async () => {
    for (const t of ["users", "tasks", "task_templates", "projects", "calendar_sync", "identity_tokens", "oauth_tokens", "oauth_codes", "proposed_plans", "audit_log"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("is a strict no-op when RETENTION_DAYS is unset", async () => {
    await seedUser("stale@org", "2020-01-01T00:00:00Z");
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: undefined }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(1);
  });

  it("is a strict no-op when RETENTION_DAYS is empty / zero / negative / non-numeric", async () => {
    await seedUser("stale@org", "2020-01-01T00:00:00Z");
    for (const v of ["", "0", "-5", "abc"]) {
      const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: v }, NOW, noopCalendar);
      expect(swept, `RETENTION_DAYS=${JSON.stringify(v)}`).toEqual([]);
    }
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(1);
  });

  it("offboards users idle longer than RETENTION_DAYS and leaves recent ones intact", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z"); // 61 days before NOW
    await seedUser("recent@org", "2026-05-30T00:00:00Z"); // 2 days before NOW
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("st1", "stale@org", "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);

    expect(swept).toEqual(["stale@org"]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(0);
    expect((await getUser(env.DB, "recent@org"))?.is_active).toBe(1);
    const taskCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind("stale@org").first<{ n: number }>();
    expect(taskCount?.n).toBe(0);
    const audit = await env.DB.prepare("SELECT subject, actor, action, source FROM audit_log WHERE action = 'sweep_offboard'").first<Record<string, unknown>>();
    expect(audit).toEqual({ subject: "stale@org", actor: "cron-sweep", action: "sweep_offboard", source: "cron" });
  });

  it("ignores already-inactive users (only sweeps active ones)", async () => {
    await seedUser("gone@org", "2020-01-01T00:00:00Z");
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE subject = ?").bind("gone@org").run();
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
  });

  it("skips active users whose last_seen is NULL (never offboard on unknown activity)", async () => {
    await upsertUser(env.DB, "fresh@org"); // upsertUser leaves last_seen NULL
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "fresh@org"))?.is_active).toBe(1);
  });
});
