import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db, DATA_DIR, getSetting, setSetting } from './lib/db.js';
import { METRICS, CATEGORIES } from './lib/metrics.js';
import { importExport } from './lib/importExport.js';
import { ingestHealthAutoExport } from './lib/ingest.js';
import { buildMarkdown, buildDailyCsv, buildWorkoutsCsv, writeExports, EXPORT_DIR } from './lib/exporter.js';

const PORT = Number(process.env.PORT || 4242);
const HOST = process.env.HOST || '127.0.0.1';
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const PUBLIC = path.join(import.meta.dirname, 'public');
const UPLOADS = path.join(DATA_DIR, 'uploads');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

let importState = { state: 'idle' };

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readJson(req, limit = 256 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const isLoopback = addr => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

function refreshExports() {
  try { writeExports(); } catch (e) { console.error('Export refresh failed:', e); }
}

function meta() {
  const range = db.prepare('SELECT MIN(date) first, MAX(date) last, COUNT(DISTINCT date) days FROM daily').get();
  const present = new Set(db.prepare('SELECT DISTINCT metric FROM daily').all().map(r => r.metric));
  const last = kind => db.prepare('SELECT at, detail, days, workouts FROM imports WHERE kind = ? ORDER BY at DESC LIMIT 1').get(kind) || null;
  return {
    metrics: METRICS.filter(m => present.has(m.key)).map(({ key, label, unit, category, agg, better, decimals }) => ({ key, label, unit, category, agg, better, decimals })),
    categories: CATEGORIES,
    range,
    workouts: db.prepare('SELECT COUNT(*) n FROM workouts').get().n,
    lastExport: last('export'),
    lastSync: last('sync'),
    exportDir: EXPORT_DIR,
    syncProtected: !!SYNC_TOKEN,
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);

  if (p === '/api/meta') return send(res, 200, meta());

  if (p === '/api/daily') {
    const rows = db.prepare('SELECT date, metric, value FROM daily WHERE date BETWEEN ? AND ? ORDER BY date')
      .all(q.from || '0000-00-00', q.to || '9999-99-99');
    const series = {};
    for (const r of rows) (series[r.metric] ||= []).push([r.date, r.value]);
    return send(res, 200, { series });
  }

  if (p === '/api/workouts') {
    return send(res, 200, db.prepare('SELECT * FROM workouts WHERE date BETWEEN ? AND ? ORDER BY start DESC')
      .all(q.from || '0000-00-00', q.to || '9999-99-99'));
  }

  if (p === '/api/import' && req.method === 'POST') {
    if (importState.state === 'running') return send(res, 409, { error: 'An import is already running' });
    fs.mkdirSync(UPLOADS, { recursive: true });
    const file = path.join(UPLOADS, `upload-${Date.now()}`);
    importState = { state: 'uploading', bytes: 0 };
    await pipeline(req, fs.createWriteStream(file));
    importState = { state: 'running', bytes: 0, records: 0, started: Date.now() };
    send(res, 202, { ok: true });
    importExport(file, prog => { importState = { ...importState, ...prog }; })
      .then(result => { importState = { state: 'done', ...result }; refreshExports(); })
      .catch(e => { console.error(e); importState = { state: 'error', error: e.message }; })
      .finally(() => fs.rm(file, { force: true }, () => {}));
    return;
  }

  if (p === '/api/import/status') return send(res, 200, importState);

  if (p === '/api/ingest' && req.method === 'POST') {
    const result = ingestHealthAutoExport(await readJson(req));
    refreshExports();
    console.log(`[sync] ${result.points} points → ${result.values} daily values, ${result.workouts} workouts`);
    return send(res, 200, { ok: true, ...result });
  }

  if (p === '/api/goals') {
    if (req.method === 'PUT') {
      setSetting('goals', String((await readJson(req)).text ?? ''));
      refreshExports();
    }
    return send(res, 200, { text: getSetting('goals', '') });
  }

  if (p === '/api/journal' && req.method === 'GET') {
    return send(res, 200, db.prepare('SELECT date, text FROM journal ORDER BY date DESC LIMIT ?').all(Number(q.limit) || 60));
  }

  const jm = /^\/api\/journal\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (jm) {
    if (req.method === 'PUT') {
      const text = String((await readJson(req)).text ?? '').trim();
      if (text) db.prepare('INSERT INTO journal (date, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at').run(jm[1], text, new Date().toISOString());
      else db.prepare('DELETE FROM journal WHERE date = ?').run(jm[1]);
    } else if (req.method === 'DELETE') {
      db.prepare('DELETE FROM journal WHERE date = ?').run(jm[1]);
    }
    refreshExports();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/export/summary.md') {
    const opts = { dailyDays: Number(q.dailyDays) || 30, weeks: Number(q.weeks) || 26, workoutDays: Number(q.workoutDays) || 90 };
    const disp = q.download ? { 'Content-Disposition': 'attachment; filename="health_summary.md"' } : {};
    return send(res, 200, buildMarkdown(opts), 'text/markdown; charset=utf-8', disp);
  }
  if (p === '/api/export/daily.csv') return send(res, 200, buildDailyCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="daily.csv"' });
  if (p === '/api/export/workouts.csv') return send(res, 200, buildWorkoutsCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="workouts.csv"' });

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // When exposed on the LAN (for phone sync), only the ingest endpoint is reachable from other devices.
    if (!isLoopback(req.socket.remoteAddress)) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-sync-token'] || url.searchParams.get('token');
      if (url.pathname !== '/api/ingest' || !SYNC_TOKEN || token !== SYNC_TOKEN) return send(res, 403, { error: 'Forbidden' });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  refreshExports();
  console.log(`Coach running at http://localhost:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  if (HOST !== '127.0.0.1') console.log(`Phone sync endpoint: http://<this-mac-ip>:${PORT}/api/ingest ${SYNC_TOKEN ? '(token required)' : '(disabled: set SYNC_TOKEN)'}`);
});
