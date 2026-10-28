// Arctic Shift (https://github.com/ArthurHeitmann/arctic_shift) is a free,
// keyless archive of Reddit. Used when no Reddit API credentials are set.
//
// Limits to know: it archives a comment when posted and refreshes it once about
// 36 hours later, so edits after that are missed, and it keeps comments people
// later deleted. Its link_id filter currently times out, so busy subreddits are
// crawled by time window and filtered to the tracked threads.

import { setTimeout as sleep } from 'node:timers/promises';
import { toComment } from './reddit.mjs';

const BASE = 'https://arctic-shift.photon-reddit.com';
const PAUSE_MS = 700; // the service asks for light use

async function get(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    // A dropped connection makes fetch throw; retry it like a 5xx.
    const res = await fetch(url, { headers: { 'User-Agent': 'opt-timelines (github.com; scheduled every 30 min)' } }).catch((err) => ({ ok: false, status: err.cause?.code ?? err.message, headers: new Headers() }));
    const json = res.json ? await res.json().catch(() => ({})) : {};
    if (res.ok && json.data) return json.data;
    if (attempt >= 7) throw new Error(`Arctic Shift ${url.pathname} failed (${res.status}): ${json.error ?? 'no data'}`);
    const reset = Number(res.headers.get('x-ratelimit-reset')) || 0;
    await sleep(Math.max(reset * 1000, 3000 * 2 ** attempt));
  }
}

/** Feeds `onPage` every comment in `subreddit` created at or after `after` (epoch seconds), oldest first. */
export async function crawlSubreddit(subreddit, after, onPage) {
  let cursor = after;
  for (;;) {
    const page = await get('/api/comments/search', { subreddit, after: cursor, limit: 100, sort: 'asc' });
    await onPage(page);
    if (page.length < 100) return;
    const last = page.at(-1).created_utc;
    // Many comments in one second could stall the cursor; step past it.
    cursor = last > cursor ? last : cursor + 1;
    await sleep(PAUSE_MS);
  }
}

// `after` must be a real date (the API rejects 0), so start at the post's creation.
export async function threadComments(linkId, after) {
  const out = [];
  let cursor = after;
  for (;;) {
    const page = await get('/api/comments/search', { link_id: linkId, after: cursor, limit: 100, sort: 'asc' });
    out.push(...page);
    if (page.length < 100) return out;
    cursor = Math.max(page.at(-1).created_utc, cursor + 1);
    await sleep(PAUSE_MS);
  }
}

export async function posts(ids) {
  return get('/api/posts/ids', { ids: ids.join(',') });
}

const GONE = new Set(['[deleted]', '[removed]']);
export const keep = (c) => c.body && !GONE.has(c.body.trim());
