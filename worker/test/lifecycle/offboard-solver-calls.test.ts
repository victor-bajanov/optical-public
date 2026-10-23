import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { offboardUser } from "../../src/lifecycle/offboard";
import { upsertUser } from "../../src/db/users";
// offboardUser's DELETE batch covers the poll tables (0032-0034), which the
// shared setup file doesn't apply; apply them here, same as offboard.test.ts.
import meetingPollSql from "../../migrations/0032_meeting_poll.sql?raw";
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import joinAttemptsSql from "../../migrations/0034_poll_join_attempts.sql?raw";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0032_meeting_poll.sql", queries: [meetingPollSql] },
    { name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] },
    { name: "0034_poll_join_attempts.sql", queries: [joinAttemptsSql] },
  ]);
});

const LEAVER = "leaver@org";
const BYSTANDER = "bystander@org";

async function seedSolverCall(id: string, owner: string): Promise<void> {
  await env.DB.prepare("INSERT INTO solver_calls (id, at, owner, trigger) VALUES (?, ?, ?, ?)")
    .bind(id, "2026-10-01T00:00:00Z", owner, "api").run();
}

async function solverCallsFor(owner: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM solver_calls WHERE owner = ?").bind(owner).first<{ n: number }>();
  return r?.n ?? -1;
}

beforeEach(async () => {
  for (const t of ["users", "solver_calls", "audit_log"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("offboardUser: solver_calls telemetry (O3)", () => {
  it("deletes the offboarded subject's solver_calls rows and spares another user's", async () => {
    await upsertUser(env.DB, LEAVER);
    await upsertUser(env.DB, BYSTANDER);
    await seedSolverCall("call-leaver-1", LEAVER);
    await seedSolverCall("call-leaver-2", LEAVER);
    await seedSolverCall("call-bystander", BYSTANDER);

    await offboardUser(env, LEAVER, "admin@org");

    expect(await solverCallsFor(LEAVER)).toBe(0);
    expect(await solverCallsFor(BYSTANDER)).toBe(1);
  });
});
