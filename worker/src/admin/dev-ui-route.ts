import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireAccess } from "../middleware/auth-access";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Scheduler — Dev UI</title>
<style>
  body { font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 1rem; max-width: 1100px; }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem 0; }
  h2 { font-size: 0.9rem; margin: 1rem 0 0.25rem 0; text-transform: uppercase; color: #555; }
  section { border: 1px solid #ccc; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; border-radius: 4px; }
  label { display: inline-block; min-width: 7rem; }
  input[type=text], input[type=date] { font: inherit; padding: 0.2rem 0.3rem; }
  input[type=text].wide { width: 32rem; }
  button { font: inherit; padding: 0.3rem 0.6rem; margin-right: 0.3rem; cursor: pointer; }
  button.primary { background: #2563eb; color: white; border: 1px solid #1e40af; border-radius: 3px; }
  button.danger { background: #dc2626; color: white; border: 1px solid #991b1b; border-radius: 3px; }
  textarea { font: 12px/1.3 ui-monospace, Menlo, monospace; width: 100%; min-height: 8rem; padding: 0.3rem; box-sizing: border-box; }
  pre { background: #f5f5f5; border: 1px solid #ddd; padding: 0.4rem; overflow-x: auto; max-height: 22rem; font: 11px/1.35 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.25rem 0.4rem; border-bottom: 1px solid #eee; font-size: 12px; vertical-align: top; }
  th { background: #fafafa; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin: 0.25rem 0; }
  .muted { color: #777; font-size: 11px; }
  .ok { color: #166534; }
  .err { color: #991b1b; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
</style>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>

<h1>Scheduler dev UI</h1>
<div class="muted">Served by the Worker at <code>/admin/dev-ui</code>. Access-gated; CF cookie auto-attached. Bearer token persists in localStorage.</div>

<section>
  <h2>Auth</h2>
  <div class="row">
    <label>Bearer</label>
    <input id="bearer" type="text" class="wide" placeholder="paste from /oauth/authorize + /oauth/token" />
    <button id="bearer-save">Save</button>
    <span id="bearer-status" class="muted"></span>
  </div>
  <div class="row">
    <label>Active account</label>
    <span id="active-account" class="muted">(loading…)</span>
    <button id="active-account-refresh">Refresh</button>
  </div>
</section>

<div class="grid2">
  <section>
    <h2>Create task / template</h2>
    <div class="row">
      <label><input type="radio" name="kind" value="task" checked /> task</label>
      <label><input type="radio" name="kind" value="template" /> template</label>
      <button id="prefill-task">Prefill task</button>
      <button id="prefill-template">Prefill template</button>
    </div>
    <textarea id="payload"></textarea>
    <div class="row">
      <button class="primary" id="submit-payload">Add</button>
      <span id="submit-status" class="muted"></span>
    </div>
    <pre id="submit-resp"></pre>
  </section>

  <section>
    <h2>Planning window</h2>
    <div class="row">
      <label>Start (Mon)</label><input id="win-start" type="date" />
      <label>End (next Mon)</label><input id="win-end" type="date" />
    </div>
    <div class="row">
      <button id="win-this">This week</button>
      <button id="win-next">Next week</button>
    </div>

    <h2>Actions</h2>
    <div class="row">
      <button class="primary" id="act-resolve">Resolve</button>
      <button class="primary" id="act-commit">Commit</button>
    </div>
    <div class="row">
      <label>Plan hash</label>
      <input id="plan-hash" type="text" class="wide" />
    </div>

    <h2>Re-resolve (webhook-style)</h2>
    <div class="row">
      <label><input id="rr-dry" type="checkbox" checked /> dry run (no email)</label>
      <label><input id="rr-force" type="checkbox" checked /> force resolve (skip change check)</label>
    </div>
    <div class="row">
      <label>Trigger label</label>
      <input id="rr-trigger" type="text" placeholder="manual replan" />
      <button class="primary" id="act-replan">Replan now</button>
    </div>
  </section>
</div>

<section>
  <h2>Tasks (status: pending / scheduled / committed)</h2>
  <div class="row">
    <button id="tasks-refresh">Refresh</button>
    <span id="tasks-status" class="muted"></span>
  </div>
  <table id="tasks-table">
    <thead><tr><th>id</th><th>title</th><th>ctx</th><th>pri</th><th>dur</th><th>pinned</th><th>status</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Last response</h2>
  <pre id="last-resp">(none)</pre>
</section>

<section>
  <h2>Fit curves</h2>
  <div class="row">
    <label>Plan hash</label>
    <input id="curve-plan-hash" type="text" class="wide" placeholder="paste plan_hash to overlay scheduled chunks" />
    <button id="curve-use-current">Use current</button>
    <button id="curve-load">Load overlay</button>
    <button id="curve-refresh">Refresh curves</button>
    <span id="curve-status" class="muted"></span>
  </div>
  <div id="curve-chart" style="width: 100%; height: 360px; border: 1px solid #ddd; border-radius: 4px;"></div>
</section>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const out = (id, value) => { $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };

  // ---- bearer token ----
  const BEAR_KEY = "scheduler.bearer";
  $("bearer").value = localStorage.getItem(BEAR_KEY) ?? "";
  $("bearer-save").addEventListener("click", () => {
    localStorage.setItem(BEAR_KEY, $("bearer").value.trim());
    $("bearer-status").textContent = "saved";
    setTimeout(() => $("bearer-status").textContent = "", 1500);
  });
  const bearer = () => $("bearer").value.trim() || localStorage.getItem(BEAR_KEY) || "";

  // ---- request helpers ----
  async function call(method, path, opts = {}) {
    const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (path.startsWith("/v1/") && bearer()) headers["authorization"] = "Bearer " + bearer();
    const init = { method, headers, credentials: "same-origin" };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(path, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  function show(target, { status, body }) {
    const ok = status >= 200 && status < 300;
    out(target, "HTTP " + status + "\\n" + (typeof body === "string" ? body : JSON.stringify(body, null, 2)));
    out("last-resp", "HTTP " + status + " " + (typeof body === "string" ? body : JSON.stringify(body, null, 2)));
    return { ok, body };
  }

  // ---- active account ----
  let homeTz = "UTC";
  async function loadActiveAccount() {
    $("active-account").textContent = "(loading…)";
    const { status, body } = await call("GET", "/v1/whoami");
    if (status === 200 && body && body.email) {
      if (body.home_tz) homeTz = body.home_tz;
      $("active-account").textContent = body.email + " · tz=" + (body.home_tz ?? "?");
    } else {
      $("active-account").textContent = "(error: HTTP " + status + ")";
    }
  }
  $("active-account-refresh").addEventListener("click", loadActiveAccount);

  // ---- week picker ----
  function mondayOf(d) {
    const x = new Date(d);
    const day = x.getDay(); // 0=Sun, 1=Mon, ...
    const delta = (day === 0 ? -6 : 1 - day);
    x.setDate(x.getDate() + delta);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function setWeek(weekOffset) {
    const start = mondayOf(new Date());
    start.setDate(start.getDate() + weekOffset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    $("win-start").value = fmtDate(start);
    $("win-end").value = fmtDate(end);
  }
  $("win-this").addEventListener("click", () => setWeek(0));
  $("win-next").addEventListener("click", () => setWeek(1));

  // ---- prefill ----
  const TASK_TEMPLATE = {
    title: "Deep work block",
    context: "deep",
    priority: 70,
    duration_minutes: 90,
    earliest_start: null,
    deadline: null,
    preferred_windows: [],
    dependencies: [],
    pinned_at: null,
    source: { kind: "mcp", external_id: null },
    status: "pending"
  };
  const TEMPLATE_TEMPLATE = {
    title: "Pilates",
    context: "physical",
    rrule: "FREQ=WEEKLY;BYDAY=FR",
    pinned_time: "19:00",
    pinned_tz: "Australia/Sydney",
    duration_minutes: 90,
    task_body: { priority: 50, source: { kind: "mcp", external_id: null } },
    active_from: fmtDate(new Date()),
    active_until: null
  };
  function prefill(kind) {
    $("payload").value = JSON.stringify(kind === "task" ? TASK_TEMPLATE : TEMPLATE_TEMPLATE, null, 2);
    const radio = document.querySelector('input[name="kind"][value="' + kind + '"]');
    if (radio) radio.checked = true;
  }
  $("prefill-task").addEventListener("click", () => prefill("task"));
  $("prefill-template").addEventListener("click", () => prefill("template"));
  prefill("task");

  // ---- submit task/template ----
  $("submit-payload").addEventListener("click", async () => {
    let parsed;
    try { parsed = JSON.parse($("payload").value); } catch (e) {
      out("submit-resp", "Invalid JSON: " + e.message);
      return;
    }
    const kind = document.querySelector('input[name="kind"]:checked').value;
    const path = kind === "task" ? "/v1/tasks" : "/v1/templates";
    $("submit-status").textContent = "posting…";
    const r = await call("POST", path, { body: parsed });
    $("submit-status").textContent = "";
    show("submit-resp", r);
    if (r.status === 201 || r.status === 200) refreshTasks();
  });

  // ---- task list ----
  async function refreshTasks() {
    $("tasks-status").textContent = "loading…";
    const r = await call("GET", "/v1/tasks");
    $("tasks-status").textContent = "";
    const tbody = $("tasks-table").querySelector("tbody");
    tbody.innerHTML = "";
    const tasks = (r.body && r.body.tasks) ? r.body.tasks : [];
    for (const t of tasks) {
      const tr = document.createElement("tr");
      tr.innerHTML = [
        "<td><code>" + (t.id || "").slice(0, 8) + "</code></td>",
        "<td>" + escapeHtml(t.title ?? "") + "</td>",
        "<td>" + escapeHtml(t.context ?? "") + "</td>",
        "<td>" + (t.priority ?? "") + "</td>",
        "<td>" + (t.duration_minutes ?? (t.chunks ? t.chunks.map(c => c.duration_minutes).join("+") : "")) + "</td>",
        "<td>" + escapeHtml(t.pinned_at ?? "") + "</td>",
        "<td>" + escapeHtml(t.status ?? "") + "</td>",
        '<td><button class="danger" data-del="' + t.id + '">delete</button></td>'
      ].join("");
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll("button[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-del");
        const r = await call("DELETE", "/v1/tasks/" + id);
        show("last-resp", r);
        refreshTasks();
      });
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  $("tasks-refresh").addEventListener("click", refreshTasks);

  // ---- actions ----
  $("act-resolve").addEventListener("click", async () => {
    const ws = $("win-start").value, we = $("win-end").value;
    if (!ws || !we) { alert("pick a window first"); return; }
    const r = await call("POST", "/v1/resolve", {
      body: { window_start: ws + "T00:00:00Z", window_end: we + "T00:00:00Z" }
    });
    show("last-resp", r);
    if (r.body && r.body.plan_hash) $("plan-hash").value = r.body.plan_hash;
  });
  $("act-commit").addEventListener("click", async () => {
    const h = $("plan-hash").value.trim();
    if (!h) { alert("no plan hash"); return; }
    const r = await call("POST", "/v1/commit", { body: { plan_hash: h } });
    show("last-resp", r);
  });
  $("act-replan").addEventListener("click", async () => {
    const dry = $("rr-dry").checked ? "true" : "false";
    const force = $("rr-force").checked ? "true" : "false";
    const trigger = encodeURIComponent($("rr-trigger").value.trim());
    const q = "?dry_run=" + dry + "&force=" + force + (trigger ? "&trigger=" + trigger : "");
    const r = await call("POST", "/v1/replan-now" + q);
    show("last-resp", r);
    if (r.body && r.body.plan_hash) $("plan-hash").value = r.body.plan_hash;
  });

  // ---- bootstrap ----
  setWeek(0);
  loadActiveAccount();
  refreshTasks();

  // ---- fit-curve viewer ----
  // Mirrors solver/src/solver/fit_curve.py exactly.
  function timeToMin(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }
  function scoreAtMin(curve, minute) {
    const ps = timeToMin(curve.peak_start);
    const pe = timeToMin(curve.peak_end);
    const fe = timeToMin(curve.falloff_end);
    if (minute >= ps && minute <= pe) return 0;
    if (minute < ps) {
      if (ps === 0) return 0;
      return Math.round((ps - minute) / ps * 100);
    }
    if (minute >= fe) return 100;
    const span = fe - pe;
    if (span <= 0) return 100;
    return Math.round((minute - pe) / span * 100);
  }
  function minToLabel(min) {
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m = String(min % 60).padStart(2, "0");
    return h + ":" + m;
  }

  const CTX_COLORS = {
    deep: "#2563eb", admin: "#0891b2", physical: "#16a34a",
    family: "#db2777", meeting: "#d97706"
  };

  let curveState = { contexts: [], businessHours: null, overlayTraces: [] };

  async function renderCurves() {
    $("curve-status").textContent = "loading…";
    const [ctxResp, bhResp] = await Promise.all([
      call("GET", "/v1/contexts"),
      call("GET", "/v1/business-hours"),
    ]);
    if (ctxResp.status !== 200 || bhResp.status !== 200) {
      $("curve-status").textContent = "(error loading config)";
      return;
    }
    curveState.contexts = ctxResp.body.contexts ?? [];
    curveState.businessHours = bhResp.body.business_hours ?? null;

    const xs = [];
    for (let m = 0; m <= 24 * 60; m += 15) xs.push(m);
    const xLabels = xs.map(minToLabel);

    const traces = curveState.contexts.map((c) => ({
      x: xLabels,
      y: xs.map((m) => scoreAtMin(c.body.fit_curve, m)),
      type: "scatter",
      mode: "lines",
      name: c.context,
      line: { color: CTX_COLORS[c.context] || "#555", width: 2 },
    }));

    const layout = {
      margin: { l: 40, r: 20, t: 30, b: 40 },
      yaxis: { title: "Score (0 = best fit)", range: [0, 105] },
      xaxis: { title: "Time of day", tickmode: "array",
               tickvals: ["00:00", "06:00", "09:00", "12:00", "15:00", "17:00", "20:00", "24:00"] },
      legend: { orientation: "h", y: -0.18 },
      shapes: [],
      annotations: [],
    };

    if (curveState.businessHours) {
      layout.shapes.push({
        type: "rect", xref: "x", yref: "paper",
        x0: curveState.businessHours.start, x1: curveState.businessHours.end,
        y0: 0, y1: 1, fillcolor: "rgba(34,197,94,0.08)",
        line: { width: 0 },
      });
      layout.annotations.push({
        x: curveState.businessHours.start, y: 102, text: "biz hrs",
        showarrow: false, font: { size: 10, color: "#166534" },
        xanchor: "left",
      });
    }

    Plotly.newPlot("curve-chart", [...traces, ...curveState.overlayTraces], layout, { displaylogo: false });
    $("curve-status").textContent = "";
  }

  async function loadOverlay() {
    const hash = $("curve-plan-hash").value.trim();
    if (!hash) { alert("paste a plan hash"); return; }
    const r = await call("GET", "/v1/plans/" + hash);
    if (r.status !== 200) { show("last-resp", r); return; }
    const schedule = r.body?.body?.schedule ?? r.body?.schedule ?? [];

    // schedule entries' start is ISO-Z (UTC instant); convert to home_tz
    // for time-of-day plotting so dots land on the chart at the operator's
    // local wall-clock time, not at UTC.
    const localFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: homeTz, hour: "2-digit", minute: "2-digit", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    function localStartParts(iso) {
      const parts = localFmt.formatToParts(new Date(iso));
      const get = (t) => parts.find((p) => p.type === t).value;
      const h = Number(get("hour"));
      const m = Number(get("minute"));
      return { minutes: h * 60 + m, date: get("year") + "-" + get("month") + "-" + get("day") };
    }

    const byContext = {};
    for (const entry of schedule) {
      const { minutes: startMin, date: localDate } = localStartParts(entry.start);
      (byContext[entry.context] ??= []).push({
        x: minToLabel(startMin),
        y: scoreAtMin(
          curveState.contexts.find((c) => c.context === entry.context)?.body.fit_curve
            ?? { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
          startMin,
        ),
        text: entry.task_id + " @ " + localDate,
      });
    }

    curveState.overlayTraces = Object.entries(byContext).map(([ctx, pts]) => ({
      x: pts.map((p) => p.x),
      y: pts.map((p) => p.y),
      text: pts.map((p) => p.text),
      type: "scatter",
      mode: "markers",
      name: ctx + " (scheduled)",
      marker: { size: 12, color: CTX_COLORS[ctx] || "#555", line: { color: "white", width: 1 } },
      hovertemplate: "%{text}<br>%{x}<extra></extra>",
    }));
    renderCurves();
  }

  $("curve-refresh").addEventListener("click", () => {
    curveState.overlayTraces = [];
    renderCurves();
  });
  $("curve-load").addEventListener("click", loadOverlay);
  $("curve-use-current").addEventListener("click", () => {
    $("curve-plan-hash").value = $("plan-hash").value;
  });

  // initial render
  renderCurves();
})();
</script>

</body>
</html>
`;

export function mountDevUiRoute(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
  app.get("/admin/dev-ui", requireAccess, (c) => {
    return new Response(HTML, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });
}
