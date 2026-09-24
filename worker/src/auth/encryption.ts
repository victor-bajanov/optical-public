// Shared AES-GCM string encryption. Key = SHA-256(`${purpose}:${pepper}`) so
// each purpose gets an independent key from the same secret. identity-store
// uses purpose "identity-refresh" (pre-existing data — do NOT rename);
// calendar-feed reveals use "feed-reveal".
async function deriveKey(purpose: string, pepper: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${purpose}:${pepper}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptString(plain: string, pepper: string, purpose: string): Promise<ArrayBuffer> {
  const key = await deriveKey(purpose, pepper);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return out.buffer;
}

export async function decryptString(buf: ArrayBuffer, pepper: string, purpose: string): Promise<string> {
  const key = await deriveKey(purpose, pepper);
  const b = new Uint8Array(buf);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12));
  return new TextDecoder().decode(pt);
}
