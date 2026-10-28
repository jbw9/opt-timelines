#!/usr/bin/env node
// Fetches every source in sources.json, extracts timeline reports and writes
// site/data/*.json for the static site.
//
//   node scripts/build.mjs                                # Arctic Shift archive, no keys needed
//   REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=... node scripts/build.mjs   # Reddit API instead
//   node scripts/build.mjs --import 1r6p9k0=thread.json   # thread saved from a browser
//
// When a source fails, its reports from the previous build (PREVIOUS_DATA_URL,
// else the local site/data) are carried forward and marked stale, so the site
// never goes blank. Exits non-zero only when nothing refreshed and the live
// data couldn't be read, so CI never deploys over good data.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { crawlSubreddit, keep, posts, threadComments } from './lib/arctic-shift.mjs';
import { createClient, fetchSearch, fetchThread, getToken, loadThreadFile, toComment } from './lib/reddit.mjs';
import { buildReports, dedupeAcrossSources, stripInternal } from './lib/reports.mjs';

const ROOT = new URL('..', import.meta.url);
const OUT = new URL('site/data/', ROOT);

const { values } = parseArgs({ options: { import: { type: 'string', multiple: true, default: [] } } });
const imports = new Map(values.import.map((s) => s.split('=')));

const config = JSON.parse(await readFile(new URL('sources.json', ROOT), 'utf8'));

async function loadPrevious(name) {
  const base = process.env.PREVIOUS_DATA_URL;
  try {
    if (base) {
      const res = await fetch(new URL(name, base.endsWith('/') ? base : `${base}/`));
      if (res.status === 404) return { sources: [], reports: [] }; // first deploy
      return res.ok ? await res.json() : null;
    }
    return JSON.parse(await readFile(new URL(name, OUT), 'utf8'));
  } catch {
    return null;
  }
}

async function redditGetter() {
  const { REDDIT_CLIENT_ID: clientId, REDDIT_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) return null;
  const userAgent = process.env.REDDIT_USER_AGENT || 'web:opt-timelines:v1.0';
  return createClient({ token: await getToken({ clientId, clientSecret, userAgent }), userAgent });
}

// Arctic Shift: crawl each subreddit in `crawl` once per run, incrementally via
// .cache/ (kept between CI runs by actions/cache), then hand threads their comments.
const CACHE = new URL('.cache/arctic-shift.json', ROOT);
const OVERLAP = 3 * 86400; // re-read recent days: the archive refreshes comments ~36h after posting

async function archive() {
  const cache = JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
  const threads = config.sources.filter((s) => s.kind === 'thread');
  const titles = cache.titles ?? {};
  const missing = threads.filter((s) => !titles[s.id]).map((s) => s.id);
  if (missing.length) for (const p of await posts(missing)) titles[p.id] = { title: p.title, subreddit: p.subreddit, created: p.created_utc };

  const subs = cache.subs ?? {};
  const save = async () => {
    await mkdir(new URL('.cache/', ROOT), { recursive: true });
    await writeFile(CACHE, JSON.stringify({ titles, subs }));
  };
  await save();
  for (const sub of config.crawl ?? []) {
    const mine = threads.filter((s) => s.subreddit === sub);
    const ids = new Set(mine.map((s) => `t3_${s.id}`));
    const prev = subs[sub] ?? { until: 0, comments: [] };
    const from = prev.until ? prev.until - OVERLAP : Math.min(...mine.map((s) => titles[s.id]?.created ?? Date.now() / 1000));
    console.log(`[archive] r/${sub} from ${new Date(from * 1000).toISOString().slice(0, 10)}`);
    const byId = new Map(prev.comments.map((c) => [c.id, c]));
    let until = prev.until;
    let seen = 0;
    // Save after every page so an interrupted backfill resumes where it stopped.
    await crawlSubreddit(sub, from, async (page) => {
      for (const c of page) {
        if (!ids.has(c.link_id)) continue;
        if (keep(c)) byId.set(c.id, { id: c.id, author: c.author, body: c.body, created_utc: c.created_utc, parent_id: c.parent_id, link_id: c.link_id, edited: c.edited, permalink: c.permalink });
        else byId.delete(c.id);
      }
      until = Math.max(until, ...page.map((c) => c.created_utc));
      subs[sub] = { until, comments: [...byId.values()] };
      await save();
      if (Math.floor((seen + page.length) / 2000) > Math.floor(seen / 2000)) console.log(`[archive] r/${sub} ${seen + page.length} comments, at ${new Date(until * 1000).toISOString().slice(0, 10)}`);
      seen += page.length;
    });
  }

  return async (src) => {
    const t = titles[src.id];
    const raw = (config.crawl ?? []).includes(src.subreddit)
      ? subs[src.subreddit].comments.filter((c) => c.link_id === `t3_${src.id}`)
      : (await threadComments(`t3_${src.id}`, t?.created ?? 1)).filter(keep);
    return { post: t && { subreddit: t.subreddit, title: t.title }, comments: raw.map(toComment) };
  };
}

const now = new Date().toISOString();
const previous = await loadPrevious('reports.json');
let get = null;
let authError = null;
try {
  get = await redditGetter();
} catch (err) {
  authError = err.message;
}

const sources = [];
let reports = [];
let fromArchive = null;
for (const src of config.sources) {
  const info = { id: src.id, kind: src.kind, label: src.label, url: src.url };
  try {
    let fetched;
    if (imports.has(src.id)) {
      info.via = 'import';
      fetched = await loadThreadFile(imports.get(src.id));
    } else if (get) {
      info.via = 'reddit';
      fetched = src.kind === 'thread' ? await fetchThread(get, src.id) : await fetchSearch(get, src);
    } else {
      if (authError) throw new Error(authError);
      info.via = 'arctic-shift';
      fromArchive ??= archive();
      fetched = await (await fromArchive)(src);
    }

    const found = buildReports(src.id, fetched.comments, { requireOptMention: src.requireOptMention });
    reports.push(...found);
    const label = fetched.post ? `r/${fetched.post.subreddit}: ${fetched.post.title}` : info.label;
    sources.push({ ...info, label, ok: true, fetchedAt: now, items: fetched.comments.length, reports: found.length });
    console.log(`[${src.id}] ${fetched.comments.length} items -> ${found.length} reports`);
  } catch (err) {
    const prevInfo = previous?.sources?.find((s) => s.id === src.id);
    const carried = previous?.reports?.filter((r) => r.source === src.id) ?? [];
    reports.push(...carried);
    sources.push({ ...info, ok: false, error: err.message, fetchedAt: prevInfo?.fetchedAt ?? null, items: prevInfo?.items ?? 0, reports: carried.length });
    console.error(`[${src.id}] ${err.message}; carried forward ${carried.length} reports`);
  }
}

reports = dedupeAcrossSources(reports)
  .map(stripInternal)
  .sort((a, b) => (b.asOf < a.asOf ? -1 : b.asOf > a.asOf ? 1 : 0));

await mkdir(OUT, { recursive: true });
await writeFile(new URL('reports.json', OUT), JSON.stringify({ generatedAt: now, sources, reports }));
const fresh = sources.filter((s) => s.ok).length;
console.log(`wrote ${reports.length} reports from ${fresh}/${sources.length} fresh sources`);
if (process.env.GITHUB_ACTIONS) for (const s of sources.filter((x) => !x.ok)) console.log(`::warning title=${s.id} not refreshed::${s.error}`);

// Never publish over live data we couldn't read back.
if (!fresh && !previous && process.env.PREVIOUS_DATA_URL) {
  console.error('No source refreshed and the live data could not be read; not deploying.');
  process.exit(1);
}
