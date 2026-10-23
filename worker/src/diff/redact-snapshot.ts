/** Prompt-injection redaction for render snapshots returned to API clients
 *  (agentic-action inventory §6, mitigation d; card O9.6).
 *
 *  A render snapshot (the ReplanEmailModel persisted on proposed_plans) shows
 *  the titles of every calendar event around a change, including invites other
 *  people organise — text an attacker can write by sending the user an invite.
 *  An LLM agent reading getLatestProposedPlan or replanNow must not see that
 *  text, so the API copy replaces it with "Busy". The user's own task titles
 *  and their own events keep their titles.
 *
 *  Applied ONLY at the API boundary. The stored snapshot and the user's own
 *  email/accept page keep the real titles — this function never mutates its
 *  input.
 *
 *  Fail closed: an entry without a known first-party origin (snapshots
 *  persisted before origins existed) and a webhook trigger without positive
 *  self-organised provenance are redacted. */
import type { EntryOrigin } from "./email-model";

export const REDACTED_TITLE = "Busy";

const KEEP: ReadonlySet<EntryOrigin | undefined> = new Set<EntryOrigin | undefined>(["task", "own_event"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function redactEntry(e: unknown): unknown {
  if (!isObj(e)) return e;
  return KEEP.has(e.origin as EntryOrigin | undefined) ? e : { ...e, title: REDACTED_TITLE };
}

function redactTrigger(t: unknown): unknown {
  if (!isObj(t) || t.kind !== "webhook") return t;
  return t.inviteOrganizedBySelf === true ? t : { ...t, inviteTitle: REDACTED_TITLE };
}

export function redactRenderSnapshot(snapshot: unknown): unknown {
  if (!isObj(snapshot)) return snapshot;
  const out: Obj = { ...snapshot };
  if ("trigger" in snapshot) out.trigger = redactTrigger(snapshot.trigger);
  if (Array.isArray(snapshot.days)) {
    out.days = snapshot.days.map((d) => {
      if (!isObj(d)) return d;
      return {
        ...d,
        ...(Array.isArray(d.before) ? { before: d.before.map(redactEntry) } : {}),
        ...(Array.isArray(d.after) ? { after: d.after.map(redactEntry) } : {}),
      };
    });
  }
  return out;
}
