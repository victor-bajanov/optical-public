// worker/src/middleware/admin-subject.ts
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { getUser } from "../db/users";

type Vars = { subject?: string };

/**
 * Bearer-based admin gate (the requireAccess/accessEmail variant is
 * admin-role.ts, retained only for /admin/dev-ui). requireBearer must run first
 * and set `subject` from the token. Admin status comes from the users table.
 */
export const requireAdminSubject: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const subject = c.get("subject");
  if (!subject) return c.json({ error: "forbidden_not_admin" }, 403);
  const user = await getUser(c.env.DB, subject);
  if (!user || user.is_active !== 1 || user.role !== "admin") {
    return c.json({ error: "forbidden_not_admin" }, 403);
  }
  await next();
};
