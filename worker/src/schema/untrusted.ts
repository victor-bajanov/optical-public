import { z } from "@hono/zod-openapi";

/** OpenAPI extension marking a response field whose text can be written by a
 *  third party (an invitee, a booker, the organiser of an invite on the user's
 *  calendar) rather than by the signed-in user. An MCP gateway reading the
 *  spec should fence such values as data before an LLM sees them — they may
 *  contain prompt injection (agentic-action inventory §6, mitigation b).
 *  Explained to clients in API_OVERVIEW (schema/descriptions.ts). */
export const UNTRUSTED_EXTENSION = "x-optical-untrusted" as const;

/** Tag a response schema as carrying third-party-controlled text. The one
 *  place the extension is applied, so every marked field is tagged the same
 *  way. Call it on the outermost wrapper (after .nullable()/.optional()/
 *  .describe()) so the marker lands on the property itself. */
export function untrusted<T extends z.ZodTypeAny>(schema: T): T {
  return schema.openapi({ [UNTRUSTED_EXTENSION]: true }) as T;
}
