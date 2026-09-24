import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getDoneTaskIds, loadTasksByIds } from "../../src/db/tasks";

const insertTask = (
  id: string,
  owner: string,
  status: string,
  body: Record<string, unknown>,
  created = "2026-05-17T00:00:00Z",
  updated = "2026-05-17T00:00:00Z",
) =>
  env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, owner, JSON.stringify(body), status, created, updated)
    .run();

describe("getDoneTaskIds", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("returns empty Set without querying when taskIds is empty", async () => {
    const result = await getDoneTaskIds(env.DB, "owner@org", []);
    expect(result).toEqual(new Set());
  });

  it("returns only ids that are status='done' and owner-matched", async () => {
    await insertTask("done-1", "owner@org", "done", { title: "a" });
    await insertTask("pending-1", "owner@org", "pending", { title: "b" });
    await insertTask("done-other", "other@org", "done", { title: "c" });

    const result = await getDoneTaskIds(env.DB, "owner@org", [
      "done-1",
      "pending-1",
      "done-other",
    ]);
    expect(result).toEqual(new Set(["done-1"]));
  });

  it("excludes non-done statuses", async () => {
    await insertTask("scheduled-1", "owner@org", "scheduled", { title: "a" });
    await insertTask("committed-1", "owner@org", "committed", { title: "b" });

    const result = await getDoneTaskIds(env.DB, "owner@org", [
      "scheduled-1",
      "committed-1",
    ]);
    expect(result).toEqual(new Set());
  });

  it("does not include an id that is not present in the table", async () => {
    await insertTask("done-1", "owner@org", "done", { title: "a" });
    const result = await getDoneTaskIds(env.DB, "owner@org", ["done-1", "ghost"]);
    expect(result).toEqual(new Set(["done-1"]));
  });

  it("de-dups input ids", async () => {
    await insertTask("done-1", "owner@org", "done", { title: "a" });
    const result = await getDoneTaskIds(env.DB, "owner@org", [
      "done-1",
      "done-1",
      "done-1",
    ]);
    expect(result).toEqual(new Set(["done-1"]));
  });
});

describe("loadTasksByIds", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("returns [] without querying when taskIds is empty", async () => {
    const result = await loadTasksByIds(env.DB, "owner@org", []);
    expect(result).toEqual([]);
  });

  it("merges id/created_at/updated_at from columns and the rest from body", async () => {
    await insertTask(
      "t1",
      "owner@org",
      "pending",
      { title: "Deep work", context: "deep", priority: 80 },
      "2026-05-01T00:00:00Z",
      "2026-05-02T00:00:00Z",
    );

    const result = await loadTasksByIds(env.DB, "owner@org", ["t1"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "t1",
      title: "Deep work",
      context: "deep",
      priority: 80,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });
  });

  it("column id/created_at/updated_at win over any stale values in body", async () => {
    await insertTask(
      "real-id",
      "owner@org",
      "pending",
      { id: "stale-id", title: "x", created_at: "1999-01-01T00:00:00Z", updated_at: "1999-01-01T00:00:00Z" },
      "2026-05-01T00:00:00Z",
      "2026-05-02T00:00:00Z",
    );

    const result = await loadTasksByIds(env.DB, "owner@org", ["real-id"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("real-id");
    expect(result[0]!.created_at).toBe("2026-05-01T00:00:00Z");
    expect(result[0]!.updated_at).toBe("2026-05-02T00:00:00Z");
  });

  it("is owner-scoped and excludes other owners", async () => {
    await insertTask("t1", "owner@org", "pending", { title: "mine" });
    await insertTask("t2", "other@org", "pending", { title: "theirs" });

    const result = await loadTasksByIds(env.DB, "owner@org", ["t1", "t2"]);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
  });

  it("loads a 'done' task (no status filter)", async () => {
    await insertTask("done-1", "owner@org", "done", { title: "finished" });
    const result = await loadTasksByIds(env.DB, "owner@org", ["done-1"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("done-1");
  });

  it("de-dups input ids", async () => {
    await insertTask("t1", "owner@org", "pending", { title: "a" });
    const result = await loadTasksByIds(env.DB, "owner@org", ["t1", "t1"]);
    expect(result).toHaveLength(1);
  });
});
