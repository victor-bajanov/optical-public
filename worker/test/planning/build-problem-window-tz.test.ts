// Card E (internal design notes): buildSolverProblem projects tz-carrying
// preferred windows into the problem tz and never puts `tz` on the wire.
import { describe, it, expect } from "vitest";
import { buildSolverProblem } from "../../src/planning/build-problem";
import type { Task } from "../../src/types/task";

const WEIGHTS = { time_of_day_fit_per_15min: 0, churn_per_15min_moved: 1, priority_unit: 1, base_drop_penalty: 200 };
const LON = "Europe/London";
const SYD = "Australia/Sydney";
// London week of Mon 30 Mar 2026 (BST; Sydney AEDT till Sun 5 Apr).
const LON_APR = { start: "2026-03-29T23:00:00Z", end: "2026-04-05T23:00:00Z" };

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    title: "T",
    context: "deep",
    priority: 50,
    duration_minutes: 60,
    source: { kind: "rest", external_id: null },
    status: "pending",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...overrides,
  } as Task;
}

function build(tasks: Task[], extra: Record<string, unknown> = {}) {
  return buildSolverProblem({
    tasks,
    externalEvents: [],
    previousSchedule: [],
    window: LON_APR,
    weights: WEIGHTS,
    contexts: [],
    tz: LON,
    ...extra,
  });
}

describe("buildSolverProblem: preferred-window tz projection", () => {
  it("passes untimezoned windows through unchanged", () => {
    const pw = [{ days: ["tue" as const], start: "14:00", end: "16:00", hard: true }];
    const wire = build([task({ preferred_windows: pw })]).tasks[0]!;
    expect(wire.preferred_windows).toEqual(pw);
    expect(wire).not.toHaveProperty("availability_windows");
  });

  it("strips a tz equal to the problem tz from the wire", () => {
    const wire = build([task({ preferred_windows: [{ days: ["tue"], start: "14:00", end: "16:00", hard: false, tz: LON }] })]).tasks[0]!;
    expect(wire.preferred_windows).toEqual([{ days: ["tue"], start: "14:00", end: "16:00", hard: false }]);
    expect(JSON.stringify(wire)).not.toContain('"tz"');
  });

  it("re-expresses a Sydney window in London time", () => {
    const wire = build([task({ preferred_windows: [{ days: ["tue"], start: "09:00", end: "11:00", hard: false, tz: SYD }] })]).tasks[0]!;
    expect(wire.preferred_windows).toEqual([
      { days: ["mon"], start: "23:00", end: "23:59", hard: false },
      { days: ["tue"], start: "00:00", end: "01:00", hard: false },
    ]);
  });

  it("a split hard window becomes an availability mask (and still exempts business hours)", () => {
    const wire = build([task({ preferred_windows: [{ days: ["tue"], start: "09:00", end: "11:00", hard: true, tz: SYD }] })], {
      businessHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
    }).tasks[0]!;
    expect(wire.preferred_windows).toEqual([]);
    expect(wire.availability_windows).toEqual([{ start: "2026-03-30T23:00:00", end: "2026-03-31T01:00:00" }]);
  });

  it("clips the mask at the placement floor", () => {
    const wire = build([task({ preferred_windows: [{ days: ["tue"], start: "09:00", end: "11:00", hard: true, tz: SYD }] })], {
      placementFloor: "2026-03-31T00:00:00Z", // Tue 01:00 BST
    }).tasks[0]!;
    // Nothing a 60-minute chunk can fit: impossible mask past the horizon.
    expect(wire.availability_windows).toEqual([{ start: "2026-04-06T00:00:00", end: "2026-04-06T00:15:00" }]);
  });

  it("intersects a foreign hard mask with a movable meeting's availability", () => {
    const wire = build(
      [task({ id: "m1", context: "meeting", duration_minutes: 30, preferred_windows: [{ days: ["tue"], start: "09:00", end: "11:00", hard: true, tz: SYD }] })],
      {
        meetingInputs: [
          {
            taskId: "m1",
            eventId: "evt1",
            currentStartISO: "2026-03-31T00:00:00Z",
            durationMinutes: 30,
            availabilityWindowsISO: [{ start: "2026-03-30T23:00:00Z", end: "2026-03-31T02:00:00Z" }], // Tue 00:00–03:00 BST
            churnMultiplier: 1,
          },
        ],
      },
    ).tasks[0]!;
    expect(wire.availability_windows).toEqual([{ start: "2026-03-31T00:00:00", end: "2026-03-31T01:00:00" }]);
  });
});
