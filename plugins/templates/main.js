// Insert a note from Templates/ at the cursor, filling in the obvious tokens.
// Tokens: {{date}} {{time}} {{title}} {{path}} {{date:+1}} (days offset).
const FOLDER = 'Templates';

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fill(text, ctx) {
  return text.replace(/\{\{(\w+)(?::([+-]?\d+))?\}\}/g, (whole, token, arg) => {
    const now = new Date();
    if (token === 'date') {
      if (arg) now.setDate(now.getDate() + Number(arg));
      return iso(now);
    }
    if (token === 'time') return now.toTimeString().slice(0, 5);
    if (token === 'title') return ctx.title || '';
    if (token === 'path') return ctx.path || '';
    return whole; // unknown token: leave it visible rather than silently eat it
  });
}

export default {
  onload(api) {
    const insert = async () => {
      const notes = await api.vault.index.all();
      const templates = notes.filter((n) => n.path.startsWith(FOLDER + '/'));
      if (!templates.length) {
        return api.notice(`Put some notes in ${FOLDER}/ first`);
      }
      const target = api.app.currentNote();
      if (!target) return api.notice('Open a note to insert into');

      const editor = api.app.editor();
      if (!editor) return api.notice('Open a note to insert into');

      api.app.menu(document.querySelector('.ribbon') || document.body, templates.map((t) => ({
        label: t.title,
        run: async () => {
          const tpl = await api.vault.note.read(t.path);
          const text = fill(tpl.body.trim(), {
            title: target.split('/').pop().replace(/\.md$/, ''),
            path: target,
          });
          editor.insert(text);
          api.notice(`Inserted ${t.title}`);
        },
      })));
      return undefined;
    };

    api.addCommand({ id: 'insert', name: 'Insert template', run: insert });
    api.addRibbon({ icon: '⧉', title: 'Insert template', run: insert });

    api.addCommand({
      id: 'new',
      name: 'New note from template',
      run: async () => {
        const notes = await api.vault.index.all();
        const templates = notes.filter((n) => n.path.startsWith(FOLDER + '/'));
        if (!templates.length) return api.notice(`Put some notes in ${FOLDER}/ first`);
        const name = await api.app.prompt('New note name', 'Untitled');
        if (!name) return undefined;
        api.app.menu(document.querySelector('.ribbon') || document.body, templates.map((t) => ({
          label: t.title,
          run: async () => {
            const tpl = await api.vault.note.read(t.path);
            const body = fill(tpl.raw, { title: name, path: name + '.md' });
            const made = await api.vault.note.create(name, body);
            await api.app.refresh();
            api.app.openNote(made.path);
          },
        })));
        return undefined;
      },
    });
  },
};
