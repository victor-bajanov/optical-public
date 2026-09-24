// Per-endpoint title-reveal rules: a JSON array of regex source strings,
// compiled FULL-MATCH (^(?:p)$) and case-sensitive (no flags). Stored in
// calendar_feed_tokens.reveal_rules; validated on every API write.
export const MAX_PATTERNS = 20;
export const MAX_PATTERN_LENGTH = 256;

export class RevealRegexError extends Error {
  constructor(message: string) { super(message); this.name = "RevealRegexError"; }
}

/**
 * Static heuristic against the two textbook catastrophic-backtracking shapes:
 *
 *  1. Nested quantifiers — a quantifier immediately following a group close
 *     ("`)+`", "`)*`", "`){n,m}`") whose body itself contains a quantifier,
 *     e.g. `(a+)+`.
 *  2. Repeated overlapping alternation — a quantifier immediately following a
 *     group close whose body contains a top-level `|`, e.g. `(a|aa)*`. No
 *     attempt is made to prove the branches actually overlap; any repeated
 *     group containing alternation is treated as risky wholesale.
 *
 * This is best-effort, not a completeness guarantee — it cannot prove
 * ReDoS-freedom in general, other exotic shapes may still slip through, and
 * some innocuous patterns of these shapes may be rejected. The Workers CPU
 * cap is the real backstop; a pattern that slips through and wedges an
 * endpoint is recoverable via PATCH, which never evaluates the stored regexes.
 *
 * Scans the pattern tracking backslash-escapes, character-class ("[...]")
 * spans, and a stack of open group frames. A bare "?" after a group close is
 * exempt (it doesn't repeat anything), as is the "?" that opens a
 * non-capturing/named/lookaround group ("(?:", "(?<name>", "(?=", "(?!"). A
 * top-level `|` marks only the innermost currently-open frame; when that
 * frame's group closes WITHOUT itself being quantified, its alternation
 * propagates one level up to the enclosing frame, since a plain unquantified
 * wrapper group doesn't change the risk — `((a|aa))*` and `(?:(a|aa))*` are
 * both semantically `(a|aa)*` and must be rejected the same way.
 */
function hasRiskyRepetition(pattern: string): boolean {
  const intervalRe = /^\{\d+(,\d*)?\}/;
  const stack: { hasQuantifier: boolean; hasAlternation: boolean }[] = [];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") { i += 2; continue; }
    if (inClass) {
      if (ch === "]") inClass = false;
      i += 1;
      continue;
    }
    if (ch === "[") { inClass = true; i += 1; continue; }
    if (ch === "(") {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      // "(?..." (non-capturing / named / lookaround) — the "?" is group
      // syntax, not a repetition quantifier on the (nonexistent) preceding atom.
      i += pattern[i + 1] === "?" ? 2 : 1;
      continue;
    }
    if (ch === ")") {
      const frame = stack.pop();
      i += 1;
      if (!frame) continue; // unbalanced; standalone-compile check guards this separately
      const rest = pattern.slice(i);
      const isRepetition = rest[0] === "+" || rest[0] === "*" || intervalRe.test(rest);
      if (isRepetition && (frame.hasQuantifier || frame.hasAlternation)) return true;
      // An unquantified group's top-level alternation lives at the parent's
      // level for repetition-risk purposes: `((a|aa))*` is semantically
      // `(a|aa)*`, so a plain wrapper group must not absorb the alternation.
      if (!isRepetition) {
        const parent = stack[stack.length - 1];
        if (parent) parent.hasAlternation = parent.hasAlternation || frame.hasAlternation;
      }
      continue;
    }
    if (ch === "|") {
      const top = stack[stack.length - 1];
      if (top) top.hasAlternation = true;
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "*" || ch === "?") {
      for (const frame of stack) frame.hasQuantifier = true;
      i += 1;
      continue;
    }
    if (ch === "{") {
      const m = intervalRe.exec(pattern.slice(i));
      if (m) {
        for (const frame of stack) frame.hasQuantifier = true;
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return false;
}

/**
 * Validate a reveal-regex list at write time. Each pattern must: be a
 * non-empty string within the length/count caps; compile both standalone
 * (`new RegExp(p)`) and wrapped in the full-match anchor (`^(?:p)$`) — the
 * standalone check catches patterns like `x)|(.*` whose unbalanced parens
 * would otherwise close the anchor group early and match every title once
 * wrapped; and pass the {@link hasRiskyRepetition} heuristic. Throws
 * {@link RevealRegexError} on any violation; returns the input unchanged
 * (already validated as `string[]`) on success.
 */
export function validateRevealRegexes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new RevealRegexError("reveal_regexes must be an array of strings");
  if (input.length > MAX_PATTERNS) throw new RevealRegexError(`at most ${MAX_PATTERNS} patterns per endpoint`);
  for (const p of input) {
    if (typeof p !== "string") throw new RevealRegexError("reveal_regexes must be an array of strings");
    if (p.length === 0) throw new RevealRegexError("empty pattern");
    if (p.length > MAX_PATTERN_LENGTH) throw new RevealRegexError(`pattern longer than ${MAX_PATTERN_LENGTH} chars`);
    try {
      new RegExp(p);
      new RegExp(`^(?:${p})$`);
    } catch {
      throw new RevealRegexError(`pattern does not compile: ${p}`);
    }
    if (hasRiskyRepetition(p)) {
      throw new RevealRegexError(`pattern risks catastrophic backtracking: ${p}`);
    }
  }
  return input as string[];
}

/** Compile validated patterns. Patterns that fail to compile — standalone or
 *  wrapped, e.g. rows written before validation tightened — are skipped,
 *  never thrown. Does not re-run the catastrophic-backtracking heuristic:
 *  that's a write-time gate ({@link validateRevealRegexes}), and legacy-row
 *  tolerance here is only about compilability. */
export function compileRevealRegexes(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      new RegExp(p);
      out.push(new RegExp(`^(?:${p})$`));
    } catch { /* skip */ }
  }
  return out;
}

/** True if `title` full-matches (case-sensitive) any of the compiled reveal
 *  patterns for this endpoint. Used to decide "show real title" vs "Busy". */
export function titleMatches(title: string, compiled: RegExp[]): boolean {
  return compiled.some((r) => r.test(title));
}
