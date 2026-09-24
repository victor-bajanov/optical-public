/** Constant-time string comparison for secret-vs-secret checks (login nonces,
 *  webhook clientState). Length mismatch short-circuits — acceptable because
 *  the compared secrets are fixed-length in practice. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
