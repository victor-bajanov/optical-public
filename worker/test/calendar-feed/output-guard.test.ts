import { describe, it, expect } from "vitest";
import { guardOutput, OutputLeakError, contentLeakLabel } from "../../src/calendar-feed/output-guard";

const CLEAN = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//optical//busy-feed//EN",
  "CALSCALE:GREGORIAN",
  "BEGIN:VEVENT",
  "UID:abc123@scheduler.example.com",
  "DTSTAMP:20260609T000000Z",
  "DTSTART:20260610T090000Z",
  "DTEND:20260610T100000Z",
  "SUMMARY:Busy",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("guardOutput (vendored)", () => {
  it("passes a clean busy calendar", () => {
    expect(() => guardOutput(CLEAN)).not.toThrow();
  });

  it("throws on a leaked DESCRIPTION", () => {
    const leaky = CLEAN.replace("SUMMARY:Busy", "SUMMARY:Busy\r\nDESCRIPTION:secret notes");
    expect(() => guardOutput(leaky)).toThrow(OutputLeakError);
  });

  it("throws on a non-Busy summary", () => {
    const leaky = CLEAN.replace("SUMMARY:Busy", "SUMMARY:Lunch with Client A");
    expect(() => guardOutput(leaky)).toThrow(OutputLeakError);
  });
});

describe("guardOutput with allowedSummaries", () => {
  const wrap = (summary: string) => [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//optical//busy-feed//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", "UID:u1", "DTSTAMP:20260723T000000Z",
    "DTSTART:20260723T010000Z", "DTEND:20260723T020000Z",
    `SUMMARY:${summary}`, "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n") + "\r\n";

  it("accepts a summary in the allowed set", () => {
    expect(() => guardOutput(wrap("Northwinds hold - x"), new Set(["Northwinds hold - x"]))).not.toThrow();
  });
  it("still accepts Busy without any set", () => {
    expect(() => guardOutput(wrap("Busy"))).not.toThrow();
  });
  it("rejects a summary NOT in the allowed set", () => {
    expect(() => guardOutput(wrap("Secret meeting"), new Set(["Other"]))).toThrow(OutputLeakError);
  });
  it("content patterns still apply to allowed summaries (fail closed)", () => {
    const s = "call +61 400 123 456 now";
    expect(() => guardOutput(wrap(s), new Set([s]))).toThrow(OutputLeakError);
  });

  it("requires the ICS-escaped form in the allowed set: escaped passes, unescaped fails closed", () => {
    const raw = "Northwinds, Site Reviews";
    const escaped = "Northwinds\\, Site Reviews"; // RFC 5545 TEXT escaping: comma -> \,
    expect(() => guardOutput(wrap(escaped), new Set([escaped]))).not.toThrow();
    expect(() => guardOutput(wrap(escaped), new Set([raw]))).toThrow(OutputLeakError);
  });
});

describe("contentLeakLabel", () => {
  it("labels emails, urls, meeting links, phones; null for clean text", () => {
    expect(contentLeakLabel("mail a@b.co")).toBe("email address");
    expect(contentLeakLabel("https://x.y")).toBe("URL");
    expect(contentLeakLabel("join zoom.us/j/1")).toBe("meeting link");
    expect(contentLeakLabel("+61 400 123 456")).toBe("phone number");
    expect(contentLeakLabel("Northwinds hold - 11am")).toBeNull();
  });

  it("does not mistake a date/time-bearing title for a phone number", () => {
    expect(contentLeakLabel("Northwinds hold - 2026-07-21 11:00")).toBeNull();
    expect(contentLeakLabel("2026-07-21")).toBeNull();
    expect(contentLeakLabel("meet at 11:00")).toBeNull();
  });

  it("still catches real phone numbers once date/time shapes are stripped", () => {
    expect(contentLeakLabel("+61 400 123 456")).toBe("phone number");
    expect(contentLeakLabel("(02) 9999 8888")).toBe("phone number");
    expect(contentLeakLabel("call 0400 123 456 now")).toBe("phone number");
  });

  it("does not let a 4-2-2-grouped phone number evade the strip as a fake date", () => {
    expect(contentLeakLabel("0412-34-56 78:90")).toBe("phone number");
    expect(contentLeakLabel("call 1300-22-33 45 now")).toBe("phone number");
  });
});

describe("guardOutput phone-vs-date carve-out", () => {
  const wrap = (summary: string) => [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//optical//busy-feed//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", "UID:u1", "DTSTAMP:20260723T000000Z",
    "DTSTART:20260723T010000Z", "DTEND:20260723T020000Z",
    `SUMMARY:${summary}`, "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n") + "\r\n";

  it("accepts an allowed summary carrying a date/time (previously false-positived as a phone number)", () => {
    const s = "Northwinds hold - 2026-07-21 11:00";
    expect(() => guardOutput(wrap(s), new Set([s]))).not.toThrow();
  });

  it("still rejects an allowed summary containing a real phone number (fail-closed regression check)", () => {
    const s = "call +61 400 123 456 now";
    expect(() => guardOutput(wrap(s), new Set([s]))).toThrow(OutputLeakError);
  });
});
