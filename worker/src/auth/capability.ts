import type { Env } from "../env";
import { capabilityHmacKey } from "./crypto-keys";

export interface CapabilityWindow { start: string; end: string }

export interface AcceptCapabilityClaims {
  purpose: "accept";
  planHash: string;
  subject: string;
  exp: number;
  window?: CapabilityWindow;
  // Absent on this variant, typed for property access without narrowing —
  // pre-existing accept-token call sites read `.pollId`-shaped fields never,
  // but this keeps the union ergonomic for callers that only check one field.
  pollId?: undefined;
  inviteeId?: undefined;
}
export interface PollCapabilityClaims {
  purpose: "poll-response";
  pollId: string;
  inviteeId: string;
  subject: string;
  exp: number;
  // Absent on this variant — see AcceptCapabilityClaims for why these are
  // declared (not just omitted): it lets un-narrowed reads of `.planHash` /
  // `.window` on a `CapabilityClaims` value type-check as `undefined` rather
  // than error, which is how existing accept-only call sites use this type.
  planHash?: undefined;
  window?: undefined;
}
// Organiser-scoped (not invitee-scoped, unlike PollCapabilityClaims): grants
// read-only access to one poll's status page for the subject it was minted
// for, via ?t= on GET /poll/:id/status (worker/src/polls/route.ts) as a
// browser-navigable alternative to that route's requireOwner bearer path.
export interface PollStatusCapabilityClaims {
  purpose: "poll-status";
  pollId: string;
  subject: string;
  exp: number;
  inviteeId?: undefined;
  planHash?: undefined;
  window?: undefined;
}
// Discriminated on `purpose` — callers must narrow before reading
// purpose-specific fields (see accept.ts for the established pattern).
export type CapabilityClaims = AcceptCapabilityClaims | PollCapabilityClaims | PollStatusCapabilityClaims;

// Signing inputs mirror the claims union minus `exp` (derived from ttlSeconds).
export type CapabilityInput =
  | { purpose: "accept"; planHash: string; subject: string; ttlSeconds: number; window?: CapabilityWindow }
  | { purpose: "poll-response"; pollId: string; inviteeId: string; subject: string; ttlSeconds: number }
  | { purpose: "poll-status"; pollId: string; subject: string; ttlSeconds: number };

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
async function hmacKey(pepper: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`capability:${pepper}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signCapability(p: CapabilityInput, pepper: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + p.ttlSeconds;
  const claims: CapabilityClaims =
    p.purpose === "accept"
      ? { purpose: "accept", planHash: p.planHash, subject: p.subject, exp, ...(p.window ? { window: p.window } : {}) }
      : p.purpose === "poll-response"
        ? { purpose: "poll-response", pollId: p.pollId, inviteeId: p.inviteeId, subject: p.subject, exp }
        : { purpose: "poll-status", pollId: p.pollId, subject: p.subject, exp };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(pepper), new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyCapability(token: string, pepper: string): Promise<CapabilityClaims | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(pepper), fromB64url(sig), new TextEncoder().encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as CapabilityClaims;
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}

// Env-aware wrappers used by all call sites (accept.ts, google-calendar.ts,
// monday-resolve.ts). They read the purpose-specific HMAC key (Plan 4 brief E)
// via capabilityHmacKey(env), which defaults to TOKEN_HASH_PEPPER when HMAC_KEY
// is unset, so existing in-flight capability tokens stay verifiable.
export function signCapabilityWithEnv(p: CapabilityInput, env: Env): Promise<string> {
  return signCapability(p, capabilityHmacKey(env));
}

export function verifyCapabilityWithEnv(token: string, env: Env): Promise<CapabilityClaims | null> {
  return verifyCapability(token, capabilityHmacKey(env));
}
