// Markdown editor: CodeMirror 6 + live preview.
// The raw markdown stays in the document; syntax marks are hidden and styled
// unless your cursor is on that line. Same trick Obsidian uses, so the file and
// the view can never drift apart.
//
// Note: we deliberately do NOT use `basicSetup`. It ships defaultHighlightStyle,
// which underlines every heading and link - the single biggest reason plain
// CodeMirror markdown reads like a text dump instead of a document.
import {
  EditorView, keymap, placeholder, Decoration, WidgetType, ViewPlugin,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import { EditorState, RangeSetBuilder, Prec, StateField } from '@codemirror/state';
import {
  syntaxTree, indentUnit, syntaxHighlighting, HighlightStyle,
  bracketMatching, foldKeymap,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { languages } from '@codemirror/language-data';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

// --- syntax colours ---------------------------------------------------------
// Headings get size and weight, never underline. Links get colour, and only
// underline on hover.
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.9em', fontWeight: '700', lineHeight: '1.3', color: 'var(--text-strong)' },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: '650', lineHeight: '1.3', color: 'var(--text-strong)' },
  { tag: t.heading3, fontSize: '1.25em', fontWeight: '600', color: 'var(--text-strong)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontSize: '1.05em', fontWeight: '600', color: 'var(--text-strong)' },
  { tag: t.strong, fontWeight: '680', color: 'var(--text-strong)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-faint)' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'none' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '.88em', color: 'var(--code-text)' },
  { tag: t.quote, color: 'var(--text-dim)' },
  { tag: t.list, color: 'var(--text-dim)' },
  { tag: t.contentSeparator, color: 'var(--text-faint)' },
  // Frontmatter, now that it parses as real YAML instead of setext headings.
  { tag: t.definition(t.propertyName), color: 'var(--prop-key)', fontWeight: '500' },
  { tag: t.propertyName, color: 'var(--prop-key)', fontWeight: '500' },
  { tag: [t.string, t.atom], color: 'var(--prop-val)' },
  { tag: [t.number, t.bool], color: 'var(--prop-num)' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--syn-kw)' },
  { tag: [t.variableName, t.attributeName], color: 'var(--syn-var)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const HEADINGS = { ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6 };
const MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'StrongMark', 'StrikethroughMark',
  'LinkMark', 'CodeMark', 'QuoteMark',
]);
const hidden = Decoration.replace({});

// --- widgets ----------------------------------------------------------------

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task';
    box.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? '[ ]' : '[x]' } });
    };
    return box;
  }
  ignoreEvent() { return false; }
}

class LinkWidget extends WidgetType {
  constructor(target, label, exists) { super(); this.target = target; this.label = label; this.exists = exists; }
  eq(o) { return o.target === this.target && o.label === this.label && o.exists === this.exists; }
  toDOM() {
    const a = document.createElement('span');
    a.className = 'cm-wikilink' + (this.exists ? '' : ' is-unresolved');
    a.textContent = this.label;
    a.dataset.link = this.target;
    a.title = this.exists ? this.target : `${this.target} - not created yet`;
    return a;
  }
  ignoreEvent() { return false; }
}

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac)$/i;

