// O9.1 agent-confirm registry: the ops a gated client's call can be deferred
// as, and how each one is shown and replayed once the user confirms.
//
// An op module registers itself at import time:
//
//   registerConfirmableOp("createMeetingPoll", {
//     label: "Send a meeting poll",          // static; email subject + page title
//     payloadSchema, summarySchema,          // zod; checked at defer AND confirm
//     render: (summary) => ({ heading, recipients, text, slot, moves }),
//     replay: async (env, ownerSubject, payload, deps) => { ... },
//   });
//
// and confirm/ops.ts imports that module, so the confirm route (which imports
// ops.ts) always sees every op. deferForConfirmation refuses an op that isn't
// registered, so a handler can't defer something nothing could replay.
//
// Contract for `replay`, which runs only after the CAS has consumed the row:
// - RE-VALIDATE live state first. Up to 24 h have passed since the agent
//   asked; the poll may be booked, the plan superseded, the page edited.
//   Return {ok:false, reason, message} rather than acting on stale intent.
// - Never throw for an expected refusal; a throw is shown as a generic
//   failure page and logged as confirm_action_replay_failed (op name only).
// - The row stays consumed whatever the outcome (side effects may be
//   partial), so the user re-asks the agent rather than re-clicking.
// - `message` is shown to the user (escaped); never embed a URL in it, put it
//   in `links` so it renders as a clickable link. `reason` is a short machine code
//   that goes to the log, so it must never carry PII.
// - Build providers with defaultCalendarProvider/defaultNotificationProvider
//   unless `deps` supplies one (deps carries the test seams).
import type { z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";

/** What the confirm page shows. Every string is rendered escaped, so an op
 *  never produces HTML. Pre-format times (the op knows the user's tz). */
export interface ConfirmView {
  heading: string;
  recipients?: string[];
  text?: Array<{ label: string; value: string }>;
  slot?: string;
  moves?: Array<{ title: string; from: string; to: string }>;
  notes?: string[];
  /** A whole HTML document from one of Optical's own renderers (never agent
   *  text), shown first, in a sandboxed srcdoc iframe under `caption`. */
  preview?: { caption: string; html: string };
}

/** A link on the result page, rendered as a real anchor (only http(s); the
 *  op builds the URL itself). `copy` also shows it in a selectable field. */
export interface ConfirmLink {
  label: string;
  url: string;
  copy?: boolean;
}

export type ReplayOutcome =
  | { ok: true; message: string; links?: ConfirmLink[] }
  | { ok: false; reason: string; message: string };

export interface ReplayDeps {
  actionId: string;
  calendarProvider?: CalendarProvider;
  notificationProvider?: NotificationProvider;
}

export interface ConfirmableOp<P = unknown, S = unknown> {
  /** Static, op-authored wording (never agent text): the email subject and the
   *  page title. The email carries nothing else from the action. */
  label: string;
  payloadSchema: z.ZodType<P, z.ZodTypeDef, unknown>;
  summarySchema: z.ZodType<S, z.ZodTypeDef, unknown>;
  render(summary: S): ConfirmView;
  replay(env: Env, ownerSubject: string, payload: P, deps: ReplayDeps): Promise<ReplayOutcome>;
}

const OP_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const registry = new Map<string, ConfirmableOp<any, any>>();

export function registerConfirmableOp<P, S>(op: string, def: ConfirmableOp<P, S>): void {
  if (!OP_NAME.test(op)) throw new Error(`invalid confirmable op name: ${op}`);
  if (registry.has(op)) throw new Error(`confirmable op already registered: ${op}`);
  registry.set(op, def as ConfirmableOp<any, any>);
}

export function getConfirmableOp(op: string): ConfirmableOp<any, any> | undefined {
  return registry.get(op);
}
