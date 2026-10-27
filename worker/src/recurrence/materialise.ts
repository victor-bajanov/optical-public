import { expandRRule } from "./rrule";
import { fromLocalNaiveCompatible, localNaiveMs } from "../planning/datetime";
import type { LocalNaive } from "../planning/solver-contract";
import { TaskCreate } from "../schema/task";

/** Keys the materialiser owns — task_body must never override these. project_id
 *  is intentionally absent: a template targets a project via task_body.project_id. */
const RESERVED_TASK_BODY_KEYS = ["template_id", "earliest_start", "pinned_at", "source"] as const;

export interface TemplateBody {
  title: string;
  context: "deep" | "admin" | "physical" | "family" | "meeting";
  rrule: string;
  pinned_time?: string | null;
  pinned_tz?: string | null;
  duration_minutes: number;
  task_body?: Record<string, unknown>;
  active_from: string;
  active_until?: string | null;
}

export interface TemplateRow {
  id: string;
  body: TemplateBody;
}

export interface NewTaskInsert {
  id: string;
  /** owner_subject is intentionally absent: the sweep caller owns it and binds
   *  it directly in the INSERT so there is no risk of an empty-string sentinel
   *  reaching the database. Do not add it here. */
  template_id: string;
  project_id: string | null;
  status: "pending";
  /** Immutable occurrence key — the expander's local date (YYYY-MM-DD). The sweep
   *  dedupe key; never reconstructed from an instant. */
  occurrence_date: string;
  body: Record<string, unknown> & { template_id: string };
  created_at: string;
  updated_at: string;
}

interface MaterialiseOptions {
  now?: string;
  idFn?: () => string;
}

export function materialiseTemplate(
  template: TemplateRow,
  windowStart: string,
  windowEnd: string,
  existingOccurrences: Set<string>,
  homeTz: string,
  excludedOccurrences: Set<string> = new Set(),
  opts: MaterialiseOptions = {},
): NewTaskInsert[] {
  const now = opts.now ?? new Date().toISOString();
  const idFn = opts.idFn ?? (() => crypto.randomUUID());

  const tplBody = template.body;
  const activeUntil = tplBody.active_until ?? null;
  const pinTz = tplBody.pinned_tz ?? homeTz;

  // An unpinned occurrence is a date in the user's window. A pinned one is a
  // date in pinTz, and belongs to the window holding its pin: pinTz can be up
  // to a day off the user's zone either way, so expand a day of margin each
  // side and keep only pins inside [windowStart, windowEnd).
  const pinned = Boolean(tplBody.pinned_time);
  const { fromDate, toDate } = pinned
    ? localDateRange(windowStart, windowEnd, pinTz, 1)
    : localDateRange(windowStart, windowEnd, homeTz, 0);
  const occurrences = expandRRule(tplBody.rrule, tplBody.active_from, fromDate, toDate);
  const windowStartMs = Date.parse(windowStart);
  const windowEndMs = Date.parse(windowEnd);

  const out: NewTaskInsert[] = [];
  for (const occ of occurrences) {
    if (existingOccurrences.has(occ)) continue;
    if (excludedOccurrences.has(occ)) continue;
    if (activeUntil && occ > activeUntil) continue;

    const pinnedLocal = tplBody.pinned_time
      ? (`${occ}T${normaliseTime(tplBody.pinned_time)}:00` as LocalNaive)
      : null;
    // A time inside a DST gap (a pin at 02:30 on spring-forward day, or a
    // local midnight that doesn't exist) moves forward by the gap.
    const pinnedAt = pinnedLocal ? fromLocalNaiveCompatible(pinnedLocal, pinTz) : null;
    if (pinnedAt !== null) {
      const pinMs = Date.parse(pinnedAt);
      if (pinMs < windowStartMs || pinMs >= windowEndMs) continue;
    }
    const earliestStart = pinnedAt
      ?? fromLocalNaiveCompatible(`${occ}T00:00:00` as LocalNaive, homeTz);

    const reservedStripped = { ...(tplBody.task_body ?? {}) };
    for (const k of RESERVED_TASK_BODY_KEYS) delete reservedStripped[k];
    // Card E: a pinned_tz template's windows are read in that zone, so its
    // instances carry it on every window without one. Untimezoned templates stay
    // unstamped (their windows follow the user's tz until a change freezes them).
    if (tplBody.pinned_tz && Array.isArray(reservedStripped.preferred_windows)) {
      reservedStripped.preferred_windows = reservedStripped.preferred_windows.map((w: unknown) =>
        w && typeof w === "object" && !("tz" in w) ? { ...w, tz: tplBody.pinned_tz } : w,
      );
    }

    const body: Record<string, unknown> & { template_id: string } = {
      title: tplBody.title,
      context: tplBody.context,
      priority: 50,
      duration_minutes: tplBody.duration_minutes,
      earliest_start: earliestStart,
      pinned_at: pinnedAt,
      template_id: template.id,
      project_id: null,
      source: { kind: "cron", external_id: null },
      ...reservedStripped,
    };

    // RC4: validate the merged body to reject un-PATCHable task_body overrides.
    // template_id is excluded from the check: it is materialiser-owned (set from
    // template.id, which the sweep caller guarantees is a UUID), not part of the
    // user-supplied task_body that RC4 guards. Including it would spuriously fail
    // any non-UUID template id (e.g. test fixtures) without catching a real defect.
    const { template_id: _ownedTemplateId, ...bodyForValidation } = body;
    const validated = TaskCreate.safeParse(bodyForValidation);
    if (!validated.success) {
      console.warn(
        `materialiseTemplate: skipping ${template.id}@${occ} — task_body fails TaskCreate: ${JSON.stringify(validated.error.issues)}`,
      );
      continue;
    }

    out.push({
      id: idFn(),
      template_id: template.id,
      project_id: (body.project_id as string | null) ?? null,
      status: "pending",
      occurrence_date: occ,
      body,
      created_at: now,
      updated_at: now,
    });
  }
  return out;
}

/** The window's local calendar dates in `tz`, widened by `padDays` each
 *  side: the date of windowStart (inclusive) to the day after the date of
 *  windowEnd − 1ms (exclusive), so a partial last day counts. For the
 *  resolve's local week [Mon 00:00, next Mon 00:00) with no pad that is
 *  exactly Mon..Sun in every zone. */
function localDateRange(
  windowStart: string,
  windowEnd: string,
  tz: string,
  padDays: number,
): { fromDate: string; toDate: string } {
  const localDateMs = (ms: number) => {
    if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime in window ${windowStart}..${windowEnd}`);
    const naive = localNaiveMs(ms, tz);
    return naive - (((naive % 86_400_000) + 86_400_000) % 86_400_000);
  };
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = localDateMs(Date.parse(windowStart)) - padDays * 86_400_000;
  const to = localDateMs(Date.parse(windowEnd) - 1) + (1 + padDays) * 86_400_000;
  return { fromDate: date(from), toDate: date(to) };
}

/** Normalises a "HH:MM" or "H:MM" string to "HH:MM". */
function normaliseTime(t: string): string {
  const [h, m] = t.split(":");
  if (!h || !m) throw new Error(`bad pinned_time "${t}"`);
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}
