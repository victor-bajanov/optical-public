export interface Env {
  // Bindings
  DB: D1Database;
  GOOGLE_TOKEN_CACHE: KVNamespace;
  SOLVER: Fetcher;
  RESOLVE_COORDINATOR: DurableObjectNamespace<import("./durable-objects/resolve-coordinator").ResolveCoordinator>;
  // Card 3.0: R2 bucket for captured live solver problems (Stage 3 parity
  // corpus). Deliberately OPTIONAL and absent on any deployment whose users
  // have not opted into collection, so the write path must tolerate this
  // being unbound (never enable capture there).
  SOLVER_CAPTURE?: R2Bucket;
  // Card E: service binding back to THIS worker's `EngineRpc` entrypoint, used
  // by the engine's improvement phase to fan neighbourhood sub-solves out into
  // their own isolates. Typed as the engine's structural binding interface
  // rather than a Cloudflare Service<> so engine/fanout.ts stays free of
  // platform types — the RPC stub satisfies it at runtime. OPTIONAL: a
  // deployment without the [[services]] block must degrade to the in-process
  // sequential path, never fail a resolve (see fanoutEligible()).
  ENGINE_RPC?: import("./engine/fanout").EngineRpcBinding;

  // Vars
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_POLICY_AUD: string;
  OAUTH_ISSUER: string;
  GOOGLE_OAUTH_REDIRECT_URI: string;
  SCHEDULER_TZ: string;
  MS_PROVIDER_ENABLED?: string;          // "true" enables Microsoft sign-in (dev first)
  MICROSOFT_OAUTH_CLIENT_ID?: string;
  MICROSOFT_OAUTH_CLIENT_SECRET?: string; // secret (op-injected); Entra secrets expire <=24 months
  MICROSOFT_TENANT?: string;             // default "common"
  OPERATOR_EMAIL: string;
  // Per-attempt budget (ms) for a single solver /solve call. Optional; defaults
  // to SOLVER_TIMEOUT_MS in resolve-internal. Stringly-typed like all Worker vars.
  SOLVER_TIMEOUT_MS?: string;
  // Which solver produces a resolve's answer (bespoke engine, card G):
  //   "container" — today's HTTP hop to the solver container (the DEFAULT, so
  //                 the engine deploys dark);
  //   "worker"    — the in-process bespoke engine, no HTTP hop at all;
  //   "shadow"    — container serves, engine runs alongside for a `solver_shadow`
  //                 comparison line (never affects the response);
  //   "fallback"  — engine first, served only when it certifies (OPTIMAL);
  //                 anything else re-solves via the container.
  // Unset or unrecognised ⇒ "container" (fail-safe), with one `solver_engine_unknown`
  // warn line per distinct bad value. See engineMode() in resolve-internal.ts.
  SOLVER_ENGINE?: string;
  // Fallback mode only: how long (ms) an in-process engine solve may take before
  // its answer is distrusted and the container re-solves (`solver_fallback`
  // reason `engine_timeout`). The engine is synchronous, so this is a SERVING
  // guard, not a timeout — it cannot preempt a running solve. Unset/unparseable
  // ⇒ ENGINE_WALL_GUARD_MS (twice the engine's own wall budgets); a parseable
  // value < 1 clamps UP to 1 ms rather than disabling the guard.
  SOLVER_ENGINE_WALL_GUARD_MS?: string;
  // In-process engine wall budgets in SECONDS (fractions allowed), mirroring
  // the container's SOLVER_PASS*_TIME_LIMIT_S posture so a soak can run both
  // solvers at like-for-like budgets via a var flip. Unset/unparseable ⇒ the
  // engine's DEFAULT_BUDGETS (20 s per layer); values ≤ 0 clamp UP to 1 ms.
  // See engineBudgets() in resolve-internal.ts, parsed via
  // util/env-parse.ts's parseEnvNumberWithFloor.
  SOLVER_ENGINE_PASS1_TIME_LIMIT_S?: string;
  SOLVER_ENGINE_PASS2_TIME_LIMIT_S?: string;
  SOLVER_ENGINE_MUS_TIME_LIMIT_S?: string;
  // Card E: fan-out escape hatch master switch. When exactly "true" AND
  // ENGINE_RPC is bound AND the engine's improvement phase is running AND the
  // instance is at/above SOLVER_ENGINE_FANOUT_MIN_CHUNKS chunks, neighbourhood
  // sub-solves are batched out over the RPC binding instead of running
  // in-process. Ships dark ("false" in every env block, ms included); any RPC
  // failure degrades to the sequential path for the rest of the solve
  // (`engine_fanout_degraded`) and never fails the resolve. See
  // fanoutEligible() in engine/fanout.ts and runbook §P.
  SOLVER_ENGINE_FANOUT?: string;
  // Card E: chunk-count threshold below which fan-out is not worth its RPC
  // overhead (the spec's "at n = 1 and small n, in-process beats fan-out").
  // Unset/unparseable ⇒ 24; a value that parses but is < 1 clamps UP to a
  // 1-chunk floor rather than falling back — the low override is exactly what
  // lets `bin/engine-smoke.py --phase fanout` trigger fan-out on a tiny dev
  // problem. See fanoutMinChunks() in engine/fanout.ts, parsed via
  // util/env-parse.ts's parseEnvNumberWithFloor.
  SOLVER_ENGINE_FANOUT_MIN_CHUNKS?: string;
  // System-wide weekly-cron on/off switch. Default OFF: the Monday cron does
  // nothing unless this is exactly "true". When "true", the Monday resolve fans
  // out over every connected subject (listSubjects). Stringly-typed Worker var.
  WEEKLY_CRON_ENABLED?: string;
  // Plan 4: comma-separated membership allow-list. Supports exact emails AND
  // domain wildcards like "*@example.com". Governs who may complete
  // federated login. Optional; when unset, only existing active users + the
  // OPERATOR_EMAIL seed admin may log in.
  MEMBERSHIP_ALLOWLIST?: string;
  // Plan 4: purpose-split crypto keys. Each DEFAULTS to TOKEN_HASH_PEPPER when
  // unset (backward-compat: existing hashes/ciphertexts stay valid). Set
  // distinct Secrets Store values in prod. Rotating HASHING_KEY invalidates all
  // bearer/code hashes (re-auth); rotating ENCRYPTION_KEY invalidates all
  // identity_tokens ciphertexts (re-auth). See docs/runbook.md.
  HASHING_KEY?: string;
  ENCRYPTION_KEY?: string;
  HMAC_KEY?: string;
  // Decision D (Plan 5): when exactly "true", events the user is TENTATIVE on
  // (Google status "tentative") block solver time. Default (unset / any other
  // value) → tentative events do NOT block. Stringly-typed Worker var; read in
  // runResolve and passed as a boolean into buildSolverProblem.
  TENTATIVE_IS_BUSY?: string;
  // Plan 6 brief C: inactive-user retention window in days. When this parses to a
  // POSITIVE integer, the daily cleanup cron offboards active users whose
  // last_seen is older than now - RETENTION_DAYS. Unset / empty / "0" / negative /
  // non-numeric → strict NO-OP (the sweep never runs). Stringly-typed Worker var.
  RETENTION_DAYS?: string;
  // Task done-marking: Google Calendar colorId applied to events for tasks that
  // have been marked done. MUST differ from the scheduler create color "5".
  // getDoneColorId() enforces this constraint at runtime.
  DONE_COLOR_ID?: string;
  // The scheduler create color (Google colorId applied to freshly-created chunk
  // events). Used to repaint chunks back when an API done→pending undo clears
  // completion (DC1). Defaults to "5" (the documented create color) if unset.
  CREATE_COLOR_ID?: string;
  // Diagnostic logging master switch. When exactly "true", debugLog() emits
  // verbose `dbg_*` lines (webhook change detection, resolve window, done-scan)
  // to Workers Observability. Default OFF. See src/log.ts.
  DEBUG_LOG?: string;
  // Per-user busy .ics feed master switch. When exactly "true", the public
  // /cal/<token>/busy.ics feed and the /v1/calendar-feeds management
  // endpoints are live. Unset / "false" / anything else → feature OFF: the
  // public feed 404s and the management endpoints return 403 feature_disabled.
  // Default OFF — the feed serves calendar data authed only by a URL token.
  CALENDAR_FEED_ENABLED?: string;
  // Phase 3: Owned meetings feature flag. When exactly "true", the solver
  // incorporates owned meetings into its constraints. Default OFF. Stringly-typed.
  OWNED_MEETINGS_ENABLED?: string;
  // Phase 3: Minimum notice period in minutes before an owned meeting can be
  // scheduled. Default 1440 (24 hours). Stringly-typed.
  MEETING_MIN_NOTICE_MINUTES?: string;
  // Phase 3: Cap on the churn multiplier for owned meetings. Default 20.
  // Stringly-typed.
  MEETING_CHURN_MULTIPLIER_CAP?: string;
  // Minutes after Optical commits a meeting move during which that meeting is
  // held at its slot (cascade stability). Default 60. Stringly-typed.
  MEETING_COMMIT_STABILITY_MINUTES?: string;
  // Dev only: when exactly "true", the Google OAuth scope list appends
  // calendar.acls so the meeting-smoke harness can manage free/busy sharing
  // (freeBusyReader grants) with the raw token. Prod omits it → prod tokens can
  // never touch ACLs. Stringly-typed.
  GOOGLE_ACL_SCOPE_ENABLED?: string;
  // Dev only: when exactly "true", the Google OAuth scope list appends
  // gmail.readonly so poll-smoke can read the organiser's Sent mail with the
  // raw token instead of an operator pasting each invitee link. Prod omits it
  // → prod tokens can never read the mailbox. Stringly-typed.
  GOOGLE_GMAIL_READ_SCOPE_ENABLED?: string;
  // Non-prod only: when exactly "true", the Microsoft OAuth scope list appends
  // Mail.Read so poll-smoke can read the organiser's Sent Items with the
  // raw token instead of an operator pasting each invitee link. Prod omits
  // it → prod tokens can never read the mailbox. Stringly-typed.
  MICROSOFT_MAIL_READ_SCOPE_ENABLED?: string;
  // Public booking page master switch; anything other than "true" 404s every
  // /book route so a disabled deployment never advertises the feature.
  BOOKING_PAGE_ENABLED?: string;
  // Turnstile widget site key, embedded in the page HTML.
  TURNSTILE_SITE_KEY?: string;
  // Turnstile secret (a Worker secret, never a var).
  TURNSTILE_SECRET?: string;
  // Meeting-poll master switch; anything other than "true" 404s every /poll
  // route so a disabled deployment never advertises the feature. Default OFF.
  MEETING_POLL_ENABLED?: string;
  // Booking-page decline auto-cancel: grace period (minutes) between the
  // webhook first observing an all-declined booking-page event and the
  // */5 * * * * sweep (cron/booking-decline-sweep.ts) actually cancelling it
  // (misclick protection). Rides BOOKING_PAGE_ENABLED — no separate flag.
  // Stringly-typed. A value that fails to parse (unset, "", non-numeric)
  // falls back to a default of 10; a value that parses but is < 1 ("0", a
  // negative number) clamps UP to a 1-minute floor instead of falling back
  // to the default (see graceMinutes() in booking-decline-sweep.ts, parsed
  // via util/env-parse.ts's parseEnvNumberWithFloor).
  BOOKING_DECLINE_GRACE_MINUTES?: string;
  // Card 3.0: master switch for capturing every live solver `Problem` JSON to
  // R2 (SOLVER_CAPTURE) for the Stage 3 parity corpus. Default OFF; when not
  // exactly "true", zero R2 calls. Never set where SOLVER_CAPTURE is unbound
  // (see above).
  SOLVER_CAPTURE_PROBLEMS?: string;
  // Card 3.0: label stamped into each captured envelope's `env` field so
  // captures are separable by deployment without a D1 join (the worker has no
  // other way to know which deployment it is). Missing ⇒ "unknown" — a
  // mislabelled capture beats a lost one.
  DEPLOY_ENV?: string;

  // Secrets
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  TOKEN_HASH_PEPPER: string;
}
