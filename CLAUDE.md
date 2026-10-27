# Engineering practices

**Always use TDD.** For any behaviour change or bug fix: write a failing test
that captures the desired behaviour FIRST, watch it fail (red), then make it pass
with the smallest change (green), then refactor. Never write the fix before the
test. A bug fix without a regression test that fails on the old code is incomplete.

**Running tests.** Use the repo-pinned vitest, not `npx` (which can pull an
incompatible major and break `cloudflare:test` resolution):

```bash
cd worker && npm ci                       # deps must be installed first
./node_modules/.bin/vitest run <file>     # single file (worker-pool tests need this binary)
npm run test:ci                           # full suite, batched (scripts/ci-test.sh)
npm run typecheck                         # tsc --noEmit
```

The `@cloudflare/vitest-pool-workers` pool can't collect the whole suite in one
process, so the full run is batched per `test/` subdir — run `test:ci`, not a
bare `vitest run`.

**Timezones.** Tz-sensitive code is covered by the permanent 30-zone matrix in
`worker/test/tz-matrix/` (every whole-hour offset, the off-grid ones, and the
zones whose DST starts at local midnight; expectations come from a brute-force
Intl oracle in `zones.ts`). It stays in `npm run test:ci` for good, and a new
tz behaviour adds its matrix case.


# Deploy

## Dev (`weekly-scheduling-assistant-dev`)

Run from `worker/`, with secrets injected via `op run`:

```bash
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
```

**`--env dev` is required** on every wrangler command — without it, wrangler
resolves against the top-level (prod) config. For `d1 migrations apply`, pass the
binding `DB` (not the db name `scheduler-dev`): the `scheduler-dev` D1 only exists
under `[env.dev]`, so `wrangler d1 migrations apply scheduler-dev` fails with
"Couldn't find a D1 DB". `wrangler d1 migrations apply DB --env dev` resolves the
dev binding correctly.

Always apply migrations BEFORE the deploy, in every env. Migration **0041**
(`users.retention_warned_at`) is load-bearing: `requireBearer` reads the
column, so deploying ahead of it fails every bearer call. Migration **0046**
(`identity_tokens.login_email`) is load-bearing too: every sign-in writes it
and every owner email reads it. So is migration **0047**
(`proposed_plans.commit_claim`/`commit_claimed_at`): every commit and accept
claims the plan before touching the calendar, so deploying first fails every
commit. A second concurrent commit of the same plan answers
`409 commit_in_progress`, normally having written nothing (120 s lease; the
commit runs under `waitUntil`; runbook §E "Accept-exact-hash behaviour").

Dev is fully isolated from prod: own D1 (`scheduler-dev`), KV, Durable Objects,
and the `scheduler-dev.example.com` custom domain.

## Prod

`bin/deploy.sh` applies migrations to `scheduler` and runs `npx wrangler deploy`
(no `--env`).

## Solver container cost

The solver container is shared by every deployment and billed on memory × uptime.
`bin/solver-usage-backfill.py` and `bin/container-usage.py` snapshot calls and
billed usage into `analysis/*.csv` (run weekly — the APIs keep 7 d / 32 d);
`bin/container-cost.py` reconciles to invoices and `bin/container-backtest.py`
grids (memory, sleepAfter) against recorded demand. Runbook §G.
`SOLVER_CAPTURE_PROBLEMS` (default "false") captures live solver problems to
R2 for the Stage 3 parity corpus; see runbook §G, "Problem capture".

## Owned movable meetings

