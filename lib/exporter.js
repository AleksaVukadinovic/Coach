// Turns the database into plain files a language model can read: one Markdown digest plus full-history CSVs.

import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR, getSetting } from './db.js';
import { METRICS, METRIC_BY_KEY } from './metrics.js';

export const EXPORT_DIR = path.join(DATA_DIR, 'export');

// Columns used in the weekly / monthly tables (the daily tables include everything)
const CORE = ['steps', 'active_energy', 'exercise_min', 'distance', 'sleep_total', 'sleep_deep', 'sleep_rem', 'resting_hr', 'hrv', 'vo2max', 'weight', 'body_fat', 'calories_in', 'protein'];

export const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStart(date) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = date => WEEKDAY[new Date(date + 'T00:00:00Z').getUTCDay()];

function fmt(metric, v) {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(METRIC_BY_KEY[metric]?.decimals ?? 1);
}
const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\n+/g, ' ');

function table(header, rows) {
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

// Map(date -> {metric: value})
function loadDays(from = '0000-00-00', to = '9999-99-99') {
  const days = new Map();
  for (const r of db.prepare('SELECT date, metric, value FROM daily WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to)) {
    let d = days.get(r.date);
    if (!d) days.set(r.date, (d = {}));
    d[r.metric] = r.value;
  }
  return days;
}

function mean(days, metric, from, to) {
  let s = 0, n = 0;
  for (const [date, d] of days) {
    if (date < from || date > to) continue;
    const v = d[metric];
    if (v != null) { s += v; n++; }
  }
  return n ? s / n : null;
}

function groupBy(days, keyFn, metrics) {
  const groups = new Map();
  for (const [date, d] of days) {
    const k = keyFn(date);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = {}));
    for (const m of metrics) {
      const v = d[m];
      if (v == null) continue;
      (g[m] ||= { s: 0, n: 0 });
      g[m].s += v;
      g[m].n++;
    }
  }
  return groups;
}

function workoutTotals(workouts, keyFn) {
  const out = new Map();
  for (const w of workouts) {
    const k = keyFn(w.date);
    const t = out.get(k) || { n: 0, min: 0 };
    t.n++;
    t.min += w.duration_min || 0;
    out.set(k, t);
  }
  return out;
}

const presentMetrics = (days, candidates = METRICS.map(m => m.key)) =>
  candidates.filter(k => [...days.values()].some(d => d[k] != null));

const colLabel = k => `${METRIC_BY_KEY[k].label} (${METRIC_BY_KEY[k].unit})`;

