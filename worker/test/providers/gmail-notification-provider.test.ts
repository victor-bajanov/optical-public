import { describe, it, expect, vi } from "vitest";
import { GmailNotificationProvider } from "../../src/providers/gmail-notification-provider";
import type { ReplanEmailModel } from "../../src/diff/email-model";

function decodeRfc2047(s: string): string {
  const words = s.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [];
  let out = "";
  for (const w of words) {
    const b64 = w.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
    const bin = atob(b64);
    out += new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  return out;
}

const model: ReplanEmailModel = {
  tz: "Australia/Sydney",
  window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
  trigger: { kind: "webhook", inviteTitle: "Client call" },
  isEmpty: false,
  days: [{ date: "2026-06-15",
    before: [{ title: "BAS prep", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T03:30:00.000Z", role: "moved-from" }],
    after: [{ title: "BAS prep", start: "2026-06-15T04:45:00.000Z", end: "2026-06-15T06:45:00.000Z", role: "moved-to", movedFrom: "2026-06-15T01:30:00.000Z" }] }],
  dropped: [],
  warnings: [],
};

describe("GmailNotificationProvider", () => {
  it("renders the model and POSTs a multipart RFC822 to gmail.send", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("gmail/v1/users/me/messages/send");
      const body = JSON.parse((init?.body as string) ?? "{}");
      const decoded = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
      expect(decoded).toContain("To: user@example.com");
      expect(decoded).toContain('Subject: Scheduler: replan for invite "Client call"');
      expect(decoded).toContain("Content-Type: multipart/alternative");
      expect(decoded).toContain("text/plain");
      expect(decoded).toContain("text/html");
      expect(decoded).toContain("BAS prep");
      expect(decoded).toContain("2:45 PM");
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    const p = new GmailNotificationProvider({
      from: "scheduler@example.com",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.sendReplanNotification("user@example.com", model, { acceptUrl: "https://s/x", planHash: "abc1234def" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("RFC 2047-encodes a Subject containing non-ASCII so it round-trips", async () => {
    const unicodeModel: ReplanEmailModel = {
      ...model,
      trigger: { kind: "webhook", inviteTitle: "Q3 Goals Agent — read the Planner-version design" },
    };
    let decodedRfc822 = "";
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      decodedRfc822 = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    const p = new GmailNotificationProvider({
      from: "scheduler@example.com",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.sendReplanNotification("user@example.com", unicodeModel, { acceptUrl: "https://s/x", planHash: "abc1234def" });

    // The raw em-dash bytes must NOT appear unencoded in the Subject header.
    const subjectLine = decodedRfc822.split("\r\n").find((l) => l.startsWith("Subject:")) ?? "";
    expect(subjectLine).toContain("=?UTF-8?B?");
    // The encoded-words decode back to the original title.
    expect(decodeRfc2047(decodedRfc822)).toContain("Q3 Goals Agent — read the Planner-version design");
  });

  it("wraps the alternative body in multipart/mixed and attaches a file when sendPollEmail carries attachments", async () => {
    const icsBody = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
    const icsBase64 = btoa(icsBody);
    let decodedRfc822 = "";
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      decodedRfc822 = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    const p = new GmailNotificationProvider({
      from: "scheduler@example.com",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });

    await p.sendPollEmail({
      to: "invitee@example.com",
      subject: "Booked: Q3 planning sync",
      text: "Booked.",
      html: "<p>Booked.</p>",
      attachments: [{ filename: "invite.ics", mimeType: "text/calendar; method=PUBLISH", contentBase64: icsBase64 }],
    });

    expect(decodedRfc822).toContain("Content-Type: multipart/mixed");
    // The text/html alternative still rides inside the mixed envelope.
    expect(decodedRfc822).toContain("Content-Type: multipart/alternative");
    expect(decodedRfc822).toContain("Booked.");
    expect(decodedRfc822).toContain('Content-Disposition: attachment; filename="invite.ics"');
    expect(decodedRfc822).toContain("Content-Type: text/calendar; method=PUBLISH");
    expect(decodedRfc822).toContain("Content-Transfer-Encoding: base64");

    // The attachment's base64 body decodes back to the original ICS bytes.
    const afterHeader = decodedRfc822.split("Content-Transfer-Encoding: base64\r\n\r\n")[1]!;
    const attachmentB64 = afterHeader.split(/\r\n--/)[0]!.replace(/\r\n/g, "");
    expect(atob(attachmentB64)).toBe(icsBody);
  });

  it("still sends a plain multipart/alternative (no multipart/mixed) when no attachments are given", async () => {
    let decodedRfc822 = "";
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      decodedRfc822 = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    const p = new GmailNotificationProvider({
      from: "scheduler@example.com",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });

    await p.sendPollEmail({ to: "invitee@example.com", subject: "Reminder", text: "plain", html: "<p>html</p>" });

    expect(decodedRfc822).not.toContain("multipart/mixed");
    expect(decodedRfc822).toContain("Content-Type: multipart/alternative");
  });
});
