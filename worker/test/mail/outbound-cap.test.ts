import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_OUTBOUND_MAIL_DAILY_CAP,
  OutboundMailCapExceeded,
  outboundMailDailyCap,
  countThirdPartyRecipients,
  hasOutboundMailBudget,
  withOutboundMailCap,
  utcDay,
} from "../../src/mail/outbound-cap";
import { defaultNotificationProvider, defaultProviders } from "../../src/index-providers";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { Env } from "../../src/env";
import type { ReplanEmailModel } from "../../src/diff/email-model";

const ALICE = "alice@org.example";
const BOB = "bob@org.example";
const MAIL = { subject: "s", text: "t", html: "<p>t</p>" };

function capEnv(cap?: string): Env {
  return { ...(env as unknown as Env), OUTBOUND_MAIL_DAILY_CAP: cap };
}

async function seedCount(subject: string, day: string, count: number): Promise<void> {
  await env.DB.prepare("INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?, ?, ?)")
    .bind(subject, day, count).run();
}

async function countFor(subject: string, day: string): Promise<number | null> {
  const r = await env.DB.prepare("SELECT count FROM outbound_mail_counts WHERE subject = ? AND utc_day = ?")
    .bind(subject, day).first<{ count: number }>();
  return r?.count ?? null;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbound_mail_counts").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outboundMailDailyCap", () => {
  it("defaults to 50 when unset, blank or unparseable", () => {
    expect(DEFAULT_OUTBOUND_MAIL_DAILY_CAP).toBe(50);
    expect(outboundMailDailyCap(capEnv(undefined))).toBe(50);
    expect(outboundMailDailyCap(capEnv(""))).toBe(50);
    expect(outboundMailDailyCap(capEnv("lots"))).toBe(50);
  });

  it("honours an explicit integer, flooring fractions", () => {
    expect(outboundMailDailyCap(capEnv("5"))).toBe(5);
    expect(outboundMailDailyCap(capEnv("7.9"))).toBe(7);
  });

  it('"0" means no third-party mail at all (a kill switch), and a negative clamps up to 0', () => {
    expect(outboundMailDailyCap(capEnv("0"))).toBe(0);
    expect(outboundMailDailyCap(capEnv("-3"))).toBe(0);
  });
});

describe("countThirdPartyRecipients", () => {
  it("counts each comma/semicolon-separated address, excluding the sender's own", () => {
    expect(countThirdPartyRecipients(BOB, ALICE)).toBe(1);
    expect(countThirdPartyRecipients(`${BOB}, carol@x.example; dan@x.example`, ALICE)).toBe(3);
    expect(countThirdPartyRecipients(ALICE, ALICE)).toBe(0);
    expect(countThirdPartyRecipients(` ${ALICE.toUpperCase()} `, ALICE)).toBe(0);
  });
});

describe("utcDay", () => {
  it("buckets by the UTC calendar day", () => {
    expect(utcDay(new Date("2026-10-09T23:59:59Z"))).toBe("2026-10-09");
    expect(utcDay(new Date("2026-10-10T00:00:00Z"))).toBe("2026-10-10");
  });
});