export function buildMarkdown({ dailyDays = 30, weeks = 26, workoutDays = 90 } = {}) {
  const range = db.prepare('SELECT MIN(date) first, MAX(date) last, COUNT(DISTINCT date) n FROM daily').get();
  const lines = [];
  const now = new Date();
  lines.push('# Personal health log (Apple Health)');
  lines.push('');
  if (!range.last) {
    lines.push('_No data imported yet._');
    return lines.join('\n');
  }
  const anchor = range.last < today() ? range.last : today();
  const all = loadDays();
  const workouts = db.prepare('SELECT * FROM workouts ORDER BY start').all();
  const lastExport = db.prepare("SELECT at FROM imports WHERE kind = 'export' ORDER BY at DESC LIMIT 1").get()?.at;
  const lastSync = db.prepare("SELECT at FROM imports WHERE kind = 'sync' ORDER BY at DESC LIMIT 1").get()?.at;

  lines.push(`Generated ${now.toLocaleString('sv')} local time. Data covers ${range.first} → ${range.last} (${range.n} days with data, ${workouts.length} workouts).`);
  lines.push(`Last Apple Health export import: ${lastExport ? lastExport.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}. Last live sync: ${lastSync ? lastSync.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}.`);
  lines.push('');
  lines.push('## How to read this');
  lines.push('- Each daily value is for one local calendar day. Totals (steps, energy, exercise, distance, food) are full-day sums; rates (heart rate, HRV, SpO₂) are daily means; body measurements are the last reading of the day.');
  lines.push('- Sleep is attributed to the date you woke up. Stages (deep/REM/core) need an Apple Watch on iOS 16+.');
  lines.push('- Weekly, monthly and period columns are **averages per day over days that have data**, not sums. Blank = no data.');
  lines.push(`- Rolling periods end on ${anchor}.`);
  lines.push('');

  const goals = getSetting('goals', '').trim();
  lines.push('## Goals & context (written by me)');
  lines.push(goals || '_Not set._');
  lines.push('');

  // Overview
  const present = presentMetrics(all);
  const p = (n, offset = 0) => [addDays(anchor, -(n * (offset + 1)) + 1), addDays(anchor, -n * offset)];
  const overview = present.map(k => {
    const [a7, b7] = p(7), [c7, d7] = p(7, 1), [a30, b30] = p(30), [c30, d30] = p(30, 1), [a90, b90] = p(90), [a365, b365] = p(365);
    const count = [...all.values()].filter(d => d[k] != null).length;
    return [METRIC_BY_KEY[k].label, METRIC_BY_KEY[k].unit,
      fmt(k, mean(all, k, a7, b7)), fmt(k, mean(all, k, c7, d7)),
      fmt(k, mean(all, k, a30, b30)), fmt(k, mean(all, k, c30, d30)),
      fmt(k, mean(all, k, a90, b90)), fmt(k, mean(all, k, a365, b365)),
      fmt(k, mean(all, k, '0000', '9999')), count];
  });
  lines.push('## Overview (daily averages)');
  lines.push(table(['Metric', 'Unit', 'Last 7d', 'Prev 7d', 'Last 30d', 'Prev 30d', 'Last 90d', 'Last 365d', 'All time', 'Days w/ data'], overview));
  lines.push('');

  // Daily detail
  const journal = new Map(db.prepare('SELECT date, text FROM journal').all().map(r => [r.date, r.text]));
  const dFrom = addDays(anchor, -dailyDays + 1);
  const recent = new Map([...all].filter(([d]) => d >= dFrom && d <= anchor));
  const dCols = presentMetrics(recent);
  const wByDate = new Map();
  for (const w of workouts) if (w.date >= dFrom) (wByDate.get(w.date) || wByDate.set(w.date, []).get(w.date)).push(w);
  const dRows = [];
  for (let d = anchor; d >= dFrom; d = addDays(d, -1)) {
    const v = recent.get(d) || {};
    const ws = (wByDate.get(d) || []).map(w => `${w.type} ${Math.round(w.duration_min || 0)}min`).join(', ');
    dRows.push([d, weekday(d), ...dCols.map(k => fmt(k, v[k])), ws, journal.get(d) || '']);
  }
  lines.push(`## Daily — last ${dailyDays} days (newest first)`);
  lines.push(table(['Date', 'Day', ...dCols.map(colLabel), 'Workouts', 'Journal'], dRows));
  lines.push('');

  // Weekly
  const coreCols = presentMetrics(all, CORE);
  const wFrom = weekStart(addDays(anchor, -(weeks - 1) * 7));
  const weekDays = new Map([...all].filter(([d]) => d >= wFrom));
  const wGroups = groupBy(weekDays, weekStart, coreCols);
  const wWork = workoutTotals(workouts.filter(w => w.date >= wFrom), weekStart);
  const wRows = [...wGroups.keys()].sort().reverse().map(k => {
    const g = wGroups.get(k), t = wWork.get(k);
    return [k, ...coreCols.map(m => fmt(m, g[m] ? g[m].s / g[m].n : null)), t ? `${t.n} / ${Math.round(t.min)}` : ''];
  });
  lines.push(`## Weekly averages — last ${weeks} weeks (week starts Monday, newest first)`);
  lines.push(table(['Week of', ...coreCols.map(colLabel), 'Workouts (count / min)'], wRows));
  lines.push('');

  // Monthly
  const mGroups = groupBy(all, d => d.slice(0, 7), coreCols);
  const mWork = workoutTotals(workouts, d => d.slice(0, 7));
  const mRows = [...mGroups.keys()].sort().reverse().map(k => {
    const g = mGroups.get(k), t = mWork.get(k);
    return [k, ...coreCols.map(m => fmt(m, g[m] ? g[m].s / g[m].n : null)), t ? `${t.n} / ${Math.round(t.min)}` : ''];
  });
  lines.push('## Monthly averages — full history (newest first)');
  lines.push(table(['Month', ...coreCols.map(colLabel), 'Workouts (count / min)'], mRows));
  lines.push('');

  // Workouts
  const woFrom = addDays(anchor, -workoutDays + 1);
  const woRows = workouts.filter(w => w.date >= woFrom).reverse().map(w => [
    w.start.slice(0, 16), w.type, w.duration_min?.toFixed(0) ?? '', w.distance_km?.toFixed(2) ?? '',
    w.energy_kcal?.toFixed(0) ?? '', w.avg_hr?.toFixed(0) ?? '', w.max_hr?.toFixed(0) ?? '',
  ]);
  lines.push(`## Workouts — last ${workoutDays} days`);
  lines.push(woRows.length ? table(['Start', 'Type', 'Duration (min)', 'Distance (km)', 'Active energy (kcal)', 'Avg HR', 'Max HR'], woRows) : '_None._');
  lines.push('');

  // Workout mix by type, last 365 days
  const yFrom = addDays(anchor, -364);
  const mix = new Map();
  for (const w of workouts) {
    if (w.date < yFrom) continue;
    const t = mix.get(w.type) || { n: 0, min: 0, km: 0 };
    t.n++; t.min += w.duration_min || 0; t.km += w.distance_km || 0;
    mix.set(w.type, t);
  }
  if (mix.size) {
    lines.push('## Workout mix — last 365 days');
    lines.push(table(['Type', 'Sessions', 'Total hours', 'Total km'],
      [...mix].sort((a, b) => b[1].n - a[1].n).map(([t, v]) => [t, v.n, (v.min / 60).toFixed(1), v.km ? v.km.toFixed(1) : ''])));
    lines.push('');
  }

  // Journal (older than the daily table)
  const older = [...journal].filter(([d]) => d < dFrom && d >= addDays(anchor, -365)).sort().reverse();
  if (older.length) {
    lines.push('## Earlier journal entries (last year)');
    for (const [d, t] of older) lines.push(`- ${d}: ${cell(t)}`);
    lines.push('');
  }

  return lines.join('\n');
}

