# Solver JSON Contract

This is the input/output contract of the solver HTTP service. It is
**intentionally decoupled** from the Worker's storage schema (see the
top-level design spec §3) so the solver can evolve independently and so
the Worker can flatten cross-references (template materialisation,
project priority floors, default penalties) before sending.

## Endpoint

`POST /solve`

- Request body: `Problem` JSON (below)
- 200 response: `Solution` JSON
- 422 response: `{"unsat_core": [UnsatItem...]}`
- 400 response: `{"error": "...", "details": ...}` for malformed JSON
- 500 response: `{"error": "..."}` for solver crashes

## Time and slot encoding

All datetimes are ISO 8601 local-naive (no timezone in the string;
the `window.tz` field documents the intended zone). All datetimes must
align to a 15-minute boundary; the schema rejects misaligned values.

The solver works internally in **slot indices** = whole 15-minute steps
since `window.start`.

## Problem schema

```jsonc
{
  "window": {
    "start": "2026-05-18T00:00:00",
    "end":   "2026-05-25T00:00:00",
    "tz":    "Australia/Sydney"
  },
  "weights": {
    "time_of_day_fit_per_15min":     5,
    "churn_per_15min_moved":         10,
    "priority_unit":                 1,
    "base_drop_penalty":             200,
    "preferred_day_miss":            40,
    "preferred_time_miss_per_15min": 5
  },
  "contexts": [
    {
      "context": "deep",
      "fit_curve": {
        "peak_start":   "09:00",
        "peak_end":     "12:00",
        "falloff_end":  "16:00"
      },
      "max_minutes_per_day":              240,        // or null = unlimited
      "max_contiguous_minutes":           90,         // or null = unlimited
      "over_daily_cap_penalty_per_15min": 25,
      "over_streak_cap_penalty_per_15min":25
    }
  ],
  "tasks": [
    {
      "id":         "task-uuid",
      "title":      "Title",
      "context":    "deep",
      "priority":   70,                              // 0..100
      "chunks":     [{"chunk_id": "task-uuid#0", "duration_minutes": 60}],
      "group_policy": {"same_day": false, "ordered": false},
      "deadline":   {"at": "2026-05-21T17:00:00", "hard": false, "penalty_per_15min": 30},
      "earliest_start": "2026-05-18T00:00:00",      // always hard
      "preferred_windows": [
        {"days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "12:00", "hard": false}
      ],
      "dependencies": [
        {"type": "after_task",   "ref": "task-uuid", "hard": true},
        {"type": "before_event", "ref": "event-id",  "hard": true}
      ],
      "pinned_at": null,                            // ISO datetime or null
      "previous_placement": [
        {"chunk_id": "task-uuid#0", "start": "2026-05-19T09:00:00"}
      ]
    }
  ],
  "external_pinned": [
    {
      "id":               "ext-1",
      "title":            "External meeting",
      "start":            "2026-05-22T19:00:00",
      "duration_minutes": 60,
      "context":          "meeting"
    }
  ]
}
```

## Caller responsibilities (Worker)

These transformations happen Worker-side, not solver-side:

- materialise `TaskTemplate` rows into concrete tasks for the planning window
- substitute `priority * 0.3` as the soft-deadline default `penalty_per_15min`
  when omitted
- expand `Project.priority_floor` into each child task's `priority`
  (use `max(task.priority, project.priority_floor)`)
- merge scheduler-owned vs scheduler-unowned calendar events into the right
  buckets (tasks vs external_pinned)
- pre-filter or chunk tasks longer than the streak cap if you want clean
  scheduling (the solver penalises but does not split)

## Solution schema

```jsonc
{
  "schedule": [
    {
      "task_id":          "task-uuid",
      "chunk_id":         "task-uuid#0",
      "start":            "2026-05-18T09:00:00",
      "duration_minutes": 60,
      "context":          "deep"
    }
  ],
  "dropped": [
    {
      "task_id":                 "uuid",
      "title":                   "Email triage",
      "drop_cost":               230,
      "reason":                  "drop_was_cheaper_than_alternatives",
      "contributing_constraints":["soft_deadline","preferred_window"]
    }
  ],
  "objective": {
    "total": 1234,
    "components": {
      "lateness":         0,
      "fit":              120,
      "churn":            0,
      "daily_cap":        0,
      "streak_cap":       0,
      "drop":             0,
      "preferred_window": 0
    }
  },
  "diagnostics": {
    "pass1_wall_seconds": 0.42,
    "pass2_wall_seconds": 0.31,
    "status":             "OPTIMAL"
  }
}
```

## Response headers

Every response (all routes, all status codes) carries `X-Solver-Uptime-Ms`: the
container process's age in milliseconds, sampled at request receipt. A small
value means the request paid a cold start; the calling worker logs it in its
`solver_fetch` event so cold and warm solve latencies can be separated.

## 422 unsat-core schema

```jsonc
{
  "unsat_core": [
    {"type": "pinned_at",       "task_id": "uuid-1", "value": "2026-05-19T11:00:00"},
    {"type": "hard_deadline",   "task_id": "uuid-2", "value": "2026-05-19T12:00:00"},
    {"type": "hard_dependency", "task_id": "uuid-2", "ref":   "uuid-1"}
  ]
}
```

`type` is one of:
`pinned_at`, `hard_deadline`, `earliest_start`, `hard_dependency`,
`hard_preferred_window`, `group_same_day`, `group_ordered`,
`external_pinned`.
