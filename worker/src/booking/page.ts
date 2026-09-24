// Server-rendered shell for the public booking page. Same idiom as
// web/accept-page.ts: one CSS constant, explicit escaping, no framework.
//
// This page is PUBLIC and every dynamic value in it (the slug above all) comes
// from a URL path segment, so each interpolation goes through the escaper for
// its context — escText inside element content, escAttr inside a quoted
// attribute. Nothing dynamic reaches a URL, a <script> body or a style.

import type { LocationKind, LocationOption } from "./location";
import { escText, escAttr } from "../util/html-escape";
import { BOOKING_CLIENT_HASH } from "./booking-client-source.generated";

const STYLE = `
:root{--fg:#1f2328;--muted:#6b7480;--line:#d8dde3;--accent:#c9a227;--pane:#fff;--bg:#eef1f5}
*{box-sizing:border-box}
body{font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px}
.pane{max-width:920px;margin:0 auto;background:var(--pane);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.head{padding:16px 20px;border-bottom:1px solid #eceff2;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0}
.muted{color:var(--muted);font-size:12px;margin:2px 0 0}
.chips{display:flex;gap:6px;margin-left:auto}
.chip{border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:12px;background:#fff;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--fg);border-color:var(--fg);color:#fff;font-weight:600}
.tools{padding:11px 20px;border-bottom:1px solid #eceff2;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px}
.tools input[type=file]{font-size:12px}
.tools select{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:#fff}
.ok{color:#8a6d0b}
.body{padding:16px 20px}
.grid{display:grid;gap:4px}
.colh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:center;padding-bottom:6px}
.slot{border:1px solid var(--line);border-radius:7px;padding:9px 6px;text-align:center;font-size:12.5px;font-weight:600;background:#fff;cursor:pointer}
.slot.clash{color:#aab2bb;background:#f7f8fa;border-style:dashed;font-weight:400}
.slot[aria-pressed="true"]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.none{background:repeating-linear-gradient(45deg,#f1f3f6,#f1f3f6 4px,#e7eaee 4px,#e7eaee 8px);border:1px solid #e1e5ea;border-radius:7px;min-height:34px}
.strip{display:flex;gap:5px;padding:11px 20px;border-bottom:1px solid #eceff2;overflow-x:auto;align-items:flex-end}
.mgroup{flex:0 0 auto;display:flex;flex-direction:column}
.mgroup+.mgroup{margin-left:9px;padding-left:9px;border-left:1px solid #eceff2}
.mlabel{position:sticky;left:20px;align-self:flex-start;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--fg);padding:0 4px 4px;white-space:nowrap}
.mdays{display:flex;gap:5px}
.dcell{flex:0 0 46px;border:1px solid transparent;border-radius:8px;padding:6px 2px 5px;text-align:center;cursor:pointer;background:none}
.dcell[aria-pressed="true"]{background:var(--fg)}
.dcell[aria-pressed="true"] .dnum,.dcell[aria-pressed="true"] .dwd{color:#fff}
.dwd{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#8b939d}
.dnum{font-size:13px;font-weight:600;margin:1px 0 4px}
.dots{display:flex;gap:2.5px;justify-content:center;height:6px;align-items:center}
.dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
.empty{opacity:.45}
.dcell.more{border-color:var(--line);border-style:dashed;cursor:pointer}
.dcell.more .dnum{color:var(--accent)}
.dcell.more:disabled{opacity:.45;cursor:default}
form{margin-top:18px;display:grid;gap:10px;max-width:420px}
label{font-size:12px;color:var(--muted)}
input[type=text],input[type=email],textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;font:inherit}
button.go{background:var(--fg);color:#fff;border:0;border-radius:7px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer}
button.go:disabled{opacity:.45;cursor:default}
.msg{font-size:13px;padding:10px 12px;border-radius:7px;background:#fef7e0;border:1px solid #f4e3a5}
.locpick{display:grid;gap:6px}
.locopt{display:flex;gap:7px;align-items:center;font-size:13px;color:var(--fg)}
@media(max-width:720px){body{padding:12px}.grid{grid-template-columns:1fr 1fr!important}.colh{display:none}}
`;

/** The global Turnstile invokes once its API is ready. MUST match
 *  `TURNSTILE_READY_CALLBACK` in booking.client.js — like the 720px breakpoint,
 *  this name is written in two files and neither can derive it from the other
 *  (this one is baked into a URL, that one into a `window` property). */
const TURNSTILE_READY_CALLBACK = "opticalTurnstileReady";

/** Content-Security-Policy for the booking page.
 *
 *  Defence in depth: every interpolation above is escaped for its context, so
 *  this is not standing between a live injection and the booker. It matters
 *  because the page is unauthenticated, public, and its success sends a
 *  calendar invitation from the owner's own account — and because without
 *  `frame-ancestors` any origin could frame it and drive that by clickjacking.
 *
 *  Kept next to the markup it has to permit. Each source is load-bearing:
 *  - `script-src 'self'` — the page's own module, /book/_static/booking.js.
 *  - `script-src`/`frame-src`/`connect-src` challenges.cloudflare.com — the
 *    Turnstile script, the iframe it injects and the calls that iframe makes.
 *  - `style-src 'unsafe-inline'` — the <style> block below AND the style=""
 *    grid-placement attributes booking.client.js writes on every slot cell.
 *    A nonce is NOT an option: under CSP3 a nonce makes 'unsafe-inline' be
 *    ignored, which would kill the attributes and collapse the week grid.
 *  - `connect-src 'self'` — GET /book/<slug>/slots and POST /book/<slug>.
 *  Everything else falls to `default-src 'none'`. `form-action 'none'` is safe
 *  because the confirm form is always submitted through fetch(). */