const csvCell = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildDailyCsv() {
  const all = loadDays();
  const cols = presentMetrics(all);
  const journal = new Map(db.prepare('SELECT date, text FROM journal').all().map(r => [r.date, r.text]));
  const out = [['date', ...cols.map(k => `${k} [${METRIC_BY_KEY[k].unit}]`), 'journal'].join(',')];
  for (const [date, d] of all) out.push([date, ...cols.map(k => fmt(k, d[k])), csvCell(journal.get(date))].join(','));
  return out.join('\n') + '\n';
}

export function buildWorkoutsCsv() {
  const rows = db.prepare('SELECT start, end, type, duration_min, distance_km, energy_kcal, avg_hr, max_hr, source FROM workouts ORDER BY start').all();
  const head = ['start', 'end', 'type', 'duration_min', 'distance_km', 'active_energy_kcal', 'avg_hr', 'max_hr', 'source'];
  const out = [head.join(',')];
  for (const r of rows) {
    out.push([r.start, r.end, r.type, r.duration_min?.toFixed(1), r.distance_km?.toFixed(2), r.energy_kcal?.toFixed(0),
      r.avg_hr?.toFixed(0), r.max_hr?.toFixed(0), r.source].map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}

// Refreshes data/export/ so the latest files are always on disk, ready to attach to a chat.
export function writeExports() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXPORT_DIR, 'health_summary.md'), buildMarkdown());
  fs.writeFileSync(path.join(EXPORT_DIR, 'daily.csv'), buildDailyCsv());
  fs.writeFileSync(path.join(EXPORT_DIR, 'workouts.csv'), buildWorkoutsCsv());
}
