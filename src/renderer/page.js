// Notion's page chrome: cover banner, page icon, big title.
// Everything lives in frontmatter (`banner`, `icon`), so a note styled here is
// still a plain markdown file that Obsidian will happily open.
import { h } from './dbview.js';
import { GRADIENTS, coverOf, coverStyle } from './cover.js';
import { prettyTitle } from './dates.js';

// Kept in frontmatter but shown elsewhere (the icon, the cover), so not chips.
const SHOWN_ELSEWHERE = new Set(['icon', 'banner', 'cover', 'title']);

export function renderPageHeader(opts) {
  const { path, props, title, app } = opts;
  const banner = coverOf(props);
  const icon = props.icon;

  const set = async (patch) => {
    await window.newEra.note.setProps(path, patch);
    await app.reloadCurrentNote();
  };

  // --- cover ---
  const coverEl = h('div', { class: 'page-cover' + (banner ? '' : ' is-empty') });
  const style = coverStyle(banner, (s) => app.assetUrl(s));
  if (style) Object.assign(coverEl.style, style);

  if (banner) {
    coverEl.append(h('div', { class: 'cover-tools' }, [
      h('button', { class: 'chip-btn', text: '🖼️  Change picture', onclick: (e) => coverMenu(e.target, app, set) }),
      h('button', { class: 'chip-btn', text: 'Remove', onclick: () => set({ banner: undefined, cover: undefined }) }),
    ]));
  }

  // --- icon ---
  const iconEl = icon
    ? h('button', {
      class: 'page-icon', text: icon, title: 'Change icon',
      onclick: (e) => iconMenu(e.target, app, set),
    })
    : null;

  // --- add buttons (Notion shows these on hover when empty) ---
  const adders = h('div', { class: 'page-adders' }, [
    icon ? null : h('button', { class: 'add-btn', text: '😀  Add an icon', onclick: (e) => iconMenu(e.target, app, set) }),
    banner ? null : h('button', { class: 'add-btn', text: '🖼️  Add a cover picture', onclick: (e) => coverMenu(e.target, app, set) }),
  ]);

  const dateStyle = app.settings.values.dateFormat;
  const shown = prettyTitle(title, dateStyle);
  const titleEl = h('input', {
    class: 'page-title', value: shown, spellcheck: 'false', placeholder: 'Untitled',
    // A daily page shows "5th Sep 2026" but keeps its sortable file name
    // unless you actually type a new title.
    onchange: (e) => { if (e.target.value !== shown) app.renameNote(path, e.target.value); },
  });

  return h('header', {
    class: 'page-head' + (banner ? ' has-cover' : '') + (icon ? ' has-icon' : ''),
  }, [
    banner ? coverEl : null,
    h('div', { class: 'page-head-inner' }, [
      iconEl,
      adders,
      titleEl,
      detailChips(props, app, set, dateStyle),
    ]),
  ]);
}

// Details as friendly chips under the title, the way Notion shows properties:
// "Status  Research", tags in colour. Click one to change it.
function detailChips(props, app, set, style) {
  const nice = (k) => k.charAt(0).toUpperCase() + k.slice(1).replace(/[_-]+/g, ' ');
  const chips = [];
  for (const [k, v] of Object.entries(props)) {
    if (SHOWN_ELSEWHERE.has(k) || v === '' || v == null) continue;
    if (k === 'tags' && Array.isArray(v)) {
      for (const tag of v) {
        chips.push(h('button', {
          class: 'tag-chip', text: '#' + tag, title: 'See every page tagged ' + tag,
          style: `--hue:${[...String(tag)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 17)}`,
          onclick: () => app.openDatabase({ name: '#' + tag, source: { tag }, view: 'table' }, true),
        }));
      }
      continue;
    }
    const text = Array.isArray(v) ? v.join(', ') : prettyTitle(String(v), style);
    chips.push(h('button', {
      class: 'detail-chip', title: `Click to change ${nice(k).toLowerCase()}`,
      onclick: async () => {
        const next = await app.prompt(`Change "${nice(k)}" (leave empty to remove it)`, Array.isArray(v) ? v.join(', ') : String(v));
        if (next === null) return;
        const value = !next.trim() ? undefined
          : Array.isArray(v) ? next.split(',').map((s) => s.trim()).filter(Boolean) : next.trim();
        set({ [k]: value });
      },
    }, [h('span', { class: 'detail-key', text: nice(k) }), h('span', { class: 'detail-val', text: text })]));
  }
  chips.push(h('button', {
    class: 'detail-add', text: '+ Add a detail',
    title: 'Things like status, due date or who it is for',
    onclick: async () => {
      const name = await app.prompt('What is it? For example: status, due, author');
      if (!name || !name.trim()) return;
      const value = await app.prompt(`And the ${name.trim()}?`);
      if (value === null) return;
      set({ [name.trim().toLowerCase().replace(/\s+/g, '_')]: value.trim() });
    },
  }));
  return h('div', { class: 'page-details' }, chips);
}

function iconMenu(anchor, app, set) {
  const grid = h('div', { class: 'emoji-grid' });
  const fill = (list) => grid.replaceChildren(...list.map((e) => h('button', {
    class: 'emoji', text: e, onclick: () => { app.closeOverlay(); set({ icon: e }); },
  })));
  fill(EMOJI);

  const search = h('input', {
    class: 'palette-input', placeholder: 'Type or paste any emoji, then Enter',
    oninput: (e) => {
      const q = e.target.value.trim();
      if (!q) return fill(EMOJI);
      return fill(EMOJI.filter((x) => x.includes(q)).concat(q.length <= 4 ? [q] : []));
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      app.closeOverlay();
      set({ icon: [...e.target.value.trim()][0] });
    },
  });

  app.popover(anchor, [
    h('div', { class: 'pop-head' }, [
      h('span', { text: 'Page icon' }),
      h('button', { class: 'btn-ghost', text: 'Remove', onclick: () => { app.closeOverlay(); set({ icon: undefined }); } }),
    ]),
    search,
    grid,
  ]);
}

function coverMenu(anchor, app, set) {
  const swatches = h('div', { class: 'cover-grid' }, Object.entries(GRADIENTS).map(([name, css]) => h('button', {
    class: 'cover-swatch', title: name, style: `background:${css}`,
    onclick: () => { app.closeOverlay(); set({ banner: 'gradient:' + name }); },
  })));

  app.popover(anchor, [
    h('div', { class: 'pop-head' }, [h('span', { text: 'Cover' })]),
    swatches,
    h('input', {
      class: 'palette-input', placeholder: '…or paste an image URL / vault path, then Enter',
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        app.closeOverlay();
        set({ banner: e.target.value.trim() });
      },
    }),
  ]);
}
