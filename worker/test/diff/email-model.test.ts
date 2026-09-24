import { describe, it, expect } from "vitest";
import { buildReplanEmailModel } from "../../src/diff/email-model";
import type { PlanDiff } from "../../src/diff/compute-diff";

const TZ = "Australia/Sydney";
const entry = (chunk: string, task: string, start: string, end: string) =>
  ({ task_id: task, chunk_id: chunk, start, end, context: "" });

describe("buildReplanEmailModel", () => {
  it("classifies a single move with surrounding meetings on the affected day", () => {
    const from = entry("t1#0", "t1", "2026-06-15T01:30:00.000Z", "2026-06-15T03:30:00.000Z");
    const to = entry("t1#0", "t1", "2026-06-15T04:45:00.000Z", "2026-06-15T06:45:00.000Z");
    const diff: PlanDiff = { moved: [{ task_id: "t1", chunk_id: "t1#0", from, to }], added: [], removed: [], dropped: [], isEmpty: false };

    const model = buildReplanEmailModel({
      diff,
      titles: { t1: "BAS prep" },
      priorEvents: [from],
      proposedSchedule: [to],
      externalEvents: [
        { id: "c1", title: "Client call", start: "2026-06-15T01:00:00.000Z", end: "2026-06-15T02:00:00.000Z" },
        { id: "s1", title: "1:1 with Sam", start: "2026-06-15T03:30:00.000Z", end: "2026-06-15T04:45:00.000Z" },
      ],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
      tz: TZ,
      trigger: { kind: "webhook", inviteTitle: "Client call" },
      triggerEventIds: ["c1"],
    });

    expect(model.isEmpty).toBe(false);
    expect(model.days).toHaveLength(1);
    const day = model.days[0]!;
    expect(day.date).toBe("2026-06-15");
    // BEFORE: Client call (new-clash), BAS prep moved-from, 1:1 existing — sorted by start
    expect(day.before.map((e) => [e.title, e.role])).toEqual([
      ["Client call", "new-clash"],
      ["BAS prep", "moved-from"],
      ["1:1 with Sam", "existing"],
    ]);
    // AFTER: Client call, 1:1, BAS prep moved-to (with movedFrom)
    const basAfter = day.after.find((e) => e.title === "BAS prep")!;
    expect(basAfter.role).toBe("moved-to");
    expect(basAfter.movedFrom).toBe("2026-06-15T01:30:00.000Z");
  });

  it("is empty when the diff is empty", () => {
    const diff: PlanDiff = { moved: [], added: [], removed: [], dropped: [], isEmpty: true };
    const model = buildReplanEmailModel({
      diff, titles: {}, priorEvents: [], proposedSchedule: [], externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" }, tz: TZ, trigger: "monday-cron",
    });
    expect(model.isEmpty).toBe(true);
    expect(model.days).toEqual([]);
  });

  it("carries dropped tasks with the solver's returned reasons", () => {
    const diff: PlanDiff = {
      moved: [], added: [], removed: [],
      dropped: [{ task_id: "t9", title: "Tax return", drop_cost: 200, reason: "no_fit", contributing_constraints: ["business_hours", "deadline"] }],
      isEmpty: false,
    };
    const model = buildReplanEmailModel({
      diff, titles: { t9: "Tax return" }, priorEvents: [], proposedSchedule: [], externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" }, tz: TZ, trigger: "monday-cron",
    });
    expect(model.dropped).toEqual([{ title: "Tax return", reason: "no_fit", constraints: ["business_hours", "deadline"] }]);
  });

  it("uses the solver-provided d.title for dropped tasks whose task_id is not in the titles map", () => {
    // task_id "t-unknown" is intentionally absent from the titles map;
    // the diff carries a human-readable title in dropped[].title — that should win.
    const diff: PlanDiff = {
      moved: [], added: [], removed: [],
      dropped: [{ task_id: "t-unknown", title: "Legacy project", drop_cost: 200, reason: "no_fit", contributing_constraints: [] }],
      isEmpty: false,
    };
    const model = buildReplanEmailModel({
      diff, titles: {}, priorEvents: [], proposedSchedule: [], externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" }, tz: TZ, trigger: "monday-cron",
    });
    // Should use the human d.title, NOT the raw task_id.
    expect(model.dropped[0]!.title).toBe("Legacy project");
    expect(model.dropped[0]!.title).not.toBe("t-unknown");
  });

  it("suppresses days whose entries are all 'existing'", () => {
    // A move on 2026-06-15, plus an unchanged scheduler chunk on a DIFFERENT
    // local day (2026-06-17) that appears in both prior and proposed schedules.
    const from = entry("t1#0", "t1", "2026-06-15T01:30:00.000Z", "2026-06-15T03:30:00.000Z");
    const to = entry("t1#0", "t1", "2026-06-15T04:45:00.000Z", "2026-06-15T06:45:00.000Z");
    const unchanged = entry("t2#0", "t2", "2026-06-17T01:00:00.000Z", "2026-06-17T02:00:00.000Z");
    const diff: PlanDiff = { moved: [{ task_id: "t1", chunk_id: "t1#0", from, to }], added: [], removed: [], dropped: [], isEmpty: false };

    const model = buildReplanEmailModel({
      diff,
      titles: { t1: "BAS prep", t2: "Reading" },
      priorEvents: [from, unchanged],
      proposedSchedule: [to, unchanged],
      externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
      tz: TZ,
      trigger: "monday-cron",
    });

    // Only the move's day survives — the all-"existing" 2026-06-17 day is dropped.
    expect(model.days.map((d) => d.date)).toEqual(["2026-06-15"]);
    // The unchanged chunk, where it appears, is classified "existing".
    const reading = model.days
      .flatMap((d) => [...d.before, ...d.after])
      .filter((e) => e.title === "Reading");
    for (const e of reading) expect(e.role).toBe("existing");
  });

  it("marks a moved meeting (task_id in meetingTaskIds) on both before and after sides, and threads warnings", () => {
    // priorEvents always arrive with context "" (reconstructed from calendar);
    // meeting-ness comes from the caller's meetingTaskIds (real meeting rows,
    // source.kind === "meeting"). A moved meeting must read as a meeting on BOTH
    // columns.
    const from = { task_id: "m1", chunk_id: "m1#0", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T02:00:00.000Z", context: "" };
    const to = { task_id: "m1", chunk_id: "m1#0", start: "2026-06-15T04:45:00.000Z", end: "2026-06-15T05:15:00.000Z", context: "meeting" };
    const diff: PlanDiff = { moved: [{ task_id: "m1", chunk_id: "m1#0", from, to }], added: [], removed: [], dropped: [], isEmpty: false };

    const model = buildReplanEmailModel({
      diff,
      titles: { m1: "Standup" },
      priorEvents: [from],
      proposedSchedule: [to],
      externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
      tz: TZ,
      trigger: "monday-cron",
      warnings: ["Standup: attendee_availability_unknown"],
      meetingTaskIds: ["m1"],
    });

    expect(model.warnings).toEqual(["Standup: attendee_availability_unknown"]);
    const day = model.days[0]!;
    const beforeStandup = day.before.find((e) => e.title === "Standup")!;
    const afterStandup = day.after.find((e) => e.title === "Standup")!;
    expect(beforeStandup.isMeeting).toBe(true);
    expect(afterStandup.isMeeting).toBe(true);
  });

  it("does NOT mark a user task whose context is 'meeting' as a meeting (regression: context is a batching category, not meeting-ness)", () => {
    // "meeting" is a legitimate user-selectable Context enum value ("deep",
    // "admin", ..., "meeting") used to batch similar work. Only tasks whose id is
    // in meetingTaskIds (rows with source.kind === "meeting") are real owned
    // meetings; a plain task titled/categorised "meeting" must not get the
    // Meeting chip or the "attendees will be notified" note.
    const from = { task_id: "t1", chunk_id: "t1#0", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T02:00:00.000Z", context: "" };
    const to = { task_id: "t1", chunk_id: "t1#0", start: "2026-06-15T04:45:00.000Z", end: "2026-06-15T05:15:00.000Z", context: "meeting" };
    const diff: PlanDiff = { moved: [{ task_id: "t1", chunk_id: "t1#0", from, to }], added: [], removed: [], dropped: [], isEmpty: false };

    const model = buildReplanEmailModel({
      diff,
      titles: { t1: "Multiplayer meeting bookings" },
      priorEvents: [from],
      proposedSchedule: [to],
      externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
      tz: TZ,
      trigger: "monday-cron",
      meetingTaskIds: [],
    });

    const all = model.days.flatMap((d) => [...d.before, ...d.after]);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(e.isMeeting).toBeUndefined();
  });

  it("does not mark ordinary task moves as meetings and defaults warnings to []", () => {
    const from = entry("t1#0", "t1", "2026-06-15T01:30:00.000Z", "2026-06-15T03:30:00.000Z");
    const to = entry("t1#0", "t1", "2026-06-15T04:45:00.000Z", "2026-06-15T06:45:00.000Z");
    const diff: PlanDiff = { moved: [{ task_id: "t1", chunk_id: "t1#0", from, to }], added: [], removed: [], dropped: [], isEmpty: false };
    const model = buildReplanEmailModel({
      diff, titles: { t1: "BAS prep" }, priorEvents: [from], proposedSchedule: [to], externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" }, tz: TZ, trigger: "monday-cron",
    });
    expect(model.warnings).toEqual([]);
    const all = model.days.flatMap((d) => [...d.before, ...d.after]);
    for (const e of all) expect(e.isMeeting).toBeUndefined();
  });

  it("produces one DayView per changed local day, in chronological order", () => {
    // A move on 2026-06-17 and an add on 2026-06-15 — supplied out of order to
    // prove the output is sorted chronologically by local day.
    const from = entry("t1#0", "t1", "2026-06-17T01:30:00.000Z", "2026-06-17T03:30:00.000Z");
    const to = entry("t1#0", "t1", "2026-06-17T04:45:00.000Z", "2026-06-17T06:45:00.000Z");
    const added = entry("t2#0", "t2", "2026-06-15T01:00:00.000Z", "2026-06-15T02:00:00.000Z");
    const diff: PlanDiff = { moved: [{ task_id: "t1", chunk_id: "t1#0", from, to }], added: [added], removed: [], dropped: [], isEmpty: false };

    const model = buildReplanEmailModel({
      diff,
      titles: { t1: "BAS prep", t2: "New task" },
      priorEvents: [from],
      proposedSchedule: [to, added],
      externalEvents: [],
      window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
      tz: TZ,
      trigger: "monday-cron",
    });

    expect(model.days.map((d) => d.date)).toEqual(["2026-06-15", "2026-06-17"]);
  });
});
