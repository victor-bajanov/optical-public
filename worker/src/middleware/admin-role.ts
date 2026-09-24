import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { getUser } from "../db/users";

type Vars = { accessEmail?: string };

// Role gate for INSTANCE-CONFIG admin routes (Plan 4 brief C). Must run AFTER
// requireAccess, which sets accessEmail from the Cloudflare Access JWT. Admin
// status comes from the canonical users table, NOT from OPERATOR_EMAIL.
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const email = c.get("accessEmail");
  if (!email) return c.json({ error: "forbidden_not_admin" }, 403);
  const user = await getUser(c.env.DB, email);
  if (!user || user.is_active !== 1 || user.role !== "admin") {
    return c.json({ error: "forbidden_not_admin" }, 403);
  }
  await next();
};
