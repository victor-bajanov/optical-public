import type { AttendeeEnforcement } from "../meetings/identify";

/** Own row wins; else the instance default ('__default__'); else a hardcoded
 *  not_declined floor. Body is a JSON object so future per-user meeting prefs can
 *  extend it without a schema change. */
export async function loadMeetingPolicy(
  db: D1Database,
  ownerSubject: string,
): Promise<AttendeeEnforcement> {
  const row = await db
    .prepare(
      "SELECT body FROM config_meeting_policy WHERE owner_subject IN (?, '__default__') ORDER BY (owner_subject = ?) DESC LIMIT 1",
    )
    .bind(ownerSubject, ownerSubject)
    .first<{ body: string }>();
  if (!row) return "not_declined";
  const parsed = JSON.parse(row.body) as { attendee_enforcement?: AttendeeEnforcement };
  return parsed.attendee_enforcement ?? "not_declined";
}
