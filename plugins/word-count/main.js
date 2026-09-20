// Example NEW ERA plugin. Copy this folder to start your own.
// Lives in ./plugins or <vault>/.new-era/plugins. No build step, no registry.
export default {
  async onload(api) {
    const count = async () => {
      const path = api.app.currentNote();
      if (!path) return api.notice('No note open');
      const note = await api.vault.note.read(path);
      const words = (note.body.match(/\b[\w'-]+\b/g) || []).length;
      api.notice(`${words} words - about ${Math.max(1, Math.round(words / 220))} min read`);
    };

    api.addCommand({ id: 'count', name: 'Word count of current note', run: count });
    api.addRibbon({ icon: '#', title: 'Word count', run: count });
    api.on('note:open', ({ path }) => console.log('[word-count] opened', path));
  },
};
