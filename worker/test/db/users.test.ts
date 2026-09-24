import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { upsertUser, touchLastSeen, listActiveSubjects, deactivateUser, getUser } from "../../src/db/users";

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
