// One search box for everything: notes, attachments, tags, bases, tools,
// commands and individual settings. Five sidebar tabs plus a command palette
// meant knowing where to look before you could look; this needs one key.
//
// Typing a scope prefix narrows it, the way editors have taught everyone:
//   >  commands      #  tags       @  files      /  settings      ?  help
import { h } from './dbview.js';
import { label as keyLabel } from './keymap.js';

export const SCOPES = [
  { key: '>', kind: 'command', label: 'Commands' },
  { key: '#', kind: 'tag', label: 'Tags' },
  { key: '@', kind: 'file', label: 'Files and attachments' },
  { key: '/', kind: 'setting', label: 'Settings' },
];

const ORDER = ['note', 'file', 'tag', 'base', 'tool', 'setting', 'command', 'create'];
const GROUP = {
  note: 'Notes',
  file: 'Files',
  tag: 'Tags',
  base: 'Bases',
  tool: 'Tools and views',
  setting: 'Settings',
  command: 'Commands',
  create: 'Create',
};
const ICON = {
  note: '▤', file: '▣', tag: '#', base: '▦',
  tool: '◍', setting: '⚙', command: '⌘', create: '+',
};

// Substring beats subsequence, word-start beats mid-word, title beats path.
// Good enough to feel instant and predictable; no fuzzy-match library.
export function score(query, text, weight = 1) {
  if (!query) return 0.001;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 100 * weight;
  if (at > 0) return (/[\s/\-_]/.test(t[at - 1]) ? 80 : 55) * weight;

  let i = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const next = t.indexOf(ch, i);
    if (next < 0) return 0;
    if (last >= 0 && next > last + 1) gaps++;
    last = next;
    i = next + 1;
  }
  return Math.max(4, (30 - gaps * 2)) * weight;
}

export class Omni {
  constructor(app) {
    this.app = app;
    this.recent = [];
  }

  remember(entry) {
    if (!entry || entry.kind === 'create') return;
    this.recent = [entry, ...this.recent.filter((r) => r.id !== entry.id)].slice(0, 8);
  }

  // Everything searchable, built fresh each open so it never goes stale.
  async entries() {
    const app = this.app;
    const out = [];

    for (const n of app.notes || []) {
      out.push({
        kind: 'note', id: 'note:' + n.path, label: n.title, hint: n.folder || 'vault root',
        run: () => app.openNote(n.path),
      });
    }

    for (const a of app.assets || []) {
      out.push({
        kind: 'file', id: 'file:' + a.path, label: a.name,
        hint: `${a.folder || 'vault root'} · ${a.ext || 'file'}`,
        run: () => app.openAsset(a),
      });
    }

    for (const t of await app.tagList()) {
      out.push({
        kind: 'tag', id: 'tag:' + t.tag, label: '#' + t.tag, hint: `${t.n} notes`,
        run: () => app.openDatabase({ name: '#' + t.tag, source: { tag: t.tag }, view: 'table' }, true),
      });
    }

    for (const v of app.views || []) {
      out.push({
        kind: 'base', id: 'base:' + v.id, label: v.name, hint: v.source?.folder || 'saved base',
        run: () => app.openDatabase(v),
      });
    }

    out.push({
      kind: 'tool', id: 'tool:graph', label: 'Graph', hint: 'the whole vault',
      run: () => app.openGraph('global'),
    });
    for (const [id, v] of app.plugins.views) {
      out.push({
        kind: 'tool', id: 'tool:' + id, label: v.name, hint: v.plugin,
        run: () => app.openPluginView(id),
      });
    }

    for (const s of app.settings.index()) {
      out.push({
        kind: 'setting', id: 'set:' + s.key, label: s.label,
        hint: s.hint || GROUP.setting, keywords: s.keywords,
        run: () => app.openSettings(s.tab, s.key),
      });
    }

    for (const c of [...app.builtins(), ...app.plugins.allCommands()]) {
      out.push({
        kind: 'command', id: 'cmd:' + c.id, label: c.name, hint: c.id,
        key: app.keymap.keys[c.id], run: c.run,
      });
    }

    return out;
  }

