// Kanban board for a single note.
// Columns are `## headings`, cards are the list items under them. Moving a card
// rewrites the markdown, so the board and the file are the same thing.
const CARD = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/;

// Cards show text, not syntax. This only affects display - the file keeps its
// markdown exactly as written.
export function plain(text) {
  return text
    .replace(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, target, alias) => (alias || target).trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function parse(body) {
  const lines = body.split('\n');
  const cols = [];
  let current = null;
  lines.forEach((text, i) => {
    const head = text.match(/^##\s+(.+?)\s*$/);
    if (head) {
      current = { name: head[1], headLine: i, cards: [], lastLine: i };
      cols.push(current);
      return;
    }
    if (/^#\s+/.test(text)) { current = null; return; } // an h1 ends the board
    if (!current) return;
    const card = text.match(CARD);
    if (card) {
      current.cards.push({ line: i, done: /[xX]/.test(card[1] || ''), text: card[2] });
      current.lastLine = i;
    } else if (text.trim()) {
      current.lastLine = i;
    }
  });
  return { lines, cols };
}

// Move one line to the end of another column, then re-emit the document.
function move(body, fromLine, toColName, { done } = {}) {
  const { lines, cols } = parse(body);
  const target = cols.find((c) => c.name === toColName);
  if (!target) return body;
  const raw = lines[fromLine];
  const card = raw.match(CARD);
  let text = raw;
  if (card && done !== undefined) {
    text = raw.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  }
  const rest = lines.filter((_, i) => i !== fromLine);
  // Insert position shifts by one when the removed line was above the target.
  const at = (fromLine < target.lastLine ? target.lastLine - 1 : target.lastLine) + 1;
  rest.splice(at, 0, text);
  return rest.join('\n');
}

export default {
  async onload(api) {
    const { h } = api;

    const write = async (path, nextBody) => {
      const note = await api.vault.note.read(path);
      await api.vault.note.write(path, note.raw.slice(0, note.raw.length - note.body.length) + nextBody);
    };

    const mount = async (el, ctx, override) => {
      const path = override || ctx.notePath || api.app.currentNote();
      if (!path) {
        el.replaceChildren(h('div', { class: 'db-empty' }, [
          h('p', { text: 'A board is built from one note: its "## headings" become the columns.' }),
          h('button', {
            class: 'btn btn-primary', text: 'Choose a note\u2026',
            onclick: (e) => pick(e.currentTarget, el, ctx),
          }),
        ]));
        return;
      }
      const note = await api.vault.note.read(path);
      const { cols } = parse(note.body);

      const redraw = async (nextBody) => {
        await write(path, nextBody);
        await mount(el, ctx, path);
      };

      if (!cols.length) {
        el.replaceChildren(h('div', { class: 'db-empty' }, [
          h('p', { text: 'No "## headings" in this note yet - they become the columns.' }),
          h('button', {
            class: 'btn btn-primary', text: 'Add Todo / Doing / Done',
            onclick: () => redraw(note.body.trimEnd()
              + '\n\n## Todo\n\n## Doing\n\n## Done\n'),
          }),
          h('button', {
            class: 'btn', text: 'Board a different note\u2026',
            onclick: (e) => pick(e.currentTarget, el, ctx),
          }),
        ]));
        return;
      }

      const board = h('div', { class: 'db-board' });
      for (const col of cols) {
        const column = h('div', { class: 'board-col' }, [
          h('div', { class: 'board-head' }, [
            h('span', { class: 'chip', style: '--chip-h:210deg', text: col.name }),
            h('span', { class: 'count', text: col.cards.length }),
          ]),
        ]);

        for (const card of col.cards) {
          const el2 = h('div', { class: 'card' + (card.done ? ' is-done' : ''), draggable: 'true' }, [
            h('div', { class: 'card-title', text: plain(card.text) }),
          ]);
          el2.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(card.line)));
          el2.addEventListener('click', () => {
            api.app.openNote(path);
          });
          column.append(el2);
        }

        column.append(h('button', {
          class: 'btn-ghost board-add', text: '+ Card',
          onclick: async () => {
            const text = await api.app.prompt('Card text');
            if (!text) return;
            const fresh = parse((await api.vault.note.read(path)).body);
            const target = fresh.cols.find((c) => c.name === col.name);
            const lines = fresh.lines.slice();
            lines.splice(target.lastLine + 1, 0, `- [ ] ${text}`);
            await redraw(lines.join('\n'));
          },
        }));

        column.addEventListener('dragover', (e) => { e.preventDefault(); column.classList.add('is-over'); });
        column.addEventListener('dragleave', () => column.classList.remove('is-over'));
        column.addEventListener('drop', async (e) => {
          e.preventDefault();
          column.classList.remove('is-over');
          const line = Number(e.dataTransfer.getData('text/plain'));
          if (Number.isNaN(line)) return;
          const fresh = await api.vault.note.read(path);
          // A card landing in a column called Done is done.
          const done = /^(done|complete|completed|shipped)$/i.test(col.name) ? true
            : /^(todo|to do|backlog|doing|in progress)$/i.test(col.name) ? false : undefined;
          await redraw(move(fresh.body, line, col.name, { done }));
        });

        board.append(column);
      }

      const title = note.props.title || path.split('/').pop().replace(/\.md$/, '');
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'vault root';
      const cardCount = cols.reduce((n, c) => n + c.cards.length, 0);

      el.replaceChildren(
        h('div', { class: 'db-toolbar' }, [
          h('div', { class: 'db-title' }, [
            h('span', { class: 'db-icon', text: note.props.icon || '▤' }),
            h('div', { class: 'kanban-head' }, [
              h('div', { class: 'db-name-static', text: title }),
              h('div', { class: 'kanban-path', text: `${folder} \u00b7 board of ${cols.length} columns, ${cardCount} cards` }),
            ]),
          ]),
          h('div', { class: 'db-actions' }, [
            h('button', {
              class: 'btn', text: 'Board another note\u2026',
              onclick: (e) => pick(e.currentTarget, el, ctx),
            }),
            h('button', { class: 'btn', text: 'Open as note', onclick: () => api.app.openNote(path) }),
            h('button', { class: 'btn', text: 'Refresh', onclick: () => mount(el, ctx, path) }),
          ]),
        ]),
        board,
      );
    };

    // Which note to board is a choice, so make it one instead of a guess.
    async function pick(anchor, el, ctx) {
      const notes = await api.vault.index.all();
      if (!notes.length) return api.notice('This vault has no notes yet');
      api.app.menu(anchor, notes.slice(0, 40).map((n) => ({
        label: n.folder ? `${n.title}  \u2014  ${n.folder}` : n.title,
        run: () => mount(el, ctx, n.path),
      })));
      return undefined;
    }

    api.addView({ id: 'board', name: 'Kanban', mount });
    api.addRibbon({
      icon: '▤', title: 'Kanban board',
      run: () => api.app.openViewById('kanban:board'),
    });
  },
};

export { parse, move };
