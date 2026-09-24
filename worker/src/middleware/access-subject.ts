// worker/src/middleware/access-subject.ts
import type { Context } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import type { AccessPayload } from "./auth-access";

// requireAccess (chained as middleware before requireCaller) narrows the handler
// context to also carry the CF-Access vars, so Ctx must include them.
type AccessVars = { accessEmail: string; accessPayload: AccessPayload };
type Ctx = Context<{ Bindings: Env; Variables: AppVariables & AccessVars }>;

/**
 * Caller gate for CF-Access admin routes. requireAccess must run first and set
 * `accessEmail`. Returns the caller's OWN email (its subject), or a 401 Response
 * when the verified JWT carries no email. Fail closed — never fall back to a
 * global "active subject" (the resolveActiveSubject cross-tenant bug this fixes).
 */
export function requireCaller(c: Ctx): string | Response {
  const email = (c.get("accessEmail") as string | undefined) ?? "";
  if (!email) return c.json({ error: "no_caller" }, 401);
  return email;
}
