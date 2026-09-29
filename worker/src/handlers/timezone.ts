// worker/src/handlers/timezone.ts
// Card A of internal design notes: GET/PATCH/DELETE /v1/timezone — the
// caller's effective timezone (users.home_tz, else SCHEDULER_TZ), owner-scoped.
// A write that changes the effective timezone discards the caller's pending
// plans; it never replans (the next resolve applies the new zone).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { mountOwnerGate } from "../middleware/owner-gate";
import { canonicalIanaZone, getUser, setHomeTzStmt } from "../db/users";
import { deletePendingPlansForSubjectStmt } from "../planning/proposed-plans";
import { stampPreferredWindowTzStmt } from "../db/tasks";
import { IanaZone } from "../schema/common";
import { D } from "../schema/descriptions";

const TimezoneResponse = z.object({
  tz: z.string().describe("The caller's effective IANA timezone: their own home_tz if set, else the instance default SCHEDULER_TZ."),
  source: z.enum(["user", "default"]).describe(
    "'user' if the caller has set their own timezone (even one equal to the instance default), else 'default' (inheriting SCHEDULER_TZ).",
  ),
  superseded_plans: z.number().int().describe(
    "How many of the caller's pending (uncommitted) proposed plans this call discarded. Non-zero only on a write that changed the effective timezone; always 0 on GET.",
  ),
});

const PatchTimezoneBody = z
  .object({
    tz: IanaZone.describe(
      "IANA timezone name, e.g. 'Australia/Sydney' or 'Europe/London'. Matched case-insensitively and stored in canonical spelling.",
    ),
  })
  .strict()
  .describe("The caller's new timezone. Unknown keys are rejected (400), not silently ignored.");

const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  detail: z.string().optional().describe("Human-readable detail; not machine-readable."),
});

const errs = {
  401: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing/invalid bearer" },
  403: { content: { "application/json": { schema: ErrorResponse } }, description: "Token carries no subject" },
} as const;

const noUserRow = {
  error: "no_user_row",
  detail: "the caller has no users row (sign in first); the timezone was not changed and no plans were discarded",
};
const notFound = {
  404: {
    content: { "application/json": { schema: ErrorResponse } },
    description: "no_user_row: the caller has no users row (created at sign-in). Nothing is written and no plans are discarded.",
  },
} as const;

type TimezoneState = z.infer<typeof TimezoneResponse>;

/** Canonical zone name, or null if Intl can't resolve it (e.g. a legacy
 *  operator-written value). null never compares equal, so an uncanonicalisable
 *  old zone counts as a change. */
function safeCanonical(tz: string): string | null {
  try {
    return canonicalIanaZone(tz);
  } catch {
    return null;
  }
}

type WriteOutcome = TimezoneState | "no_user_row";

/** Write home_tz (canonical zone, or null to reset). When the effective zone
 *  (home_tz ?? SCHEDULER_TZ, compared canonically) changes, the write, the
 *  pending-plan delete and the task-window tz stamp run as one D1 batch, so a failure leaves none applied
 *  and a retry sees the old zone and deletes again. A subject with no users
 *  row gets "no_user_row": a config write never creates one. */
async function writeTimezone(
  db: D1Database,
  owner: string,
  schedulerTz: string,
  newHomeTz: string | null,
): Promise<WriteOutcome> {
  const user = await getUser(db, owner);
  if (!user) return "no_user_row";
  const oldEffective = safeCanonical(user.home_tz ?? schedulerTz);
  const newEffective = safeCanonical(newHomeTz ?? schedulerTz);
  const write = setHomeTzStmt(db, owner, newHomeTz);
  let superseded_plans = 0;
  if (oldEffective === null || oldEffective !== newEffective) {
    // Card E: freeze untimezoned task windows in the zone being left, in the
    // same batch, so they never move. An uncanonicalisable old zone can't be
    // frozen (it could never be projected), so nothing is stamped then.
    const stmts = [write, deletePendingPlansForSubjectStmt(db, owner)];
    if (oldEffective !== null) stmts.push(stampPreferredWindowTzStmt(db, owner, oldEffective));
    const [, deleted, stamped] = await db.batch(stmts);
    superseded_plans = deleted?.meta?.changes ?? 0;
    if (stamped) {
      console.log(JSON.stringify({ msg: "timezone_windows_stamped", tz: oldEffective, tasks: stamped.meta?.changes ?? 0 }));
    }
  } else {
    await write.run();
  }
  return newHomeTz != null
    ? { tz: newHomeTz, source: "user", superseded_plans }
    : { tz: schedulerTz, source: "default", superseded_plans };
}

export function mountTimezoneRoutes(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  // `/timezone` has no sub-paths, so one pattern suffices. The scoped gate
  // runs auth before zod validation (no "malformed" vs "unauthorised" leak).
  mountOwnerGate(v1, "/timezone");

  const get = createRoute({
    method: "get",
    path: "/timezone",
    operationId: "getTimezone",
    tags: ["config"],
    summary: "The caller's effective timezone.",
    description: D.timezoneConfig.getTimezone,
    security: [{ BearerAuth: [] }],
    responses: {
      200: { content: { "application/json": { schema: TimezoneResponse } }, description: "Effective timezone" },
      ...errs,
    },
  });
  v1.openapi(get, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const user = await getUser(c.env.DB, owner);
    // `!= null`, matching getHomeTz's `??`.
    const body: TimezoneState = user?.home_tz != null
      ? { tz: user.home_tz, source: "user", superseded_plans: 0 }
      : { tz: c.env.SCHEDULER_TZ, source: "default", superseded_plans: 0 };
    return c.json(body, 200);
  });

  const patch = createRoute({
    method: "patch",
    path: "/timezone",
    operationId: "setTimezone",
    tags: ["config"],
    summary: "Set the caller's timezone.",
    description: D.timezoneConfig.setTimezone,
    security: [{ BearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: PatchTimezoneBody } } } },
    responses: {
      200: { content: { "application/json": { schema: TimezoneResponse } }, description: "New effective timezone." },
      400: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "validation_failed: tz missing or not a known IANA zone, or an unknown key.",
      },
      ...notFound,
      ...errs,
    },
  });
  v1.openapi(patch, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const { tz } = c.req.valid("json");
    const result = await writeTimezone(c.env.DB, owner, c.env.SCHEDULER_TZ, canonicalIanaZone(tz));
    if (result === "no_user_row") return c.json(noUserRow, 404) as any;
    return c.json(result, 200);
  });

  const del = createRoute({
    method: "delete",
    path: "/timezone",
    operationId: "resetTimezone",
    tags: ["config"],
    summary: "Reset the caller's timezone to the instance default.",
    description: D.timezoneConfig.resetTimezone,
    security: [{ BearerAuth: [] }],
    responses: {
      200: { content: { "application/json": { schema: TimezoneResponse } }, description: "Default timezone." },
      ...notFound,
      ...errs,
    },
  });
  v1.openapi(del, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const result = await writeTimezone(c.env.DB, owner, c.env.SCHEDULER_TZ, null);
    if (result === "no_user_row") return c.json(noUserRow, 404) as any;
    return c.json(result, 200);
  });
}
