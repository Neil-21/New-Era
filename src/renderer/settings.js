// Settings: appearance, editor, keybindings, plugins.
// Appearance values are CSS custom properties, so applying them is one style
// write with no re-render. Everything lives in <vault>/.new-era/settings.json.
import { h } from './dbview.js';
import { label as keyLabel, fromEvent } from './keymap.js';

export const DEFAULTS = {
  theme: 'dark',
  accent: '#7c9cff',
  fontText: 'system',
  editorSize: 16,
  editorLeading: 1.7,
  noteWidth: 760,
  coverHeight: 180,
  sidebarWidth: 250,
  highlight: '#e0c04e',
  newNoteFolder: '',
  attachmentMode: 'subfolder',
  attachmentFolder: 'attachments',
  showAttachments: false,
  dailyFolder: 'Daily',
  keys: {},
  disabledPlugins: [],
  plugins: {},
};

const FONTS = {
  system: 'ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, sans-serif',
  inter: 'Inter, ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  serif: 'Iowan Old Style, Charter, Georgia, "Times New Roman", serif',
  mono: 'var(--font-mono)',
};

const ACCENTS = ['#7c9cff', '#8b7cf6', '#ec6a9c', '#f08c4b', '#3fb984', '#48b0d0', '#c9a227', '#d1495b'];
const HIGHLIGHTS = ['#e0c04e', '#7ad17a', '#69b7e8', '#e08ab8', '#c79bf0', '#e0885a'];

// titleBarOverlay only accepts opaque hex, so trim anything else away.
function hex(value) {
  const m = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  return m ? '#' + m[1] : null;
}

export class Settings {
  constructor(app) {
    this.app = app;
    this.values = { ...DEFAULTS };
    this.tab = 'appearance';
  }

  async load() {
    const saved = await window.newEra.settings.get();
    this.values = { ...DEFAULTS, ...saved };
    this.apply();
    return this.values;
  }

  set(patch) {
    this.values = { ...this.values, ...patch };
    this.apply();
    window.newEra.settings.save(this.values);
  }

  reset() {
    this.values = { ...DEFAULTS, plugins: this.values.plugins };
    this.apply();
    window.newEra.settings.save(this.values);
  }

  apply() {
    const v = this.values;
    const root = document.documentElement;
    root.dataset.theme = v.theme;
    root.style.setProperty('--accent', v.accent);
    root.style.setProperty('--highlight', v.highlight);
    root.style.setProperty('--font-text', FONTS[v.fontText] || FONTS.system);
    root.style.setProperty('--editor-size', v.editorSize + 'px');
    root.style.setProperty('--editor-leading', String(v.editorLeading));
    root.style.setProperty('--note-width', v.noteWidth + 'px');
    root.style.setProperty('--cover-height', v.coverHeight + 'px');
    root.style.setProperty('--sidebar-width', v.sidebarWidth + 'px');
    // Repaint the native window buttons to match the theme.
    const css = getComputedStyle(root);
    window.newEra.setChromeTheme({
      color: hex(css.getPropertyValue('--bg-2')) || '#1c1c1c',
      symbolColor: hex(css.getPropertyValue('--text-dim')) || '#9a9a9a',
    });
  }

  // --- panel ---------------------------------------------------------------

  panel() {
    const body = h('div', { class: 'set-body' });
    const tabs = [
      ['appearance', 'Appearance'],
      ['editor', 'Editor'],
      ['keys', 'Keybindings'],
      ['plugins', 'Plugins'],
    ];
    const paint = () => {
      body.replaceChildren(
        this.tab === 'editor' ? this.editorTab()
          : this.tab === 'keys' ? this.keysTab()
            : this.tab === 'plugins' ? this.pluginsTab()
              : this.appearanceTab(),
      );
      for (const b of nav.children) b.classList.toggle('is-active', b.dataset.tab === this.tab);
    };
    const nav = h('div', { class: 'set-nav' }, tabs.map(([id, name]) => h('button', {
      class: 'set-navbtn' + (this.tab === id ? ' is-active' : ''), text: name, 'data-tab': id,
      onclick: () => { this.tab = id; paint(); },
    })));

    paint();
    return h('div', { class: 'settings' }, [
      h('div', { class: 'pop-head' }, [
        h('span', { text: 'Settings' }),
        h('button', {
          class: 'btn-ghost', text: 'Reset all',
          onclick: () => { this.reset(); this.app.keymap.reset(); this.app.openSettings(); },
        }),
      ]),
      nav,
      body,
    ]);
  }

