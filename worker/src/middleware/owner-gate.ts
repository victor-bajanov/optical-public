// worker/src/middleware/owner-gate.ts
import type { Context } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "./auth-bearer";
import { requireSubject } from "./require-subject";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Owner gate for bearer-authenticated /v1 routes. Runs requireBearer then
 * requireSubject and returns the resolved ownerSubject, or a Response to
 * short-circuit (401 missing/invalid bearer; 403 no_subject, which also writes
 * the denied_no_subject audit row). Quarantines the `as any` casts the
 * OpenAPIHono v0.19.10 typing issue forces when invoking middleware inline.
 *
 * Usage:
 *   const owner = await requireOwner(c);
 *   if (owner instanceof Response) return owner;
 *   // owner: ownerSubject string
 */
export async function requireOwner(c: Ctx): Promise<string | Response> {
  const bearer = await requireBearer(c as any, async () => undefined as any);
  if (bearer) return bearer as unknown as Response;
  const subject = await requireSubject(c as any, async () => undefined as any);
  if (subject) return subject as unknown as Response;
  return c.var.ownerSubject!;
}

/**
 * Registers requireOwner as scoped middleware on the given path patterns so
 * auth runs BEFORE @hono/zod-openapi's built-in param/body validators —
 * otherwise an unauthenticated request with a malformed body or path param
 * gets a 400 instead of the 401/403 it should, letting the caller
 * distinguish "malformed" from "not allowed to be here at all". Handlers
 * behind the gate read `c.var.ownerSubject!`. One shared implementation of
 * the `gate` closure previously copy-pasted per handler file.
 */
export function mountOwnerGate(
  v1: { use: (path: string, mw: (c: Ctx, next: () => Promise<void>) => Promise<Response | void>) => unknown },
  ...paths: string[]
) {
  const gate = async (c: Ctx, next: () => Promise<void>) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    await next();
    return;
  };
  for (const path of paths) v1.use(path, gate);
}
