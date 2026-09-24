import { describe, it, expect, vi } from "vitest";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { OPTICAL_DONE_CATEGORY, graphPropId } from "../../src/providers/graph-event-mapping";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const graphEvent = (id: string, over: Record<string, unknown> = {}) => ({
  id, subject: `ev-${id}`, showAs: "busy", isCancelled: false, isAllDay: false,
  start: { dateTime: "2026-07-06T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-07-06T10:00:00.0000000", timeZone: "UTC" },
  ...over,
});

function provider(fetchImpl: ReturnType<typeof vi.fn>, now?: () => Date) {
  return new MicrosoftCalendarProvider({ getAccessToken: async () => "tok", fetch: fetchImpl as unknown as typeof fetch, now });
}

describe("MicrosoftCalendarProvider read paths", () => {
  it("fetchEventsInWindow pages calendarView/delta and returns the deltaLink as nextSyncToken", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ value: [graphEvent("e1")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page" }))
      .mockResolvedValueOnce(json({ value: [graphEvent("e2"), graphEvent("free1", { showAs: "free" })], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-token" }));
    const r = await provider(fetchFn).fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    expect(r.events.map((e) => e.id)).toEqual(["e1", "e2"]); // free event filtered
    expect(r.nextSyncToken).toBe("https://graph.microsoft.com/v1.0/delta-token");
    const firstUrl = fetchFn.mock.calls[0]![0] as string;
    expect(firstUrl).toContain("/me/calendarView/delta");
    // The delta window is the wide horizon, not the caller's week (see the
    // "delta horizon" block below) — the week is applied as a filter.
    expect(new URL(firstUrl).searchParams.get("startDateTime")! < "2026-07-06T00:00:00Z").toBe(true);
    const headers = new Headers((fetchFn.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("Prefer")).toContain('IdType="ImmutableId"');
    expect(headers.get("Prefer")).toContain('outlook.timezone="UTC"');
    expect(fetchFn.mock.calls[1]![0]).toBe("https://graph.microsoft.com/v1.0/next-page"); // nextLink followed verbatim
  });

  it("fetchEventsInWindow requests singleValueExtendedProperties via $expand on the initial delta URL", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ value: [], "@odata.deltaLink": "d" }));
    await provider(fetchFn).fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    const firstUrl = fetchFn.mock.calls[0]![0] as string;
    const expand = new URL(firstUrl).searchParams.get("$expand")!;
    expect(expand).toContain(`singleValueExtendedProperties($filter=`);
    expect(expand).toContain(graphPropId("scheduler_chunk_id"));
    expect(expand).toContain(graphPropId("optical_meeting_task_id"));
  });

  it("fetchEventsInWindow throws when the initial delta sync completes with no deltaLink", async () => {
    // A successful (non-410) response that never hands back @odata.deltaLink
    // leaves us with no way to continue polling — that must fail loudly, not
    // silently return a nextSyncToken of "" that callers would store and
    // treat as a usable (if empty) sync state.
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ value: [graphEvent("e1")] })); // no deltaLink
    await expect(
      provider(fetchFn).fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z"),
    ).rejects.toThrow("graph_delta_no_deltalink");
  });

  it("fetchEventsInWindow skips isCancelled events (only fetchIncrementalChanges should tombstone them)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [graphEvent("e1"), graphEvent("cancelled1", { isCancelled: true })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-cancel",
    }));
    const r = await provider(fetchFn).fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    expect(r.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("fetchIncrementalChanges maps upserts and @removed deletions", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [graphEvent("changed"), { id: "gone", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-2",
    }));
    const r = await provider(fetchFn).fetchIncrementalChanges("https://graph.microsoft.com/v1.0/delta-1");
    expect(r.changes).toEqual([
      expect.objectContaining({ kind: "upsert" }),
      { kind: "delete", eventId: "gone" },
    ]);
    expect(r.nextSyncToken).toBe("https://graph.microsoft.com/v1.0/delta-2");
    expect(r.syncTokenInvalidated).toBe(false);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://graph.microsoft.com/v1.0/delta-1"); // deltaLink used verbatim
  });

  it("fetchIncrementalChanges skips (and warns once) items with unparseable start/end instead of upserting", async () => {
    // A mapped event with "" start/end (e.g. Graph omitted start.dateTime)
    // would make downstream localWeekWindow("") abort the whole replan —
    // skip rather than upsert, and warn once per call, not once per item.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [
        graphEvent("bad1", { start: undefined, end: undefined }),
        graphEvent("bad2", { start: undefined, end: undefined }),
        graphEvent("good1"),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-guard",
    }));
    const r = await provider(fetchFn).fetchIncrementalChanges("https://graph.microsoft.com/v1.0/delta-1");
    expect(r.changes).toEqual([
      expect.objectContaining({ kind: "upsert", event: expect.objectContaining({ id: "good1" }) }),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("fetchIncrementalChanges treats a missing deltaLink as invalidated, forcing a full refetch", async () => {
    // Without a deltaLink there's no way to continue this incremental chain —
    // the same recovery path as an explicit 410 must kick in.
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ value: [graphEvent("e1")] })); // no deltaLink
    const r = await provider(fetchFn).fetchIncrementalChanges("https://graph.microsoft.com/v1.0/delta-1");
    expect(r).toEqual({ changes: [], nextSyncToken: "", syncTokenInvalidated: true });
  });

  it("fetchIncrementalChanges signals invalidation on 410", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ error: { code: "syncStateNotFound" } }, 410));
    const r = await provider(fetchFn).fetchIncrementalChanges("https://graph.microsoft.com/v1.0/delta-stale");
    expect(r).toEqual({ changes: [], nextSyncToken: "", syncTokenInvalidated: true });
  });

  it("retries once with forceRefresh on 401", async () => {
    const tokens: Array<{ forceRefresh?: boolean } | undefined> = [];
    const p = new MicrosoftCalendarProvider({
      getAccessToken: async (opts) => { tokens.push(opts); return "tok"; },
      fetch: vi.fn()
        .mockResolvedValueOnce(new Response("", { status: 401 }))
        .mockResolvedValueOnce(json({ value: [], "@odata.deltaLink": "d" })) as unknown as typeof fetch,
    });
    await p.fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    expect(tokens[1]).toEqual({ forceRefresh: true });
  });
});

