# Changelog

Curated notes for each public release, newest first. The full commit list for
a release is in that release's PR on the public repository.

## v1.3.1

Fixes from an external review: timezone correctness across every zone, a
double-accept race, and limits on the public availability reads.

- **Upgrading:** apply migration **0047**
  (`proposed_plans.commit_claim`/`commit_claimed_at`) before deploying, in
  every environment. Without it every commit and accept fails. Each env block
  in `wrangler.toml` now declares two `[[ratelimits]]` bindings; their
  `namespace_id`s are account-wide, so pick ids nothing else on your
  Cloudflare account uses. No new vars or secrets.
- **Timezones:** a permanent 30-zone test matrix (every whole-hour offset, the
  off-grid zones and the zones whose DST starts at local midnight), checked
  against a brute-force `Intl` oracle, is now fully green. Fixes found by it:
  - All-day events block the user's local day. West of UTC they blocked the
    day before, and webhook week bucketing had the same error.
  - A midnight or pinned time that falls in a DST gap shifts forward instead
    of throwing.
  - Recurrence expands on local dates; pinned templates expand in their
    pinned zone, so far-east pinned templates are no longer shed every week.
  - Booking and poll slots align to the local half hour (owners in :45-offset
    zones now see :00/:30 local slots). Saved poll cells carry across a grid
    move by overlap, with a notice to the invitee and a note on the
    organiser's status page.
  - Timezone ids are stored canonical; re-saving a legacy spelling renames it
    in place.
  - A hard preferred window projected over a fall-back hour could be
    violated. Fixed.
- **Commit claim:** two concurrent accepts of one plan could duplicate
  calendar events. A commit now claims the plan (120 s lease) before touching
  the calendar; a concurrent one gets `409 commit_in_progress`, shown on the
  accept page as "Already being applied". The commit runs under `waitUntil`,
  so a client disconnect no longer cuts it off mid-write.
- **Public reads:** `GET /book/{slug}/slots`, `GET /poll/{id}/grid` and
  `PUT /poll/{id}/response` are limited to 30 requests a minute per IP (IPv6
  per /64) and 120 calendar reads a minute per page, answering
  `429 rate_limited` with `Retry-After` past either. Calendar reads go through
  a 60 s per-location cache (`PUBLIC_READ_CACHE_TTL_SECONDS`, "0" = off) that
  stores no titles or addresses. Bookings and Optical's own commits show at
  once; a change made outside Optical can take up to the TTL. Booking claims,
  poll booking and authenticated paths always read live. Runbook §K.

## v1.3.0

Identity hardening and data minimisation, from preparing the hosted trial
for Google's OAuth verification.

- **Upgrading:** apply migration **0046** (`identity_tokens.login_email`)
  before deploying, in every environment. Without it every sign-in and every
  owner email fails. The raw calendar-token route is now off by default
  (below): set `CALENDAR_RAW_TOKEN_ENABLED = "true"` on any environment the
  `bin/` smoke harnesses target.
- **Sign-in address:** each sign-in stores its verified email as
  `login_email`. Owner mail, the Gmail `From` and the poll organiser name use
  it, so a user whose Google address or Entra UPN is renamed gets mail at the
  new address after their next sign-in. Membership and every key stay on the
  provider subject.
- **Admin rebind** (`POST /admin/identity-rebind`, `bin/optical-admin.py
  rebind`): releases an account that `REFUSE_PROVIDER_REBIND` has locked, so
  the next sign-in as that address binds whoever holds it. It ends the
  account's sessions, wipes its stored refresh credential, deletes pending
  plans, revokes calendar feed URLs and kills emailed accept links and
  organiser poll status links. Until the next sign-in, `resolve` and
  `replanNow` answer `409 identity_credential_missing`. It answers
  `409 subject_drifted` when the owner now signs in under another address
  (`--force` overrides) and `409 concurrent_update` when a sign-in raced it.
  Runbook §S; smoke: `bin/identity-smoke.py`.
- **Provider switch:** signing in with the other provider under the same
  email now resets that subject's calendar sync state atomically, and closes
  a race between the switch and a concurrent token refresh.
