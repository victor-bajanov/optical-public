/** Half-open millisecond interval [s, e). */
export interface Interval {
  s: number;
  e: number;
}

export function mergeIntervals(ivs: Interval[]): Interval[] {
  const sorted = [...ivs].filter((i) => i.e > i.s).sort((a, b) => a.s - b.s);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.s <= last.e) last.e = Math.max(last.e, iv.e);
    else out.push({ ...iv });
  }
  return out;
}

/** subtract `holes` from `base` (both lists of intervals). */
export function subtract(base: Interval[], holes: Interval[]): Interval[] {
  const merged = mergeIntervals(holes);
  let cur = [...base];
  for (const h of merged) {
    const next: Interval[] = [];
    for (const iv of cur) {
      if (h.e <= iv.s || h.s >= iv.e) {
        next.push(iv);
        continue;
      }
      if (h.s > iv.s) next.push({ s: iv.s, e: h.s });
      if (h.e < iv.e) next.push({ s: h.e, e: iv.e });
    }
    cur = next;
  }
  return cur;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.s, y.s);
      const e = Math.min(x.e, y.e);
      if (e > s) out.push({ s, e });
    }
  }
  return mergeIntervals(out);
}
