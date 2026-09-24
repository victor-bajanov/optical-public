import type { Env } from "../env";
import type { CalendarEvent } from "../providers/types";
import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import { capabilityHmacKey } from "../auth/crypto-keys";
import { hashEventUid } from "./uid";
import { foldLine, escapeText } from "./ics-lines";
import { titleMatches } from "./reveal-rules";
import { contentLeakLabel } from "./output-guard";

/** The optical task id an event belongs to, or null for a real (external)
 *  meeting. Optical tags its own events with scheduler_chunk_id = `<task>#<i>`
 *  (see planning/build-problem.ts); resolve-internal.ts derives the task the
 *  same way. */
export function taskIdOfEvent(e: CalendarEvent): string | null {
  const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
  if (!chunkId) return null;
  const hashIdx = chunkId.lastIndexOf("#");
  return hashIdx >= 0 ? chunkId.slice(0, hashIdx) : chunkId;
}

/** Keep an event if it is a real meeting (no scheduler tag) OR a PINNED optical
 *  task. Movable (non-pinned) optical tasks are dropped — that time is flexible
 *  and optical replans around bookings. Cancelled events are dropped. */
export function selectBusyEvents(events: CalendarEvent[], pinnedTaskIds: Set<string>): CalendarEvent[] {
  return events.filter((e) => {
    if ((e.status ?? "").toLowerCase() === "cancelled") return false;
    const taskId = taskIdOfEvent(e);
    if (taskId === null) return true;
    return pinnedTaskIds.has(taskId);
  });
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function timeLines(e: CalendarEvent): string[] {
  if (e.isAllDay) {
    const ds = e.start.slice(0, 10).replace(/-/g, "");
    const de = e.end.slice(0, 10).replace(/-/g, "");
    return [`DTSTART;VALUE=DATE:${ds}`, `DTEND;VALUE=DATE:${de}`];
  }
  return [`DTSTART:${utcStamp(new Date(e.start))}`, `DTEND:${utcStamp(new Date(e.end))}`];
}

/** Emit a busy VCALENDAR from already-selected events. Titles that full-match
 *  a reveal regex AND pass the content screen are shown verbatim (escaped);
 *  everything else is an opaque `SUMMARY:Busy` block. Returns the escaped
 *  revealed titles so the output guard can allow exactly those. */
export async function buildBusyIcs(
  events: CalendarEvent[],
  now: Date,
  env: Env,
  revealRegexes: RegExp[] = [],
): Promise<{ ics: string; allowedSummaries: Set<string> }> {
  const key = capabilityHmacKey(env);
  const dtstamp = utcStamp(now);
  const allowedSummaries = new Set<string>();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//optical//busy-feed//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const e of events) {
    const uid = await hashEventUid(e.id, key);
    let summary = "Busy";
    if (titleMatches(e.summary, revealRegexes) && contentLeakLabel(e.summary) === null) {
      summary = escapeText(e.summary);
      allowedSummaries.add(summary);
    }
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${dtstamp}`, ...timeLines(e), `SUMMARY:${summary}`, "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return { ics: lines.map(foldLine).join("\r\n") + "\r\n", allowedSummaries };
}
