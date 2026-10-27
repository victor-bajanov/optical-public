import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GoogleCalendarProvider,
  GOOGLE_EVENT_ITEM_FIELDS,
} from "../../src/providers/google-calendar-provider";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, init);
  });
}

describe("GoogleCalendarProvider.fetchEventsInWindow", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requests timeMin/timeMax and parses Google response into CalendarEvent[]", async () => {
    const fetchFn = mockFetch(async (url) => {
      expect(url).toContain("calendars/primary/events");
      expect(url).toContain("timeMin=2026-05-18T00%3A00%3A00.000Z");
      expect(url).toContain("timeMax=2026-05-25T00%3A00%3A00.000Z");
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "g1",
              summary: "Meeting",
              start: { dateTime: "2026-05-19T09:00:00Z" },
              end: { dateTime: "2026-05-19T10:00:00Z" },
              extendedProperties: { private: { scheduler_chunk_id: "chunk-1" } },
            },
          ],
          nextSyncToken: "tok-after",
        }),
        { status: 200 },
      );
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "fake-token",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev.id).toBe("g1");
    expect(ev.extendedProperties.private?.scheduler_chunk_id).toBe("chunk-1");
    expect(r.nextSyncToken).toBe("tok-after");
  });

  it("paginates through pageToken until exhausted", async () => {
    let call = 0;
    const fetchFn = mockFetch(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "a",
                summary: "a",
                start: { dateTime: "2026-05-19T09:00:00Z" },
                end: { dateTime: "2026-05-19T10:00:00Z" },
              },
            ],
            nextPageToken: "p2",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "b",
              summary: "b",
              start: { dateTime: "2026-05-19T11:00:00Z" },
              end: { dateTime: "2026-05-19T12:00:00Z" },
            },
          ],
          nextSyncToken: "final-tok",
        }),
        { status: 200 },
      );
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(r.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(r.nextSyncToken).toBe("final-tok");
    expect(call).toBe(2);
  });

  it("on 401 refreshes token and retries once", async () => {
    let call = 0;
    const fetchFn = mockFetch(async () => {
      call++;
      if (call === 1) return new Response("", { status: 401 });
      return new Response(JSON.stringify({ items: [], nextSyncToken: "tok" }), { status: 200 });
    });
    const tokenCalls: boolean[] = [];
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async (opts) => {
        tokenCalls.push(!!opts?.forceRefresh);
        return "t";
      },
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(r.events).toEqual([]);
    expect(tokenCalls).toEqual([false, true]);
    expect(call).toBe(2);
  });
});

describe("GoogleCalendarProvider.fetchIncrementalChanges", () => {
  it("returns upserts and deletes with the new sync token", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("syncToken=tok-1");
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "a",
              summary: "ok",
              start: { dateTime: "2026-05-19T09:00:00Z" },
              end: { dateTime: "2026-05-19T10:00:00Z" },
            },
            { id: "b", status: "cancelled" },
          ],
          nextSyncToken: "tok-2",
        }),
        { status: 200 },
      );
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchIncrementalChanges("tok-1");
    expect(r.changes).toEqual([
      { kind: "upsert", event: expect.objectContaining({ id: "a" }) },
      { kind: "delete", eventId: "b" },
    ]);
    expect(r.nextSyncToken).toBe("tok-2");
    expect(r.syncTokenInvalidated).toBe(false);
  });

  it("flags syncTokenInvalidated on 410 Gone", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 410 } }), { status: 410 }),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchIncrementalChanges("dead-tok");
    expect(r.syncTokenInvalidated).toBe(true);
    expect(r.changes).toEqual([]);
    expect(r.nextSyncToken).toBe("");
  });
});

