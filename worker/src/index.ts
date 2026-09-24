import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { runSubsolve } from "./engine/fanout";
import type { SubsolveRequest, SubsolveResult } from "./engine/types";
import { oauthProviderApp, handleAuthCallback } from "./auth/oauth-provider";
import {
  defaultCalendarProvider,
  defaultNotificationProvider,
  type AppVariables,
} from "./index-providers";
import { v1 } from "./v1";
import { mountRunCronRoute } from "./admin/run-cron-route";
import { mountOffboardRoute } from "./admin/offboard-route";
import { mountDevUiRoute } from "./admin/dev-ui-route";
import { mountStopChannelRoute } from "./admin/stop-channel-route";
import { mountRenewSubscriptionsRoute } from "./admin/renew-subscriptions-route";
import { mountCalendarFeedRoute } from "./calendar-feed/feed-route";
import { mountCalendarRevealRoute } from "./calendar-feed/reveal-route";
import { mountBookingRoutes } from "./booking/route";
import { mountPollRoutes } from "./polls/route";
import { dispatchScheduled } from "./cron/scheduled-entry";

export {
  defaultCalendarProvider,
  defaultNotificationProvider,
  type AppVariables,
} from "./index-providers";

export { ResolveCoordinator } from "./durable-objects/resolve-coordinator";

/** Card E (internal design notes §E) — the fan-out leaf.
 *
 * Bound to this same Worker as `ENGINE_RPC` (see wrangler.toml). What the
 * platform documents is that each invocation gets its own CPU budget, and that
 * is the concrete win: a neighbourhood re-solve stops spending the master
 * resolve's CPU, and a master round costs the slowest leaf rather than the sum.
 *
 * The stronger claim in the spec — a separate isolate, hence a separate
 * 128 MiB — is a HYPOTHESIS here, not a guarantee. Isolate placement for
 * same-worker RPC is undocumented, and co-location in the calling isolate is
 * likely, which would leave memory a shared pie after all. Card H's dev smoke
 * measures `engine_fanout` `wall_ms` against `subsolves` before anything is
 * promoted past dark; until then, assume only the CPU-budget win.
 *
 * There is no state here on purpose. The request carries the whole problem
 * and baking is deterministic, so a leaf needs nothing warmed across calls;
 * the DO-per-(person, week) shape the spec sketches is for the multi-person
 * decomposition, not for this single-person escape hatch. */
export class EngineRpc extends WorkerEntrypoint<Env> {
  async subsolve(request: SubsolveRequest): Promise<SubsolveResult> {
    return runSubsolve(request);
  }
}

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get("/", (c) => c.json({ name: "weekly-scheduling-assistant", version: "0.1.0" }));

app.route("/oauth", oauthProviderApp);
app.get("/auth/callback", handleAuthCallback);

mountRunCronRoute(app);
mountOffboardRoute(app);
mountDevUiRoute(app);
mountStopChannelRoute(app);
mountRenewSubscriptionsRoute(app);
mountCalendarFeedRoute(app);
mountCalendarRevealRoute(app);
mountBookingRoutes(app);
mountPollRoutes(app);

app.route("/v1", v1);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return dispatchScheduled(event, env, ctx);
  },
} satisfies ExportedHandler<Env>;
