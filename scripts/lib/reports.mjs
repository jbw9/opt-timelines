// Groups raw Reddit comments into timeline reports and de-duplicates them.

import { daysBetween, isoDate } from '../../site/js/dates.js';
import { excerpt, isReport, parseReport } from './parse.mjs';

const BOTS = new Set(['AutoModerator', '[deleted]']);

const toPart = (c) => ({
  id: c.id,
  body: c.body,
  created: isoDate(c.created),
  edited: c.edited ? isoDate(c.edited) : null,
  url: c.url,
  topLevel: !c.parentId || c.parentId.startsWith('t3_'),
});

// A reply by the same author anywhere under their own comment is an update
// to that report ("Update: approved 3/2!"), not a new report.
export function groupComments(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = new Map();
  const groups = new Map();
  for (const c of [...comments].sort((a, b) => a.created - b.created)) {
    if (BOTS.has(c.author)) continue;
    let root = c.id;
    for (let p = byId.get(c.parentId?.slice(3)); p; p = byId.get(p.parentId?.slice(3))) {
      if (p.author === c.author && rootOf.has(p.id)) {
        root = rootOf.get(p.id);
        break;
      }
    }
    rootOf.set(c.id, root);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  }
  return [...groups.values()];
}

function toReport(sourceId, group) {
  const parts = group.map(toPart);
  const parsed = parseReport(parts);
  if (!isReport(parsed)) return null;
  const root = group[0];
  // Link to the comment that holds the timeline: people often ask a question
  // first and post their dates in a later reply.
  const dates = parts.map((p) => Object.keys(parseReport([p]).events).length);
  const main = group[dates.reduce((best, n, i) => (n > dates[best] ? i : best), 0)];
  return {
    id: `${sourceId}:${root.id}`,
    source: sourceId,
    url: main.url,
    updates: group.filter((c) => c !== main).map((c) => c.url),
    author: root.author,
    posted: parts[0].created,
    ...parsed,
    excerpt: excerpt(main.body),
    _group: group,
  };
}

const sameCase = (a, b) => !a.start || !b.start || Math.abs(daysBetween(a.start, b.start)) <= 3;

// General subreddits (r/USCIS) also carry non-student EAD cases.
const OPT_MENTION = /\b(?:opt|stem|f-?1|c\)?\s*\(?3\)?\s*\(?[abc]\b|c3[abc])/i;

export function buildReports(sourceId, comments, { requireOptMention = false } = {}) {
  const reports = groupComments(comments)
    .filter((g) => !requireOptMention || g.some((c) => OPT_MENTION.test(c.body)))
    .map((g) => toReport(sourceId, g))
    .filter(Boolean);

  // Someone who posts a second top-level comment about the same case gets one report.
  const byAuthor = new Map();
  const out = [];
  for (const r of reports.sort((a, b) => a._group[0].created - b._group[0].created)) {
    const prev = byAuthor.get(r.author);
    if (prev && prev.type === r.type && sameCase(prev, r)) {
      const merged = toReport(sourceId, [...prev._group, ...r._group].sort((a, b) => a.created - b.created));
      if (merged && !merged.flags.includes('inconsistent_order')) {
        out[out.indexOf(prev)] = merged;
        byAuthor.set(r.author, merged);
        continue;
      }
    }
    out.push(r);
    byAuthor.set(r.author, r);
  }
  return out;
}

const richness = (r) => Object.keys(r.events).length;

// The same person often posts their timeline more than once, in one thread or several.
export function dedupeAcrossSources(reports) {
  const keep = [];
  const seen = new Map();
  for (const r of reports) {
    const key = `${r.author}|${r.type}`;
    const prev = (seen.get(key) ?? []).find((p) => p.start && r.start && sameCase(p, r));
    if (!prev) {
      keep.push(r);
      seen.set(key, [...(seen.get(key) ?? []), r]);
    } else if (richness(r) > richness(prev)) {
      r.alsoAt = [...(r.alsoAt ?? []), prev.url];
      keep[keep.indexOf(prev)] = r;
      seen.set(key, seen.get(key).map((p) => (p === prev ? r : p)));
    } else {
      prev.alsoAt = [...(prev.alsoAt ?? []), r.url];
    }
  }
  return keep;
}

export function stripInternal(r) {
  const { _group, ...rest } = r;
  return rest;
}
