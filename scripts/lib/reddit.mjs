// Minimal Reddit Data API client. Anonymous requests to reddit.com are blocked,
// so scheduled fetches use an app-only OAuth token (client_credentials grant).
// https://github.com/reddit-archive/reddit/wiki/OAuth2

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export async function getToken({ clientId, clientSecret, userAgent }) {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Reddit token request failed (${res.status}): ${JSON.stringify(json)}`);
  return json.access_token;
}

export function createClient({ token, userAgent }) {
  let remaining = Infinity;
  let resetAt = 0;
  return async function get(path, params = {}) {
    if (remaining < 2 && Date.now() < resetAt) await sleep(resetAt - Date.now() + 500);
    const url = new URL(`https://oauth.reddit.com${path}`);
    for (const [k, v] of Object.entries({ raw_json: 1, ...params })) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent } });
      if (res.headers.has('x-ratelimit-remaining')) remaining = Number(res.headers.get('x-ratelimit-remaining'));
      if (res.headers.has('x-ratelimit-reset')) resetAt = Date.now() + Number(res.headers.get('x-ratelimit-reset')) * 1000;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url.pathname} failed: ${res.status}`);
      return res.json();
    }
  };
}

export function toComment(d) {
  return {
    id: d.id,
    parentId: d.parent_id ?? null,
    author: d.author,
    body: d.body ?? `${d.title ?? ''}\n${d.selftext ?? ''}`,
    created: d.created_utc,
    edited: typeof d.edited === 'number' ? d.edited : null,
    url: `https://www.reddit.com${d.permalink}`,
  };
}

const GONE = new Set(['[deleted]', '[removed]']);

// Collects comments from a (possibly nested) listing, remembering which
// branches Reddit truncated so they can be fetched separately.
function walk(children, out, more, cont) {
  for (const child of children ?? []) {
    if (child.kind === 't1') {
      const d = child.data;
      if (!GONE.has(d.body?.trim()) && !out.has(d.id)) out.set(d.id, toComment(d));
      if (d.replies?.data) walk(d.replies.data.children, out, more, cont);
    } else if (child.kind === 'more') {
      const d = child.data;
      if (d.children?.length) more.push(...d.children);
      else if (d.parent_id?.startsWith('t1_')) cont.push(d.parent_id.slice(3)); // "continue this thread"
    }
  }
}

function summarizePost(d) {
  return {
    id: d.id,
    title: d.title,
    subreddit: d.subreddit,
    author: d.author,
    created: d.created_utc,
    url: `https://www.reddit.com${d.permalink}`,
    numComments: d.num_comments,
  };
}

export async function fetchThread(get, postId) {
  const [postListing, commentListing] = await get(`/comments/${postId}`, { limit: 500, depth: 10, sort: 'old' });
  const comments = new Map();
  const more = [];
  const cont = [];
  const seenMore = new Set();
  walk(commentListing.data.children, comments, more, cont);

  while (more.length || cont.length) {
    if (more.length) {
      const batch = more.splice(0, 100).filter((id) => !seenMore.has(id) && !comments.has(id));
      batch.forEach((id) => seenMore.add(id));
      if (!batch.length) continue;
      const res = await get('/api/morechildren', { api_type: 'json', link_id: `t3_${postId}`, children: batch.join(','), limit_children: false });
      walk(res.json?.data?.things, comments, more, cont);
    } else {
      const id = cont.shift();
      if (seenMore.has(`c:${id}`)) continue;
      seenMore.add(`c:${id}`);
      const [, listing] = await get(`/comments/${postId}`, { comment: id, limit: 500, depth: 10, sort: 'old' });
      walk(listing.data.children, comments, more, cont);
    }
  }
  return { post: summarizePost(postListing.data.children[0].data), comments: [...comments.values()] };
}

export async function fetchSearch(get, { subreddit, query, time = 'year' }) {
  const posts = [];
  let after = null;
  // Reddit search returns at most ~250 results per query; 3 pages covers it.
  for (let page = 0; page < 3; page++) {
    const res = await get(`/r/${subreddit}/search`, { q: query, restrict_sr: 1, sort: 'new', t: time, limit: 100, type: 'link', ...(after && { after }) });
    for (const child of res.data.children) {
      if (child.kind === 't3' && !GONE.has(child.data.selftext?.trim())) posts.push(toComment(child.data));
    }
    after = res.data.after;
    if (!after) break;
  }
  return { comments: posts };
}

// A thread saved from a browser ("<thread url>.json"). Truncated branches can't
// be expanded without the API, so this is only for bootstrapping/testing.
export async function loadThreadFile(path) {
  const [postListing, commentListing] = JSON.parse(await readFile(path, 'utf8'));
  const comments = new Map();
  walk(commentListing.data.children, comments, [], []);
  return { post: summarizePost(postListing.data.children[0].data), comments: [...comments.values()] };
}
