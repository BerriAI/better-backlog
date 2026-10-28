import test from 'node:test';
import assert from 'node:assert/strict';
import { queryIssues } from '../public/query.js';
const issues = [
  { number: 1, title: 'Streaming failure', body: 'Azure', created_at: '2026-09-28T00:00:00Z', labels: ['bug', 'proxy'], user: { login: 'Alice' }, assignees: [], comments: 2, reactions: { total_count: 8, '+1': 3 } },
  { number: 2, title: 'Streaming support', created_at: '2026-10-28T23:59:59Z', labels: [{ name: 'bug' }], user: { login: 'bob' }, assignees: [{ login: 'Alice' }], comments: 4, reactions: { total_count: 8, '+1': 7 } },
  { number: 3, title: 'Older', created_at: '2026-09-27T23:59:59Z', reactions: { total_count: 40 } },
  { number: 4, title: 'Newer', created_at: '2026-10-29T00:00:00Z' },
];
test('date boundaries, deterministic ties, totals before limit, and no input mutation', () => {
  const result = queryIssues(issues, { 'created-after': '2026-09-28', 'created-before': '2026-10-28', sort: 'reactions', limit: '1' });
  assert.equal(result.total, 4); assert.equal(result.matched, 2);
  assert.deepEqual(result.issues.map(i => i.number), [2]);
  assert.deepEqual(issues.map(i => i.number), [1, 2, 3, 4]);
});
test('AND labels, OR authors, exclusions, text and unassigned intersect', () => {
  assert.deepEqual(queryIssues(issues, { label: ['bug', 'proxy'], author: ['ALICE', 'bob'], assignee: 'none', text: 'azure', 'exclude-author': 'bob', 'min-reactions': '5', 'max-comments': '3' }).issues.map(i => i.number), [1]);
  assert.equal(queryIssues(issues, { label: 'bug', 'exclude-label': 'proxy', assignee: 'alice', 'min-thumbs-up': '6' }).issues[0].number, 2);
});
test('reject invalid options and handle zero limits and absent reactions', () => {
  for (const options of [{ 'created-after': '2026-02-30' }, { limit: '-1' }, { sort: '__proto__' }, { order: 'random' }, { 'min-comments': '4', 'max-comments': '2' }, { 'created-after': '2026-10-30', 'created-before': '2026-10-01' }]) assert.throws(() => queryIssues(issues, options));
  assert.equal(queryIssues(issues, { limit: '0' }).issues.length, 0);
  assert.equal(queryIssues(issues, { sort: 'reactions', order: 'asc' }).issues[0].number, 4);
});
