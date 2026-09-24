// worker/src/schema/resolve-response.ts
import { z } from "zod";
import { D } from "./descriptions";

const ScheduleEntry = z.object({
  task_id: z.string().uuid().describe(D.response.schedule.task_id),
  chunk_id: z.string().describe(D.response.schedule.chunk_id),
  start: z.string().describe(D.response.schedule.start),
  end: z.string().describe(D.response.schedule.end),
  context: z.string().describe(D.response.schedule.context),
});

const DroppedEntry = z.object({
  task_id: z.string().uuid().describe(D.response.dropped.task_id),
  title: z.string().describe(D.response.dropped.title),
  drop_cost: z.number().describe(D.response.dropped.drop_cost),
  reason: z.string().describe(D.response.dropped.reason),
  contributing_constraints: z.array(z.string()).describe(D.response.dropped.contributing_constraints),
});

export const ResolveResponse = z.object({
  plan_hash: z.string().describe(D.response.plan_hash),
  schedule: z.array(ScheduleEntry).describe(D.response.schedule.$),
  dropped: z.array(DroppedEntry).describe(D.response.dropped.$),
  window: z.object({
    start: z.string().describe(D.response.window.start),
    end: z.string().describe(D.response.window.end),
  }).describe(D.response.window.$),
  warnings: z.array(z.string()).optional().describe(D.response.warnings),
});
