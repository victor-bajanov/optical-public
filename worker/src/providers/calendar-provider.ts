import type { CalendarEvent, IncrementalResult, Subscription } from "./types";

export interface BusyInterval {
  start: string; // ISO-Z
  end: string; // ISO-Z
}

/** Per-calendar free/busy result: busy intervals, or an error string when that
 *  calendar is unreadable (unshared / private / not found). Never throws per
 *  calendar — the absence of visibility is data, surfaced as a warning upstream. */
export type FreeBusyResult = { busy: BusyInterval[] } | { error: string };

export interface UpdateEventOptions {
  /** Notify attendees of the change (Google sendUpdates=all). Provider may
   *  no-op this knob (e.g. Microsoft auto-notifies). */
  notifyAttendees?: boolean;
}

export interface CreateEventOptions {
  /** Notify attendees of the invitation (Google sendUpdates=all). Provider
   *  may no-op this knob (e.g. Microsoft auto-notifies attendees on any
   *  meeting-relevant create — no sendUpdates equivalent). */
  notifyAttendees?: boolean;
  /** Attach a video-conference link. Google: a Meet conference, via
   *  conferenceDataVersion=1 + conferenceData.createRequest (keyed by
   *  conferenceRequestId below). Microsoft: a Teams meeting, via
   *  isOnlineMeeting:true + onlineMeetingProvider:"teamsForBusiness" —
   *  conferenceRequestId is ignored (Graph has no equivalent per-request
   *  idempotency knob). */
  addMeet?: boolean;
  /** Idempotency key Google requires for a conference request. Ignored by
   *  providers with no equivalent knob (e.g. Microsoft). */
  conferenceRequestId?: string;
}

export interface DeleteEventOptions {
  /** Send Google's cancellation email to attendees (sendUpdates=all). */
  notifyAttendees?: boolean;
}

export interface CalendarProvider {
  subscribeToChanges(callbackUrl: string, channelToken: string): Promise<Subscription>;
  /** `opts.syncToken` defaults to true (today's behaviour: the provider may
   *  use whatever incremental-sync mechanism it has and returns a usable
   *  nextSyncToken). `{ syncToken: false }` tells the provider the caller
   *  will discard nextSyncToken, so it may take a cheaper plain bounded read
   *  instead — Microsoft avoids opening a wide-horizon delta subscription for
   *  a throwaway read; Google ignores the option and behaves as before. */
  fetchEventsInWindow(
    start: string,
    end: string,
    opts?: { syncToken?: boolean },
  ): Promise<{ events: CalendarEvent[]; nextSyncToken: string }>;
  fetchIncrementalChanges(syncToken: string): Promise<IncrementalResult>;
  createEvent(
    event: CalendarEvent,
    schedulerMetadata: Record<string, string>,
    opts?: CreateEventOptions,
  ): Promise<{ eventId: string }>;
  updateEvent(
    eventId: string,
    changes: Partial<CalendarEvent>,
    opts?: UpdateEventOptions,
  ): Promise<void>;
  /** Busy intervals only (free is implied) for each calendar id over `window`.
   *  Per-calendar errors are reported in the result map, never thrown. */
  queryFreeBusy(
    calendarIds: string[],
    window: { start: string; end: string },
  ): Promise<Map<string, FreeBusyResult>>;
  deleteEvent(eventId: string, opts?: DeleteEventOptions): Promise<void>;
  /** Single-event fetch. Returns null when the event is gone (404/410) — a
   *  Google-side "cancelled" event may instead come back with
   *  `status: "cancelled"`; callers that care must check `status` themselves.
   *  A cancelled event (e.g. a cancelled instance of a recurring series) may
   *  carry empty-string `start`/`end` and no `attendees` — callers must check
   *  `status`/null FIRST, before touching dates or attendees. */
  getEvent(eventId: string): Promise<CalendarEvent | null>;
  verifyWebhook(headers: Headers, body: string): boolean;
  /** Stop a Google push channel so it stops delivering (channels.stop). */
  stopChannel(channelId: string, resourceId: string): Promise<void>;
  /** Renew an existing subscription in place (Graph PATCH). Providers whose
   *  upstream forbids duplicate subscriptions (Microsoft: 409) implement this;
   *  Google omits it and keeps the rotate path. */
  renewSubscription?(channelId: string): Promise<{ expiresAt: string }>;
  /** Value to write as colorId when un-marking done. Providers whose done
   *  marker is set-membership (Microsoft categories) need an explicit clear
   *  sentinel; when omitted the caller falls back to its create color. */
  readonly undoneColorId?: string;
  /** Provider-shaped floor for the "done" marker color, under
   *  `users.done_color_id` but above `env.DONE_COLOR_ID`: precedence is
   *  `users.done_color_id` > `defaultDoneColorId` > `env.DONE_COLOR_ID`.
   *  A numeric Google colorId (the env default) is meaningless for a
   *  Microsoft user (Outlook has categories, not colorIds) — omitted by
   *  Google (the env default stays authoritative there), set by Microsoft to
   *  its "Optical Done" category. See getDoneColorId (db/users.ts) and its
   *  three callers. */
  readonly defaultDoneColorId?: string;
}

export class SyncTokenInvalidatedError extends Error {
  constructor() {
    super("Google sync token is no longer valid; perform a full window fetch");
    this.name = "SyncTokenInvalidatedError";
  }
}
