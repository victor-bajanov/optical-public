import { describe, it, expect } from "vitest";
import { D } from "../../src/schema/descriptions";
import { TaskCreate, TaskPatch } from "../../src/schema/task";
import { TaskResponse } from "../../src/schema/task-response";

describe("task status description — done terminal state", () => {
  it("D.task.status documents 'done' as a user-completion terminal state", () => {
    const desc = D.task.status;
    expect(desc).toMatch(/done/);
    // 'done' must be described as terminal
    expect(desc).toMatch(/terminal/i);
    // must mention exclusion from planning
    expect(desc).toMatch(/planning|solver|plan/i);
    // must mention calendar event removal
    expect(desc).toMatch(/calendar|event/i);
  });

  it("TaskCreate (request schema) status field uses D.task.status", () => {
    // Extract the description from the status field of TaskCreate
    const shape = (TaskCreate as any)._def?.schema?._def?.shape?.() ?? (TaskCreate as any)._def?.shape?.();
    const statusField = shape?.status;
    expect(statusField).toBeDefined();
    const desc = statusField?._def?.description ?? statusField?._def?.innerType?._def?.description;
    expect(desc).toBe(D.task.status);
  });

  it("TaskResponse (response schema) status field uses D.task.status", () => {
    const shape = (TaskResponse as any)._def?.shape?.();
    const statusField = shape?.status;
    expect(statusField).toBeDefined();
    const desc = statusField?._def?.description;
    expect(desc).toBe(D.task.status);
  });
});
