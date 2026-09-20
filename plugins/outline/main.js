// Headings of the open note, in the right panel. Click one to jump to it.
export default {
  onload(api) {
    const { h } = api;

    api.addRailPanel({
      id: 'outline',
      title: 'Outline',
      async mount(el, ctx) {
        const note = await api.vault.note.read(ctx.path).catch(() => null);
        if (!note) return;

        const heads = [];
        let inFence = false;
        note.body.split('\n').forEach((line, i) => {
          if (/^\s*```/.test(line)) { inFence = !inFence; return; }
          if (inFence) return;
          const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
          if (m) heads.push({ level: m[1].length, text: m[2], line: i });
        });

        if (!heads.length) {
          el.append(h('div', { class: 'muted', text: 'No headings yet' }));
          return;
        }

        // Normalise so a note starting at ## does not render indented.
        const top = Math.min(...heads.map((x) => x.level));
        const offset = note.raw.length - note.body.length;

        for (const head of heads) {
          el.append(h('a', {
            class: 'rail-link outline-link', text: head.text,
            style: `--indent:${head.level - top}`,
            onclick: () => {
              const editor = api.app.editor();
              if (!editor) return;
              const lineNo = head.line + 1;
              const doc = editor.view.state.doc;
              const before = doc.lineAt(Math.min(offset, doc.length)).number - 1;
              const target = Math.min(doc.lines, before + lineNo);
              const pos = doc.line(target).from;
              editor.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
              editor.view.focus();
            },
          }));
        }
      },
    });
  },
};
