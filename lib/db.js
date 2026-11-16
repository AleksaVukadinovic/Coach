import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'health.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS daily (
    date       TEXT NOT NULL,          -- YYYY-MM-DD, local day the data was recorded
    metric     TEXT NOT NULL,          -- key from lib/metrics.js
    value      REAL NOT NULL,          -- canonical unit (see metrics.js)
    origin     TEXT NOT NULL,          -- 'export' | 'sync' | 'manual'
    updated_at TEXT NOT NULL,
    PRIMARY KEY (date, metric)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS workouts (
    id           TEXT PRIMARY KEY,     -- start time to the minute; dedupes export vs sync
    date         TEXT NOT NULL,
    start        TEXT NOT NULL,
    end          TEXT,
    type         TEXT NOT NULL,
    duration_min REAL,
    distance_km  REAL,
    energy_kcal  REAL,
    avg_hr       REAL,
    max_hr       REAL,
    source       TEXT,
    origin       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workouts_date ON workouts(date);

  CREATE TABLE IF NOT EXISTS journal (
    date TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS imports (
    id       INTEGER PRIMARY KEY,
    at       TEXT NOT NULL,
    kind     TEXT NOT NULL,            -- 'export' | 'sync'
    detail   TEXT,
    days     INTEGER,
    values_written INTEGER,
    workouts INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

  -- Strength sessions with exercise detail (from a Hevy CSV export), matched to workouts by start time
  CREATE TABLE IF NOT EXISTS strength_sessions (
    id          TEXT PRIMARY KEY,      -- local start "YYYY-MM-DD HH:MM"
    start       TEXT NOT NULL,
    end         TEXT,
    title       TEXT,
    description TEXT,
    source      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS strength_sets (
    session_id     TEXT NOT NULL,
    exercise_index INTEGER NOT NULL,   -- order of the exercise within the session
    exercise       TEXT NOT NULL,
    superset_id    TEXT,
    exercise_notes TEXT,
    set_index      INTEGER NOT NULL,
    set_type       TEXT,               -- normal | warmup | dropset | failure
    weight_kg      REAL,
    reps           REAL,
    distance_km    REAL,
    duration_s     REAL,
    rpe            REAL
  );
  CREATE INDEX IF NOT EXISTS strength_sets_session ON strength_sets(session_id);
`);

// Columns added after the first release
const workoutCols = new Set(db.prepare('PRAGMA table_info(workouts)').all().map(c => c.name));
if (!workoutCols.has('title')) db.exec('ALTER TABLE workouts ADD COLUMN title TEXT');
if (!workoutCols.has('hr_series')) db.exec('ALTER TABLE workouts ADD COLUMN hr_series TEXT'); // JSON [[seconds from start, bpm], ...]

const upsertDailyStmt = db.prepare(`
  INSERT INTO daily (date, metric, value, origin, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value, origin = excluded.origin, updated_at = excluded.updated_at
`);

const upsertWorkoutStmt = db.prepare(`
  INSERT INTO workouts (id, date, start, end, type, duration_min, distance_km, energy_kcal, avg_hr, max_hr, source, origin, title, hr_series)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    end = excluded.end, type = excluded.type, duration_min = excluded.duration_min,
    distance_km = COALESCE(excluded.distance_km, workouts.distance_km),
    energy_kcal = COALESCE(excluded.energy_kcal, workouts.energy_kcal),
    avg_hr = COALESCE(excluded.avg_hr, workouts.avg_hr),
    max_hr = COALESCE(excluded.max_hr, workouts.max_hr),
    title = COALESCE(excluded.title, workouts.title),
    hr_series = COALESCE(excluded.hr_series, workouts.hr_series),
    source = excluded.source, origin = excluded.origin
`);

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// rows: [{date, metric, value}]
export function writeDaily(rows, origin) {
  const now = new Date().toISOString();
  const days = new Set();
  transaction(() => {
    for (const r of rows) {
      if (r.value == null || !Number.isFinite(r.value)) continue;
      upsertDailyStmt.run(r.date, r.metric, r.value, origin, now);
      days.add(r.date);
    }
  });
  return days.size;
}

export function writeWorkouts(list, origin) {
  transaction(() => {
    for (const w of list) {
      upsertWorkoutStmt.run(
        w.start.slice(0, 16), w.start.slice(0, 10), w.start, w.end ?? null, w.type,
        w.duration_min ?? null, w.distance_km ?? null, w.energy_kcal ?? null,
        w.avg_hr ?? null, w.max_hr ?? null, w.source ?? null, origin,
        w.title ?? null, w.hr_series ? JSON.stringify(w.hr_series) : null,
      );
    }
  });
  dedupeWorkouts();
  return list.length;
}

// Wall-clock minutes of a "YYYY-MM-DD HH:MM..." string, ignoring the timezone suffix
export const wallMinutes = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
export const MATCH_WINDOW_MIN = 10;

// Hevy-only workouts are placeholders; drop them once Apple Health has the same session.
function dedupeWorkouts() {
  const hevy = db.prepare("SELECT id, start FROM workouts WHERE origin = 'hevy'").all();
  if (!hevy.length) return;
  const others = db.prepare("SELECT start FROM workouts WHERE origin != 'hevy'").all().map(w => wallMinutes(w.start));
  const del = db.prepare('DELETE FROM workouts WHERE id = ?');
  for (const h of hevy) {
    const t = wallMinutes(h.start);
    if (others.some(o => Math.abs(o - t) <= MATCH_WINDOW_MIN)) del.run(h.id);
  }
}

export function logImport(kind, detail, days, values, workouts) {
  db.prepare('INSERT INTO imports (at, kind, detail, days, values_written, workouts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, detail, days, values, workouts);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
