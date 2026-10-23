// O9.1 confirm routes, mounted on the root app and kept out of the OpenAPI
// spec (like the accept page), so the codemode proxy can't reach them:
//
//   GET  /confirm/{id}?t=…  review page with a Confirm form. Read-only: mail
//                           link scanners prefetch emailed GET links.
//   POST /confirm/{id}      the human's confirmation. Refuses any request
//                           carrying Authorization, consumes the row with a
//                           CAS, then replays the op through the registry.
import type { Hono, Context } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { verifyCapabilityWithEnv } from "../auth/capability";
import { blankExpiredPendingAction, consumePendingAction, getPendingAction, type PendingActionRow } from "../db/pending-actions";
import { isForeignFetchSite } from "./gate";
import { isActiveMember } from "../auth/membership";
import { getUser } from "../db/users";
import { getConfirmableOp, type ConfirmableOp } from "./registry";
import { renderConfirmActionPage, renderConfirmNoticePage } from "./page";
// Side-effect import: registers every confirmable op before a request lands.
import "./ops";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Frame-Options": "DENY",
  // The token rides in the GET URL; never leak it through a Referer.
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function page(html: string, status: number): Response {
  return new Response(html, { status, headers: HEADERS });
}

const COPY = {
  invalid: ["This link isn't valid", "This link is invalid or has expired. Ask your assistant again if you still want this done."],
  consumed: ["Already confirmed", "This action was already confirmed, so it won't run again."],
  expired: ["This link has expired", "Nothing was done. Confirmation links expire after 24 hours; ask your assistant again if you still want this."],
  unavailable: ["This can no longer be confirmed", "Nothing was done. Ask your assistant again if you still want this."],
  browserOnly: ["Confirm this in your browser", "This confirmation has to come from you, by opening the emailed link in your browser. Nothing was done."],
  failed: ["We couldn't complete this", "Something went wrong while carrying out this action. Check your calendar before asking your assistant again."],
} as const;

const notice = (k: keyof typeof COPY, status: number) => page(renderConfirmNoticePage(COPY[k][0], COPY[k][1]), status);

type Loaded =
  | { kind: "ok"; row: PendingActionRow; def: ConfirmableOp<any, any>; tz: string }
  | { kind: "error"; res: Response };

/** Token → active member → active account → owner-scoped row → registered
 *  op. One invalid page for a bad token, a token for another action, another
 *  owner's action, a delisted owner (decision C: nothing runs on a delisted
 *  user's grant) and a deactivated or missing account alike. The account
 *  check matters even with an allow-list: isActiveMember then never reads
 *  users.is_active, and a deferral racing a self-delete (offboard deletes
 *  pending_actions, but a row inserted just after it survives) must not
 *  replay and recreate rows for a deleted account. */
async function load(c: Ctx, id: string, token: string | undefined): Promise<Loaded> {
  const claims = token ? await verifyCapabilityWithEnv(token, c.env) : null;
  if (!claims || claims.purpose !== "confirm-action" || claims.actionId !== id) {
    return { kind: "error", res: notice("invalid", 400) };
  }
  if (!(await isActiveMember(c.env, claims.subject, "confirm_action"))) {
    return { kind: "error", res: notice("invalid", 400) };
  }
  const user = await getUser(c.env.DB, claims.subject);
  if (user?.is_active !== 1) {
    return { kind: "error", res: notice("invalid", 400) };
  }
  const row = await getPendingAction(c.env.DB, id, claims.subject);
  if (!row) return { kind: "error", res: notice("invalid", 400) };
  if (row.consumed_at) return { kind: "error", res: notice("consumed", 409) };
  const now = new Date();
  if (row.expires_at <= now.toISOString()) {
    await blankExpiredPendingAction(c.env.DB, id, row.owner_subject, now);
    return { kind: "error", res: notice("expired", 410) };
  }
  const def = getConfirmableOp(row.op);
  if (!def) {
    console.error("confirm_action_unknown_op", { op: row.op });
    return { kind: "error", res: notice("unavailable", 410) };
  }
  // The owner's effective tz (as getHomeTz), off the row already read.
  return { kind: "ok", row, def, tz: user.home_tz ?? c.env.SCHEDULER_TZ };
}

function parseStored(schema: ConfirmableOp["payloadSchema"], json: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const r = schema.safeParse(JSON.parse(json));
    return r.success ? { ok: true, value: r.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function mountConfirmRoutes(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  app.get("/confirm/:id", async (c) => {
    const id = c.req.param("id");
    const token = c.req.query("t");
    const loaded = await load(c, id, token);
    if (loaded.kind === "error") return loaded.res;
    const { row, def, tz } = loaded;
    const summary = parseStored(def.summarySchema, row.summary);
    if (!summary.ok) {
      console.error("confirm_action_bad_summary", { op: row.op });
      return notice("unavailable", 410);
    }
    return page(
      renderConfirmActionPage({ label: def.label, view: def.render(summary.value), actionId: id, token: token!, expiresAt: row.expires_at, tz }),
      200,
    );
  });

  app.post("/confirm/:id", async (c) => {
    // Self-confirm guard, before anything else: a browser form POST never
    // carries Authorization, and the codemode proxy always attaches one.
    if (c.req.header("authorization") !== undefined) return notice("browserOnly", 403);
    // Cross-site guard: only our own page's form may post here.
    if (isForeignFetchSite(c.req.header("sec-fetch-site"))) return notice("browserOnly", 403);
    const id = c.req.param("id");
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const token = typeof form.t === "string" ? form.t : undefined;
    const loaded = await load(c, id, token);
    if (loaded.kind === "error") return loaded.res;
    const { row, def } = loaded;
    const payload = parseStored(def.payloadSchema, row.payload);
    if (!payload.ok) {
      console.error("confirm_action_bad_payload", { op: row.op });
      return notice("unavailable", 410);
    }

    // The CAS is the authority (load()'s checks only pick the nicer page):
    // exactly one POST wins; a racer or a link expiring in between loses.
    if (!(await consumePendingAction(c.env.DB, id, row.owner_subject, new Date()))) {
      const after = await getPendingAction(c.env.DB, id, row.owner_subject);
      if (after && !after.consumed_at) {
        await blankExpiredPendingAction(c.env.DB, id, row.owner_subject, new Date());
        return notice("expired", 410);
      }
      return notice("consumed", 409);
    }

    try {
      const outcome = await def.replay(c.env, row.owner_subject, payload.value, {
        actionId: id,
        calendarProvider: c.var.calendarProvider,
        notificationProvider: c.var.notificationProvider,
      });
      console.log("confirm_action_replayed", { op: row.op, action_id: id, outcome: outcome.ok ? "ok" : outcome.reason });
      return outcome.ok
        ? page(renderConfirmNoticePage("Done", outcome.message, outcome.links), 200)
        : page(renderConfirmNoticePage("This wasn't done", outcome.message), 409);
    } catch (e) {
      // Error name only: messages can carry addresses, titles or tokens.
      console.error("confirm_action_replay_failed", { op: row.op, action_id: id, error: e instanceof Error ? e.name : "unknown" });
      return notice("failed", 500);
    }
  });
}
