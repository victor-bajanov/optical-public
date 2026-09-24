import type { DiffEmailRenderer, RenderedEmail, RenderOpts } from "./diff-email-renderer";
import type { ReplanEmailModel } from "./email-model";
import { renderDiffCalendarHtml, renderDiffPlaintext } from "./render-diff-calendar";
import { escAttr as esc } from "../util/html-escape";
const shortHash = (h: string) => h.slice(0, 7);

function subjectFor(model: ReplanEmailModel, planHash: string): string {
  if (typeof model.trigger === "object" && model.trigger.kind === "webhook") {
    return `Scheduler: replan for invite "${model.trigger.inviteTitle}" (${shortHash(planHash)})`;
  }
  return model.isEmpty
    ? `Scheduler: weekly plan unchanged (${shortHash(planHash)})`
    : `Scheduler: weekly replan ready (${shortHash(planHash)})`;
}

const ctaButton = (url: string) =>
  `<div style="margin-top:18px"><a href="${esc(url)}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 24px;border-radius:6px">Accept this plan</a></div>`;

export class GmailDiffRenderer implements DiffEmailRenderer {
  render(model: ReplanEmailModel, opts: RenderOpts): RenderedEmail {
    const body = renderDiffCalendarHtml(model);
    const html =
      `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fc">` +
      `<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">` +
      body + ctaButton(opts.acceptUrl) +
      `</div></body></html>`;
    const plaintext = `${renderDiffPlaintext(model)}\nAccept this plan: ${opts.acceptUrl}`;
    return { subject: subjectFor(model, opts.planHash), plaintext, html };
  }
}
