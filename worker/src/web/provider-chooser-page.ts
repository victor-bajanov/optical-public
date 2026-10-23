import { escAttr, escText } from "../util/html-escape";
import type { ProviderName } from "../providers/provider-name";

// Sign-in provider chooser shown by /oauth/authorize when no ?provider= was
// given and either more than one provider is offered or PRIVACY_URL is set
// (the hosted trial's in-app disclosure before consent). Plain HTML, no client JS, no external
// assets: the brand marks are inline SVG. Palette matches the booking page.
// Exported so the sign-in-refused page (O4/O6) shares the same card styling.
export const SIGN_IN_PAGE_STYLE =
  `:root{--fg:#1f2328;--muted:#6b7480;--line:#d8dde3;--accent:#c9a227;--pane:#fff;--bg:#eef1f5}` +
  `*{box-sizing:border-box}` +
  `body{font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}` +
  `.card{width:100%;max-width:400px;background:var(--pane);border:1px solid var(--line);border-radius:14px;padding:36px 32px 28px;box-shadow:0 10px 30px rgba(31,35,40,.08)}` +
  `.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}` +
  `.brand .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(201,162,39,.18)}` +
  `.brand span{font-weight:700;letter-spacing:.02em}` +
  `h1{font-size:22px;line-height:1.2;margin:0 0 6px}` +
  `p.lead{margin:0 0 24px;color:var(--muted);font-size:14px}` +
  `.btn{display:flex;align-items:center;gap:12px;width:100%;padding:12px 16px;margin-bottom:12px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--fg);font-weight:600;font-size:15px;text-decoration:none;transition:border-color .15s,box-shadow .15s,transform .05s}` +
  `.btn:hover{border-color:var(--fg);box-shadow:0 2px 8px rgba(31,35,40,.10)}` +
  `.btn:active{transform:translateY(1px)}` +
  `.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}` +
  `.btn svg{width:20px;height:20px;flex:none}` +
  `.fine{margin:18px 0 0;font-size:12px;color:var(--muted);text-align:center}` +
  `.badge{margin-left:auto;padding:2px 9px;border:1px solid var(--accent);border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}` +
  `.disclosure{margin:20px 0 0;padding-top:16px;border-top:1px solid var(--line);font-size:12px;line-height:1.55;color:var(--muted)}` +
  `.disclosure p{margin:0 0 8px}` +
  `.disclosure a{color:inherit;text-decoration:underline}` +
  `.legal{text-align:center}` +
  `@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--muted:#9aa3ad;--line:#3a404a;--pane:#1c1f24;--bg:#121417}.btn{background:#23272e}.btn:hover{border-color:var(--accent)}}`;

const GOOGLE_MARK =
  `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.8l-7.7-6c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;

const MICROSOFT_MARK =
  `<svg viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>`;

export interface ChooserLinks { google: string; microsoft: string }

export interface ChooserOptions {
  /** Providers offered. Only these get a button (Google first, then Microsoft). */
  providers: ProviderName[];
  /** PRIVACY_URL. Non-blank turns the disclosure block on; linked only
   *  when it parses as an http(s) URL. */
  privacyUrl?: string;
  /** TERMS_URL. Linked only when it parses as an http(s) URL. */
  termsUrl?: string;
  /** DEPLOYMENT_LABEL, shown as a badge beside the wordmark (e.g. "Trial").
   *  Like the rest of the disclosure, only rendered when privacyUrl is set. */
  label?: string;
}

/** Google API Services User Data Policy disclosure. Verbatim wording required
 *  by Google's OAuth verification (Google's official word order); do not paraphrase. */
export const LIMITED_USE_SENTENCE =
  "Optical's use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements.";
const USER_DATA_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
const USER_DATA_POLICY_NAME = "Google API Services User Data Policy";

/** An operator-supplied URL is linked only if it is absolute http(s); anything
 *  else (blank, relative, javascript:) is dropped rather than rendered. */
function safeHttpUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? v : null;
  } catch {
    return null;
  }
}

function limitedUseHtml(): string {
  const [before, after] = LIMITED_USE_SENTENCE.split(USER_DATA_POLICY_NAME) as [string, string];
  return `${escText(before)}<a href="${escAttr(USER_DATA_POLICY_URL)}" rel="noopener">${escText(USER_DATA_POLICY_NAME)}</a>${escText(after)}`;
}

function disclosureHtml(opts: ChooserOptions): string {
  const privacy = safeHttpUrl(opts.privacyUrl);
  const terms = safeHttpUrl(opts.termsUrl);
  const legal = [
    privacy ? `<a href="${escAttr(privacy)}" rel="noopener">Privacy policy</a>` : "",
    terms ? `<a href="${escAttr(terms)}" rel="noopener">Terms of service</a>` : "",
  ].filter(Boolean).join(" &middot; ");
  return (
    `<section class="disclosure">` +
    `<p>Optical reads and writes your calendar events, reads free/busy for you and the people you meet, ` +
    `and sends email as you (plan summaries and meeting invitations). ` +
    `Your data reaches the AI client you connect only when you ask it to, and is never used to train AI models.</p>` +
    `<p>${limitedUseHtml()}</p>` +
    (legal ? `<p class="legal">${legal}</p>` : "") +
    `</section>`
  );
}

/** Full HTML document for the provider chooser. `links` are the re-entry
 *  URLs for /oauth/authorize with ?provider= appended (path + query, already
 *  built by the caller); they are attribute-escaped here. With no `opts` both
 *  provider buttons render. */
export function renderProviderChooserPage(
  links: ChooserLinks,
  opts: ChooserOptions = { providers: ["google", "microsoft"] },
): string {
  // The disclosure (paragraph, Limited Use, links, badge) is a hosted-trial
  // surface keyed on PRIVACY_URL; without it the chooser is exactly today's.
  const disclose = (opts.privacyUrl ?? "").trim().length > 0;
  const label = disclose ? (opts.label ?? "").trim() : "";
  const offers = (p: ProviderName) => opts.providers.includes(p);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Sign in &middot; Optical</title><style>${SIGN_IN_PAGE_STYLE}</style></head><body>` +
    `<main class="card">` +
    `<div class="brand"><span class="dot"></span><span>Optical</span>` +
    (label ? `<span class="badge">${escText(label)}</span>` : "") +
    `</div>` +
    `<h1>Sign in</h1>` +
    `<p class="lead">Choose the calendar you want Optical to plan around.</p>` +
    (offers("google") ? `<a class="btn btn-google" href="${escAttr(links.google)}">${GOOGLE_MARK}Continue with Google</a>` : "") +
    (offers("microsoft") ? `<a class="btn btn-microsoft" href="${escAttr(links.microsoft)}">${MICROSOFT_MARK}Continue with Microsoft 365</a>` : "") +
    `<p class="fine">You&rsquo;ll be asked to grant calendar access on the next screen.</p>` +
    (disclose ? disclosureHtml(opts) : "") +
    `</main></body></html>`
  );
}
