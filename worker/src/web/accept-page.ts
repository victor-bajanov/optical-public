import { renderDiffCalendarHtml } from "../diff/render-diff-calendar";
import type { ReplanEmailModel } from "../diff/email-model";
import { escText, escAttr } from "../util/html-escape";

const SHELL_HEAD =
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f8fc;margin:0;padding:24px;color:#202124}` +
  `.card{max-width:640px;margin:0 auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}` +
  `.btn{display:inline-block;background:#1a73e8;color:#fff;border:0;text-decoration:none;font-size:15px;font-weight:600;padding:12px 26px;border-radius:6px;cursor:pointer}` +
  `.banner{background:#fef7e0;border:1px solid #f9e3a0;color:#7a5c00;border-radius:6px;padding:10px 14px;font-size:13px;margin-bottom:16px}` +
  `.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}` +
  `.tab{display:inline-block;font-size:13px;font-weight:600;padding:6px 14px;border-radius:16px;border:1px solid #dadce0;color:#1a73e8;text-decoration:none;background:#fff}` +
  `.tab-current{background:#e8f0fe;border-color:#1a73e8;color:#174ea6}` +
  `.tabs-note{font-size:12px;color:#5f6368;margin:0 0 16px}` +
  `h1{font-size:20px;margin:0 0 12px}</style></head><body><div class="card">`;
const SHELL_FOOT = `</div></body></html>`;

export interface WeekTab { label: string; href: string; current: boolean }

/** Selector row across pending weeks. Hidden entirely for 0–1 weeks so the
 *  single-plan page looks exactly as before. */
function tabsHtml(tabs: WeekTab[] | undefined): string {
  if (!tabs || tabs.length < 2) return "";
  const items = tabs
    .map((t) =>
      t.current
        ? `<span class="tab tab-current">${escText(t.label)}</span>`
        : `<a class="tab" href="${escAttr(t.href)}">${escText(t.label)}</a>`,
    )
    .join("");
  return `<div class="tabs">${items}</div>` +
    `<p class="tabs-note">You have proposed changes for ${tabs.length} weeks. Each is accepted separately.</p>`;
}

/** GET confirm page: the selected week's diff + an Accept form. `banner` is
 *  pre-worded end-user copy (stale-email or superseded-while-open); ws/we ride
 *  as hidden fields so a superseded POST can recover the week it was for. */
export function renderConfirmPage(opts: {
  model: ReplanEmailModel | null;
  action: string;          // POST target
  capToken: string;        // hidden form field
  banner?: string;
  weekTabs?: WeekTab[];
  windowStart: string;
  windowEnd: string;
}): string {
  const banner = opts.banner ? `<div class="banner">${escText(opts.banner)}</div>` : "";
  const visual = opts.model ? renderDiffCalendarHtml(opts.model)
    : `<p>Your plan is ready to accept.</p>`;
  return SHELL_HEAD + `<h1>Review &amp; accept your plan</h1>` + tabsHtml(opts.weekTabs) + banner + visual +
    `<form method="post" action="${escAttr(opts.action)}" style="margin-top:20px">` +
    `<input type="hidden" name="t" value="${escAttr(opts.capToken)}">` +
    `<input type="hidden" name="ws" value="${escAttr(opts.windowStart)}">` +
    `<input type="hidden" name="we" value="${escAttr(opts.windowEnd)}">` +
    `<button class="btn" type="submit">Accept this plan</button></form>` + SHELL_FOOT;
}

/** Informational page (no accept form): all-caught-up, week-no-longer-needed,
 *  already-accepted. Tabs let the user hop to weeks that DO need review. */
export function renderNoticePage(opts: { heading: string; message: string; weekTabs?: WeekTab[] }): string {
  return SHELL_HEAD + `<h1>${escText(opts.heading)}</h1>` + tabsHtml(opts.weekTabs) +
    `<p>${escText(opts.message)}</p>` + SHELL_FOOT;
}

export function renderAcceptedPage(opts?: { otherWeeks?: Array<{ label: string; href: string }> }): string {
  const others = (opts?.otherWeeks ?? [])
    .map((w) => `<li><a href="${escAttr(w.href)}">${escText(w.label)}</a></li>`)
    .join("");
  const othersBlock = others
    ? `<p>You also have proposed changes waiting for:</p><ul>${others}</ul>`
    : "";
  return SHELL_HEAD + `<h1>Plan accepted ✓</h1><p>Your calendar has been updated.</p>` + othersBlock + SHELL_FOOT;
}

export function renderErrorPage(msg: string): string {
  return SHELL_HEAD + `<h1>Can't accept this plan</h1><p>${msg.replace(/[<>&]/g, "")}</p>` + SHELL_FOOT;
}
