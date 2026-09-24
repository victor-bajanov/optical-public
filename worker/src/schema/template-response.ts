// worker/src/schema/template-response.ts
import { z } from "zod";
import { ContextEnum, IsoDate, TimeOfDay } from "./common";
import { D } from "./descriptions";

export const TemplateResponse = z.object({
  id: z.string().uuid().describe(D.response.id),
  created_at: z.string().describe(D.response.created_at),
  title: z.string().min(1).max(500).describe(D.template.title),
  context: ContextEnum.describe(D.template.context),
  rrule: z.string().describe(D.template.rrule),
  pinned_time: TimeOfDay.describe(D.template.pinned_time).nullable().optional(),
  pinned_tz: z.string().describe(D.template.pinned_tz).nullable().optional(),
  duration_minutes: z.number().int().positive().describe(D.template.duration_minutes),
  task_body: z.record(z.unknown()).describe(D.template.task_body).optional(),
  active_from: IsoDate.describe(D.template.active_from),
  active_until: IsoDate.describe(D.template.active_until).nullable().optional(),
});
