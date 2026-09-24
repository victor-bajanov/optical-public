import { describe, it, expect } from "vitest";
import {
  toCalendarEventFromGraph, isBusyGraphEvent, isoZ, toGraphPatch,
  OPTICAL_DONE_CATEGORY, graphPropId, SCHEDULER_PROPERTY_GUID,
} from "../../src/providers/graph-event-mapping";

const base = {
  id: "AAMkAg1", subject: "Standup",
  start: { dateTime: "2026-07-06T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-07-06T09:30:00.0000000", timeZone: "UTC" },
  showAs: "busy", isCancelled: false, isAllDay: false, isOrganizer: true,
  organizer: { emailAddress: { address: "me@example.com" } },
};

describe("graph-event-mapping", () => {
  it("normalises Graph UTC datetimes to ISO-Z", () => {
    expect(isoZ("2026-07-06T09:00:00.0000000")).toBe("2026-07-06T09:00:00.000Z");
  });

  it("maps core fields", () => {
    const e = toCalendarEventFromGraph(base);
    expect(e).toMatchObject({
      id: "AAMkAg1", summary: "Standup",
      start: "2026-07-06T09:00:00.000Z", end: "2026-07-06T09:30:00.000Z",
      isAllDay: false, organizer: { email: "me@example.com", self: true },
    });
  });

  it("maps attendee response statuses to the internal enum", () => {
    const e = toCalendarEventFromGraph({
      ...base,
      attendees: [
        { type: "required", status: { response: "accepted" }, emailAddress: { address: "a@x.com" } },
        { type: "optional", status: { response: "tentativelyAccepted" }, emailAddress: { address: "b@x.com" } },
        { type: "required", status: { response: "declined" }, emailAddress: { address: "c@x.com" } },
        { type: "required", status: { response: "notResponded" }, emailAddress: { address: "d@x.com" } },
        { type: "required", status: { response: "none" }, emailAddress: { address: "e@x.com" } },
        { type: "resource", status: { response: "none" }, emailAddress: { address: "room@x.com" } },
      ],
    });
    expect(e.attendees).toEqual([
      { email: "a@x.com", responseStatus: "accepted", optional: false, resource: false, self: false },
      { email: "b@x.com", responseStatus: "tentative", optional: true, resource: false, self: false },
      { email: "c@x.com", responseStatus: "declined", optional: false, resource: false, self: false },
      { email: "d@x.com", responseStatus: "needsAction", optional: false, resource: false, self: false },
      { email: "e@x.com", responseStatus: "needsAction", optional: false, resource: false, self: false },
      { email: "room@x.com", responseStatus: "needsAction", optional: false, resource: true, self: false },
    ]);
  });

  it("marks the organizer's own attendee row self=true", () => {
    const e = toCalendarEventFromGraph({
      ...base,
      attendees: [{ type: "required", status: { response: "organizer" }, emailAddress: { address: "me@example.com" } }],
    });
    expect(e.attendees![0]).toMatchObject({ email: "me@example.com", self: true, responseStatus: "accepted" });
  });

  it("marks the organizer's own attendee row self=true even when Graph cases the addresses differently", () => {
    // organizer.emailAddress.address and the matching attendee row's address
    // can come back with different casing from Graph (e.g. mailbox-policy
    // capitalization) even though they denote the same mailbox.
    const e = toCalendarEventFromGraph({
      ...base,
      organizer: { emailAddress: { address: "Me@Example.com" } },
      attendees: [{ type: "required", status: { response: "organizer" }, emailAddress: { address: "me@example.com" } }],
    });
    expect(e.attendees![0]).toMatchObject({ email: "me@example.com", self: true });
  });

  it("surfaces singleValueExtendedProperties as extendedProperties.private", () => {
    const e = toCalendarEventFromGraph({
      ...base,
      singleValueExtendedProperties: [
        { id: graphPropId("scheduler_chunk_id"), value: "chunk-42" },
        { id: `String {${SCHEDULER_PROPERTY_GUID}} Name optical_meeting_task_id`, value: "task-7" },
        { id: "String {ffffffff-0000-0000-0000-000000000000} Name foreign", value: "ignored" },
      ],
    });
    expect(e.extendedProperties.private).toEqual({ scheduler_chunk_id: "chunk-42", optical_meeting_task_id: "task-7" });
  });

  it("maps the done category to colorId and cancellation to status", () => {
    const done = toCalendarEventFromGraph({ ...base, categories: [OPTICAL_DONE_CATEGORY, "Blue category"] });
    expect(done.colorId).toBe(OPTICAL_DONE_CATEGORY);
    const notDone = toCalendarEventFromGraph({ ...base, categories: ["Blue category"] });
    expect(notDone.colorId).toBeUndefined();
    expect(toCalendarEventFromGraph({ ...base, isCancelled: true }).status).toBe("cancelled");
  });

  it("maps showAs tentative to status tentative (so TENTATIVE_IS_BUSY can act on it)", () => {
    const tentative = toCalendarEventFromGraph({ ...base, showAs: "tentative" });
    expect(tentative.status).toBe("tentative");
    expect(tentative.eventType).toBeUndefined();

    const busy = toCalendarEventFromGraph({ ...base, showAs: "busy" });
    expect(busy.status).toBe("confirmed");
    expect(busy.eventType).toBeUndefined();
  });

  it("does NOT map showAs oof to eventType outOfOffice: Graph's oof is a per-appointment flag, not Google's whole-day event kind", () => {
    // busy-blocks.ts expands eventType:"outOfOffice" to block the WHOLE local
    // day (that's the Google semantics the field exists for) — a 30-minute
    // Graph appointment marked showAs:"oof" must stay a normal timed event
    // (still busy, via isBusyGraphEvent treating oof as busy), not silently
    // wipe the rest of the day.
    const oof = toCalendarEventFromGraph({ ...base, showAs: "oof" });
    expect(oof.eventType).toBeUndefined();
    expect(oof.status).toBe("confirmed");
    expect(isBusyGraphEvent({ ...base, showAs: "oof" })).toBe(true);
  });

  it("busy filter: showAs free is not busy; busy/tentative/oof are", () => {
    expect(isBusyGraphEvent({ ...base, showAs: "free" })).toBe(false);
    expect(isBusyGraphEvent({ ...base, showAs: "workingElsewhere" })).toBe(false);
    for (const s of ["busy", "tentative", "oof"]) expect(isBusyGraphEvent({ ...base, showAs: s })).toBe(true);
  });

  it("all-day events pass midnight bounds through", () => {
    const e = toCalendarEventFromGraph({
      ...base, isAllDay: true,
      start: { dateTime: "2026-07-06T00:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-07-07T00:00:00.0000000", timeZone: "UTC" },
    });
    expect(e.isAllDay).toBe(true);
    expect(e.start).toBe("2026-07-06T00:00:00.000Z");
  });

  describe("toGraphPatch colorId translation", () => {
    it("colorId === OPTICAL_DONE_CATEGORY sets categories to the done category", () => {
      expect(toGraphPatch({ colorId: OPTICAL_DONE_CATEGORY })).toEqual({
        categories: [OPTICAL_DONE_CATEGORY],
      });
    });

    it('colorId === "" explicitly clears categories', () => {
      expect(toGraphPatch({ colorId: "" })).toEqual({ categories: [] });
    });

    it("any other colorId (e.g. a Google-style numeric colorId with no Graph meaning) omits categories entirely", () => {
      expect(toGraphPatch({ colorId: "11" })).toEqual({});
      const withOtherFields = toGraphPatch({ summary: "x", colorId: "11" });
      expect(withOtherFields).toEqual({ subject: "x" });
      expect(withOtherFields).not.toHaveProperty("categories");
    });
  });
});
