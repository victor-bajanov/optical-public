import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  loadBookingPage, saveBookingPage, findOwnerBySlug, validateSlug, SlugError, normaliseLocation,
} from "../../src/db/booking-page";

const OWNER = "book-owner@org";

describe("validateSlug", () => {
  it("accepts lowercase alphanumeric with hyphens", () => {
    expect(() => validateSlug("victor-b2")).not.toThrow();
  });

  it("rejects uppercase, short, over-long, and reserved slugs", () => {
    for (const bad of ["Victor", "a", "x".repeat(32), "admin", "v1", "_static"]) {
      expect(() => validateSlug(bad), bad).toThrow(SlugError);
    }
  });
});

describe("loadBookingPage", () => {
  it("returns the __default__ defaults for an owner with no row", async () => {
    const cfg = await loadBookingPage(env.DB, "nobody@org");
    expect(cfg.enabled).toBe(false);
    expect(cfg.durations_minutes).toEqual([30, 60]);
    expect(cfg.slug).toBeNull();
  });

  it("returns the owner's row when present, slug included", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "owner-one", enabled: true, horizon_days: 7 });
    const cfg = await loadBookingPage(env.DB, OWNER);
    expect(cfg.slug).toBe("owner-one");
    expect(cfg.enabled).toBe(true);
    expect(cfg.horizon_days).toBe(7);
    // unspecified fields still fall back to the defaults row
    expect(cfg.min_notice_minutes).toBe(240);
  });

  it("reads max_horizon_days as null when never set — one page, the pre-paging reach", async () => {
    // No migration backfills this field: the '__default__' row seeded by 0030
    // predates it, and so does every owner's row. The shallow merge over the
    // hardcoded floor is what makes an absent field null rather than
    // undefined, and null is what pageWindow reads as "no further than
    // horizon_days".
    const cfg = await loadBookingPage(env.DB, "nobody@org");
    expect(cfg.max_horizon_days).toBeNull();
  });

  it("round-trips a stored max_horizon_days", async () => {
    await saveBookingPage(env.DB, OWNER, { slug: "owner-one", horizon_days: 7, max_horizon_days: 60 });
    const cfg = await loadBookingPage(env.DB, OWNER);
    expect(cfg.max_horizon_days).toBe(60);
  });
});

describe("normaliseLocation", () => {
  it("passes a current-shape value through unchanged", () => {
    const modes = [{ kind: "meet" as const }, { kind: "phone" as const }];
    expect(normaliseLocation({ modes })).toEqual({ modes });
  });

  it("maps a legacy single-mode value onto the array shape, dropping a stray detail", () => {
    // A legacy `phone` entry's detail was the OWNER's own number — it must not
    // survive onto a kind whose detail the booker supplies at claim time. It is
    // omitted entirely (not nulled), so there is one canonical shape for "no
    // detail" regardless of whether the row came in fresh or migrated.
    expect(normaliseLocation({ mode: "phone", detail: "+61 400 000 000" })).toEqual({
      modes: [{ kind: "phone" }],
    });
  });

  it("falls back to meet when a legacy custom has no detail", () => {
    // Otherwise the page would offer nothing and be unbookable.
    expect(normaliseLocation({ mode: "custom", detail: null })).toEqual({
      modes: [{ kind: "meet" }],
    });
  });

  it("drops a stray detail on a non-owning kind in the array shape too", () => {
    // Same rule applies uniformly, not just to the legacy branch: a hand-edited
    // or otherwise malformed stored array must not leak an owner detail either.
    expect(normaliseLocation({ modes: [{ kind: "in_person", detail: "owner's home address" }] })).toEqual({
      modes: [{ kind: "in_person" }],
    });
  });

  it("treats a genuine single meet-mode array as authoritative, not a fallback", () => {
    // Distinguishes "the owner really only offers Meet" from "nothing stored
    // was usable, so we fell back" — a mutant that dropped the array-branch
    // entirely would otherwise still happen to return the same shape here.
    expect(normaliseLocation({ modes: [{ kind: "meet" }] })).toEqual({ modes: [{ kind: "meet" }] });
  });

  it("drops non-object entries in a stored array instead of crashing", () => {
    expect(normaliseLocation({ modes: [null, "nope", { kind: "meet" }] })).toEqual({
      modes: [{ kind: "meet" }],
    });
  });

  it("drops a non-string detail instead of crashing on offerableModes' .trim()", () => {
    // offerableModes does `(m.detail ?? "").trim()` for a `custom` entry; a
    // stored detail that isn't a string (or null) would throw there, and
    // loadBookingPage calls this on every read, so a malformed row would 500
    // the whole booking page. Both branches must guard the type, not just kind.
    expect(normaliseLocation({ modes: [{ kind: "custom", detail: 123 }] })).toEqual({
      modes: [{ kind: "meet" }],
    });
    expect(normaliseLocation({ mode: "custom", detail: 123 })).toEqual({
      modes: [{ kind: "meet" }],
    });
  });

  it("falls back rather than crashing when modes is present but not an array", () => {
    expect(normaliseLocation({ modes: "nope" })).toEqual({ modes: [{ kind: "meet" }] });
  });

  it("falls back to meet on a missing or unusable value", () => {
    expect(normaliseLocation(undefined)).toEqual({ modes: [{ kind: "meet" }] });
    expect(normaliseLocation({ modes: [] })).toEqual({ modes: [{ kind: "meet" }] });
    expect(normaliseLocation({ mode: "nonsense" })).toEqual({ modes: [{ kind: "meet" }] });
  });
});

describe("findOwnerBySlug", () => {
  it("resolves an owner and ignores the defaults row", async () => {
    await saveBookingPage(env.DB, "slug-owner@org", { slug: "findme", enabled: true });
    expect(await findOwnerBySlug(env.DB, "findme")).toBe("slug-owner@org");
    expect(await findOwnerBySlug(env.DB, "nosuch")).toBeNull();
  });

  it("rejects a slug already taken by another owner", async () => {
    await saveBookingPage(env.DB, "first@org", { slug: "shared", enabled: true });
    await expect(saveBookingPage(env.DB, "second@org", { slug: "shared" })).rejects.toThrow(SlugError);
  });

  it("translates a slug-uniqueness race into SlugError, not a raw D1 error", async () => {
    // The pre-check SELECT and the upsert are two separate statements, so two
    // owners can both pass the pre-check for the same free slug before either
    // writes. Reproduce that interleaving deterministically: let owner
    // "racer-b"'s pre-check see no clash, then land owner "racer-a"'s row for
    // the same slug before "racer-b"'s own upsert runs — so "racer-b"'s INSERT
    // hits the real config_booking_page_slug UNIQUE index.
    const racingDb: D1Database = {
      ...env.DB,
      prepare: (sql: string) => {
        const stmt = env.DB.prepare(sql);
        if (sql.includes("SELECT owner_subject FROM config_booking_page WHERE slug")) {
          return {
            ...stmt,
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                ...bound,
                first: async <T>() => {
                  const result = await bound.first<T>();
                  await saveBookingPage(env.DB, "racer-a@org", { slug: "race", enabled: true });
                  return result;
                },
              } as D1PreparedStatement;
            },
          } as D1PreparedStatement;
        }
        return stmt;
      },
    } as D1Database;

    await expect(saveBookingPage(racingDb, "racer-b@org", { slug: "race" })).rejects.toThrow(SlugError);
  });
});
