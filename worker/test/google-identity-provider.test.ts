import { describe, it, expect } from "vitest";
import { GoogleIdentityProvider } from "../src/auth/google-identity-provider";

describe("GoogleIdentityProvider", () => {
  const p = new GoogleIdentityProvider({
    clientId: "cid", clientSecret: "secret",
  });

  it("builds an offline consent authorize URL with state + redirect", () => {
    const url = new URL(p.authorizeUrl({ state: "st", redirectUri: "https://o/auth/callback" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://o/auth/callback");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
  });
});
