import type { ReplanEmailModel, DayView, TimelineEntry, EntryRole } from "./email-model";
import { formatLocalTime, formatLocalDate } from "./format-local";
import { escText as esc } from "../util/html-escape";

// Inline-styled card per role (Gmail-safe: no <style>, no positioning).
function card(entry: TimelineEntry, tz: string): string {
  const time = `${formatLocalTime(entry.start, tz)} – ${formatLocalTime(entry.end, tz)}`;
  const styles: Record<EntryRole, { bar: string; bg: string; title: string; sub: string; strike?: boolean; faded?: boolean }> = {
    "new-clash": { bar: "#c5221f", bg: "#fce8e6", title: "#202124", sub: "#5f6368" },
    "moved-to":  { bar: "#1a73e8", bg: "#e8f0fe", title: "#202124", sub: "#1a73e8" },
    "added":     { bar: "#1a73e8", bg: "#e8f0fe", title: "#202124", sub: "#1a73e8" },
    "moved-from":{ bar: "#9aa0a6", bg: "#f1f3f4", title: "#5f6368", sub: "#c5221f", strike: true, faded: true },
    "removed":   { bar: "#9aa0a6", bg: "#f1f3f4", title: "#5f6368", sub: "#c5221f", strike: true, faded: true },
    "existing":  { bar: "#9aa0a6", bg: "#f8f9fa", title: "#3c4043", sub: "#80868b" },
  };
  const s = styles[entry.role];
  const sub = entry.role === "moved-to" && entry.movedFrom
    ? `${time} · moved from ${formatLocalTime(entry.movedFrom, tz)}`
    : entry.role === "new-clash" ? `${time} · new`
    : entry.role === "moved-from" || entry.role === "removed" ? `${time} · was here`
    : time;
  const titleDeco = s.strike ? "text-decoration:line-through;" : "";
  const op = s.faded ? "opacity:.7;" : "";
  // Owned meetings render distinctly: a "Meeting" chip on the title and, on the
  // proposed (moved-to / added) side, an attendee-notification note so the user
  // knows accepting will reschedule attendees. The numeric attendee count is not
  // available in the email-build inputs (it lives in the solver problem, not the
  // resolve body) — see report; deferred deliberately.
  const meetingChip = entry.isMeeting
    ? ` <span style="font-size:10px;font-weight:600;color:#8430ce;background:#f3e8fd;border-radius:3px;padding:1px 5px;vertical-align:middle">Meeting</span>`
    : "";
  const notify = entry.isMeeting && (entry.role === "moved-to" || entry.role === "added")
    ? `<div style="font-size:11px;color:#8430ce;margin-top:2px">Attendees will be notified when you accept</div>`
    : "";
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px"><tr>` +
    `<td style="border-left:3px solid ${s.bar};background:${s.bg};border-radius:5px;padding:6px 10px;${op}">` +
    `<div style="font-size:13px;color:${s.title};font-weight:600;${titleDeco}">${esc(entry.title)}${meetingChip}</div>` +
    `<div style="font-size:11px;color:${s.sub}">${esc(sub)}</div>` +
    notify +
    `</td></tr></table>`
  );
}

// body.warnings carries machine-readable codes (meeting-smoke + runbook assert
// them); user-facing prose is a render-time concern only, so previously
// persisted render_snapshots pick up the copy fix automatically.
const WARNING_HUMANIZERS: Record<string, (summary: string) => string> = {
  attendee_availability_unknown: (s) =>
    `We couldn't check everyone's availability for “${s}”, so it stays at its current time.`,
};
// The tail-code match below runs first, so prose following a PREFIX_CODES
// entry must never itself end in a bare `: <snake_case>` tail.
const PREFIX_CODES = ["must_include_meeting_with_dropped_task"];

export function humanizeWarning(raw: string): string {
  const tail = raw.match(/^(.+): ([a-z0-9_]+)$/);
  if (tail) {
    const h = WARNING_HUMANIZERS[tail[2]!];
    return h ? h(tail[1]!) : `“${tail[1]!}” needs attention — we've left it unchanged this time.`;
  }
  for (const code of PREFIX_CODES) {
    if (raw.startsWith(`${code}: `)) return raw.slice(code.length + 2);
  }
  return raw;
}

