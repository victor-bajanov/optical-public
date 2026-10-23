import { describe, it, expect } from "vitest";
import {
  requiredProductScopes, parseGranted, missingProductScopes, scopeLabel,
  googleScopeOptions, microsoftScopeOptions, requireExactProviderScopes,
} from "../../src/auth/scope-check";
import { GoogleIdentityProvider } from "../../src/auth/google-identity-provider";
import { MicrosoftIdentityProvider } from "../../src/auth/microsoft-identity-provider";
import type { Env } from "../../src/env";

const G = "https://www.googleapis.com/auth/";
const GRAPH = "https://graph.microsoft.com/";

const G_EVENTS = `${G}calendar.events`;
const G_FREEBUSY = `${G}calendar.freebusy`;
const G_SEND = `${G}gmail.send`;
const G_EMAIL = `${G}userinfo.email`;
const G_ACLS = `${G}calendar.acls`;
const G_READ = `${G}gmail.readonly`;

type Flags = Partial<Pick<Env, "GOOGLE_ACL_SCOPE_ENABLED" | "GOOGLE_GMAIL_READ_SCOPE_ENABLED" | "MICROSOFT_MAIL_READ_SCOPE_ENABLED">>;
const OFF: Flags = {};
const ALL_ON: Flags = {
  GOOGLE_ACL_SCOPE_ENABLED: "true",
  GOOGLE_GMAIL_READ_SCOPE_ENABLED: "true",
  MICROSOFT_MAIL_READ_SCOPE_ENABLED: "true",
};

const without = (all: string[], drop: string) => all.filter((s) => s !== drop).join(" ");

describe("requiredProductScopes", () => {
  it("google, harness flags off: the three product scopes; identity scopes excluded", () => {
    expect(requiredProductScopes("google", OFF)).toEqual([G_EVENTS, G_FREEBUSY, G_SEND]);
  });

  it("google, harness flags on: adds calendar.acls and gmail.readonly", () => {
    expect(requiredProductScopes("google", ALL_ON)).toEqual([G_EVENTS, G_FREEBUSY, G_SEND, G_ACLS, G_READ]);
  });

  it("microsoft, flag off: Calendars.ReadWrite and Mail.Send (normalised: bare, lower-case)", () => {
    expect(requiredProductScopes("microsoft", OFF)).toEqual(["calendars.readwrite", "mail.send"]);
  });

  it("microsoft, MICROSOFT_MAIL_READ_SCOPE_ENABLED on: adds Mail.Read", () => {
    expect(requiredProductScopes("microsoft", ALL_ON)).toEqual(["calendars.readwrite", "mail.send", "mail.read"]);
  });

  it("only an exact \"true\" turns a harness flag on", () => {
    expect(requiredProductScopes("google", { GOOGLE_ACL_SCOPE_ENABLED: "TRUE", GOOGLE_GMAIL_READ_SCOPE_ENABLED: "1" }))
      .toEqual([G_EVENTS, G_FREEBUSY, G_SEND]);
  });

  // No drift: every scope the provider actually REQUESTS is either required
  // here or a sign-in/identity scope, for every flag combination. A new
  // product scope added to a provider (or calendar.events -> .owned, O8)
  // is checked without touching scope-check.ts.
  const combos: Flags[] = [OFF, ALL_ON, { GOOGLE_ACL_SCOPE_ENABLED: "true" }, { GOOGLE_GMAIL_READ_SCOPE_ENABLED: "true" }];
  for (const flags of combos) {
    it(`google requested scopes are all required or identity (${JSON.stringify(flags)})`, () => {
      const requested = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s", ...googleScopeOptions(flags) }).scopes;
      const required = new Set(requiredProductScopes("google", flags));
      const identity = new Set([G_EMAIL]);
      for (const s of requested) expect(required.has(s.toLowerCase()) || identity.has(s)).toBe(true);
      expect(required.size).toBe(requested.length - 1);
    });
    it(`microsoft requested scopes are all required or identity (${JSON.stringify(flags)})`, () => {
      const requested = new MicrosoftIdentityProvider({ clientId: "c", clientSecret: "s", ...microsoftScopeOptions(flags) }).scopes;
      const required = new Set(requiredProductScopes("microsoft", flags));
      const identity = new Set(["openid", "profile", "email", "offline_access"]);
      for (const s of requested) {
        const bare = s.replace(GRAPH, "").toLowerCase();
        expect(required.has(bare) || identity.has(bare)).toBe(true);
      }
      expect(required.size).toBe(requested.length - identity.size);
    });
  }
});

