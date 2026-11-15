const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => Object.assign(document.createElement(tag), attrs, html ? { innerHTML: html } : {});
const SVG = 'http://www.w3.org/2000/svg';

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let meta = null;
let series = {}, prev = {}, workouts = [];
let range = store.get('range', '30');
let focus = store.get('focus', 'steps');

// ---------- dates & numbers ----------
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekStart = d => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5) + 1;
const fmtDay = (d, opts = { month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, opts);
const fmtMonth = d => new Date(d.slice(0, 7) + '-15T12:00:00').toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
const fmtNum = (v, dec = 0) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
const ago = iso => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const catColor = cat => `var(--c-${cat})`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2200);
}

// ---------- periods ----------
function bounds() {
  const to = meta.range.last;
  if (range === 'all') return { from: meta.range.first, to, prevFrom: null, prevTo: null, days: daysBetween(meta.range.first, to) };
  const n = Number(range);
  const from = addDays(to, -n + 1);
  const prevTo = addDays(from, -1);
  return { from, to, prevFrom: addDays(prevTo, -n + 1), prevTo, days: n };
}

function stat(m, pts) {
  if (!pts?.length) return null;
  if (m.agg === 'last') return pts[pts.length - 1][1];
  return pts.reduce((s, p) => s + p[1], 0) / pts.length;
}

function delta(m, cur, before) {
  if (cur == null || before == null) return null;
  const diff = cur - before;
  const usePct = m.agg === 'sum' && before > 0;
  const mag = usePct ? Math.abs(diff / before) * 100 : Math.abs(diff);
  const flat = usePct ? mag < 1 : mag < 0.5 * 10 ** -m.decimals;
  const cls = flat || !m.better ? 'flat' : (diff > 0) === (m.better === 'up') ? 'good' : 'bad';
  const arrow = flat ? '→' : diff > 0 ? '↑' : '↓';
  const text = usePct ? `${mag.toFixed(0)}%` : `${mag.toFixed(m.decimals)} ${m.unit}`;
  return { cls, html: `<span class="delta ${cls}">${arrow} ${text}</span>` };
}

// Daily points -> day / week / month buckets depending on the span
function bucketUnit(days) { return days <= 120 ? 'day' : days <= 800 ? 'week' : 'month'; }
function bucket(pts, unit) {
  if (unit === 'day') return pts;
  const key = unit === 'week' ? weekStart : d => d.slice(0, 7) + '-01';
  const g = new Map();
  for (const [d, v] of pts) {
    const k = key(d);
    const a = g.get(k) || [0, 0];
    a[0] += v; a[1]++;
    g.set(k, a);
  }
  return [...g].map(([k, [s, n]]) => [k, s / n]);
}
function xKeys(unit, from, to, ...lists) {
  if (unit === 'day') {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  return [...new Set(lists.flat().map(p => p[0]))].sort();
}

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= step0);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

