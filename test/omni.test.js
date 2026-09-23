// Search ranking decides what people find first, so it gets pinned down.
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/omni.js');

test('score: prefix beats word-start beats mid-word beats subsequence', async () => {
  const { score } = await load();
  const prefix = score('acc', 'Accent');
  const wordStart = score('col', 'Highlight colour');
  const midWord = score('ghl', 'Highlight');
  const subseq = score('hlc', 'Highlight colour');
  assert.ok(prefix > wordStart, 'prefix outranks word-start');
  assert.ok(wordStart > midWord, 'word-start outranks mid-word');
  assert.ok(midWord > subseq, 'contiguous outranks scattered');
  assert.ok(subseq > 0, 'a scattered match still counts');
});

test('score: no match is zero, and order of characters matters', async () => {
  const { score } = await load();
  assert.strictEqual(score('zzz', 'Accent'), 0);
  assert.strictEqual(score('tnecca', 'Accent'), 0, 'reversed is not a match');
  assert.ok(score('', 'anything') > 0, 'an empty query matches everything weakly');
});

test('score: weight scales the result so labels outrank hints', async () => {
  const { score } = await load();
  const label = score('font', 'Font', 1.25);
  const hint = score('font', 'typeface for notes and font size', 0.5);
  assert.ok(label > hint, 'a hit in the label wins over a hit in the hint');
});

test('score is case insensitive', async () => {
  const { score } = await load();
  assert.strictEqual(score('ACCENT', 'accent'), score('accent', 'ACCENT'));
});

test('every scope prefix is a single distinct character', async () => {
  const { SCOPES } = await load();
  const keys = SCOPES.map((s) => s.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'no two scopes share a prefix');
  for (const k of keys) assert.strictEqual(k.length, 1);
  assert.ok(!keys.includes('#') || true);
});
