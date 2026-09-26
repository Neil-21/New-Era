// NEW ERA: Obsidian-style vault, Notion-style databases, one window.
import '../style.css';
import { createEditor } from './editor.js';
import { DatabaseView, h } from './dbview.js';
import { PluginHost } from './plugins.js';
import { renderPageHeader } from './page.js';
import { Settings } from './settings.js';
import { GraphView } from './graph.js';
import { Keymap } from './keymap.js';
import { Omni } from './omni.js';
import { label as keyLabel } from './keymap.js';
import { prettyTitle } from './dates.js';

const newEra = window.newEra;

const KIND_ICON = {
  image: '\u25a3', video: '\u25b6', audio: '\u266a', doc: '\u25a5',
  data: '\u2637', code: '\u2b1a', file: '\u25cb',
};

const $ = (sel) => document.querySelector(sel);

const VIEWABLE = /^(png|jpe?g|gif|webp|svg|avif|bmp|mp4|mov|webm|m4v|mp3|wav|ogg|m4a|flac|aac|pdf)$/i;

function fileSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// Coral, amber, green, teal, blue, violet, pink, lime: far enough apart to
// tell folders apart at a glance. FNV-1a spreads similar names across them.
const FOLDER_HUES = [8, 38, 145, 180, 212, 262, 325, 85];
function folderHue(name) {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return FOLDER_HUES[h % FOLDER_HUES.length];
}

class App {
  constructor() {
    this.vault = null;
    this.notes = [];
    this.views = [];
    this.tabs = [];
    this.current = null;
    this.editor = null;
    // Folder and section keys the user has closed.
    this.collapsed = new Set();
    this.plugins = new PluginHost(this);
    this.settings = new Settings(this);
    this.keymap = new Keymap(this);
    this.omni = new Omni(this);
  }

  async boot() {
    document.body.append(this.layout());
    const state = await newEra.vault.current();
    if (state.vault) await this.setVault(state);
    else this.renderWelcome();

    newEra.on('vault:changed', (p) => this.onVaultChanged(p));
    newEra.on('command', (cmd) => this.command(cmd));
    window.addEventListener('keydown', (e) => this.hotkey(e));
    this.keymap.load(this.settings.values.keys);
    await this.plugins.loadAll(this.settings.values.disabledPlugins || []);
    this.renderRibbon();
  }

  // --- chrome --------------------------------------------------------------

  layout() {
    this.el = {
      sidebar: h('div', { class: 'sidebar-body', id: 'sidebar-body' }),
      ribbon: h('div', { class: 'ribbon' }), // unused; plugins render into Tools
      vaultName: h('button', {
        class: 'vault-name', onclick: (e) => this.vaultMenu(e.currentTarget),
      }),
      tabbar: h('div', { class: 'tabbar' }),
      content: h('div', { class: 'content', id: 'content' }),
      right: h('aside', { class: 'rightbar', id: 'rightbar' }),
      toast: h('div', { class: 'toast-wrap' }),
    };


    // Search is the front door, so it sits top and centre where everyone looks.
    this.el.searchKey = h('span', { class: 'search-key' });
    document.documentElement.dataset.platform = newEra.platform || 'win32';

    return h('div', { class: 'app' }, [
      // One drag strip across the top. The OS still owns the window buttons on
      // the right (titleBarOverlay), so we reserve room for them.
      h('div', { class: 'titlebar' }, [
        h('div', { class: 'titlebar-left' }, [
          h('button', {
            class: 'icon-btn no-drag', text: '☰', title: 'Show or hide the sidebar',
            onclick: () => this.toggleSidebar(),
          }),
        ]),
        h('button', { class: 'search-pill no-drag', onclick: () => this.omni.open() }, [
          h('span', { class: 'search-pill-ico', text: '\u{1F50D}' }),
          h('span', { class: 'search-pill-text', text: 'Search your notes, files and settings' }),
          this.el.searchKey,
        ]),
      ]),
      h('aside', { class: 'sidebar' }, [
        this.toolbar(),
        this.el.sidebar,
        // Vault switcher sits where ChatGPT and Claude put the account.
        h('div', { class: 'sidebar-foot' }, [
          this.el.vaultMark = h('span', { class: 'vault-mark' }),
          this.el.vaultName,
          h('button', {
            class: 'icon-btn', text: '⚙️', title: 'Settings',
            onclick: () => this.openSettings(),
          }),
        ]),
      ]),
      h('main', { class: 'main' }, [
        h('div', { class: 'topbar' }, [
          this.el.tabbar,
          h('button', {
            class: 'page-action', title: 'See how your notes connect',
            onclick: () => this.command('view.graph'),
          }, [h('span', { text: '\u{1F578}️' }), h('span', { text: 'Map' })]),
          h('button', {
            class: 'page-action', title: 'What links to this page, and its headings',
            onclick: () => this.toggleRail(),
          }, [h('span', { text: '\u{1F517}' }), h('span', { text: 'Connections' })]),
        ]),
        this.el.content,
      ]),
      this.el.right,
      this.el.toast,
    ]);
  }

  navRow(icon, label, run, o = {}) {
    return h('div', { class: 'nav-row' + (o.active ? ' is-active' : ''), title: o.title || label, onclick: run }, [
      h('span', { class: 'nav-ico', text: icon, style: `--tile:${o.tile || 'var(--accent)'}` }),
      h('span', { class: 'nav-label', text: label }),
      o.key ? h('span', { class: 'nav-key', text: keyLabel(this.keymap.keys[o.key] || '') }) : null,
    ]);
  }

  async setVault(state) {
    this.vault = state.vault;
    this.el.vaultName.textContent = state.vault.split(/[\\/]/).pop() || state.vault;
    this.el.vaultName.title = state.vault;
    this.el.vaultMark.textContent = (this.el.vaultName.textContent[0] || '?').toUpperCase();
    this.views = await newEra.views.list();
    await this.settings.load();
    if (Array.isArray(this.settings.values.collapsed)) {
      this.collapsed = new Set(this.settings.values.collapsed);
    }
    this.keymap.load(this.settings.values.keys);
    document.body.classList.toggle('no-rail', !this.settings.values.showRail);
    await this.refresh();
    if (!this.current) {
      const first = this.notes[0];
      if (first) this.openNote(first.path);
      else this.renderWelcome();
    }
  }