Gated by `OWNED_MEETINGS_ENABLED` (default "false"). When "true", meetings the
signed-in user organises are imported as `tasks` rows (`context:"meeting"`,
`source.kind:"meeting"`) and may be relocated to slots where every *accepted*
attendee is free. Tunables: `MEETING_MIN_NOTICE_MINUTES` (default 1440),
`MEETING_CHURN_MULTIPLIER_CAP` (default 20). Requires the
`calendar.freebusy` OAuth scope — existing accounts must re-consent, and the
re-consent must grant every requested scope (a partial grant is refused at
sign-in in every deployment; runbook Diagnostics, "Permissions needed"). Stored grants that predate
`calendar.freebusy` degrade meetings to immovable (today's behaviour). Moves notify attendees
(`sendUpdates=all`) only after the user accepts the proposed plan.

**Enabling in dev:**

```bash
# In worker/wrangler.toml under [env.dev] vars:
OWNED_MEETINGS_ENABLED = "true"
# Then redeploy:
op run --env-file=../.env -- npx wrangler deploy --env dev
# Existing users must re-consent to gain the calendar.freebusy scope:
./bin/mint-token.py --url https://scheduler-dev.example.com --client-id smoke-cli
```

**Known v1 limitations (see runbook §J for full list):**
- Deletion of a meeting outside the current resolved window is reconciled only when
  that meeting's week is next resolved.
- `guestsCanModify` (editing meetings you don't organise) is out of scope.
- Attendee count is not shown in the replan email.

## Microsoft 365 (Outlook) provider

Gated by `MS_PROVIDER_ENABLED` (default "false"). When "true", `/authorize`
offers Microsoft as a second sign-in provider alongside Google; the chosen
provider is stored per-user (`identity_tokens.provider`), so this is a
per-user selection, not a per-deployment switch. Needs an Entra app
registration (client ID in `MICROSOFT_OAUTH_CLIENT_ID`, secret pushed as
`MICROSOFT_OAUTH_CLIENT_SECRET` via `op run`) — see runbook §O for the
registration steps and dev-tenant setup.

**Enabling in dev:**

```bash
# In worker/wrangler.toml under [env.dev] vars:
MS_PROVIDER_ENABLED = "true"
MICROSOFT_OAUTH_CLIENT_ID = "<from Entra app registration>"
MICROSOFT_TENANT = "common"
# Apply migration 0037 (identity_tokens.provider_subject), then redeploy:
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
# Sign in as a Microsoft account to provision an identity_tokens row with
# provider='microsoft':
./bin/mint-token.py --provider microsoft --url https://scheduler-dev.example.com --client-id smoke-cli
```

With the flag on in dev, `bin/regression-smoke.py --provider microsoft` runs
the standard ladder against dev (runbook §D, §O).


`MS_PROVIDER_ENABLED` is a kill switch, not just a new-signup gate: flipping
it back to "false" also blocks token refresh and Graph API access for
already-provisioned Microsoft users, not only new sign-ins (deliberate,
wave B review — see runbook §O). Mechanically this is a typed
`ProviderDisabledError` thrown by `defaultIdentityProvider`, fails closed
everywhere including the shared `defaultProviders` bundle factory (the
D1 provider lookup is unconditional — the flag disables the identity
provider, not the lookup, so a provisioned Microsoft subject is never
silently handed a Google provider). Offboarding is the one caller that
degrades on this specific error (calendar-side cleanup skipped, D1 removal
still completes); any other provider-construction error is rethrown and
aborts the offboard before any row is deleted. `/oauth/authorize`'s
provider chooser offers Microsoft only when the flag is "true" **and**
`MICROSOFT_OAUTH_CLIENT_ID` is a real (non-placeholder) value. With
`PRIVACY_URL` set, the chooser renders even when Microsoft is off, carrying
the consent disclosure (Limited Use sentence, privacy/terms links); see
runbook §O "Consent disclosure".

Identity is derived from the id_token's verified claims (`email` only when
Entra-attested via `xms_edov`, else the UPN), never Graph `/me.mail` — see
runbook §O for the full nOAuth rationale and the deploy gate that must be
cleared before this reaches an env with existing Microsoft users. Signing
in with the other provider under the same email resets that subject's
calendar sync state and done marker (provider switch is now safe, not
destructive-but-silent), and kills the account's emailed accept links and
poll status links, which are bound to the identity anchor that minted them
— see runbook §O for what a switch does and does
not clean up. With `REFUSE_PROVIDER_REBIND="true"` the switch (and a
same-provider rebind) is refused instead with an "Account already linked"
page; see runbook §S.

A user's internal identity is anchored on the provider's immutable subject
(Microsoft `tid:oid`, Google userinfo `id` — migration 0037), not the
mutable email/UPN a login carries; email is display/admission only, so a
renamed Entra UPN or Google address no longer strands the account under a
new empty user — see runbook §O ("Identity anchor: provider subject") for
the resolution rules and the drift log line. Each sign-in also stores its
verified email as `identity_tokens.login_email` (migration 0046). Owner mail,
the Gmail `From` and the poll organiser name use it (falling back to the
subject when it is NULL), so a renamed user's mail follows the new address
after their next sign-in. Membership and every key stay on the subject.

`MICROSOFT_MAIL_READ_SCOPE_ENABLED` (default unset/"false") appends
`https://graph.microsoft.com/Mail.Read` to the Microsoft OAuth scope list —
the exact counterpart of the Google `gmail.readonly` scope flag (see runbook
§L), so poll-smoke can read a Microsoft organiser's Sent Items to relay
invitee links. Non-prod only, **never** set under the top-level (prod) vars;
re-consent by re-minting (`./bin/mint-token.py --provider microsoft …`) to
pick up the new scope on an already-provisioned account.

**Known v1 limitations (see runbook §O for full list):** cross-provider
freebusy (same limitation class as Google-only owned meetings), done-marking
coupled to an exact Outlook category name (provider default; per-user
override via `users.done_color_id`), unverified-publisher consent
warning until publisher verification, `guestsCanModify` out of scope, no
switch-time ghost sweep for stranded chunk events/old push channels, no
join URL surfaced by either provider, categories read-merge is not atomic,
`addMeet` 400s on a personal MSA mailbox without Teams.

## Meeting polls

Gated by `MEETING_POLL_ENABLED` (default off/unset). When "true", an
organiser can propose a meeting poll (duration + candidate date range);
invitees paint availability on a public grid page (no sign-in), and the poll
auto-books the best slot once everyone has responded, or at its deadline
against whoever has — **except** when the organiser also enabled a guest-join
link: while that link is live and the poll is `open`, it never auto-books or
escalates early, even once every named invitee is in, since a guest could
still join; it waits for the deadline, and the organiser can still force an
early book via `resolveMeetingPoll {action:"book"}` (an explicit slot) or
`{action:"bookBest"}` (books the best slot for whoever has responded so far,
without picking a slot) — both ignore the guest-link wait, since it protects
automatic triggers only. Booked events are
ordinary calendar meetings, never `tasks` rows — `meetings/identify.ts`
excludes any event tagged `optical_poll_id` from import before any other
check, regardless of `OWNED_MEETINGS_ENABLED`. No new OAuth scope required.

**Enabling in dev:**

```bash
# In worker/wrangler.toml under [env.dev] vars:
MEETING_POLL_ENABLED = "true"
# Apply the new migrations (0032 + guest-join 0033/0034), then redeploy:
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
```

The organiser is emailed on a successful booking (slot/duration/location, plus
who's on the calendar invite vs notified privately — reflecting actual send
outcomes, not intent) and on an invitee response save (respondent name,
first-response-vs-update, running response count) — the latter is gated by a
15-minute quiet-period debounce measured from the invitee's last SAVE (not
their last email), so a continuously-revising invitee generates exactly one
email total until they actually stop for 15 minutes; a first response always
notifies regardless. Cancelling a poll (CAS-guarded, so a booking landing
concurrently wins over the cancel) emails every non-dropped invitee —
invited and guest kinds, hidden included — a private per-recipient
cancellation notice.

