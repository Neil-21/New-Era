# Hermes

Obsidian's editing model and Notion's databases in one app, over the same files.

- **Your notes are plain markdown** in a folder you own. Wikilinks, frontmatter, tasks, live preview.
- **Your databases are queries** over those files. A property is a frontmatter key. Editing a table cell or dragging a board card rewrites the `.md` file.
- **SQLite is an index, not the truth.** Delete `.hermes/index.db` and it rebuilds from the files.
- **Pages look like Notion pages.** Cover banners, page icons, callouts, web embeds, a `/` block menu.
- **A graph of the whole vault**, or just the note you are on.
- **Files live in the vault.** Paste or drop an image, video, PDF or spreadsheet and it is
  saved next to the note, indexed, and findable.
- **Plugins are ours.** Kanban, tasks, outline, templates, random note - all written here, none ported.
  No community store, no Obsidian or Logseq plugin API.

## Run

```bash
npm install && npm start -- ./demo-vault
```

`npm start` alone reopens your last vault, or shows the vault picker.

Every shortcut below is rebindable in **Settings → Keybindings**.

| | |
|---|---|
| `Ctrl+O` | quick switcher |
| `Ctrl+P` | command palette |
| `Ctrl+N` | new note |
| `Ctrl+Shift+N` | new database base |
| `Ctrl+Shift+F` | search |
| `Ctrl+Shift+D` | today's daily note |
| `Ctrl+,` | appearance settings |
| `Ctrl+B` | toggle sidebar |
| `Ctrl+G` | graph view (`Ctrl+Shift+G` for this note only) |
| `Ctrl+W` / `Ctrl+Tab` | close / cycle tabs |
| `Ctrl+Shift+H` | highlight the selection |
| `/` | block menu, in the editor |

## How it fits together

```
main process                    renderer
  db.js      SQLite index   <--  app.js       shell, tabs, palette
  parse.js   md + frontmatter    editor.js    CodeMirror 6 live preview
  main.js    IPC, file watch     dbview.js    table / board / gallery
                                 page.js      cover, icon, title
                                 graph.js     force-directed graph, canvas
                                 cover.js     gradients, cover resolution
                                 settings.js  appearance, editor, keys, plugins
                                 keymap.js    rebindable shortcuts
  sheet.js   xlsx / csv reader
                                 plugins.js   plugin host
```

The vault is the database. `src/db.js` walks `*.md`, parses frontmatter into a
JSON column, and indexes links and full text (FTS5). Queries filter on
`json_extract(props, '$.status')`, so a Notion-style view is one SQL statement.
A file watcher reindexes on change, including edits made in Obsidian or vim.

Writes go the other way through `setFrontmatter()`, which edits only the keys
you changed and leaves every other byte of the file alone.

**No native modules.** SQLite is `node:sqlite`, built into Electron's Node.
Nothing to compile, nothing to rebuild per platform.

## Writing

Live preview keeps the markdown in the file and hides the syntax unless your
cursor is on that line. Headings get size, not underlines. `[[Wikilinks]]` are
chips, red when the note does not exist yet (click to create it).

Press `/` on an empty line for headings, to-dos, callouts, code, tables,
dividers, wikilinks, images and embeds.

**Covers and icons** are frontmatter, not app state:

```yaml
---
icon: 🛰
banner: gradient:neon      # or a vault path, or an https:// image
---
```

Eight built-in gradients (`sunset`, `dusk`, `mint`, `ember`, `ocean`, `neon`,
`slate`, `sand`), or paste any image URL. Icons show on the page and on gallery
cards.

`==highlight==` marks text in the colour you pick in settings.

**Callouts** use Obsidian's syntax, so they survive the round trip:

```markdown
> [!warning] Calibration drifts
> Re-measure before every capture session.
```

**Embeds**: put a URL alone on a line. YouTube, Vimeo, Spotify, Figma, CodePen,
Loom and Google Docs become live iframes; everything else becomes a link card,
because most sites refuse to be framed. `!(url)` forces an iframe anyway.

## Files and attachments

Paste or drop anything into a note and it is written into the vault, never
left in a temp folder that gets cleaned up later. By default it lands in an
`attachments/` folder beside the note, so a project folder stays
self-contained; **Settings → Editor** switches that to the note's own folder
or one folder at the vault root.

Attachments are indexed like notes, so `![[photo.png]]` resolves by filename
from anywhere in the vault and keeps working after you move the file. Images,
video and audio play inline. Everything else gets a link.

The **Files** tab in the sidebar lists every non-markdown file, filtered by
kind (image, video, audio, doc, data, code), with search. Right-click one to
copy its embed, insert it into the open note, reveal it, or trash it. The sort
menu in the Notes tab can also show attachments inline in the tree.

## Graph

`Ctrl+G` for the whole vault, `Ctrl+Shift+G` for the note you are on and its
direct links. Node size is link count, colour is folder, dashed outline means a
`[[link]]` to a note you have not written yet. Drag nodes, drag the background
to pan, scroll to zoom, click to open. The `tags` toggle folds `#tags` in as
nodes of their own.

It is canvas plus a ~40 line force simulation - no graph library.

## Files and folders

Folders sort above notes and carry a note count. Drag a note onto a folder to
move it on disk; links keep resolving because they match on basename. Right
click a folder for *new note here*, *open as table*, *rename*, *collapse all*.
The sort button offers A→Z, Z→A and recently edited.