// ---------- charts ----------
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function roundedBar(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const tooltip = $('#tooltip');
function showTip(x, y, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const w = tooltip.offsetWidth / 2;
  tooltip.style.left = Math.min(Math.max(x, w + 8), innerWidth - w - 8) + 'px';
  tooltip.style.top = Math.max(y, tooltip.offsetHeight + 20) + 'px';
}
const hideTip = () => (tooltip.hidden = true);

/**
 * layers: [{ key, label, color, pts:[[date,v]], kind:'bar'|'line', stack?:true, thin?:true }]
 */
function drawChart(container, { layers, keys, unit, m, zeroBased }) {
  container.innerHTML = '';
  const W = container.clientWidth, H = container.clientHeight;
  if (W < 100) return;
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${m.label} chart` });
  container.append(root);
  if (!keys.length) return;

  const idx = new Map(keys.map((k, i) => [k, i]));
  const maps = layers.map(l => new Map(l.pts));
  const stacks = layers.filter(l => l.stack);
  let lo = Infinity, hi = -Infinity;
  for (const k of keys) {
    let s = 0;
    for (const l of stacks) s += new Map(l.pts).get(k) || 0;
    if (stacks.length) hi = Math.max(hi, s);
  }
  layers.forEach((l, i) => { if (!l.stack) for (const [, v] of l.pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
  if (zeroBased || stacks.length) lo = 0;
  else { const padv = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1; lo -= padv; hi += padv; }
  if (!Number.isFinite(hi)) return;
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const Y = v => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const band = iw / keys.length;
  const X = i => pad.l + band * i + band / 2;

  const axis = svg('g', { class: 'axis' });
  for (const t of ticks) {
    axis.append(svg('line', { class: 'gridline', x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t) }));
    const tx = svg('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' });
    tx.textContent = Math.abs(t) >= 10000 ? `${t / 1000}k` : fmtNum(t, Number.isInteger(t) ? 0 : 1);
    axis.append(tx);
  }
  const labelEvery = Math.max(1, Math.ceil(keys.length / Math.max(2, Math.floor(iw / 80))));
  keys.forEach((k, i) => {
    if ((keys.length - 1 - i) % labelEvery) return;
    const tx = svg('text', { x: X(i), y: H - 6, 'text-anchor': 'middle' });
    tx.textContent = unit === 'month' ? fmtMonth(k) : fmtDay(k);
    axis.append(tx);
  });
  root.append(axis);

  const barW = Math.max(2, Math.min(28, band - 2));
  const base = new Array(keys.length).fill(0);
  layers.forEach((l, li) => {
    const g = svg('g');
    if (l.kind === 'bar') {
      for (const [k, v] of l.pts) {
        const i = idx.get(k);
        if (i == null || !(v > 0)) continue;
        const b = l.stack ? base[i] : 0;
        const top = Y(b + v), bottom = Y(b);
        // 2px surface gap between stacked segments; only the topmost segment is rounded
        const isTop = !l.stack || !stacks.slice(stacks.indexOf(l) + 1).some(s => (maps[layers.indexOf(s)].get(k) || 0) > 0);
        const h = bottom - top - (l.stack && b > 0 ? 2 : 0);
        g.append(svg('path', { d: isTop ? roundedBar(X(i) - barW / 2, top, barW, h) : `M${X(i) - barW / 2},${top}h${barW}v${h}h${-barW}Z`, fill: l.color, opacity: l.faded ? 0.35 : 1 }));
        if (l.stack) base[i] += v;
      }
    } else {
      let d = '', pen = false;
      keys.forEach((k, i) => {
        const v = maps[li].get(k);
        if (v == null) { pen = l.bridge ? pen : false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      g.append(svg('path', { d, fill: 'none', stroke: l.color, 'stroke-width': l.thin ? 1.5 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': l.dashed ? '4 3' : '' }));
      if (l.dots) {
        for (const [k, v] of l.pts) {
          const i = idx.get(k);
          if (i != null) g.append(svg('circle', { cx: X(i), cy: Y(v), r: 3, fill: l.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
        }
      }
    }
    root.append(g);
  });

  // hover layer
  const cross = svg('line', { class: 'crosshair', y1: pad.t, y2: pad.t + ih, visibility: 'hidden' });
  const marker = svg('circle', { r: 5, fill: layers.find(l => !l.stack && l.kind === 'line' && !l.thin)?.color || 'none', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  root.append(cross, marker);
  const hit = svg('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' });
  root.append(hit);
  hit.addEventListener('mousemove', e => {
    const r = root.getBoundingClientRect();
    const i = Math.max(0, Math.min(keys.length - 1, Math.floor((e.clientX - r.left - pad.l) / band)));
    const k = keys[i];
    const vals = layers.map((l, li) => [l, maps[li].get(k)]).filter(([, v]) => v != null);
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    const main = layers.findIndex(l => l.kind === 'line' && !l.thin);
    const mv = main >= 0 ? maps[main].get(k) : null;
    if (mv != null) { marker.setAttribute('cx', X(i)); marker.setAttribute('cy', Y(mv)); marker.setAttribute('visibility', 'visible'); }
    else marker.setAttribute('visibility', 'hidden');
    const label = unit === 'day' ? fmtDay(k, { weekday: 'short', month: 'short', day: 'numeric' })
      : unit === 'week' ? `Week of ${fmtDay(k)}` : fmtMonth(k);
    const rows = vals.length
      ? vals.map(([l, v]) => `<div class="tt-row"><span>${l.label}</span><b>${fmtNum(v, m.decimals)} ${m.unit}</b></div>`).join('')
      : '<div>No data</div>';
    const total = stacks.length > 1 ? stacks.reduce((s, l) => s + (maps[layers.indexOf(l)].get(k) || 0), 0) : null;
    showTip(r.left + X(i) * (r.width / W), r.top + pad.t, `<div class="tt-date">${label}${unit !== 'day' ? ' · daily avg' : ''}</div>${rows}${total ? `<div class="tt-row"><span>Total</span><b>${fmtNum(total, m.decimals)} ${m.unit}</b></div>` : ''}`);
  });
  hit.addEventListener('mouseleave', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); marker.setAttribute('visibility', 'hidden'); });
}

function sparkline(pts, color) {
  const w = 200, h = 34;
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  if (pts.length < 2) return s;
  const vs = pts.map(p => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((p[1] - lo) / span) * (h - 6)).toFixed(1)}`).join('');
  s.append(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.75, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return s;
}

function rolling(pts, keys, n = 7) {
  const map = new Map(pts);
  const out = [];
  keys.forEach((k, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { const v = map.get(keys[j]); if (v != null) { s += v; c++; } }
    if (c >= Math.min(3, i + 1)) out.push([k, s / c]);
  });
  return out;
}

// ---------- rendering ----------
const metricByKey = () => Object.fromEntries(meta.metrics.map(m => [m.key, m]));

function renderFocus() {
  const M = metricByKey();
  if (!M[focus]) focus = M.steps ? 'steps' : meta.metrics[0].key;
  const m = M[focus];
  const b = bounds();
  const unit = bucketUnit(b.days);
  const cat = meta.categories.find(c => c.key === m.category);
  const color = catColor(m.category);
  const pts = series[m.key] || [];
  const cur = stat(m, pts), before = stat(m, prev[m.key]);
  const dl = delta(m, cur, before);

  $('#focus-cat').textContent = cat?.label || '';
  $('#focus-title').textContent = m.label;
  $('#focus-value').textContent = fmtNum(cur, m.decimals);
  $('#focus-unit').textContent = m.unit;
  $('#focus-delta').innerHTML = `${m.agg === 'last' ? 'latest' : m.agg === 'sum' ? 'daily average' : 'average'}${dl ? ` · ${dl.html} vs previous ${range === 'all' ? '' : range + ' days'}` : ''}`;

  let layers, keys, legend = [];
  if (m.key === 'sleep_total' && (series.sleep_deep?.length || series.sleep_rem?.length)) {
    const stages = [
      { key: 'sleep_deep', label: 'Deep', color: 'var(--sleep-deep)' },
      { key: 'sleep_core', label: 'Core', color: 'var(--sleep-core)' },
      { key: 'sleep_rem', label: 'REM', color: 'var(--sleep-rem)' },
    ].map(s => ({ ...s, kind: 'bar', stack: true, pts: bucket(series[s.key] || [], unit) }));
    // Sleep without stage data (older nights / other apps)
    const staged = new Map();
    for (const s of stages) for (const [k, v] of s.pts) staged.set(k, (staged.get(k) || 0) + v);
    const other = bucket(pts, unit).map(([k, v]) => [k, v - (staged.get(k) || 0)]).filter(([, v]) => v > 0.05);
    if (other.length) stages.push({ key: 'other', label: 'Unstaged', color: 'var(--text-3)', kind: 'bar', stack: true, pts: other });
    keys = xKeys(unit, b.from, b.to, ...stages.map(s => s.pts));
    layers = stages;
    legend = stages.map(s => [s.label, s.color]);
  } else if (m.agg === 'sum') {
    const bp = bucket(pts, unit);
    keys = xKeys(unit, b.from, b.to, bp);
    layers = [{ key: m.key, label: unit === 'day' ? m.label : 'Daily avg', color, kind: 'bar', pts: bp }];
    if (unit === 'day' && b.days > 14) {
      layers.push({ key: 'avg', label: '7-day avg', color: 'var(--text-2)', kind: 'line', thin: true, pts: rolling(pts, keys) });
      legend = [[m.label, color], ['7-day average', 'var(--text-2)']];
    }
  } else {
    const bp = bucket(pts, unit);
    keys = xKeys(unit, b.from, b.to, bp);
    layers = [{ key: m.key, label: m.label, color, kind: 'line', bridge: true, dots: bp.length <= 45, pts: bp }];
  }
  $('#focus-legend').innerHTML = legend.map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
  drawChart($('#focus-chart'), { layers, keys, unit, m, zeroBased: m.agg === 'sum' });
}

function renderCards() {
  const b = bounds();
  const unit = bucketUnit(b.days);
  const wrap = $('#sections');
  wrap.innerHTML = '';
  for (const cat of meta.categories) {
    const ms = meta.metrics.filter(m => m.category === cat.key);
    if (!ms.length) continue;
    const sec = el('section', { className: 'section' });
    sec.append(el('h2', { className: 'section-title' }, `<span class="dot" style="background:${catColor(cat.key)}"></span>${cat.label}`));
    const grid = el('div', { className: 'grid' });
    for (const m of ms) {
      const pts = series[m.key] || [];
      const cur = stat(m, pts);
      const dl = delta(m, cur, stat(m, prev[m.key]));
      const card = el('button', { className: 'metric' + (m.key === focus ? ' active' : ''), type: 'button' });
      card.innerHTML = `
        <span class="label">${m.label}</span>
        <span class="value">${fmtNum(cur, m.decimals)}<span class="unit">${m.unit}</span></span>
        <span class="meta"><span>${m.agg === 'last' ? 'latest' : m.agg === 'sum' ? 'avg / day' : 'average'}</span>${dl ? dl.html : ''}</span>`;
      card.append(sparkline(bucket(pts, unit === 'day' && b.days > 60 ? 'week' : unit), catColor(m.category)));
      card.addEventListener('click', () => {
        focus = m.key;
        store.set('focus', focus);
        renderFocus();
        document.querySelectorAll('.metric.active').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        $('#focus').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      grid.append(card);
    }
    sec.append(grid);
    wrap.append(sec);
  }
}

function renderWorkouts() {
  const totalMin = workouts.reduce((s, w) => s + (w.duration_min || 0), 0);
  $('#workout-summary').textContent = workouts.length ? `${workouts.length} sessions · ${(totalMin / 60).toFixed(1)} h` : '';
  const mix = new Map();
  for (const w of workouts) mix.set(w.type, (mix.get(w.type) || 0) + 1);
  $('#workout-mix').innerHTML = [...mix].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `<span class="chip"><b>${n}</b> ${t}</span>`).join('');
  const list = $('#workout-list');
  list.innerHTML = workouts.length ? '' : '<li class="muted">No workouts in this period.</li>';
  for (const w of workouts.slice(0, 80)) {
    const bits = [
      w.duration_min ? `${Math.round(w.duration_min)} min` : null,
      w.distance_km ? `${w.distance_km.toFixed(1)} km` : null,
      w.energy_kcal ? `${Math.round(w.energy_kcal)} kcal` : null,
    ].filter(Boolean).join(' · ');
    const hr = w.avg_hr ? `♥ ${Math.round(w.avg_hr)}${w.max_hr ? ` / ${Math.round(w.max_hr)}` : ''} bpm` : '';
    list.append(el('li', {}, `<div><div class="title">${w.type}</div><div class="subtle">${fmtDay(w.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${w.start.slice(11, 16)}</div></div><div class="right">${bits}<div class="subtle">${hr}</div></div>`));
  }
}

async function renderJournal() {
  const entries = await api('/api/journal?limit=30');
  const list = $('#journal-list');
  list.innerHTML = entries.length ? '' : '<li class="muted">Notes give Claude context the numbers can’t — illness, stress, travel.</li>';
  for (const e of entries) {
    const li = el('li', {}, `<span class="date">${fmtDay(e.date, { month: 'short', day: 'numeric', year: '2-digit' })}</span><span class="text"></span><button class="icon-btn" title="Delete" aria-label="Delete">✕</button>`);
    li.querySelector('.text').textContent = e.text;
    li.querySelector('.text').addEventListener('click', () => { $('#journal-date').value = e.date; $('#journal-text').value = e.text; $('#journal-text').focus(); });
    li.querySelector('button').addEventListener('click', async () => { await api(`/api/journal/${e.date}`, { method: 'DELETE' }); renderJournal(); });
    list.append(li);
  }
}

function renderStatus() {
  const parts = [];
  if (meta.range.days) parts.push(`${meta.range.days.toLocaleString()} days of data`);
  const last = [meta.lastSync, meta.lastExport].filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (last) parts.push(`updated ${ago(last.at)}${meta.lastSync === last ? ' via sync' : ''}`);
  $('#status').textContent = parts.join(' · ') || 'No data yet';
}

async function loadRange() {
  const b = bounds();
  document.querySelectorAll('#ranges button').forEach(x => x.setAttribute('aria-selected', x.dataset.range === range));
  $('#period').textContent = `${fmtDay(b.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDay(b.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const [{ series: all }, ws] = await Promise.all([
    api(`/api/daily?from=${b.prevFrom || b.from}&to=${b.to}`),
    api(`/api/workouts?from=${b.from}&to=${b.to}`),
  ]);
  series = {}; prev = {};
  for (const [k, pts] of Object.entries(all)) {
    series[k] = pts.filter(p => p[0] >= b.from);
    prev[k] = b.prevFrom ? pts.filter(p => p[0] <= b.prevTo) : [];
  }
  workouts = ws;
  renderFocus();
  renderCards();
  renderWorkouts();
}

async function load() {
  meta = await api('/api/meta');
  renderStatus();
  const hasData = !!meta.range.last;
  $('#empty').hidden = hasData;
  $('#dash').hidden = !hasData;
  if (!hasData) return;
  await loadRange();
  renderJournal();
  $('#journal-date').value ||= new Date().toLocaleDateString('sv');
  $('#export-dir').textContent = meta.exportDir;
}

// ---------- interactions ----------
$('#ranges').addEventListener('click', e => {
  const r = e.target.closest('button')?.dataset.range;
  if (!r || r === range) return;
  range = r;
  store.set('range', range);
  loadRange();
});

let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => meta?.range.last && renderFocus(), 120); });

// goals
api('/api/goals').then(g => ($('#goals').value = g.text || ''));
let goalsT;
const saveGoals = async () => {
  await api('/api/goals', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('#goals').value }) });
  $('#goals-saved').textContent = 'Saved';
  setTimeout(() => ($('#goals-saved').textContent = ''), 1500);
};
$('#goals').addEventListener('input', () => { clearTimeout(goalsT); goalsT = setTimeout(saveGoals, 800); });

// journal
$('#journal-form').addEventListener('submit', async e => {
  e.preventDefault();
  const date = $('#journal-date').value, text = $('#journal-text').value.trim();
  if (!date || !text) return;
  await api(`/api/journal/${date}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  $('#journal-text').value = '';
  renderJournal();
  toast('Journal saved');
});

// import
const importDlg = $('#import-dialog');
const openImport = () => { $('#progress').hidden = true; importDlg.showModal(); };
$('#btn-import').addEventListener('click', openImport);
$('#btn-import-empty').addEventListener('click', openImport);
$('#file').addEventListener('change', e => e.target.files[0] && upload(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && !importDlg.open) { openImport(); upload(f); }
});

