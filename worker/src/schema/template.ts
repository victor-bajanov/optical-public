import { z } from "zod";
import { ContextEnum, IsoDate, TimeOfDay } from "./common";
import { D } from "./descriptions";

// Minimal RRULE validation: must contain FREQ=.
const RRule = z.string().regex(/(^|;)FREQ=/, "rrule must contain FREQ=");

const TaskBodyPartial = z.record(z.unknown()); // partial Task spec; validated when materialised (Plan C).

// IANA zone validator — probes Intl.DateTimeFormat which throws RangeError
// for unknown zones in the Workers runtime.
const IanaZone = z.string().refine(
  (s) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: s });
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid IANA timezone (e.g. 'Australia/Sydney', 'America/New_York')" },
);

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
