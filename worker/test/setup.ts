import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";
// Vite ?raw imports resolve to string contents at build time.
import initialSql from "../migrations/0001_initial.sql?raw";
import seedSql from "../migrations/0002_seed_config.sql?raw";
import plansAndSyncSql from "../migrations/0003_plans_and_sync.sql?raw";
import webhookChannelsSql from "../migrations/0004_webhook_channels.sql?raw";
import fixConfigContextsSql from "../migrations/0005_fix_config_contexts.sql?raw";
import businessHoursSql from "../migrations/0006_business_hours.sql?raw";
import updateFitCurvesSql from "../migrations/0007_update_fit_curves.sql?raw";
import oauthSubjectSql from "../migrations/0008_oauth_subject.sql?raw";
import renameIdentityTokensSql from "../migrations/0009_rename_identity_tokens.sql?raw";
import taskScheduledForSql from "../migrations/0010_task_scheduled_for.sql?raw";
import preferredWindowWeightsSql from "../migrations/0011_preferred_window_weights.sql?raw";
import proposedPlanRenderSnapshotSql from "../migrations/0012_proposed_plan_render_snapshot.sql?raw";
import ownerSubjectSql from "../migrations/0013_owner_subject.sql?raw";
import calendarSyncPerUserSql from "../migrations/0014_calendar_sync_per_user.sql?raw";
import usersSql from "../migrations/0015_users.sql?raw";
import auditLogSql from "../migrations/0016_audit_log.sql?raw";
import perUserConfigSql from "../migrations/0017_per_user_config.sql?raw";
import userHomeTzSql from "../migrations/0018_user_home_tz.sql?raw";
import userDoneColorIdSql from "../migrations/0019_user_done_color_id.sql?raw";
import calendarFeedTokensSql from "../migrations/0020_calendar_feed_tokens.sql?raw";
import occurrenceKeySql from "../migrations/0021_recurrence_occurrence_key.sql?raw";
import chunkCompletionsSql from "../migrations/0023_chunk_completions.sql?raw";
import oauthClientsAllowedScopesSql from "../migrations/0024_oauth_clients_allowed_scopes.sql?raw";
import meetingPolicySql from "../migrations/0025_meeting_policy.sql?raw";
import taskLastCommittedMoveAtSql from "../migrations/0026_task_last_committed_move_at.sql?raw";
import planWindowColumnsSql from "../migrations/0027_plan_window_columns.sql?raw";
import chunkCompletionEventIdSql from "../migrations/0028_chunk_completion_event_id.sql?raw";
import calendarFeedMultiSql from "../migrations/0029_calendar_feed_multi.sql?raw";
import bookingPageSql from "../migrations/0030_booking_page.sql?raw";
import bookingLocationSql from "../migrations/0031_booking_location.sql?raw";
import meetingPollSql from "../migrations/0032_meeting_poll.sql?raw";
import pollGuestRateLimitSql from "../migrations/0033_poll_guest_rate_limit.sql?raw";
import pollJoinAttemptsSql from "../migrations/0034_poll_join_attempts.sql?raw";
import bookingCancelPendingSql from "../migrations/0035_booking_cancel_pending.sql?raw";
import identityProviderSql from "../migrations/0036_identity_provider.sql?raw";
import identityProviderSubjectSql from "../migrations/0037_identity_provider_subject.sql?raw";
import solverCallsSql from "../migrations/0038_solver_calls.sql?raw";
import solverCallsEngineSql from "../migrations/0039_solver_calls_engine.sql?raw";
import { OCCURRENCE_UNIQUE_INDEX_DDL } from "../src/recurrence/occurrence-index";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0001_initial.sql", queries: [initialSql] },
    { name: "0002_seed_config.sql", queries: [seedSql] },
    { name: "0003_plans_and_sync.sql", queries: [plansAndSyncSql] },
    { name: "0004_webhook_channels.sql", queries: [webhookChannelsSql] },
    { name: "0005_fix_config_contexts.sql", queries: [fixConfigContextsSql] },
    { name: "0006_business_hours.sql", queries: [businessHoursSql] },
    { name: "0007_update_fit_curves.sql", queries: [updateFitCurvesSql] },
    { name: "0008_oauth_subject.sql", queries: [oauthSubjectSql] },
    { name: "0009_rename_identity_tokens.sql", queries: [renameIdentityTokensSql] },
    { name: "0010_task_scheduled_for.sql", queries: [taskScheduledForSql] },
    { name: "0011_preferred_window_weights.sql", queries: [preferredWindowWeightsSql] },
    { name: "0012_proposed_plan_render_snapshot.sql", queries: [proposedPlanRenderSnapshotSql] },
    { name: "0013_owner_subject.sql", queries: [ownerSubjectSql] },
    { name: "0014_calendar_sync_per_user.sql", queries: [calendarSyncPerUserSql] },
    { name: "0015_users.sql", queries: [usersSql] },
    { name: "0016_audit_log.sql", queries: [auditLogSql] },
    { name: "0017_per_user_config.sql", queries: [perUserConfigSql] },
    { name: "0018_user_home_tz.sql", queries: [userHomeTzSql] },
    { name: "0019_user_done_color_id.sql", queries: [userDoneColorIdSql] },
    { name: "0020_calendar_feed_tokens.sql", queries: [calendarFeedTokensSql] },
    { name: "0021_recurrence_occurrence_key.sql", queries: [occurrenceKeySql] },
    { name: "0022_tasks_occurrence_unique_index.sql", queries: [OCCURRENCE_UNIQUE_INDEX_DDL] },
    { name: "0023_chunk_completions.sql", queries: [chunkCompletionsSql] },
    { name: "0024_oauth_clients_allowed_scopes.sql", queries: [oauthClientsAllowedScopesSql] },
    { name: "0025_meeting_policy.sql", queries: [meetingPolicySql] },
    { name: "0026_task_last_committed_move_at.sql", queries: [taskLastCommittedMoveAtSql] },
    { name: "0027_plan_window_columns.sql", queries: [planWindowColumnsSql] },
    { name: "0028_chunk_completion_event_id.sql", queries: [chunkCompletionEventIdSql] },
    { name: "0029_calendar_feed_multi.sql", queries: [calendarFeedMultiSql] },
    { name: "0030_booking_page.sql", queries: [bookingPageSql] },
    { name: "0031_booking_location.sql", queries: [bookingLocationSql] },
    { name: "0032_meeting_poll.sql", queries: [meetingPollSql] },
    { name: "0033_poll_guest_rate_limit.sql", queries: [pollGuestRateLimitSql] },
    { name: "0034_poll_join_attempts.sql", queries: [pollJoinAttemptsSql] },
    { name: "0035_booking_cancel_pending.sql", queries: [bookingCancelPendingSql] },
    { name: "0036_identity_provider.sql", queries: [identityProviderSql] },
    { name: "0037_identity_provider_subject.sql", queries: [identityProviderSubjectSql] },
    { name: "0038_solver_calls.sql", queries: [solverCallsSql] },
    { name: "0039_solver_calls_engine.sql", queries: [solverCallsEngineSql] },
  ]);
});
