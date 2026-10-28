// Hand-built SVG charts. No library: the shapes are simple and this keeps the
// page fast on phones, which is where most people check their case.

import { addDays, daysBetween } from './dates.js';
import { category, clockStart, days, decidedOn } from './stats.js';

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

function text(parent, x, y, str, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
export const fmtDate = (iso) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : '—');

const linear = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function monthStarts(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    const iso = `${y}-${String(m).padStart(2, '0')}-01`;
    if (iso > to) return out;
    out.push(iso);
  }
}

const SERIES = { opt: 'var(--series-1)', stem: 'var(--series-2)', premium: 'var(--series-3)' };

function marker(parent, cat, x, y, filled) {
  const color = SERIES[cat];
  const common = { 'stroke-width': 2 };
  if (cat === 'premium') {
    const s = 5.5;
    return el('path', {
      d: `M${x} ${y - s}L${x + s} ${y}L${x} ${y + s}L${x - s} ${y}Z`,
      fill: filled ? color : 'var(--surface)',
      stroke: filled ? 'var(--surface)' : color,
      ...common,
    }, parent);
  }
  return el('circle', { cx: x, cy: y, r: filled ? 4.5 : 3.5, fill: filled ? color : 'var(--surface)', stroke: filled ? 'var(--surface)' : color, ...common }, parent);
}

// One tooltip per chart wrapper. Content is built with textContent only:
// everything shown comes from Reddit comments and is untrusted.
function tooltip(wrap) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  return {
    show(rows, x, y) {
      tip.replaceChildren();
      for (const [value, label] of rows) {
        const row = document.createElement('div');
        const b = document.createElement('strong');
        b.textContent = value;
        row.append(b);
        if (label) row.append(` ${label}`);
        tip.appendChild(row);
      }
      tip.hidden = false;
      const w = wrap.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(8, x - tw / 2), w - tw - 8)}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 14)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function reportRows(r) {
  const cat = category(r);
  const rows = [];
  const d = decidedOn(r);
  if (d) rows.push([`${days(r)} days`, cat === 'premium' ? 'on the premium clock' : 'to decision']);
  else rows.push([`${daysBetween(clockStart(r), r.asOf)}+ days`, `waiting as of ${fmtDate(r.asOf)}`]);
  rows.push([fmtDate(r.start), r.events.received ? 'received' : 'filed']);
  if (r.events.premium_upgrade) rows.push([fmtDate(r.events.premium_upgrade), 'upgraded to premium']);
  if (r.events.approved) rows.push([fmtDate(r.events.approved), 'approved']);
  if (r.events.denied) rows.push([fmtDate(r.events.denied), 'denied']);
  if (r.events.silent_update) rows.push([fmtDate(r.events.silent_update), 'silent update']);
  if (r.events.card_produced) rows.push([fmtDate(r.events.card_produced), 'card produced']);
  if (r.events.card_delivered) rows.push([fmtDate(r.events.card_delivered), 'card delivered']);
  rows.push(['Click', 'to open the source comment']);
  return rows;
}