describe("GoogleCalendarProvider.subscribeToChanges", () => {
  it("POSTs /watch with a UUID channel id and the supplied token", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/watch");
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.type).toBe("web_hook");
      expect(body.address).toBe("https://w.example.com/v1/webhook/google-calendar");
      expect(body.token).toBe("secret-tok");
      expect(typeof body.id).toBe("string");
      return new Response(
        JSON.stringify({
          id: body.id,
          resourceId: "res-1",
          expiration: String(Date.now() + 7 * 86400_000),
        }),
        { status: 200 },
      );
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const sub = await p.subscribeToChanges(
      "https://w.example.com/v1/webhook/google-calendar",
      "secret-tok",
    );
    expect(sub.channelToken).toBe("secret-tok");
    expect(sub.resourceId).toBe("res-1");
    expect(Date.parse(sub.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("GoogleCalendarProvider.stopChannel", () => {
  it("stopChannel POSTs id + resourceId to the channels/stop endpoint", async () => {
    const calls: { url: string; body: unknown; auth: string | undefined }[] = [];
    const fetchFn = mockFetch(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        body: JSON.parse((init?.body as string) ?? "{}"),
        auth: headers.Authorization,
      });
      return new Response("{}", { status: 200 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "test-token",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.stopChannel("chan-123", "res-456");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/channels/stop");
    expect(calls[0]!.body).toEqual({ id: "chan-123", resourceId: "res-456" });
    expect(calls[0]!.auth).toBe("Bearer test-token");
  });

  it("throws on a hard error (e.g. 500)", async () => {
    const fetchFn = mockFetch(async () => new Response("nope", { status: 500 }));
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(p.stopChannel("c", "r")).rejects.toThrow();
  });

  it("tolerates 404 and 410 without throwing", async () => {
    for (const status of [404, 410]) {
      const fetchFn = mockFetch(async () => new Response("{}", { status }));
      const p = new GoogleCalendarProvider({
        calendarId: "primary",
        getAccessToken: async () => "t",
        fetch: fetchFn as unknown as typeof fetch,
      });
      await expect(p.stopChannel("c", "r")).resolves.toBeUndefined();
    }
  });
});

describe("GoogleCalendarProvider free/busy filtering", () => {
  it("fetchEventsInWindow excludes a transparent all-day workingLocation 'Home' event", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "wl-1",
              summary: "Home",
              eventType: "workingLocation",
              transparency: "transparent",
              start: { date: "2026-06-01" },
              end: { date: "2026-06-02" },
            },
          ],
          nextSyncToken: "tok",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z");
    expect(r.events.find((e) => e.id === "wl-1")).toBeUndefined();
    expect(r.events).toHaveLength(0);
  });

  it("fetchEventsInWindow excludes a transparent timed event", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "free-1",
              summary: "Lunch (free)",
              transparency: "transparent",
              start: { dateTime: "2026-06-01T12:00:00Z" },
              end: { dateTime: "2026-06-01T13:00:00Z" },
            },
          ],
          nextSyncToken: "tok",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z");
    expect(r.events.find((e) => e.id === "free-1")).toBeUndefined();
    expect(r.events).toHaveLength(0);
  });

  it("fetchEventsInWindow includes an opaque timed event and excludes a transparent one in a mixed batch", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "busy-1",
              summary: "Team meeting",
              start: { dateTime: "2026-06-01T09:00:00Z" },
              end: { dateTime: "2026-06-01T10:00:00Z" },
            },
            {
              id: "free-2",
              summary: "Office",
              eventType: "workingLocation",
              transparency: "transparent",
              start: { date: "2026-06-01" },
              end: { date: "2026-06-02" },
            },
          ],
          nextSyncToken: "tok",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z");
    expect(r.events.map((e) => e.id)).toEqual(["busy-1"]);
  });

  it("fetchEventsInWindow keeps opaque outOfOffice and focusTime events as busy", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "ooo-1",
              summary: "Out of office",
              eventType: "outOfOffice",
              start: { dateTime: "2026-06-01T09:00:00Z" },
              end: { dateTime: "2026-06-01T17:00:00Z" },
            },
            {
              id: "focus-1",
              summary: "Focus time",
              eventType: "focusTime",
              transparency: "opaque",
              start: { dateTime: "2026-06-02T14:00:00Z" },
              end: { dateTime: "2026-06-02T16:00:00Z" },
            },
          ],
          nextSyncToken: "tok",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z");
    expect(r.events.map((e) => e.id)).toEqual(["ooo-1", "focus-1"]);
  });

  it("fetchIncrementalChanges does not emit upsert for a transparent workingLocation event, still emits upsert for normal event and delete for cancelled", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "normal-1",
              summary: "Meeting",
              start: { dateTime: "2026-06-02T10:00:00Z" },
              end: { dateTime: "2026-06-02T11:00:00Z" },
            },
            {
              id: "wl-2",
              summary: "Home",
              eventType: "workingLocation",
              transparency: "transparent",
              start: { date: "2026-06-02" },
              end: { date: "2026-06-03" },
            },
            { id: "deleted-1", status: "cancelled" },
          ],
          nextSyncToken: "tok-next",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchIncrementalChanges("tok-1");
    expect(r.changes).toEqual([
      { kind: "upsert", event: expect.objectContaining({ id: "normal-1" }) },
      { kind: "delete", eventId: "deleted-1" },
    ]);
    expect(r.changes.find((c) => c.kind === "upsert" && c.event.id === "wl-2")).toBeUndefined();
  });

  it("maps status, eventType, and isAllDay onto the CalendarEvent", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "ooo-allday",
              summary: "Out of office",
              eventType: "outOfOffice",
              status: "confirmed",
              start: { date: "2026-06-03" },
              end: { date: "2026-06-04" },
            },
            {
              id: "timed-confirmed",
              summary: "Meeting",
              status: "confirmed",
              start: { dateTime: "2026-06-03T01:00:00Z" },
              end: { dateTime: "2026-06-03T02:00:00Z" },
            },
          ],
          nextSyncToken: "tok",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.fetchEventsInWindow("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z");
    const ooo = r.events.find((e) => e.id === "ooo-allday")!;
    expect(ooo.eventType).toBe("outOfOffice");
    expect(ooo.status).toBe("confirmed");
    expect(ooo.isAllDay).toBe(true);
    const timed = r.events.find((e) => e.id === "timed-confirmed")!;
    expect(timed.isAllDay).toBe(false);
    expect(timed.status).toBe("confirmed");
    expect(timed.eventType).toBeUndefined();
  });
});

