// Page history: before a page is overwritten, renamed away or deleted, its old
// text is copied to <vault>/.new-era/history/pages/<page path>/<time>~<why>.md.
// Plain files, so even with the app broken you can open the folder and copy
// a version back by hand.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const EDIT_GAP = 5 * 60 * 1000;         // while typing, keep at most one copy per 5 minutes
const KEEP_RECENT = 24 * 60 * 60 * 1000; // everything from the last day is kept
const KEEP_MAX = 100;                    // older than that: at most this many per page
const KEEP_DAYS = 90;                    // ...and nothing older than this, bar the last 10

class History {
  constructor(vault) {
    this.vault = vault;
    this.root = path.join(vault, '.new-era', 'history', 'pages');
  }

  dir(rel) {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new Error('Path escapes history: ' + rel);
    return abs;
  }

  // Newest first: [{ id, time, reason, size }]
  versions(rel) {
    let names = [];
    try { names = fs.readdirSync(this.dir(rel)); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.md'))
      .map((id) => {
        const [stamp, reason = 'edit'] = id.slice(0, -3).split('~');
        return { id, time: Number(stamp), reason, size: fs.statSync(path.join(this.dir(rel), id)).size };
      })
      .filter((v) => Number.isFinite(v.time))
      .sort((a, b) => b.time - a.time);
  }

  read(rel, id) {
    if (!/^\d+~[\w-]+\.md$/.test(id)) throw new Error('Not a history version: ' + id);
    return fs.readFileSync(path.join(this.dir(rel), id), 'utf8');
  }

  // Save `content` as a past version of `rel`. Edits are throttled; renames,
  // deletes and restores always get their own copy.
  snapshot(rel, content, reason = 'edit', now = Date.now()) {
    if (!content || !content.trim()) return null;
    const list = this.versions(rel);
    const last = list[0];
    if (last && this.read(rel, last.id) === content) return null;
    if (reason === 'edit' && last && now - last.time < EDIT_GAP) return null;
    const dir = this.dir(rel);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${now}~${reason}.md`;
    fs.writeFileSync(path.join(dir, id), content, 'utf8');
    this.prune(rel, now);
    return id;
  }

  prune(rel, now = Date.now()) {
    const list = this.versions(rel);
    list.forEach((v, i) => {
      const age = now - v.time;
      if (age < KEEP_RECENT || i < 10) return;
      if (i >= KEEP_MAX || age > KEEP_DAYS * 86400000) {
        try { fs.unlinkSync(path.join(this.dir(rel), v.id)); } catch { /* already gone */ }
      }
    });
  }

  // A page's history follows it when it is renamed or moved.
  move(rel, nextRel) {
    const from = this.dir(rel);
    if (!fs.existsSync(from)) return;
    const to = this.dir(nextRel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(to)) { fs.renameSync(from, to); return; }
    for (const n of fs.readdirSync(from)) fs.renameSync(path.join(from, n), path.join(to, n));
    fs.rmdirSync(from);
  }

  // Pages that have history but no longer exist in the vault. Newest first.
  deleted() {
    const out = [];
    const walk = (dir, rel) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const next = rel ? rel + '/' + e.name : e.name;
        if (e.name.endsWith('.md')) {
          if (!fs.existsSync(path.join(this.vault, next))) {
            const [latest] = this.versions(next);
            if (latest) out.push({ path: next, time: latest.time, id: latest.id });
          }
        } else {
          walk(path.join(dir, e.name), next);
        }
      }
    };
    walk(this.root, '');
    return out.sort((a, b) => b.time - a.time);
  }
}

// Write so a crash mid-save can never leave a half-written page: write a temp
// file beside it, then swap it in. A rename within one folder is atomic.
function writeAtomic(abs, content) {
  const tmp = abs + '.saving~';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
}

module.exports = { History, writeAtomic, EDIT_GAP };
