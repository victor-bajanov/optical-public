/**
 * How long a proposed plan stays acceptable: the window during which the
 * emailed accept link works AND the proposal's expires_at gate allows commit.
 * Single source of truth so the capability TTL and expires_at never diverge.
 */
export const ACCEPT_TTL_SECONDS = 72 * 3600;