describe("GoogleCalendarProvider.updateEvent colorId", () => {
  it("updateEvent patches colorId when provided", async () => {
    let captured: { method?: string; body?: any } = {};
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { method: init?.method, body: JSON.parse((init?.body as string) ?? "{}") };
      return new Response(JSON.stringify({ id: "evt1" }), { status: 200 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.updateEvent("evt1", { colorId: "11" });
    expect(captured.method).toBe("PATCH");
    expect(captured.body.colorId).toBe("11");
  });
});

describe("GoogleCalendarProvider organizer, guestsCanModify, and attendees", () => {
  it("maps organizer.self, guestsCanModify and attendees from a Google event", async () => {
    const fetchFn = mockFetch(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "evt1",
              summary: "Standup",
              start: { dateTime: "2026-05-19T09:00:00+10:00" },
              end: { dateTime: "2026-05-19T09:30:00+10:00" },
              organizer: { email: "me@x.com", self: true },
              guestsCanModify: false,
              attendees: [
                { email: "a@x.com", responseStatus: "accepted" },
                { email: "room@x.com", responseStatus: "accepted", resource: true },
              ],
            },
          ],
          nextSyncToken: "tok",
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const { events } = await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(events[0]?.organizer?.self).toBe(true);
    expect(events[0]?.guestsCanModify).toBe(false);
    expect(events[0]?.attendees?.[1]?.resource).toBe(true);
  });
});

describe("GoogleCalendarProvider.queryFreeBusy", () => {
  it("queryFreeBusy posts items + window and maps busy / per-calendar errors", async () => {
    let captured: any;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          calendars: {
            "a@x.com": { busy: [{ start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:00:00Z" }] },
            "b@x.com": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "tok",
      fetch: fetchFn,
    });
    const res = await provider.queryFreeBusy(["a@x.com", "b@x.com"], {
      start: "2026-05-18T00:00:00Z",
      end: "2026-05-25T00:00:00Z",
    });
    expect(captured.items).toEqual([{ id: "a@x.com" }, { id: "b@x.com" }]);
    expect(captured.timeMin).toBe("2026-05-18T00:00:00.000Z");
    expect(res.get("a@x.com")).toEqual({
      busy: [{ start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:00:00Z" }],
    });
    expect(res.get("b@x.com")).toEqual({ error: "notFound" });
  });
});

describe("GoogleCalendarProvider.updateEvent sendUpdates", () => {
  it("updateEvent adds sendUpdates=all when notifyAttendees is true", async () => {
    let capturedUrl = "";
    const fetchFn = (async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "tok",
      fetch: fetchFn,
    });
    await provider.updateEvent("evt1", { start: "2026-05-19T10:00:00Z", end: "2026-05-19T10:30:00Z" }, {
      notifyAttendees: true,
    });
    expect(capturedUrl).toContain("sendUpdates=all");
  });

  it("updateEvent omits sendUpdates by default", async () => {
    let capturedUrl = "";
    const fetchFn = (async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "tok",
      fetch: fetchFn,
    });
    await provider.updateEvent("evt1", { summary: "x" });
    expect(capturedUrl).not.toContain("sendUpdates");
  });
});

describe("GoogleCalendarProvider write ops", () => {
  it("createEvent posts to /events and merges scheduler metadata into extendedProperties.private", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toMatch(/\/events$/);
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.summary).toBe("Deep work");
      expect(body.extendedProperties.private.scheduler_chunk_id).toBe("chunk-42");
      expect(body.colorId).toBe("5");
      return new Response(JSON.stringify({ id: "g-new" }), { status: 200 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const r = await p.createEvent(
      {
        id: "",
        summary: "Deep work",
        start: "2026-05-19T09:00:00Z",
        end: "2026-05-19T10:30:00Z",
        // The chunk colour now comes from the caller (planning/commit.ts); the
        // provider no longer defaults it.
        colorId: "5",
        extendedProperties: {},
      },
      { scheduler_chunk_id: "chunk-42" },
    );
    expect(r.eventId).toBe("g-new");
  });

  it("createEvent omits colorId when the event carries none", async () => {
    let body: Record<string, unknown> = {};
    let capturedUrl = "";
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      body = JSON.parse((init?.body as string) ?? "{}");
      return new Response(JSON.stringify({ id: "g-new" }), { status: 200 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.createEvent(
      {
        id: "",
        summary: "Booking",
        start: "2026-05-19T09:00:00Z",
        end: "2026-05-19T09:30:00Z",
        extendedProperties: {},
      },
      {},
    );
    expect(body.colorId).toBeUndefined();
    expect(body.attendees).toBeUndefined();
    expect(body.conferenceData).toBeUndefined();
    // No options: the URL must stay the bare collection endpoint.
    expect(capturedUrl).toMatch(/\/events$/);
  });

  it("createEvent sends attendees, sendUpdates=all and a Meet conference request", async () => {
    let body: Record<string, unknown> = {};
    let capturedUrl = "";
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      body = JSON.parse((init?.body as string) ?? "{}");
      return new Response(JSON.stringify({ id: "g-book" }), { status: 200 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.createEvent(
      {
        id: "",
        summary: "Meeting with Sam",
        start: "2026-05-19T09:00:00Z",
        end: "2026-05-19T09:30:00Z",
        attendees: [{ email: "sam@x.com" }],
        extendedProperties: {},
      },
      { optical_booking: "b1" },
      { notifyAttendees: true, addMeet: true, conferenceRequestId: "b1" },
    );
    expect(capturedUrl).toContain("sendUpdates=all");
    expect(capturedUrl).toContain("conferenceDataVersion=1");
    expect(body.attendees).toEqual([{ email: "sam@x.com" }]);
    expect(body.conferenceData).toEqual({
      createRequest: {
        requestId: "b1",
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    });
    expect((body.extendedProperties as { private: Record<string, string> }).private
      .optical_booking).toBe("b1");
  });

  it("updateEvent PATCHes the event by id", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/events/evt-7");
      expect(init?.method).toBe("PATCH");
      return new Response("{}", { status: 200 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.updateEvent("evt-7", { start: "2026-05-19T11:00:00Z", end: "2026-05-19T12:00:00Z" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("deleteEvent DELETEs the event by id", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/events/evt-9");
      expect(init?.method).toBe("DELETE");
      return new Response("", { status: 204 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.deleteEvent("evt-9");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("GoogleCalendarProvider.deleteEvent notifyAttendees", () => {
  it("appends sendUpdates=all when notifyAttendees is true", async () => {
    let capturedUrl = "";
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      expect(init?.method).toBe("DELETE");
      return new Response("", { status: 204 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.deleteEvent("evt-10", { notifyAttendees: true });
    expect(capturedUrl).toContain("/events/evt-10");
    expect(capturedUrl).toContain("sendUpdates=all");
  });

  it("leaves the query string empty when notifyAttendees is absent or false", async () => {
    let capturedUrl = "";
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response("", { status: 204 });
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.deleteEvent("evt-11");
    expect(capturedUrl).toContain("/events/evt-11");
    expect(capturedUrl).not.toContain("sendUpdates");
    expect(capturedUrl).not.toContain("?");

    await p.deleteEvent("evt-12", { notifyAttendees: false });
    expect(capturedUrl).toContain("/events/evt-12");
    expect(capturedUrl).not.toContain("sendUpdates");
    expect(capturedUrl).not.toContain("?");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("tolerates 404 (already gone) the same as 410, without throwing", async () => {
    for (const status of [404, 410]) {
      const fetchFn = vi.fn(async () => new Response("", { status }));
      const p = new GoogleCalendarProvider({
        calendarId: "primary",
        getAccessToken: async () => "t",
        fetch: fetchFn as unknown as typeof fetch,
      });
      await expect(p.deleteEvent("evt-gone")).resolves.toBeUndefined();
    }
  });
});

describe("GoogleCalendarProvider.getEvent", () => {
  it("GETs the event by id and maps it through toCalendarEvent, preserving attendees and extendedProperties", async () => {
    let capturedUrl = "";
    let capturedMethod: string | undefined;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedMethod = init?.method;
      return new Response(
        JSON.stringify({
          id: "evt-20",
          summary: "Booking with Sam",
          start: { dateTime: "2026-05-19T09:00:00Z" },
          end: { dateTime: "2026-05-19T09:30:00Z" },
          extendedProperties: { private: { optical_booking: "b-1" } },
          attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
        }),
        { status: 200 },
      );
    });
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const ev = await p.getEvent("evt-20");
    expect(capturedUrl).toContain("/events/evt-20");
    expect(capturedMethod === undefined || capturedMethod === "GET").toBe(true);
    expect(ev).not.toBeNull();
    expect(ev?.id).toBe("evt-20");
    expect(ev?.extendedProperties.private?.optical_booking).toBe("b-1");
    expect(ev?.attendees).toEqual([
      {
        email: "sam@x.com",
        responseStatus: "declined",
        optional: undefined,
        resource: undefined,
        self: undefined,
      },
    ]);
  });

  it("returns the event, not null, when Google reports status:'cancelled' (e.g. a cancelled recurring instance)", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "evt-21",
          summary: "Booking with Sam",
          status: "cancelled",
          start: { dateTime: "2026-05-19T09:00:00Z" },
          end: { dateTime: "2026-05-19T09:30:00Z" },
        }),
        { status: 200 },
      ),
    );
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const ev = await p.getEvent("evt-21");
    expect(ev).not.toBeNull();
    expect(ev?.status).toBe("cancelled");
    expect(ev?.start).toBe("2026-05-19T09:00:00Z");
    expect(ev?.end).toBe("2026-05-19T09:30:00Z");
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 }));
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(p.getEvent("evt-gone")).resolves.toBeNull();
  });

  it("returns null on 410", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 410 }));
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(p.getEvent("evt-gone")).resolves.toBeNull();
  });

  it("throws on other non-2xx statuses", async () => {
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));
    const p = new GoogleCalendarProvider({
      calendarId: "primary",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(p.getEvent("evt-err")).rejects.toThrow();
  });
});

// Partial response (OAuth verification, data minimisation): every events read
// asks Google for only the fields the read mapper consumes. `fields` uses
// Google's partial-response syntax, so the tests below project fixtures through
// a small parser of that syntax, the way Google does, and check the mapped
// result is unchanged — i.e. the field list is sufficient.
type FieldTree = Map<string, FieldTree | null>;

/** Parse "a,b(c,d(e)),f" into a tree; a leaf (null) keeps the whole value. */
function parseFields(spec: string): FieldTree {
  let i = 0;
  const parseList = (): FieldTree => {
    const out: FieldTree = new Map();
    while (i < spec.length && spec[i] !== ")") {
      let name = "";
      while (i < spec.length && !",()".includes(spec[i]!)) name += spec[i++];
      let sub: FieldTree | null = null;
      if (spec[i] === "(") {
        i++;
        sub = parseList();
        if (spec[i] !== ")") throw new Error(`unbalanced fields: ${spec}`);
        i++;
      }
      if (!name) throw new Error(`empty field name in: ${spec}`);
      out.set(name, sub);
      if (spec[i] === ",") i++;
    }
    return out;
  };
  const tree = parseList();
  if (i !== spec.length) throw new Error(`trailing input in fields: ${spec}`);
  return tree;
}

function project(value: unknown, tree: FieldTree | null): unknown {
  if (tree === null || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => project(v, tree));
  const out: Record<string, unknown> = {};
  for (const [k, sub] of tree) {
    if (k in (value as Record<string, unknown>)) out[k] = project((value as Record<string, unknown>)[k], sub);
  }
  return out;
}

/** Every field Google can send on an event that the mappers might be tempted
 *  to read, plus fields that must never reach us (description/location). */
const FULL_GOOGLE_EVENT = {
  kind: "calendar#event",
  etag: '"3181"',
  id: "full-1",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=x",
  created: "2026-05-01T00:00:00Z",
  updated: "2026-05-02T00:00:00Z",
  summary: "Quarterly review",
  description: "Secret agenda: layoffs",
  location: "Board room 4",
  colorId: "5",
  creator: { email: "boss@example.com" },
  organizer: { email: "me@example.com", self: true, displayName: "Me" },
  start: { dateTime: "2026-05-19T09:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-05-19T10:00:00Z", timeZone: "UTC" },
  transparency: "opaque",
  visibility: "default",
  iCalUID: "full-1@google.com",
  sequence: 2,
  eventType: "default",
  guestsCanModify: false,
  hangoutLink: "https://meet.google.com/abc",
  conferenceData: { entryPoints: [{ uri: "https://meet.google.com/abc" }] },
  attendees: [
    { email: "me@example.com", responseStatus: "accepted", self: true, organizer: true, displayName: "Me" },
    { email: "a@example.com", responseStatus: "tentative", optional: true, comment: "maybe" },
    { email: "room@resource.calendar.google.com", responseStatus: "accepted", resource: true },
    { displayName: "no email" },
  ],
  extendedProperties: {
    private: { scheduler_chunk_id: "chunk-1", optical_deployment: "https://x.example" },
    shared: { s: "1" },
  },
  reminders: { useDefault: true },
};

const ALL_DAY_GOOGLE_EVENT = {
  id: "full-2",
  status: "confirmed",
  summary: "OOO",
  description: "beach",
  eventType: "outOfOffice",
  start: { date: "2026-05-20" },
  end: { date: "2026-05-21" },
};

const FREE_GOOGLE_EVENT = {
  id: "free-1",
  status: "confirmed",
  summary: "free",
  transparency: "transparent",
  start: { dateTime: "2026-05-19T11:00:00Z" },
  end: { dateTime: "2026-05-19T12:00:00Z" },
};

const CANCELLED_GOOGLE_EVENT = { id: "gone-1", status: "cancelled", summary: "x", description: "y" };

/** A Google fake that answers every events read with `body`, projected through
 *  the request's `fields` parameter when `honourFields` is set. */
function googleFake(body: Record<string, unknown>, honourFields: boolean) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const fields = url.searchParams.get("fields");
    const out = honourFields && fields ? project(body, parseFields(fields)) : body;
    return new Response(JSON.stringify(out), { status: 200 });
  });
}

const googleProvider = (fetchFn: unknown) =>
  new GoogleCalendarProvider({
    calendarId: "primary",
    getAccessToken: async () => "t",
    fetch: fetchFn as typeof fetch,
    deploymentId: "https://x.example",
  });

describe("GoogleCalendarProvider partial response (fields=)", () => {
  const listBody = {
    kind: "calendar#events",
    summary: "me@example.com",
    timeZone: "UTC",
    items: [FULL_GOOGLE_EVENT, ALL_DAY_GOOGLE_EVENT, FREE_GOOGLE_EVENT, CANCELLED_GOOGLE_EVENT],
    nextSyncToken: "tok-next",
  };

  it("exports the item field list and it parses as Google partial-response syntax", () => {
    const tree = parseFields(GOOGLE_EVENT_ITEM_FIELDS);
    expect([...tree.keys()].sort()).toEqual(
      [
        "id", "status", "summary", "start", "end", "colorId", "transparency", "eventType",
        "organizer", "guestsCanModify", "attendees", "extendedProperties",
      ].sort(),
    );
    expect([...tree.get("organizer")!.keys()].sort()).toEqual(["email", "self"]);
    expect([...tree.get("attendees")!.keys()].sort()).toEqual(
      ["email", "optional", "resource", "responseStatus", "self"],
    );
    // A leaf: the whole extendedProperties object (private + shared) comes back.
    expect(tree.get("extendedProperties")).toBeNull();
    expect(tree.has("description")).toBe(false);
    expect(tree.has("location")).toBe(false);
  });

  it("window list and incremental list carry fields with the page and sync tokens", async () => {
    const fetchFn = googleFake(listBody, false);
    const p = googleProvider(fetchFn);
    await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    await p.fetchIncrementalChanges("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const call of fetchFn.mock.calls) {
      const fields = new URL(call[0] as string).searchParams.get("fields");
      expect(fields).toBe(`nextPageToken,nextSyncToken,items(${GOOGLE_EVENT_ITEM_FIELDS})`);
      const tree = parseFields(fields!);
      expect(tree.has("nextPageToken")).toBe(true);
      expect(tree.has("nextSyncToken")).toBe(true);
    }
  });

  it("events.get carries the item field list without the items() wrapper", async () => {
    const fetchFn = googleFake(FULL_GOOGLE_EVENT, false);
    await googleProvider(fetchFn).getEvent("full-1");
    expect(new URL(fetchFn.mock.calls[0]![0] as string).searchParams.get("fields")).toBe(
      GOOGLE_EVENT_ITEM_FIELDS,
    );
  });

  it("maps an event carrying description/location to one with neither key", async () => {
    const ev = await googleProvider(googleFake(FULL_GOOGLE_EVENT, false)).getEvent("full-1");
    expect(ev).not.toBeNull();
    expect(Object.keys(ev!)).not.toContain("description");
    expect(Object.keys(ev!)).not.toContain("location");
  });

  it("sufficiency: window list maps identically from the full and the projected response", async () => {
    const full = await googleProvider(googleFake(listBody, false))
      .fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    const projected = await googleProvider(googleFake(listBody, true))
      .fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(full.events.map((e) => e.id)).toEqual(["full-1", "full-2", "gone-1"]);
    expect(projected).toEqual(full);
  });

  it("sufficiency: incremental list maps identically from the full and the projected response", async () => {
    const full = await googleProvider(googleFake(listBody, false)).fetchIncrementalChanges("tok-1");
    const projected = await googleProvider(googleFake(listBody, true)).fetchIncrementalChanges("tok-1");
    expect(full.changes.map((c) => c.kind)).toEqual(["upsert", "upsert", "delete"]);
    expect(projected).toEqual(full);
  });

  it("sufficiency: events.get maps identically from the full and the projected response", async () => {
    for (const ev of [FULL_GOOGLE_EVENT, ALL_DAY_GOOGLE_EVENT, CANCELLED_GOOGLE_EVENT]) {
      const full = await googleProvider(googleFake(ev, false)).getEvent(ev.id);
      const projected = await googleProvider(googleFake(ev, true)).getEvent(ev.id);
      expect(projected).toEqual(full);
    }
  });
});