function setProgress(pct, text) {
  $('#progress').hidden = false;
  $('#progress-bar').style.width = `${pct}%`;
  $('#progress-text').textContent = text;
}

function upload(file) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/import');
  xhr.upload.onprogress = e => e.lengthComputable && setProgress((e.loaded / e.total) * 40, `Uploading ${(e.loaded / 1e6).toFixed(0)} / ${(e.total / 1e6).toFixed(0)} MB`);
  xhr.onload = () => {
    if (xhr.status >= 300) return setProgress(0, `Upload failed: ${xhr.responseText}`);
    poll();
  };
  xhr.onerror = () => setProgress(0, 'Upload failed: can’t reach the Coach server. Run “npm start” and open http://localhost:4242');
  setProgress(1, 'Uploading…');
  xhr.send(file);
}

async function poll() {
  const s = await api('/api/import/status');
  if (s.state === 'running') {
    const pct = s.total ? 40 + (s.bytes / s.total) * 58 : 60;
    setProgress(pct, `Reading health records… ${(s.records || 0).toLocaleString()}`);
    return setTimeout(poll, 600);
  }
  if (s.state === 'error') return setProgress(0, `Import failed: ${s.error}`);
  if (s.state === 'done') {
    setProgress(100, `Done · ${s.records.toLocaleString()} records → ${s.days} days, ${s.workouts} workouts`);
    await load();
    setTimeout(() => importDlg.close(), 1400);
  }
}