describe("MicrosoftCalendarProvider write paths", () => {
  const newEvent = {
    id: "", summary: "Deep work", start: "2026-07-06T09:00:00.000Z", end: "2026-07-06T11:00:00.000Z",
    extendedProperties: { private: {} },
  };

  it("createEvent POSTs with transactionId, UTC times and scheduler metadata", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "created-1" }, 201));
    const r = await provider(fetchFn).createEvent(newEvent, { scheduler_chunk_id: "chunk-9" });
    expect(r).toEqual({ eventId: "created-1" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/events");
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe("Deep work");
    expect(body.start).toEqual({ dateTime: "2026-07-06T09:00:00.000Z", timeZone: "UTC" });
    expect(body.transactionId).toEqual(expect.any(String));
    expect(body.singleValueExtendedProperties).toContainEqual({ id: graphPropId("scheduler_chunk_id"), value: "chunk-9" });
  });

  it("createEvent generates a fresh transactionId per attempt, even for the same chunk", async () => {
    // A deleted-then-recreated chunk must not replay an id Graph already
    // consumed — the id is a create-attempt idempotency key, not a chunk key.
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "created-a" }, 201))
      .mockResolvedValueOnce(json({ id: "created-b" }, 201));
    const p = provider(fetchFn);
    await p.createEvent(newEvent, { scheduler_chunk_id: "chunk-9" });
    await p.createEvent(newEvent, { scheduler_chunk_id: "chunk-9" });
    const id1 = JSON.parse(fetchFn.mock.calls[0]![1].body as string).transactionId;
    const id2 = JSON.parse(fetchFn.mock.calls[1]![1].body as string).transactionId;
    expect(id1).not.toBe(id2);
  });

  it("createEvent maps attendees to Graph shape and enables Teams via addMeet", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "created-2" }, 201));
    const eventWithAttendees = {
      ...newEvent,
      attendees: [
        { email: "a@x.com" },
        { email: "b@x.com", optional: true },
      ],
    };
    await provider(fetchFn).createEvent(eventWithAttendees, {}, { addMeet: true });
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(body.attendees).toEqual([
      { emailAddress: { address: "a@x.com" }, type: "required" },
      { emailAddress: { address: "b@x.com" }, type: "optional" },
    ]);
    expect(body.isOnlineMeeting).toBe(true);
    expect(body.onlineMeetingProvider).toBe("teamsForBusiness");
  });

  it("createEvent omits attendees/online-meeting keys when there are none/not requested", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "created-3" }, 201));
    await provider(fetchFn).createEvent(newEvent, {});
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty("attendees");
    expect(body).not.toHaveProperty("isOnlineMeeting");
    expect(body).not.toHaveProperty("onlineMeetingProvider");
  });

  it("updateEvent PATCHes only provided fields; colorId becomes the done category, read-merged with existing categories", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ categories: ["Client X"] })) // GET current categories
      .mockResolvedValueOnce(json({ id: "e1" })); // PATCH
    await provider(fetchFn).updateEvent("e1", { start: "2026-07-07T09:00:00.000Z", end: "2026-07-07T10:00:00.000Z", colorId: OPTICAL_DONE_CATEGORY }, { notifyAttendees: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [getUrl] = fetchFn.mock.calls[0]!;
    expect(getUrl).toContain("/me/events/e1");
    expect(getUrl).toContain("$select=categories");
    const [patchUrl, patchInit] = fetchFn.mock.calls[1]!;
    expect(patchUrl).toBe("https://graph.microsoft.com/v1.0/me/events/e1");
    expect(patchInit.method).toBe("PATCH");
    const body = JSON.parse(patchInit.body as string);
    expect(body).toEqual({
      start: { dateTime: "2026-07-07T09:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-07-07T10:00:00.000Z", timeZone: "UTC" },
      categories: ["Client X", OPTICAL_DONE_CATEGORY],
    });
    // no sendUpdates analogue — Graph auto-notifies; the flag must be a no-op, not an error
  });

  it("clearing colorId read-merges: removes only the done marker, keeps other categories", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ categories: ["Client X", OPTICAL_DONE_CATEGORY] }))
      .mockResolvedValueOnce(json({ id: "e1" }));
    await provider(fetchFn).updateEvent("e1", { colorId: "" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchFn.mock.calls[1]![1].body as string);
    expect(body).toEqual({ categories: ["Client X"] });
  });

  it("updateEvent makes no categories GET when the patch carries no done-marker change", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "e1" }));
    await provider(fetchFn).updateEvent("e1", { summary: "New title" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/events/e1");
    expect(JSON.parse(init.body as string)).toEqual({ subject: "New title" });
  });

  it("deleteEvent treats 404 as success", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(provider(fetchFn).deleteEvent("gone")).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0]![1].method).toBe("DELETE");
  });

  it("declares undoneColorId as the empty-string category-clear sentinel", () => {
    // Microsoft's done marker is category set-membership, not a numeric color:
    // callers that undo done-ness must PATCH colorId:"" (clear), not fall back
    // to a Google-style CREATE_COLOR_ID that toGraphPatch would silently ignore.
    expect(provider(vi.fn()).undoneColorId).toBe("");
  });
});

