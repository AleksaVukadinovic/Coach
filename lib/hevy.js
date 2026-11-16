// Imports a Hevy workout CSV export (Hevy → Profile → Settings → Export & Import Data → Export workouts).
// Hevy only writes title, duration and calories to Apple Health; the CSV carries every exercise and set.

import fs from 'node:fs';
import { db, transaction, writeWorkouts, logImport, wallMinutes, MATCH_WINDOW_MIN } from './db.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export const looksLikeHevyCsv = head => /exercise_title/.test(head) && /start_time/.test(head);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');

// "16 Nov 2025, 12:04" | "2025-11-16 12:04:00" | "2025-11-16T12:04:00Z" -> "2025-11-16 12:04"
function hevyTime(s) {
  if (!s) return null;
  let m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]} ${m[2]}`;
  m = /^(\d{1,2}) (\w{3})\w* (\d{4}),? (\d{1,2}):(\d{2})/.exec(s.trim());
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])} ${pad(m[4])}:${m[5]}`;
  return null;
}

const num = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function importHevyCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  const head = rows.shift().map(h => h.trim());
  const col = name => head.indexOf(name);
  const get = (r, name) => (col(name) >= 0 ? r[col(name)] : undefined);
  if (col('exercise_title') < 0) throw new Error('This CSV doesn’t look like a Hevy workout export.');

  const sessions = new Map();
  for (const r of rows) {
    const start = hevyTime(get(r, 'start_time'));
    if (!start) continue;
    let s = sessions.get(start);
    if (!s) sessions.set(start, (s = { id: start, start, end: hevyTime(get(r, 'end_time')), title: get(r, 'title') || 'Workout', description: get(r, 'description') || '', sets: [], lastExercise: null, exerciseIndex: -1 }));
    const exercise = get(r, 'exercise_title') || 'Exercise';
    if (exercise !== s.lastExercise) { s.exerciseIndex++; s.lastExercise = exercise; }
    const lbs = num(get(r, 'weight_lbs')), miles = num(get(r, 'distance_miles'));
    s.sets.push({
      exercise_index: s.exerciseIndex,
      exercise,
      superset_id: get(r, 'superset_id') || null,
      exercise_notes: get(r, 'exercise_notes') || null,
      set_index: num(get(r, 'set_index')) ?? s.sets.filter(x => x.exercise_index === s.exerciseIndex).length,
      set_type: get(r, 'set_type') || 'normal',
      weight_kg: num(get(r, 'weight_kg')) ?? (lbs != null ? lbs * 0.45359237 : null),
      reps: num(get(r, 'reps')),
      distance_km: num(get(r, 'distance_km')) ?? (miles != null ? miles * 1.609344 : null),
      duration_s: num(get(r, 'duration_seconds')),
      rpe: num(get(r, 'rpe')),
    });
  }

  const insSession = db.prepare('INSERT INTO strength_sessions (id, start, end, title, description, source) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET end = excluded.end, title = excluded.title, description = excluded.description');
  const delSets = db.prepare('DELETE FROM strength_sets WHERE session_id = ?');
  const insSet = db.prepare('INSERT INTO strength_sets (session_id, exercise_index, exercise, superset_id, exercise_notes, set_index, set_type, weight_kg, reps, distance_km, duration_s, rpe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let setCount = 0;
  transaction(() => {
    for (const s of sessions.values()) {
      insSession.run(s.id, s.start, s.end, s.title, s.description, 'Hevy');
      delSets.run(s.id);
      for (const x of s.sets) {
        insSet.run(s.id, x.exercise_index, x.exercise, x.superset_id, x.exercise_notes, x.set_index, x.set_type, x.weight_kg, x.reps, x.distance_km, x.duration_s, x.rpe);
        setCount++;
      }
    }
  });

  // Sessions Apple Health doesn't know about (e.g. logged before Hevy was connected) still show up as workouts.
  const known = db.prepare('SELECT start FROM workouts').all().map(w => wallMinutes(w.start));
  const missing = [...sessions.values()].filter(s => !known.some(t => Math.abs(t - wallMinutes(s.start)) <= MATCH_WINDOW_MIN));
  writeWorkouts(missing.map(s => ({
    start: `${s.start}:00`,
    end: s.end ? `${s.end}:00` : null,
    type: 'Traditional Strength Training',
    title: s.title,
    source: 'Hevy',
    duration_min: s.end ? wallMinutes(s.end) - wallMinutes(s.start) : null,
  })), 'hevy');

  logImport('hevy', `${setCount} sets`, null, null, sessions.size);
  return { sessions: sessions.size, sets: setCount, addedWorkouts: missing.length };
}

// Strength session (with sets grouped by exercise) closest to a workout's start, if any
export function sessionForWorkout(start) {
  const t = wallMinutes(start);
  const day = start.slice(0, 10);
  const candidates = db.prepare('SELECT * FROM strength_sessions WHERE substr(start, 1, 10) BETWEEN ? AND ?')
    .all(addDay(day, -1), addDay(day, 1));
  const best = candidates
    .map(s => ({ s, d: Math.abs(wallMinutes(s.start) - t) }))
    .filter(x => x.d <= MATCH_WINDOW_MIN)
    .sort((a, b) => a.d - b.d)[0]?.s;
  if (!best) return null;
  const sets = db.prepare('SELECT * FROM strength_sets WHERE session_id = ? ORDER BY exercise_index, set_index').all(best.id);
  return { ...best, exercises: groupExercises(sets) };
}

export function groupExercises(sets) {
  const out = [];
  for (const x of sets) {
    let e = out[out.length - 1];
    if (!e || e.index !== x.exercise_index) out.push((e = { index: x.exercise_index, name: x.exercise, notes: x.exercise_notes, superset_id: x.superset_id, sets: [] }));
    e.sets.push({ type: x.set_type, weight_kg: x.weight_kg, reps: x.reps, distance_km: x.distance_km, duration_s: x.duration_s, rpe: x.rpe });
  }
  return out;
}

// Ids of workouts that have exercise detail, for list badges
export function workoutIdsWithSets(workouts) {
  const sessions = db.prepare('SELECT start FROM strength_sessions').all().map(s => wallMinutes(s.start));
  if (!sessions.length) return new Set();
  return new Set(workouts.filter(w => sessions.some(t => Math.abs(t - wallMinutes(w.start)) <= MATCH_WINDOW_MIN)).map(w => w.id));
}

// Epley estimated one-rep max
export const e1rm = (kg, reps) => (kg > 0 && reps > 0 ? (reps === 1 ? kg : kg * (1 + reps / 30)) : null);

function addDay(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
