import { z } from "zod";
import { ContextEnum, IsoDateTime, TimeOfDay, Uuid } from "./common";
import { D } from "./descriptions";

const Chunk = z
  .object({ duration_minutes: z.number().int().positive().describe(D.task.chunks.duration_minutes) })
  .strict();

const GroupPolicy = z
  .object({
    same_day: z.boolean().describe(D.task.group_policy.same_day),
    ordered: z.boolean().describe(D.task.group_policy.ordered),
  })
  .strict();

const Deadline = z
  .object({
    at: IsoDateTime.describe(D.task.deadline.at),
    hard: z.boolean().describe(D.task.deadline.hard),
    penalty_per_15min: z.number().nonnegative().describe(D.task.deadline.penalty_per_15min).optional(),
  })
  .strict();

const PreferredWindow = z
  .object({
    days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(1).describe(D.task.preferred_windows.days),
    start: TimeOfDay.describe(D.task.preferred_windows.start),
    end: TimeOfDay.describe(D.task.preferred_windows.end),
    hard: z.boolean().describe(D.task.preferred_windows.hard),
  })
  .strict();

const Dependency = z.discriminatedUnion("type", [
  z.object({ type: z.literal("after_task"), ref: Uuid.describe(D.task.dependencies.ref), hard: z.boolean().describe(D.task.dependencies.hard) }).strict(),
  z.object({ type: z.literal("before_event"), ref: z.string().min(1).describe(D.task.dependencies.ref), hard: z.boolean().describe(D.task.dependencies.hard) }).strict(),
]);

const Source = z
  .object({
    kind: z.enum(["mcp", "rest", "shortcut", "cron", "webhook", "meeting"]).describe(D.task.source.kind),
    external_id: z.string().describe(D.task.source.external_id).nullable(),
  })
  .strict();

// System-maintained (see src/meetings/movable-verdict.ts). Declared here because
// PATCH re-parses the STORED body against this strict schema, so an undeclared
// field the planner writes would 400 every patch of a meeting task. `reason` is
// a plain string, not an enum: a resolve that learns a new freeze reason must
// never turn into a 400 on an unrelated PATCH.
const MovableVerdict = z
  .object({
    at: IsoDateTime.describe(D.task.movable_verdict.at),
    ok: z.boolean().describe(D.task.movable_verdict.ok),
    reason: z.string().describe(D.task.movable_verdict.reason).nullable(),
  })
  .strict();

const StatusEnum = z.enum(["pending", "scheduled", "committed", "done", "cancelled"]);

const TaskBase = z.object({
  title: z.string().min(1).max(500).describe(D.task.title),
  context: ContextEnum.describe(D.task.context),
  priority: z.number().int().min(0).max(100).describe(D.task.priority),
  location: z.string().describe(D.task.location).nullable().optional(),
  effort_estimate_confidence: z.enum(["low", "medium", "high"]).describe(D.task.effort_estimate_confidence).optional(),

  duration_minutes: z.number().int().positive().describe(D.task.duration_minutes).optional(),
  chunks: z.array(Chunk).min(2).describe(D.task.chunks.$).optional(),
  group_policy: GroupPolicy.describe(D.task.group_policy.$).optional(),

  deadline: Deadline.describe(D.task.deadline.$).nullable().optional(),
  earliest_start: IsoDateTime.describe(D.task.earliest_start).nullable().optional(),
  preferred_windows: z.array(PreferredWindow).describe(D.task.preferred_windows.$).optional(),
  dependencies: z.array(Dependency).describe(D.task.dependencies.$).optional(),

  pinned_at: IsoDateTime.describe(D.task.pinned_at).nullable().optional(),
  must_include: z.boolean().describe(D.task.must_include).default(false),
  template_id: Uuid.describe(D.task.template_id).nullable().optional(),
  project_id: Uuid.describe(D.task.project_id).nullable().optional(),

  source: Source.describe(D.task.source.$).optional(),
  status: StatusEnum.describe(D.task.status).optional(),

  attendee_enforcement: z
    .enum(["accepted", "accepted_or_tentative", "not_declined"])
    .describe(D.task.attendee_enforcement)
    .nullable()
    .optional(),

  movable_verdict: MovableVerdict.describe(D.task.movable_verdict.$).nullable().optional(),
}).strict();

// Cross-field invariants from §3.1:
//  - exactly one of {duration_minutes, chunks}
//  - group_policy iff chunks
export const TaskCreate = TaskBase.superRefine((v, ctx) => {
  const hasDur = v.duration_minutes !== undefined;
  const hasChunks = v.chunks !== undefined;
  if (hasDur === hasChunks) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of duration_minutes or chunks required" });
  }
  if (hasChunks && v.group_policy === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "group_policy required when chunks present" });
  }
  if (!hasChunks && v.group_policy !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "group_policy not allowed without chunks" });
  }
});

export type TaskCreateT = z.infer<typeof TaskCreate>;

// PATCH: all fields optional, strict, but if chunks/duration/group_policy touched the same invariant applies post-merge.
// The merge happens in the handler; here we just enforce shape per-field.
export const TaskPatch = TaskBase.partial();
export type TaskPatchT = z.infer<typeof TaskPatch>;

export const TaskStatus = StatusEnum;
