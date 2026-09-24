import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  defaultRunner,
  __setWebhookReplanForTests,
} from "../../src/durable-objects/resolve-coordinator";
import { ACCESS_PREFIX } from "../../src/auth/identity-store";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";

// The webhook owner whose calendar edit triggered this replan.
const OWNER_B = "b@org";
// A DIFFERENT user who is the globally most-recently-active subject, so
// resolveActiveSubject(env) resolves to X. If defaultRunner builds the calendar
// and notification providers WITHOUT the owner's subject, they fall back to
// subjectFor(env) -> resolveActiveSubject(env) -> X and operate on X's Google
// calendar / Gmail credentials — the cross-tenant credential-confusion bug.
const ACTIVE_X = "x@org";

// Read a provider's bound subject without any network: the notification
// provider exposes the owner via its `getFrom` resolver, and the calendar
// provider's `getAccessToken` short-circuits on the per-subject KV cache we seed
// below, so the returned token reveals which subject it was built for.
type FromIntrospect = { getFrom: () => Promise<string> };
type TokenIntrospect = { getAccessToken: () => Promise<string> };

describe("defaultRunner binds providers to the webhook owner, not the active subject", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
    // X has the later last_seen, so resolveActiveSubject() => X.
    await env.DB
      .prepare(
        "INSERT INTO users (subject, role, is_active, last_seen, created_at) VALUES (?, 'member', 1, ?, ?)",
      )
      .bind(ACTIVE_X, "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();
    await env.DB
      .prepare(
        "INSERT INTO users (subject, role, is_active, last_seen, created_at) VALUES (?, 'member', 1, ?, ?)",
      )
      .bind(OWNER_B, "2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z")
      .run();
    // Distinct cached access tokens per subject so the bound subject is
    // observable via getAccessToken() with no upstream call.
    await env.GOOGLE_TOKEN_CACHE.put(ACCESS_PREFIX + ACTIVE_X, "tok-X");
    await env.GOOGLE_TOKEN_CACHE.put(ACCESS_PREFIX + OWNER_B, "tok-B");
  });

  afterEach(() => {
    __setWebhookReplanForTests(null);
  });

  it("uses owner B's credentials for both the calendar and notification providers", async () => {
    let captured:
      | { calendar: CalendarProvider; notify: NotificationProvider; accountEmail: string }
      | null = null;
    __setWebhookReplanForTests(async (args) => {
      captured = { calendar: args.calendar, notify: args.notify, accountEmail: args.accountEmail };
      return { kind: "no_diff" };
    });

    await defaultRunner(env, OWNER_B);

    expect(captured).not.toBeNull();
    expect(captured!.accountEmail).toBe(OWNER_B);

    const from = await (captured!.notify as unknown as FromIntrospect).getFrom();
    expect(from).toBe(OWNER_B);

    const token = await (captured!.calendar as unknown as TokenIntrospect).getAccessToken();
    expect(token).toBe("tok-B");
  });
});
