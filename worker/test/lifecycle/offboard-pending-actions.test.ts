import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { offboardUser } from "../../src/lifecycle/offboard";
import { upsertUser } from "../../src/db/users";
import { OWNER_SCOPED_TABLES } from "../../src/lifecycle/owner-scoped-tables";
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

async function seedAction(id: string, owner: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
  ).bind(id, owner, "test.op", "{}", "{}", "2026-10-01T00:00:00Z", "2099-01-01T00:00:00Z").run();
}

async function actionsFor(owner: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_subject = ?").bind(owner).first<{ n: number }>();
  return r?.n ?? -1;
}

beforeEach(async () => {
  for (const t of ["users", "pending_actions", "audit_log"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("offboardUser: pending_actions (O9.1)", () => {
  it("registers pending_actions.owner_subject for deletion", () => {
    expect(OWNER_SCOPED_TABLES.find((t) => t.table === "pending_actions"))
      .toMatchObject({ table: "pending_actions", column: "owner_subject", policy: "delete" });
  });

  it("deletes the leaver's pending actions (an emailed link then finds nothing) and spares another user's", async () => {
    await upsertUser(env.DB, LEAVER);
    await upsertUser(env.DB, BYSTANDER);
    await seedAction("a1", LEAVER);
    await seedAction("a2", LEAVER);
    await seedAction("b1", BYSTANDER);

    await offboardUser(env, LEAVER, "admin@org");

    expect(await actionsFor(LEAVER)).toBe(0);
    expect(await actionsFor(BYSTANDER)).toBe(1);
  });
});
