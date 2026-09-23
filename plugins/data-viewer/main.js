// Read JSON, CSV, TSV and XLSX files that live in the vault.
// The main process does the parsing (zip, XML, quoting); this is just the view.

function fmt(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export default {
  onload(api) {
    const { h } = api;

    // --- JSON tree ---------------------------------------------------------
    function jsonNode(key, value, depth) {
      const leaf = value === null || typeof value !== 'object';
      if (leaf) {
        return h('div', { class: 'jrow', style: `--d:${depth}` }, [
          key !== null ? h('span', { class: 'jkey', text: key + ':' }) : null,
          h('span', { class: 'jval j-' + (value === null ? 'null' : typeof value), text: fmt(value) }),
        ]);
      }
      const arr = Array.isArray(value);
      const entries = arr ? value.map((v, i) => [i, v]) : Object.entries(value);
      const wrap = h('div', {});
      let open = depth < 2;

      const head = h('div', { class: 'jrow jrow-head', style: `--d:${depth}` }, [
        h('span', { class: 'jtwist', text: open ? '▾' : '▸' }),
        key !== null ? h('span', { class: 'jkey', text: key + ':' }) : null,
        h('span', { class: 'jmeta', text: (arr ? '[' : '{') + entries.length + (arr ? ']' : '}') }),
      ]);
      const kids = h('div', {});
      const paint = () => {
        head.firstChild.textContent = open ? '▾' : '▸';
        kids.style.display = open ? '' : 'none';
        if (open && !kids.childElementCount) {
          for (const [k, v] of entries) kids.append(jsonNode(String(k), v, depth + 1));
        }
      };
      head.onclick = () => { open = !open; paint(); };
      wrap.append(head, kids);
      paint();
      return wrap;
    }

    // --- sheet table -------------------------------------------------------
    function sheetTable(sheet, filter) {
      const rows = sheet.rows || [];
      if (!rows.length) return h('div', { class: 'db-empty', text: 'This sheet is empty.' });
      const [head, ...body] = rows;
      const shown = filter
        ? body.filter((r) => r.some((c) => String(c).toLowerCase().includes(filter.toLowerCase())))
        : body;

      return h('div', { class: 'db-table sheet' }, [
        h('div', { class: 'row row-head' }, [
          h('div', { class: 'cell cell-num', text: '' }),
          ...head.map((c) => h('div', { class: 'cell', text: fmt(c) })),
        ]),
        ...shown.slice(0, 2000).map((r, i) => h('div', { class: 'row' }, [
          h('div', { class: 'cell cell-num', text: i + 1 }),
          ...head.map((_, ci) => h('div', {
            class: 'cell' + (typeof r[ci] === 'number' ? ' is-num' : ''),
            text: fmt(r[ci]),
          })),
        ])),
        h('div', { class: 'row row-foot' }, [
          h('span', { class: 'count', text: `${shown.length} of ${body.length} rows` }),
        ]),
      ]);
    }

    function toMarkdown(sheet) {
      const rows = sheet.rows || [];
      if (!rows.length) return '';
      const [head, ...body] = rows;
      const cell = (c) => fmt(c).replace(/\|/g, '\\|');
      return [
        '| ' + head.map(cell).join(' | ') + ' |',
        '| ' + head.map(() => '---').join(' | ') + ' |',
        ...body.map((r) => '| ' + head.map((_, i) => cell(r[i])).join(' | ') + ' |'),
      ].join('\n');
    }

    const mount = async (el, ctx) => {
      const path = ctx.app.dataFile;
      if (!path) {
        el.replaceChildren(h('div', { class: 'db-empty' }, [
          h('p', { text: 'Pick a file from the Files tab in the sidebar.' }),
        ]));
        return;
      }

      let data;
      try {
        data = await api.vault.file.read(path);
      } catch (err) {
        el.replaceChildren(h('div', { class: 'db-empty', text: err.message }));
        return;
      }

      let sheetAt = 0;
      let filter = '';
      const body = h('div', { class: 'data-body' });

      const draw = () => {
        if (data.kind === 'sheets') body.replaceChildren(sheetTable(data.sheets[sheetAt], filter));
        else if (data.kind === 'json') {
          body.replaceChildren(h('div', { class: 'json-tree' }, [jsonNode(null, data.value, 0)]));
        } else {
          body.replaceChildren(h('pre', { class: 'data-text', text: data.text }));
        }
      };

      el.replaceChildren(
        h('div', { class: 'db-toolbar' }, [
          h('div', { class: 'db-title' }, [
            h('span', { class: 'db-icon', text: data.kind === 'json' ? '☷' : '▦' }),
            h('span', { class: 'db-name-static', text: path.split('/').pop() }),
            h('span', { class: 'db-source', text: path }),
          ]),
          data.kind === 'sheets' && data.sheets.length > 1
            ? h('div', { class: 'db-tabs' }, data.sheets.map((s, i) => h('button', {
              class: 'db-tab' + (i === sheetAt ? ' is-active' : ''), text: s.name,
              onclick: (e) => {
                sheetAt = i;
                [...e.target.parentNode.children].forEach((b) => b.classList.toggle('is-active', b === e.target));
                draw();
              },
            })))
            : null,
          h('div', { class: 'db-actions' }, [
            data.kind === 'sheets' ? h('input', {
              class: 'db-search', placeholder: 'Filter rows…',
              oninput: (e) => { filter = e.target.value; draw(); },
            }) : null,
            data.kind === 'sheets' ? h('button', {
              class: 'btn', text: 'Copy as markdown',
              onclick: async () => {
                await navigator.clipboard.writeText(toMarkdown(data.sheets[sheetAt]));
                api.notice('Table copied - paste it into a note');
              },
            }) : null,
            h('button', { class: 'btn', text: 'Open externally', onclick: () => api.vault.asset.open(path) }),
          ]),
        ]),
        body,
      );
      draw();
    };

    api.addView({ id: 'file', name: 'Data viewer', mount });
    api.addRibbon({
      icon: '☷', title: 'Data files',
      run: () => { api.app.openSidebarTab('media'); },
    });
  },
};
