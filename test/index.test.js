'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseFrontmatter, setFrontmatter, parseLinks, frontmatterTags, titleOf,
} = require('../src/parse.js');
const { Index } = require('../src/db.js');

test('frontmatter: scalars, inline lists, block lists', () => {
  const { data, body } = parseFrontmatter(
    '---\ntitle: Spectra\nstatus: Active\ndone: false\nscore: 4.5\n'
    + 'tags: [ml, vision]\npeople:\n  - Avery\n  - Ada\n---\n\n# Body\n');
  assert.deepStrictEqual(data, {
    title: 'Spectra', status: 'Active', done: false, score: 4.5,
    tags: ['ml', 'vision'], people: ['Avery', 'Ada'],
  });
  assert.strictEqual(body.trim(), '# Body');
});

test('frontmatter: no frontmatter is not an error', () => {
  const { data, body } = parseFrontmatter('# Just a note\n');
  assert.deepStrictEqual(data, {});
  assert.strictEqual(body, '# Just a note\n');
});

test('setFrontmatter edits in place and leaves the body byte-identical', () => {
  const raw = '---\nstatus: Todo\nowner: Avery\n---\n\n# Hi\n\nbody `text` here\n';
  const out = setFrontmatter(raw, { status: 'Done' });
  assert.match(out, /status: Done/);
  assert.match(out, /owner: Avery/);
  assert.strictEqual(out.slice(out.indexOf('# Hi')), raw.slice(raw.indexOf('# Hi')));
});

test('setFrontmatter adds keys, deletes with undefined, replaces block lists', () => {
  const raw = '---\nstatus: Todo\ntags:\n  - a\n  - b\ndrop: me\n---\n\nbody\n';
  const out = setFrontmatter(raw, { tags: ['x'], drop: undefined, owner: 'Ada' });
  const { data } = parseFrontmatter(out);
  assert.deepStrictEqual(data, { status: 'Todo', tags: ['x'], owner: 'Ada' });
  assert.ok(!('drop' in data));
});

test('setFrontmatter creates a block when the file has none', () => {
  const out = setFrontmatter('# Note\n\ntext\n', { status: 'New' });
  assert.ok(out.startsWith('---\nstatus: New\n---\n'));
  assert.deepStrictEqual(parseFrontmatter(out).data, { status: 'New' });
  assert.match(parseFrontmatter(out).body, /# Note/);
});

test('values that would break YAML get quoted on write', () => {
  const out = setFrontmatter('x\n', { note: 'a: b', arr: ['one', 'two'] });
  const { data } = parseFrontmatter(out);
  assert.strictEqual(data.note, 'a: b');
  assert.deepStrictEqual(data.arr, ['one', 'two']);
});

test('links: wikilinks, aliases, embeds, tags, md links; code spans ignored', () => {
  const links = parseLinks(
    'See [[Trace21x]] and [[Deep/Note|alias]].\n'
    + '![[cover.md]]\n#project #a/b\n[md](Other%20Note.md)\n'
    + '`[[NotALink]]` and\n```\n[[AlsoNot]]\n```\n');
  const by = (t) => links.filter((l) => l.type === t).map((l) => l.target);
  assert.deepStrictEqual(by('wikilink'), ['Trace21x', 'Deep/Note', 'Other Note.md']);
  assert.deepStrictEqual(by('embed'), ['cover.md']);
  assert.deepStrictEqual(by('tag'), ['project', 'a/b']);
  assert.strictEqual(links.find((l) => l.target === 'Deep/Note').alias, 'alias');
  assert.ok(!links.some((l) => /NotALink|AlsoNot/.test(l.target)));
});

test('links: heading and block refs strip to the note', () => {
  const links = parseLinks('[[Note#Heading]] [[Note2^blockid|shown]]');
  assert.deepStrictEqual(links.map((l) => l.target), ['Note', 'Note2']);
});

test('title falls back frontmatter -> h1 -> filename', () => {
  assert.strictEqual(titleOf('a/b.md', { title: 'FM' }, '# H1'), 'FM');
  assert.strictEqual(titleOf('a/b.md', {}, 'intro\n# H1\n'), 'H1');
  assert.strictEqual(titleOf('a/My Note.md', {}, 'no heading'), 'My Note');
});

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'new-era-'));
  const w = (p, s) => {
    fs.mkdirSync(path.join(v, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(v, p), s);
  };
  w('Projects/SpectraTrack.md',
    '---\nstatus: Active\nowner: Avery\ntags: [ml]\n---\n\n# SpectraTrack\n\nPairs with [[Trace21x]]. #ml\n');
  w('Projects/Trace21x.md', '---\nstatus: Paused\nowner: Avery\n---\n\n# Trace21x\n\nBack to [[SpectraTrack]].\n');
  w('Daily/2026-09-20.md', '# Today\n\nWorked on [[SpectraTrack]] and [[Ghost Note]].\n');
  return v;
}

