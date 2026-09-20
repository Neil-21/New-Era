// Hermes: Obsidian-style vault, Notion-style databases, one window.
import '../style.css';
import { createEditor } from './editor.js';
import { DatabaseView, h } from './dbview.js';
import { PluginHost } from './plugins.js';
import { renderPageHeader } from './page.js';
import { Settings } from './settings.js';
import { GraphView } from './graph.js';
import { Keymap } from './keymap.js';

const hermes = window.hermes;

const KIND_ICON = {
  image: '\u25a3', video: '\u25b6', audio: '\u266a', doc: '\u25a5',
  data: '\u2637', code: '\u2b1a', file: '\u25cb',
};

function fileSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
const $ = (sel) => document.querySelector(sel);

class App {
  constructor() {
    this.vault = null;
    this.notes = [];
    this.views = [];
    this.tabs = [];
    this.current = null;
    this.editor = null;
    this.sidebarTab = 'files';
    this.collapsed = new Set();
    this.plugins = new PluginHost(this);
    this.settings = new Settings(this);
    this.keymap = new Keymap(this);
  }

  async boot() {
    document.body.append(this.layout());
    const state = await hermes.vault.current();
    if (state.vault) await this.setVault(state);
    else this.renderWelcome();

    hermes.on('vault:changed', (p) => this.onVaultChanged(p));
    hermes.on('command', (cmd) => this.command(cmd));
    window.addEventListener('keydown', (e) => this.hotkey(e));
    this.keymap.load(this.settings.values.keys);
    await this.plugins.loadAll(this.settings.values.disabledPlugins || []);
    this.renderRibbon();
  }

  // --- chrome --------------------------------------------------------------

  layout() {
    this.el = {
      sidebar: h('div', { class: 'sidebar-body', id: 'sidebar-body' }),
      ribbon: h('div', { class: 'ribbon' }),
      vaultName: h('button', {
        class: 'vault-name', onclick: (e) => this.vaultMenu(e.currentTarget),
      }),
      tabbar: h('div', { class: 'tabbar' }),
      content: h('div', { class: 'content', id: 'content' }),
      right: h('aside', { class: 'rightbar', id: 'rightbar' }),
      toast: h('div', { class: 'toast-wrap' }),
    };

    const tabs = ['files', 'search', 'tags', 'bases', 'media'].map((t) => h('button', {
      class: 'stab',
      text: { files: 'Notes', search: 'Search', tags: 'Tags', bases: 'Bases', media: 'Files' }[t],
      'data-tab': t,
      onclick: () => { this.sidebarTab = t; this.renderSidebar(); },
    }));
    this.el.stabs = tabs;

    this.el.crumb = h('div', { class: 'titlebar-crumb' });
    document.documentElement.dataset.platform = hermes.platform || 'win32';

    return h('div', { class: 'app' }, [
      // One drag strip across the top. The OS still owns the window buttons on
      // the right (titleBarOverlay), so we only reserve room for them.
      h('div', { class: 'titlebar' }, [
        h('div', { class: 'titlebar-left' }, [
          h('button', {
            class: 'icon-btn no-drag', text: '\u2630', title: 'Toggle sidebar',
            onclick: () => this.toggleSidebar(),
          }),
        ]),
        this.el.crumb,
        h('div', { class: 'titlebar-right' }, [
          h('button', {
            class: 'icon-btn no-drag', text: '\u25cd', title: 'Graph view',
            onclick: () => this.command('view.graph'),
          }),
          h('button', {
            class: 'icon-btn no-drag', text: '\u25e7', title: 'Toggle right panel',
            onclick: () => this.toggleRail(),
          }),
        ]),
      ]),
      h('aside', { class: 'sidebar' }, [
        h('div', { class: 'stabs' }, tabs),
        this.el.sidebar,
        // Vault switcher and settings live at the bottom, out of the way of the
        // thing you actually came here to do.
        h('div', { class: 'sidebar-foot' }, [
          this.el.ribbon,
          h('div', { class: 'foot-row' }, [
            this.el.vaultName,
            h('button', {
              class: 'icon-btn', text: '\u2699', title: 'Settings',
              onclick: () => this.openSettings(),
            }),
          ]),
        ]),
      ]),
      h('main', { class: 'main' }, [this.el.tabbar, this.el.content]),
      this.el.right,
      this.el.toast,
    ]);
  }

