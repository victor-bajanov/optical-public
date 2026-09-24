import { describe, it, expect } from "vitest";
import { escText, escAttr } from "../../src/util/html-escape";

// The four page/email renderers this helper replaces had diverged: some
// escaped only `& < >`, one dropped `< >` from its attribute escaper
// entirely (worker/src/web/accept-page.ts's old escAttr), and two escaped
// the full `& < > " '` set. This test pins the union — the strictest
// behaviour any copy had — for both text-node and attribute contexts, so a
// future edit can't silently narrow either function back down.
const CASES: Array<[char: string, escaped: string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
];

describe("escText", () => {
  for (const [char, escaped] of CASES) {
    it(`escapes ${JSON.stringify(char)}`, () => {
      expect(escText(`a${char}b`)).toBe(`a${escaped}b`);
    });
  }

  it("escapes a mix of every special character in one string", () => {
    expect(escText(`<a href="x">it's & done</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; done&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escText("plain text 123")).toBe("plain text 123");
  });
});

describe("escAttr", () => {
  for (const [char, escaped] of CASES) {
    it(`escapes ${JSON.stringify(char)}`, () => {
      expect(escAttr(`a${char}b`)).toBe(`a${escaped}b`);
    });
  }

  it("escapes a hostile attribute value closing the tag early", () => {
    // The regression this guards: accept-page.ts's old escAttr only escaped
    // `&` and `"`, so a slug/href containing `<` or `>` passed through
    // unescaped inside a double-quoted attribute.
    expect(escAttr(`"><script>alert(1)</script>`)).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes a mix of every special character in one string", () => {
    expect(escAttr(`<a href="x">it's & done</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; done&lt;/a&gt;",
    );
  });
});
