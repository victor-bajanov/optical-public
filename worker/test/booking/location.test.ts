import { describe, it, expect } from "vitest";
import {
  validateLocationModes,
  LocationError,
  offerableModes,
  needsOwnerDetail,
  MAX_LOCATION_LENGTH,
  locationForEvent,
} from "../../src/booking/location";

describe("validateLocationModes", () => {
  it("accepts the shipped default set", () => {
    expect(() =>
      validateLocationModes([{ kind: "meet" }, { kind: "phone" }, { kind: "in_person" }]),
    ).not.toThrow();
  });

  it("rejects an empty set", () => {
    expect(() => validateLocationModes([])).toThrow(LocationError);
    expect(() => validateLocationModes([])).toThrow("at least one location mode is required");
  });

  it("rejects a non-array value with a type-shaped message, not the empty-set count message", () => {
    expect(() => validateLocationModes(null as never)).toThrow(LocationError);
    expect(() => validateLocationModes(null as never)).toThrow(/array/i);
    expect(() => validateLocationModes(null as never)).not.toThrow(
      "at least one location mode is required",
    );

    expect(() => validateLocationModes({} as never)).toThrow(LocationError);
    expect(() => validateLocationModes({} as never)).toThrow(/array/i);
    expect(() => validateLocationModes({} as never)).not.toThrow(
      "at least one location mode is required",
    );
  });

  it("rejects duplicate kinds", () => {
    expect(() => validateLocationModes([{ kind: "meet" }, { kind: "meet" }])).toThrow(
      /duplicate/i,
    );
  });

  it("rejects custom without detail", () => {
    // custom is the owner's fixed text; with nothing to show it is unusable.
    expect(() => validateLocationModes([{ kind: "custom" }])).toThrow(/detail/i);
    expect(() => validateLocationModes([{ kind: "custom", detail: "  " }])).toThrow(/detail/i);
  });

  it("rejects detail on a kind that does not use it", () => {
    // Strict on purpose: phone.detail must not become a place to stash the
    // owner's own number, which is what leaked it before.
    expect(() => validateLocationModes([{ kind: "phone", detail: "+61 400 000 000" }])).toThrow(
      /detail/i,
    );
  });

  it("rejects detail longer than the cap", () => {
    expect(() =>
      validateLocationModes([{ kind: "custom", detail: "x".repeat(MAX_LOCATION_LENGTH + 1) }]),
    ).toThrow(LocationError);
  });

  it("accepts a detail that exceeds the cap only before trimming", () => {
    // Whitespace padding pushes the raw length over the cap, but the code
    // measures after trimming — the trimmed value fits, so this is fine.
    const padded = `  ${"x".repeat(MAX_LOCATION_LENGTH)}  `;
    expect(padded.length).toBeGreaterThan(MAX_LOCATION_LENGTH);
    expect(() => validateLocationModes([{ kind: "custom", detail: padded }])).not.toThrow();
  });

  it("accepts a detail exactly at the cap after trimming", () => {
    expect(() =>
      validateLocationModes([{ kind: "custom", detail: "x".repeat(MAX_LOCATION_LENGTH) }]),
    ).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => validateLocationModes([{ kind: "zoom" } as never])).toThrow(LocationError);
  });

  it("rejects more than four entries", () => {
    expect(() =>
      validateLocationModes([
        { kind: "meet" },
        { kind: "phone" },
        { kind: "in_person" },
        { kind: "custom", detail: "Level 3" },
        { kind: "meet" },
      ]),
    ).toThrow(LocationError);
  });
});

describe("needsOwnerDetail", () => {
  it("is true only for custom", () => {
    expect(needsOwnerDetail("custom")).toBe(true);
    expect(needsOwnerDetail("meet")).toBe(false);
    expect(needsOwnerDetail("phone")).toBe(false);
    expect(needsOwnerDetail("in_person")).toBe(false);
  });
});

describe("offerableModes", () => {
  it("drops a custom entry with no usable detail", () => {
    // Reachable only from a legacy row: validation forbids storing this.
    expect(offerableModes([{ kind: "meet" }, { kind: "custom", detail: null }])).toEqual([
      { kind: "meet" },
    ]);
  });

  it("keeps every usable entry in the owner's order", () => {
    const modes = [{ kind: "phone" as const }, { kind: "meet" as const }];
    expect(offerableModes(modes)).toEqual(modes);
  });
});

describe("locationForEvent", () => {
  const offered = [
    { kind: "meet" as const },
    { kind: "phone" as const },
    { kind: "in_person" as const },
    { kind: "custom" as const, detail: "Level 3, 100 Collins St" },
  ];

  it("asks the provider for a conference on meet and sets no location", () => {
    expect(locationForEvent("meet", null, offered)).toEqual({ addMeet: true });
  });

  it("labels the booker's number on phone", () => {
    expect(locationForEvent("phone", "+61 400 000 000", offered)).toEqual({
      addMeet: false,
      location: "Phone: +61 400 000 000",
    });
  });

  it("uses the booker's text verbatim in person", () => {
    expect(locationForEvent("in_person", "The Kettle, Fitzroy", offered)).toEqual({
      addMeet: false,
      location: "The Kettle, Fitzroy",
    });
  });

  it("uses the owner's fixed text on custom and ignores any booker detail", () => {
    expect(locationForEvent("custom", "ignored", offered)).toEqual({
      addMeet: false,
      location: "Level 3, 100 Collins St",
    });
  });

  it("never emits owner contact details for a booker-detail kind", () => {
    // The old code put location.detail (the OWNER's number) on the event for
    // every non-meet mode, mailing it to every booker via notifyAttendees.
    const withLegacyOwnerNumber = [{ kind: "phone" as const, detail: "+61 499 999 999" }];
    const out = locationForEvent("phone", "+61 400 000 000", withLegacyOwnerNumber);
    expect(out.location).toBe("Phone: +61 400 000 000");
    expect(out.location).not.toContain("499");
  });

  it("throws when the kind is not offered by this page", () => {
    expect(() => locationForEvent("in_person", "x", [{ kind: "meet" }])).toThrow(LocationError);
  });
});