export const BOOKING_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'unsafe-inline'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "img-src 'self' data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface BookingPageOptions {
  slug: string;
  durations: number[];
  siteKey: string;
  /** The meeting types this page offers, in the order the owner set. Already
   *  filtered to what is actually usable — see `offerableModes`. */
  modes: LocationOption[];
}

/** Booker-facing wording. `custom` is rendered from the owner's own text, so it
 *  has no fixed label here. */
const MODE_LABEL: Record<Exclude<LocationKind, "custom">, string> = {
  meet: "Google Meet — a link is sent with your invitation",
  phone: "Phone call — leave your number and I'll ring you",
  in_person: "In person — tell me where",
};

/** The picker, rendered server-side into a <template>.
 *
 *  The confirm form is built in the browser, but the owner's `custom` text must
 *  not be: routing it through the same escText as the rest of the page keeps it
 *  on one escaping path, instead of a second one via JSON in a data attribute.
 *  The client clones this markup into the form. */
function locationTemplate(modes: LocationOption[]): string {
  const label = (m: LocationOption) =>
    m.kind === "custom" ? escText((m.detail ?? "").trim()) : MODE_LABEL[m.kind];

  // Nothing to choose between: the one kind is stated rather than offered, and
  // `data-single` is how the client learns which kind the form means.
  if (modes.length === 1) {
    const only = modes[0] as LocationOption;
    return (
      `<template id="loctpl"><div class="locpick" data-single="${escAttr(only.kind)}">` +
      `<div class="msg">${label(only)}</div></div></template>`
    );
  }
  const radios = modes
    .map(
      (m, i) =>
        `<label class="locopt"><input type="radio" name="location_kind" ` +
        `value="${escAttr(m.kind)}"${i === 0 ? " checked" : ""}> ${label(m)}</label>`,
    )
    .join("");
  return `<template id="loctpl"><div class="locpick">${radios}</div></template>`;
}

/** Server-rendered shell. All interactivity lives in booking.client.js, which
 *  reads its configuration from the data- attributes on #app. */
export function renderBookingPage(o: BookingPageOptions): string {
  // One chip per offered duration; with a single duration there is nothing to
  // choose, so the row is omitted entirely rather than rendered inert.
  const chips =
    o.durations.length > 1
      ? `<div class="chips" id="durations">` +
        o.durations
          .map(
            (d, i) =>
              `<button class="chip" type="button" data-duration="${escAttr(String(d))}" ` +
              `aria-pressed="${i === 0}">${escText(String(d))} min</button>`,
          )
          .join("") +
        `</div>`
      : "";
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>Book time &middot; ${escText(o.slug)}</title>` +
    `<style>${STYLE}</style>` +
    // ORDER MATTERS, and both tags must stay in the head, in this order.
    //
    // The client renders the widget itself (`render=explicit`) and learns the
    // API has arrived through the `onload` callback — without which a booker
    // who selects a slot before api.js executes never gets a widget at all, and
    // the claim then fails a challenge they were never shown.
    //
    // `type="module"` is deferred, and `defer` (NOT `async`) puts api.js in the
    // same deferred queue, which the spec runs in document order. So the module
    // is guaranteed to have registered the callback before api.js looks for it.
    // With `async` the browser usually ran api.js first, and Turnstile gives up
    // on a missing callback after one second — it worked anyway (the client
    // also checks for an already-loaded `window.turnstile`), but every load
    // logged two "Unable to find onload callback" warnings.
    // Content-hashed filename: the asset is cached immutably, so this url is
    // what makes a deploy visible. Build-time constant, never user input.
    `<script type="module" src="/book/_static/booking.${BOOKING_CLIENT_HASH}.js"></script>` +
    `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js` +
    `?onload=${TURNSTILE_READY_CALLBACK}&amp;render=explicit" defer></script>` +
    `</head><body>` +
    `<div class="pane" id="app" data-slug="${escAttr(o.slug)}" ` +
    `data-durations="${escAttr(o.durations.join(","))}" ` +
    `data-sitekey="${escAttr(o.siteKey)}">` +
    `<div class="head"><div><h1>Book time with ${escText(o.slug)}</h1>` +
    `<p class="muted" id="tzline">Loading availability&hellip;</p></div>${chips}</div>` +
    `<div class="tools"><label for="overlay">Compare with your calendar:</label>` +
    `<input type="file" id="overlay" accept=".ics,text/calendar">` +
    `<span class="ok" id="overlay-state"></span>` +
    `<label for="tzsel">Times in:</label>` +
    `<select id="tzsel"><option value="">Detecting&hellip;</option></select>` +
    `</div>` +
    `<div class="strip" id="strip"></div>` +
    `<div class="body"><div id="slots"></div><div id="confirm"></div></div>` +
    locationTemplate(o.modes) +
    `</div>` +
    `</body></html>`
  );
}
