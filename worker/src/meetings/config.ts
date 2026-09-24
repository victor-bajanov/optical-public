import type { Env } from "../env";

export interface MeetingConfig {
  enabled: boolean;
  minNoticeMinutes: number;
  churnMultiplierCap: number;
  commitStabilityMinutes: number;
}

function intOr(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Single source of truth for the owned-meetings feature flags + tunables.
 *  All sitewide (per-tenant = per-deployment via wrangler vars), per the review. */
export function readMeetingConfig(env: Env): MeetingConfig {
  return {
    enabled: env.OWNED_MEETINGS_ENABLED === "true",
    minNoticeMinutes: intOr(env.MEETING_MIN_NOTICE_MINUTES, 1440),
    churnMultiplierCap: intOr(env.MEETING_CHURN_MULTIPLIER_CAP, 20),
    commitStabilityMinutes: intOr(env.MEETING_COMMIT_STABILITY_MINUTES, 60),
  };
}
