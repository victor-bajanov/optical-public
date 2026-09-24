// worker/src/middleware/require-scope.ts
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

type Vars = { scopes?: string[] };

/**
 * Scope gate. requireBearer must run first and set `scopes` from the token.
 * 403 insufficient_scope when the required scope is absent.
 */
export function requireScope(
  scope: string,
): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const scopes = (c.get("scopes") as string[] | undefined) ?? [];
    if (!scopes.includes(scope)) {
      return c.json({ error: "insufficient_scope", required: scope }, 403);
    }
    await next();
  };
}