An escalated (`needs_attention`) poll is not read-only: invitees can keep
revising availability on their existing links, but a save on an escalated
poll never auto-books — the organiser resolves it manually via
`resolveMeetingPoll` (`book` or `bookBest`); editing the poll itself (title,
location, invitees, guest link, deadline) goes through `updateMeetingPoll`
(`PATCH /v1/polls/{id}`) instead — see runbook §L.
`bookBest` never escalates on failure (no qualifying slot yet, or a
concurrent booking already claimed the poll) — the poll's status is left
exactly as found, `open` or `needs_attention` alike, since it's a synchronous,
organiser-initiated "try booking now" and escalating as a side effect would
freeze future auto-book and kill a live guest-join link.

**Known v1 limitations (see runbook §L for full list):** hidden ("hide my
name") invitees are dropped from the booked event's attendee list and instead
get a private booking-notice email with an ICS attachment (no RSVP tracking,
no auto-updates — acceptable since poll meetings are never relocated); all
other non-dropped invitees, including guests and deadline non-responders, are
required attendees; nudges (cron and manual) rotate the invitee's link, so an
older email's link goes dead; deletion outside the resolved window is the
same class of gap as owned meetings §J; the response-saved organiser
notification is a quiet-period debounce against the invitee's last save, not
a fixed-rate cap — a continuous burst of saves yields exactly one email
total, not periodic resends (≤4 emails/hour/invitee is a hard ceiling, not a
typical rate); a guest-link poll's organiser only finds out about a disjoint
intersection at the deadline, by design.

## Booking-page paging

Rides `BOOKING_PAGE_ENABLED` — no separate flag, and no migration. The public
`GET /book/{slug}/slots` takes a `page` index (absent = 0): page k covers days
`[k·horizon_days, (k+1)·horizon_days)` off the server's `now`, each page one
calendar read sized to its own window. `horizon_days` is therefore the page
size (and all a booker sees at first); the new `max_horizon_days`
(1–365, `null` default = one page, i.e. today's behaviour; must be ≥
`horizon_days`, `400 invalid_horizon` checked on the merged config) is how
far they may press the strip's "Later →" cell. Pages past the reach are
`400 page_out_of_range`, refused before any read. The claim path re-verifies
against the page holding the requested start only (`pageForStart`), so a
far-out booking costs one read, not a year of calendar. See runbook §M
"Paging"; smoke step B10 in `bin/booking-smoke.py`.

## Public read cache and limits

**No flag, no migration.** The three availability reads anyone with a link
can drive (`GET /book/{slug}/slots`, `GET /poll/{id}/grid`,
`PUT /poll/{id}/response`), after the flag/slug/token/membership checks,
pass a per-IP limit on every request (`PUBLIC_READ_IP_LIMITER`, 30/min per
`CF-Connecting-IP`, IPv6 keyed on its /64), then read the owner's calendar
through a per-colo Cache API copy (`PUBLIC_READ_CACHE_TTL_SECONDS`, default
60, "0" = off; titles and addresses are never stored). Only a cache miss
spends the per-page budget (`PUBLIC_READ_TARGET_LIMITER`, 120 calendar
reads/min per slug or poll). Over either limit is `429 rate_limited` +
`Retry-After: 60`, with no calendar read. Both limiters are `[[ratelimits]]`
bindings in every env block, mirrored in `vitest.workspace.ts`. D1 inputs
stay fresh, so a new booking blocks at once, and the key carries an own-write
generation (task count + newest `tasks.updated_at`), so a commit shows at
once; a calendar change made outside Optical can take up to the TTL to show.
The booking claim, poll booking, the status page and every authenticated path
read live (`worker/src/public-read/`, pinned by
`test/public-read/wiring.test.ts`). The cache is not available on
`*.workers.dev` or behind Access; check it per env with `DEBUG_LOG`
(`dbg_public_read_cache {hit}`). The suite pins the TTL to "0". See runbook
§K "Public read cache and limits".

## Booking-page owner notice

Rides `BOOKING_PAGE_ENABLED` — no flag, no migration. After a claim's
calendar event is created, the owner gets a best-effort "New booking" email
from and to their own mailbox (booker, time in the owner's tz, duration, how,
and the booker's note labelled as untrusted); self-addressed, so the outbound
cap never counts it. Log line `booking_owner_notified {ok,bookingId}`. See
runbook §K "What happens on a booking".

## Booking-page decline auto-cancel

Rides `BOOKING_PAGE_ENABLED` — no separate flag. When the sole attendee of a
booking-page-owned calendar event (identified by the event's own
`optical_booking` extended property, `worker/src/booking/decline-cancel.ts`)
declines and the event hasn't started, the webhook path stamps
`bookings.cancel_pending_at`; a new
`*/5 * * * *` sweep (`worker/src/cron/booking-decline-sweep.ts`) re-verifies
each stamped row against the live calendar event once it's at least
`BOOKING_DECLINE_GRACE_MINUTES` old (default `"10"`; unset or unparseable
falls back to that default, and a value that parses but is `< 1` clamps UP to
a 1-minute floor rather than falling back — see the constant's comment in
`env.ts`), then deletes the event (`sendUpdates=all`), marks the row
`'cancelled'`, and emails the booker (please re-book) and the owner
(heads-up). An un-decline before the sweep fires aborts the clock. `GET
/v1/bookings` uses a new `listBookingsForOwner` (includes `'cancelled'` rows,
management-view only) — the original `listBookings` used for slot-blocking
availability is unchanged and still excludes them, since a cancelled slot
should re-open immediately. See runbook §M for the full mechanism and known
v1 limitations.

## User timezone

**No flag.** It rides `users.home_tz` (0018) plus migration 0040. Any signed-in
user can set their own timezone with `GET/PATCH/DELETE /v1/timezone`
(`getTimezone`/`setTimezone`/`resetTimezone`,
`worker/src/handlers/timezone.ts`). An IANA zone is stored canonicalised;
DELETE falls back to `SCHEDULER_TZ`. There's one tz per user, with no
home/current split. A change of *effective* tz discards the user's pending
plans (they were solved under the old hours) and replans nothing by itself.
The next resolve applies business hours in the new tz, so free-floating
chunks move, while pins, deadlines and `pinned_tz` templates stay put. Task
`preferred_windows` are wall-clock, so a change stamps the *old* tz onto the
untimezoned windows of all its tasks (never templates).
`planning/window-projection.ts` then projects them into the planning tz,
with a hard window that doesn't stay single becoming an exact
`availability_windows` mask. `replan-now?force=true` replans at once.

Every week-identity site (webhook and cron window derivation, churn/drop
baselines, supersede, accept grouping) buckets in the subject's **effective
tz** (`getHomeTz`), never `env.SCHEDULER_TZ` directly. They must move
together, because a bucket must use the tz that produced the window. The
Monday cron still fires once at Sun 15:00 UTC and takes each user's
`upcomingLocalWeekWindow` (the local week containing now + 3.5 d). See
runbook §Q, including the transition caveats. Proposed plans record their
bucketing tz (`proposed_plans.window_tz`, migration **0040**, NULL =
`SCHEDULER_TZ`), and week lookups match same-tz rows only. Apply 0040 before
deploying:

```bash
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
```

Smoke: `bin/timezone-smoke.py`.

## Per-user cost curves & weights

**No flag — rides the always-on `config_contexts`/`config_weights` tables.**
Any signed-in user can customise the solver's cost model for their own week:
the per-context fit curve + caps/penalties for each of the 5 contexts
(`deep`, `admin`, `physical`, `family`, `meeting`), and the 6 global soft
weights. `weights_override` (per-resolve, `z.record(z.number())`) can already
override any of the 6 weight keys for a single resolve — `churn_per_15min_moved`
is just the motivating example, since before this feature its *persistent*
default was settable only via migration, with no other per-user knob at all.
Six ops: `GET/PATCH/DELETE /v1/contexts` (`{context}` on PATCH/DELETE) and
`GET/PATCH/DELETE /v1/weights` (`worker/src/handlers/contexts.ts`,
`worker/src/handlers/weights.ts`).
Effective config is a per-context merge — the caller's own row if present,
else the `'__default__'` instance-default row — computed once in
`worker/src/db/context-config.ts` and shared by resolve, `GET /v1/contexts`,
and the meeting-poll booking engine's fit-curve lookup.

PATCH stores a **complete snapshot** (partial body merged over the effective
config), so a customised context or weights row stops tracking future
instance-default changes, on every field, until reset via `DELETE
/v1/contexts/{context}` or `DELETE /v1/weights` — writing values equal to
today's defaults is not the same as resetting, since it would freeze if
defaults later change. Precedence for weights:
`'__default__'` < caller's custom row < per-resolve `weights_override`
(unchanged, still wins for that one resolve only). No migration — both
tables already existed, per-user-keyed, since `0017_per_user_config.sql`.

See runbook §N for the endpoint contract, validation rules, and known v1
limitations. Smoke: `bin/config-smoke.py`.

## Bespoke solver engine

Gated by `SOLVER_ENGINE` (default `"container"` — the engine ships **dark**,
so a deploy changes nothing until the flag is flipped). An in-process
TypeScript exact-search engine (`worker/src/engine/`, four layers: substrate,
pass-1 selection B&B, pass-2 placement B&B, deletion-based MUS + demotion)
that solves the same `Problem` the container solves and returns the same
`Solution`/`UnsatResponse` shapes — same statuses, same 422 + `unsat_core`
vocabulary, same drop reasons. Modes:

- `container` — today's HTTP hop to the solver container (default).
- `shadow` — container serves; the engine runs alongside for one
  `solver_shadow` comparison line. Never changes the response, but its wall
  is paid *synchronously* on top of the container round trip.
- `fallback` — the engine goes first and is served **only when it certifies**
  (`OPTIMAL`); a crash, the wall guard, an uncertified status, or a 422 all
  re-solve via the container (`solver_fallback` line with the reason). The
  container stays the authority on user-visible errors.
- `worker` — the engine is the only solver; no HTTP hop and no second
  opinion (a crash is a 500, as an unreachable container is).

Promotion path is `shadow → fallback → worker`; rollback at every stage is a
flag flip back to `"container"`. `solver_diagnostics` and `solver_calls`
(migration 0039) both gain `engine`, naming who produced the *served* answer.
`SOLVER_ENGINE_WALL_GUARD_MS` (default 120000) is a fallback-mode **serving**
guard, not a timeout — the engine is synchronous and cannot be preempted.
`[limits] cpu_ms = 300000` is set in every env block for the same reason.

**Enabling in dev:**

```bash
# In worker/wrangler.toml under [env.dev] vars:
SOLVER_ENGINE = "shadow"
# Apply migration 0039 BEFORE deploying (an unmigrated D1 makes every resolve
# log `solver_calls insert failed`), then redeploy:
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
# Watch the comparison lines:
npx wrangler tail --env dev --format json | grep solver_shadow
```

The engine's search was strengthened in a second round (Lagrangian
contention bound, pass-1 branching order + Hall cuts, deterministic LNS
improvement phase, gap-proportional budget controller — allowlist 6 → 4,
internal bench results). It also gained a **fan-out escape
hatch**: `SOLVER_ENGINE_FANOUT` (default `"false"` everywhere — ships dark)
runs the improvement phase's sub-solves as batched RPC to the worker's own
`EngineRpc` entrypoint when the flag is `"true"`, the `ENGINE_RPC` binding
is bound, and the problem has ≥ `SOLVER_ENGINE_FANOUT_MIN_CHUNKS` chunks
(default 24; dev smoke overrides to "1"). The flag may change wall clock,
never the answer (exact under node budgets; see the §P caveat for a
binding wall); any RPC failure degrades to sequential and never fails
the resolve. See runbook §P. The bench set exercises the fan-out code at
corpus scale: `bench/runners/bespoke-fanout.mjs` (worker_threads leaf
pool), the `fanout_*` corpus family, and the `optical_bench.identity`
gate (internal design notes;
internal bench results).

See runbook §P for the architecture, `bound_gap` interpretation, every log-line
shape, the soak procedure and exit criteria, the bench acceptance summary
(including the four allowlisted problems), and known v1 limitations. Smoke:
`bin/engine-smoke.py` (no flag: detects the deployed `SOLVER_ENGINE` off the
Workers settings API and asserts that phase — container/shadow/fallback/
worker; `--phase <p>` pins one; `--phase fanout` is explicit-only, dev-only,
and expects `SOLVER_ENGINE_FANOUT="true"` +
`SOLVER_ENGINE_FANOUT_MIN_CHUNKS="1"` deployed plus a crowded week).

## Membership and account lifecycle

A non-empty `MEMBERSHIP_ALLOWLIST` is authoritative: an existing active user
not on it (and not in `OPERATOR_EMAIL`) is refused at sign-in. The
existing-user branch applies only when no allow-list is configured.
`worker/test/auth/membership.test.ts` pins this against each env's real toml
values. A refused sign-in gets a 403 "Invitation only" page (asks the person
to contact `INVITE_CONTACT`; no redirect to the client), and with an
allow-list set a delisted subject's `refresh_token` grant is refused
(`400 invalid_grant`, chain revoked). Offboard (`bin/optical-admin.py
offboard`) and the `RETENTION_DAYS` sweep are in runbook "Plan 4 cutover" §4
and "Account lifecycle".

**Refresh rotation.** A `refresh_token` grant is single-use under a CAS
(`revoked_at IS NULL`): of a concurrent burst presenting one token, exactly
one mints a new pair and the rest get `400 invalid_grant` `"revoked"`. Every
refused refresh logs `oauth_refresh_refused {reason, client_id}`. Don't
deploy it to an env until the codemode-mcp single-flight refresh fix is live
on every codemode-mcp deployment that talks to that env (runbook §S,
"Single-use refresh rotation").

**Upstream revoke.** `UPSTREAM_REVOKE_ENABLED` (default "false") makes
offboard and a refused sign-in revoke the user's grant at the IdP (Google
revoke endpoint; Microsoft is a no-op). Set it only where the deployment has
its own Google OAuth client: Google's revoke removes the whole user-to-client
grant, so deployments sharing a client would revoke each other's users.
Runbook "Plan 4 cutover" §4.