// One widget for images, video and audio: they differ only by the tag.
class ImageWidget extends WidgetType {
  constructor(src, alt, resolve) { super(); this.src = src; this.alt = alt; this.resolve = resolve; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM() {
    const fig = document.createElement('span');
    const video = VIDEO_EXT.test(this.src);
    const audio = AUDIO_EXT.test(this.src);
    fig.className = 'cm-embed cm-embed-img' + (video ? ' cm-embed-video' : audio ? ' cm-embed-audio' : '');
    const img = document.createElement(video ? 'video' : audio ? 'audio' : 'img');
    img.src = this.resolve(this.src);
    if (video || audio) img.controls = true;
    else {
      img.alt = this.alt || '';
      img.loading = 'lazy';
    }
    img.onerror = () => {
      fig.classList.add('is-broken');
      fig.textContent = `file not found: ${this.src}`;
    };
    fig.append(img);
    if (this.alt) {
      const cap = document.createElement('span');
      cap.className = 'cm-embed-cap';
      cap.textContent = this.alt;
      fig.append(cap);
    }
    return fig;
  }
  ignoreEvent() { return false; }
}

// Notion-style web embeds. A bare URL alone on a line becomes a live iframe for
// providers that allow framing, and a link card for everything else - most sites
// send X-Frame-Options: DENY and would render an empty box.
const FRAMERS = [
  [/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/, (m) => `https://www.youtube.com/embed/${m[1]}`, '16/9'],
  [/youtube\.com\/embed\/[\w-]+/, (m) => 'https://' + m[0].replace(/^https?:\/\//, ''), '16/9'],
  [/vimeo\.com\/(\d+)/, (m) => `https://player.vimeo.com/video/${m[1]}`, '16/9'],
  [/open\.spotify\.com\/(track|album|playlist|episode)\/(\w+)/, (m) => `https://open.spotify.com/embed/${m[1]}/${m[2]}`, '4/1'],
  [/figma\.com\/(file|design|proto|board)\/[\w/-]+/, (m) => `https://www.figma.com/embed?embed_host=new-era&url=https://${m[0].replace(/^https?:\/\//, '')}`, '16/10'],
  [/codepen\.io\/([\w-]+)\/pen\/([\w-]+)/, (m) => `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, '4/3'],
  [/loom\.com\/share\/(\w+)/, (m) => `https://www.loom.com/embed/${m[1]}`, '16/9'],
  [/docs\.google\.com\/[\w/.-]+/, (m) => 'https://' + m[0].replace(/^https?:\/\//, '') + '?embedded=true', '4/3'],
];

function framer(url) {
  for (const [re, build, ratio] of FRAMERS) {
    const m = url.match(re);
    if (m) return { src: build(m), ratio };
  }
  return null;
}

class EmbedWidget extends WidgetType {
  constructor(url, forced) { super(); this.url = url; this.forced = forced; }
  eq(o) { return o.url === this.url && o.forced === this.forced; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-embed cm-embed-web';
    const f = framer(this.url);
    if (f || this.forced) {
      const frame = document.createElement('iframe');
      frame.src = f ? f.src : this.url;
      frame.loading = 'lazy';
      frame.allow = 'accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen';
      frame.referrerPolicy = 'no-referrer';
      frame.style.aspectRatio = f ? f.ratio : '16/9';
      wrap.append(frame);
      return wrap;
    }
    let host = this.url;
    try { host = new URL(this.url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
    wrap.classList.add('is-card');
    const body = document.createElement('div');
    body.className = 'cm-card-body';
    const title = document.createElement('div');
    title.className = 'cm-card-title';
    title.textContent = host;
    const sub = document.createElement('div');
    sub.className = 'cm-card-url';
    sub.textContent = this.url;
    body.append(title, sub);
    wrap.append(body);
    wrap.dataset.open = this.url;
    return wrap;
  }
  ignoreEvent() { return false; }
}

// `> [!note] Title` - hide the marker and show the kind as a labelled badge,
// the way Obsidian renders callouts.
const CALLOUT_ICON = {
  note: '\u270e', info: '\u2139', tip: '\u2726', success: '\u2713', done: '\u2713',
  question: '?', warning: '\u26a0', caution: '\u26a0', danger: '\u26a0',
  error: '\u2715', bug: '\u2731', example: '\u2261', quote: '\u201c', abstract: '\u2630',
};

class CalloutWidget extends WidgetType {
  constructor(kind) { super(); this.kind = kind; }
  eq(o) { return o.kind === this.kind; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-callout-badge';
    el.textContent = (CALLOUT_ICON[this.kind] || '\u270e') + '  ' + this.kind.toUpperCase();
    return el;
  }
  ignoreEvent() { return false; }
}

class FrontmatterWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-fm-fold';
    el.textContent = 'Properties';
    return el;
  }
  ignoreEvent() { return false; }
}

// --- frontmatter fold -------------------------------------------------------
// This decoration spans line breaks, which CodeMirror only allows from a
// StateField; a ViewPlugin throws at runtime.
const frontmatterFold = StateField.define({
  create(state) { return foldRange(state); },
  update(value, tr) { return tr.docChanged || tr.selection ? foldRange(tr.state) : value; },
  provide: (f) => EditorView.decorations.from(f),
});

function foldRange(state) {
  if (state.doc.line(1).text.trim() !== '---') return Decoration.none;
  let end = 0;
  for (let n = 2; n <= Math.min(state.doc.lines, 200); n++) {
    if (state.doc.line(n).text.trim() === '---') { end = n; break; }
  }
  if (!end) return Decoration.none;
  const last = state.doc.line(end);
  for (const r of state.selection.ranges) {
    if (r.from <= last.to) return Decoration.none; // cursor is in or above it
  }
  return Decoration.set([
    Decoration.replace({ widget: new FrontmatterWidget(), block: true })
      .range(state.doc.line(1).from, last.to),
  ]);
}

// --- live preview -----------------------------------------------------------

const WIKI_RE = /(!?)\[\[([^\]|#^]+)(?:[#^]([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const URL_LINE_RE = /^\s*(https?:\/\/\S+)\s*$/;
const EMBED_LINE_RE = /^\s*!(?:embed)?\((https?:\/\/\S+)\)\s*$/;
const CALLOUT_RE = /^\s*>\s*\[!(\w+)\]/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|mp4|mov|webm|m4v|mp3|wav|ogg|m4a|flac)$/i;
// `==highlight==` is not standard markdown, so it gets its own pass.
const HIGHLIGHT_RE = /==([^=\n]+)==/g;
const highlightMark = Decoration.mark({ class: 'cm-highlight' });

function livePreview(ctx) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
    }

    build(view) {
      const b = new RangeSetBuilder();
      const { state } = view;
      const cursorLines = new Set();
      for (const r of state.selection.ranges) {
        for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) {
          cursorLines.add(l);
        }
      }
      const live = (pos) => !cursorLines.has(state.doc.lineAt(pos).number);
      const marks = [];
      const consumed = []; // line ranges already replaced by a block widget
      const badges = [];   // callout marker ranges, which own their whole span

      // Whole-line embeds: a bare URL, an !(url), or an image alone on a line.
      // These replace a line's content but never its line break, and they are
      // inline decorations styled `display:block` - CodeMirror reserves real
      // block decorations for StateFields and throws if a plugin emits one.
      for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n);
        if (!line.text.trim() || cursorLines.has(n)) continue;
        const forced = line.text.match(EMBED_LINE_RE);
        const bare = line.text.match(URL_LINE_RE);
        if (forced || bare) {
          const url = (forced || bare)[1];
          marks.push([line.from, line.to,
            Decoration.replace({ widget: new EmbedWidget(url, !!forced) })]);
          consumed.push([line.from, line.to]);
          continue;
        }
        const md = line.text.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
        const wiki = line.text.trim().match(/^!\[\[([^\]]+)\]\]$/);
        if (md || wiki) {
          marks.push([line.from, line.to, Decoration.replace({
            widget: new ImageWidget(md ? md[2] : wiki[1], md ? md[1] : '', ctx.asset),
          })]);
          consumed.push([line.from, line.to]);
        }
      }

      const claimed = (from, to) => consumed.some(([f, t]) => from >= f && to <= t);


      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (node) => {
            const hd = HEADINGS[node.name];
            if (hd) {
              const line = state.doc.lineAt(node.from);
              marks.push([line.from, line.from, Decoration.line({ class: `cm-h${hd}` })]);
              return;
            }
            if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
              const first = state.doc.lineAt(node.from).number;
              const last = state.doc.lineAt(node.to).number;
              for (let n = first; n <= last; n++) {
                const line = state.doc.line(n);
                marks.push([line.from, line.from, Decoration.line({
                  class: 'cm-codeblock'
                    + (n === first ? ' cm-code-top' : '') + (n === last ? ' cm-code-bot' : ''),
                })]);
              }
              return;
            }
            if (node.name === 'Blockquote') {
              const first = state.doc.lineAt(node.from).number;
              const last = state.doc.lineAt(node.to).number;
              // `> [!note]` on the opening line turns the whole quote into a
              // callout box, so every line of it needs the styling - not just
              // the one carrying the marker.
              const call = state.doc.line(first).text.match(CALLOUT_RE);
              const kind = call ? ` cm-callout cm-callout-${call[1].toLowerCase()}` : '';
              if (call && live(node.from)) {
                // Replace `> [!note]` with the badge; the `>` is hidden
                // separately by the QuoteMark rule. Markdown also parses
                // `[!note]` as link syntax, so claim the span here and skip the
                // LinkMarks inside it - otherwise they win the overlap and the
                // raw text leaks through as "!note".
                const line = state.doc.line(first);
                const open = line.text.indexOf('[!');
                const close = line.text.indexOf(']', open) + 1;
                const at = line.from + open;
                const to = line.from + close + (line.text[close] === ' ' ? 1 : 0);
                badges.push([at, to]);
                marks.push([at, to,
                  Decoration.replace({ widget: new CalloutWidget(call[1].toLowerCase()) })]);
              }
              for (let n = first; n <= last; n++) {
                marks.push([state.doc.line(n).from, state.doc.line(n).from, Decoration.line({
                  class: 'cm-quote' + kind
                    + (kind && n === first ? ' cm-callout-top' : '')
                    + (kind && n === last ? ' cm-callout-bot' : ''),
                })]);
              }
              return;
            }
            // A line already replaced by an embed owns every byte of it.
            if (claimed(node.from, node.to)) return;
            if (node.name === 'TaskMarker') {
              if (!live(node.from)) return;
              const txt = state.doc.sliceString(node.from, node.to);
              marks.push([node.from, node.to,
                Decoration.replace({ widget: new CheckboxWidget(/[xX]/.test(txt), node.from) })]);
              return;
            }
            if (node.name === 'HeaderMark' && live(node.from)) {
              // Swallow the space after "#" too, or the heading renders indented.
              const after = state.doc.sliceString(node.to, node.to + 1);
              marks.push([node.from, node.to + (after === ' ' ? 1 : 0), hidden]);
              return;
            }
            if (MARKS.has(node.name) && live(node.from) && node.to > node.from) {
              if (badges.some(([f, t2]) => node.from >= f && node.to <= t2)) return;
              marks.push([node.from, node.to, hidden]);
            }
          },
        });
      }

      const eaten = (pos) => consumed.some(([f, tt]) => pos >= f && pos <= tt);

      // Inline images and wikilinks.
      for (const { from, to } of view.visibleRanges) {
        const text = state.doc.sliceString(from, to);
        for (const m of text.matchAll(IMG_RE)) {
          const start = from + m.index;
          if (!live(start) || eaten(start)) continue;
          marks.push([start, start + m[0].length,
            Decoration.replace({ widget: new ImageWidget(m[2], m[1], ctx.asset) })]);
        }
        for (const m of text.matchAll(HIGHLIGHT_RE)) {
          const start = from + m.index;
          if (eaten(start)) continue;
          const end = start + m[0].length;
          if (live(start)) {
            marks.push([start, start + 2, hidden]);
            marks.push([end - 2, end, hidden]);
          }
          marks.push([start + 2, end - 2, highlightMark]);
        }
        for (const m of text.matchAll(WIKI_RE)) {
          const start = from + m.index;
          if (!live(start) || eaten(start)) continue;
          const target = m[2].trim();
          if (m[1] && IMAGE_EXT.test(target)) {
            marks.push([start, start + m[0].length,
              Decoration.replace({ widget: new ImageWidget(target, '', ctx.asset) })]);
            continue;
          }
          const label = (m[4] || m[2]).trim() + (m[3] ? ' › ' + m[3] : '');
          marks.push([start, start + m[0].length,
            Decoration.replace({ widget: new LinkWidget(target, label, ctx.exists(target)) })]);
        }
      }

      // RangeSetBuilder needs sorted, non-overlapping ranges.
      marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let prevTo = -1;
      let prevFrom = -1;
      for (const [f, tt, d] of marks) {
        if (f < prevTo && !(f === prevFrom && tt === prevTo)) continue;
        b.add(f, tt, d);
        prevFrom = f;
        prevTo = tt;
      }
      // (marks are sorted above; disjoint ranges only, which is what the
      // builder requires)
      return b.finish();
    }
  }, { decorations: (v) => v.decorations });
}