test('index: sync, query, filter, backlinks, search, rename-safety', (t) => {
  const v = vault();
  const ix = new Index(v);
  t.after(() => { ix.close(); fs.rmSync(v, { recursive: true, force: true }); });

  assert.deepStrictEqual(ix.sync(), { total: 3, changed: 3, removed: 0 });
  assert.strictEqual(ix.sync().changed, 0, 'second sync is a no-op');

  const active = ix.query({ folder: 'Projects', filters: [{ prop: 'status', op: 'is', value: 'Active' }] });
  assert.deepStrictEqual(active.map((r) => r.title), ['SpectraTrack']);
  assert.deepStrictEqual(active[0].props.tags, ['ml']);

  assert.strictEqual(ix.query({ folder: 'Projects' }).length, 2);
  assert.strictEqual(ix.query({ tag: 'ml' }).length, 1);
  assert.strictEqual(ix.query({ filters: [{ prop: 'status', op: 'not-empty' }] }).length, 2);

  assert.deepStrictEqual(
    ix.query({ folder: 'Projects', sort: { prop: 'status', desc: true } }).map((r) => r.title),
    ['Trace21x', 'SpectraTrack']);

  assert.deepStrictEqual(ix.propKeys({ folder: 'Projects' }).map((p) => p.key),
    ['status', 'owner', 'tags']);
  assert.deepStrictEqual(ix.propValues('status', { folder: 'Projects' }),
    [{ value: 'Active', n: 1 }, { value: 'Paused', n: 1 }]);

  assert.deepStrictEqual(
    ix.backlinks('Projects/SpectraTrack.md').map((b) => b.path).sort(),
    ['Daily/2026-09-20.md', 'Projects/Trace21x.md']);

  assert.deepStrictEqual(ix.search('pairs').map((r) => r.path), ['Projects/SpectraTrack.md']);
  assert.deepStrictEqual(ix.search('spectra').map((r) => r.path).sort(),
    ['Daily/2026-09-20.md', 'Projects/SpectraTrack.md', 'Projects/Trace21x.md']);
  assert.deepStrictEqual(ix.search('zzz"*(('), [], 'malformed query must not throw');

  // A link to a note that does not exist yet stays unresolved, then resolves.
  assert.strictEqual(ix.stats().unresolved, 1);
  fs.writeFileSync(path.join(v, 'Ghost Note.md'), '# Ghost Note\n');
  ix.sync();
  assert.strictEqual(ix.stats().unresolved, 0);
  assert.strictEqual(ix.backlinks('Ghost Note.md').length, 1);

  // Deleting a note must not leave dangling resolved links behind.
  fs.rmSync(path.join(v, 'Ghost Note.md'));
  assert.deepStrictEqual(ix.sync(), { total: 3, changed: 0, removed: 1 });
  assert.strictEqual(ix.note('Ghost Note.md'), undefined);
  assert.strictEqual(ix.stats().unresolved, 1);
});

test('index: filter values are bound, not interpolated', (t) => {
  const v = vault();
  const ix = new Index(v);
  t.after(() => { ix.close(); fs.rmSync(v, { recursive: true, force: true }); });
  ix.sync();
  const rows = ix.query({ filters: [{ prop: 'status', op: 'is', value: "x' OR 1=1 --" }] });
  assert.strictEqual(rows.length, 0, 'injection attempt must match nothing');
  assert.strictEqual(ix.query({ filters: [{ prop: 'status', op: 'bogus-op' }] }).length, 3);
});

test('a vault from before the rename keeps its settings and views', (t) => {
  const v = vault();
  // Simulate the old layout: config lives in .hermes, not .new-era.
  const legacy = path.join(v, '.hermes');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'views.json'), '[{"id":"keepme","name":"Projects"}]');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"theme":"midnight"}');

  const ix = new Index(v);
  t.after(() => { ix.close(); fs.rmSync(v, { recursive: true, force: true }); });

  const moved = path.join(v, '.new-era');
  assert.ok(fs.existsSync(moved), 'config folder is carried over, not abandoned');
  assert.ok(!fs.existsSync(legacy), 'the old folder does not linger as a decoy');
  assert.match(fs.readFileSync(path.join(moved, 'views.json'), 'utf8'), /keepme/);
  assert.match(fs.readFileSync(path.join(moved, 'settings.json'), 'utf8'), /midnight/);
  assert.strictEqual(ix.sync().total, 3, 'and the vault still indexes normally');
});

