// Notion-style database views over plain markdown notes.
// A "database" is just a query (folder + tag + filters). A "property" is just a
// frontmatter key. Editing a cell rewrites that key in the .md file - there is
// no separate record store to drift out of sync.
import { coverOf, coverStyle } from './cover.js';

const h = (tag, attrs = {}, kids = []) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) el.append(kid);
  return el;
};

const EMPTY = '—'; // em dash for an empty cell
const NO_VALUE = 'No value';

function display(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// Reverse of display(): keep the stored type stable so a list stays a list.
function coerce(text, previous) {
  const t = text.trim();
  if (Array.isArray(previous)) return t ? t.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (t === '') return '';
  if (typeof previous === 'number' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (typeof previous === 'boolean') return /^(true|yes|done|x)$/i.test(t);
  if (/^-?\d+(\.\d+)?$/.test(t) && typeof previous !== 'string') return Number(t);
  return t;
}

// Stable per-value colour, so "Active" is the same green everywhere. Notion
// assigns these by hand; a hash is one line and nobody has to pick.
function chipHue(value) {
  let n = 0;
  for (let i = 0; i < value.length; i++) n = (n * 31 + value.charCodeAt(i)) >>> 0;
  return n % 360;
}

function chip(value) {
  const hue = chipHue(String(value));
  return h('span', {
    class: 'chip', text: String(value),
    style: `--chip-h:${hue}deg`,
  });
}

export class DatabaseView {
  constructor(host, spec, app) {
    this.host = host;
    this.app = app;
    this.spec = {
      view: 'table', columns: [], filters: [], source: {}, ...spec,
    };
    this.rows = [];
    this.render();
  }

  async load() {
    const q = {
      folder: this.spec.source.folder || null,
      tag: this.spec.source.tag || null,
      filters: this.spec.filters,
      sort: this.spec.sort,
      search: this.search || null,
    };
    this.rows = await window.newEra.index.query(q);
    this.keys = await window.newEra.index.propKeys(q);
    if (!this.spec.columns.length) {
      this.spec.columns = this.keys.slice(0, 4).map((k) => k.key);
    }
  }

  async render() {
    await this.load();
    this.host.replaceChildren(this.toolbar(), this.body());
  }

  save() { this.app.saveViews(); }

  async patch(row, key, value) {
    const prev = row.props[key];
    if (display(prev) === display(value)) return;
    row.props[key] = value;
    await window.newEra.note.setProps(row.path, { [key]: value === '' ? undefined : value });
    this.app.toast(`${key} → ${display(value) || 'empty'}`);
  }

  // --- chrome --------------------------------------------------------------

  toolbar() {
    const views = ['table', 'board', 'gallery'];
    const src = this.spec.source.folder ? this.spec.source.folder
      : this.spec.source.tag ? '#' + this.spec.source.tag : 'whole vault';

    return h('div', { class: 'db-toolbar' }, [
      h('div', { class: 'db-title' }, [
        h('span', { class: 'db-icon', text: this.spec.icon || '▦' }),
        h('input', {
          class: 'db-name', value: this.spec.name || 'Untitled', spellcheck: 'false',
          onchange: (e) => { this.spec.name = e.target.value; this.save(); this.app.renderSidebar(); },
        }),
        h('span', { class: 'db-source', text: src }),
      ]),
      h('div', { class: 'db-tabs' }, views.map((v) => h('button', {
        class: 'db-tab' + (this.spec.view === v ? ' is-active' : ''),
        text: v,
        onclick: () => { this.spec.view = v; this.save(); this.render(); },
      }))),
      h('div', { class: 'db-actions' }, [
        h('input', {
          class: 'db-search', placeholder: 'Filter…', value: this.search || '',
          oninput: (e) => { this.search = e.target.value; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 200); },
        }),
        this.spec.view === 'board' ? this.groupPicker() : null,
        h('button', { class: 'btn', text: 'Sort', onclick: (e) => this.sortMenu(e.target) }),
        h('button', { class: 'btn btn-primary', text: '+ New', onclick: () => this.newRow() }),
      ]),
    ]);
  }

  groupPicker() {
    const sel = h('select', {
      class: 'db-select',
      onchange: (e) => { this.spec.groupBy = e.target.value; this.save(); this.render(); },
    }, this.keys.map((k) => h('option', { value: k.key, text: 'Group: ' + k.key,
      selected: this.spec.groupBy === k.key })));
    if (!this.spec.groupBy && this.keys.length) this.spec.groupBy = this.keys[0].key;
    return sel;
  }

  sortMenu(anchor) {
    const opts = [{ key: 'title', n: 0 }, { key: 'mtime', n: 0 }, ...this.keys];
    this.app.menu(anchor, opts.map((k) => ({
      label: (this.spec.sort && this.spec.sort.prop === k.key
        ? (this.spec.sort.desc ? '↓ ' : '↑ ') : '  ') + k.key,
      run: () => {
        const same = this.spec.sort && this.spec.sort.prop === k.key;
        this.spec.sort = { prop: k.key, desc: same ? !this.spec.sort.desc : false };
        this.save();
        this.render();
      },
    })));
  }

  async newRow() {
    const folder = this.spec.source.folder ? this.spec.source.folder + '/' : '';
    const props = {};
    if (this.spec.source.tag) props.tags = [this.spec.source.tag];
    for (const f of this.spec.filters) if (f.op === 'is') props[f.prop] = f.value;
    const fm = Object.keys(props).length
      ? '---\n' + Object.entries(props).map(([k, v]) => `${k}: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`).join('\n') + '\n---\n\n'
      : '';
    const note = await window.newEra.note.create(folder + 'Untitled', fm);
    await this.render();
    this.app.openNote(note.path);
  }

  body() {
    if (!this.rows.length) {
      return h('div', { class: 'db-empty' }, [
        h('p', { text: 'No notes match this view.' }),
        h('button', { class: 'btn btn-primary', text: 'Create the first one', onclick: () => this.newRow() }),
      ]);
    }
    if (this.spec.view === 'board') return this.board();
    if (this.spec.view === 'gallery') return this.gallery();
    return this.table();
  }

  // --- table ---------------------------------------------------------------

  table() {
    const cols = this.spec.columns;
    const head = h('div', { class: 'row row-head' }, [
      h('div', { class: 'cell cell-title', text: 'Name' }),
      ...cols.map((c) => h('div', { class: 'cell' }, [
        h('span', { text: c }),
        h('button', { class: 'cell-x', text: '×', title: 'Hide column',
          onclick: () => { this.spec.columns = cols.filter((x) => x !== c); this.save(); this.render(); } }),
      ])),
      h('div', { class: 'cell cell-add' }, [
        h('button', {
          class: 'btn-ghost', text: '+', title: 'Add property',
          onclick: (e) => this.addColumnMenu(e.target),
        }),
      ]),
    ]);

    const rows = this.rows.map((row) => h('div', { class: 'row' }, [
      h('div', { class: 'cell cell-title' }, [
        h('a', { class: 'row-title', text: row.title, onclick: () => this.app.openNote(row.path) }),
        h('span', { class: 'row-open', text: 'open', onclick: () => this.app.openNote(row.path) }),
      ]),
      ...cols.map((c) => this.cell(row, c)),
      h('div', { class: 'cell cell-add' }),
    ]));

    return h('div', { class: 'db-table' }, [head, ...rows,
      h('div', { class: 'row row-foot' }, [
        h('button', { class: 'btn-ghost', text: '+ New', onclick: () => this.newRow() }),
        h('span', { class: 'count', text: `${this.rows.length} notes` }),
      ])]);
  }

  addColumnMenu(anchor) {
    const avail = this.keys.filter((k) => !this.spec.columns.includes(k.key));
    this.app.menu(anchor, [
      ...avail.map((k) => ({
        label: `${k.key}  (${k.n})`,
        run: () => { this.spec.columns.push(k.key); this.save(); this.render(); },
      })),
      { label: '+ New property…', run: async () => {
        const name = await this.app.prompt('Property name');
        if (!name) return;
        this.spec.columns.push(name);
        this.save();
        this.render();
      } },
    ]);
  }

  cell(row, key) {
    const value = row.props[key];
    const el = h('div', { class: 'cell cell-edit', tabindex: '0' });

    if (typeof value === 'boolean') {
      el.append(h('input', { type: 'checkbox', checked: value,
        onchange: (e) => this.patch(row, key, e.target.checked) }));
      return el;
    }

    const show = () => {
      el.replaceChildren();
      if (value === undefined || value === null || value === '') {
        el.append(h('span', { class: 'cell-empty', text: EMPTY }));
      } else if (Array.isArray(value)) {
        for (const v of value) el.append(chip(v));
      } else if (key === 'status' || key === 'Status' || /^(stage|phase|priority|type)$/i.test(key)) {
        el.append(chip(value));
      } else {
        el.append(h('span', { text: display(value) }));
      }
    };

    const edit = async () => {
      const input = h('input', { class: 'cell-input', value: display(value) });
      const list = h('datalist', { id: 'dl-' + key });
      input.setAttribute('list', list.id);
      el.replaceChildren(input, list);
      input.focus();
      input.select();
      const vals = await window.newEra.index.propValues(key, {
        folder: this.spec.source.folder || null, tag: this.spec.source.tag || null,
      });
      for (const v of vals) list.append(h('option', { value: v.value }));
      let closed = false;
      const commit = async (apply) => {
        if (closed) return;
        closed = true;
        if (apply) await this.patch(row, key, coerce(input.value, value));
        this.render();
      };
      input.onblur = () => commit(true);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') commit(true);
        if (e.key === 'Escape') commit(false);
      };
    };

    show();
    el.addEventListener('click', edit);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); edit(); } });
    return el;
  }

  // --- board ---------------------------------------------------------------

  board() {
    const key = this.spec.groupBy || (this.keys[0] && this.keys[0].key);
    if (!key) return h('div', { class: 'db-empty', text: 'No properties to group by yet.' });

    const groups = new Map([[NO_VALUE, []]]);
    for (const row of this.rows) {
      const v = row.props[key];
      const names = Array.isArray(v) ? v : [v];
      const use = names.filter((x) => x !== undefined && x !== null && x !== '');
      for (const name of use.length ? use : [NO_VALUE]) {
        const k = String(name);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(row);
      }
    }
    if (!groups.get(NO_VALUE).length) groups.delete(NO_VALUE);

    const cols = [...groups].map(([name, rows]) => {
      const col = h('div', { class: 'board-col' }, [
        h('div', { class: 'board-head' }, [
          name === NO_VALUE ? h('span', { class: 'chip chip-empty', text: NO_VALUE }) : chip(name),
          h('span', { class: 'count', text: rows.length }),
        ]),
      ]);
      for (const row of rows) col.append(this.card(row, key));
      col.append(h('button', {
        class: 'btn-ghost board-add', text: '+ New',
        onclick: async () => {
          const before = this.spec.filters;
          this.spec.filters = [...before, { prop: key, op: 'is', value: name }];
          await this.newRow();
          this.spec.filters = before;
        },
      }));
      // Drop target: moving a card writes the new value into that note's file.
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('is-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('is-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('is-over');
        const path = e.dataTransfer.getData('text/plain');
        const row = this.rows.find((r) => r.path === path);
        if (!row) return;
        await this.patch(row, key, name === NO_VALUE ? '' : name);
        this.render();
      });
      return col;
    });

    return h('div', { class: 'db-board' }, cols);
  }

  card(row, groupKey) {
    const el = h('div', { class: 'card', draggable: 'true', onclick: () => this.app.openNote(row.path) }, [
      h('div', { class: 'card-title', text: row.title }),
    ]);
    const meta = h('div', { class: 'card-meta' });
    for (const c of this.spec.columns) {
      if (c === groupKey) continue;
      const v = row.props[c];
      if (v === undefined || v === null || v === '') continue;
      for (const one of Array.isArray(v) ? v : [v]) meta.append(chip(one));
    }
    if (meta.children.length) el.append(meta);
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', row.path));
    return el;
  }

  // --- gallery -------------------------------------------------------------

  gallery() {
    return h('div', { class: 'db-gallery' }, this.rows.map((row) => {
      const cover = h('div', { class: 'gcard-cover' });
      const style = coverStyle(coverOf(row.props), (s) => this.app.assetUrl(s));
      if (style) Object.assign(cover.style, style);
      else cover.classList.add('gcard-blank');
      if (row.props.icon) cover.append(h('span', { class: 'gcard-icon', text: row.props.icon }));
      else if (!style) cover.append(h('span', { class: 'gcard-icon', text: '📄' }));

      const el = h('div', { class: 'gcard', onclick: () => this.app.openNote(row.path) }, [
        cover,
        h('div', { class: 'gcard-title', text: row.title }),
      ]);
      const meta = h('div', { class: 'card-meta' });
      for (const c of this.spec.columns) {
        const v = row.props[c];
        if (v === undefined || v === null || v === '') continue;
        for (const one of Array.isArray(v) ? v : [v]) meta.append(chip(one));
      }
      if (meta.children.length) el.append(meta);
      return el;
    }));
  }
}

export { h, chip, display, coerce };
