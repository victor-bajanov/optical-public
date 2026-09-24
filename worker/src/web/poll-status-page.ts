// Organiser-facing, read-only meeting-poll status page (wave-3 T11 card /
// original T11 spec). Pure render only — same split as web/accept-page.ts
// vs planning/accept.ts: auth, ownership checks, and data assembly (roster,
// aggregate, live candidate ranking) live in polls/route.ts, which is the
// only caller. This file never touches the DB or the calendar.
//
// Guardrails (card, non-negotiable): read-only — zero mutations, no <form>,
// no client JS. Every dynamic value is escaped for its context. The
// nudge/cancel/resolve actions are plain-text pointers to their /v1 API
// operations, not forms — the actions themselves stay MCP/API ops in v1.

import { escText, escAttr } from "../util/html-escape";
import type { PollStatus } from "../db/polls";

const STYLE = `
:root{--fg:#1f2328;--muted:#6b7480;--line:#d8dde3;--accent:#c9a227;--pane:#fff;--bg:#eef1f5;--free:#2e7d32;--if-needed:#8f6b00}
*{box-sizing:border-box}
body{font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px}
.pane{max-width:1080px;margin:0 auto;background:var(--pane);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.head{padding:16px 20px;border-bottom:1px solid #eceff2}
h1{font-size:18px;margin:0}
h2{font-size:14px;margin:22px 0 8px}
.muted{color:var(--muted);font-size:12px;margin:2px 0 0}
.body{padding:16px 20px}
.banner{display:inline-block;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;margin-top:6px}
.banner-open{background:#e6f4ea;color:#1e7d32}
.banner-booked{background:#e8f0fe;color:#174ea6}
.banner-cancelled{background:#f1f3f4;color:#5f6368}
.banner-needs_attention{background:#fce8e6;color:#a50e0e}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:6px}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;white-space:nowrap}
th{background:#f6f8fa;font-weight:600}
.overflow{overflow-x:auto}
.tick{color:var(--free);font-weight:700}
.cross{color:var(--muted)}
ol{margin:6px 0;padding-left:22px}
.score{font-weight:700}
.weights{color:var(--muted);font-size:11.5px}
.actions{font-size:12.5px;line-height:1.7}
code{background:#f6f8fa;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:11.5px}
table.agg td.av-cell{text-align:center;padding:3px 4px;width:1%}
table.agg th.date{text-align:center}
table.agg th.time{text-align:center;padding:3px 4px}
.av{font-weight:700}
.av-free{color:var(--free)}
.av-ifneeded{color:var(--if-needed)}
.legend{color:var(--muted);font-size:11.5px;margin:4px 0 0}
@media(max-width:720px){body{padding:12px}}
`;

const HEAD = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex">` +
  `<title>${escText(title)}</title><style>${STYLE}</style>`;

const STATE_LABEL: Record<PollStatus, string> = {
  open: "Open",
  booked: "Booked",
  cancelled: "Cancelled",
  needs_attention: "Needs attention",
};

export interface RosterEntry {
  email: string;
  /** Real name if known, else the pseudonym — organiser sees everything, so
   *  this is never itself the pseudonym-for-hiding substitution the public
   *  grid payload uses. */
  displayName: string;
  /** Present (non-null) only when `hideName` is true — the organiser gets
   *  BOTH the real name above and this, since the pseudonym is what this
   *  invitee's peers see on the poll page and the status roster is meant to
   *  let the organiser cross-reference the two. */
  pseudonymIfHidden: string | null;
  responded: boolean;
  dropped: boolean;
}

export interface AggregateRow {
  displayName: string;
  /** cellStartUtc -> state, only for cells this invitee actually painted;
   *  absent means blank in the table. */
  statesByCell: Record<string, "free" | "if_needed" | undefined>;
}

export interface CandidateWeight {
  label: string;
  weight: number;
}

export interface CandidateRow {
  slotStartUtc: string;
  score: number;
  organiserFit: number;
  weights: CandidateWeight[];
}