// --- slash menu -------------------------------------------------------------

const BLOCKS = [
  { label: 'Heading 1', hint: 'Big section heading', insert: '# ' },
  { label: 'Heading 2', hint: 'Medium section heading', insert: '## ' },
  { label: 'Heading 3', hint: 'Small section heading', insert: '### ' },
  { label: 'To-do', hint: 'Checkbox you can tick', insert: '- [ ] ' },
  { label: 'Bulleted list', hint: 'Simple bullet', insert: '- ' },
  { label: 'Numbered list', hint: 'Ordered list', insert: '1. ' },
  { label: 'Quote', hint: 'Set text apart', insert: '> ' },
  { label: 'Callout', hint: 'Highlighted note box', insert: '> [!note] ' },
  { label: 'Code', hint: 'Fenced code block', insert: '```\n\n```', cursor: 4 },
  { label: 'Divider', hint: 'Horizontal rule', insert: '\n---\n' },
  { label: 'Table', hint: 'Markdown table', insert: '| Name | Status |\n| --- | --- |\n|  |  |' },
  { label: 'Link to note', hint: 'Wikilink to another note', insert: '[[]]', cursor: 2 },
  { label: 'Web embed', hint: 'YouTube, Figma, Spotify, Loom…', insert: '!()', cursor: 2 },
  { label: 'Image', hint: 'By URL or vault path', insert: '![]()', cursor: 4 },
];