describe("parseGranted", () => {
  it("google: whitespace-split, lower-cased", () => {
    expect([...parseGranted("google", `  ${G_EVENTS}\n${G_SEND}  openid `)]).toEqual([G_EVENTS, G_SEND, "openid"]);
  });

  it("microsoft: the Graph prefix and bare forms both normalise to the bare lower-case name", () => {
    expect([...parseGranted("microsoft", `${GRAPH}Calendars.ReadWrite Mail.Send HTTPS://GRAPH.MICROSOFT.COM/Mail.Read`)])
      .toEqual(["calendars.readwrite", "mail.send", "mail.read"]);
  });

  it("missing or empty scope field parses to the empty set", () => {
    expect(parseGranted("google", undefined).size).toBe(0);
    expect(parseGranted("microsoft", null).size).toBe(0);
    expect(parseGranted("google", "").size).toBe(0);
  });
});

describe("missingProductScopes: google", () => {
  const full = [G_EVENTS, G_FREEBUSY, G_SEND, G_EMAIL, "openid"];

  it("full grant: nothing missing", () => {
    expect(missingProductScopes("google", OFF, full.join(" "))).toEqual([]);
  });

  for (const s of [G_EVENTS, G_FREEBUSY, G_SEND]) {
    it(`${s.replace(G, "")} unticked alone -> exactly that one missing`, () => {
      expect(missingProductScopes("google", OFF, without(full, s))).toEqual([s]);
    });
  }

  it("userinfo.email absent does not refuse (a sign-in scope Google never offers as a checkbox; fetchIdentity fails closed on a missing email anyway)", () => {
    expect(missingProductScopes("google", OFF, without(full, G_EMAIL))).toEqual([]);
  });

  it("include_granted_scopes union (extra earlier grants) is still a pass", () => {
    expect(missingProductScopes("google", OFF, `${full.join(" ")} ${G}calendar ${G}drive.file`)).toEqual([]);
  });

  it("calendar.acls: required and missing when GOOGLE_ACL_SCOPE_ENABLED=true; ignored when off", () => {
    const grant = `${full.join(" ")} ${G_READ}`;
    expect(missingProductScopes("google", ALL_ON, grant)).toEqual([G_ACLS]);
    expect(missingProductScopes("google", { GOOGLE_GMAIL_READ_SCOPE_ENABLED: "true" }, grant)).toEqual([]);
  });

  it("gmail.readonly: required and missing when GOOGLE_GMAIL_READ_SCOPE_ENABLED=true; ignored when off", () => {
    const grant = `${full.join(" ")} ${G_ACLS}`;
    expect(missingProductScopes("google", ALL_ON, grant)).toEqual([G_READ]);
    expect(missingProductScopes("google", { GOOGLE_ACL_SCOPE_ENABLED: "true" }, grant)).toEqual([]);
  });

  it("no scope field at all fails closed: every product scope is missing", () => {
    expect(missingProductScopes("google", OFF, undefined)).toEqual([G_EVENTS, G_FREEBUSY, G_SEND]);
  });

  it("a scope granted to the OTHER provider's name never satisfies google", () => {
    expect(missingProductScopes("google", OFF, "calendar.events calendar.freebusy gmail.send")).toEqual([G_EVENTS, G_FREEBUSY, G_SEND]);
  });
});

