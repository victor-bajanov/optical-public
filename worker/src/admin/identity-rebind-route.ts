import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireBearer } from "../middleware/auth-bearer";
import { requireAdminSubject } from "../middleware/admin-subject";
import { requireScope } from "../middleware/require-scope";
import { resolveOffboardSubject } from "./offboard-route";
import { clearIdentityAnchor, readRebindTarget } from "../auth/identity-rebind";
import { dropCachedAccessToken, hasRefreshCredential, readRefreshToken } from "../auth/identity-store";
import { revokeUpstreamGrant, upstreamRevokeEnabled } from "../auth/upstream-revoke";
import { defaultIdentityProvider } from "../index-providers";
import { writeAudit } from "../db/audit";

export const IdentityRebindRequest = z.object({
  subject: z.string().trim().min(1)
    .describe("The account to rebind: its subject (the address the account was created under, identity_tokens.account_email / users.subject). Trimmed, then resolved to the stored subject case-insensitively, an exact match winning, exactly as /admin/offboard resolves it."),
  force: z.boolean().optional()
    .describe("Set true to rebind a renamed owner, i.e. when the row's login_email (the address the owner last signed in with) differs case-insensitively from the subject. Without it that case is refused with 409 subject_drifted: the real owner now signs in as login_email, so whoever is refused at the subject address is probably a new holder of a reassigned address, and a rebind would hand them the account. Force only once you have confirmed the person signing in at the subject address is the account owner. Has no effect on a row that has not drifted."),
}).describe("Clear one account's identity anchor so its next sign-in may bind a different IdP identity.");

export const IdentityRebindResponse = z.object({
  ok: z.literal(true).describe("Always true on success."),
  subject: z.string().describe("The stored subject whose anchor was cleared."),
  previous_provider: z.enum(["google", "microsoft"])
    .describe("The provider the account was bound to. The row keeps it, but the stored refresh credential is wiped, so the account is idle (no cron, webhook replan, poll or booking calendar access) until the next sign-in stores a new one; with UPSTREAM_REVOKE_ENABLED the grant was also revoked at the IdP (best-effort)."),
  previous_provider_subject: z.string().nullable()
    .describe("The provider_subject that was cleared; null when the row was already unanchored (a repeat call, or a legacy pre-0037 row)."),
  login_email: z.string().nullable()
    .describe("The row's login_email (the owner's latest verified sign-in address, where owner mail goes); null when never recorded."),
  forced: z.boolean()
    .describe("True when login_email had drifted from the subject and force:true overrode the 409 subject_drifted refusal (audited as identity_rebind_forced)."),
}).describe("The anchor that was cleared.");

/**
 * Admin-only deliberate identity rebind (plan 2026-10-23-identity-port-105,
 * decision 9). `POST /admin/identity-rebind {subject, force?}`.
 *
 * With REFUSE_PROVIDER_REBIND on, /auth/callback refuses a sign-in whose
 * (provider, provider_subject) differs from the account's stored anchor: a
 * provider switch, an Entra object recreated under the same UPN, or a
 * reassigned address. This clears the anchor so the NEXT sign-in to that
 * address binds whichever identity carries it. In the same batch it wipes the
 * stored refresh credential (the account is idle until that next sign-in),
 * resets the account's calendar sync token and push channel and ends the
 * previous holder's Optical sessions: oauth_tokens revoked, oauth_codes and
 * pending_actions deleted, as offboard does (identity-rebind.ts), so
 * connected clients must re-authorise. It also deletes the account's pending
 * (uncommitted) plans and revokes its calendar feed tokens, and every emailed
 * accept link and organiser poll-status link dies with the anchor it was
 * minted under (identityAnchorTag). With UPSTREAM_REVOKE_ENABLED the grant is
 * also revoked at the IdP, after the clear. Whoever signs in next as that
 * address gets the whole account, so confirm who that is first.
 *
 * Not flag-gated, but only useful where REFUSE_PROVIDER_REBIND is on, and NOT
 * harmless where it is off: there nothing is refused, so a cleared anchor
 * only loosens things further. The renamed owner's next sign-in no longer
 * finds the account by provider_subject and lands on a new, empty account
 * under their new address (orphaning the old one), and any holder of the
 * subject address binds it. Don't run it in an env with the flag off.
 *
 * Responses: 400 validation_failed {issues}; 404 unknown_subject (no matching
 * account, or no identity_tokens row); 409 ambiguous_subject (case variants);
 * 409 subject_drifted {subject, login_email} for a renamed owner without
 * force:true; 409 concurrent_update when a sign-in or offboard changed the row
 * between the read and the clear (nothing written; re-run to re-evaluate);
 * 200 IdentityRebindResponse.
 *
 * Audited (`identity_rebind`, or `identity_rebind_forced` for a forced drift
 * clear; table identity_tokens, source admin, actor = the bearer's subject).
 * Logs carry no subject, email or provider_subject. Lives on the top-level
 * app like every /admin route, so it is not in the published v1 OpenAPI
 * document.
 */
