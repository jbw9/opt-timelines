import { addDays, daysBetween, isoDate } from './dates.js';
import { fmtDate, lanes, scatter } from './charts.js';
import { CATEGORIES, approvalFront, cardTimes, category, recentDecisions, summarize, usable } from './stats.js';
import { mountDecoder } from './silent.js';

const $ = (sel) => document.querySelector(sel);
const today = () => isoDate(Date.now() / 1000);
const REFRESH_MS = 30 * 60 * 1000;
const PAGE = 60;

const state = {
  reports: [],
  sources: [],
  generatedAt: null,
  filters: { cat: 'all', range: 180 },
  limit: PAGE,
};

// Strings always go in as text, never HTML: they come from Reddit comments.
function h(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

const round = (v) => Math.round(v);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const key = (cat) => h('i', { class: `k k-${cat}`, 'aria-hidden': 'true' });
const openReport = (r) => window.open(r.url, '_blank', 'noopener');

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (s < 90) return 'just now';
  if (s < 5400) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 129600) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

async function load() {
  try {
    const res = await fetch('data/reports.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      state.reports = data.reports ?? [];
      state.sources = data.sources ?? [];
      state.generatedAt = data.generatedAt;
    }
  } catch { /* keep what we have */ }
  renderAll();
}

function filtered() {
  const { cat, range } = state.filters;
  const from = range ? addDays(today(), -range) : '0000';
  return state.reports.filter((r) => usable(r) && r.start && r.start >= from && (cat === 'all' || category(r) === cat));
}

function renderFreshness() {
  const el = $('#freshness');
  if (!state.generatedAt) {
    el.textContent = 'No reports yet.';
    return;
  }
  const stale = state.sources.some((s) => !s.ok) || Date.now() - Date.parse(state.generatedAt) > 3 * 3600 * 1000;
  el.textContent = `${plural(state.reports.length, 'person', 'people')} from r/f1visa, updated ${ago(state.generatedAt)}${stale ? ' (refresh delayed)' : ''}.`;
}

function tile(label, value, sub, cat) {
  return h('div', { class: 'tile' }, h('p', { class: 'tile-label' }, cat ? key(cat) : '', label), h('p', { class: 'tile-value' }, value), h('p', { class: 'tile-sub' }, sub));
}

function renderTiles() {
  const t = today();
  const tiles = CATEGORIES.map(({ id, short }) => {
    const rec = recentDecisions(state.reports, id, t);
    if (!rec?.n) return tile(short, '—', 'Not enough recent reports', id);
    const front = id === 'premium' ? null : approvalFront(state.reports, id, t);
    return tile(short, `${round(rec.median)} days`,
      [`Most ${round(rec.p25)}–${round(rec.p75)}`, front?.median ? `. Now approving cases received around ${fmtDate(front.median)}` : ''], id);
  });
  const card = cardTimes(state.reports).toCard;
  const silent = summarize(state.reports.filter((r) => usable(r) && r.events.silent_update && r.events.approved >= r.events.silent_update)
    .map((r) => daysBetween(r.events.silent_update, r.events.approved)));
  tiles.push(tile('Silent update to approval', silent.n ? `${round(silent.median)} days` : '—', silent.n ? `Most ${round(silent.p25)}–${round(silent.p75)}, from ${plural(silent.n, 'person', 'people')}` : 'Not enough reports'));
  tiles.push(tile('Approval to card', card.n ? `${round(card.median)} days` : '—', card.n ? `Most ${round(card.p25)}–${round(card.p75)}` : 'Not enough reports'));
  $('#tiles').replaceChildren(...tiles);
}

function renderCharts() {
  const t = today();
  const rows = filtered();
  const starts = rows.map((r) => r.start).sort();
  const from = state.filters.range ? addDays(t, -state.filters.range) : starts[0] ?? addDays(t, -365);
  scatter($('#scatter'), { reports: rows, today: t, from, onOpen: openReport });

  const newest = [...rows].sort((a, b) => (a.start < b.start ? 1 : -1));
  lanes($('#lanes'), { reports: newest.slice(0, state.limit), onOpen: openReport });
  $('#more').hidden = newest.length <= state.limit;
}

function renderSources() {
  const links = state.sources.map((s) => h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.label));
  $('#sources').replaceChildren(...(links.length ? ['Sources: ', ...links.flatMap((a, i) => (i ? ['; ', a] : [a])), '.'] : []));
}

function renderAll() {
  renderFreshness();
  renderTiles();
  renderCharts();
  renderSources();
}

for (const [id, k, parse] of [['#f-cat', 'cat', String], ['#f-range', 'range', Number]]) {
  $(id).addEventListener('change', (e) => {
    state.filters[k] = parse(e.target.value);
    state.limit = PAGE;
    renderCharts();
  });
}

$('#more').addEventListener('click', () => {
  state.limit += PAGE;
  renderCharts();
});

let lastWidth = window.innerWidth;
let resizeTimer;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCharts, 150);
});

mountDecoder($('#decoder'));
load();
setInterval(load, REFRESH_MS);