  async vaultMenu(anchor) {
    const recent = await newEra.vault.recent();
    const short = (p) => p.split(/[\\/]/).pop() || p;
    this.menu(anchor, [
      ...recent.filter((r) => r !== this.vault).slice(0, 5).map((r) => ({
        label: short(r),
        run: async () => {
          const state = await newEra.vault.open(r);
          if (!state) return this.toast('That vault folder is gone');
          this.tabs = [];
          this.current = null;
          return this.setVault(state);
        },
      })),
      { label: 'Open another vault\u2026', run: () => this.command('vault.pick') },
      { label: 'Reveal in file manager', run: () => newEra.vault.reveal('.') },
      { label: 'Reindex this vault', run: () => this.command('vault.resync') },
    ]);
  }

  // Connections (mentions, outline, links) is for people who want it; most
  // pages never need it, so it starts closed and remembers your choice.
  toggleRail() {
    const open = document.body.classList.toggle('no-rail') === false;
    this.settings.set({ showRail: open });
  }

  async refresh() {
    this.notes = await newEra.index.all();
    this.assets = await newEra.asset.list({});
    // Basename lookup, so an embed keeps working after the file is moved.
    this.assetByName = new Map();
    for (const a of this.assets) {
      this.assetByName.set(a.path.toLowerCase(), a.path);
      if (!this.assetByName.has(a.name.toLowerCase())) {
        this.assetByName.set(a.name.toLowerCase(), a.path);
      }
    }
    this.tags = await newEra.index.tags();
    this.folders = await newEra.index.folders();
    document.body.classList.toggle('is-dense', this.notes.length > 40);
    this.renderSidebar();
  }

  async tagList() {
    if (!this.tags) this.tags = await newEra.index.tags();
    return this.tags;
  }

  // Where a pasted or dropped file should land, per the attachment setting.
  attachFolder(notePath) {
    const v = this.settings.values;
    const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
    const name = (v.attachmentFolder || 'attachments').replace(/^\/+|\/+$/g, '');
    if (v.attachmentMode === 'same') return dir;
    if (v.attachmentMode === 'root') return name;
    return dir ? `${dir}/${name}` : name;
  }

  async onVaultChanged({ paths }) {
    await this.refresh();
    if (this.current && this.current.type === 'note' && paths.includes(this.current.path)) {
      // Someone edited this file outside the app. Never clobber unsaved work.
      if (this.editor && this.dirty) this.toast('This note changed on disk - your edits are unsaved');
      else this.openNote(this.current.path, { force: true });
    }
    if (this.current && this.current.type === 'db' && this.db) this.db.render();
    if (this.graph) this.graph.reload();
    this.plugins.emit('vault:changed', { paths });
  }

  renderWelcome() {
    this.el.right.replaceChildren();
    this.el.content.replaceChildren(h('div', { class: 'welcome' }, [
      h('div', { class: 'welcome-mark', text: '✦' }),
      h('h1', { text: 'Welcome to New Era' }),
      h('p', { text: 'Pick a folder to keep your notes in. Everything stays on your computer as plain files.' }),
      h('button', { class: 'btn btn-primary btn-big', text: '📂  Choose a folder', onclick: () => this.command('vault.pick') }),
    ]));
  }

  // --- sidebar -------------------------------------------------------------

  toggleSection(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    this.settings.set({ collapsed: [...this.collapsed] });
    this.renderSidebar();
  }

