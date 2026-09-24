import type { NotificationProvider, PollEmail } from "./notification-provider";
import type { DiffEmailRenderer, RenderOpts } from "../diff/diff-email-renderer";
import { GmailDiffRenderer } from "../diff/gmail-diff-renderer";
import type { ReplanEmailModel } from "../diff/email-model";

type TokenFetcher = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface MicrosoftGraphNotificationProviderOptions {
  getAccessToken: TokenFetcher;
  fetch?: typeof fetch;
  renderer?: DiffEmailRenderer;
}

export class MicrosoftGraphNotificationProvider implements NotificationProvider {
  private readonly getAccessToken: TokenFetcher;
  private readonly fetchFn: typeof fetch;
  private readonly renderer: DiffEmailRenderer;

  constructor(opts: MicrosoftGraphNotificationProviderOptions) {
    this.getAccessToken = opts.getAccessToken;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    // The renderer is transport-agnostic despite the Gmail name — same
    // subject/plaintext/html triple either way.
    this.renderer = opts.renderer ?? new GmailDiffRenderer();
  }

  async sendReplanNotification(to: string, model: ReplanEmailModel, opts: RenderOpts): Promise<void> {
    const { subject, plaintext, html } = this.renderer.render(model, opts);
    await this.sendMail(to, subject, plaintext, html);
  }

  async sendPollEmail(email: PollEmail): Promise<void> {
    // Graph takes attachments inline on the message (fileAttachment, base64
    // contentBytes) — no MIME assembly needed, unlike the Gmail provider.
    const attachments = email.attachments?.length
      ? email.attachments.map((a) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.filename,
          contentType: a.mimeType,
          contentBytes: a.contentBase64,
        }))
      : undefined;
    await this.sendMail(email.to, email.subject, email.text, email.html, attachments);
  }

  private async sendMail(
    to: string, subject: string, plaintext: string, html: string,
    attachments?: Array<Record<string, string>>,
  ): Promise<void> {
    // The JSON `message` body's contentType is single-valued (Text XOR
    // HTML) — POST /me/sendMail also accepts a base64-encoded raw MIME
    // message (which CAN carry multipart/alternative, like Gmail's raw
    // send), but that's a deliberate follow-up, not this path. Every caller
    // today supplies both plaintext and html (RenderedEmail / PollEmail make
    // both required), so this just prefers the richer HTML rendering and
    // drops plaintext, matching the Gmail provider's visual result. The
    // empty-html branch exists so a future or defensive text-only caller is
    // never sent with contentType: "HTML" — most clients render bare
    // newlines in an HTML body as nothing, collapsing multi-line plaintext
    // onto one line.
    const body = html
      ? { contentType: "HTML", content: html }
      : { contentType: "Text", content: plaintext };
    const payload = JSON.stringify({
      message: {
        subject,
        body,
        toRecipients: [{ emailAddress: { address: to } }],
        ...(attachments ? { attachments } : {}),
      },
      saveToSentItems: true,
    });
    const url = "https://graph.microsoft.com/v1.0/me/sendMail";
    const send = (token: string) => this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: payload,
    });
    let res = await send(await this.getAccessToken());
    if (res.status === 401) res = await send(await this.getAccessToken({ forceRefresh: true }));
    if (!res.ok) throw new Error(`Graph sendMail failed: ${res.status} ${await res.text()}`);
  }
}
