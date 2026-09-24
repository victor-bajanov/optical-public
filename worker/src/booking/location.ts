/** How a booked meeting happens. Video-conferencing kinds name their provider
 *  because each needs its own integration to mint a per-booking link — a future
 *  `zoom` is a sibling of `meet`, not a variant of a generic kind carrying a
 *  pasted URL. */
export type LocationKind = "meet" | "phone" | "custom" | "in_person";

export interface LocationOption {
  kind: LocationKind;
  /** Owner-supplied fixed text. Only `custom` uses it. */
  detail?: string | null;
}

export const ALL_KINDS: readonly LocationKind[] = ["meet", "phone", "custom", "in_person"];

/** Between MAX_NAME_LENGTH (120) and MAX_NOTE_LENGTH (2000): long enough for a
 *  street address, short enough that one calendar location line stays readable. */
export const MAX_LOCATION_LENGTH = 200;

/** Kinds whose text the OWNER supplies at config time. */
const OWNER_DETAIL: ReadonlySet<LocationKind> = new Set(["custom"]);

/** Kinds whose text the BOOKER supplies at claim time. */
const BOOKER_DETAIL: ReadonlySet<LocationKind> = new Set(["phone", "in_person"]);

export class LocationError extends Error {}

export function needsBookerDetail(kind: LocationKind): boolean {
  return BOOKER_DETAIL.has(kind);
}

export function needsOwnerDetail(kind: LocationKind): boolean {
  return OWNER_DETAIL.has(kind);
}

/** Write-time gate for `PUT /v1/booking-page`. Rejects rather than silently
 *  repairing, so a bad config surfaces to the owner instead of on the page. */
export function validateLocationModes(modes: LocationOption[]): void {
  if (!Array.isArray(modes)) {
    throw new LocationError("location modes must be an array");
  }
  if (modes.length === 0) {
    throw new LocationError("at least one location mode is required");
  }
  if (modes.length > ALL_KINDS.length) {
    throw new LocationError(`at most ${ALL_KINDS.length} location modes are allowed`);
  }
  const seen = new Set<LocationKind>();
  for (const m of modes) {
    if (!ALL_KINDS.includes(m.kind)) {
      throw new LocationError(`unknown location kind '${m.kind}'`);
    }
    if (seen.has(m.kind)) throw new LocationError(`duplicate location kind '${m.kind}'`);
    seen.add(m.kind);

    const detail = (m.detail ?? "").trim();
    if (OWNER_DETAIL.has(m.kind)) {
      if (detail.length === 0) {
        throw new LocationError(`location kind '${m.kind}' requires a non-empty detail`);
      }
    } else if (detail.length > 0) {
      throw new LocationError(`location kind '${m.kind}' must not carry a detail`);
    }
    if (detail.length > MAX_LOCATION_LENGTH) {
      throw new LocationError(`location detail must be at most ${MAX_LOCATION_LENGTH} characters`);
    }
  }
}

/** Read-time guard. A mode is offerable only if it is actually usable, which
 *  keeps a detail-less `custom` — storable only by a legacy row — out of the
 *  picker instead of rendering an empty option. */
export function offerableModes(modes: LocationOption[]): LocationOption[] {
  return modes.filter((m) => !OWNER_DETAIL.has(m.kind) || (m.detail ?? "").trim().length > 0);
}

export interface EventLocation {
  /** Omitted entirely when the kind sets no location. */
  location?: string;
  addMeet: boolean;
}

/** Map the booker's choice onto the calendar event.
 *
 *  The offered set is the authority, not the rendered picker: a hand-rolled
 *  POST must not be able to book in-person against a Meet-only page.
 *
 *  No branch emits the owner's own contact details. A legacy `phone` entry may
 *  still carry the owner's number in `detail`; it is deliberately never read
 *  here, because the event goes out with `notifyAttendees: true`. */
export function locationForEvent(
  kind: LocationKind,
  bookerDetail: string | null,
  offered: LocationOption[],
): EventLocation {
  const option = offerableModes(offered).find((m) => m.kind === kind);
  if (!option) throw new LocationError(`location kind '${kind}' is not offered by this page`);

  if (kind === "meet") return { addMeet: true };
  if (kind === "custom") return { addMeet: false, location: (option.detail ?? "").trim() };

  const detail = (bookerDetail ?? "").trim();
  if (detail.length === 0) throw new LocationError(`location kind '${kind}' requires a detail`);
  return { addMeet: false, location: kind === "phone" ? `Phone: ${detail}` : detail };
}
