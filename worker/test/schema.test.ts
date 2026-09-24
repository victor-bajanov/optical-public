import { describe, it, expect } from "vitest";
import { TaskCreate, TaskPatch } from "../src/schema/task";
import { TemplateCreate } from "../src/schema/template";
import { ProjectCreate } from "../src/schema/project";

describe("Task schema", () => {
  it("accepts atomic task", () => {
    const r = TaskCreate.safeParse({
      title: "Email triage",
      context: "admin",
      priority: 40,
      duration_minutes: 30,
    });
    expect(r.success).toBe(true);
  });

  it("rejects when both duration_minutes and chunks present", () => {
    const r = TaskCreate.safeParse({
      title: "Bad",
      context: "deep",
      priority: 50,
      duration_minutes: 60,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects chunks without group_policy", () => {
    const r = TaskCreate.safeParse({
      title: "Bad",
      context: "deep",
      priority: 50,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects group_policy without chunks", () => {
    const r = TaskCreate.safeParse({
      title: "Bad",
      context: "deep",
      priority: 50,
      duration_minutes: 60,
      group_policy: { same_day: true, ordered: false },
    });
    expect(r.success).toBe(false);
  });

  it("rejects context outside enum", () => {
    const r = TaskCreate.safeParse({
      title: "X",
      context: "bogus",
      priority: 10,
      duration_minutes: 30,
    });
    expect(r.success).toBe(false);
  });

  it("rejects priority out of 0..100", () => {
    const r = TaskCreate.safeParse({
      title: "X",
      context: "deep",
      priority: 200,
      duration_minutes: 30,
    });
    expect(r.success).toBe(false);
  });

  it("accepts chunked task with group_policy", () => {
    const r = TaskCreate.safeParse({
      title: "Big",
      context: "deep",
      priority: 80,
      chunks: [{ duration_minutes: 60 }, { duration_minutes: 60 }],
      group_policy: { same_day: false, ordered: true },
    });
    expect(r.success).toBe(true);
  });

  it("TaskPatch accepts partial body", () => {
    const r = TaskPatch.safeParse({ priority: 90 });
    expect(r.success).toBe(true);
  });

  it("TaskPatch rejects unknown field", () => {
    const r = TaskPatch.safeParse({ priority: 90, nonsense: true });
    expect(r.success).toBe(false);
  });

  it("accepts dependency by id", () => {
    const r = TaskCreate.safeParse({
      title: "Dependent",
      context: "deep",
      priority: 50,
      duration_minutes: 30,
      dependencies: [{ type: "after_task", ref: "11111111-1111-1111-1111-111111111111", hard: true }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts must_include and defaults it to false when omitted", () => {
    const validAtomicTask = {
      title: "Email triage",
      context: "admin" as const,
      priority: 40,
      duration_minutes: 30,
    };
    const withFlag = TaskCreate.parse({ ...validAtomicTask, must_include: true });
    expect(withFlag.must_include).toBe(true);
    const without = TaskCreate.parse({ ...validAtomicTask });
    expect(without.must_include).toBe(false);
  });
});

describe("TaskTemplate schema", () => {
  it("accepts pinned recurring template", () => {
    const r = TemplateCreate.safeParse({
      title: "Pilates",
      context: "physical",
      rrule: "FREQ=WEEKLY;BYDAY=FR",
      pinned_time: "19:00",
      duration_minutes: 90,
      active_from: "2026-01-01",
    });
    expect(r.success).toBe(true);
  });

  it("rejects malformed rrule (missing FREQ)", () => {
    const r = TemplateCreate.safeParse({
      title: "X",
      context: "deep",
      rrule: "BYDAY=MO",
      duration_minutes: 30,
      active_from: "2026-01-01",
    });
    expect(r.success).toBe(false);
  });
});

describe("Project schema", () => {
  it("accepts minimal project", () => {
    const r = ProjectCreate.safeParse({ title: "Q2 review" });
    expect(r.success).toBe(true);
  });

  it("accepts priority_floor 0..100", () => {
    const r = ProjectCreate.safeParse({ title: "X", priority_floor: 60 });
    expect(r.success).toBe(true);
  });

  it("rejects priority_floor > 100", () => {
    const r = ProjectCreate.safeParse({ title: "X", priority_floor: 200 });
    expect(r.success).toBe(false);
  });
});