describe("MicrosoftCalendarProvider queryFreeBusy", () => {
  const win = { start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z" };

  it("maps busy/tentative/oof items to busy intervals and free/workingElsewhere to none", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [{
        scheduleId: "a@x.com",
        scheduleItems: [
          { status: "busy", start: { dateTime: "2026-07-06T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-06T10:00:00.0000000", timeZone: "UTC" } },
          { status: "tentative", start: { dateTime: "2026-07-06T11:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-06T12:00:00.0000000", timeZone: "UTC" } },
          { status: "oof", start: { dateTime: "2026-07-07T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-07T17:00:00.0000000", timeZone: "UTC" } },
          { status: "free", start: { dateTime: "2026-07-08T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-08T10:00:00.0000000", timeZone: "UTC" } },
          { status: "workingElsewhere", start: { dateTime: "2026-07-09T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-09T10:00:00.0000000", timeZone: "UTC" } },
        ],
      }],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["a@x.com"], win);
    expect(out.get("a@x.com")).toEqual({
      busy: [
        { start: "2026-07-06T09:00:00.000Z", end: "2026-07-06T10:00:00.000Z" },
        { start: "2026-07-06T11:00:00.000Z", end: "2026-07-06T12:00:00.000Z" },
        { start: "2026-07-07T09:00:00.000Z", end: "2026-07-07T17:00:00.000Z" },
      ],
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/calendar/getSchedule");
    const body = JSON.parse(init.body as string);
    expect(body.schedules).toEqual(["a@x.com"]);
  });

  it("surfaces per-schedule errors as data (degrade-to-immovable feed)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [
        { scheduleId: "ok@x.com", scheduleItems: [] },
        { scheduleId: "private@x.com", error: { responseCode: "ErrorNoFreeBusyAccess", message: "denied" } },
      ],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["ok@x.com", "private@x.com", "missing@x.com"], win);
    expect(out.get("ok@x.com")).toEqual({ busy: [] });
    expect(out.get("private@x.com")).toEqual({ error: "ErrorNoFreeBusyAccess" });
    expect(out.get("missing@x.com")).toEqual({ error: "missing_in_response" });
  });

  it("derives busy from availabilityView when scheduleItems is absent (unknown/external mailbox)", async () => {
    // 0 free, 2 busy, 1 tentative, 4 workingElsewhere(free), 3 oof(busy) — 30-min slots from win.start.
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [{ scheduleId: "a@x.com", availabilityView: "02143" }],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["a@x.com"], win);
    expect(out.get("a@x.com")).toEqual({
      busy: [
        { start: "2026-07-06T00:30:00.000Z", end: "2026-07-06T01:00:00.000Z" },
        { start: "2026-07-06T01:00:00.000Z", end: "2026-07-06T01:30:00.000Z" },
        { start: "2026-07-06T02:00:00.000Z", end: "2026-07-06T02:30:00.000Z" },
      ],
    });
  });

  it("reports no_schedule_detail when neither scheduleItems nor availabilityView is present", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [{ scheduleId: "a@x.com" }],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["a@x.com"], win);
    expect(out.get("a@x.com")).toEqual({ error: "no_schedule_detail" });
  });

  it("derives busy from availabilityView even when scheduleItems is present but empty (availability-only sharing)", async () => {
    // Graph returns scheduleItems: [] (present, truthy-as-an-array, but no
    // detail) alongside a populated availabilityView for exactly the
    // availability-only / cross-tenant / personal-mailbox cases — the empty
    // array must not be mistaken for "readable, confirmed nothing busy".
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [{ scheduleId: "a@x.com", scheduleItems: [], availabilityView: "0220" }],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["a@x.com"], win);
    expect(out.get("a@x.com")).toEqual({
      busy: [
        { start: "2026-07-06T00:30:00.000Z", end: "2026-07-06T01:00:00.000Z" },
        { start: "2026-07-06T01:00:00.000Z", end: "2026-07-06T01:30:00.000Z" },
      ],
    });
  });

  it("still treats empty scheduleItems with no availabilityView as readable-free (today's contract, unaffected)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [{ scheduleId: "a@x.com", scheduleItems: [] }],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["a@x.com"], win);
    expect(out.get("a@x.com")).toEqual({ busy: [] });
  });

  it("floors availabilityView slot indexing to a 30-min boundary and clamps the last slot to window.end", async () => {
    // window.start at :15 must not shift every 30-min slot by 15 minutes —
    // index from the boundary at-or-before window.start.
    const offsetWin = { start: "2026-07-06T00:15:00Z", end: "2026-07-06T01:20:00Z" };
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      // idx0 00:00-00:30 free, idx1 00:30-01:00 busy, idx2 01:00-01:30 busy (clamped to window.end)
      value: [{ scheduleId: "a@x.com", availabilityView: "022" }],
    }));
    const out = await provider(fetchFn).queryFreeBusy(["a@x.com"], offsetWin);
    expect(out.get("a@x.com")).toEqual({
      busy: [
        { start: "2026-07-06T00:30:00.000Z", end: "2026-07-06T01:00:00.000Z" },
        { start: "2026-07-06T01:00:00.000Z", end: "2026-07-06T01:20:00.000Z" },
      ],
    });
  });

  it("chunks >20 schedules into multiple calls and marks whole-batch failures", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `u${i}@x.com`);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ value: ids.slice(0, 20).map((s) => ({ scheduleId: s, scheduleItems: [] })) }))
      .mockResolvedValueOnce(new Response("boom", { status: 403 }));
    const out = await provider(fetchFn).queryFreeBusy(ids, win);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.get("u0@x.com")).toEqual({ busy: [] });
    expect(out.get("u24@x.com")).toEqual({ error: "freebusy_http_403" });
  });

  it("issues getSchedule batches concurrently (Promise.all), not sequentially", async () => {
    let resolveFirst!: (r: Response) => void;
    const pending = new Promise<Response>((res) => { resolveFirst = res; });
    const fetchFn = vi.fn()
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(async () => json({ value: [] }));
    const ids = Array.from({ length: 25 }, (_, i) => `u${i}@x.com`);
    const resultPromise = provider(fetchFn).queryFreeBusy(ids, win);
    // Flush microtasks (the token warm-up call, then getAccessToken await +
    // the fetch call itself for both batches) without letting the first
    // fetch resolve — a sequential implementation would still be awaiting
    // the first call's response and would never have issued the second.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    resolveFirst(json({ value: [] }));
    await resultPromise;
  });

  it("warms the token cache once before fanning out multiple getSchedule batches", async () => {
    // Entra rotates the refresh token per use — N concurrent batches each
    // independently forcing a cold refresh would race each other (only one
    // "wins", the rest 401 or get a stale token). One sequential warm-up
    // call ahead of the fan-out avoids the race.
    let tokenCallCount = 0;
    let resolveFirstToken!: (t: string) => void;
    const firstTokenPromise = new Promise<string>((res) => { resolveFirstToken = res; });
    const getAccessToken = vi.fn(async () => {
      tokenCallCount++;
      if (tokenCallCount === 1) return firstTokenPromise;
      return "tok";
    });
    const fetchFn = vi.fn().mockImplementation(async () => json({ value: [] }));
    const p = new MicrosoftCalendarProvider({ getAccessToken, fetch: fetchFn as unknown as typeof fetch });
    const ids = Array.from({ length: 25 }, (_, i) => `u${i}@x.com`); // 2 batches
    const resultPromise = p.queryFreeBusy(ids, win);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The warm-up call has fired (and is pending) but the fan-out hasn't
    // started yet — no batch has called getAccessToken or fetch a second time.
    expect(tokenCallCount).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    resolveFirstToken("tok");
    await resultPromise;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("MicrosoftCalendarProvider subscriptions", () => {
  it("subscribeToChanges POSTs a Graph subscription and maps it to Subscription", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      id: "sub-123", expirationDateTime: "2026-07-08T21:00:00Z",
    }, 201));
    const sub = await provider(fetchFn).subscribeToChanges("https://app/v1/webhook/microsoft-calendar", "secret-token");
    expect(sub).toEqual({
      channelId: "sub-123", channelToken: "secret-token", resourceId: "", expiresAt: "2026-07-08T21:00:00Z",
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      changeType: "created,updated,deleted",
      resource: "/me/events",
      notificationUrl: "https://app/v1/webhook/microsoft-calendar",
      lifecycleNotificationUrl: "https://app/v1/webhook/microsoft-calendar",
      clientState: "secret-token",
    });
    expect(Date.parse(body.expirationDateTime)).toBeGreaterThan(Date.now() + 4000 * 60_000);
  });

  it("renewSubscription PATCHes a new expiry", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "sub-123", expirationDateTime: "2026-07-11T21:00:00Z" }));
    const r = await provider(fetchFn).renewSubscription!("sub-123");
    expect(r).toEqual({ expiresAt: "2026-07-11T21:00:00Z" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-123");
    expect(init.method).toBe("PATCH");
  });

  it("stopChannel DELETEs and treats 404 as success", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(provider(fetchFn).stopChannel("sub-123", "")).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0]![0]).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-123");
  });
});

