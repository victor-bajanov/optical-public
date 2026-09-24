import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import {
  createFeed, listFeeds, updateFeed, regenerateFeed, revokeFeed, FeedError,
} from "../db/calendar-feed-tokens";
import { createReveal, pendingReveals } from "../db/calendar-feed-reveals";
import { validateRevealRegexes, RevealRegexError, MAX_PATTERNS } from "../calendar-feed/reveal-rules";

const REVEAL_INSTRUCTIONS =
  "Give this reveal_url to the user to open in their BROWSER. It shows the feed URL exactly once, then self-destructs (1-hour expiry). Do not fetch it yourself — opening it consumes the one-time secret. If the secret is lost, regenerate; it cannot be recovered.";

const RegexesField = z.array(z.string()).max(MAX_PATTERNS).describe(
  `Full-match, case-sensitive regexes (compiled as ^(?:pattern)$) against event titles. A matching title is shown verbatim in THIS endpoint's feed instead of 'Busy' — unless the title contains an email/URL/meeting-link/phone, in which case it stays 'Busy'. Empty list = everything is 'Busy'. Max ${MAX_PATTERNS} patterns.`,
);
const FeedCore = z.object({
  id: z.string().describe("Endpoint id (stable across secret rotations)."),
  label: z.string().describe("Owner-unique name among active endpoints, e.g. the counterparty this URL is shared with."),
  reveal_regexes: RegexesField,
  created_at: z.string().describe("Endpoint creation time (ISO 8601)."),
  last_used_at: z.string().nullable().describe("Last feed poll with the current secret (ISO 8601), or null."),
});
const RevealField = z.string().describe(
  "Pre-signed single-use URL where the USER (in a browser) can view the feed URL once. Never contains the secret itself.",
);
const CreateBody = z.object({
  label: z.string().min(1).max(64).describe("Owner-unique endpoint name."),
  reveal_regexes: RegexesField.optional().describe("Optional initial reveal patterns; defaults to none (pure busy feed)."),
});
const PatchBody = z.object({
  label: z.string().min(1).max(64).optional().describe("New owner-unique endpoint name; omit to leave unchanged."),
  reveal_regexes: RegexesField.optional(),
}).describe("Edits config only; the secret is untouched. Rotate via /regenerate.");
const CreatedResponse = FeedCore.extend({ reveal_url: RevealField, instructions: z.string().describe("How to use reveal_url — hand it to the user's browser, never fetch it yourself.") });
const ListResponse = z.object({
  feeds: z.array(FeedCore.extend({
    pending_reveal: z.object({
      expires_at: z.string().describe("When the pending reveal expires (ISO 8601)."),
    }).nullable().describe(
      "Set when an unopened reveal URL exists for this endpoint (with its expiry). Null once opened or expired.",
    ),
  })).describe("Active endpoints, ordered by creation time."),
});
const RegenerateResponse = z.object({ reveal_url: RevealField, instructions: z.string().describe("How to use reveal_url — hand it to the user's browser, never fetch it yourself.") });
const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  detail: z.string().optional().describe("Human-readable detail, e.g. why a regex failed to validate. Not machine-readable; absent on most error codes."),
});

function disabled(c: { env: Env }): boolean {
  return c.env.CALENDAR_FEED_ENABLED !== "true";
}

type Ctx = { env: Env; req: { url: string } };
async function stageReveal(c: Ctx, feedId: string, owner: string, secret: string): Promise<string> {
  const origin = new URL(c.req.url).origin;
  const feedUrl = `${origin}/cal/${secret}/busy.ics`;
  const token = await createReveal(c.env.DB, c.env, feedId, owner, feedUrl, new Date());
  return `${origin}/cal-reveal/${token}`;
}

