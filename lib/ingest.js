// Accepts the JSON that the "Health Auto Export" iOS app POSTs via its REST API automation.
// Payload shape: { data: { metrics: [{ name, units, data: [...] }], workouts: [...] } }

import { METRICS_BY_HAE, METRIC_BY_KEY, toCanonical, normalizeWorkoutType } from './metrics.js';
import { DayAggregator, parseTs, sleepNight } from './aggregate.js';
import { writeDaily, writeWorkouts, logImport } from './db.js';

const SLEEP_VALUE = {
  core: 'HKCategoryValueSleepAnalysisAsleepCore',
  deep: 'HKCategoryValueSleepAnalysisAsleepDeep',
  rem: 'HKCategoryValueSleepAnalysisAsleepREM',
  awake: 'HKCategoryValueSleepAnalysisAwake',
  'in bed': 'HKCategoryValueSleepAnalysisInBed',
  inbed: 'HKCategoryValueSleepAnalysisInBed',
  asleep: 'HKCategoryValueSleepAnalysisAsleep',
};

const qty = x => (x == null ? null : typeof x === 'number' ? x : typeof x === 'object' ? Number(x.qty ?? x.avg?.qty ?? NaN) : Number(x));
const unitOf = x => (x && typeof x === 'object' ? x.units : undefined);
const num = x => (Number.isFinite(x) ? x : null);

export function ingestHealthAutoExport(body) {
  const d = body?.data ?? body ?? {};
  const agg = new DayAggregator();
  const sleepRows = new Map(); // night -> row set with the longest sleep
  let points = 0;

  for (const entry of d.metrics || []) {
    if (entry.name === 'sleep_analysis') {
      for (const p of entry.data || []) {
        points++;
        if (p.startDate && p.value) { // un-aggregated segments
          agg.addSleep(SLEEP_VALUE[String(p.value).toLowerCase()], p.startDate, p.endDate, p.source || '');
          continue;
        }
        const night = p.sleepStart ? sleepNight(p.sleepStart) : String(p.date).slice(0, 10);
        const total = p.totalSleep ?? p.asleep ?? ((p.core || 0) + (p.deep || 0) + (p.rem || 0));
        if (!(total > 0)) continue;
        const prev = sleepRows.get(night);
        if (prev && prev.sleep_total >= total) continue;
        sleepRows.set(night, {
          sleep_total: total, sleep_deep: p.deep, sleep_rem: p.rem, sleep_core: p.core,
          sleep_awake: p.awake, sleep_in_bed: p.inBed || null,
        });
      }
      continue;
    }
    const metrics = METRICS_BY_HAE[entry.name];
    if (!metrics) continue;
    for (const p of entry.data || []) {
      points++;
      if (!p.date) continue;
      const date = String(p.date).slice(0, 10);
      for (const m of metrics) {
        const raw = m.haeField ? (p[m.haeField] ?? p.qty) : p.qty;
        const v = toCanonical(m, Number(raw), entry.units);
        agg.add(m, date, v, '', m.agg === 'last' ? parseTs(p.date) : 0);
      }
    }
  }

  const rows = agg.rows();
  for (const [date, s] of sleepRows) {
    for (const [metric, value] of Object.entries(s)) if (value != null && value > 0) rows.push({ date, metric, value });
  }

  const workouts = [];
  for (const w of d.workouts || []) {
    const start = w.start || w.startDate;
    if (!start) continue;
    const dist = w.distance ?? w.totalDistance;
    const energy = w.activeEnergyBurned ?? w.activeEnergy ?? w.totalEnergy;
    let duration = num(qty(w.duration));
    if (duration == null && w.end) duration = (parseTs(w.end) - parseTs(start)) / 1000;
    const t0 = parseTs(start);
    const hr = (w.heartRateData || [])
      .map(p => [Math.round((parseTs(p.date) - t0) / 1000), Number(p.Avg ?? p.qty)])
      .filter(([t, v]) => t >= 0 && Number.isFinite(v));
    workouts.push({
      start,
      end: w.end || w.endDate,
      type: normalizeWorkoutType(w.name || w.workoutActivityType),
      source: w.source || 'Health Auto Export',
      duration_min: duration != null ? duration / 60 : null,
      distance_km: dist != null ? num(toCanonical(METRIC_BY_KEY.distance, qty(dist), unitOf(dist) || 'km')) : null,
      energy_kcal: energy != null ? num(toCanonical(METRIC_BY_KEY.active_energy, qty(energy), unitOf(energy) || 'kcal')) : null,
      avg_hr: num(qty(w.avgHeartRate ?? w.heartRate?.avg)),
      max_hr: num(qty(w.maxHeartRate ?? w.heartRate?.max)),
      hr_series: hr.length >= 3 ? hr : null,
    });
  }

  const days = writeDaily(rows, 'sync');
  writeWorkouts(workouts, 'sync');
  logImport('sync', `${points} points`, days, rows.length, workouts.length);
  return { points, days, values: rows.length, workouts: workouts.length };
}
