// worker/src/schema/task-response.ts
import { z } from "zod";
import { ContextEnum, IsoDateTime, TimeOfDay, Uuid } from "./common";
import { D } from "./descriptions";

const Chunk = z.object({ duration_minutes: z.number().int().positive().describe(D.task.chunks.duration_minutes) });
const GroupPolicy = z.object({
  same_day: z.boolean().describe(D.task.group_policy.same_day),
  ordered: z.boolean().describe(D.task.group_policy.ordered),
});
const Deadline = z.object({
  at: IsoDateTime.describe(D.task.deadline.at),
  hard: z.boolean().describe(D.task.deadline.hard),
  penalty_per_15min: z.number().nonnegative().describe(D.task.deadline.penalty_per_15min).optional(),
});
const PreferredWindow = z.object({
  days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).describe(D.task.preferred_windows.days),
  start: TimeOfDay.describe(D.task.preferred_windows.start),
  end: TimeOfDay.describe(D.task.preferred_windows.end),
  hard: z.boolean().describe(D.task.preferred_windows.hard),
});
const Dependency = z.discriminatedUnion("type", [
  z.object({ type: z.literal("after_task"), ref: Uuid.describe(D.task.dependencies.ref), hard: z.boolean().describe(D.task.dependencies.hard) }),
  z.object({ type: z.literal("before_event"), ref: z.string().describe(D.task.dependencies.ref), hard: z.boolean().describe(D.task.dependencies.hard) }),
]);
const Source = z.object({
  kind: z.enum(["mcp", "rest", "shortcut", "cron", "webhook"]).describe(D.task.source.kind),
  external_id: z.string().describe(D.task.source.external_id).nullable(),
});

const MovableVerdict = z.object({
  at: IsoDateTime.describe(D.task.movable_verdict.at),
  ok: z.boolean().describe(D.task.movable_verdict.ok),
  reason: z.string().describe(D.task.movable_verdict.reason).nullable(),
});

export const TaskResponse = z.object({
  id: Uuid.describe(D.response.id),
  status: z.enum(["pending", "scheduled", "committed", "done", "cancelled"]).describe(D.task.status),
  created_at: z.string().describe(D.response.created_at),
  updated_at: z.string().describe(D.response.updated_at),
  title: z.string().min(1).max(500).describe(D.task.title),
  context: ContextEnum.describe(D.task.context),
  priority: z.number().int().min(0).max(100).describe(D.task.priority),
  location: z.string().describe(D.task.location).nullable().optional(),
  effort_estimate_confidence: z.enum(["low", "medium", "high"]).describe(D.task.effort_estimate_confidence).optional(),
  duration_minutes: z.number().int().positive().describe(D.task.duration_minutes).optional(),
  chunks: z.array(Chunk).describe(D.task.chunks.$).optional(),
  group_policy: GroupPolicy.describe(D.task.group_policy.$).optional(),
  deadline: Deadline.describe(D.task.deadline.$).nullable().optional(),
  earliest_start: IsoDateTime.describe(D.task.earliest_start).nullable().optional(),
  preferred_windows: z.array(PreferredWindow).describe(D.task.preferred_windows.$).optional(),
  dependencies: z.array(Dependency).describe(D.task.dependencies.$).optional(),
  pinned_at: IsoDateTime.describe(D.task.pinned_at).nullable().optional(),
  template_id: Uuid.describe(D.task.template_id).nullable().optional(),
  project_id: Uuid.describe(D.task.project_id).nullable().optional(),
  source: Source.describe(D.task.source.$).optional(),
  attendee_enforcement: z
    .enum(["accepted", "accepted_or_tentative", "not_declined"])
    .describe(D.task.attendee_enforcement)
    .nullable()
    .optional(),
  movable_verdict: MovableVerdict.describe(D.task.movable_verdict.$).nullable().optional(),
});
