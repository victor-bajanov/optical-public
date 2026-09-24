import { unfoldLines } from "./ics-lines";

export class OutputLeakError extends Error {
  constructor(
    message: string,
    public readonly check: string,
    public readonly lineNumber: number,
  ) {
    super(message);
    this.name = "OutputLeakError";
  }
}

const FORBIDDEN_PROPS = new Set([
  "DESCRIPTION",
  "LOCATION",
  "ATTENDEE",
  "ORGANIZER",
  "URL",
  "ATTACH",
  "COMMENT",
  "CONTACT",
  "CATEGORIES",
  "CLASS",
  "PRIORITY",
  "REQUEST-STATUS",
  "RESOURCES",
  "RELATED-TO",
  "SEQUENCE",
]);

const ALLOWED_CALENDAR_PROPS = new Set([
  "PRODID", "VERSION", "CALSCALE", "METHOD",
]);

const ALLOWED_VEVENT_PROPS = new Set([
  "DTSTART", "DTEND", "DURATION", "DTSTAMP", "UID",
  "STATUS", "TRANSP", "RRULE", "RDATE", "EXDATE",
  "RECURRENCE-ID", "SUMMARY",
]);

const CONTENT_EXEMPT_PROPS = new Set(["UID", "PRODID"]);

const PHONE_EXEMPT_PROPS = new Set([
  "DTSTART", "DTEND", "DTSTAMP", "EXDATE", "RDATE", "RECURRENCE-ID",
  "RRULE", "DURATION",
]);

const CONTENT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\S+@\S+\.\S+/, label: "email address" },
  { pattern: /https?:\/\//, label: "URL" },
  { pattern: /zoom\.us|teams\.microsoft\.com|meet\.google\.com|webex\.com/i, label: "meeting link" },
  { pattern: /\+?\d[\d\s\-()]{6,}\d/, label: "phone number" },
];

function propName(line: string): string {
  const colon = line.indexOf(":");
  const semi = line.indexOf(";");
  let end: number;
  if (colon === -1 && semi === -1) return line.toUpperCase();
  if (colon === -1) end = semi;
  else if (semi === -1) end = colon;
  else end = Math.min(colon, semi);
  return line.slice(0, end).toUpperCase();
}

/** Narrow carve-out for the phone-number pattern: dates and times are
 *  legitimate, expected-to-reveal content in event titles (e.g. "hold -
 *  2026-07-21 11:00"), but their digit runs otherwise look exactly like the
 *  phone pattern's digit/space/dash run. Strip ISO dates and clock times
 *  before testing for a phone number; every other pattern still scans the
 *  original value. The date strip is anchored to a plausible year prefix
 *  (19xx/20xx) so a dash-grouped phone number (e.g. "0412-34-56 78:90",
 *  "1300-22-33 45") isn't mistaken for a date and stripped away — real
 *  AU exchange/mobile prefixes never start with 19 or 20. */
function stripDateTimeShapesForPhoneCheck(value: string): string {
  return value
    .replace(/(?:19|20)\d{2}-\d{2}-\d{2}/g, "")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "");
}

function matchesContentPattern(value: string, pattern: RegExp, label: string): boolean {
  const testValue = label === "phone number" ? stripDateTimeShapesForPhoneCheck(value) : value;
  return pattern.test(testValue);
}

/** First content-pattern label found in a value, or null if clean. Used by
 *  the builder to pre-screen titles before deliberately revealing them. */
export function contentLeakLabel(value: string): string | null {
  for (const { pattern, label } of CONTENT_PATTERNS) {
    if (matchesContentPattern(value, pattern, label)) return label;
  }
  return null;
}

/**
 * @param allowedSummaries Deliberately-revealed titles, in ICS-escaped
 *   (RFC 5545 TEXT) form. Check 2 compares each SUMMARY against this set
 *   using the raw on-the-wire value (after the property-name colon, still
 *   backslash-escaped), so entries must match that escaped form exactly —
 *   an unescaped or otherwise mismatched entry fails closed.
 */