function warningsBlock(model: ReplanEmailModel): string {
  // Tolerate snapshots persisted before warnings existed (render_snapshot is
  // deserialized JSON; an older row has no `warnings` key).
  const warnings = model.warnings ?? [];
  if (warnings.length === 0) return "";
  const items = warnings
    .map((w) => `<li style="font-size:13px;color:#8a4b00;margin-bottom:4px">${esc(humanizeWarning(w))}</li>`)
    .join("");
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr>` +
    `<td style="border-left:3px solid #f9ab00;background:#fef7e0;border-radius:5px;padding:10px 14px">` +
    `<div style="font-size:13px;color:#8a4b00;font-weight:600">Before you accept</div>` +
    `<ul style="margin:6px 0 0;padding-left:20px">${items}</ul>` +
    `</td></tr></table>`
  );
}

function column(label: string, accent: string, entries: TimelineEntry[], tz: string): string {
  return (
    `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${accent};font-weight:600;margin-bottom:8px">${esc(label)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e0e0e0;border-radius:8px"><tr><td style="padding:10px 12px">` +
    entries.map((e) => card(e, tz)).join("") +
    `</td></tr></table>`
  );
}

function dayBlock(day: DayView, tz: string): string {
  const heading = formatLocalDate(day.before[0]?.start ?? day.after[0]!.start, tz);
  return (
    `<div style="font-size:15px;color:#202124;font-weight:600;margin-top:18px">${esc(heading)}</div>` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="margin-top:8px"><tr>` +
    `<td width="50%" valign="top" style="padding:0 8px 0 0">${column("Before · conflict", "#5f6368", day.before, tz)}</td>` +
    `<td width="50%" valign="top" style="padding:0 0 0 8px">${column("After · resolved", "#1a73e8", day.after, tz)}</td>` +
    `</tr></table>`
  );
}

function droppedBlock(model: ReplanEmailModel): string {
  if (model.dropped.length === 0) return "";
  const rows = model.dropped.map((d) =>
    `<li style="font-size:13px;color:#3c4043;margin-bottom:4px">${esc(d.title)} — ${esc(d.reason)} (${esc(d.constraints.join(", "))})</li>`).join("");
  return `<div style="font-size:14px;color:#b06000;font-weight:600;margin-top:18px">Couldn’t fit this week</div><ul style="margin:8px 0;padding-left:20px">${rows}</ul>`;
}

const LEGEND =
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>` +
  `<td style="font-size:11px;color:#5f6368;padding-right:14px"><span style="display:inline-block;width:9px;height:9px;background:#1a73e8;border-radius:2px"></span> moved / planned</td>` +
  `<td style="font-size:11px;color:#5f6368;padding-right:14px"><span style="display:inline-block;width:9px;height:9px;background:#9aa0a6;border-radius:2px"></span> existing meeting</td>` +
  `<td style="font-size:11px;color:#5f6368"><span style="display:inline-block;width:9px;height:9px;background:#c5221f;border-radius:2px"></span> new / clash</td>` +
  `</tr></table>`;

/** Inner HTML fragment: day columns + dropped + legend. No shell, no CTA. */
export function renderDiffCalendarHtml(model: ReplanEmailModel): string {
  if (model.isEmpty) {
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">` +
      warningsBlock(model) +
      `<p style="font-size:14px;color:#3c4043">No changes to your plan this week.</p>` +
      `</div>`;
  }
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">` +
    warningsBlock(model) +
    model.days.map((d) => dayBlock(d, model.tz)).join("") + droppedBlock(model) + LEGEND + `</div>`;
}

/** Plaintext alternative body. No accept URL (the renderer appends it). */
function warningsPlaintext(model: ReplanEmailModel): string[] {
  const warnings = model.warnings ?? [];
  if (warnings.length === 0) return [];
  const lines = ["Before you accept:"];
  for (const w of warnings) lines.push(`  - ${humanizeWarning(w)}`);
  lines.push("");
  return lines;
}

export function renderDiffPlaintext(model: ReplanEmailModel): string {
  if (model.isEmpty) {
    const head = warningsPlaintext(model);
    return [...head, "No changes to your plan this week."].join("\n");
  }
  const lines: string[] = [...warningsPlaintext(model)];
  for (const day of model.days) {
    lines.push(formatLocalDate(day.before[0]?.start ?? day.after[0]!.start, model.tz));
    for (const e of day.after) {
      const t = `${formatLocalTime(e.start, model.tz)}–${formatLocalTime(e.end, model.tz)}`;
      const note = e.role === "moved-to" && e.movedFrom ? ` (moved from ${formatLocalTime(e.movedFrom, model.tz)})`
        : e.role === "added" ? " (added)" : e.role === "new-clash" ? " (new)" : "";
      const meeting = e.isMeeting ? " [meeting — attendees notified on accept]" : "";
      lines.push(`  ${t}  ${e.title}${note}${meeting}`);
    }
    lines.push("");
  }
  if (model.dropped.length) {
    lines.push("Couldn't fit this week:");
    for (const d of model.dropped) lines.push(`  - ${d.title}: ${d.reason} (${d.constraints.join(", ")})`);
    lines.push("");
  }
  return lines.join("\n");
}
