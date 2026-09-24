import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { consumeReveal } from "../db/calendar-feed-reveals";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  // Clickjacking defence-in-depth: an invisible framed POST could otherwise
  // burn a victim's single-use reveal link without them seeing the page.
  "X-Frame-Options": "DENY",
};

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5}code{display:block;word-break:break-all;background:#f4f4f4;padding:1rem;border-radius:6px;margin:1rem 0}button{font-size:1rem;padding:.6rem 1.2rem;cursor:pointer}</style></head><body>${bodyHtml}</body></html>`;
}

/** Public, pre-signed, single-use secret reveal. GET never touches the DB —
 *  link-preview bots and curl on the URL cannot burn the reveal; only the
 *  explicit form POST consumes it. Mounted on the root app ahead of auth. */
export function mountCalendarRevealRoute(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  app.get("/cal-reveal/:token", (c) => {
    if (c.env.CALENDAR_FEED_ENABLED !== "true") return new Response("Not Found", { status: 404 });
    const body = `<h1>Calendar feed secret</h1>
<p>This link shows a calendar feed URL <strong>exactly once</strong>. Click reveal only when you are ready to copy it.</p>
<form method="post"><button type="submit">Reveal secret</button></form>`;
    return new Response(page("Reveal calendar feed secret", body), { status: 200, headers: HEADERS });
  });

  app.post("/cal-reveal/:token", async (c) => {
    if (c.env.CALENDAR_FEED_ENABLED !== "true") return new Response("Not Found", { status: 404 });
    const plaintext = await consumeReveal(c.env.DB, c.env, c.req.param("token"), new Date());
    if (plaintext === null) {
      const body = `<h1>Link expired</h1><p>This reveal link is invalid, already used, or expired. Ask for the secret to be regenerated to get a new link.</p>`;
      return new Response(page("Link expired", body), { status: 410, headers: HEADERS });
    }
    const esc = plaintext.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const body = `<h1>Your calendar feed URL</h1>
<p><strong>Copy it now — it will not be shown again.</strong> Subscribe to it from your calendar client (e.g. Outlook &quot;Subscribe from web&quot;).</p>
<code>${esc}</code>`;
    return new Response(page("Calendar feed URL", body), { status: 200, headers: HEADERS });
  });
}
