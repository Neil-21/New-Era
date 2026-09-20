// Every open task in the vault, in one place.
// Ticking a box here rewrites that line in its own file - there is no separate
// task store to fall out of sync.
const TASK = /^(\s*[-*]\s+\[)( |x|X)(\]\s*)(.*)$/;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
// Template notes are full of placeholder checkboxes that are not real work.
const SKIP_DEFAULT = 'Templates';

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

export default {
  async onload(api) {
    const { h } = api;

    async function collect(showDone) {
      const skip = (api.settings.get().skipFolder ?? SKIP_DEFAULT)
        .split(',').map((x) => x.trim()).filter(Boolean);
      const notes = (await api.vault.index.all())
        .filter((n) => !skip.some((f) => n.path === f || n.path.startsWith(f + '/')));
      const out = [];
      for (const n of notes) {
        const note = await api.vault.note.read(n.path).catch(() => null);
        if (!note || !note.body.includes('[')) continue;
        note.body.split('\n').forEach((line, i) => {
          const m = line.match(TASK);
          if (!m) return;
          const done = /[xX]/.test(m[2]);
          if (done && !showDone) return;
          const due = (m[4].match(DATE) || note.props.date && [null, note.props.date] || [])[1] || null;
          out.push({ path: n.path, title: n.title, line: i, done, text: plain(m[4]), raw: m[4], due });
        });
      }
      return out;
    }

    async function toggle(task) {
      const note = await api.vault.note.read(task.path);
      const lines = note.body.split('\n');
      const m = lines[task.line].match(TASK);
      if (!m) return api.notice('That task moved - refresh the list');
      lines[task.line] = m[1] + (task.done ? ' ' : 'x') + m[3] + m[4];
      const head = note.raw.slice(0, note.raw.length - note.body.length);
      await api.vault.note.write(task.path, head + lines.join('\n'));
      return undefined;
    }

    const mount = async (el) => {
      const state = api.settings.get();
      let showDone = !!state.showDone;
      let group = state.group || 'note';

      const draw = async () => {
        const tasks = await collect(showDone);
        const body = h('div', { class: 'task-list' });

        if (!tasks.length) {
          body.append(h('div', { class: 'db-empty', text: 'No open tasks. Write "- [ ] something" in a note.' }));
        }

        const buckets = new Map();
        const today = new Date().toISOString().slice(0, 10);
        for (const t of tasks) {
          const key = group === 'due'
            ? (!t.due ? 'No date' : t.due < today ? 'Overdue' : t.due === today ? 'Today' : t.due)
            : t.title;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(t);
        }
        const order = group === 'due'
          ? ['Overdue', 'Today', ...[...buckets.keys()].filter((k) => !['Overdue', 'Today', 'No date'].includes(k)).sort(), 'No date']
          : [...buckets.keys()].sort();

        for (const key of order) {
          const list = buckets.get(key);
          if (!list) continue;
          body.append(h('div', { class: 'task-group' }, [
            h('div', { class: 'task-group-head' }, [
              h('span', { text: key }),
              h('span', { class: 'count', text: list.length }),
            ]),
            ...list.map((t) => h('div', { class: 'task' + (t.done ? ' is-done' : '') }, [
              h('input', {
                type: 'checkbox', checked: t.done,
                onclick: async (e) => { e.stopPropagation(); await toggle(t); draw(); },
              }),
              h('span', { class: 'task-text', text: t.text, onclick: () => api.app.openNote(t.path) }),
              group === 'due' ? null : (t.due ? h('span', { class: 'chip', style: '--chip-h:40deg', text: t.due }) : null),
              group === 'due' ? h('span', { class: 'task-src', text: t.title, onclick: () => api.app.openNote(t.path) }) : null,
            ])),
          ]));
        }

        el.replaceChildren(
          h('div', { class: 'db-toolbar' }, [
            h('div', { class: 'db-title' }, [
              h('span', { class: 'db-icon', text: '✓' }),
              h('span', { class: 'db-name-static', text: 'Tasks' }),
              h('span', { class: 'db-source', text: `${tasks.filter((t) => !t.done).length} open` }),
            ]),
            h('div', { class: 'db-tabs' }, [['note', 'by note'], ['due', 'by date']].map(([id, lbl]) => h('button', {
              class: 'db-tab' + (group === id ? ' is-active' : ''), text: lbl,
              onclick: () => { group = id; api.settings.set({ group: id }); draw(); },
            }))),
            h('div', { class: 'db-actions' }, [
              h('label', { class: 'graph-toggle' }, [
                h('input', {
                  type: 'checkbox', checked: showDone,
                  onchange: (e) => { showDone = e.target.checked; api.settings.set({ showDone }); draw(); },
                }),
                h('span', { text: 'show done' }),
              ]),
              h('button', {
                class: 'btn', text: 'Ignore\u2026',
                onclick: async () => {
                  const cur = api.settings.get().skipFolder ?? SKIP_DEFAULT;
                  const next = await api.app.prompt('Folders to ignore (comma separated)', cur);
                  if (next === null) return;
                  api.settings.set({ skipFolder: next });
                  draw();
                },
              }),
              h('button', { class: 'btn', text: 'Refresh', onclick: () => draw() }),
            ]),
          ]),
          body,
        );
      };

      await draw();
    };

    api.addView({ id: 'all', name: 'Tasks across the vault', mount });
    api.addRibbon({ icon: '✓', title: 'Tasks', run: () => api.app.openViewById('tasks:all') });
  },
};
