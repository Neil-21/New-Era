// Our own plugin system. Not Obsidian's, not Logseq's, no registry.
// A plugin is a folder with main.js that default-exports { onload(api) }.
// Drop it in ./plugins or <vault>/.hermes/plugins.
export class PluginHost {
  constructor(app) {
    this.app = app;
    this.available = [];   // everything found on disk
    this.loaded = new Map();
    this.commands = new Map();
    this.ribbon = [];
    this.views = new Map();
    this.rails = [];
    this.listeners = new Map();
    this.disabled = new Set();
  }

  // The API surface handed to a plugin. Everything a plugin can do goes
  // through here, so there is one list to read when something misbehaves.
  api(meta) {
    const host = this;
    return {
      id: meta.id,
      app: {
        openNote: (p) => host.app.openNote(p),
        openView: (spec) => host.app.openDatabase(spec),
        openGraph: (mode) => host.app.openGraph(mode),
        openViewById: (id) => host.app.openPluginView(id),
        openSidebarTab: (tab) => { host.app.sidebarTab = tab; host.app.renderSidebar(); },
        runCommand: (id) => host.app.command(id),
        assetUrl: (src) => host.app.assetUrl(src),
        get dataFile() { return host.app.dataFile; },
        currentNote: () => host.app.lastNotePath || null,
        refresh: () => host.app.refresh(),
        toast: (m) => host.app.toast(m),
        prompt: (label, value) => host.app.prompt(label, value),
        menu: (anchor, items) => host.app.menu(anchor, items),
        editor: () => host.app.editor,
      },
      vault: window.hermes,
      // Build DOM without every plugin shipping its own helper.
      h: (tag, attrs = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'class') el.className = v;
          else if (k === 'text') el.textContent = v;
          else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
          else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
        }
        for (const kid of [].concat(kids)) if (kid) el.append(kid);
        return el;
      },
      addCommand: (cmd) => host.commands.set(`${meta.id}:${cmd.id}`, { ...cmd, plugin: meta.id }),
      addRibbon: (item) => host.ribbon.push({ ...item, plugin: meta.id }),
      // A full-pane view, opened from the command palette or a ribbon button.
      addView: (view) => host.views.set(`${meta.id}:${view.id}`, { ...view, plugin: meta.id }),
      // A panel in the right rail, re-mounted on every note open.
      addRailPanel: (panel) => host.rails.push({ ...panel, plugin: meta.id }),
      on: (event, fn) => {
        if (!host.listeners.has(event)) host.listeners.set(event, []);
        host.listeners.get(event).push({ fn, plugin: meta.id });
      },
      settings: {
        get: () => (host.app.settings.values.plugins || {})[meta.id] || {},
        set: (patch) => {
          const all = { ...(host.app.settings.values.plugins || {}) };
          all[meta.id] = { ...(all[meta.id] || {}), ...patch };
          host.app.settings.set({ plugins: all });
        },
      },
      notice: (m) => host.app.toast(m),
    };
  }

  async loadAll(disabled = []) {
    this.disabled = new Set(disabled);
    this.available = await window.hermes.plugins.list();
    this.commands.clear();
    this.ribbon = [];
    this.views.clear();
    this.rails = [];
    this.listeners.clear();
    this.loaded.clear();

    for (const meta of this.available) {
      if (this.disabled.has(meta.id)) continue;
      try {
        // Cache-bust so a re-enable picks up an edited file.
        const mod = await import(/* @vite-ignore */ meta.url + '?v=' + Date.now());
        const plugin = mod.default || mod;
        if (typeof plugin.onload === 'function') await plugin.onload(this.api(meta));
        this.loaded.set(meta.id, { ...meta, plugin });
      } catch (err) {
        console.error(`[hermes] plugin "${meta.id}" failed to load`, err);
        this.app.toast(`Plugin ${meta.id} failed: ${err.message}`);
      }
    }
    return [...this.loaded.values()];
  }

  async setEnabled(id, on) {
    const next = new Set(this.disabled);
    if (on) next.delete(id); else next.add(id);
    this.app.settings.set({ disabledPlugins: [...next] });
    await this.loadAll([...next]);
    this.app.renderRibbon();
    if (this.app.lastNotePath && this.app.current && this.app.current.type === 'note') {
      this.app.renderRight(this.app.lastNotePath);
    }
  }

  emit(event, payload) {
    for (const { fn, plugin } of this.listeners.get(event) || []) {
      try { fn(payload); } catch (err) { console.error(`[hermes] ${plugin} ${event} handler`, err); }
    }
  }

  allCommands() {
    const out = [...this.commands.entries()].map(([id, c]) => ({ id, name: c.name, run: c.run }));
    for (const [id, v] of this.views) {
      out.push({ id: 'view:' + id, name: v.name, run: () => this.app.openPluginView(id) });
    }
    return out;
  }
}
