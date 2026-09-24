import { describe, it, expect, vi } from "vitest";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import { GoogleCalendarProvider } from "../../src/providers/google-calendar-provider";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { graphPropId } from "../../src/providers/graph-event-mapping";

// One behavioural scenario — a busy timed event (one accepted + one declined
// attendee, stamped with scheduler_chunk_id), a transparent/free event, and an
// all-day event — translated into each provider's native wire format and fed
// through fetchEventsInWindow via an injected fetch. Both providers must
// normalise to the same shape: this is the contract build-problem.ts relies on.
const CHUNK_ID = "chunk-42";
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Fixture {
  name: string;
  buildProvider(fetchImpl: typeof fetch): CalendarProvider;
  windowResponse: Response;
  /** Expected `defaultDoneColorId`: the provider-shaped floor under
   *  `users.done_color_id` / `env.DONE_COLOR_ID` (see getDoneColorId callers).
   *  Google omits it (env default stays authoritative); Microsoft floors on
   *  its "Optical Done" category, since a numeric Google colorId is
   *  meaningless for Outlook categories. */
  expectedDefaultDoneColorId: string | undefined;
}

const googleFixture: Fixture = {
  name: "GoogleCalendarProvider",
  buildProvider: (fetchImpl) =>
    new GoogleCalendarProvider({ calendarId: "primary", getAccessToken: async () => "tok", fetch: fetchImpl }),
  expectedDefaultDoneColorId: undefined,
  windowResponse: json({
    items: [
      {
        id: "evt-busy",
        summary: "Standup",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
        extendedProperties: { private: { scheduler_chunk_id: CHUNK_ID } },
        attendees: [
          { email: "a@x.com", responseStatus: "accepted" },
          { email: "b@x.com", responseStatus: "declined" },
        ],
      },
      {
        id: "evt-free",
        summary: "Free block",
        start: { dateTime: "2026-07-06T11:00:00Z" },
        end: { dateTime: "2026-07-06T11:30:00Z" },
        transparency: "transparent",
      },
      {
        id: "evt-allday",
        summary: "Offsite",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      },
    ],
    nextSyncToken: "google-sync-abc",
  }),
};

const microsoftFixture: Fixture = {
  name: "MicrosoftCalendarProvider",
  buildProvider: (fetchImpl) => new MicrosoftCalendarProvider({ getAccessToken: async () => "tok", fetch: fetchImpl }),
  expectedDefaultDoneColorId: "Optical Done",
  windowResponse: json({
    value: [
      {
        id: "evt-busy",
        subject: "Standup",
        showAs: "busy",
        isCancelled: false,
        isAllDay: false,
        start: { dateTime: "2026-07-06T09:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-07-06T09:30:00.0000000", timeZone: "UTC" },
        attendees: [
          { type: "required", status: { response: "accepted" }, emailAddress: { address: "a@x.com" } },
          { type: "required", status: { response: "declined" }, emailAddress: { address: "b@x.com" } },
        ],
        singleValueExtendedProperties: [{ id: graphPropId("scheduler_chunk_id"), value: CHUNK_ID }],
      },
      {
        id: "evt-free",
        subject: "Free block",
        showAs: "free",
        isCancelled: false,
        isAllDay: false,
        start: { dateTime: "2026-07-06T11:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-07-06T11:30:00.0000000", timeZone: "UTC" },
      },
      {
        id: "evt-allday",
        subject: "Offsite",
        showAs: "busy",
        isCancelled: false,
        isAllDay: true,
        start: { dateTime: "2026-07-08T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-07-09T00:00:00.0000000", timeZone: "UTC" },
      },
    ],
    "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final",
  }),
};

describe.each([googleFixture, microsoftFixture])("provider contract: $name", (fixture) => {
  async function fetchWindow() {
    const fetchFn = vi.fn().mockResolvedValueOnce(fixture.windowResponse.clone());
    const provider = fixture.buildProvider(fetchFn as unknown as typeof fetch);
    return provider.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
  }

  it("filters the transparent/free event, keeping the busy and all-day events", async () => {
    const r = await fetchWindow();
    expect(r.events).toHaveLength(2);
    expect(r.events.map((e) => e.id).sort()).toEqual(["evt-allday", "evt-busy"]);
  });

  it("returns ISO-Z start/end strings for every event", async () => {
    const r = await fetchWindow();
    for (const e of r.events) {
      expect(e.start).toMatch(ISO_Z);
      expect(e.end).toMatch(ISO_Z);
    }
  });

  it("maps attendee responseStatus to the shared enum", async () => {
    const r = await fetchWindow();
    const busy = r.events.find((e) => e.id === "evt-busy")!;
    expect(busy.attendees?.map((a) => a.responseStatus)).toEqual(["accepted", "declined"]);
  });

  it("surfaces scheduler_chunk_id under extendedProperties.private with the same value", async () => {
    const r = await fetchWindow();
    const busy = r.events.find((e) => e.id === "evt-busy")!;
    expect(busy.extendedProperties.private?.scheduler_chunk_id).toBe(CHUNK_ID);
  });

  it("marks the all-day event isAllDay === true", async () => {
    const r = await fetchWindow();
    const allDay = r.events.find((e) => e.id === "evt-allday")!;
    expect(allDay.isAllDay).toBe(true);
  });

  it("returns a non-empty nextSyncToken", async () => {
    const r = await fetchWindow();
    expect(r.nextSyncToken).toBeTruthy();
  });

  it("exposes the provider-shaped defaultDoneColorId floor", () => {
    const provider = fixture.buildProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.defaultDoneColorId).toBe(fixture.expectedDefaultDoneColorId);
  });

  it("accepts { syncToken: false } without changing the mapped event shape", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fixture.windowResponse.clone());
    const provider = fixture.buildProvider(fetchFn as unknown as typeof fetch);
    const r = await provider.fetchEventsInWindow(
      "2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", { syncToken: false },
    );
    expect(r.events.map((e) => e.id).sort()).toEqual(["evt-allday", "evt-busy"]);
  });
});
