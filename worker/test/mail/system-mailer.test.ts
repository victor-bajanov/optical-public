import { describe, it, expect, vi, afterEach } from "vitest";
import { systemMailer, type SystemMailEnv } from "../../src/mail/system-mailer";

const KEY = "fake-smtp2go-key-for-tests";
const FROM = "Optical <optical@example.test>";
const TO = "user@example.test";

function env(over: Partial<SystemMailEnv> = {}): SystemMailEnv {
  return {
    SYSTEM_MAIL_ENABLED: "true",
    SYSTEM_MAIL_FROM: FROM,
    SYSTEM_MAIL_API_KEY: KEY,
    ...over,
  };
}

function okResponse(data: Record<string, unknown> = { succeeded: 1, failed: 0, failures: [], email_id: "e1" }) {
  return new Response(JSON.stringify({ request_id: "r1", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const msg = { to: TO, subject: "Your Optical account", text: "Body text with private detail" };

/** Every console line emitted during the test, flattened to one string. */
function captureLogs() {
  const lines: string[] = [];
  const rec = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation(rec);
  }
  return () => lines.join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("systemMailer", () => {
  it("flag off: no fetch, returns {ok:false}, logs nothing", async () => {
    const logs = captureLogs();
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      const fetchFn = vi.fn();
      const r = await systemMailer(env({ SYSTEM_MAIL_ENABLED: flag }), { fetch: fetchFn }).send(msg);
      expect(r).toEqual({ ok: false });
      expect(fetchFn).not.toHaveBeenCalled();
    }
    expect(logs()).toBe("");
  });

  it("flag on + key missing: no fetch, logs system_mail_misconfigured", async () => {
    for (const over of [
      { SYSTEM_MAIL_API_KEY: undefined },
      { SYSTEM_MAIL_API_KEY: "" },
      { SYSTEM_MAIL_FROM: undefined },
      { SYSTEM_MAIL_FROM: "  " },
      { SYSTEM_MAIL_FROM: "<set after V14>" },
    ]) {
      vi.restoreAllMocks();
      const logs = captureLogs();
      const fetchFn = vi.fn();
      const r = await systemMailer(env(over), { fetch: fetchFn }).send(msg);
      expect(r).toEqual({ ok: false });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(logs()).toContain("system_mail_misconfigured");
    }
  });

  it("success: POSTs the SMTP2GO payload with the key header, returns {ok:true}", async () => {
    const fetchFn = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => okResponse());
    const r = await systemMailer(env(), { fetch: fetchFn }).send(msg);
    expect(r).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.smtp2go.com/v3/email/send");
    expect(init!.method).toBe("POST");
    const headers = new Headers(init!.headers);
    expect(headers.get("X-Smtp2go-Api-Key")).toBe(KEY);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init!.body))).toEqual({
      sender: FROM,
      to: [TO],
      subject: msg.subject,
      text_body: msg.text,
    });
    // The key travels only in the header, never in the body.
    expect(String(init!.body)).not.toContain(KEY);
  });

  it("non-2xx: {ok:false}, no throw, logs system_mail_failed with status only", async () => {
    const logs = captureLogs();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { error: "bad key " + KEY } }), { status: 401 }));
    const r = await systemMailer(env(), { fetch: fetchFn }).send(msg);
    expect(r).toEqual({ ok: false });
    const out = logs();
    expect(out).toContain("system_mail_failed");
    expect(out).toContain("401");
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(msg.text);
    expect(out).not.toContain(TO);
  });

  it("200 with data.failed > 0 / succeeded = 0 is a failure", async () => {
    for (const data of [
      { succeeded: 0, failed: 1, failures: [TO] },
      { succeeded: 0, failed: 0 },
      {},
    ]) {
      vi.restoreAllMocks();
      const logs = captureLogs();
      const fetchFn = vi.fn(async () => okResponse(data));
      const r = await systemMailer(env(), { fetch: fetchFn }).send(msg);
      expect(r).toEqual({ ok: false });
      expect(logs()).toContain("system_mail_failed");
      expect(logs()).not.toContain(TO);
    }
  });

  it("200 with an unparseable body is a failure, not a throw", async () => {
    captureLogs();
    const fetchFn = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    expect(await systemMailer(env(), { fetch: fetchFn }).send(msg)).toEqual({ ok: false });
  });

  it("network error: {ok:false}, no throw, key not logged", async () => {
    const logs = captureLogs();
    const fetchFn = vi.fn(async () => {
      throw new Error("connect failed with key " + KEY);
    });
    const r = await systemMailer(env(), { fetch: fetchFn }).send(msg);
    expect(r).toEqual({ ok: false });
    expect(logs()).toContain("system_mail_failed");
    expect(logs()).not.toContain(KEY);
  });

  it("rejects header-injection in subject or recipient without sending", async () => {
    const bad = [
      { ...msg, subject: "Hello\r\nBcc: attacker@evil.test" },
      { ...msg, subject: "Hello\nX" },
      { ...msg, subject: "Hello\rX" },
      { ...msg, subject: "Hello\u2028X" },
      { ...msg, to: "user@example.test\r\nBcc: attacker@evil.test" },
      { ...msg, to: "user@example.test\n" },
    ];
    for (const m of bad) {
      vi.restoreAllMocks();
      const logs = captureLogs();
      const fetchFn = vi.fn(async () => okResponse());
      const r = await systemMailer(env(), { fetch: fetchFn }).send(m);
      expect(r).toEqual({ ok: false });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(logs()).toContain("system_mail_failed");
      expect(logs()).not.toContain("attacker");
    }
  });

  it("never logs the key on any path", async () => {
    const logs = captureLogs();
    await systemMailer(env({ SYSTEM_MAIL_FROM: undefined }), { fetch: vi.fn() }).send(msg);
    await systemMailer(env(), { fetch: vi.fn(async () => new Response("x", { status: 500 })) }).send(msg);
    await systemMailer(env(), { fetch: vi.fn(async () => okResponse()) }).send(msg);
    expect(logs()).not.toContain(KEY);
  });
});
