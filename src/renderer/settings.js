// Settings: a full page, not a pop-up. A sidebar of sections on the left,
// grouped cards on the right, one search across all of it.
// Appearance values are CSS custom properties, so applying them is one style
// write with no re-render. Everything lives in <vault>/.new-era/settings.json.
import { h } from './dbview.js';
import { label as keyLabel, fromEvent } from './keymap.js';
import { DATE_STYLES, formatDate, prettyTitle as prettyTitleImpl } from './dates.js';

export const DEFAULTS = {
  theme: 'dark',
  accent: '#f2643c',
  fontText: 'rounded',
  uiScale: 1,
  editorSize: 17,
  editorLeading: 1.7,
  noteWidth: 760,
  coverHeight: 180,
  sidebarWidth: 270,
  highlight: '#e0c04e',
  newNoteFolder: '',
  attachmentMode: 'subfolder',
  attachmentFolder: 'attachments',
  showAttachments: true,
  collapsed: null,
  dailyFolder: 'Daily',
  dateFormat: 'ordinal',
  showRail: false,
  keys: {},
  disabledPlugins: [],
  plugins: {},
};

const FONTS = {
  rounded: '"Nunito Variable", ui-rounded, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  system: 'ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, sans-serif',
  inter: 'Inter, ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  serif: 'Iowan Old Style, Charter, Georgia, "Times New Roman", serif',
  mono: 'var(--font-mono)',
};
const FONT_NAMES = { rounded: 'Friendly', system: 'Classic', inter: 'Modern', serif: 'Book', mono: 'Typewriter' };

const THEMES = [
  ['dark', 'Cocoa', 'Warm and dark', ['#1f1b1a', '#282220', '#f1e8e3']],
  ['midnight', 'Midnight', 'Deep blue night', ['#121428', '#181b33', '#e4e6ff']],
  ['light', 'Paper', 'Bright cream pages', ['#fffcf6', '#fbf3e6', '#33271f']],
];

// Whole-window zoom, so every button and label scales together.
const UI_SCALES = [[0.8, 'Compact'], [0.9, 'Small'], [1, 'Normal'], [1.1, 'Large'], [1.25, 'Extra large']];

const ACCENTS = ['#f2643c', '#e8457c', '#8b5cf6', '#3b82f6', '#0ea5a4', '#22a55b', '#e0a106', '#2383e2'];
const HIGHLIGHTS = ['#e0c04e', '#7ad17a', '#69b7e8', '#e08ab8', '#c79bf0', '#e0885a'];

const SECTIONS = [
  ['look', '\u{1F3A8}', 'Look and feel', 'Colours, size and fonts. Changes show straight away.'],
  ['writing', '✏️', 'Writing', 'Where new pages, daily pages and pictures are kept.'],
  ['keys', '⌨️', 'Keyboard shortcuts', 'Click a shortcut, then press the keys you want.'],
  ['plugins', '\u{1F9E9}', 'Add-ons', 'Extra tools you can switch on and off.'],
  ['vault', '\u{1F4C1}', 'Your vault', 'The folder on your computer that holds everything.'],
];

