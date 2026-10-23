// O9.4: booking-page publishing goes through the O9.1 agent-confirm gate.
// For an AGENT_CONFIRM client, updateBookingPage defers (202) when the edit
// would publish something on the public page: enabled false->true, a slug
// change while enabled, or a title / location edit while enabled. Every other
// edit, and every ungated client, applies immediately as before. The confirmed
// replay re-validates: the page must still be as the summary described, the
// slug still free, and the feature still on.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/index-providers";
import { v1 } from "../../src/v1";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { mountConfirmRoutes } from "../../src/confirm/route";
import { getConfirmableOp } from "../../src/confirm/registry";
import { AwaitingConfirmationResponse } from "../../src/confirm/defer";
import { saveBookingPage, loadBookingPage } from "../../src/db/booking-page";
import { seedBearer, OWNER, OWNER_TOKEN } from "./helpers";
import { upsertUser } from "../../src/db/users";
import { BookingPagePutBody, BOOKING_PAGE_FIELD_LABELS } from "../../src/handlers/booking-page";

const OTHER = "book-publish-other@org";
const ISSUER = "https://scheduler.example.com";
const EVIL = `<script>alert("x")</script> & "q"`;
const GATED = { BOOKING_PAGE_ENABLED: "true", AGENT_CONFIRM_CLIENT_IDS: "book-client", OAUTH_ISSUER: ISSUER };
const UNGATED = { BOOKING_PAGE_ENABLED: "true", AGENT_CONFIRM_CLIENT_IDS: undefined, OAUTH_ISSUER: ISSUER };

let notify: MockNotificationProvider;

function makeApp() {
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("notificationProvider", notify);
    await next();
  });
  mountConfirmRoutes(app);
  app.route("/v1", v1);
  return app;
}

function put(body: unknown, e: Record<string, unknown> = GATED) {
  return makeApp().request(
    "/v1/booking-page",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { ...env, ...e },
  );
}

