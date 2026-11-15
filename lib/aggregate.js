// Collapses raw samples into one value per (day, metric).

// "2024-01-15 23:10:00 +0100" -> epoch ms
export function parseTs(s) {
  if (!s) return NaN;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})?/.exec(s);
  if (!m) return Date.parse(s);
  return Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}${m[3]}:${m[4] || '00'}`);
}

// Local calendar date of a timestamp string, shifted by `hours` on the wall clock.
export function localDate(s, hours = 0) {
  if (!hours) return s.slice(0, 10);
  const [y, mo, d] = s.slice(0, 10).split('-').map(Number);
  const h = Number(s.slice(11, 13)) || 0;
  return new Date(Date.UTC(y, mo - 1, d, h + hours)).toISOString().slice(0, 10);
}

// Sleep that starts after 18:00 belongs to the next day (the day you wake up).
export const sleepNight = start => localDate(start, 6);

const SLEEP_STAGE = {
  HKCategoryValueSleepAnalysisInBed: 'in_bed',
  HKCategoryValueSleepAnalysisAsleep: 'unspecified',
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'unspecified',
  HKCategoryValueSleepAnalysisAsleepCore: 'core',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
  HKCategoryValueSleepAnalysisAwake: 'awake',
};

export class DayAggregator {
  constructor() {
    this.sums = new Map();   // metric|date -> Map(source -> total)
    this.stats = new Map();  // metric|date -> {sum, n, min, max, last, lastT}
    this.sleep = new Map();  // date -> Map(source -> {stage: hours})
  }

  add(metric, date, value, source = '', t = 0) {
    if (value == null || !Number.isFinite(value)) return;
    const k = `${metric.key}|${date}`;
    if (metric.agg === 'sum') {
      let bySrc = this.sums.get(k);
      if (!bySrc) this.sums.set(k, (bySrc = new Map()));
      bySrc.set(source, (bySrc.get(source) || 0) + value);
      return;
    }
    let s = this.stats.get(k);
    if (!s) this.stats.set(k, (s = { metric, sum: 0, n: 0, min: Infinity, max: -Infinity, last: null, lastT: -Infinity }));
    s.sum += value;
    s.n++;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    if (t >= s.lastT) { s.last = value; s.lastT = t; }
  }

  addSleep(hkValue, start, end, source = '') {
    const stage = SLEEP_STAGE[hkValue];
    if (!stage) return;
    const hours = (parseTs(end) - parseTs(start)) / 3.6e6;
    if (!(hours > 0) || hours > 24) return;
    const night = sleepNight(start);
    let bySrc = this.sleep.get(night);
    if (!bySrc) this.sleep.set(night, (bySrc = new Map()));
    let st = bySrc.get(source);
    if (!st) bySrc.set(source, (st = {}));
    st[stage] = (st[stage] || 0) + hours;
  }

  rows() {
    const out = [];
    for (const [k, bySrc] of this.sums) {
      const [metric, date] = k.split('|');
      out.push({ date, metric, value: Math.max(...bySrc.values()) });
    }
    for (const [k, s] of this.stats) {
      const [metric, date] = k.split('|');
      const agg = s.metric.agg;
      const value = agg === 'avg' ? s.sum / s.n : agg === 'min' ? s.min : agg === 'max' ? s.max : s.last;
      out.push({ date, metric, value });
    }
    for (const [date, bySrc] of this.sleep) {
      // Use the source that recorded the most sleep that night (usually the Watch).
      let best = null, bestAsleep = 0, inBed = 0;
      for (const st of bySrc.values()) {
        const asleep = (st.unspecified || 0) + (st.core || 0) + (st.deep || 0) + (st.rem || 0);
        if (asleep > bestAsleep) { best = st; bestAsleep = asleep; }
        inBed = Math.max(inBed, st.in_bed || 0);
      }
      if (!best) continue;
      out.push({ date, metric: 'sleep_total', value: bestAsleep });
      if (best.deep != null) out.push({ date, metric: 'sleep_deep', value: best.deep });
      if (best.rem != null) out.push({ date, metric: 'sleep_rem', value: best.rem });
      if (best.core != null) out.push({ date, metric: 'sleep_core', value: best.core });
      if (best.awake != null) out.push({ date, metric: 'sleep_awake', value: best.awake });
      out.push({ date, metric: 'sleep_in_bed', value: Math.max(inBed, bestAsleep + (best.awake || 0)) });
    }
    return out;
  }
}
