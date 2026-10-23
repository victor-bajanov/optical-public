// worker/src/schema/render-snapshot.ts
// API shape of a plan's render snapshot (diff/email-model.ts ReplanEmailModel)
// as returned by getLatestProposedPlan.render_snapshot and replanNow.model —
// always AFTER diff/redact-snapshot.ts has replaced others' event titles.
import { z } from "@hono/zod-openapi";
import { untrusted } from "./untrusted";

const TimelineEntry = z.object({
  title: untrusted(z.string().describe(
    "Entry title. \"Busy\" for a calendar event someone else organises (redacted, never the invite's real title). Otherwise the user's own task or event title — which can still hold third-party text, e.g. a booking-page event named after the booker.",
  )),
  start: z.string().describe("Entry start (ISO 8601, UTC)."),
  end: z.string().describe("Entry end (ISO 8601, UTC)."),
  role: z.enum(["moved-from", "moved-to", "added", "removed", "existing", "new-clash"]).describe(
    "What the plan does to this entry. new-clash marks the calendar change that triggered the replan.",
  ),
  movedFrom: z.string().optional().describe("Previous start (ISO 8601, UTC); only on moved-to entries."),
  isMeeting: z.boolean().optional().describe("True when the entry is an owned meeting Optical may move."),
  origin: z.enum(["task", "own_event", "others_event"]).optional().describe(
    "Where the title came from: task = an Optical-scheduled task chunk; own_event = a calendar event the user organises; others_event = one someone else organises (its title is redacted to \"Busy\"). Absent on older snapshots, whose non-task titles are redacted too.",
  ),
}).describe("One timeline entry.");

const Trigger = z.union([
  z.literal("monday-cron").describe("The weekly Monday resolve produced this plan."),
  z.literal("api").describe("An agent-confirm client (AGENT_CONFIRM_CLIENT_IDS) resolved this plan; the user is emailed it to accept when that client commits it."),
  z.object({
    kind: z.literal("webhook").describe("A calendar change (or a manual replan) produced this plan."),
    inviteTitle: untrusted(z.string().describe(
      "Title of the calendar change that triggered the replan; \"Busy\" unless the user organises that event or supplied the title themselves.",
    )),
    inviteOrganizedBySelf: z.boolean().optional().describe("Whether inviteTitle is the user's own text. Absent on older snapshots (treated as false)."),
  }),
]).describe("What triggered the replan.");

export const RenderSnapshotSchema = z.object({
  tz: z.string().describe("IANA timezone the days are bucketed in."),
  window: z.object({
    start: z.string().describe("Inclusive window start (ISO 8601)."),
    end: z.string().describe("Exclusive window end (ISO 8601)."),
  }).describe("Scheduling window the plan covers."),
  trigger: Trigger,
  isEmpty: z.boolean().describe("True when the plan changes nothing."),
  days: z.array(z.object({
    date: z.string().describe("Local date, YYYY-MM-DD."),
    before: z.array(TimelineEntry).describe("The day as it is now."),
    after: z.array(TimelineEntry).describe("The day if the plan is accepted."),
  }).describe("One local day with at least one change.")).describe("Days the plan changes, in date order."),
  dropped: z.array(z.object({
    title: untrusted(z.string().describe("Title of the dropped task. Task titles can carry third-party text (e.g. a booking-page event named after the booker).")),
    reason: z.string().describe("Why the solver dropped it."),
    constraints: z.array(z.string()).describe("Constraints that contributed to the drop."),
  }).describe("One dropped task.")).describe("Tasks the plan does not place."),
  warnings: untrusted(z.array(z.string()).optional().describe("Resolve warnings as '<meeting title>: <code>' strings. Absent on older snapshots.")),
}).describe(
  "Cached render of the plan's diff. Titles of calendar events the user does not organise are replaced with \"Busy\"; the user's own email and accept page show the real titles.",
);

export type RenderSnapshot = z.infer<typeof RenderSnapshotSchema>;