function slashMenu(view, opts) {
  const startLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const slashPos = view.state.selection.main.head - 1;
  const box = document.createElement('div');
  box.className = 'slash-menu';
  document.body.append(box);

  let query = '';
  let sel = 0;
  let items = BLOCKS;

  const place = () => {
    const co = view.coordsAtPos(slashPos);
    if (!co) return;
    const below = window.innerHeight - co.bottom > 300;
    box.style.left = Math.min(co.left, window.innerWidth - 310) + 'px';
    box.style.top = (below ? co.bottom + 6 : co.top - 6) + 'px';
    box.style.transform = below ? '' : 'translateY(-100%)';
  };

  const paint = () => {
    items = BLOCKS.filter((x) => (x.label + ' ' + x.hint).toLowerCase().includes(query.toLowerCase()));
    if (!items.length) return close();
    sel = Math.min(sel, items.length - 1);
    box.replaceChildren(...items.map((x, i) => {
      const row = document.createElement('div');
      row.className = 'slash-row' + (i === sel ? ' is-sel' : '');
      const label = document.createElement('span');
      label.className = 'slash-label';
      label.textContent = x.label;
      const hint = document.createElement('span');
      hint.className = 'slash-hint';
      hint.textContent = x.hint;
      row.append(label, hint);
      row.onmousedown = (e) => { e.preventDefault(); choose(x); };
      return row;
    }));
    return place();
  };

  const close = () => {
    box.remove();
    view.dom.removeEventListener('keydown', onKey, true);
    opts.onClose();
  };

  const choose = (x) => {
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: slashPos, to: head, insert: x.insert },
      selection: { anchor: slashPos + (x.cursor ?? x.insert.length) },
    });
    close();
    view.focus();
  };

  const onKey = (e) => {
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); return close(); }
    if (e.key === 'ArrowDown') { stop(); sel = (sel + 1) % items.length; return paint(); }
    if (e.key === 'ArrowUp') { stop(); sel = (sel - 1 + items.length) % items.length; return paint(); }
    if (e.key === 'Enter' || e.key === 'Tab') { stop(); return choose(items[sel]); }
    // Re-read the query after the keystroke lands in the document.
    return setTimeout(() => {
      const head = view.state.selection.main.head;
      if (head <= slashPos || view.state.doc.lineAt(head).number !== startLine) return close();
      query = view.state.doc.sliceString(slashPos + 1, head);
      if (/\s\s|\n/.test(query)) return close();
      return paint();
    }, 0);
  };

  view.dom.addEventListener('keydown', onKey, true);
  paint();
  return { close };
}

