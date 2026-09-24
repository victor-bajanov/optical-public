import { describe, it, expect } from "vitest";
import {
  renderPollPage,
  renderPollExpiredPage,
  renderPollJoinFormPage,
  renderPollJoinSentPage,
  renderPollJoinErrorPage,
  POLL_PAGE_CSP,
  POLL_JOIN_PAGE_CSP,
} from "../../src/polls/page";
import { POLL_CLIENT_HASH } from "../../src/polls/poll-client-source.generated";

const CLIENT_SRC = `/poll/_static/poll.${POLL_CLIENT_HASH}.js`;

function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

describe("renderPollPage", () => {
  const opts = { pollId: "p_abc123", token: "tok.sig", cellMinutes: 30 };

  it("bootstraps via data-* attributes on #app, not an inline script", () => {
    // Fix 1: script-src 'self' has no 'unsafe-inline' and no nonce, so an
    // inline <script> here would simply never execute in a real browser —
    // the bootstrap must travel as attributes T6's client reads from
    // root.dataset instead. Matches booking/page.ts's own dataset pattern.
    const html = renderPollPage(opts);
    expect(html).toContain('data-poll-id="p_abc123"');
    expect(html).toContain('data-token="tok.sig"');
    expect(html).toContain('data-cell-minutes="30"');
  });

  it("emits no inline (non-src) <script> element", () => {
    // The regex matches any <script tag NOT immediately followed by a src=
    // attribute — i.e. an inline script, which the CSP would silently drop.
    const html = renderPollPage(opts);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it("points the module script tag at the content-hashed client asset", () => {
    const html = renderPollPage(opts);
    expect(html).toContain(`<script type="module" src="${CLIENT_SRC}"></script>`);
  });

  it("renders the structural ids poll.client.js's mount() looks for", () => {
    const html = renderPollPage(opts);
    for (const id of ["app", "app-body", "status", "responseform", "name", "hideName", "ics-upload"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-tool="free"');
    expect(html).toContain('data-tool="if_needed"');
    expect(html).toContain('data-action="clear"');
  });

  it("scopes the hide-name promise to this poll's other voters, not the calendar invite", () => {
    // Fix 8: the booked event carries every invitee as an attendee, hidden
    // ones included, so their email is visible to the others in the Google
    // invite. The old "other attendees" wording overpromised.
    const html = renderPollPage(opts);
    expect(html).toContain("Hide my name from other people voting on this poll");
    expect(html).not.toContain("Hide my name from other attendees");
  });

  it("marks paintable cells touch-action:none so drag-painting isn't claimed by scroll", () => {
    const html = renderPollPage(opts);
    expect(html).toMatch(/\[data-cell\]\{[^}]*touch-action:none/);
  });

  it("gives #status aria-live=polite so save/error feedback is announced to assistive tech (save-feedback review)", () => {
    const html = renderPollPage(opts);
    expect(html).toMatch(/id="status"[^>]*aria-live="polite"/);
  });

  it("styles a disabled submit button distinctly (save-feedback review MINOR)", () => {
    // T6's client disables #submit-btn (class="go") while a PUT is in
    // flight — without a :disabled rule here that state is invisible.
    const html = renderPollPage(opts);
    expect(html).toMatch(/button\.go:disabled\{/);
  });

  it("wraps the tool buttons in .tools, so [aria-pressed=true] styling actually applies", () => {
    const html = renderPollPage(opts);
    const toolsBlock = html.match(/<div class="tools">.*?<\/div>/s)?.[0] ?? "";
    expect(toolsBlock).toContain('data-tool="free"');
    expect(toolsBlock).toContain('data-tool="if_needed"');
  });

  describe("grid markup poll.client.js's renderGrid() builds (final-review FIX-1)", () => {
    // renderGrid (poll.client.js ~916-935) stamps .daynav / .cells containers
    // and, per cell button, `heat-0`..`heat-4` always plus `free`/`if_needed`
    // when painted — none of which page.ts's STYLE defined, so painting and
    // the heatmap produced zero visible change.
    it("styles the week grid renderGrid() now builds — weeknav/weekgrid/weekcol/colh/none", () => {
      // T6b replaced the single-day strip with a full week grid; the old
      // .daynav/.cells selectors no longer match anything renderGrid emits
      // and are dropped in the same pass. The client sets its own layout
      // mechanics (display:grid/flex) inline via style="" — see poll.client.js's
      // renderGrid — so this stylesheet supplies the visual polish layer
      // (colour, spacing, typography) on top, same idiom as .tools/.daynav's
      // button styling before it.
      const html = renderPollPage(opts);
      expect(html).toMatch(/\.weeknav\{/);
      expect(html).toMatch(/\.weeknav button\{/);
      expect(html).toMatch(/\.weekgrid\{/);
      expect(html).toMatch(/\.weekcol\{/);
      expect(html).toMatch(/\.colh\{/);
      expect(html).toMatch(/\.none\{/);
      expect(html).not.toMatch(/\.daynav\{/);
      expect(html).not.toMatch(/\.cells\{/);
    });

    it("gives painted cells distinct, visible free vs if_needed styling", () => {
      const html = renderPollPage(opts);
      // free: solid fill. if_needed: a hatched/lighter pattern, not a flat
      // fill — distinguishable from free at a glance, per the card's idiom
      // ("lighter/hatched" vs free's solid), mirroring booking's clash/
      // selected dashed-vs-solid distinction.
      expect(html).toMatch(/\[data-cell\]\.free\{[^}]*background:[^;]+;/);
      expect(html).toMatch(/\[data-cell\]\.if_needed\{[^}]*(repeating-linear-gradient|dashed)/);
      const freeRule = html.match(/\[data-cell\]\.free\{[^}]*\}/)?.[0];
      const ifNeededRule = html.match(/\[data-cell\]\.if_needed\{[^}]*\}/)?.[0];
      expect(freeRule).toBeTruthy();
      expect(ifNeededRule).toBeTruthy();
      expect(freeRule).not.toBe(ifNeededRule);
    });

    it("defines background shading from heat-0 (none) through heat-4 (strongest)", () => {
      const html = renderPollPage(opts);
      for (let i = 0; i <= 4; i++) {
        expect(html).toMatch(new RegExp(`\\.heat-${i}\\{`));
      }
    });

    it("keeps heat legible on a painted cell instead of letting the fill hide it entirely", () => {
      // The client adds heat-N to EVERY cell, painted or not (renderGrid:
      // `btn.classList.add(paintState)` then unconditionally
      // `btn.classList.add(\`heat-${heat}\`)`), so a rule that only ever
      // shows on unpainted cells would silently drop the aggregate signal
      // the moment an invitee paints. There must be a rule whose selector
      // combines a paint class with a heat class — however the shading is
      // layered (background, box-shadow, border) — so painted+hot reads
      // differently from painted+cold.
      const html = renderPollPage(opts);
      expect(html).toMatch(/\[data-cell\]\.(free|if_needed)\.heat-[1-4][^{,]*\{/);
    });
  });

  it("escapes a hostile poll id so it cannot break out of the attribute", () => {
    const hostile = { pollId: '"><script>alert(1)</script>', token: "t", cellMinutes: 30 };
    const html = renderPollPage(hostile);
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a hostile token the same way", () => {
    const hostile = { pollId: "p_1", token: '"></script><img src=x onerror=alert(1)>//', cellMinutes: 30 };
    const html = renderPollPage(hostile);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("</script><img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("renderPollExpiredPage", () => {
  it("is static — carries no data at all, so there is nothing to leak", () => {
    const html = renderPollExpiredPage();
    expect(html).toContain("expired");
    expect(html).not.toContain("__POLL__");
    expect(html).not.toContain("<script");
  });
});

describe("renderPollJoinFormPage", () => {
  const opts = { pollId: "p_abc123", guestToken: "guest.tok", siteKey: "1x00000000000000000000AA" };

  it("posts to this poll's join endpoint", () => {
    const html = renderPollJoinFormPage(opts);
    expect(html).toContain(`<form method="post" action="/poll/${opts.pollId}/join"`);
  });

  it("carries the guest token as a hidden field, never in a URL", () => {
    const html = renderPollJoinFormPage(opts);
    expect(html).toContain(`<input type="hidden" name="guestToken" value="${opts.guestToken}"`);
  });

  it("renders name and email fields", () => {
    const html = renderPollJoinFormPage(opts);
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
  });

  it("renders the Turnstile widget in implicit mode — no custom script required", () => {
    // Implicit rendering (a plain `cf-turnstile` div + the external api.js
    // script) needs zero first-party JavaScript: Cloudflare's script finds
    // the div itself and, on solve, writes a `cf-turnstile-response` hidden
    // input into the enclosing <form> — which a plain HTML form submission
    // then carries automatically. No inline script, no module.
    const html = renderPollJoinFormPage(opts);
    expect(html).toContain(`class="cf-turnstile" data-sitekey="${opts.siteKey}"`);
    expect(html).toContain('src="https://challenges.cloudflare.com/turnstile/v0/api.js"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it("escapes a hostile guest token so it cannot break out of the attribute", () => {
    const hostile = { ...opts, guestToken: '"><script>alert(1)</script>' };
    const html = renderPollJoinFormPage(hostile);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("renderPollJoinSentPage", () => {
  it("is static and identical regardless of new-vs-already-invited — no data to leak", () => {
    const html = renderPollJoinSentPage();
    expect(html).not.toContain("__POLL__");
    expect(html).not.toContain("<script");
    expect(html.toLowerCase()).toContain("email");
  });
});

describe("renderPollJoinErrorPage", () => {
  it("escapes its heading and message", () => {
    const html = renderPollJoinErrorPage("<b>Oops</b>", "bad & stuff");
    expect(html).not.toContain("<b>Oops</b>");
    expect(html).toContain("&lt;b&gt;Oops&lt;/b&gt;");
    expect(html).toContain("bad &amp; stuff");
  });
});

describe("POLL_JOIN_PAGE_CSP", () => {
  const d = directives(POLL_JOIN_PAGE_CSP);

  it("denies everything not named", () => {
    expect(d.get("default-src")).toEqual(["'none'"]);
  });

  it("allows the Turnstile script and iframe, and nothing else, as script-src", () => {
    expect(d.get("script-src")).toEqual(["https://challenges.cloudflare.com"]);
  });

  it("allows the Turnstile iframe", () => {
    expect(d.get("frame-src")).toContain("https://challenges.cloudflare.com");
  });

  it("permits a real (non-fetch) form POST — the whole point of this page", () => {
    expect(d.get("form-action")).toEqual(["'self'"]);
  });

  it("refuses to be framed", () => {
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });
});

describe("POLL_PAGE_CSP", () => {
  const d = directives(POLL_PAGE_CSP);

  it("denies everything not named", () => {
    expect(d.get("default-src")).toEqual(["'none'"]);
  });

  it("allows only the page's own module", () => {
    expect(d.get("script-src")).toEqual(["'self'"]);
  });

  it("allows inline styles for the <style> block", () => {
    expect(d.get("style-src")).toContain("'unsafe-inline'");
  });

  it("allows same-origin fetches for the grid/response endpoints", () => {
    expect(d.get("connect-src")).toContain("'self'");
  });

  it("refuses to be framed", () => {
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("pins the document base and blocks non-script form posts", () => {
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'none'"]);
  });
});