// Nearest mark within reach of the pointer, so tiny dots are easy to hit.
function nearest(points, px, py, reach = 24) {
  let best = null;
  let bestD = reach * reach;
  for (const p of points) {
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function attachHover(svg, tip, points, onOpen, pick = nearest) {
  let current = null;
  const find = (evt) => {
    const box = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / box.width;
    return { best: pick(points, (evt.clientX - box.left) * scale, (evt.clientY - box.top) * scale), scale };
  };
  svg.addEventListener('pointermove', (evt) => {
    const { best, scale } = find(evt);
    if (current && current !== best) current.node.classList.remove('hot');
    current = best;
    if (!best) { tip.hide(); svg.style.cursor = ''; return; }
    best.node.classList.add('hot');
    svg.style.cursor = 'pointer';
    tip.show(best.rows, best.x / scale, best.y / scale);
  });
  svg.addEventListener('pointerleave', () => { current?.node.classList.remove('hot'); current = null; tip.hide(); });
  svg.addEventListener('click', (evt) => {
    const { best } = find(evt);
    if (best?.report) onOpen(best.report);
  });
}

/** Receipt date vs days to decision. Waiting cases sit at days-waited-so-far. */
export function scatter(wrap, { reports, today, from, onOpen }) {
  wrap.replaceChildren();
  const W = Math.max(320, wrap.clientWidth);
  const H = W < 560 ? 300 : 380;
  const left = 40;
  const right = 12;
  const top = 12;
  const bottom = 30;
  const span = daysBetween(from, today);

  const pts = reports
    .filter((r) => r.start && r.start >= from && r.start <= today)
    .map((r) => {
      const decided = Boolean(decidedOn(r)) && days(r) != null;
      return { r, decided, y: decided ? days(r) : daysBetween(clockStart(r), r.asOf) };
    })
    .filter((p) => p.y != null && p.y >= 0);

  // Scale to the 98th percentile so one extreme case doesn't flatten everything;
  // anything above is pinned to the top edge and keeps its real value in the tooltip.
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const maxY = Math.max(120, Math.ceil((ys[Math.floor((ys.length - 1) * 0.98)] ?? 0) / 30) * 30);
  const x = linear(0, span, left, W - right);
  const y = linear(0, maxY, H - bottom, top);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Days to decision by receipt date' }, wrap);

  for (let d = 0; d <= maxY; d += 30) {
    el('line', { x1: left, x2: W - right, y1: y(d), y2: y(d), class: d ? 'grid' : 'axis' }, svg);
    text(svg, left - 6, y(d) + 4, String(d), { class: 'tick', 'text-anchor': 'end' });
  }
  text(svg, left, top - 2, 'days', { class: 'tick' }).setAttribute('dy', '-0.2em');
  for (const iso of monthStarts(addDays(from, -1), today)) {
    text(svg, x(daysBetween(from, iso)) + 4, H - 10, fmtMonth.format(new Date(`${iso}T00:00:00Z`)), { class: 'tick' });
  }

  const points = [];
  // Waiting cases first so decided ones draw on top.
  for (const p of pts.sort((a, b) => a.decided - b.decided)) {
    const px = x(daysBetween(from, p.r.start));
    const py = y(Math.min(p.y, maxY));
    const g = el('g', {}, svg);
    if (!p.decided) el('path', { d: `M${px - 3} ${py - 7}L${px} ${py - 10}L${px + 3} ${py - 7}`, class: 'still', stroke: SERIES[category(p.r)] }, g);
    marker(g, category(p.r), px, py, p.decided);
    points.push({ x: px, y: py, node: g, report: p.r, rows: reportRows(p.r) });
  }

  if (ys.length && ys[ys.length - 1] > maxY) {
    text(svg, W - right, top - 2, `Over ${maxY} days: drawn at the top`, { class: 'tick', 'text-anchor': 'end' }).setAttribute('dy', '-0.2em');
  }

  const tip = tooltip(wrap);
  attachHover(svg, tip, points, onOpen);
}

const fmtMonthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * One row per person, newest receipt first, all starting at their received
 * date: a solid line to the decision, then approval to card produced (square)
 * and delivered (ring). Still-waiting cases are dashed up to their last update.
 * A small triangle marks a reported silent update.
 */
export function lanes(wrap, { reports, onOpen }) {
  wrap.replaceChildren();
  const W = Math.max(320, wrap.clientWidth);
  const left = 68;
  const right = 16;
  const top = 28;
  const rowH = 16;
  const off = (r, iso) => (iso ? daysBetween(r.start, iso) : null);
  const rows = reports.map((r) => {
    const decided = decidedOn(r);
    const end = r.events.card_delivered || r.events.card_produced || decided || r.asOf;
    return { r, decided: off(r, decided), card: off(r, r.events.card_produced), delivered: off(r, r.events.card_delivered), upgrade: off(r, r.events.premium_upgrade), silent: off(r, r.events.silent_update), end: off(r, end) };
  }).filter((p) => p.end != null && p.end >= 0);

  // Same p98 cap as the scatter; longer rows run off the right edge.
  const ends = rows.map((p) => p.end).sort((a, b) => a - b);
  const maxX = Math.max(120, Math.ceil((ends[Math.floor((ends.length - 1) * 0.98)] ?? 0) / 30) * 30);
  const x = linear(0, maxX, left, W - right);
  const at = (d) => x(Math.min(d, maxX));
  const H = top + rows.length * rowH + 8;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Each reported case from received date to decision and card' }, wrap);

  const step = W < 560 && maxX > 180 ? 60 : 30;
  for (let d = 0; d <= maxX; d += step) {
    el('line', { x1: x(d), x2: x(d), y1: top - 4, y2: H - 8, class: d ? 'grid' : 'axis' }, svg);
    text(svg, x(d), top - 10, d ? String(d) : '0 days', { class: 'tick', 'text-anchor': d ? 'middle' : 'start' });
  }

  const points = [];
  let month = null;
  rows.forEach((p, i) => {
    const cy = top + i * rowH + rowH / 2;
    const m = p.r.start.slice(0, 7);
    if (m !== month) {
      month = m;
      if (i) el('line', { x1: 0, x2: W - right, y1: top + i * rowH, y2: top + i * rowH, class: 'grid' }, svg);
      text(svg, 0, cy + 4, fmtMonthYear.format(new Date(`${m}-01T00:00:00Z`)), { class: 'tick' });
    }
    const cat = category(p.r);
    const color = SERIES[cat];
    const g = el('g', {}, svg);
    if (p.decided != null) {
      el('line', { x1: x(0), x2: at(p.decided), y1: cy, y2: cy, stroke: color, 'stroke-width': 2 }, g);
      if (p.end > p.decided) el('line', { x1: at(p.decided), x2: at(p.end), y1: cy, y2: cy, class: 'after' }, g);
      if (p.card != null) el('rect', { x: at(p.card) - 3, y: cy - 3, width: 6, height: 6, class: 'card' }, g);
      if (p.delivered != null) el('circle', { cx: at(p.delivered), cy, r: 3, class: 'delivered' }, g);
    } else {
      el('line', { x1: x(0), x2: at(p.end), y1: cy, y2: cy, stroke: color, 'stroke-width': 2, 'stroke-dasharray': '2 4' }, g);
    }
    if (p.upgrade != null && p.upgrade >= 0) el('line', { x1: at(p.upgrade), x2: at(p.upgrade), y1: cy - 5, y2: cy + 5, stroke: color, 'stroke-width': 2 }, g);
    if (p.silent != null && p.silent >= 0) el('path', { d: `M${at(p.silent) - 3.5} ${cy - 7}h7l-3.5 5z`, class: 'silent' }, g);
    marker(g, cat, at(p.decided ?? p.end), cy, p.decided != null);
    points.push({ x: at(p.end), y: cy, node: g, report: p.r, rows: reportRows(p.r) });
  });

  const tip = tooltip(wrap);
  // The whole row is the hit target.
  attachHover(svg, tip, points, onOpen, (pts, px, py) => (py >= top && px >= 0 ? pts[Math.floor((py - top) / rowH)] ?? null : null));
}
