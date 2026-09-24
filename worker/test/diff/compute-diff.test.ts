import { describe, it, expect } from "vitest";
import { computePlanDiff } from "../../src/diff/compute-diff";

const committed = {
  schedule: [
    { task_id: "t-deep", chunk_id: "t-deep#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" },
    { task_id: "t-admin", chunk_id: "t-admin#0", start: "2026-05-19T14:00:00Z", end: "2026-05-19T14:30:00Z", context: "admin" },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

const proposed = {
  schedule: [
    { task_id: "t-deep", chunk_id: "t-deep#0", start: "2026-05-19T10:00:00Z", end: "2026-05-19T11:30:00Z", context: "deep" }, // moved
    { task_id: "t-new", chunk_id: "t-new#0", start: "2026-05-19T15:00:00Z", end: "2026-05-19T15:30:00Z", context: "admin" }, // added
  ],
  dropped: [
    { task_id: "t-admin", title: "Email triage", drop_cost: 230, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["soft_deadline"] },
  ],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

describe("computePlanDiff", () => {
  it("categorises moves, adds, removes and dropped", () => {
    const d = computePlanDiff(proposed, committed);
    expect(d.moved).toHaveLength(1);
    expect(d.moved[0]!.task_id).toBe("t-deep");
    expect(d.moved[0]!.from.start).toBe("2026-05-19T09:00:00Z");
    expect(d.moved[0]!.to.start).toBe("2026-05-19T10:00:00Z");
    expect(d.added.map((a) => a.task_id)).toEqual(["t-new"]);
    expect(d.removed.map((r) => r.task_id)).toEqual(["t-admin"]);
    expect(d.dropped).toHaveLength(1);
  });

  it("treats an identical proposed plan as empty diff", () => {
    const d = computePlanDiff(committed, committed);
    expect(d.moved).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.dropped).toEqual([]);
  });

  it("treats a null committed plan as everything being added", () => {
    const d = computePlanDiff(proposed, null);
    expect(d.moved).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.added).toHaveLength(2);
  });

  it("isEmpty true only when no moves/adds/removes/drops", () => {
    expect(computePlanDiff(committed, committed).isEmpty).toBe(true);
    expect(computePlanDiff(proposed, committed).isEmpty).toBe(false);
  });

  it("a task still dropped from the committed plan is NOT newly dropped → isEmpty when nothing else changed", () => {
    // Regression (2026-07-07): a persistently-unfittable task (e.g. Lunch) that
    // was ALREADY dropped in the last accepted plan and is still dropped is not a
    // change worth emailing. `dropped` alone must not defeat the no-op gate.
    const window = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
    const existing = { task_id: "t-deep", chunk_id: "t-deep#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" };
    const lunch = { task_id: "t-lunch", title: "Lunch", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    const committedPlan = { schedule: [existing], dropped: [lunch], window };
    const proposedPlan = { schedule: [existing], dropped: [lunch], window }; // identical; still drops Lunch
    const d = computePlanDiff(proposedPlan, committedPlan);
    expect(d.newlyDropped).toEqual([]);
    expect(d.dropped).toHaveLength(1); // still surfaced for display when the email DOES fire
    expect(d.isEmpty).toBe(true);
  });

  it("a task dropped now but NOT dropped in the committed plan is newly dropped → not empty", () => {
    const window = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
    const existing = { task_id: "t-deep", chunk_id: "t-deep#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" };
    const lunch = { task_id: "t-lunch", title: "Lunch", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    const committedPlan = { schedule: [existing], dropped: [], window };
    const proposedPlan = { schedule: [existing], dropped: [lunch], window };
    const d = computePlanDiff(proposedPlan, committedPlan);
    expect((d.newlyDropped ?? []).map((x) => x.task_id)).toEqual(["t-lunch"]);
    expect(d.isEmpty).toBe(false);
  });

  it("null committed baseline treats every drop as newly dropped", () => {
    const window = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
    const lunch = { task_id: "t-lunch", title: "Lunch", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    const d = computePlanDiff({ schedule: [], dropped: [lunch], window }, null);
    expect((d.newlyDropped ?? []).map((x) => x.task_id)).toEqual(["t-lunch"]);
    expect(d.isEmpty).toBe(false);
  });

  it("does not report a move when times denote the same instant in different forms", () => {
    // Baseline in offset form (as Google may return), proposed in canonical Z —
    // same instants. Instant-based comparison must treat this as unchanged.
    const baseline = {
      schedule: [
        { task_id: "t-deep", chunk_id: "t-deep#0", start: "2026-05-19T19:00:00+10:00", end: "2026-05-19T20:30:00+10:00", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    const same = {
      schedule: [
        { task_id: "t-deep", chunk_id: "t-deep#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    const d = computePlanDiff(same, baseline);
    expect(d.moved).toEqual([]);
    expect(d.isEmpty).toBe(true);
  });
});
