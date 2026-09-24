import { describe, it, expect } from "vitest";
import { taskBelongsInWindow } from "../../src/planning/task-window";

// Window under test: [2026-05-18, 2026-05-25) (a Mon–Mon week).
const S = Date.parse("2026-05-18T00:00:00Z");
const E = Date.parse("2026-05-25T00:00:00Z");

const lastWeek = "2026-05-11T09:00:00Z";
const thisWeek = "2026-05-20T09:00:00Z";
const nextWeek = "2026-05-30T09:00:00Z";
const pastDeadline = "2026-05-01T17:00:00Z";
const futureDeadline = "2026-06-20T17:00:00Z";

// "Now" sits inside the window for the behaviour-matrix tests: they describe
// resolving the CURRENT week. The future-window suite passes its own now.
const NOW = Date.parse("2026-05-19T12:00:00Z");

const include = (
  a: Parameters<typeof taskBelongsInWindow>[0],
  nowMs: number = NOW,
) => taskBelongsInWindow(a, S, E, nowMs);

describe("taskBelongsInWindow — behaviour matrix", () => {
  it("includes an unscheduled TODO with no deadline (live backlog)", () => {
    expect(include({})).toBe(true);
  });

  it("includes a TODO with a future deadline (work ahead allowed)", () => {
    expect(include({ deadline: { at: futureDeadline } })).toBe(true);
  });

  it("sheds a TODO with a past deadline (overdue, soft or hard)", () => {
    expect(include({ deadline: { at: pastDeadline } })).toBe(false);
  });

  it("sheds a legacy committed task with a past hard deadline and no stamp", () => {
    expect(include({ deadline: { at: pastDeadline }, scheduled_for: null })).toBe(false);
  });

  it("sheds a task committed last week, undeadlined (anchor = past scheduled_for)", () => {
    expect(include({ scheduled_for: lastWeek })).toBe(false);
  });

  it("includes a task committed this week when re-resolving this week", () => {
    expect(include({ scheduled_for: thisWeek })).toBe(true);
  });

  it("sheds a task committed last week even with a future deadline (anchor wins)", () => {
    expect(include({ scheduled_for: lastWeek, deadline: { at: futureDeadline } })).toBe(false);
  });

  it("sheds a task pinned next week", () => {
    expect(include({ pinned_at: nextWeek })).toBe(false);
  });

  it("sheds a task pinned last week", () => {
    expect(include({ pinned_at: lastWeek })).toBe(false);
  });

  it("sheds a recurring occurrence pinned last week", () => {
    expect(include({ pinned_at: lastWeek, template_id: "tmpl-1", earliest_start: lastWeek })).toBe(false);
  });

  it("sheds an unpinned recurring occurrence from last week (earliest_start is its claimed week)", () => {
    expect(include({ template_id: "tmpl-1", earliest_start: lastWeek })).toBe(false);
  });

  it("includes an unpinned recurring occurrence for this week", () => {
    expect(include({ template_id: "tmpl-1", earliest_start: thisWeek })).toBe(true);
  });

  it("includes an ad-hoc task with a past earliest_start (a floor, not a pastness signal)", () => {
    expect(include({ earliest_start: lastWeek })).toBe(true);
  });
});

describe("taskBelongsInWindow — future earliest_start guard", () => {
  it("sheds a task whose earliest_start is at/after the window end, even with an in-window scheduled_for", () => {
    expect(include({ earliest_start: nextWeek, scheduled_for: thisWeek })).toBe(false);
  });

  it("sheds an earliest_start exactly at the window end (inclusive guard)", () => {
    expect(include({ earliest_start: "2026-05-25T00:00:00Z", scheduled_for: thisWeek })).toBe(false);
  });

  it("keeps a task whose earliest_start is inside the window", () => {
    expect(include({ earliest_start: thisWeek, scheduled_for: thisWeek })).toBe(true);
  });

  it("sheds a one-off (template_id == null) with a future earliest_start over a stale in-window stamp", () => {
    expect(include({ earliest_start: nextWeek, scheduled_for: thisWeek, template_id: null })).toBe(false);
  });

  it("sheds a recurring occurrence with a future earliest_start over a stale in-window stamp", () => {
    expect(include({ earliest_start: nextWeek, scheduled_for: thisWeek, template_id: "tmpl-1" })).toBe(false);
  });
});

