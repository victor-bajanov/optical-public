# Changelog

Curated notes for each public release, newest first. The full commit list for
a release is in that release's PR on the public repository.

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
