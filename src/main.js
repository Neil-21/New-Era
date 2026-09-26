'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Index } = require('./db.js');
const { parseFrontmatter, setFrontmatter } = require('./parse.js');
const { readXlsx, readDelimited } = require('./sheet.js');

const CONFIG = path.join(app.getPath('userData'), 'config.json');

let win = null;
let ix = null;       // Index for the open vault
let watcher = null;
let selfWrites = new Set(); // paths we just wrote, so the watcher ignores the echo

// --- link previews -----------------------------------------------------------
// A link on its own line shows as a card with the page's title, blurb and
// picture. Fetched here, not in the page, so any site works regardless of CORS.

const previews = new Map();

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function metaTag(html, name) {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'));
  const content = tag && tag[0].match(/content=["']([^"']*)["']/i);
  return content ? decodeEntities(content[1]) : '';
}

async function linkPreview(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Not a web link: ' + url);
  if (previews.has(url)) return previews.get(url);
  const res = await net.fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; NewEra link preview)', accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(8000),
  });
  const type = res.headers.get('content-type') || '';
  // Electron's net.fetch can leave res.url empty; fall back to what we asked for.
  const base = res.url || url;
  const out = { url: base };
  if (type.startsWith('image/')) {
    out.image = base;
  } else if (type.includes('html')) {
    // ponytail: regex over the first 400 kB, not an HTML parser. Meta tags live
    // in <head>, and a parser would be a dependency for four fields.
    const html = (await res.text()).slice(0, 400000);
    const title = html.match(/<title[^>]*>([^<]*)</i);
    out.title = metaTag(html, 'og:title') || metaTag(html, 'twitter:title') || decodeEntities(title && title[1]);
    out.description = metaTag(html, 'og:description') || metaTag(html, 'description');
    out.site = metaTag(html, 'og:site_name');
    const image = metaTag(html, 'og:image') || metaTag(html, 'twitter:image');
    if (image) {
      try { out.image = new URL(image, base).href; } catch { /* bad URL, no picture */ }
    }
  }
  previews.set(url, out);
  return out;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return next;
}

// --- vault -----------------------------------------------------------------

function openVault(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (watcher) { watcher.close(); watcher = null; }
  if (ix) ix.close();
  ix = new Index(dir);
  const stats = ix.sync();
  writeConfig({ vault: dir, recent: [dir, ...(readConfig().recent || []).filter((r) => r !== dir)].slice(0, 8) });
  watch(dir);
  return { vault: dir, ...stats, ...ix.stats() };
}

// ponytail: fs.watch({recursive}) is native on Windows and macOS. On Linux it
// is not - fall back to a 5s poll there rather than pulling in chokidar.
function watch(dir) {
  const dirty = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    const paths = [...dirty].filter((p) => !selfWrites.has(p));
    dirty.clear();
    selfWrites.clear();
    if (!ix) return;
    const stats = ix.sync();
    if (win && (paths.length || stats.changed || stats.removed)) {
      win.webContents.send('vault:changed', { paths, ...stats });
    }
  };
  const bump = (rel) => {
    if (rel) dirty.add(rel.split(path.sep).join('/'));
    if (!timer) timer = setTimeout(flush, 250);
  };
  try {
    watcher = fs.watch(dir, { recursive: true }, (_e, file) => {
      if (file && file.toLowerCase().endsWith('.md')) bump(file);
    });
  } catch {
    const id = setInterval(() => bump(null), 5000);
    watcher = { close: () => clearInterval(id) };
  }
}

function requireVault() {
  if (!ix) throw new Error('No vault is open');
  return ix;
}

// Keep every path inside the vault - a note path arriving over IPC is input.
function safe(rel) {
  const v = requireVault().vault;
  const abs = path.resolve(v, rel);
  if (abs !== v && !abs.startsWith(v + path.sep)) throw new Error('Path escapes vault: ' + rel);
  return abs;
}

