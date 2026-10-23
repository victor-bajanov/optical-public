import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { purgeDeletedAccounts, auditPseudonym } from "../../src/lifecycle/purge-deleted";
import { upsertUser, touchLastSeen, deactivateUser, getUser } from "../../src/db/users";
import { writeAudit } from "../../src/db/audit";
import { hashingKey } from "../../src/auth/crypto-keys";

// Decision F: DELETED_ACCOUNT_RETENTION_DAYS (N). N days after offboard the
// daily sweep deletes the deactivated users row and pseudonymises the
// subject's audit_log rows. "0"/unset/unparseable = keep indefinitely.
const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

async function seedDeactivated(subject: string, deactivatedAt: string | null) {
  await upsertUser(env.DB, subject);
  await deactivateUser(env.DB, subject);
  await env.DB.prepare("UPDATE users SET deactivated_at = ? WHERE subject = ?").bind(deactivatedAt, subject).run();
}

async function userExists(subject: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS one FROM users WHERE subject = ?").bind(subject).first();
  return r !== null;
}

async function auditRows() {
  const r = await env.DB.prepare("SELECT id, subject, actor, action, table_name, source, created_at FROM audit_log ORDER BY created_at, id")
    .all<Record<string, string | null>>();
  return r.results;
}

describe("purgeDeletedAccounts", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM audit_log").run();
  });
  afterEach(() => vi.restoreAllMocks());

  it("never purges when N is unset, empty, 0, negative or non-numeric", async () => {
    await seedDeactivated("old@org", daysAgo(3650));
    for (const v of [undefined, "", "0", "-3", "abc", "1.5"]) {
      const n = await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: v }, NOW);
      expect(n, `N=${JSON.stringify(v)}`).toBe(0);
    }
    expect(await userExists("old@org")).toBe(true);
  });

  it("purges a row deactivated more than N days ago, keeps one deactivated N days ago or less", async () => {
    await seedDeactivated("past@org", new Date(NOW.getTime() - 30 * DAY - 1000).toISOString());
    await seedDeactivated("edge@org", daysAgo(30));
    await seedDeactivated("recent@org", daysAgo(29));
    const n = await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW);
    expect(n).toBe(1);
    expect(await userExists("past@org")).toBe(false);
    expect(await userExists("edge@org")).toBe(true);
    expect(await userExists("recent@org")).toBe(true);
  });

  it("never purges an active user, even one carrying a stale deactivated_at", async () => {
    await upsertUser(env.DB, "live@org");
    // e.g. a harness that flips is_active back by hand without clearing the stamp
    await env.DB.prepare("UPDATE users SET deactivated_at = ? WHERE subject = ?").bind(daysAgo(400), "live@org").run();
    await writeAudit(env.DB, { subject: "live@org", actor: "live@org", action: "x", source: "api" });
    const n = await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW);
    expect(n).toBe(0);
    expect((await getUser(env.DB, "live@org"))?.is_active).toBe(1);
    expect((await auditRows()).every((r) => r.subject === "live@org")).toBe(true);
  });

  it("a user re-activated after offboard is not purged on the old offboard", async () => {
    await upsertUser(env.DB, "back@org");
    await deactivateUser(env.DB, "back@org", daysAgo(60));
    await touchLastSeen(env.DB, "back@org", daysAgo(1));
    const n = await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW);
    expect(n).toBe(0);
    expect((await getUser(env.DB, "back@org"))?.is_active).toBe(1);
  });

  it("pseudonymises the purged subject's audit rows (subject and actor), leaving the rest intact", async () => {
    await seedDeactivated("gone@org", daysAgo(31));
    await writeAudit(env.DB, { subject: "gone@org", actor: "gone@org", action: "offboard", source: "api" }, "2026-04-01T00:00:00.000Z");
    await writeAudit(env.DB, { subject: "gone@org", actor: "admin@org", action: "offboard", table_name: "users", source: "admin" }, "2026-04-02T00:00:00.000Z");
    await writeAudit(env.DB, { subject: "other@org", actor: "gone@org", action: "denied", source: "api" }, "2026-04-03T00:00:00.000Z");
    await writeAudit(env.DB, { subject: "other@org", actor: "other@org", action: "keep", source: "api" }, "2026-04-04T00:00:00.000Z");
    const before = await auditRows();

    await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW);

    const p = await auditPseudonym(env, "gone@org");
    expect(p).toMatch(/^deleted:[0-9a-f]{64}$/);
    const after = await auditRows();
    // The four original rows: same ids, actions, sources, tables, times.
    const orig = after.filter((r) => before.some((b) => b.id === r.id));
    expect(orig.map((r) => [r.id, r.action, r.table_name, r.source, r.created_at]))
      .toEqual(before.map((r) => [r.id, r.action, r.table_name, r.source, r.created_at]));
    expect(orig.map((r) => [r.subject, r.actor])).toEqual([
      [p, p],
      [p, "admin@org"],
      ["other@org", p],
      ["other@org", "other@org"],
    ]);
    expect(JSON.stringify(after)).not.toContain("gone@org");
    // The purge itself is audited under the pseudonym.
    const purge = after.find((r) => r.action === "account_purged");
    expect(purge).toMatchObject({ subject: p, actor: "cron-sweep", source: "cron" });
  });

  it("the pseudonym is exactly deleted: + HMAC-SHA256(hashingKey, 'audit-pseudonym:' + subject), hex", async () => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(hashingKey(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode("audit-pseudonym:pinned@org"));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await auditPseudonym(env, "pinned@org")).toBe(`deleted:${hex}`);
  });

  it("the pseudonym is stable per subject, distinct across subjects, and keyed", async () => {
    const a1 = await auditPseudonym(env, "a@org");
    expect(await auditPseudonym(env, "a@org")).toBe(a1);
    expect(await auditPseudonym(env, "b@org")).not.toBe(a1);
    expect(await auditPseudonym({ ...env, HASHING_KEY: "another-key" }, "a@org")).not.toBe(a1);
    expect(a1).not.toContain("a@org");
  });

  it("a row deactivated before 0043 (NULL stamp) is stamped on the first purge-enabled run and purged N days later", async () => {
    await seedDeactivated("legacy@org", null);
    expect(await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW)).toBe(0);
    const row = await env.DB.prepare("SELECT deactivated_at AS d FROM users WHERE subject = ?").bind("legacy@org").first<{ d: string }>();
    expect(row?.d).toBe(NOW.toISOString());
    const later = new Date(NOW.getTime() + 31 * DAY);
    expect(await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, later)).toBe(1);
    expect(await userExists("legacy@org")).toBe(false);
  });

  it("with N off, a legacy NULL row is left unstamped", async () => {
    await seedDeactivated("legacy@org", null);
    await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "0" }, NOW);
    const row = await env.DB.prepare("SELECT deactivated_at AS d FROM users WHERE subject = ?").bind("legacy@org").first<{ d: string | null }>();
    expect(row?.d).toBeNull();
  });

  it("a re-sign-in after purge creates a fresh row", async () => {
    await seedDeactivated("gone@org", daysAgo(31));
    await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW);
    await touchLastSeen(env.DB, "gone@org", NOW.toISOString());
    expect(await getUser(env.DB, "gone@org")).toMatchObject({ is_active: 1, role: "member", created_at: NOW.toISOString() });
  });

  it("fails closed without a hashing key: nothing deleted, no address logged", async () => {
    await seedDeactivated("gone@org", daysAgo(31));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const n = await purgeDeletedAccounts(
      { ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30", HASHING_KEY: "", TOKEN_HASH_PEPPER: "" }, NOW,
    );
    expect(n).toBe(0);
    expect(await userExists("gone@org")).toBe(true);
    expect(err).toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain("gone@org");
  });

  it("logs a count, never an address", async () => {
    await seedDeactivated("gone@org", daysAgo(31));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await purgeDeletedAccounts({ ...env, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW);
    expect(log).toHaveBeenCalledWith("deleted_accounts_purged", { count: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("gone@org");
  });
});
