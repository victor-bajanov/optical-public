/**
 * HMAC-SHA256 the source event id into an opaque, non-reversible iCal UID so a
 * feed consumer cannot correlate a "Busy" block back to the source event. The
 * @domain suffix is just a namespace label (clients use UID only for identity).
 */
export async function hashEventUid(eventId: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(eventId));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 32) + "@scheduler.example.com";
}
