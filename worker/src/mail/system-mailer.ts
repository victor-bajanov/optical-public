import type { Env } from "../env";

/**
 * First-party Optical sender (hosted-trial card O11).
 *
 * Mail Optical sends as itself — retention warnings and deletion
 * confirmations — via one SMTP2GO HTTP API call. Separate from the per-user
 * notification providers (product mail still goes from the user's own
 * mailbox). Callers treat it as best-effort: `send` never throws and returns
 * `{ok}`; a failed send must never block a sweep or its audit trail.
 *
 * Gating:
 * - `SYSTEM_MAIL_ENABLED !== "true"` → silent no-op (`{ok:false}`, no fetch).
 * - flag on but `SYSTEM_MAIL_API_KEY` or `SYSTEM_MAIL_FROM` missing (or a
 *   `<set …>` placeholder) → `system_mail_misconfigured` error line, skip.
 *
 * Logging: `system_mail_failed` carries `{status}` only — an HTTP status, or
 * `"network"`, `"rejected"` (SMTP2GO 200 with nothing succeeded) or
 * `"invalid_input"` (CR/LF/control chars in subject or recipient). Never the
 * key, the body, the subject or the recipient address.
 */

export const SMTP2GO_SEND_URL = "https://api.smtp2go.com/v3/email/send";

export type SystemMailEnv = Pick<Env, "SYSTEM_MAIL_ENABLED" | "SYSTEM_MAIL_FROM" | "SYSTEM_MAIL_API_KEY">;

export interface SystemMail {
  to: string;
  subject: string;
  text: string;
}

export interface SystemMailer {
  send(mail: SystemMail): Promise<{ ok: boolean }>;
}

export interface SystemMailerOptions {
  fetch?: typeof fetch;
}

// Same character class as gmail-notification-provider's headerValue(): CR, LF,
// NUL and the rest of C0, DEL, and U+2028/U+2029. Rejected here rather than
// stripped — a value containing them is a caller bug or an injection attempt.
const UNSAFE_HEADER_CHARS = /[\r\n\x00-\x1F\x7F\u2028\u2029]/;

function configured(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 && !s.startsWith("<set") ? s : null;
}

export function systemMailer(env: SystemMailEnv, opts: SystemMailerOptions = {}): SystemMailer {
  if (env.SYSTEM_MAIL_ENABLED !== "true") {
    return { send: async () => ({ ok: false }) };
  }
  const key = configured(env.SYSTEM_MAIL_API_KEY);
  const sender = configured(env.SYSTEM_MAIL_FROM);
  if (!key || !sender) {
    return {
      send: async () => {
        console.error("system_mail_misconfigured", {
          api_key: key ? "set" : "missing",
          from: sender ? "set" : "missing",
        });
        return { ok: false };
      },
    };
  }
  const fetchFn: typeof fetch = opts.fetch ?? ((...args) => fetch(...args));
  const fail = (status: number | string) => {
    console.error("system_mail_failed", { status });
    return { ok: false };
  };

  return {
    async send({ to, subject, text }) {
      if (UNSAFE_HEADER_CHARS.test(to) || UNSAFE_HEADER_CHARS.test(subject)) {
        return fail("invalid_input");
      }
      let res: Response;
      try {
        res = await fetchFn(SMTP2GO_SEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Smtp2go-Api-Key": key },
          body: JSON.stringify({ sender, to: [to], subject, text_body: text }),
        });
      } catch {
        return fail("network");
      }
      if (!res.ok) return fail(res.status);
      // SMTP2GO can answer 200 while refusing every recipient: success means
      // data.succeeded >= 1 and data.failed == 0.
      let data: { succeeded?: unknown; failed?: unknown } | undefined;
      try {
        data = ((await res.json()) as { data?: typeof data }).data;
      } catch {
        return fail("rejected");
      }
      const succeeded = typeof data?.succeeded === "number" ? data.succeeded : 0;
      const failed = typeof data?.failed === "number" ? data.failed : 0;
      if (succeeded < 1 || failed > 0) return fail("rejected");
      return { ok: true };
    },
  };
}
