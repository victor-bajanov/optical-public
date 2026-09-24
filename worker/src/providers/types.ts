import { z } from "zod";

export const CalendarEventSchema = z.object({
  id: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().optional(),
  description: z.string().optional(),
  colorId: z.string().optional(),
  // Free/busy metadata threaded from the provider so build-problem.ts can apply
  // free/busy rules (cancelled/tentative/all-day-OOO) at the single busy-
  // computation site. All optional + additive: events that omit them parse and
  // are treated as confirmed, timed, opaque busy events (the historical default).
  status: z.string().optional(),
  eventType: z.string().optional(),
  isAllDay: z.boolean().optional(),
  // Ownership + attendees, surfaced for owned-movable-meeting detection. All
  // optional + additive: events that omit them parse exactly as before.
  organizer: z
    .object({ email: z.string().optional(), self: z.boolean().optional() })
    .optional(),
  guestsCanModify: z.boolean().optional(),
  attendees: z
    .array(
      z.object({
        email: z.string(),
        responseStatus: z
          .enum(["needsAction", "declined", "tentative", "accepted"])
          .optional(),
        optional: z.boolean().optional(),
        resource: z.boolean().optional(), // room/equipment — excluded from people count
        self: z.boolean().optional(),
      }),
    )
    .optional(),
  extendedProperties: z
    .object({
      private: z.record(z.string()).optional(),
      shared: z.record(z.string()).optional(),
    })
    .default({}),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const ChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), event: CalendarEventSchema }),
  z.object({ kind: z.literal("delete"), eventId: z.string() }),
]);
export type Change = z.infer<typeof ChangeSchema>;

export const IncrementalResultSchema = z.object({
  changes: z.array(ChangeSchema),
  nextSyncToken: z.string(),
  syncTokenInvalidated: z.boolean(),
});
export type IncrementalResult = z.infer<typeof IncrementalResultSchema>;

export interface Subscription {
  channelId: string;
  channelToken: string;
  resourceId: string;
  expiresAt: string;
}

export const SCHEDULER_CHUNK_ID_KEY = "scheduler_chunk_id";

// Private extended-property key stamped on an imported owned-meeting event so a
// re-sync recognises it as already imported and recovers the owning task row id.
// Mirrors SCHEDULER_CHUNK_ID_KEY (used for scheduler-created chunk events).
export const OPTICAL_MEETING_TASK_ID_KEY = "optical_meeting_task_id";