describe("MicrosoftCalendarProvider getEvent", () => {
  it("GETs /me/events/{id} with the extended-property $expand and maps the event", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json(graphEvent("e1", {
      singleValueExtendedProperties: [{ id: graphPropId("scheduler_chunk_id"), value: "chunk-1" }],
    })));
    const ev = await provider(fetchFn).getEvent("e1");
    expect(ev?.id).toBe("e1");
    expect(ev?.extendedProperties?.private?.scheduler_chunk_id).toBe("chunk-1");
    const url = fetchFn.mock.calls[0]![0] as string;
    expect(url).toContain("/me/events/e1");
    const expand = new URL(url).searchParams.get("$expand")!;
    expect(expand).toContain(graphPropId("scheduler_chunk_id"));
    expect(expand).toContain(graphPropId("optical_meeting_task_id"));
  });

  it("returns null on 404/410 and throws on other failures", async () => {
    const gone = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await provider(gone).getEvent("x")).toBeNull();
    const bad = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(provider(bad).getEvent("x")).rejects.toThrow("Graph get failed: 500");
  });

  it("maps a cancelled event to status cancelled rather than null", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json(graphEvent("c1", { isCancelled: true })));
    const ev = await provider(fetchFn).getEvent("c1");
    expect(ev?.status).toBe("cancelled");
  });
});

