import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { loadTitleMap } from "../../src/diff/load-titles";

describe("loadTitleMap", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("t1", "owner-a", JSON.stringify({ id: "t1", title: "Deep work" }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("t2", "owner-a", JSON.stringify({ id: "t2", title: "Email triage" }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
  });

  it("returns title map for requested ids", async () => {
    const m = await loadTitleMap(env.DB, "owner-a", ["t1", "t2"]);
    expect(m).toEqual({ t1: "Deep work", t2: "Email triage" });
  });

  it("returns empty map for empty input", async () => {
    const m = await loadTitleMap(env.DB, "owner-a", []);
    expect(m).toEqual({});
  });

  it("omits missing ids silently", async () => {
    const m = await loadTitleMap(env.DB, "owner-a", ["t1", "missing"]);
    expect(m).toEqual({ t1: "Deep work" });
  });

  it("never returns another owner's titles even when the id is requested", async () => {
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("b1", "owner-b", JSON.stringify({ id: "b1", title: "B secret" }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    const m = await loadTitleMap(env.DB, "owner-a", ["t1", "b1"]);
    expect(m).toEqual({ t1: "Deep work" });
  });
});
