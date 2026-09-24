import { describe, it, expect } from "vitest";
import { encryptString, decryptString } from "../../src/auth/encryption";

describe("auth/encryption", () => {
  it("round-trips a string", async () => {
    const ct = await encryptString("s3cret-url", "pepper", "feed-reveal");
    expect(await decryptString(ct, "pepper", "feed-reveal")).toBe("s3cret-url");
  });

  it("fails to decrypt under a different purpose (domain separation)", async () => {
    const ct = await encryptString("x", "pepper", "feed-reveal");
    await expect(decryptString(ct, "pepper", "identity-refresh")).rejects.toThrow();
  });

  it("fails to decrypt under a different pepper", async () => {
    const ct = await encryptString("x", "pepper-a", "feed-reveal");
    await expect(decryptString(ct, "pepper-b", "feed-reveal")).rejects.toThrow();
  });

  it("decrypts a fixed identity-refresh ciphertext (pins key derivation + layout)", async () => {
    // This vector was generated ONCE against the current encryptString/deriveKey
    // (SHA-256("identity-refresh:pin-pepper") -> AES-GCM key; layout is
    // 12-byte IV || ciphertext). Real D1 rows hold ciphertext produced by this
    // exact derivation for purpose "identity-refresh" — if this test breaks,
    // stored refresh tokens would break too. Do NOT regenerate this vector to
    // make the test pass; fix the regression instead.
    const hex =
      "0102030405060708090a0b0ccd1bd824b689c4b136fd3df0e7eb05e7b078d76d488f09c4babcb6f8cd7cc019b88098";
    const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    expect(await decryptString(bytes.buffer, "pin-pepper", "identity-refresh")).toBe(
      "pinned-plaintext-v1",
    );
  });
});
