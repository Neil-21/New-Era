'use strict';
// Markdown note parsing: YAML-ish frontmatter, wikilinks, tags, title.
// ponytail: frontmatter supports the flat subset Obsidian/Notion actually use
// (scalar, inline list, block list). Nested maps fall through as raw strings.
// Swap in a real YAML lib only if someone hand-writes nested frontmatter.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function scalar(s) {
  s = s.trim();
  if (!s) return null;
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s[0] === '[' && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map(scalar) : [];
  }
  return s;
}

function dump(v) {
  if (Array.isArray(v)) return '[' + v.map(dump).join(', ') + ']';
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /^[\s"'\[{#-]|[:#]\s|[\s]$/.test(s) ? JSON.stringify(s) : s;
}

function parseFrontmatter(raw) {
  const m = raw.match(FM_RE);
  if (!m) return { data: {}, body: raw, end: 0 };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = data[key] === null ? [] : [data[key]];
      data[key].push(scalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\- ]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1].trim();
    data[key] = scalar(kv[2]);
  }
  return { data, body: raw.slice(m[0].length), end: m[0].length };
}

// Surgical write-back: touches only the given keys, every other byte survives.
function setFrontmatter(raw, patch) {
  const m = raw.match(FM_RE);
  const keys = Object.keys(patch);
  if (!m) {
    const block = keys.filter(k => patch[k] !== undefined)
      .map(k => `${k}: ${dump(patch[k])}`).join('\n');
    return `---\n${block}\n---\n\n${raw.replace(/^\s+/, '')}`;
  }
  const lines = m[1].split(/\r?\n/);
  const out = [];
  const done = new Set();
  let skipping = null;
  for (const line of lines) {
    if (skipping !== null) {                       // drop old block-list items
      if (/^\s*-\s+/.test(line)) continue;
      skipping = null;
    }
    const kv = line.match(/^([A-Za-z0-9_\- ]+):\s*(.*)$/);
    const k = kv && kv[1].trim();
    if (k && k in patch) {
      done.add(k);
      skipping = k;
      if (patch[k] === undefined) continue;        // undefined deletes the key
      out.push(`${k}: ${dump(patch[k])}`);
      continue;
    }
    out.push(line);
  }
  for (const k of keys) {
    if (done.has(k) || patch[k] === undefined) continue;
    out.push(`${k}: ${dump(patch[k])}`);
  }
  const block = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return `---\n${block}\n---\n` + raw.slice(m[0].length ? m[0].indexOf('---', 3) + 4 : 0).replace(/^\r?\n/, '\n');
}

const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

function parseLinks(body) {
  const clean = body.replace(CODE_RE, m => ' '.repeat(m.length));
  const links = [];
  const seen = new Set();
  const push = (target, type, alias) => {
    target = target.trim();
    if (!target) return;
    const k = type + '\u0000' + target;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ target, type, alias: alias || null });
  };
  for (const m of clean.matchAll(/(!)?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g))
    push(m[2], m[1] ? 'embed' : 'wikilink', m[3]);
  for (const m of clean.matchAll(/(?:^|[\s(])#([A-Za-z][\w\/-]*)/g)) push(m[1], 'tag');
  for (const m of clean.matchAll(/\[([^\]]*)\]\(([^)\s]+\.md)\)/g))
    push(decodeURIComponent(m[2]), 'wikilink', m[1]);
  return links;
}

function titleOf(path, data, body) {
  if (data && data.title) return String(data.title);
  const h = body.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  return path.split('/').pop().replace(/\.md$/i, '');
}

module.exports = { parseFrontmatter, setFrontmatter, parseLinks, titleOf, dump, scalar };