**Raw-token route.** `CALENDAR_RAW_TOKEN_ENABLED` (default off; exactly
"true" enables) gates `GET /v1/calendar-access-token`; off is a 404 before
auth, like `SELF_SERVE_DELETE_ENABLED`. Only the smoke deployments set
"true" (the harnesses need it: `RawTokenRouteDisabled` otherwise); prod and
trial set "false". Runbook "Auth model".

**Retention warning.** The `RETENTION_DAYS` (R) sweep emails a warning at
`max(R−14, 1)` days idle and deletes only once the warning is ≥ 14 UTC days
old; any activity clears it. Migration **0041**
(`users.retention_warned_at`) must be applied BEFORE deploying:
`requireBearer` reads the column, so an unmigrated D1 fails every bearer
call. Runbook "Account lifecycle".

**Self-serve deletion.** `SELF_SERVE_DELETE_ENABLED` (default "false") gates
`DELETE /v1/account` (`deleteAccount`, body `{confirm:<own email>}`, needs
`scheduler:write`). Flag off is a 404 that deliberately runs before auth, so
a disabled deployment doesn't reveal the route (polls and the booking page
use 403 `feature_disabled` instead). It runs the full offboard on the
caller's own subject only; the deactivated `users` row (email, role,
timestamps) and `audit_log` are kept and disclosed, for as long as
`DELETED_ACCOUNT_RETENTION_DAYS` says. Runbook "Account lifecycle".

