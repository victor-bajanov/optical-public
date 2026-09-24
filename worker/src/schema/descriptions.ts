// Canonical prose for the OpenAPI spec. Imported by request AND response
// schemas so the two cannot drift. The `$` key on a composite holds the
// container-level description; its siblings describe the inner fields.
export const D = {
  common: {
    isoDateTime:
      "ISO 8601 datetime. Either local wall-clock 'YYYY-MM-DDTHH:MM' (no timezone) or a full form with seconds and/or a 'Z'/±HH:MM offset. Scheduling runs on a 15-minute grid, so the time of day MUST sit on a quarter-hour boundary (minutes 00/15/30/45, seconds 00). An off-grid value — e.g. '2026-07-10T23:59:59' — is accepted at task creation but fails the whole resolve later with a datetime-alignment error. Encode 'end of day' as 00:00 of the NEXT day (or 23:45), never 23:59:59.",
    timeOfDay: "Wall-clock time of day, 24-hour 'HH:MM'.",
    isoDate: "Calendar date, 'YYYY-MM-DD'.",
    uuid: "RFC 4122 UUID.",
  },

  task: {
    title: "Human-readable task name; shown on the calendar.",
    context:
      "Cognitive/setting category used to batch similar work: 'deep', 'admin', 'physical', 'family', or 'meeting'.",
    priority:
      "Importance from 0–100 (higher = more important). Drives drop order when the week is over-subscribed.",
    location:
      "Free-text place the task happens (e.g. 'Office', 'Home'). Informational only; not used for travel-time math.",
    effort_estimate_confidence:
      "How reliable duration_minutes is: 'low', 'medium', or 'high'.",
    duration_minutes:
      "Total minutes of work for an atomic task. Provide exactly one of duration_minutes or chunks. Work is scheduled in 15-minute blocks, so a duration is reserved rounded UP to the next quarter hour; the calendar event still shows the requested duration.",

    chunks: {
      $: "Splits the task into multiple work sessions instead of one block (minimum two). Provide chunks XOR duration_minutes; when present, group_policy is required.",
      duration_minutes: "Length in minutes of this individual chunk. Reserved rounded UP to the next 15-minute block; the calendar event shows the requested length.",
    },
    group_policy: {
      $: "How the chunks relate to each other. Required when chunks is set; not allowed otherwise.",
      same_day: "If true, all chunks must be scheduled on the same calendar day.",
      ordered: "If true, chunks must run in the order listed.",
    },
    deadline: {
      $: "Latest acceptable completion time. Omit when the task has no due date.",
      at: "The due datetime. Must land on a 15-minute boundary: '2026-07-10T23:59:59' fails at resolve time — for an end-of-day deadline use 00:00 of the next day (or 23:45).",
      hard: "If true, the deadline is inviolable — the solver drops the task rather than schedule it late. If false, lateness is a weighed penalty (see penalty_per_15min).",
      penalty_per_15min:
        "Soft-deadline cost accrued per 15 minutes past `at`. Only meaningful when hard is false.",
    },
    preferred_windows: {
      $: "Recurring time-of-day windows the task should fall within. Each window is weighed, or required if hard. A task with NO pin and NO hard window is confined to your configured business hours (fetch them at GET /v1/business-hours; a 09:00–17:00 Mon–Fri default applies unless changed).",
      days: "Weekdays this window applies to; any of 'mon','tue','wed','thu','fri','sat','sun'. At least one.",
      start: "Window start time of day, 'HH:MM'.",
      end: "Window end time of day, 'HH:MM'.",
      hard: "If true, the task must land inside one of its windows when scheduled; if no window slot is free it is dropped rather than placed outside (if false, falling outside is a weighed penalty). A hard window also REPLACES the business-hours floor with the window itself — so to keep business hours while pinning days, set the window to your business hours (e.g. 09:00–17:00), not 00:00–23:59.",
    },
    dependencies: {
      $: "Ordering constraints relative to other tasks or external calendar events.",
      // `type` is intentionally not applied to the discriminator: zod-to-openapi
      // renders it as a const enum, and the guard test allowlists the `type` property.
      type: "Dependency kind: 'after_task' (run after another task) or 'before_event' (finish before an external event).",
      ref: "Target of the dependency: a task UUID for 'after_task', or an external event identifier for 'before_event'.",
      hard: "If true, the ordering is inviolable — a task is dropped rather than scheduled in violation. If false, violating it is a weighed penalty.",
    },
    source: {
      $: "Provenance — how the task entered the system. Usually omitted when creating a task by hand.",
      kind: "Originating surface: 'mcp', 'rest', 'shortcut', 'cron', or 'webhook'.",
      external_id:
        "Caller-supplied correlation id from the originating system (e.g. the upstream record id), or null. Used to de-duplicate and trace tasks back to their source.",
    },

    earliest_start:
      "Task may not be scheduled before this datetime. Must land on a 15-minute boundary (minutes 00/15/30/45, seconds 00) — e.g. '…T23:59:59' fails at resolve time. Null/omitted means no lower bound. Patching this (like any timing field) clears the placement stamp left by the last committed plan, so moving it into a future week is the supported bring-forward nudge for a dropped or past-week task.",
    pinned_at:
      "Fixes the task to start exactly at this datetime, bypassing solver placement. Must land on a 15-minute boundary (minutes 00/15/30/45, seconds 00) — e.g. '…T23:59:59' fails at resolve time. If that exact slot is unavailable (e.g. it collides with a real meeting) the task is dropped rather than moved. Null/omitted means the solver chooses. Setting OR clearing this via PATCH clears the placement stamp left by the last committed plan.",
    movable_verdict: {
      $: "Owned meetings only, system-maintained: the last resolve's answer to whether Optical can actually relocate this meeting. Every resolve re-stamps it for every meeting task in the window — a freeze (unreadable attendee free/busy, inside the meeting notice window, held by post-move stability) writes ok:false with a reason; a genuine promotion to the solver writes ok:true. Read by the public booking page, which offers a meeting's time to a booker only on a fresh ok:true verdict, so the reschedule it promises is one the planner will actually perform; absent, stale (older than 7 days) or negative all mean 'not bookable'. Written by the planner — a value supplied by a caller stands only until the next resolve overwrites it, and is not a supported way to influence scheduling.",
      at: "ISO datetime of the resolve that produced this verdict. Verdicts older than 7 days are ignored (a resolve re-stamps at least weekly).",
      ok: "True only if the meeting was promoted to the solver as movable in that resolve.",
      reason:
        "Why the meeting was frozen: 'event_missing' (the task row outlived its calendar event), 'imminent_notice', 'commit_stability', 'attendee_availability_unknown' (a constraining attendee's free/busy could not be read), 'no_constraining_attendees' (no attendee constrains the meeting under the effective attendee_enforcement policy — e.g. an 'accepted' policy and nobody has accepted yet — so nobody's availability is known), or 'no_availability_windows'. Null when ok is true.",
    },
    attendee_enforcement:
      "Owned meetings only: which attendees' busy times constrain where this meeting may be moved. 'accepted' = only attendees who accepted; 'accepted_or_tentative' = also those marked tentative; 'not_declined' = anyone who has not declined (including those who have not yet responded). Omitted/null = use the account default. Ignored on non-meeting tasks.",
    must_include:
      "When true the task is mandatory: the solver may not drop it to relieve an over-subscribed week. Orthogonal to timing-hardness — combine with pinned_at / a hard deadline / a hard preferred_window, or leave timing open. If a must_include task cannot be placed even in isolation (e.g. pinned onto an immovable event, or its earliest_start is past the window) it is demoted to droppable and dropped rather than failing the whole plan; genuine over-subscription of mutually-feasible must_include tasks returns 422. Default false (droppable).",
    template_id: "Recurring template that generated this task, if any.",
    project_id: "Project this task belongs to, if any.",
    status:
      "Lifecycle state: 'pending' (awaiting placement), 'scheduled' (solver-placed, not yet committed to calendar), 'committed' (written to Google Calendar; if a later committed plan drops the task it reverts to 'pending' with its placement stamp cleared), 'done' (user-marked complete — terminal: excluded from planning and scheduler-owned calendar events are removed on the next replan; reversible by an explicit PATCH {status:\"pending\"}, or by repainting a chunk's calendar event off the done color — but only the exact event whose done-coloring was verified when the chunk was recorded complete; an unverified or duplicate event's color never revives), or 'cancelled' (dropped, no further scheduling).",
  },

  template: {
    title: "Human-readable template name; copied to each generated task.",
    context: "Context category applied to every generated occurrence (see task.context).",
    rrule:
      "iCalendar RRULE defining recurrence; must contain 'FREQ=' (e.g. 'FREQ=WEEKLY;BYDAY=MO').",
    pinned_time: "Optional wall-clock time each generated occurrence is pinned to, 'HH:MM'.",
    pinned_tz:
      "IANA timezone used to interpret pinned_time (e.g. 'Australia/Sydney', 'America/New_York').",
    duration_minutes: "Duration in minutes of each generated occurrence.",
    task_body:
      "Partial Task fields applied to each generated occurrence (priority, deadline, preferred_windows, etc.); validated when the occurrence is materialised.",
    active_from: "First date (inclusive) the template generates occurrences.",
    active_until:
      "Last date (inclusive) the template generates occurrences; null means open-ended.",
  },

  project: {
    title: "Project name.",
    deadline: "Optional overall project due datetime.",
    priority_floor:
      "Minimum effective priority (0–100) applied to tasks in this project.",
  },

  businessHours: {
    $: "The business-hours placement floor: the recurring window a task without a pin or a hard preferred window is confined to when scheduled. Bounds where a task lands, never whether it is scheduled. Null when no floor is configured (the solver then applies none).",
    days: "Weekdays the floor applies to; any of 'mon','tue','wed','thu','fri','sat','sun'.",
  },

  taskList: {
    status:
      "Filter to tasks in this lifecycle state ('pending', 'scheduled', 'committed', 'done', or 'cancelled'). Omit to return all states.",
    project_id: "Filter to tasks belonging to this project (UUID).",
    from: "Inclusive lower bound on updated_at: return only tasks last updated at or after this ISO 8601 datetime. Compared lexicographically against the stored timestamp (full form 'YYYY-MM-DDTHH:MM:SS.sssZ', e.g. '2026-05-28T09:00:00.000Z'), so use that same form to avoid edge cases. Omit for no lower bound.",
    to: "Inclusive upper bound on updated_at: return only tasks last updated at or before this ISO 8601 datetime. Compared lexicographically against the stored timestamp (full form 'YYYY-MM-DDTHH:MM:SS.sssZ', e.g. '2026-05-28T09:00:00.000Z'), so use that same form to avoid edge cases. Omit for no upper bound.",
  },

  resolve: {
    window_start: "Start of the date window to solve (ISO 8601). The solver only places work inside [window_start, window_end). Align both bounds to a 15-minute block boundary (:00/:15/:30/:45) — the solver models time in 15-minute slots and truncates a fractional bound inward, silently shrinking the window.",
    window_end: "End of the date window to solve (ISO 8601), exclusive. Use a 15-minute-aligned instant: for a whole day, pass the NEXT day's midnight (e.g. 2026-07-10T00:00:00+10:00), NOT 23:59:59 — an unaligned end truncates down to the previous block (23:59:59 → 23:45), dropping the last 15 minutes of the day.",
    weights_override:
      "Optional per-objective weight overrides for this solve only; keys are solver objective names, values are their relative weights.",
    account_email:
      "Optional Google account email whose calendar supplies the busy/free baseline. Defaults to the caller's connected account.",
  },

  // Cost-curve customisation (internal design notes).
  // Placeholder keys only — Card B fills `contextConfig`, Card C fills
  // `weightsConfig`; nothing else edits these blocks.
  contextConfig: {
    getContexts:
      "Return the caller's effective per-context scheduling config: for EACH of the 5 known contexts (deep, admin, physical, family, meeting) independently, the caller's own row if they have customised it, else the instance default — always exactly 5 entries. Fit-curve times are local to the caller's home timezone, matching the solve window. Once a context is customised (via PATCH), it snapshots ALL its fields and stops tracking future instance-default changes until reset via DELETE — 'source' tells you which state each context is in.",
    updateContext:
      "Partially update the caller's scheduling config for one context (fit curve and/or caps/penalties). The supplied fields are merged over the context's current EFFECTIVE config (the caller's own row if any, else the instance default) and stored as a complete snapshot — so after this call the context stops tracking future instance-default changes, on every field, not just the ones this call touched, until reset via DELETE /v1/contexts/{context}. fit_curve is atomic: when supplied it must carry the full peak_start/peak_end/falloff_end triple, never a partial curve merged field-by-field. Curve times are local to the caller's home timezone, matching the solve window. At least one field must be supplied.",
    resetContext:
      "Delete the caller's custom row for this context, if any, so it goes back to tracking the instance default. Idempotent: calling this on a context that's already on the default is a no-op 200, not an error.",
  },
  weightsConfig: {
    getWeights:
      "Return the caller's effective solver weights: the six global soft weights (time_of_day_fit_per_15min, churn_per_15min_moved, priority_unit, base_drop_penalty, preferred_day_miss, preferred_time_miss_per_15min) that shape every resolve. Precedence: the instance '__default__' row, overridden by the caller's own custom row (if any), overridden in turn by a per-resolve weights_override for that resolve only. `source` reflects the row actually in play — 'custom' if the caller has PATCHed and not since reset, 'default' otherwise; it is row-level, not per-field, because a PATCH stores a complete six-field snapshot.",
    updateWeights:
      "Partially update the caller's solver weights. The body is merged over the caller's current effective weights (their custom row if any, else the instance default) and stored as a complete six-field snapshot — once customised this way, the row stops tracking future instance-default changes until reset via DELETE /v1/weights. Each supplied field must be a non-negative integer (the solver's Weights model types every field int = Field(ge=0); a fractional or infinite value here would poison a later resolve); unknown keys are rejected (400) rather than silently ignored. At least one field is required (400 empty_update otherwise). This never affects a per-resolve weights_override, which still overrides these stored weights for that resolve only.",
    resetWeights:
      "Delete the caller's custom weights row, if any, so they track the instance default weights again. Idempotent: calling this with no custom row still returns 200 with the current (default) weights.",
  },

  error: {
    solver_status:
      "Upstream HTTP status code returned by the solver service.",
    solver_detail:
      "Detail message from the solver service describing why it failed.",
    internal_detail:
      "Stringified exception detail when the resolve handler catches an unexpected internal failure.",
  },

  webhook: {
    queued:
      "True when the change was accepted and a debounced replan was enqueued; the actual resolve runs off the request path.",
    state:
      "Lifecycle signal echoed from Google's X-Goog-Resource-State header (e.g. 'sync' for the initial channel handshake).",
  },

  response: {
    id: "Server-assigned UUID.",
    created_at: "Server timestamp (ISO 8601) when the record was created.",
    updated_at: "Server timestamp (ISO 8601) when the record was last updated.",

    tasks: "The matching tasks, each a full task object with its constraints and current status.",
    templates: "All recurring task templates.",
    projects: "All projects.",

    committed: "Number of calendar events created/updated by this commit.",
    already_committed: "Always true; indicates this plan was already committed (the call was a no-op).",
    latest_plan_hash:
      "The current pending plan for the same week as the superseded hash, when that week is identifiable (form `ws`/`we` or the token's window claim) and has a pending plan; re-fetch it (GET /plans/{plan_hash}) and accept that instead.",

    plan_hash:
      "Content hash identifying this proposed plan; pass it to commit or accept, or use GET /plans/{plan_hash} to inspect.",
    expires_at:
      "When this proposed plan expires and can no longer be committed (ISO 8601).",
    committed_at:
      "When the plan was committed to the calendar (ISO 8601), or null if not yet committed.",
    body: "The plan contents: the placed schedule, dropped tasks, and covered window.",

    schedule: {
      $: "Concrete placed work blocks in this plan.",
      task_id: "Task this block belongs to.",
      chunk_id: "Identifier of the specific chunk placed (the task id for atomic tasks).",
      start: "Block start (ISO 8601).",
      end: "Block end (ISO 8601).",
      context: "Context category of the task (see task.context).",
    },
    dropped: {
      $: "Tasks the solver could not fit, left unscheduled, with the reason.",
      task_id: "Task that was dropped.",
      title: "Title of the dropped task.",
      drop_cost: "Relative regret the solver incurred by dropping this task (higher = worse).",
      reason: "Human-readable explanation of why the task was dropped.",
      contributing_constraints:
        "Identifiers of the constraints that forced the drop.",
    },
    window: {
      $: "The date window this plan covers.",
      start: "Window start (ISO 8601).",
      end: "Window end (ISO 8601).",
    },
    warnings:
      "Advisory warnings about the resolved schedule, as '<meeting title>: <code>' strings. 'attendee_availability_unknown' is EXPECTED for any meeting with external attendees: their free/busy is not visible to this account, so the meeting is simply left at its current time instead of being considered for relocation. It is normal operation, not an error — do not suggest remediation to the user (there is nothing to fix from this API; visibility depends on the attendees' calendar sharing). Other codes (e.g. a must-include meeting kept while a task dropped) are likewise informational.",
  },
} as const;

