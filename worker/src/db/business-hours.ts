import type { BusinessHours } from "../planning/solver-contract";

export type { BusinessHours } from "../planning/solver-contract";

export async function loadBusinessHours(
  db: D1Database,
  ownerSubject: string,
): Promise<BusinessHours | null> {
  // Own row wins; else the instance default ('__default__'). Absent → null
  // (graceful), matching pre-Plan-6 behaviour for a missing global row.
  const row = await db
    .prepare(
      "SELECT body FROM config_business_hours WHERE owner_subject IN (?, '__default__') ORDER BY (owner_subject = ?) DESC LIMIT 1",
    )
    .bind(ownerSubject, ownerSubject)
    .first<{ body: string }>();
  if (!row) return null;
  return JSON.parse(row.body) as BusinessHours;
}
