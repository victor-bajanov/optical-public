import { describe, it, expect, vi } from "vitest";
import { MicrosoftGraphNotificationProvider } from "../../src/providers/microsoft-graph-notification-provider";
import type { DiffEmailRenderer } from "../../src/diff/diff-email-renderer";

const renderer: DiffEmailRenderer = {
  render: () => ({ subject: "Your plan — updated", plaintext: "plain", html: "<b>html</b>" }),
};

describe("MicrosoftGraphNotificationProvider", () => {
  it("sends the rendered replan email via Graph sendMail", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }));
    const p = new MicrosoftGraphNotificationProvider({
      getAccessToken: async () => "tok", fetch: fetchFn as unknown as typeof fetch, renderer,
    });
    await p.sendReplanNotification("to@x.com", {} as never, {} as never);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      message: {
        subject: "Your plan — updated",
        body: { contentType: "HTML", content: "<b>html</b>" },
        toRecipients: [{ emailAddress: { address: "to@x.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("retries once on 401 and throws on other failures", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("nope", { status: 400 }));
    const p = new MicrosoftGraphNotificationProvider({
      getAccessToken: async () => "tok", fetch: fetchFn as unknown as typeof fetch, renderer,
    });
    await expect(p.sendReplanNotification("to@x.com", {} as never, {} as never)).rejects.toThrow("Graph sendMail failed: 400");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("MicrosoftGraphNotificationProvider sendPollEmail", () => {
  function make(fetchFn: ReturnType<typeof vi.fn>) {
    return new MicrosoftGraphNotificationProvider({
      getAccessToken: async () => "tok", fetch: fetchFn as unknown as typeof fetch, renderer,
    });
  }

  it("sends a pre-rendered poll email via Graph sendMail as HTML", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }));
    await make(fetchFn).sendPollEmail({ to: "inv@x.com", subject: "Poll: sync", text: "plain", html: "<p>hi</p>" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    const body = JSON.parse(init.body as string);
    expect(body.message.subject).toBe("Poll: sync");
    expect(body.message.body).toEqual({ contentType: "HTML", content: "<p>hi</p>" });
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "inv@x.com" } }]);
    expect(body.message.attachments).toBeUndefined();
  });

  it("maps attachments to Graph fileAttachment entries (ICS booking notice)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }));
    await make(fetchFn).sendPollEmail({
      to: "hidden@x.com", subject: "Booked", text: "t", html: "<p>h</p>",
      attachments: [{ filename: "invite.ics", mimeType: "text/calendar", contentBase64: "QkVHSU4=" }],
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(body.message.attachments).toEqual([{
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "invite.ics", contentType: "text/calendar", contentBytes: "QkVHSU4=",
    }]);
  });

  it("retries once on 401 and throws on other failures", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("nope", { status: 400 }));
    await expect(make(fetchFn).sendPollEmail({ to: "a@x.com", subject: "s", text: "t", html: "h" }))
      .rejects.toThrow("Graph sendMail failed: 400");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("falls back to a plaintext contentType when no HTML body is supplied — never mislabels plaintext as HTML", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }));
    await make(fetchFn).sendPollEmail({ to: "text-only@x.com", subject: "Poll: sync", text: "plain only", html: "" });
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(body.message.body).toEqual({ contentType: "Text", content: "plain only" });
  });
});