- **Data minimisation:**
  - Calendar reads fetch only the event fields Optical uses (Google
    `fields=`, Graph `$select`); location and description are no longer kept.
  - Third-party event titles leave a plan when it is accepted, and a daily
    sweep scrubs any committed plan that still holds them. `GET /v1/schedule`
    and `GET /v1/plans/{hash}` no longer return `body.warnings`.
  - The cached IdP access token is encrypted, keyed by a hash rather than
    the user's email, and kept for at most an hour.
  - Expired agent-confirm actions are pruned daily.
  - Prod turns Workers invocation logs off, since capability links carry
    secrets in request URLs. Console logs still ship.
- **Raw calendar-token route:** `GET /v1/calendar-access-token` is behind
  `CALENDAR_RAW_TOKEN_ENABLED` (off: a 404 before auth).
- **`subscribeWebhook`** now answers `subscribed: true` whenever the caller
  has a live push channel, including one that already existed. Provider
  errors no longer return 500.
- **Docs:** if you run your own OAuth client, your organisation's terms with
  Google govern the calendar data your users' AI assistant receives,
  including whether it may be used for model training (runbook §A, README).

## v1.2.0

Hardening for running Optical for people other than its operator: agents act
only with the user's confirmation, mail and accounts have lifecycle limits,
and sign-in and token handling are stricter.

- **Upgrading:** apply migrations **0041–0045** before deploying, in every
  environment.
  - Without 0041, every bearer call fails.
  - Without 0043, every sign-in fails.
  - Without 0042 and 0045, a `replanNow` that sends mail returns 500.

  Refresh tokens are now single-use (below). If an MCP front end such as
  codemode-mcp refreshes in parallel, upgrade it to a release with
  single-flight refresh (codemode-mcp v1.2.0) *before* deploying this one,
  or its connector breaks on the first parallel refresh and has to be
  re-authorised.
- **Agent confirmation** (`AGENT_CONFIRM_CLIENT_IDS`, default: no client
  is gated). For the OAuth clients listed, consequential operations answer
  `202 awaiting_confirmation` and run only after the user clicks a
  single-use link emailed to them. These operations are:
  - `commit`, and `acceptPlan` called with a bearer token;
  - the poll operations that email or book;
  - poll title and location edits on an open poll;
  - publishing the booking page;
  - `deleteAccount`.

  Each user can have at most 20 actions waiting for confirmation. If the
  user's own mailbox can't send a confirmation, a system-mail fallback
  sends at most 3 per user per day.
- **Outbound mail cap:** at most 50 third-party recipients per user per UTC
  day from the user's own mailbox (`OUTBOUND_MAIL_DAILY_CAP`; `"0"` turns
  third-party mail off). Over the cap, poll create, nudge and update return
  `429 mail_cap_exceeded` before writing anything.
- **`replanNow`** sends each plan's accept email at most once while its link
  is live, for every client. When it skips the email it still answers 200,
  with `email_sent: false` and `email_skipped`.
- **Untrusted text:** response fields that carry third-party text are
  tagged `x-optical-untrusted: true` in the spec. Plan views returned over
  the API show other people's event titles as "Busy".
- **Membership and account lifecycle:**
  - A non-empty `MEMBERSHIP_ALLOWLIST` is now authoritative. A user who
    isn't on it is refused at sign-in and at token refresh, and every cron,
    webhook replan and public page skips them.
  - `RETENTION_DAYS` emails a warning before deleting an idle account, and
    deletes it only once the warning is at least 14 days old.
  - `DELETED_ACCOUNT_RETENTION_DAYS` sets how long after an offboard the
    deactivated user row is purged and the audit log pseudonymised.
  - Self-serve account deletion, `DELETE /v1/account`, is behind
    `SELF_SERVE_DELETE_ENABLED`.
  - A first-party system mailer (SMTP2GO) is behind `SYSTEM_MAIL_ENABLED`.
  - With `UPSTREAM_REVOKE_ENABLED`, offboarding also revokes the user's
    grant at the identity provider.
