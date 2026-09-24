// Server-rendered shells for the public invitee-facing meeting-poll page.
// Same idiom as booking/page.ts: template-string HTML, one CSS constant,
// explicit escaping, no framework. Interactivity lives in poll.client.js
// (T6), which this shell bootstraps via `data-poll-id`/`data-token`/
// `data-cell-minutes` attributes on `#app` — NOT an inline <script>, which
// the CSP's unsafe-inline-free script-src would simply refuse to run.
//
// Guardrail (plan card): this file carries NO poll data beyond the bootstrap
// id/token/cellMinutes — title, invitee list, times and aggregate all flow
// through GET /poll/:id/grid instead, once the client has loaded. The three
// render functions below never take anything else.

import { escAttr, escText } from "../util/html-escape";
import { POLL_CLIENT_HASH } from "./poll-client-source.generated";

// STYLE's .weeknav/.weekgrid/.weekcol/.colh/.none/[data-cell]/.free/
// .if_needed/.heat-0..4 rules exist to match poll.client.js's renderGrid()
// (~poll.client.js:1040-1130), which this file never renders markup for
// directly — the client builds #grid's contents entirely at runtime.
// renderGrid stamps EVERY cell button with a heat-N class (0=none, 4=
// strongest, quantised from the aggregate) and, additionally, `free` or
// `if_needed` when the viewer has painted that cell. Heat therefore needs to
// read on BOTH painted and unpainted cells: .heat-0..4 supply the background
// ramp for the common (unpainted) case, and since `.free`/`.if_needed` set a
// higher-specificity `background` of their own (paint state is the more
// important signal once it exists), the combined
// `[data-cell].free.heat-N`/`.if_needed.heat-N` rules add a darkening inset
// ring instead of fighting the fill colour — so the aggregate signal
// survives without ever hiding "you painted this".
//
// The week grid's own layout mechanics (display:grid/flex, column count,
// gap) are set inline by renderGrid itself (style=""), same as booking.
// client.js's slot grid — the CSP's `style-src 'unsafe-inline'` permits it,
// and a CSP3 nonce would actually break it (a nonce makes 'unsafe-inline' be
// ignored). This stylesheet supplies only the visual polish layer on top
// (colour, spacing, typography) — the same split as booking/page.ts's own
// .grid/.colh/.none rules, which .colh/.none below deliberately mirror for
// visual consistency across the app (each page.ts owns its own stylesheet,
// so the rule has to be repeated, not shared).

const STYLE = `
:root{--fg:#1f2328;--muted:#6b7480;--line:#d8dde3;--accent:#c9a227;--pane:#fff;--bg:#eef1f5;--free:#2e7d32;--if-needed:#c9a227}
*{box-sizing:border-box}
body{font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px}
.pane{max-width:960px;margin:0 auto;background:var(--pane);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.head{padding:16px 20px;border-bottom:1px solid #eceff2}
h1{font-size:16px;margin:0}
.muted{color:var(--muted);font-size:12px;margin:2px 0 0}
.tools{padding:11px 20px;border-bottom:1px solid #eceff2;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px}
.tools button{border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:12px;background:#fff;cursor:pointer}
.tools button[aria-pressed="true"]{background:var(--fg);border-color:var(--fg);color:#fff;font-weight:600}
.tools input[type=file]{font-size:12px}
.tools select{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:#fff}
.body{padding:16px 20px}
form{margin-top:18px;display:grid;gap:10px;max-width:420px}
label{font-size:12px;color:var(--muted)}
input[type=text]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;font:inherit}
button.go{background:var(--fg);color:#fff;border:0;border-radius:7px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer}
button.go:disabled{background:#9aa0a6;color:#fff;cursor:not-allowed;opacity:.75}
.outcome{font-size:14px;padding:16px;background:#fef7e0;border:1px solid #f4e3a5;border-radius:7px}
.weeknav{display:flex;gap:8px;padding:0 0 10px}
.weeknav button{border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:12px;background:#fff;cursor:pointer;white-space:nowrap}
.weeknav button:hover{border-color:var(--accent)}
.weekgrid{margin-top:2px}
.weekcol{border:1px solid #eceff2;border-radius:9px;padding:8px 7px;background:#fbfcfd}
.colh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:center;padding-bottom:6px}
.none{background:repeating-linear-gradient(45deg,#f1f3f6,#f1f3f6 4px,#e7eaee 4px,#e7eaee 8px);border:1px solid #e1e5ea;border-radius:7px;min-height:34px}
[data-cell]{touch-action:none;border:1px solid var(--line);border-radius:7px;padding:9px 6px;min-width:58px;text-align:center;font-size:12px;font-weight:600;background:#fff;cursor:pointer}
[data-cell].free{background:var(--free);border-color:var(--free);color:#fff}
[data-cell].if_needed{background:repeating-linear-gradient(45deg,#fff,#fff 4px,#f4e3a5 4px,#f4e3a5 8px);border:1px dashed var(--if-needed);color:var(--fg)}
.heat-0{background:#fff}
.heat-1{background:#faf1d6}
.heat-2{background:#f2e0a3}
.heat-3{background:#e9cd70}
.heat-4{background:#dfb93c}
[data-cell].free.heat-2,[data-cell].if_needed.heat-2{box-shadow:inset 0 0 0 2px rgba(0,0,0,.15)}
[data-cell].free.heat-3,[data-cell].if_needed.heat-3{box-shadow:inset 0 0 0 2px rgba(0,0,0,.3)}
[data-cell].free.heat-4,[data-cell].if_needed.heat-4{box-shadow:inset 0 0 0 3px rgba(0,0,0,.5)}
@media(max-width:720px){body{padding:12px}}
`;

