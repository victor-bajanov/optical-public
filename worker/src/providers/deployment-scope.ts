import type { Env } from "../env";
import type { CalendarEvent } from "./types";
import { OPTICAL_BOOKING_KEY, OPTICAL_DEPLOYMENT_KEY, SCHEDULER_CHUNK_ID_KEY } from "./types";

/** Private tags that make an event "owned" by the deployment that created it:
 *  a scheduler chunk (commit reconcile, stray scan, done-by-colour, recolour,
 *  offboard, busy exclusion) and a booking-page booking (decline auto-cancel).
 *  Deliberately NOT here: `optical_poll_id`, whose only reader excludes the
 *  event from owned-meeting import — that must hold for every deployment, or
 *  one could relocate another's poll meeting — and `optical_meeting_task_id`,
 *  a marker on the user's own meeting that no path trusts (import is keyed on
 *  the D1 row's external_id). */
const DEPLOYMENT_OWNED_KEYS = [SCHEDULER_CHUNK_ID_KEY, OPTICAL_BOOKING_KEY] as const;

/** This deployment's identity: the origin of OAUTH_ISSUER (scheme + host +
 *  port, so a trailing slash, a path or host case can't split one deployment
 *  in two). Undefined for an empty or unparseable issuer, which falls back to
 *  the pre-stamp behaviour (no stamp written, every tagged event is ours). */
export function deploymentIdFromEnv(env: Pick<Env, "OAUTH_ISSUER">): string | undefined {
  try {
    const origin = new URL(env.OAUTH_ISSUER).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Metadata for an event this deployment creates, with its stamp added. */
export function withDeploymentStamp(
  metadata: Record<string, string>,
  deploymentId: string | undefined,
): Record<string, string> {
  return deploymentId ? { ...metadata, [OPTICAL_DEPLOYMENT_KEY]: deploymentId } : metadata;
}

/** Applied by every provider to every event it reads. An event stamped by a
 *  DIFFERENT deployment loses its ownership tags, so it reads as ordinary busy
 *  time like any other external event and no path can move, recolour, delete
 *  or count it. An unstamped event (created before stamping existed) and this
 *  deployment's own are returned unchanged. */
export function scopeEventToDeployment(event: CalendarEvent, deploymentId: string | undefined): CalendarEvent {
  const priv = event.extendedProperties?.private;
  const stamp = priv?.[OPTICAL_DEPLOYMENT_KEY];
  if (!deploymentId || !priv || stamp === undefined || stamp === deploymentId) return event;
  const kept = { ...priv };
  for (const key of DEPLOYMENT_OWNED_KEYS) delete kept[key];
  return { ...event, extendedProperties: { ...event.extendedProperties, private: kept } };
}

/** The PATCH that stamps a legacy (unstamped) event this deployment has proved
 *  is its own, or undefined when there is nothing to stamp. It carries the
 *  event's WHOLE private map plus the stamp, so it is safe whether the
 *  provider merges or replaces the map on PATCH. Only call it for an event
 *  whose ownership is independently proved (commit: its chunk's task is in
 *  this deployment's plan) — stamping on the tag alone could claim another
 *  deployment's legacy event. */
export function legacyStampPatch(
  event: CalendarEvent,
  deploymentId: string | undefined,
): Pick<CalendarEvent, "extendedProperties"> | undefined {
  const priv = event.extendedProperties?.private ?? {};
  if (!deploymentId || priv[OPTICAL_DEPLOYMENT_KEY] !== undefined) return undefined;
  return { extendedProperties: { private: { ...priv, [OPTICAL_DEPLOYMENT_KEY]: deploymentId } } };
}
