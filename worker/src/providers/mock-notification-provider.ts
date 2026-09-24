import type { NotificationProvider, PollEmail } from "./notification-provider";
import type { ReplanEmailModel } from "../diff/email-model";
import type { RenderOpts } from "../diff/diff-email-renderer";

export class MockNotificationProvider implements NotificationProvider {
  public sent: Array<{ to: string; model: ReplanEmailModel; opts: RenderOpts }> = [];
  public sentPollEmails: PollEmail[] = [];

  async sendReplanNotification(to: string, model: ReplanEmailModel, opts: RenderOpts): Promise<void> {
    this.sent.push({ to, model, opts });
  }

  async sendPollEmail(email: PollEmail): Promise<void> {
    this.sentPollEmails.push(email);
  }
}
