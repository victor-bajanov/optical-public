/** House parse-with-floor posture for stringly-typed numeric Worker vars —
 *  the shape shared by resolve-internal.ts's engine budgets + wall guard,
 *  booking-decline-sweep.ts's graceMinutes, and engine/fanout.ts's
 *  fanoutMinChunks: unset, blank, or unparseable falls back to `fallback`;
 *  a value that parses but sits below `floor` clamps UP to it rather than
 *  falling back — the low override is exactly what lets dev smoke trigger
 *  these mechanisms on tiny inputs. `integer`, when true, floors the parsed
 *  value to a whole number BEFORE the floor clamp (fanoutMinChunks and
 *  graceMinutes both want whole units); when false (the default —
 *  resolve-internal.ts's fractional-seconds budgets) the parsed value is
 *  clamped as-is, since callers that need integers floor the result
 *  themselves. Platform-free (no Cloudflare/Env types) so engine/fanout.ts,
 *  which stays deliberately free of platform types, can import it. */
export function parseEnvNumberWithFloor(
  raw: string | undefined,
  fallback: number,
  floor: number,
  integer = false,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(floor, integer ? Math.floor(n) : n);
}
