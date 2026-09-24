import type {
  CalendarProvider,
  CreateEventOptions,
  DeleteEventOptions,
  FreeBusyResult,
  UpdateEventOptions,
} from "./calendar-provider";
import type { CalendarEvent, IncrementalResult, Subscription } from "./types";

interface MockOptions {
  events?: CalendarEvent[];
  freeBusy?: Record<string, FreeBusyResult>;
  /** Mirrors MicrosoftCalendarProvider: when true, exposes renewSubscription
   *  so subscription-manager tests can drive the in-place-renewal branch. */
  supportsRenew?: boolean;
}

export class MockCalendarProvider implements CalendarProvider {
  private events: CalendarEvent[];
  private created: CalendarEvent[] = [];
  /** Per-call `createEvent` options, in call order (`undefined` when omitted). */
  createOptions: Array<CreateEventOptions | undefined> = [];
  updated: { eventId: string; changes: Partial<CalendarEvent> }[] = [];
  private deleted: string[] = [];
  private stoppedChannels: { channelId: string; resourceId: string }[] = [];
  private subscribeCount = 0;
  private tokenCounter = 1;
  private readonly freeBusyFixture: Record<string, FreeBusyResult>;
  lastUpdate?: { eventId: string; changes: Partial<CalendarEvent>; opts?: UpdateEventOptions };
  /** Per-call `deleteEvent` options, in call order. */
  deleteOptions: Array<{ eventId: string; opts?: DeleteEventOptions }> = [];
  /** Populated only when constructed with `supportsRenew: true`. */
  renewedChannelIds: string[] = [];
  renewSubscription?(channelId: string): Promise<{ expiresAt: string }>;

  constructor(opts: MockOptions = {}) {
    this.events = [...(opts.events ?? [])];
    this.freeBusyFixture = opts.freeBusy ?? {};
    if (opts.supportsRenew) {
      this.renewSubscription = async (channelId: string) => {
        this.renewedChannelIds.push(channelId);
        return { expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() };
      };
    }
  }

  getSubscribeCallCount(): number {
    return this.subscribeCount;
  }

  getCreated(): CalendarEvent[] {
    return this.created;
  }

  getUpdated(): { eventId: string; changes: Partial<CalendarEvent> }[] {
    return this.updated;
  }

  getDeleted(): string[] {
    return this.deleted;
  }

  getStoppedChannels(): { channelId: string; resourceId: string }[] {
    return this.stoppedChannels;
  }

  /**
   * Test helper: append an event as if an external party (e.g. Google
   * Calendar invite) added it. Subsequent `fetchEventsInWindow` calls will
   * surface it; `buildSolverProblem` will see it as a fixed input (no
   * scheduler_chunk_id metadata).
   */
  injectExternalEvent(event: Omit<CalendarEvent, "extendedProperties">): void {
    this.events.push({
      id: event.id,
      summary: event.summary,
      start: event.start,
      end: event.end,
      status: event.status,
      eventType: event.eventType,
      isAllDay: event.isAllDay,
      extendedProperties: { private: {} },
    });
  }

  async subscribeToChanges(_callbackUrl: string, channelToken: string): Promise<Subscription> {
    this.subscribeCount++;
    return {
      channelId: `mock-channel-${this.tokenCounter++}`,
      channelToken,
      resourceId: "mock-resource",
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    };
  }

  async fetchEventsInWindow(start: string, end: string, opts?: { syncToken?: boolean }) {
    const s = Date.parse(start);
    const e = Date.parse(end);
    const events = this.events.filter(
      (ev) => Date.parse(ev.start) >= s && Date.parse(ev.end) <= e,
    );
    // Returning "" for nextSyncToken when the caller opts out mirrors
    // Microsoft's { syncToken: false } plain-read path
    // (fetchEventsInWindowPlain), not Google — Google's own provider ignores
    // the option entirely and always returns a real sync token regardless.
    return { events, nextSyncToken: opts?.syncToken === false ? "" : `mock-${this.tokenCounter++}` };
  }

  async fetchIncrementalChanges(_syncToken: string): Promise<IncrementalResult> {
    return { changes: [], nextSyncToken: `mock-${this.tokenCounter++}`, syncTokenInvalidated: false };
  }

  async createEvent(
    event: CalendarEvent,
    schedulerMetadata: Record<string, string>,
    opts?: CreateEventOptions,
  ) {
    this.createOptions.push(opts);
    const id = `mock-evt-${this.tokenCounter++}`;
    const stored: CalendarEvent = {
      ...event,
      id,
      extendedProperties: {
        ...(event.extendedProperties ?? {}),
        private: { ...(event.extendedProperties?.private ?? {}), ...schedulerMetadata },
      },
    };
    this.events.push(stored);
    this.created.push(stored);
    return { eventId: id };
  }

  async updateEvent(
    eventId: string,
    changes: Partial<CalendarEvent>,
    opts?: UpdateEventOptions,
  ): Promise<void> {
    this.lastUpdate = { eventId, changes, opts };
    this.updated.push({ eventId, changes });
    this.events = this.events.map((e) => (e.id === eventId ? { ...e, ...changes } : e));
  }

  async queryFreeBusy(
    calendarIds: string[],
    _window: { start: string; end: string },
  ): Promise<Map<string, FreeBusyResult>> {
    const out = new Map<string, FreeBusyResult>();
    for (const id of calendarIds) {
      out.set(id, this.freeBusyFixture[id] ?? { busy: [] });
    }
    return out;
  }

  async deleteEvent(eventId: string, opts?: DeleteEventOptions): Promise<void> {
    this.deleted.push(eventId);
    this.deleteOptions.push({ eventId, opts });
    this.events = this.events.filter((e) => e.id !== eventId);
  }

  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    return this.events.find((e) => e.id === eventId) ?? null;
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    this.stoppedChannels.push({ channelId, resourceId });
  }

  verifyWebhook(_headers: Headers, _body: string): boolean {
    return true;
  }
}