test('a fresh vault is untouched by the migration path', (t) => {
  const v = vault();
  const ix = new Index(v);
  t.after(() => { ix.close(); fs.rmSync(v, { recursive: true, force: true }); });
  assert.ok(fs.existsSync(path.join(v, '.new-era')));
  assert.strictEqual(ix.sync().total, 3);
});

test('a template heading does not become the note title', () => {
  // Templates hold `# {{title}}` until they are used; the filename is a better
  // name than the raw token.
  assert.strictEqual(titleOf('Templates/Meeting.md', {}, '# {{title}}\n\nnotes'), 'Meeting');
  assert.strictEqual(titleOf('Templates/Project.md', { title: '{{title}}' }, '# {{title}}'), 'Project');
  assert.strictEqual(titleOf('Templates/Standup.md', {}, '# {{date}} standup'), 'Standup');
  // A real heading still wins over the filename.
  assert.strictEqual(titleOf('Notes/untitled-3.md', {}, '# Real heading'), 'Real heading');
  assert.strictEqual(titleOf('Notes/x.md', { title: 'From frontmatter' }, '# H1'), 'From frontmatter');
});

test('a parser change rebuilds notes that have not been touched', (t) => {
  const v = vault();
  const first = new Index(v);
  first.sync();
  // Pretend the index was written by an older parser.
  first.db.prepare("UPDATE meta SET value = 'stale' WHERE key = 'parser'").run();
  first.db.prepare("UPDATE notes SET title = 'WRONG'").run();
  first.close();

  const second = new Index(v);
  t.after(() => { second.close(); fs.rmSync(v, { recursive: true, force: true }); });

  assert.strictEqual(second.all().length, 0, 'stale rows are dropped on open');
  assert.strictEqual(second.sync().changed, 3, 'and every note is re-read');
  assert.ok(!second.all().some((n) => n.title === 'WRONG'), 'no stale titles survive');

  // Opening again with the same parser must not throw the index away.
  second.close();
  const third = new Index(v);
  assert.strictEqual(third.all().length, 3, 'a matching version keeps the index');
  assert.strictEqual(third.sync().changed, 0);
  third.close();
});

test('frontmatter tags count as tags, like inline ones', () => {
  assert.deepStrictEqual(frontmatterTags({ tags: ['demo', 'research'] }), ['demo', 'research']);
  assert.deepStrictEqual(frontmatterTags({ tags: 'demo, research' }), ['demo', 'research']);
  assert.deepStrictEqual(frontmatterTags({ tags: '#demo' }), ['demo'], 'a leading # is optional');
  assert.deepStrictEqual(frontmatterTags({ tag: 'single' }), ['single']);
  assert.deepStrictEqual(frontmatterTags({}), []);
  assert.deepStrictEqual(frontmatterTags({ tags: '' }), []);
  assert.deepStrictEqual(frontmatterTags({ tags: ['a', 'a'] }), ['a'], 'no duplicates');
});

test('index: a note tagged only in frontmatter is findable by that tag', (t) => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'Welcome.md'), '---\ntags: [demo, research]\n---\n\n# Welcome\n');
  const ix = new Index(v);
  t.after(() => { ix.close(); fs.rmSync(v, { recursive: true, force: true }); });
  ix.sync();

  const tags = Object.fromEntries(ix.tags().map((t2) => [t2.tag, t2.n]));
  assert.strictEqual(tags.demo, 1);
  assert.strictEqual(tags.research, 1);
  assert.strictEqual(tags.ml, 1, 'inline #tags still work');
  assert.deepStrictEqual(ix.query({ tag: 'demo' }).map((r) => r.title), ['Welcome']);

  // A tag in both places must not double-count.
  fs.writeFileSync(path.join(v, 'Welcome.md'), '---\ntags: [demo]\n---\n\n# Welcome\n\n#demo\n');
  ix.sync();
  assert.strictEqual(ix.tags().find((t2) => t2.tag === 'demo').n, 1, 'counted once, not twice');
});
