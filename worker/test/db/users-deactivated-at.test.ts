import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { upsertUser, touchLastSeen, deactivateUser } from "../../src/db/users";

// Decision F: the purge window counts from users.deactivated_at, so offboard
// stamps it and every reactivation path clears it (a re-activated user must
// never be purged on an old offboard).
async function deactivatedAt(subject: string): Promise<string | null | undefined> {
  const r = await env.DB.prepare("SELECT deactivated_at AS d FROM users WHERE subject = ?")
    .bind(subject).first<{ d: string | null }>();
  return r ? r.d : undefined;
}

describe("users.deactivated_at", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM users").run(); });

  it("deactivateUser stamps deactivated_at with the given time", async () => {
    await upsertUser(env.DB, "u@org");
    expect(await deactivatedAt("u@org")).toBeNull();
    await deactivateUser(env.DB, "u@org", "2026-06-01T00:00:00.000Z");
    expect(await deactivatedAt("u@org")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("a second deactivation keeps the first stamp (the window counts from the offboard)", async () => {
    await upsertUser(env.DB, "u@org");
    await deactivateUser(env.DB, "u@org", "2026-06-01T00:00:00.000Z");
    await deactivateUser(env.DB, "u@org", "2026-06-20T00:00:00.000Z");
    expect(await deactivatedAt("u@org")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("offboarding an active row that carries a stale stamp restarts the window", async () => {
    // e.g. a harness flipped is_active back by hand without clearing the stamp
    await upsertUser(env.DB, "u@org");
    await env.DB.prepare("UPDATE users SET deactivated_at = ? WHERE subject = ?").bind("2025-01-01T00:00:00.000Z", "u@org").run();
    await deactivateUser(env.DB, "u@org", "2026-06-01T00:00:00.000Z");
    expect(await deactivatedAt("u@org")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("touchLastSeen (sign-in) reactivates and clears the stamp", async () => {
    await upsertUser(env.DB, "u@org");
    await deactivateUser(env.DB, "u@org", "2026-06-01T00:00:00.000Z");
    await touchLastSeen(env.DB, "u@org", "2026-06-02T00:00:00.000Z");
    expect(await deactivatedAt("u@org")).toBeNull();
  });

  it("upsertUser (with and without a role) reactivates and clears the stamp", async () => {
    await upsertUser(env.DB, "a@org");
    await deactivateUser(env.DB, "a@org", "2026-06-01T00:00:00.000Z");
    await upsertUser(env.DB, "a@org");
    expect(await deactivatedAt("a@org")).toBeNull();
    await deactivateUser(env.DB, "a@org", "2026-06-01T00:00:00.000Z");
    await upsertUser(env.DB, "a@org", "admin");
    expect(await deactivatedAt("a@org")).toBeNull();
  });
});
