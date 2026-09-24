import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { requireAdminSubject } from "../middleware/admin-subject";
import { requireScope } from "../middleware/require-scope";
import { defaultProviders } from "../index-providers";
import { runMondayResolve } from "../cron/monday-resolve";

export function mountRunCronRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  app.post("/admin/run-cron", requireBearer, requireAdminSubject, requireScope("admin"), async (c) => {
    // Single-named-subject trigger. The real Monday cron fans out over all active
    // subjects (cron/scheduled-entry.ts); this operator route runs ONE subject and
    // fails closed if none is given — never the global first active user.
    const subject = c.req.query("subject");
    if (!subject) return c.json({ error: "subject query param is required" }, 400);
    // Only build the default provider bundle when at least one of the two
    // factories below will actually need it (this route's tests override
    // both c.var.*Provider directly, skipping the D1 lookup entirely).
    const built = (!c.var.calendarProvider || !c.var.notificationProvider)
      ? await defaultProviders(c.env, subject)
      : undefined;
    const calendar = c.var.calendarProvider ?? built!.calendar;
    const notification = c.var.notificationProvider ?? built!.notification;
    const result = await runMondayResolve({
      env: c.env,
      calendar,
      notification,
      accountEmail: subject,
    });
    const status = result.kind === "ok" ? 200 : 500;
    return c.json(result, status);
  });
}
