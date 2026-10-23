import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { upsertUser, touchLastSeen, listActiveSubjects, deactivateUser, getUser, bumpLastSeenStmt, isLastSeenStale, isActivityBumpDue } from "../../src/db/users";

beforeEach(async () => { await env.DB.prepare("DELETE FROM users").run(); });

describe("users repository", () => {
  it("upsertUser inserts a member by default and is idempotent on role", async () => {
    await upsertUser(env.DB, "u@org");
    await upsertUser(env.DB, "u@org"); // second call must not clobber role
    const u = await getUser(env.DB, "u@org");
    expect(u).toMatchObject({ subject: "u@org", role: "member", is_active: 1 });
  });

  it("upsertUser honours an explicit admin role and keeps it on re-upsert", async () => {
    await upsertUser(env.DB, "a@org", "admin");
    await upsertUser(env.DB, "a@org"); // no role arg => must NOT downgrade
    const u = await getUser(env.DB, "a@org");
    expect(u?.role).toBe("admin");
  });

  it("touchLastSeen sets last_seen, creates the row if missing, and reactivates", async () => {
    await touchLastSeen(env.DB, "u@org", "2026-06-01T00:00:00Z");
    let u = await getUser(env.DB, "u@org");
    expect(u).toMatchObject({ is_active: 1, last_seen: "2026-06-01T00:00:00Z" });
    await deactivateUser(env.DB, "u@org");
    await touchLastSeen(env.DB, "u@org", "2026-06-02T00:00:00Z");
    u = await getUser(env.DB, "u@org");
    expect(u).toMatchObject({ is_active: 1, last_seen: "2026-06-02T00:00:00Z" });
  });

  it("listActiveSubjects returns only active subjects", async () => {
    await upsertUser(env.DB, "active@org");
    await upsertUser(env.DB, "gone@org");
    await deactivateUser(env.DB, "gone@org");
    const subs = await listActiveSubjects(env.DB);
    expect(subs).toContain("active@org");
    expect(subs).not.toContain("gone@org");
  });

  it("getUser returns null for an unknown subject", async () => {
    expect(await getUser(env.DB, "nobody@org")).toBeNull();
  });
});

// O10a: activity bump. UPDATE-only, active-only, throttled to one write per
// LAST_SEEN_BUMP_THROTTLE (20 h), ISO strings as the retention sweep compares.
describe("bumpLastSeenStmt", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const seed = (subject: string, lastSeen: string | null, isActive = 1) =>
    env.DB.prepare("INSERT INTO users (subject, role, is_active, last_seen, created_at) VALUES (?, 'member', ?, ?, '2026-01-01T00:00:00Z')")
      .bind(subject, isActive, lastSeen).run();

  it("stamps an active user whose last_seen is older than the 20 h throttle", async () => {
    await seed("u@org", "2026-10-08T15:59:59.999Z"); // 20 h + 1 ms ago
    const r = await bumpLastSeenStmt(env.DB, "u@org", NOW).run();
    expect(r.meta.changes).toBe(1);
    expect((await getUser(env.DB, "u@org"))!.last_seen).toBe("2026-10-09T12:00:00.000Z");
  });

  it("stamps a NULL last_seen", async () => {
    await seed("u@org", null);
    await bumpLastSeenStmt(env.DB, "u@org", NOW).run();
    expect((await getUser(env.DB, "u@org"))!.last_seen).toBe("2026-10-09T12:00:00.000Z");
  });

  it("leaves a last_seen exactly at or newer than the cutoff alone", async () => {
    await seed("edge@org", "2026-10-08T16:00:00.000Z"); // exactly 20 h ago
    await seed("fresh@org", "2026-10-09T11:00:00.000Z");
    expect((await bumpLastSeenStmt(env.DB, "edge@org", NOW).run()).meta.changes).toBe(0);
    expect((await bumpLastSeenStmt(env.DB, "fresh@org", NOW).run()).meta.changes).toBe(0);
    expect((await getUser(env.DB, "edge@org"))!.last_seen).toBe("2026-10-08T16:00:00.000Z");
  });

  it("never reactivates or stamps an inactive user", async () => {
    await seed("gone@org", "2026-01-01T00:00:00.000Z", 0);
    expect((await bumpLastSeenStmt(env.DB, "gone@org", NOW).run()).meta.changes).toBe(0);
    expect(await getUser(env.DB, "gone@org")).toMatchObject({ is_active: 0, last_seen: "2026-01-01T00:00:00.000Z" });
  });

  it("never creates a row for an unknown subject", async () => {
    expect((await bumpLastSeenStmt(env.DB, "nobody@org", NOW).run()).meta.changes).toBe(0);
    expect(await getUser(env.DB, "nobody@org")).toBeNull();
  });
});