export function mountCalendarFeedsRoutes(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  // Auth and the feature flag must be checked before @hono/zod-openapi's
  // built-in body/param validator runs (it executes ahead of the route
  // handler below), otherwise a disabled-flag or unauthenticated request with
  // an invalid body gets a 400 instead of the 401/403 it should — the caller
  // can't distinguish "malformed" from "not allowed to be here at all".
  v1.use("/calendar-feeds/*", async (c, next) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    if (disabled(c)) return c.json({ error: "feature_disabled" }, 403);
    await next();
  });

  const errs = {
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing/invalid bearer" },
    403: { content: { "application/json": { schema: ErrorResponse } }, description: "Feature disabled or token carries no subject" },
  } as const;

  const post = createRoute({
    method: "post", path: "/calendar-feeds", operationId: "createCalendarFeed",
    summary: "Create a busy-feed endpoint.",
    description: "Create a new feed endpoint with its own secret URL and (optionally) title-reveal regexes. The secret is NOT returned: hand the returned reveal_url to the user to open in a browser — it displays the feed URL exactly once within 1 hour, then only regeneration can produce a new one.",
    security: [{ BearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: CreateBody } } } },
    responses: {
      200: { content: { "application/json": { schema: CreatedResponse } }, description: "Endpoint created; reveal URL staged" },
      400: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid label or regexes" },
      409: { content: { "application/json": { schema: ErrorResponse } }, description: "label_taken or feed_limit" },
      ...errs,
    },
  });
  v1.openapi(post, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner middleware above
    const body = c.req.valid("json");
    let regexes: string[];
    try {
      regexes = validateRevealRegexes(body.reveal_regexes ?? []);
    } catch (err) {
      if (err instanceof RevealRegexError) return c.json({ error: "invalid_regexes", detail: err.message }, 400);
      throw err;
    }
    try {
      const { id, secret } = await createFeed(c.env.DB, c.env, owner, body.label, regexes);
      const reveal_url = await stageReveal(c, id, owner, secret);
      const feed = (await listFeeds(c.env.DB, owner)).find((f) => f.id === id)!;
      return c.json({
        id, label: feed.label, reveal_regexes: feed.revealRegexes,
        created_at: feed.created_at, last_used_at: feed.last_used_at,
        reveal_url, instructions: REVEAL_INSTRUCTIONS,
      }, 200);
    } catch (err) {
      if (err instanceof FeedError) return c.json({ error: err.code }, 409);
      throw err;
    }
  });

  const list = createRoute({
    method: "get", path: "/calendar-feeds", operationId: "listCalendarFeeds",
    summary: "List busy-feed endpoints.",
    description: "All active endpoints with their reveal regexes, usage timestamps and pending-reveal status. Never returns secrets or feed URLs.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: { content: { "application/json": { schema: ListResponse } }, description: "Active endpoints" },
      ...errs,
    },
  });
  v1.openapi(list, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner middleware above
    const [feeds, pending] = await Promise.all([
      listFeeds(c.env.DB, owner),
      pendingReveals(c.env.DB, owner, new Date()),
    ]);
    return c.json({
      feeds: feeds.map((f) => ({
        id: f.id, label: f.label, reveal_regexes: f.revealRegexes,
        created_at: f.created_at, last_used_at: f.last_used_at,
        pending_reveal: pending.get(f.id) ?? null,
      })),
    }, 200);
  });

  const IdParam = z.object({ id: z.string().describe("Endpoint id from the list/create response.") });

  const patch = createRoute({
    method: "patch", path: "/calendar-feeds/{id}", operationId: "updateCalendarFeed",
    summary: "Edit an endpoint's label or reveal regexes.",
    description: "Config-only edit; the secret and subscription URL are untouched. Regex changes take effect on the next feed poll.",
    security: [{ BearerAuth: [] }],
    request: { params: IdParam, body: { content: { "application/json": { schema: PatchBody } } } },
    responses: {
      200: { content: { "application/json": { schema: FeedCore } }, description: "Updated endpoint" },
      400: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid label or regexes" },
      404: { content: { "application/json": { schema: ErrorResponse } }, description: "Unknown endpoint" },
      409: { content: { "application/json": { schema: ErrorResponse } }, description: "label_taken" },
      ...errs,
    },
  });
  v1.openapi(patch, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner middleware above
    const body = c.req.valid("json");
    let regexes: string[] | undefined;
    try {
      regexes = body.reveal_regexes === undefined ? undefined : validateRevealRegexes(body.reveal_regexes);
    } catch (err) {
      if (err instanceof RevealRegexError) return c.json({ error: "invalid_regexes", detail: err.message }, 400);
      throw err;
    }
    try {
      const updated = await updateFeed(c.env.DB, owner, c.req.valid("param").id, { label: body.label, revealRegexes: regexes });
      if (!updated) return c.json({ error: "not_found" }, 404);
      return c.json({
        id: updated.id, label: updated.label, reveal_regexes: updated.revealRegexes,
        created_at: updated.created_at, last_used_at: updated.last_used_at,
      }, 200);
    } catch (err) {
      if (err instanceof FeedError) return c.json({ error: err.code }, 409);
      throw err;
    }
  });

  const regen = createRoute({
    method: "post", path: "/calendar-feeds/{id}/regenerate", operationId: "regenerateCalendarFeedSecret",
    summary: "Rotate an endpoint's secret.",
    description: "Issue a new secret for this endpoint — the OLD feed URL stops working immediately and any subscription must be re-pointed. Returns a fresh single-use reveal_url for the user's browser; the secret itself is never in the response. An unopened prior reveal is invalidated.",
    security: [{ BearerAuth: [] }],
    request: { params: IdParam },
    responses: {
      200: { content: { "application/json": { schema: RegenerateResponse } }, description: "Secret rotated; reveal URL staged" },
      404: { content: { "application/json": { schema: ErrorResponse } }, description: "Unknown endpoint" },
      ...errs,
    },
  });
  v1.openapi(regen, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner middleware above
    const id = c.req.valid("param").id;
    const r = await regenerateFeed(c.env.DB, c.env, owner, id);
    if (!r) return c.json({ error: "not_found" }, 404);
    const reveal_url = await stageReveal(c, id, owner, r.secret);
    return c.json({ reveal_url, instructions: REVEAL_INSTRUCTIONS }, 200);
  });

  const del = createRoute({
    method: "delete", path: "/calendar-feeds/{id}", operationId: "deleteCalendarFeed",
    summary: "Revoke an endpoint.",
    description: "Soft-revoke: the feed URL stops working immediately. The label becomes reusable.",
    security: [{ BearerAuth: [] }],
    request: { params: IdParam },
    responses: {
      200: { content: { "application/json": { schema: z.object({ revoked: z.boolean().describe("Whether an active endpoint was found and revoked.") }) } }, description: "Revocation result" },
      404: { content: { "application/json": { schema: ErrorResponse } }, description: "Unknown endpoint" },
      ...errs,
    },
  });
  v1.openapi(del, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner middleware above
    const ok = await revokeFeed(c.env.DB, owner, c.req.valid("param").id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ revoked: true }, 200);
  });
}