function linkFrom(text: string): { id: string; t: string } {
  const m = /\/confirm\/([0-9a-f-]+)\?t=([^\s"<]+)/.exec(text);
  if (!m) throw new Error("no confirm link in mail");
  return { id: m[1]!, t: decodeURIComponent(m[2]!) };
}

function confirmPage(id: string, t: string, e: Record<string, unknown> = GATED) {
  return makeApp().request(`/confirm/${id}?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env, ...e });
}

function confirmPost(id: string, t: string, e: Record<string, unknown> = GATED) {
  return makeApp().request(
    `/confirm/${id}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
    { ...env, ...e },
  );
}

async function pendingCount(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_subject = ?").bind(OWNER).first<{ n: number }>();
  return r?.n ?? 0;
}

/** A live page: enabled, slug set, a custom location. */
async function seedLive() {
  await saveBookingPage(env.DB, OWNER, {
    slug: "pub-live", enabled: true, event_title: "Chat with {booker_name}",
    location: { modes: [{ kind: "meet" }] },
  });
}

async function expectDeferred(res: Response) {
  expect(res.status).toBe(202);
  const body = AwaitingConfirmationResponse.parse(await res.json());
  expect(body.status).toBe("awaiting_confirmation");
  expect(notify.sentPollEmails).toHaveLength(1);
  expect(await pendingCount()).toBe(1);
  const row = await env.DB.prepare("SELECT op FROM pending_actions WHERE id = ?").bind(body.action_id).first<{ op: string }>();
  expect(row?.op).toBe("updateBookingPage");
  return linkFrom(notify.sentPollEmails[0]!.text);
}

beforeEach(async () => {
  for (const t of ["config_booking_page", "pending_actions"]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE owner_subject IN (?, ?)`).bind(OWNER, OTHER).run();
  }
  await seedBearer(OWNER, OWNER_TOKEN);
  await upsertUser(env.DB, OWNER); // the confirm route requires an active account
  notify = new MockNotificationProvider();
});

describe("gated transitions defer and change nothing", () => {
  it("enabled false -> true", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    await expectDeferred(await put({ enabled: true }));
    expect((await loadBookingPage(env.DB, OWNER)).enabled).toBe(false);
  });

  it("enabling together with a new slug, title and location in one request", async () => {
    await expectDeferred(await put({
      enabled: true, slug: "pub-new", event_title: "Hi", location: { modes: [{ kind: "phone" }] },
    }));
    const cfg = await loadBookingPage(env.DB, OWNER);
    expect(cfg).toMatchObject({ enabled: false, slug: null });
  });

  it("a slug change while enabled", async () => {
    await seedLive();
    await expectDeferred(await put({ slug: "pub-moved" }));
    expect((await loadBookingPage(env.DB, OWNER)).slug).toBe("pub-live");
  });

  it("a title edit while enabled", async () => {
    await seedLive();
    await expectDeferred(await put({ event_title: "Pay me at evil.example" }));
    expect((await loadBookingPage(env.DB, OWNER)).event_title).toBe("Chat with {booker_name}");
  });

  it("a location edit while enabled", async () => {
    await seedLive();
    await expectDeferred(await put({ location: { modes: [{ kind: "custom", detail: "Somewhere" }] } }));
    expect((await loadBookingPage(env.DB, OWNER)).location).toEqual({ modes: [{ kind: "meet" }] });
  });

  it("a mixed edit (durations + title while enabled) defers as a whole", async () => {
    await seedLive();
    await expectDeferred(await put({ durations_minutes: [45], event_title: "New" }));
    expect((await loadBookingPage(env.DB, OWNER)).durations_minutes).toEqual([30, 60]);
  });
});

describe("non-gated edits apply immediately", () => {
  const cases: Array<[string, () => Promise<void>, Record<string, unknown>]> = [
    ["durations while enabled", seedLive, { durations_minutes: [45] }],
    ["title/slug/location while disabled", async () => {}, { slug: "pub-draft", event_title: "Draft", location: { modes: [{ kind: "phone" }] } }],
    ["disabling a live page", seedLive, { enabled: false }],
    ["unpublishing while changing the title", seedLive, { enabled: false, event_title: "Later" }],
    ["re-sending the same slug, title and location while enabled", seedLive, {
      enabled: true, slug: "pub-live", event_title: "Chat with {booker_name}", location: { modes: [{ kind: "meet" }] },
    }],
  ];
  for (const [name, seed, body] of cases) {
    it(name, async () => {
      await seed();
      const res = await put(body);
      expect(res.status).toBe(200);
      const cfg = await res.json() as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) expect(cfg[k]).toEqual(v);
      expect(notify.sentPollEmails).toHaveLength(0);
      expect(await pendingCount()).toBe(0);
    });
  }

  it("an ungated client enables the page directly, byte-identical to before", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const res = await put({ enabled: true }, UNGATED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await loadBookingPage(env.DB, OWNER));
    expect((await loadBookingPage(env.DB, OWNER)).enabled).toBe(true);
    expect(await pendingCount()).toBe(0);
  });
});

describe("a gated request is still validated up front", () => {
  it("an invalid field is a 400, not a deferral", async () => {
    const res = await put({ enabled: true, durations_minutes: [7] });
    expect(res.status).toBe(400);
    expect(await pendingCount()).toBe(0);
  });

  it("a slug already taken is a 409, not a deferral", async () => {
    await saveBookingPage(env.DB, OTHER, { slug: "pub-taken" });
    const res = await put({ enabled: true, slug: "pub-taken" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("slug_taken");
    expect(await pendingCount()).toBe(0);
  });

  it("an invalid slug is a 400, not a deferral", async () => {
    await seedLive();
    const res = await put({ slug: "book" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_slug");
    expect(await pendingCount()).toBe(0);
  });
});

describe("confirm page and replay", () => {
  it("the page shows the public URL, title and location, escaped", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({
      enabled: true, event_title: EVIL, location: { modes: [{ kind: "custom", detail: EVIL }, { kind: "phone" }] },
    }));
    const res = await confirmPage(id, t);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`${ISSUER}/book/pub-off`);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
    expect(html).toMatch(/phone/i);
  });

  it("shows a sandboxed preview of the page after the change first, then the changes, then Confirm", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false, durations_minutes: [30] });
    const { id, t } = await expectDeferred(await put({
      enabled: true, durations_minutes: [30, 45], location: { modes: [{ kind: "custom", detail: EVIL }] },
    }));
    const html = await (await confirmPage(id, t)).text();
    const iframe = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(iframe).toMatch(/\ssandbox=""/);
    const srcdoc = /srcdoc="([^"]*)"/.exec(iframe)?.[1] ?? "";
    // The real renderer's markup, escaped once more for the attribute.
    expect(srcdoc).toContain("Book time with pub-off");
    expect(srcdoc).toContain("45 min"); // the config AFTER the change
    expect(srcdoc).not.toMatch(/&lt;script/i);
    expect(srcdoc).not.toContain("<");
    // The custom location text is escaped by the renderer, then for the attribute.
    expect(srcdoc).toContain("&amp;lt;script&amp;gt;alert");
    expect(html).toMatch(/Preview/);
    const at = (s: string) => html.indexOf(s);
    expect(at("<iframe")).toBeLessThan(at("Turns the booking page on"));
    expect(at("Turns the booking page on")).toBeLessThan(at("<form"));
  });

  it("a summary stored before previews existed still renders and confirms (no preview)", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true }));
    const row = await env.DB.prepare("SELECT summary FROM pending_actions WHERE id = ?").bind(id).first<{ summary: string }>();
    const { preview, ...old } = JSON.parse(row!.summary);
    expect(preview).toBeDefined();
    await env.DB.prepare("UPDATE pending_actions SET summary = ? WHERE id = ?").bind(JSON.stringify(old), id).run();
    const page = await confirmPage(id, t);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("<iframe");
    expect(html).toContain(`${ISSUER}/book/pub-off`);
    expect(html).toContain("Turns the booking page on");
    expect(html).toMatch(/<button class="btn" type="submit">Confirm<\/button>/);
    expect((await confirmPost(id, t)).status).toBe(200);
    expect((await loadBookingPage(env.DB, OWNER)).enabled).toBe(true);
  });

  it("the confirm page's CSP still allows no script or other source", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true }));
    const csp = (await confirmPage(id, t)).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
  });

  it("shows the event title as an example with the booker's name filled in", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true, event_title: "Meeting with {booker_name}" }));
    const html = await (await confirmPage(id, t)).text();
    expect(html).toContain("Meeting with Alex Example");
    expect(html).toMatch(/booker&#39;s name/);
    expect(html).not.toContain("{booker_name}");
  });

  it("names other changed fields in plain English, never as raw config keys", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true, bookable_over_movable_meetings: true, min_notice_minutes: 60 }));
    const html = await (await confirmPage(id, t)).text();
    expect(html).toMatch(/Also changes:/);
    expect(html).toContain(BOOKING_PAGE_FIELD_LABELS.bookable_over_movable_meetings);
    expect(html).toContain(BOOKING_PAGE_FIELD_LABELS.min_notice_minutes);
    expect(html).not.toContain("bookable_over_movable_meetings");
    expect(html).not.toContain("min_notice_minutes");
  });

  it("every patchable booking-page field has a plain-English label", () => {
    for (const key of Object.keys(BookingPagePutBody.shape)) {
      const label = (BOOKING_PAGE_FIELD_LABELS as Record<string, string>)[key];
      expect(label, key).toBeTruthy();
      expect(label).not.toContain("_");
    }
  });

  it("the Done page links to the live page instead of pasting its URL", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true }));
    const html = await (await confirmPost(id, t)).text();
    expect(html).toContain(`<a class="btn" href="${ISSUER}/book/pub-off">Open your booking page</a>`);
    expect(/<h1>Done<\/h1><p>([^<]*)<\/p>/.exec(html)?.[1]).not.toContain("http");
  });

  it("confirming applies the whole stored edit", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true, durations_minutes: [45], event_title: "Hello" }));
    const res = await confirmPost(id, t);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${ISSUER}/book/pub-off`);
    expect(await loadBookingPage(env.DB, OWNER)).toMatchObject({
      enabled: true, durations_minutes: [45], event_title: "Hello", slug: "pub-off",
    });
  });

  it("refuses when the page changed after the request (stale summary)", async () => {
    await seedLive();
    const { id, t } = await expectDeferred(await put({ event_title: "Agent title" }));
    await saveBookingPage(env.DB, OWNER, { slug: "pub-other" }); // the owner moved it meanwhile
    const res = await confirmPost(id, t);
    expect(res.status).toBe(409);
    const cfg = await loadBookingPage(env.DB, OWNER);
    expect(cfg.event_title).toBe("Chat with {booker_name}");
    expect(cfg.slug).toBe("pub-other");
  });

  it("refuses when the slug was taken by someone else in the meantime", async () => {
    await seedLive();
    const { id, t } = await expectDeferred(await put({ slug: "pub-race" }));
    await saveBookingPage(env.DB, OTHER, { slug: "pub-race" });
    const res = await confirmPost(id, t);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/taken/i);
    expect((await loadBookingPage(env.DB, OWNER)).slug).toBe("pub-live");
  });

  it("refuses when the booking-page feature was turned off", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id, t } = await expectDeferred(await put({ enabled: true }));
    const res = await confirmPost(id, t, { ...GATED, BOOKING_PAGE_ENABLED: "false" });
    expect(res.status).toBe(409);
    expect((await loadBookingPage(env.DB, OWNER)).enabled).toBe(false);
  });

  it("re-runs cross-field validation against the live config", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false, horizon_days: 21, max_horizon_days: 60 });
    const { id, t } = await expectDeferred(await put({ enabled: true, horizon_days: 50 }));
    // Meanwhile the reach shrank below the requested page size.
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 30 });
    const res = await confirmPost(id, t);
    expect(res.status).toBe(409);
    expect((await loadBookingPage(env.DB, OWNER)).enabled).toBe(false);
  });

  it("the registered op's summary and payload schemas round-trip what the handler stored", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "pub-off", enabled: false });
    const { id } = await expectDeferred(await put({ enabled: true }));
    const row = await env.DB.prepare("SELECT payload, summary FROM pending_actions WHERE id = ?").bind(id).first<{ payload: string; summary: string }>();
    const def = getConfirmableOp("updateBookingPage")!;
    expect(def.payloadSchema.safeParse(JSON.parse(row!.payload)).success).toBe(true);
    expect(def.summarySchema.safeParse(JSON.parse(row!.summary)).success).toBe(true);
  });
});

describe("spec", () => {
  it("updateBookingPage documents the 202 deferral and the 503, and says what is gated", () => {
    const doc: any = v1.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    const op = doc.paths["/booking-page"].put;
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["200", "202", "503"]));
    expect(op.responses["202"].content["application/json"].schema.properties.status.enum).toEqual(["awaiting_confirmation"]);
    expect(op.description).toMatch(/AGENT_CONFIRM_CLIENT_IDS/);
    expect(op.description).toMatch(/event_title/);
  });
});
