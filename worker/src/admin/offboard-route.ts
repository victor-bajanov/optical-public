import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { requireAdminSubject } from "../middleware/admin-subject";
import { requireScope } from "../middleware/require-scope";
import { offboardUser } from "../lifecycle/offboard";

export type SubjectResolution =
  | { kind: "found"; subject: string }
  | { kind: "unknown" }
  | { kind: "ambiguous" };

// Resolve an operator-typed subject to the STORED one (O14 #2). Every
// per-user delete binds the subject byte-for-byte, so offboarding a raw
// "Alice@Corp.com" against a stored "alice@corp.com" would delete nothing yet
// still deactivate/audit a phantom. Candidates are every users row plus every
// identity_tokens row (a legacy subject may have no users row) matching
// case-insensitively. NOCASE rather than lower-casing the input keeps legacy
// mixed-case subjects reachable. An exact match wins; otherwise exactly one
// candidate is the target; none is unknown; several is ambiguous.
export async function resolveOffboardSubject(db: D1Database, input: string): Promise<SubjectResolution> {
  const r = await db
    .prepare(
      `SELECT subject AS s FROM users WHERE subject = ?1 COLLATE NOCASE
       UNION
       SELECT account_email AS s FROM identity_tokens WHERE account_email = ?1 COLLATE NOCASE`,
    )
    .bind(input)
    .all<{ s: string }>();
  // De-duplicate byte-exactly: a users row and its identity_tokens row are
  // one subject, while case variants are distinct stored subjects.
  const matches = [...new Set((r.results ?? []).map((row) => row.s))];
  if (matches.includes(input)) return { kind: "found", subject: input };
  if (matches.length === 1) return { kind: "found", subject: matches[0]! };
  return matches.length === 0 ? { kind: "unknown" } : { kind: "ambiguous" };
}

// Admin-only hard offboard (Plan 4 brief D). Requires a bearer token from an
// admin subject (requireAdminSubject) with the "admin" scope (requireScope).
// The bearer token's subject is the audit actor. The caller gets NO ability to
// read the target's data — only to remove it. The body's subject is resolved
// to the stored one first (resolveOffboardSubject): 404 unknown_subject and
// 409 ambiguous_subject offboard nothing and write no audit row. The response
// echoes the stored subject that was offboarded.
export function mountOffboardRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  app.post("/admin/offboard", requireBearer, requireAdminSubject, requireScope("admin"), async (c) => {
    const body = await c.req.json<{ subject?: string }>().catch(() => ({ subject: undefined }));
    const input = body.subject?.trim();
    if (!input) return c.json({ error: "subject_required" }, 400);
    const target = await resolveOffboardSubject(c.env.DB, input);
    if (target.kind === "unknown") return c.json({ error: "unknown_subject" }, 404);
    if (target.kind === "ambiguous") return c.json({ error: "ambiguous_subject" }, 409);
    const actor = (c.get("subject" as never) as string | undefined) ?? "unknown";
    await offboardUser(c.env, target.subject, actor);
    return c.json({ ok: true, subject: target.subject }, 200);
  });
}
