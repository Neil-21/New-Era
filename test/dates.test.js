const { test } = require('node:test');
const assert = require('node:assert');

test('dates read like people write them', async () => {
  const { formatDate, prettyTitle } = await import('../src/renderer/dates.js');
  const d = new Date(2026, 8, 5);
  assert.equal(formatDate(d, 'ordinal'), '5th Sep 2026');
  assert.equal(formatDate(new Date(2026, 8, 22), 'ordinal'), '22nd Sep 2026');
  assert.equal(formatDate(new Date(2026, 8, 13), 'ordinal'), '13th Sep 2026');
  assert.equal(formatDate(d, 'long'), '5 September 2026');
  assert.equal(formatDate(d, 'us'), 'Sep 5, 2026');
  assert.equal(formatDate(d, 'iso'), '2026-09-05');
  assert.equal(prettyTitle('2026-09-05', 'ordinal'), '5th Sep 2026');
  assert.equal(prettyTitle('2026-02-31', 'ordinal'), '2026-02-31');
  assert.equal(prettyTitle('Anthropic', 'ordinal'), 'Anthropic');
});