describe("isLastSeenStale", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  it("is true for NULL and for values strictly older than now - 20 h", () => {
    expect(isLastSeenStale(null, NOW)).toBe(true);
    expect(isLastSeenStale("2026-10-08T15:59:59.999Z", NOW)).toBe(true);
  });
  it("is false at or after the cutoff", () => {
    expect(isLastSeenStale("2026-10-08T16:00:00.000Z", NOW)).toBe(false);
    expect(isLastSeenStale("2026-10-09T11:59:00.000Z", NOW)).toBe(false);
  });
});

// O10b: activity clears the retention warning stamp (retention_warned_at), so a
// warned user who comes back is never deleted on the old warning's clock.
describe("activity clears retention_warned_at (O10b)", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const seedWarned = (subject: string, lastSeen: string | null, warnedAt: string | null, isActive = 1) =>
    env.DB.prepare("INSERT INTO users (subject, role, is_active, last_seen, created_at, retention_warned_at) VALUES (?, 'member', ?, ?, '2026-01-01T00:00:00Z', ?)")
      .bind(subject, isActive, lastSeen, warnedAt).run();
  const warnedAt = (subject: string) =>
    env.DB.prepare("SELECT retention_warned_at AS w FROM users WHERE subject = ?").bind(subject).first<{ w: string | null }>();

  it("touchLastSeen (sign-in) clears the stamp", async () => {
    await seedWarned("u@org", "2026-07-01T00:00:00.000Z", "2026-09-20T04:00:00.000Z");
    await touchLastSeen(env.DB, "u@org", "2026-10-09T12:00:00.000Z");
    expect((await warnedAt("u@org"))!.w).toBeNull();
  });

  it("the bump clears the stamp and stamps last_seen when stale", async () => {
    await seedWarned("u@org", "2026-07-01T00:00:00.000Z", "2026-09-20T04:00:00.000Z");
    expect((await bumpLastSeenStmt(env.DB, "u@org", NOW).run()).meta.changes).toBe(1);
    expect(await getUser(env.DB, "u@org")).toMatchObject({ last_seen: "2026-10-09T12:00:00.000Z" });
    expect((await warnedAt("u@org"))!.w).toBeNull();
  });

  it("the bump clears the stamp even inside the 20 h throttle window", async () => {
    await seedWarned("u@org", "2026-10-09T11:00:00.000Z", "2026-10-09T04:00:00.000Z");
    expect((await bumpLastSeenStmt(env.DB, "u@org", NOW).run()).meta.changes).toBe(1);
    expect((await warnedAt("u@org"))!.w).toBeNull();
  });

  it("an un-warned user inside the throttle is still not written", async () => {
    await seedWarned("u@org", "2026-10-09T11:00:00.000Z", null);
    expect((await bumpLastSeenStmt(env.DB, "u@org", NOW).run()).meta.changes).toBe(0);
  });

  it("the bump never touches an inactive warned user", async () => {
    await seedWarned("gone@org", "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", 0);
    expect((await bumpLastSeenStmt(env.DB, "gone@org", NOW).run()).meta.changes).toBe(0);
    expect((await warnedAt("gone@org"))!.w).toBe("2026-03-01T00:00:00.000Z");
  });

  it("isActivityBumpDue: stale last_seen, or any warning stamp", () => {
    expect(isActivityBumpDue(null, null, NOW)).toBe(true);
    expect(isActivityBumpDue("2026-10-08T15:59:59.999Z", null, NOW)).toBe(true);
    expect(isActivityBumpDue("2026-10-09T11:00:00.000Z", null, NOW)).toBe(false);
    expect(isActivityBumpDue("2026-10-09T11:00:00.000Z", "2026-10-09T04:00:00.000Z", NOW)).toBe(true);
  });
});
