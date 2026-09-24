export const atomicTask = {
  title: "Email triage",
  context: "admin" as const,
  priority: 40,
  duration_minutes: 30,
};

export const chunkedDeepTask = {
  title: "Review APOLLO quarterly draft",
  context: "deep" as const,
  priority: 70,
  chunks: [{ duration_minutes: 60 }, { duration_minutes: 60 }],
  group_policy: { same_day: false, ordered: false },
  deadline: { at: "2026-05-21T17:00", hard: false, penalty_per_15min: 30 },
};
