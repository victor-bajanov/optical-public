import { describe, it, expect } from "vitest";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";

describe("MockCalendarProvider.queryFreeBusy", () => {
  it("returns fixture busy intervals and an error for an unknown calendar", async () => {
    const provider = new MockCalendarProvider({
      freeBusy: {
        "a@x.com": { busy: [{ start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:00:00Z" }] },
        "b@x.com": { error: "notFound" },
      },
    });
    const res = await provider.queryFreeBusy(["a@x.com", "b@x.com"], {
      start: "2026-05-18T00:00:00Z",
      end: "2026-05-25T00:00:00Z",
    });
    expect(res.get("a@x.com")).toEqual({
      busy: [{ start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:00:00Z" }],
    });
    expect(res.get("b@x.com")).toEqual({ error: "notFound" });
  });

  it("captures notifyAttendees on updateEvent", async () => {
    const provider = new MockCalendarProvider({});
    await provider.updateEvent("evt1", { start: "2026-05-19T10:00:00Z" }, { notifyAttendees: true });
    expect(provider.lastUpdate).toMatchObject({
      eventId: "evt1",
      opts: { notifyAttendees: true },
    });
  });
});
