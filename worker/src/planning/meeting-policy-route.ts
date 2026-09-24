import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { loadMeetingPolicy } from "../db/meeting-policy";
import { D } from "../schema/descriptions";

const MeetingPolicyResponseSchema = z.object({
  attendee_enforcement: z
    .enum(["accepted", "accepted_or_tentative", "not_declined"])
    .describe(D.task.attendee_enforcement),
});

export function mountMeetingPolicyRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const route = createRoute({
    method: "get",
    path: "/meeting-policy",
    operationId: "getMeetingPolicy",
    summary: "Retrieve the caller's effective owned-meeting attendee-enforcement default.",
    description:
      "Return the account-level default for which attendees' busy times constrain an owned meeting's placement when the meeting itself does not override it. Owner-scoped: the caller's own configured value, else the instance default (not_declined).",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: { "application/json": { schema: MeetingPolicyResponseSchema } },
        description: "Effective meeting attendee-enforcement default",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No subject on token",
      },
    },
  });

  v1.openapi(route, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const attendee_enforcement = await loadMeetingPolicy(c.env.DB, owner);
    return c.json({ attendee_enforcement } as z.infer<typeof MeetingPolicyResponseSchema>);
  });
}
