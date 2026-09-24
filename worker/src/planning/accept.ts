import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { defaultCalendarProvider } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { verifyCapabilityWithEnv } from "../auth/capability";
import { commitPlan } from "./commit";
import { getCommittedPlansForSubject, getPendingPlansForSubject, getProposedPlan, type ProposedPlanRow } from "./proposed-plans";
import type { ReplanEmailModel } from "../diff/email-model";
import { renderConfirmPage, renderAcceptedPage, renderNoticePage, renderErrorPage, type WeekTab } from "../web/accept-page";
import { formatLocalDate } from "../diff/format-local";
import { localWeekWindow } from "./datetime";
import { D } from "../schema/descriptions";

/** Local-calendar-week identity: the Monday-00:00 instant (in `tz`) of the week
 *  containing `iso`. A mid-week replan narrows window_start to "now" (so the
 *  solver can't place into the past), so the same week can carry
 *  differently-anchored windows — grouping, labels, and link-window matching
 *  must all use the week, never the raw (start,end) pair. Returns null for an
 *  unparseable instant (ws/we are caller-supplied query/form values). */
function weekKeyOf(iso: string, tz: string): string | null {
  try {
    return localWeekWindow(iso, tz).start;
  } catch {
    return null;
  }
}

function planWeekKey(p: ProposedPlanRow, tz: string): string | null {
  return weekKeyOf(p.window_start ?? p.created_at, tz);
}

/** Latest pending plan per local calendar week, ordered by window start.
 *  Supersede keeps this to one per week; grouping is defensive (and covers
 *  pre-fix rows whose sibling windows were never superseded). */
function latestPerWeek(pending: ProposedPlanRow[], tz: string): ProposedPlanRow[] {
  const byWeek = new Map<string, ProposedPlanRow>();
  for (const p of pending) {
    const key = planWeekKey(p, tz);
    if (key === null || byWeek.has(key)) continue; // pending is created_at DESC
    byWeek.set(key, p);
  }
  return [...byWeek.values()].sort((a, b) => (a.window_start ?? "").localeCompare(b.window_start ?? ""));
}

/** Latest committed_at (epoch ms) per local calendar week, from the subject's
 *  recent committed plans (getCommittedPlansForSubject, capped at 16). */
function latestAcceptByWeek(committed: ProposedPlanRow[], tz: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of committed) {
    if (!p.committed_at) continue;
    const key = planWeekKey(p, tz);
    const ms = Date.parse(p.committed_at);
    if (key === null || !Number.isFinite(ms)) continue;
    if ((out.get(key) ?? -Infinity) < ms) out.set(key, ms);
  }
  return out;
}

/** Drop pending plans proposed BEFORE the same week's latest accept. Such a
 *  plan's diff was computed against pre-accept task/calendar state (a resolve
 *  racing an accept on another surface — MCP, another tab), so showing or
 *  offering it would invite re-applying an outdated proposal. A pending plan
 *  created AFTER the accept is a fresh re-resolve and stays. */
function withoutAcceptSuperseded(
  pending: ProposedPlanRow[],
  acceptsByWeek: Map<string, number>,
  tz: string,
): ProposedPlanRow[] {
  return pending.filter((p) => {
    const key = planWeekKey(p, tz);
    const acceptedAt = key === null ? undefined : acceptsByWeek.get(key);
    return acceptedAt === undefined || !(Date.parse(p.created_at) < acceptedAt);
  });
}

function weekTabsFor(windows: ProposedPlanRow[], capToken: string, tz: string, currentHash: string | undefined): WeekTab[] {
  return windows.map((p) => ({
    // Label the containing week's Monday, not the (possibly mid-week) window
    // start — "Week of Wed 29 July" read as a different week from Mon 27's.
    label: `Week of ${formatLocalDate(planWeekKey(p, tz) ?? p.created_at, tz)}`,
    href: `/v1/plans/${encodeURIComponent(p.plan_hash)}/accept?t=${encodeURIComponent(capToken)}` +
      `&ws=${encodeURIComponent(p.window_start ?? "")}&we=${encodeURIComponent(p.window_end ?? "")}`,
    current: p.plan_hash === currentHash,
  }));
}

