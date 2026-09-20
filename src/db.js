'use strict';
// SQLite index over the vault. The markdown files are the source of truth;
// this is a derived cache that makes Notion-style queries instant.
// Uses node:sqlite (built into Electron's Node) - no native module to compile.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter, parseLinks, titleOf } = require('./parse.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY, title TEXT, folder TEXT, mtime INTEGER,
  size INTEGER, props TEXT DEFAULT '{}', body TEXT
);
CREATE TABLE IF NOT EXISTS links (
  src TEXT, target TEXT, resolved TEXT, type TEXT, alias TEXT
);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_res ON links(resolved);
CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  path UNINDEXED, title, body, tokenize='porter unicode61');
-- Attachments. A pasted image is only findable if something knows it exists,
-- which is why an image embed used to resolve to nothing.
CREATE TABLE IF NOT EXISTS assets (
  path TEXT PRIMARY KEY, name TEXT, ext TEXT, folder TEXT, size INTEGER, mtime INTEGER
);
CREATE INDEX IF NOT EXISTS assets_name ON assets(name);
`;

const KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'],
  doc: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'epub'],
  data: ['json', 'csv', 'tsv', 'xlsx', 'xls', 'ods', 'yaml', 'yml', 'toml', 'xml'],
  code: ['js', 'ts', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'html', 'css'],
};

function kindOf(ext) {
  for (const [kind, list] of Object.entries(KIND)) if (list.includes(ext)) return kind;
  return 'file';
}

const OPS = {
  is: '= ?', 'is-not': '!= ?', contains: "LIKE '%'||?||'%'",
  gt: '> ?', lt: '< ?',
};

class Index {
  constructor(vault) {
    this.vault = vault;
    fs.mkdirSync(path.join(vault, '.new-era'), { recursive: true });
    this.db = new DatabaseSync(path.join(vault, '.new-era', 'index.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  rel(abs) { return path.relative(this.vault, abs).split(path.sep).join('/'); }
  abs(rel) { return path.join(this.vault, rel); }

  // One walk, two buckets: notes and everything else worth linking to.
  walk(dir = this.vault, out = { notes: [], assets: [] }) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(p, out);
      else if (e.name.toLowerCase().endsWith('.md')) out.notes.push(p);
      else out.assets.push(p);
    }
    return out;
  }

  // Reindex everything whose mtime moved; drop rows for files that vanished.
  sync() {
    const found = this.walk();
    const files = found.notes;
    const known = new Map(
      this.db.prepare('SELECT path, mtime FROM notes').all().map((r) => [r.path, r.mtime]));
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      this.syncAssets(found.assets);
      for (const abs of files) {
        const rel = this.rel(abs);
        const mtime = Math.floor(fs.statSync(abs).mtimeMs);
        if (known.get(rel) !== mtime) { this.upsert(rel); changed++; }
        known.delete(rel);
      }
      for (const gone of known.keys()) this.remove(gone);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (changed || known.size) this.resolveLinks();
    return { total: files.length, changed, removed: known.size };
  }

  // Attachments are cheap to re-scan wholesale: no parsing, just stat.
  syncAssets(list) {
    const seen = new Set();
    const known = new Map(
      this.db.prepare('SELECT path, mtime FROM assets').all().map((r) => [r.path, r.mtime]));
    const ins = this.db.prepare(`INSERT INTO assets (path,name,ext,folder,size,mtime)
      VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
      size=excluded.size, mtime=excluded.mtime`);
    for (const abs of list) {
      const rel = this.rel(abs);
      seen.add(rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const mtime = Math.floor(st.mtimeMs);
      if (known.get(rel) === mtime) continue;
      const name = rel.split('/').pop();
      const dot = name.lastIndexOf('.');
      ins.run(rel, name, dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
        rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', st.size, mtime);
    }
    for (const gone of known.keys()) {
      if (!seen.has(gone)) this.db.prepare('DELETE FROM assets WHERE path = ?').run(gone);
    }
  }

  // Same rule as wikilinks: full path first, then basename anywhere in the
  // vault. This is what makes `![[photo.png]]` work after you move the file.
  resolveAsset(target) {
    const t = target.replace(/^\.\//, '');
    const hit = this.db.prepare(
      `SELECT path FROM assets WHERE path = ?1 OR lower(path) = lower(?1)
       OR lower(name) = lower(?1) ORDER BY length(path) LIMIT 1`).get(t);
    return hit ? hit.path : null;
  }

  assets({ kind, search, limit = 500 } = {}) {
    const parts = [];
    const args = [];
    if (search) { parts.push('name LIKE ?'); args.push('%' + search + '%'); }
    const rows = this.db.prepare(
      `SELECT path, name, ext, folder, size, mtime FROM assets
       ${parts.length ? 'WHERE ' + parts.join(' AND ') : ''}
       ORDER BY mtime DESC LIMIT ?`).all(...args, limit);
    for (const r of rows) r.kind = kindOf(r.ext);
    return kind ? rows.filter((r) => r.kind === kind) : rows;
  }

  assetKinds() {
    const rows = this.db.prepare('SELECT ext, COUNT(*) AS n FROM assets GROUP BY ext').all();
    const out = new Map();
    for (const r of rows) {
      const k = kindOf(r.ext);
      out.set(k, (out.get(k) || 0) + r.n);
    }
    return [...out].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
  }

  upsert(rel) {
    let raw, st;
    try {
      raw = fs.readFileSync(this.abs(rel), 'utf8');
      st = fs.statSync(this.abs(rel));
    } catch {
      this.remove(rel);
      return null;
    }
    const { data, body } = parseFrontmatter(raw);
    const title = titleOf(rel, data, body);
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    this.db.prepare(`INSERT INTO notes (path,title,folder,mtime,size,props,body)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
      title=excluded.title, folder=excluded.folder, mtime=excluded.mtime,
      size=excluded.size, props=excluded.props, body=excluded.body`)
      .run(rel, title, folder, Math.floor(st.mtimeMs), st.size, JSON.stringify(data), body);
    this.db.prepare('DELETE FROM fts WHERE path = ?').run(rel);
    this.db.prepare('INSERT INTO fts (path,title,body) VALUES (?,?,?)').run(rel, title, body);
    this.db.prepare('DELETE FROM links WHERE src = ?').run(rel);
    const ins = this.db.prepare(
      'INSERT INTO links (src,target,resolved,type,alias) VALUES (?,?,?,?,?)');
    for (const l of parseLinks(body)) {
      // Tags live in this table too, but they name a topic, not a file - they
      // never resolve to a path and must not count as broken links.
      const res = l.type === 'tag' ? null : this.resolve(l.target);
      ins.run(rel, l.target, res, l.type, l.alias);
    }
    return { path: rel, title };
  }

  remove(rel) {
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(rel);
    this.db.prepare('DELETE FROM fts WHERE path = ?').run(rel);
    this.db.prepare('DELETE FROM links WHERE src = ?').run(rel);
    this.db.prepare('UPDATE links SET resolved = NULL WHERE resolved = ?').run(rel);
  }

  // Obsidian's rule: a wikilink matches by basename anywhere in the vault, or by
  // full relative path. Unresolved stays NULL - a link to a note you have not
  // written yet is valid, and resolves itself the moment that note appears.
  resolve(target) {
    const t = target.replace(/\.md$/i, '');
    const hit = this.db.prepare(
      `SELECT path FROM notes WHERE path = ?1 OR path = ?1 || '.md'
       OR lower(replace(path, '.md', '')) = lower(?1)
       OR lower(path) LIKE '%/' || lower(?1) || '.md'
       ORDER BY length(path) LIMIT 1`).get(t);
    return hit ? hit.path : null;
  }

  resolveLinks() {
    const pending = this.db.prepare(
      "SELECT DISTINCT target FROM links WHERE resolved IS NULL AND type != 'tag'").all();
    for (const r of pending) {
      const hit = this.resolve(r.target);
      if (hit) this.db.prepare('UPDATE links SET resolved = ? WHERE target = ?').run(hit, r.target);
    }
  }

  note(rel) {
    const r = this.db.prepare('SELECT * FROM notes WHERE path = ?').get(rel);
    if (r) r.props = JSON.parse(r.props);
    return r;
  }

  all() {
    return this.db.prepare('SELECT path, title, folder, mtime FROM notes ORDER BY path').all();
  }

  search(q, limit = 50) {
    if (!q || !q.trim()) return [];
    const safe = q.trim().replace(/["*]/g, ' ').split(/\s+/).filter(Boolean)
      .map((w) => `"${w}"*`).join(' ');
    if (!safe) return [];
    try {
      return this.db.prepare(
        `SELECT f.path, n.title, snippet(fts, 2, '<mark>', '</mark>', '...', 12) AS snip
         FROM fts f JOIN notes n ON n.path = f.path
         WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(safe, limit);
    } catch {
      return []; // malformed FTS query - user is mid-typing
    }
  }

  backlinks(rel) {
    return this.db.prepare(
      `SELECT DISTINCT l.src AS path, n.title, l.type
       FROM links l JOIN notes n ON n.path = l.src
       WHERE l.resolved = ? AND l.src != ?`).all(rel, rel);
  }

  outlinks(rel) {
    return this.db.prepare(
      'SELECT DISTINCT target, resolved, type FROM links WHERE src = ?').all(rel);
  }

  tags() {
    return this.db.prepare(
      `SELECT target AS tag, COUNT(*) AS n FROM links WHERE type = 'tag'
       GROUP BY target ORDER BY n DESC, tag`).all();
  }

  folders() {
    return this.db.prepare(
      `SELECT folder, COUNT(*) AS n FROM notes WHERE folder != ''
       GROUP BY folder ORDER BY folder`).all();
  }

  // Every frontmatter key in a result set, so a table view can offer columns.
  propKeys(spec = {}) {
    const { sql, args } = this.where(spec);
    const rows = this.db.prepare(`SELECT props FROM notes ${sql}`).all(...args);
    const counts = new Map();
    for (const r of rows) {
      for (const k of Object.keys(JSON.parse(r.props))) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
  }

  // Distinct values of one property - powers board columns and select dropdowns.
  propValues(prop, spec = {}) {
    const rows = this.query({ ...spec, limit: 5000 });
    const counts = new Map();
    for (const r of rows) {
      const v = r.props[prop];
      for (const one of Array.isArray(v) ? v : [v]) {
        if (one === undefined || one === null || one === '') continue;
        counts.set(String(one), (counts.get(String(one)) || 0) + 1);
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
  }

  jsonPath(prop) {
    return `json_extract(props, '$."${String(prop).replace(/["\\]/g, '')}"')`;
  }

  where({ folder, tag, filters = [], search } = {}) {
    const parts = [];
    const args = [];
    if (folder) {
      parts.push("(folder = ? OR folder LIKE ? || '/%')");
      args.push(folder, folder);
    }
    if (tag) {
      parts.push("path IN (SELECT src FROM links WHERE type = 'tag' AND target = ?)");
      args.push(tag);
    }
    if (search) {
      parts.push('(title LIKE ? OR body LIKE ?)');
      args.push('%' + search + '%', '%' + search + '%');
    }
    for (const f of filters) {
      if (!f || !f.prop) continue;
      const jp = this.jsonPath(f.prop);
      if (f.op === 'empty') { parts.push(`(${jp} IS NULL OR ${jp} = '')`); continue; }
      if (f.op === 'not-empty') { parts.push(`(${jp} IS NOT NULL AND ${jp} != '')`); continue; }
      const op = OPS[f.op];
      if (!op) continue; // unknown op - ignore rather than build broken SQL
      parts.push(`${jp} ${op}`);
      args.push(f.value);
    }
    return { sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '', args };
  }

  // Rows for a Notion-style view.
  query(spec = {}) {
    const { sql, args } = this.where(spec);
    let order = 'title COLLATE NOCASE ASC';
    if (spec.sort && spec.sort.prop) {
      const dir = spec.sort.desc ? 'DESC' : 'ASC';
      order = spec.sort.prop === 'title' ? `title COLLATE NOCASE ${dir}`
        : spec.sort.prop === 'mtime' ? `mtime ${dir}`
          : `${this.jsonPath(spec.sort.prop)} ${dir}`;
    }
    const rows = this.db.prepare(
      `SELECT path, title, folder, mtime, size, props FROM notes ${sql}
       ORDER BY ${order} LIMIT ?`).all(...args, spec.limit || 500);
    for (const r of rows) r.props = JSON.parse(r.props);
    return rows;
  }

  // Nodes and edges for the graph view. Unresolved wikilinks become ghost
  // nodes so you can see what you have promised yourself to write.
  graph({ includeGhosts = true, includeTags = false } = {}) {
    const nodes = new Map();
    for (const r of this.db.prepare('SELECT path, title, folder FROM notes').all()) {
      nodes.set(r.path, { id: r.path, title: r.title, folder: r.folder, ghost: false, degree: 0 });
    }
    const edges = [];
    const seen = new Set();
    const rows = this.db.prepare(
      `SELECT src, target, resolved, type FROM links WHERE type != 'tag'`).all();
    for (const l of rows) {
      let to = l.resolved;
      if (!to) {
        if (!includeGhosts) continue;
        to = 'ghost:' + l.target;
        if (!nodes.has(to)) {
          nodes.set(to, { id: to, title: l.target, folder: '', ghost: true, degree: 0 });
        }
      }
      if (l.src === to) continue;
      const key = l.src < to ? l.src + ' ' + to : to + ' ' + l.src;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ s: l.src, t: to });
      nodes.get(l.src).degree++;
      nodes.get(to).degree++;
    }
    if (includeTags) {
      for (const l of this.db.prepare("SELECT src, target FROM links WHERE type = 'tag'").all()) {
        const to = 'tag:' + l.target;
        if (!nodes.has(to)) {
          nodes.set(to, { id: to, title: '#' + l.target, folder: '', tag: true, degree: 0 });
        }
        edges.push({ s: l.src, t: to });
        nodes.get(l.src).degree++;
        nodes.get(to).degree++;
      }
    }
    return { nodes: [...nodes.values()], edges };
  }

  stats() {
    const a = this.db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
    const l = this.db.prepare('SELECT COUNT(*) AS c FROM links').get().c;
    const u = this.db.prepare(
      "SELECT COUNT(DISTINCT target) AS c FROM links WHERE resolved IS NULL AND type != 'tag'")
      .get().c;
    return { notes: n, links: l, unresolved: u, assets: a };
  }
}

module.exports = { Index };
