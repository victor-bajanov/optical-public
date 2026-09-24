import { describe, it, expect } from "vitest";
import { TaskCreate, TaskPatch } from "../../src/schema/task";

describe("attendee_enforcement schema field", () => {
  it("TaskCreate accepts a valid enforcement value", () => {
    const r = TaskCreate.parse({ title: "m", context: "meeting", priority: 100, duration_minutes: 60, attendee_enforcement: "not_declined" });
    expect(r.attendee_enforcement).toBe("not_declined");
  });
  it("TaskPatch accepts attendee_enforcement on its own", () => {
    expect(TaskPatch.parse({ attendee_enforcement: "accepted" }).attendee_enforcement).toBe("accepted");
  });
  it("rejects an unknown enforcement value", () => {
    expect(() => TaskCreate.parse({ title: "m", context: "meeting", priority: 100, duration_minutes: 60, attendee_enforcement: "everyone" })).toThrow();
  });
});