const COPY = {
  invalidLink: "This link is invalid or has expired. Use the button in your most recent email.",
  staleEmail: "Your calendar changed after that email was sent — this is the up-to-date plan for this week.",
  supersededWhileOpen: "Your calendar changed while you had this page open, so the plan was updated. Nothing has been applied yet — please review the new plan below.",
  windowGone: "The plan from your email is no longer needed — your calendar for that week is already up to date.",
  alreadyAccepted: "You've already accepted this plan — your calendar is up to date.",
  caughtUp: "There are no proposed changes waiting.",
  expired: "This plan has expired and can no longer be accepted. You'll get a fresh email the next time your schedule changes.",
};

export function mountAcceptRoute(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  const acceptRoute = createRoute({
    method: "post", path: "/plans/{plan_hash}/accept", tags: ["internal"],
    operationId: "acceptPlan",
    summary: "Accept (commit) the proposed plan identified by {plan_hash}.",
    description: "Commit exactly the plan named in the path (owner-scoped). Auth: a capability token (form field `t`, from the emailed link) or an optical bearer. If the hash is unknown — typically because a newer resolve superseded it for the same week — the call commits NOTHING and returns 409 `plan_superseded` (with `latest_plan_hash` when that week has a current pending plan, excluding a pending plan that predates the week's latest accept); re-fetch and re-accept. Idempotent on an already-committed hash.",
    responses: {
      200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "Committed (idempotent on an already-committed plan)" },
      401: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Unauthenticated" },
      409: { content: { "application/json": { schema: z.object({ error: z.string(), latest_plan_hash: z.string().optional().describe(D.response.latest_plan_hash) }) } }, description: "Superseded — the plan no longer exists; nothing was committed" },
      410: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Expired" },
    },
  });

  v1.openapi(acceptRoute, async (c) => {
    let subject: string | undefined;
    // The token's verified window claim (capability path only) — used to resolve
    // the superseded hash's week when the form carries no ws/we.
    let capWindow: { start: string; end: string } | undefined;
    const isBearerPath = !c.req.header("content-type")?.includes("application/x-www-form-urlencoded") && !c.req.query("t");
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const cap = typeof form.t === "string" ? form.t : c.req.query("t");
    if (cap) {
      const claims = await verifyCapabilityWithEnv(cap, c.env);
      if (!claims || claims.purpose !== "accept") return c.json({ error: "invalid_token" }, 401);
      subject = claims.subject;
      capWindow = claims.window;
    } else {
      const r = await requireBearer(c as any, async () => undefined as any);
      if (r) return r as any;
      subject = c.get("subject" as never) as string | undefined;
    }
    if (!subject) return c.json({ error: "invalid_token" }, 401);

    // Content negotiation: bearer path is always JSON; capability path is HTML unless
    // the caller explicitly requests JSON via the Accept header.
    const wantsJson = Boolean(isBearerPath || c.req.header("accept")?.includes("application/json"));
    const pathHash = c.req.param("plan_hash");
    const tz = c.env.SCHEDULER_TZ;

    const cal = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, subject);
    // Commit EXACTLY the hash in the path — never pre-resolve "latest". A vanished
    // hash surfaces below as 409, so a stale link can never silently apply a
    // different plan.
    const result = await commitPlan(c.env.DB, cal, pathHash, subject, { createColorId: c.env.CREATE_COLOR_ID });

    if (result.status === 200) {
      if (wantsJson) return c.json({ ok: true }, 200);
      // Other weeks may still be waiting — offer them right on the accepted page.
      // "Other" means other CALENDAR WEEKS: a leftover sibling window of the
      // week just accepted (pre-supersede-fix rows, or a mid-week-anchored
      // duplicate) must not be offered back as if it were another week.
      const committed = await getProposedPlan(c.env.DB, pathHash);
      const acceptedWeek = committed ? planWeekKey(committed, tz) : null;
      const acceptsByWeek = latestAcceptByWeek(await getCommittedPlansForSubject(c.env.DB, subject), tz);
      const remaining = latestPerWeek(
        withoutAcceptSuperseded(
          (await getPendingPlansForSubject(c.env.DB, subject, new Date())).filter(
            (p) => p.plan_hash !== pathHash && (acceptedWeek === null || planWeekKey(p, tz) !== acceptedWeek),
          ),
          acceptsByWeek,
          tz,
        ),
        tz,
      );
      const otherWeeks = cap
        ? weekTabsFor(remaining, cap, tz, undefined).map((w) => ({ label: w.label, href: w.href }))
        : [];
      return c.html(renderAcceptedPage({ otherWeeks }), 200);
    }

    if (result.status === 404) {
      // Supersede hard-deletes, so a vanished pending hash almost certainly
      // means a newer resolve replaced it. Never commit blind — surface the
      // replacement (found via the ws/we the form carried) and re-confirm.
      // A pending plan older than its week's latest accept is not a valid
      // replacement either — never point the caller back at it.
      const acceptsByWeek = latestAcceptByWeek(await getCommittedPlansForSubject(c.env.DB, subject), tz);
      const pending = withoutAcceptSuperseded(
        await getPendingPlansForSubject(c.env.DB, subject, new Date()),
        acceptsByWeek,
        tz,
      );
      const windows = latestPerWeek(pending, tz);
      // Resolve the superseded hash's week: explicit form ws/we (HTML hidden
      // fields) first, else the token's verified window claim. Never fall back
      // to "newest overall" — that could name a DIFFERENT week's plan, which is
      // exactly the confusion the exact-hash contract exists to prevent.
      // Matching is by calendar week, not exact window: the replacement plan
      // may be anchored mid-week while the stale link carried the Monday window.
      const ws = typeof form.ws === "string" && form.ws ? form.ws : capWindow?.start;
      const wsWeek = ws ? weekKeyOf(ws, tz) : null;
      const windowPlan = wsWeek
        ? windows.find((p) => planWeekKey(p, tz) === wsWeek)
        : undefined;
      if (wantsJson) {
        return c.json({ error: "plan_superseded", ...(windowPlan ? { latest_plan_hash: windowPlan.plan_hash } : {}) }, 409);
      }
      const model = (windowPlan?.render_snapshot as ReplanEmailModel | null) ?? null;
      if (windowPlan && model && !model.isEmpty && cap) {
        return c.html(renderConfirmPage({
          model,
          action: `/v1/plans/${encodeURIComponent(windowPlan.plan_hash)}/accept`,
          capToken: cap,
          banner: COPY.supersededWhileOpen,
          weekTabs: weekTabsFor(windows, cap, tz, windowPlan.plan_hash),
          windowStart: windowPlan.window_start ?? "",
          windowEnd: windowPlan.window_end ?? "",
        }), 409);
      }
      // Superseded but nothing to re-show (no identifiable week, or its plan has
      // no reviewable diff): the JSON caller already got a 409 above; the browser
      // gets a friendly 200 "all caught up" rather than a bare error. The
      // status divergence (409 machine / 200 human) is deliberate.
      const weekTabs = cap ? weekTabsFor(windows, cap, tz, undefined) : [];
      return c.html(renderNoticePage({ heading: "You're all caught up", message: COPY.caughtUp, weekTabs }), 200);
    }

    if (result.status === 410) {
      return wantsJson
        ? c.json(result.body as Record<string, unknown>, 410)
        : c.html(renderErrorPage(COPY.expired), 410);
    }
    return wantsJson
      ? c.json(result.body as Record<string, unknown>, result.status as 410)
      : c.html(renderErrorPage("This plan can no longer be accepted."), result.status as 410);
  });

  // GET confirm page: the emailed link is a GET; render the plan for the week
  // the link was about (never a silently different week), with a selector
  // across all pending weeks.
  v1.get("/plans/:plan_hash/accept", async (c) => {
    const cap = c.req.query("t") ?? "";
    const claims = cap ? await verifyCapabilityWithEnv(cap, c.env) : null;
    if (!claims || claims.purpose !== "accept") {
      return c.html(renderErrorPage(COPY.invalidLink), 400);
    }
    const tz = c.env.SCHEDULER_TZ;
    const acceptsByWeek = latestAcceptByWeek(await getCommittedPlansForSubject(c.env.DB, claims.subject), tz);
    const pending = withoutAcceptSuperseded(
      await getPendingPlansForSubject(c.env.DB, claims.subject, new Date()),
      acceptsByWeek,
      tz,
    );
    const windows = latestPerWeek(pending, tz);

    // Preselection: ?ws/&we → token window claim → the emailed plan's window →
    // newest overall (only when the request expresses no window at all).
    // Matching is by calendar week: the link may carry a Monday-anchored window
    // while the week's current plan is anchored mid-week (or vice versa) — that
    // is still the SAME week, not a silently different one.
    const reqWs = c.req.query("ws"), reqWe = c.req.query("we");
    const requested = reqWs && reqWe ? { start: reqWs, end: reqWe } : claims.window ?? null;
    let plan: ProposedPlanRow | undefined;
    if (requested) {
      const requestedWeek = weekKeyOf(requested.start, tz);
      plan = requestedWeek ? windows.find((p) => planWeekKey(p, tz) === requestedWeek) : undefined;
    } else {
      // No window expressed: anchor on the emailed hash's week if that plan
      // still exists, else the newest pending plan's week.
      const anchor = pending.find((p) => p.plan_hash === claims.planHash) ?? pending[0];
      plan = anchor
        ? windows.find((p) => planWeekKey(p, tz) === planWeekKey(anchor, tz))
        : undefined;
    }

    const weekTabs = weekTabsFor(windows, cap, tz, plan?.plan_hash);

    if (requested && !plan) {
      // The week this link was about has nothing pending: either it was
      // accepted (committed rows survive supersede; a still-pending emailed
      // plan whose week saw a LATER accept counts as accepted too), or a later
      // replan found nothing to change. Say which — never silently show
      // another week.
      const emailedRow = await getProposedPlan(c.env.DB, claims.planHash);
      const emailedWeek = emailedRow ? planWeekKey(emailedRow, tz) : null;
      const acceptedAfterEmailed =
        emailedRow != null &&
        emailedWeek !== null &&
        (acceptsByWeek.get(emailedWeek) ?? -Infinity) > Date.parse(emailedRow.created_at);
      const accepted = Boolean(emailedRow?.committed_at) || acceptedAfterEmailed;
      return c.html(renderNoticePage({
        heading: accepted ? "Plan already accepted" : "That week is up to date",
        message: accepted ? COPY.alreadyAccepted : COPY.windowGone,
        weekTabs,
      }), 200);
    }

    const model = (plan?.render_snapshot as ReplanEmailModel | null) ?? null;
    if (!plan || !model || model.isEmpty) {
      // No pending plan at all, or a plan with no reviewable diff — degrade to
      // a friendly page rather than a bare Accept button (phantom commit).
      return c.html(renderNoticePage({ heading: "You're all caught up", message: COPY.caughtUp, weekTabs }), 200);
    }
    const banner = plan.plan_hash !== claims.planHash ? COPY.staleEmail : undefined;
    const action = `/v1/plans/${encodeURIComponent(plan.plan_hash)}/accept`;
    return c.html(renderConfirmPage({
      model, action, capToken: cap, banner, weekTabs,
      windowStart: plan.window_start ?? "", windowEnd: plan.window_end ?? "",
    }), 200);
  });
}