**System mail.** `SYSTEM_MAIL_ENABLED` (default "false") gates Optical's
first-party sender (`worker/src/mail/system-mailer.ts`, SMTP2GO HTTP API),
separate from product mail sent from the user's own mailbox. Needs var
`SYSTEM_MAIL_FROM` and secret `SYSTEM_MAIL_API_KEY`. Off is a silent no-op;
`send` never throws. Log lines and failure statuses: runbook "Account
lifecycle", "System mail".

**Purge window.** `DELETED_ACCOUNT_RETENTION_DAYS` (unset/"0" = keep
indefinitely) is N days after an offboard before the daily sweep deletes the
deactivated `users` row and replaces the subject in `audit_log.subject` and
`.actor` with a keyed `deleted:<hmac>` pseudonym. Prod and dev set "0".
Offboard stamps `users.deactivated_at` (migration **0043**); pre-0043 rows are
stamped on the first run, never mass-deleted. The sweep also logs
`retention_unwarnable {count}` for users it can't warn (never auto-deleted),
and `optical-admin list-users` flags them `overdue_unwarned`. Runbook
"Account lifecycle", "Purge window".

**Agentic safety (runbook §S).** Apply migrations **0042–0046**
BEFORE deploying: without 0043 every sign-in fails (`touchLastSeen` writes
`users.deactivated_at`); without 0045 (`pending_actions.mail_channel`) a
gated op whose own-mailbox confirm send fails 500s at the system-mail
fallback. 0042 and 0045 also back `replanNow` for every client in every env:
on an unmigrated D1 any `replanNow` that sends mail returns 500. Without
0046 (`identity_tokens.login_email`) every sign-in (the store upsert writes
it) and every owner email (`ownerNotificationEmail` reads it) fails.
- *Agent-confirm.* `AGENT_CONFIRM_CLIENT_IDS` (unset = nobody gated; "*" =
  every OAuth client) lists the clients whose consequential ops answer
  `202 awaiting_confirmation` and run only after the user confirms an
  emailed single-use link (`/confirm/{id}`, outside the spec; the POST
  refuses `Authorization` and a foreign `Sec-Fetch-Site`). Gated: `commit`
  and acceptPlan's bearer branch (they email the plan's own accept link),
  the poll ops that email or book, poll title/location edits on an open or
  escalated poll (decision J), booking-page publishing and `deleteAccount`.
  An identical request while one waits returns the same 202 with no new
  email. At most 20 live pending actions per user
  (`429 too_many_pending_actions`), and at most 3 confirmations per user per
  rolling 24 h sent by the system-mail (SMTP2GO) fallback when the user's own
  mailbox send fails (0045; past that, 503). `replanNow` (every client)
  sends each plan's accept email at most once while its link is live and
  counts toward the same limits; when it skips the email it still answers
  200, with `email_sent: false` and `email_skipped`. Replays re-check state.
  Re-vendor codemode-mcp after any change to this surface.
