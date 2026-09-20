// The plugins ship real logic, so they get real checks. Everything here is
// pure text transformation, which is exactly the part that can silently
// corrupt a note.
const test = require('node:test');
const assert = require('node:assert');

const load = (name) => import('../plugins/' + name + '/main.js');

test('kanban: headings become columns, list items become cards', async () => {
  const { parse } = await load('kanban');
  const body = '# Note\n\n## Todo\n- [ ] a\n- [ ] b\n\n## Done\n- [x] z\n';
  const cols = parse(body).cols;
  assert.deepStrictEqual(cols.map((c) => c.name), ['Todo', 'Done']);
  assert.deepStrictEqual(cols[0].cards.map((c) => c.text), ['a', 'b']);
  assert.strictEqual(cols[1].cards[0].done, true);
  assert.strictEqual(cols[0].cards[0].done, false);
});

test('kanban: a second h1 ends the board', async () => {
  const { parse } = await load('kanban');
  const cols = parse('## A\n- one\n\n# Other section\n\n- not a card\n').cols;
  assert.deepStrictEqual(cols.map((c) => c.name), ['A']);
  assert.deepStrictEqual(cols[0].cards.map((c) => c.text), ['one']);
});

test('kanban: moving a card keeps every other line intact', async () => {
  const { move, parse } = await load('kanban');
  const body = '# N\n\n## Todo\n- [ ] a\n- [ ] b\n\n## Done\n- [x] z\n';

  const down = move(body, 3, 'Done', { done: true });
  assert.deepStrictEqual(parse(down).cols.map((c) => c.cards.map((x) => x.text)), [['b'], ['z', 'a']]);
  assert.match(down, /- \[x\] a/, 'dropping into Done ticks the box');

  const up = move(body, 7, 'Todo', { done: false });
  assert.deepStrictEqual(parse(up).cols.map((c) => c.cards.map((x) => x.text)), [['a', 'b', 'z'], []]);
  assert.match(up, /- \[ \] z/, 'dropping back into Todo unticks it');

  // No line may be lost or duplicated by a move.
  assert.strictEqual(down.split('\n').length, body.split('\n').length);
  assert.strictEqual(up.split('\n').length, body.split('\n').length);
});

test('kanban: moving into a column that vanished is a no-op', async () => {
  const { move } = await load('kanban');
  const body = '## Todo\n- [ ] a\n';
  assert.strictEqual(move(body, 1, 'Ghost'), body);
});

test('templates: tokens fill, unknown tokens survive', async () => {
  const { fill } = await load('templates');
  const out = fill('{{title}} / {{path}} / {{date}} / {{date:+1}} / {{time}} / {{mystery}}',
    { title: 'Spec', path: 'Notes/Spec.md' });
  const [title, path, today, tomorrow, time, unknown] = out.split(' / ');
  assert.strictEqual(title, 'Spec');
  assert.strictEqual(path, 'Notes/Spec.md');
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(time, /^\d{2}:\d{2}$/);
  assert.strictEqual(unknown, '{{mystery}}', 'unknown tokens stay visible, not silently eaten');
  assert.strictEqual(
    (new Date(tomorrow) - new Date(today)) / 86400000, 1, 'date:+1 is one day later');
});

test('plain(): cards read as text, never as syntax', async () => {
  const { plain } = await load('kanban');
  assert.strictEqual(plain('Re-ID head for [[SpectraTrack]]'), 'Re-ID head for SpectraTrack');
  assert.strictEqual(plain('[[Note#Heading|Shown]]'), 'Shown');
  assert.strictEqual(plain('Write ==docs== in **bold** and *ital* and `code`'),
    'Write docs in bold and ital and code');
  assert.strictEqual(plain('[link](http://x) plain'), 'link plain');
  assert.strictEqual(plain('nothing to strip'), 'nothing to strip');
});

test('export: markdown renders to HTML with structure intact', async () => {
  const { renderMarkdown } = await load('export');
  const md = [
    '# Title', '', 'A **bold** ==hot== `code` [[Link|alias]] word.', '',
    '> [!warning] Careful', '> Body line', '',
    '- [ ] todo', '- [x] done', '',
    '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
    '```js', 'const x = 1 < 2;', '```', '', '![[rig.png]]',
  ].join('\n');
  const html = renderMarkdown(md, (s) => 'file:///V/' + s);

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<mark>hot<\/mark>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /class="wl">alias</);
  assert.match(html, /callout callout-warning/);
  assert.match(html, /<input type="checkbox" disabled>/, 'unchecked task');
  assert.match(html, /<input type="checkbox" disabled checked>/, 'checked task');
  assert.match(html, /<th>a<\/th>[\s\S]*<td>1<\/td>/);
  assert.match(html, /<pre><code class="lang-js">const x = 1 &lt; 2;<\/code><\/pre>/,
    'code is escaped, not interpreted');
  assert.match(html, /<img src="file:\/\/\/V\/rig\.png"/);
});

test('export: HTML injection in note text is escaped', async () => {
  const { renderMarkdown } = await load('export');
  const html = renderMarkdown('Hello <script>alert(1)</script> & "quotes"');
  assert.ok(!html.includes('<script>'), 'script tag must not survive');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('export: backticks protect their contents from formatting', async () => {
  const { renderMarkdown } = await load('export');
  const html = renderMarkdown('`**not bold** and ==not marked==`');
  assert.match(html, /<code>\*\*not bold\*\* and ==not marked==<\/code>/);
});
