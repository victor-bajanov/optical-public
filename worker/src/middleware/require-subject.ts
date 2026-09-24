import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { writeAudit } from "../db/audit";

type Vars = { subject?: string; ownerSubject: string };

// Fail-closed owner gate for user-owned routes. requireBearer must run first and
// set `subject` from the token. A token that carries no identity must never read
// or write owned rows, so we reject rather than default. Downstream handlers can
// rely on `c.var.ownerSubject` being a non-empty string. A denied attempt is
// audited (Plan 4 brief G).
export const requireSubject: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const subject = c.get("subject");
  if (!subject) {
    await writeAudit(c.env.DB, { action: "denied_no_subject", source: "api" });
    return c.json({ error: "no_subject" }, 403);
  }
  c.set("ownerSubject", subject);
  await next();
};