  async setVault(state) {
    this.vault = state.vault;
    this.el.vaultName.textContent = state.vault.split(/[\\/]/).pop() || state.vault;
    this.el.vaultName.title = state.vault;
    this.views = await hermes.views.list();
    await this.settings.load();
    this.keymap.load(this.settings.values.keys);
    await this.refresh();
    if (!this.current) {
      const first = this.notes[0];
      if (first) this.openNote(first.path);
      else this.renderWelcome();
    }
  }

  async vaultMenu(anchor) {
    const recent = await hermes.vault.recent();
    const short = (p) => p.split(/[\\/]/).pop() || p;
    this.menu(anchor, [
      ...recent.filter((r) => r !== this.vault).slice(0, 5).map((r) => ({
        label: short(r),
        run: async () => {
          const state = await hermes.vault.open(r);
          if (!state) return this.toast('That vault folder is gone');
          this.tabs = [];
          this.current = null;
          return this.setVault(state);
        },
      })),
      { label: 'Open another vault\u2026', run: () => this.command('vault.pick') },
      { label: 'Reveal in file manager', run: () => hermes.vault.reveal('.') },
      { label: 'Reindex this vault', run: () => this.command('vault.resync') },
    ]);
  }

  toggleRail() {
    document.body.classList.toggle('no-rail');
  }

