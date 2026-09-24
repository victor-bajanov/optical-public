import { describe, it, expect } from "vitest";
import { headerValue } from "../../src/providers/gmail-notification-provider";

describe("headerValue (RFC822 header sanitizer)", () => {
  it("strips CRLF so a value cannot inject a new header", () => {
    expect(headerValue("Subject line\r\nBcc: attacker@evil.test")).toBe("Subject line Bcc: attacker@evil.test");
  });
  it("strips lone CR, lone LF, NUL and other C0/DEL controls", () => {
    expect(headerValue("a\rb\nc\x00d\x7fe")).toBe("a b c d e");
  });
  it("strips Unicode line separators U+2028/U+2029", () => {
    expect(headerValue("a\u2028b\u2029c")).toBe("a b c");
  });
  it("trims surrounding whitespace left by folding", () => {
    expect(headerValue("  hi  ")).toBe("hi");
  });
});
