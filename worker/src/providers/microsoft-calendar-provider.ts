import type {
  BusyInterval, CalendarProvider, CreateEventOptions, FreeBusyResult, UpdateEventOptions,
} from "./calendar-provider";
import { SyncTokenInvalidatedError } from "./calendar-provider";
import type { CalendarEvent, Change, IncrementalResult, Subscription } from "./types";
import {
  type GraphEvent, toCalendarEventFromGraph, isBusyGraphEvent,
  toGraphPatch, OPTICAL_DONE_CATEGORY, graphPropId, isoZ,
} from "./graph-event-mapping";

type TokenFetcher = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface MicrosoftCalendarProviderOptions {
  getAccessToken: TokenFetcher;
  fetch?: typeof fetch;
  /** Clock for the delta horizon (tests). */
  now?: () => Date;
}

const GRAPH = "https://graph.microsoft.com/v1.0";
// ImmutableId: default Graph ids change when an event moves folders. UTC:
// responses come back normalisable to ISO-Z. maxpagesize keeps paging bounded.
const PREFER = 'IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=250';

// Graph's calendarView/delta is WINDOW-BOUND: the deltaLink it hands back only
// ever reports changes inside the startDateTime/endDateTime it was created
// with — unlike a Google sync token, which spans the whole calendar. Callers
// (resolve, webhook replan) store that link as next_sync_token and ask for a
// single week at a time, so binding the delta to the caller's window meant
// webhook change detection only ever saw the LAST RESOLVED WEEK (live L8,
// 2026-08-20: a chunk dragged in week A went unreported once week B had been
// resolved). The delta is therefore always opened over a wide horizon anchored
// on now — 28 days back (the done-scan's reach) and a year ahead — unioned
// with the requested window; the requested window is applied as a filter to
// the returned events. Each resolve re-opens a fresh horizon, so the window
// rolls forward weekly under the Monday cron.
const DELTA_PAST_DAYS = 28;
const DELTA_FUTURE_DAYS = 365;
const DAY_MS = 24 * 3600 * 1000;

/** A Graph item is "deleted" for our purposes either as a delta tombstone
 *  (`@removed`, incremental path only) or a cancelled event (both paths).
 *  Single source of truth so fetchEventsInWindow and fetchIncrementalChanges
 *  can't drift on what counts as gone. */
function isDeletedGraphEvent(g: GraphEvent): boolean {
  return Boolean(g["@removed"]) || Boolean(g.isCancelled);
}

export class MicrosoftCalendarProvider implements CalendarProvider {
  private readonly getAccessToken: TokenFetcher;
  private readonly fetchFn: typeof fetch;
  // Done marker is category set-membership, not a numeric color: undoing done
  // needs an explicit categories:[] clear (toGraphPatch), not a Google-style
  // CREATE_COLOR_ID that toGraphPatch would silently ignore.
  readonly undoneColorId = "";
  // Floor under users.done_color_id / env.DONE_COLOR_ID (calendar-provider.ts):
  // a numeric Google colorId is meaningless for Outlook categories, so a NULL
  // done_color_id row must resolve here, not to the Google-shaped env default.
  readonly defaultDoneColorId = OPTICAL_DONE_CATEGORY;
  private readonly now: () => Date;

  constructor(opts: MicrosoftCalendarProviderOptions) {
    this.getAccessToken = opts.getAccessToken;
    this.now = opts.now ?? (() => new Date());
    // Closure wrap: bare `this.fetchFn = fetch` breaks in Workers ("Illegal
    // invocation") — same trick as google-calendar-provider.ts:104.
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.getAccessToken();
    const withAuth = (t: string): RequestInit => ({
      ...init,
      headers: { Prefer: PREFER, ...(init.headers ?? {}), Authorization: `Bearer ${t}` },
    });
    let res = await this.fetchFn(url, withAuth(token));
    if (res.status === 401) {
      token = await this.getAccessToken({ forceRefresh: true });
      res = await this.fetchFn(url, withAuth(token));
    }
    return res;
  }

