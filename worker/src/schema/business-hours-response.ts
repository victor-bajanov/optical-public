import { z } from "@hono/zod-openapi";
import { D } from "./descriptions";

export const BusinessHoursResponseSchema = z.object({
  business_hours: z
    .object({
      days: z
        .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
        .openapi({ description: D.businessHours.days }),
      start: z.string().openapi({ description: D.common.timeOfDay }),
      end: z.string().openapi({ description: D.common.timeOfDay }),
    })
    .nullable()
    .openapi({ description: D.businessHours.$ }),
});
