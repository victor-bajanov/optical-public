import { describe, it, expect } from "vitest";
import {
  validateRevealRegexes, compileRevealRegexes, titleMatches,
  RevealRegexError, MAX_PATTERNS, MAX_PATTERN_LENGTH,
} from "../../src/calendar-feed/reveal-rules";

describe("validateRevealRegexes", () => {
  it("accepts a valid list and returns it", () => {
    expect(validateRevealRegexes(["Northwinds hold .*"])).toEqual(["Northwinds hold .*"]);
  });
  it("accepts an empty list", () => {
    expect(validateRevealRegexes([])).toEqual([]);
  });
  it("rejects non-arrays and non-string members", () => {
    expect(() => validateRevealRegexes("x")).toThrow(RevealRegexError);
    expect(() => validateRevealRegexes([1])).toThrow(RevealRegexError);
  });
  it("rejects a pattern that does not compile", () => {
    expect(() => validateRevealRegexes(["("])).toThrow(RevealRegexError);
  });
  it("rejects over-long patterns and over-long lists", () => {
    expect(() => validateRevealRegexes(["a".repeat(MAX_PATTERN_LENGTH + 1)])).toThrow(RevealRegexError);
    expect(() => validateRevealRegexes(Array.from({ length: MAX_PATTERNS + 1 }, () => "a"))).toThrow(RevealRegexError);
  });
});

describe("titleMatches (full-match, case-sensitive)", () => {
  const rx = compileRevealRegexes(["Northwinds hold .*"]);
  it("matches the whole title", () => {
    expect(titleMatches("Northwinds hold - 2026-07-21 11:00", rx)).toBe(true);
  });
  it("does NOT match a substring occurrence", () => {
    expect(titleMatches("Prep for Northwinds hold - later", rx)).toBe(false);
  });
  it("is case-sensitive", () => {
    expect(titleMatches("northwinds hold - x", rx)).toBe(false);
  });
  it("an empty compiled list matches nothing", () => {
    expect(titleMatches("anything", [])).toBe(false);
  });
  it("alternation inside a pattern cannot escape the anchor group", () => {
    // "a|b" compiled as ^(?:a|b)$ must not match "xa"
    expect(titleMatches("xa", compileRevealRegexes(["a|b"]))).toBe(false);
    expect(titleMatches("b", compileRevealRegexes(["a|b"]))).toBe(true);
  });
});

describe("anchor escape via unbalanced parens", () => {
  // "x)|(.*" wrapped naively becomes ^(?:x)|(.*)$ — the top-level "|" escapes
  // the anchor group and matches every title. The pattern must also compile
  // standalone (unwrapped) to be accepted; this one does not (unbalanced parens).
  it("validateRevealRegexes rejects it", () => {
    expect(() => validateRevealRegexes(["x)|(.*"])).toThrow(RevealRegexError);
  });
  it("compileRevealRegexes skips it rather than emitting an escaping regex", () => {
    expect(compileRevealRegexes(["x)|(.*"])).toEqual([]);
  });
  it("sanity: does not match an unrelated title", () => {
    expect(titleMatches("Board meeting - confidential", compileRevealRegexes(["x)|(.*"]))).toBe(false);
  });
});

describe("catastrophic-backtracking guard", () => {
  it.each([
    "(a+)+",
    "(a*)*",
    "(a+)*",
    "(a{2,}){2,}",
    "((a)+b)+",
  ])("rejects nested-quantifier pattern %s", (p) => {
    expect(() => validateRevealRegexes([p])).toThrow(RevealRegexError);
  });

  it.each([
    "Northwinds hold .*",
    "(?:abc)+",
    "a+b+",
    "(ab)+cd",
    "(?:x+)?",
  ])("accepts safe pattern %s", (p) => {
    expect(validateRevealRegexes([p])).toEqual([p]);
  });
});

describe("alternation-overlap ReDoS shape", () => {
  it.each([
    "(a|aa)*",
    "(a|a)+",
    "(?:Board|Board Mtg)*",
    "(a|b){2,}",
  ])("rejects repeated-alternation pattern %s", (p) => {
    expect(() => validateRevealRegexes([p])).toThrow(RevealRegexError);
  });

  it.each([
    "a|b",
    "(a|b)",
    "(?:Mon|Tue)?",
  ])("accepts safe alternation pattern %s", (p) => {
    expect(validateRevealRegexes([p])).toEqual([p]);
  });
});

describe("alternation propagation through an unquantified wrapper group", () => {
  it.each([
    "((a|aa))*",
    "(?:(a|aa))*",
  ])("rejects %s (semantically (a|aa)*)", (p) => {
    expect(() => validateRevealRegexes([p])).toThrow(RevealRegexError);
  });

  it.each([
    "((a|b))",
    "(?:(a|b))cd",
  ])("accepts %s (nothing repeated)", (p) => {
    expect(validateRevealRegexes([p])).toEqual([p]);
  });
});

describe("compileRevealRegexes skip behaviour", () => {
  it("skips a non-compiling pattern but keeps the rest", () => {
    const compiled = compileRevealRegexes(["(", "a"]);
    expect(compiled.length).toBe(1);
    expect(titleMatches("a", compiled)).toBe(true);
  });
});

describe("boundary cases", () => {
  it("accepts exactly MAX_PATTERNS patterns", () => {
    const patterns = Array.from({ length: MAX_PATTERNS }, (_, i) => `p${i}`);
    expect(validateRevealRegexes(patterns)).toEqual(patterns);
  });
  it("accepts a pattern of exactly MAX_PATTERN_LENGTH chars", () => {
    const p = "a".repeat(MAX_PATTERN_LENGTH);
    expect(validateRevealRegexes([p])).toEqual([p]);
  });
});
