import type { Env } from "../env";
import { hashingKey } from "../auth/crypto-keys";

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256(hashingKey, label + subject), hex. The label domain-separates
 *  each use, so one keyed MAC of a subject can never stand in for another.
 *  Throws (crypto_key_missing) when the deployment has no hashing key. */
export async function keyedSubjectMac(env: Env, label: string, subject: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(hashingKey(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}${subject}`)));
}

/** The stand-in for a subject (an email) on a log line:
 *  "subj:" + HMAC-SHA256(hashingKey, "log-pseudonym:" + subject), hex.
 *  Keyed, so a log reader can't recompute it from a guessed address; stable,
 *  so an operator holding the key can recompute it for a known subject and
 *  one subject's lines group together. Its own label and prefix keep it
 *  distinct from the audit-log purge pseudonym ("deleted:", "audit-pseudonym:").
 *  Never throws: a log line must not fail its caller, so a deployment with no
 *  hashing key gets the fixed marker "subj:unavailable" (never the subject). */
export async function logPseudonym(env: Env, subject: string): Promise<string> {
  try {
    return `subj:${await keyedSubjectMac(env, "log-pseudonym:", subject)}`;
  } catch {
    return "subj:unavailable";
  }
}

const LOG_ERROR_MAX = 200;

/** An error as log text: String(e) with the subject (matched literally and
 *  case-insensitively) replaced by its pseudonym, every whitespace run
 *  collapsed to one space, capped at 200 characters. Errors can name the
 *  subject in their text (identity-store's "no identity tokens for <subject>"),
 *  and Google failure bodies are pretty-printed JSON, so collapsing (rather
 *  than keeping the first line) keeps the reason inside the cap. Redaction
 *  runs before the cap, so a cut can never leave part of an address. */
export function logErrorText(e: unknown, redact?: { subject: string; pseudonym: string }): string {
  let text = String(e);
  if (redact && redact.subject) {
    const literal = redact.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(literal, "gi"), () => redact.pseudonym);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, LOG_ERROR_MAX);
}
