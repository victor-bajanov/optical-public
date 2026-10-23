import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import { graphPropId } from "../../src/providers/graph-event-mapping";
import { syncOwnedMeetings } from "../../src/meetings/sync";

// Graph returns ONLY the singleValueExtendedProperties named in a read's
// $expand filter. A tag missing from that list is invisible on Outlook: a
// poll-booked meeting (optical_poll_id) was imported as an owned movable
// meeting and could be relocated, and booking decline auto-cancel never saw
// optical_booking on its own events.
const EXPECTED = [
  "scheduler_chunk_id",
  "optical_meeting_task_id",
  "optical_deployment",
  "optical_poll_id",
  "optical_booking",
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The property names a request's $expand filter asks Graph for. */
function expandedNames(url: string): string[] {
  const expand = new URL(url).searchParams.get("$expand") ?? "";
  return [...expand.matchAll(/id eq '([^']+)'/g)].map((m) => m[1]!.replace(graphPropId(""), ""));
}

/** A Graph fake that honours $expand the way Graph does: an event's stored
 *  named properties come back only when the request names them. */
function graphFake(stored: Array<{ id: string; props: Record<string, string>; raw: Record<string, unknown> }>) {
  return vi.fn(async (url: string) => {
    const names = new Set(expandedNames(url));
    const shape = (e: (typeof stored)[number]) => ({
      ...e.raw,
      id: e.id,
      singleValueExtendedProperties: Object.entries(e.props)
        .filter(([k]) => names.has(k))
        .map(([k, v]) => ({ id: graphPropId(k), value: v })),
    });
    if (url.includes("/me/events/")) return json(shape(stored[0]!));
    return json({ value: stored.map(shape), "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final" });
  });
}

const build = (fetchFn: unknown) =>
  new MicrosoftCalendarProvider({
    getAccessToken: async () => "t",
    fetch: fetchFn as typeof fetch,
    now: () => new Date("2026-07-06T00:00:00Z"),
  });

describe("MicrosoftCalendarProvider expands every Optical private property", () => {
  it.each([
    ["delta window", (p: CalendarProvider) => p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z")],
    ["plain window", (p: CalendarProvider) => p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", { syncToken: false })],
    ["getEvent", (p: CalendarProvider) => p.getEvent("e1")],
  ])("%s pins the full list", async (_name, call) => {
    const fetchFn = vi.fn().mockResolvedValue(
      json({ id: "e1", value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/d" }),
    );
    await call(build(fetchFn));
    expect(expandedNames(String(fetchFn.mock.calls[0]![0])).sort()).toEqual([...EXPECTED].sort());
  });

  it("surfaces optical_booking on getEvent (decline auto-cancel's re-verify)", async () => {
    const p = build(graphFake([{
      id: "bk1",
      props: { optical_booking: "booking-1" },
      raw: {
        subject: "Booked", showAs: "busy", isCancelled: false, isAllDay: false,
        start: { dateTime: "2026-07-07T01:00:00.0000000" }, end: { dateTime: "2026-07-07T01:30:00.0000000" },
      },
    }]));
    expect((await p.getEvent("bk1"))?.extendedProperties.private?.optical_booking).toBe("booking-1");
  });
});

describe("an Outlook poll-booked meeting is never imported as an owned movable meeting", () => {
  const OWNER = "organiser@example.com";

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("is excluded end to end: Graph read through the provider, then the meeting sync", async () => {
    const meeting = (id: string, props: Record<string, string>) => ({
      id,
      props,
      raw: {
        subject: id,
        showAs: "busy",
        isCancelled: false,
        isAllDay: false,
        isOrganizer: true,
        organizer: { emailAddress: { address: OWNER } },
        attendees: [
          { type: "required", status: { response: "accepted" }, emailAddress: { address: "guest@example.com" } },
        ],
        start: { dateTime: "2026-07-07T01:00:00.0000000" },
        end: { dateTime: "2026-07-07T02:00:00.0000000" },
      },
    });
    const p = build(graphFake([meeting("poll-booked", { optical_poll_id: "poll-1" }), meeting("plain", {})]));
    const { events } = await p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    await syncOwnedMeetings(
      env.DB, p, OWNER, events,
      Date.parse("2026-07-06T00:00:00Z"), Date.parse("2026-07-13T00:00:00Z"),
      { churnMultiplierCap: 20 },
    );
    const { results } = await env.DB
      .prepare("SELECT json_extract(body, '$.source.external_id') AS ext FROM tasks WHERE owner_subject = ?")
      .bind(OWNER)
      .all<{ ext: string }>();
    expect(results.map((r) => r.ext)).toEqual(["plain"]);
  });
});