// What the omni-search and the settings filter look through. Keywords are the
// words people actually type when they cannot remember our label.
const INDEX = [
  ['theme', 'Theme', 'look', 'Cocoa, Midnight or Paper', 'dark light mode colour scheme night'],
  ['accent', 'Accent colour', 'look', 'the colour of buttons and highlights', 'colour color blue primary accent'],
  ['highlight', 'Highlighter colour', 'look', 'colour for ==highlighted text==', 'marker pen yellow colour color'],
  ['uiScale', 'App size', 'look', 'how big buttons, menus and labels are', 'zoom scale size bigger smaller compact large ui interface'],
  ['fontText', 'Font', 'look', 'the typeface for everything', 'typeface serif mono inter font'],
  ['editorSize', 'Text size', 'look', 'how big page text is', 'font size bigger smaller zoom'],
  ['editorLeading', 'Line spacing', 'look', 'space between lines', 'leading spacing airy dense line height'],
  ['noteWidth', 'Page width', 'look', 'how wide a page reads', 'measure column width narrow wide'],
  ['coverHeight', 'Cover picture height', 'look', 'height of the page banner', 'banner cover image header'],
  ['sidebarWidth', 'Sidebar width', 'look', 'how wide the sidebar is', 'panel left narrow wide'],
  ['newNoteFolder', 'New pages go to', 'writing', 'where new pages are created', 'default location new note'],
  ['dailyFolder', 'Daily pages go to', 'writing', 'where today’s page lives', 'journal today date daily'],
  ['dateFormat', 'Dates look like', 'writing', 'how dates are written', 'date format day month year calendar daily'],
  ['attachmentMode', 'Pictures and files go to', 'writing', 'folder for pasted and dropped files', 'image paste drop upload photo attachment file'],
  ['attachmentFolder', 'Pictures folder name', 'writing', 'name of the attachments folder', 'image paste upload attachment folder name'],
  ['keys', 'Keyboard shortcuts', 'keys', 'change any shortcut', 'keybinding hotkey shortcut key rebind'],
  ['plugins', 'Add-ons', 'plugins', 'turn add-ons on and off', 'extension addon kanban tasks export plugin'],
  ['vault', 'Vault folder', 'vault', 'open, switch or reindex your vault', 'folder vault reindex switch open location'],
  ['history', 'Page history', 'vault', 'earlier versions and deleted pages', 'backup history restore undo recover deleted version'],
];

const KEY_BY_LABEL = new Map(INDEX.map(([key, label]) => [label, key]));

function prettyTitleOf(path, style) {
  return prettyTitleImpl(path.split('/').pop().replace(/\.md$/, ''), style);
}

// titleBarOverlay only accepts opaque hex, so trim anything else away.
function hex(value) {
  const m = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  return m ? '#' + m[1] : null;
}

export class Settings {
  constructor(app) {
    this.app = app;
    this.values = { ...DEFAULTS };
    this.tab = 'look';
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
    if ('dateFormat' in patch) {
      for (const t of this.app.tabs || []) {
        if (t.type === 'note') t.title = prettyTitleOf(t.path, this.values.dateFormat);
      }
      this.app.renderTabs();
      this.app.renderSidebar();
    }
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
    window.newEra.setZoom(Number(v.uiScale) || 1);
    // Repaint the native window buttons to match the theme.
    const css = getComputedStyle(root);
    window.newEra.setChromeTheme({
      color: hex(css.getPropertyValue('--bg-2')) || '#1c1c1c',
      symbolColor: hex(css.getPropertyValue('--text-dim')) || '#9a9a9a',
    });
  }

  index() {
    return INDEX.map(([key, label, tab, hint, keywords]) => ({
      key, label, tab, hint, keywords: keywords.split(' '),
    }));
  }

  // --- page ----------------------------------------------------------------