/** CSP for THIS page (the invitee-facing shell, GET /poll/:id?t=…) and the
 *  static error/expired/sent pages below — NOT the guest-join form, which
 *  has its own, separately-defined POLL_JOIN_PAGE_CSP further down that DOES
 *  permit challenges.cloudflare.com (it embeds Turnstile). This page never
 *  embeds Turnstile, so there is no reason to permit that host here.
 *  `script-src 'self'` has NO `'unsafe-inline'` and no nonce — the bootstrap
 *  therefore travels via `data-*` attributes on `#app` (read by
 *  poll.client.js's mount()), the same pattern booking/page.ts uses, never
 *  an inline `<script>`. `style-src 'unsafe-inline'` covers the <style>
 *  block above. */
export const POLL_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface PollPageOptions {
  pollId: string;
  token: string;
  cellMinutes: number;
}

const HEAD = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex">` +
  `<title>${title}</title><style>${STYLE}</style>`;

/** The normal invitee shell: paint grid + ICS upload + submit form. All
 *  interactivity and rendering happens in poll.client.js once it loads and
 *  fetches GET /poll/:id/grid — this shell supplies only the static
 *  structure the client's event delegation looks for (ids/data-attributes
 *  referenced in poll.client.js's mount()).
 *
 *  Bootstrap travels as `data-poll-id`/`data-token`/`data-cell-minutes` on
 *  `#app`, NOT an inline `<script>` — the CSP's `script-src 'self'` carries no
 *  `'unsafe-inline'` and no nonce, so an inline script here would simply never
 *  run (T6's mount() reads `root.dataset.pollId`/`.token`/`.cellMinutes`; the
 *  three attribute names are the pinned cross-card contract). */
export function renderPollPage(o: PollPageOptions): string {
  return (
    HEAD("Meeting poll") +
    `<script type="module" src="/poll/_static/poll.${POLL_CLIENT_HASH}.js"></script>` +
    `</head><body>` +
    `<div class="pane" id="app" data-poll-id="${escAttr(o.pollId)}" ` +
    `data-token="${escAttr(o.token)}" data-cell-minutes="${escAttr(String(o.cellMinutes))}">` +
    `<div class="head"><h1>Mark your availability</h1>` +
    `<p class="muted" id="status" aria-live="polite">Loading&hellip;</p></div>` +
    `<div class="tools">` +
    `<button type="button" data-tool="free" aria-pressed="true">Free</button>` +
    `<button type="button" data-tool="if_needed" aria-pressed="false">If needed</button>` +
    `<button type="button" data-action="clear">Clear</button>` +
    `<label for="tzsel">Times in:</label><select id="tzsel"></select>` +
    `<label for="ics-upload">Compare with your calendar:</label>` +
    `<input type="file" id="ics-upload" accept=".ics,text/calendar">` +
    `</div>` +
    `<div class="body" id="app-body">` +
    `<div id="grid"></div>` +
    `<form id="responseform">` +
    `<label for="name">Your name</label>` +
    `<input type="text" id="name" name="name" maxlength="100">` +
    `<label><input type="checkbox" id="hideName" name="hideName"> Hide my name from other people voting on this poll</label>` +
    `<button class="go" type="submit" id="submit-btn">Save my availability</button>` +
    `</form>` +
    `</div>` +
    `</div>` +
    `</body></html>`
  );
}

/** Friendly, static, 200 response for a token that fails to verify — expired,
 *  tampered, wrong poll, dropped invitee, or simply absent. No dynamic
 *  content at all (not even the poll id), so there is nothing here to leak
 *  and nothing to escape: opaque by construction, the same philosophy as
 *  booking's unified 404 for feature-off/unknown-slug/disabled-page. */
