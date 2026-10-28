// Shared deterministic query engine for the browser, HTTP API and CLI.
export const queryOptions = {
  text: 'Title/body contains text (case insensitive)',
  label: 'Required label; repeat for AND',
  'exclude-label': 'Excluded label; repeatable',
  author: 'Author login; repeat for OR',
  'exclude-author': 'Excluded author login; repeatable',
  assignee: 'Assignee login, or none; repeat for OR',
  'created-after': 'Created on/after YYYY-MM-DD (UTC)',
  'created-before': 'Created on/before YYYY-MM-DD (UTC)',
  'updated-after': 'Updated on/after YYYY-MM-DD (UTC)',
  'updated-before': 'Updated on/before YYYY-MM-DD (UTC)',
  'min-reactions': 'Minimum total issue reactions',
  'min-thumbs-up': 'Minimum thumbs-up reactions',
  'min-comments': 'Minimum comments',
  'max-comments': 'Maximum comments',
  sort: 'created, updated, reactions, thumbs-up, comments',
  order: 'asc or desc (default: desc)',
  limit: 'Maximum results after filtering and sorting',
};
export const multipleOptions = ['label', 'exclude-label', 'author', 'exclude-author', 'assignee'];
export function queryIssues(issues, options = {}) {
  const value = (key) => options[key] ?? '';
  const list = (key) => (Array.isArray(value(key)) ? value(key) : [value(key)]).filter(Boolean).map(x => String(x).toLowerCase());
  const dates = {};
  for (const key of ['created-after', 'created-before', 'updated-after', 'updated-before']) {
    if (!value(key)) continue;
    const date = String(value(key));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
      throw new Error(`${key} must be a valid YYYY-MM-DD date.`);
    dates[key] = Date.parse(date) + (key.endsWith('before') ? 86400000 - 1 : 0);
  }
  for (const field of ['created', 'updated'])
    if (dates[`${field}-after`] > dates[`${field}-before`]) throw new Error(`${field} date range is reversed.`);
  const nums = {};
  for (const key of ['min-reactions', 'min-thumbs-up', 'min-comments', 'max-comments', 'limit']) {
    if (value(key) === '') continue;
    if (!/^\d+$/.test(String(value(key))) || !Number.isSafeInteger(Number(value(key)))) throw new Error(`${key} must be a non-negative integer.`);
    nums[key] = Number(value(key));
  }
  if (nums['min-comments'] > nums['max-comments']) throw new Error('Comment range is reversed.');
  const metrics = {
    created: i => Date.parse(i.created_at) || 0,
    updated: i => Date.parse(i.updated_at) || 0,
    reactions: i => i.reactions?.total_count ?? 0,
    'thumbs-up': i => i.reactions?.['+1'] ?? 0,
    comments: i => i.comments ?? 0,
  };
  const sort = value('sort') || 'created', order = value('order') || 'desc';
  if (!Object.hasOwn(metrics, sort)) throw new Error('Unknown sort field.');
  if (!['asc', 'desc'].includes(order)) throw new Error('Order must be asc or desc.');
  const matches = issues.filter(i => {
    const labels = (i.labels || []).map(l => (l.name ?? l).toLowerCase());
    const author = (i.user?.login || i.author || '').toLowerCase();
    const assignees = (i.assignees || []).map(a => a.login.toLowerCase());
    if (value('text') && !`${i.title}\n${i.body || ''}`.toLowerCase().includes(String(value('text')).toLowerCase())) return false;
    if (!list('label').every(l => labels.includes(l)) || list('exclude-label').some(l => labels.includes(l))) return false;
    if (list('author').length && !list('author').includes(author) || list('exclude-author').includes(author)) return false;
    if (list('assignee').length && !list('assignee').some(a => a === 'none' ? !assignees.length : assignees.includes(a))) return false;
    for (const [key, bound] of Object.entries(dates)) {
      const stamp = Date.parse(i[key.startsWith('created') ? 'created_at' : 'updated_at']);
      if (!Number.isFinite(stamp) || (key.endsWith('after') ? stamp < bound : stamp > bound)) return false;
    }
    for (const [key, metric] of [['min-reactions', 'reactions'], ['min-thumbs-up', 'thumbs-up'], ['min-comments', 'comments']])
      if (nums[key] !== undefined && metrics[metric](i) < nums[key]) return false;
    return nums['max-comments'] === undefined || metrics.comments(i) <= nums['max-comments'];
  });
  matches.sort((a, b) => (order === 'asc' ? 1 : -1) * (metrics[sort](a) - metrics[sort](b)) || b.number - a.number);
  return { total: issues.length, matched: matches.length, issues: matches.slice(0, nums.limit ?? matches.length) };
}