  row(label, control, note) {
    return h('div', { class: 'set-row' }, [
      h('div', {}, [
        h('div', { class: 'set-label', text: label }),
        note ? h('div', { class: 'set-note', text: note }) : null,
      ]),
      control,
    ]);
  }

  slider(key, min, max, step, fmt) {
    const out = h('span', { class: 'set-out', text: fmt(this.values[key]) });
    const input = h('input', {
      type: 'range', min, max, step, value: this.values[key],
      oninput: (e) => {
        const n = Number(e.target.value);
        out.textContent = fmt(n);
        this.set({ [key]: n });
      },
    });
    return h('div', { class: 'set-slider' }, [input, out]);
  }

  swatches(key, colors) {
    return h('div', { class: 'swatches' }, colors.map((c) => h('button', {
      class: 'swatch' + (this.values[key] === c ? ' is-active' : ''), style: `background:${c}`,
      onclick: (e) => {
        this.set({ [key]: c });
        [...e.target.parentNode.children].forEach((b) => b.classList.toggle('is-active', b === e.target));
      },
    })));
  }

  appearanceTab() {
    const v = this.values;
    return h('div', {}, [
      this.row('Theme', h('div', { class: 'seg' }, ['dark', 'midnight', 'light'].map((name) => h('button', {
        class: 'seg-btn' + (v.theme === name ? ' is-active' : ''), text: name,
        onclick: (e) => {
          this.set({ theme: name });
          [...e.target.parentNode.children].forEach((b) => b.classList.toggle('is-active', b === e.target));
        },
      })))),
      this.row('Accent', this.swatches('accent', ACCENTS)),
      this.row('Highlight', this.swatches('highlight', HIGHLIGHTS), 'Colour for ==highlighted text=='),
      this.row('Font', h('select', {
        class: 'db-select', onchange: (e) => this.set({ fontText: e.target.value }),
      }, Object.keys(FONTS).map((k) => h('option', { value: k, text: k, selected: v.fontText === k })))),
      this.row('Text size', this.slider('editorSize', 13, 22, 1, (n) => n + 'px')),
      this.row('Line height', this.slider('editorLeading', 1.3, 2.2, 0.05, (n) => n.toFixed(2))),
      this.row('Line width', this.slider('noteWidth', 560, 1100, 20, (n) => n + 'px')),
      this.row('Cover height', this.slider('coverHeight', 100, 380, 10, (n) => n + 'px')),
      this.row('Sidebar width', this.slider('sidebarWidth', 190, 400, 10, (n) => n + 'px')),
    ]);
  }

  editorTab() {
    const v = this.values;
    const text = (key, placeholder, note) => this.row(
      key === 'dailyFolder' ? 'Daily notes folder' : 'New note folder',
      h('input', {
        class: 'palette-input', value: v[key], placeholder,
        onchange: (e) => this.set({ [key]: e.target.value.replace(/^\/+|\/+$/g, '') }),
      }),
      note,
    );
    const modes = [
      ['subfolder', 'Subfolder next to the note'],
      ['same', 'Same folder as the note'],
      ['root', 'One folder at the vault root'],
    ];
    return h('div', {}, [
      text('newNoteFolder', 'vault root', 'Where Ctrl+N puts new notes'),
      text('dailyFolder', 'Daily', 'Where the daily note lives'),
      this.row('Attachments go to', h('select', {
        class: 'db-select', onchange: (e) => this.set({ attachmentMode: e.target.value }),
      }, modes.map(([id, lbl]) => h('option', { value: id, text: lbl, selected: v.attachmentMode === id }))),
      'Pasted and dropped files are saved into the vault, never left in temp'),
      this.row('Attachment folder name', h('input', {
        class: 'palette-input', value: v.attachmentFolder,
        onchange: (e) => this.set({ attachmentFolder: e.target.value.replace(/^\/+|\/+$/g, '') || 'attachments' }),
      }), v.attachmentMode === 'same' ? 'Not used with "same folder"' : null),
      h('div', { class: 'set-foot', text: 'Markdown shortcuts: ==highlight==, > [!note] callouts, '
        + '[[wikilinks]], ![[image.png]], a bare URL on its own line embeds it.' }),
    ]);
  }

