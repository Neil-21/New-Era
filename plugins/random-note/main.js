// Open a random note. Surprisingly good at surfacing things you forgot.
export default {
  onload(api) {
    const open = async () => {
      const notes = await api.vault.index.all();
      if (!notes.length) return api.notice('This vault is empty');
      const current = api.app.currentNote();
      const pool = notes.length > 1 ? notes.filter((n) => n.path !== current) : notes;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      api.app.openNote(pick.path);
      return api.notice(pick.title);
    };
    api.addCommand({ id: 'open', name: 'Open a random note', run: open });
    api.addRibbon({ icon: '\u2684', title: 'Random note', run: open });
  },
};
