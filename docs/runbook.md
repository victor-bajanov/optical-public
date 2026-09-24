# Operator Runbook — First Test Run

Top-to-bottom path from a fresh Cloudflare account to a working scheduler.
Assumes you have a Cloudflare zone on the same account you'll deploy to.

## Auth model

**`/v1/*` routes** are bearer-authenticated. Callers supply an OAuth bearer token
minted via the PKCE flow (`bin/mint-token.py`).

**`/admin/*` routes** are admin-bearer — gated by `requireBearer` +
`requireAdminSubject` + `requireScope("admin")` — **except `/admin/dev-ui`**,
which remains Cloudflare Access-gated (the only human-facing, browser-only
route). All other `/admin/*` routes accept the bearer alone; a CF_Authorization
cookie is not required and not checked.

**Privileged OAuth scopes:**
- `calendar:raw-token` — mint a raw Google access token via
  `GET /v1/calendar-access-token`. Restricted to clients whose
  `oauth_clients.allowed_scopes` lists this scope.
- `admin` — reach cross-user `/admin/*` operations. Requires the subject to
  carry `role='admin'` in the `users` table; the `/auth/callback` handler
  narrows the granted scopes to `admin` only for subjects with that role.

A per-client `oauth_clients.allowed_scopes` column bounds what each client may
be granted. To grant admin access to `smoke-cli`, re-register it with the
`admin` scope (see §B.5 below).

**Smoke harnesses** authenticate with the bearer alone. They no longer need a
Cloudflare Access JWT (`CF_Authorization` cookie / header). `bin/mu-smoke-login.py`
only mints and prints per-account bearer env vars now — it does not harvest a CF
cookie.

**Minting identities (`bin/mu-smoke-login.py`).** Pass every letter you need
in one invocation and get back a single combined eval-able env block — each
letter is still its own interactive Google OAuth dance, run sequentially
(switch Google accounts when prompted between identities). Pass all three
account emails every time — they become the `*_EXPECTED_EMAIL` vars, and the
script checks each freshly minted bearer against the matching one via
`GET /v1/whoami` before moving to the next letter, so a wrong-account login
fails at mint time instead of mid-run (`--no-verify` skips the check):

```bash
DEV=https://scheduler-dev.example.com
EM="--email-a a@example.com --email-b b@example.com --email-c c@example.com"
eval "$(bin/mu-smoke-login.py A B C --url $DEV $EM)"
```

A wrong-account login on one letter (e.g. B) still prints the exports for
every letter that minted before it (A here) — you get a non-zero exit and a
stderr note naming which letter(s) didn't mint, but not silence; re-run just
the missing letter(s) once you've switched accounts. Each letter can also be
minted on its own, one invocation per account, if you'd rather interleave
minting with other setup:

```bash
eval "$(bin/mu-smoke-login.py A --url $DEV $EM)"
eval "$(bin/mu-smoke-login.py B --url $DEV $EM)"   # switch Google account!
eval "$(bin/mu-smoke-login.py C --url $DEV $EM)"   # meeting-smoke / poll-smoke
```

Each run exports `SCHEDULER_URL`, `D1_DATABASE_ID` (chosen by `--url`'s host:
`scheduler-dev` for the dev host, explicitly
`unset D1_DATABASE_ID` for any other host — never prod, and never a stale
value left over from a previous run's export), the minted letter's
`_BEARER`/`_REFRESH`/`_EXPECTED_EMAIL`, the other letters' `_EXPECTED_EMAIL`,
and poll-smoke's `INVITEE_A_EMAIL` / `INVITEE_B_EMAIL` (mailboxes, not
identity letters: they are accounts **B** and **C**, since poll-smoke's
organiser is identity A). That covers every env var `multiuser-smoke.py`,
`meeting-smoke.py` and `poll-smoke.py` require except `CLOUDFLARE_API_TOKEN`
(injected by `op run`) and poll-smoke's hand-relayed `*_TOKEN` invitee links.

**Microsoft letters (`--provider microsoft`, 2026-09-02).** The same script
mints Microsoft identities: `eval "$(bin/mu-smoke-login.py A --provider
microsoft --url $DEV --email-a <ms-account>@outlook.com)"` (dev must
have the Microsoft provider enabled first — see §O "Microsoft smoke on
dev"). Prompts say "Microsoft account" and suggest an
InPrivate window (not the Google chooser); the exported block uses a
**distinct env family**, `MS_<L>_BEARER`/`MS_<L>_REFRESH`/
`MS_<L>_EXPECTED_EMAIL`/`MS_<L>_MINTED_AT` (and `MS_<L>_CLIENT_ID` when
non-default) instead of plain `<L>_*`, so one shell can hold a Google cast
and a Microsoft cast at once — `smoke-runner.py`'s `compose_env` projects
`MS_<L>_*` onto plain `<L>_*` automatically when a run's identity is a
Microsoft letter, but a **direct** (non-runner) invocation of
`multiuser-smoke.py`/`meeting-smoke.py` against a Microsoft identity has to
map the family by hand first, e.g.:

```bash
A_BEARER=$MS_A_BEARER A_REFRESH=$MS_A_REFRESH \
  A_EXPECTED_EMAIL=$MS_A_EXPECTED_EMAIL \
  bin/multiuser-smoke.py --provider microsoft --dry-run
```

`--email-<l>` may be omitted for either provider: `mu-smoke-login.py` then
tries the smoke-runner config first (`[google].<l>` or `[microsoft].<l>`,
per `--provider`) before prompting; `--no-config` skips that lookup.
`INVITEE_A/B_EMAIL` are never emitted under `--provider microsoft` — poll
invitees stay the Gmail smoke mailboxes from `[poll]`, never Microsoft
letters.

## A. Google Cloud setup (one-time, ~15 min)

1. **Create a project** in the [Google Cloud Console](https://console.cloud.google.com/).
2. **Enable APIs:** Calendar API + Gmail API.
3. **Configure OAuth consent screen:**
   - User type: External
   - App name: "Scheduler" (or your choice)
   - User support email + developer contact: your operator email
   - Scopes: Calendar (`.../auth/calendar.events`) + Gmail send (`.../auth/gmail.send`)
   - Test users: add the sandbox Google account you'll authenticate as
4. **Create OAuth client:**
   - Application type: Web application
   - Authorized redirect URI: `https://<subdomain>.<zone>/auth/callback` (run `cd infra && tofu output google_oauth_redirect_uri` after Step B.1 to get the exact value)
5. **Capture credentials:** client ID and client secret. Hold these aside for Step B.3.

> **Note on Testing mode:** while the OAuth consent screen is in "Testing" state,
> refresh tokens issued to your sandbox user expire after 7 days. Acceptable for
> a sandbox run; publish (with verification) before promoting to daily use.

## B. First-time bootstrap (one-time, ~10 min)

1. **Provision Cloudflare resources:**
   ```bash
   cd infra
   cp terraform.tfvars.example terraform.tfvars
   $EDITOR terraform.tfvars     # fill in account_id, zone_id, zone_name, operator_email
   export CLOUDFLARE_API_TOKEN=...  # scope: Account/D1+KV+Workers+Access:Edit, Zone/DNS:Edit
   tofu init
   tofu apply
   ```
   Capture `tofu output -json` for the next step.

2. **Update `worker/wrangler.toml`:**
   - `[[d1_databases]].database_id` ← `d1_database_id` output
   - `[[kv_namespaces]].id` ← `kv_namespace_id` output
   - `[vars].ACCESS_POLICY_AUD` ← `access_application_aud` output
   - `[vars].OAUTH_ISSUER` ← `oauth_issuer` output
   - `[vars].GOOGLE_OAUTH_REDIRECT_URI` ← `google_oauth_redirect_uri` output
   - `[vars].ACCESS_TEAM_DOMAIN` ← copy from Cloudflare Zero Trust dashboard (e.g. `https://<team>.cloudflareaccess.com`); not derivable from TF outputs
   - `[vars].GOOGLE_OAUTH_CLIENT_ID` ← the client ID from Step A.5
   - `[vars].PROVIDER` ← `"google"`
   - `[vars].OPERATOR_EMAIL` ← comma-separated allowlist of Google identities permitted to complete federated login (e.g. `"you@op.example,sandbox@gmail.com"`). The account you log in as in Step B.6 becomes the connected Calendar/Gmail account.

3. **Push secrets:**
   ```bash
   GOOGLE_OAUTH_CLIENT_SECRET=<from-step-A.5> ./bin/bootstrap-secrets.sh
   ```
   (Generates `TOKEN_HASH_PEPPER` and `WEBHOOK_CHANNEL_TOKEN`, pushes Google client secret. Idempotent.)

4. **Deploy:**
   ```bash
   ./bin/deploy.sh
   ```
   Applies D1 migrations, deploys the Worker, tails logs for 30s.

   **Solver deployment is out of scope of this runbook.** See
   `worker/docs/plan-d-deploy.md` for the existing notes; the Worker assumes
   a Worker named `weekly-scheduling-solver` exists (per `[[services]]`
   binding in `worker/wrangler.toml`). Deploy that separately before
   exercising `/v1/resolve`.

5. **Register a PKCE client for programmatic callers:**
   Auth federates to Google now; programmatic callers use the authorization-code
   + PKCE flow (the device-code flow was removed). Register each client's
   redirect URI in the `oauth_clients` table via the helper:
   ```bash
   # CLI/smoke client used by bin/mint-token.py (localhost redirect).
   # Include all scopes the client may be granted — admin grants cross-user
   # /admin/* access; calendar:raw-token grants /v1/calendar-access-token.
   ./bin/register-pkce-client.sh smoke-cli http://localhost:8976/callback \
     --scopes "scheduler:read scheduler:write calendar:raw-token admin"
   # codemode / other programmatic callers: register their real redirect_uri.
   ```
   (Clients are `type='pkce'`; there is no `'device'` client type anymore.)

   **Re-registering an existing client** to add new scopes (e.g. after the
   bearer-auth consolidation) re-runs the same command above — it is
   idempotent. Then re-mint each account's token (§B.6) so the new scopes are
   included in the granted set.

6. **Connect the operator's Google account + mint a token (federated PKCE):**
   ```bash
   ./bin/mint-token.py --url https://<subdomain>.<zone> --client-id smoke-cli
   ```
   - Opens the browser and federates to Google. **Log in as an account listed in
     `OPERATOR_EMAIL`** — for a sandbox run, the Test User you added in Step A.3.
   - On success the worker persists *that account's* Google refresh token in the
     `identity_tokens` table (encrypted with `TOKEN_HASH_PEPPER`) — this is what
     connects Calendar + Gmail — and the script prints `export` lines for
     `SCHEDULER_BEARER` and `SCHEDULER_REFRESH_TOKEN`. Save them (1Password/.env).
   - The federated `/auth/callback` does double duty here: Google consent **and**
     optical token issuance. There is no separate `/auth/google/start` step.
   - The connected account (whoever you logged in as) becomes the active subject;
     `/admin/active-account` reflects it.
   - The scopes granted are bounded by the client's `allowed_scopes` (set in §B.5)
     and the subject's role. For an admin subject with `smoke-cli` registered as
     above, the bearer will carry `scheduler:read scheduler:write calendar:raw-token
     admin`.

7. **Subscribe to Google push notifications** (after Step B.6 connects Google):
   `/admin/webhook/subscribe` is bearer-gated — supply the bearer from Step B.6:
   ```bash
   curl -X POST https://<subdomain>.<zone>/admin/webhook/subscribe \
     -H "authorization: Bearer $SCHEDULER_BEARER"
   ```
   Expect `{"ok":true,"subscribed":true}`. A `calendar_sync` row with a `channel_id` is written.

## C. Smoke test (~5 min, proves the path works)

1. **Seed fixtures:**
   ```bash
   SCHEDULER_URL=https://<subdomain>.<zone> \
   SCHEDULER_BEARER=<from-step-B.6> \
   ./bin/seed.sh
   ```
   Expect 5 tasks + 2 templates POSTed with 201 responses.

2. **Resolve and commit:**
   ```bash
   curl -X POST https://<subdomain>.<zone>/v1/resolve \
     -H "authorization: Bearer $SCHEDULER_BEARER" \
     -H "content-type: application/json" \
     -d '{"window_start":"2026-06-01T00:00","window_end":"2026-06-08T00:00"}'
   ```
   Expect HTTP 200 with `plan_hash` and `schedule[]`. Over-subscription no longer 422s: contended tasks (a blocked hard window, a stale pin, a cap conflict) are dropped and surface in `dropped[]` instead, so a 200 with unexpected `dropped[]` entries — not a 422 — is the signal that fixtures clash with seeded caps; adjust the fixture dates to the current planning window. A 422 with `unsat_core` now means only genuinely contradictory immovable calendar events (e.g. two overlapping external meetings).

   **`must_include` (mandatory tasks).** A task may set `must_include: true` to declare it cannot be dropped, orthogonally to timing-hardness (pin / hard deadline / hard window). Over-subscribing mutually-feasible must-include tasks returns HTTP 422 with `task_present` entries in `unsat_core`. A must-include task that cannot be placed even in isolation (e.g. pinned onto an immovable event) is demoted and reported `dropped` with reason `must_include_unplaceable_in_isolation` rather than failing the plan. The regression-smoke ladder exercises both: **5.1** (droppable over-subscription → 200 + drops) and **5.2** (must-include over-subscription → 422).

3. **Accept the plan.** There's no Access-gated preview page anymore. Either:
   - **From the replan email** (Steps C.5 / cron): click the "Accept this plan"
     link. It opens a confirm page carrying a capability token; click **Accept**
     and the plan commits (`{"ok":true}`). No login required — the capability
     token in the link is the auth.
   - **Programmatically** with your bearer:
     ```bash
     curl -X POST https://<subdomain>.<zone>/v1/plans/<plan_hash>/accept \
       -H "authorization: Bearer $SCHEDULER_BEARER"
     ```
     Expect HTTP 200 `{"ok":true}`.

4. **Verify calendar:** open the sandbox Google Calendar. Yellow events with the new schedule should be present, each carrying `extendedProperties.private.scheduler_chunk_id`.

5. **Simulate an external invite:**
   - In the sandbox Google Calendar, create a new event titled "Lunch with X" overlapping a scheduler-owned event.
   - Within ~10 seconds, expect an email at the operator's address: subject "Scheduler: replan needed for new invite 'Lunch with X'", body with moves/adds/drops, and an "Accept this plan" link (a capability link — no login needed).
   - Click the link → confirm page → Accept, verify Google Calendar updates.

6. **Force the Monday cron without waiting for Sunday 15:00 UTC:**
   ```bash
   curl -X POST "https://<subdomain>.<zone>/admin/run-cron?subject=<email>" \
     -H "authorization: Bearer $SCHEDULER_BEARER"
   ```
   Expect HTTP 200 with `{kind:"ok", planHash:"..."}`. The Monday-morning email is sent only when the new plan differs from the currently-committed plan — if you've just committed in Step C.3 with no other changes, you may see a no-op result.

- `POST /admin/run-cron?subject=<email>` — runs the Monday resolve for **one
  named subject**. The `subject` query param is **required**; a request without
  it returns `400`. (The scheduled Monday cron fans out over all active subjects
  on its own; this route is the single-subject manual trigger.) Bearer auth required
  (`admin` scope).
- `POST /admin/replan-now` — replans the **calling admin's own** calendar (scoped
  to the verified bearer subject). Bearer auth required (`admin` scope).

## D. Regression smoke harness

`bin/regression-smoke.py` runs an ordered ladder of 5 synthetic weeks against the
live deploy (sandbox). See
internal design notes for the
full design.

### Quick start

```bash
export SCHEDULER_URL=https://scheduler.example.com
export SCHEDULER_BEARER=...        # ./bin/mint-token.py (federated PKCE), §B.6
export SCHEDULER_REFRESH_TOKEN=... # same — printed alongside the bearer
export D1_DATABASE_ID=REPLACE_WITH_YOUR_PROD_D1_DATABASE_ID
export EXPECTED_TEST_ACCOUNT=operator.alt@example.com   # the OPERATOR_EMAIL account you minted as

# Dry run (no mutations):
bin/regression-smoke.py --dry-run --levels=2

# Single level:
bin/regression-smoke.py --levels=1

# Full ladder:
bin/regression-smoke.py
```

### Microsoft-provider run (`--provider microsoft`)

The same ladder runs against a Microsoft-provider account (outlook.com or
M365), on dev once the provider is enabled there — see §O for the provider
itself and "Microsoft smoke on dev" for the `[env.dev]` settings.
The harness talks to Graph through `_smoke_lib.GraphCalendarClient`, which
normalises every event into Google wire shape, so no level differs; the only
observable change is done-marking, which switches from colorId `"11"`/`"5"`
to the `"Optical Done"` Outlook category / clear (`SMOKE_DONE_COLOR_ID`
still overrides). Direct-D1 reads (`_d1_read_task`, `DevD1`) target
`wrangler d1 execute DB --env $SMOKE_WRANGLER_ENV`, so point that at the
env whose DB you allow-listed:

```bash
export SCHEDULER_URL=https://scheduler-dev.example.com
export SCHEDULER_BEARER=... SCHEDULER_REFRESH_TOKEN=...   # mint-token.py --provider microsoft --url $SCHEDULER_URL
export D1_DATABASE_ID=REPLACE_WITH_YOUR_DEV_D1_DATABASE_ID # scheduler-dev
export EXPECTED_TEST_ACCOUNT=<the outlook.com account>
export SMOKE_WRANGLER_ENV=dev   # the default; set explicitly to clear a stale value
op run --env-file=.env -- bin/regression-smoke.py --provider microsoft >/tmp/microsoft-regsmoke.log 2>&1
```

Expect the owned-meetings level to report the degrade-to-immovable notice
on a personal (outlook.com) account: Graph `getSchedule` is not available
for consumer mailboxes, so attendee free/busy is unknown by design (§O).

### Reset the sandbox calendar first

The ladder expects a known calendar baseline. `bin/reset-smoke-env.py` wipes the
sandbox calendar and reseeds a synthetic 5-week operator pattern. It refuses to
run unless the active account matches `EXPECTED_TEST_ACCOUNT`. Alongside the
calendar wipe it also sweeps D1 for harness-owned tasks/templates left by any
of the three smoke harness families — regression-smoke's `[regsmoke`-titled
"must_include" tasks + templates, plus its generic tasks (realistic titles,
matched via a `regsmoke-`-tagged `source.external_id` instead); meeting-smoke's
`[mtg-smoke]`-titled rows (both its filler tasks and its imported-meeting
tasks); and multiuser-smoke's `[mu-smoke]`-titled templates plus its
`mu-smoke-`-tagged tasks (their titles are generic, so they're matched by
`source.external_id` instead) — a title/external_id-based catch-all for
anything a crashed or Ctrl-C'd run left behind. This sweep runs as ONE
identity (`/v1/tasks`/`/v1/templates` are owner-scoped): it only clears rows
owned by whichever account `SCHEDULER_BEARER`/`SCHEDULER_REFRESH_TOKEN`/
`EXPECTED_TEST_ACCOUNT` authenticate as, so a multi-account harness
(multiuser-smoke's A, meeting-smoke's A/B/C) needs the script re-run once per
letter, with that letter's tokens, to clear all of its residue.

```bash
# Same SCHEDULER_URL / SCHEDULER_BEARER / EXPECTED_TEST_ACCOUNT as above.

# Preview without mutating:
bin/reset-smoke-env.py --dry-run

# Default: delete every event in [today, today + 1yr), then reseed:
bin/reset-smoke-env.py

# Seed week 1 on a specific Monday:
bin/reset-smoke-env.py --starting-monday 2026-06-01
```

By default it only clears the next year (one `DELETE` per event). Pass
`--clear-all` to instead wipe the **entire** primary calendar before reseeding:
an all-time (`2000`–`2100`) list + per-event `DELETE`. It deletes **all** events
for all time (past, and beyond the 1-year window), and works on the primary
calendar only. (It can't use the one-shot `calendars.clear` API — the scheduler's
Google token carries only the `calendar.events` scope, and `calendars.clear`
requires the broader `calendar` scope, so a wide list+delete achieves the same
intent.) Use it when you want a guaranteed-clean slate and don't care about
history on the sandbox account.

```bash
bin/reset-smoke-env.py --clear-all
```

### Templates support `pinned_tz`

`POST /v1/templates` accepts an optional `pinned_tz` field (IANA zone, e.g.
`"America/New_York"`). If absent, `pinned_time` is interpreted in
`env.SCHEDULER_TZ` (the worker's home zone). Per-template zone is what the
harness uses to verify a "weekly NYC team sync at 09:00 ET" template lands at
the right wall-clock time on both sides of DST.

## E. Webhook async resolve & channel hygiene

### How the Durable Object path works

When Google delivers a calendar push notification to `/webhook`, the worker hands
off to the `ResolveCoordinator` Durable Object (DO) for the affected account.
The DO debounces rapid edits with a **fixed 10-second alarm window**: on the
first delivery it arms an alarm ~10 seconds out, and subsequent deliveries during
that window are coalesced — they do NOT push the alarm back (worst-case latency
stays bounded). While the alarm is pending, the webhook handler returns
`200 {"queued":true}` fast — the resolve itself runs in the DO alarm handler,
entirely off the request path. This means a burst of calendar edits results in a
single resolve pass, not one per event. (If an edit arrives while a resolve is
running, the DO arms a fresh alarm afterward so that change is not lost.)

**Which week gets resolved.** The resolve does NOT re-plan a fixed forward
window. Each changed (human, non-scheduler-owned) event is bucketed into the
**local calendar week it falls in** — Monday 00:00 to the next Monday 00:00 in
`SCHEDULER_TZ` (see `localWeekWindow`). The replan re-resolves exactly that week
(or each distinct week, if a debounced burst spans more than one), so an edit
weeks ahead re-plans the week it touches — not an empty near-term window. The
Monday cron uses the same local-Monday anchoring for the week it fires in. A
deleted event carries no time and so does not trigger a replan (unchanged
behaviour). If a changed week's plan is identical to what's already on the
calendar, that week is a no-op (no email) — `resolve_coordinator_fired` still logs.

> Note: anchoring to the *local* Monday matters. A 09:00 Monday-AEST chunk is
> 23:00Z the prior Sunday; a UTC-Monday window would wrongly exclude it. Weeks
> are committed at local Monday boundaries, so the resolve window must match.

Two key log events mark the lifecycle:

- `resolve_coordinator_scheduled` — emitted when the DO first sets its alarm
  (i.e. the debounce timer starts).
- `resolve_coordinator_fired` — emitted when the alarm fires and the resolve
  actually runs.

These event names use underscores deliberately (not dots) to avoid Cloudflare
log-forwarding mangling, matching the same convention as `resolve_window_shed`.
Filter for them in Workers Observability or `wrangler tail`. The
`--webhook-check` smoke (below) asserts the resolved plan's **window covers the
triggering event**, which is what catches a resolve firing against the wrong week.

### Automatic channel renewal

Google push channels expire after **~7 days, silently** — no error is delivered,
pushes just stop, and webhook replans go dark (this is exactly what happened on
2026-06-10/11 in dev and prod). The daily cleanup cron (`0 4 * * *` UTC) now runs
a renewal sweep (`cron/renew-subscriptions.ts`): for every `calendar_sync` row
that has a `channel_id`, it calls `ensureSubscription`, which re-subscribes when
`channel_expires_at` is within **48 hours** (and is a cheap no-op otherwise). The
48h threshold against a 24h cadence means two consecutive cron failures are
needed before a channel can lapse. Rows without a `channel_id` are skipped — the
sweep keeps existing subscriptions alive but never creates first-time ones;
initial subscription remains an explicit caller-scoped
`POST /admin/webhook/subscribe`.

Each sweep logs a `subscription_renewal` summary (`{checked, renewed, failed}`)
plus a `subscription-renewal failed` line per failing owner; filter for these in
Workers Observability to confirm the sweep is running.

Dev runs the same daily cleanup/renewal cron (its only cron — Monday resolves
stay manual there). For an immediate out-of-band renewal in either env, use the
bearer-gated fan-out endpoint:

```bash
curl -X POST https://<subdomain>.<zone>/admin/renew-subscriptions \
  -H "authorization: Bearer $SCHEDULER_BEARER"
```

Expect `200 {"ok":true,"checked":N,"renewed":M,"failed":0}` (HTTP 500 with the
same shape if any owner failed). Unlike `/admin/webhook/subscribe` this is not
caller-scoped — one call renews every subscribed owner.

**Cookie-free alternative** (no Access JWT needed — only the wrangler API
token): a remote preview session runs the real cron dispatch against the real
remote bindings (live D1 + deployed secrets), so the sweep executes for real:

```bash
cd worker
op run --env-file=../.env -- npx wrangler dev --env dev --remote --test-scheduled
# in another shell (drop --env dev and use the prod worker for prod):
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
```

This fires the whole `0 4 * * *` branch (cleanup + retention sweep + renewal),
all idempotent. A `stopChannel failed … stopChannelCallerNotOwner` warning is
expected best-effort noise when rotating a channel created by a different
session; the renewal itself still succeeds. Confirm via the
`subscription_renewal` summary line and a ~7-days-out `channel_expires_at`.
Google sends an initial `resourceState=sync` push to the new channel — seeing
that `POST /v1/webhook/google-calendar` return 200 in Workers Observability
proves end-to-end delivery.

### Clearing a stale push channel

A push channel becomes stale if the worker was redeployed with a new
`WEBHOOK_CHANNEL_TOKEN` secret, or if the Google subscription lapsed and
`/admin/webhook/subscribe` was called again without stopping the old one first.
To clear a stale channel immediately without waiting for Google's 7-day expiry:

```bash
curl -X POST "https://<subdomain>.<zone>/admin/stop-channel?channel_id=<channel_id>" \
  -H "authorization: Bearer $SCHEDULER_BEARER"
```

Only `channel_id` is required; it is stored in the `calendar_sync` row —
retrieve it via the Cloudflare D1 console or `wrangler d1 execute`. When
`resource_id` is omitted the route falls back to the row's stored
`channel_resource_id`, which is correct for both providers: Google rows store
the real resource id, and Microsoft rows store `""` because Graph
subscriptions have no resourceId concept (the Microsoft provider ignores the
argument). Pass `resource_id=<...>` explicitly only to override the stored
value (e.g. a Google channel whose row was already deleted-and-recreated).
This endpoint requires a bearer token with the `admin` scope.

After stopping the stale channel, re-subscribe:

```bash
curl -X POST https://<subdomain>.<zone>/admin/webhook/subscribe \
  -H "authorization: Bearer $SCHEDULER_BEARER"
```

### Accept-exact-hash behaviour

The "Accept this plan" capability link commits **exactly the plan hash in the
path** (owner-scoped) — it never silently substitutes a different plan for the
same week, even a newer one. See "Pending plans are per-week (week-scoped
supersede)" below for what happens when a second replan supersedes that hash
before the user clicks Accept.

### Async webhook smoke check

To verify the full async path **including the diff/email render** (Google push →
webhook → DO debounce → resolve → diff → `render_snapshot` + email), run:

```bash
op run -- uv run bin/regression-smoke.py --webhook-check > /tmp/webhook-check.log 2>&1
```

The check is **self-contained**: it picks a blank week, seeds its own pending
tasks there, resolves once to establish a baseline plan (no `render_snapshot` —
`/v1/resolve` does not render), then creates a **conflicting calendar event** so
Google delivers a webhook. The debounced replan re-resolves that week, schedules
the tasks (a non-empty diff vs the empty-calendar baseline), persists
`render_snapshot`, and sends the email. It polls
`GET /admin/latest-plan?covers=<event-instant>` — which deterministically returns
the plan for the **week containing the event**, immune to unrelated background
resolves becoming "latest" — until that plan carries a `render_snapshot`, then
validates the model. A non-null snapshot is the proof the diff/email path ran; an
**empty** week would yield a `no_diff` plan with no snapshot and **no email**, so
the snapshot is the test. Allow up to ~120 s (Google delivery + ~10 s debounce +
resolve). Success prints `webhook-check OK: replanned plan <hash> … with a
render_snapshot`.

It cleans up **only its own** artifacts via targeted deletes (the seeded tasks
by id, the event, and the baseline + replanned plan hashes via
`DELETE /v1/plans/<hash>`) — no blanket table clears.

As with all harness runs: redirect output to a file (unsat_core dumps overflow
terminal buffers), and inject secrets via `op run --` rather than hardcoding
them. The same env vars as the full ladder are required
(`SCHEDULER_URL`, `SCHEDULER_BEARER`, `SCHEDULER_REFRESH_TOKEN`,
`D1_DATABASE_ID`, `EXPECTED_TEST_ACCOUNT`).

### Replan email visual and accept confirm page

**Before → after calendar visual (facts only).** Replan emails contain a
before→after agenda view rendered by `worker/src/diff/render-diff-calendar.ts`
(`renderDiffCalendarHtml` / `renderDiffPlaintext`). The visual is built from a
pure `ReplanEmailModel` (`worker/src/diff/email-model.ts`,
`buildReplanEmailModel`) that contains **facts only** — the diff, prior
scheduler events, the proposed schedule, external calendar events, and dropped
tasks — grouped by local calendar day. It carries no inferred solver reasoning.
Entry roles: `moved-from`, `moved-to`, `added`, `removed`, `existing`,
`new-clash`. On the webhook path, the triggering invite is classified
`new-clash` (via `triggerEventIds`). The same rendering fragment is reused by
both the email and the web accept page.

**Provider → `DiffEmailRenderer` seam.** `NotificationProvider` now takes the
pure model plus `{acceptUrl, planHash}`:

```ts
sendReplanNotification(to: string, model: ReplanEmailModel, opts: RenderOpts): Promise<void>
```

`GmailNotificationProvider` owns a `DiffEmailRenderer` (defaults to
`GmailDiffRenderer`, `worker/src/diff/gmail-diff-renderer.ts`) that wraps the
shared fragment in an email-doc shell, adds the Accept CTA, and computes the
subject line. The `DiffEmailRenderer` interface (`worker/src/diff/diff-email-renderer.ts`)
is the extension point for a future Outlook renderer: swap in a different
implementation without touching the email model or notification provider.

**`render_snapshot` stored outside `body`.** Migration
`worker/migrations/0012_proposed_plan_render_snapshot.sql` adds a
`render_snapshot TEXT` column to `proposed_plans`. After building the model,
both the webhook path and the Monday-cron path call `attachRenderSnapshot` to
persist the `ReplanEmailModel` JSON in this column. Because it is separate from
`body`, the `computePlanHash(body)` function — the plan identity — is
**unaffected**: presentation changes never alter the plan hash.

**Styled accept confirm page.** `GET /v1/plans/:plan_hash/accept?t=<cap>`
renders a styled HTML confirm page (`worker/src/web/accept-page.ts`,
`renderConfirmPage`) with a per-week selector (`weekTabs`) across every pending
plan for the subject. It preselects the week the token identifies: `?ws=`/`&we=`
query params → the capability token's `window` claim → the emailed hash's own
window → newest (only when the request expresses no window at all). If the
plan for the selected week differs from the plan that was current when the
token was minted (`plan.plan_hash !== claims.planHash`), a **staleness banner**
is shown: "Your calendar changed after that email was sent — this is the
up-to-date plan for this week." If the emailed week has nothing pending, the
page says so explicitly — "Plan already accepted" (the row's `committed_at` is
set) or "That week is up to date" (superseded by a later no-diff resolve) —
rather than silently switching to a different week. The form POSTs `t` (and the
selected week's `plan_hash` in the path) to that week's accept URL.

**Accept-superseded pending plans are filtered out (2026-08-12).** A pending
plan is dropped from the week tabs, the confirm page, and the "other weeks"
list whenever its `created_at` predates that same local calendar week's latest
`committed_at` — its diff was computed against pre-accept state (a resolve
racing an accept on another surface, e.g. MCP or another browser tab), so
offering it back would invite re-applying an outdated proposal. The affected
week instead renders the "Plan already accepted" notice. A pending plan created
*after* the week's last accept is a fresh re-resolve and still shows normally.
See `withoutAcceptSuperseded` / `latestAcceptByWeek` in
`worker/src/planning/accept.ts`.

**Content negotiation on `POST /v1/plans/:plan_hash/accept`.** A browser form
submit (capability token in form body, `Content-Type:
application/x-www-form-urlencoded`) returns a styled HTML result page
(accepted / superseded / caught-up / error). Bearer-token callers and callers
that send `Accept: application/json` always receive the JSON contract:
`{"ok":true}` (200, idempotent on an already-committed hash), `{"error":
"plan_superseded", "latest_plan_hash"?: string}` (409 — the path hash was
superseded by a newer resolve for that week; `latest_plan_hash` is present only
when the week is identifiable via `ws`/`we` or the token's window claim and
still has a pending plan), `{"error":"invalid_token"}` (401), or `{"error":
"plan_expired"}` (410). The HTML flow degrades a 409 with no identifiable
replacement to a friendly 200 "you're all caught up" page rather than a bare
error — the JSON caller still gets the 409. The admin `POST /admin/replan-now`
response includes the structured `model` (the `ReplanEmailModel`) for any
`replanned` result — whether dry-run or actually sent — so an admin can inspect
what was, or would be, sent.

**Pending plans are per-week (week-scoped supersede).** `proposed_plans`
carries `window_start`/`window_end` (migration 0027). Plan identity for
supersede, accept-page grouping, tab labels, and link-window matching is the
**local calendar week** — the [Mon 00:00, next Mon) week in `SCHEDULER_TZ`
containing `window_start` (`localWeekWindow`) — NOT the exact (start,end) pair.
A mid-week replan legitimately narrows `window_start` to "now" (the solver must
not place into the past), so the same week can carry differently-anchored
windows; exact-pair identity left the Monday-anchored sibling pending and the
accept page showed the same week twice ("Week of Mon 27 July" and "Week of Wed
29 July", 2026-07-30 incident). Every resolve, right after inserting its plan,
hard-deletes all OTHER pending plans for the same (subject, week) — so at most
one pending plan exists per week. A window spanning several weeks buckets by
its start week only. Committed rows are never touched. A no-diff resolve still
supersedes first, then deletes its own row: an empty diff means the calendar
already matches baseline, so the week ends with zero pending plans (intended).

The accept page (`GET /v1/plans/{hash}/accept?t=…`) lists ALL pending weeks as
selector tabs — one per calendar week, labelled "Week of <Monday>", newest plan
winning within a week — and preselects the week the email was about:
`?ws=`/`&we=` params → the capability token's `window` claim → the emailed
hash's window → newest. The `ws` value is matched by its calendar week, so a
Monday-anchored link still finds a mid-week-anchored replacement plan. If the
emailed week has nothing pending it says so ("already accepted" vs "no longer
needed") rather than silently showing another week. The accepted page's "you
also have proposed changes" list likewise excludes any leftover sibling window
of the week just accepted.

`POST /v1/plans/{plan_hash}/accept` commits EXACTLY the hash in the path
(owner-scoped). If that hash was superseded meanwhile, nothing is committed:
JSON gets 409 `plan_superseded` (+ `latest_plan_hash` when the week is
identifiable and has a current plan); the HTML form flow re-renders the new
plan with a banner for re-confirmation. This replaced the old "path is
informational, commit latest for subject" behaviour — API clients must accept
the hash they fetched.

**Smoke asserts the model, not the confirm-page HTML.** The `--webhook-check`
smoke asserts the rendering pipeline ran by reading `render_snapshot` from
`GET /admin/latest-plan` and checking the persisted `ReplanEmailModel` is
well-formed: `days` present, entries carry resolved titles, `trigger.kind ==
"webhook"`, and at least one diff role present. It does **not** fetch or render
the confirm-page HTML — it cannot forge a capability token — so the assertion
is model-level only, via the admin endpoint.

**Empty diff — no email sent.** When a resolve produces an empty diff (the proposed plan matches what's already on the calendar), both the webhook path and the Monday-cron path short-circuit and send **no** email — there is currently no "weekly plan unchanged" notification. Note that the renderer does support an empty/"No changes this week" visual (and the `GmailDiffRenderer` produces an "unchanged" subject) as a latent capability if that path is enabled in future.

**Dropped tasks don't, on their own, defeat the no-op gate (2026-07-07 fix).** The diff's emptiness (`computePlanDiff.isEmpty`) counts moves/adds/removes plus only **newly** dropped tasks — a task dropped now but *not* dropped in the **last accepted plan for that calendar week**. A persistently-unfittable task (e.g. a recurring "Lunch" that never fits, `drop_was_cheaper_than_alternatives`) that was already dropped in the last accepted plan and is still dropped is **not** a change, so an unrelated calendar edit no longer re-emails an identical BEFORE/AFTER plan. A drop that genuinely matters — a previously *scheduled* task now dropped — still fires the email because it surfaces as a `removed` calendar event through the normal path. The drop baseline comes from `getCommittedDroppedForWeek` (the newest committed plan whose window falls in the same local calendar week — week identity, not the exact window pair, for the same reason as week-scoped supersede: a mid-week replan narrows `window_start` to "now" and would otherwise miss the Mon-anchored committed baseline and re-email the week's old drops); when the user has never accepted a plan for that week, every drop is treated as new (it emails). The full dropped list is still shown in the email's "Couldn't fit this week" section when the email *does* fire.

## F. Window-relative task shedding

A `/v1/resolve` only considers tasks that *belong* to the window it resolves.
A task is **shed** (excluded from the solver input for that resolve) when:

- its **positional anchor** falls outside the window — the anchor is the first
  of `pinned_at`, then the system-owned `scheduled_for` stamp (set at commit to
  the earliest committed chunk start), then, **only for recurring occurrences**
  (`template_id` set), `earliest_start`; or
- it has **no** positional anchor but a `deadline.at` strictly before the
  window start (overdue, soft or hard); or
- it has **no** positional anchor, **no** `deadline.at` at all, and the window
  has not started yet (`windowStart > now`) — pure backlog does not
  automatically populate a future week. It is kept only if its `earliest_start`
  floor is at/after the window start, an explicit claim on that week (a
  deadline at/after the window start also keeps it — work-ahead — since that
  case fails the "no deadline at all" test above). Added 2026-08-12 after a
  webhook replan of a week four weeks out (triggered by a new invite landing
  there) captured the unanchored backlog task "Gym"; accepting that plan
  stamped `scheduled_for` into the future week, which then excluded the task
  from every current-week resolve (silently exported to mid-September — an
  older task had been ratcheted to October the same way). See
  `taskBelongsInWindow` in `worker/src/planning/task-window.ts`.

Shedding is stateless and read-time: it never changes a task's status and never
deletes anything. Shed tasks still appear in `GET /v1/tasks`. To pull a slipped
task into a current or future week, **PATCH any timing field** (e.g. set
`earliest_start` to the target week) — that clears the placement stamp so the
task re-enters the backlog. Each resolve emits one `console.info`
entry — message `resolve_window_shed` with a structured payload
`{ excluded_past: N, kept: M }` — visible via `wrangler tail` or Workers observability.
Grep for the `resolve_window_shed` message (non-dotted so Cloudflare logfwd does not
mangle the fingerprint); the counts live in the payload, not concatenated into the
message string.

`scheduled_for` is system-owned: it is never accepted on create/patch and never
echoed in the task schema. It has exactly four writers: commit stamps it for
every task in the committed schedule, commit clears it (status → 'pending') for
every task in the plan's dropped list, a PATCH touching any timing field
(pinned_at, earliest_start, preferred_windows, deadline) clears it, and the
webhook's manual-move write-back re-stamps it (with `updated_at`) to the
hand-dragged position.

When you drag a scheduler block to a new time, the assistant treats the new
position as authoritative and keeps it there:

- The committed plan the chunk belongs to is updated so the next replan does
  not try to move it back — this works even if you have already committed a
  later week.
- If you drag a block earlier than its "don't start before" time, that floor is
  lowered to the new position (it is not discarded — the task simply won't drift
  earlier than where you put it).
- If the block was pinned, the pin moves with it.

Dragging a block whose task you have already marked done leaves the task done;
only the plan record catches up to the calendar.

## G. Solver configuration

### Soft preferred-window weights

`config_weights` carries two weights controlling how soft `preferred_windows`
bias placement:

- `preferred_day_miss` (default 40) — penalty per day-of-week a chunk lands
  off the nearest preferred day.
- `preferred_time_miss_per_15min` (default 5) — penalty per 15 minutes the
  chunk falls outside the window's `[start, end)`.

These two, and the other four global soft weights, plus every context's fit
curve and caps/penalties, are now per-user customisable — see §N for the
read/write API, precedence rules, and snapshot semantics. The defaults named
here are the instance `'__default__'` values a user tracks until they
customise.

Business hours is a **hard** placement floor: a task with only soft windows is
confined to business hours (it lands in-hours or drops — never out of hours).
Only a pin or a **hard** preferred window opts a task out of business hours.
A soft-window miss never causes a drop (it is a pass-2 placement bias only).

### Solver call resilience and container logs

The solver runs as a Cloudflare **container Durable Object** (`weekly-scheduling-solver`,
`SolverContainer`, port 8080). `solver/cf-worker.ts` routes every `/solve` to a
single container via `getContainer(env.SOLVER_CONTAINER)` (no name = one shared
instance, so `max_instances` does not fan out), and the container idle-stops after
`sleepAfter`. The solver has **no public route** (`workers_dev = false` in
`solver/wrangler.toml`): `cf-worker.ts` forwards every request to the container
with no auth, so the default `*.workers.dev` URL would let anyone occupy the
solver. The scheduling worker reaches it via the `SOLVER` service binding, which
needs no route. For ad-hoc `/solve` testing run the solver locally
(`uv run uvicorn solver.server:app`) or go through the dev worker. A cold/restarting container can be briefly unready (~30s boot), and a
request landing in that window would otherwise hang until the caller's read timeout.

The worker therefore bounds each solve: `runResolve` wraps `env.SOLVER.fetch` with a
per-attempt `AbortController` timeout (`SOLVER_TIMEOUT_MS`, default 45s, overridable
via the `SOLVER_TIMEOUT_MS` var) and retries once (`SOLVER_MAX_ATTEMPTS`). `/solve`
is a pure function, so retries are safe. A **2xx/4xx** response
(including 422 unsat) is definitive and returned immediately; a **5xx** means
the container is unready (cold boot / restart) or crashed mid-request, so the
worker retries it (up to `SOLVER_MAX_ATTEMPTS`) and only surfaces the final 5xx.
If a 5xx persists across all attempts, `runResolve` returns `solver_error` with
that status → the route answers **502**. If every attempt instead *times out*
(no HTTP response at all), `runResolve` returns `solver_error` **504**. Either
way the client gets a clean, retriable failure instead of a hang. The smoke
harness `read` timeout (120s) is set above the worker's worst-case 2-attempt
budget so a 502/504 surfaces rather than a client-side `ReadTimeout`.

**Solver timing observability.** Three permanent log events (JSON embedded in
the message text — the log pipeline drops structured `console.*` arguments, see
`worker/src/log.ts`) cover the full solve path:

- `solver_fetch` (worker, one line **per attempt**): `{attempt, ms, status |
  error, solver_uptime_ms}`. `ms` is that attempt's wall time; `error` appears
  instead of `status` when the attempt aborted (timeout) or failed transport.
  `solver_uptime_ms` echoes the container's `X-Solver-Uptime-Ms` response header
  (process age at request receipt): a **small value means the request paid a
  cold start**, so cold vs warm latency separates without container-side hooks.
- `solver_diagnostics` (worker, on each successful solve):
  `{pass1_wall_seconds, pass2_wall_seconds, status, round_trip_ms, trigger,
  attempts, solver_uptime_ms, engine, n_tasks, n_chunks, n_external,
  n_dropped}`. `engine` is `"container"` or `"worker"` — which solver
  produced the **served** answer (§P). On an engine-served line `attempts`
  and `solver_uptime_ms` are `null` (there was no HTTP call), `round_trip_ms`
  is the engine's own wall, and two extra fields may appear — `bound_gap` and
  `nodes`; the container emits neither.
  `round_trip_ms` is worker-side wall time across all attempts up to response
  headers; `trigger` is who initiated the solve (`api` = `/v1/resolve`,
  `webhook` = calendar-change replan, `cron` = Monday resolve), `attempts`
  how many `solver_fetch` attempts it took, and the `n_*` fields the size of
  the problem actually sent (tasks/chunks after completed chunks and frozen
  meetings are stripped, busy blocks, and tasks the solver dropped); the pass fields are the solver's own two-pass split — pass 1 finds
  the candidate schedule, pass 2 proves optimality. `status: "OPTIMAL"` means
  the proof completed; `"FEASIBLE"` means pass 2 was **abandoned** by the
  stall/time limit (`SOLVER_STALL_LIMIT_S`, default 5s of no improvement, or
  the 20s hard cap); `"PASS1_FALLBACK"` means pass 2 failed and the pass-1
  candidate was returned.
- `solve_timing` (container, one line per `/solve`): `{outcome: "ok"|"unsat",
  total_ms, pass1_wall_seconds?, pass2_wall_seconds?, status?}` — the
  server-side total (JSON parse + validation + solve), so `round_trip_ms −
  total_ms` ≈ transport + container-boot overhead. The unsat path carries only
  `outcome` + `total_ms` (no pass diagnostics exist for it).

Filter any of these names in Workers Observability or `wrangler tail` (worker
events on `weekly-scheduling-assistant`, `solve_timing` on
`weekly-scheduling-solver`).

**`solver_calls` table (migration 0038).** Logs expire after 7 days, so
`runResolve` also persists one row per solve it gets an HTTP answer for —
success *and* 422 (`status='UNSAT'`, pass/`n_dropped` fields NULL) — into
D1 `solver_calls` (`id, at, owner, trigger, window_start, attempts,
http_status, round_trip_ms, solver_uptime_ms, pass1_ms, pass2_ms, status,
n_tasks, n_chunks, n_external, n_dropped, source, engine`), the same fields
as the extended `solver_diagnostics` line plus the owner and window.
`engine` (migration 0039) names who produced the **served** answer —
`'container'` or `'worker'`, NULL on pre-0039 and backfilled rows, read NULL
as `'container'`. See §P. No row is
written when every attempt timed out or failed transport (there is no
status to record; the `solver_fetch` error lines are the only trace). The
insert is best-effort: a failure logs `solver_calls insert failed: …` at
error level and the resolve continues. `source` is `'live'` for these rows;
`'logs'` is reserved for rows loaded from `bin/solver-usage-backfill.py`
output. Each env's worker writes to its own D1 (prod `scheduler`, dev
`scheduler-dev`, and so on for any other env), so the cross-env demand view
that the cost model needs (§G, "Container usage and cost model") is still
the union of them all — the backfill CSV remains the all-env snapshot until the snapshot
scripts read `solver_calls` from each D1.

**Problem capture (`SOLVER_CAPTURE_PROBLEMS`).** Gated by
`SOLVER_CAPTURE_PROBLEMS` (default unset/"false"); when not "true", zero R2
calls. When on, `runResolve` generates `callId` up front and — **before**
calling the solver, so 422s and solver errors are captured too — puts the
`Problem` JSON to the shared, account-level bucket `optical-solver-capture`
at the flat key `problems/<callId>.json`, then reuses that same `callId` as
the `solver_calls.id` row above, so every capture joins to its recorded
outcome. The stored object is an envelope `{env, call_id, captured_at,
problem}`: `env` comes from a new `DEPLOY_ENV` var set explicitly per env
block (the worker has no other way to know which deployment it is) — a
missing `DEPLOY_ENV` stamps `env: "unknown"` rather than skipping the
capture, and `"unknown"` turning up in a pull is itself the config-drift
alarm. The put is best-effort, same stance as the `solver_calls` insert: a
failure logs `solver_capture put failed: …` and never blocks the resolve.
A deployment whose users haven't opted in to collection gets **no**
`SOLVER_CAPTURE` binding and pins `SOLVER_CAPTURE_PROBLEMS = "false"`
explicitly; the write path needs the flag AND the binding (and tolerates
the binding being absent), so there's no accidental way to turn capture on
there. Orphan case: four ways
a solve can leave no `solver_calls` row to join against — every attempt
timed out or failed transport (no HTTP answer at all), a persistent 5xx
that survives all retries, a non-422 4xx (the `solver_error` branch), or a
2xx whose body fails to parse (throws after the capture, before the
insert) — and each still leaves the capture sitting in the bucket, reachable via
bucket list if ever needed, but out of scope for the puller below.


Pull a corpus with `bin/solver-capture-pull.py --env dev|prod` (date range
args; only envs that capture): reads `solver_calls` from that env's D1
over the range, downloads each `problems/<id>.json` via `npx wrangler r2
object get`, asserts the payload's `env` agrees with the D1 source (a
mismatch aborts that pull before the manifest merge — drift is an alarm
state, not something to paper over), and writes
`analysis/corpus/<env>/<at>-<id>.json` (filename uses the D1 `at`
timestamp, not the envelope's own `captured_at`, which differs by one
solver round-trip — `id` is the join key either way) plus
`analysis/corpus/manifest.csv` (id, at, env, trigger, status, n_tasks,
n_chunks, round_trip_ms). Only the per-env payload subdirectories are
gitignored (problem payloads carry event titles); the manifest itself is
committed — no titles, no owner column — and is the shareable index.

**Container logs** are forwarded to Workers Logs (dashboard log stream + `wrangler
tail`) purely because `solver/wrangler.toml` has `[observability] enabled = true` —
this is *not* a Dockerfile setting (the Dockerfile only needs `PYTHONUNBUFFERED=1`,
already set). The app logs a `solver server ready` line on boot and `shutting down`
on a graceful stop: a stop with **no** shutdown line indicates a hard VM kill
(OOM/segfault/platform), which by nature leaves no application log — the dashboard's
container metrics and the `VMStopped` event are the only signal for that class. If the
container is wedged (repeated `VMStopped`, `Error checking 8080: not listening`),
redeploy the solver (`cd solver && wrangler deploy`) to get a fresh VM.

### Container usage and cost model

The solver container is **one service shared by every env's worker**
(`[[services]] service = "weekly-scheduling-solver"` in every env), so its
uptime — and its bill — is driven by all of them. Cost is memory
allocation × uptime (12 GiB today); vCPU is billed on CPU time actually used,
disk on allocation.
Prices and allowances are encoded in `bin/container-cost.py`.

Scripts (all read-only; need `Workers Observability: Read` and `Account
Analytics: Read` on the deploy token — `infra/create-api-token.sh` has them):

```bash
op run --env-file=.env -- bin/solver-usage-backfill.py   # solver calls -> analysis/solver-calls.csv
op run --env-file=.env -- bin/container-usage.py         # billed usage  -> analysis/container-usage.csv
bin/container-cost.py reconcile analysis/fixtures/reconcile-YYYY-MM.json
bin/container-backtest.py                                # (memory, sleepAfter) grid -> analysis/backtest.csv
bin/container-cost.py quote --memory-gib 1 --hours-per-day 10
```

Run the first two at least weekly: Workers Logs keep 7 days and the
analytics dataset keeps 4w4d, and both scripts merge into the CSVs (which
are committed — they are the all-env durable dataset; the `solver_calls` D1
table (migration 0038, one row per solve, per env's own D1) now accumulates
the same fields live, but `bin/solver-usage-backfill.py` still reads Workers
Logs and the cost/backtest scripts still read the CSVs — see
internal design notes). Each new
invoice gets an `analysis/fixtures/reconcile-YYYY-MM.json` (quantities from
the PDF's Container lines) and `bin/test_container_cost.py` asserts the
usage pull reconciles to it within 5 %.

Gotchas: the telemetry `events` view silently truncates multi-day windows
(pull in ≤ 6 h slices — the script does); a webhook alarm runs several
solves under one requestId; fetch and diagnostics lines share a millisecond.

**Engine-served solves cost the container nothing.** Once `SOLVER_ENGINE` is
`"fallback"` or `"worker"` somewhere (§P), `solver_calls.engine = 'worker'`
is exactly the set of solves with no request, no uptime and no vCPU behind
them. Two tooling gaps to close before that shows up honestly in the cost
model: `bin/solver-usage-backfill.py` counts `solver_fetch` log lines, which
an engine-served solve never emits, so those solves are silently omitted from
`analysis/solver-calls.csv`; and `bin/solver-capture-pull.py`'s `D1_COLUMNS`
lacks `engine`, so a capture manifest can't split engine-served from
container-served problems.



## H. Plan 1 cutover: owner_subject backfill (prod)

Legacy rows have `owner_subject = NULL` and are invisible to the scoped repository once Plan 1 is deployed. Before enabling Plan 1 in prod, assign all existing rows to the single real owner. **Downtime is acceptable.** Ownership must be **verified, not assumed** — confirm the owner identity before any `UPDATE`.

> **Deployment gate reminder:** even after this backfill, do **not** authorise a 2nd org user in prod. A 2nd user is safe only once Plans 2–4 (resolve/cron scoping, webhook routing, identity/membership/offboarding/audit) are merged — see spec §8.4. Plan 1 in prod with a single user is a no-op behaviourally (all rows owned by `<OWNER>`), which is the point: it lands the schema + scoped paths safely ahead of the rest.

### Step 1: Inspect prod ownership (read-only) before any write

`owner_subject` does **not exist** until migration 0013 (Step 2) adds it, so a
pre-apply `WHERE owner_subject IS NULL` query errors (`no such column`). Before
apply you can only confirm the operator identity and the *total* row counts; the
NULL-owner counts are taken **after** apply, in Step 2.

```bash
# Authorised read-only prod query (creds via op).
# Confirm the operator identity — prod may have more than one connected account
# (e.g. a sandbox gmail alongside the real OPERATOR_EMAIL), so do not assume one:
op run --env-file=.env -- npx wrangler d1 execute scheduler --remote --json \
  --command "SELECT account_email owner, COUNT(*) n FROM identity_tokens GROUP BY account_email"
# Total rows that will need an owner (owner_subject column not present yet):
op run --env-file=.env -- npx wrangler d1 execute scheduler --remote --json \
  --command "SELECT (SELECT COUNT(*) FROM tasks) tasks, (SELECT COUNT(*) FROM task_templates) task_templates, (SELECT COUNT(*) FROM projects) projects"
```

Expected: confirm which `account_email` is the intended owner. If more than one is
connected, decide explicitly which `<OWNER>` the legacy rows belong to — **verify,
do not assume the first**. Record `<OWNER>` and the total counts; every existing
row becomes NULL-owner the instant 0013 adds the column, so these totals are what
Step 3 backfills.

### Step 2: Apply pending migrations to prod

`wrangler d1 migrations apply` applies **every** pending migration in order, not
just 0013 — there is no "apply up to N". If prod is at 0012, this single command
applies the whole 0013–0019 range (owner_subject, calendar_sync per-user, users,
audit_log, per-user config, home_tz, done_color_id) at once — i.e. the full
Plans 1–4 + done-color schema cutover, not an isolated Plan-1 step. List the
pending set first so there are no surprises:

```bash
cd worker && op run --env-file=../.env -- npx wrangler d1 migrations list scheduler --remote
cd worker && op run --env-file=../.env -- npx wrangler d1 migrations apply scheduler --remote
```

Expected: every migration in the pending list reports ✅.

Now that `owner_subject` exists, record the NULL-owner counts Step 3 will backfill
(they equal the totals from Step 1):

```bash
cd worker && op run --env-file=../.env -- npx wrangler d1 execute scheduler --remote --json \
  --command "SELECT (SELECT COUNT(*) FROM tasks WHERE owner_subject IS NULL) tasks_null, (SELECT COUNT(*) FROM task_templates WHERE owner_subject IS NULL) task_templates_null, (SELECT COUNT(*) FROM projects WHERE owner_subject IS NULL) projects_null"
```

### Step 3: Backfill the verified owner (downtime window)

```bash
cd worker && op run --env-file=../.env -- npx wrangler d1 execute scheduler --remote \
  --command "UPDATE tasks SET owner_subject='<OWNER>' WHERE owner_subject IS NULL"
cd worker && op run --env-file=../.env -- npx wrangler d1 execute scheduler --remote \
  --command "UPDATE task_templates SET owner_subject='<OWNER>' WHERE owner_subject IS NULL"
cd worker && op run --env-file=../.env -- npx wrangler d1 execute scheduler --remote \
  --command "UPDATE projects SET owner_subject='<OWNER>' WHERE owner_subject IS NULL"
```

Expected: each command's reported rows-changed matches the pre-count recorded in Step 1 for that table. Re-run the Step-1 NULL counts for all three tables → 0.

## Plan 3 cutover: calendar_sync re-key + per-user re-subscribe

Migration `0014_calendar_sync_per_user.sql` re-keys `calendar_sync` on
`(owner_subject, calendar_id)` and adds a UNIQUE index on `channel_id`. It does
**not** carry the legacy single `'primary'` row over — in pure SQL we cannot
know which owner it belonged to. The row is re-created by a verified per-user
re-subscribe below. A brief window with no live push channel between apply and
re-subscribe is acceptable (the Monday cron is a backstop; stale Google channels
self-expire in ~7 days).

> Replace `<OWNER>` with the verified operator email. **Verify before assuming**
> which owner is connected — run the read-only check first.

1. Confirm the connected identity (read-only):

   ```sh
   op run --env-file=.env -- npx wrangler d1 execute scheduler --remote \
     --command "SELECT account_email FROM identity_tokens ORDER BY updated_at DESC;"
   ```

   Note the operator email; use it as `<OWNER>` below. `account_email` in
   `identity_tokens` (set at OAuth connect) and `owner_subject` in `calendar_sync`
   hold the same email string for a given user, but `owner_subject` is now written
   from the **authenticated caller** — the bearer subject resolved by
   `requireCaller` — not from a global "active subject". So the re-subscribe in
   step 4 binds the new row to **whoever's bearer you present**: authenticate
   as the owner whose calendar you are recreating. If several identities are
   connected (prod currently has more than one), run step 4 once per owner,
   minting a separate bearer for each account first.

2. Apply migration 0014 (downtime OK — the old `'primary'` row is dropped):

   ```sh
   cd worker && op run --env-file=../.env -- npx wrangler d1 migrations apply scheduler --remote
   ```

3. Confirm the table re-keyed (composite PK, empty after rebuild):

   ```sh
   op run --env-file=.env -- npx wrangler d1 execute scheduler --remote \
     --command "SELECT owner_subject, calendar_id, channel_id FROM calendar_sync;"
   ```

   Expect zero rows immediately after apply.

4. Re-subscribe the operator's primary calendar (recreates the per-user channel
   row). `POST /admin/webhook/subscribe` is **caller-scoped**: it subscribes the
   primary calendar of the **authenticated caller** (the bearer subject, via
   `requireCaller`) and builds the Google watch with that owner's token. Supply
   the bearer for `<OWNER>` — the new `calendar_sync` row is keyed to exactly
   that caller:

   ```sh
   curl -X POST https://<your-worker-host>/admin/webhook/subscribe \
     -H "authorization: Bearer $SCHEDULER_BEARER"
   ```

   Expect `{ "ok": true, "subscribed": true }`.

5. Confirm a per-user row now exists with a fresh channel:

   ```sh
   op run --env-file=.env -- npx wrangler d1 execute scheduler --remote \
     --command "SELECT owner_subject, channel_id, channel_expires_at FROM calendar_sync WHERE owner_subject = '<OWNER>';"
   ```

   Expect one row owned by `<OWNER>` with a non-null `channel_id`.

6. (Optional) Stop any stale pre-cutover Google channel still delivering. If you
   captured the old `channel_id`/`resource_id` before apply, use the one-shot:

   ```sh
   curl -X POST "https://<your-worker-host>/admin/stop-channel?channel_id=<OLD_CHANNEL_ID>&resource_id=<OLD_RESOURCE_ID>" \
     -H "authorization: Bearer $SCHEDULER_BEARER"
   ```

   If you did not capture them, no action is needed — Google expires stale push
   channels in ~7 days, and pushes on a channel with no matching `calendar_sync`
   row now return 401 (`channel_token_mismatch`) and are ignored.

**Plan 4 note:** automatic per-user fan-out (subscribe-on-onboard for every
connected identity) is deferred to Plan 4. Plan 3 only makes the subscribe
primitive per-user-correct (caller-scoped). Until fan-out lands, restore routing
by running step 4 manually once per connected owner — authenticate as each in
turn. In a single-operator deployment that is a single call.

## Recurring tasks (templates & occurrence sweep)

Recurring tasks are authored as templates (`POST /v1/templates`) and materialised
into concrete task rows by the recurrence sweep, which runs as part of each
`/v1/resolve`. The sweep is occurrence-keyed: each materialised task carries the
date of the occurrence it represents, and a UNIQUE index guarantees one row per
(template, occurrence-date). Re-running the sweep is therefore idempotent — it
never re-creates an occurrence that already exists.

### Deleting a recurring instance permanently skips that occurrence

`DELETE /v1/tasks/:id` on a materialised recurring instance (a task created from a
template) is treated as a permanent skip of that occurrence, modelled as an
RFC-5545 `EXDATE` exclusion on the parent template. The task row is removed and
the sweep will **not** re-create that occurrence on any future resolve. This is
deliberate: without the EXDATE record, the next sweep would happily re-materialise
the occurrence the operator (or user) just deleted.

There is currently **no API to un-skip an occurrence**. To restore a deleted
occurrence, recreate the task manually (e.g. `POST /v1/tasks` with the desired
fields, or re-create it via the template if appropriate for the whole series).
The EXDATE exclusion on the template persists, so simply re-running the sweep will
not bring the occurrence back.

### One-time occurrence-date backfill (migration 0022)

Existing materialised tasks predate the occurrence-date column and its UNIQUE
index. The backfill stamps each pre-existing recurring task with its occurrence
date and then authors/applies migration 0022 (the occurrence UNIQUE index).

Ordering matters: the backfill must run **after** deploying migration 0021 (which
adds the occurrence-date column) **and** the new sweep/delete code. Running it
before either is in place will either fail (no column) or stamp dates the new code
does not yet read.

Run the dry-run first, inspect the planned changes, then apply:

```bash
# Dry-run — reports what it would stamp, makes no writes:
op run --env-file=.env -- uv run bin/backfill-occurrence-date.py

# Apply — stamps occurrence dates, then authors & applies migration 0022
# (the occurrence UNIQUE index):
op run --env-file=.env -- uv run bin/backfill-occurrence-date.py --apply
```

The backfill is one-time. Once migration 0022's UNIQUE index is in place, the
sweep's idempotency is enforced at the database level and the backfill should not
need to be re-run.

## I. Task done-marking & replan placement floor

### Marking a task done via API

Send a PATCH request to `/v1/tasks/:id` with `{"status":"done"}`:

```bash
curl -X PATCH https://<subdomain>.<zone>/v1/tasks/<task-id> \
  -H "authorization: Bearer $SCHEDULER_BEARER" \
  -H "content-type: application/json" \
  -d '{"status":"done"}'
```

Once a task's status is `done`, it is excluded from every subsequent resolve: the load query selects only `status IN ('pending', 'scheduled', 'committed')`. The task is never fed to the solver and never re-committed. Its scheduler-owned calendar events (those carrying the `scheduler_chunk_id` private extended property) are orphan-deleted by `commit.ts` on the very next replan that covers the same week. The task row remains visible in `GET /v1/tasks`; only its calendar presence disappears.

On a `pending → done` transition, the PATCH handler also best-effort recolors the task's scheduler calendar chunks to the done color (via `worker/src/planning/recolor-done.ts`), scanning **28 days back and forward** of the current week — the backward reach matters because tasks are often done-marked after their chunk's week has elapsed. This ensures the task looks identical to a color-done task, so the un-done-by-color revive scan cannot silently re-open it. The resulting Google Calendar push notification (a done-colored chunk update) is dropped by the webhook as a known echo — it does not trigger a re-resolve. If the recolor Calendar call fails, it is logged but the task is still marked done in D1 (best-effort). Previously this recolor was not performed, causing api-done tasks to be revived by the revive scan (resolved 2026-06-04).

Color confirmation is **per chunk and truthful**: a chunk's completion record is stamped `color_confirmed_at` (plus the confirming `event_id`) only when the recolor actually saw that chunk's event in its scan. A chunk whose event lies beyond the scan, or has no event at all, is recorded done but *unconfirmed* — and an unconfirmed record is never revivable by color. Previously the whole task was stamped confirmed whenever the recolor call merely didn't throw, so a done task whose event sat in an unscanned past week was silently revivable by any later resolve of that week (incident 2026-07-06).

Done is terminal for planning purposes. `status='done'` is never reset by any automated path except the color-revive below, which now requires repainting the exact event whose done-coloring was verified — otherwise only an explicit `PATCH {status:"pending"}` can reverse it.

### Marking a task done via calendar color

Recolor any one of a task's scheduler-owned calendar events to the configured done color. That color change is an event update, which triggers a Google push notification → `/webhook` → `ResolveCoordinator` debounced alarm (~10 s) → resolve. During the resolve:

1. The scheduler fetches all events in the week window via `fetchEventsInWindow`.
2. Color-done detection inspects every scheduler-owned event (those carrying `scheduler_chunk_id`). Any event whose `colorId` matches the user's effective done color triggers a task-level done mark: `UPDATE tasks SET status = 'done' WHERE id = <taskId>`.
3. The task is dropped from the in-memory solver input. Any one chunk match is sufficient — coloring a single event out of a multi-chunk task marks the whole task done.
4. The now-orphaned events (including the colored one) are deleted by `commit.ts` as part of the same replan commit.

The colored event therefore disappears from the calendar on that same replan, replaced by nothing (the task is done). External events (not carrying `scheduler_chunk_id`) are never inspected for done-color detection — their color is the user's own and unrelated to the scheduler.

### Un-done via calendar color (revive)

The done-via-color round-trip is reversible from the calendar, as long as the done-colored event still exists. Repaint a done task's still-existing scheduler-owned event **off** the done color — back to any non-done color, e.g. Banana (`"5"`). That color change is an event update → Google push → `/webhook` → debounced resolve, just like the forward leg.

The webhook normally drops scheduler-owned events to prevent a feedback storm, but it passes this one through a narrow second pinhole: pinhole (b), a scheduler-owned event that is *not* done-colored **and** whose task is currently `status='done'` in D1. (Pinhole (a) is the forward done signal: a scheduler-owned event painted the done color.) Everything else scheduler-owned is still dropped.

During the triggered resolve, the revive-scan is the mirror of the done-scan: it flips the task `done → pending` (`UPDATE tasks SET status='pending'`) and re-adds it to the **current** solve. The task reschedules normally — the churn weight anchors it to its existing event slot, so it usually stays put but may move — producing a non-empty diff and a replan email. On accept, the existing banana event is reconciled in place rather than recreated.

**Best-effort caveat.** This works **only while the done-colored event still exists**. Once a committed resolve has orphan-deleted it (see "Marking a task done via calendar color" above), there is no in-window event to detect, so the revive-scan finds nothing and is a no-op. After the event is gone, un-done must go through the API instead: `PATCH {status:"pending"}` (see "Marking a task done via API").

**Same-event gate.** A completion record remembers *which* event's done-coloring confirmed it (`chunk_completions.event_id`, migration 0028). The revive fires only when **that exact event** is present in the resolved window and off the done color. A stray second event that happens to carry the same `scheduler_chunk_id` — e.g. one minted by an earlier cross-week commit — can neither revive the chunk by its color nor mask the real event's color (records with no `event_id`, i.e. pre-0028 legacy rows, fall back to reviving only when *every* in-window event with the chunk id is off the done color). Relatedly, commit no longer mints such duplicates at all: a chunk with no event inside the plan window is first looked up across a wide horizon (±~3 months back / +1 year forward of the window) and any stray event is **moved** into the planned slot (repainted the create color) rather than a second event being created; extras are deleted (`commit_stray_chunk_relocated` log line). This closes the 2026-07-06 revived-done-task incident chain end to end.

**No-loop note.** After the revive the task is `pending`, so its event no longer fits either pinhole — pinhole (a) needs the done color, pinhole (b) needs a `done` task. Future repaints of that event are therefore dropped by the webhook filter; the revive is one-shot.

**Where the churn anchor comes from.** The baseline a resolve hands the solver (`tasks[].previous_placement`) is sourced in this order. First, the **committed plan for the week being resolved**: week identity is the Mon-anchored local week in `SCHEDULER_TZ`, resolved by a single `getCommittedPlanForWeek` lookup that the drop baseline also uses, so the two baselines always agree on which plan is the reference. The lookup is a SQL range over `window_start` rather than a filter over the newest N commits, so a week's plan is found however deep in the history it sits. Its entries are then filtered to those starting inside `[window.start, window.end)`, and reduced to at most one per `chunk_id` (earliest start wins) since two calendar events can carry the same `scheduler_chunk_id`. Second, if that yields nothing in-window, the **live scheduler-owned events** already fetched for the window. Otherwise the baseline is empty.

All week-identity logic buckets in the instance `SCHEDULER_TZ` — the tz that derived the window in the first place (webhook, Monday cron, accept, supersede). This is deliberate and load-bearing, not an oversight about `home_tz`: a Sydney week straddles two UTC weeks, so bucketing a `SCHEDULER_TZ`-anchored window in a user's `home_tz` splits it, and a mid-week resolve then lands in a different week from its own Mon-anchored plan and misses it. `home_tz` has no write path today; see the internal backlog for what a real migration would have to move together.

Source selection is all-or-nothing after the filter: a partially surviving plan (a Mon-anchored plan against a Wed-narrowed window) is used with exactly its surviving entries, never topped up per chunk from the calendar, since the manual-move write-back is what keeps that plan in sync with hand-drags. Before selection was week-scoped, a plan committed for *another* week won on recency and the filter emptied it, so a future week resolved with `churn = 0` (an internal issue, prod 2026-08-25). Meetings are the exception throughout: `build-problem` overrides their anchor with the live calendar slot. Live guard: L8's **anchor sub-leg** (`bin/regression-smoke.py`) re-resolves the drag-patched, non-latest week A and asserts every dragged chunk is proposed at its dragged slot.

Be precise about what the calendar fallback does and does not cover. Only a commit writes `scheduler_chunk_id`, so the events it reads are the residue of *previously accepted* plans — a subject who has never accepted anything has neither a plan nor scheduler-owned events, and still resolves with an empty baseline. Now that plan selection no longer ages out, the fallback's real coverage is narrow: chunk events dragged into a week whose plan does not contain them, and a week whose committed entries have all elapsed under a mid-week narrowing. (A committed plan disappearing out from under its week is not reachable through the app — every shipped delete path is `committed_at IS NULL`-guarded, and offboarding removes the whole account — so it needs operator SQL to happen at all.)

Two related asymmetries worth knowing when reading a replan email against a churn number. The email's "before" schedule is `result.priorEvents`, i.e. the live calendar, while churn is priced against the committed plan when one exists — so if the plan and the calendar disagree about where a chunk sits, the email narrates a different move distance than the solver charged for. And a committed plan that spans more than one week is only findable through its **start** week: for the drop baseline that matches the long-standing supersede precedent, and for churn the calendar fallback covers the later weeks except for chunks whose events have been deleted. Neither is changed here.

### Configuring the done color

The done color is identified by Google Calendar's `colorId` string (the same values accepted and returned by the Calendar API: `"1"` through `"11"`).

**Instance default (env var):** set `DONE_COLOR_ID` in `worker/wrangler.toml` `[vars]` (or as a Secret):

```toml
[vars]
DONE_COLOR_ID = "3"   # "3" = Grape; any value other than "5" is valid
```

**Per-user override (SQL):** mirror the same pattern as `home_tz` — there is no write endpoint yet; set it directly in D1:

```bash
op run --env-file=.env -- npx wrangler d1 execute scheduler --remote \
  --command "UPDATE users SET done_color_id = '3' WHERE subject = '<email>'"
```

The accessor (`getDoneColorId` in `worker/src/db/users.ts`) returns `users.done_color_id` if set, else falls back to `env.DONE_COLOR_ID`. The effective value is resolved per-user at the start of each resolve.

**Constraint — must not be `"5"`:** the scheduler creates new events with `colorId = "5"` (Banana). If the done color were also `"5"`, newly placed events would immediately be detected as done on the next replan and deleted, causing a loop. `getDoneColorId` throws an error (`getDoneColorId: resolved color "5" conflicts with the scheduler create color`) if either the env var or the user override resolves to `"5"`, so the misconfiguration surfaces immediately rather than silently corrupting data.

To check the current effective done color for a user:

```bash
op run --env-file=.env -- npx wrangler d1 execute scheduler --remote \
  --command "SELECT subject, done_color_id FROM users WHERE subject = '<email>'"
```

A `NULL` `done_color_id` means the user inherits the instance `DONE_COLOR_ID`. If `DONE_COLOR_ID` is also unset, the effective value resolves to the empty string `""`. This does **not** throw (only the value `"5"` throws); instead, color-done detection silently never matches — no calendar event will ever carry `colorId = ""`, so recoloring events has no effect. Ensure at least the env default is set to a valid non-`"5"` color string before the done-via-color feature is used.

### Placement floor: mid-week replans place nothing in the past

Every resolve separates **selection/fetch** from **placement**:

- **Selection and fetch** use the full local week window `[Mon 00:00, next Mon 00:00)` in `SCHEDULER_TZ` (or the user's `home_tz`). An undone task anchored to Monday is still selected and planned on Wednesday; past-day calendar events (including any done-colored ones) are still fetched for detection and diff.

- **Placement floor** = `max(weekStart, ceilToQuarter(now))`. This is the earliest instant the solver may place any chunk into. For a mid-week resolve, `ceilToQuarter(now)` exceeds `weekStart`, so the floor advances to the next 15-minute slot from now. For a future week (`now < weekStart`) the floor collapses to `weekStart` — no behavior change for advance planning.

The effect: a task that was pinned or placed on Monday is still selected and solved on Wednesday, but it lands at or after the placement floor (Wednesday/now), not on Monday. Nothing is ever scheduled onto an already-elapsed slot.

**Past hard-pin release.** A `pinned_at` strictly before the placement floor is silently released: the pin is dropped and the chunk becomes freely movable so the solver reschedules it forward. A pin at or after the floor stays hard. This prevents a stale past pin from making the task infeasible (which would cause it to be dropped from the schedule entirely).

**Fully-past-week guard.** If `windowEnd <= now` (the entire week has elapsed), the resolve is skipped before any DB load or solver call. The callers — webhook replan and Monday cron — can reach a past week via a late-delivered push notification or a cron firing near midnight. Without the guard, `ceilToQuarter(now)` would exceed `windowEnd` and every task would be mass-dropped. The guard returns an empty plan that produces an empty diff, so callers naturally no-op without emitting an email or writing to `proposed_plans`. Current and future weeks (`windowEnd > now`) are unaffected.

The observability log event `resolve_window_shed` (emitted once per resolve, visible via `wrangler tail`) reports `excluded_past` (tasks shed from the window by the window-relative shedding filter, not by the placement floor) and `kept`. The placement floor itself is not separately logged but is derivable from `ceilToQuarter(now)` at resolve time.

## Diagnostics

| Symptom | Likely cause | First check |
|---|---|---|
| 401 on `/v1/...` | Bearer missing/expired | The smoke harness auto-refreshes from `SCHEDULER_REFRESH_TOKEN` (sends `client_id`, default `smoke-cli`, overridable via `SCHEDULER_CLIENT_ID`, and adopts the rotated refresh token). If refresh also fails, re-mint via `./bin/mint-token.py` (Step B.6) |
| 400 from `/oauth/token` during smoke | Refresh rejected: missing/mismatched `client_id`, or the refresh token was already rotated/revoked (provider rotates on every refresh) or expired (90-day TTL) | Ensure `SCHEDULER_CLIENT_ID` matches the mint client; if the stored refresh token was consumed by an earlier run, re-mint via `./bin/mint-token.py` and update `SCHEDULER_BEARER`/`SCHEDULER_REFRESH_TOKEN` |
| `access_denied` on the `/auth/callback` redirect | The Google account you logged in as isn't in the `OPERATOR_EMAIL` allowlist | Add it (comma-separated) to `[vars].OPERATOR_EMAIL` and redeploy |
| 401 on `/admin/...` (non-dev-ui) | Bearer missing/expired, `admin` scope absent, or subject not `role='admin'` | Re-mint with `./bin/mint-token.py` after ensuring `smoke-cli` is registered with the `admin` scope (§B.5); confirm the subject's role in D1 |
| 401/403 on `/admin/dev-ui` from browser | Access cookie expired or `ACCESS_TEAM_DOMAIN`/`ACCESS_POLICY_AUD` mismatch | Compare `wrangler.toml [vars]` to Cloudflare Zero Trust dashboard; this is the only `/admin` route still gated by CF Access |
| Google webhook returns 401 to Google | `WEBHOOK_CHANNEL_TOKEN` mismatch between the secret and `calendar_sync.channel_token` | Re-subscribe via `/admin/webhook/subscribe` (Step B.6) |
| `/v1/resolve` returns 502/solver_error | Solver Worker not deployed/unreachable, **or** the container returned a 5xx on every attempt (cold/restarting and not ready within `SOLVER_MAX_ATTEMPTS`). A single cold-boot 5xx is now retried, so a 502 means the unready window outlasted the retry budget. | `wrangler tail --name weekly-scheduling-solver`; look for `not listening on 8080` / `VMStopped`. If the container idle-stopped, simply re-running the resolve once it is warm succeeds; if wedged, redeploy: `cd solver && wrangler deploy` |
| `/v1/resolve` returns 502 with a solver 400 / a task duration not a multiple of 15 | Durations are reserved as quarter-hour blocks: the worker rounds each chunk **up** to the next 15 before sending to the solver, while the calendar event / diff email render the **real** requested duration. A genuinely invalid problem now returns a clean serialisable 400 (no longer a masked 500). If you still see this, the worker round-up is not being applied. | Confirm the worker is sending rounded durations — check `worker/src/planning/build-problem.ts`; the solver returns `{"error":"validation","details":[...]}` for any still-invalid problem. |
| `/v1/resolve` returns 500 `{"error":"internal_error"}` | An unexpected exception inside `runResolve` (e.g. a malformed solver response failing Zod parse, a bad stored config row, or a template that fails materialisation) — distinct from a solver 502. | Grep Workers Logs for the `resolve_failed` message; the structured payload carries `error` + `stack`. Fix the offending data/code; this is a real bug, not a transient. |
| `/v1/resolve` (or smoke) hangs ~90s then `ReadTimeout` | Solver container wedged/restarting; a solve landed during a down window | Check container metrics + `VMStopped` in the dashboard; redeploy the solver to get a fresh VM, then re-run |
| 7-day re-consent prompts | Google OAuth app stuck in "Testing" mode | Publish the consent screen (requires verification) |
| A past-week task is missing from a new plan | Window-relative shedding (expected): its anchor or deadline is before the window | Confirm via the `resolve_window_shed` log line; PATCH a timing field (e.g. `earliest_start`) to clear the stamp and bring it forward |
| A pure-backlog task (no anchor, no deadline) is absent from a far-future week's resolve | Window-relative shedding (expected, since 2026-08-12): a not-yet-started window only admits backlog via an in-window `earliest_start` floor or a deadline at/after the window start — see §F | Give the task an `earliest_start` inside the target week, or a deadline at/after that week, to include it. A backlog task appearing in / being captured by a far-future week's plan without either is now expected to be impossible — if you see it, that's a regression |

## Plan 4 cutover — close the deployment gate

This is the final multi-user gate. After it merges, a 2nd org user may be authorised.

### 1. Set the membership allow-list

Membership now governs login (the `OPERATOR_EMAIL` var only seeds the initial admin).
Set `MEMBERSHIP_ALLOWLIST` in `[vars]` of `worker/wrangler.toml` — CSV of exact emails
and/or domain wildcards:

```toml
MEMBERSHIP_ALLOWLIST = "<ALLOWLIST>"   # e.g. "*@example.com,contractor@gmail.com"
```

Anyone matching the allow-list, the `OPERATOR_EMAIL` seed admin, or an existing active
`users` row may complete `/oauth/authorize`. Everyone else gets `access_denied`.

### 2. Seed the admin user

The first time `<OWNER>` (an `OPERATOR_EMAIL` identity) logs in, the callback seeds them
as `role='admin'` automatically. To confirm:

```sql
SELECT subject, role, is_active FROM users WHERE subject = '<OWNER>';
-- expect: role='admin', is_active=1
```

(Read-only prod queries are pre-authorised; run via
`op run --env-file=.env -- npx wrangler d1 execute scheduler --remote --command "<sql>"`.)

### 3. Split secrets (optional but recommended)

The crypto keys are purpose-split. Each defaults to `TOKEN_HASH_PEPPER`, so doing nothing
keeps existing tokens/ciphertexts valid. To rotate to distinct values, set Secrets:

- `HASHING_KEY`   — keys `hashToken` (bearer/code lookups). Rotating it invalidates ALL
  issued bearer/refresh tokens and pending auth codes → every user must re-auth.
- `ENCRYPTION_KEY` — keys AES-GCM of `identity_tokens.refresh_token_encrypted`. Rotating it
  makes ALL stored refresh tokens undecryptable → every user must re-connect their calendar.
- `HMAC_KEY`      — keys capability tokens AND the OAuth login-nonce cookie. Rotating it
  breaks only in-flight accept links / login flows (short TTL).

Downtime for a key rotation is acceptable (re-auth is the recovery). Push via the existing
`bin/bootstrap-secrets.sh` pattern (`op run … -- npx wrangler secret put HASHING_KEY`).

### 4. Offboarding

To remove a user (hard-delete current assets + stop their Google webhook, keep sent email
history): `POST /admin/offboard` with `{ "subject": "<email>" }` as an admin (CF Access +
`role='admin'`). It is idempotent and audited (`audit_log`, `source='admin'`).

### 5. GO / NO-GO checklist (before authorising a 2nd user)

- [ ] Plans 1–4 merged to the deploy branch.
- [ ] `npx vitest run` green, including `test/merge-gate/multi-user-gate.test.ts`.
- [ ] Owner-isolation suites green: `db-owner-scope`, `handlers-owner-isolation`,
      `resolve-owner-isolation`, `webhook-owner-isolation`.
- [ ] `MEMBERSHIP_ALLOWLIST` set and deployed; `<OWNER>` confirmed `role='admin'`.
- [ ] (If split) `HASHING_KEY` / `ENCRYPTION_KEY` / `HMAC_KEY` Secrets pushed, or the
      `TOKEN_HASH_PEPPER` default consciously accepted.
- [ ] `bin/switch-account.py` is gone (retired); operators use `/admin/offboard` + a fresh
      login per user instead of switching one shared account.

## Multi-user smoke (scheduler-dev)

`bin/multiuser-smoke.py` exercises the multi-user surface (isolation, resolve
scoping, per-user config/home_tz, fail-closed auth, webhook routing,
offboarding) using two real identities against **scheduler-dev only** — it
hard-refuses any `D1_DATABASE_ID` other than the dev smoke database
(`assert_dev_db`'s `SMOKE_DB_IDS`; prod is denied unconditionally). The same
holds for a Microsoft-provider run — see "Microsoft accounts" below.

The dev deployment serves on `https://scheduler-dev.example.com`
(Workers Custom Domain; the workers.dev URL also still resolves). OAuth flows —
`bin/mint-token.py`, codemode authorize — must use the custom domain: the
federated login's `__Host-` nonce cookie and `OAUTH_ISSUER`-derived callback are
bound to that host, and server-side token exchanges from other Workers only
work across a custom domain (workers.dev worker→worker fetches fail with
Cloudflare error 1042).

Required env (inject via `op run --env-file=.env --`):
`SCHEDULER_URL` (dev host), `A_BEARER`/`A_REFRESH`/`A_EXPECTED_EMAIL`,
the same `B_*` set, and `D1_DATABASE_ID` (the dev db id), plus `CLOUDFLARE_API_TOKEN`
(for `wrangler d1 execute`). No CF_Authorization cookie is required — the harness
authenticates with the bearer alone.

Offline check (no network): `bin/multiuser-smoke.py --self-test`.

Live run: `op run --env-file=.env -- bin/multiuser-smoke.py --levels 1,2,3,4,5,6,7,8`.
M7 is destructive: it offboards identity B (hard-deletes B's data) and then
re-onboards B. M8 backdates B's `calendar_sync.channel_expires_at` in the
target env's D1 and asserts `POST /admin/renew-subscriptions` renewed it the
way that provider does (see "Automatic channel renewal" in section E): on
Google the channel is rotated (new `channel_id`); on Microsoft the Graph
subscription is renewed in place (same `channel_id`, later expiry), except on
UTC Sunday when the sweep forces the rotate path so the webhook secret still
cycles weekly (`m8_renewal_verdict` in `bin/multiuser-smoke.py`). Record/compare baselines with
`--baseline-record` / `--baseline-check`.

### Microsoft accounts

`--provider microsoft` runs the same ladder with A and B both signed in as
Microsoft accounts (Outlook calendars, driven through Graph) — against dev,
which must have `MS_PROVIDER_ENABLED = "true"` and the Microsoft vars set
under `[env.dev]` first (§O "Microsoft smoke on dev"). Both letters must be
the same provider; there is no mixed-provider run.

Preflight checks each identity's `/v1/whoami` provider against `--provider`
and refuses to start on a mismatch. If the deployed worker predates the
`provider` field on whoami (pre WP0), that check can't run — preflight
prints one stderr line per identity (`identity A: whoami has no provider
field — provider guard skipped …`) and continues rather than blocking; in
that case a Google bearer accidentally run under `--provider microsoft`
won't be caught until it 401s against Graph partway through the ladder.

**Minting A and B.**

```bash
eval "$(bin/mu-smoke-login.py A B --provider microsoft --url https://scheduler-dev.example.com \
  --email-a "$MS_A_EXPECTED_EMAIL" --email-b "$MS_B_EXPECTED_EMAIL")"
```

mints both identities in one go, prompting for each Microsoft sign-in in
turn (InPrivate/incognito is recommended so the second account doesn't
inherit the first's session). On a first-ever mint neither
`$MS_A_EXPECTED_EMAIL` nor `$MS_B_EXPECTED_EMAIL` exists yet — substitute the
literal addresses instead; on a re-mint (e.g. after M7) those vars are
already sitting in the shell from the earlier mint, so reusing them avoids
retyping. Pass `--email-a`/`--email-b` explicitly either way: `resolve_emails`
(`bin/mu-smoke-login.py`) resolves each letter in this order — the explicit
`--email-<l>` flag, then the PROVIDER-SCOPED env var (`MS_<L>_EXPECTED_EMAIL`
under `--provider microsoft`, plain `<L>_EXPECTED_EMAIL` under google), then
the smoke-runner config's cast for that provider (`[microsoft].<l>` /
`[google].<l>`), then an empty string that leaves the caller to prompt. It
never falls back to the plain `<L>_EXPECTED_EMAIL` family under
`--provider microsoft`, so a shell that already holds a Google cast can't
leak a Google address into a Microsoft mint — but the explicit `--email-a`/
`--email-b` form above is still the clearest one to use when you're not
sure what's already resolving from env or config. This prints `MS_A_*` /
`MS_B_*` env vars, not plain `A_*` / `B_*` — the Microsoft letters export
under a distinct family so a single shell can hold a Google cast and a
Microsoft cast at the same time (see internal design notes,
Decision 3). Running the harness through `smoke-runner.py` projects
`MS_<L>_*` onto plain `<L>_*` automatically; a **direct** invocation
(bypassing the runner) must map the full target triple by hand before
running — `SCHEDULER_URL`, `D1_DATABASE_ID`, `SMOKE_WRANGLER_ENV`, and each
letter's bearer/refresh/email/client-id:

```bash
SCHEDULER_URL=https://scheduler-dev.example.com \
D1_DATABASE_ID=REPLACE_WITH_YOUR_DEV_D1_DATABASE_ID \
SMOKE_WRANGLER_ENV=dev \
A_BEARER=$MS_A_BEARER A_REFRESH=$MS_A_REFRESH A_EXPECTED_EMAIL=$MS_A_EXPECTED_EMAIL A_CLIENT_ID=$MS_A_CLIENT_ID \
B_BEARER=$MS_B_BEARER B_REFRESH=$MS_B_REFRESH B_EXPECTED_EMAIL=$MS_B_EXPECTED_EMAIL B_CLIENT_ID=$MS_B_CLIENT_ID \
op run --env-file=.env -- bin/multiuser-smoke.py --provider microsoft --levels 1,2,3,4,5,6,8,7
```

Set every one of those explicitly rather than relying on values left in the
shell from an earlier (e.g. Google) campaign: `assert_env_consistent` only
checks that `SCHEDULER_URL` and `D1_DATABASE_ID` name the same env, not that
each letter's bearer belongs to the Microsoft cast (preflight's whoami check
catches that, one letter at a time).

**M6 gate.** M6 (per-user webhook routing) asserts that a push on B's
calendar replans only B, which on Microsoft rides a Graph change
notification reaching a consumer-mailbox (MSA) subscription — a path that
has never been confirmed live. Before running M6 under `--provider
microsoft`, `ms-smoke` step 4 (webhook replan on Graph) must be green on the
current dev build. There is no `SKIP` mechanism in the harness itself — an
unconfirmed M6 doesn't auto-skip, it just fails (or worse, hangs the full
120s wait for a replan that Graph never delivers) — so the gate is manual:
until `ms-smoke` step 4 is confirmed green, drop `6` from `--levels` by hand
(e.g. `--levels 1,2,3,4,5,8,7`) rather than running the full default ladder
and treating an M6 failure as a real regression. Outcome: **not yet run** —
record the result of the `ms-smoke` step 4 check and the first Microsoft M6
attempt once both happen.

**Re-minting B after M7.** M7 (offboard) revokes B's OAuth tokens under any
provider — under `--provider microsoft` the calendar-side cleanup in that
same path also runs, because `MS_PROVIDER_ENABLED` is on for dev. Re-mint B
before running any B-dependent level again:

```bash
eval "$(bin/mu-smoke-login.py B --provider microsoft --url https://scheduler-dev.example.com)"
```

## Per-user busy `.ics` feed

A per-user iCalendar feed of *immovable* commitments (real meetings + pinned
tasks) as opaque `SUMMARY:Busy` blocks. Movable tasks are deliberately omitted —
that time is flexible and optical replans around bookings. Authed only by a
secret URL token (same trust model as a Google secret iCal address).

### Enable / disable (wholesale)
- **Rolled out 2026-07-24**: `CALENDAR_FEED_ENABLED` is `"true"` in both
  `scheduler-dev` and prod `wrangler.toml`. Set it to `"false"` / unset to
  disable in either environment.
- When OFF: `GET /cal/<token>/busy.ics` returns 404; the `/v1/calendar-feeds`
  endpoints return 403 `feature_disabled`.

### Endpoints (per user, Bearer auth)

Multiple named feed endpoints per user, each with its own secret URL and an
optional list of **title-reveal regexes** (full-match, case-sensitive,
compiled `^(?:p)$`). A matching event title is shown verbatim in that
endpoint's feed instead of `Busy` — unless the title contains an
email/URL/meeting-link/phone pattern, in which case it silently stays `Busy`
(the feed never 502s over a title). Other endpoints still show `Busy`.

- `POST /v1/calendar-feeds` `{label, reveal_regexes?}` → endpoint + `reveal_url`.
- `GET /v1/calendar-feeds` → active endpoints incl. `pending_reveal` status.
- `PATCH /v1/calendar-feeds/:id` → edit label/regexes (secret untouched).
- `POST /v1/calendar-feeds/:id/regenerate` → rotate secret (old URL dies NOW),
  fresh `reveal_url`.
- `DELETE /v1/calendar-feeds/:id` → revoke.

Caps: 10 active endpoints/user, 20 patterns/endpoint, 256 chars/pattern.

**Secret delivery — single-use reveal URL.** The API never returns the feed
URL. Create/regenerate stage the URL (AES-GCM-encrypted, purpose
`feed-reveal`) behind `GET /cal-reveal/<token>` — an HTML page whose
**Reveal secret** button POSTs and shows the feed URL exactly once. GET never
consumes (prefetch-safe). TTL 1 hour; consumed/expired reveals return 410 and
the ciphertext is nulled. Lost secret ⇒ regenerate; recovery is impossible by
design. An unopened reveal that expires leaves the endpoint's live secret
known to nobody — regenerate to get a working URL.

### Troubleshooting a dead feed
- 404 on the feed URL: endpoint revoked, secret rotated, or the flag is OFF.
  Re-issue via `POST /v1/calendar-feeds/:id/regenerate` (fresh reveal URL) or
  create a new endpoint via `POST /v1/calendar-feeds`.
- 502: the upstream Google fetch failed or the output leak-guard tripped (check
  Workers logs for `calendar feed output guard blocked response`).
- Empty `VCALENDAR` (no `VEVENT`): the user has no meetings and no *pinned*
  tasks in the next 8 weeks — expected; movable tasks never appear.
- Reveal link shows "Link expired": already opened, older than 1 h, or
  replaced by a newer regenerate. `POST /v1/calendar-feeds/:id/regenerate`
  for a fresh link.
- A title that should reveal shows as Busy: the regex must FULL-match the
  exact title (case-sensitive), and titles containing emails/URLs/meeting
  links/phone numbers are always masked. Check `GET /v1/calendar-feeds` for
  the endpoint's active patterns.

## J. Owned movable meetings

This feature imports meetings the signed-in user *organises* as `tasks` rows
(with `context:"meeting"` and `source.kind:"meeting"`) and allows the scheduler
to relocate them to slots where every *constraining* attendee is free. Which
attendees constrain placement is governed by the **attendee-enforcement policy**
(default `not_declined` — see "Attendee enforcement" below); it is no longer
hard-wired to accepted-only.

### Enabling the feature

**Gate flag (per-env, in `wrangler.toml`):**

```toml
# Under the target environment's [vars] block (e.g. [env.dev]):
OWNED_MEETINGS_ENABLED = "true"
```

Deploy after setting the flag; until deployed meetings import as immovable
(today's behaviour). There is no code-path difference for the operator — the
flag is read once per resolve.

**Tunables (both optional; defaults match the plan spec):**

| Var | Default | Meaning |
|---|---|---|
| `MEETING_MIN_NOTICE_MINUTES` | `1440` (24 h) | Moves are never proposed within this many minutes of the meeting's current start. |
| `MEETING_CHURN_MULTIPLIER_CAP` | `20` | Maximum churn-penalty multiplier for a meeting, relative to an equivalent-duration deep-work task. |
| `MEETING_COMMIT_STABILITY_MINUTES` | `60` | After Optical commits a meeting *move*, the meeting is held at its new slot for this many minutes (cascade stability — see "Cascade stability" below). |

### Re-consent requirement (`calendar.freebusy` scope)

Owned meetings need the `calendar.freebusy` OAuth scope to check whether
constraining attendees are free at candidate slots. Existing accounts connected
before the feature was deployed **do not** have this scope in their stored
refresh token. Until they re-consent, the free/busy query returns a 403 and
every owned meeting **degrades to immovable** for that resolve — it is dropped
from the movable set and stays frozen at its real slot (an `external_pinned`
busy block, reusing the imminent/stability freeze path), so it is never
relocated and never re-notified.

**Degrade-to-immovable is per-meeting and applies to *any* unreadable
free/busy**, not just the missing-scope case. If even one constraining attendee
(per the enforcement policy) reads back as an error — missing scope (403), a
private/`notFound` calendar, a transient upstream error (5xx), or a thrown query
that leaves the free/busy map empty — that meeting is frozen for the resolve
rather than moved blind. A per-meeting `<summary>: attendee_availability_unknown`
warning is surfaced in the resolve response / plan `warnings`; a later resolve
where free/busy reads cleanly will promote the meeting again.

**An EMPTY constraining set freezes the meeting too.** If *no* attendee's
`responseStatus` falls inside the effective enforcement policy — an
`accepted`/`accepted_or_tentative` policy where nobody has accepted yet, or an
attendee whose `responseStatus` Google omitted, which is outside every policy —
then no free/busy is queried at all. That reads as "nobody's availability is
known", not "nobody's availability matters": the meeting is frozen on the same
path, with the same `attendee_availability_unknown` warning and
`movable_verdict.reason = "no_constraining_attendees"`. Without this, the
availability mask degenerates to plain business hours and the solver relocates
the meeting anywhere in the week. Note the enforcement policy therefore only
ever *narrows* what can move: switching an account from `not_declined` to
`accepted` does not free up more meetings, it holds more of them.

This warning is **normal operation, not a fault**: any meeting with external
attendees (whose calendars this account can never read) produces it on every
resolve. There is nothing to fix on our side — visibility is governed by the
attendees' calendar sharing — so a steady stream of these warnings is not an
incident, and no remediation should be suggested to the user. The meeting
simply stays where it is.

**The freeze is now also persisted.** Every resolve stamps
`body.movable_verdict = {at, ok, reason}` on each meeting task in its window —
`ok:false` for every freeze path (unreadable free/busy, no constraining
attendee at all, imminent notice, commit stability, an empty availability mask,
a missing event), `ok:true` on a genuine promotion. The warning above is per-resolve and transient; the verdict is
durable, and it is what the booking page reads before offering a meeting's time
(see "What is offered as bookable"). Nothing in planning consumes it — the
promotion decision is still made fresh each resolve — so a failed stamp is
logged (`dbg_movable_verdict_stamp_failed`) and never fails the resolve.

`body.warnings` keeps these machine codes (smoke + tests assert them); the
accept page and replan email translate them to end-user copy at render time
(`humanizeWarning` in `worker/src/diff/render-diff-calendar.ts`).

> Regression note: an earlier build surfaced the warning but still treated the
> unknown attendee as constraint-free, so meetings with unreadable free/busy were
> relocated anywhere in the week (prod incident 2026-06-26, before the organiser
> re-consented). The freeze above is the fix; the
> `freezes the meeting when …` cases in
> `worker/test/planning/resolve-meetings.test.ts` guard it.

**How to trigger re-consent for an account:**

1. Open a browser and navigate to
   `https://<subdomain>.<zone>/oauth/authorize?client_id=<pkce-client-id>&...`
   using the same flow as the initial mint:
   ```bash
   ./bin/mint-token.py --url https://<subdomain>.<zone> --client-id smoke-cli
   ```
2. The Google consent screen will now show the additional
   "See free/busy information" permission. Accept it.
3. The new refresh token (persisted in `identity_tokens`) includes the scope; on
   the next resolve, owned meetings that were previously immovable will become
   eligible for relocation.

Until re-consent is completed, the dev smoke `--levels owned-meetings` will
skip the free/busy assertion — it prints a skip notice rather than failing, as
the feature degrading to immovable is the specified pre-consent behaviour.

### Attendee enforcement (which attendees constrain placement)

When relocating an owned meeting, Optical subtracts the free/busy of a set of
attendees from the candidate availability mask: a slot is only offered if every
attendee in that set is free. **Which** attendees are in that set is the
*attendee-enforcement policy*:

| Value | Constrains |
|---|---|
| `accepted` | Only attendees who **accepted**. (Reproduces the original review-4C behaviour.) |
| `accepted_or_tentative` | Accepted **plus** tentative. |
| `not_declined` *(default)* | Everyone who has **not declined** — accepted, tentative, **and** not-yet-responded (`needsAction`). |

In every case, resource rooms, the organiser's own copy (`self`), and declined
attendees are **never** counted.

**Resolution order (per meeting):**

```
task.attendee_enforcement  ??  account default (config_meeting_policy)  ??  "not_declined"
```

- **Per-meeting override** — set `attendee_enforcement` on the meeting's task via
  `PATCH /v1/tasks/<task-id>` (`"accepted" | "accepted_or_tentative" |
  "not_declined" | null`). `null`/omitted falls back to the account default. The
  field is preserved across calendar syncs (sync only refreshes
  title/duration/start). Ignored on non-meeting tasks.
- **Account default** — stored in the `config_meeting_policy` table, keyed by
  `owner_subject`, with `'__default__'` as the instance-wide default (seeded
  `{"attendee_enforcement":"not_declined"}`). The loader resolves own-row-else-
  `__default__`-else-hardcoded-`not_declined`, mirroring `config_business_hours`.
  An operator sets a per-user default with a D1 upsert:
  ```bash
  op run --env-file=.env -- npx wrangler d1 execute DB --env dev --remote \
    --command "INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('<subject>', '{\"attendee_enforcement\":\"accepted\"}') ON CONFLICT(owner_subject) DO UPDATE SET body=excluded.body"
  ```
- **Read the effective default** — `GET /v1/meeting-policy` (owner-scoped bearer)
  returns `{ "attendee_enforcement": "<value>" }`: the caller's own configured
  value, else the instance default.

This **overturns review 4C** as the default: a `needsAction` attendee who is
actually attending now constrains placement, so the meeting will not be moved
onto their busy block. The old accepted-only behaviour remains available
per-meeting via `attendee_enforcement: "accepted"`.

### Cascade stability (`MEETING_COMMIT_STABILITY_MINUTES`)

Accepting a plan that moves a meeting patches the Google event with
`sendUpdates=all`, which **resets every attendee's RSVP to `needsAction`**. The
commit also fires the organiser's calendar webhook, triggering a fresh resolve.
Under the `not_declined` default those just-reset attendees still constrain, but
under `accepted`/`accepted_or_tentative` their busy momentarily stops being
enforced — either way, re-resolving the meeting immediately after its own commit
risks proposing a *second* move before RSVPs settle (a cascade).

To prevent this, `commitPlan` stamps `last_committed_move_at` on a meeting's task
row **only when the calendar time actually changed** (never on a no-op commit).
`resolve` then excludes any meeting stamped within
`MEETING_COMMIT_STABILITY_MINUTES` (default 60) from the movable set: it stays an
`external_pinned` busy block at its committed slot, reusing the existing frozen-
meeting path. After the window elapses the meeting becomes movable again.
`last_committed_move_at` is a system column (like `scheduled_for`): never in the
task body, never PATCHable.

### Pinning a meeting (opt-out of relocation)

Owned meetings are imported as ordinary `tasks` rows. To prevent the scheduler
from ever moving a particular meeting, set a hard pin on it:

```bash
curl -X PATCH https://<subdomain>.<zone>/v1/tasks/<task-id> \
  -H "authorization: Bearer $SCHEDULER_BEARER" \
  -H "content-type: application/json" \
  -d '{"pinned_at":"<current-start-ISO>"}'
```

A hard pin locks the meeting to its current slot, exactly like pinning any
other task. The `OPTICAL_MEETING_TASK_ID_KEY` extended property on the Google
Calendar event (`optical_meeting_task_id`) links the event back to its task row
and is how the harness (and the worker) identifies scheduler-owned meeting
tasks.

### Accept and attendee notification

Moves are **proposed** by `/v1/resolve` — they appear in the plan diff email
with the `moved-to` role. The Google event is only **patched** (start/end
updated, `sendUpdates=all`) after the user explicitly accepts the plan via
`POST /v1/plans/<plan_hash>/accept` or the Accept link in the email. Attendees
therefore receive a single calendar update from the organiser's account, not
from Google's scheduler, once the human confirms the move.

### Known v1 limitations

- **Deletion reconciliation window.** A meeting that is deleted from Google
  Calendar is detected the next time the week containing the meeting's stored
  `earliest_start` is resolved. A deleted meeting whose week is never resolved
  leaves a dormant row in `tasks` (eligible for cancellation) until that week
  is triggered by a normal resolve or Monday cron. This is deliberate: full
  event-deletion tombstoning is deferred to a future iteration.

- **`guestsCanModify` out of scope.** You cannot move a meeting you can edit
  but do not organise. The feature is organiser-only in v1.

- **Attendee count not shown in email.** The replan diff email shows which
  meetings move (with `moved-to`/`moved-from` roles) but does not list the
  meeting's attendee count or names. This is future presentational work.

- **Churn count vs. placement set may differ.** The churn multiplier is
  proportional to total accepted-attendee count (including optional attendees who
  accepted). Placement gating, however, follows the **attendee-enforcement
  policy** (default `not_declined`; see "Attendee enforcement" above), so the set
  of attendees whose free/busy gates a slot is not necessarily the same as the
  set that drives the churn multiplier. The earlier accepted-only placement rule
  (review 4C) is now just the `attendee_enforcement: "accepted"` option.

### Regression smoke (`--levels owned-meetings`)

Run the owned-meetings scenario against the dev env (requires `op` + secrets):

```bash
op run --env-file=.env -- uv run bin/regression-smoke.py --levels owned-meetings \
  > /tmp/smoke-meetings.txt 2>&1; tail -40 /tmp/smoke-meetings.txt
```

**Pre-conditions:** `OWNED_MEETINGS_ENABLED=true` deployed in the dev env
AND the test account re-consented to the `calendar.freebusy` scope. If either
condition is absent the scenario skips cleanly with a notice — it does not
fail, because degrading to immovable is the specified pre-feature behaviour.

**What the scenario tests:**
1. Creates an owned meeting with one accepted attendee whose free/busy blocks
   the current slot but leaves a better slot available later in the week.
2. Runs `/v1/resolve`; asserts the proposed plan moves the meeting (the
   meeting's task appears in the schedule at a new slot, not its original slot),
   and that `warnings` is absent or empty (all attendees known).
3. Commits the plan; asserts the Google Calendar event is patched to the new
   start/end (`sendUpdates=all` was sent — the attendee received an update).

The scenario cleans up all artifacts (seeded tasks + calendar events + plan
hashes) in its `finally` block regardless of pass/fail.

### Multi-account meeting smoke (`bin/meeting-smoke.py`)

Exercises the free/busy *visibility* paths that the single-account harness
structurally cannot, using real Google accounts. Two modes, selected by
`--accounts` (default **2**):

| Acct | Email |
|------|-------|
| A | operator@example.com |
| B | operator.alt@example.com |
| C | tester1@example.com |

- **`--accounts 2`** (default): organiser **B**, attendee **C**; the only
  relationship is C grants B. Scenarios **2A/2B/2C/2D** (placement) plus **2E**
  (attendee enforcement: with C left `needsAction`, the `not_declined` default
  still constrains placement, so the meeting skips C's blocked Y1 and lands at
  Y2 — under the old accepted-only rule it would have taken Y1) and **2F**
  (cascade stability: the meeting is moved, the move is **committed**, and an
  immediate re-resolve finds it frozen — excluded from the movable set, so it
  produces no schedule chunk).
- **`--accounts 3`**: A, B, C with the partial-visibility topology (C sees B,
  not A). Scenarios **M1** (commit path: move committed, attendee notified,
  event patched off X), **M2** (invisible attendee →
  `attendee_availability_unknown` warning), **M3** (mixed visibility: A
  unreadable + B readable **freezes** the meeting at X — one unconfirmable
  attendee makes the whole party unconfirmable, per the degrade-to-immovable
  policy `8785336`; partial visibility never produces a move. Distinct case:
  an attendee whose free/busy IS readable but busy wall-to-wall is a
  *known*-availability problem — today their busy constrains placement via the
  mask; dropping such an attendee from the constraint set, like making either
  behaviour configurable, is deliberate future work, not v1).

**Corrected premise (why the scenarios are shaped this way):** a meeting *never*
relocates merely because an attendee is busy at its current slot — the worker's
C1 fallback always re-adds the current slot as feasible. A meeting moves only
under **resource competition**: each "moves" scenario seeds a **pinned
competitor** task on the organiser at slot **X**, which forces the meeting off X.
Free/busy honouring is then observable in *where* it lands — **Y1** (10:30,
nearest free) when the attendee is free, vs **Y2** (11:00) when the attendee
blocks Y1. That Y1↔Y2 contrast is attributable solely to the attendee's
free/busy, which the worker can read only when the ACL topology grants it.

**Why X/Y1/Y2 = 10:00/10:30/11:00 (not 09:00).** The three slots sit inside the
default `meeting` context fit-curve plateau (peak 10:00–11:00, migration 0005),
so X and Y1 score identical time-of-day fit. This is load-bearing: it keeps
placement driven purely by competition + attendee free/busy + churn. An earlier
09:00–10:30 window sat on the curve's rising edge, so the solver legitimately
drifted the meeting toward the 10:00 peak (2C 09:00→10:00, 2D 09:30→09:45) and
every scenario failed for a reason unrelated to free/busy. The harness also
waits for each attendee's RSVP to propagate to the *organiser's* event copy
before resolving (the copy the worker's accepted-attendee mask reads), mirroring
the ACL-visibility wait.

**Hermetic — no manual sharing setup.** The harness sets the free/busy topology
itself via the Calendar ACL API (`freeBusyReader` grants), isolates a blank week
across the active calendars, and seeds deterministic business hours
(10:00–11:30 Mon–Fri) + `home_tz` (Sydney) per account in D1, then tears it all
down. The **only** manual prerequisite is auth.

**Prerequisites (the harness SKIPs, exit 2, if unmet):**
- `OWNED_MEETINGS_ENABLED=true` on the target dev worker.
- The **owner** accounts re-consented on dev with **both** `calendar.freebusy`
  and `calendar.acls` (via `bin/mint-token.py` against the dev host). Owners that
  grant sharing: two-account → **C**; three-account → **A, B, C**. The
  `calendar.acls` scope is dev-only (gated by `GOOGLE_ACL_SCOPE_ENABLED` under
  `[env.dev.vars]`); deploy dev first so the scope is advertised, then re-consent.
  If an owner lacks the scope, its ACL write returns 403 and the affected
  scenario SKIPs with a clear *"re-consent … with calendar.acls"* message.

**Safety:** refuses to run unless `SCHEDULER_URL` is the dev host or `*.workers.dev`
(prod host hard-denied), and `D1_DATABASE_ID` must be the dev D1 (prod id
hard-denied) since the harness writes business hours / `home_tz` to D1.
Deletions are scoped to harness-created artifacts (mtg-smoke tasks + meeting
tasks correlated by the event id the harness created) and the ACL grants the run
itself added (reversible `freeBusyReader` rules among {A,B,C}); real meeting
tasks and real sharing rules are never touched.

**Note:** most scenarios *resolve* (propose) only and assert on the proposed
plan, so no notifications are sent. **M1** (three-account) and **2F**
(two-account) are the exceptions: they **commit** the proposed move (sending
`sendUpdates=all` to the attendee), intentionally exercising the commit path end
to end — M1 verifies the Google event was patched off its slot; 2F verifies the
committed meeting is then frozen on the immediate re-resolve.

#### Named harness gap: no accepted-only policy scenario (**2G**, not written)

Every scenario above runs under the **`not_declined` default** — none sets
`attendee_enforcement`, so no scenario ever produces an *empty* constraining
set, and the `no_constraining_attendees` freeze (§J) is covered by vitest only,
never end to end. That is the freeze that holds a public booking under an
accepted-only policy, so the gap is worth closing deliberately rather than
leaving implicit.

The scenario to write, **2G** — essentially 2E inverted:

1. `PUT /v1/meeting-policy {"attendee_enforcement":"accepted"}` for the
   organiser (**B**), recording the prior value.
2. Meeting B+C at **X** with C left `needsAction` — skip the accept and the
   RSVP-propagation wait, exactly as 2E does.
3. Seed the pinned competitor at X, then `/v1/resolve`.
4. Assert **no meeting chunk** in the plan (C does not constrain, so the set is
   empty and the meeting must be frozen at X, *not* moved to Y1), and that
   `movable_verdict.reason == "no_constraining_attendees"` on the meeting's task.
5. Restore the prior policy in the `finally` block alongside the existing
   teardown.

Step 4's second assertion is the real gate: without it the scenario passes
vacuously if the meeting is frozen for some unrelated reason.

**Run:**
```bash
# two-account (default; needs only B and C authed + C re-consented to calendar.acls)
op run --env-file=.env -- uv run bin/meeting-smoke.py --accounts 2 \
  > /tmp/meeting-smoke.log 2>&1; tail -60 /tmp/meeting-smoke.log
# three-account
op run --env-file=.env -- uv run bin/meeting-smoke.py --accounts 3 \
  > /tmp/meeting-smoke.log 2>&1; tail -60 /tmp/meeting-smoke.log
```
Exit codes: 0 = at least one scenario genuinely passed; 1 = a failure;
2 = everything skipped (the live path was never exercised — not a pass).

### Microsoft accounts (work tenant)

`--provider microsoft` (WP4, internal design notes) runs
the same scenarios with every active account signed in as Microsoft
(Outlook calendars, driven through Graph), against dev with the Microsoft
provider enabled (§O "Microsoft smoke on dev").
Unlike poll-smoke and multiuser-smoke, this harness needs **a work
tenant**, not a personal Microsoft account (MSA) — and unlike an earlier
draft of this note, **no scenario at all** is runnable on an MSA, 2C
included (review fix #7, 2026-09-03). It's tempting to think 2C ("stays
put, no competition") would be exempt since its own assertions never touch
free/busy, but every scenario — 2C too — calls `grant_and_wait`/
`revoke_and_wait` in its setup/teardown, which write the organisation-
default `calendarPermissions` entry and poll `getSchedule` via
`wait_for_visibility`; neither concept exists on an MSA. So 2C still fails,
just for a different reason than the freebusy-dependent scenarios (a
`VisibilityError` from the missing permissions entry, or a visibility poll
that never converges and times out) rather than an unexpected
`attendee_availability_unknown`. All three letters (`microsoft:a/b/c`) must
be mailboxes in the **same** tenant.

**Topology model — organisation-default permission, not per-grantee ACL.**
Google's ACL API grants free/busy visibility to one named grantee at a
time; Graph has no per-grantee equivalent. Instead, WP4 models a
scenario's grant/revoke via the tenant's **organisation-default calendar
permission** — the "My Organization" pseudo-entry in
`GET /me/calendar/calendarPermissions` — set to `freeBusyRead` (visible) or
`none` (invisible) via `PATCH .../calendarPermissions/{id}`
(`GraphCalendarClient.set_visibility`, `bin/_smoke_lib.py`). This means a
grant/revoke in this harness is **org-wide**: every tenant member's
visibility of the owner's calendar changes together, not just the one
grantee a scenario names for readability (e.g. 2A's "ACL on (C→B)" reads as
"B's calendar becomes visible to the whole tenant, not only C"). Running
2A/2B back to back therefore still works — each flips the SAME
organisation-default entry — but do not run a Microsoft meeting-smoke
scenario concurrently with anything else in the tenant that depends on a
DIFFERENT visibility state. Propagation latency of the permission change is
unmeasured as of this writing; `wait_for_visibility`'s existing poll/budget
applies unchanged, but a live run may need a longer `--accounts`-agnostic
timeout if it proves too tight — record the observed latency here once
measured (WP4.3, not yet run).

**Invitation and RSVP email cannot be suppressed.** Google's
`sendUpdates=none` suppresses invite/cancellation email while still
registering the event on each attendee's calendar (needed for free/busy to
reflect it); Graph has no equivalent — every `create_event(...)` call with
attendees sends them a real invitation email under this provider.
RSVP mail is unavoidable too: Graph's accept/decline/tentativelyAccept
action call IS the response message, unlike Google's PATCH-only RSVP —
`sendResponse: false` applies no response at all (the organiser's copy
would keep `status.response == "none"` forever and the worker's own
accepted-attendee mask would never see it), so `GraphCalendarClient.rsvp`
sends `sendResponse: true` and every scenario that calls `accept_invite`
also generates RSVP mail to the organiser under `--provider microsoft`.
Acceptable for the smoke mailboxes this runs against; each scenario's own
docstring notes the invitation-mail half of this.

**RSVP correlation.** Google reuses the SAME event `id` across the
organiser's and every attendee's calendar, so RSVP-ing on an attendee's
copy is a direct GET/PATCH by that id. Graph gives each attendee's copy a
DIFFERENT id — the harness instead resolves the event's `iCalUId`
(`GraphCalendarClient.get_event_icaluid`) once on the organiser's copy and
polls `GET /me/events?$filter=iCalUId eq '<uid>'` on the attendee's side to
find their copy, then RSVPs via `POST /me/events/{id}/accept` (or
`decline`) with `sendResponse: true`. `bin/_smoke_lib.rsvp_as_attendee`
isolates this branch so level code never sees the provider.

**Free/busy normalisation mirrors the worker exactly, not just loosely.**
`GraphCalendarClient.query_freebusy` matches `getSchedule` results to
requested emails by `scheduleId` (casefold-compared) — Graph does not
guarantee response order — and reuses the SAME per-item rules
`worker/src/providers/microsoft-calendar-provider.ts`'s `queryFreeBusyBatch`
does: `busy`/`tentative`/`oof` block, `free`/`workingElsewhere` don't; an
id absent from the response is `errors: ["missing_in_response"]`; a
present-but-empty `scheduleItems` with no `availabilityView` is genuinely
free (`busy: []`), not unreadable; a missing `scheduleItems` but a non-empty
`availabilityView` falls back to that coarser (30-min-granularity) view,
floored to a 30-min boundary from the UNIX epoch and clamped to the query
window's end, exactly like the worker's own fallback. A whole-request HTTP
failure degrades to `errors` for every requested email ONLY when the body
carries a recognisable personal-mailbox-shaped error code
(`_MSA_UNREADABLE_ERROR_CODES` — `ErrorAccessDenied`,
`MailboxNotEnabledForRESTAPI`, and two more; **not yet confirmed against a
real MSA response, WP4.3 must verify and this list may need updating**);
anything else raises, so a malformed harness request cannot make every
attendee look "invisible" and silently pass 2B/M2 for the wrong reason.

**Minting A, B, C.** Each letter mints the same way poll-smoke's Microsoft
organiser does (see §L's poll-smoke Microsoft subsection for the general
pattern) — `bin/mu-smoke-login.py <LETTER> --provider microsoft --url
https://scheduler-dev.example.com --email-<letter> "$MS_<LETTER>_EXPECTED_EMAIL"`
for each of A/B/C, exporting the `MS_<L>_*` family (Decision 3,
internal design notes). Running through `smoke-runner.py`
projects `MS_<L>_*` onto plain `<L>_*` automatically; a direct invocation
must map the full triple by hand, the same way the Multi-user smoke
section's Microsoft subsection shows for A/B.

**Run:**
```bash
SCHEDULER_URL=https://scheduler-dev.example.com \
D1_DATABASE_ID=REPLACE_WITH_YOUR_DEV_D1_DATABASE_ID \
SMOKE_WRANGLER_ENV=dev \
B_BEARER=$MS_B_BEARER B_REFRESH=$MS_B_REFRESH B_EXPECTED_EMAIL=$MS_B_EXPECTED_EMAIL \
C_BEARER=$MS_C_BEARER C_REFRESH=$MS_C_REFRESH C_EXPECTED_EMAIL=$MS_C_EXPECTED_EMAIL \
op run --env-file=.env -- uv run bin/meeting-smoke.py --provider microsoft --accounts 2 \
  > /tmp/meeting-smoke-microsoft.log 2>&1; tail -60 /tmp/meeting-smoke-microsoft.log
```
(add `A_*` from `$MS_A_*` for `--accounts 3`.)

**Status (2026-09-03): design + unit tests only.** WP4.1/4.2 (this
subsection, `GraphCalendarClient.rsvp`/`query_freebusy`/`set_visibility`/
`get_event_icaluid`/`attendee_responses`, and meeting-smoke's `--provider`)
are built and unit-tested against Graph fixtures — no live tenant exists
yet, per the operator's 2026-09-02 decision to build ahead of the account
purchase. **Not yet done (WP4.3/4.4, blocking a live run):** (a) confirm
`getSchedule` between two tenant members actually returns `scheduleItems`
in the shape assumed above — **first suspect if this comes back a 400**:
`query_freebusy`'s request body sends `startTime`/`endTime` as
`{"dateTime": "…Z", "timeZone": "UTC"}` (a Z-suffixed instant plus an
explicit zone), matching the worker's own request shape
(`microsoft-calendar-provider.ts` ~378) but Graph's dateTimeTimeZone docs
describe a NAIVE local datetime with the zone carried separately, not a
Z-suffixed one — untested against a real endpoint either way, so if (a)
400s, try a naive (no-Z) `dateTime` first; (a2) confirm the real error
code(s) Graph returns for an unreadable/personal mailbox and reconcile
`_MSA_UNREADABLE_ERROR_CODES` against it; (b) measure how long the
organisation-default permission flip takes to propagate, against
`wait_for_visibility`'s existing budget; (c) confirm a Graph `accept`
action with `sendResponse: true` shows up on the organiser's copy within
`wait_for_attendee_accept`'s budget; (d) the live 2A–2F / M1–M3 ladder
itself. Record each outcome here once run.

## K. Public booking page

A per-user public page at `/book/<slug>` — no sign-in, no bearer, no
`CF_Authorization` cookie — that lets anyone with the link claim a slot on the
owner's calendar. `GET /book/<slug>` serves the page, `GET
/book/<slug>/slots?duration=<minutes>` returns bookable start times as JSON, and
`POST /book/<slug>` claims one and creates the calendar event. Every failure
path — feature off, unknown slug, disabled page — returns the same byte-
identical 404, so the endpoint is not a slug oracle (`worker/src/booking/route.ts`).

### Two layouts, and one fetch per page

The page draws one of two arrangements, chosen in JS from
`matchMedia("(max-width:720px)")`: wide is a week grid — a column per day of
the selected day's week, `.colh` headers, a hatched `.none` cell for a day with
nothing on offer — and narrow is the dot strip plus the one selected day. The
strip is present at **both** widths: it is the only day picker, so it is also
how the wide grid moves between weeks, and nothing caps it (every loaded day
stays reachable). While the server has a further page of dates, the strip ends
in a dashed **"Later →"** cell (`#more`, styled as a `.dcell`); pressing it
fetches exactly one more page and appends it — see "Paging" below.

The strip is grouped by calendar month (`stripMonths` in the client, one
`.mgroup` per month with a `.mlabel` heading, a hairline divider between
groups). With `max_horizon_days` a strip can run for months, and a scrolled row
of bare day numbers ("29 30 1 2 5 6") does not say which month "1" is in. The
label is `position:sticky; left:` so it stays pinned to the strip's left edge
while any of its month's days are in view and is pushed off by the next
month's label — the month is readable wherever the strip is scrolled. It reads
"Sep" until the year differs from the first month's, then "Jan 2027"
(`monthLabel`), formatted in the booker's browser locale like every other
label on the page.

**The breakpoint is written twice** — the media query in
`worker/src/booking/page.ts` and the `matchMedia` call in
`worker/src/booking/booking.client.js`. They select different *markup*, not
different styling for the same markup, so CSS alone cannot do it. Change one
and you must change the other.

**So is the Turnstile onload callback name** (`opticalTurnstileReady`): a
constant in `page.ts`, baked into the `api.js` URL as
`?onload=opticalTurnstileReady&render=explicit`, and `TURNSTILE_READY_CALLBACK`
in `booking.client.js`, set as a property on `window`. Neither file can derive
it from the other; `worker/test/booking/page.test.ts` asserts they agree. The
callback exists because `api.js` may execute *after* the module: without it a
booker on a slow connection who selects a slot during the wait gets no widget at
all, and then a bare `403 challenge_failed` for a challenge they were never
shown. Either load order works — if `window.turnstile` is already there the
client renders straight away.

**Both script tags live in the `<head>`, module first, and the challenge tag is
`defer` and NOT `async`.** `type="module"` and `defer` share one deferred queue
which the browser runs in document order, so the module is guaranteed to have
registered the callback before api.js looks for it. With `async` the browser
usually won that race: the page still worked (the already-loaded check catches
it) but every load logged two `[Cloudflare Turnstile] Unable to find onload
callback` warnings before it gave up. `page.test.ts` pins the order.

**The confirm form is not rebuilt on every render.** `render()` also runs on an
overlay load, a timezone switch and every crossing of the breakpoint, none of
which change *which* slot is selected — rebuilding on those wiped the
name/email/note the booker had typed and forced the challenge to be solved
again. `confirmNeedsRebuild` gates the rebuild on the selected slot alone; the
summary line (`#bookwhen`) is the only part that depends on anything else, and
is rewritten in place. When a rebuild is genuinely due the old widget is
`turnstile.remove()`d before its container goes.

**The uploaded-.ics overlay is parsed over a window derived from the offered
slots** (`overlayWindow`), not a constant. It was a hardcoded 90 days, which
under-reported for any owner whose `horizon_days` exceeds that: slots on days
91-120 clashed with nothing and always drew a full set of dots. Under-reporting
busy time is the one direction that file must never take — it tells a booker
they are free when they are not.

**Paging.** `GET /book/<slug>/slots?duration=N&page=k` returns ONE page —
`horizon_days` of availability — and costs one calendar read plus one
`bookings` read, both sized to that page's window, never to the whole reach.
Page k is `[now + k·horizon_days, now + (k+1)·horizon_days)` in
**milliseconds off the server's `now`**, not local midnight: page 0 is
byte-for-byte the single window the page served before paging existed, and a
local day that straddles a boundary is split across two pages (never
duplicated, never dropped — the client sorts the union before bucketing by
date). The owner's `max_horizon_days` is how far a booker may page; the last
page is clamped to it, `null` (the default, and every page configured before
this existed) means one page. The response carries `page`, `has_more` and
`window: {start, end}` (ISO instants); `page` absent is page 0, anything that
is not a non-negative integer is `400 invalid_page`, and a page past the reach
is `400 page_out_of_range` — refused **before** any read, so an
unauthenticated caller cannot spend a calendar read on a page that cannot
exist (`computeAvailability` throws `PageOutOfRangeError` first thing).
Nothing prefetches: each page is a calendar read, so a booker who wants day
300 pays for the page holding it, and only when they press "Later →".

The claim path (`POST /book/<slug>`) re-verifies the requested start against a
fresh recompute of **the page holding it** (`pageForStart`) — one calendar
read whatever the distance, rather than every page from now to there. A start
past the reach has no page and is `409 slot_unavailable` **without** a `slots`
list, before the calendar is touched. A 409 that does carry a list also
carries `page` and `window`, so the client can splice.

The client caches per duration: an entry is the sorted union of pages
`0..pages-1` plus `hasMore`, and only the NEXT page is ever accepted into it
(`appendSlotPage` — a duplicate or out-of-order response is dropped, not
doubled). Each page is fetched once: toggling 30 → 60 → 30 is two round-trips,
not three, and switching duration starts that duration at page 0 with its own
"Later →". **If you are watching for a `/slots` call that never comes, this is
why.** On a 409 the page the response names is spliced out by its `window` and
the fresh list put in its place — the other pages, and the reach, are kept, so
a booker paged out to week six is not thrown back to week one by someone
else's booking. That window was computed at claim time, not fetch time, so it
is shifted from the cached page by however long the booker sat on the page;
the sliver of stale page it leaves is harmless (every claim is re-verified
server-side). The whole cache is dropped after a successful booking — a
booking blocks more than its own start. A 409 that carries **no** `slots` key
at all (the post-claim recompute could not read the calendar) drops the cached
entry instead, so the next selection refetches from page 0.

**The overlay parser's over-reporting bias does not extend to properties that
state availability outright.** `parseIcsBusy` used to read only
`DTSTART`/`DTEND`/`RRULE`, on the reasoning above — everything else ignored or
collapsed, safe because over-reporting only costs a dot. That reasoning does
not cover a property that says outright an event is not busy time. Google
exports working-location markers ("Home"), birthdays and due-date reminders as
all-day events with `TRANSP:TRANSPARENT`; one real booker's export had seven of
these merge into a single 107-hour busy block that greyed out their entire
week (71.4% of the window reported busy — 10.9% after the fix, longest block
4.0h). `parseIcsBusy` now honours, checked **before** any date or recurrence
work runs (so an unsupported `RRULE FREQ` on a transparent event never even
warns):

- `TRANSP:TRANSPARENT` — RFC 5545 for "does not consume time". A missing
  `TRANSP` still defaults to OPAQUE (busy), per the same spec.
- `STATUS:CANCELLED` — the event is not happening.
- `EXDATE` — excluded occurrences are dropped, matched on the **resolved UTC
  instant** rather than the literal property text, so an `EXDATE` written as a
  bare `Z` literal still cancels a `TZID`-bound occurrence. Handles multiple
  comma-separated dates in one property and multiple `EXDATE` properties on one
  `VEVENT`.

Known gaps that remain, left as over-reporting on purpose:

- `RECURRENCE-ID` is not linked back to its parent series, so a moved
  occurrence is counted twice — busy at both the vacated original time and the
  new one.
- `FREQ=MONTHLY` and `FREQ=YEARLY` are not expanded; each still collapses to
  its first occurrence with a warning. (Most `YEARLY` events in practice are
  birthdays, which are `TRANSPARENT` and are now skipped entirely regardless.)
- `RDATE` is still ignored.

`worker/test/booking/fixtures/` (17 `.ics` files plus a README table) is where
parser semantics are pinned property-by-property, driven by
`worker/test/booking/ics-fixtures.test.ts`. The known gaps above are asserted
there as *current* behaviour, so closing one fails a test on purpose instead of
silently changing what a booker sees. And regardless of any of the above: the
overlay is only the booker's convenience view — the owner's real availability
is enforced server-side at claim time, so an overlay that reads slightly free
can never actually double-book anyone.

### Response headers on the public page

`GET /book/<slug>` carries a `Content-Security-Policy` (`BOOKING_PAGE_CSP`,
exported from `worker/src/booking/page.ts` and applied in `route.ts`) plus
`X-Frame-Options: DENY`. Defence in depth — every interpolation in the shell is
already escaped for its context — but this is an unauthenticated public form
whose success sends a calendar invitation from the owner's account, so being
frameable by any origin was a real clickjacking surface.

```
default-src 'none'; script-src 'self' https://challenges.cloudflare.com;
style-src 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com; img-src 'self' data:;
form-action 'none'; base-uri 'none'; frame-ancestors 'none'
```

Every source is load-bearing, and **a policy that breaks the flow is worse than
none** — if you tighten this, check each of:

- `script-src 'self'` — the page's own module, `/book/_static/booking.<hash>.js`.
- `challenges.cloudflare.com` in `script-src`/`frame-src`/`connect-src` — the
  Turnstile script and the iframe it injects.
- `style-src 'unsafe-inline'` — **two** things: the `<style>` block in the shell
  *and* the `style=""` grid-placement attributes `booking.client.js` writes on
  every slot cell. **Do not "improve" this with a nonce:** under CSP3 a nonce
  makes `'unsafe-inline'` be ignored, which kills the attributes and collapses
  the week grid.
- `connect-src 'self'` — `GET /book/<slug>/slots` and `POST /book/<slug>`.

`worker/test/booking/page.test.ts` checks each directive against the markup it
protects, and `bin/booking-smoke.py` step B2 asserts both headers survive the
edge on a live deployment.

### The static client asset is generated, not the source

The client asset is **not** served via a wrangler Text rule — Task 14 hit a
module-resolution failure with that approach in the vitest workers pool, so the
fallback is a generated TS module instead.
`worker/src/booking/booking.client.js` stays the single source of truth for the
client logic; `./bin/build-client-js.sh` wraps its exact bytes as a
`JSON.stringify`-escaped string constant in
`worker/src/booking/booking-client-source.generated.ts` (`BOOKING_CLIENT_JS`),
which `worker/src/booking/route.ts` serves directly (`text/javascript`).

**The served filename carries a content hash**:
`/book/_static/booking.<hash>.js`, where the hash is the first 16 hex
characters of the SHA-256 of the client source, emitted by the same generator as
`BOOKING_CLIENT_HASH` and used both to register the route and to build the
`<script>` tag in `page.ts`. Only the current hash is routed — a stale URL 404s
rather than serving today's bytes under yesterday's name.

That naming is what makes `cache-control: public, max-age=31536000, immutable`
safe, and it is not cosmetic. The asset was previously served at a **fixed** URL
with `max-age=3600` and neither an `ETag` nor a `Last-Modified`, so a browser
had nothing to revalidate against and simply reused its copy for an hour. A
deploy fixing the `.ics` overlay parser therefore did not reach anyone who had
opened the page recently, and `curl` (which has no cache) disagreed with the
browser for an hour — which is exactly how long it took to work out why the fix
"had not deployed". The page shell that names the asset is sent
`cache-control: no-cache` for the same reason: cache the shell and it keeps
asking for the old hash, defeating the whole mechanism.

**Editing `booking.client.js` without re-running the generator ships a stale
asset** — the generated file does not update itself. `npm run typecheck`
will not catch this (both files are valid TS/JS on their own).
`worker/test/booking/static.test.ts` does catch it: it compares
`BOOKING_CLIENT_JS` byte-for-byte against the real `booking.client.js` source
and fails on any drift — but only if that test actually runs before deploy.
After any change to `booking.client.js`, run `./bin/build-client-js.sh` from
the repo root and commit the regenerated `.generated.ts` alongside it.

### Enabling the feature

**Gate flag (per-env, in `worker/wrangler.toml`):**

```toml
BOOKING_PAGE_ENABLED = "true"
```

Default is `"false"`. Also required, whenever the flag is on:

- `TURNSTILE_SITE_KEY` — a var, embedded in the served page for the client-side
  widget.
- `TURNSTILE_SECRET` — a **secret** (`wrangler secret put TURNSTILE_SECRET --env
  <env>`), checked server-side on every claim via Cloudflare's siteverify API. A
  missing secret or a failed/empty token fails the claim closed (`403
  challenge_failed`) — there is deliberately no way to accept a booking without
  a passing challenge. The siteverify **`hostname`** must also match the host of
  the incoming request (the widget is served from the same origin), so a token
  minted for this sitekey on somebody else's page cannot be replayed against
  the claim endpoint; a success with a mismatched or absent hostname is denied.

**Minting a real pair.** A Turnstile pair is *issued* by Cloudflare against a
hostname, not generated locally — there is no `openssl rand` equivalent, which
is why `bin/bootstrap-secrets.sh` does not cover `TURNSTILE_SECRET`. Use
`bin/create-turnstile-widget.py`, which creates the widget, prints only the
public sitekey on stdout, and pipes the secret straight into `wrangler secret
put` without it ever being displayed or written to disk:

```bash
SITEKEY=$(op run --env-file=.env -- bin/create-turnstile-widget.py \
            --hostname scheduler.example.com \
            --name 'Optical booking page (prod)' \
            --wrangler-env prod)
```

Then set `TURNSTILE_SITE_KEY = "$SITEKEY"` in the matching `wrangler.toml` vars
block and deploy. `--wrangler-env prod` omits `--env` (top-level config); `dev`
passes `--env dev`. The script refuses to mint a second widget for a hostname
that already has one — that would strand the deployed sitekey against a rotated
secret and fail every claim closed — unless you pass `--force`.

It needs `Turnstile Sites Read`+`Write` on `CLOUDFLARE_API_TOKEN`; without them
the API answers `10000 Authentication error`. Those permissions are in
`infra/create-api-token.sh`'s `WANTED` list — re-running that script updates the
existing `optical-deploy` token **in place, value unchanged**, so the 1Password
item and `.env` keep working. Cloudflare retains the secret, so it stays
readable and rotatable from the Turnstile dashboard afterwards.

Offline unit tests: `uv run bin/test_create_turnstile_widget.py` (fake API and
fake runner; asserts the secret reaches neither stdout nor stderr).

**Dev test-key pair.** Cloudflare publishes an always-passes Turnstile pair for
non-production use — never use it outside dev:

```toml
TURNSTILE_SITE_KEY = "1x00000000000000000000AA"
```
```bash
echo "1x0000000000000000000000000000000AA" | npx wrangler secret put TURNSTILE_SECRET --env dev
```

With the test secret installed, any non-empty token (the smoke harness sends
the literal string `"XXXX.DUMMY.TOKEN.XXXX"`) verifies successfully — dev and
the smoke harness need no real widget render.

`bin/booking-smoke.py` automates this swap for its own runs: it installs the
test secret before B1, runs B1–B9 exactly as shown above, then restores the
real secret in `finally` — `TURNSTILE_SECRET_DEV` in `.env` (from the
1Password item `Turnstile Secret - Dev`). That restore covers any
exception, an assertion failure, or Ctrl-C — but not a `SIGKILL`/`SIGTERM` or
a closed terminal, since the harness installs no signal handler and Python's
`finally` does not run for those. Where the harness can detect the failure
itself it prints a `CRITICAL` line with the exact command to restore the
secret by hand; an abrupt kill prints nothing at all, so after one, check
dev's `TURNSTILE_SECRET` yourself and restore it before trusting the
environment again. The warning below about leaving the test secret installed
"unattended" is about installing it by hand outside of a smoke run, not about
the bracketed run itself.

> **⚠️ The test secret means dev has NO effective challenge. Do not leave
> `BOOKING_PAGE_ENABLED = "true"` on in dev unattended.**
>
> `scheduler-dev.example.com` is publicly reachable, and dev's
> Google account is the operator's real one. With the always-passes secret installed,
> `verifyTurnstile` returns true for *any* non-empty token — no browser, no
> widget, no challenge. Anyone who finds or guesses a dev slug can then claim
> slots straight from `curl`, and each successful claim writes an event to that
> real calendar and makes Google send an invitation, DKIM-signed, from that real
> account, to whatever address the caller supplies (booker addresses are never
> verified). The only remaining brakes are the rate limits — 5 claims per IP and
> 20 per page per 24h — and an IP cap is trivially sidestepped.
>
> The hostname check in `verifyTurnstile` does **not** help here: the testing
> secret answers `hostname: "example.com"` for every caller and flags itself
> with `metadata.result_with_testing_key`, which the function honours precisely
> so the dev pair keeps working. Against a real secret the hostname is always
> enforced.
>
> Turn the flag on in dev only for the length of a smoke run, and turn it off
> again after — or install a real Turnstile secret for the dev hostname instead
> of the test pair. Never use the test pair in prod.

### Configuring a page

`GET /v1/booking-page` / `PUT /v1/booking-page` (owner-scoped bearer, same
`requireOwner` gate as every other `/v1` route: 401 missing/invalid bearer, 403
token carries no subject). They sit behind `BOOKING_PAGE_ENABLED` as well: with
the flag off they return `403 feature_disabled`, checked *after* auth so an
anonymous caller still gets a 401 and learns nothing about which features this
deployment runs. `PUT` patches only the fields supplied; everything
else is left as-is (`worker/src/handlers/booking-page.ts`,
`worker/src/db/booking-page.ts`). Fields:

| Field | Meaning |
|---|---|
| `slug` | Public URL segment. `null` until set — the page 404s with no slug regardless of `enabled`. |
| `enabled` | When `false` the page 404s even with a slug set. |
| `durations_minutes` | Meeting lengths offered. Must be multiples of 15, minimum 15 (Optical's placement grid) — a non-multiple is rejected with `400 invalid_duration`. Offering a 15-minute duration puts slot starts on a 15-minute grid; otherwise they land on the half hour. |
| `hours` | Booking-specific hours (`days`/`start`/`end` in the owner's timezone), or `null` to fall back to the owner's business hours (`config_business_hours`). If that row is missing too, the page falls back to Mon–Fri 09:00–17:00 rather than to no limit at all — offering the whole horizon round the clock is the dangerous direction. **Validated for range, not just shape:** `start`/`end` must be real clock times (`00:00`–`23:59`, `400 validation_failed` otherwise), `days` must be non-empty, and `start` must be strictly before `end` (`400 invalid_hours`). Each used to be a `200` followed by a broken live page, with nothing pointing back at the config: an out-of-range time throws `invalid local datetime` inside `computeAvailability`, so **every `/book/<slug>/slots` call answered `502 calendar_unavailable`** — blaming the calendar for a config the owner had just saved; an empty window merely offered nothing. If you meet a booking page 502ing on every slots call, check `hours` first. |
| `buffer_minutes.before` / `.after` | Padding reserved around each booking, enforced against *other bookings too* (both sides of the overlap guard are buffer-expanded, so the gap between two bookings is `before + after`; offered slots keep that same sum-gap from ALL busy time — a slot ending exactly at a busy start is no longer offered — see §L "frontier cells"). |
| `min_notice_minutes` | No slot is offered sooner than this many minutes from now. |
| `horizon_days` | Days of availability per **page** of the public page (1–120), and all a booker sees until they press "Later →". Each page is one calendar read. |
| `max_horizon_days` | How far a booker may page, in days from now (1–365), or `null` for one page only (the default — the reach equals `horizon_days`, the behaviour before paging existed). Must be ≥ `horizon_days`, checked on the **merged** config so a two-step edit cannot store what a one-step edit is refused for (`400 invalid_horizon`). The last page is clamped to it. Raising it costs nothing until a booker actually pages; see "Paging" above. |
| `bookable_over_movable_meetings` | See "What is offered as bookable" below. |
| `location.modes` | Meeting types offered to the booker, in the order shown; array of `{kind, detail?}`. At least one, at most four (`ALL_KINDS.length`), no duplicate kinds. See "Location kinds and the offered set" below. |
| `event_title` | Calendar event title; `{booker_name}` is replaced with the booker's name. |

### Location kinds and the offered set

The booker chooses how the meeting happens from a set the owner constrains,
not a single fixed mode. Four kinds (`worker/src/booking/location.ts`):

| Kind | `detail` supplied by | What lands on the calendar event |
|---|---|---|
| `meet` | nobody | asks the calendar provider for a Google Meet link (`addMeet: true`) |
| `phone` | booker, at claim time | `Phone: <booker's number>` |
| `in_person` | booker, at claim time | the booker's free-text place — there is no default, and "TBC" is a normal answer |
| `custom` | owner, at config time | the owner's fixed text, verbatim, which the booker cannot change |

**`phone` collects the BOOKER's number, and never publishes the owner's.**
The old single-mode shape put the owner's `location.detail` on the calendar
event for every non-Meet mode — and that event goes out with
`notifyAttendees: true`, so it mailed the owner's own phone number to every
booker. `locationForEvent` (`worker/src/booking/location.ts`) closes this: for
`phone`/`in_person` it only ever reads the detail passed in at claim time,
never anything stored on the offered mode itself — a legacy `phone` entry's
stored `detail` (the owner's own number) is deliberately never consulted here.

**`custom` text is world-readable.** It renders on `GET /book/<slug>` before
Turnstile, to anyone holding the slug — an owner must not put anything
sensitive there.

**Validation.** `PUT /v1/booking-page` rejects a bad `location.modes` array
with `400 invalid_location` (`validateLocationModes`): at least one mode, at
most `ALL_KINDS.length` (4), no duplicate kinds, `custom` must carry a
non-empty `detail`, every other kind must carry none, and any `detail` is
capped at `MAX_LOCATION_LENGTH` — 200 characters, between the 120-char name
cap and the 2000-char note cap: long enough for a street address, short
enough that one calendar location line stays readable. `POST /book/<slug>`
re-validates independently at claim time: a `location_kind` outside
`ALL_KINDS`, or one carrying a `detail` it shouldn't (or missing one it
needs), is `400 invalid_body`; a kind that is well-formed but not in *this*
page's offered set is `400 location_unavailable` — checked before a slot is
reserved, so a rejected claim never has to release one.

**A legacy `{mode, detail}` row is normalised at read time, falling back to
`meet`.** `loadBookingPage` merges the `__default__` row and the owner's row
SHALLOWLY, so migration 0031 could only rewrite the shared default row — a
per-user row written before this feature still holds the old shape, and the
shallow merge would let it clobber the new `modes` field with `undefined`.
`normaliseLocation` (`worker/src/db/booking-page.ts`) maps that legacy shape
onto the new one on every read, and strips a stored `detail` from any kind
that does not own it — so a legacy `phone` row's owner-supplied number does
not survive onto the new shape either. The same function also drops any
offered `custom` mode left with an empty `detail`, so a mode that would
render as a blank option never reaches the picker.

Operational note: migration 0031 and `normaliseLocation` shipped in the same
release and must stay paired. If 0031 were applied to a D1 while the worker
still lacked the normaliser, any owner row holding the legacy shape would read
back with `modes` undefined. Not a live hazard here, but relevant to anyone
reading the history or contemplating a partial rollback.

**Seeded instance defaults** (migration `0030_booking_page.sql` seeds the row,
`0031_booking_location.sql` rewrites its `location` field to the offered-set
shape; row `owner_subject = '__default__'`, used whenever a user has no row of
their own):

```json
{"enabled":false,"durations_minutes":[30,60],"hours":null,
 "buffer_minutes":{"before":0,"after":10},"min_notice_minutes":240,
 "horizon_days":21,"bookable_over_movable_meetings":false,
 "location":{"modes":[{"kind":"meet"},{"kind":"phone"},{"kind":"in_person"}]},
 "event_title":"Meeting with {booker_name}"}
```

**Slug rules.** `^[a-z0-9][a-z0-9-]{1,30}$` — lowercase alphanumeric or hyphen,
2–31 characters total, may not *start* with a hyphen. Reserved words, rejected
outright (`worker/src/db/booking-page.ts`):

```
cal, book, v1, auth, admin, _static, oauth
```

A slug must also be globally unique — `PUT` returns `409 slug_taken` for a
collision, `400 invalid_slug` for anything the regex or reserved list rejects.
Stored slugs are always lowercase, but the public route lowercases the
incoming path segment before lookup, so a booker who mistypes the case in a
retyped URL still resolves.

`GET /v1/bookings?from=<iso>&to=<iso>` (same bearer gate) lists live bookings
(`reserving` or `confirmed`) overlapping the window, ascending by start. Both
bounds must be ISO 8601 datetimes, with either `Z` or a numeric offset; anything
else is `400 validation_failed` from the schema rather than a 500 out of the
date parsing.

### What is offered as bookable

- **Movable task chunks — yes.** Optical's own busy derivation
  (`deriveBusyBlocks`) drops every Optical-owned calendar chunk, movable or
  pinned; that time is not busy from the booking page's point of view, so it is
  offered. This is deliberate — a movable task will simply be replanned around
  the booking on the next resolve.
- **Pinned task chunks — no.** The booking page adds these back as busy
  (`pinnedChunkBlocks` in `worker/src/booking/availability.ts`), because a
  pinned task has no "replan around it" fallback: its committed time must stay
  blocked.
- **External meetings (not Optical-owned) — no.** Ordinary busy time from
  `deriveBusyBlocks`, never excludable.
- **Owned unpinned meetings, only with `bookable_over_movable_meetings: true`
  AND `OWNED_MEETINGS_ENABLED=true`.**
  `worker/src/booking/availability.ts` gates `resolveBookableOverIds` on
  BOTH the per-user `bookable_over_movable_meetings` flag AND the ops
  kill-switch `OWNED_MEETINGS_ENABLED` (`readMeetingConfig(env).enabled`) —
  when the env flag is off, resolves stop re-stamping/clearing
  `movable_verdict` rows entirely, so a lingering fresh `ok:true` verdict must
  not be trusted either. `worker/src/booking/bookable-over.ts` itself then
  requires all of:
  1. `isOwnedMovableMeeting` — the owner organises it and at least one
     non-resource, non-self attendee exists.
  2. Its `tasks` row carries a **fresh, positive `movable_verdict`** — the last
     resolve actually promoted this meeting to the solver as movable. Every
     resolve stamps `body.movable_verdict = {at, ok, reason}` on every meeting
     task in its window (`worker/src/meetings/movable-verdict.ts`): `ok:false`
     with a `reason` for each freeze path (`attendee_availability_unknown`,
     `no_constraining_attendees`, `imminent_notice`, `commit_stability`,
     `no_availability_windows`, `event_missing`), `ok:true` on a genuine
     promotion. A verdict that is
     **absent** (never resolved, or row predates the field), **stale**
     (older than `MOVABLE_VERDICT_MAX_AGE_MS`, 7 days — one full resolve cycle)
     or **negative** all mean *not bookable*. This fails closed by design:
     degrade-to-immovable (§J) is an in-memory decision of one resolve, so
     before the verdict existed a permanently-frozen meeting was indistinguishable
     in D1 from a movable one and its time was offered anyway.
  3. That row is **unpinned** (`pinned_at IS NULL`) and **not terminal**
     (`status NOT IN ('done','cancelled')`, read from the authoritative column,
     not the body's copy) — both checked live and independently of the verdict,
     because both are newer information than the last resolve. A hand-set pin
     means `build-problem` holds the task in place; a done or cancelled row has
     dropped out of the resolve's solver set, so it stops being re-stamped and
     its last `ok:true` verdict would otherwise linger until it aged out.
  4. Its start clears the meeting notice window WITH headroom:
     `now + (MEETING_MIN_NOTICE_MINUTES + RESOLVE_HEADROOM_MINUTES) * 60_000`.
     `RESOLVE_HEADROOM_MINUTES` (60) exists because the resolve that freezes an
     owned meeting as `imminent_notice` uses the exact same
     `MEETING_MIN_NOTICE_MINUTES` boundary — without headroom, a meeting
     starting at precisely `now + notice` could be offered and claimed, then be
     inside the notice window (and frozen) by the time the webhook-triggered
     follow-up resolve runs, permanently double-booking it.
  5. It has no **confirmed** booking of its own already — otherwise a second
     booker could take a slot the first booker already holds.

  Operator note: to see why a meeting is not being offered, read the verdict
  directly — `SELECT json_extract(body,'$.movable_verdict') FROM tasks WHERE
  json_extract(body,'$.source.external_id') = '<google event id>'`.

Existing bookings (`reserving` or `confirmed`) are always subtracted from
availability too, on top of all of the above — regardless of the flag, no
booker can double-book a slot another booker already claimed.

### What happens on a booking

`POST /book/<slug>` runs, in order: a request-body size cap
(`MAX_CLAIM_BODY_BYTES`, 16 KB, checked against `content-length` *before* the
body is buffered or parsed — a real claim is under 3 KB, and this is the one
thing that has to precede the challenge, since verifying it means reading the
token out of the body); Turnstile verification (no DB read, no calendar fetch,
no field validation and no row until the challenge passes); body
validation; a **client-IP check** — a request with no `cf-connecting-ip` is
refused `400 client_ip_required` rather than counted, because hashing the empty
string files every such caller into one constant bucket and turns the per-IP cap
into a global cap of 5 shared by unrelated bookers. Behind Cloudflare the edge
always sets the header and a client cannot forge it; the header is absent only
when the worker is *not* fronted by Cloudflare, which in practice means
`wrangler dev` — **a local `curl` claim now 400s, and that is deliberate**; a
rate-limit check — max **5 claims per IP per 24h** and max **20
claims per page (owner) per 24h** (`MAX_CLAIMS_PER_IP_24H` /
`MAX_CLAIMS_PER_PAGE_24H`, `worker/src/booking/turnstile.ts`; the IP is never
stored raw, only `hashToken(ip, hashingKey(env))`) — returning `429
rate_limited` past either; a fresh, re-computed slot check
against the *server's* availability, never the client's cached list; an atomic
D1 claim (`INSERT ... WHERE NOT EXISTS`, buffer-aware — no Durable Object
needed, a single SQLite statement is the whole mutual-exclusion primitive);
then a Google Calendar `createEvent` with the booker as the sole attendee
(`sendUpdates`/notify on) and a location built by `locationForEvent` from the
booker's `location_kind` against the page's offered set (see "Location kinds
and the offered set" above) — a Meet link for `meet`, otherwise text on the
event's `location` field for `phone`/`in_person`/`custom`.

- **The claim loses a race** (the D1 guard matches an existing row, so
  `claimSlot` returns null) → `409 slot_unavailable`, with a freshly recomputed
  `slots` list so the client can repaint. If *that* recompute cannot read the
  calendar the answer is still `409`, just with the `slots` key omitted — the
  claim has already lost and the guard needed no calendar to know it, so a 502
  would blame the wrong thing and send the client down its generic error path
  instead of the one that clears the selection.
- **Calendar write fails** → the reservation is released (`bookings.status =
  'failed'`) and the slot re-opens; the booker gets `502
  calendar_write_failed`.
- **Calendar write succeeds but the confirm write fails** → the row is left
  `reserving` (**not** released) — the event and invite already exist, so the
  calendar is the truth, and re-offering that time would be worse than one row
  needing a manual look. Booker gets `502 booking_unconfirmed`. Operator
  action: find the `bookings` row by timestamp, confirm the Google event
  exists, and manually set `status='confirmed'` + `google_event_id` to match
  (or delete the row if the event was never actually created).

**The webhook path is identical to any other calendar change**: creating the
event fires the owner's existing calendar webhook, which triggers a resolve.
Because the new event is organiser-self with one attendee, it is picked up as
an ordinary owned meeting on the next import (`isOwnedMovableMeeting` has no
special case for booking-created events) and competes for slots like any other
task.

**A displaced movable meeting or task is never moved automatically. The
calendar genuinely double-books until the owner opens the resulting
proposed-plan email and accepts it** (`POST /v1/plans/<plan_hash>/accept`).
Between the booking landing and that accept, the booker's slot and whatever it
collided with both sit on the calendar at the same time. Say this plainly to
anyone reporting a "double-booked" complaint — it is expected until the next
accept, not a fault.

That reassurance holds only because the displaced thing is one Optical can
actually move: a movable task chunk, or a meeting whose `movable_verdict` was
`ok:true` when the slot was offered. It does **not** cover a meeting the planner
has frozen — there the double-book is permanent, since no future resolve will
propose relocating it. That is precisely why condition 2 above gates on the
persisted verdict rather than on `pinned_at`. If a complaint involves a
collision that never clears after an accept, check the meeting's verdict first:
an `ok:false` verdict on a meeting whose time was nonetheless offered is a bug,
not expected behaviour.

### A booking is never silently relocated

Once a booking becomes an owned-meeting task (above), whether it can itself be
relocated on a later resolve is decided by exactly the same machinery as any
other owned meeting (§J) — there is no booking-specific case anywhere in the
code. What holds a booker's chosen slot in place is **two** rules, and which one
does the work depends on the account's `attendee_enforcement` policy. A fresh
booking's attendee is always `needsAction` (the booker is invited, not asked to
accept, when the event is created):

- **Under the `not_declined` default** — a `needsAction` booker *is* a
  constraining attendee, so their free/busy is queried. For an external booker
  (any address Google can't return free/busy for from this account) it is
  unreadable, so the meeting degrades to immovable, frozen at its slot with an
  `attendee_availability_unknown` warning
  (`movable_verdict.reason = "attendee_availability_unknown"`).
- **Under `accepted` or `accepted_or_tentative`** — a `needsAction` booker is
  *not* constraining, so no free/busy is queried at all and the unreadability
  above never comes into play. The constraining set is **empty**, and an empty
  set is itself a freeze: `movable_verdict.reason =
  "no_constraining_attendees"`. An empty set means nobody's availability is
  known, never that nobody's availability matters.

So a booking is never relocated while its booker has not accepted, whatever the
policy. Once the booker accepts *and* their free/busy is readable (a same-domain
/ shareable address), the booking becomes an ordinary owned movable meeting and
a later resolve may propose relocating it — subject to the usual accept gate, so
the owner sees and approves the move before the booker is notified.

> Regression note: the second rule was added after review found that under an
> accepted-only policy the first one does not apply. The booking was promoted as
> freely movable with a positive verdict, and the planner could email the booker a
> reschedule of the slot they had just picked off a public page. `freezes a
> meeting whose only attendee has not responded, under an accepted-only policy`
> in `worker/test/planning/resolve-meetings.test.ts` guards it.

### Known limitations

- **The ICS feed and the booking page disagree on tentative events.** The ICS
  builder (`worker/src/calendar-feed/build-busy-ics.ts`) treats every
  non-cancelled event as busy, tentative included, with no flag to change that.
  The booking page's availability computation (`deriveBusyBlocks`, shared with
  the planner) respects `TENTATIVE_IS_BUSY` (default `"false"` in both `[vars]`
  and `[env.dev.vars]`), so a tentative event reads as *free* there. Net effect
  at the default: a slot the ICS feed shows as busy can still be offered and
  booked on the booking page.
- **The calendar overlay parser still has known recurrence gaps.** `EXDATE` is
  honoured (see the overlay-parsing note earlier in §K), but `RDATE`, linking a
  `RECURRENCE-ID` override back to its parent series (a moved occurrence
  double-counts), and `FREQ=MONTHLY`/`FREQ=YEARLY` expansion are not. All three
  over-report rather than under-report.
- **Deleting a booking's calendar event by hand leaves its `bookings` row
  `confirmed`.** The row is the source of truth for slot availability (it is
  subtracted in `computeAvailability` regardless of calendar state), so a
  hand-deleted event alone does **not** re-open the slot — delete the row too.
  Confirm you have the right row first (binding `DB`, not the database name
  `scheduler-dev` — the dev database is only defined under `[env.dev]`, so the
  bare name doesn't resolve):

  ```bash
  op run --env-file=.env -- npx wrangler d1 execute DB --env dev --remote \
    --command "SELECT * FROM bookings WHERE google_event_id = '<event-id>'"
  ```

  then

  ```bash
  op run --env-file=.env -- npx wrangler d1 execute DB --env dev --remote \
    --command "DELETE FROM bookings WHERE google_event_id = '<event-id>'"
  ```

- **`GET /book/<slug>/slots` is unauthenticated, unchallenged and
  unthrottled — and every call triggers a live Google Calendar fetch.**
  Unlike `POST /book/<slug>`, the slots handler never calls `verifyTurnstile`
  or either rate-limit counter (`worker/src/booking/route.ts`); it goes
  straight from the `duration` check to `computeAvailability`, which calls
  `cal.fetchEventsInWindow`. Anyone who has (or guesses) a valid slug can drive
  unbounded Google Calendar API calls and worker CPU against that owner's
  account. This is forced by the design — the page has to show slots *before*
  a booker is challenged — so it is an accepted exposure in this iteration, not
  a bug to fix here. Mitigating it would need a cache in front of
  `computeAvailability` or a read-path rate limiter; neither exists yet.

- **A confirm-path failure can strand a `bookings` row in `reserving`
  indefinitely.** As described above, when the calendar write succeeds but
  `confirmBooking` then fails, the row is deliberately left `reserving` (it
  matches the calendar state and keeps the slot blocked) and the route logs
  the booking id and event id and returns `502 booking_unconfirmed`. Nothing
  reaps these rows automatically. Find candidates with (binding `DB`, not the
  database name — see the note above):

  ```bash
  op run --env-file=.env -- npx wrangler d1 execute DB --env dev --remote \
    --command "SELECT id, owner_subject, slug, start_utc, created_at FROM bookings WHERE status = 'reserving' AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes')"
  ```

  `google_event_id` is **always `NULL`** on a `reserving` row — only
  `confirmBooking` ever sets it, together with `status='confirmed'`, so the
  column gives no signal here. **Check the calendar first, not the column:**
  `confirmBooking` only ever fails *after* `cal.createEvent` already succeeded,
  so the code's own invariant is that the event almost certainly exists — find
  it on the owner's calendar around `start_utc` (search by the booker's email,
  or by the `optical_booking` extended property matching the row's `id`), then
  set `status='confirmed'` and `google_event_id` to match by hand. Only delete
  the row if a real search of the calendar around that time turns up nothing.

- **The rate-limit counters (`countRecentByIp`, `countTodayByOwner`) are
  read-then-insert, not atomic** — each `POST /book/<slug>` reads both counts,
  compares against `MAX_CLAIMS_PER_IP_24H`/`MAX_CLAIMS_PER_PAGE_24H`, and only
  *then* inserts the reservation. Concurrent requests can each observe a count
  under the cap and all proceed, so the true count can overshoot the limit —
  bounded by however many requests raced, not unbounded. Do not be alarmed by
  a handful of bookings slightly over either cap in a short window; that is
  this race, not a broken limiter.

- **The 404s are opaque, but the timing is not.** Feature-off, unknown-slug
  and disabled-page all return the same byte-identical 404 body, but
  `resolvePage` (`worker/src/booking/route.ts`) does 0, 1 and 3 D1 queries to
  reach each of those three outcomes respectively (0: the env flag check short
  circuits before any query; 1: `findOwnerBySlug` misses; 3: `findOwnerBySlug`
  hits plus the two parallel reads inside `loadBookingPage`). Slug existence is
  therefore in principle observable by response timing. Accepted, not
  mitigated.

- **Booker `name` and `note` are stored raw and sanitised only on the way to
  Google.** They are length-capped at 120 and 2000 characters
  (`MAX_NAME_LENGTH`/`MAX_NOTE_LENGTH`), and the copy that reaches the calendar
  event title/description goes through `sanitiseForCalendar`
  (`worker/src/booking/route.ts`): angle brackets and control characters are
  stripped, and the title additionally collapses newlines and runs of
  whitespace to a single line. That is deliberately narrow — Google renders a
  limited HTML subset in event descriptions, so an unstripped `<a>` in a note
  becomes a live link in an invitation sent from the owner's account. **The
  `bookings` row keeps the text exactly as submitted**, so the owner sees what
  the booker really typed. Consequence: anything added later that renders the
  stored values anywhere else (an admin UI, a digest email, a log viewer) must
  escape them itself — the D1 copy is raw and nothing upstream escapes it.

- **The booker's email address is never verified.** The claimant chooses who
  receives the invitation, and Google sends it from the owner's own account,
  DKIM-signed. Sanitising bounds what that message can *say*; it does not stop
  it being addressed to a stranger. `event_title` still defaults to `"Meeting
  with {booker_name}"` — keeping booker-authored text in the subject line is a
  deliberate product call, and the sanitising above is what makes it safe. The
  real fix is emailing a confirmation link to the address before writing the
  event; it is deferred, not done.

### Smoke

```bash
op run --env-file=.env -- uv run bin/booking-smoke.py > /tmp/booking-smoke.out 2>&1
# Microsoft, against dev (with the Microsoft provider enabled there):
op run --env-file=.env -- uv run bin/booking-smoke.py --provider microsoft > /tmp/booking-smoke-microsoft.out 2>&1
```

Required env: `SCHEDULER_URL`, `A_BEARER`, `A_REFRESH`, `A_EXPECTED_EMAIL`,
`TURNSTILE_SECRET_DEV` (`A_CLIENT_ID` optional, defaults to `smoke-cli`).
`--provider` (`google`/`microsoft`, default `$SMOKE_PROVIDER` or `google`)
picks the calendar client the F2-equivalent public-page flow runs through and
is checked against `GET /v1/whoami` in preflight, before the Turnstile secret
is ever swapped. `--wrangler-env` (only `dev`, the default) picks the
deployment: it selects `TURNSTILE_SECRET_DEV` to restore after the harness's
test-secret swap (see "Dev test-key pair" above) and pins the direct-D1
cleanup to dev's own database (`assert_smoke_db`). Redirect to a file as
shown — smoke output in this repo is verbose enough to overflow terminal
buffers.

The claim step sends a `location_kind` — `POST /book/<slug>` now requires one
— so the harness exercises the offered location kinds as part of claiming a
slot.

Optional: `D1_DATABASE_ID` (dev's own db, `scheduler-dev`) plus
`CLOUDFLARE_API_TOKEN`
enable the harness to delete the `bookings` row it creates directly via
`wrangler d1 execute` in its cleanup step. **Without `D1_DATABASE_ID` the
harness cannot delete that row itself** — it prints the manual `wrangler d1
execute ... DELETE FROM bookings WHERE id = '<id>'` command instead and reports
the row as NOT cleaned up in its `CLEANUP` summary. An operator who skips that
manual step leaves a `reserving`-turned-`confirmed` row behind that permanently
blocks the `smoke-book` slot it claimed (same failure mode as the stuck-row
limitation above) — always check the `CLEANUP — NOT cleaned` list at the end
of the run and act on it.

Needs the credential env vars that only exist in the operator's shell — do not
attempt this from an agent session; hand the command to him instead.

## L. Meeting polls

An organiser proposes a duration + candidate date range for a meeting; invitees
paint their availability (free / if-needed) on a public grid page, no sign-in
required; the poll auto-books the best slot once everyone has responded, or at
its deadline against whoever has. Booked events are ordinary calendar meetings
— not `tasks` rows, and not movable by the owned-meetings feature regardless
of `OWNED_MEETINGS_ENABLED` (see "Immovability mechanism" below).

### Enabling the feature

**Gate flag (per-env, in `wrangler.toml`):**

```toml
# Under the target environment's [vars] block (e.g. [env.dev]):
MEETING_POLL_ENABLED = "true"
```

Default OFF (unset). Prod stays off; dev is on. The two route families gate
differently while the flag is off:

- **`/poll/*`** (the invitee-facing page, grid, join, and organiser status
  page — a mix of unauthenticated and bearer-authenticated handlers, see
  "Organiser status page" below) — every handler returns a plain **404**
  (`worker/src/polls/route.ts:129` `flagOn`, checked at each handler, e.g.
  `:379`, `:571`, `:794`). This is deliberate: a disabled feature must look
  identical to a poll id that never existed, not leak its own existence via a
  different status code.
- **`/v1/polls*`** (the organiser API — note the path is `/v1/polls`, not
  `/v1/meeting-polls`; `POST /polls`, `GET /polls/{id}`, `POST
  /polls/{id}/nudge`, etc., mounted under `/v1`) — returns **403**
  `{error:"feature_disabled"}` (`worker/src/handlers/polls.ts`, the
  `feature_disabled` guard in the poll route handlers).

The flag also gates the hourly cron sweep
(`worker/src/cron/scheduled-entry.ts:93` — the sweep is a no-op tick when off,
not an error).

**Enablement steps (dev):**

```bash
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
```

Migrations 0033 and 0034 (guest-join rate limiting; see "Guest joins" below)
must land before deploy, same as any other migration — they auto-apply in
sequence via `d1 migrations apply`. No new OAuth scope is required — meeting polls
use the notification/calendar providers already wired up for booking pages,
so existing accounts need no re-consent.

### Cron sweep behaviour (`worker/src/cron/poll-sweep.ts`)

The hourly sweep has its **own dedicated cron trigger** — `"0 * * * *"` is a
separate entry in both `[triggers]` (prod, `worker/wrangler.toml:106`) and
`[env.dev.triggers]` (dev, `worker/wrangler.toml:241`), alongside (not
sharing) the `"0 4 * * *"` daily-cleanup entry. `scheduled-entry.ts` dispatches
on `event.cron === POLL_CRON` as its own branch (`worker/src/cron/scheduled-
entry.ts:25,90`), distinct from `CLEANUP_CRON`. **If you ever need to change
the poll-sweep cadence, edit the `"0 * * * *"` line, not the `"0 4 * * *"`
one.** The sweep walks every subject's `open` polls whose deadline has passed
or whose nudge cadence is due:

- **Deadline fallback.** Once `now >= deadlineUtc`, the poll is booked against
  whoever responded (dropped invitees and non-responders excluded from the
  candidate ranking) — see "Booking semantics" below. A poll with zero
  responders at its deadline escalates instead of booking nobody's slot.
- **Nudges.** Two cadences, both idempotent per poll episode (re-armed by an
  `updateMeetingPoll{deadlineUtc}` deadline extension — see below):
  - **deadline − 24h**, for every poll **except one created inside that
    window** — i.e. whose `createdAt` is already at or after
    `deadlineUtc − 24h`. That poll's invite already carries the urgency, and
    the invite link was just minted; firing a nudge on the next hourly tick
    would re-mint-and-store the invitee's token (`mintAndStoreInviteeUrl`),
    killing the link that email just sent (a real dev-run failure — see
    the internal backlog's "poll created inside the 24h nudge window" card). The
    guard compares `createdAt` against `deadlineUtc − 24h` on every sweep —
    it is computed, not stamped, so it can't re-arm on its own, but it still
    composes with an `updateMeetingPoll{deadlineUtc}` extension: if the
    extension pushes `deadlineUtc − 24h` past `createdAt`, the poll becomes
    eligible for a real final nudge at the new deadline.
  - **lifetime midpoint**, only for polls whose lifetime (`createdAt` to
    `deadlineUtc`) exceeds 7 days.
  Neither cadence fires until the poll is at least `MIN_NUDGE_AGE_MS` (6h)
  old, regardless of the window/lifetime math — an ordinary poll (e.g. a
  24h05m lifetime) is born just *outside* the deadline−24h window above, so
  the born-inside-window guard alone doesn't catch it, and without this floor
  it would still final-nudge (and rotate the invitee's token) minutes after
  its invite email went out. Vacuous for the midpoint cadence in practice
  (its earliest possible firing is `createdAt + 3.5d`, always past 6h) — kept
  anyway as cheap, self-documenting defence-in-depth. Same computed-not-
  stamped, deadline-PATCH-composing shape as the window guard.
  A poll first swept late enough for both cadences to be due at once (e.g.
  after downtime) gets ONE combined nudge email per non-responder, not two.
- **Failure isolation.** Each poll is swept in its own try/catch; one poll's
  failure (a throwing booking attempt, a bounced notification) is logged and
  counted, never aborts the sweep for the rest of that tick.

### Booking semantics

- **All-in auto-book.** The moment every non-dropped invitee has responded at
  least once, `maybeBookOnAllIn` ranks candidate slots and books the best one
  immediately — it does not wait for the deadline or the cron tick.
  **Exception — guest-link polls wait for the deadline regardless.** If the
  poll's `guestTokenHash` is set (i.e. `createMeetingPoll` was called with
  `guestLink: true`) and the poll is still `open`, `maybeBookOnAllIn` returns
  without booking OR escalating (`worker/src/polls/booking.ts:643`) — even
  once every named invitee has responded. Escalating would flip status away
  from `open`, which would foreclose guest joins just as early as booking
  would; only the deadline (`bookAtDeadline`) is allowed to close out a
  guest-link poll while it's `open`. This applies to both trigger paths that
  call `maybeBookOnAllIn` — `PUT /poll/:id/response`'s all-in check AND
  `updateMeetingPoll`'s invitee-removal re-attempt (`removeInviteeIds`) — so
  removing the blocking invitee on a guest-link poll does not force an early
  book either. The guard is scoped to `status === "open"` only: once a
  guest-link poll is already `needs_attention`, joins are already impossible
  (guests can only join an `open` poll), so the removal rescue path proceeds
  normally there. **Practical effect: the organiser only learns whether a guest-link
  poll's responses intersect at the deadline** — there is no early
  escalation email to warn of a disjoint set while there's still time to act.
  An organiser who wants to book earlier than the deadline must do so
  explicitly via `resolveMeetingPoll {action:"book", slotStartUtc:...}` or
  `{action:"bookBest"}` (see below) — both bypass this guard entirely
  (different code paths, neither gated by `guestTokenHash`). The wait has no
  revocation switch once the guest
  link is minted — even after `MAX_GUESTS_PER_POLL` (20, see "Guest joins"
  below) makes further joins impossible in practice, `guestTokenHash` stays
  set on the poll row and the guard keeps applying until the deadline.
- **Deadline fallback books best-among-responders, and now re-validates its
  own due-ness.** At the deadline, only invitees who actually responded (and
  aren't dropped) constrain the ranking; non-responders are excluded from
  time-choosing but are still invited to the booked event (see "Attendee
  list" below). `bookAtDeadline` re-checks `now >= deadlineUtc` against a
  freshly-fetched poll row (`worker/src/polls/booking.ts:687`), rather than
  trusting the cron sweep's due-ness snapshot — the sweep snapshots its
  `open`-and-due poll list once before looping, and earlier polls in that
  same tick can take multi-second calendar round-trips, so by the time a
  later poll's `bookAtDeadline` call runs, an intervening
  `updateMeetingPoll{deadlineUtc}` call could have pushed its
  deadline out. Without the re-check, that poll would book anyway against
  the stale snapshot — silently overriding the organiser's extension, and,
  for a guest-link poll, foreclosing exactly the joins the guard above exists
  to protect.
- **Empty intersection escalates, never books a bad slot.** If no candidate
  slot satisfies every required invitee (or, at the deadline, there are zero
  responders), the poll flips to `needs_attention` and the organiser gets an
  escalation email with near-miss slots (each: "works if you drop X"). The
  poll is never auto-booked into a slot that doesn't actually satisfy the
  ranking.
- **The grid never offers a slot the claim would then reject (W1, fixed
  2026-08-17, corrected 2026-08-17 after an adversarial review refuted the
  first fix).** `candidateStarts` used to widen an existing busy block (or
  bookings row) by `before` minutes on its leading edge and `after` minutes
  on its trailing edge — swapped from the minimal correct rule for raw busy
  time, and worse, ignoring how `claimSlot`'s own overlap guard actually
  behaves against a bookings row: both callers pass a guard already padded by
  the candidate's own before/after, and `claimSlot` then re-pads THAT guard
  by before/after again — the two paddings compose, so the real clearance a
  bookings row requires on *either* side of a candidate is `before + after`,
  not `before` or `after` alone, and (a first fix here got this wrong too)
  not `max(before, after)` either, since `max() < before + after` whenever
  both are non-zero. Live-D1-verified: `{before:15, after:10}`, an existing
  row 01:45-02:15Z — a candidate ending 01:00Z (15-min gap, exactly
  `max(before,after)`) is offered by a max()-based grid but `claimSlot`
  still returns null; only a 25-min gap (`before+after`) actually clears.
  Before either fix, the grid offered a start the claim always rejected,
  silently, as `slot_taken`; for a poll this meant a real (if unlucky)
  candidate got walked into the ranked list, failed its claim, and could
  exhaust the walk into a spurious `needs_attention` escalation with no
  genuinely bookable candidate ever tried (live: HIDDEN poll `p_930ec249`,
  `before:0`/`after:10`, two frontier candidates both died this way — that
  specific case happens to survive both the max() and sum() fixes, since one
  buffer was 0). The fix expands EVERY busy block (raw calendar busy and
  bookings rows alike — the grid has no way to tell them apart by the time it
  sees a flat `busy` list) by `before + after` on both sides, so a start the
  grid offers is never one `claimSlot` then refuses; it deliberately
  over-suppresses busy-adjacent (non-booking) slots by `min(before, after)`
  per edge — zero under the shipped default `{before:0, after:10}` — as a
  simplicity trade-off rather than tracking which busy source needs which
  rule. A slot ending exactly at a busy start (or starting exactly at a busy
  end) is no longer offered once `before != after`.
- **`needs_attention` is not terminal.** The organiser can `book` a specific
  slot or `bookBest` (book whoever's in, no slot picking — see below) via
  `resolveMeetingPoll`, or edit the poll via `updateMeetingPoll`: removing an
  invitee (`removeInviteeIds`) re-attempts auto-book, and extending the
  deadline (`deadlineUtc`) reopens the poll to `open` and starts a new
  response episode — see "`updateMeetingPoll`" below.
- **`resolveMeetingPoll {action:"bookBest"}` — book the best slot for
  whoever has responded, right now, without picking a slot yourself.** Ranks
  candidates against exactly `bookAtDeadline`'s required-set rule (non-dropped
  invitees with at least one response — factored into one shared helper in
  `worker/src/polls/booking.ts` so the two can't silently diverge) and books
  the top workable slot via the same `bookPollSlotInternal` walk every other
  booking path uses, so the booked event's attendee list, hidden-invitee
  notice, and organiser notification are all identical to any other booking
  path — non-responders are ranked out but still invited. Fires on `open`
  *and* `needs_attention` (a rescue, same posture as `book`), ignores the
  guest-link wait (an organiser override, not an automatic trigger), and
  ignores the deadline entirely — that's the point. **On failure it never
  escalates.** Unlike the all-in and deadline paths, a `bookBest` that finds
  no qualifying slot (`no_qualifying_slot`), loses a race to a concurrent
  booking (`poll_already_claimed`), or finds the poll itself went terminal
  mid-walk (booked/cancelled by something else while `bookBest` was still
  working — `poll_not_actionable`) leaves the poll's status exactly as found
  — `open` stays `open`, `needs_attention` stays `needs_attention` — and
  sends no escalation email; the failure is reported in-band via the HTTP
  response (400 `no_responders`, 409 `book_failed` or `invalid_status`, or
  502 `calendar_unavailable`) instead. Escalating on a synchronous,
  exploratory "try booking now" would be a surprising side effect: it would
  freeze future auto-book (a save on an escalated poll never auto-books) and
  kill a live guest-join link (joins need status `open`), neither of which
  the organiser asked for by trying `bookBest`. Zero responders is a 400
  `no_responders` — unlike `bookAtDeadline`, which escalates on zero
  responders, `bookBest` never escalates at all (same reasoning).
  **A calendar-write failure aborts immediately, unlike a candidate-read
  failure or the all-in/deadline paths.** `resolveMeetingPoll{action:"book"}`'s
  502 is always a *read* failure (candidate re-check before the single slot
  the caller specified). `bookAtDeadline`/`maybeBookOnAllIn` keep walking
  ranked candidates past a transient calendar-*write* failure — a later
  candidate succeeding is exactly what those automatic paths want, and this
  is unchanged. `bookBest` is the one path that aborts on the FIRST such
  write failure (502 `calendar_unavailable`) instead: without this, a
  provider write outage made `bookBest` claim → create → fail on EVERY
  ranked candidate in a single HTTP request (confirmed PoC: 80 `createEvent`
  calls, ~161 provider round-trips for one request), reporting the
  misleading `no_qualifying_slot` instead of the real outage, and risking the
  Workers subrequest budget on a long poll range.
- **`needs_attention` unlocks invitee edits — it does not freeze the poll.**
  Both `GET /poll/:id/grid` and `PUT /poll/:id/response`
  (`worker/src/polls/route.ts:520`, `:548`) treat `needs_attention` the same
  as `open`: an invitee's existing link keeps working, and they can keep
  revising their painted availability, for as long as that link is valid
  (the same deadline+7-day-grace token lifetime as any other invitee link —
  once past that, the link is unreachable regardless of poll status, which
  is the existing posture, not something this changes). What's different
  from `open` is what a save does next: `PUT /response` only fires
  `maybeBookOnAllIn` when the poll is (freshly re-read as) `open`
  (`worker/src/polls/route.ts:669`) — a save on an escalated poll is
  persisted but never triggers an auto-book. The poll still doesn't need a
  human in the loop for every resolution, though: besides the organiser's
  manual `resolveMeetingPoll` call, `updateMeetingPoll` can also resolve it —
  a removal that actually drops a row, or disabling the guest link, fires
  the same best-effort booking re-attempt as the old `dropInvitee` did (see
  "`updateMeetingPoll`" below), and a deadline extension reopens the poll to
  `open` outright, starting a new response episode. A save by itself is
  simply never enough. The handler re-reads status immediately before firing that check rather
  than trusting the snapshot `resolveInvitee` captured at the top of the
  request, because a sibling invitee's save can escalate the same poll in
  the window between them (review finding B-R1) — this narrows the race to
  the much smaller gap between that re-read and `maybeBookOnAllIn`'s own
  internal re-read, it does not close it; a poll could in principle still
  escalate in that residual window and get one further all-in attempt
  against it. Accepted, not fixed further — same class of micro-window as
  the other timing gaps in this section. Separately, the deadline-passed 409
  in `PUT /response` (`worker/src/polls/route.ts:556`) is gated to
  `status === "open"` only: it exists solely to stop an `open` poll's
  invitee from racing the cron's `bookAtDeadline` in the up-to-~59-minute
  window between a passed deadline and the next hourly sweep, and a
  `needs_attention` poll has no pending `bookAtDeadline` to race, so there is
  nothing for that 409 to protect there.
- **Manual nudge stays closed on `needs_attention`, by design — the unlock
  above doesn't extend to it.** `POST /v1/polls/{id}/nudge` still 409s
  unless `status === "open"` (`worker/src/handlers/polls.ts:709`). Reasons
  this remains a gate even though the grid/response paths unlocked: nudge
  only emails *non*-responders, and an escalated poll typically has none
  left to chase; it rotates each non-responder's capability token, which
  would kill the very links the escalation email just told the organiser
  still work; and the sanctioned way to re-open or re-deliver links on an
  escalated poll is `updateMeetingPoll{deadlineUtc}` (a deadline extension),
  not nudge.

### `updateMeetingPoll` (`PATCH /v1/polls/{id}`)

The organiser-facing edit endpoint: change the title, location, or deadline,
add/remove invitees, or toggle the guest-join link. `extendDeadline` and
`dropInvitee` used to live under `resolveMeetingPoll` — they moved here
outright (see internal design notes), since they're edits to the
poll, not booking-resolution actions; `resolveMeetingPoll` now only takes
`book`/`bookBest`. There are no aliases — a caller still sending
`resolveMeetingPoll{action:"extendDeadline"}` or `{action:"dropInvitee"}`
gets a 400 (the actions are gone from `ResolveBody`'s discriminated union).

**Request body** — every field optional, at least one required (400
`no_changes` on an empty body):

```jsonc
{
  "title": "…",                                  // 1..200 chars, same rule as create
  "location": { "kind": "…", "detail": "…" },     // validatePollLocation, whole-object replace
  "deadlineUtc": "…",                             // strictly after the current deadline; validateDeadline (1h floor, ≤ 23:59 rangeEnd)
  "addInvitees": [{ "email": "…", "name": "…" }], // restore-if-dropped; 400 duplicate_invitee against an existing non-dropped email or an in-batch duplicate
  "removeInviteeIds": ["pi_…"],                   // by invitee id (same addressing as the old dropInvitee); unknown id -> 404 invitee_not_found; already-dropped id -> 200 no-op
  "guestLink": true | false                       // toggle; true-when-enabled or false-when-disabled is a no-op
}
```

**Status gate**: editable while `open` or `needs_attention`; 409
`invalid_status` on `booked`/`cancelled` (checked up front, and again via
`casSetPollStatus` on the deadline arm, so a booking landing concurrently
wins over the extension). Only a deadline change flips `needs_attention`
back to `open` (+ clears the per-episode nudge/escalation stamps) — every
other edit leaves status alone. An invitee added to an escalated poll can
paint (the grid stays unlocked for `needs_attention`, see "Booking
semantics" above) but a save there still never auto-books; the organiser
resolves manually or extends the deadline, same as today.

**Validation is all-or-nothing**: every supplied field is validated before
any write; any single failure 400s the whole request with nothing written.
The post-patch non-dropped invitee count (existing − removals + additions +
restores) must stay ≤ 20 (the same cap `createMeetingPoll` enforces), else
400 `too_many_invitees`. That count includes guest-joined rows, not just
named invitees — a poll whose guest link has already attracted a full house
of joiners can hit the cap on an `addInvitees` PATCH with room seemingly
left on the roster. This is deliberate, not an oversight: the cap bounds
*required attendees*, and a guest who joined is a required attendee exactly
like any named invitee (see "Attendee list on the booked event" below).
Re-adding a previously removed/dropped email
**restores** that row (same invitee id, painted cells intact) rather than
hitting the `UNIQUE(poll_id, email)` constraint — an id removed and
re-added by email in the *same* call nets out as a deliberate re-invite
(fresh token, one invite email).

**Apply order**: removals → additions/restores → title/location/guestLink →
deadline last, so an added invitee's invite email already renders the final
(possibly just-extended) deadline. All DB writes commit before any email
sends; sends are per-recipient, non-fatal, logged by invitee id never
address (the established R1-F6 posture).

**Booking re-attempt**: if any removal actually dropped a row, or the guest
link was disabled (lifting the "Booking semantics" wait-for-deadline guard
above), the handler fires ONE best-effort `maybeBookOnAllIn` at the end
(failure swallowed, same as the old `dropInvitee` behaviour), then re-reads
the poll so the response reflects a booking that just landed.

**The least-email principle governs every arm** — people with existing links
are never disturbed and their links keep working, except where token
mechanics force otherwise (the deadline arm):

| Change | Who gets emailed |
|---|---|
| Add invitee | The new invitee only (normal invite email, personal tokenised link) |
| Restore a dropped invitee | The restored invitee only (invite email, fresh link) |
| Remove invitee | The removed invitee only (a new, polite removal notice — no poll link, since theirs is now dead) |
| Change location | Nobody. Location surfaces only at booking time (the booked event + booking-notice emails; the invitee grid page and invite/nudge emails never show it), so anyone reaching a booking sees the new value automatically |
| Change title | Nobody. Invitees see it on next page load |
| Enable/disable guest link | Nobody |
| Extend deadline | Every non-dropped invitee (deadline-extended email + re-issued link) — **except** invitees added in the same PATCH call, whose invite email already carries the new deadline |

The organiser is never emailed by this endpoint — they made the call; the
API response is the confirmation.

**Response** (200): the poll's post-patch, re-read state — `id`, `status`,
`title`, `deadlineUtc`, `location`, `bookedSlotUtc`, `gcalEventId`, and
`invitees` (same `InviteeSummary` shape as `getMeetingPoll`), plus
`guestUrl` — present **only** when this call newly *enabled* the guest link
(see the carried-forward edge below).

**Known edges carried forward from before this endpoint existed:**
- The organiser's status-page token is **not** re-minted on a deadline
  extension — see "Link rotation and re-issue" below. A saved `statusUrl`
  link still expires at the *original* deadline + 7 days regardless of how
  many times the poll is later extended; the bearer/MCP path on the same
  route (`GET /poll/:id/status` with no `?t=`) is unaffected.
- **Enabling an already-enabled guest link cannot return the URL; a
  disable-then-enable rotates it.** Guest-link creation stores only the
  token's *hash*, never the raw token, so there is nothing to hand back on
  a no-op re-enable (`guestLink:true` when already enabled is a no-op, no
  `guestUrl` in the response, hash unchanged). `guestLink` is a single
  boolean, so one PATCH cannot both disable and re-enable it — getting a
  fresh, retrievable guest URL is a two-PATCH operation: one call to disable
  it (`guestLink:false`, which NULLs the hash), then a later call to enable
  it again (`guestLink:true`, which mints a new one and returns it).
- **A removed invitee's painted cells persist, excluded from aggregates; a
  restore revives them.** Removal only flips `dropped`; nothing in
  `poll_responses` is deleted. The dropped-filter that already excludes
  dropped invitees from ranking/aggregates (`db/polls.ts`'s `dropped = 0`
  filters, the required-set computation in `handlers/polls.ts`) is what
  makes the removal take effect — restoring the same email later brings the
  same invitee id, same painted cells, straight back into consideration.

### Organiser status page (`GET /poll/:id/status`)

An HTML page showing everything about a poll: every invitee's roster entry
(display name, hidden-invitee pseudonym, responded/dropped state), the
per-cell aggregate (who painted what, real names — organisers never see
pseudonyms), and — while `open` — the current live-ranked candidate slots
(`worker/src/polls/route.ts:793-830`).

**Aggregate rendering: icons under a two-tier header, not per-cell text**
(`worker/src/web/poll-status-page.ts`'s `aggregateTable`). Each invitee's row
shows a checkmark (`✓`, free) or a half-circle (`◐`, if-needed) per cell
instead of the word; a `<p class="legend">` below the table spells both out
once. The column header is two rows — a colspanned UTC date row above a row
of time-only labels per cell — rather than the old single row that repeated
the full `YYYY-MM-DD HH:MM UTC` string in every column: that repetition
pinned each column's width to its longest label regardless of how narrow an
icon cell actually needs to be, which is what made the table wider than it
needed to be. Two variants of each icon exist for accessibility: the table
cells use the labelled variant (`role="img"` + `aria-label`, since a bare
`<span>` has no implicit ARIA role for the label to attach to), while the
legend uses a separate `aria-hidden` decorative variant with no
`aria-label` — otherwise the legend's own icons would double-announce
right next to their spelled-out "free"/"if needed" text.

The page accepts **either of two independent auth paths** (`worker/src/polls/
route.ts:861-895`):

- **A `?t=<token>` capability token** — the `statusUrl` `createMeetingPoll`
  returns is `${OAUTH_ISSUER}/poll/${pollId}/status?t=${token}`
  (`mintStatusToken`/`statusUrlFor`, `worker/src/handlers/polls.ts:113-123`).
  The token carries `purpose:"poll-status"`, is bound to `pollId` + the
  organiser's `subject`, and its TTL is the same deadline+7-day-grace formula
  as invitee tokens. It is **not stored or rotatable** like invitee tokens —
  the status page is read-only, so there is nothing to invalidate on reuse
  (`worker/src/handlers/polls.ts:108-111`). `resolveStatusToken`
  (`worker/src/polls/route.ts:175-185`) verifies the signature + expiry, the
  purpose/pollId binding, AND re-checks ownership against the DB
  (`getPollForSubject`) rather than trusting the token's claimed subject
  alone. This is what makes `statusUrl` directly clickable in a browser (a
  plain navigation can't carry an `Authorization` header) — the query param
  takes priority when present.
- **`requireOwner`** (bearer + subject, no `?t=` present) — the same gate
  `/v1/polls*` uses, for the MCP/curl path.

Both paths resolve through the same ownership check, so a poll id that exists
but belongs to a different subject 404s either way — never a 403 that would
confirm the id's existence to the wrong caller.

**`guestUrl`** (also returned by `createMeetingPoll`, only when the request
set `guestLink: true`) is different: it's `${OAUTH_ISSUER}/poll/${poll.id}?
g=<guestToken>` and *is* meant to be shared/clicked — no auth header needed.
Opening it renders the join form (`renderPollJoinFormPage`,
`worker/src/polls/route.ts:403-411`), which POSTs to the Turnstile-gated,
per-IP-rate-limited `/poll/:id/join` (see "Guest joins" below) to get the
visitor their own personal per-invitee link by email.

### Attendee list on the booked event

Per the operator's binding wave-3 decision: **all non-dropped invitees are required
attendees** on the booked calendar event, including guests and deadline
non-responders (`worker/src/polls/booking.ts` — the attendee objects carry no
`optional` field, so they default to required). The deadline fallback only
excludes non-responders from *choosing* the time; it does not exclude them
from the invite.

**Exception — hidden invitees.** An invitee who checked "hide my name from
other people voting on this poll" is *excluded* from the event's attendee
list entirely (their email would otherwise leak on the calendar invite to
every other attendee, defeating the point of hiding). Instead, once the event
is confirmed, they get a private booking-notice email with a minimal
`METHOD:PUBLISH` `.ics` attachment (BCC-equivalent — Google Calendar has no
real BCC for event invites). Trade-off, accepted for v1: no RSVP tracking for
that invitee, and no automatic update if the event is later changed. This is
acceptable because poll-booked meetings are never relocated (next section) —
there is nothing for them to miss an update about. An all-hidden poll books
with zero attendees on the calendar event; that is correct, not a bug.

**Related, accepted v1 limitation: Google Meet knock-to-enter.** When the
poll's location kind is `meet` (`worker/src/booking/location.ts` —
`addMeet: true` on the created event), being off the attendee list can also
mean a hidden invitee is not auto-admitted to the Meet call: Google Meet's
knock-to-enter gating gives automatic entry to attendees on the invite, so a
hidden invitee may have to knock and wait to be let in — or be missed
entirely if no one is watching the waiting room — despite having voted for
the meeting. They still get the booking-notice email with the `.ics`
attachment, which carries the meeting's details, but not automatic Meet
admission. Accepted alongside the BCC trade-off above for the same reason:
fixing it would mean putting their real email back on the attendee list.

### Organiser notifications

The organiser gets emailed at two points beyond the escalation email covered
in "Booking semantics" above:

- **On a successful booking** (`renderPollBookedEmail`,
  `worker/src/polls/emails.ts`) — sent from `bookPollSlotInternal`
  (`worker/src/polls/booking.ts`), strictly after `confirmBooking`, the same
  placement as the hidden-invitee booking-notice email; the content build AND
  the send both happen inside one try/catch, so nothing after `confirmBooking`
  can throw out of `bookPollSlotInternal` uncaught (a booking that actually
  succeeded must never surface as a 500, with a retry then hitting a 409
  because the poll is already booked). One call site covers every booking
  path (all-in, deadline fallback, manual `resolveMeetingPoll` book), since
  they all route through this function. States the slot (in the organiser's
  own timezone, reusing the `availability.tz` already resolved for the live
  feasibility re-check — no extra DB read), duration, and location — for a
  Google Meet booking this reads "Google Meet (link is on the calendar
  event)" rather than a URL, since Meet's own join link is minted
  asynchronously by Google and isn't known at this point. Lists who's on the
  calendar invite versus who was notified privately (hidden invitees — the
  organiser always sees their real name here, never their pseudonym) — and,
  since this email is the organiser's only signal those people were reached
  at all, the "notified privately" list reflects booking-notice sends that
  actually SUCCEEDED, with a separate "could not notify" line naming anyone
  whose booking-notice send failed. Never sent when the booking itself fails
  (calendar-write failure, a lost claim/CAS) — this is the successful-booking
  counterpart to the escalation email, not an unconditional "we tried"
  notice. Send failures are logged by poll id only and never undo or fail the
  booking.
- **On an invitee response save** (`renderPollResponseSavedEmail`,
  `worker/src/polls/emails.ts`) — sent from `PUT /poll/:id/response`
  (`worker/src/polls/route.ts`), fire-and-forget via `c.executionCtx.waitUntil`
  (same idiom as the existing `fireMaybeBookOnAllIn` all-in-booking hook), so
  it never fails the response save it fired from. States the respondent's
  real name (never the pseudonym), whether this is their first response or a
  revision, and how many of the poll's non-dropped invitees have now
  responded. **A stateless 15-minute per-invitee quiet-period debounce**
  gates repeat saves (`RESPONSE_NOTIFY_COOLDOWN_MS` in
  `worker/src/polls/route.ts`): a first response always notifies; a later save from an
  already-responded invitee notifies again only once a ≥15-minute gap has
  passed since their PREVIOUS SAVE. This needs no migration — it reads the
  pre-save `respondedAt` already on the invitee row — but that column is the
  invitee's last save time, not their last-notified time: `markResponded`
  stamps it on every save unconditionally, including saves this gate
  suppresses. So the window slides on every save, not just notified ones: an
  invitee who keeps revising at shorter intervals generates no further
  emails until they actually stop for 15 minutes. A continuous burst of
  saves produces exactly ONE email total (the first response), never a
  resend partway through the burst. The save itself is never gated, only the
  notification. See "Known v1 limitations" below for the residual bound.
  Ordering across the two `waitUntil` promises is not guaranteed: the final
  all-in save queues the booking and this notification independently, so the
  organiser may receive "responded (n of n)" AFTER "You booked" — both are
  individually accurate.

### Cancellation (`POST /v1/polls/{id}/cancel`)

The organiser can cancel an `open` or `needs_attention` poll
(`worker/src/handlers/polls.ts`, the cancel route). No data is deleted; the
poll row's status flips to `cancelled`.

- **CAS-guarded, not a blind write.** The status flip is
  `casSetPollStatus(db, poll.id, "cancelled", ["open", "needs_attention"],
  ...)` — a compare-and-swap against the poll's status at write time, not a
  read-then-write built from the `getPollForSubject` snapshot taken earlier
  in the handler. A booking (via the all-in path or the cron's
  `bookAtDeadline`) can land in the gap between that read and this write; a
  blind `UPDATE` would have clobbered a just-booked poll back to
  `cancelled` while leaving its calendar event live (booking.ts's own
  compensation logic only fires when a *booking* attempt loses a race, not
  when a later cancel overwrites one that already won) — and every invitee
  would then get a false "no meeting will be booked" cancellation email
  about a meeting that, in fact, exists. The CAS closes that: if the swap
  doesn't land (poll was already `booked` or `cancelled` by the time this
  call's write executes), the handler returns `409 {error:"invalid_status"}`
  and sends no emails. A poll already `booked` or `cancelled` at the initial
  read is rejected the same way, before the CAS is even attempted.
- **On success, every non-dropped invitee is emailed a cancellation
  notice** — invited and guest kinds alike, hidden invitees included. Each
  send is a private, per-recipient email (`renderPollCancelledEmail`,
  `worker/src/polls/emails.ts`) stating the poll is cancelled, no meeting
  will be booked, and any link the recipient is holding can be disregarded
  — there's no CTA or link in the email itself, since there's nothing left
  for the recipient to do. A *dropped* invitee gets nothing here; they were
  already told, implicitly, that they're out of the required set when they
  lost access. Each send happens in its own try/catch; a failure is logged
  by invitee id only (never the address — the established R1-F6 posture)
  and does not fail the cancel or block the remaining sends — the poll is
  already durably cancelled by that point regardless of how many
  notification sends succeed.
- **A guest join racing a cancel can miss the notice.** `POST
  /poll/:id/join` and the cancel handler are not mutually exclusive: a
  guest whose join lands after the invitee list is read for the
  cancellation loop (or after the loop has already finished) becomes an
  invitee on an already-cancelled poll without ever receiving a
  cancellation email. Accepted v1 window, same class as the other
  read-then-act races in this section — the guest-join handler's own status
  check still stops them from doing anything useful with the new link
  (joining is gated to `open` polls in the first place, so most instances of
  this race are actually foreclosed by that gate; the residual case is the
  narrower window inside the cancel handler itself, between the CAS landing
  and the notification loop completing).

### Immovability mechanism (poll meetings are excluded, not pinned)

Poll-booked events are tagged `extendedProperties.private.optical_poll_id` at
creation. `worker/src/meetings/identify.ts`'s `isOwnedMovableMeeting` rejects
any event carrying that tag **before any other check**, regardless of whether
`OWNED_MEETINGS_ENABLED` is on. The event therefore never becomes a `tasks`
row at all — it is ordinary calendar busy time to the scheduler, the same as
any external meeting. **There is no pinned task row to look for**; do not
confuse this with the owned-meetings `pinned_at` mechanism (§J) — a poll
meeting has no task row to pin.

**Known latent coupling:** `updateEvent` on the calendar provider replaces
`extendedProperties` wholesale rather than merging
(`worker/src/providers/google-calendar-provider.ts:343`) — a future caller
that patches a poll-booked event's `extendedProperties` without preserving
`optical_poll_id` would silently un-tag it and make the event movable. Nothing
in the current codebase does this (the identify-filter shields the poll tag
today), but it is worth knowing about before adding a new `updateEvent` call
site that touches a poll event.

**Deletion outside the resolved window.** Same class of limitation as the
owned-meetings §J: if a poll-booked event is deleted from Google Calendar,
Optical only notices when the week containing it is next resolved (irrelevant
here in one sense, since poll meetings hold no task row to reconcile — but the
underlying `bookings` row can go stale until then).

### Guest joins

`POST /poll/:id/join` is Turnstile-gated and per-IP rate-limited. The per-IP
limit counts *attempts*, recorded in the dedicated
`poll_join_attempts` table (migration `0034_poll_join_attempts.sql`:
`(poll_id, ip_hash, created_at)` plus an index). Every join attempt is
recorded before the handler branches on whether the address is a new guest,
an already-invited invitee, or a dropped one — so all of those paths consume
the same per-IP budget, not only the ones that insert an invitee row.
(The earlier `0033_poll_guest_rate_limit.sql` added `ip_hash`/`created_at` to
`poll_invitees` for an insert-counting scheme; that column-based count was
replaced by the `poll_join_attempts` table because it left the
already-invited and dropped paths unthrottled — the 0033 columns remain but
the live rate limit no longer reads them.) On top of the per-IP limit sits
the `MAX_GUESTS_PER_POLL = 20` poll-scoped circuit breaker
(`worker/src/polls/route.ts:359`) — defence in depth, not a replacement.

**Anti-oracle.** The join response is identical (`202 {sent:true}`, no URL in
the body) whether the submitted email is a brand-new guest or an address
already on the poll — the personal link is only ever emailed to the address
supplied, never returned in the API response. This stops a guest-link holder
from probing which addresses are already invitees (which would otherwise
defeat "hide my name" more thoroughly than the poll's own respondent list
ever could).

### Link rotation and re-issue

- **A `updateMeetingPoll{deadlineUtc}` deadline extension re-issues every
  non-dropped invitee's capability token** (including invitees who already
  responded) and emails them the new link; the old link stops resolving. This
  also reopens a `needs_attention` poll to `open` (via `casSetPollStatus`,
  409ing `invalid_status` if a booking lands concurrently — see the endpoint
  contract above) and clears the per-episode nudge/escalation stamps, so a
  new deadline starts a genuinely new response window. Each re-issue email
  send is best-effort and non-fatal: if the provider fails to send to one
  invitee, the PATCH still succeeds and that invitee's token has already
  rotated (their old link is dead) — leaving them without a working link. A
  manual nudge only re-emails *non-responders*, so an invitee who had
  **already responded** before the extension cannot be recovered by nudge;
  the remedy for them is a second `updateMeetingPoll{deadlineUtc}` call
  (which re-emails all non-dropped invitees). A v1 edge worth knowing when a
  send provider is flaky mid-extend. Exception: an invitee added in the
  *same* PATCH call (`addInvitees`) is not double-emailed — their invite
  email already carries the new deadline.
- **A deadline extension does NOT re-mint the organiser's status-page
  token.** Only invitee tokens are re-issued by `updateMeetingPoll`'s
  deadline arm (`worker/src/handlers/polls.ts`) — there is no corresponding
  `mintStatusToken` call there. The `statusUrl` token's TTL was fixed at
  creation time to the *original* deadline + 7 days
  (`worker/src/handlers/polls.ts:113-115`), so a saved `statusUrl` link stops
  resolving at that original expiry even if the poll has since been extended
  to run longer. The bearer/MCP auth path on the same route is unaffected —
  the organiser can always fall back to `getMeetingPoll` (or their own bearer
  client hitting `GET /poll/:id/status` with no `?t=`) for current state. A
  v1 edge, not fixed: worth knowing if a long-running poll gets extended more
  than once.
- **Both nudge paths (cron and manual) also rotate the invitee's link** — the
  capability token is re-signed and its hash re-stored on every nudge, so an
  invitee who clicks an *older* nudge or invite email after a newer one has
  gone out lands on the "link expired" page. This is the designed re-issue-
  invalidation behaviour, not a bug, but it is surprising enough to flag: an
  invitee should always use the most recent email they received. **The cron
  path's deadline−24h cadence has two guards that narrow this**: a poll
  created inside that window never fires the cadence at all, and no poll of
  any shape fires it (or the midpoint cadence) before it's `MIN_NUDGE_AGE_MS`
  (6h) old (see "Cron sweep behaviour" above) — so that poll's invite link
  can't be rotated out from under an invitee by a final nudge landing minutes
  after the invite email. Outside those two cases (a poll old enough, with a
  window that opened after its 6h floor), the cron path still rotates on
  schedule like any other nudge.
- **Manual nudge (`POST /v1/polls/{id}/nudge`, organiser API — not a
  `/poll/*` public path) is guarded to `status === "open"` only**
  (`worker/src/handlers/polls.ts:666`) — nudging a `needs_attention` or
  terminal poll would rotate links and email a "please respond" that opens a
  closed page.
- **Mid-loop nudge failure is a known gap.** If a nudge fails partway through
  emailing non-responders, an invitee can be left holding a dead (already-
  rotated) link until the next nudge. The manual path is organiser-retriable
  (just nudge again); the cron path self-heals on its next tick.

### Known v1 limitations

- **Hidden invitees' emails are visible to other attendees anyway, just not
  labelled.** "Hide my name" only controls the peer-visible respondent list on
  the poll page itself. Hidden invitees are excluded from the calendar event's
  attendee list (see "Attendee list" above) specifically because the calendar
  provider has no `guestsCanSeeOtherGuests`-style control to hide the guest
  list from other attendees — there was no way to keep them on the invite
  without exposing their address to everyone else on it.
- **Poll slot grid can be coarser than the booking page for 15-minute
  owners.** The grid derives its step from the poll's single duration
  (`slotStepForDurations([poll.durationMin])`,
  `worker/src/polls/grid.ts:115`), not the owner's full configured duration
  set the way the booking page does — so a poll can offer a subset of the
  starts the booking page would for the same owner. Under-offering, never
  over-offering; accepted for v1.
- **`fitScoreForChunk` ignores a DST shift inside a chunk**
  (`worker/src/polls/scoring.ts:134`) — this mirrors the Python solver's
  caller-obligation contract exactly, trading the edge case for guaranteed
  scoring parity between the two implementations. Accepted, not fixed.
- **Deletion of a poll-booked meeting outside the currently-resolved window**
  — see "Immovability mechanism" above; same class as the owned-meetings §J
  limitation.
- **The response-saved organiser notification is a quiet-period debounce,
  not a fixed-rate cap.** A first response always emails immediately.
  `RESPONSE_NOTIFY_COOLDOWN_MS` then gates repeat saves from that SAME
  invitee: an invitee is notified again only after a ≥15-minute quiet period
  following their LAST SAVE (not their last email — see that constant's own
  comment in `worker/src/polls/route.ts` for why those two differ, since
  `markResponded` stamps `respondedAt` on every save, notified or not). An
  invitee who keeps revising at shorter intervals generates no further
  emails until they actually stop for 15 minutes — a continuous burst of
  saves produces exactly ONE email total, not periodic resends through the
  burst. ≤4 emails/hour/invitee is a hard ceiling (only reached if every
  save happens to land just past the gate), not a typical rate. Not fixed
  further for v1.
- **Guest-link polls only reveal a disjoint intersection at the deadline.**
  See "Booking semantics" above — while a guest-join link is enabled and the
  poll is `open`, neither the all-in path nor `updateMeetingPoll`'s
  invitee-removal re-attempt will book or escalate early, so there is no
  early warning email if the
  responses in hand don't actually intersect. The organiser can still force
  an earlier resolution via `resolveMeetingPoll {action:"book"}` or
  `{action:"bookBest"}` (both bypass the guard) once they're willing to stop
  waiting for guests. The
  wait itself has no off switch once a guest link is minted — it persists
  for the life of the poll even after `MAX_GUESTS_PER_POLL` makes further
  joins impossible.
- **A "hide my name" save can race a manual book and still show up on the
  invite.** The booked event's attendee list is built from `hideName` as
  read live off the invitee rows at book time (`worker/src/polls/
  booking.ts:489-490`) — not a value pinned when the booking decision was
  made. An invitee who submits `hideName: true` in the same narrow window
  the organiser's `resolveMeetingPoll {action:"book"}` call is reading that
  table can still land on the calendar invite with their real email
  visible, if their save's write commits before the attendee-list read.
  The inverse (a save toggling `hideName` back to `false` right before a
  book) is equally possible and equally accepted — this is a v1 ordering
  gap, not validated further.
- **A save racing a book can leave a stale-looking editable grid.** `PUT
  /poll/:id/response` gates on the poll's status at the top of the request
  (`worker/src/polls/route.ts:548`); if a book completes between that gate
  and the save actually persisting, the save can still succeed against a
  poll that's now `booked` from the invitee's point of view, and the
  invitee's browser keeps showing an editable grid until they reload and
  get the fresh (closed) state. The save itself is not lost or corrupted —
  it just doesn't reflect the meeting no longer being open to negotiate.
- **The response-saved debounce (`RESPONSE_NOTIFY_COOLDOWN_MS`, see
  "Organiser notifications" above) is status-blind.** It gates purely on
  elapsed time since the invitee's previous save, with no awareness of
  whether the poll has since escalated to `needs_attention`. A revision
  within 15 minutes of that invitee's prior save on a now-escalated poll
  sends no email at all — same as it would on an `open` poll — and even
  when a notification email is sent, its body doesn't distinguish an
  escalated poll from an open one. The status page (`GET /poll/:id/status`)
  is the organiser's authoritative source for current poll state; the
  response-saved email is a save-activity signal, not a status feed. Not
  fixed further for v1.
- **Guest-link enable-when-enabled cannot return the URL; disable-then-enable
  rotates it.** See `updateMeetingPoll`'s "Known edges carried forward"
  above — guest-link creation stores only the token's hash, so a redundant
  `guestLink:true` PATCH is a no-op with no `guestUrl` to hand back. Getting
  a fresh, retrievable guest URL after the first one is lost requires two
  PATCH calls (disable, then enable). Not fixed further for v1.

### Live smoke (`bin/poll-smoke.py`)

```bash
op run --env-file=.env -- uv run bin/poll-smoke.py > /tmp/poll-smoke.out 2>&1; tail -60 /tmp/poll-smoke.out
```

Env: `SCHEDULER_URL`, the organiser identity `A_BEARER`/`A_REFRESH`/
`A_EXPECTED_EMAIL`, and the two invitee mailboxes `INVITEE_A_EMAIL` /
`INVITEE_B_EMAIL` (optionally `D1_DATABASE_ID` for automatic row cleanup) — all
of which `eval "$(bin/mu-smoke-login.py A --url $DEV --email-a … --email-b …
--email-c …)"` exports in one go (see §B's "Minting identities").

Exercises the full lifecycle against deployed dev: create → invite → paint →
auto-book → immovability, plus the manual-nudge contract and the unhappy
(disjoint-paint → `needs_attention`) path. Extended for the 2026-08-16
bug-fix pass (see "Booking semantics" and "Known v1 limitations" above) to
also exercise: the `needs_attention` grid unlock end to end (an escalated
poll's GET/PUT return the full payload, an invitee's overlapping revise does
NOT auto-book, manual nudge still 409s, and the organiser rescues it via
`resolveMeetingPoll{action:"book"}`); a `guestLink:true` poll holding `open`
through an all-in overlapping paint instead of auto-booking/escalating early
(guest self-join itself is out of scope — a third mailbox would be needed);
the cancel CAS in both directions (409 on an already-booked poll, 200 →
`cancelled` on an open one); and the status page's icon aggregate markup
(`av-free`/legend/two-tier header) once a response has been painted. A
further BOOKBEST mode covers `resolveMeetingPoll{action:"bookBest"}`: only
one invitee responds (so their single painted cell is the only qualifying
candidate), `bookBest` books it pre-deadline, and the non-responding invitee
still lands on the event's attendee list; a second, zero-response poll
asserts the failure shape (400 `no_responders`, poll left open — `bookBest`
never escalates on failure, unlike `bookAtDeadline`). A further EDIT mode
covers `updateMeetingPoll` (Card D, internal design notes): one
PATCH that adds a third invitee, removes an existing one, and changes the
location in a single call — asserting the removed invitee's link goes dead,
an untouched invitee's ORIGINAL link (captured before the PATCH, same URL)
keeps working, the new invitee's roster row appears via `getMeetingPoll`,
and the PATCH response itself already carries the new location; the two
remaining invitees then paint an overlap to auto-book, and the booked
event is checked for the PATCHed location and the removed invitee's
exclusion from attendees. A second poll covers the deadline arm in
isolation, deriving the PATCH target from the poll's ACTUAL created
deadline rather than an assumed value (it rotates EVERY non-dropped
invitee's token, unlike every other PATCH field), and the resolve-slimming
guard: `resolveMeetingPoll{action:"extendDeadline"}` and
`{action:"dropInvitee"}` both now 400 `validation_failed`, even sent with a
body shaped exactly as the OLD (pre-slimming) schema required — proof the
action literal itself is gone from the union, not just that some other
field was missing. EDIT's third invitee reuses invitee A's mailbox via a
`+` subaddress tag (poll-smoke only has two real invitee mailboxes — see
the `INVITEE_A_EMAIL`/`INVITEE_B_EMAIL` note above), overridable with
`EDIT_C_EMAIL` (also the escape hatch if Google Calendar collapses the
tagged address onto A's own attendee entry on a live run).

**Token relay is automated when the organiser's token can read Gmail (T3).**
Every per-invitee capability token (the invite link, and each nudge's freshly
re-issued link) is minted only into an email body — but every one of those
emails goes out via the organiser's own `gmail.send`, so they all land in
identity A's **Sent** folder. `resolve_token` checks THREE sources in order:

1. **A pre-supplied `*_TOKEN` env var wins unconditionally.** It's the
   operator's explicit intent, so it is consulted first and short-circuits
   both of the paths below it — not merely "reached after a mailbox timeout".
2. **The mailbox**, when A's OAuth token carries `gmail.readonly`: it polls
   the Sent folder itself (up to ~90s, since sending is async) and returns
   each invitee's CURRENT link with no operator involved — including after a
   nudge rotates it, since a match is only accepted if it was sent at/after a
   `not_before` watermark specific to that call (the nudge step's watermark
   is the moment just before its own POST) — a stale, already-landed
   pre-rotation match is correctly treated as "nothing yet", not as a
   valid-but-old token, which is what makes the freshness guarantee real
   rather than just "whichever email happens to match first".
3. **The interactive prompt** (pre-T3 behaviour) as the last resort: run the
   harness attached to a terminal — it prints a "waiting for `<label>`"
   prompt and expects the token (or the whole link) pasted in once the email
   arrives.

The mailbox path never crashes a run: a 403 (scope missing) or persistent
Gmail/transport error disables it for the rest of the run and falls back to
the prompt; a full ~90s poll that never finds a match ALSO disables it after
its first occurrence, rather than repeating the same wait on every one of the
~11 resolve_token call sites (a real cost — that would be roughly 16 minutes
of dead time in the worst case). "Disabled" only affects paths 2 and 3 above;
a pre-supplied env var for a later call site still wins immediately.

Enabling it in dev: set `GOOGLE_GMAIL_READ_SCOPE_ENABLED = "true"` under
`worker/wrangler.toml`'s `[env.dev.vars]` (mirrors `GOOGLE_ACL_SCOPE_ENABLED`
above — **never** set under the top-level/prod vars) and deploy dev, then
re-consent A to pick up the new scope — same drill as `calendar.freebusy` /
`calendar.acls`:

```bash
./bin/mint-token.py --url https://scheduler-dev.example.com --client-id smoke-cli
```

Before committing a real run to it, verify the scope actually took with one
live `users.messages.list` call using the harness's exact query shape
(`gmail_query`'s `in:sent to:<email> subject:[pollsmoke] after:<epoch>`) —
zero results are indistinguishable from "the scope isn't live yet" and from
"nothing has been sent yet", so a quick manual check saves discovering the
gap 90 seconds into a real poll-smoke run instead.

Set the matching `INVITEE_A_TOKEN` / `INVITEE_B_TOKEN` / `NUDGE_TOKEN` /
`UNHAPPY_A_TOKEN` / `UNHAPPY_B_TOKEN` / `HIDDEN_A_TOKEN` / `HIDDEN_B_TOKEN` /
`GUESTWAIT_A_TOKEN` / `GUESTWAIT_B_TOKEN` / `BOOKBEST_A_TOKEN` env vars to
skip both the mailbox and the prompt for a given call site, regardless of
which path is otherwise active.

Still not covered by the mailbox read: email CONTENT assertions (invite,
nudge, escalation, cancellation, the hidden-invitee ICS notice, both
organiser notifications) — the harness only ever mines the one link it needs
out of each message, it doesn't assert anything else about what's in it.

Like the other live harnesses, run Mon–Thu (weekend business-hours capacity
gaps produce spurious failures — see the L6 weekend-artifact note elsewhere in
this runbook) and always redirect output to a file; this harness's output can
overflow terminal buffers.

Needs the credential env vars that only exist in the operator's shell — do not
attempt this from an agent session; hand the command to him instead.

#### Microsoft organiser (`--provider microsoft`)

WP2 of internal design notes: runs the organiser identity
(A) against a Microsoft account instead of Google. Invitee mailboxes
(`INVITEE_A_EMAIL`/`INVITEE_B_EMAIL`) are **always Gmail** — this flag only
changes which provider the organiser's calendar and mail relay use.

```bash
op run --env-file=.env -- uv run bin/poll-smoke.py --provider microsoft \
  > /tmp/poll-smoke-microsoft.out 2>&1; tail -60 /tmp/poll-smoke-microsoft.out
```

(or `SMOKE_PROVIDER=microsoft`, same convention as `regression-smoke.py`).
The target env must host the Microsoft provider: set
`MS_PROVIDER_ENABLED = "true"` and the Microsoft vars under `[env.dev]` (see
§O "Microsoft smoke on dev") and run against dev.

- **Preflight.** `main()` now runs a `GET /v1/whoami` check before creating
  anything: `A_EXPECTED_EMAIL` must match, and (once the worker's whoami
  route carries the additive `provider` field — WP0 of the same plan) that
  field must equal `--provider`. A Google `A_BEARER` run under `--provider
  microsoft` fails here, in the first second, instead of twenty minutes in
  against a confusing Graph 401. Against a pre-WP0 worker (no `provider`
  field in the response) that half of the check is skipped, not failed —
  and a one-line stderr warning says so, since the operator should still
  know a mismatched `--provider` will only surface later as a Graph 401.
  **This preflight hard-fails on an email mismatch**, so `MS_A_EXPECTED_EMAIL`
  (or whichever env var seeds `A_EXPECTED_EMAIL` for the run) must be the
  account's actual whoami identity — the same address it signed in with —
  never the `outlook_<hex>@outlook.com` proxy alias outbound mail leaves
  from (see the proxy-alias note below): the whoami route never returns
  that alias, so a run seeded with it fails preflight immediately.
- **Mail-read scope.** The organiser-Sent-mail relay (see "Token relay is
  automated" above) needs `MICROSOFT_MAIL_READ_SCOPE_ENABLED = "true"` under
  the target env's `[env.<name>.vars]` — the Microsoft analogue of
  `GOOGLE_GMAIL_READ_SCOPE_ENABLED`, appending `Mail.Read` to the delegated
  scopes (`microsoft-identity-provider.ts`). Re-consent identity A after
  flipping it:
  ```bash
  ./bin/mint-token.py --provider microsoft --url https://<target-host> --client-id smoke-cli
  ```
  Without the scope, the mailbox path 403s once (`MailScopeError` —
  `GmailScopeError`'s provider-neutral name since WP2, same class) and falls
  back to the interactive-prompt relay for the rest of the run, identical
  degradation to the Google path.
- **EDIT mode's location.** Poll-1's create location kind is `phone` (with a
  detail) on Microsoft, not `meet` — Graph's `addMeet` path 400s on a
  personal Microsoft account (an MSA) without a Teams license (Decision 7 of
  the coverage plan; `edit_create_location` in `bin/poll-smoke.py`). The
  PATCH-to-`in_person` half of Poll-1 is unaffected — it never depended on
  the initial kind.
- **Proxy-alias cosmetic note.** Organiser-side poll mail on an MSA leaves
  from its `outlook_<hex>@outlook.com` proxy alias rather than the account's
  real address (see §O's open item on this). Invitee mailboxes still receive
  the mail correctly, and the harness reads the organiser's own Sent Items
  (not the invitee's Inbox) for the relay, so this never affects what the
  harness asserts — it is purely cosmetic in a live inbox.
- **Live run recorded:** not yet run — WP2.5 in the coverage plan; needs
  the operator's shell (see the note above) and is a separate step from this
  implementation pass.

## M. Booking-page decline auto-cancel

Rides `BOOKING_PAGE_ENABLED` — no separate flag
(internal design notes, decision 4). When the sole attendee
of a booking-page-owned calendar event declines the invite and the event
hasn't started, Optical waits out a grace period (misclick protection) and
then auto-cancels: deletes the calendar event (with Google's own
cancellation notices), marks the `bookings` row `'cancelled'`, and emails
the booker (please re-book) and the owner (heads-up). Non-booking-page
events — including 1:1s where the only attendee declines — are never
touched.

### Mechanism

Two halves joined by a nullable `bookings.cancel_pending_at` column:

- **Detection** (webhook path, `worker/src/booking/decline-cancel.ts`,
  hooked into `runWebhookReplan`, `worker/src/webhooks/google-calendar.ts`).
  On every webhook-driven replan, changed events tagged `optical_booking`
  (the tag IS `bookings.id` — set at claim time, `booking/route.ts`) are
  scanned: if every counted attendee (excluding `self`/`resource`) has
  declined and the event's start is still in the future, `markCancelPending`
  CAS-stamps `cancel_pending_at = now` on the matching `'confirmed'` row —
  only if the stamp is currently NULL, so a repeat webhook delivery of the
  same decline never resets the clock. If a tagged event's attendee is back
  to any non-declined state, `clearCancelPending` clears the stamp (fast
  un-decline abort). **An all-declined event whose start has already
  passed is skipped entirely — no stamp, but also no clear.** This is
  different from the un-decline case: if a stamp is already running (set
  while the event was still future) and the event's start then passes
  while it stays all-declined, detection leaves that stamp exactly as it
  found it; the sweep's own future-start check (below) is what eventually
  aborts it, not a detection-side clear. An unparseable `start` fails
  closed the same way (treated as "already passed", never stamped). An
  `optical_poll_id`-tagged event, an untagged event, or a Google-
  `status:"cancelled"` event is skipped outright — poll bookings are out
  of scope, and a gone/cancelled event is the sweep's job (below), not
  detection's.

- **Sweep** (`*/5 * * * *`, `worker/src/cron/booking-decline-sweep.ts`,
  dispatched from `scheduled-entry.ts`'s `BOOKING_DECLINE_CRON` branch, gated
  on `BOOKING_PAGE_ENABLED === "true"`, same as every other cron master
  switch). Finds every `'confirmed'` booking whose `cancel_pending_at` is at
  least `BOOKING_DECLINE_GRACE_MINUTES` old (`listCancelPendingDue`), grouped
  by owner (one calendar/notification provider pair per owner, same fan-out
  shape as `runPollSweep`). For each due row it **re-fetches the live event
  from Google** (`getEvent`) — this re-fetch, not the stamp, is the real
  misclick protection, since the stamp alone only proves what was true at
  detection time — and:
  - event gone (404/410) or Google's own `status:"cancelled"` → the owner
    deleted it themselves; `markCancelled` closes the row out quietly, no
    emails (there's nothing to notify anyone about);
  - the re-fetched event's `optical_booking` property doesn't match this
    row's id (defense-in-depth against event-id reuse after an out-of-band
    delete) → `clearCancelPending`, event left alone;
  - the event's start has now passed → `clearCancelPending`, event left
    alone;
  - the attendee is no longer all-declined (un-decline, or Optical itself
    relocated the meeting mid-grace and Google reset the RSVP — see
    "Relocation race" below) → `clearCancelPending`, event left alone;
  - still all-declined and still future → **fire**: `deleteEvent(id,
    {notifyAttendees: true})` (Google sends `sendUpdates=all`), THEN
    `markCancelled` CAS to `'cancelled'` (delete-before-CAS is deliberate — a
    crash between the two self-heals on the next tick via the "event gone"
    branch above; only the emails would be lost, never a live event left
    standing while the row reads `'cancelled'`), then the booker email
    (please re-book, CTA to `${OAUTH_ISSUER}/book/<slug>`) and the owner
    email (heads-up), in that order. If the `markCancelled` CAS loses
    (something else — a concurrent sweep tick, the owner — closed the row
    out in between), no emails are sent; this is logged as `aborted` in the
    sweep's summary, since it's the one path that deletes a live event with
    no other observable trace.

  A throwing row (e.g. a Google 500 on delete) is caught, logged (booking id
  only, never an address — logging rule R1-F6), and does not stop the rest
  of the batch; the stamp survives so the next tick retries.

### `BOOKING_DECLINE_GRACE_MINUTES`

Stringly-typed Worker var, parsed in `graceMinutes()`
(`worker/src/cron/booking-decline-sweep.ts`). Two distinct failure shapes:

| Value | Effective grace |
|---|---|
| Unset, empty, or non-numeric | Falls back to the default, **10 minutes** |
| Parses but `< 1` (`"0"`, a negative number) | Clamps UP to a **1-minute floor** — does NOT fall back to the 10-minute default |
| Parses and `>= 1` | Used as given (fractional values floored) |

Because the timer is a 5-minute cron, not a Durable Object alarm, the
*effective* wait is "at least the configured grace, at most ~grace + 5
minutes". Dev sets `BOOKING_DECLINE_GRACE_MINUTES = "1"` under
`[env.dev] vars` (`worker/wrangler.toml`) so `bin/booking-smoke.py`'s decline
mode doesn't have to wait out a realistic window; prod stays on the default
(unset).

### Known v1 limitations

- **Fallback-window gap.** Detection only sees events the webhook path
  actually delivers. When the sync token is invalidated, the fallback full
  fetch only covers `DEFAULT_DETECT_DAYS = 7` — a decline on a booking
  further out is missed until that event next changes for some other reason.
  Same class of gap as §J's deletion-reconciliation window.
- **Deletion events never reach detection.** Incremental sync converts a
  *deleted* calendar item into a bare tombstone/delete entry, which is
  dropped before it ever reaches `runWebhookReplan`'s changed-event list —
  there is no "the event vanished" signal on the detection side. The
  gone-event path is entirely the sweep's `getEvent` → `null` quiet close
  (above); `detectBookingDeclines`'s own `status:"cancelled"` guard is pure
  defence for an event Google still returns with that shape, not a
  substitute for a real deletion signal — don't read it as "how deletions
  are handled".
- **A decline inside the grace window before the event starts is left
  alone.** If the grace period would only elapse after the event's start,
  the sweep's future-start check aborts the cancellation
  (`clearCancelPending`) and the event stays on the calendar, declined
  attendee and all.
- **Owner-deleted-during-grace closes quietly, with no emails.** If the
  owner deletes the event themselves while a decline's grace clock is
  running, the sweep's next tick sees `getEvent` return null/cancelled and
  just marks the row `'cancelled'` — no booker or owner email, since there's
  nothing new to tell either of them. Two *overlapping sweep ticks* (Cloudflare
  doesn't serialize scheduled invocations) can produce the same quiet close on
  a genuine decline-fired cancellation: tick 1 deletes, tick 2 sees the event
  gone and wins the `markCancelled` CAS, tick 1's CAS then loses (`aborted`) —
  event and row end in the right states but both emails are swallowed and the
  log reads as owner-deleted. Rare (needs a tick slower than 5 minutes);
  accepted.
- **Relocation race.** The same `runWebhookReplan` invocation that detects an
  all-declined booking event may also go on to *relocate* it — a fully
  declined attendee set can make an owned-meeting-eligible event maximally
  movable under `constrainingAttendeeEmails`. If Optical moves it, Google
  resets the attendee's RSVP to `needsAction`, the next webhook clears the
  stamp, and the sweep's re-verify would abort anyway even if the stamp
  somehow survived. Net effect: safe, no special-cased code, but a booking
  can appear to "recover" from a pending cancellation because it moved, not
  because the booker actually un-declined.
- **The slot stays blocked for the whole grace window.** `cancel_pending_at`
  is a column, not a status — the row is still `'confirmed'`, so the normal
  overlap guard (`claimSlot`) keeps blocking that slot until the sweep
  either cancels or clears it. A booker who declines and immediately tries
  to re-claim the *same* slot has to wait out the grace period first.
- **Cancelled rows still count toward the IP/day rate limits**
  (`countRecentByIp`/`countTodayByOwner` count every row with
  `status != 'failed'`). Accepted as anti-abuse behaviour, unchanged from the
  pre-existing rate-limit design.
- **Whether Google emails the declining attendee is Google's call, not
  ours.** `deleteEvent(id, {notifyAttendees: true})` requests
  `sendUpdates=all`, but Google's own delivery to a declined attendee on a
  cancellation is not guaranteed by this feature. The booker's courtesy
  email (`renderBookingDeclineCancelledEmail`) is the one channel this
  feature actually guarantees.
- **A self-booking never triggers this flow.** If the booker's email is the
  owner's own account (an owner books their own page), Google marks that
  attendee entry `self: true`; the counted-attendee set (which excludes
  `self`) is then empty, and `isAllDeclined` requires at least one counted
  attendee, so a decline in this shape is never detected. Harmless — by
  design, not a bug.
- **An email failure after the cancel CAS is not retried.** If
  `sendPollEmail` throws for either the booker or owner email after
  `markCancelled` has already won its CAS, the row stays `'cancelled'` and
  the event stays deleted — the notification is simply lost. One log line
  and the sweep's `failed` counter are the only trace; this trade-off is
  pinned by a test, not an oversight.
- **A lost CAS after delete is tracked separately, as `aborted`.** See
  "Sweep" above — the event is already gone either way, so this is not a
  data-integrity problem, just a summary-counter distinction from `failed`
  (nothing threw) worth knowing when reading sweep logs.
- **Defense-in-depth event-identity check.** Before deleting, the sweep
  re-verifies the re-fetched live event's `optical_booking` extended
  property still equals the row's own id — an event id can, in principle, be
  reused for an unrelated event after the original was deleted out-of-band,
  and everything past that point (start/attendee checks, delete) would be
  meaningless or dangerous applied to someone else's event.
- **Turning `BOOKING_PAGE_ENABLED` off does not stop detection.** Only the
  sweep dispatch is flag-gated; `detectBookingDeclines` runs on every webhook
  regardless, so with the flag off, outstanding stamps sit unswept
  indefinitely and new declines on existing bookings keep stamping.
  Re-enabling the flag fires all accumulated stamps on the next tick —
  safely, since the fire-time re-verify re-checks the live event (passed
  starts and un-declines clear instead of firing).

### Vendor follow-up

`GET /v1/bookings`'s OpenAPI description changed (the `status` enum and the
route description both now mention `cancelled`/auto-cancel). codemode-mcp
vendors the optical spec — the vendor refresh PR for this change is done
(2026-08-18), so the `listBookings` tool description is current.

### Live smoke (`bin/booking-smoke.py --mode decline`)

```bash
op run --env-file=.env -- uv run bin/booking-smoke.py --mode decline > /tmp/booking-smoke-decline.out 2>&1
# Microsoft, against dev (with the Microsoft provider enabled there):
op run --env-file=.env -- uv run bin/booking-smoke.py --mode decline --provider microsoft > /tmp/booking-smoke-decline-microsoft.out 2>&1
```

Books via the public page using a second, real account (the "harness
attendee") so its RSVP is real, declines on the attendee's own event copy,
waits for the webhook to stamp `cancel_pending_at`, force-fires the `*/5 * *
* *` sweep via the cookie-free cron trigger (§E's "Cookie-free alternative"
— `wrangler dev --env <env> --remote --test-scheduled` + `curl
".../__scheduled?cron=*/5+*+*+*+*"`), and asserts the event is deleted,
`bookings.status = 'cancelled'` (direct D1), and both notification emails
are present. Both land in the **owner's own Sent folder/Sent Items**, not
the attendee's mailbox — `booking-decline-sweep.ts` builds its
`NotificationProvider` off the owner subject for both the booker and owner
recipients (same infra `bin/poll-smoke.py`'s mailbox-first relay reads),
so no mail-read scope is needed on the attendee account at all. Also
exercises the abort path: decline, then re-accept before the (grace-
shortened) grace elapses — the event survives and the stamp clears.

The **google** decline mode reads the owner's Sent folder over Gmail (dev's
`GOOGLE_GMAIL_READ_SCOPE_ENABLED`). The **microsoft** decline mode
(`--provider microsoft`) reads the owner's Sent Items over Graph instead
(`_smoke_lib.GraphMailClient.list_sent_since` + `graph_sent_matches`).

Env, beyond §K's base-mode set (`SCHEDULER_URL`, `A_BEARER`/`A_REFRESH`/
`A_EXPECTED_EMAIL`, `TURNSTILE_SECRET_<ENV>`):

- `C_BEARER`/`C_REFRESH`/`C_EXPECTED_EMAIL` — the harness attendee account
  (`C_CLIENT_ID` optional, defaults to `smoke-cli`), same convention as
  `bin/meeting-smoke.py`'s two-account mode.
- `D1_DATABASE_ID` + `CLOUDFLARE_API_TOKEN` — **mandatory** in this mode
  (optional in base mode): the D1 assertions and the `wrangler dev
  --test-scheduled` subprocess both need them. `D1_DATABASE_ID` must be
  dev's own db (`scheduler-dev`) — `assert_smoke_db` refuses anything else.
- On Microsoft: dev's `MICROSOFT_MAIL_READ_SCOPE_ENABLED` live, with the
  **owner** (`A`, `microsoft:a`) account re-consented to pick it up (re-mint
  via `bin/mu-smoke-login.py A --provider microsoft --url
  https://scheduler-dev.example.com`) — the exact Microsoft counterpart of
  the Gmail scope-flip-then-re-consent drill in §L "Enabling it in dev".
- On Google: dev's `GOOGLE_GMAIL_READ_SCOPE_ENABLED` live, with the
  **owner** (`A`) account re-consented to pick it up — see §L "Enabling it
  in dev" for the scope-flip-then-re-consent drill; same scope, same steps,
  just read from the owner's Sent folder here instead of inferred from it.
- The target env must actually be **deployed from a branch carrying
  `BOOKING_DECLINE_GRACE_MINUTES = "1"`** (`worker/wrangler.toml`'s
  `[env.dev]` vars, or whichever env block this runs against) for the
  grace-shortening to be live — a deploy from before that var landed leaves the env on the
  10-minute default, and this mode will look "stuck" waiting on
  `cancel_pending_at` to become due rather than failing outright.

Do not run `--mode base` and `--mode decline` concurrently against the same
owner: `config_booking_page` is one row per `owner_subject`, so the second
mode's `PUT /v1/booking-page` replaces the first mode's config wholesale —
whichever mode's public calls land after that see a 404 (unknown slug) or a
config not shaped the way that mode expects.

Needs the credential env vars that only exist in the operator's shell — do not
attempt this from an agent session; hand the command to him instead.

## N. Per-user cost curves & weights

No feature flag — this rides the always-on `config_contexts` /
`config_weights` tables (internal design notes). Any
signed-in user can customise the solver's cost model for their own week: the
per-context time-of-day fit curve, daily/streak caps, and over-cap penalties
for each of the 5 contexts (`deep`, `admin`, `physical`, `family`,
`meeting`), and the 6 global soft weights that shape every resolve. No
migration shipped with this feature — both tables already existed,
per-user-keyed, since `0017_per_user_config.sql`.

### Mechanism

`config_contexts` holds one row per `(owner_subject, context)`;
`config_weights` holds one row per `owner_subject`. The sentinel owner
`'__default__'` holds the instance defaults, seeded and only ever changed by
migration (`0002_seed_config.sql` → `0005_fix_config_contexts.sql` →
`0007_update_fit_curves.sql` for contexts; `0002` → `0011_preferred_window_weights.sql`
for weights) — there is no admin API for the `'__default__'` rows. See §G for
the current seeded values of the two soft preferred-window weights and
business-hours interaction.

**Migration-author warning:** since `0017_per_user_config.sql` re-keyed both
tables by `owner_subject`, a default-tuning migration written in the older,
pre-`0017` style — e.g. `0007`'s `UPDATE config_contexts SET body = ... WHERE
context = 'deep'`, with no `owner_subject` filter — would now match and
clobber every user's custom `deep` row along with the `'__default__'` one.
Any future migration touching `config_contexts` or `config_weights` must add
`AND owner_subject = '__default__'`.

**Effective config = per-context merge**, computed by
`worker/src/db/context-config.ts`'s `loadEffectiveContexts(db, owner)`: for
each of the 5 known contexts independently, the owner's own row if they have
one, else the `'__default__'` row for that context. A user can therefore
customise `deep` alone and keep tracking the instance default on the other
four. This single module is now the only place that logic lives — the
resolve pipeline (`resolve-internal.ts`), `GET /v1/contexts`
(`handlers/contexts.ts`), and the meeting-poll booking engine's fit-curve
lookup (`worker/src/polls/booking.ts`'s `loadMeetingFitCurve`, which delegates
to `loadEffectiveContexts` and reads the `meeting` entry) all call it, so a
poll organiser who has customised e.g. only `deep` still ranks poll slots
against the *default* meeting curve, not a stale reimplementation. If the
`'__default__'` row for a context is somehow missing, `loadEffectiveContexts`
throws (a config invariant, not a runtime possibility under normal
migrations); `loadMeetingFitCurve` catches that (and a missing `meeting`
entry) and returns `null` rather than failing the booking path over broken
instance config. Callers use the wrapping `resolveMeetingFitCurve`, which is
never `null`: it applies the flat all-day fallback
(`{peak_start:"00:00", peak_end:"23:59", falloff_end:"23:59"}`) when
`loadMeetingFitCurve` returns `null`, and every caller that ranks poll
candidates must go through `resolveMeetingFitCurve` rather than
`loadMeetingFitCurve` directly, so the ranking shown to the organiser and the
ranking the booking engine actually books against can never diverge.

**Effective weights** (`loadEffectiveWeights`) follow the same idea at
row granularity: the owner's row if present, else `'__default__'`. A
pre-`0011` weights row missing `preferred_day_miss` /
`preferred_time_miss_per_15min` is back-filled with `40` / `5` at read time
so the solver never receives `undefined` for those fields. Precedence for
what actually reaches the solver on a given resolve:

```
'__default__' row  <  owner's custom row (if any)  <  per-resolve weights_override
```

`weights_override` (`worker/src/planning/resolve.ts`, `z.record(z.number())`)
is unchanged by this feature and still wins for that one resolve only — it
does not touch the stored row.

**Writes are complete snapshots, not field-level deltas.** `PATCH
/v1/contexts/{context}` and `PATCH /v1/weights` merge the supplied partial
body over the *effective* config (own row if any, else default) and store
the full result. Consequence: once a context or the weights row is
customised, it stops tracking future instance-default changes — on every
field, not just the ones the PATCH touched — until reset via `DELETE`. This
is deliberate (`worker/src/db/context-config.ts:7-10`): stored rows must stay
self-contained, exactly what resolve ships to the solver, with no runtime
merge-with-current-default step.

### Deploy-time behaviour change

`getContexts` (`GET /v1/contexts`) is **not new** — it pre-dates this
feature — but its semantics and response shape both changed on this deploy,
and because the resolve pipeline's context loader changed identically, so
did what actually reaches the solver:

- **Old semantics (pre-deploy): wholesale, no merge.** The pre-Card-A
  `loadContexts` (`resolve-internal.ts`) and the old `handlers/contexts.ts`
  each independently queried "the owner's own rows if the owner has ANY,
  else the full `'__default__'` set" — no per-context merge. A user who had
  written even one custom context row got back *only* their own row(s), not
  padded out to 5, and resolve shipped the solver only those rows too. The
  old response shape was `{context, body}` (no `source` field), ordered
  alphabetically by context, with a count equal to however many rows the
  owner actually owned.
- **New semantics (this deploy): per-context merge, always 5.**
  `getContexts` and the resolve pipeline now both call the same
  `loadEffectiveContexts` (see Mechanism above): every one of the 5 known
  contexts independently, own row else default. The response is always
  exactly 5 entries, in `KNOWN_CONTEXTS` order (deep, admin, physical,
  family, meeting — not alphabetical), each carrying the new `source` field.
- **Who this affects:** only a user who, before this deploy, held a
  *partial* custom `config_contexts` set (some but not all 5 contexts
  customised) — no such write path existed before this feature, so this was
  only reachable via direct DB access. For that user, the contexts they
  hadn't customised go from "whatever the wholesale fallback happened to
  omit" to "tracking the instance default" — strictly more correct, but a
  real, silent change to their next resolve's solver payload.
- **Operational requirement before prod deploy:** re-run the prod row-count
  check from the plan (internal design notes, "Current
  behaviour findings"). As of 2026-08-18 it found prod `config_contexts` at
  exactly 5 rows, all `'__default__'`, and `config_weights` at 1 row — no
  user has any custom rows, so this deploy is behaviour-neutral for live
  data today. If a user has acquired custom rows by the time prod is
  actually deployed, confirm out loud that the wholesale→merge change is
  acceptable for them before proceeding — it is strictly more
  default-tracking, never less correct, but that should be a stated
  decision, not an assumption.

### Endpoints (`worker/src/handlers/contexts.ts`, `worker/src/handlers/weights.ts`, mounted in `v1.ts`)

Of the six operations below, only `getContexts` pre-dates this feature (see
"Deploy-time behaviour change" above for what changed about it); the other
five — `updateContext`, `resetContext`, `getWeights`, `updateWeights`,
`resetWeights` — are new.

All bearer-scoped via `requireOwner` (401 missing/invalid bearer; 403 token
carries no subject — same house pattern as booking-page, checked before
Zod's own request validation so a malformed body from an unauthenticated
caller still gets 401/403, not 400).

| operationId | Method/path | Notes |
|---|---|---|
| `getContexts` | `GET /v1/contexts` | Always returns exactly 5 entries `{context, body, source}`; `source` is `"custom"` or `"default"` per context. |
| `updateContext` | `PATCH /v1/contexts/{context}` | Partial `ContextConfig` body (`fit_curve`, `max_minutes_per_day`, `max_contiguous_minutes`, `over_daily_cap_penalty_per_15min`, `over_streak_cap_penalty_per_15min`); 200 → the context's new effective entry. |
| `resetContext` | `DELETE /v1/contexts/{context}` | Deletes the caller's row for that context, if any. Idempotent — a context already on default still 200s. |
| `getWeights` | `GET /v1/weights` | `{weights: {...6 fields}, source}`. |
| `updateWeights` | `PATCH /v1/weights` | Partial 6-field body; 200 → new effective weights. |
| `resetWeights` | `DELETE /v1/weights` | Deletes the caller's weights row, if any. Idempotent. |

**Validation** (worker-side, so a bad snapshot can never reach the solver
and poison a later resolve):

- `{context}` path param is one of `deep`/`admin`/`physical`/`family`/`meeting`
  (Zod enum; unknown value → 400).
- `fit_curve`, when supplied, must carry the complete
  `{peak_start, peak_end, falloff_end}` triple — never a partial curve merged
  bound-by-bound. Each bound matches `^([01]\d|2[0-3]):[0-5]\d$` (zero-padded
  local `HH:MM`, chosen so lexicographic string compare is chronological).
  Ordering `peak_start <= peak_end <= falloff_end` is checked imperatively in
  the handler (`validateFitCurveOrdering`), mirroring the solver's own
  Pydantic validator so the worker rejects everything the solver would.
- `max_minutes_per_day` / `max_contiguous_minutes`: positive integer or
  `null` (`null` = uncapped).
- `over_daily_cap_penalty_per_15min` / `over_streak_cap_penalty_per_15min`
  and all 6 weights fields: **non-negative integer**, `z.number().int().min(0)`
  — not just "`>= 0`". The solver's Pydantic model types every weight and
  penalty `int = Field(ge=0)`, so a fractional value (`12.5`) would pass a
  looser check here but 422 the solver on the next resolve, and `Infinity`
  JSON-stringifies to `null` in the stored snapshot; `.int()` rejects both
  fractional values and `Infinity`/`NaN` outright.
- Both PATCH bodies are `.strict()` — an unknown field is rejected (400),
  never silently dropped.
- An empty PATCH body (no fields at all) → 400 `empty_update`.
- Error codes: `validation_failed` (Zod-level: malformed HH:MM, incomplete
  `fit_curve` triple, unknown context, non-integer/negative penalty or
  weight, non-positive cap, unknown field); `invalid_fit_curve` (the triple
  parses but is out of order — `peak_start > peak_end` or
  `peak_end > falloff_end`); `empty_update` (no fields supplied).
- Error response bodies differ by source, not just by code: a
  `validation_failed` raised by @hono/zod-openapi's own request-schema
  validation (the shared `defaultHook` in `worker/src/v1.ts`) carries
  `{error: "validation_failed", issues: [...]}` — raw Zod issues, not
  human-authored text. `invalid_fit_curve` and `empty_update`, both raised
  by the handler itself, carry `{error, detail?}` instead — `detail` is
  human-readable prose, not machine-parseable. Clients should key off
  `error` alone and not assume a fixed body shape across codes.

### No feature flag, no migration — deploy order

Both tables predate this feature (`0017_per_user_config.sql`); there is no
migration to apply. Deploy is worker-only, and follows the usual dev → smoke
→ prod order (re-run the prod row-count check from "Deploy-time behaviour
change" above before the prod step):

```bash
# dev
(cd worker && op run --env-file=../.env -- npx wrangler deploy --env dev)

# smoke — the operator's shell only, see "Smoke" below
op run --env-file=.env -- uv run bin/config-smoke.py > /tmp/config-smoke.out 2>&1

# prod
bin/deploy.sh
```

### Smoke

`bin/config-smoke.py` (PEP 723, `uv run`, credentials injected via `op run`,
runs in the operator's shell like the other harnesses — not from an agent
session): GET contexts (expect 5, all `source:"default"`) → PATCH `deep`
with an extreme curve + PATCH the churn weight → GET both (verify
`source:"custom"`, merged values) → run a resolve (proves the solver accepts
the customised payload live) → DELETE both → GET (back to `source:"default"`).

### Known v1 limitations

- **Snapshot granularity, not field granularity.** Customising a context
  snapshots ALL its fields; it stops tracking future instance-default
  changes on the whole row until reset via `DELETE`. Same for weights.
- **`source` is per-context / per-weights-row, not per-field** — a context
  or weights row reads `"custom"` in full even if only one field was ever
  touched, because a PATCH always stores a complete snapshot.
- **No sensibleness validation of curves.** A curve like a 1-minute peak at
  03:00 is accepted — the worker and solver only enforce ordering, not
  whether a curve is a reasonable schedule preference. MCP clients visualise
  it; the user judges.
- **Instance defaults still change only via migration.** There is no admin
  API for editing the `'__default__'` rows.
- **`weights_override` is still unvalidated.** It remains
  `z.record(z.number())` on `resolve` (`worker/src/planning/resolve.ts`) and
  can send values the new `PATCH /v1/weights` surface would reject (e.g.
  fractional). Tightening it to the same Zod shape is a follow-up, not part
  of this change.
- **Concurrent PATCHes are last-write-wins.** `saveContextConfig` /
  `saveWeights` are read-merge-write with no CAS or version column (adding
  one would need a migration, which this feature deliberately avoids): two
  racing PATCHes for the same owner both read the same base snapshot, and
  the second write silently discards the first's fields — both callers get
  200. Acceptable v1 semantics for a user's own single-row config; a
  version-column CAS (the `db/bookings.ts` pattern) is the follow-up if it
  ever matters.
- **A zero cap is deliberately rejected.** `max_minutes_per_day` /
  `max_contiguous_minutes` are positive-or-null even though the solver's
  contract would accept `0` — suppressing a context entirely should be done
  by not scheduling tasks in it, not via a cap that silently drops
  everything. The API descriptions state this.

### Vendor follow-up

codemode-mcp vendors the optical OpenAPI spec. This feature adds 5 new
operationIds (`updateContext`, `resetContext`, `getWeights`, `updateWeights`,
`resetWeights`) and changes an existing one's response shape (`getContexts`
gains `source` and the always-5-entries guarantee — see "Deploy-time
behaviour change" above). The vendor refresh PR for this change has not been
cut yet — do it alongside the optical deploy, same as every other spec
change (see §M's "Vendor follow-up" for the pattern). The MCP spec reads
stale once immediately after a deploy — call it twice to pick up the fresh
version.

## O. Microsoft 365 (Outlook) provider

Adds Microsoft 365/Outlook as a second `CalendarProvider`/`IdentityProvider`/
`NotificationProvider` implementation, selected per-user (`identity_tokens.
provider`, default `'google'`) rather than per-deployment. Design doc:
internal design notes.

### Gate flag (`MS_PROVIDER_ENABLED`)

```toml
# Under the target environment's vars block (e.g. [env.dev.vars]):
MS_PROVIDER_ENABLED = "true"
```

Default `"false"` in both envs until an Entra app registration exists and dev
smoke has passed. When `"false"`, `/authorize` behaves exactly as before
(straight to Google, no provider chooser).

**This flag is a kill switch, not just a new-signup gate.** Provider
resolution reads it on every request that needs a Microsoft token or Graph
call — refresh, event sync, webhook processing, sendMail — not only at
sign-in. Flipping it back to `"false"` after Microsoft users already exist
therefore does not just hide the sign-in option: it also blocks token refresh
and all Graph API access for *every already-provisioned* Microsoft user,
immediately, on the next request that needs one. Their rows in
`identity_tokens` are untouched (no data loss, no re-consent needed to
recover), but until the flag is re-enabled those accounts get no calendar
sync, no chunk placement, and no replan emails — effectively frozen, the same
way owned meetings degrade to immovable when their gate is off. This is a
deliberate wave B review decision (fail closed across the whole provider, not
just at the front door): treat disabling the flag with an already-onboarded
Microsoft user base as equivalent to a maintenance window for those accounts,
not a no-op.

One operation is deliberately exempt from failing closed: **offboarding**.
`offboardUser` treats calendar-provider construction as best-effort — with
the flag off it logs `ms_provider_disabled`, skips the calendar-side cleanup
(Graph subscription stop + chunk-event sweep; the subscription self-expires
in ~3 days), and still performs the full D1 removal, KV cache purge, DO
reset, and deactivation. A disabled provider must never make its users
un-removable.

The mechanism is a typed error, not a string match: `index-providers.ts`
exports `ProviderDisabledError`, thrown by `defaultIdentityProvider` when
`MS_PROVIDER_ENABLED` is off (message `ms_provider_disabled` unchanged).
`defaultProviders(env, subject)` — the shared bundle factory used by the
cron entry point, the resolve coordinator, `run-cron-route`, and
`replan-now` — resolves the subject's stored provider *unconditionally*
(never short-circuits on the flag) so the resolved name still reaches
`defaultIdentityProvider` and throws there; the flag is a runtime kill
switch over already-provisioned rows, not a signup gate, so skipping the
D1 lookup would risk serving a provisioned Microsoft subject a Google
provider over the subject-keyed token cache. `offboardUser` is the one
caller that catches this specific error (`instanceof ProviderDisabledError`)
to degrade — any *other* provider-construction error (a transient D1
failure, for example) is rethrown and aborts the offboard before any row is
deleted, so a flaky dependency can no longer silently skip calendar cleanup
and delete the user anyway. `/oauth/authorize`'s provider chooser
(`enabledProviders(env)`) offers Microsoft only when the flag is `"true"`
**and** `MICROSOFT_OAUTH_CLIENT_ID` is a real, non-empty value — a
placeholder client ID (the pre-registration default) means no chooser is
shown and the flow goes straight to Google, exactly as before Microsoft
existed as an option.

### Identity: verified claims only, never Graph `/me.mail`

`MicrosoftIdentityProvider.fetchIdentity` (`worker/src/auth/
microsoft-identity-provider.ts`) derives identity from the **id_token**
returned by the token endpoint (fetched directly over TLS with the client
secret, so the payload is trusted without a signature check — but `aud`,
`exp`, and the `tid`/`oid` subject claims are still validated), never from
Graph `/me.mail`. `/me.mail` is free text any tenant admin can set to
someone else's address; under the multi-tenant `common` endpoint that is an
account-takeover primitive (the "nOAuth" class) against any allow-listed
email, including `OPERATOR_EMAIL`. Resolution order:
1. the `email` claim, only when `xms_edov` is `true` (Entra attests the
   domain owner);
2. else `preferred_username` (the UPN) — its domain suffix is always
   tenant-verified, including the consumer tenant
   (`9188040d-6c67-4c5b-b112-36a304b66dad`), where it's the MSA address;
3. reject with `unverified_identity` when the UPN contains `#EXT#` (a guest
   account), when neither claim resolves, or when the id_token is missing
   entirely.
The email is lower-cased exactly once, immediately after `fetchIdentity`
returns (`oauth-provider.ts`'s callback) — every downstream key
(`identity_tokens`, `users`, `oauth_codes.subject`, `calendar_sync` owner)
compares the raw string with no `COLLATE NOCASE`, and Entra echoes a UPN in
whatever casing it was set with.

Both identity providers now fail closed on an unverified identity, not just
Microsoft: `GoogleIdentityProvider.fetchIdentity` rejects with
`unverified_email` unless userinfo returns `verified_email: true` (Google's
own guidance — a legacy Google-account-on-a-non-Google-address flow can
otherwise carry an unverified `email`). This isn't the nOAuth class above
(Google's `email` is Google-verified, not editable by a third-party tenant
admin), but the same fail-closed posture as Microsoft's `unverified_identity`
reject.

**Rollout note:** an existing Microsoft user whose UPN differs from their
primary SMTP address is now identified by UPN, not by mail — they'll need
to re-login (and may need a fresh allow-list entry keyed by the UPN rather
than the mailbox address). Before deploying to an env with existing
Microsoft users, check `identity_tokens.account_email` there against what
the UPN will resolve to. Never allow-list `*@*.onmicrosoft.com`: it's a
self-service, unverified suffix any consumer tenant can claim.

**DEPLOY GATE — required before this identity rule reaches an env with
existing Microsoft users** (an env with no Microsoft rows yet needs only
step 3):
1. Read `identity_tokens.account_email` on the target env and confirm no
   existing Microsoft row is keyed by an address the new resolution order
   would no longer produce.
2. Confirm the Entra app registration emits `xms_edov` and `email` as
   optional claims on the id_token — without them, branch 1 above is dead
   and every work account is keyed by UPN unconditionally.
3. Do one live Microsoft sign-in on the target env and confirm in logs
   which branch fired, and that `tid`/`oid` are present on the test
   account's token. (The code does not log the branch; read it off the
   row instead — `identity_tokens.provider_subject` is `tid:oid`, so its
   presence proves both claims, and an MSA `tid`
   `9188040d-6c67-4c5b-b112-36a304b66dad` with an unchanged address can
   only be the UPN branch.)


**Superseded by the identity anchor below, but only partially:** migration
`0037` (Card G) means the re-key risk in gate item 1 is now bounded to rows
that pre-date `0037` **and are still `identity_tokens.provider_subject IS
NULL`** — i.e. haven't logged in since that migration shipped. Any row that
already carries a `provider_subject` self-heals on the next login regardless
of what the token's email/UPN says (drift is logged, never a lost account).
Gate item 1 therefore only needs to inspect the NULL subset before deploying
to an env with existing Microsoft users; a non-NULL row is safe as-is.

### Identity anchor: provider subject

Every user key in D1 (`identity_tokens.account_email`, `users.subject`,
`tasks`/`calendar_sync`/`oauth_tokens` owner columns) is the email the IdP
handed us at sign-in — and that email is mutable (Entra UPN/mail renames,
domain consolidation; see the rollout note above). Migration `0037`
(`identity_tokens.provider_subject TEXT`, partial unique index on
`(provider, provider_subject) WHERE provider_subject IS NOT NULL`) anchors
identity on each provider's **immutable** subject instead:
- Microsoft: `` `${tid}:${oid}` `` (`microsoft-identity-provider.ts`) — both
  claims are already required by the existing subject-claim check.
- Google: userinfo's `id` field (`google-identity-provider.ts`), rejected
  with `no_subject_in_userinfo` when absent — same fail-closed posture as
  `unverified_email`.

`IdentityProvider.fetchIdentity` now returns `{ email, providerSubject }`.
`/auth/callback` (`oauth-provider.ts`) resolves the login's internal
`subject` via `resolveSubject(env, provider, providerSubject, email)`
(`identity-store.ts`) immediately after the once-only email
lower-casing and before the membership gate:
- **Subject match** — a row already keyed by `(provider, provider_subject)`
  exists: `subject` is that row's `account_email`, for life, even if the
  token's email has since changed. **No rename is performed.** A mismatch
  only logs `console.warn("identity_email_drift provider=…
  provider_subject=… stored=… token=…")` for operator visibility (the field
  is `provider_subject=`, not `subject=` — everywhere else `subject` means
  the internal email key). Membership, the credential
  store, the `users` touch/upsert (including the `OPERATOR_EMAIL` seed-admin
  check), the Microsoft done-colour seed, and the minted `oauth_codes.subject`
  all key off this resolved `subject` — so a renamed-but-already-active user
  completes login even if their *new* address isn't allow-listed, while a
  genuinely brand-new user is still gated by allow-list on their email,
  unchanged.
- **No subject match** — first-ever sign-in, or a legacy pre-`0037` row
  that has never had a `provider_subject` written to it: `subject` is the
  token's email. `storeIdentityTokens` (now taking a trailing
  `providerSubject` param) always writes it on every store via an upsert
  (`INSERT … ON CONFLICT(account_email) DO UPDATE`) keyed on `account_email`
  — this is also how a legacy row gets backfilled, with no special-cased
  migration step. (Deliberately not `INSERT OR REPLACE`: that resolves a
  conflict on *any* unique constraint — including the `(provider,
  provider_subject)` index — by deleting the conflicting row first, which
  would silently destroy a different account's credential on a genuine
  subject collision instead of failing loud.)
- **Conflict (rule 6)** — the subject row says account A, but the token's
  *new* email is already B's own row under the same provider: the subject
  match wins (A keeps the credential; A's `subject` is used downstream) and
  B's row is left completely untouched — `resolveSubject` never writes
  anything itself, so there's nothing for it to touch. **Known v1
  limitation:** no merge tooling exists for this case; it's expected to be
  rare (two independent identities colliding on the same new email) and is
  surfaced only via the drift log line.
- **Same-provider rebind** — the IdP-side identity is re-created under the
  *same* mailbox (an Entra object deleted and recreated: same UPN, new
  `oid`): the stored `provider_subject` is overwritten with no gate (it's
  the same mailbox, so this is correct), but logged —
  `console.warn("identity_subject_rebound provider=… email=… old=… new=…")`
  — since it's otherwise silent. Does not fire on the legacy-row backfill
  (`NULL` → a value) or across a provider switch (comparing subjects
  between two different IdPs is meaningless; that case already resets
  `calendar_sync`/`done_color_id` below).

**`OPERATOR_EMAIL` stays keyed on the resolved `subject`, not the token's
current email** — it must therefore list the operator's *original*
sign-in address. After an IdP-side rename the seed-admin check
(`csv(OPERATOR_EMAIL).includes(subject)`) is evaluated against that
original email by design, so a drifted token email can never itself claim
admin; the already-admin user keeps their role regardless via
`touchLastSeen`, which never changes role.

Google's `fetchIdentity` reads `id` from the same `/oauth2/v2/userinfo`
call already used for `email`/`verified_email` — no new scope, no OIDC
id_token parsing (the userinfo `id` is the same value the id_token's `sub`
claim would carry).

### Provider switch (same email, different IdP)

Signing in with the *other* provider under the same email address is not a
no-op: `storeIdentityTokens` (`auth/identity-store.ts`) detects the stored
`provider` changing and, in the same write path as the new credential,
resets that subject's `calendar_sync` row (`next_sync_token` and all
channel fields) and `users.done_color_id` — both are provider-shaped (a
Google sync token thrown at Graph raises `Invalid URL`, never a clean 410,
and would otherwise wedge webhook-triggered replan forever). The next
resolve re-seeds `done_color_id` for the new provider. `getAccessToken`'s
refresh-token write is provider-guarded (`WHERE account_email=? AND
provider=?`) so a refresh that was in flight on the old provider can't
clobber the new provider's freshly-stored credential.

What a switch does **not** clean up, by design (v1): the old provider's
push channel/subscription is **abandoned, not stopped** — Graph and Google
both keep sending change notifications to a channel `calendar_sync` no
longer references, which 404 harmlessly against a route that can't find a
matching row, and can no longer be stopped via `/admin/stop-channel`
afterwards (there's no row left to look it up by) — it just runs out its
own lifetime. Chunk events already committed to the old calendar are
stranded there; there is no switch-time ghost sweep in v1, so a user who
switches provider needs to manually clean up any chunk events left on
their old calendar.

### Webhooks & subscriptions

- **Lifecycle events force a re-ensure.** `reauthorizationRequired`,
  `subscriptionRemoved`, and `missed` notifications call `ensureSubscription`
  with `force: true`, bypassing the normal 48h freshness gate — Graph is
  telling us the stored expiry can't be trusted, so waiting for the gate to
  open would leave the subscription dead for up to ~46h. `missed` also
  enqueues an immediate replan (`RESOLVE_COORDINATOR.notifyChange`) on top
  of the re-ensure: unlike the other two lifecycle events (which are about
  the subscription itself), `missed` means Graph couldn't guarantee delivery
  of some change notifications during an outage, so a real change could
  otherwise sit unnoticed until the next unrelated trigger.
- **Weekly forced rotation.** `ensureSubscription` normally renews
  in-place (PATCH, same `channel_id`/`clientState` forever) whenever the
  channel and callback URL are unchanged. Once a week — `now.getUTCDay() ===
  0` (UTC Sunday) — it forces the full rotate path (new subscription, new
  token, stop the old one) instead, so the webhook secret (`clientState`)
  actually rotates rather than living forever. This is date-derived, not
  state-tracked (no `rotated_at` column — a follow-up), and depends on two
  things staying true together: the 4200-minute Graph subscription lifetime
  keeps the 48h freshness gate open on every day of the week including
  Sunday, and the daily 04:00 cron actually runs that day. If either changes,
  the weekly rotate can silently stop firing.
- The rotate path's stop-the-old-channel gate uses **truthiness** on the
  channel id (`priorChannelId &&`, not `!= null`) — a stored `channel_id ===
  ""` (never a real value) no longer attempts a doomed stop call. The
  resource-id side of the same gate keeps `!= null`, since `""` is a valid
  Microsoft resourceId.
- A newly created Graph subscription's id is logged
  (`ensureSubscription: new subscription created`) **before** the D1 upsert
  that persists it — if that write throws, the log line is the only trail
  back to an otherwise-orphaned Graph subscription (recoverable via
  `/admin/stop-channel`).
- The webhook route (`webhooks/microsoft-calendar.ts`) 202s on a JSON `null`
  body or a non-array `value` instead of 500ing; distinct `subscriptionId`s
  are looked up once each (`Promise.all`, not once per notification), capped
  at 100 distinct ids per batch (unauthenticated route — an oversized or
  adversarial batch must not fan out unboundedly many D1 lookups); and the
  owner `notifyChange` fan-out and the lifecycle re-ensure both run in the
  same deferred `waitUntil` block, off the request path, each iteration
  wrapped in its own try/catch so one owner's rejecting DO call or failed
  re-ensure doesn't skip the rest.
- `booking-decline-sweep.ts` constructs each owner's calendar provider
  inside a per-owner try/catch — one Microsoft owner hitting the kill switch
  (`ms_provider_disabled`) or a transient D1 error no longer aborts the
  sweep for every other owner. Those rows are counted separately
  (`skippedOwners`/`skippedRows` in the summary), distinct from `failed`
  (a row that was actually attempted and failed).

### Calendar semantics

- **`createEvent` maps attendees and Teams.** `event.attendees` becomes
  Graph `attendees[{emailAddress:{address}, type: "required"|"optional"}]`;
  `opts.addMeet` becomes `isOnlineMeeting: true, onlineMeetingProvider:
  "teamsForBusiness"`. `notifyAttendees` is implicit on Graph (no
  send-updates knob to set). This 400s if the organiser is a personal MSA
  mailbox without a Teams license and `addMeet` is requested — a booking
  create on such an account fails hard rather than degrading. Neither
  provider currently surfaces a join URL on `CalendarEvent` (Graph returns
  `onlineMeeting.joinUrl` on the create response but there's no field to put
  it in) — follow-up.
- **`updateEvent` read-merges categories.** A done-marker PATCH first `GET`s
  `?$select=categories`, then sends the merged array (add or remove only
  the Optical Done marker) instead of overwriting the whole array — the
  naive whole-array PATCH used to wipe every other Outlook category the
  user had on that event. The GET→PATCH pair is not atomic: a category edit
  the user makes in Outlook during that window can be lost.
- **Done-marker default is provider-shaped (Card H,
  internal design notes).** `CalendarProvider` carries a
  `defaultDoneColorId` — `getDoneColorId` (`worker/src/db/users.ts`)
  resolves it ahead of the env default at all three call sites
  (`resolve-internal.ts`'s `reconcileChunkCompletions`, the webhook replan's
  done-color pinhole, and the PATCH-to-done recolor handler). Precedence:
  `users.done_color_id` > provider `defaultDoneColorId` (Microsoft:
  `"Optical Done"`; Google omits it, so the env default stays authoritative
  there) > `env.DONE_COLOR_ID`. Before this, a `NULL` `users.done_color_id`
  row on a Microsoft-provider subject silently fell through straight to
  `env.DONE_COLOR_ID` — a Google colorId ("11") that Outlook's category
  comparison can never match — so done-marking stopped working until the
  next sign-in re-seeded the column via `seedDoneColorIdIfUnset`. A `NULL`
  row no longer silences MS done-marking.
  **Gotcha (2026-08-21, Microsoft smoke env):** `regression-smoke.py --provider
  microsoft` failed L6 ("done tasks still scheduled", all 3 — the two
  API-done tasks and the category-painted one) and L7 (chunk #0's event
  still on the calendar). `wrangler tail` showed every resolve's
  `dbg_resolve_chunk_reconcile` carrying `"doneColorId":"11"`. Root cause
  was **not** the worker: `bin/ms-smoke.py` step 5's `finally` ran
  `set_done_color_id(d1, subject, None)` unconditionally after every
  attempt, wiping out whatever the real login callback had just seeded.
  Fixed in the same card: step 5 now reads the prior value with the new
  `get_done_color_id` (`bin/_smoke_lib.py`) before seeding
  `"Optical Done"`, and its `finally` restores exactly that value (`NULL`
  included, e.g. for a Google-provider subject on dev) instead of always
  clearing it. Post-restore rerun on the pre-fix deploy: L7 PASS, L6
  baseline-drop only (Friday-capacity artifact — run L6 Mon–Thu). Full
  ladder still to be re-run after this card deploys.
- **Freebusy**: `queryFreeBusy` prefers `scheduleItems` when Graph returns
  them; when they're absent (or present but empty) it falls back to the
  coarser `availabilityView` (30-minute characters, floored/clamped to the
  requested window: `0` free, `4` (workingElsewhere) free, `1`/`2`/`3`
  busy); when neither is present it returns `{ error: "no_schedule_detail"
  }`, which freezes the meeting under the existing unknown-freebusy policy
  (see section J) rather than silently reporting no conflicts. `getSchedule`
  batches now issue concurrently (`Promise.all`), not sequentially.
- **`workingElsewhere` is free** on both the `scheduleItems` and
  `availabilityView` decode paths, matching `isBusyGraphEvent`'s treatment
  of calendar events (the older code kept it busy on one path and free on
  the other).
- **Tentative and out-of-office mapping.** `showAs: tentative` maps to
  `CalendarEvent.status: "tentative"`, making `TENTATIVE_IS_BUSY` actually
  do something for Microsoft users (previously inert). `showAs: oof` is
  deliberately **not** mapped to `eventType: "outOfOffice"`: Graph's `oof`
  is a per-appointment flag on any event, not Google's deliberate
  whole-day event kind, and `busy-blocks` expands any `outOfOffice` event
  to the whole local day — mapping it would turn a two-hour Outlook OOF
  appointment into a day-long block. A timed Outlook OOF blocks only its
  own span; an all-day one already expands correctly via `isAllDay`.
  Set `TENTATIVE_IS_BUSY` to `"true"` on every env that hosts Microsoft
  users (the Google default is `"false"`): Outlook marks every un-RSVP'd invite
  `showAs: tentative`, so the Google default would silently let the solver,
  booking page, and polls place on top of pending invites. Flip per-env
  deliberately if parity with Google's default is wanted elsewhere.
- **Token-less reads use a plain calendar view, not the delta.**
  `fetchEventsInWindow(start, end, { syncToken: false })` issues a bounded
  `/me/calendarView` read and returns `nextSyncToken: ""` instead of
  opening/continuing a delta chain — used at every call site that discards
  the returned sync token anyway (booking availability, poll booking/route,
  the calendar feed, scheduler chunk lookups, offboard, and both
  `commit.ts` call sites). Sites that actually consume the token (resolve,
  the webhook full refetch) are unchanged. An empty `@odata.deltaLink` from
  the full-fetch path now throws (`graph_delta_no_deltalink`) instead of
  silently returning an unpersisted empty token; the incremental path
  returns `syncTokenInvalidated: true` in the same situation, forcing a
  full resync on the next cycle instead of staling quietly. Each
  `createEvent` attempt gets a fresh `crypto.randomUUID()` `transactionId`
  (was a stable chunk-derived id, which a deleted-then-recreated chunk
  would replay).
- `fetchEventsInWindow` (delta and plain paths) skips Graph-cancelled events
  (`isCancelled`) on the initial fetch path too, matching the incremental
  path; both paths share one `isDeletedGraphEvent` tombstone predicate.

### Harness

- `bin/_smoke_lib.py` has exactly one `assert_dev_url` (an old duplicate
  definition silently shadowed the first). Its allow-list is the dev custom
  domain and `*.workers.dev`; prod's own custom domain **and** prod's
  workers.dev label are both refused. `regression-smoke.py` uses the same
  guard.
- `assert_env_consistent(url, db_id)` cross-checks the target host against
  the D1 id so a mismatched `--url`/`D1_DATABASE_ID` pair fails fast instead
  of quietly reading or wiping the wrong database.
- `d1_for_db_id(db_id, repo_root)` derives the `DevD1` `env_name` from the
  target db id (`"dev"`), with `SMOKE_WRANGLER_ENV` still winning when set.
  Both `reset-smoke-env.py` and `ms-smoke.py` use it.
- `ms-smoke.py step1_gate_probe` classifies every outcome instead of only
  recognising `unknown_provider`: the expected gate error passes, a success
  where the gate should be closed fails, and any other error fails with the
  error shown (the gate runs *after* client/redirect validation, so a
  precondition failure elsewhere used to be misread as never having reached
  the gate).
- `ms-smoke.py`'s `--url`/`--client-id` CLI flags are now threaded into
  `MsEnv.from_environ` (CLI wins over the environment variable) — previously
  parsed and silently ignored.
- `GraphCalendarClient` sends `Prefer: IdType="ImmutableId", …` on every
  verb, not just some — without it, Graph ids the harness records can drift
  when an event moves folders, unlike the worker's own reads.
- `DoneMarking.for_provider` ignores (with a stderr warning) a
  `SMOKE_DONE_COLOR_ID` override on `--provider microsoft` unless it names
  the Optical Done category — a stale Google colorId value used to break an
  MS run with a misleading error instead of being ignored.
- `GET /v1/whoami` returns an additive `provider: "google" | "microsoft"`
  field (WP0 of internal design notes), resolved via the
  same `getSubjectProvider` lookup `calendar-access-token.ts` uses and
  defaulting to `"google"` for a subject with no `identity_tokens` row. This
  is the seam the smoke runner's identity work (WP1) uses to assert a
  minted bearer's actual provider matches `--provider` before handing it to
  a harness, instead of trusting only the config-email match.

### Entra app registration (manual, one-time per environment)

1. Azure Portal -> **Entra ID** -> **App registrations** -> **New
   registration**.
2. **Supported account types:** "Accounts in any organizational directory
   (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft
   accounts" — this is what `MICROSOFT_TENANT = "common"` expects.
3. **Redirect URI** (platform: Web):
   - Dev: `https://scheduler-dev.example.com/auth/callback`
   - Prod: `https://scheduler.example.com/auth/callback`
   Register both if using one app across environments, or one URI per
   per-environment app — either works; keep the client ID/secret pair
   consistent with whichever app the target env's vars point at.
4. **API permissions** (Microsoft Graph, delegated):
   - `openid`, `profile`, `email`, `offline_access`
   - `Calendars.ReadWrite`
   - `Mail.Send`
   - `Mail.Read` — flag-gated by `MICROSOFT_MAIL_READ_SCOPE_ENABLED`
     (default unset/"false", non-prod only, never prod). Only requested when
     the flag is on; needed so `bin/poll-smoke.py --provider microsoft` can
     read the organiser's Sent Items to relay invitee capability links,
     mirroring `GOOGLE_GMAIL_READ_SCOPE_ENABLED` / `gmail.readonly` on the
     Google side (WP0 of internal design notes). Flipping
     the flag on for an already-provisioned account requires re-consent —
     re-mint (`./bin/mint-token.py --provider microsoft …`) to pick it up.
   Grant admin consent only if testing under a managed tenant that requires
   it; the `common` multitenant + personal-account registration otherwise
   relies on per-user consent at sign-in.
5. **Certificates & secrets** -> **New client secret**. Client secrets expire
   at most 24 months out — set a calendar reminder well before expiry (the
   secret cannot be recovered after creation, only rotated: create a new one,
   push it via `op run -- npx wrangler secret put MICROSOFT_OAUTH_CLIENT_SECRET
   --env <env>`, then delete the old one from the Entra app once the new
   secret is confirmed live).
6. Copy the **Application (client) ID** into `MICROSOFT_OAUTH_CLIENT_ID` under
   the target env's vars in `worker/wrangler.toml` (replacing the
   `<set after Entra app registration>` placeholder), then deploy.
7. **Unverified-publisher warning:** until the app goes through Microsoft's
   publisher verification, personal/consumer accounts and accounts in "strict"
   managed tenants see an "unverified publisher" interstitial during consent.
   This is expected in v1; publisher verification is deferred.

### M365 dev-tenant setup

Live smoke coverage needs a real Microsoft 365 tenant with at least **two**
mailboxes (one organiser, one attendee — mirrors the Google
`bin/meeting-smoke.py` two-account topology) so owned-meeting freebusy can be
exercised end to end.

1. Enroll in the **Microsoft 365 Developer Program**
   (`developer.microsoft.com/microsoft-365/dev-program`) for a renewable
   sandbox tenant with Exchange/Outlook licensing included, or provision a
   time-limited **trial tenant** if a Developer Program tenant isn't
   available.
2. Create at least 2 user mailboxes in the tenant (e.g. an "organiser" and an
   "attendee" account) — needed for the `ms-smoke` harness's owned-meeting
   freebusy scenario (Task 15).
3. Sign in as each via `./bin/mint-token.py --provider microsoft --url
   https://scheduler-dev.example.com --client-id smoke-cli` to
   provision `identity_tokens` rows with `provider = 'microsoft'`.

### Known v1 limitations

- **Cross-provider freebusy.** An organiser's `queryFreeBusy` runs through
  *their own* provider only. If a Microsoft-organised meeting has a Google
  attendee (or vice versa), that attendee's calendar cannot be read through
  the organiser's Graph/Google API and surfaces as a per-schedule error —
  triggering the same degrade-to-immovable path as any other unreadable
  free/busy (see section J). This is the same limitation class as the
  existing Google-only behaviour, not a new gap introduced by Microsoft
  support.
- **Done-marking is exact-category-name coupled.** For Microsoft users,
  `done_color_id` stores an Outlook **category name** — `"Optical Done"` by
  default (the provider's `defaultDoneColorId` floor, per-user overridable
  via `users.done_color_id`; see the "Done-marker default is provider-shaped"
  bullet under Calendar semantics above) — and the provider maps
  `categories` <-> `colorId` by that exact string in both directions. If a
  user renames or deletes the category in Outlook, done-marking silently
  stops round-tripping for that user — there is no reconciliation or
  rename-detection in v1. Un-marking done writes an explicit empty
  `categories` list (the provider's `undoneColorId` is `""`),
  which also clears any categories the user added to that chunk event by
  hand — acceptable because chunk events are scheduler-owned.
- **Unverified-publisher consent warning.** See Entra registration step 7
  above — cosmetic but can alarm first-time signers-in; publisher
  verification is deferred, not planned for v1.
- **`guestsCanModify` out of scope**, same as the existing Google limitation:
  a Microsoft user cannot move a meeting they can edit but do not organise.
- **No rich Graph webhook payloads.** Change notifications carry no resource
  data (Microsoft's "rich notifications" preview is not used); every ping
  triggers a delta refetch, same pattern as the Google webhook.
- **No PKCE on the Microsoft OAuth flow in v1.** The Microsoft flow is a
  confidential client with a client secret; Microsoft recommends but does not
  require PKCE for confidential clients, so it is deferred.
- **No switch-time ghost sweep.** A provider switch (see above) resets sync
  state cleanly but leaves chunk events already committed to the old
  calendar in place, and abandons (rather than stops) the old push channel.
  Both are manual cleanup in v1.
- **No join URL surfaced by either provider.** Graph's create response and
  Google's Meet link both exist upstream, but `CalendarEvent` has no field
  for either — a booked Teams/Meet meeting's join link isn't visible through
  Optical.
- **Categories read-merge is not atomic.** `updateEvent`'s done-marker PATCH
  is a GET-then-PATCH; a concurrent category edit by the user in Outlook
  during that window can be lost.
- **`addMeet` 400s on a personal MSA mailbox without Teams.** There's no
  fallback — the booking create fails hard rather than degrading to no
  online-meeting link.
- **Weekly channel-secret rotation is date-derived, not state-tracked.** It
  depends on the 4200-minute subscription lifetime and the daily 04:00 cron
  both continuing to hold; there's no `rotated_at` column to verify it
  actually fired (follow-up).

### Extended-properties spike — validate before building on it

The Graph analogue of Google's `extendedProperties.private` metadata
(`scheduler_chunk_id`, `optical_meeting_task_id`) is
`singleValueExtendedProperties`, addressed by a fixed GUID property-set
namespace generated once and committed as a constant. **Before relying on
this for chunk/meeting identification, confirm it survives the read paths
Optical actually uses**: a `$expand=singleValueExtendedProperties($filter=...)`
query must round-trip through both `calendarView` (initial fetch) and
`delta` (incremental sync) — not just a plain `GET /events/{id}`. This is
the first thing to validate when implementing the Microsoft calendar
provider, and it is re-verified live by the `ms-smoke` harness (Task 15,
step 3): it fetches a created event raw via Graph and asserts
`scheduler_chunk_id` comes back through `fetchEventsInWindow`. If the
round-trip does not hold, the documented fallback is Graph **open
extensions** instead of `singleValueExtendedProperties`, isolated behind the
same `graphPropId`/mapping boundary so no other code needs to change.

**Gaps found by static review while building the `ms-smoke` harness (Task 15,
2026-07-02) — both fixed pre-merge, commit `5f734c3`:**
- `worker/src/handlers/calendar-access-token.ts` called
  `defaultIdentityProvider(c.env)` with no `provider` argument, so it always
  resolved the **Google** `IdentityProvider` regardless of the caller's own
  `identity_tokens.provider`. Every Graph call the harness makes (it mints its
  token the same way `bin/meeting-smoke.py`'s `CalendarClient` does, via
  `GET /v1/calendar-access-token`) would have failed or misbehaved for a
  Microsoft-provider subject. Fixed: the route now resolves the provider first
  (`getSubjectProvider(env, owner)` → `defaultIdentityProvider(env, provider)`,
  matching `defaultCalendarProvider`/`defaultNotificationProvider` in
  `worker/src/index-providers.ts`).
- `MicrosoftCalendarProvider.fetchEventsInWindow`
  (`worker/src/providers/microsoft-calendar-provider.ts`) requested only
  `startDateTime`/`endDateTime` on `/me/calendarView/delta` — no
  `$expand=singleValueExtendedProperties(...)`. Fixed: the initial delta
  request now sends `$expand=singleValueExtendedProperties($filter=...)` for
  both `scheduler_chunk_id` and `optical_meeting_task_id`.

Both fixes are unit-tested (`worker/test/v1-calendar-access-token.test.ts`,
`worker/test/providers/microsoft-calendar-provider.test.ts`), but neither has
been exercised against live Graph yet — the round-trip validation described
above (the `ms-smoke` step 3 ext-prop gate) is still a required LIVE step
before this feature ships, not a settled fact.

### Graph delta is window-bound (why the provider opens a wide horizon)

Google's sync token spans the whole calendar; a Graph `calendarView/delta`
deltaLink only reports changes inside the `startDateTime`/`endDateTime` it
was created with. Resolve stores the deltaLink from its one-week fetch as
`calendar_sync.next_sync_token`, so a naive port meant webhook change
detection only saw the **last resolved week** (live L8 on the Microsoft
smoke env, 2026-08-20: a chunk dragged in week A was never reported once week B had
been resolved — `dbg_webhook_fetch raw=1` listed only week B). The
provider therefore always opens the delta over `[now-28d, now+365d] ∪
requested window` (28d back = the done-scan's reach) and filters the
returned events to the requested window; each resolve re-opens a fresh
horizon, so it rolls forward weekly under the Monday cron. Known
limitation: an account whose last resolve was more than ~11 months ago has a
horizon that no longer covers "next week" — the next resolve heals it.

The same log line confirmed live that `scheduler_chunk_id` survives the
`calendarView/delta` round-trip (`sched_owned=true`) — the extended-
properties spike below is validated; the open-extensions fallback is not
needed.

### Microsoft smoke on dev

The public config has no separate Microsoft smoke deployment: every
`--provider microsoft` harness (`regression-smoke.py`, `multiuser-smoke.py`,
`meeting-smoke.py`, `poll-smoke.py`, `booking-smoke.py`, `ms-smoke.py`)
targets dev. `--wrangler-env` only offers `dev`, and `SMOKE_WRANGLER_ENV`
defaults to `dev`. To enable it, set these under `[env.dev.vars]` in
`worker/wrangler.toml`:

```toml
MS_PROVIDER_ENABLED = "true"
MICROSOFT_OAUTH_CLIENT_ID = "<from the Entra app registration above>"
MICROSOFT_TENANT = "common"
# poll-smoke / decline-smoke read the organiser's Sent Items (never in prod):
MICROSOFT_MAIL_READ_SCOPE_ENABLED = "true"
# Outlook marks un-RSVP'd invites tentative (see "Tentative and
# out-of-office mapping" above):
TENTATIVE_IS_BUSY = "true"
```

Admit the smoke accounts in `MEMBERSHIP_ALLOWLIST` (wildcard the consumer
domains such as `*@outlook.com` for personal accounts; list work-tenant
mailboxes **by name**, never `*@<tenant>.onmicrosoft.com`, which would admit
every mailbox ever provisioned in that tenant). The multiuser ladder's A
letter must also be in `OPERATOR_EMAIL`, or M7 (`/admin/offboard`) and M8
(`/admin/renew-subscriptions`) fail with 403 `forbidden_not_admin`. Then push
the client secret, apply migrations and deploy:

```bash
cd worker
op run --env-file=../.env -- npx wrangler secret put MICROSOFT_OAUTH_CLIENT_SECRET --env dev
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
cd .. && ./bin/mint-token.py --provider microsoft --url https://scheduler-dev.example.com --client-id smoke-cli
```

The Entra app's Web redirect URI must be exactly
`https://scheduler-dev.example.com/auth/callback` (step 3 above).


**Personal (outlook.com) accounts:** Graph `getSchedule` is unsupported for
consumer mailboxes, so attendee free/busy resolves as unknown and owned
meetings degrade to immovable — expected, not a failure. Everything else
(calendarView/delta, extended properties, categories, subscriptions,
sendMail) is available to personal accounts.

### Running `ms-smoke`

```bash
# Prerequisite (interactive, once): mint a Microsoft-provider bearer/refresh
# token — mirrors the meeting-smoke re-consent prerequisite, not automated by
# the harness itself.
./bin/mint-token.py --provider microsoft \
  --url https://scheduler-dev.example.com --client-id smoke-cli
export SCHEDULER_URL=https://scheduler-dev.example.com
export SCHEDULER_BEARER=...        # from mint-token's output
export SCHEDULER_REFRESH_TOKEN=... # from mint-token's output
export EXPECTED_TEST_ACCOUNT=...   # the Microsoft account's email
# Step 5 (done-category) needs D1 access (no API write path for done_color_id):
export D1_DATABASE_ID=REPLACE_WITH_YOUR_DEV_D1_DATABASE_ID
# Step 6 (freebusy degrade) needs a mailbox in a DIFFERENT M365 tenant — no
# scheduler login required for it, only used as an attendee address:
export MS2_ATTENDEE_EMAIL=someone@a-different-tenant.onmicrosoft.com

op run --env-file=.env -- uv run bin/ms-smoke.py \
  >/tmp/ms-smoke.log 2>&1; tail -60 /tmp/ms-smoke.log
```

Runs steps 1–6 in order (`--levels` restricts the set but never reorders; step
3, the extended-properties round-trip gate, halts anything else requested in
the same invocation if it fails). `--dry-run` prints the selected steps
without any network calls; `--self-test` runs the pure-function checks with no
network and no live tenant. Exit codes match `meeting-smoke.py`: 0 = at least
one genuine pass and no failures, 1 = a failure, 2 = everything skipped (not a
pass).

## P. Bespoke solver engine (`SOLVER_ENGINE`)

An in-process TypeScript exact-search engine (`worker/src/engine/`) that
solves the same `Problem` the container solves, with the same
`Solution`/`UnsatResponse` shapes, inside the Worker isolate — no HTTP hop,
no container. It shipped **dark** (`SOLVER_ENGINE = "container"`); every
env block ran `SOLVER_ENGINE = "shadow"` (the soak) from 2026-08-24 until
2026-08-27, when — after the search-strengthening merge (an internal PR) and a 9/9
dev regression ladder on the strengthened engine — every env block was
promoted to **`SOLVER_ENGINE = "fallback"` with `SOLVER_ENGINE_FANOUT =
"true"`** (an internal PR; dev keeps its `MIN_CHUNKS = "1"` override, every other
env uses the default 24). The engine now serves the resolves it certifies
(`OPTIMAL`); everything else re-solves via the container, which remains
the authority on user-visible errors, and the `solver_fallback` rate is
the number that gates further promotion. Note the shadow soak was
deliberately cut short (3 days, on the pre-strengthening engine) in
favour of promoting the strengthened engine — the fallback mode's
served-only-when-certified design is the safety argument. Plan:
internal design notes; design:
internal design notes.

### Architecture

Four layers, all pure dependency-free TypeScript over typed arrays (no
Cloudflare imports, no Node imports — the same module runs under the Workers
runtime, under Node for the bench runner, and under vitest):

- **substrate** (`substrate.ts`) — `bakeProblem(problem)`: per-chunk sorted
  `allowed_starts` + 672-bit masks, per-chunk cost vectors (fit + churn ×
  multiplier + soft-window min-over-windows), external occupancy mask,
  per-task metadata (drop weight, group policy, deadline slots, dependency
  edges, `must_include`). A port of `placements.py`/`objective.py`
  semantics, pinned against Python by committed `dump-domains.py` fixtures.
  It also runs the externals overlap sweep, the one unconditional-UNSAT
  path, before any search.
- **pass 1** (`pass1.ts`) — `selectTasks`: selection B&B minimising drop
  cost, keep-first in descending drop weight, capacity cuts over
  envelope-based bands, exact partition. `packFeasible(baked, taskIndices)`
  is the feasibility primitive the MUS layer reuses.
- **pass 2** (`pass2.ts`) — `place`: placement B&B over the frozen
  partition, fail-first variable order, ascending-cost values, admissible
  separable bound plus incremental daily/streak/lateness terms, warm-started
  from `previous_placement`, root shortcut when the greedy incumbent meets
  the bound.
- **MUS** (`mus.ts`) — `resolveInfeasibility`: deletion-based minimal cores
  over the same `ASSUMPTION_*` vocabulary `model.py` uses, isolation checks,
  and the guarded-demotion loop that turns an unplaceable-in-isolation
  `must_include` into a drop with reason
  `must_include_unplaceable_in_isolation` instead of a 422.

`engine.ts` composes them: `solveProblem(problem, budgets = DEFAULT_BUDGETS)`
→ `{kind: "solution" | "unsat"}`. Budgets are three independent wall/node
allowances — `pass1` and `pass2` 20 s / 5,000,000 nodes each, `mus` 20 s /
100,000 deletion tests. Every search path is bounded by one of them; there is
no unbudgeted call left in the engine (the pass-1 **witness** is captured
during selection rather than re-derived with an unbudgeted `packFeasible`,
which is what made two heavy acceptance problems run 366 s and past 600 s
before the fix).

### Proof states and `bound_gap`

| `diagnostics.status` | meaning | `bound_gap` |
|---|---|---|
| `OPTIMAL` | both passes proved (or root-closed) — the certificate case | `0` |
| `FEASIBLE` | a budget was hit; incumbent returned | pass 2's gap **when pass 1 itself certified**, otherwise the field is **omitted** |
| `PASS1_FALLBACK` | pass 2 completed no descent at all; the pass-1 witness is served | omitted (`pass2_wall_seconds` reports `0`, matching the container) |

Read an **omitted** `bound_gap` as *unknown*, never as zero: when pass 1 is
uncertified the true gap cannot be stated, and emitting pass 2's (possibly 0)
gap would read as "certified after all". `0` means certified; a positive
value is pass 2's residual gap over a certified partition.

The status vocabulary is deliberately the container's, so nothing downstream
can tell the two apart: 422 + `unsat_core` for a genuine conflict, and the
same drop reasons and `contributing_constraints`.

### Search strengthening (D1–D4 + fan-out, 2026-08-25)

Second round of solver development
(internal design notes, plan + card-by-card outcome
records in internal design notes). Same contract, same
status vocabulary, same budgets surface; what changed is the search:

- **D1 — Lagrangian contention bound** (`lagrangian.ts` + `pass2.ts`): the
  time-indexed relaxation's slot-capacity rows priced by a budgeted
  subgradient at the root (scaled-integer λ, deterministic schedule sized to
  the instance), fused into `scan()` as a λ-augmented cost table. Prices the
  no-overlap contention the separable bound cannot see: a saturated week
  that never closed in 18.7 M nodes certifies at the root in 0 nodes. Runs
  only when the greedy incumbent misses the root bound — the prod root
  shortcut never pays for it. Known honest limit: the relaxation has a
  measured **integrality gap** on `combo_chunked_workflow-medium` (dual 427
  vs optimum 550) and `combo_kitchen_sink-medium` (11 155 vs 11 750), which
  is exactly why those two stay allowlisted.
- **D2 — interval Hall cuts** (`hall.ts`, wired in `pass1.ts`): sound
  (independently fuzz-verified) and near-free, but **zero measured effect
  on the whole corpus** — lever-isolation runs showed every heavy-tier win
  attributed to it actually comes from the pass-1 **branching order**
  change that rode the same card: keep-first by drop weight *per occupied
  slot* (the fractional-knapsack ratio `buildBands` already used) instead
  of drop weight alone. That ordering is what took
  `availability_windows-heavy` and `preferred_window_hard-heavy` out of
  `PASS1_FALLBACK` (drops 26 → 18 and 51 → 40, vs CP-SAT's 16/36) and
  certified `business_hours-heavy` at the reference objective in 0.86 s.
  The cut stays for fragmented-envelope structures the corpus's heavies
  don't have.
- **D3 + D4 — improvement phase and controller** (`improve.ts`,
  `engine.ts`): the pass-2 pipeline is **improve-first, prove-once** —
  root evaluation (pass-1 witness descent + Lagrangian, zero search nodes)
  → deterministic round-batched LNS from the witness (five ranked
  neighbourhood families incl. relocation-priced *displacement*; strict
  improvements; node-budgeted, no RNG, no clock) → ONE seeded proof search
  with every node the LNS did not spend. `splitPass2Budget` divides the
  budget gap-proportionally (closed gap ⇒ all proof — the certificate path
  is untouched). Witness seeding also means a pass 2 that cannot finish a
  descent still serves real placements as `FEASIBLE` (the old
  `PASS1_FALLBACK` cliff); the fallback status remains for a dead-clock or
  broken-witness run. Wall stays a safety valve; the phase's stopping
  rules are node/iteration-based (deterministic across machines) — the
  hard ceiling is the fixed iteration cap, not the wall.
- **Diagnostics** (log line + `solver_diagnostics` only, NOT the HTTP
  schema): `root_bound`, `root_incumbent`, `bound_lift` (Lagrangian minus
  separable at root), `improve_iterations`, `improve_accepted`,
  `fanout_subsolves`. Present per the card A rules (root fields whenever a
  root scan completed; counters hard-zero wherever the phase did not run —
  every certified solve included; all absent on unsat).

### Fan-out escape hatch (`SOLVER_ENGINE_FANOUT`)

Ships **dark**: `SOLVER_ENGINE_FANOUT = "false"` explicit in every env
block. When `"true"` AND the `ENGINE_RPC` service binding is bound AND the
instance has ≥ `SOLVER_ENGINE_FANOUT_MIN_CHUNKS` chunks (default 24 in
code; parse-with-floor, so dev smoke sets `"1"` to trigger on small
problems), a `worker`/`fallback`-mode resolve runs the improvement phase's
sub-solves as batched RPC to `EngineRpc` (this same worker's exported
entrypoint, bound per-env so dev can never fan into prod). Shadow mode
deliberately stays sequential — its comparison line measures the
sequential engine wall.

- **The flag may change wall clock, never the answer**: both drivers run
  the identical round schedule (`improveRounds`), and results are combined
  in fixed request order — bit-identity is tested through the real RPC
  boundary. Sub-solves are node-capped with `wallMs: Infinity` (the
  determinism invariant documented at `SubsolveRequest.wallMs`).
  **Caveat (bench-fanout card B): the claim is exact under node budgets
  only.** When pass 2's *wall* binds, the proof search that follows the
  phase takes wall-remaining budget, so a fan-out phase that spent
  different wall hands the proof search a different tree — two
  *sequential* runs of a wall-bound problem already differ in nodes
  (measured), and objective equality there is likely but not guaranteed.
  Prod budgets are wall-bound, so treat fan-out answers as
  equal-in-practice, bit-equal-in-principle-only-at-node-budgets; a
  node-denominated proof budget is the recorded engine follow-up
  (internal design notes).
- **Degrade, never fail**: any RPC failure recomputes the WHOLE call
  sequentially (a mixture would depend on which leaf failed), latches for
  the rest of the resolve, and logs one
  `engine_fanout_degraded {reason, subsolves, batches, error?}` line
  (`reason`: `rpc_error` | `subsolve_cap`; `batches ≥ 1` distinguishes
  "engaged and fell over" from "never engaged", which logs no
  degraded/summary line — the flag-gated `engine_fanout_gate` line below
  still records the gate decision either way).
- One `engine_fanout {subsolves, batches, wall_ms}` info line per resolve
  that actually fanned out (`wall_ms` measures fan-out only, not any
  sequential recompute). Grep with the trailing space — `"engine_fanout "`
  — or the degraded and gate lines match too.
- One `engine_fanout_gate {call_id?, eligible, chunk_count, min_chunks,
  binding_bound}` info line per resolve whenever `SOLVER_ENGINE_FANOUT`
  is `"true"` — the gate DECISION, logged whether or not fan-out then
  engages, so soak threshold-tuning can tell eligible-but-idle (line says
  `eligible:true`, no `engine_fanout ` summary follows) from ineligible
  (the line names which leg closed the gate). `call_id` joins the line to
  its `solver_calls` row. **Worker and fallback modes ONLY**: shadow
  calls the engine directly and container never reaches the gate, so
  neither emits it — flipping the fan-out flag during a shadow soak
  yields zero gate lines BY DESIGN, not a rejecting gate (per-resolve
  chunk counts live in `solver_calls.n_chunks` in every mode). Flag
  off/unset: byte-silent.
- Caps: ≤ 24 sub-solves per resolve (the platform limit is 32 invocations
  of the same Worker per request — miniflare does not enforce it, so the
  dev smoke is what validates the true ceiling), batches of 8.
- **Verified on dev 2026-08-26** (`bin/engine-smoke.py --phase fanout`,
  card H — ALL PASS, FN1–FN4): the self-referential `[[services]]` binding
  is accepted at deploy time, the gate opened (36 chunks ≥ min 1), and a
  crowded seeded week ran 8 sub-solves in 5 batches with no
  `engine_fanout_degraded`. Isolate separation is REAL, not co-located:
  each leaf lands in Workers Observability as its own billed `jsrpc`
  invocation with its own CPU accounting.
- **Fan-out is wall-neutral at current leaf granularity** (same dev
  session, platform-measured via Observability `wallTimeMs`/`cpuTimeMs` —
  the per-invocation numbers the platform records, NOT the in-worker log
  lines): on a seeded heavy week (24 tasks / 36 chunks, ~39 h demand,
  5.0 M root nodes) the root resolve measured 46–51 s wall / 38–41 s CPU
  with fan-out ON across five runs and 46.2 s wall / 37.9 s CPU with it
  OFF — indistinguishable. The 8 leaf sub-solves totalled < 0.2 s CPU
  against ~39 s of root CPU, so there is nothing to parallelise until
  leaves carry a much larger share of the search: the same
  overhead-bound conclusion the bench thread-pool measured, now confirmed
  on real workerd RPC.
- **In-worker wall lines under-report — accepted, no follow-up planned.**
  workerd freezes `Date.now()`/`performance.now()` during synchronous
  execution (Spectre mitigation) and advances the clock only at real I/O,
  so `engine_fanout wall_ms`, worker-mode `round_trip_ms`, and the shadow
  soak's `engine_wall_ms` can read anywhere from ~0 (warm, no I/O) to a
  small fraction of true wall (fan-out runs advance at each RPC await) —
  the same ~39 s solve read 0 ms, 1 876 ms, and 4 755 ms on consecutive
  runs. `container_wall_ms` and container-mode `round_trip_ms` stay
  honest (the awaited HTTP hop advances the clock). Read true engine
  wall/CPU from Workers Observability per-invocation fields. Consequence,
  also accepted: the fallback `SOLVER_ENGINE_WALL_GUARD_MS` serving guard
  reads this same frozen clock, so a slow synchronous solve largely
  escapes it.
- **Container reference on the same seeded heavy week**: solve
  11.3–12.3 s (pass1 + pass2, container-side clock), round trip
  12.6–15.5 s — 3–4× faster than the engine's 46–51 s, and one fewer
  drop (11 vs 12; both `FEASIBLE`). Consistent with the known-limitations
  bullet: heavy contention is CP-SAT's class; the engine's case is the
  typical light resolve it certifies in milliseconds with no hop.
- **Bench now exercises the fan-out code at corpus scale**
  (internal design notes): `bench/runners/bespoke-fanout.mjs`
  drives `solveProblemFanout` through a real `makeFanoutSession` whose
  binding is a Node worker_threads pool (structured clone — the same
  serialization boundary class as workerd RPC), at production session
  settings. The corpus gained a `fanout_*` family (77 problems total):
  `fanout_wide` pins maximum round width (all five neighbourhood families
  emitting), `fanout_converge` an engineered under-cap completion (no
  degrade), `fanout_cap` the deterministic `subsolve_cap` degrade.
  `optical_bench.identity` gates a fan-out run byte-equal to the
  sequential run (nodes included) under node budgets, with
  `--expect-engaged` failing loudly on a silent sequential no-op —
  acceptance internal bench results: identity PASS
  76/76 compared (one problem budget-unverifiable on both sides, skipped
  loudly), parity vs CP-SAT PASS at corpus scope. What bench measured of
  wall: Node thread-pool fan-out is overhead-bound at ≤1000-node leaf
  granularity (fan wall ≈ sequential wall) — and the 2026-08-26 dev smoke
  answered the workerd half the same way (see the verified-on-dev bullets
  above: binding accepted, isolate separation real, wall neutral).

### Modes (`SOLVER_ENGINE`)

Set per env in `worker/wrangler.toml` `[vars]`. Unset or unrecognised ⇒
`"container"` (fail-safe), with one `solver_engine_unknown` warn per distinct
bad value per isolate — a typo can never silently promote the engine.

| mode | who serves | container called? | notes |
|---|---|---|---|
| `container` | container | always | today's behaviour, byte-identical |
| `shadow` | container | always | engine also runs; one `solver_shadow` line; never changes the response, **does** add its wall to latency |
| `fallback` | engine when it certifies, else container | only on the tail | the intended first live mode |
| `worker` | engine | never | no second opinion; an engine crash is a `solver_error` (500) |

**Fallback decision table** — first match wins
(`solveWithFallback`, `resolve-internal.ts`):

| engine outcome | served | `solver_fallback.reason` |
|---|---|---|
| threw | container | `engine_error` (line also carries `engine_error`) |
| wall > guard | container | `engine_timeout` |
| UNSAT | container | `engine_unsat_confirm` |
| `FEASIBLE` / `PASS1_FALLBACK` | container | `engine_uncertified` |
| `OPTIMAL` | **engine** | — (no line, no fetch) |

**The container is the authority on user-visible errors.** A 422 is rare and
cheap to confirm, so fallback mode never serves the engine's 422 — it
re-solves and serves the container's answer either way. If the two contradict
each other (engine 422 + container plan, or engine plan + container 422) that
falsifies the parity claim the whole promotion path rests on, so it logs
`solver_engine_disagreement` at **error** level, in both directions, and the
container's answer is served.

**Shadow costs latency, synchronously.** `runResolve` has no
`ExecutionContext`, so there is no `waitUntil` to defer onto, and the engine
is synchronous: every shadowed resolve pays the full engine wall *on top of*
the container round trip before responding. That is the accepted price of the
soak (shadow is never a steady state) — but it is why shadow is a soak mode,
not something to leave on.

### Engine budgets, wall guard and CPU limits

The engine's three wall budgets are env-tunable in SECONDS, mirroring the
container's knobs so a soak compares like for like via a var flip:
`SOLVER_ENGINE_PASS1_TIME_LIMIT_S`, `SOLVER_ENGINE_PASS2_TIME_LIMIT_S`,
`SOLVER_ENGINE_MUS_TIME_LIMIT_S` (unset ⇒ 20 s each, the engine's
`DEFAULT_BUDGETS`; fractions allowed; ≤ 0 clamps up to 1 ms; node caps are
backstops, not knobs). The bench runner honours the container-named
`SOLVER_PASS*_TIME_LIMIT_S` variants for the same purpose off-worker.

`SOLVER_ENGINE_WALL_GUARD_MS` (fallback mode only; default = twice the sum
of the **env-tuned** wall budgets — 120,000 ms at the defaults — so
retuning the budgets moves the guard with them). The engine is synchronous, so this **cannot preempt** a running
solve — the CPU is already spent by the time we look. It is a *serving*
guard: an answer that took grossly longer than the engine's own budgets has
broken budget accounting, so its `OPTIMAL` is suspect and the container
re-solves. Unset or unparseable falls back to the default; a parseable value
below 1 clamps **up** to a 1 ms floor rather than disabling the guard (same
posture as `BOOKING_DECLINE_GRACE_MINUTES`).

`[limits] cpu_ms = 300000` is set in **every** env block (limits do not
inherit). The Workers default of 30 s would kill the isolate before the
120 s guard could ever refuse a slow answer — and in shadow mode a CPU kill
would take down the *container-served* response the caller was already owed,
breaking "shadow never affects the response". Billing is per CPU-ms actually
consumed, so the raised ceiling costs nothing unless it is used.

### Log lines

All JSON embedded in the message text (the log pipeline drops structured
`console.*` arguments — `worker/src/log.ts`). Filter these names in Workers
Observability or `wrangler tail` on `weekly-scheduling-assistant`.

- **`solver_shadow`** (info, shadow mode, one per resolve):
  `{engine_status, engine_objective_total, container_status,
  container_objective_total, container_wall_ms, engine_wall_ms, status_agree,
  sat_agree, objective_agree}`. `status_agree` is **exact** status equality
  (`OPTIMAL` vs `FEASIBLE` is a real difference the soak wants to see);
  `sat_agree` asks only the load-bearing question — plan or 422?
  `objective_agree` is `null` when either side has no objective total (a 422).
  **Crash variant:** an engine exception replaces the engine half of the line
  with `engine_error` — `{container_status, container_objective_total,
  container_wall_ms, engine_wall_ms, engine_error}`, and **none** of
  `engine_status` / `status_agree` / `sat_agree` / `objective_agree` is
  present. "Zero swallowed exceptions" (a soak exit criterion) therefore
  means exactly: **zero `solver_shadow` lines carrying an `engine_error`
  field.**
- **`solver_fallback`** (warn, fallback mode, one per fallen-back solve):
  `{reason, engine_status, container_status, engine_wall_ms,
  container_wall_ms}` plus `engine_error` when the reason was a crash.
  `engine_status` is the engine's own status, or `"UNSAT"`, or `"ERROR"`.
  `container_status` is the container's status, or `"UNSAT"`, or
  `"transport_error"` / `"http_<code>"` when the container itself failed.
- **`solver_engine_disagreement`** (error, fallback mode): `{owner,
  window_start, call_id, engine_status, container_status}` plus whichever
  core exists — `engine_unsat_core` (engine said 422, container planned) or
  `container_unsat_core` (engine planned, container said 422). Both
  directions log; the container's answer is served in both.
- **`solver_engine_unknown`** (warn): `{value, using: "container"}`, once per
  distinct bad value per isolate.
- **`solver_engine_error`** (error, **worker mode only**): `{error, wall_ms}`.
  The resolve then returns `solver_error` 500 — worker mode has no fallback,
  exactly as an unreachable container has none.
- **`solver_diagnostics`** gains **`engine: "container" | "worker"`** — who
  produced the **served** answer. On an engine-served row the fields that
  describe an HTTP call are `null` by construction: `attempts: null`,
  `solver_uptime_ms: null`, and `round_trip_ms` is the engine's own wall.
  `bound_gap` and `nodes` appear when the engine defines them (see the proof
  table above); the container never emits either.

One gap worth knowing when grepping: a **worker-mode UNSAT** writes its
`solver_calls` row (status `UNSAT`, pass fields NULL) but logs **no**
`solver_diagnostics` line — there are no pass diagnostics for a 422, the same
shape the container's 422 path has.

### `solver_calls.engine` (migration 0039)

`ALTER TABLE solver_calls ADD COLUMN engine TEXT` — `'container'` or
`'worker'`, naming **who was served, not who was tried**: a fallback that
fell back records `'container'`. NULL on rows written before the migration
and on backfilled `source='logs'` rows; **read NULL as `'container'`**.

`engine='worker'` is exactly the set of solves that cost the container
nothing — see the cost note in §G.

### Deploy order

**Apply migration 0039 BEFORE deploying the worker**, in every env, even
though the flag ships as `"container"`:

```bash
cd worker
op run --env-file=../.env -- npx wrangler d1 migrations apply DB --env dev --remote
op run --env-file=../.env -- npx wrangler deploy --env dev
```

Failure mode if you don't: the insert in `recordSolverCall` names the
`engine` column, so on an unmigrated D1 **every** resolve logs
`solver_calls insert failed: …` at error level. It is observability-only —
the insert is best-effort and the resolve still succeeds and still serves a
plan — but the demand dataset silently stops accumulating until the migration
lands.

### Shadow soak and promotion

Promotion path is **`shadow` → `fallback` → `worker`**, and the rollback at
every stage is a flag flip back to `"container"` plus a redeploy. Nothing
else has to be undone: no data shape changes, no migration to reverse.

1. **Dev first.** Set `SOLVER_ENGINE = "shadow"` under `[env.dev] vars` in
   `worker/wrangler.toml`, apply 0039, redeploy dev. Run
   `bin/engine-smoke.py --phase shadow` (below) and watch a resolve produce
   a `solver_shadow` line with `sat_agree: true` and no `engine_error`.
2. **Then prod**, same flag under the top-level `[vars]`. Leave it for
   **≥ 2 weeks** of real traffic.
3. **Grep the soak.** `solver_shadow` for the comparison rows,
   `solver_engine_unknown` for config drift, and `solver_calls` (which now
   outlives the 7-day log retention) for the status distribution. Exit
   criteria for promoting to `fallback`:
   - 100 % `sat_agree` on prod traffic (a single false is a hard stop);
   - objective equality wherever both sides say `OPTIMAL`;
   - engine wall ≤ container CP-SAT time + margin;
   - **zero swallowed exceptions** — zero `solver_shadow` lines with an
     `engine_error` field.
4. **`fallback`** is the first live mode: the engine serves only certified
   answers and the container catches the tail. Watch `solver_fallback` rates
   by `reason`, and treat any `solver_engine_disagreement` as a stop-and-
   investigate.
5. **`worker`** — and the container-retirement economics — goes back to
   internal design notes once the prod
   `solver_fallback` rate is ~zero over a further soak window. The prod R2
   capture corpus acceptance gate (§G, "Problem capture") applies before any
   live-mode promotion beyond shadow; the synthetic bench corpus below is
   the build-time acceptance set, not that gate.

### Bench acceptance (2026-08-25 — search strengthening)

Reference unchanged (internal bench results). Candidate:
internal bench results — **70/70, zero errors,
`compare` PASS** with the four-problem allowlist below, zero unused
allowances. Side-by-side: internal bench results.

- **The allowlist shrank 6 → 4.** `business_hours-heavy` (0.84 s) and
  `deadline_soft-heavy` (2.8 s, objective 0) now **certify**;
  `context_caps-medium` and `context_caps-heavy` certify where the
  reference itself is only FEASIBLE (certificate gains over CP-SAT).
- Remaining allowlist: `combo_chunked_workflow-medium` and
  `combo_kitchen_sink-medium` (the D1 dual's integrality gap — for
  kitchen_sink the incumbent IS the reference optimum, so the dual is
  provably the sole blocker), plus `availability_windows-heavy` and
  `preferred_window_hard-heavy` (class B by design: FEASIBLE with real
  placements, drops gated ≤ ⌈1.10 × ref⌉ and landing exactly on 18/40 —
  heavy certificates stay a formal non-goal).
- **Class C**: signed mean incumbent gap **−8.6 %** over the 12
  FEASIBLE-both problems (gate ≤ 0); medium slice +4.7 % reported
  (per-problem medium ceiling +6.5 %, re-pinned from +5 % on measured
  LNS-convergence evidence — see the plan's card F/G records).
  `churn-heavy` +73.2 % → **+1.4 %**; `combo_deadline_window-heavy`
  +8.5 % at CP-SAT drop parity (the witness-seeding cliff unlock);
  engine wins up to −85.5 % retained.
- **Memory: 24.4 MB net worst case** against the 30 MB gate (up from 17.4
  — the phase's sub-solves cost footprint; still nowhere near the limit).
- No light-tier wall regressions; the compare command now also enforces
  the class-B drop gate and class-C ceilings/aggregate in code
  (`compare.py`, TDD'd in `bench/tests/test_compare.py`; the class-B gate
  also runs standalone: `uv run --extra dev pytest -m class_b`).

```bash
cd bench && uv run python -m optical_bench.compare \
  results/20260824-125520-reference results/<candidate> \
  --allow-regression combo_chunked_workflow-medium \
  --allow-regression combo_kitchen_sink-medium \
  --allow-regression availability_windows-heavy \
  --allow-regression preferred_window_hard-heavy \
  --markdown results/<date>-acceptance.md
```

**Soak note:** the ~15 % uncertified-at-equal-objective rate in the shadow
soak is the live signature of the (now largely closed) class-A bound gap —
it is expected to DROP once this branch deploys to a shadow env; record the
observed change here when it does.

### Bench acceptance (2026-08-24 — superseded by the 2026-08-25 run above; kept for history)

Reference: the committed CP-SAT run internal bench results
over the 70-problem corpus (26 light / 22 medium / 22 heavy), engine at the
same 20 s per-pass budgets — like for like. See `bench/README.md` for the
runner and comparison contract.

Candidate: internal bench results — **70/70 problems
completed, zero errors, `compare` PASS (exit 0)** with the six-problem
allowlist below and **zero unused allowances**. The full per-problem
side-by-side (status, objective, drops, memory and wall clock for both
solvers, one row per corpus problem, plus every finding) is committed as
internal bench results, generated by the command below with
`--markdown` — regenerate it the same way after any new candidate run.

- **Memory: 17.4 MB net worst case against a 30 MB gate** (max per tier:
  light 3.0 / medium 10.4 / heavy 17.4), versus CP-SAT running to hundreds of
  MB — GB on the soft-cost problems. Memory was never the reason to leave the
  isolate.
- **Wall: 369 s for the whole corpus**, worst problem 36.85 s (a heavy
  `FEASIBLE` spending its full budgets).
- **Certified parity on all 26 light problems and 20 of 22 mediums** —
  statuses, drop sets, oracle-validated placements, and **exact objective
  equality on every problem where both runs say `OPTIMAL`**.
- **Six problems are allowlisted** as recorded v1 limitations
  (`--allow-regression`, which excuses that problem's *status* gate only —
  memory, invariants, drop equality and SAT/UNSAT disagreement still gate on
  the same problem, and an allowance that stops firing reports as
  `unused_allowance`):

  | problem(s) | diagnosis |
  |---|---|
  | `combo_chunked_workflow-medium`, `combo_kitchen_sink-medium` | the no-overlap contention gap: crowding excess is invisible to the separable bound, so the bound never lifts off zero on a crowded plateau and pass 2 exhausts its 20 s. Follow-up: an assignment relaxation over chunks × slots (plan doc). |
  | `business_hours-heavy`, `deadline_soft-heavy` | structural certificate losses: a `PACK_NODE_CAP`-abandoned proof that needs ≥ 35 s of tree, and a pass-2 20 s exhaustion. Raising the cap trades this against the runaway class; measured, and the cap kept. |
  | `availability_windows-heavy`, `preferred_window_hard-heavy` | `PASS1_FALLBACK` at ~10 s, serving the drop-only objective: availability crowding is only refutable by DFS, which is what spends the pass-1 budget. Both heavy-tier, where certificates are an explicit non-goal (CP-SAT also returns `FEASIBLE` there at 20 s). |

  ```bash
  cd bench && uv run python -m optical_bench.compare \
    results/20260824-125520-reference results/<candidate> \
    --allow-regression combo_chunked_workflow-medium \
    --allow-regression combo_kitchen_sink-medium \
    --allow-regression business_hours-heavy \
    --allow-regression deadline_soft-heavy \
    --allow-regression availability_windows-heavy \
    --allow-regression preferred_window_hard-heavy \
    --markdown results/20260824-acceptance.md
  ```

Three combo mediums that lost their certificate in the first acceptance run
(`combo_deadline_window`, `combo_meeting`, `combo_replan`) certify here, with
exact objective equality — the pass-2 speedups carried them under budget.
They are **not** on the allowlist; an allowance kept for them would report as
`unused_allowance`. Treat them as the regression canaries for that speedup:
they certify with no allowance today, so if one of them ever flags
`status_regression` again, the pass-2 work regressed rather than the corpus
getting harder.

Heavy-tier incumbents cut both ways, and both directions are reported rather
than gated (the tier returns `FEASIBLE` on both sides): the engine beats
CP-SAT at equal budgets on `combo_kitchen_sink-heavy` (−85.5 %) and
`combo_replan-heavy` (−23.1 %), and loses to it on `churn-heavy` (+73.2 %).

None of the six is in the prod instance class (1–2 tasks against ~20
externals, 5–50 ms, 100 % `OPTIMAL`). They are the honest edge of the
certificate claim, not a prod risk — and in `fallback` mode every one of them
would simply be served by the container.

### Cost model (see also §G)

`engine='worker'` rows in `solver_calls` are solves that **cost the container
nothing** — no request, no uptime, no vCPU. The column exists so the cost
tooling *can* separate them once the engine serves live traffic; nothing
reads it yet. Two known tooling gaps to close before the fallback/worker cost
claim can be reconciled to an invoice:

- `bin/solver-usage-backfill.py` reads Workers Logs for `solver_fetch` lines,
  which an engine-served solve never emits — so engine-served solves are
  **silently omitted** from `analysis/solver-calls.csv`. Arguably correct
  (that CSV models *container* demand), but it means the CSV stops being a
  count of all solves the moment the engine serves anything.
- `bin/solver-capture-pull.py`'s `D1_COLUMNS` does not include `engine`, so
  the capture manifest cannot split an engine-served problem from a
  container-served one.

### Live smoke (`bin/engine-smoke.py`)

Runs in the operator's shell against **dev only** (it refuses a non-dev URL), one
phase per invocation, because each phase asserts the consequences of one
deployed `SOLVER_ENGINE` value — and changing that means a `wrangler.toml`
edit and a redeploy. The script does not orchestrate deploys. Since
2026-09-02 it **detects the deployed posture itself**: with no `--phase` it
reads the script's plain-text vars off the Workers settings API
(`GET /accounts/{id}/workers/scripts/weekly-scheduling-assistant-<env>/settings`
— `SOLVER_ENGINE`, `SOLVER_ENGINE_FANOUT`, `…_MIN_CHUNKS` all come back as
`plain_text` bindings), prints a `P0` line naming what it found, and runs the
matching phase (`container`/`shadow`/`fallback`/`worker`). This is what the
smoke runner's `auto` mode does. `--phase <p>` still pins a phase (no API
call) and fails loudly if the deployment disagrees; `fanout` is never
inferred — it needs a crowded week — so it stays an explicit `--phase`.

```bash
# Whatever dev is deployed with — container/shadow/fallback/worker:
op run --env-file=.env -- uv run bin/engine-smoke.py \
  > /tmp/engine-smoke.out 2>&1
# Pin a phase explicitly (must match the deployed flag):
op run --env-file=.env -- uv run bin/engine-smoke.py --phase shadow \
  > /tmp/engine-smoke-shadow.out 2>&1
# Fan-out (dev only) — SOLVER_ENGINE = "worker" (or a certifying "fallback")
# AND SOLVER_ENGINE_FANOUT = "true" + SOLVER_ENGINE_FANOUT_MIN_CHUNKS = "1"
# deployed, a crowded target week seeded, then:
op run --env-file=.env -- uv run bin/engine-smoke.py --phase fanout \
  > /tmp/engine-smoke-fanout.out 2>&1
```

Requires `SCHEDULER_URL`, `A_BEARER`, `A_REFRESH`, `A_EXPECTED_EMAIL`, and
`D1_DATABASE_ID` (the `solver_calls` assertions are direct D1 reads — there
is no API for them); posture detection additionally needs
`CLOUDFLARE_API_TOKEN` (the same token `wrangler tail`/`d1` use; Workers
Scripts read) and the account id (`CLOUDFLARE_ACCOUNT_ID`, default: the
optical account). Each phase triggers one `POST /v1/resolve` over a blank
future week and then asserts, mechanically:

- **container** — `solver_calls.engine = 'container'` with an HTTP call
  behind it, and **no** engine log line at all.

- **shadow** — a `solver_shadow` line exists for that resolve with
  `sat_agree: true` and **no** `engine_error` field; `solver_calls.engine` is
  `'container'` (shadow never changes who serves).
- **fallback** — the happy path: `solver_calls.engine = 'worker'` with
  `status = 'OPTIMAL'`, and **no** `solver_fallback` line for that resolve.
- **worker** — the plan lands (200) and `solver_calls.engine = 'worker'`.
- **fanout** — engine-served row, no `engine_fanout_degraded` /
  `solver_engine_error`, the `engine_fanout {subsolves, batches, wall_ms}`
  summary (FN3) and an `eligible:true` `engine_fanout_gate` line (FN4).
  FN3 FAILS BY DESIGN on a blank week — a trivially-certified root never
  runs the improvement phase, so nothing fans out. Seed the target week
  (the first Monday 21+ days out, or whatever `--monday` names) crowded
  enough to leave the root gap open first; the 2026-08-26 pass seeded 24
  API tasks / 36 chunks (~39 h demand incl. twelve 2×60-min chunked deep
  tasks) into it, and deleted them by title tag afterwards.

Log assertions need the log stream: by default the script spawns its own
`npx wrangler tail --env dev --format json` around the resolve; `--tail-log
<path>` reads a tail capture you started yourself instead, and `--no-tail`
skips the log assertions and says so (a skip is printed as SKIP, never
folded into a pass). Attach detection is active, not banner-based: with
`--format json` wrangler prints *nothing* until an event arrives (both
banners are pretty-mode-only in wrangler 4.92), so the script probes the
worker's health route (GET /) until the first event record lands in the
capture — proving the tail is attached and delivering before the resolve
fires. A 45 s attach timeout therefore means events genuinely aren't
flowing (token, env, or tail-session limits), not a silent-but-healthy
tail. D1 assertions are unconditional and exact — the row is
pinned by the resolve's own `window_start` string plus a lower bound on `at`.
The log assertions are weaker by nature: `solver_shadow` and
`solver_fallback` carry no call id (only `solver_engine_disagreement` does),
so a line is attributed to the run because it was captured inside the run's
tail window, and dev's cron/webhook replans can contribute lines too. Every
matched line is printed. `bin/test_engine_smoke_parse.py` covers the parsing
and the phase predicates offline (`uv run bin/test_engine_smoke_parse.py`).

### Known v1 limitations

- **Certificates only for the instance class search closes within budget.**
  Synthetic heavy classes return `FEASIBLE` + `bound_gap` by design, as
  CP-SAT does at its own limits. The six allowlisted bench problems above
  are the measured edge.
- **Minimal cores may differ from CP-SAT's sufficient cores** on problems
  with several minimal conflicts — parity is "covers the same conflict", not
  set equality. `unsat_core` item shapes are unchanged.
- **Plateau landscapes are the known B&B risk.** The two allowlisted combo
  mediums are exactly that: no-overlap contention excess invisible to the
  separable bound. Bounded by budget, never by hanging.
- **`PACK_NODE_CAP` certificate losses** on `business_hours-heavy` and
  `deadline_soft-heavy`: an abandoned proof that would need ≥ 35 s of tree,
  and a pass-2 exhaustion. The cap was kept deliberately — raising it
  re-opens the long-running class.
- **`packFeasible` is unbudgeted inside a single MUS deletion test.** The MUS
  layer's budget bounds the *number* of deletion tests, not the wall of any
  one of them; a pathological single test can overrun the mus wall. Follow-up
  in the plan doc: a budgeted three-valued `packFeasible`.
- **Shadow doubles solve compute per resolve** and adds the engine wall to
  response latency, synchronously, for the soak duration. Fallback doubles it
  only on non-`OPTIMAL` engine outcomes — including every 422, which is
  confirm-by-container by design.
- **The webhook replan path compounds engine CPU per invocation.**
  `webhooks/google-calendar.ts` buckets changed events into distinct local
  weeks and calls `runResolve` once per week, so a change touching N weeks
  runs the engine N times inside one invocation. That is what `cpu_ms =
  300000` leaves headroom for; a pathological fan-out is still bounded by the
  isolate's CPU limit, not by the engine's own budgets.
- **Fallback keeps the container deployed and warm-path-relevant** — it
  defers, not delivers, the container retirement. Only `worker` mode removes
  the dependency.
- **No warm-start persistence across resolves** beyond `previous_placement`
  (CP-SAT has none either — parity, noted for symmetry).
- **Nothing in `worker/src` consumes `UnsatItem` fields** — the core is an
  opaque passthrough. Latent traps for a future consumer, unchanged by this
  work: `external_pinned` puts an *event* id in `task_id`, `value` is
  local-naive rather than ISO-Z, and `replan-now.ts` double-nests
  `unsat_core` (pre-existing, untested, out of scope here).