function writeNote(rel, content) {
  const abs = safe(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  selfWrites.add(rel);
  return ix.upsert(rel);
}

// --- ipc -------------------------------------------------------------------

const api = {
  'vault:current': () => (ix ? { vault: ix.vault, ...ix.stats() } : { vault: null }),
  'vault:recent': () => readConfig().recent || [],
  'vault:open': (_e, dir) => openVault(dir),
  'vault:pick': async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a vault folder', properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : openVault(r.filePaths[0]);
  },
  'vault:reveal': (_e, rel) => shell.showItemInFolder(safe(rel)),

  'note:read': (_e, rel) => {
    const abs = safe(rel);
    const raw = fs.readFileSync(abs, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return { path: rel, raw, body, props: data, mtime: Math.floor(fs.statSync(abs).mtimeMs) };
  },
  'note:write': (_e, rel, content) => writeNote(rel, content),
  'note:create': (_e, rel, content) => {
    let target = rel.endsWith('.md') ? rel : rel + '.md';
    let n = 1;
    while (fs.existsSync(safe(target))) target = rel.replace(/\.md$/, '') + ` ${++n}.md`;
    return writeNote(target, content ?? `# ${path.basename(target, '.md')}\n\n`);
  },
  'note:setProps': (_e, rel, patch) => {
    const raw = fs.readFileSync(safe(rel), 'utf8');
    return writeNote(rel, setFrontmatter(raw, patch));
  },
  'note:rename': (_e, rel, nextRel) => {
    const to = nextRel.endsWith('.md') ? nextRel : nextRel + '.md';
    const abs = safe(rel);
    const dst = safe(to);
    if (fs.existsSync(dst)) throw new Error('A note already exists at ' + to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(abs, dst);
    selfWrites.add(rel);
    selfWrites.add(to);
    ix.remove(rel);
    ix.upsert(to);
    ix.resolveLinks();
    return { path: to };
  },
  'folder:create': (_e, rel) => {
    const abs = safe(rel);
    fs.mkdirSync(abs, { recursive: true });
    return { folder: rel };
  },
  // Moving a note is a rename into another folder; the index resolves links by
  // basename, so nothing breaks as long as the name survives.
  'folder:rename': (_e, rel, nextRel) => {
    const abs = safe(rel);
    const dst = safe(nextRel);
    if (fs.existsSync(dst)) throw new Error('A folder already exists at ' + nextRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(abs, dst);
    ix.sync();
    return { folder: nextRel };
  },

  // Trash, never unlink: a notes app must not be able to destroy your writing.
  'note:trash': async (_e, rel) => {
    await shell.trashItem(safe(rel));
    ix.remove(rel);
    return { path: rel };
  },

  // --- attachments --------------------------------------------------------
  // Files land in the vault next to the notes that use them, so a vault stays
  // one self-contained folder you can zip up or put in git.
  'asset:save': (_e, folder, name, bytes) => {
    const clean = String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '');
    const dir = safe(folder || '');
    fs.mkdirSync(dir, { recursive: true });
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : '';
    let final = clean;
    let n = 1;
    while (fs.existsSync(path.join(dir, final))) final = `${stem}-${++n}${ext}`;
    fs.writeFileSync(path.join(dir, final), Buffer.from(bytes));
    const rel = (folder ? folder + '/' : '') + final;
    ix.sync();
    return { path: rel, name: final };
  },
  'asset:list': (_e, opts) => requireVault().assets(opts),
  'asset:kinds': () => requireVault().assetKinds(),
  'asset:resolve': (_e, name) => requireVault().resolveAsset(name),
  'asset:open': (_e, rel) => shell.openPath(safe(rel)),
  'asset:trash': async (_e, rel) => {
    await shell.trashItem(safe(rel));
    ix.sync();
    return { path: rel };
  },

  // Read a data file for the viewer plugin. Returns rows for anything tabular
  // so the renderer never has to know about zip or XML.
  'file:read': (_e, rel) => {
    const abs = safe(rel);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const size = fs.statSync(abs).size;
    if (size > 40 * 1024 * 1024) throw new Error('File is too large to preview (40MB limit)');
    if (ext === 'xlsx') return { kind: 'sheets', sheets: readXlsx(fs.readFileSync(abs)), size };
    if (ext === 'csv' || ext === 'tsv') {
      return { kind: 'sheets', size, sheets: [{ name: path.basename(abs), rows: readDelimited(fs.readFileSync(abs, 'utf8')) }] };
    }
    if (ext === 'json') {
      const text = fs.readFileSync(abs, 'utf8');
      try { return { kind: 'json', value: JSON.parse(text), size }; }
      catch (err) { return { kind: 'text', text, size, error: err.message }; }
    }
    if (ext === 'xls') throw new Error('Legacy .xls files open in your system spreadsheet app. Re-save as .xlsx to preview them safely here.');
    return { kind: 'text', text: fs.readFileSync(abs, 'utf8').slice(0, 400000), size };
  },

  // --- export ---------------------------------------------------------------
  // Chromium already has a good PDF engine; printToPDF drives the same one.
  'export:pdf': async (_e, html, suggested) => {
    const out = await dialog.showSaveDialog(win, {
      title: 'Export PDF', defaultPath: suggested, filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (out.canceled) return null;
    const tmpDir = path.join(app.getPath('temp'), 'new-era-export');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `p${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      await printer.loadFile(tmp);
      const pdf = await printer.webContents.printToPDF({
        printBackground: true, pageSize: 'A4',
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      });
      fs.writeFileSync(out.filePath, pdf);
    } finally {
      printer.destroy();
      try { fs.rmSync(tmp); } catch { /* temp file already gone */ }
    }
    return { path: out.filePath };
  },
  'export:save': async (_e, text, suggested, ext) => {
    const out = await dialog.showSaveDialog(win, {
      title: 'Export', defaultPath: suggested, filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (out.canceled) return null;
    fs.writeFileSync(out.filePath, text, 'utf8');
    return { path: out.filePath };
  },
  'shell:show': (_e, abs) => shell.showItemInFolder(abs),

  'index:query': (_e, spec) => requireVault().query(spec),
  'index:search': (_e, q, limit) => requireVault().search(q, limit),
  'index:propKeys': (_e, spec) => requireVault().propKeys(spec),
  'index:propValues': (_e, prop, spec) => requireVault().propValues(prop, spec),
  'index:backlinks': (_e, rel) => requireVault().backlinks(rel),
  'index:outlinks': (_e, rel) => requireVault().outlinks(rel),
  'index:tags': () => requireVault().tags(),
  'index:folders': () => requireVault().folders(),
  'index:all': () => requireVault().all(),
  'index:note': (_e, rel) => requireVault().note(rel),
  'index:stats': () => requireVault().stats(),
  'index:graph': (_e, opts) => requireVault().graph(opts),
  'index:resync': () => ({ ...requireVault().sync(), ...ix.stats() }),

  // Saved database views live in the vault as plain JSON, so they travel with
  // the notes and diff in git like everything else.
  'views:list': () => {
    try { return JSON.parse(fs.readFileSync(path.join(requireVault().vault, '.new-era', 'views.json'), 'utf8')); }
    catch { return []; }
  },
  'views:save': (_e, views) => {
    const f = path.join(requireVault().vault, '.new-era', 'views.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(views, null, 2));
    return views;
  },

  // Appearance settings live next to the views, per vault.
  'settings:get': () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(requireVault().vault, '.new-era', 'settings.json'), 'utf8'));
    } catch { return {}; }
  },
  'settings:save': (_e, values) => {
    const f = path.join(requireVault().vault, '.new-era', 'settings.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(values, null, 2));
    return values;
  },

  'web:preview': (_e, url) => linkPreview(url),

  // Open a link in the user's real browser, never inside the app window.
  'shell:open': (_e, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Refusing to open: ' + url);
    return shell.openExternal(url);
  },

  // Our own plugin system: every folder with a main.js under plugins/ or
  // <vault>/.new-era/plugins/. No registry, no marketplace, no sandbox escape -
  // they are local files the user put there.
  'plugins:list': () => {
    const dirs = [path.join(__dirname, '..', 'plugins')];
    if (ix) dirs.push(path.join(ix.vault, '.new-era', 'plugins'));
    const found = [];
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const main = path.join(dir, e.name, 'main.js');
        if (!e.isDirectory() || !fs.existsSync(main)) continue;
        let manifest = {};
        try { manifest = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'plugin.json'), 'utf8')); }
        catch { /* manifest is optional */ }
        found.push({
          id: manifest.id || e.name,
          name: manifest.name || e.name,
          description: manifest.description || '',
          url: 'file:///' + main.split(path.sep).join('/'),
        });
      }
    }
    return found;
  },
  'plugins:folder': () => {
    const dir = path.join(__dirname, '..', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  },
};

for (const [channel, fn] of Object.entries(api)) {
  ipcMain.handle(channel, async (...args) => fn(...args));
}

// --- window ----------------------------------------------------------------

function createWindow() {
  // Hidden title bar with a native overlay: we draw our own header, but keep
  // the OS window controls, snap layouts and rounded corners. `frame: false`
  // would give us all three to reimplement badly.
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 720, minHeight: 480,
    backgroundColor: '#1f1b1a',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined
      : { color: '#1c1c1c', symbolColor: '#c2b3ab', height: 42 },
    trafficLightPosition: { x: 14, y: 12 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      plugins: true, // Chromium's PDF viewer, for PDFs opened in a tab
    },
  });

  // Keep the OS controls legible when the theme changes.
  ipcMain.on('chrome:theme', (_e, colors) => {
    if (process.platform === 'darwin' || !win) return;
    try { win.setTitleBarOverlay({ ...colors, height: 42 }); } catch { /* not supported */ }
  });
  // Anything an embed tries to open in a new window (a YouTube title, a
  // Spotify "open app" button) goes to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  const send = (cmd) => () => win && win.webContents.send('command', cmd);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: send('note.new') },
        { label: "Today's Daily Note", accelerator: 'CmdOrCtrl+Shift+D', click: send('note.daily') },
        { type: 'separator' },
        { label: 'Open Vault...', accelerator: 'CmdOrCtrl+Shift+O', click: send('vault.pick') },
        { label: 'Reindex Vault', click: send('vault.resync') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Quick Switcher', accelerator: 'CmdOrCtrl+O', click: send('palette.files') },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+P', click: send('palette.commands') },
        { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', click: send('view.search') },
        { label: 'New Database View', accelerator: 'CmdOrCtrl+Shift+N', click: send('db.new') },
        { label: 'Graph View', accelerator: 'CmdOrCtrl+G', click: send('view.graph') },
        { type: 'separator' },
        { label: 'Appearance…', accelerator: 'CmdOrCtrl+,', click: send('app.settings') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('view.sidebar') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(() => {
  // YouTube refuses to play embeds that arrive with no Referer ("error 153"),
  // and a page loaded from disk sends none. Give its player one.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] },
    (details, done) => {
      details.requestHeaders.Referer = 'https://new-era.app/';
      done({ requestHeaders: details.requestHeaders });
    },
  );
  createWindow();
  // `npm start -- ./some-vault` opens that folder; otherwise reopen the last one.
  const cli = process.argv.slice(2).find(
    (a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a) && fs.statSync(a).isDirectory());
  const last = cli ? path.resolve(cli) : readConfig().vault;
  if (last && fs.existsSync(last)) {
    try { openVault(last); } catch { /* fall through to the welcome screen */ }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (ix) ix.close();
  if (process.platform !== 'darwin') app.quit();
});