  keysTab() {
    const km = this.app.keymap;
    const all = [...this.app.builtins(), ...this.app.plugins.allCommands()];
    const rows = all.map((cmd) => {
      const binding = km.keys[cmd.id] || '';
      const btn = h('button', {
        class: 'key-btn' + (binding ? '' : ' is-unset'),
        text: binding ? keyLabel(binding) : 'Not set',
      });
      btn.onclick = () => {
        btn.classList.add('is-capturing');
        btn.textContent = 'Press keys…';
        const capture = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') return done(null);
          const combo = fromEvent(e);
          if (!combo) return undefined;           // modifier alone, keep waiting
          return done(combo);
        };
        const done = (combo) => {
          window.removeEventListener('keydown', capture, true);
          btn.classList.remove('is-capturing');
          if (combo !== null) this.set({ keys: km.set(cmd.id, combo) });
          this.app.openSettings();
          return undefined;
        };
        window.addEventListener('keydown', capture, true);
      };
      return h('div', { class: 'set-row key-row' }, [
        h('div', {}, [
          h('div', { class: 'set-label', text: cmd.name }),
          h('div', { class: 'set-note', text: cmd.id }),
        ]),
        h('div', { class: 'key-cell' }, [
          btn,
          binding ? h('button', {
            class: 'btn-ghost key-clear', text: '×', title: 'Clear',
            onclick: () => { this.set({ keys: km.set(cmd.id, '') }); this.app.openSettings(); },
          }) : null,
        ]),
      ]);
    });
    return h('div', {}, [
      h('div', { class: 'set-foot', text: 'Click a shortcut, then press the keys you want. Escape cancels.' }),
      ...rows,
      h('div', { class: 'set-row' }, [
        h('div', { class: 'set-label', text: 'Restore default shortcuts' }),
        h('button', {
          class: 'btn', text: 'Reset keys',
          onclick: () => { this.set({ keys: km.reset() }); this.app.openSettings(); },
        }),
      ]),
    ]);
  }

  pluginsTab() {
    const host = this.app.plugins;
    const rows = host.available.map((meta) => {
      const on = !host.disabled.has(meta.id);
      const counts = [];
      if (on) {
        const cmds = [...host.commands.values()].filter((c) => c.plugin === meta.id).length;
        const views = [...host.views.values()].filter((v) => v.plugin === meta.id).length;
        const rails = host.rails.filter((r) => r.plugin === meta.id).length;
        if (cmds) counts.push(`${cmds} command${cmds > 1 ? 's' : ''}`);
        if (views) counts.push(`${views} view${views > 1 ? 's' : ''}`);
        if (rails) counts.push(`${rails} panel${rails > 1 ? 's' : ''}`);
      }
      return h('div', { class: 'set-row' }, [
        h('div', {}, [
          h('div', { class: 'set-label', text: meta.name }),
          h('div', { class: 'set-note', text: meta.description || meta.id }),
          counts.length ? h('div', { class: 'set-note plugin-counts', text: counts.join(' · ') }) : null,
        ]),
        h('label', { class: 'toggle' }, [
          h('input', {
            type: 'checkbox', checked: on,
            onchange: async (e) => {
              await host.setEnabled(meta.id, e.target.checked);
              this.app.openSettings();
            },
          }),
          h('span', { class: 'toggle-track' }),
        ]),
      ]);
    });
    return h('div', {}, [
      ...(rows.length ? rows : [h('div', { class: 'muted', text: 'No plugins found.' })]),
      h('div', { class: 'set-row' }, [
        h('div', {}, [
          h('div', { class: 'set-label', text: 'Plugins folder' }),
          h('div', { class: 'set-note', text: 'A folder with main.js exporting { onload(api) }' }),
        ]),
        h('button', { class: 'btn', text: 'Open folder', onclick: () => window.newEra.plugins.folder() }),
      ]),
    ]);
  }
}
