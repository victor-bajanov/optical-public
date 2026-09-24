import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatchScheduled, MONDAY_CRON, __setHandlersForTests } from "../../src/cron/scheduled-entry";
import { upsertUser } from "../../src/db/users";

function ctx(): ExecutionContext {
  const waits: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {}, _waits: waits } as any;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
});
afterEach(() => __setHandlersForTests(null));

describe("monday cron audit", () => {
  it("writes a cron monday_resolve audit row per active subject", async () => {
    await upsertUser(env.DB, "solo@org");
    __setHandlersForTests({ monday: async () => {}, cleanup: async () => {} });
    const c = ctx();
    await dispatchScheduled({ cron: MONDAY_CRON } as any, { ...env, WEEKLY_CRON_ENABLED: "true" } as any, c);
    await Promise.all((c as any)._waits);
    const rows = await env.DB.prepare("SELECT subject, action, source FROM audit_log").all<{ subject: string; action: string; source: string }>();
    expect(rows.results).toContainEqual({ subject: "solo@org", action: "monday_resolve", source: "cron" });
  });
});