  async refresh() {
    this.notes = await hermes.index.all();
    this.assets = await hermes.asset.list({});
    // Basename lookup, so an embed keeps working after the file is moved.
    this.assetByName = new Map();
    for (const a of this.assets) {
      this.assetByName.set(a.path.toLowerCase(), a.path);
      if (!this.assetByName.has(a.name.toLowerCase())) {
        this.assetByName.set(a.name.toLowerCase(), a.path);
      }
    }
    this.renderSidebar();
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
      h('h1', { text: 'Hermes' }),
      h('p', { text: 'Your notes are plain markdown files. Your databases are queries over them.' }),
      h('button', { class: 'btn btn-primary', text: 'Open a vault folder', onclick: () => this.command('vault.pick') }),
    ]));
  }

  // --- sidebar -------------------------------------------------------------

  renderSidebar() {
    for (const t of this.el.stabs) t.classList.toggle('is-active', t.dataset.tab === this.sidebarTab);
    const body = this.el.sidebar;
    if (this.sidebarTab === 'files') return this.renderFiles(body);
    if (this.sidebarTab === 'search') return this.renderSearch(body);
    if (this.sidebarTab === 'tags') return this.renderTags(body);
    if (this.sidebarTab === 'media') return this.renderMedia(body);
    return this.renderBases(body);
  }

  renderFiles(body) {
    const tree = { dirs: new Map(), files: [] };
    for (const n of this.notes) {
      const parts = n.path.split('/');
      let node = tree;
      for (const dir of parts.slice(0, -1)) {
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

    // Count notes below a folder, so a collapsed folder still says how much is
    // inside it.
    const total = (node) => node.files.length
      + [...node.dirs.values()].reduce((sum, d) => sum + total(d), 0);

    const draw = (node, prefix, depth) => {
      const out = [];
      for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const full = prefix ? prefix + '/' + name : name;
        const open = !this.collapsed.has(full);
        const row = h('div', {
          class: 'tree-row tree-dir', style: `--depth:${depth}`,
          onclick: () => {
            if (open) this.collapsed.add(full); else this.collapsed.delete(full);
            this.renderSidebar();
          },
          oncontextmenu: (e) => { e.preventDefault(); this.folderMenu(e.currentTarget, full); },
        }, [
          h('span', { class: 'twisty' + (open ? ' is-open' : ''), text: '▸' }),
          h('span', { class: 'tree-name', text: name }),
          h('span', { class: 'count', text: total(child) }),
        ]);
        this.dropTarget(row, full);
        out.push(row);
        if (open) out.push(...draw(child, full, depth + 1));
      }
      if (this.settings.values.showAttachments) {
        for (const a of (node.assets || []).sort((x, y) => x.name.localeCompare(y.name))) {
          out.push(h('div', {
            class: 'tree-row tree-file tree-asset', style: `--depth:${depth}`,
            title: a.path,
            onclick: () => this.openAsset(a),
            oncontextmenu: (e) => { e.preventDefault(); this.assetMenu(e.currentTarget, a); },
          }, [
            h('span', { class: 'asset-ico', text: KIND_ICON[a.kind] || '\u25cb' }),
            h('span', { class: 'tree-name', text: a.name }),
          ]));
        }
      }
      for (const f of node.files.sort(sortFiles)) {
        const row = h('div', {
          class: 'tree-row tree-file' + (this.current && this.current.path === f.path ? ' is-active' : ''),
          style: `--depth:${depth}`,
          draggable: 'true',
          onclick: () => this.openNote(f.path),
          oncontextmenu: (e) => { e.preventDefault(); this.noteMenu(e, f.path); },
        }, [h('span', { class: 'tree-dot' }), h('span', { class: 'tree-name', text: f.title })]);
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/hermes-note', f.path);
          e.dataTransfer.effectAllowed = 'move';
        });
        out.push(row);
      }
      return out;
    };

    const root = h('div', { class: 'tree' }, draw(tree, '', 0));
    this.dropTarget(root, ''); // dropping on empty space moves to the vault root

    body.replaceChildren(
      h('div', { class: 'sidebar-actions' }, [
        h('button', { class: 'btn-ghost', text: '+ Note', onclick: () => this.command('note.new') }),
        h('button', { class: 'btn-ghost', text: '+ Folder', onclick: () => this.newFolder() }),
        h('button', { class: 'btn-ghost', text: 'Today', onclick: () => this.command('note.daily') }),
        h('button', {
          class: 'btn-ghost sort-btn', text: '⇅', title: 'Sort and collapse',
          onclick: (e) => this.menu(e.currentTarget, [
            { label: 'Name A → Z', run: () => { this.fileSort = 'name'; this.renderSidebar(); } },
            { label: 'Name Z → A', run: () => { this.fileSort = 'name-desc'; this.renderSidebar(); } },
            { label: 'Recently edited', run: () => { this.fileSort = 'modified'; this.renderSidebar(); } },
            { label: (this.settings.values.showAttachments ? '\u2713 ' : '   ') + 'Show attachments',
              run: () => {
                this.settings.set({ showAttachments: !this.settings.values.showAttachments });
                this.renderSidebar();
              } },
            { label: 'Collapse all folders', run: () => this.collapseAll() },
          ]),
        }),
      ]),
      root,
    );
  }

  // Dragging a note onto a folder row moves the file on disk. Links resolve by
  // basename, so nothing breaks as long as the filename stays the same.
  dropTarget(el, folder) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/hermes-note')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', async (e) => {
      el.classList.remove('is-drop');
      const from = e.dataTransfer.getData('text/hermes-note');
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();
      const name = from.split('/').pop();
      const to = folder ? folder + '/' + name : name;
      if (to === from) return;
      try {
        await hermes.note.rename(from, to);
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
    const name = await this.prompt('Folder name', 'New folder');
    if (!name) return;
    const clean = name.replace(/[\\:*?"<>|]/g, '-');
    await hermes.folder.create(clean);
    const note = await hermes.note.create(clean + '/Untitled', '# Untitled\n\n');
    await this.refresh();
    this.openNote(note.path);
  }

  folderMenu(anchor, folder) {
    this.menu(anchor, [
      { label: 'New note here', run: async () => {
        const name = await this.prompt('Note name', 'Untitled');
        if (!name) return;
        const note = await hermes.note.create(folder + '/' + name, '# ' + name + '\n\n');
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
          await hermes.folder.rename(folder, parent + name);
          await this.refresh();
        } catch (err) { this.toast(err.message); }
      } },
      { label: 'Collapse all folders', run: () => this.collapseAll() },
    ]);
  }

  // Every non-markdown file in the vault: images, data, video, PDFs.
  async renderMedia(body) {
    const kinds = await hermes.asset.kinds();
    const filter = this.mediaKind || null;
    const list = h('div', { class: 'tree' });

    const draw = async () => {
      const rows = await hermes.asset.list({ kind: filter, search: this.mediaSearch || null });
      if (!rows.length) {
        list.replaceChildren(h('div', { class: 'muted', text: 'Nothing here yet - paste or drop a file into a note.' }));
        return;
      }
      list.replaceChildren(...rows.map((a) => h('div', {
        class: 'tree-row tree-file asset-row', style: '--depth:0', title: a.path,
        onclick: () => this.openAsset(a),
        oncontextmenu: (e) => { e.preventDefault(); this.assetMenu(e.currentTarget, a); },
      }, [
        h('span', { class: 'asset-ico', text: KIND_ICON[a.kind] || '\u25cb' }),
        h('div', { class: 'asset-body' }, [
          h('div', { class: 'asset-name', text: a.name }),
          h('div', { class: 'asset-sub', text: `${a.folder || 'vault root'} \u00b7 ${fileSize(a.size)}` }),
        ]),
      ])));
    };

    body.replaceChildren(
      h('div', { class: 'sidebar-actions' }, [
        h('input', {
          class: 'search-input', placeholder: 'Find a file\u2026', value: this.mediaSearch || '',
          oninput: (e) => {
            this.mediaSearch = e.target.value;
            clearTimeout(this._mt);
            this._mt = setTimeout(draw, 180);
          },
        }),
      ]),
      h('div', { class: 'kind-chips' }, [
        h('button', {
          class: 'kind-chip' + (filter ? '' : ' is-active'), text: 'all',
          onclick: () => { this.mediaKind = null; this.renderSidebar(); },
        }),
        ...kinds.map((k) => h('button', {
          class: 'kind-chip' + (filter === k.kind ? ' is-active' : ''),
          text: `${KIND_ICON[k.kind] || ''} ${k.kind} ${k.n}`,
          onclick: () => { this.mediaKind = k.kind; this.renderSidebar(); },
        })),
      ]),
      list,
    );
    await draw();
  }

  // Data files open in the viewer; everything else goes to the OS.
  openAsset(a) {
    if (['json', 'csv', 'tsv', 'xlsx'].includes(a.ext) && this.plugins.views.has('data-viewer:file')) {
      this.dataFile = a.path;
      return this.openPluginView('data-viewer:file');
    }
    return hermes.asset.open(a.path);
  }

  assetMenu(anchor, a) {
    const link = /^(png|jpe?g|gif|webp|svg|avif|bmp|mp4|mov|webm|mp3|wav|ogg|m4a)$/i.test(a.ext)
      ? `![[${a.name}]]` : `[${a.name}](${encodeURI(a.path)})`;
    this.menu(anchor, [
      { label: 'Open', run: () => this.openAsset(a) },
      { label: 'Open with system app', run: () => hermes.asset.open(a.path) },
      { label: 'Copy embed for a note', run: async () => {
        await navigator.clipboard.writeText(link);
        this.toast('Copied ' + link);
      } },
      { label: 'Insert into the open note', run: () => {
        if (!this.editor) return this.toast('Open a note first');
        this.editor.insert(link + '\n');
        return this.toast('Inserted');
      } },
      { label: 'Reveal in file manager', run: () => hermes.vault.reveal(a.path) },
      { label: 'Move to trash', run: async () => {
        await hermes.asset.trash(a.path);
        await this.refresh();
        this.toast('Moved ' + a.name + ' to trash');
      } },
    ]);
  }

  renderSearch(body) {
    const results = h('div', { class: 'results' });
    const input = h('input', {
      class: 'search-input', placeholder: 'Search all notes…', value: this.lastSearch || '',
      oninput: async (e) => {
        this.lastSearch = e.target.value;
        const rows = await hermes.index.search(e.target.value);
        results.replaceChildren(...rows.map((r) => {
          const snip = h('div', { class: 'result-snip' });
          snip.innerHTML = sanitize(r.snip || '');
          return h('div', { class: 'result', onclick: () => this.openNote(r.path) }, [
            h('div', { class: 'result-title', text: r.title }), snip,
          ]);
        }));
        if (!rows.length && e.target.value) results.replaceChildren(h('div', { class: 'muted', text: 'No matches' }));
      },
    });
    body.replaceChildren(h('div', { class: 'sidebar-actions' }, [input]), results);
    input.focus();
  }

  async renderTags(body) {
    const tags = await hermes.index.tags();
    body.replaceChildren(h('div', { class: 'tree' }, tags.map((t) => h('div', {
      class: 'tree-row tree-file', style: '--depth:0',
      onclick: () => this.openDatabase({ name: '#' + t.tag, source: { tag: t.tag }, view: 'table' }, true),
    }, [h('span', { text: '#' + t.tag }), h('span', { class: 'count', text: t.n })]))));
  }

  async renderBases(body) {
    const folders = await hermes.index.folders();
    body.replaceChildren(
      h('div', { class: 'sidebar-actions' }, [
        h('button', { class: 'btn-ghost', text: '+ New base', onclick: () => this.command('db.new') }),
      ]),
      h('div', { class: 'tree' }, [
        ...this.views.map((v) => h('div', {
          class: 'tree-row tree-file' + (this.current && this.current.id === v.id ? ' is-active' : ''),
          style: '--depth:0',
          onclick: () => this.openDatabase(v),
          oncontextmenu: (e) => {
            e.preventDefault();
            this.menu(e.target, [{ label: 'Delete base', run: () => {
              this.views = this.views.filter((x) => x.id !== v.id);
              this.saveViews();
              this.renderSidebar();
            } }]);
          },
        }, [h('span', { text: (v.icon || '▦') + ' ' + v.name })])),
        h('div', { class: 'tree-label', text: 'Folders as tables' }),
        ...folders.map((f) => h('div', {
          class: 'tree-row tree-file', style: '--depth:0',
          onclick: () => this.openDatabase({ name: f.folder, source: { folder: f.folder }, view: 'table' }, true),
        }, [h('span', { text: f.folder }), h('span', { class: 'count', text: f.n })])),
      ]),
    );
  }

  renderRibbon() {
    // Icon plus label. An icon row alone is a guessing game - nobody knows what
    // the third glyph does.
    this.el.ribbon.replaceChildren(
      ...this.plugins.ribbon.map((r) => h('button', {
        class: 'ribbon-btn', title: r.title || r.plugin, onclick: (e) => r.run(e),
      }, [
        h('span', { class: 'ribbon-ico', text: r.icon || '●' }),
        h('span', { class: 'ribbon-label', text: r.title || r.plugin }),
      ])),
    );
  }

  // --- tabs ----------------------------------------------------------------

  renderTabs() {
    this.el.tabbar.replaceChildren(...this.tabs.map((t) => h('div', {
      class: 'tab' + (this.isCurrent(t) ? ' is-active' : ''),
      onclick: () => this.openTab(t),
    }, [
      h('span', { text: t.title }),
      h('button', { class: 'tab-x', text: '×', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }),
    ])));
  }

  isCurrent(t) {
    if (!this.current) return false;
    return t.type === 'note' ? this.current.path === t.path : this.current.id === t.id;
  }

  pushTab(tab) {
    if (!this.tabs.some((t) => (t.type === 'note' ? t.path === tab.path : t.id === tab.id))) {
      this.tabs.push(tab);
      if (this.tabs.length > 12) this.tabs.shift();
    }
    this.renderTabs();
  }

  closeTab(tab) {
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.renderTabs();
    if (this.isCurrent(tab)) {
      const next = this.tabs[this.tabs.length - 1];
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
    try { note = await hermes.note.read(path); } catch { return this.toast('Cannot open ' + path); }
    this.current = { type: 'note', path, title: path.split('/').pop().replace(/\.md$/, '') };
    // Remembered separately: opening the graph replaces `current`, and the
    // local graph still needs to know which note it is centred on.
    this.lastNotePath = path;
    this.dirty = false;
    this.pushTab({ type: 'note', path, title: this.current.title });

    const host = h('div', { class: 'editor-host' });
    this.el.content.replaceChildren(h('div', { class: 'note' }, [
      renderPageHeader({
        path, props: note.props, title: note.props.title || this.current.title, app: this,
      }),
      host,
    ]));

    const exists = new Set(this.notes.map((n) => n.path.replace(/\.md$/, '').toLowerCase()));
    const existsBase = new Set(this.notes.map((n) => n.path.split('/').pop().replace(/\.md$/, '').toLowerCase()));

    this.editor = createEditor(host, {
      doc: note.raw,
      // Land the cursor on the body. At offset 0 the cursor sits inside the
      // frontmatter, which would unfold it on every single open.
      cursor: note.raw.length - note.body.length,
      exists: (t) => exists.has(t.toLowerCase()) || existsBase.has(t.toLowerCase()),
      onChange: async (text) => {
        this.dirty = false;
        await hermes.note.write(path, text);
        this.renderRight(path);
      },
      asset: (src) => this.assetUrl(src),
      onAttach: async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await hermes.asset.save(this.attachFolder(path), file.name || 'pasted.png', bytes);
        await this.refresh();
        this.toast(`Saved ${saved.path}`);
        return saved;
      },
      onAttachError: (err) => this.toast('Could not attach: ' + err.message),
      onLink: (target) => this.followLink(target),
      onExternal: (url) => hermes.openExternal(url).catch(() => this.toast('Could not open ' + url)),
    });
    host.addEventListener('input', () => { this.dirty = true; }, true);

    this.renderRight(path);
    this.renderSidebar();
    this.renderTabs();
    this.setCrumb((note.props.icon ? note.props.icon + '  ' : '') + path.replace(/\.md$/, ''));
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
    const made = await hermes.note.create(target, `# ${target}\n\n`);
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
      const r = await hermes.note.rename(path, next);
      await this.refresh();
      this.tabs = this.tabs.filter((t) => t.path !== path);
      this.openNote(r.path);
    } catch (e) { this.toast(e.message); }
  }

  noteMenu(e, path) {
    this.menu(e.target, [
      { label: 'Open', run: () => this.openNote(path) },
      { label: 'Rename…', run: async () => {
        const name = await this.prompt('New name', path.split('/').pop().replace(/\.md$/, ''));
        if (name) this.renameNote(path, name);
      } },
      { label: 'Reveal in file manager', run: () => hermes.vault.reveal(path) },
      { label: 'Move to trash', run: async () => {
        await hermes.note.trash(path);
        this.tabs = this.tabs.filter((t) => t.path !== path);
        await this.refresh();
        this.renderWelcome();
      } },
    ]);
  }

  // --- right rail: properties + backlinks ----------------------------------

  async renderRight(path) {
    const meta = await hermes.note.meta(path);
    const backs = await hermes.index.backlinks(path);
    const outs = await hermes.index.outlinks(path);
    const props = (meta && meta.props) || {};

    const rows = Object.entries(props).map(([k, v]) => h('div', { class: 'prop' }, [
      h('div', { class: 'prop-key', text: k }),
      h('input', {
        class: 'prop-val', value: Array.isArray(v) ? v.join(', ') : String(v ?? ''),
        onchange: async (e) => {
          const next = Array.isArray(v) ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
            : e.target.value;
          await hermes.note.setProps(path, { [k]: next });
          if (this.editor) this.editor.setDoc((await hermes.note.read(path)).raw);
          this.toast(`${k} updated`);
        },
      }),
    ]));

    this.el.right.replaceChildren(
      h('div', { class: 'rail-sec' }, [
        h('div', { class: 'rail-head' }, [
          h('span', { text: 'Properties' }),
          h('button', { class: 'btn-ghost', text: '+', onclick: async () => {
            const key = await this.prompt('Property name');
            if (!key) return;
            await hermes.note.setProps(path, { [key]: '' });
            if (this.editor) this.editor.setDoc((await hermes.note.read(path)).raw);
            this.renderRight(path);
          } }),
        ]),
        ...(rows.length ? rows : [h('div', { class: 'muted', text: 'No properties yet' })]),
      ]),
      h('div', { class: 'rail-sec' }, [
        h('div', { class: 'rail-head', text: `Backlinks (${backs.length})` }),
        ...(backs.length
          ? backs.map((b) => h('a', { class: 'rail-link', text: b.title, onclick: () => this.openNote(b.path) }))
          : [h('div', { class: 'muted', text: 'Nothing links here yet' })]),
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
        h('div', { class: 'rail-head', text: `Links (${outs.length})` }),
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

  saveViews() { hermes.views.save(this.views); }

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
    this.setCrumb('Graph');
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
    this.setCrumb(view.name);
    this.renderTabs();
    this.renderSidebar();
    try {
      view.mount(this.el.content, { app: this, notePath: this.lastNotePath });
    } catch (err) {
      this.el.content.append(h('div', { class: 'db-empty', text: 'View error: ' + err.message }));
    }
    return undefined;
  }

  setCrumb(text) {
    if (this.el.crumb) this.el.crumb.textContent = text;
  }

  openTab(t) {
    if (t.type === 'note') return this.openNote(t.path);
    if (t.type === 'graph') return this.openGraph();
    if (t.type === 'plugin') return this.openPluginView(t.id);
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
        const s = await hermes.vault.pick();
        if (s) { this.tabs = []; this.current = null; await this.setVault(s); }
      } },
      { id: 'vault.resync', name: 'Reindex vault', run: async () => {
        const s = await hermes.vault.resync();
        await this.refresh();
        this.toast(`Indexed ${s.total} notes, ${s.links} links`);
      } },
      { id: 'view.search', name: 'Search notes', run: () => { this.sidebarTab = 'search'; this.renderSidebar(); } },
      { id: 'palette.files', name: 'Quick switcher', run: () => this.palette('files') },
      { id: 'palette.commands', name: 'Command palette', run: () => this.palette('commands') },
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
      { id: 'app.settings', name: 'Appearance settings', run: () => this.openSettings() },
      { id: 'view.sidebar', name: 'Toggle sidebar', run: () => this.toggleSidebar() },
      { id: 'note.cover', name: 'Add or change page cover', run: () => {
        const btn = document.querySelector('.page-adders .add-btn:last-child, .cover-tools .chip-btn');
        if (btn) btn.click(); else this.toast('Open a note first');
      } },
      { id: 'plugins.folder', name: 'Open plugins folder', run: () => hermes.plugins.folder() },
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
    const name = await this.prompt('Note name', 'Untitled');
    if (!name) return;
    const folder = this.settings.values.newNoteFolder;
    const note = await hermes.note.create((folder ? folder + '/' : '') + name, `# ${name}\n\n`);
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
    await hermes.note.create(path, `---\ndate: ${iso}\n---\n\n# ${iso}\n\n`);
    await this.refresh();
    return this.openNote(path);
  }

  async newBase() {
    const name = await this.prompt('Base name', 'Projects');
    if (!name) return;
    const folders = await hermes.index.folders();
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
    const r = anchor.getBoundingClientRect();
    const pop = h('div', { class: 'popover' }, children);
    document.body.append(pop);
    const box = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8)) + 'px';
    pop.style.top = (r.bottom + box.height + 8 > window.innerHeight
      ? Math.max(8, r.top - box.height - 6) : r.bottom + 6) + 'px';
    const away = (e) => {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      document.removeEventListener('mousedown', away, true);
      pop.remove();
    };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    return pop;
  }

  openSettings() {
    this.closeOverlay();
    const overlay = h('div', {
      class: 'overlay', onclick: (e) => { if (e.target === overlay) this.closeOverlay(); },
    }, [h('div', { class: 'panel' }, [this.settings.panel()])]);
    document.body.append(overlay);
  }

  toggleSidebar() {
    document.body.classList.toggle('no-sidebar');
  }

  palette(mode) {
    this.closeOverlay();
    const items = mode === 'files'
      ? this.notes.map((n) => ({ label: n.title, hint: n.path, run: () => this.openNote(n.path) }))
      : [...this.builtins(), ...this.plugins.allCommands()].map((c) => ({ label: c.name, hint: c.id, run: c.run }));

    const list = h('div', { class: 'palette-list' });
    let shown = [];
    let sel = 0;
    const draw = (q) => {
      const ql = q.toLowerCase();
      shown = items.filter((i) => (i.label + ' ' + i.hint).toLowerCase().includes(ql)).slice(0, 60);
      sel = 0;
      paint();
    };
    const paint = () => list.replaceChildren(...shown.map((i, n) => h('div', {
      class: 'palette-row' + (n === sel ? ' is-sel' : ''),
      onclick: () => { this.closeOverlay(); i.run(); },
    }, [h('span', { text: i.label }), h('span', { class: 'hint', text: i.hint })])));

    const input = h('input', {
      class: 'palette-input', placeholder: mode === 'files' ? 'Jump to note…' : 'Run a command…',
      oninput: (e) => draw(e.target.value),
      onkeydown: (e) => {
        if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); paint(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
        if (e.key === 'Enter' && shown[sel]) { this.closeOverlay(); shown[sel].run(); }
      },
    });
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) this.closeOverlay(); } },
      [h('div', { class: 'palette' }, [input, list])]);
    document.body.append(overlay);
    draw('');
    input.focus();
  }

  menu(anchor, items) {
    this.closeOverlay();
    const r = anchor.getBoundingClientRect();
    const menu = h('div', { class: 'menu', style: `left:${Math.min(r.left, innerWidth - 240)}px; top:${r.bottom + 4}px` },
      items.map((i) => h('div', { class: 'menu-row', text: i.label, onclick: () => { this.closeOverlay(); i.run(); } })));
    document.body.append(menu);
    setTimeout(() => document.addEventListener('click', () => this.closeOverlay(), { once: true }), 0);
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
            h('button', { class: 'btn btn-primary', text: 'OK', onclick: () => done(input.value) }),
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