- *Outbound mail cap.* `OUTBOUND_MAIL_DAILY_CAP` (default 50; "0" = no
  third-party mail (a kill switch, not unlimited)) caps third-party
  recipients per subject per UTC day from the user's own mailbox (migration
  0044). Poll create/nudge/update answer
  `429 mail_cap_exceeded` before any write; mail to the user, calendar
  invites and system mail aren't counted.
- *Untrusted fields.* Response fields carrying third-party text are tagged
  `x-optical-untrusted: true` in the spec, and render snapshots returned over
  the API show others' event titles as "Busy". A plan loses
  `render_snapshot` and `body.warnings` when it is accepted (the daily cleanup
  backfills, and also prunes expired `pending_actions`). `GET /v1/schedule` and `GET
  /v1/plans/{hash}` strip `body.warnings` on read.
- *Delisted users.* With `MEMBERSHIP_ALLOWLIST` set, every cron, webhook
  replan and public page (booking, poll, feed, accept and confirm links)
  does nothing for a subject not on it (`delisted_skip {path}`); retention
  and the purge still run.
- *Provider rebind refusal.* `REFUSE_PROVIDER_REBIND` (default off; exactly
  "true" enables) refuses a sign-in whose email belongs to an account bound
  to a different provider subject or provider. To release it, an operator
  runs the admin rebind (`bin/optical-admin.py rebind <email> --env E --yes`,
  `POST /admin/identity-rebind`). It clears the anchor so the next sign-in
  as that address binds whoever holds it, so confirm who that is first, and
  ends the account's sessions like offboard and wipes its stored refresh
  credential, so the account is idle until the next sign-in (connected
  clients re-authorise, confirm links die, resolve/replanNow answer `409
  identity_credential_missing`; with `UPSTREAM_REVOKE_ENABLED` the grant is
  revoked at the IdP too). It also deletes pending plans, revokes calendar feed
  URLs (recreate them), and kills emailed accept links and organiser poll
  status links (bound to the identity anchor). Accept links minted before that
  build carry no anchor and live up to 72 h, so don't rebind within 72 h of
  deploying it. The booking page stays published for the next holder. Use it
  only where the flag is on. It answers
  `409 subject_drifted` when the owner now signs in under another address
  (`--force` overrides, after confirming ownership) and
  `409 concurrent_update` when a sign-in raced it (re-run). Runbook §S
  "Admin rebind". Smoke: `bin/identity-smoke.py` (A, the admin, rebinds a
  test account B, which then signs in again in a browser; B needs a re-mint
  afterwards).
