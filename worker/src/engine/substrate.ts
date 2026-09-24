// Substrate — baked domains, cost vectors, occupancy masks (card A).
//
// Port of the Python fast path's baking (solver/src/solver/placements.py,
// slots.py, fit_curve.py). Semantics are pinned against Python via the
// golden fixtures in test/engine/fixtures/domains/, regenerated only by
// solver/bin/dump-domains.py. Pure, dependency-free TypeScript over typed
// arrays: no Cloudflare imports, no Node imports.

import type {
  Baked,
  BakedChunk,
  BakedContext,
  BakedDependency,
  BakedTask,
  Problem,
  UnsatItem,
} from "./types";

export const SLOT_MINUTES = 15;
export const SLOTS_PER_DAY = 96;

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// ---------------------------------------------------------------------------
// Local-naive datetime arithmetic (mirrors slots.py; no Date, no zones)
// ---------------------------------------------------------------------------

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** Days since 1970-01-01 for a proleptic-Gregorian civil date. */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/** Seconds since 1970-01-01T00:00:00 (naive) for "YYYY-MM-DDTHH:MM:SS". */
function parseLocalNaiveSeconds(s: string): number {
  const m = DT_RE.exec(s);
  if (!m) throw new Error(`invalid local-naive datetime: ${s}`);
  const days = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  return days * 86400 + Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Slot index of `dt` from `origin` (both "YYYY-MM-DDTHH:MM:SS"). Throws on
 * input not aligned to the 15-minute grid — the worker guarantees alignment,
 * so misalignment is a contract violation (mirrors slots.datetime_to_slot). */
export function datetimeToSlot(dt: string, origin: string): number {
  const deltaSeconds = parseLocalNaiveSeconds(dt) - parseLocalNaiveSeconds(origin);
  if (deltaSeconds % (SLOT_MINUTES * 60) !== 0) {
    throw new Error(`${dt} is not aligned to a ${SLOT_MINUTES}-minute slot from ${origin}`);
  }
  return deltaSeconds / (SLOT_MINUTES * 60);
}

export function slotToDatetime(slot: number, origin: string): string {
  const total = parseLocalNaiveSeconds(origin) + slot * SLOT_MINUTES * 60;
  const days = Math.floor(total / 86400);
  const secs = total - days * 86400;
  const [y, m, d] = civilFromDays(days);
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

function durationToSlots(minutes: number): number {
  if (minutes % SLOT_MINUTES !== 0) {
    throw new Error(`duration ${minutes} is not a multiple of ${SLOT_MINUTES}`);
  }
  return minutes / SLOT_MINUTES;
}

/** "HH:MM" or "HH:MM:SS" → minutes of day. */
function timeToMinutes(t: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`invalid time of day: ${t}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Python round() (banker's rounding) for non-negative values — fit-curve
 * parity depends on half-even, not JS Math.round's half-up. */
function pyRound(x: number): number {
  const fl = Math.floor(x);
  const diff = x - fl;
  if (diff > 0.5) return fl + 1;
  if (diff < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

// ---------------------------------------------------------------------------
// Fit curve (port of fit_curve.FitCurveEvaluator)
// ---------------------------------------------------------------------------

const MAX_FIT_SCORE = 100;

export class FitCurve {
  private readonly peakStart: number;
  private readonly peakEnd: number;
  private readonly falloffEnd: number;

  constructor(curve: { peak_start: string; peak_end: string; falloff_end: string }) {
    this.peakStart = timeToMinutes(curve.peak_start);
    this.peakEnd = timeToMinutes(curve.peak_end);
    this.falloffEnd = timeToMinutes(curve.falloff_end);
  }

  scoreAt(minute: number): number {
    if (this.peakStart <= minute && minute <= this.peakEnd) return 0;
    if (minute < this.peakStart) {
      if (this.peakStart === 0) return 0;
      return pyRound(((this.peakStart - minute) / this.peakStart) * MAX_FIT_SCORE);
    }
    if (minute >= this.falloffEnd) return MAX_FIT_SCORE;
    const span = this.falloffEnd - this.peakEnd;
    if (span <= 0) return MAX_FIT_SCORE;
    return pyRound(((minute - this.peakEnd) / span) * MAX_FIT_SCORE);
  }

  scoreForChunk(startMinute: number, durationMinutes: number): number {
    let total = 0;
    for (let off = 0; off < durationMinutes; off += SLOT_MINUTES) {
      total += this.scoreAt(startMinute + off);
    }
    return total;
  }
}

/** Raw (unweighted) fit score for a chunk starting at time-of-day
 * `startTodMin`. Shared by the bake loop and engine.ts's objective
 * breakdown so the two cannot drift. */
export function rawChunkFit(
  curve: FitCurve,
  startTodMin: number,
  durationMinutes: number,
): number {
  return startTodMin + durationMinutes > 24 * 60
    ? MAX_FIT_SCORE * (durationMinutes / 15)
    : curve.scoreForChunk(startTodMin, durationMinutes) +
        curve.scoreAt(startTodMin + durationMinutes);
}

// ---------------------------------------------------------------------------
// Bit-mask helpers (Uint32Array, bit s = slot/start s)
// ---------------------------------------------------------------------------

export function maskGet(mask: Uint32Array, bit: number): boolean {
  return ((mask[bit >> 5]! >>> (bit & 31)) & 1) === 1;
}

export function maskSet(mask: Uint32Array, bit: number): void {
  mask[bit >> 5]! |= 1 << (bit & 31);
}

/** True iff no bit is set in [start, end). */
export function rangeFree(mask: Uint32Array, start: number, end: number): boolean {
  for (let s = start; s < end; s++) {
    if (maskGet(mask, s)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// bakeProblem
// ---------------------------------------------------------------------------

export function bakeProblem(problem: Problem): Baked {
  const origin = problem.window.start;
  const horizon = datetimeToSlot(problem.window.end, origin);
  if (horizon <= 0) throw new Error("window.end must be after window.start");
  const maskWords = (horizon + 31) >> 5;

  // ----- slot tables (mirror placements.build_slot_tables) -----
  const originSeconds = parseLocalNaiveSeconds(origin);
  const originDay = Math.floor(originSeconds / 86400);
  const originTod = Math.floor((originSeconds - originDay * 86400) / 60);
  // Python weekday(): Monday = 0. 1970-01-01 was a Thursday (= 3).
  const originWeekday = (((originDay % 7) + 7) % 7 + 3) % 7;

  const slotTod = new Int32Array(horizon);
  const slotDayIndex = new Int32Array(horizon);
  const slotWeekday = new Uint8Array(horizon);
  for (let s = 0; s < horizon; s++) {
    const total = originTod + s * SLOT_MINUTES;
    const dayOffset = Math.floor(total / 1440);
    slotTod[s] = total - dayOffset * 1440;
    slotDayIndex[s] = dayOffset;
    slotWeekday[s] = (originWeekday + dayOffset) % 7;
  }

  // ----- contexts -----
  const contexts: BakedContext[] = [];
  const contextIndexByName = new Map<string, number>();
  for (const c of problem.contexts) {
    contextIndexByName.set(c.context, contexts.length);
    contexts.push({
      context: c.context,
      dailyCapSlots: c.max_minutes_per_day === null ? -1 : Math.floor(c.max_minutes_per_day / 15),
      dailyCapPenaltyPer15: c.over_daily_cap_penalty_per_15min,
      streakCapSlots:
        c.max_contiguous_minutes === null ? -1 : Math.floor(c.max_contiguous_minutes / 15),
      streakCapPenaltyPer15: c.over_streak_cap_penalty_per_15min,
    });
  }

  const weights = problem.weights;
  const fitWeight = weights.time_of_day_fit_per_15min;
  const churnWeight = weights.churn_per_15min_moved;
  const dayMissWeight = weights.preferred_day_miss ?? 0;
  const timeMissWeight = weights.preferred_time_miss_per_15min ?? 0;
  const daysInHorizon = Math.max(Math.floor(horizon / SLOTS_PER_DAY), 1);
  const weekdayOfDay: number[] = [];
  for (let d = 0; d < daysInHorizon; d++) weekdayOfDay.push(slotWeekday[d * SLOTS_PER_DAY]!);
  const maxDayGap = daysInHorizon;
  const maxTimeUnits = (24 * 60) / 15;

  const bh = problem.business_hours ?? null;
  const bhSpec =
    bh === null
      ? null
      : {
          start: timeToMinutes(bh.start),
          end: timeToMinutes(bh.end),
          days: new Set(bh.days.map((d) => WEEKDAYS.indexOf(d))),
        };

  // ----- tasks + chunks -----
  const tasks: BakedTask[] = [];
  const chunks: BakedChunk[] = [];
  const taskIndexById = new Map<string, number>();
  const chunkIndexByKey = new Map<string, number>();

  for (let ti = 0; ti < problem.tasks.length; ti++) {
    const task = problem.tasks[ti]!;
    taskIndexById.set(task.id, ti);
  }

  for (let ti = 0; ti < problem.tasks.length; ti++) {
    const task = problem.tasks[ti]!;
    const hardWindows = task.preferred_windows.filter((w) => w.hard);
    const softWindows = task.preferred_windows.filter((w) => !w.hard);
    const hardWindowSpecs = hardWindows.map((w) => ({
      start: timeToMinutes(w.start),
      end: timeToMinutes(w.end),
      days: new Set(w.days.map((d) => WEEKDAYS.indexOf(d))),
    }));
    const availability = task.availability_windows ?? [];
    const availSlots = availability.map((w) => ({
      start: datetimeToSlot(w.start, origin),
      end: datetimeToSlot(w.end, origin),
    }));
    const esSlot = Math.max(0, datetimeToSlot(task.earliest_start, origin));
    const deadline = task.deadline ?? null;
    const hardDeadlineSlot =
      deadline !== null && deadline.hard ? datetimeToSlot(deadline.at, origin) : null;
    // Mirror model.py _add_business_hours: explicit beats implicit — a pin, a
    // hard own window, or an availability mask exempts the task from the
    // business-hours floor. A SOFT window does not.
    // Wire JSON may carry explicit nulls for optional fields (pydantic dumps).
    const useBh =
      bhSpec !== null &&
      task.pinned_at == null &&
      hardWindows.length === 0 &&
      availability.length === 0;
    const pinnedSlot = task.pinned_at == null ? null : datetimeToSlot(task.pinned_at, origin);

    const churnMultiplier = task.churn_multiplier ?? 1;
    const ctxIdx = contextIndexByName.get(task.context);
    const ctxCfg = ctxIdx === undefined ? null : problem.contexts[ctxIdx]!;
    const evaluator = fitWeight && ctxCfg ? new FitCurve(ctxCfg.fit_curve) : null;
    const hasSoftWindows = softWindows.length > 0 && (dayMissWeight !== 0 || timeMissWeight !== 0);
    const softSpecs = hasSoftWindows
      ? softWindows.map((w) => ({
          start: timeToMinutes(w.start),
          end: timeToMinutes(w.end),
          days: new Set(w.days.map((d) => WEEKDAYS.indexOf(d))),
        }))
      : [];
    const taskChurnWeight = churnWeight * churnMultiplier;

    const chunkIndices: number[] = [];
    for (let ci = 0; ci < task.chunks.length; ci++) {
      const chunk = task.chunks[ci]!;
      const durSlots = durationToSlots(chunk.duration_minutes);
      const durMin = chunk.duration_minutes;
      // model.py pins only the FIRST chunk of a pinned task.
      const pinHere = pinnedSlot !== null && ci === 0 ? pinnedSlot : null;
      let lo = esSlot;
      let hi = horizon - durSlots;
      if (pinHere !== null) {
        lo = Math.max(lo, pinHere);
        hi = Math.min(hi, pinHere);
      }
      if (hardDeadlineSlot !== null) hi = Math.min(hi, hardDeadlineSlot - durSlots);

      const allowed: number[] = [];
      let canSpanMidnight = false;
      for (let s = lo; s <= hi; s++) {
        const m = slotTod[s]!;
        const wd = slotWeekday[s]!;
        const crossesMidnight = m + durMin > 24 * 60;
        if (useBh) {
          if (!bhSpec!.days.has(wd) || m < bhSpec!.start || m + durMin > bhSpec!.end || crossesMidnight) {
            continue;
          }
        }
        let ok = true;
        for (const win of hardWindowSpecs) {
          // Intersection semantics: EACH hard window constrains the start.
          if (!win.days.has(wd) || m < win.start || m + durMin > win.end || crossesMidnight) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (availSlots.length > 0) {
          let inSome = false;
          for (const w of availSlots) {
            if (w.start <= s && s + durSlots <= w.end) {
              inSome = true;
              break;
            }
          }
          if (!inSome) continue;
        }
        allowed.push(s);
        if (crossesMidnight) canSpanMidnight = true;
      }

      // ----- combined soft-cost vector at allowed starts (mirror
      // placements.combined_cost_table; zeros when no start-dependent cost) -----
      const prev = task.previous_placement.find((p) => p.chunk_id === chunk.chunk_id);
      let prevSlot = -1;
      if (prev !== undefined) {
        const ps = datetimeToSlot(prev.start, origin);
        // Out-of-window previous placements carry no churn and no warm start.
        if (ps >= 0 && ps < horizon) prevSlot = ps;
      }
      const churnPrevSlot = taskChurnWeight !== 0 ? prevSlot : -1;

      const cost = new Int32Array(allowed.length);
      if (evaluator !== null || softSpecs.length > 0 || churnPrevSlot !== -1) {
        for (let i = 0; i < allowed.length; i++) {
          const s = allowed[i]!;
          const m = slotTod[s]!;
          let v = 0;
          if (evaluator !== null) {
            v += fitWeight * rawChunkFit(evaluator, m, durMin);
          }
          if (softSpecs.length > 0) {
            if (m + durMin > 24 * 60) {
              v += dayMissWeight * maxDayGap + timeMissWeight * maxTimeUnits;
            } else {
              const wd = slotWeekday[s]!;
              const dayIdx = slotDayIndex[s]!;
              let best = -1;
              for (const w of softSpecs) {
                let dgap: number;
                if (w.days.has(wd)) {
                  dgap = 0;
                } else {
                  dgap = maxDayGap;
                  let found = false;
                  for (let d = 0; d < daysInHorizon; d++) {
                    if (w.days.has(weekdayOfDay[d]!)) {
                      const g = Math.abs(d - dayIdx);
                      if (!found || g < dgap) dgap = g;
                      found = true;
                    }
                  }
                }
                const tgapMin = Math.max(0, w.start - m) + Math.max(0, m + durMin - w.end);
                const c = dayMissWeight * dgap + timeMissWeight * Math.floor(tgapMin / 15);
                if (best < 0 || c < best) best = c;
              }
              v += best < 0 ? 0 : best;
            }
          }
          if (churnPrevSlot !== -1) {
            v += taskChurnWeight * Math.abs(s - churnPrevSlot);
          }
          cost[i] = v;
        }
      }

      const allowedMask = new Uint32Array(maskWords);
      for (const s of allowed) maskSet(allowedMask, s);

      const index = chunks.length;
      chunkIndices.push(index);
      chunkIndexByKey.set(`${task.id} ${chunk.chunk_id}`, index);
      chunks.push({
        index,
        taskIndex: ti,
        chunkId: chunk.chunk_id,
        durationSlots: durSlots,
        durationMinutes: durMin,
        allowedStarts: Int32Array.from(allowed),
        allowedMask,
        cost,
        canSpanMidnight,
        prevSlot,
      });
    }

    // ----- hard dependencies, endpoints resolved (mirror model.py: soft
    // ignored; unresolvable refs skipped) -----
    const deps: BakedDependency[] = [];
    for (const dep of task.dependencies) {
      if (!dep.hard) continue;
      if (dep.type === "after_task" || dep.type === "before_task") {
        const other = taskIndexById.get(dep.ref);
        if (other === undefined || problem.tasks[other]!.chunks.length === 0) continue;
        deps.push({ type: dep.type, ref: dep.ref, taskIndex: other, eventStartSlot: -1, eventEndSlot: -1 });
      } else {
        const ev = problem.external_pinned.find((e) => e.id === dep.ref);
        if (ev === undefined) continue;
        const evStart = datetimeToSlot(ev.start, origin);
        deps.push({
          type: dep.type,
          ref: dep.ref,
          taskIndex: -1,
          eventStartSlot: evStart,
          eventEndSlot: evStart + durationToSlots(ev.duration_minutes),
        });
      }
    }

    tasks.push({
      index: ti,
      id: task.id,
      title: task.title,
      context: task.context,
      contextIndex: ctxIdx ?? -1,
      priority: task.priority,
      dropWeight: weights.base_drop_penalty + task.priority * weights.priority_unit,
      mustInclude: task.must_include,
      churnMultiplier,
      sameDay: task.group_policy.same_day,
      ordered: task.group_policy.ordered,
      // Deliberately unclamped: an already-passed deadline bakes negative, and
      // objective.lateness_terms still prices it (pulling the task earlier).
      deadlineSlot: deadline === null ? -1 : datetimeToSlot(deadline.at, origin),
      deadlineHard: deadline !== null && deadline.hard,
      deadlinePenaltyPer15: deadline === null ? 0 : deadline.penalty_per_15min,
      hasSoftDeadline: deadline !== null && !deadline.hard,
      earliestStartSlot: esSlot,
      pinnedSlot: pinnedSlot ?? -1,
      usedBusinessHours: useBh,
      chunkIndices,
      deps,
      hasHardWindows: hardWindows.length > 0,
      hasAvailability: availability.length > 0,
    });
  }

  // ----- externals: occupancy mask + overlap sweep (the one unconditional-
  // UNSAT case, returned as an external_pinned core without any search) -----
  const externalMask = new Uint32Array(maskWords);
  const events = problem.external_pinned
    .map((e) => {
      const start = datetimeToSlot(e.start, origin);
      return { id: e.id, start, end: start + durationToSlots(e.duration_minutes), startIso: e.start };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let externalOverlapCore: UnsatItem[] | null = null;
  let prevEvent: (typeof events)[number] | null = null;
  for (const ev of events) {
    if (externalOverlapCore === null && prevEvent !== null && ev.start < prevEvent.end) {
      externalOverlapCore = [
        { type: "external_pinned", task_id: prevEvent.id, value: prevEvent.startIso },
        { type: "external_pinned", task_id: ev.id, value: ev.startIso },
      ];
    }
    if (prevEvent === null || ev.end > prevEvent.end) prevEvent = ev;
    for (let s = Math.max(0, ev.start); s < Math.min(horizon, ev.end); s++) {
      maskSet(externalMask, s);
    }
  }

  return {
    problem,
    horizon,
    maskWords,
    slotTod,
    slotDayIndex,
    slotWeekday,
    tasks,
    chunks,
    contexts,
    taskIndexById,
    chunkIndexByKey,
    externalMask,
    externalOverlapCore,
  };
}
