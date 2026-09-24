import type { BusinessHours } from "../planning/solver-contract";
import {
  ALL_KINDS,
  needsOwnerDetail,
  offerableModes,
  type LocationKind,
  type LocationOption,
} from "../booking/location";

export type { LocationKind, LocationOption };

export interface BookingPageConfig {
  slug: string | null;
  enabled: boolean;
  durations_minutes: number[];
  hours: BusinessHours | null;
  buffer_minutes: { before: number; after: number };
  min_notice_minutes: number;
  /** Days per page — and all a booker sees until they ask for more. */
  horizon_days: number;
  /** How far a booker may page, in days from now; null is one page (the
   *  pre-paging reach). Never below `horizon_days` (validateHorizons). */
  max_horizon_days: number | null;
  bookable_over_movable_meetings: boolean;
  location: { modes: LocationOption[] };
  event_title: string;
}

/** Hardcoded floor, used only if the '__default__' row is missing. Also what
 *  a field absent from BOTH rows falls back to, so a field added after 0030
 *  seeded the '__default__' row (max_horizon_days) needs a value here, not a
 *  migration. */
const FLOOR: Omit<BookingPageConfig, "slug"> = {
  enabled: false,
  durations_minutes: [30, 60],
  hours: null,
  buffer_minutes: { before: 0, after: 10 },
  min_notice_minutes: 240,
  horizon_days: 21,
  max_horizon_days: null,
  bookable_over_movable_meetings: false,
  location: { modes: [{ kind: "meet" }] },
  event_title: "Meeting with {booker_name}",
};

export class SlugError extends Error {}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED = new Set(["cal", "book", "v1", "auth", "admin", "_static", "oauth"]);

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new SlugError("slug must be 2-31 chars, lowercase alphanumeric or hyphen, not starting with a hyphen");
  }
  if (RESERVED.has(slug)) throw new SlugError(`slug '${slug}' is reserved`);
}

async function readRow(db: D1Database, owner: string) {
  return db
    .prepare("SELECT slug, body FROM config_booking_page WHERE owner_subject = ?")
    .bind(owner)
    .first<{ slug: string | null; body: string }>();
}

/** Reconcile whatever is stored with the current shape.
 *
 *  `loadBookingPage` merges SHALLOWLY, so a row written before this feature
 *  carries `{mode, detail}` and replaces the new default wholesale — the new
 *  field would arrive `undefined`. Mapping it here means a legacy page keeps
 *  working; falling back to `meet` when nothing is offerable means it degrades
 *  to a bookable page rather than one with no options at all. */
export function normaliseLocation(raw: unknown): { modes: LocationOption[] } {
  const fallback = { modes: [{ kind: "meet" as LocationKind }] };
  if (!raw || typeof raw !== "object") return fallback;

  const v = raw as { modes?: unknown; mode?: unknown; detail?: unknown };
  // `offerableModes` does `(m.detail ?? "").trim()` for a `custom` entry, so a
  // stored detail that isn't a string (or absent/null) would throw there —
  // and loadBookingPage calls this on every read, so one malformed row would
  // 500 the whole booking page. Guard the type here, in both branches, not
  // just the kind.
  const hasUsableDetail = typeof v.detail === "string" || v.detail == null;
  const rawCandidates: LocationOption[] = Array.isArray(v.modes)
    ? (v.modes as LocationOption[]).filter(
        (m) =>
          m &&
          typeof m === "object" &&
          ALL_KINDS.includes(m.kind) &&
          (typeof m.detail === "string" || m.detail == null),
      )
    : typeof v.mode === "string" && ALL_KINDS.includes(v.mode as LocationKind) && hasUsableDetail
      ? [{ kind: v.mode as LocationKind, detail: (v.detail as string | null) ?? null }]
      : [];

  // A stored detail belongs only to the kind that owns it (currently just
  // `custom`'s owner-supplied address). Any other kind's stored detail is
  // stale — for a legacy `phone`/`in_person` row it is the OWNER's own
  // contact info, which must never reach a field the booker's copy reads —
  // so it is omitted entirely rather than nulled, keeping one canonical
  // shape for "no detail" regardless of whether the row is fresh or
  // migrated. Applied uniformly, not just on the legacy branch: a
  // hand-edited or otherwise malformed stored array could carry the same
  // stale shape.
  const candidates: LocationOption[] = rawCandidates.map((m) =>
    needsOwnerDetail(m.kind) ? m : { kind: m.kind },
  );

  const usable = offerableModes(candidates);
  return usable.length > 0 ? { modes: usable } : fallback;
}

/** Own row merged over the '__default__' row merged over the hardcoded floor,
 *  so adding a config field never requires backfilling every user's row. */
export async function loadBookingPage(db: D1Database, owner: string): Promise<BookingPageConfig> {
  const [defaults, own] = await Promise.all([readRow(db, "__default__"), readRow(db, owner)]);
  const defaultBody = defaults ? JSON.parse(defaults.body) : {};
  const ownBody = own ? JSON.parse(own.body) : {};
  const merged = {
    ...FLOOR,
    ...defaultBody,
    ...ownBody,
    slug: own?.slug ?? null,
  };
  return { ...merged, location: normaliseLocation(merged.location) };
}

/** Upsert a partial config. `slug` is stored in its own column; everything else
 *  is merged into the JSON body so callers can patch one field at a time. */
export async function saveBookingPage(
  db: D1Database,
  owner: string,
  patch: Partial<BookingPageConfig>,
): Promise<BookingPageConfig> {
  const { slug: patchSlug, ...bodyPatch } = patch;
  const own = await readRow(db, owner);
  const nextSlug = patchSlug === undefined ? (own?.slug ?? null) : patchSlug;
  if (nextSlug !== null) {
    validateSlug(nextSlug);
    const clash = await db
      .prepare("SELECT owner_subject FROM config_booking_page WHERE slug = ? AND owner_subject != ?")
      .bind(nextSlug, owner)
      .first<{ owner_subject: string }>();
    if (clash) throw new SlugError(`slug '${nextSlug}' is already taken`);
  }
  const body = JSON.stringify({ ...(own ? JSON.parse(own.body) : {}), ...bodyPatch });
  try {
    await db
      .prepare(
        `INSERT INTO config_booking_page (owner_subject, slug, body) VALUES (?, ?, ?)
         ON CONFLICT(owner_subject) DO UPDATE SET slug = excluded.slug, body = excluded.body`,
      )
      .bind(owner, nextSlug, body)
      .run();
  } catch (err) {
    // TOCTOU backstop: the pre-check above and this upsert are separate
    // statements, so two owners racing the same free slug can both pass the
    // check before either writes. The loser hits config_booking_page_slug's
    // UNIQUE index here; translate that specific violation into the same
    // SlugError the pre-check throws, rather than let a raw D1 error surface
    // as a bodyless 500.
    if (err instanceof Error && /UNIQUE constraint failed: config_booking_page\.slug/.test(err.message)) {
      throw new SlugError(`slug '${nextSlug}' is already taken`);
    }
    throw err;
  }
  return loadBookingPage(db, owner);
}

export async function findOwnerBySlug(db: D1Database, slug: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT owner_subject FROM config_booking_page WHERE slug = ? AND owner_subject != '__default__'")
    .bind(slug)
    .first<{ owner_subject: string }>();
  return row?.owner_subject ?? null;
}
