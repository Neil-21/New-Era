// Page history is the safety net, so the rules that decide what is kept are pinned down.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { History, writeAtomic, EDIT_GAP } = require('../src/history.js');

function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newera-history-'));
  fs.mkdirSync(path.join(dir, 'Notes'));
  return dir;
}

test('keeps a copy, skips duplicates and throttles typing', () => {
  const h = new History(vault());
  const t = 1_700_000_000_000;
  assert.ok(h.snapshot('Notes/A.md', 'one', 'edit', t));
  assert.equal(h.snapshot('Notes/A.md', 'one', 'edit', t + EDIT_GAP * 2), null, 'same text twice');
  assert.equal(h.snapshot('Notes/A.md', 'two', 'edit', t + 1000), null, 'too soon while typing');
  assert.ok(h.snapshot('Notes/A.md', 'two', 'deleted', t + 2000), 'deletes always get a copy');
  assert.ok(h.snapshot('Notes/A.md', 'three', 'edit', t + EDIT_GAP + 3000));
  const list = h.versions('Notes/A.md');
  assert.deepEqual(list.map((v) => v.reason), ['edit', 'deleted', 'edit']);
  assert.equal(h.read('Notes/A.md', list[1].id), 'two');
  assert.equal(h.snapshot('Notes/A.md', '   ', 'edit', t + EDIT_GAP * 9), null, 'blank pages are not worth a copy');
});

test('history follows a rename and finds deleted pages', () => {
  const dir = vault();
  const h = new History(dir);
  fs.writeFileSync(path.join(dir, 'Notes', 'Kept.md'), 'here');
  h.snapshot('Notes/Kept.md', 'old kept', 'edit', 1);
  h.snapshot('Notes/Gone.md', 'old gone', 'deleted', 2);
  h.snapshot('Notes/Old name.md', 'renamed text', 'renamed', 3);
  h.move('Notes/Old name.md', 'Notes/Kept.md');
  assert.equal(h.versions('Notes/Kept.md').length, 2, 'rename merged into the new name');
  assert.deepEqual(h.deleted().map((d) => d.path), ['Notes/Gone.md']);
});

test('rejects paths that escape the history folder', () => {
  const h = new History(vault());
  assert.throws(() => h.snapshot('../../evil.md', 'x'));
  assert.throws(() => h.read('Notes/A.md', '../../../x.md'));
});

test('atomic write leaves no temp file behind', () => {
  const dir = vault();
  const f = path.join(dir, 'Notes', 'B.md');
  writeAtomic(f, 'first');
  writeAtomic(f, 'second');
  assert.equal(fs.readFileSync(f, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Notes')), ['B.md']);
});