describe("withOutboundMailCap", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const clock = () => now;

  it("caps the provider in place, keeping its class and any other members callers introspect", () => {
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("3"), ALICE, inner, clock);
    expect(capped).toBe(inner);
    expect(capped).toBeInstanceOf(MockNotificationProvider);
  });

  it("sends under the cap and counts one per third-party recipient", async () => {
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("3"), ALICE, inner, clock);
    await capped.sendPollEmail({ to: BOB, ...MAIL });
    await capped.sendPollEmail({ to: "carol@x.example", ...MAIL });
    expect(inner.sentPollEmails).toHaveLength(2);
    expect(await countFor(ALICE, "2026-10-09")).toBe(2);
  });

  it("refuses at the cap with OutboundMailCapExceeded, without calling the inner provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedCount(ALICE, "2026-10-09", 3);
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("3"), ALICE, inner, clock);
    const err = await capped.sendPollEmail({ to: BOB, ...MAIL }).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundMailCapExceeded);
    expect(err.code).toBe("mail_cap_exceeded");
    expect(inner.sentPollEmails).toHaveLength(0);
    expect(await countFor(ALICE, "2026-10-09")).toBe(3);
    // One structured line, no PII: no address, no subject.
    expect(warn).toHaveBeenCalledWith("outbound_mail_capped", { count: 3, cap: 3 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("@");
  });

  it("refuses a multi-recipient message that would cross the cap, all-or-nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedCount(ALICE, "2026-10-09", 2);
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("3"), ALICE, inner, clock);
    await expect(capped.sendPollEmail({ to: `${BOB}, carol@x.example`, ...MAIL })).rejects.toBeInstanceOf(OutboundMailCapExceeded);
    expect(inner.sentPollEmails).toHaveLength(0);
    expect(await countFor(ALICE, "2026-10-09")).toBe(2);
  });

  it("never counts or refuses mail to the sender's own mailbox (replan, organiser notices)", async () => {
    await seedCount(ALICE, "2026-10-09", 3);
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("3"), ALICE, inner, clock);
    await capped.sendPollEmail({ to: ALICE, ...MAIL });
    await capped.sendReplanNotification(ALICE, {} as ReplanEmailModel, { acceptUrl: "u", planHash: "h" });
    expect(inner.sentPollEmails).toHaveLength(1);
    expect(inner.sent).toHaveLength(1);
    expect(await countFor(ALICE, "2026-10-09")).toBe(3);
  });

  it("isolates subjects: one subject at its cap does not block another", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedCount(ALICE, "2026-10-09", 3);
    const aliceInner = new MockNotificationProvider();
    const bobInner = new MockNotificationProvider();
    await expect(withOutboundMailCap(capEnv("3"), ALICE, aliceInner, clock).sendPollEmail({ to: "x@y.example", ...MAIL }))
      .rejects.toBeInstanceOf(OutboundMailCapExceeded);
    await withOutboundMailCap(capEnv("3"), BOB, bobInner, clock).sendPollEmail({ to: "x@y.example", ...MAIL });
    expect(aliceInner.sentPollEmails).toHaveLength(0);
    expect(bobInner.sentPollEmails).toHaveLength(1);
    expect(await countFor(BOB, "2026-10-09")).toBe(1);
  });

  it("rolls over at the UTC day boundary and prunes the subject's older day rows", async () => {
    await seedCount(ALICE, "2026-10-08", 3);
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("3"), ALICE, inner, () => new Date("2026-10-09T00:00:01Z"));
    await capped.sendPollEmail({ to: BOB, ...MAIL });
    expect(inner.sentPollEmails).toHaveLength(1);
    expect(await countFor(ALICE, "2026-10-09")).toBe(1);
    expect(await countFor(ALICE, "2026-10-08")).toBeNull();
  });

  it('with cap "0" refuses every third-party send but still delivers self-mail', async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("0"), ALICE, inner, clock);
    await expect(capped.sendPollEmail({ to: BOB, ...MAIL })).rejects.toBeInstanceOf(OutboundMailCapExceeded);
    await capped.sendPollEmail({ to: ALICE, ...MAIL });
    expect(inner.sentPollEmails.map((e) => e.to)).toEqual([ALICE]);
  });

  it("is atomic under concurrency: N parallel sends against cap K deliver exactly K", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = new MockNotificationProvider();
    const capped = withOutboundMailCap(capEnv("4"), ALICE, inner, clock);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => capped.sendPollEmail({ to: `r${i}@x.example`, ...MAIL })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(inner.sentPollEmails).toHaveLength(4);
    expect(await countFor(ALICE, "2026-10-09")).toBe(4);
  });
});

describe("hasOutboundMailBudget (handler pre-flight)", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("answers whether the third-party recipients fit in today's remaining budget, without consuming it", async () => {
    await seedCount(ALICE, "2026-10-09", 1);
    const e = capEnv("3");
    expect(await hasOutboundMailBudget(e, ALICE, [BOB, "c@x.example"], now)).toBe(true);
    expect(await hasOutboundMailBudget(e, ALICE, [BOB, "c@x.example", "d@x.example"], now)).toBe(false);
    // Self-addressed recipients are free.
    expect(await hasOutboundMailBudget(e, ALICE, [BOB, "c@x.example", ALICE], now)).toBe(true);
    expect(await countFor(ALICE, "2026-10-09")).toBe(1);
  });
});

describe("notification-provider factories are the choke point", () => {
  it("defaultNotificationProvider refuses at the cap before touching the network", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await seedCount(ALICE, utcDay(new Date()), 50);
    const provider = await defaultNotificationProvider(capEnv(undefined), ALICE, "google");
    await expect(provider.sendPollEmail({ to: BOB, ...MAIL })).rejects.toBeInstanceOf(OutboundMailCapExceeded);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defaultProviders' notification provider is capped too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await seedCount(ALICE, utcDay(new Date()), 50);
    const { notification } = await defaultProviders(capEnv(undefined), ALICE);
    await expect(notification.sendPollEmail({ to: BOB, ...MAIL })).rejects.toBeInstanceOf(OutboundMailCapExceeded);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
