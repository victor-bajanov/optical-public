import type { ReplanEmailModel } from "../diff/email-model";
import type { RenderOpts } from "../diff/diff-email-renderer";

// A fully-addressed poll email (invite/nudge/escalation/booking-notice),
// already rendered. Renderers in polls/emails.ts produce the subject/
// text/html/attachments content; the caller (route/handler/cron) attaches
// `to` since renderers don't take a recipient address.
export interface PollEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  // BCC-equivalent booking notices (hidden invitees) carry an ICS file;
  // every other poll email omits this. Content is already base64.
  attachments?: Array<{ filename: string; mimeType: string; contentBase64: string }>;
}

export interface NotificationProvider {
  sendReplanNotification(to: string, model: ReplanEmailModel, opts: RenderOpts): Promise<void>;
  sendPollEmail(email: PollEmail): Promise<void>;
}
