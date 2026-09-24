import type { Env } from "./env";

/**
 * Verbose diagnostic logging gated by the `DEBUG_LOG` worker var.
 *
 * Off unless `DEBUG_LOG === "true"` — flip it in wrangler `[vars]` to capture a
 * flow in Workers Observability, then turn it back off. The payload is
 * JSON-stringified INTO the message string on purpose: observability reliably
 * captures `console.*` message text, but the structured second argument was
 * observed NOT to survive logfwd (the `resolve_window_shed` `{excluded_past,
 * kept}` object never appeared in queries) — embedding it in the message is what
 * makes it queryable. Prefix `dbg_` keeps these greppable and distinct from the
 * permanent `resolve_*` event lines.
 */
export function debugLog(
  env: Pick<Env, "DEBUG_LOG">,
  event: string,
  data: Record<string, unknown>,
): void {
  if (env.DEBUG_LOG !== "true") return;
  console.info(`${event} ${JSON.stringify(data)}`);
}