  open(prefix = '') {
    const app = this.app;
    app.closeOverlay();

    const list = h('div', { class: 'palette-list' });
    let all = [];
    let shown = [];
    let sel = 0;

    const input = h('input', {
      class: 'palette-input', value: prefix,
      placeholder: 'Search notes, files, tags, settings…    >commands  #tags  @files  /settings',
    });

    const scopeBar = h('div', { class: 'omni-scopes' }, SCOPES.map((sc) => h('button', {
      class: 'omni-scope', text: sc.key + ' ' + sc.label,
      onmousedown: (e) => {
        e.preventDefault();
        input.value = sc.key;
        input.focus();
        draw();
      },
    })));

    const draw = () => {
      const raw = input.value;
      const scope = SCOPES.find((sc) => raw.startsWith(sc.key));
      const q = (scope ? raw.slice(scope.key.length) : raw).trim();
      const pool = scope ? all.filter((e) => e.kind === scope.kind) : all;

      if (!q) {
        shown = scope ? pool.slice(0, 60)
          : [...this.recent, ...pool.filter((e) => !this.recent.some((r) => r.id === e.id))].slice(0, 40);
      } else {
        const hits = pool
          .map((e) => ({
            e,
            s: Math.max(
              score(q, e.label, 1.25),
              score(q, e.hint || '', 0.5),
              score(q, (e.keywords || []).join(' '), 0.7),
            ),
          }))
          .filter((x) => x.s > 0);

        // Order the groups by their best hit, then the rows inside each group.
        // Sorting purely by score interleaves the kinds and repeats headings.
        const best = new Map();
        for (const x of hits) best.set(x.e.kind, Math.max(best.get(x.e.kind) || 0, x.s));
        hits.sort((a, b) => (best.get(b.e.kind) - best.get(a.e.kind))
          || (ORDER.indexOf(a.e.kind) - ORDER.indexOf(b.e.kind))
          || (b.s - a.s));
        shown = hits.slice(0, 60).map((x) => x.e);
        const strong = hits.some((x) => x.s >= 55);

        // Offer to create only when nothing really matched - otherwise it sits
        // under every search as noise.
        if (!strong && q.length > 1 && !scope) {
          shown.push({
            kind: 'create', id: 'create:' + q, label: `Create note "${q}"`, hint: 'new note',
            run: async () => {
              const note = await window.newEra.note.create(q, `# ${q}\n\n`);
              await app.refresh();
              app.openNote(note.path);
            },
          });
        }
      }
      sel = 0;
      paint();
    };

    const paint = () => {
      if (!shown.length) {
        list.replaceChildren(h('div', { class: 'omni-empty' }, [
          h('div', { text: 'Nothing here yet.' }),
          h('div', {
            class: 'hint',
            text: 'Tags come from #tags in your notes. Files appear once you paste or drop one into a note.',
          }),
        ]));
        return;
      }
      const rows = [];
      let group = null;
      shown.forEach((e, n) => {
        if (e.kind !== group) {
          group = e.kind;
          rows.push(h('div', { class: 'omni-group', text: GROUP[e.kind] || e.kind }));
        }
        rows.push(h('div', {
          class: 'palette-row' + (n === sel ? ' is-sel' : ''),
          onmousedown: (ev) => { ev.preventDefault(); choose(e); },
        }, [
          h('span', { class: 'omni-ico', text: ICON[e.kind] || '▪' }),
          h('span', { class: 'omni-label', text: e.label }),
          e.key ? h('span', { class: 'omni-key', text: keyLabel(e.key) }) : null,
          h('span', { class: 'hint', text: e.hint || '' }),
        ]));
      });
      list.replaceChildren(...rows);
      const active = list.querySelector('.is-sel');
      if (active) active.scrollIntoView({ block: 'nearest' });
    };

    const choose = (e) => {
      this.remember(e);
      app.closeOverlay();
      e.run();
    };

    input.oninput = draw;
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); paint(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
      if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); choose(shown[sel]); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const i = SCOPES.findIndex((sc) => input.value.startsWith(sc.key));
        input.value = SCOPES[(i + 1) % SCOPES.length].key;
        draw();
      }
    };

    const overlay = h('div', {
      class: 'overlay', onclick: (e) => { if (e.target === overlay) app.closeOverlay(); },
    }, [h('div', { class: 'palette omni' }, [input, scopeBar, list])]);
    document.body.append(overlay);
    input.focus();
    input.select();

    this.entries().then((e) => { all = e; draw(); });
    draw();
  }
}
