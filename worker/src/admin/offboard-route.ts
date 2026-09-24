import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { requireAdminSubject } from "../middleware/admin-subject";
import { requireScope } from "../middleware/require-scope";
import { offboardUser } from "../lifecycle/offboard";

// Admin-only hard offboard (Plan 4 brief D). Requires a bearer token from an
// admin subject (requireAdminSubject) with the "admin" scope (requireScope).
// The bearer token's subject is the audit actor. The caller gets NO ability to
// read the target's data — only to remove it.
export function mountOffboardRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  app.post("/admin/offboard", requireBearer, requireAdminSubject, requireScope("admin"), async (c) => {
    const body = await c.req.json<{ subject?: string }>().catch(() => ({ subject: undefined }));
    const subject = body.subject?.trim();
    if (!subject) return c.json({ error: "subject_required" }, 400);
    const actor = (c.get("subject" as never) as string | undefined) ?? "unknown";
    await offboardUser(c.env, subject, actor);
    return c.json({ ok: true, subject }, 200);
  });
}
