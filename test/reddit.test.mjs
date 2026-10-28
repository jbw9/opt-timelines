import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchThread, loadThreadFile } from '../scripts/lib/reddit.mjs';

const t1 = (id, parent, body, replies = '') => ({
  kind: 't1',
  data: { id, parent_id: parent, author: `u_${id}`, body, created_utc: 1772000000, edited: false, permalink: `/r/f1visa/comments/abc/x/${id}/`, replies },
});
const listing = (children) => ({ kind: 'Listing', data: { children } });
const post = listing([{ kind: 't3', data: { id: 'abc', title: 'Megathread', subreddit: 'f1visa', author: 'mod', created_utc: 1771000000, permalink: '/r/f1visa/comments/abc/x/', num_comments: 5 } }]);

test('walks nested replies, expands "more" stubs and continued threads', async () => {
  const calls = [];
  const get = async (path, params) => {
    calls.push([path, params]);
    if (path === '/comments/abc' && !params.comment) {
      return [post, listing([
        t1('a', 't3_abc', 'Applied 1/5', listing([
          t1('b', 't1_a', 'Approved 3/1', listing([{ kind: 'more', data: { id: '_', count: 0, children: [], parent_id: 't1_b' } }])),
        ])),
        t1('gone', 't3_abc', '[deleted]'),
        { kind: 'more', data: { count: 2, children: ['c', 'd'], parent_id: 't3_abc' } },
      ])];
    }
    if (path === '/api/morechildren') return { json: { data: { things: [t1('c', 't3_abc', 'Received 2/2'), t1('d', 't1_c', 'same')] } } };
    if (path === '/comments/abc' && params.comment === 'b') return [post, listing([t1('b', 't1_a', 'Approved 3/1', listing([t1('e', 't1_b', 'deep reply')]))])];
    throw new Error(`unexpected ${path}`);
  };
  const { post: p, comments } = await fetchThread(get, 'abc');
  assert.equal(p.url, 'https://www.reddit.com/r/f1visa/comments/abc/x/');
  assert.deepEqual(comments.map((c) => c.id).sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(comments.find((c) => c.id === 'c').url, 'https://www.reddit.com/r/f1visa/comments/abc/x/c/');
  assert.deepEqual(calls.find(([path]) => path === '/api/morechildren')[1].children, 'c,d');
});

test('imports a thread saved from a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-'));
  const file = join(dir, 'thread.json');
  await writeFile(file, JSON.stringify([post, listing([t1('a', 't3_abc', 'Applied 1/5'), { kind: 'more', data: { count: 9, children: ['z'] } }])]));
  const { comments } = await loadThreadFile(file);
  assert.deepEqual(comments.map((c) => c.id), ['a']);
});
