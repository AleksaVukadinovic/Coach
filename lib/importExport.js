// Streams an Apple Health export (export.zip or export.xml) into daily aggregates.
// Exports can be several GB, so the XML is scanned incrementally instead of parsed into a DOM.

import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { METRICS_BY_HK, METRIC_BY_KEY, toCanonical, normalizeWorkoutType } from './metrics.js';
import { DayAggregator, parseTs } from './aggregate.js';
import { writeDaily, writeWorkouts, logImport } from './db.js';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = s => (s.includes('&') ? s.replace(/&(amp|lt|gt|quot|apos);/g, e => ENTITIES[e]) : s);

function attrs(s) {
  const out = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

function openStream(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const magic = Buffer.alloc(2);
  fs.readSync(fd, magic, 0, 2, 0);
  fs.closeSync(fd);

  if (magic.toString() !== 'PK') {
    return { stream: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 }), total: fs.statSync(filePath).size };
  }
  const listing = execFileSync('unzip', ['-Z1', filePath], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
  const entry = listing.find(n => /(^|\/)export\.xml$/.test(n));
  if (!entry) throw new Error('No export.xml found inside the zip. Is this an Apple Health export?');
  let total = 0;
  try {
    const info = execFileSync('unzip', ['-Zl', filePath, entry], { encoding: 'utf8' });
    total = Number(info.trim().split(/\s+/)[3]) || 0; // uncompressed size column
  } catch {}
  const child = spawn('unzip', ['-p', filePath, entry]);
  child.stdout.setEncoding('utf8');
  return { stream: child.stdout, total };
}

