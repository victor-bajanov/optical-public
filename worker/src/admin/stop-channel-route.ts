import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { requireAdminSubject } from "../middleware/admin-subject";
import { requireScope } from "../middleware/require-scope";
import { getCalendarSyncByChannelId } from "../db/calendar-sync";
import { defaultCalendarProvider } from "../index-providers";
import { getSubjectProvider } from "../auth/identity-store";

/**
 * Admin one-shot to stop a specific push channel/subscription that is still
 * delivering (e.g. a stale channel from before stop-on-rotation existed).
 *   POST /admin/stop-channel?channel_id=...&resource_id=...
 *
 * channel_id is required; resource_id is optional. Google channels need a
 * resourceId to stop — pass it explicitly, or omit it to fall back to the
 * value stored on the calendar_sync row. Microsoft subscriptions have no
 * resourceId concept (Graph doesn't use one, and MicrosoftCalendarProvider
 * ignores the argument), so the row's channel_resource_id is "" and omitting
 * the param is the normal path.
 *
 * A GOOGLE row can end up with no usable resourceId — channel_resource_id
 * null (never stored, e.g. a pre-resourceId-tracking legacy row) or ""
 * (falsy, same broken shape), and/or an explicit `?resource_id=` param that
 * is present but empty — falling through to "" there would send Google a
 * stop call with an empty resourceId, which 500s. That case 400s instead,
 * asking the caller to pass resource_id explicitly.
 */
export function mountStopChannelRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  app.post("/admin/stop-channel", requireBearer, requireAdminSubject, requireScope("admin"), async (c) => {
    const channelId = c.req.query("channel_id");
    if (!channelId) {
      return c.json({ error: "channel_id is required" }, 400);
    }
    // The provider must use the CHANNEL OWNER's token, not the first active user.
    // channel_id is unique (migration 0014), so this maps to at most one owner.
    const row = await getCalendarSyncByChannelId(c.env.DB, channelId);
    if (!row) {
      return c.json({ error: "unknown_channel" }, 404);
    }
    // Falsiness, not nullness: an explicit `?resource_id=` (present but
    // empty) and a stored channel_resource_id of "" are exactly as broken
    // for Google as a missing/null value — Google's stop call needs a
    // non-empty resourceId. Microsoft rows legitimately store "" (Graph has
    // no resourceId concept), so the provider check below is what actually
    // discriminates a broken Google row from a normal Microsoft one.
    const explicitResourceId = c.req.query("resource_id");
    if (!explicitResourceId && !row.channel_resource_id) {
      const providerName = await getSubjectProvider(c.env, row.owner_subject);
      if (providerName !== "microsoft") {
        return c.json(
          {
            error: "missing_resource_id",
            message:
              "This channel's calendar_sync row has no stored resourceId; pass resource_id explicitly.",
          },
          400,
        );
      }
    }
    const resourceId = explicitResourceId || row.channel_resource_id || "";
    const calendar = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, row.owner_subject);
    // Intentionally NOT wrapped in try/catch: stopChannel throws on hard
    // (non-404/410) errors, and for this operator one-shot a visible 500 is
    // better than a silent failure. (Task 7's rotation path swallows the same
    // call for best-effort cleanup; do not "helpfully" add a catch here.)
    await calendar.stopChannel(channelId, resourceId);
    return c.json(
      { ok: true, stopped: { channel_id: channelId, resource_id: resourceId } },
      200,
    );
  });
}
