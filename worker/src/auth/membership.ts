import type { Env } from "../env";
import { getUser } from "../db/users";

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// True when `email` matches one allow-list entry: either an exact email or a
// "*@domain" wildcard.
function matchesAllowlist(email: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (entry.startsWith("*@")) {
      const domain = entry.slice(2);
      if (email.endsWith(`@${domain}`)) return true;
    } else if (entry === email) {
      return true;
    }
  }
  return false;
}

// Membership gate (Plan 4 brief B). An email is a member if:
//  - it matches MEMBERSHIP_ALLOWLIST (exact or *@domain), OR
//  - it is an OPERATOR_EMAIL seed identity (initial admin), OR
//  - it already has an active users row.
export async function isMember(email: string, env: Env): Promise<boolean> {
  const lower = email.trim().toLowerCase();
  if (!lower) return false;
  if (matchesAllowlist(lower, csv(env.MEMBERSHIP_ALLOWLIST))) return true;
  if (csv(env.OPERATOR_EMAIL).includes(lower)) return true;
  const existing = await getUser(env.DB, email);
  return !!existing && existing.is_active === 1;
}
