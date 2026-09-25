# Optical

A weekly scheduling assistant that plans your tasks into your real calendar.
You keep a backlog of tasks with durations, priorities, deadlines and
preferences; Optical reads your Google or Microsoft 365 calendar, solves for
the best week around what's already there, proposes the plan, and writes the
accepted plan back as calendar events — replanning when the calendar changes.

Runs on Cloudflare Workers, with an exact-search solver engine in-process and
a CP-SAT solver as a container fallback.

Website: [optical-scheduler.com](https://optical-scheduler.com)

## What it does

- **Constraint-based weekly planning** — deadlines (hard and soft), preferred
  days/times and hard windows, chunking of long tasks, pinned tasks, groups
  (same-day / ordered), per-context capacity caps, and a churn penalty so
  replans move as little as possible. Unplaceable tasks are dropped with a
  reason rather than failing the week, and a genuinely infeasible week returns
  an unsat core naming the conflicting constraints.
- **Propose → accept** — every resolve produces a proposed plan; nothing
  touches your calendar until you accept it (API, email link, or an MCP
  client).
- **Live replanning** — calendar push notifications trigger a replan when an
  event lands on top of planned work.
- **Google and Microsoft 365** calendars, chosen per user at sign-in.
- **Owned movable meetings** — meetings you organise can be relocated to a
  slot where every accepted attendee is free.
- **Public booking page** — share a link; bookers pick a slot from your real
  availability (Turnstile-protected), with decline auto-cancel.
- **Meeting polls** — invitees paint availability on a public grid; the poll
  books the best slot automatically.
- **Busy `.ics` feed** — a private free/busy feed with per-title reveal rules.
- **Per-user cost model** — customise the fit curves and weights the solver
  optimises.
- **Recurring tasks**, done-marking by event colour/category, multi-user with
  OAuth 2.1 (PKCE) bearer tokens for API/MCP clients.

Most features sit behind flags in `worker/wrangler.toml`; `CLAUDE.md` lists
them with how to enable each.

## Layout

```
worker/    Cloudflare Worker (TypeScript): API, OAuth, calendar providers,
           planning pipeline, solver engine (src/engine/), D1 migrations
solver/    CP-SAT solver service (Python, OR-Tools) run as a Cloudflare
           Container behind a service binding
schema/    OpenAPI spec for the public API
bin/       smoke harnesses and ops tooling (Python, run with `uv run`)
infra/     OpenTofu for D1, KV, DNS and Cloudflare Access
bench/problems/  synthetic solver corpus used by the engine tests
docs/runbook.md  setup, operations and per-feature reference
```

## Getting started

You need a Cloudflare account (Workers Paid, for Containers and Durable
Objects), a Google Cloud OAuth client (and optionally a Microsoft Entra app
registration), Node 22 and [uv](https://docs.astral.sh/uv/).

1. **Google Cloud** OAuth client and consent screen — runbook §A.
2. **Cloudflare resources** — `infra/` (OpenTofu) creates D1, KV, DNS and
   Access; see `infra/README.md`.
3. **Configure** `worker/wrangler.toml`. Every `REPLACE_WITH_YOUR_…` value and
   `example.com` hostname is a placeholder for your own (D1/KV ids, Access
   AUD, OAuth client id, Turnstile site key, custom domain, operator email).
   The file defines prod (top level) and `[env.dev]`.
4. **Secrets and first deploy** — runbook §B (`bin/bootstrap-secrets.sh`,
   D1 migrations, `wrangler deploy`), then smoke test with runbook §C.

To smoke the Microsoft 365 provider, set `MS_PROVIDER_ENABLED = "true"` and
the `MICROSOFT_*` vars under `[env.dev]` and run the `bin/` harnesses with
`--provider microsoft` against dev (runbook §O).

## Using it from an AI assistant (MCP)

Optical is an HTTP API; to drive it from Claude or any other MCP client, put
[codemode-mcp](https://github.com/victor-bajanov/codemode-mcp-public) in
front of it. Its `optical` provider (`packages/providers/optical`, deployed
as the `apps/optical` Worker) exposes the Optical API (tasks, resolve and
accept, meeting polls, booking pages, cost curves) as a code-mode MCP server,
signing in to your deployment through an OAuth 2.1 PKCE client registered in
Optical's `oauth_clients` table. Setup steps are in that repo's
`apps/optical/README.md`. The provider's OAuth scopes must match the scopes
your Optical deployment allows, so redeploy both together when either
changes.

## Development

```bash
cd worker && npm ci
npm run typecheck
npm run test:ci                          # full suite, batched per test/ subdir
./node_modules/.bin/vitest run <file>    # single file

cd solver && uv run --extra dev pytest -m "not perf"

uv run bin/test_<name>.py                # bin/ harness unit tests
```

Use the repo-pinned vitest rather than `npx vitest`, and run the full suite
via `test:ci`: the Workers vitest pool can't collect every test in one
process.

## Licence

[Business Source License 1.1](LICENSE). Free for production use by
organisations with annual revenue up to AUD $10M. Each release converts to
Apache 2.0 four years after it is published. For other licensing, contact
info@optical-scheduler.com.