// Claude export
const claudeDlg = $('#claude-dialog');
let markdown = '';
async function loadSummary() {
  const days = $('#claude-days').value;
  markdown = await fetch(`/api/export/summary.md?dailyDays=${days}`).then(r => r.text());
  $('#claude-preview').textContent = markdown;
  $('#claude-size').textContent = `${markdown.length.toLocaleString()} chars · ~${Math.round(markdown.length / 3.5 / 1000)}k tokens`;
  $('#dl-md').href = `/api/export/summary.md?dailyDays=${days}&download=1`;
}
$('#btn-claude').addEventListener('click', () => { claudeDlg.showModal(); loadSummary(); });
$('#claude-days').addEventListener('change', loadSummary);

const COACH_PROMPT = `You are my personal health and fitness coach. Below is a log exported from my Apple Health data (Markdown tables; definitions are at the top, my goals and journal notes are included).

Please:
1. Summarise how I'm trending over the last 30 and 90 days compared with before.
2. Point out anything notable or concerning — sleep, recovery (resting HR, HRV), activity consistency, body composition.
3. Relate it to my goals and journal notes.
4. Suggest 2–3 concrete focus areas for the next two weeks.
Ask me questions if anything is ambiguous rather than guessing.

---

`;
async function copy(text, msg) {
  await navigator.clipboard.writeText(text);
  toast(msg);
}
$('#copy-md').addEventListener('click', () => copy(markdown, 'Summary copied'));
$('#copy-prompt').addEventListener('click', () => copy(COACH_PROMPT + markdown, 'Copied with coach prompt'));

load().catch(e => {
  const offline = location.protocol === 'file:' || e instanceof TypeError;
  $('#status').textContent = offline ? 'Server not running. Run “npm start”, then open http://localhost:4242' : `Error: ${e.message}`;
  $('#empty').hidden = false;
});