export async function importExport(filePath, onProgress = () => {}) {
  const { stream, total } = openStream(filePath);
  const agg = new DayAggregator();
  const workouts = [];
  let bytes = 0, records = 0, buf = '';
  const sleepType = 'HKCategoryTypeIdentifierSleepAnalysis';
  const hrType = 'HKQuantityTypeIdentifierHeartRate';
  const hrT = [], hrV = []; // every heart-rate sample, used to chart each workout
  const standHours = METRIC_BY_KEY.stand_hours;

  const onRecord = a => {
    records++;
    const type = a.type;
    if (type === sleepType) return agg.addSleep(a.value, a.startDate, a.endDate, decode(a.sourceName || ''));
    const metrics = METRICS_BY_HK[type];
    if (!metrics) return;
    if (type === hrType) { hrT.push(parseTs(a.startDate)); hrV.push(parseFloat(a.value)); }
    const source = a.sourceName || '';
    const date = a.startDate.slice(0, 10);
    for (const m of metrics) {
      const v = m.duration
        ? (parseTs(a.endDate) - parseTs(a.startDate)) / 60000
        : toCanonical(m, parseFloat(a.value), a.unit);
      agg.add(m, date, v, source, m.agg === 'last' ? parseTs(a.startDate) : 0);
    }
  };

  const onWorkout = (a, inner) => {
    const w = {
      start: a.startDate,
      end: a.endDate,
      type: normalizeWorkoutType(a.workoutActivityType),
      source: decode(a.sourceName || ''),
      duration_min: a.duration ? toCanonical(METRIC_BY_KEY.exercise_min, parseFloat(a.duration), a.durationUnit) : null,
      distance_km: a.totalDistance ? toCanonical(METRIC_BY_KEY.distance, parseFloat(a.totalDistance), a.totalDistanceUnit) : null,
      energy_kcal: a.totalEnergyBurned ? toCanonical(METRIC_BY_KEY.active_energy, parseFloat(a.totalEnergyBurned), a.totalEnergyBurnedUnit) : null,
    };
    const brand = /<MetadataEntry key="HKWorkoutBrandName" value="([^"]*)"/.exec(inner);
    if (brand) w.title = decode(brand[1]);
    // iOS 16+ moved totals into <WorkoutStatistics> children
    const re = /<WorkoutStatistics\b([^>]*)>/g;
    let m;
    while ((m = re.exec(inner))) {
      const s = attrs(m[1]);
      if (s.type === 'HKQuantityTypeIdentifierActiveEnergyBurned' && s.sum) w.energy_kcal ??= toCanonical(METRIC_BY_KEY.active_energy, parseFloat(s.sum), s.unit);
      else if (s.type?.startsWith('HKQuantityTypeIdentifierDistance') && s.sum) w.distance_km ??= toCanonical(METRIC_BY_KEY.distance, parseFloat(s.sum), s.unit);
      else if (s.type === 'HKQuantityTypeIdentifierHeartRate') {
        if (s.average) w.avg_hr = parseFloat(s.average);
        if (s.maximum) w.max_hr = parseFloat(s.maximum);
      }
    }
    if (w.start) workouts.push(w);
  };

  const onActivitySummary = a => {
    if (!a.dateComponents) return;
    const stand = parseFloat(a.appleStandHours);
    const anything = parseFloat(a.activeEnergyBurned) || parseFloat(a.appleExerciseTime) || stand;
    if (anything) agg.add(standHours, a.dateComponents, stand, 'summary');
  };

  let lastReport = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    buf += chunk;
    let pos = 0;
    for (;;) {
      const i = buf.indexOf('<', pos);
      if (i < 0) { pos = buf.length; break; }
      if (buf.length - i < 24) { pos = i; break; } // too short to identify the tag yet
      if (buf.startsWith('<Record ', i)) {
        const j = buf.indexOf('>', i);
        if (j < 0) { pos = i; break; }
        onRecord(attrs(buf.slice(i + 8, j)));
        pos = j + 1;
      } else if (buf.startsWith('<Workout ', i)) {
        const j = buf.indexOf('>', i);
        if (j < 0) { pos = i; break; }
        if (buf[j - 1] === '/') {
          onWorkout(attrs(buf.slice(i + 9, j)), '');
          pos = j + 1;
        } else {
          const e = buf.indexOf('</Workout>', j);
          if (e < 0) { pos = i; break; }
          onWorkout(attrs(buf.slice(i + 9, j)), buf.slice(j + 1, e));
          pos = e + 10;
        }
      } else if (buf.startsWith('<ActivitySummary ', i)) {
        const j = buf.indexOf('>', i);
        if (j < 0) { pos = i; break; }
        onActivitySummary(attrs(buf.slice(i + 17, j)));
        pos = j + 1;
      } else {
        pos = i + 1;
      }
    }
    buf = buf.slice(pos);
    if (bytes - lastReport > 8 << 20) {
      lastReport = bytes;
      onProgress({ bytes, total, records });
    }
  }

  attachHeartRate(workouts, hrT, hrV);
  const rows = agg.rows();
  const days = writeDaily(rows, 'export');
  writeWorkouts(workouts, 'export');
  logImport('export', `${records} records`, days, rows.length, workouts.length);
  return { records, days, values: rows.length, workouts: workouts.length };
}

// Gives each workout its heart-rate trace (≤ 240 points) and fills avg/max HR when the source app didn't record them.
function attachHeartRate(workouts, hrT, hrV) {
  if (!hrT.length) return;
  const order = Array.from(hrT.keys()).sort((a, b) => hrT[a] - hrT[b]);
  const T = Float64Array.from(order, i => hrT[i]);
  const V = Float32Array.from(order, i => hrV[i]);
  const lowerBound = t => {
    let lo = 0, hi = T.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const w of workouts) {
    const s = parseTs(w.start), e = parseTs(w.end);
    if (!(e > s)) continue;
    const pts = [];
    for (let i = lowerBound(s); i < T.length && T[i] <= e; i++) pts.push([Math.round((T[i] - s) / 1000), V[i]]);
    if (pts.length < 3) continue;
    w.avg_hr ??= pts.reduce((a, p) => a + p[1], 0) / pts.length;
    w.max_hr ??= Math.max(...pts.map(p => p[1]));
    const step = Math.ceil(pts.length / 240);
    w.hr_series = step > 1 ? pts.filter((_, i) => i % step === 0) : pts;
  }
}