export function mountIdentityRebindRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  app.post("/admin/identity-rebind", requireBearer, requireAdminSubject, requireScope("admin"), async (c) => {
    const raw = await c.req.json<unknown>().catch(() => undefined);
    const parsed = IdentityRebindRequest.safeParse(raw);
    if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);

    const resolved = await resolveOffboardSubject(c.env.DB, parsed.data.subject);
    if (resolved.kind === "unknown") return c.json({ error: "unknown_subject" }, 404);
    if (resolved.kind === "ambiguous") return c.json({ error: "ambiguous_subject" }, 409);
    const subject = resolved.subject;

    const target = await readRebindTarget(c.env.DB, subject);
    if (!target) return c.json({ error: "unknown_subject" }, 404);

    const drifted = !!target.loginEmail && target.loginEmail.toLowerCase() !== subject.toLowerCase();
    if (drifted && parsed.data.force !== true) {
      console.warn("identity_rebind_drift_refused", { provider: target.provider });
      return c.json({ error: "subject_drifted", subject, login_email: target.loginEmail }, 409);
    }
    const forced = drifted;

    // UPSTREAM_REVOKE_ENABLED: read the credential now, because the clear
    // below wipes it. Decrypt failures are kept for revokeUpstreamGrant to log
    // after the clear, never raised here.
    let revokeToken: (() => Promise<string | null>) | null = null;
    if (upstreamRevokeEnabled(c.env)) {
      const read = await readRefreshToken(c.env, subject).then(
        (token) => ({ token }), (error: unknown) => ({ error }),
      );
      revokeToken = async () => {
        if ("error" in read) throw read.error;
        return read.token;
      };
    }

    if (!(await clearIdentityAnchor(c.env.DB, subject, target))) {
      return c.json({ error: "concurrent_update" }, 409);
    }
    const actor = (c.get("subject" as never) as string | undefined) ?? "unknown";
    await writeAudit(c.env.DB, {
      subject, actor,
      action: forced ? "identity_rebind_forced" : "identity_rebind",
      table_name: "identity_tokens", source: "admin",
    });
    // Revoke the previous holder's grant at the IdP, as offboard and a
    // refused sign-in do (parity), only once the clear and its audit row have
    // landed: a 409 above revokes nothing. UPSTREAM_REVOKE_ENABLED is set only
    // where the deployment has its own OAuth client (trial), and
    // (provider, provider_subject) is unique, so the grant revoked is this
    // account's alone. Microsoft's revokeGrant is a documented no-op.
    // Best-effort: revokeUpstreamGrant never throws, and logs
    // identity_rebind_revoke_failed / _skipped with no token, subject or
    // email, so the rebind still answers 200.
    if (revokeToken) {
      const outcome = await revokeUpstreamGrant(c.env, {
        token: revokeToken,
        idp: () => defaultIdentityProvider(c.env, target.provider),
        logPrefix: "identity_rebind_revoke",
        context: { provider: target.provider },
        redact: [subject, target.loginEmail ?? ""],
      });
      // Google's revoke ends the whole user-to-client grant, so a sign-in
      // that stored a credential between the wipe and a revoke that went
      // through had its fresh grant killed too, and its next refresh will
      // fail. Nothing to undo here; say so (no email) so the operator can ask
      // the user to sign in again. Microsoft's revoke is a no-op.
      // Best-effort, like the cache drop below: a D1 failure here must not
      // turn a committed rebind into a 500 or skip that drop. The error is
      // not logged (it may echo the subject).
      if (outcome === "revoked" && target.provider === "google") {
        try {
          if (await hasRefreshCredential(c.env, subject)) {
            console.warn("identity_rebind_revoke_raced", { provider: target.provider });
          }
        } catch {
          console.warn("identity_rebind_revoke_race_check_failed", { provider: target.provider });
        }
      }
    }
    // Drop the previous holder's cached IdP access token, only once the anchor
    // is cleared (a refused rebind leaves the account as it was). The
    // credential is wiped above, so this is what stops calendar calls on the
    // cached token, which would otherwise live up to an hour. Best-effort,
    // after the audit: a KV failure must not turn a committed rebind into a
    // 500. The error is not logged, because the legacy key name carries the
    // subject's email.
    try {
      await dropCachedAccessToken(c.env, subject);
    } catch {
      console.warn("identity_rebind_cache_drop_failed", { provider: target.provider });
    }
    console.warn("identity_rebind_cleared", {
      provider: target.provider, had_anchor: target.providerSubject !== null, forced,
    });
    const body: z.infer<typeof IdentityRebindResponse> = {
      ok: true,
      subject,
      previous_provider: target.provider,
      previous_provider_subject: target.providerSubject,
      login_email: target.loginEmail,
      forced,
    };
    return c.json(IdentityRebindResponse.parse(body), 200);
  });
}