export const API_OVERVIEW = `**optical — weekly scheduling assistant.** You describe work as *tasks* (with rich timing constraints), optionally grouped by *projects* or generated from recurring *templates*; a solver packs them into an optimal week, which you preview, accept, and commit to Google Calendar.

**Responses are enveloped:** every \`codemode.request(...)\` resolves to a runtime wrapper \`{ success, status, result, errors }\` — the API payload documented below lives under \`.result\`, one level down. Read the created task's id at \`res.result.id\`, the task list at \`res.result.tasks\`, a plan at \`res.result\`, etc. Check \`success\`/\`status\` to detect failures.

**Workflow:** (1) Create tasks — \`POST /v1/tasks\` is the main constraint surface; read its request-body field descriptions closely. (2) \`POST /v1/resolve\` for a date window → returns a \`plan_hash\` and proposed schedule. (3) Inspect via \`GET /v1/plans/{plan_hash}\`. (4) \`POST /v1/plans/{plan_hash}/accept\` or \`POST /v1/commit\` to write the plan to Google Calendar. (5) \`GET /v1/schedule\` returns the current committed plan.

**Key concepts (on the task schema):** every \`hard\` boolean means *inviolable* when \`true\`, a weighed *preference* when \`false\`. Hardness and droppability are orthogonal: a \`hard\` constraint governs only *where* a task goes when scheduled — an over-subscribed week drops the lowest-\`priority\` *droppable* task (rather than violating a hard constraint or failing the whole solve). Inclusion is a separate axis: a task with \`must_include: true\` is never dropped — if mutually-feasible must-include tasks over-subscribe the week the solve returns an infeasible (422) result, while a must-include task that cannot be placed even in isolation degrades to a drop. A task has **either** \`duration_minutes\` **or** \`chunks\` (chunks require \`group_policy\`). \`deadline\`, \`preferred_windows\` (note the per-day \`days\` enum), \`dependencies\`, \`earliest_start\`, and \`pinned_at\` further constrain placement. A global **business-hours floor** confines any task with no pin and no hard window to configured hours; a hard window overrides it. Read your effective hours at \`GET /v1/business-hours\` (a \`09:00–17:00 Mon–Fri\` default applies unless changed).

**Traversal:** start at the \`createTask\` request schema — field descriptions there explain semantics and which composite fields apply together — then follow \`resolve\` → \`plans\` → \`commit\`.`;
