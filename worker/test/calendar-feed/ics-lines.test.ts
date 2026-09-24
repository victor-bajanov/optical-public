import { describe, it, expect } from "vitest";
import { escapeText } from "../../src/calendar-feed/ics-lines";

describe("escapeText (RFC 5545 TEXT)", () => {
  it("escapes backslash, semicolon, comma and newline", () => {
    expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });
  it("leaves plain text alone", () => {
    expect(escapeText("Northwinds hold - 2026-07-21 11:00")).toBe("Northwinds hold - 2026-07-21 11:00");
  });
  it("handles CRLF as one newline", () => {
    expect(escapeText("a\r\nb")).toBe("a\\nb");
  });
});
