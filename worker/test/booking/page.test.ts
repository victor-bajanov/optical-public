import { describe, it, expect } from "vitest";
import { renderBookingPage, BOOKING_PAGE_CSP } from "../../src/booking/page";
import { TURNSTILE_READY_CALLBACK } from "../../src/booking/booking.client.js";
import { BOOKING_CLIENT_HASH } from "../../src/booking/booking-client-source.generated";

// The client asset is served under a content-hashed filename so it can be
// cached immutably; these assertions follow the hash rather than pinning a
// literal that changes with every edit to booking.client.js.
const CLIENT_SRC = `/book/_static/booking.${BOOKING_CLIENT_HASH}.js`;

const opts = {
  slug: "victor",
  durations: [30, 60],
  siteKey: "site-key-1",
  modes: [{ kind: "meet" as const }],
};

/** The policy as a directive → source-list map, so the assertions below read
 *  the real thing rather than matching substrings of one long header. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

describe("renderBookingPage", () => {
  it("embeds the slug, durations and Turnstile site key", () => {
    const html = renderBookingPage(opts);
    expect(html).toContain("site-key-1");
    expect(html).toContain('data-slug="victor"');
    expect(html).toContain(CLIENT_SRC);
    expect(html).toContain("challenges.cloudflare.com");
  });

  it("renders one duration chip per offered duration", () => {
    const html = renderBookingPage(opts);
    expect(html).toContain("30 min");
    expect(html).toContain("60 min");
  });

  it("hides the duration chooser when only one duration is offered", () => {
    expect(renderBookingPage({ ...opts, durations: [30] })).not.toContain('class="chips"');
  });

  it("escapes a hostile slug rather than injecting markup", () => {
    const html = renderBookingPage({ ...opts, slug: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the timezone switcher", () => {
    expect(renderBookingPage(opts)).toContain('id="tzsel"');
  });

  // The client renders one day's slots at a time and #strip is the only day
  // picker, so hiding the strip outside the mobile breakpoint would strand a
  // desktop booker on the first available day with no way to reach the rest.
  it("shows the day strip at every width, not just on mobile", () => {
    const html = renderBookingPage(opts);
    expect(html).toContain('<div class="strip" id="strip">');
    expect(html).not.toContain(".strip{display:none");
  });

  // The client groups the strip by month (stripMonths) and heads each group
  // with a label. A label that scrolled away with its first day would leave a
  // booker deep in a 365-day reach staring at "1 2 5 6" with no month, so it
  // must be pinned to the strip's left edge while its month is in view.
  it("pins each month label to the strip while its month is scrolled through", () => {
    const html = renderBookingPage(opts);
    expect(html).toMatch(/\.mlabel\{[^}]*position:sticky;left:/);
  });

  // The challenge script is `async defer`, so it can execute after the module
  // that wants to use it. Explicit rendering plus the onload callback is how
  // the client is told the API has arrived; without it a booker on a slow
  // connection gets no widget and a bare 403.
  it("asks Turnstile to call back when its API is ready", () => {
    const html = renderBookingPage(opts);
    expect(html).toContain(`onload=${TURNSTILE_READY_CALLBACK}`);
    expect(html).toContain("render=explicit");
  });

  it("runs the module before the challenge script, and defers both", () => {
    // `type="module"` and `defer` share one deferred queue, executed in
    // document order — which is the only thing that guarantees the callback is
    // registered before api.js looks for it. With `async` on the challenge tag
    // the browser usually won that race and Turnstile logged "Unable to find
    // onload callback" twice per load before giving up.
    const html = renderBookingPage(opts);
    const module = html.indexOf(`<script type="module" src="${CLIENT_SRC}">`);
    const challenge = html.indexOf("challenges.cloudflare.com/turnstile");
    expect(module).toBeGreaterThan(-1);
    expect(module).toBeLessThan(challenge);
    // Both in the head, or the ordering guarantee does not hold.
    expect(challenge).toBeLessThan(html.indexOf("</head>"));
    expect(html).not.toContain("api.js?onload=opticalTurnstileReady&amp;render=explicit\" async");
  });
});

describe("the location picker", () => {
  it("renders a radio per offered mode, in the owner's order", () => {
    const html = renderBookingPage({ ...opts, modes: [{ kind: "phone" }, { kind: "meet" }] });
    expect(html).toContain('value="phone"');
    expect(html).toContain('value="meet"');
    expect(html.indexOf('value="phone"')).toBeLessThan(html.indexOf('value="meet"'));
  });

  it("renders no radio when a single mode is offered", () => {
    const html = renderBookingPage({ ...opts, modes: [{ kind: "phone" }] });
    expect(html).not.toContain('type="radio"');
    expect(html).toContain("Phone call");
  });

  // The client reads this marker to learn which kind a one-option form means;
  // without it a single-mode page posts the "meet" fallback instead.
  it("marks a single offered mode so the client knows which kind it is", () => {
    expect(renderBookingPage({ ...opts, modes: [{ kind: "in_person" }] })).toContain(
      'data-single="in_person"',
    );
  });

  // The client clones #loctpl's innerHTML into the confirm form it builds, so
  // the picker has to be inside a <template> and carry the classes that module
  // queries for.
  it("puts the picker in the template the client clones", () => {
    const html = renderBookingPage({ ...opts, modes: [{ kind: "phone" }, { kind: "meet" }] });
    expect(html).toContain('<template id="loctpl">');
    expect(html).toContain('class="locpick"');
    expect(html).toContain('name="location_kind"');
  });

  it("escapes owner-supplied custom text", () => {
    const html = renderBookingPage({
      ...opts,
      modes: [{ kind: "custom", detail: '<img src=x onerror="alert(1)">' }],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("no longer emits the dead data-location attribute", () => {
    expect(renderBookingPage({ ...opts, modes: [{ kind: "meet" }] })).not.toContain("data-location");
  });
});

describe("BOOKING_PAGE_CSP", () => {
  // This is an unauthenticated public form whose success sends a calendar
  // invitation from the owner's account. The policy is defence in depth (every
  // interpolation is already escaped) — but it must not break the page, so
  // each assertion below names the thing in the markup it keeps working.
  const d = directives(BOOKING_PAGE_CSP);

  it("denies everything not named", () => {
    expect(d.get("default-src")).toEqual(["'none'"]);
  });

  it("allows the page's own module and the Turnstile script it loads", () => {
    const html = renderBookingPage(opts);
    expect(html).toContain(`src="${CLIENT_SRC}"`); // same-origin → 'self'
    expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    const scriptSrc = d.get("script-src") ?? [];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("https://challenges.cloudflare.com");
  });

  it("allows the challenge's iframe", () => {
    expect(d.get("frame-src")).toContain("https://challenges.cloudflare.com");
  });

  it("allows inline styles, which the page and the client both rely on", () => {
    // Two of them: the <style> element in the shell, and the style="" grid
    // placement attributes the client writes on every slot cell. A nonce
    // cannot cover the second — under CSP3 adding one would DISABLE
    // 'unsafe-inline' and collapse the week grid — so 'unsafe-inline' stands
    // alone here.
    expect(renderBookingPage(opts)).toContain("<style>");
    expect(d.get("style-src")).toContain("'unsafe-inline'");
    expect(d.get("style-src")).not.toContain("'nonce'");
  });

  it("allows the same-origin fetches the client makes", () => {
    // GET /book/<slug>/slots and POST /book/<slug>.
    expect(d.get("connect-src")).toContain("'self'");
  });

  it("refuses to be framed", () => {
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("pins the document base and blocks non-script form posts", () => {
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'none'"]);
  });

  it("names no source the page does not actually use", () => {
    // A policy nobody can check drifts. Every host in it must appear in the
    // markup it protects.
    const html = renderBookingPage(opts);
    for (const sources of d.values()) {
      for (const s of sources) {
        if (!s.startsWith("http")) continue;
        expect([s, html.includes(s)]).toEqual([s, true]);
      }
    }
  });
});
