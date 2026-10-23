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

async function countsFor(subject: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_mail_counts WHERE subject = ?").bind(subject).first<{ n: number }>();
  return r?.n ?? -1;
}

beforeEach(async () => {
  for (const t of ["users", "outbound_mail_counts", "audit_log"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("offboardUser: outbound mail counters (O9.8)", () => {
  it("registers outbound_mail_counts.subject for deletion", () => {
    expect(OWNER_SCOPED_TABLES.find((t) => t.table === "outbound_mail_counts"))
      .toMatchObject({ column: "subject", policy: "delete" });
  });

  it("deletes the leaver's counters and spares another user's", async () => {
    await upsertUser(env.DB, LEAVER);
    await upsertUser(env.DB, BYSTANDER);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?, '2026-10-09', 7)").bind(LEAVER),
      env.DB.prepare("INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?, '2026-10-09', 2)").bind(BYSTANDER),
    ]);

    await offboardUser(env, LEAVER, "admin@org");

    expect(await countsFor(LEAVER)).toBe(0);
    expect(await countsFor(BYSTANDER)).toBe(1);
  });
});
