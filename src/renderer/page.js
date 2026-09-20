// Notion's page chrome: cover banner, page icon, big title.
// Everything lives in frontmatter (`banner`, `icon`), so a note styled here is
// still a plain markdown file that Obsidian will happily open.
import { h } from './dbview.js';
import { GRADIENTS, coverOf, coverStyle } from './cover.js';

export function renderPageHeader(opts) {
  const { path, props, title, app } = opts;
  const banner = coverOf(props);
  const icon = props.icon;

  const set = async (patch) => {
    await window.hermes.note.setProps(path, patch);
    await app.reloadCurrentNote();
  };

  // --- cover ---
  const coverEl = h('div', { class: 'page-cover' + (banner ? '' : ' is-empty') });
  const style = coverStyle(banner, (s) => app.assetUrl(s));
  if (style) Object.assign(coverEl.style, style);

  if (banner) {
    coverEl.append(h('div', { class: 'cover-tools' }, [
      h('button', { class: 'chip-btn', text: 'Change cover', onclick: (e) => coverMenu(e.target, app, set) }),
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
    icon ? null : h('button', { class: 'add-btn', text: '🙂  Add icon', onclick: (e) => iconMenu(e.target, app, set) }),
    banner ? null : h('button', { class: 'add-btn', text: '🖼  Add cover', onclick: (e) => coverMenu(e.target, app, set) }),
  ]);

  const titleEl = h('input', {
    class: 'page-title', value: title, spellcheck: 'false', placeholder: 'Untitled',
    onchange: (e) => app.renameNote(path, e.target.value),
  });

  return h('header', {
    class: 'page-head' + (banner ? ' has-cover' : '') + (icon ? ' has-icon' : ''),
  }, [
    banner ? coverEl : null,
    h('div', { class: 'page-head-inner' }, [
      iconEl,
      adders,
      titleEl,
      h('div', { class: 'page-crumb', text: path }),
    ]),
  ]);
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