  page(highlight) {
    const main = h('section', { class: 'set-main' });
    const search = h('input', {
      class: 'set-search', type: 'search', placeholder: '\u{1F50D}  Find a setting…',
      oninput: () => paint(),
    });

    const nav = h('nav', { class: 'set-nav' }, SECTIONS.map(([id, icon, name]) => h('button', {
      class: 'set-navbtn', 'data-tab': id,
      onclick: () => { this.tab = id; search.value = ''; paint(); main.scrollTop = 0; },
    }, [h('span', { class: 'set-navico', text: icon }), h('span', { text: name })])));

    const header = (id) => {
      const [, icon, name, intro] = SECTIONS.find((s) => s[0] === id);
      return h('header', { class: 'set-header' }, [
        h('h1', {}, [h('span', { class: 'set-h1ico', text: icon }), h('span', { text: name })]),
        h('p', { text: intro }),
      ]);
    };

    const paint = () => {
      const q = search.value.trim().toLowerCase();
      for (const b of nav.children) b.classList.toggle('is-active', !q && b.dataset.tab === this.tab);
      if (q) {
        // Searching crosses sections: you should not have to guess which one
        // holds the thing you are after.
        const hits = this.index().filter((i) => (i.label + ' ' + i.hint + ' ' + i.keywords.join(' '))
          .toLowerCase().includes(q));
        const keep = new Set(hits.map((i) => i.key));
        main.replaceChildren(...[...new Set(hits.map((i) => i.tab))].map((t) => this.section(t)));
        for (const row of main.querySelectorAll('.set-row[data-setkey]')) {
          if (!keep.has(row.dataset.setkey)) row.remove();
        }
        for (const card of main.querySelectorAll('.set-card')) {
          if (!card.querySelector('.set-row')) card.remove();
        }
        if (!main.querySelector('.set-row')) {
          main.replaceChildren(h('div', { class: 'set-empty', text: 'No setting matches that. Try another word.' }));
        }
        return;
      }
      main.replaceChildren(header(this.tab), this.section(this.tab));
      if (highlight) {
        const row = main.querySelector('.set-row[data-setkey="' + highlight + '"]');
        if (row) {
          row.classList.add('is-found');
          row.scrollIntoView({ block: 'center' });
        }
        highlight = null;
      }
    };

    paint();
    return h('div', { class: 'set-page' }, [
      h('aside', { class: 'set-side' }, [
        h('div', { class: 'set-title', text: 'Settings' }),
        search,
        nav,
        h('button', {
          class: 'set-reset', text: 'Reset everything',
          onclick: () => {
            if (!window.confirm('Put every setting back to how it started? Your pages are not touched.')) return;
            this.reset();
            this.app.keymap.reset();
            this.app.openSettings();
          },
        }),
      ]),
      main,
    ]);
  }

  section(tab) {
    if (tab === 'writing') return this.writingTab();
    if (tab === 'keys') return this.keysTab();
    if (tab === 'plugins') return this.pluginsTab();
    if (tab === 'vault') return this.vaultTab();
    return this.lookTab();
  }

  card(title, rows) {
    return h('div', { class: 'set-card' }, [h('h2', { class: 'set-card-title', text: title }), ...rows]);
  }

  row(label, control, note) {
    return h('div', { class: 'set-row', 'data-setkey': KEY_BY_LABEL.get(label) || null }, [
      h('div', { class: 'set-text' }, [
        h('div', { class: 'set-label', text: label }),
        note ? h('div', { class: 'set-note', text: note }) : null,
      ]),
      control,
    ]);
  }

