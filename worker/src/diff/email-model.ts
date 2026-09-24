import type { PlanDiff, ScheduleEntry } from "./compute-diff";
import type { ExternalEvent } from "../planning/resolve-internal";
import { localDayKey } from "./format-local";

export type Trigger = "monday-cron" | { kind: "webhook"; inviteTitle: string };

export type EntryRole =
  | "moved-from" | "moved-to" | "added" | "removed" | "existing" | "new-clash";

export interface TimelineEntry {
  title: string;
  start: string;        // ISO-Z
  end: string;          // ISO-Z
  role: EntryRole;
  movedFrom?: string;   // ISO-Z, only on "moved-to"
  isMeeting?: boolean;  // true when the backing task is an owned meeting row (source.kind === "meeting")
}

export interface DayView {
  date: string;               // local YYYY-MM-DD
  before: TimelineEntry[];
  after: TimelineEntry[];
}

export interface DroppedView { title: string; reason: string; constraints: string[] }

export interface ReplanEmailModel {
  tz: string;
  window: { start: string; end: string };
  trigger: Trigger;
  isEmpty: boolean;
  days: DayView[];
  dropped: DroppedView[];
  warnings: string[];   // resolve warnings (e.g. meeting attendee-availability) surfaced before accept
}

export interface BuildReplanEmailModelInput {
  diff: PlanDiff;
  titles: Record<string, string>;
  priorEvents: ScheduleEntry[];
  proposedSchedule: ScheduleEntry[];
  externalEvents: ExternalEvent[];
  window: { start: string; end: string };
  tz: string;
  trigger: Trigger;
  triggerEventIds?: string[];
  warnings?: string[];
  // Task ids of REAL owned-meeting rows (source.kind === "meeting") present in
  // this plan. Meeting-ness must key on these, never on entry.context: "meeting"
  // is also a user-selectable batching category on ordinary tasks.
  meetingTaskIds?: readonly string[];
}

const titleOf = (titles: Record<string, string>, id: string) => titles[id] ?? id;
const byStart = (a: TimelineEntry, b: TimelineEntry) => Date.parse(a.start) - Date.parse(b.start);

export function buildReplanEmailModel(input: BuildReplanEmailModelInput): ReplanEmailModel {
  const { diff, titles, priorEvents, proposedSchedule, externalEvents, window, tz, trigger } = input;
  const triggerIds = new Set(input.triggerEventIds ?? []);

  const movedChunks = new Set(diff.moved.map((m) => m.chunk_id));
  const removedChunks = new Set(diff.removed.map((r) => r.chunk_id));
  const addedChunks = new Set(diff.added.map((a) => a.chunk_id));
  const movedFromStart = new Map(diff.moved.map((m) => [m.chunk_id, m.from.start]));

  // Meeting-ness keys on the caller-supplied meetingTaskIds (real owned-meeting
  // rows, source.kind === "meeting") and applies to BOTH the before (moved-from)
  // and after (moved-to) sides so a moved meeting reads as a meeting on both
  // columns. Deliberately NOT keyed on entry.context === "meeting": that is also
  // a user-selectable batching category on ordinary tasks (ContextEnum), so a
  // plain task filed under "meeting" must not pick up the Meeting chip.
  const meetingTaskIds = new Set(input.meetingTaskIds ?? []);
  const isMeetingTask = (taskId: string): boolean => meetingTaskIds.has(taskId);

  const externalRole = (id: string): EntryRole => (triggerIds.has(id) ? "new-clash" : "existing");
  const externalEntries: TimelineEntry[] = externalEvents.map((e): TimelineEntry => ({
    title: e.title, start: e.start, end: e.end, role: externalRole(e.id),
  }));

  const beforeScheduler: TimelineEntry[] = priorEvents.map((e): TimelineEntry => ({
    title: titleOf(titles, e.task_id), start: e.start, end: e.end,
    role: movedChunks.has(e.chunk_id) ? "moved-from" : removedChunks.has(e.chunk_id) ? "removed" : "existing",
    ...(isMeetingTask(e.task_id) ? { isMeeting: true } : {}),
  }));
  const afterScheduler: TimelineEntry[] = proposedSchedule.map((e): TimelineEntry => {
    const meetingFlag = isMeetingTask(e.task_id) ? { isMeeting: true } : {};
    if (movedChunks.has(e.chunk_id)) {
      return { title: titleOf(titles, e.task_id), start: e.start, end: e.end, role: "moved-to", movedFrom: movedFromStart.get(e.chunk_id), ...meetingFlag };
    }
    return { title: titleOf(titles, e.task_id), start: e.start, end: e.end, role: addedChunks.has(e.chunk_id) ? "added" : "existing", ...meetingFlag };
  });

  const before = [...beforeScheduler, ...externalEntries];
  const after = [...afterScheduler, ...externalEntries];

  // Group by local day; keep only days that contain a non-"existing" change.
  const dayKeys = new Set<string>();
  for (const e of [...before, ...after]) if (e.role !== "existing") dayKeys.add(localDayKey(e.start, tz));

  const days: DayView[] = [...dayKeys].sort().map((date) => ({
    date,
    before: before.filter((e) => localDayKey(e.start, tz) === date).sort(byStart),
    after: after.filter((e) => localDayKey(e.start, tz) === date).sort(byStart),
  }));

  const dropped: DroppedView[] = diff.dropped.map((d) => ({
    title: titles[d.task_id] ?? d.title ?? d.task_id, reason: d.reason, constraints: d.contributing_constraints,
  }));

  return { tz, window, trigger, isEmpty: diff.isEmpty, days, dropped, warnings: input.warnings ?? [] };
}
