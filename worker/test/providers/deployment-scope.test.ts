import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { CalendarEvent } from "../../src/providers/types";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import { OPTICAL_DEPLOYMENT_KEY, SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import {
  deploymentIdFromEnv,
  scopeEventToDeployment,
  withDeploymentStamp,
} from "../../src/providers/deployment-scope";
import { GoogleCalendarProvider } from "../../src/providers/google-calendar-provider";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { graphPropId } from "../../src/providers/graph-event-mapping";
import { defaultCalendarProvider, defaultProviders } from "../../src/index-providers";
import { storeIdentityTokens } from "../../src/auth/identity-store";

// Several Optical deployments (prod, dev, trial, …) can be connected to the
// same calendar. Every event a deployment creates carries its origin under
// optical_deployment; an event stamped by ANOTHER deployment must read as
// ordinary busy time (its ownership tags stripped at the provider boundary),
// so no path — commit reconcile, stray scan, done-by-colour, recolour,
// offboard — can move, recolour, delete or count it (incident 2026-10-16:
// dev's commit deleted trial's five work blocks).
const ME = "https://optical-a.example.com";
const OTHER = "https://optical-b.example.com";

function ev(id: string, priv: Record<string, string>): CalendarEvent {
  return {
    id,
    summary: id,
    start: "2026-07-06T09:00:00Z",
    end: "2026-07-06T10:00:00Z",
    extendedProperties: { private: priv },
  };
}

describe("deploymentIdFromEnv", () => {
  it("is the origin of OAUTH_ISSUER", () => {
    expect(deploymentIdFromEnv({ OAUTH_ISSUER: "https://optical-a.example.com" })).toBe(ME);
  });

  it("normalises a trailing slash, a path and host case away", () => {
    expect(deploymentIdFromEnv({ OAUTH_ISSUER: "https://Optical-A.Example.com/" })).toBe(ME);
    expect(deploymentIdFromEnv({ OAUTH_ISSUER: "https://optical-a.example.com/x/y" })).toBe(ME);
  });

  it("is undefined for an empty or unparseable issuer (no stamp, legacy behaviour)", () => {
    expect(deploymentIdFromEnv({ OAUTH_ISSUER: "" })).toBeUndefined();
    expect(deploymentIdFromEnv({ OAUTH_ISSUER: "not a url" })).toBeUndefined();
  });
});

describe("withDeploymentStamp", () => {
  it("adds the deployment stamp to the metadata", () => {
    expect(withDeploymentStamp({ [SCHEDULER_CHUNK_ID_KEY]: "t#0" }, ME)).toEqual({
      [SCHEDULER_CHUNK_ID_KEY]: "t#0",
      [OPTICAL_DEPLOYMENT_KEY]: ME,
    });
  });

  it("leaves the metadata alone without a deployment id", () => {
    expect(withDeploymentStamp({ a: "1" }, undefined)).toEqual({ a: "1" });
  });
});

describe("scopeEventToDeployment", () => {
  it("keeps this deployment's own chunk intact", () => {
    const e = ev("own", { [SCHEDULER_CHUNK_ID_KEY]: "t#0", [OPTICAL_DEPLOYMENT_KEY]: ME });
    expect(scopeEventToDeployment(e, ME)).toEqual(e);
  });

  it("keeps a legacy unstamped chunk as this deployment's own", () => {
    const e = ev("legacy", { [SCHEDULER_CHUNK_ID_KEY]: "t#0" });
    expect(scopeEventToDeployment(e, ME)).toEqual(e);
  });

  it("strips the chunk and booking ownership tags off another deployment's event", () => {
    const e = ev("foreign", {
      [SCHEDULER_CHUNK_ID_KEY]: "t#0",
      optical_booking: "b-1",
      [OPTICAL_DEPLOYMENT_KEY]: OTHER,
      unrelated: "x",
    });
    const scoped = scopeEventToDeployment(e, ME);
    expect(scoped.extendedProperties.private).toEqual({ [OPTICAL_DEPLOYMENT_KEY]: OTHER, unrelated: "x" });
    // The input is not mutated.
    expect(e.extendedProperties.private?.[SCHEDULER_CHUNK_ID_KEY]).toBe("t#0");
  });

  it("keeps a foreign poll tag: a poll-booked meeting must never be imported as movable by any deployment", () => {
    const e = ev("poll", { optical_poll_id: "p-1", [OPTICAL_DEPLOYMENT_KEY]: OTHER });
    expect(scopeEventToDeployment(e, ME).extendedProperties.private?.optical_poll_id).toBe("p-1");
  });

  it("is the identity without a deployment id of its own", () => {
    const e = ev("foreign", { [SCHEDULER_CHUNK_ID_KEY]: "t#0", [OPTICAL_DEPLOYMENT_KEY]: OTHER });
    expect(scopeEventToDeployment(e, undefined)).toEqual(e);
  });
});

// ---- per provider: stamp on create, scope on every read path ----

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const googleItem = (id: string, priv: Record<string, string>) => ({
  id,
  summary: id,
  start: { dateTime: "2026-07-06T09:00:00Z" },
  end: { dateTime: "2026-07-06T10:00:00Z" },
  extendedProperties: { private: priv },
});

const graphItem = (id: string, priv: Record<string, string>) => ({
  id,
  subject: id,
  showAs: "busy",
  isCancelled: false,
  isAllDay: false,
  start: { dateTime: "2026-07-06T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-07-06T10:00:00.0000000", timeZone: "UTC" },
  singleValueExtendedProperties: Object.entries(priv).map(([k, v]) => ({ id: graphPropId(k), value: v })),
});

const OWN = { [SCHEDULER_CHUNK_ID_KEY]: "own#0", [OPTICAL_DEPLOYMENT_KEY]: ME };
const LEGACY = { [SCHEDULER_CHUNK_ID_KEY]: "legacy#0" };
const FOREIGN = { [SCHEDULER_CHUNK_ID_KEY]: "foreign#0", [OPTICAL_DEPLOYMENT_KEY]: OTHER };

interface WireFixture {
  name: string;
  build(fetchFn: typeof fetch): CalendarProvider;
  listResponse(): Response;
  incrementalResponse(): Response;
  getResponse(): Response;
  createResponse(): Response;
  /** Pull the private metadata the provider sent on create. */
  sentMetadata(body: Record<string, unknown>): Record<string, string>;
}

const google: WireFixture = {
  name: "GoogleCalendarProvider",
  build: (fetchFn) =>
    new GoogleCalendarProvider({ calendarId: "primary", getAccessToken: async () => "t", fetch: fetchFn, deploymentId: ME }),
  listResponse: () =>
    json({ items: [googleItem("own", OWN), googleItem("legacy", LEGACY), googleItem("foreign", FOREIGN)], nextSyncToken: "s" }),
  incrementalResponse: () =>
    json({ items: [googleItem("own", OWN), googleItem("legacy", LEGACY), googleItem("foreign", FOREIGN)], nextSyncToken: "s2" }),
  getResponse: () => json(googleItem("foreign", FOREIGN)),
  createResponse: () => json({ id: "new-1" }),
  sentMetadata: (body) => (body.extendedProperties as { private: Record<string, string> }).private,
};

const microsoft: WireFixture = {
  name: "MicrosoftCalendarProvider",
  build: (fetchFn) =>
    new MicrosoftCalendarProvider({
      getAccessToken: async () => "t",
      fetch: fetchFn,
      now: () => new Date("2026-07-06T00:00:00Z"),
      deploymentId: ME,
    }),
  listResponse: () =>
    json({
      value: [graphItem("own", OWN), graphItem("legacy", LEGACY), graphItem("foreign", FOREIGN)],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final",
    }),
  incrementalResponse: () =>
    json({
      value: [graphItem("own", OWN), graphItem("legacy", LEGACY), graphItem("foreign", FOREIGN)],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-next",
    }),
  getResponse: () => json(graphItem("foreign", FOREIGN)),
  createResponse: () => json({ id: "new-1" }),
  sentMetadata: (body) =>
    Object.fromEntries(
      (body.singleValueExtendedProperties as Array<{ id: string; value: string }>).map((p) => [
        p.id.replace(graphPropId(""), ""),
        p.value,
      ]),
    ),
};

function chunkIds(events: CalendarEvent[]): Record<string, string | undefined> {
  return Object.fromEntries(events.map((e) => [e.id, e.extendedProperties.private?.[SCHEDULER_CHUNK_ID_KEY]]));
}

describe.each([google, microsoft])("deployment scoping: $name", (fx) => {
  it("stamps this deployment's origin on every created event", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fx.createResponse());
    const p = fx.build(fetchFn as unknown as typeof fetch);
    await p.createEvent(
      { id: "", summary: "Deep", start: "2026-07-06T09:00:00Z", end: "2026-07-06T10:00:00Z", extendedProperties: {} },
      { [SCHEDULER_CHUNK_ID_KEY]: "t#0" },
    );
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(fx.sentMetadata(body)).toEqual({ [SCHEDULER_CHUNK_ID_KEY]: "t#0", [OPTICAL_DEPLOYMENT_KEY]: ME });
  });

  it("exposes its deployment id", () => {
    expect(fx.build(vi.fn() as unknown as typeof fetch).deploymentId).toBe(ME);
  });

  it.each([{ syncToken: true }, { syncToken: false }])(
    "fetchEventsInWindow(%o) strips another deployment's chunk tag, keeps own and legacy",
    async (opts) => {
      const fetchFn = vi.fn().mockResolvedValueOnce(fx.listResponse());
      const p = fx.build(fetchFn as unknown as typeof fetch);
      const r = await p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", opts);
      expect(chunkIds(r.events)).toEqual({ own: "own#0", legacy: "legacy#0", foreign: undefined });
      // The foreign event still reads as busy time.
      expect(r.events.map((e) => e.id)).toContain("foreign");
    },
  );

  it("fetchIncrementalChanges strips another deployment's chunk tag", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fx.incrementalResponse());
    const p = fx.build(fetchFn as unknown as typeof fetch);
    const r = await p.fetchIncrementalChanges("https://graph.microsoft.com/v1.0/delta-prev");
    const events = r.changes.flatMap((c) => (c.kind === "upsert" ? [c.event] : []));
    expect(chunkIds(events)).toEqual({ own: "own#0", legacy: "legacy#0", foreign: undefined });
  });

  it("getEvent strips another deployment's chunk tag", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fx.getResponse());
    const p = fx.build(fetchFn as unknown as typeof fetch);
    const got = await p.getEvent("foreign");
    expect(got?.extendedProperties.private?.[SCHEDULER_CHUNK_ID_KEY]).toBeUndefined();
    expect(got?.extendedProperties.private?.[OPTICAL_DEPLOYMENT_KEY]).toBe(OTHER);
  });
});