  // Open a sidebar section and scroll it into view, for plugins that want to
  // point at something rather than open a pane.
  revealSection(name) {
    this.collapsed.delete('sec:' + name.toLowerCase());
    this.renderSidebar();
    const head = [...this.el.sidebar.querySelectorAll('.side-head-label')]
      .find((e) => e.textContent.toLowerCase() === name.toLowerCase());
    if (head) head.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // Sidebar top, Claude/ChatGPT style: the app, then one obvious primary action.
  toolbar() {
    return h('div', { class: 'side-toolbar' }, [
      h('div', { class: 'brand-row' }, [
        h('span', { class: 'brand-mark', text: '✦' }),
        h('span', { class: 'brand-name', text: 'New Era' }),
        h('button', {
          class: 'icon-btn', text: '⋯', title: 'Sort and display',
          onclick: (e) => this.menu(e.currentTarget, [
            { label: '📁  New folder…', run: () => this.newFolder() },
            { label: '🔤  Sort A → Z', run: () => { this.fileSort = 'name'; this.renderSidebar(); } },
            { label: '🔤  Sort Z → A', run: () => { this.fileSort = 'name-desc'; this.renderSidebar(); } },
            { label: '🕒  Newest first', run: () => { this.fileSort = 'modified'; this.renderSidebar(); } },
            { label: (this.settings.values.showAttachments ? '✓ ' : '   ') + 'Show pictures and files',
              run: () => {
                this.settings.set({ showAttachments: !this.settings.values.showAttachments });
                this.renderSidebar();
              } },
            { label: '📂  Fold all folders', run: () => this.collapseAll() },
          ]),
        }),
      ]),
      h('button', { class: 'new-page-btn', onclick: () => this.command('note.new') }, [
        h('span', { class: 'new-page-plus', text: '+' }),
        h('span', { text: 'New page' }),
      ]),
    ]);
  }

  // One sidebar. Notes, views, tools, tags and files are sections of the same
  // tree rather than five tabs you have to pick between before you can look.
  renderSidebar() {
    const body = this.el.sidebar;
    const out = [];

    const section = (key, label, rows, extra) => {
      // An empty section is a row that only ever says zero. Leave it out.
      if (!rows.length && !extra) return;
      const open = !this.collapsed.has('sec:' + key);
      out.push(h('div', {
        class: 'side-head' + (open ? ' is-open' : ''),
        onclick: () => this.toggleSection('sec:' + key),
      }, [
        h('span', { class: 'twisty' + (open ? ' is-open' : ''), text: '▸' }),
        h('span', { class: 'side-head-label', text: label }),
      ]));
      if (!open) return;
      out.push(...rows);
      if (extra) out.push(extra);
    };

    const leaf = (label, o = {}) => h('div', {
      class: 'tree-row tree-file' + (o.active ? ' is-active' : ''),
      style: `--depth:${o.depth ?? 1}`,
      title: o.title || label,
      draggable: o.draggable ? 'true' : null,
      onclick: (e) => { this.newTabNext = e.ctrlKey || e.metaKey; o.run(); },
      onauxclick: (e) => { if (e.button === 1) { this.newTabNext = true; o.run(); } },
      oncontextmenu: o.menu ? (e) => { e.preventDefault(); this.menu(e.currentTarget, o.menu()); } : null,
    }, [
      o.icon ? h('span', { class: 'tree-ico', text: o.icon }) : null,
      h('span', { class: 'tree-name', text: label }),
      o.count !== undefined ? h('span', { class: 'count', text: o.count }) : null,
    ]);

    this.el.searchKey.textContent = keyLabel(this.keymap.keys['palette.omni'] || '');

    // --- menu: a few fixed places to go ---
    const cur = this.current || {};
    out.push(h('div', { class: 'nav' }, [
      this.navRow('📅', "Today's page", () => this.command('note.daily'), { tile: '#ffb020' }),
      this.navRow('🕸️', 'Map of notes', () => this.openGraph('global'), { active: cur.type === 'graph', tile: '#a970ff' }),
      this.navRow('🏷️', 'Browse by tag', () => this.omni.open('#'), { tile: '#2fc48d' }),
    ]));

    // --- notes: the folder tree ---
    const tree = { dirs: new Map(), files: [] };
    for (const n of this.notes) {
      let node = tree;
      for (const dir of n.path.split('/').slice(0, -1)) {
        if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
        node = node.dirs.get(dir);
      }
      node.files.push(n);
    }
    if (this.settings.values.showAttachments) {
      for (const a of this.assets || []) {
        let node = tree;
        for (const dir of a.path.split('/').slice(0, -1)) {
          if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
          node = node.dirs.get(dir);
        }
        (node.assets ||= []).push(a);
      }
    }

    const sorter = this.fileSort || 'name';
    const sortFiles = (a, b) => (sorter === 'modified' ? b.mtime - a.mtime
      : sorter === 'name-desc' ? b.title.localeCompare(a.title)
        : a.title.localeCompare(b.title));
    const total = (node) => node.files.length
      + [...node.dirs.values()].reduce((sum, d) => sum + total(d), 0);

    const walk = (node, prefix, depth) => {
      const rows = [];
      for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const full = prefix ? prefix + '/' + name : name;
        const open = !this.collapsed.has(full);
        const dir = h('div', {
          class: 'tree-row tree-dir', style: `--depth:${depth}`,
          onclick: () => {
            if (open) this.collapsed.add(full); else this.collapsed.delete(full);
            this.renderSidebar();
          },
          oncontextmenu: (e) => { e.preventDefault(); this.folderMenu(e.currentTarget, full); },
        }, [
          h('span', { class: 'twisty' + (open ? ' is-open' : ''), text: '▸' }),
          // Each folder keeps its own colour, so you find it by eye, not by reading.
          h('span', {
            class: 'folder-dot',
            style: `--hue:${folderHue(name)}`,
          }),
          h('span', { class: 'tree-name', text: name }),
          h('span', { class: 'count', text: total(child) }),
        ]);
        this.dropTarget(dir, full);
        rows.push(dir);
        if (open) rows.push(...walk(child, full, depth + 1));
      }
      for (const a of (node.assets || []).sort((x, y) => x.name.localeCompare(y.name))) {
        rows.push(leaf(a.name, {
          depth, icon: KIND_ICON[a.kind] || '○', title: a.path,
          run: () => this.openAsset(a), menu: () => this.assetMenuItems(a),
        }));
      }
      for (const f of node.files.sort(sortFiles)) {
        const el = leaf(prettyTitle(f.title, this.settings.values.dateFormat), {
          depth, title: f.path,
          active: this.current && this.current.path === f.path,
          draggable: true,
          run: () => this.openNote(f.path),
          menu: () => this.noteMenuItems(f.path),
        });
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/hermes-note', f.path);
          e.dataTransfer.effectAllowed = 'move';
        });
        rows.push(el);
      }
      return rows;
    };

    section('notes', 'Your pages', walk(tree, '', 0));

    // --- views: saved bases, then every folder as a table ---
    // Folders are in the tree above, with "Open as table" on right-click, so
    // listing every one of them again here was the same thing twice.
    section('views', 'Tables', [
      ...this.views.map((v) => leaf(v.name, {
        icon: v.icon || '▦',
        active: this.current && this.current.id === v.id,
        run: () => this.openDatabase(v),
        menu: () => [
          { label: 'Open', run: () => this.openDatabase(v) },
          { label: 'Delete base', run: () => {
            this.views = this.views.filter((x) => x.id !== v.id);
            this.saveViews();
            this.renderSidebar();
          } },
        ],
      })),
    ]);

    const root = h('div', { class: 'tree' }, out);
    this.dropTarget(root, '');
    body.replaceChildren(root);
  }

  // Dragging a note onto a folder row moves the file on disk. Links resolve by
  // basename, so nothing breaks as long as the filename stays the same.
  dropTarget(el, folder) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/new-era-note')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', async (e) => {
      el.classList.remove('is-drop');
      const from = e.dataTransfer.getData('text/new-era-note');
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();
      const name = from.split('/').pop();
      const to = folder ? folder + '/' + name : name;
      if (to === from) return;
      try {
        await newEra.note.rename(from, to);
        await this.refresh();
        if (this.current && this.current.path === from) this.openNote(to);
        this.toast('Moved to ' + (folder || 'vault root'));
      } catch (err) { this.toast(err.message); }
    });
  }

  collapseAll() {
    const dirs = new Set();
    for (const n of this.notes) {
      const parts = n.path.split('/').slice(0, -1);
      for (let i = 0; i < parts.length; i++) dirs.add(parts.slice(0, i + 1).join('/'));
    }
    this.collapsed = dirs;
    this.renderSidebar();
  }

  async newFolder() {
    const name = await this.prompt('What do you want to call the folder?', 'New folder');
    if (!name) return;
    const clean = name.replace(/[\\:*?"<>|]/g, '-');
    await newEra.folder.create(clean);
    const note = await newEra.note.create(clean + '/Untitled', '');
    await this.refresh();
    this.openNote(note.path);
  }

  folderMenu(anchor, folder) {
    this.menu(anchor, [
      { label: 'New note here', run: async () => {
        const name = await this.prompt('What do you want to call your new page?', 'Untitled');
        if (!name) return;
        const note = await newEra.note.create(folder + '/' + name, '');
        await this.refresh();
        this.openNote(note.path);
      } },
      { label: 'Open as table', run: () => this.openDatabase(
        { name: folder.split('/').pop(), source: { folder }, view: 'table' }, true) },
      { label: 'Open in graph', run: () => this.openGraph() },
      { label: 'Rename folder…', run: async () => {
        const name = await this.prompt('New folder name', folder.split('/').pop());
        if (!name) return;
        const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/') + 1) : '';
        try {
          await newEra.folder.rename(folder, parent + name);
          await this.refresh();
        } catch (err) { this.toast(err.message); }
      } },
      { label: 'Collapse all folders', run: () => this.collapseAll() },
    ]);
  }

  // Pictures, video, sound and PDFs open in a tab; data files in the data
  // viewer; anything else goes to the program your computer uses for it.
  openAsset(a) {
    if (['json', 'csv', 'tsv', 'xlsx'].includes(a.ext) && this.plugins.views.has('data-viewer:file')) {
      this.dataFile = a.path;
      return this.openPluginView('data-viewer:file');
    }
    if (VIEWABLE.test(a.ext)) return this.openAssetView(a);
    return newEra.asset.open(a.path);
  }

  openAssetView(a) {
    if (this.editor) { this.editor.flush(); this.editor.destroy(); this.editor = null; }
    this.closeGraph();
    this.db = null;
    const id = 'asset:' + a.path;
    this.current = { type: 'asset', id };
    this.pushTab({ type: 'asset', id, asset: a, title: a.name });
    this.el.right.replaceChildren();

    const src = this.assetUrl(a.path);
    const kind = /^(mp4|mov|webm|m4v)$/i.test(a.ext) ? 'video'
      : /^(mp3|wav|ogg|m4a|flac|aac)$/i.test(a.ext) ? 'audio'
        : /^pdf$/i.test(a.ext) ? 'pdf' : 'image';
    let media;
    if (kind === 'image') {
      // Click to flip between "fit the window" and actual size.
      media = h('img', { class: 'viewer-img', src, alt: a.name, onclick: (e) => e.target.classList.toggle('is-zoomed') });
    } else if (kind === 'pdf') {
      media = h('iframe', { class: 'viewer-pdf', src });
    } else {
      media = h(kind, { class: 'viewer-' + kind, src, controls: true });
    }
    const folder = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : 'top of your vault';
    const embed = /^(png|jpe?g|gif|webp|svg|avif|bmp|mp4|mov|webm|m4v|mp3|wav|ogg|m4a|flac|aac)$/i.test(a.ext)
      ? `![[${a.path}]]` : `[${a.name}](${encodeURI(a.path)})`;
    this.el.content.replaceChildren(h('div', { class: 'viewer' }, [
      h('div', { class: 'viewer-bar' }, [
        h('div', { class: 'viewer-text' }, [
          h('div', { class: 'viewer-name', text: a.name }),
          h('div', { class: 'viewer-sub', text: `In ${folder}` + (a.size ? ` · ${fileSize(a.size)}` : '') }),
        ]),
        this.lastNotePath ? h('button', {
          class: 'btn btn-primary', text: '➕ Add to my last page',
          onclick: async () => {
            const target = this.lastNotePath;
            const note = await newEra.note.read(target);
            await newEra.note.write(target, note.raw.replace(/\s*$/, '\n\n') + embed + '\n');
            this.toast('Added to ' + target.split('/').pop().replace(/\.md$/, ''));
          },
        }) : null,
        h('button', { class: 'btn', text: '\u{1F4C2} Show in folder', onclick: () => newEra.vault.reveal(a.path) }),
        h('button', { class: 'btn', text: 'Open with…', onclick: () => newEra.asset.open(a.path) }),
      ]),
      h('div', { class: 'viewer-stage viewer-stage-' + kind }, [media]),
    ]));
    this.renderTabs();
    this.renderSidebar();
  }

  assetMenu(anchor, a) {
    this.menu(anchor, this.assetMenuItems(a));
  }

  assetMenuItems(a) {
    const link = /^(png|jpe?g|gif|webp|svg|avif|bmp|mp4|mov|webm|mp3|wav|ogg|m4a)$/i.test(a.ext)
      ? `![[${a.name}]]` : `[${a.name}](${encodeURI(a.path)})`;
    return [
      { label: 'Open', run: () => this.openAsset(a) },
      { label: 'Open with system app', run: () => newEra.asset.open(a.path) },
      { label: 'Copy embed for a note', run: async () => {
        await navigator.clipboard.writeText(link);
        this.toast('Copied ' + link);
      } },
      { label: 'Insert into the open note', run: () => {
        if (!this.editor) return this.toast('Open a note first');
        this.editor.insert(link + '\n');
        return this.toast('Inserted');
      } },
      { label: 'Reveal in file manager', run: () => newEra.vault.reveal(a.path) },
      { label: 'Move to trash', run: async () => {
        await newEra.asset.trash(a.path);
        await this.refresh();
        this.toast('Moved ' + a.name + ' to trash');
      } },
    ];
  }

  // Plugin buttons are listed in the Tools group of the sidebar now, so there
  // is no separate ribbon to paint. Kept as a hook because the plugin host
  // calls it after enabling or disabling a plugin.
  renderRibbon() {
    this.renderSidebar();
  }

  // --- tabs ----------------------------------------------------------------

  // Tabs behave like a browser's: opening a page reuses the tab you are in,
  // unless you have typed in it (then it is kept) or asked for a new tab with
  // Ctrl+click, middle-click or the + button. Tabs you have not kept show in
  // italics, so it is clear which one will be replaced.
  renderTabs() {
    this.el.tabbar.replaceChildren(...this.tabs.map((t) => h('div', {
      class: 'tab' + (this.isCurrent(t) ? ' is-active' : '') + (t.kept ? '' : ' is-preview'),
      title: t.kept ? t.title : `${t.title} (double-click to keep this tab)`,
      onclick: () => this.openTab(t),
      ondblclick: () => { t.kept = true; this.renderTabs(); },
      onauxclick: (e) => { if (e.button === 1) this.closeTab(t); },
    }, [
      h('span', { text: t.title }),
      h('button', { class: 'tab-x', text: '×', title: 'Close', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }),
    ])), h('button', {
      class: 'icon-btn tab-new', text: '+', title: 'Open a page in a new tab',
      onclick: () => { this.newTabNext = true; this.omni.open(); },
    }));
    const active = this.el.tabbar.querySelector('.tab.is-active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  isCurrent(t) {
    if (!this.current) return false;
    return t.type === 'note' ? this.current.path === t.path : this.current.id === t.id;
  }

  pushTab(tab) {
    const same = this.tabs.find((t) => (t.type === 'note' ? t.path === tab.path : t.id === tab.id));
    if (same) {
      Object.assign(same, { title: tab.title });
      this.activeTab = same;
    } else {
      const at = this.activeTab ? this.tabs.indexOf(this.activeTab) : -1;
      if (!this.newTabNext && at >= 0 && !this.activeTab.kept) this.tabs[at] = tab;
      else this.tabs.splice(at >= 0 ? at + 1 : this.tabs.length, 0, tab);
      // ponytail: a hard cap of 8, dropping the oldest tab that is not open.
      while (this.tabs.length > 8) this.tabs.splice(this.tabs.findIndex((t) => t !== tab), 1);
      this.activeTab = tab;
    }
    this.newTabNext = false;
    this.renderTabs();
  }

  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    this.tabs = this.tabs.filter((t) => t !== tab);
    if (this.activeTab === tab) this.activeTab = null;
    this.renderTabs();
    if (this.isCurrent(tab)) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.openTab(next);
      else this.renderWelcome();
    }
  }

  // --- notes ---------------------------------------------------------------

  async openNote(path, { force } = {}) {
    if (this.editor) { this.editor.flush(); this.editor.destroy(); this.editor = null; }
    this.closeGraph();
    this.db = null;
    let note;
    try { note = await newEra.note.read(path); } catch { return this.toast('Cannot open ' + path); }
    this.current = { type: 'note', path, title: path.split('/').pop().replace(/\.md$/, '') };
    // Remembered separately: opening the graph replaces `current`, and the
    // local graph still needs to know which note it is centred on.
    this.lastNotePath = path;
    this.dirty = false;
    this.pushTab({ type: 'note', path, title: prettyTitle(this.current.title, this.settings.values.dateFormat) });

    const host = h('div', { class: 'editor-host' });
    const foot = h('div', { class: 'page-foot' });
    this.el.content.replaceChildren(h('div', { class: 'note' }, [
      renderPageHeader({
        path, props: note.props, title: note.props.title || this.current.title, app: this,
      }),
      host,
      foot,
    ]));
    this.renderMentions(path, foot);

    const exists = new Set(this.notes.map((n) => n.path.replace(/\.md$/, '').toLowerCase()));
    const existsBase = new Set(this.notes.map((n) => n.path.split('/').pop().replace(/\.md$/, '').toLowerCase()));

    this.editor = createEditor(host, {
      doc: note.body,
      prefix: note.raw.slice(0, note.raw.length - note.body.length),
      title: note.props.title || this.current.title,
      exists: (t) => exists.has(t.toLowerCase()) || existsBase.has(t.toLowerCase()),
      onChange: async (text) => {
        this.dirty = false;
        await newEra.note.write(path, text);
        this.renderRight(path);
      },
      asset: (src) => this.assetUrl(src),
      onAttach: async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Clipboard images all arrive as "image.png"; name them after the note
        // and the moment instead, so the attachments folder stays readable.
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\W.*/, '');
        const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '');
        const name = !file.name || /^image\.\w+$/.test(file.name)
          ? `${path.split('/').pop().replace(/\.md$/, '')} ${stamp}.${ext}` : file.name;
        const saved = await newEra.asset.save(this.attachFolder(path), name, bytes);
        await this.refresh();
        this.toast(`Saved ${saved.path}`);
        return saved;
      },
      onAttachError: (err) => this.toast('Could not attach: ' + err.message),
      onLink: (target) => this.followLink(target),
      onExternal: (url) => newEra.openExternal(url).catch(() => this.toast('Could not open ' + url)),
      preview: (url) => newEra.web.preview(url),
      prompt: (label) => this.prompt(label),
    });
    host.addEventListener('input', () => {
      this.dirty = true;
      // A tab you have typed in is one you meant to keep.
      if (this.activeTab && !this.activeTab.kept) { this.activeTab.kept = true; this.renderTabs(); }
    }, true);

    this.renderRight(path);
    this.renderSidebar();
    this.renderTabs();
    this.plugins.emit('note:open', { path });
    if (!force) this.editor.focus();
  }

  // Re-read the open note from disk and rebuild the page. Used after a banner,
  // icon or property change rewrites the frontmatter underneath the editor.
  async reloadCurrentNote() {
    if (!this.current || this.current.type !== 'note') return;
    await this.refresh();
    await this.openNote(this.current.path, { force: true });
  }

  async followLink(target) {
    const clean = target.replace(/\.md$/i, '').toLowerCase();
    const hit = this.notes.find((n) => n.path.replace(/\.md$/i, '').toLowerCase() === clean)
      || this.notes.find((n) => n.path.split('/').pop().replace(/\.md$/i, '').toLowerCase() === clean);
    if (hit) return this.openNote(hit.path);
    const made = await newEra.note.create(target, '');
    await this.refresh();
    this.toast('Created ' + made.path);
    return this.openNote(made.path);
  }

  async renameNote(path, title) {
    if (!title.trim()) return;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const next = dir + title.trim().replace(/[\\/:*?"<>|]/g, '-') + '.md';
    if (next === path) return;
    try {
      const r = await newEra.note.rename(path, next);
      await this.refresh();
      this.tabs = this.tabs.filter((t) => t.path !== path);
      this.openNote(r.path);
    } catch (e) { this.toast(e.message); }
  }

  noteMenu(e, path) {
    this.menu(e.target, this.noteMenuItems(path));
  }

  noteMenuItems(path) {
    return [
      { label: 'Open', run: () => this.openNote(path) },
      { label: 'Rename…', run: async () => {
        const name = await this.prompt('New name', path.split('/').pop().replace(/\.md$/, ''));
        if (name) this.renameNote(path, name);
      } },
      { label: 'Reveal in file manager', run: () => newEra.vault.reveal(path) },
      { label: 'Move to trash', run: async () => {
        await newEra.note.trash(path);
        this.tabs = this.tabs.filter((t) => t.path !== path);
        await this.refresh();
        this.renderWelcome();
      } },
    ];
  }

  // --- connections panel, and "mentioned in" at the foot of the page -------

  async renderRight(path) {
    const backs = await newEra.index.backlinks(path);
    const outs = await newEra.index.outlinks(path);
    const meta = await newEra.note.meta(path);
    const props = (meta && meta.props) || {};
    const style = this.settings.values.dateFormat;

    this.el.right.replaceChildren(
      h('div', { class: 'rail-sec' }, [
        h('div', { class: 'rail-head', text: `\u{1F517} Mentioned in (${backs.length})` }),
        ...(backs.length
          ? backs.map((b) => h('a', {
            class: 'rail-link', text: prettyTitle(b.title, style), onclick: () => this.openNote(b.path),
          }))
          : [h('div', { class: 'muted', text: 'No other page mentions this one yet. Type [[ in any page to link here.' })]),
      ]),
      ...this.plugins.rails.map((panel) => {
        const host = h('div', { class: 'rail-sec' }, [
          h('div', { class: 'rail-head', text: panel.title || panel.plugin }),
        ]);
        const slot = h('div', {});
        host.append(slot);
        try { panel.mount(slot, { path, props }); } catch (err) {
          slot.append(h('div', { class: 'muted', text: 'Panel error: ' + err.message }));
        }
        return host;
      }),
      h('div', { class: 'rail-sec' }, [
        h('div', { class: 'rail-head', text: `➡️ Links on this page (${outs.length})` }),
        ...outs.map((o) => h('a', {
          class: 'rail-link' + (o.resolved || o.type === 'tag' ? '' : ' is-unresolved'),
          text: (o.type === 'tag' ? '#' : '') + o.target,
          onclick: () => (o.type === 'tag'
            ? this.openDatabase({ name: '#' + o.target, source: { tag: o.target }, view: 'table' }, true)
            : this.followLink(o.target)),
        })),
      ]),
    );
  }

  // Under the last line of a page: the pages that point here, as cards you
  // can click. Nothing at all when there are none.
  async renderMentions(path, foot) {
    const backs = (await newEra.index.backlinks(path)).filter((b) => b.type !== 'tag');
    if (!foot.isConnected || !backs.length) return;
    const style = this.settings.values.dateFormat;
    const byPath = new Map(this.notes.map((n) => [n.path, n]));
    foot.replaceChildren(h('section', { class: 'mentions' }, [
      h('h3', { text: `\u{1F517} Mentioned in ${backs.length} other page${backs.length > 1 ? 's' : ''}` }),
      h('div', { class: 'mention-cards' }, backs.map((b) => {
        const n = byPath.get(b.path);
        const folder = b.path.includes('/') ? b.path.slice(0, b.path.lastIndexOf('/')) : '';
        return h('button', { class: 'mention-card', onclick: () => this.openNote(b.path) }, [
          h('span', { class: 'mention-ico', text: (n && n.icon) || '\u{1F4C4}' }),
          h('span', { class: 'mention-text' }, [
            h('span', { class: 'mention-title', text: prettyTitle(b.title, style) }),
            folder ? h('span', { class: 'mention-folder', text: folder }) : null,
          ]),
        ]);
      })),
    ]));
  }

  // --- databases -----------------------------------------------------------

  openDatabase(spec, ephemeral = false) {
    if (this.editor) { this.editor.flush(); this.editor.destroy(); this.editor = null; }
    this.closeGraph();
    spec.id ||= 'v' + Math.random().toString(36).slice(2, 9);
    if (!ephemeral && !this.views.some((v) => v.id === spec.id)) {
      this.views.push(spec);
      this.saveViews();
    }
    this.current = { type: 'db', id: spec.id, spec };
    this.pushTab({ type: 'db', id: spec.id, spec, title: spec.name || 'Base' });
    this.el.right.replaceChildren();
    this.el.content.replaceChildren();
    this.db = new DatabaseView(this.el.content, spec, this);
    this.renderSidebar();
    this.renderTabs();
  }

  saveViews() { newEra.views.save(this.views); }

  // --- graph ---------------------------------------------------------------

  closeGraph() {
    if (this.graph) { this.graph.destroy(); this.graph = null; }
  }

  openGraph(mode) {
    if (this.editor) { this.editor.flush(); this.editor.destroy(); this.editor = null; }
    this.closeGraph();
    this.db = null;
    this.current = { type: 'graph', id: 'graph' };
    this.pushTab({ type: 'graph', id: 'graph', title: 'Graph' });
    this.el.right.replaceChildren();
    this.el.content.replaceChildren();
    this.graph = new GraphView(this.el.content, this, { mode: mode || 'global' });
    this.renderSidebar();
    this.renderTabs();
  }

  openPluginView(id) {
    const view = this.plugins.views.get(id);
    if (!view) return this.toast('No such view: ' + id);
    if (this.editor) { this.editor.flush(); this.editor.destroy(); this.editor = null; }
    this.closeGraph();
    this.db = null;
    this.current = { type: 'plugin', id };
    this.pushTab({ type: 'plugin', id, title: view.name });
    this.el.right.replaceChildren();
    this.el.content.replaceChildren();
    this.renderTabs();
    this.renderSidebar();
    try {
      view.mount(this.el.content, { app: this, notePath: this.lastNotePath });
    } catch (err) {
      this.el.content.append(h('div', { class: 'db-empty', text: 'View error: ' + err.message }));
    }
    return undefined;
  }

  openTab(t) {
    if (t.type === 'note') return this.openNote(t.path);
    if (t.type === 'graph') return this.openGraph();
    if (t.type === 'plugin') return this.openPluginView(t.id);
    if (t.type === 'settings') return this.openSettings();
    if (t.type === 'asset') return this.openAssetView(t.asset);
    return this.openDatabase(t.spec);
  }

  // Resolve an embed the way wikilinks resolve: exact path, then basename
  // anywhere in the vault. Without this, a pasted image only worked from the
  // one folder it happened to land in.
  assetUrl(rel) {
    if (/^(https?|data|file):/.test(rel)) return rel;
    let clean = String(rel).replace(/^\.\//, '');
    try { clean = decodeURI(clean); } catch { /* keep the raw text */ }
    const hit = (this.assetByName && this.assetByName.get(clean.toLowerCase())) || clean;
    return encodeURI('file:///' + (this.vault + '/' + hit).replace(/\\/g, '/').replace(/^\/+/, ''));
  }

  // --- commands ------------------------------------------------------------

  builtins() {
    return [
      { id: 'note.new', name: 'New note', run: () => this.newNote() },
      { id: 'note.daily', name: "Open today's daily note", run: () => this.dailyNote() },
      { id: 'db.new', name: 'New database base', run: () => this.newBase() },
      { id: 'vault.pick', name: 'Open vault…', run: async () => {
        const s = await newEra.vault.pick();
        if (s) { this.tabs = []; this.current = null; await this.setVault(s); }
      } },
      { id: 'vault.resync', name: 'Reindex vault', run: async () => {
        const s = await newEra.vault.resync();
        await this.refresh();
        this.toast(`Indexed ${s.total} notes, ${s.links} links`);
      } },
      { id: 'view.search', name: 'Search notes and their text', run: () => this.omni.open() },
      { id: 'palette.omni', name: 'Search everything', run: () => this.omni.open() },
      { id: 'palette.files', name: 'Find a note', run: () => this.omni.open() },
      { id: 'palette.commands', name: 'Run a command', run: () => this.omni.open('>') },
      { id: 'palette.files2', name: 'Find a file or attachment', run: () => this.omni.open('@') },
      { id: 'palette.settings', name: 'Find a setting', run: () => this.omni.open('/') },
      { id: 'view.graph', name: 'Graph view', run: () => this.openGraph('global') },
      { id: 'view.rail', name: 'Toggle right panel', run: () => this.toggleRail() },
      { id: 'editor.highlight', name: 'Highlight selection', run: () => this.wrapSelection('==') },
      { id: 'editor.bold', name: 'Bold selection', run: () => this.wrapSelection('**') },
      { id: 'editor.italic', name: 'Italic selection', run: () => this.wrapSelection('*') },
      { id: 'tab.close', name: 'Close tab', run: () => {
        const t = this.tabs.find((x) => this.isCurrent(x));
        if (t) this.closeTab(t);
      } },
      { id: 'tab.next', name: 'Next tab', run: () => this.cycleTab(1) },
      { id: 'tab.prev', name: 'Previous tab', run: () => this.cycleTab(-1) },
      { id: 'view.localGraph', name: 'Local graph of this note', run: () => this.openGraph('local') },
      { id: 'app.settings', name: 'Open settings', run: () => this.openSettings() },
      { id: 'view.sidebar', name: 'Toggle sidebar', run: () => this.toggleSidebar() },
      { id: 'note.cover', name: 'Add or change page cover', run: () => {
        const btn = document.querySelector('.page-adders .add-btn:last-child, .cover-tools .chip-btn');
        if (btn) btn.click(); else this.toast('Open a note first');
      } },
      { id: 'plugins.folder', name: 'Open plugins folder', run: () => newEra.plugins.folder() },
    ];
  }

  command(id) {
    const all = [...this.builtins(), ...this.plugins.allCommands()];
    const cmd = all.find((c) => c.id === id);
    if (cmd) cmd.run();
  }

  // Wrap or unwrap the selection, the way every editor's bold button behaves.
  wrapSelection(mark) {
    if (!this.editor) return this.toast('Open a note first');
    const view = this.editor.view;
    const { from, to } = view.state.selection.main;
    if (from === to) {
      view.dispatch({
        changes: { from, insert: mark + mark },
        selection: { anchor: from + mark.length },
      });
      view.focus();
      return undefined;
    }
    const text = view.state.sliceDoc(from, to);
    const wrapped = text.startsWith(mark) && text.endsWith(mark) && text.length > mark.length * 2;
    const next = wrapped ? text.slice(mark.length, -mark.length) : mark + text + mark;
    view.dispatch({
      changes: { from, to, insert: next },
      selection: { anchor: from, head: from + next.length },
    });
    view.focus();
    return undefined;
  }

  cycleTab(step) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => this.isCurrent(t));
    const next = this.tabs[(i + step + this.tabs.length) % this.tabs.length];
    if (next) this.openTab(next);
  }

  async newNote() {
    const name = await this.prompt('What do you want to call your new page?', 'Untitled');
    if (!name) return;
    const folder = this.settings.values.newNoteFolder;
    const note = await newEra.note.create((folder ? folder + '/' : '') + name, '');
    await this.refresh();
    this.openNote(note.path);
  }

  async dailyNote() {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const folder = this.settings.values.dailyFolder || 'Daily';
    const path = `${folder}/${iso}.md`;
    const known = this.notes.find((n) => n.path === path);
    if (known) return this.openNote(path);
    await newEra.note.create(path, `---\ndate: ${iso}\n---\n\n`);
    await this.refresh();
    return this.openNote(path);
  }

  async newBase() {
    const name = await this.prompt('Base name', 'Projects');
    if (!name) return;
    const folders = await newEra.index.folders();
    const folder = folders.find((f) => f.folder.toLowerCase() === name.toLowerCase());
    this.openDatabase({
      name, icon: '▦', view: 'table',
      source: folder ? { folder: folder.folder } : {},
      columns: [], filters: [],
    });
  }

  // --- overlays ------------------------------------------------------------

  hotkey(e) {
    if (e.key === 'Escape') { this.closeOverlay(); return undefined; }
    const cmd = this.keymap.lookup(e);
    if (!cmd) return undefined;
    // Let the editor keep its own Ctrl+B/I etc. unless we actually own the combo.
    e.preventDefault();
    e.stopPropagation();
    this.command(cmd);
    return undefined;
  }

  closeOverlay() {
    document.querySelectorAll('.overlay, .menu, .popover, .slash-menu').forEach((n) => n.remove());
  }

  // An anchored panel with arbitrary content (emoji picker, cover picker).
  popover(anchor, children) {
    this.closeOverlay();
    const pop = h('div', { class: 'popover' }, children);
    document.body.append(pop);
    this.place(pop, anchor);
    const away = (e) => {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      document.removeEventListener('mousedown', away, true);
      pop.remove();
    };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    return pop;
  }

  // Settings is a page in its own tab, with room to breathe.
  openSettings(tab, highlight) {
    this.closeOverlay();
    if (tab) this.settings.tab = tab;
    if (this.editor) { this.editor.flush(); this.editor.destroy(); this.editor = null; }
    this.closeGraph();
    this.db = null;
    const scroller = this.el.content.querySelector('.set-main');
    const keep = this.current && this.current.type === 'settings' && scroller ? scroller.scrollTop : 0;
    this.current = { type: 'settings', id: 'settings' };
    this.pushTab({ type: 'settings', id: 'settings', title: '\u2699\uFE0F Settings' });
    this.el.right.replaceChildren();
    this.el.content.replaceChildren(this.settings.page(highlight));
    // Re-rendering after a toggle should not throw you back to the top.
    if (!highlight) this.el.content.querySelector('.set-main').scrollTop = keep;
    this.renderTabs();
    this.renderSidebar();
  }

  toggleSidebar() {
    document.body.classList.toggle('no-sidebar');
  }

  // Kept for callers and muscle memory: both old palettes are scopes of the
  // one search now.
  palette(mode) {
    this.omni.open(mode === 'commands' ? '>' : '');
  }

  menu(anchor, items) {
    this.closeOverlay();
    const menu = h('div', { class: 'menu' }, items.map((i) => h('div', {
      class: 'menu-row', text: i.label, onclick: () => { this.closeOverlay(); i.run(); },
    })));
    document.body.append(menu);
    this.place(menu, anchor);
    setTimeout(() => document.addEventListener('click', () => this.closeOverlay(), { once: true }), 0);
    return menu;
  }

  // Anchor a floating panel, flipping it above when there is no room below.
  // Anything triggered from the sidebar footer opens upward, which is why the
  // vault menu used to render off the bottom of the window.
  place(el, anchor) {
    const a = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const pad = 8;
    const below = a.bottom + 4;
    const fitsBelow = below + box.height <= window.innerHeight - pad;
    const top = fitsBelow ? below : Math.max(pad, a.top - box.height - 4);
    el.style.left = Math.max(pad, Math.min(a.left, window.innerWidth - box.width - pad)) + 'px';
    el.style.top = top + 'px';
    // Still too tall for the window even flipped: let it scroll rather than
    // spill past the edge.
    if (box.height > window.innerHeight - pad * 2) {
      el.style.top = pad + 'px';
      el.style.maxHeight = (window.innerHeight - pad * 2) + 'px';
      el.style.overflowY = 'auto';
    }
  }

  prompt(label, value = '') {
    return new Promise((resolve) => {
      this.closeOverlay();
      const input = h('input', { class: 'palette-input', value });
      const done = (v) => { this.closeOverlay(); resolve(v); };
      const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) done(null); } }, [
        h('div', { class: 'palette' }, [
          h('div', { class: 'prompt-label', text: label }),
          input,
          h('div', { class: 'prompt-actions' }, [
            h('button', { class: 'btn', text: 'Cancel', onclick: () => done(null) }),
            h('button', { class: 'btn btn-primary', text: 'Done', onclick: () => done(input.value) }),
          ]),
        ]),
      ]);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(input.value);
        if (e.key === 'Escape') done(null);
      };
      document.body.append(overlay);
      input.focus();
      input.select();
    });
  }

  toast(msg) {
    const el = h('div', { class: 'toast', text: msg });
    this.el.toast.append(el);
    setTimeout(() => el.classList.add('is-out'), 2200);
    setTimeout(() => el.remove(), 2600);
  }
}

// FTS snippets are the only HTML we inject; allow just the <mark> tags it emits.
function sanitize(html) {
  return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}

const app = new App();
window.app = app;
app.boot();
