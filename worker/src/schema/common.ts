import { z } from "zod";
import { D } from "./descriptions";

export const ContextEnum = z.enum(["deep", "admin", "physical", "family", "meeting"]);
export type Context = z.infer<typeof ContextEnum>;

/** `HH:MM` on a real clock, zero-padded so lexicographic compare is
 *  chronological. Shared by booking-page hours and context fit curves —
 *  one definition so accepted formats can't drift between them. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// "YYYY-MM-DDTHH:MM" (local, no tz) or full ISO 8601 datetime.
export const IsoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, "expected ISO datetime")
  .describe(D.common.isoDateTime);

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").describe(D.common.isoDate);
export const TimeOfDay = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM").describe(D.common.timeOfDay);
export const Uuid = z.string().uuid().describe(D.common.uuid);

// Canonical IANA zone name as Intl resolves it ("europe/london" →
// "Europe/London", "GMT" → "UTC"). Throws RangeError for an unknown zone, and
// for two kinds Intl accepts but that silently mis-schedule:
//  - a UTC-offset identifier ("+10:00", "+1000"): valid under current
//    ECMA-402 but not an IANA zone — no DST rules, and Python's ZoneInfo
//    can't load it;
//  - a bare legacy name with no Area/ ("EST" → America/Panama, "MST" →
//    America/Phoenix — fixed offsets a US-Eastern user doesn't mean), unless
//    it is a UTC alias ("UTC", "GMT", "Zulu").
// Etc/GMT±N and backward links with an Area ("US/Eastern") stay valid.
export function canonicalZoneName(tz: string): string {
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  if (/^[+-]/.test(canonical)) throw new RangeError(`UTC offset is not an IANA timezone: ${tz}`);
  if (!tz.includes("/") && canonical !== "UTC") {
    throw new RangeError(`bare zone name is ambiguous, use Area/Location (e.g. ${canonical}): ${tz}`);
  }
  return canonical;
}

// IANA zone validator (see canonicalZoneName); parses to the canonical
// spelling, so every write path stores one form. Shared by template pinned_tz,
// task preferred_windows[].tz (incl. a template's task_body) and the
// /v1/timezone setter.
export const IanaZone = z.string().transform((s, ctx) => {
  try {
    return canonicalZoneName(s);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid IANA timezone (e.g. 'Australia/Sydney', 'America/New_York'); UTC offsets like '+10:00' and bare abbreviations like 'EST' are not accepted",
    });
    return z.NEVER;
  }
});
