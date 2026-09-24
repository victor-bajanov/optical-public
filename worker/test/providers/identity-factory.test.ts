import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { defaultCalendarProvider, defaultIdentityProvider, defaultNotificationProvider, defaultProviders, enabledProviders, ProviderDisabledError } from "../../src/index-providers";
import { GoogleIdentityProvider } from "../../src/auth/google-identity-provider";
import { GoogleCalendarProvider } from "../../src/providers/google-calendar-provider";
import { GmailNotificationProvider } from "../../src/providers/gmail-notification-provider";
import { MicrosoftIdentityProvider } from "../../src/auth/microsoft-identity-provider";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { MicrosoftGraphNotificationProvider } from "../../src/providers/microsoft-graph-notification-provider";
import { storeIdentityTokens } from "../../src/auth/identity-store";

describe("defaultIdentityProvider", () => {
  it("returns a Google provider by default (no provider argument)", () => {
    expect(defaultIdentityProvider(env)).toBeInstanceOf(GoogleIdentityProvider);
  });
});

describe("per-user provider resolution", () => {
  it("resolves google subjects to GoogleCalendarProvider", async () => {
    await storeIdentityTokens(env, "g@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google");
    expect(await defaultCalendarProvider(env, "g@example.com")).toBeInstanceOf(GoogleCalendarProvider);
  });

  it("resolves microsoft subjects to MicrosoftCalendarProvider", async () => {
    const e = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(e, "m@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    expect(await defaultCalendarProvider(e, "m@example.com")).toBeInstanceOf(MicrosoftCalendarProvider);
  });

  it("resolves microsoft subjects to MicrosoftGraphNotificationProvider", async () => {
    const e = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(e, "mn@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    expect(await defaultNotificationProvider(e, "mn@example.com")).toBeInstanceOf(MicrosoftGraphNotificationProvider);
  });

  it("defaultIdentityProvider returns the MS IdP when asked and enabled", () => {
    const e = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    expect(defaultIdentityProvider(e, "microsoft")).toBeInstanceOf(MicrosoftIdentityProvider);
  });

  it("defaultIdentityProvider threads MICROSOFT_MAIL_READ_SCOPE_ENABLED into the MS IdP's scopes, mirroring GOOGLE_GMAIL_READ_SCOPE_ENABLED", () => {
    const withoutFlag = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    expect((defaultIdentityProvider(withoutFlag, "microsoft") as MicrosoftIdentityProvider).scopes)
      .not.toContain("https://graph.microsoft.com/Mail.Read");

    const withFlag = { ...withoutFlag, MICROSOFT_MAIL_READ_SCOPE_ENABLED: "true" };
    expect((defaultIdentityProvider(withFlag, "microsoft") as MicrosoftIdentityProvider).scopes)
      .toContain("https://graph.microsoft.com/Mail.Read");
  });

  it("defaultIdentityProvider requires the exact string \"true\" for MICROSOFT_MAIL_READ_SCOPE_ENABLED — \"1\" and \"True\" do not enable it", () => {
    const base = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    for (const notTrue of ["1", "True", "TRUE", "yes"]) {
      const e = { ...base, MICROSOFT_MAIL_READ_SCOPE_ENABLED: notTrue };
      expect((defaultIdentityProvider(e, "microsoft") as MicrosoftIdentityProvider).scopes)
        .not.toContain("https://graph.microsoft.com/Mail.Read");
    }
  });

  it("defaultIdentityProvider rejects microsoft when the gate is off", () => {
    expect(() => defaultIdentityProvider(env, "microsoft")).toThrow("ms_provider_disabled");
  });

  it("defaultIdentityProvider throws ProviderDisabledError specifically (not a plain Error) when the gate is off", () => {
    expect(() => defaultIdentityProvider(env, "microsoft")).toThrow(ProviderDisabledError);
  });
});

describe("threading a known provider name skips the identity_tokens lookup", () => {
  it("defaultCalendarProvider does not query DB when the provider is passed", async () => {
    const dbShouldNotBeTouched = {
      prepare() {
        throw new Error("db_should_not_be_touched");
      },
    };
    const e = { ...env, DB: dbShouldNotBeTouched as unknown as typeof env.DB };
    expect(await defaultCalendarProvider(e, "g@example.com", "google")).toBeInstanceOf(GoogleCalendarProvider);
  });

  it("defaultNotificationProvider does not query DB when the provider is passed", async () => {
    const dbShouldNotBeTouched = {
      prepare() {
        throw new Error("db_should_not_be_touched");
      },
    };
    const e = {
      ...env,
      DB: dbShouldNotBeTouched as unknown as typeof env.DB,
      MS_PROVIDER_ENABLED: "true",
      MICROSOFT_OAUTH_CLIENT_ID: "x",
      MICROSOFT_OAUTH_CLIENT_SECRET: "y",
    };
    expect(await defaultNotificationProvider(e, "mn@example.com", "microsoft")).toBeInstanceOf(
      MicrosoftGraphNotificationProvider,
    );
  });
});

describe("defaultProviders (bundle factory)", () => {
  it("resolves the provider once and returns a matching {calendar, notification} bundle for a google subject", async () => {
    await storeIdentityTokens(env, "bundle-g@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google");
    const { calendar, notification } = await defaultProviders(env, "bundle-g@example.com");
    expect(calendar).toBeInstanceOf(GoogleCalendarProvider);
    expect(notification).toBeInstanceOf(GmailNotificationProvider);
  });

  it("resolves the provider once and returns a matching {calendar, notification} bundle for a microsoft subject", async () => {
    const e = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(e, "bundle-m@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    const { calendar, notification } = await defaultProviders(e, "bundle-m@example.com");
    expect(calendar).toBeInstanceOf(MicrosoftCalendarProvider);
    expect(notification).toBeInstanceOf(MicrosoftGraphNotificationProvider);
  });

  it("rejects with ProviderDisabledError for an already-provisioned microsoft subject when the kill switch is off", async () => {
    // Provision the row while Microsoft sign-in is enabled...
    const msEnv = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(
      msEnv,
      "kill-switch@example.com",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    // ...then call defaultProviders against an env where MS_PROVIDER_ENABLED
    // is unset (the runtime kill switch). It must NOT fall back to Google —
    // that would read this subject's live Graph token out of the
    // provider-agnostic GOOGLE_TOKEN_CACHE and hand it to googleapis.com (or,
    // on a cache miss, POST the Microsoft refresh token to Google's token
    // endpoint). The resolved provider name must still reach
    // defaultIdentityProvider so the kill switch actually blocks.
    await expect(defaultProviders(env, "kill-switch@example.com")).rejects.toBeInstanceOf(ProviderDisabledError);
  });
});

describe("enabledProviders", () => {
  const base = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-0000-0000-000000000000" };
  it("offers microsoft only when the flag is on AND the Entra client id is real", () => {
    expect(enabledProviders(base)).toEqual(["google", "microsoft"]);
  });
  it("withholds microsoft while the client id is the wrangler placeholder or empty", () => {
    expect(enabledProviders({ ...base, MICROSOFT_OAUTH_CLIENT_ID: "<set after Entra app registration>" })).toEqual(["google"]);
    expect(enabledProviders({ ...base, MICROSOFT_OAUTH_CLIENT_ID: "" })).toEqual(["google"]);
    expect(enabledProviders({ ...base, MICROSOFT_OAUTH_CLIENT_ID: undefined })).toEqual(["google"]);
  });
  it("withholds microsoft when the flag is off regardless of the client id", () => {
    expect(enabledProviders({ ...base, MS_PROVIDER_ENABLED: "false" })).toEqual(["google"]);
  });
});
