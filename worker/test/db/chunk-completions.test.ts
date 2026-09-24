import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  recordChunkCompletion,
  deleteChunkCompletion,
  deleteTaskCompletions,
  loadCompletionsByTask,
  loadCompletedChunkIdsByTask,
} from "../../src/db/chunk-completions";

const OWNER = "user@example.com";

describe("chunk_completions DB helper", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM chunk_completions").run();
  });

  it("records a completion and reads it back grouped by task", async () => {
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#0", "2026-06-15T00:00:00Z", "color", "2026-06-15T00:00:00Z");
    const map = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(map.get("t1")).toEqual(new Set(["t1#0"]));
  });

  it("is idempotent on re-record (INSERT OR IGNORE, first write wins)", async () => {
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#0", "2026-06-15T00:00:00Z", "color", "2026-06-15T00:00:00Z");
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#0", "2026-06-16T00:00:00Z", "api", null);
    const ids = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(ids.get("t1")).toEqual(new Set(["t1#0"]));
    // The surviving row must hold the FIRST write's values (proves OR IGNORE,
    // not OR REPLACE: a replace would overwrite done_at/source with the 2nd call).
    const rows = (await loadCompletionsByTask(env.DB, OWNER, ["t1"])).get("t1");
    expect(rows).toHaveLength(1);
    expect(rows![0]!.done_at).toBe("2026-06-15T00:00:00Z");
    expect(rows![0]!.source).toBe("color");
  });

  it("deletes a single chunk record", async () => {
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#0", "2026-06-15T00:00:00Z", "color", "x");
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#1", "2026-06-15T00:00:00Z", "color", "x");
    await deleteChunkCompletion(env.DB, OWNER, "t1#0");
    const map = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(map.get("t1")).toEqual(new Set(["t1#1"]));
  });

  it("deletes every chunk record for a task", async () => {
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#0", "2026-06-15T00:00:00Z", "color", "x");
    await recordChunkCompletion(env.DB, OWNER, "t1", "t1#1", "2026-06-15T00:00:00Z", "color", "x");
    await deleteTaskCompletions(env.DB, OWNER, "t1");
    const map = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(map.get("t1")).toBeUndefined();
  });

  it("is owner-scoped (does not read another owner's rows)", async () => {
    await recordChunkCompletion(env.DB, "other@x.com", "t1", "t1#0", "2026-06-15T00:00:00Z", "color", "x");
    const map = await loadCompletedChunkIdsByTask(env.DB, OWNER, ["t1"]);
    expect(map.get("t1")).toBeUndefined();
  });

  it("returns an empty map for empty task id input with no DB round-trip", async () => {
    const map = await loadCompletedChunkIdsByTask(env.DB, OWNER, []);
    expect(map.size).toBe(0);
  });
});