// A resolve of a week that has not started yet (windowStart > now) must not
// capture the live backlog: an unanchored, undeadlined task belongs to the
// running week, not to any far-future week a webhook happens to resolve
// (prod 2026-08-12: backlog "Gym" committed to a week four weeks out by a
// replan triggered by a new invite in that week).
describe("taskBelongsInWindow — future windows never capture pure backlog", () => {
  // Now is BEFORE the window: [S, E) is a future week.
  const beforeWindow = Date.parse("2026-05-14T12:00:00Z");

  it("sheds an unanchored, undeadlined TODO from a window that has not started", () => {
    expect(include({}, beforeWindow)).toBe(false);
  });

  it("sheds an unanchored TODO whose earliest_start floor is in the past (floor does not target this window)", () => {
    expect(include({ earliest_start: lastWeek }, beforeWindow)).toBe(false);
  });

  it("keeps an unanchored TODO whose earliest_start floor is inside the future window (explicit claim on that week)", () => {
    expect(include({ earliest_start: thisWeek }, beforeWindow)).toBe(true);
  });

  it("keeps an unanchored TODO whose earliest_start is exactly the window start", () => {
    expect(include({ earliest_start: "2026-05-18T00:00:00Z" }, beforeWindow)).toBe(true);
  });

  it("keeps an unanchored TODO with a deadline at/after the future window start (work ahead)", () => {
    expect(include({ deadline: { at: futureDeadline } }, beforeWindow)).toBe(true);
  });

  it("keeps a task committed into the future window (scheduled_for anchor)", () => {
    expect(include({ scheduled_for: thisWeek }, beforeWindow)).toBe(true);
  });

  it("keeps a task pinned inside the future window", () => {
    expect(include({ pinned_at: thisWeek }, beforeWindow)).toBe(true);
  });

  it("keeps a recurring occurrence materialised for the future window", () => {
    expect(include({ template_id: "tmpl-1", earliest_start: thisWeek }, beforeWindow)).toBe(true);
  });

  it("includes backlog when the window start is exactly now (window has started)", () => {
    expect(include({}, S)).toBe(true);
  });

  it("still includes backlog in a window that contains now (current week, unchanged)", () => {
    expect(include({}, NOW)).toBe(true);
  });

  it("still includes backlog in a fully-past window (pastness is handled elsewhere)", () => {
    expect(include({}, Date.parse("2026-06-03T00:00:00Z"))).toBe(true);
  });
});

describe("taskBelongsInWindow — anchor priority", () => {
  it("prefers pinned_at over scheduled_for (pin in window wins over past stamp)", () => {
    expect(include({ pinned_at: thisWeek, scheduled_for: lastWeek })).toBe(true);
  });

  it("prefers scheduled_for over earliest_start for a recurring occurrence (stamp wins over floor)", () => {
    // Stamped to last week, even though earliest_start is this week.
    expect(include({ template_id: "tmpl-1", scheduled_for: lastWeek, earliest_start: thisWeek })).toBe(false);
  });
});

describe("taskBelongsInWindow — window boundaries", () => {
  it("includes an anchor exactly at the window start (inclusive)", () => {
    expect(include({ scheduled_for: "2026-05-18T00:00:00Z" })).toBe(true);
  });

  it("sheds an anchor exactly at the window end (exclusive)", () => {
    expect(include({ scheduled_for: "2026-05-25T00:00:00Z" })).toBe(false);
  });

  it("includes a deadline exactly at the window start (not strictly before)", () => {
    expect(include({ deadline: { at: "2026-05-18T00:00:00Z" } })).toBe(true);
  });
});

describe("taskBelongsInWindow — malformed anchors never silently shed", () => {
  it("includes a task whose only anchor is unparseable", () => {
    expect(include({ pinned_at: "not-a-date" })).toBe(true);
  });

  it("falls through a malformed pinned_at to a valid past scheduled_for (still sheds)", () => {
    expect(include({ pinned_at: "garbage", scheduled_for: lastWeek })).toBe(false);
  });

  it("includes a task with an unparseable deadline and no anchor", () => {
    expect(include({ deadline: { at: "garbage" } })).toBe(true);
  });
});