export interface PollStatusPageOptions {
  poll: {
    id: string;
    title: string;
    status: PollStatus;
    durationMin: number;
    rangeStart: string;
    rangeEnd: string;
    deadlineUtc: string;
    bookedSlotUtc: string | null;
  };
  ownerTz: string;
  roster: RosterEntry[];
  /** Cells with at least one response, sorted ascending — the aggregate
   *  table's columns. Empty when nobody has responded yet. */
  cells: string[];
  aggregate: AggregateRow[];
  /** Already capped to the top N by the caller (route.ts) — this file never
   *  slices. Empty for a non-open poll (no live ranking is computed). */
  candidates: CandidateRow[];
}

/** "YYYY-MM-DD HH:MM" in the organiser's home zone — the header line has
 *  always declared "times shown in <ownerTz>", so every timestamp on the
 *  page must actually honour it. Falls back to an explicitly-suffixed UTC
 *  rendering only if `tz` is not a zone the runtime knows (then the caption
 *  would be wrong without the suffix). */
function formatInTz(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  try {
    // en-CA yields "YYYY-MM-DD, HH:MM" with these options.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(ms)
      .replace(", ", " ");
  } catch {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

function rosterRow(r: RosterEntry): string {
  const name = escText(r.displayName) + (r.pseudonymIfHidden ? ` (${escText(r.pseudonymIfHidden)})` : "");
  const responded = r.responded ? `<span class="tick">&#10003;</span>` : `<span class="cross">&mdash;</span>`;
  const status = r.dropped ? "dropped" : r.responded ? "responded" : "waiting";
  return `<tr><td>${name}</td><td>${escText(r.email)}</td><td>${responded} ${escText(status)}</td></tr>`;
}

// Icons are static markup only — never interpolated from user/DB data — so
// there is nothing here for escText/escAttr to guard. Two variants per
// state: the labelled one used inside the table needs role="img" for its
// aria-label to actually be honoured (a bare <span> has no implicit ARIA
// role, so screen readers otherwise ignore the name); the legend's copies
// are decorative (aria-hidden, no aria-label) so they don't double-announce
// alongside the table's labelled icons ("Free free").
const FREE_ICON = `<span class="av av-free" role="img" title="Free" aria-label="Free">&#10003;</span>`;
const IF_NEEDED_ICON = `<span class="av av-ifneeded" role="img" title="If needed" aria-label="If needed">&#9681;</span>`;
const FREE_ICON_DECORATIVE = `<span class="av av-free" aria-hidden="true" title="Free">&#10003;</span>`;
const IF_NEEDED_ICON_DECORATIVE = `<span class="av av-ifneeded" aria-hidden="true" title="If needed">&#9681;</span>`;

/** Splits a cell's timestamp into its organiser-local date and time parts
 *  by slicing the exact `formatInTz` rendering (so the two never disagree)
 *  — never hand-parsed separately. Falls back to treating an unparseable
 *  cell as its own singleton group, keyed by the raw string, matching
 *  `formatInTz`'s own fallback of returning the input unchanged. */
function dateAndTime(c: string, tz: string): { date: string; time: string } {
  const formatted = formatInTz(c, tz); // "YYYY-MM-DD HH:MM", or `c` back unchanged if unparseable
  if (formatted === c) return { date: c, time: c };
  return { date: formatted.slice(0, 10), time: formatted.slice(11, 16) };
}

/** Groups cells (already sorted ascending by the caller) into runs sharing
 *  the same organiser-local date, for the two-tier header's colspanned date
 *  row. Local-date runs stay contiguous because a fixed-zone local ordering
 *  is monotonic in UTC ordering. */
function groupCellsByDate(cells: string[], tz: string): Array<{ date: string; times: string[] }> {
  const groups: Array<{ date: string; times: string[] }> = [];
  for (const c of cells) {
    const { date, time } = dateAndTime(c, tz);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.times.push(time);
    else groups.push({ date, times: [time] });
  }
  return groups;
}

function aggregateTable(cells: string[], rows: AggregateRow[], tz: string): string {
  if (cells.length === 0 || rows.length === 0) {
    return `<p class="muted">No responses yet.</p>`;
  }
  // Two-tier header: a colspanned local-date row above per-cell time-only
  // headers. The old single-row header repeated the full "YYYY-MM-DD HH:MM
  // UTC" string (with white-space:nowrap) in every column, which pinned
  // each column's width regardless of how narrow the icon cells below it
  // were — this is what actually narrows the table.
  const groups = groupCellsByDate(cells, tz);
  const dateHeader = groups
    .map((g) => `<th class="date" colspan="${g.times.length}">${escText(g.date)}</th>`)
    .join("");
  const timeHeader = groups
    .flatMap((g) => g.times)
    .map((t) => `<th class="time">${escText(t)}</th>`)
    .join("");
  const header = `<tr><th rowspan="2">Invitee</th>${dateHeader}</tr><tr>${timeHeader}</tr>`;
  const body = rows
    .map((r) => {
      const tds = cells
        .map((c) => {
          const state = r.statesByCell[c];
          const icon = state === "free" ? FREE_ICON : state === "if_needed" ? IF_NEEDED_ICON : "";
          return `<td class="av-cell">${icon}</td>`;
        })
        .join("");
      return `<tr><td>${escText(r.displayName)}</td>${tds}</tr>`;
    })
    .join("");
  const legend = `<p class="legend">${FREE_ICON_DECORATIVE} free &middot; ${IF_NEEDED_ICON_DECORATIVE} if needed</p>`;
  return `<div class="overflow"><table class="agg">${header}${body}</table></div>${legend}`;
}

function candidatesList(candidates: CandidateRow[], tz: string): string {
  if (candidates.length === 0) {
    return `<p class="muted">No candidate times yet.</p>`;
  }
  const items = candidates
    .map((c) => {
      const weights = c.weights
        .map((w) => `${escText(w.label)}: ${w.weight.toFixed(2)}`)
        .join(", ");
      return (
        `<li>${escText(formatInTz(c.slotStartUtc, tz))} &mdash; ` +
        `<span class="score">score ${c.score.toFixed(1)}</span> ` +
        `(organiser fit ${c.organiserFit.toFixed(1)})` +
        (weights ? `<div class="weights">${weights}</div>` : "")
        + `</li>`
      );
    })
    .join("");
  return `<ol>${items}</ol>`;
}

/** The organiser status page (authenticated `GET /poll/:id/status`,
 *  route.ts's binding contract with `handlers/polls.ts`'s `statusUrl`).
 *  Read-only: roster, full-detail aggregate, top candidates, state banner,
 *  and plain-text API pointers — never a mutating form. */
export function renderPollStatusPage(o: PollStatusPageOptions): string {
  const bannerClass = `banner banner-${o.poll.status}`;
  const bookedLine = o.poll.bookedSlotUtc
    ? `<p class="muted">Booked for ${escText(formatInTz(o.poll.bookedSlotUtc, o.ownerTz))}</p>`
    : "";
  return (
    HEAD(`${o.poll.title} — poll status`) +
    `</head><body><div class="pane" data-poll-id="${escAttr(o.poll.id)}">` +
    `<div class="head">` +
    `<h1>${escText(o.poll.title)}</h1>` +
    `<p class="muted">${o.poll.durationMin} min &middot; ${escText(o.poll.rangeStart)} to ${escText(o.poll.rangeEnd)} ` +
    `&middot; responses close ${escText(formatInTz(o.poll.deadlineUtc, o.ownerTz))} &middot; times shown in ${escText(o.ownerTz)}</p>` +
    `<span class="${escAttr(bannerClass)}">${escText(STATE_LABEL[o.poll.status])}</span>` +
    bookedLine +
    `</div>` +
    `<div class="body">` +
    `<h2>Roster</h2>` +
    `<div class="overflow"><table><tr><th>Name</th><th>Email</th><th>Status</th></tr>` +
    o.roster.map(rosterRow).join("") +
    `</table></div>` +
    `<h2>Aggregate</h2>` +
    aggregateTable(o.cells, o.aggregate, o.ownerTz) +
    `<h2>Top candidate times</h2>` +
    candidatesList(o.candidates, o.ownerTz) +
    `<h2>Actions</h2>` +
    `<p class="actions">This page is read-only. Manage this poll via the API:<br>` +
    `Nudge (open polls only): <code>POST /v1/polls/${escText(o.poll.id)}/nudge</code><br>` +
    `Cancel: <code>POST /v1/polls/${escText(o.poll.id)}/cancel</code><br>` +
    `Resolve (needs-attention polls): <code>POST /v1/polls/${escText(o.poll.id)}/resolve</code></p>` +
    `</div>` +
    `</div></body></html>`
  );
}
