import { describe, it, expect } from "vitest";
import {
  retentionWarningEmail,
  retentionDeletedEmail,
  accountDeletedEmail,
  formatDeletionDate,
} from "../../src/mail/lifecycle-templates";

// Hosted-trial O10b: lifecycle mail sent through the first-party SystemMailer.
// Plain text, no links that track, no operator name (deployment-neutral).
describe("lifecycle templates", () => {
  const DELETION = new Date("2026-10-23T04:00:00.000Z");

  it("formats the deletion date as a UTC calendar date", () => {
    expect(formatDeletionDate(DELETION)).toBe("23 October 2026");
    // 23:30 UTC is still the 23rd in UTC whatever the runtime's local zone.
    expect(formatDeletionDate(new Date("2026-10-23T23:30:00.000Z"))).toBe("23 October 2026");
  });

  it("the warning names the concrete date and how to keep the data", () => {
    const m = retentionWarningEmail({ deletionDate: DELETION, retentionDays: 90 });
    expect(m.subject).toBe("Your Optical data will be deleted on 23 October 2026");
    expect(m.text).toContain("your Optical data will be deleted on 23 October 2026");
    expect(m.text).toContain("sign in or use it to keep it");
    expect(m.text).toContain("90 days");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("the warning is plain text with no URLs (nothing to track)", () => {
    const m = retentionWarningEmail({ deletionDate: DELETION, retentionDays: 90 });
    expect(m.text).not.toMatch(/https?:\/\//i);
    expect(m.text).not.toMatch(/<[a-z]/i);
  });

  it("adds the deployment label when one is configured, and stays neutral without it", () => {
    const labelled = retentionWarningEmail({ deletionDate: DELETION, retentionDays: 90, deploymentLabel: "Optical trial" });
    expect(labelled.text).toContain("Optical trial");
    const plain = retentionWarningEmail({ deletionDate: DELETION, retentionDays: 90, deploymentLabel: "  " });
    expect(plain.text).not.toContain("()");
  });

  it("the deletion notice says the data is gone", () => {
    const m = retentionDeletedEmail({ retentionDays: 90 });
    expect(m.subject).toBe("Your Optical data has been deleted");
    expect(m.text).toContain("90 days");
    expect(m.text).not.toMatch(/https?:\/\//i);
  });

  it("the retention deletion notice discloses what is kept (O14 #9)", () => {
    const m = retentionDeletedEmail({ retentionDays: 90 });
    expect(m.text).toContain("deactivated record");
    expect(m.text).toContain("email address");
    expect(m.text).toContain("audit log entries");
  });

  it("the self-serve deletion confirmation says what went and what is kept", () => {
    const m = accountDeletedEmail({});
    expect(m.subject).toBe("Your Optical account has been deleted");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain("has been deleted, as you asked");
    expect(m.text).toContain("tasks, plans and settings");
    // Keep-and-disclose (plan O2 open question): the deactivated users row and
    // the audit log keep the email address, and the mail says so.
    expect(m.text).toContain("email address");
    expect(m.text).toContain("audit log entries");
    // Only UPCOMING Optical work blocks are swept (offboard.ts isSchedulerOwned
    // + horizon); past ones and booked/moved meetings stay (O14 #9).
    expect(m.text).toContain("Upcoming work blocks");
    expect(m.text).toContain("past ones");
    expect(m.text).toContain("meetings booked or moved through Optical");
    expect(m.text).not.toContain("Events Optical had placed on your calendar were removed");
    // The upstream grant may outlive us (Microsoft has no per-app revoke).
    expect(m.text).toMatch(/Google or Microsoft account/);
    expect(m.text).not.toMatch(/https?:\/\//i);
    expect(m.text).not.toMatch(/<[a-z]/i);
  });

  // Decision F: name what the kept record holds (not "only the email") and
  // how long it lives: DELETED_ACCOUNT_RETENTION_DAYS when set, else no end date.
  describe.each([
    ["retention deletion notice", (n?: number | null) => retentionDeletedEmail({ retentionDays: 90, purgeAfterDays: n })],
    ["self-serve deletion confirmation", (n?: number | null) => accountDeletedEmail({ purgeAfterDays: n })],
  ])("%s: what is kept and for how long", (_name, mail) => {
    it("lists the kept record's contents: email address, role and dates", () => {
      const t = mail(30).text;
      expect(t).toContain("which holds your email address, your role and account dates (such as when it was created, last used and deleted)");
      expect(t).not.toMatch(/holds your email address[.,] and audit/);
    });

    it("with a purge window, says the record is deleted and the address pseudonymised after N days", () => {
      const t = mail(30).text;
      expect(t).toContain("Both are kept for 30 days after the deletion. Then the record is deleted and your email address in the audit log entries is replaced by an anonymous identifier.");
      expect(t).not.toContain("no set end date");
    });

    it("without one (null, 0 or omitted), says there is no set end date", () => {
      for (const n of [null, 0, undefined]) {
        const t = mail(n).text;
        expect(t, `purgeAfterDays=${n}`).toContain("Both are kept with no set end date.");
        expect(t).not.toContain("anonymous identifier");
      }
    });

    it("pluralises a one-day window correctly", () => {
      expect(mail(1).text).toContain("Both are kept for 1 day after the deletion.");
    });
  });

  it("the deletion confirmation names the deployment when labelled", () => {
    expect(accountDeletedEmail({ deploymentLabel: "trial" }).text).toContain("Optical (trial)");
    expect(accountDeletedEmail({ deploymentLabel: " " }).text).not.toContain("()");
  });
});