describe("missingProductScopes: microsoft", () => {
  const prefixed = [`${GRAPH}Calendars.ReadWrite`, `${GRAPH}Mail.Send`, "openid", "profile", "email", "offline_access"];
  const bare = ["Calendars.ReadWrite", "Mail.Send"];

  it("full grant, Graph-prefixed form: nothing missing", () => {
    expect(missingProductScopes("microsoft", OFF, prefixed.join(" "))).toEqual([]);
  });

  it("full grant, bare form without openid/offline_access echoed: nothing missing", () => {
    expect(missingProductScopes("microsoft", OFF, bare.join(" "))).toEqual([]);
  });

  it("case-insensitive", () => {
    expect(missingProductScopes("microsoft", OFF, "calendars.readwrite MAIL.SEND")).toEqual([]);
  });

  it("Calendars.ReadWrite missing alone", () => {
    expect(missingProductScopes("microsoft", OFF, without(prefixed, `${GRAPH}Calendars.ReadWrite`))).toEqual(["calendars.readwrite"]);
    expect(missingProductScopes("microsoft", OFF, "Mail.Send User.Read")).toEqual(["calendars.readwrite"]);
  });

  it("Mail.Send missing alone", () => {
    expect(missingProductScopes("microsoft", OFF, without(prefixed, `${GRAPH}Mail.Send`))).toEqual(["mail.send"]);
    expect(missingProductScopes("microsoft", OFF, "Calendars.ReadWrite")).toEqual(["mail.send"]);
  });

  it("Calendars.Read is not Calendars.ReadWrite", () => {
    expect(missingProductScopes("microsoft", OFF, "Calendars.Read Mail.Send")).toEqual(["calendars.readwrite"]);
  });

  it("Mail.Read: required and missing when MICROSOFT_MAIL_READ_SCOPE_ENABLED=true; ignored when off", () => {
    expect(missingProductScopes("microsoft", ALL_ON, prefixed.join(" "))).toEqual(["mail.read"]);
    expect(missingProductScopes("microsoft", ALL_ON, `${prefixed.join(" ")} Mail.Read`)).toEqual([]);
    expect(missingProductScopes("microsoft", OFF, prefixed.join(" "))).toEqual([]);
  });

  it("empty scope field fails closed: every product scope is missing", () => {
    expect(missingProductScopes("microsoft", OFF, "")).toEqual(["calendars.readwrite", "mail.send"]);
  });
});

describe("scopeLabel", () => {
  it("every required scope of both providers (all flags on) has a human label, not the raw scope", () => {
    for (const p of ["google", "microsoft"] as const) {
      for (const s of requiredProductScopes(p, ALL_ON)) {
        const label = scopeLabel(s);
        expect(label).not.toContain("http");
        expect(label).not.toBe(s);
        expect(label.length).toBeGreaterThan(8);
      }
    }
  });

  it("names the permission in the words a person ticked", () => {
    expect(scopeLabel(G_SEND)).toMatch(/send email/i);
    expect(scopeLabel(G_EVENTS)).toMatch(/calendar/i);
    expect(scopeLabel("mail.send")).toMatch(/send mail/i);
  });

  it("an unknown scope falls back to the scope string itself", () => {
    expect(scopeLabel("x.unknown")).toBe("x.unknown");
  });
});

describe("requireExactProviderScopes (REQUIRE_EXACT_PROVIDER_SCOPES)", () => {
  it("requires exact scopes unless the var is exactly \"false\"", () => {
    for (const v of [undefined, "", "true", "TRUE", "False", "FALSE", " false", "false ", "0", "no"]) {
      expect(requireExactProviderScopes({ REQUIRE_EXACT_PROVIDER_SCOPES: v }), JSON.stringify(v)).toBe(true);
    }
    expect(requireExactProviderScopes({})).toBe(true);
    expect(requireExactProviderScopes({ REQUIRE_EXACT_PROVIDER_SCOPES: "false" })).toBe(false);
  });
});
