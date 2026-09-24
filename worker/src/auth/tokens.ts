function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateOpaqueToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export function generateAuthCode(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function hashToken(token: string, pepper: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${pepper}:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64url(new Uint8Array(digest));
}