export function guardOutput(sanitisedIcs: string, allowedSummaries: Set<string> = new Set()): void {
  const lines = unfoldLines(sanitisedIcs);
  let tzDepth = 0;
  let context: "calendar" | "vevent" = "calendar";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const name = propName(line);

    // Track VTIMEZONE blocks (contents are safe — timezone definitions only)
    if (line === "BEGIN:VTIMEZONE") {
      tzDepth = 1;
      continue;
    }
    if (tzDepth > 0) {
      if (line.startsWith("BEGIN:")) tzDepth++;
      if (line.startsWith("END:")) {
        tzDepth--;
        if (tzDepth === 0) context = "calendar";
      }
      continue;
    }

    // Track VEVENT context
    if (line === "BEGIN:VEVENT") {
      context = "vevent";
      continue;
    }
    if (line === "END:VEVENT") {
      context = "calendar";
      continue;
    }

    // Check 1: Forbidden property names
    if (FORBIDDEN_PROPS.has(name)) {
      throw new OutputLeakError(
        `Forbidden property "${name}" at line ${i + 1}: ${line.slice(0, 80)}`,
        "forbidden_property",
        i + 1,
      );
    }

    // Check 1b: X-* properties outside VTIMEZONE
    if (name.startsWith("X-")) {
      throw new OutputLeakError(
        `Custom extension property "${name}" at line ${i + 1}: ${line.slice(0, 80)}`,
        "forbidden_property",
        i + 1,
      );
    }

    // Check 2: Summary must be "Busy" or a deliberately-revealed title
    if (name === "SUMMARY") {
      const value = line.slice(line.indexOf(":") + 1);
      if (value !== "Busy" && !allowedSummaries.has(value)) {
        throw new OutputLeakError(
          `Invalid SUMMARY at line ${i + 1}: ${line.slice(0, 80)}`,
          "bad_summary",
          i + 1,
        );
      }
    }

    // Check 3: Content pattern scanning
    if (!CONTENT_EXEMPT_PROPS.has(name)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx >= 0) {
        const value = line.slice(colonIdx + 1);
        for (const { pattern, label } of CONTENT_PATTERNS) {
          // Skip phone number check on date/time properties
          if (label === "phone number" && PHONE_EXEMPT_PROPS.has(name)) continue;
          if (matchesContentPattern(value, pattern, label)) {
            throw new OutputLeakError(
              `Detected ${label} in "${name}" at line ${i + 1}: ${line.slice(0, 80)}`,
              "content_pattern",
              i + 1,
            );
          }
        }
      }
    }

    // Check 4: Structural validation
    // Skip structural lines we already handle
    if (line === "BEGIN:VCALENDAR" || line === "END:VCALENDAR") continue;

    if (context === "calendar") {
      if (line.startsWith("BEGIN:") || line.startsWith("END:")) {
        throw new OutputLeakError(
          `Unexpected component at line ${i + 1}: ${line.slice(0, 80)}`,
          "structural",
          i + 1,
        );
      }
      if (!ALLOWED_CALENDAR_PROPS.has(name)) {
        throw new OutputLeakError(
          `Unknown property "${name}" at calendar level, line ${i + 1}: ${line.slice(0, 80)}`,
          "structural",
          i + 1,
        );
      }
    } else if (context === "vevent") {
      if (line.startsWith("BEGIN:") || line.startsWith("END:")) {
        throw new OutputLeakError(
          `Unexpected sub-component at line ${i + 1}: ${line.slice(0, 80)}`,
          "structural",
          i + 1,
        );
      }
      if (!ALLOWED_VEVENT_PROPS.has(name)) {
        throw new OutputLeakError(
          `Unknown property "${name}" in VEVENT, line ${i + 1}: ${line.slice(0, 80)}`,
          "structural",
          i + 1,
        );
      }
    }
  }
}
