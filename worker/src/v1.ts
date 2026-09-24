import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "./env";
import { requireBearer } from "./middleware/auth-bearer";
import { requireSubject } from "./middleware/require-subject";
import { tasksApp } from "./handlers/tasks";
import { templatesApp } from "./handlers/templates";
import { projectsApp } from "./handlers/projects";
import type { AppVariables } from "./index-providers";
import { mountResolveRoute } from "./planning/resolve";
import { mountPlansRoutes } from "./handlers/plans";
import { mountCommitRoute } from "./planning/commit";
import { mountScheduleRoute } from "./planning/schedule";
import { mountAcceptRoute } from "./planning/accept";
import { mountGoogleCalendarWebhookRoute } from "./webhooks/google-calendar";
import { mountMicrosoftCalendarWebhookRoute } from "./webhooks/microsoft-calendar";
import { mountBusinessHoursRoute } from "./planning/business-hours-route";
import { mountMeetingPolicyRoute } from "./planning/meeting-policy-route";
import { mountCalendarFeedsRoutes } from "./handlers/calendar-feeds";
import { mountBookingPageRoutes } from "./handlers/booking-page";
import { mountMeetingPollRoutes } from "./handlers/polls";
import { mountWhoamiRoute } from "./handlers/whoami";
import { mountLatestPlanRoute } from "./handlers/latest-plan";
import { mountReplanNowRoute } from "./handlers/replan-now";
import { mountSubscribeRoute } from "./handlers/subscribe";
import { mountContextsRoute } from "./handlers/contexts";
import { mountWeightsRoutes } from "./handlers/weights";
import { mountCalendarAccessTokenRoute } from "./handlers/calendar-access-token";

export const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_failed", issues: result.error.issues }, 400);
    }
  },
});

v1.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
});

// Sub-apps (tasks/templates/projects) were migrated to OpenAPIHono in Tasks
// 3-5 but did NOT add inline `requireBearer` per-route (the v0.19.10 typing
// issue prevented the planned `middleware: [requireBearer]` approach). The
// previous `v1.use("*", requireBearer)` in the old index.ts is removed in
// favor of inline bearer in the mount* routes (plans/resolve/commit/schedule).
// To preserve bearer auth on these sub-apps, scope it to their paths:
v1.use("/tasks/*", requireBearer);
v1.use("/tasks/*", requireSubject);
v1.use("/templates/*", requireBearer);
v1.use("/templates/*", requireSubject);
v1.use("/projects/*", requireBearer);
v1.use("/projects/*", requireSubject);

v1.route("/tasks", tasksApp);
v1.route("/templates", templatesApp);
v1.route("/projects", projectsApp);
// mountLatestPlanRoute registers the static GET /plans/latest; it MUST precede
// mountPlansRoutes (which registers GET /plans/{plan_hash}). OpenAPIHono route
// matching is registration-order sensitive, not static-priority — register the
// param route first and "latest" is captured as a plan_hash → 404.
mountLatestPlanRoute(v1);
mountPlansRoutes(v1);
mountResolveRoute(v1);
mountCommitRoute(v1);
mountScheduleRoute(v1);
mountBusinessHoursRoute(v1);
mountMeetingPolicyRoute(v1);
mountAcceptRoute(v1);
mountCalendarFeedsRoutes(v1);
mountBookingPageRoutes(v1);
mountWhoamiRoute(v1);
mountReplanNowRoute(v1);
mountSubscribeRoute(v1);
mountContextsRoute(v1);
mountWeightsRoutes(v1);
mountCalendarAccessTokenRoute(v1);
mountMeetingPollRoutes(v1);
mountGoogleCalendarWebhookRoute(v1, {});
mountMicrosoftCalendarWebhookRoute(v1, {});