describe("MicrosoftCalendarProvider expands the deployment stamp on every read", () => {
  it.each([
    ["delta window", (p: CalendarProvider) => p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z")],
    ["plain window", (p: CalendarProvider) => p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", { syncToken: false })],
    ["getEvent", (p: CalendarProvider) => p.getEvent("e1")],
  ])("%s", async (_name, call) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      json({ ...graphItem("e1", {}), value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/d" }),
    );
    await call(microsoft.build(fetchFn as unknown as typeof fetch));
    const expand = new URL(String(fetchFn.mock.calls[0]![0])).searchParams.get("$expand");
    expect(expand).toContain(`id eq '${graphPropId(OPTICAL_DEPLOYMENT_KEY)}'`);
    expect(expand).toContain(`id eq '${graphPropId(SCHEDULER_CHUNK_ID_KEY)}'`);
  });
});

describe("MockCalendarProvider mirrors the real providers' scoping", () => {
  it("stamps on create and strips a foreign chunk on read", async () => {
    const mock = new MockCalendarProvider({
      deploymentId: ME,
      events: [ev("own", OWN), ev("legacy", LEGACY), ev("foreign", FOREIGN)],
    });
    const { eventId } = await mock.createEvent(
      { id: "", summary: "n", start: "2026-07-06T11:00:00Z", end: "2026-07-06T12:00:00Z", extendedProperties: {} },
      { [SCHEDULER_CHUNK_ID_KEY]: "new#0" },
    );
    const r = await mock.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    expect(chunkIds(r.events)).toEqual({ own: "own#0", legacy: "legacy#0", foreign: undefined, [eventId]: "new#0" });
    expect(r.events.find((e) => e.id === eventId)!.extendedProperties.private?.[OPTICAL_DEPLOYMENT_KEY]).toBe(ME);
    expect((await mock.getEvent("foreign"))!.extendedProperties.private?.[SCHEDULER_CHUNK_ID_KEY]).toBeUndefined();
  });
});

describe("provider factories stamp the deployment's OAUTH_ISSUER origin", () => {
  const issuerEnv = { ...env, OAUTH_ISSUER: "https://optical-a.example.com/" };
  const msEnv = {
    ...issuerEnv,
    MS_PROVIDER_ENABLED: "true",
    MICROSOFT_OAUTH_CLIENT_ID: "x",
    MICROSOFT_OAUTH_CLIENT_SECRET: "y",
  };

  it("defaultCalendarProvider (google)", async () => {
    expect((await defaultCalendarProvider(issuerEnv, "dg@example.com")).deploymentId).toBe(ME);
  });

  it("defaultCalendarProvider (microsoft)", async () => {
    await storeIdentityTokens(msEnv, "dm@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    const p = await defaultCalendarProvider(msEnv, "dm@example.com");
    expect(p).toBeInstanceOf(MicrosoftCalendarProvider);
    expect(p.deploymentId).toBe(ME);
  });

  it("defaultProviders (google and microsoft)", async () => {
    expect((await defaultProviders(issuerEnv, "dpg@example.com")).calendar.deploymentId).toBe(ME);
    await storeIdentityTokens(msEnv, "dpm@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    const { calendar } = await defaultProviders(msEnv, "dpm@example.com");
    expect(calendar).toBeInstanceOf(MicrosoftCalendarProvider);
    expect(calendar.deploymentId).toBe(ME);
  });
});