// --- theme ------------------------------------------------------------------

const theme = EditorView.theme({
  '&': { fontSize: 'var(--editor-size)', height: '100%', background: 'transparent', color: 'var(--text)' },
  '.cm-scroller': {
    fontFamily: 'var(--font-text)', lineHeight: 'var(--editor-leading)',
    padding: '0 0 45vh', overflowX: 'hidden',
  },
  '.cm-content': {
    maxWidth: 'var(--note-width)', margin: '0 auto', padding: '0 var(--note-gutter)',
    caretColor: 'var(--accent)',
  },
  '.cm-gutters': { display: 'none' },
  '.cm-line': { padding: '3px 0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-h1, .cm-h2': { marginTop: '.7em' },
  '.cm-h3, .cm-h4': { marginTop: '.5em' },
  '.cm-codeblock': {
    fontFamily: 'var(--font-mono)', fontSize: '.88em', background: 'var(--bg-code)',
    padding: '1px var(--note-gutter)', margin: '0 calc(var(--note-gutter) * -1)',
  },
  '.cm-code-top': { paddingTop: '10px', borderRadius: '8px 8px 0 0', marginTop: '6px' },
  '.cm-code-bot': { paddingBottom: '10px', borderRadius: '0 0 8px 8px', marginBottom: '6px' },
  '.cm-quote': {
    borderLeft: '3px solid var(--border-strong)', paddingLeft: '14px', color: 'var(--text-dim)',
  },
  '.cm-callout': {
    background: 'var(--bg-3)', borderLeftColor: 'var(--accent)',
    padding: '3px 14px', margin: '0 -8px',
  },
  '.cm-callout-warning, .cm-callout-caution': { borderLeftColor: 'var(--warn)' },
  '.cm-callout-danger, .cm-callout-error, .cm-callout-bug': { borderLeftColor: 'var(--danger)' },
  '.cm-callout-tip, .cm-callout-success, .cm-callout-done': { borderLeftColor: 'var(--ok)' },
  '.cm-selectionBackground, ::selection': { background: 'var(--selection) !important' },
  '.cm-cursor': { borderLeftWidth: '2px', borderLeftColor: 'var(--accent)' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
});

// --- factory ----------------------------------------------------------------

export function createEditor(parent, opts) {
  const ctx = {
    exists: opts.exists || (() => true),
    asset: opts.asset || ((s) => s),
  };
  const save = debounce(() => opts.onChange(view.state.doc.toString()), 400);
  let slash = null;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc || '',
      selection: { anchor: Math.min(opts.cursor || 0, (opts.doc || '').length) },
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        rectangularSelection(),
        crosshairCursor(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ defaultKeymap: false }),
        highlightSelectionMatches(),
        keymap.of([
          indentWithTab, ...closeBracketsKeymap, ...defaultKeymap,
          ...historyKeymap, ...foldKeymap, ...completionKeymap, ...searchKeymap,
        ]),
        yamlFrontmatter({
          content: markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
        }),
        syntaxHighlighting(highlight),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        placeholder("Write, [[link]] a note, or press '/' for blocks"),
        frontmatterFold,
        livePreview(ctx),
        theme,
        Prec.high(keymap.of([
          { key: 'Mod-s', run: () => { save.flush(); return true; } },
        ])),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          save();
          if (slash) return;
          // Open the block menu on "/" at the start of a line or after a space.
          u.changes.iterChanges((_fa, _ta, fb, tb, ins) => {
            if (ins.toString() !== '/') return;
            const before = u.state.doc.sliceString(Math.max(0, fb - 1), fb);
            if (before && !/\s/.test(before)) return;
            if (u.state.doc.lineAt(tb).text.trim().startsWith('```')) return;
            slash = slashMenu(view, { onClose: () => { slash = null; } });
          });
        }),
        EditorView.domEventHandlers({
          paste(e, view) {
            const files = [...(e.clipboardData?.items || [])]
              .filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
            if (!files.length || !opts.onAttach) return false;
            e.preventDefault();
            attach(files, view, opts);
            return true;
          },
          dragover(e) {
            if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
            return false;
          },
          drop(e, view) {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length || !opts.onAttach) return false;
            e.preventDefault();
            const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (at !== null) view.dispatch({ selection: { anchor: at } });
            attach(files, view, opts);
            return true;
          },
          mousedown(e) {
            const link = e.target.closest('.cm-wikilink');
            if (link) { e.preventDefault(); opts.onLink(link.dataset.link); return true; }
            const card = e.target.closest('[data-open]');
            if (card) { e.preventDefault(); opts.onExternal(card.dataset.open); return true; }
            return false;
          },
        }),
      ],
    }),
  });

  return {
    view,
    get value() { return view.state.doc.toString(); },
    flush: () => save.flush(),
    setDoc(doc) {
      save.cancel();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: 0 },
      });
    },
    insert(text) {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => { save.cancel(); if (slash) slash.close(); view.destroy(); },
  };
}

// Save dropped or pasted files into the vault, then link them where the cursor
// is. Sequential on purpose: two files must not race for the same filename.
async function attach(files, view, opts) {
  for (const file of files) {
    try {
      const saved = await opts.onAttach(file);
      if (!saved) continue;
      const media = /^(image|video|audio)\//.test(file.type) || IMAGE_EXT.test(saved.name);
      const link = media ? `![[${saved.name}]]` : `[${saved.name}](${encodeURI(saved.path)})`;
      const head = view.state.selection.main;
      const before = head.from > 0 && !/\s/.test(view.state.sliceDoc(head.from - 1, head.from));
      const insert = (before ? '\n' : '') + link + '\n';
      view.dispatch({
        changes: { from: head.from, to: head.to, insert },
        selection: { anchor: head.from + insert.length },
      });
    } catch (err) {
      opts.onAttachError?.(err);
    }
  }
  view.focus();
}

function debounce(fn, ms) {
  let t = null;
  const wrapped = () => { clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
  wrapped.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  return wrapped;
}