// Graph's calendarView/delta is WINDOW-BOUND: a deltaLink only ever reports
// changes inside the startDateTime/endDateTime it was created with (unlike a
// Google sync token, which spans the whole calendar). Every resolve stores the
// deltaLink from its one-week fetch, so binding the delta to the caller's
// window meant webhook change detection only saw the LAST RESOLVED WEEK —
// live L8 on 2026-08-20: a chunk dragged in week A went unreported after
// week B was resolved. The provider therefore opens the delta over a wide
// horizon anchored on now (28d back for the done-scan, 365d ahead), unioned
// with the requested window, and applies the requested window as a filter.
describe("MicrosoftCalendarProvider fetchEventsInWindow({ syncToken: false })", () => {
  it("issues a plain bounded /me/calendarView read (not delta) and returns an empty nextSyncToken", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ value: [graphEvent("e1")] }));
    const r = await provider(fetchFn).fetchEventsInWindow(
      "2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", { syncToken: false },
    );
    expect(r.events.map((e) => e.id)).toEqual(["e1"]);
    expect(r.nextSyncToken).toBe("");
    const url = fetchFn.mock.calls[0]![0] as string;
    expect(url).toContain("/me/calendarView");
    expect(url).not.toContain("/delta");
    const u = new URL(url);
    // Bounded to exactly the requested window — not widened to the delta horizon.
    expect(u.searchParams.get("startDateTime")).toBe("2026-07-06T00:00:00.000Z");
    expect(u.searchParams.get("endDateTime")).toBe("2026-07-13T00:00:00.000Z");
    const expand = u.searchParams.get("$expand")!;
    expect(expand).toContain(graphPropId("scheduler_chunk_id"));
    const headers = new Headers((fetchFn.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("Prefer")).toContain('IdType="ImmutableId"');
    expect(headers.get("Prefer")).toContain('outlook.timezone="UTC"');
  });

  it("pages via @odata.nextLink and filters free/cancelled events, same as the delta path", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({
        value: [graphEvent("e1")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/plain-next-page",
      }))
      .mockResolvedValueOnce(json({
        value: [graphEvent("free1", { showAs: "free" }), graphEvent("cancelled1", { isCancelled: true })],
      }));
    const r = await provider(fetchFn).fetchEventsInWindow(
      "2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", { syncToken: false },
    );
    expect(r.events.map((e) => e.id)).toEqual(["e1"]);
    expect(fetchFn.mock.calls[1]![0]).toBe("https://graph.microsoft.com/v1.0/plain-next-page");
  });

  it("skips (and warns once) an item with unparseable start/end on the plain read path", async () => {
    // The plain path had no NaN guard at all (the gap B8 closed on the
    // sibling delta path) — an unparseable-start item would have been
    // pushed straight into events with "" start/end.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [graphEvent("bad1", { start: undefined, end: undefined }), graphEvent("good1")],
    }));
    const r = await provider(fetchFn).fetchEventsInWindow(
      "2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z", { syncToken: false },
    );
    expect(r.events.map((e) => e.id)).toEqual(["good1"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("MicrosoftCalendarProvider delta horizon", () => {
  const now = () => new Date("2026-07-10T00:00:00Z");

  it("opens the delta over [now-28d, now+365d] and filters returned events to the requested window", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      value: [
        graphEvent("in-week"),
        graphEvent("far-future", {
          start: { dateTime: "2026-09-01T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-09-01T10:00:00.0000000", timeZone: "UTC" },
        }),
        graphEvent("straddles-start", {
          start: { dateTime: "2026-07-05T23:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-07-06T01:00:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-wide",
    }));
    const r = await provider(fetchFn, now).fetchEventsInWindow("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z");
    const u = new URL(fetchFn.mock.calls[0]![0] as string);
    expect(u.searchParams.get("startDateTime")).toBe("2026-06-12T00:00:00.000Z");
    expect(u.searchParams.get("endDateTime")).toBe("2027-07-10T00:00:00.000Z");
    expect(r.events.map((e) => e.id)).toEqual(["in-week", "straddles-start"]); // overlap, not containment
    expect(r.nextSyncToken).toBe("https://graph.microsoft.com/v1.0/delta-wide");
  });

  it("extends the horizon when the requested window lies outside it", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ value: [], "@odata.deltaLink": "d" }));
    await provider(fetchFn, now).fetchEventsInWindow("2028-01-03T00:00:00Z", "2028-01-10T00:00:00Z");
    const u = new URL(fetchFn.mock.calls[0]![0] as string);
    expect(u.searchParams.get("startDateTime")).toBe("2026-06-12T00:00:00.000Z");
    expect(u.searchParams.get("endDateTime")).toBe("2028-01-10T00:00:00.000Z");
  });
});
