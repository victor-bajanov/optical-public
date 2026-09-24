import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { defaultCalendarProvider } from "../index-providers";
import { resolveFeedToken, touchFeedToken } from "../db/calendar-feed-tokens";
import { loadPinnedTaskIds } from "../db/tasks";
import { selectBusyEvents, buildBusyIcs } from "./build-busy-ics";
import { guardOutput, OutputLeakError } from "./output-guard";
import { compileRevealRegexes } from "./reveal-rules";

const HORIZON_MS = 8 * 7 * 24 * 60 * 60 * 1000; // 8 weeks

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Public, UNAUTHENTICATED busy feed. The URL path token is the sole
 *  credential (same trust model as a Google secret iCal address). Mounted on
 *  the root app ahead of any auth. */
export function mountCalendarFeedRoute(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  app.get("/cal/:token/busy.ics", async (c) => {
    // Flag check first so a disabled deployment never advertises the feature.
    if (c.env.CALENDAR_FEED_ENABLED !== "true") return notFound();

    const resolved = await resolveFeedToken(c.env.DB, c.env, c.req.param("token"));
    if (!resolved) return notFound(); // unknown / revoked → opaque 404
    const owner = resolved.ownerSubject;

    const now = new Date();
    const start = now.toISOString();
    const end = new Date(now.getTime() + HORIZON_MS).toISOString();

    const cal = c.get("calendarProvider") ?? (await defaultCalendarProvider(c.env, owner));
    let events;
    try {
      events = (await cal.fetchEventsInWindow(start, end, { syncToken: false })).events;
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }

    const pinned = await loadPinnedTaskIds(c.env.DB, owner);
    const compiled = compileRevealRegexes(resolved.revealRegexes);
    const { ics, allowedSummaries } = await buildBusyIcs(selectBusyEvents(events, pinned), now, c.env, compiled);

    try {
      guardOutput(ics, allowedSummaries);
    } catch (err) {
      if (err instanceof OutputLeakError) {
        console.error("calendar feed output guard blocked response:", err.message);
        return new Response("Bad Gateway", { status: 502 });
      }
      throw err;
    }

    // Best-effort last_used_at; never block or fail the feed on it.
    const touch = touchFeedToken(c.env.DB, resolved.id, start).catch(() => {});
    try {
      c.executionCtx.waitUntil(touch);
    } catch {
      await touch;
    }

    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Robots-Tag": "noindex",
      },
    });
  });
}
