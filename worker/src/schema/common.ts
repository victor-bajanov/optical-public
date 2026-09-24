import { z } from "zod";
import { D } from "./descriptions";

export const ContextEnum = z.enum(["deep", "admin", "physical", "family", "meeting"]);
export type Context = z.infer<typeof ContextEnum>;

/** `HH:MM` on a real clock, zero-padded so lexicographic compare is
 *  chronological. Shared by booking-page hours and context fit curves —
 *  one definition so accepted formats can't drift between them. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// "YYYY-MM-DDTHH:MM" (local, no tz) or full ISO 8601 datetime.
export const IsoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, "expected ISO datetime")
  .describe(D.common.isoDateTime);

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").describe(D.common.isoDate);
export const TimeOfDay = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM").describe(D.common.timeOfDay);
export const Uuid = z.string().uuid().describe(D.common.uuid);