- *Scope valve.* `REQUIRE_EXACT_PROVIDER_SCOPES` (default: require exact
  provider scopes; only "false" relaxes it) lets a partial grant through
  instead of refusing it. With `DEBUG_LOG="true"` the callback logs the raw
  granted scope string (`dbg_auth_callback_granted_scopes`). Verify the scope
  check by minting on dev and the Microsoft env before deploying prod.

## Calendar event ownership across deployments

**No flag.** Every event a deployment creates (chunks, bookings, poll
bookings) carries the private extended property `optical_deployment` = the
origin of its `OAUTH_ISSUER` (`worker/src/providers/deployment-scope.ts`; no
new var). Both providers strip `scheduler_chunk_id` and `optical_booking` off
an event another deployment stamped, on every read, so commit, the stray
scan, done-by-colour, recolour and the offboard sweep never touch it and it
reads as ordinary busy time. `optical_poll_id` is not stripped (it keeps a
poll meeting out of every deployment's owned-meeting import). An unstamped
legacy chunk is the reader's own only when its task is a tasks row of this
D1; otherwise resolve treats it as external busy time and commit and the
offboard sweep never delete it (`worker/src/planning/scheduler-chunks.ts`).
Commit stamps a legacy chunk of its own plan when it next reconciles it. The
`OAUTH_ISSUER` origin is therefore a durable identity: changing it orphans
every stamped event. One calendar should still never be
connected to two deployments: they'd replan on each other's changes. See
runbook §I, "Which deployment owns an event".