## Settings

`Ctrl+,`, or the gear at the bottom of the sidebar next to the vault switcher.

- **Appearance** — theme (dark / midnight / light), accent, highlight colour,
  font, text size, line height, line width, cover height, sidebar width. Each
  one is a CSS custom property, so a change applies without a re-render and the
  native window buttons repaint to match.
- **Editor** — where new notes and daily notes go.
- **Keybindings** — click a shortcut, press the keys you want. Taking a combo
  frees it from whatever held it before, so you cannot end up with two commands
  on one chord.
- **Plugins** — enable or disable, with what each one registers.

All of it in `<vault>/.hermes/settings.json`.

The window uses a hidden title bar with a native overlay: we draw the header,
the OS keeps the window buttons, snap layouts and rounded corners.

## Databases

A base is a saved query, stored in `<vault>/.hermes/views.json` so it travels
with your notes and diffs in git:

```json
{
  "name": "Projects",
  "view": "board",
  "source": { "folder": "Projects" },
  "groupBy": "stage",
  "columns": ["status", "owner", "stage", "tags"],
  "filters": [{ "prop": "status", "op": "is", "value": "Active" }]
}
```

Filter ops: `is`, `is-not`, `contains`, `gt`, `lt`, `empty`, `not-empty`.
Sources: a folder, a tag, or the whole vault. Any folder or tag can be opened
as a throwaway table from the sidebar without saving a base.

## Plugins

Six ship in the box, all written for this app - nothing ported from another
editor's plugin API, so there is no compatibility shim to go wrong. Toggle any
of them in **Settings → Plugins**.

| Plugin | What it does |
|---|---|
| **Kanban** | A note's `## headings` become columns and its list items become cards. Dragging a card rewrites the markdown, and dropping into *Done* ticks the box. |
| **Tasks** | Every `- [ ]` in the vault, grouped by note or by date. Ticking one rewrites that line in its own file. Ignores `Templates/` by default. |
| **Outline** | The current note's headings in the right panel; click to jump. |
| **Templates** | Insert a note from `Templates/` at the cursor, filling `{{date}}`, `{{date:+1}}`, `{{time}}`, `{{title}}`, `{{path}}`. |
| **Data viewer** | Opens `.json`, `.csv`, `.tsv` and `.xlsx` from the vault — spreadsheets as sortable tables with a sheet switcher and *copy as markdown*, JSON as a collapsible tree. Legacy `.xls` files open externally; re-save them as `.xlsx` to preview them safely in Hermes. |
| **Export** | The open note to PDF or standalone HTML, with its cover, properties, callouts, tables and images. PDF goes through Chromium's own print engine. |
| **Random note** | Opens one. Good for rediscovering what you wrote. |
| **Word count** | Words and reading time for the open note. |

Drop your own folder in `plugins/` or `<vault>/.hermes/plugins/`. See
[plugins/word-count](plugins/word-count/main.js) for the smallest one and
[plugins/kanban](plugins/kanban/main.js) for a full view.

```js
export default {
  onload(api) {
    api.addCommand({ id: 'hi', name: 'Say hi', run: () => api.notice('hi') });
    api.addRibbon({ icon: '#', title: 'Say hi', run: () => api.notice('hi') });
    api.on('note:open', ({ path }) => console.log(path));
  },
};
```

`api` gives you:

- `addCommand` / `addRibbon` — palette entries and sidebar buttons
- `addView` — a full pane, opened from the palette or a ribbon button
- `addRailPanel` — a panel in the right rail, re-mounted on every note open
- `on('note:open' | 'vault:changed')`
- `settings.get()` / `settings.set()` — persisted per plugin
- `h(tag, attrs, kids)` — DOM without shipping your own helper
- `app` — `openNote`, `openViewById`, `openGraph`, `currentNote`, `editor`, `prompt`, `menu`, `toast`
- `vault` — the whole note/index IPC surface, including `asset.save/list/open`,
  `file.read` (parsed sheets and JSON) and `exporter.pdf/save`

Plugins are local files you put there; they run with the renderer's
privileges, the same trust model as Obsidian's.

## Tests

```bash
npm test
```

Covers frontmatter round-tripping, link parsing, indexing, query filters, SQL
injection through filter values, the kanban card mover, template tokens, the
markdown-to-HTML renderer (including escaping), and the xlsx reader — which is
tested against a zip this suite builds byte by byte, stored and deflated
members included.

## Not built yet

Inline PDF preview, per-view column widths, relation and rollup properties,
drag-to-reorder columns, sync. Legacy `.xls` is a different binary format and
is not read; re-save it as `.xlsx`. The index and the view spec both have room for
them; nothing here needs reworking first.

## Why not a Logseq fork

The plan was to build on `logseq/logseq`. Two reasons it isn't:

1. Logseq is an **outliner** — every line is a block in a block tree. Obsidian's
   model is a **document**. Converting one into the other means replacing the
   data model, the editor and the renderer, which is most of the app.
2. It is ~500k lines of ClojureScript with its own build toolchain.

What you see above is ~5,100 lines of JavaScript. Runtime dependencies:
CodeMirror. Build dependencies: Electron and esbuild. That is the whole list.
The clone under `logseq/` is reference material only - nothing imports from it.
Logseq's good ideas are here anyway: a queryable index over plain files, and
properties as first-class data.