  /** One page-following pass over a delta URL. Shared by the window fetch
   *  (initial sync) and incremental (deltaLink continuation). */
  private async runDelta(firstUrl: string): Promise<
    { invalidated: true } | { invalidated: false; items: GraphEvent[]; deltaLink: string }
  > {
    const items: GraphEvent[] = [];
    let url: string | undefined = firstUrl;
    let deltaLink = "";
    while (url) {
      const res = await this.authedFetch(url);
      if (res.status === 410) return { invalidated: true };
      if (!res.ok) throw new Error(`Graph delta failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as {
        value?: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string;
      };
      items.push(...(body.value ?? []));
      url = body["@odata.nextLink"];
      if (body["@odata.deltaLink"]) deltaLink = body["@odata.deltaLink"];
    }
    return { invalidated: false, items, deltaLink };
  }

  /** Shared "does this Graph item become a busy CalendarEvent?" decision for
   *  both window-fetch paths (delta and plain): tombstoned/cancelled and
   *  transparent items are dropped; an item whose mapped start/end fails to
   *  parse is dropped with a once-per-call warning (this NaN guard used to
   *  exist only on the delta path — the plain path had no guard at all);
   *  and, when `bounds` is given, an item outside it is dropped. `warnState`
   *  is a small object the caller owns so "once" means once per call to
   *  fetchEventsInWindow/fetchEventsInWindowPlain, not once ever. */
  private mapAcceptedGraphEvent(
    g: GraphEvent,
    warnState: { warned: boolean },
    bounds?: { startMs: number; endMs: number },
  ): CalendarEvent | null {
    if (isDeletedGraphEvent(g)) return null;
    if (!isBusyGraphEvent(g)) return null;
    const ev = toCalendarEventFromGraph(g);
    const evStart = Date.parse(ev.start);
    const evEnd = Date.parse(ev.end);
    if (Number.isNaN(evStart) || Number.isNaN(evEnd)) {
      if (!warnState.warned) {
        console.warn("microsoft-calendar-provider: skipping event with unparseable start/end");
        warnState.warned = true;
      }
      return null;
    }
    if (bounds && (evEnd <= bounds.startMs || evStart >= bounds.endMs)) return null;
    return ev;
  }

  async fetchEventsInWindow(start: string, end: string, opts?: { syncToken?: boolean }) {
    if (opts?.syncToken === false) return this.fetchEventsInWindowPlain(start, end);
    const nowMs = this.now().getTime();
    const deltaStart = new Date(Math.min(nowMs - DELTA_PAST_DAYS * DAY_MS, Date.parse(start))).toISOString();
    const deltaEnd = new Date(Math.max(nowMs + DELTA_FUTURE_DAYS * DAY_MS, Date.parse(end))).toISOString();
    const params = new URLSearchParams({ startDateTime: deltaStart, endDateTime: deltaEnd });
    // Only the initial request needs $expand: fetchIncrementalChanges reuses
    // the stored deltaLink/nextLink verbatim, and Graph derives those from
    // this request's parameters, so the expand carries forward automatically.
    const chunkId = graphPropId("scheduler_chunk_id");
    const taskId = graphPropId("optical_meeting_task_id");
    params.set("$expand", `singleValueExtendedProperties($filter=id eq '${chunkId}' or id eq '${taskId}')`);
    const r = await this.runDelta(`${GRAPH}/me/calendarView/delta?${params.toString()}`);
    if (r.invalidated) {
      // A fresh initial sync can't be stale; surface loudly rather than loop.
      throw new SyncTokenInvalidatedError();
    }
    if (!r.deltaLink) {
      // A successful (non-410) run that never handed back @odata.deltaLink
      // leaves nothing to store as nextSyncToken — silently returning ""
      // would look like a usable (if empty) sync state to callers. Fail
      // loudly instead of masking what should never happen on a fresh sync.
      throw new Error("graph_delta_no_deltalink");
    }
    // The horizon is wider than the caller asked for: hand back only events
    // overlapping [start, end) (calendarView semantics — overlap, not
    // containment), so resolve's busy mask stays week-scoped.
    const bounds = { startMs: Date.parse(start), endMs: Date.parse(end) };
    const warnState = { warned: false };
    const events: CalendarEvent[] = [];
    for (const g of r.items) {
      const ev = this.mapAcceptedGraphEvent(g, warnState, bounds);
      if (ev) events.push(ev);
    }
    return { events, nextSyncToken: r.deltaLink };
  }

  /** Contract 2's { syncToken: false } path: a plain bounded /me/calendarView
   *  read (no delta), used by callers that discard nextSyncToken anyway and
   *  don't need — or want — the wide horizon a delta subscription requires. */
  private async fetchEventsInWindowPlain(start: string, end: string) {
    const params = new URLSearchParams({
      startDateTime: new Date(start).toISOString(),
      endDateTime: new Date(end).toISOString(),
    });
    const chunkId = graphPropId("scheduler_chunk_id");
    const taskId = graphPropId("optical_meeting_task_id");
    params.set("$expand", `singleValueExtendedProperties($filter=id eq '${chunkId}' or id eq '${taskId}')`);
    const events: CalendarEvent[] = [];
    const warnState = { warned: false };
    let url: string | undefined = `${GRAPH}/me/calendarView?${params.toString()}`;
    while (url) {
      const res = await this.authedFetch(url);
      if (!res.ok) throw new Error(`Graph calendarView failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { value?: GraphEvent[]; "@odata.nextLink"?: string };
      for (const g of body.value ?? []) {
        const ev = this.mapAcceptedGraphEvent(g, warnState);
        if (ev) events.push(ev);
      }
      url = body["@odata.nextLink"];
    }
    return { events, nextSyncToken: "" };
  }

  async fetchIncrementalChanges(syncToken: string): Promise<IncrementalResult> {
    // syncToken IS the deltaLink (absolute URL) — use verbatim, like Google's
    // opaque syncToken. Window-bound: rolling the resolve window invalidates it,
    // which surfaces as 410 → full refetch, the existing recovery path.
    const r = await this.runDelta(syncToken);
    if (r.invalidated) return { changes: [], nextSyncToken: "", syncTokenInvalidated: true };
    if (!r.deltaLink) {
      // No deltaLink to continue this chain with — same recovery path as an
      // explicit 410: force the caller into a full refetch rather than
      // handing back a nextSyncToken of "" that looks like valid sync state.
      return { changes: [], nextSyncToken: "", syncTokenInvalidated: true };
    }
    const changes: Change[] = [];
    let warnedUnparseable = false;
    for (const g of r.items) {
      if (isDeletedGraphEvent(g)) {
        changes.push({ kind: "delete", eventId: g.id });
      } else if (isBusyGraphEvent(g)) {
        const ev = toCalendarEventFromGraph(g);
        // Unlike fetchEventsInWindow (which has always guarded this),
        // upserting an event with an unparseable "" start/end would reach
        // build-problem.ts and abort the whole replan via localWeekWindow("").
        // Skip it — warn once per call, not once per bad item, to avoid
        // flooding logs on a chain with many affected events.
        if (Number.isNaN(Date.parse(ev.start)) || Number.isNaN(Date.parse(ev.end))) {
          if (!warnedUnparseable) {
            console.warn(
              "microsoft-calendar-provider: skipping incremental change(s) with unparseable start/end",
            );
            warnedUnparseable = true;
          }
          continue;
        }
        // Mirror of the Google path (google-calendar-provider.ts:233-239),
        // including its known gap: a busy→free transition is dropped silently.
        changes.push({ kind: "upsert", event: ev });
      }
    }
    return { changes, nextSyncToken: r.deltaLink, syncTokenInvalidated: false };
  }

  async createEvent(
    event: CalendarEvent,
    schedulerMetadata: Record<string, string>,
    opts?: CreateEventOptions,
  ): Promise<{ eventId: string }> {
    const props = { ...(event.extendedProperties?.private ?? {}), ...schedulerMetadata };
    const payload: Record<string, unknown> = {
      subject: event.summary,
      body: { contentType: "text", content: event.description ?? "" },
      location: event.location ? { displayName: event.location } : undefined,
      start: { dateTime: event.start, timeZone: "UTC" },
      end: { dateTime: event.end, timeZone: "UTC" },
      // Fresh per attempt (not keyed on the chunk id): transactionId is
      // Graph's create-attempt idempotency key. Keying it on the chunk id
      // meant a deleted-then-recreated chunk replayed an id Graph had
      // already consumed for the earlier (now-deleted) event.
      transactionId: crypto.randomUUID(),
      singleValueExtendedProperties: Object.entries(props).map(([name, value]) => ({
        id: graphPropId(name), value,
      })),
      categories: event.colorId === OPTICAL_DONE_CATEGORY ? [OPTICAL_DONE_CATEGORY] : undefined,
    };
    if (event.attendees?.length) {
      payload.attendees = event.attendees.map((a) => ({
        emailAddress: { address: a.email },
        type: a.optional ? "optional" : "required",
      }));
    }
    if (opts?.addMeet) {
      payload.isOnlineMeeting = true;
      payload.onlineMeetingProvider = "teamsForBusiness";
    }
    // notifyAttendees: no-op, same as updateEvent — Graph always notifies
    // attendees of meeting-relevant creates (no sendUpdates knob).
    // TODO(Card C mapping): the POST response carries `onlineMeeting.joinUrl`
    // for a Teams meeting, but CalendarEvent/types.ts has no field to land it
    // in (Google's provider has the same gap — createEvent never surfaces
    // hangoutLink either). Once such a field exists, read it off `body` below
    // and thread it through.
    const res = await this.authedFetch(`${GRAPH}/me/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Graph create failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { id: string };
    return { eventId: body.id };
  }

  async updateEvent(
    eventId: string,
    changes: Partial<CalendarEvent>,
    _opts?: UpdateEventOptions,
  ): Promise<void> {
    // notifyAttendees is deliberately unused: Graph always notifies attendees
    // of meeting-relevant PATCHes (no sendUpdates knob). Interface docs allow
    // providers to no-op this.
    const patch = toGraphPatch(changes);
    if ("categories" in patch) {
      // toGraphPatch computed a whole-array categories replacement (done-marker
      // set or clear) from the change alone, with no view of the user's other
      // Outlook categories on this event — PATCHing that array verbatim would
      // wipe them. Read the current categories and merge: add/remove only the
      // done marker, keep everything else untouched.
      const getRes = await this.authedFetch(
        `${GRAPH}/me/events/${encodeURIComponent(eventId)}?$select=categories`,
      );
      if (!getRes.ok) {
        throw new Error(`Graph get categories failed: ${getRes.status} ${await getRes.text()}`);
      }
      const current = (await getRes.json()) as { categories?: string[] };
      const others = (current.categories ?? []).filter((c) => c !== OPTICAL_DONE_CATEGORY);
      patch.categories = changes.colorId === OPTICAL_DONE_CATEGORY
        ? [...others, OPTICAL_DONE_CATEGORY]
        : others;
    }
    const res = await this.authedFetch(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Graph update failed: ${res.status} ${await res.text()}`);
  }

  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    // Same $expand as the delta read so scheduler metadata survives a
    // single-event fetch (decline-cancel / poll re-verification read it).
    const chunkId = graphPropId("scheduler_chunk_id");
    const taskId = graphPropId("optical_meeting_task_id");
    const params = new URLSearchParams();
    params.set("$expand", `singleValueExtendedProperties($filter=id eq '${chunkId}' or id eq '${taskId}')`);
    const res = await this.authedFetch(`${GRAPH}/me/events/${encodeURIComponent(eventId)}?${params.toString()}`);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Graph get failed: ${res.status} ${await res.text()}`);
    // A cancelled Graph event maps to status "cancelled" (not null), mirroring
    // the Google provider's contract — callers check status first.
    return toCalendarEventFromGraph((await res.json()) as GraphEvent);
  }

  async deleteEvent(eventId: string): Promise<void> {
    const res = await this.authedFetch(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Graph delete failed: ${res.status} ${await res.text()}`);
    }
  }
  async queryFreeBusy(
    calendarIds: string[],
    window: { start: string; end: string },
  ): Promise<Map<string, FreeBusyResult>> {
    const out = new Map<string, FreeBusyResult>();
    const unique = [...new Set(calendarIds)];
    const BATCH = 20; // getSchedule hard limit: 20 schedules per request
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));
    if (batches.length > 1) {
      // Warm the token cache with one sequential call before fanning out.
      // Entra rotates the refresh token on every use — N concurrent batches
      // each independently forcing a cold refresh would race each other
      // (only one "wins"; the rest see a stale/consumed refresh token).
      await this.getAccessToken();
    }
    // Issue every batch's getSchedule call concurrently — previously these
    // were awaited one at a time in the loop, so N batches paid N sequential
    // round-trips instead of one.
    await Promise.all(batches.map((batch) => this.queryFreeBusyBatch(batch, window, out)));
    return out;
  }

  private async queryFreeBusyBatch(
    batch: string[],
    window: { start: string; end: string },
    out: Map<string, FreeBusyResult>,
  ): Promise<void> {
    const res = await this.authedFetch(`${GRAPH}/me/calendar/getSchedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schedules: batch,
        startTime: { dateTime: window.start, timeZone: "UTC" },
        endTime: { dateTime: window.end, timeZone: "UTC" },
        availabilityViewInterval: 30,
      }),
    });
    if (!res.ok) {
      // Whole-batch failure → every id unreadable; caller degrades + warns
      // instead of failing the resolve (same contract as Google).
      const reason = `freebusy_http_${res.status}`;
      for (const id of batch) out.set(id, { error: reason });
      return;
    }
    const body = (await res.json()) as {
      value?: Array<{
        scheduleId: string;
        error?: { responseCode?: string; message?: string };
        scheduleItems?: Array<{
          status?: string;
          start?: { dateTime?: string }; end?: { dateTime?: string };
        }>;
        availabilityView?: string;
      }>;
    };
    const byId = new Map((body.value ?? []).map((s) => [s.scheduleId, s]));
    for (const id of batch) {
      const s = byId.get(id);
      if (!s) {
        out.set(id, { error: "missing_in_response" });
      } else if (s.error) {
        out.set(id, { error: s.error.responseCode ?? s.error.message ?? "schedule_error" });
      } else if (s.scheduleItems?.length) {
        // tentative + oof count as busy (matches Google freebusy semantics:
        // opaque events block regardless of RSVP nuance); free and
        // workingElsewhere don't — mirrors isBusyGraphEvent's calendar-event
        // treatment of the same showAs value.
        const busy = s.scheduleItems
          .filter((it) => it.status !== "free" && it.status !== "workingElsewhere" && it.start?.dateTime && it.end?.dateTime)
          .map((it) => ({ start: isoZ(it.start!.dateTime!), end: isoZ(it.end!.dateTime!) }));
        out.set(id, { busy });
      } else if (s.availabilityView) {
        // Graph omits (or empties) scheduleItems for availability-only
        // sharing, external/cross-tenant, and personal mailboxes — exactly
        // the cases the freeze-on-unknown policy needs surfaced, so fall
        // back to the coarser 30-min availabilityView (0 free, 4
        // workingElsewhere free, 1/2/3 busy) whenever it's present, even
        // when scheduleItems came back as an empty (but present) array —
        // that's the same "no per-item detail" signal as it being absent,
        // not "confirmed nothing busy".
        //
        // Graph anchors the view's slot 0 to a 30-min interval boundary, not
        // to window.start verbatim — floor window.start down to that
        // boundary before indexing, or a window.start with a :15/:45 offset
        // shifts every slot's reported time by up to 30 minutes. Clamp the
        // final slot to window.end so a short trailing slot isn't reported
        // as spanning past the requested window.
        const THIRTY_MIN_MS = 30 * 60_000;
        const winStartMs = Math.floor(Date.parse(window.start) / THIRTY_MIN_MS) * THIRTY_MIN_MS;
        const winEndMs = Date.parse(window.end);
        const busy: BusyInterval[] = [];
        for (let i = 0; i < s.availabilityView.length; i++) {
          const ch = s.availabilityView[i];
          if (ch === "0" || ch === "4") continue;
          const slotStart = winStartMs + i * THIRTY_MIN_MS;
          const slotEnd = Math.min(slotStart + THIRTY_MIN_MS, winEndMs);
          busy.push({
            start: new Date(slotStart).toISOString(),
            end: new Date(slotEnd).toISOString(),
          });
        }
        out.set(id, { busy });
      } else if (s.scheduleItems) {
        // Present but empty, and no availabilityView either — Graph read
        // this schedule and confirmed nothing, i.e. readable-free. Distinct
        // from the branch above (empty items + a real view) and from the
        // final else (neither field present at all, unreadable).
        out.set(id, { busy: [] });
      } else {
        out.set(id, { error: "no_schedule_detail" });
      }
    }
  }
  private subscriptionExpiry(): string {
    // Graph max is 4230 min; use 4200 to stay clear of clock-skew rejections.
    return new Date(Date.now() + 4200 * 60_000).toISOString();
  }

  async subscribeToChanges(callbackUrl: string, channelToken: string): Promise<Subscription> {
    const res = await this.authedFetch(`${GRAPH}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        resource: "/me/events",
        notificationUrl: callbackUrl,
        lifecycleNotificationUrl: callbackUrl,
        clientState: channelToken,
        expirationDateTime: this.subscriptionExpiry(),
      }),
    });
    if (!res.ok) throw new Error(`Graph subscribe failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { id: string; expirationDateTime: string };
    return { channelId: body.id, channelToken, resourceId: "", expiresAt: body.expirationDateTime };
  }

  async renewSubscription(channelId: string): Promise<{ expiresAt: string }> {
    const res = await this.authedFetch(`${GRAPH}/subscriptions/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expirationDateTime: this.subscriptionExpiry() }),
    });
    if (!res.ok) throw new Error(`Graph renew failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { expirationDateTime: string };
    return { expiresAt: body.expirationDateTime };
  }

  async stopChannel(channelId: string, _resourceId: string): Promise<void> {
    const res = await this.authedFetch(`${GRAPH}/subscriptions/${encodeURIComponent(channelId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Graph unsubscribe failed: ${res.status} ${await res.text()}`);
    }
  }
  verifyWebhook(_h: Headers, _b: string): boolean {
    // Same posture as Google (google-calendar-provider.ts:357): validation
    // lives in the route (clientState compare against calendar_sync).
    throw new Error("not_implemented — route validates clientState");
  }
}