  // A row of big buttons, one of which is chosen.
  choice(key, options, cls = 'seg') {
    const wrap = h('div', { class: cls });
    const paint = () => {
      wrap.replaceChildren(...options.map(([value, label, extra]) => h('button', {
        class: cls + '-btn' + (this.values[key] === value ? ' is-active' : ''),
        onclick: () => { this.set({ [key]: value }); paint(); },
      }, extra ? extra(label) : [h('span', { text: label })])));
    };
    paint();
    return wrap;
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
      class: 'swatch' + (this.values[key] === c ? ' is-active' : ''), style: `background:${c}`, title: c,
      onclick: (e) => {
        this.set({ [key]: c });
        [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('is-active', b === e.currentTarget));
      },
    })));
  }

  lookTab() {
    const themeCards = this.choice('theme', THEMES.map(([id, name, note, [bg, side, ink]]) => [id, name, () => [
      h('span', { class: 'theme-preview', style: `background:${bg}` }, [
        h('span', { class: 'theme-side', style: `background:${side}` }),
        h('span', { class: 'theme-lines' }, [
          h('span', { style: `background:${ink}` }),
          h('span', { style: `background:${ink}` }),
          h('span', { style: 'background:var(--accent)' }),
        ]),
      ]),
      h('span', { class: 'theme-name', text: name }),
      h('span', { class: 'theme-note', text: note }),
    ]]), 'themes');

    const fontCards = this.choice('fontText', Object.keys(FONTS).map((k) => [k, FONT_NAMES[k], (label) => [
      h('span', { class: 'font-sample', style: `font-family:${FONTS[k]}`, text: 'Aa' }),
      h('span', { class: 'font-name', text: label }),
    ]]), 'fonts');

    return h('div', { class: 'set-cards' }, [
      this.card('Colours', [
        h('div', { class: 'set-row set-row-wide', 'data-setkey': 'theme' }, [themeCards]),
        this.row('Accent colour', this.swatches('accent', ACCENTS), 'Buttons, links and the cursor'),
        this.row('Highlighter colour', this.swatches('highlight', HIGHLIGHTS), 'For ==highlighted text=='),
      ]),
      this.card('Size', [
        this.row('App size', this.choice('uiScale', UI_SCALES.map(([v, l]) => [v, l])),
          'Makes buttons, menus and labels smaller or bigger'),
        this.row('Text size', this.slider('editorSize', 13, 24, 1, (n) => n + 'px'), 'Short pages start a little bigger'),
        this.row('Line spacing', this.slider('editorLeading', 1.3, 2.2, 0.05, (n) => n.toFixed(2))),
      ]),
      this.card('Font', [
        h('div', { class: 'set-row set-row-wide', 'data-setkey': 'fontText' }, [fontCards]),
      ]),
      this.card('Layout', [
        this.row('Page width', this.slider('noteWidth', 560, 1100, 20, (n) => n + 'px')),
        this.row('Cover picture height', this.slider('coverHeight', 100, 380, 10, (n) => n + 'px')),
        this.row('Sidebar width', this.slider('sidebarWidth', 200, 400, 10, (n) => n + 'px')),
      ]),
    ]);
  }

  writingTab() {
    const v = this.values;
    const text = (key, label, placeholder, note) => this.row(label, h('input', {
      class: 'set-input', value: v[key], placeholder,
      onchange: (e) => this.set({ [key]: e.target.value.replace(/^\/+|\/+$/g, '') }),
    }), note);
    const modes = [
      ['subfolder', 'A folder next to the page'],
      ['same', 'The same folder as the page'],
      ['root', 'One folder for everything'],
    ];
    return h('div', { class: 'set-cards' }, [
      this.card('Pages', [
        text('newNoteFolder', 'New pages go to', 'the top of your vault', 'Leave empty to keep them at the top'),
        text('dailyFolder', 'Daily pages go to', 'Daily', 'Used by "Today’s page"'),
        this.row('Dates look like', this.choice('dateFormat',
          DATE_STYLES.map(([id]) => [id, formatDate(new Date(), id)])),
        'Daily pages keep a tidy file name; only how they are shown changes'),
      ]),
      this.card('Pictures and files', [
        this.row('Pictures and files go to', h('select', {
          class: 'set-input', onchange: (e) => this.set({ attachmentMode: e.target.value }),
        }, modes.map(([id, lbl]) => h('option', { value: id, text: lbl, selected: v.attachmentMode === id }))),
        'Anything you paste or drop is copied into your vault'),
        this.row('Pictures folder name', h('input', {
          class: 'set-input', value: v.attachmentFolder,
          onchange: (e) => this.set({ attachmentFolder: e.target.value.replace(/^\/+|\/+$/g, '') || 'attachments' }),
        }), v.attachmentMode === 'same' ? 'Not used with "the same folder"' : null),
      ]),
      this.card('Handy tricks', [
        h('ul', { class: 'set-tips' }, [
          ['/', 'at the start of a line opens the block menu'],
          ['A link on its own line', 'turns into a player or preview: YouTube, Spotify, Vimeo, Figma…'],
          ['Ctrl + click', 'a link to open it in your browser'],
          ['[[Page name]]', 'links to another page'],
          ['==text==', 'highlights it'],
        ].map(([k, t]) => h('li', {}, [h('b', { text: k }), h('span', { text: ' ' + t })]))),
      ]),
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
        h('div', { class: 'set-text' }, [h('div', { class: 'set-label', text: cmd.name })]),
        h('div', { class: 'key-cell' }, [
          btn,
          binding ? h('button', {
            class: 'btn-ghost key-clear', text: '×', title: 'Remove this shortcut',
            onclick: () => { this.set({ keys: km.set(cmd.id, '') }); this.app.openSettings(); },
          }) : null,
        ]),
      ]);
    });
    return h('div', { class: 'set-cards' }, [
      this.card(`${all.length} things you can do`, [
        h('div', { class: 'set-row', 'data-setkey': 'keys' }, [
          h('div', { class: 'set-text' }, [
            h('div', { class: 'set-label', text: 'Keyboard shortcuts' }),
            h('div', { class: 'set-note', text: 'Press Escape to cancel while choosing keys.' }),
          ]),
          h('button', {
            class: 'btn', text: 'Restore defaults',
            onclick: () => { this.set({ keys: km.reset() }); this.app.openSettings(); },
          }),
        ]),
        ...rows,
      ]),
    ]);
  }

  pluginsTab() {
    const host = this.app.plugins;
    const rows = host.available.map((meta) => {
      const on = !host.disabled.has(meta.id);
      return h('div', { class: 'set-row' }, [
        h('div', { class: 'set-text' }, [
          h('div', { class: 'set-label', text: meta.name }),
          h('div', { class: 'set-note', text: meta.description || meta.id }),
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
    return h('div', { class: 'set-cards' }, [
      this.card('Installed', [
        h('div', { class: 'set-row', 'data-setkey': 'plugins' }, [
          h('div', { class: 'set-text' }, [
            h('div', { class: 'set-label', text: 'Add-ons' }),
            h('div', { class: 'set-note', text: `${host.available.length} installed. Switch any of them on or off.` }),
          ]),
          h('button', { class: 'btn', text: 'Open add-ons folder', onclick: () => window.newEra.plugins.folder() }),
        ]),
        ...(rows.length ? rows : [h('div', { class: 'set-empty', text: 'No add-ons found.' })]),
      ]),
    ]);
  }

  vaultTab() {
    const where = this.app.vault || 'No vault open';
    return h('div', { class: 'set-cards' }, [
      this.card('This vault', [
        h('div', { class: 'set-row', 'data-setkey': 'vault' }, [
          h('div', { class: 'set-text' }, [
            h('div', { class: 'set-label', text: where.split(/[\\/]/).pop() }),
            h('div', { class: 'set-note set-path', text: where }),
          ]),
          h('button', { class: 'btn', text: 'Show in folder', onclick: () => window.newEra.vault.reveal('.') }),
        ]),
        this.row('Switch to another vault', h('button', {
          class: 'btn', text: 'Choose folder…', onclick: () => this.app.command('vault.pick'),
        }), 'Any folder of markdown files works'),
        this.row('Something looks out of date?', h('button', {
          class: 'btn', text: 'Reindex', onclick: () => this.app.command('vault.resync'),
        }), 'Re-reads every page from disk'),
      ]),
      this.card('Backups', [
        this.row('Page history', h('span', { class: 'set-badge', text: '\u2705 Always on' }),
          'Before a page is changed, renamed or deleted, the old version is copied to .new-era/history in this vault. Open any page and press History to go back.'),
        this.row('Recover deleted pages', h('button', {
          class: 'btn', text: 'Show deleted pages', onclick: () => this.app.openHistory(null),
        }), 'Anything you delete can be brought back from here'),
        this.row('Open the backup folder', h('button', {
          class: 'btn', text: 'Show in folder', onclick: () => window.newEra.vault.reveal('.new-era/history'),
        }), 'Plain files, so you can copy a page back by hand even if the app will not start'),
      ]),
    ]);
  }
}