export function renderPollExpiredPage(): string {
  return (
    HEAD("Link unavailable") +
    `</head><body><div class="pane"><div class="body">` +
    `<h1>This link has expired or is no longer valid</h1>` +
    `<p>Please contact the organiser for a new link.</p>` +
    `</div></div></body></html>`
  );
}

/** CSP for the guest-join form page ONLY (GET /poll/:id?g=... and the POST
 *  handler's HTML responses share this — see route.ts). Distinct from
 *  POLL_PAGE_CSP because this is the one poll page that (a) loads
 *  Cloudflare's Turnstile script/iframe and (b) submits a REAL, navigation
 *  form POST rather than going through poll.client.js's fetch calls.
 *
 *  - `script-src`/`frame-src`/`connect-src` challenges.cloudflare.com — the
 *    Turnstile script, the iframe it injects, and the calls that iframe
 *    makes. No `'self'`: this page ships zero first-party script — Turnstile
 *    is used in IMPLICIT rendering mode (a bare `cf-turnstile` div; the
 *    external script finds it and, on solve, writes a `cf-turnstile-response`
 *    hidden input into the enclosing form itself), so there is nothing here
 *    for a nonce or `'self'` to permit.
 *  - `form-action 'self'` — the one directive POLL_PAGE_CSP denies that this
 *    page needs: a plain `<form method="post">` to this poll's own /join
 *    endpoint, not a fetch() (this file's other pages never navigate-submit).
 *  - `style-src 'unsafe-inline'` — the shared <style> block only. */
export const POLL_JOIN_PAGE_CSP = [
  "default-src 'none'",
  "script-src https://challenges.cloudflare.com",
  "style-src 'unsafe-inline'",
  "connect-src https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface PollJoinFormPageOptions {
  pollId: string;
  /** The `?g=` guest token from the URL — carried forward as a hidden field
   *  so it travels in the POST body, never a query string the browser could
   *  log or a Referer header could leak. */
  guestToken: string;
  /** env.TURNSTILE_SITE_KEY, same source as booking/route.ts's own siteKey —
   *  may be empty in a misconfigured deployment; the widget then simply has
   *  no sitekey to render, and the server-side verifyTurnstile call fails
   *  closed regardless (same reasoning as booking/page.ts). */
  siteKey: string;
}

/** The real guest-join form (replaces the old static stub): name, email,
 *  Turnstile, submit — a plain navigation `<form>`, not fetch(). This is
 *  deliberately simpler than booking/page.ts's own form: booking needs
 *  booking.client.js to build a dynamic slot grid and an explicit-render
 *  Turnstile widget wired to it; a poll join form has no such dynamic
 *  content, so Turnstile's IMPLICIT rendering mode (this file's only
 *  external dependency) is sufficient and needs no client JS of this card's
 *  own — poll.client.js (T6's fence) is never touched. */
export function renderPollJoinFormPage(o: PollJoinFormPageOptions): string {
  return (
    HEAD("Join this poll") +
    `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` +
    `</head><body><div class="pane"><div class="body">` +
    `<h1>Join this poll</h1>` +
    `<p class="muted">Enter your details to get your own link for marking availability.</p>` +
    `<form method="post" action="/poll/${escAttr(o.pollId)}/join">` +
    `<input type="hidden" name="guestToken" value="${escAttr(o.guestToken)}">` +
    `<label for="name">Your name</label>` +
    `<input type="text" id="name" name="name" maxlength="120" required>` +
    `<label for="email">Your email</label>` +
    `<input type="email" id="email" name="email" maxlength="254" required>` +
    `<div class="cf-turnstile" data-sitekey="${escAttr(o.siteKey)}"></div>` +
    `<button class="go" type="submit">Join</button>` +
    `</form>` +
    `</div></div></body></html>`
  );
}

/** Static confirmation, IDENTICAL for a new join and an already-invited
 *  address (the whole point of the guest-join redesign — see route.ts's
 *  join handler comment): no dynamic content, so nothing to escape and
 *  nothing for a guest-link holder to learn about who else is invited. */
export function renderPollJoinSentPage(): string {
  return (
    HEAD("Check your email") +
    `</head><body><div class="pane"><div class="body">` +
    `<h1>Check your email</h1>` +
    `<p>If that address can join this poll, we've sent a personal link to mark your availability.</p>` +
    `</div></div></body></html>`
  );
}

/** Generic error page for the join POST's HTML (form-submission) path —
 *  `heading`/`message` are always server-controlled constants (route.ts's
 *  join handler), never user input, but escaped anyway for the same
 *  belt-and-braces reason every other dynamic value in this file is. */
export function renderPollJoinErrorPage(heading: string, message: string): string {
  return (
    HEAD("Can't join this poll") +
    `</head><body><div class="pane"><div class="body">` +
    `<h1>${escText(heading)}</h1>` +
    `<p>${escText(message)}</p>` +
    `</div></div></body></html>`
  );
}
