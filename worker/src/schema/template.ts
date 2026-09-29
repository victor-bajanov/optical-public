import { z } from "zod";
import { ContextEnum, IanaZone, IsoDate, TimeOfDay } from "./common";
import { D } from "./descriptions";
import { PreferredWindow } from "./task";

// Minimal RRULE validation: must contain FREQ=.
const RRule = z.string().regex(/(^|;)FREQ=/, "rrule must contain FREQ=");

// Partial Task spec; validated in full when materialised (Plan C), where a
// failure only skips the occurrence with a console.warn. preferred_windows is
// validated here too, so a bad window (e.g. an unknown or offset tz) is a 400
// at write time instead of a template that silently never materialises.
const TaskBodyPartial = z
  .object({ preferred_windows: z.array(PreferredWindow).describe(D.task.preferred_windows.$).optional() })
  .passthrough();

export const TemplateCreate = z.object({
  title: z.string().min(1).max(500).describe(D.template.title),
  context: ContextEnum.describe(D.template.context),
  rrule: RRule.describe(D.template.rrule),
  pinned_time: TimeOfDay.describe(D.template.pinned_time).nullable().optional(),
  pinned_tz: IanaZone.describe(D.template.pinned_tz).nullable().optional(),
  duration_minutes: z.number().int().positive().describe(D.template.duration_minutes),
  task_body: TaskBodyPartial.describe(D.template.task_body).optional(),
  active_from: IsoDate.describe(D.template.active_from),
  active_until: IsoDate.describe(D.template.active_until).nullable().optional(),
}).strict();

export type TemplateCreateT = z.infer<typeof TemplateCreate>;

export const TemplatePatch = TemplateCreate.partial();