- **OAuth and sign-in:**
  - Refresh tokens are single-use, enforced with a compare-and-set. Of a
    concurrent burst presenting one token, exactly one succeeds.
  - A sign-in that grants only some of the requested scopes is refused
    (`REQUIRE_EXACT_PROVIDER_SCOPES`).
  - `REFUSE_PROVIDER_REBIND` refuses a sign-in that would rebind an
    account to a different provider identity.
  - The admin scope is re-checked on every refresh.
  - The provider chooser can show a consent disclosure with privacy and
    terms links (`PRIVACY_URL`, `TERMS_URL`).
- **Calendar sync:**
  - Push channels are created at sign-in, and by a daily sweep for any
    grant holder who has none.
  - Every event a deployment creates is stamped with its origin
    (`optical_deployment`), so two deployments never treat each other's
    events as their own.
- **Smaller changes:**
  - Booking-page owners get a "New booking" email.
  - An accept-link POST that carries `Authorization` is refused.
  - Task writes with `source.kind: "meeting"` return 400.
  - Public pages redirect a trailing slash with a 301.

## v1.1.1

- **Security (solver dependency):** the solver's `certifi` is bumped to
  2026.10.19, which removes trust for the compromised eMudhra intermediate
  CAs (Mozilla bug 2083449). This changes only `solver/uv.lock` and no
  other packages. Rebuild and redeploy the solver container to pick it up.

## v1.1.0

- **Per-user timezone:** any signed-in user can now set their own timezone
  with `GET/PATCH/DELETE /v1/timezone` (`getTimezone`, `setTimezone`,
  `resetTimezone`). Zones are IANA names, stored canonicalised; UTC offsets
  and bare legacy aliases are rejected, and `DELETE` falls back to the
  deployment's `SCHEDULER_TZ`. Previously a deployment ran on one
  operator-set timezone for everyone.
- Business hours, week boundaries (webhook and cron windows, churn and drop
  baselines, supersede, accept grouping) and the Monday cron's upcoming week
  all follow the user's effective timezone. Changing it discards pending
  plans; the next resolve moves free-floating chunks, while pins, deadlines
  and `pinned_tz` templates stay put. A task's preferred windows keep their
  wall-clock meaning in the timezone they were written in.
- **Migration 0040** (`proposed_plans.window_tz`) must be applied before
  deploying. New smoke harness: `bin/timezone-smoke.py`. See runbook §Q.

## v1.0.2

- **Licence:** the Licensed Work is now "Optical 1.0.0 or later", so point
  releases are covered without editing the licence, and each release converts
  to Apache 2.0 four years after it is published (previously a single Change
  Date of 2029-09-22 for everything). The Additional Use Grant is unchanged.

## v1.0.1

- **README:** new "Using it from an AI assistant (MCP)" section. It points
  to [codemode-mcp](https://github.com/victor-bajanov/codemode-mcp-public),
  whose `optical` provider puts a code-mode MCP server in front of the Optical
  API for Claude and other MCP clients.

## v1.0.0

First public release of Optical under the Business Source License 1.1.

- **Weekly planning** — constraint-based placement of tasks into the real
  calendar: hard/soft deadlines, preferred and hard windows, chunking, pins,
  same-day and ordered groups, per-context caps, churn-minimising replans,
  per-task drop reasons and unsat cores for infeasible weeks.
- **Solver engine** — an in-process exact-search engine (selection and
  placement branch-and-bound, MUS extraction) with the CP-SAT container as a
  certified fallback, selectable via `SOLVER_ENGINE`.
- **Calendar providers** — Google Calendar and Microsoft 365 (Outlook),
  chosen per user; identity anchored on the provider's immutable subject.
- **Propose → accept** plans, push-notification replanning, recurring tasks,
  and done-marking by colour/category.
- **Owned movable meetings**, a **public booking page** with paging and
  decline auto-cancel, **meeting polls** with guest-join links, and a private
  **busy `.ics` feed**.
- **Per-user cost curves and weights** for the solver's objective.
- Multi-user OAuth 2.1 (PKCE) API with an OpenAPI spec, and smoke harnesses
  for every feature.
