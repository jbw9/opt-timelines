import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReports, dedupeAcrossSources } from '../scripts/lib/reports.mjs';

const t = (iso) => Date.parse(`${iso}T15:00:00Z`) / 1000;
const c = (id, parentId, author, body, created) => ({ id, parentId, author, body, created: t(created), edited: null, url: `https://www.reddit.com/r/f1visa/comments/x/_/${id}/` });

test('same-author replies merge into one report; other people stay separate', () => {
  const comments = [
    c('a', 't3_x', 'alice', 'Received 1/12, no premium, OPT', '2026-02-01'),
    c('b', 't1_a', 'bob', 'Same! received 1/13 and still waiting', '2026-02-02'),
    c('d', 't1_b', 'alice', 'Update: approved 3/2', '2026-03-02'),
    c('e', 't3_x', 'AutoModerator', 'Approved 3/1 received 1/1', '2026-03-02'),
  ];
  const reports = buildReports('src', comments);
  assert.equal(reports.length, 2);
  const alice = reports.find((r) => r.author === 'alice');
  assert.equal(alice.events.approved, '2026-03-02');
  assert.deepEqual(alice.updates, ['https://www.reddit.com/r/f1visa/comments/x/_/d/']);
  assert.equal(alice.url, 'https://www.reddit.com/r/f1visa/comments/x/_/a/');
});

test('links to the reply that holds the timeline, not an earlier question', () => {
  const [r] = buildReports('src', [
    c('q', 't3_x', 'dan', 'Applied for OPT in April, should I get premium?', '2026-09-18'),
    c('t', 't1_q', 'dan', 'Type: OPT\nDate Applied: 4/22/2026\nPremium: YES 9/19/2026\nDate Approved: 10/6/2026', '2026-10-07'),
  ]);
  assert.equal(r.url, 'https://www.reddit.com/r/f1visa/comments/x/_/t/');
  assert.deepEqual(r.updates, ['https://www.reddit.com/r/f1visa/comments/x/_/q/']);
  assert.match(r.excerpt, /Date Approved/);
});

test('a second top-level comment about the same case is merged', () => {
  const reports = buildReports('src', [
    c('a', 't3_x', 'carol', 'STEM received 1/20, pending', '2026-02-01'),
    c('b', 't3_x', 'carol', 'STEM approved 3/5 (received 1/20)', '2026-03-05'),
  ]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].events.approved, '2026-03-05');
});

test('requireOptMention drops non-student EAD reports', () => {
  const reports = buildReports('src', [
    c('a', 't3_x', 'dan', 'C9 EAD received 1/2 approved 3/3', '2026-03-05'),
    c('b', 't3_x', 'erin', 'OPT received 1/2 approved 3/3', '2026-03-05'),
  ], { requireOptMention: true });
  assert.deepEqual(reports.map((r) => r.author), ['erin']);
});

test('cross-source duplicates keep the richer report and link the other', () => {
  const a = { source: 's1', author: 'x', type: 'opt', start: '2026-01-10', events: { received: '2026-01-10' }, url: 'u1' };
  const b = { source: 's2', author: 'x', type: 'opt', start: '2026-01-11', events: { received: '2026-01-11', approved: '2026-03-01' }, url: 'u2' };
  const out = dedupeAcrossSources([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'u2');
  assert.deepEqual(out[0].alsoAt, ['u1']);
});
