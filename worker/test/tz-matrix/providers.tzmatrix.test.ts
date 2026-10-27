// tz-matrix mirror of test/providers/provider-contract.test.ts's all-day case,
// carried end to end: each provider's real wire shape for an all-day event
// ("Vacation" on 2026-05-19), read through fetchEventsInWindow, then through
// deriveBusyBlocks in the user's zone, must block exactly local 2026-05-19.
// Graph's shape follows the repo's own contract fixture (floating midnight,
// read with Prefer outlook.timezone="UTC").
import { describe, it, expect, vi } from "vitest";
import { GoogleCalendarProvider } from "../../src/providers/google-calendar-provider";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { deriveBusyBlocks } from "../../src/planning/busy-blocks";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, dayStartIso } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const providers = [
  {
    name: "Google",
    build: (f: typeof fetch) => new GoogleCalendarProvider({ calendarId: "primary", getAccessToken: async () => "tok", fetch: f }),
    body: () => json({ items: [{ id: "vac", summary: "Vacation", start: { date: "2026-05-19" }, end: { date: "2026-05-20" } }], nextSyncToken: "s" }),
  },
  {
    name: "Microsoft",
    build: (f: typeof fetch) => new MicrosoftCalendarProvider({ getAccessToken: async () => "tok", fetch: f }),
    body: () => json({
      value: [{ id: "vac", subject: "Vacation", showAs: "oof", isCancelled: false, isAllDay: true,
        start: { dateTime: "2026-05-19T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-05-20T00:00:00.0000000", timeZone: "UTC" } }],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final",
    }),
  },
];

describe.each(providers)("$name all-day event, end to end", (p) => {
  it.each(ALL_ZONES)("blocks exactly local 2026-05-19 in %s", async (tz) => {
    const f = vi.fn().mockResolvedValueOnce(p.body());
    const r = await p.build(f as unknown as typeof fetch).fetchEventsInWindow("2026-05-17T00:00:00Z", "2026-05-24T00:00:00Z");
    const blocks = deriveBusyBlocks(r.events, { tz, tentativeIsBusy: false, excludeEventIds: new Set() });
    expect(blocks.map((b) => [b.startUtc, b.endUtc])).toEqual([[dayStartIso("2026-05-19", tz), dayStartIso("2026-05-20", tz)]]);
  });
});
