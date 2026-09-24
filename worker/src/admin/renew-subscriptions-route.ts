import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { requireAdminSubject } from "../middleware/admin-subject";
import { requireScope } from "../middleware/require-scope";
import { runRenewSubscriptions } from "../cron/renew-subscriptions";

export function mountRenewSubscriptionsRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  // Manual trigger for the daily channel-renewal sweep (cron/renew-subscriptions).
  // Fans out over every calendar_sync owner with a channel — unlike the
  // caller-scoped /admin/webhook/subscribe, which needs a token per owner.
  // Needed in dev, where crons are disabled and channels otherwise lapse.
  app.post("/admin/renew-subscriptions", requireBearer, requireAdminSubject, requireScope("admin"), async (c) => {
    const injected = c.var.calendarProvider;
    const result = await runRenewSubscriptions(
      c.env,
      new Date(),
      injected ? () => injected : undefined,
    );
    return c.json({ ok: result.failed === 0, ...result }, result.failed === 0 ? 200 : 500);
  });
}
