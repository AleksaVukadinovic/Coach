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
`);

const upsertDailyStmt = db.prepare(`
  INSERT INTO daily (date, metric, value, origin, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value, origin = excluded.origin, updated_at = excluded.updated_at
`);

const upsertWorkoutStmt = db.prepare(`
  INSERT INTO workouts (id, date, start, end, type, duration_min, distance_km, energy_kcal, avg_hr, max_hr, source, origin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    end = excluded.end, type = excluded.type, duration_min = excluded.duration_min,
    distance_km = COALESCE(excluded.distance_km, workouts.distance_km),
    energy_kcal = COALESCE(excluded.energy_kcal, workouts.energy_kcal),
    avg_hr = COALESCE(excluded.avg_hr, workouts.avg_hr),
    max_hr = COALESCE(excluded.max_hr, workouts.max_hr),
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
      );
    }
  });
  return list.length;
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
