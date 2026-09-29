# Changelog

Curated notes for each public release, newest first. The full commit list for
a release is in that release's PR on the public repository.

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
