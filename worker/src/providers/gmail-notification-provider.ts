import type { NotificationProvider, PollEmail } from "./notification-provider";
import type { DiffEmailRenderer, RenderOpts } from "../diff/diff-email-renderer";
import { GmailDiffRenderer } from "../diff/gmail-diff-renderer";
import type { ReplanEmailModel } from "../diff/email-model";

type TokenFetcher = (opts?: { forceRefresh?: boolean }) => Promise<string>;
type FromResolver = () => Promise<string>;

// Neutralize RFC822 header-injection: collapse CR/LF and other control chars
// that can terminate or fold a header from any value spliced into a header line.
// Covers \r, \n (and lone variants), NUL + the rest of C0, DEL, and the Unicode
// line separators U+2028/U+2029 that some MIME parsers fold as breaks.
export function headerValue(v: string): string {
  return v.replace(/[\r\n\x00-\x1F\x7F\u2028\u2029]+/g, " ").trim();
}

// RFC 2047 encoded-word encoding for non-ASCII header values. Header fields are
// ASCII-only; a raw-UTF-8 Subject is reinterpreted downstream as Latin-1 and
// re-encoded, producing mojibake (em-dash → "Ã¢Â€Â"). ASCII values pass through
// unchanged. Non-ASCII is chunked into <=45-byte UTF-8 groups (so each base64
// encoded-word stays within the 75-char limit), split on code-point boundaries,
// and folded with CRLF+space. Apply ONLY to phrase/text headers (Subject), never
// to an addr-spec — encoded-words are forbidden inside an address.
export function encodeHeaderWord(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const enc = new TextEncoder();
  const word = (bytes: number[]): string => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `=?UTF-8?B?${btoa(bin)}?=`;
  };
  const words: string[] = [];
  let buf: number[] = [];
  for (const ch of value) {
    const b = Array.from(enc.encode(ch));
    if (buf.length + b.length > 45) {
      words.push(word(buf));
      buf = [];
    }
    buf.push(...b);
  }
  if (buf.length) words.push(word(buf));
  return words.join("\r\n ");
}

// RFC 2045 §6.8: base64 body content is wrapped at 76 characters per line.
function foldBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

function base64UrlEncode(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  let s = "";
  for (const b of utf8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface GmailNotificationProviderOptions {
  // Static "From" address, or an async resolver invoked per send.
  from?: string;
  getFrom?: FromResolver;
  getAccessToken: TokenFetcher;
  fetch?: typeof fetch;
  renderer?: DiffEmailRenderer;
}

export class GmailNotificationProvider implements NotificationProvider {
  private readonly getFrom: FromResolver;
  private readonly getAccessToken: TokenFetcher;
  private readonly fetchFn: typeof fetch;
  private readonly renderer: DiffEmailRenderer;

  constructor(opts: GmailNotificationProviderOptions) {
    if (opts.getFrom) {
      this.getFrom = opts.getFrom;
    } else if (opts.from !== undefined) {
      const f = opts.from;
      this.getFrom = async () => f;
    } else {
      throw new Error("GmailNotificationProvider requires either `from` or `getFrom`");
    }
    this.getAccessToken = opts.getAccessToken;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.renderer = opts.renderer ?? new GmailDiffRenderer();
  }

  async sendReplanNotification(to: string, model: ReplanEmailModel, opts: RenderOpts): Promise<void> {
    const { subject, plaintext, html } = this.renderer.render(model, opts);
    await this.sendMime(to, subject, plaintext, html);
  }

  async sendPollEmail(email: PollEmail): Promise<void> {
    await this.sendMime(email.to, email.subject, email.text, email.html, email.attachments);
  }

  private async sendMime(
    to: string,
    subject: string,
    plaintext: string,
    html: string,
    attachments?: PollEmail["attachments"],
  ): Promise<void> {
    const from = await this.getFrom();
    const altBoundary = `boundary_${crypto.randomUUID().replace(/-/g, "")}`;
    const alternativeLines = [
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      plaintext,
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
      `--${altBoundary}--`,
    ];

    // Only the booking-notice path (hidden invitees, T15) sends attachments
    // today, but this stays generic to PollEmail.attachments rather than
    // ICS-specific. multipart/mixed wraps the whole multipart/alternative as
    // its first part, then one part per attachment — the standard nested
    // shape for "text body + files".
    let bodyLines: string[];
    if (attachments?.length) {
      const mixedBoundary = `boundary_${crypto.randomUUID().replace(/-/g, "")}`;
      const attachmentParts = attachments.flatMap((a) => [
        `--${mixedBoundary}`,
        `Content-Type: ${a.mimeType}; name="${headerValue(a.filename)}"`,
        `Content-Disposition: attachment; filename="${headerValue(a.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        foldBase64(a.contentBase64),
      ]);
      bodyLines = [
        `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
        "",
        `--${mixedBoundary}`,
        ...alternativeLines,
        ...attachmentParts,
        `--${mixedBoundary}--`,
      ];
    } else {
      bodyLines = alternativeLines;
    }

    const rfc822 = [
      `From: ${headerValue(from)}`,
      `To: ${headerValue(to)}`,
      `Subject: ${encodeHeaderWord(headerValue(subject))}`,
      "MIME-Version: 1.0",
      ...bodyLines,
    ].join("\r\n");
    let token = await this.getAccessToken();
    const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
    let res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: base64UrlEncode(rfc822) }),
    });
    if (res.status === 401) {
      token = await this.getAccessToken({ forceRefresh: true });
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: base64UrlEncode(rfc822) }),
      });
    }
    if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  }
}
