// O9.1 confirm pages: GET /confirm/{id} (review + Confirm button) and the
// result/notice pages. Every dynamic string goes through escText/escAttr; an
// op's ConfirmView is plain data, never HTML, with one exception: a preview,
// which is a whole document from Optical's own renderer, shown escaped into a
// sandboxed srcdoc iframe (no scripts, no forms, no navigation).
import { escText, escAttr } from "../util/html-escape";
import { formatDateTime } from "../polls/emails";
import type { ConfirmLink, ConfirmView } from "./registry";

const SHELL_HEAD =
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
  `<title>Confirm an action</title>` +
  `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f8fc;margin:0;padding:24px;color:#202124}` +
  `.card{max-width:640px;margin:0 auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}` +
  `.btn{display:inline-block;background:#1a73e8;color:#fff;border:0;font-size:15px;font-weight:600;padding:12px 26px;border-radius:6px;cursor:pointer;text-decoration:none}` +
  `.note{font-size:13px;color:#5f6368}h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:18px 0 6px}` +
  `ul{margin:0;padding-left:20px}dd{margin:0 0 8px;white-space:pre-wrap}dt{font-weight:600;font-size:13px}` +
  // Backstop for any long unbroken string (a URL, an address) in any text.
  `.card{overflow-wrap:anywhere}` +
  `.links{margin-top:16px;display:grid;gap:14px}.copy{width:100%;box-sizing:border-box;font:13px ui-monospace,Menlo,monospace;padding:8px;border:1px solid #dadce0;border-radius:6px;margin:4px 0}` +
  `.preview{width:100%;height:440px;border:1px solid #dadce0;border-radius:8px;background:#eef1f5}</style>` +
  `</head><body><div class="card">`;
const SHELL_FOOT = `</div></body></html>`;

function list(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${escText(i)}</li>`).join("")}</ul>`;
}

function viewHtml(view: ConfirmView): string {
  let out = `<p><strong>${escText(view.heading)}</strong></p>`;
  if (view.preview) {
    // sandbox="" with no allowances: the document gets an opaque origin, no
    // scripts, no form submission and no navigation. It also inherits this
    // page's CSP (script-src falls to default-src 'none').
    out += `<h2>${escText(view.preview.caption)}</h2>` +
      `<iframe class="preview" sandbox="" title="${escAttr(view.preview.caption)}" srcdoc="${escAttr(view.preview.html)}"></iframe>`;
  }
  if (view.recipients?.length) out += `<h2>Recipients</h2>` + list(view.recipients);
  if (view.text?.length) {
    out += `<h2>Details</h2><dl>` +
      view.text.map((t) => `<dt>${escText(t.label)}</dt><dd>${escText(t.value)}</dd>`).join("") + `</dl>`;
  }
  if (view.slot) out += `<h2>When</h2><p>${escText(view.slot)}</p>`;
  if (view.moves?.length) {
    out += `<h2>Moves</h2>` + list(view.moves.map((m) => `${m.title}: ${m.from} → ${m.to}`));
  }
  if (view.notes?.length) out += list(view.notes);
  return out;
}

/** Only links Optical built itself reach a replay outcome; this keeps any
 *  other scheme out of an href regardless. */
const isHttpUrl = (url: string) => /^https?:\/\//i.test(url);

function linksHtml(links: ConfirmLink[]): string {
  const safe = links.filter((l) => isHttpUrl(l.url));
  if (safe.length === 0) return "";
  return `<div class="links">` + safe.map((l) =>
    l.copy
      // No script runs here (CSP), so "copy" is a read-only field the user
      // can select in one go, next to a plain link.
      ? `<div><strong>${escText(l.label)}</strong>` +
        `<input class="copy" type="text" readonly aria-label="${escAttr(l.label)}" value="${escAttr(l.url)}">` +
        `<a href="${escAttr(l.url)}">Open it</a></div>`
      : `<div><a class="btn" href="${escAttr(l.url)}">${escText(l.label)}</a></div>`,
  ).join("") + `</div>`;
}

export function renderConfirmActionPage(opts: {
  label: string;
  view: ConfirmView;
  actionId: string;
  token: string;
  expiresAt: string;
  /** The user's effective timezone, for the expiry line. */
  tz: string;
}): string {
  return SHELL_HEAD +
    `<h1>${escText(opts.label)}</h1>` +
    `<p>Your assistant asked Optical to do this on your behalf. Nothing has happened yet.</p>` +
    viewHtml(opts.view) +
    `<form method="post" action="/confirm/${escAttr(encodeURIComponent(opts.actionId))}" style="margin-top:20px">` +
    `<input type="hidden" name="t" value="${escAttr(opts.token)}">` +
    `<button class="btn" type="submit">Confirm</button></form>` +
    `<p class="note">This link works once and expires ${escText(formatDateTime(opts.expiresAt, opts.tz))} (${escText(opts.tz)}). ` +
    `If you didn't ask for this, close this page and nothing will happen.</p>` +
    SHELL_FOOT;
}

export function renderConfirmNoticePage(heading: string, message: string, links: ConfirmLink[] = []): string {
  return SHELL_HEAD + `<h1>${escText(heading)}</h1><p>${escText(message)}</p>` + linksHtml(links) + SHELL_FOOT;
}

/** The confirmation email: only the op's static label and the link, never
 *  anything the agent wrote (the details are on the page, behind the link). */
export function confirmActionEmail(opts: { label: string; url: string }): { subject: string; text: string; html: string } {
  const label = opts.label.replace(/[\r\n\x00-\x1F\x7F\u2028\u2029]/g, " ");
  const text =
    `Your assistant asked Optical to do this on your behalf: ${label}.\n\n` +
    `Nothing has happened yet. Review the details and confirm here (the link works once and expires in 24 hours):\n` +
    `${opts.url}\n\n` +
    `If you didn't ask your assistant for this, ignore this email and nothing will happen.\n`;
  const html =
    `<p>Your assistant asked Optical to do this on your behalf: <strong>${escText(label)}</strong>.</p>` +
    `<p>Nothing has happened yet. Review the details and confirm (the link works once and expires in 24 hours):</p>` +
    `<p><a href="${escAttr(opts.url)}">Review and confirm</a></p>` +
    `<p>If you didn't ask your assistant for this, ignore this email and nothing will happen.</p>` +
    `<p style="font-size:12px;color:#5f6368">${escText(opts.url)}</p>`;
  return { subject: `Confirm: ${label}`, text, html };
}
