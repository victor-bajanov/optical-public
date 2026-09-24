import type {
  CalendarProvider,
  CreateEventOptions,
  DeleteEventOptions,
  FreeBusyResult,
  UpdateEventOptions,
} from "./calendar-provider";
import { SyncTokenInvalidatedError } from "./calendar-provider";
import type { CalendarEvent, Change, IncrementalResult, Subscription } from "./types";

type TokenFetcher = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface GoogleCalendarProviderOptions {
  calendarId: string;
  getAccessToken: TokenFetcher;
  fetch?: typeof fetch;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  colorId?: string;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  status?: string;
  transparency?: string;
  eventType?: string;
  organizer?: { email?: string; self?: boolean };
  guestsCanModify?: boolean;
  attendees?: Array<{
    email?: string;
    responseStatus?: string;
    optional?: boolean;
    resource?: boolean;
    self?: boolean;
  }>;
}

/** Returns true when the event should be treated as busy time for the solver. */
function isBusyEvent(g: GoogleEvent): boolean {
  if (g.transparency === "transparent") return false;
  if (g.eventType === "workingLocation" || g.eventType === "birthday") return false;
  return true;
}

function toRfc3339(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${s}`);
  return d.toISOString();
}

function toCalendarEvent(g: GoogleEvent): CalendarEvent {
  const isAllDay = g.start?.date !== undefined && g.start?.dateTime === undefined;
  const start = g.start?.dateTime ?? (g.start?.date ? `${g.start.date}T00:00:00Z` : "");
  const end = g.end?.dateTime ?? (g.end?.date ? `${g.end.date}T00:00:00Z` : "");
  return {
    id: g.id,
    summary: g.summary ?? "",
    start,
    end,
    location: g.location,
    description: g.description,
    colorId: g.colorId,
    // Thread free/busy metadata so build-problem.ts can apply the all-day-OOO
    // (decision C) and tentative-toggle (decision D) rules and defensively drop
    // a cancelled event (decision B). `status` and `eventType` are passed through
    // verbatim; `isAllDay` is true when Google sent start.date (no dateTime).
    status: g.status,
    eventType: g.eventType,
    isAllDay,
    extendedProperties: {
      private: g.extendedProperties?.private,
      shared: g.extendedProperties?.shared,
    },
    organizer: g.organizer
      ? { email: g.organizer.email, self: g.organizer.self }
      : undefined,
    guestsCanModify: g.guestsCanModify,
    attendees: g.attendees
      ?.filter((a) => typeof a.email === "string")
      .map((a) => ({
        email: a.email as string,
        responseStatus: a.responseStatus as
          | "needsAction"
          | "declined"
          | "tentative"
          | "accepted"
          | undefined,
        optional: a.optional,
        resource: a.resource,
        self: a.self,
      })),
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly calendarId: string;
  private readonly getAccessToken: TokenFetcher;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GoogleCalendarProviderOptions) {
    this.calendarId = opts.calendarId;
    this.getAccessToken = opts.getAccessToken;
    // Wrap global fetch in a closure so calling `this.fetchFn(...)` doesn't
    // bind `this` to the class instance (which Workers rejects as
    // "Illegal invocation").
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.getAccessToken();
    let res = await this.fetchFn(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      token = await this.getAccessToken({ forceRefresh: true });
      res = await this.fetchFn(url, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      });
    }
    return res;
  }

  async fetchEventsInWindow(start: string, end: string) {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events`;
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken = "";
    // Google's events.list requires RFC3339 with a timezone offset; naive
    // forms like "2026-06-01T00:00" are rejected with 400. Coerce here so
    // callers can pass either.
    const timeMin = toRfc3339(start);
    const timeMax = toRfc3339(end);
    do {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        showDeleted: "false",
        maxResults: "250",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.authedFetch(`${base}?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Google Calendar list failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as {
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      for (const it of body.items ?? []) {
        if (isBusyEvent(it)) events.push(toCalendarEvent(it));
      }
      pageToken = body.nextPageToken;
      if (body.nextSyncToken) nextSyncToken = body.nextSyncToken;
    } while (pageToken);
    return { events, nextSyncToken };
  }

  async queryFreeBusy(
    calendarIds: string[],
    window: { start: string; end: string },
  ): Promise<Map<string, FreeBusyResult>> {
    const out = new Map<string, FreeBusyResult>();
    const unique = [...new Set(calendarIds)];
    // Google freebusy.query accepts <=50 calendars per call; chunk if more.
    const BATCH = 50;
    const timeMin = toRfc3339(window.start);
    const timeMax = toRfc3339(window.end);
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      const res = await this.authedFetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timeMin,
          timeMax,
          items: batch.map((id) => ({ id })),
        }),
      });
      if (!res.ok) {
        // A whole-batch failure (e.g. 403 missing scope): mark every calendar in
        // the batch unreadable so the caller degrades to "treat as available +
        // warn" rather than throwing the resolve.
        const reason = `freebusy_http_${res.status}`;
        for (const id of batch) out.set(id, { error: reason });
        continue;
      }
      const body = (await res.json()) as {
        calendars?: Record<
          string,
          { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }
        >;
      };
      for (const id of batch) {
        const cal = body.calendars?.[id];
        if (!cal) {
          out.set(id, { error: "missing_in_response" });
        } else if (cal.errors && cal.errors.length > 0) {
          out.set(id, { error: cal.errors[0]!.reason });
        } else {
          out.set(id, { busy: cal.busy ?? [] });
        }
      }
    }
    return out;
  }

  async fetchIncrementalChanges(syncToken: string): Promise<IncrementalResult> {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events`;
    const changes: Change[] = [];
    let pageToken: string | undefined;
    let nextSyncToken = "";
    do {
      const params = new URLSearchParams({ syncToken, showDeleted: "true", maxResults: "250" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.authedFetch(`${base}?${params.toString()}`);
      if (res.status === 410) {
        return { changes: [], nextSyncToken: "", syncTokenInvalidated: true };
      }
      if (!res.ok) {
        throw new Error(`Google incremental list failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as {
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      for (const it of body.items ?? []) {
        if (it.status === "cancelled") {
          changes.push({ kind: "delete", eventId: it.id });
        } else if (isBusyEvent(it)) {
          changes.push({ kind: "upsert", event: toCalendarEvent(it) });
        }
      }
      pageToken = body.nextPageToken;
      if (body.nextSyncToken) nextSyncToken = body.nextSyncToken;
    } while (pageToken);
    return { changes, nextSyncToken, syncTokenInvalidated: false };
  }
  async subscribeToChanges(callbackUrl: string, channelToken: string): Promise<Subscription> {
    const channelId = crypto.randomUUID();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events/watch`;
    const res = await this.authedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: callbackUrl,
        token: channelToken,
      }),
    });
    if (!res.ok) throw new Error(`Google watch failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      id: string;
      resourceId: string;
      expiration?: string | number;
    };
    const expiresMs = body.expiration ? Number(body.expiration) : Date.now() + 7 * 86400_000;
    return {
      channelId: body.id,
      channelToken,
      resourceId: body.resourceId,
      expiresAt: new Date(expiresMs).toISOString(),
    };
  }
  async createEvent(
    event: CalendarEvent,
    schedulerMetadata: Record<string, string>,
    opts?: CreateEventOptions,
  ): Promise<{ eventId: string }> {
    const params = new URLSearchParams();
    if (opts?.notifyAttendees) params.set("sendUpdates", "all");
    if (opts?.addMeet) params.set("conferenceDataVersion", "1");
    const qs = params.toString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events${qs ? `?${qs}` : ""}`;
    const payload: Record<string, unknown> = {
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      extendedProperties: {
        private: { ...(event.extendedProperties?.private ?? {}), ...schedulerMetadata },
        shared: event.extendedProperties?.shared,
      },
    };
    // Only set colorId when the caller asked for one: a booking is a real
    // meeting and must not render in the scheduler chunk colour. Chunk creation
    // in planning/commit.ts now passes the create colour explicitly.
    if (event.colorId) payload.colorId = event.colorId;
    if (event.attendees?.length) payload.attendees = event.attendees;
    if (opts?.addMeet) {
      payload.conferenceData = {
        createRequest: {
          requestId: opts.conferenceRequestId ?? crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }
    const res = await this.authedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Google create failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { id: string };
    return { eventId: body.id };
  }

  async updateEvent(
    eventId: string,
    changes: Partial<CalendarEvent>,
    opts?: UpdateEventOptions,
  ): Promise<void> {
    const params = new URLSearchParams();
    if (opts?.notifyAttendees) params.set("sendUpdates", "all");
    const qs = params.toString();
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}` +
      `/events/${encodeURIComponent(eventId)}${qs ? `?${qs}` : ""}`;
    const patch: Record<string, unknown> = {};
    if (changes.summary !== undefined) patch.summary = changes.summary;
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.location !== undefined) patch.location = changes.location;
    if (changes.colorId !== undefined) patch.colorId = changes.colorId;
    if (changes.start !== undefined) patch.start = { dateTime: changes.start };
    if (changes.end !== undefined) patch.end = { dateTime: changes.end };
    if (changes.extendedProperties !== undefined) {
      patch.extendedProperties = changes.extendedProperties;
    }
    const res = await this.authedFetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Google update failed: ${res.status} ${await res.text()}`);
  }

  async deleteEvent(eventId: string, opts?: DeleteEventOptions): Promise<void> {
    const params = new URLSearchParams();
    if (opts?.notifyAttendees) params.set("sendUpdates", "all");
    const qs = params.toString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events/${encodeURIComponent(eventId)}${qs ? `?${qs}` : ""}`;
    const res = await this.authedFetch(url, { method: "DELETE" });
    // 404/410 both mean "already gone" — every existing call site wants the
    // event absent, so treat both as success rather than a retriable failure
    // (also spares the decline sweep a spurious error + 5-minute retry when
    // the owner deletes the event between re-verify and delete).
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google delete failed: ${res.status} ${await res.text()}`);
    }
  }

  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      this.calendarId,
    )}/events/${encodeURIComponent(eventId)}`;
    const res = await this.authedFetch(url);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Google get failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as GoogleEvent;
    return toCalendarEvent(body);
  }
  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    const url = "https://www.googleapis.com/calendar/v3/channels/stop";
    const res = await this.authedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
    });
    // 404/410 means the channel is already gone — that is exactly the state we
    // want, so treat it as success. Any other non-ok status is a real failure:
    // throw so the admin one-shot (Task 8) surfaces it. Best-effort callers
    // (subscription rotation, Task 7) wrap this in try/catch and swallow.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`stopChannel failed: ${res.status} ${await res.text()}`);
    }
  }

  verifyWebhook(_headers: Headers, _body: string): boolean {
    throw new Error("Not implemented in this plan — Plan D");
  }
}

export { SyncTokenInvalidatedError };
