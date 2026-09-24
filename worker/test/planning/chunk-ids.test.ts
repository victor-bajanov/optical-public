import { describe, it, expect } from "vitest";
import { chunkIdsOfTask } from "../../src/planning/chunk-ids";

describe("chunkIdsOfTask", () => {
  it("atomic task (duration_minutes) has a single #0 chunk", () => {
    expect(chunkIdsOfTask({ id: "t1", duration_minutes: 60 } as any)).toEqual(["t1#0"]);
  });

  it("explicit chunks are indexed in array order", () => {
    const task = { id: "t1", chunks: [{ duration_minutes: 30 }, { duration_minutes: 45 }] } as any;
    expect(chunkIdsOfTask(task)).toEqual(["t1#0", "t1#1"]);
  });
});
