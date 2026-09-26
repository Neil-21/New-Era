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
import { languages } from '@codemirror/language-data';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

// --- syntax colours ---------------------------------------------------------
// Headings get size and weight, never underline. Links get colour, and only
// underline on hover.
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.9em', fontWeight: '900', lineHeight: '1.3', color: 'var(--text-strong)' },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: '800', lineHeight: '1.3', color: 'var(--accent)' },
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

// Notion-style web embeds. A link alone on a line becomes a live player for
// providers that allow framing, and a preview card for everything else - most
// sites send X-Frame-Options: DENY and would render an empty box.
// Each entry: pattern, player URL, and the frame's size.
const FRAMERS = [
  [/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/,
    (m) => `https://www.youtube.com/embed/${m[1]}?rel=0`, () => ({ aspectRatio: '16/9' })],
  [/vimeo\.com\/(?:video\/)?(\d+)/, (m) => `https://player.vimeo.com/video/${m[1]}`, () => ({ aspectRatio: '16/9' })],
  [/open\.spotify\.com\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/,
    (m) => `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
    (m) => ({ height: m[1] === 'track' || m[1] === 'episode' ? '152px' : '352px' })],
  [/soundcloud\.com\/[\w-]+\/[\w-]+/,
    (m) => `https://w.soundcloud.com/player/?url=${encodeURIComponent('https://' + m[0])}&visual=true`,
    () => ({ height: '300px' })],
  [/music\.apple\.com\/([\w/-]+)/, (m) => `https://embed.music.apple.com/${m[1]}`, () => ({ height: '450px' })],
  [/figma\.com\/(file|design|proto|board)\/[\w/-]+/,
    (m) => `https://www.figma.com/embed?embed_host=new-era&url=https://${m[0].replace(/^https?:\/\//, '')}`,
    () => ({ aspectRatio: '16/10' })],
  [/codepen\.io\/([\w-]+)\/pen\/([\w-]+)/,
    (m) => `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, () => ({ aspectRatio: '4/3' })],
  [/loom\.com\/share\/(\w+)/, (m) => `https://www.loom.com/embed/${m[1]}`, () => ({ aspectRatio: '16/9' })],
  [/docs\.google\.com\/[\w/.-]+/,
    (m) => 'https://' + m[0].replace(/^https?:\/\//, '') + '?embedded=true', () => ({ aspectRatio: '4/3' })],
];

function framer(url) {
  for (const [re, build, size] of FRAMERS) {
    const m = url.match(re);
    if (m) return { src: build(m), style: size(m) };
  }
  return null;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

class EmbedWidget extends WidgetType {
  constructor(url, forced, preview) { super(); this.url = url; this.forced = forced; this.preview = preview; }
  eq(o) { return o.url === this.url && o.forced === this.forced; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-embed cm-embed-web';
    const f = framer(this.url);
    if (f || this.forced) {
      const frame = document.createElement('iframe');
      frame.src = f ? f.src : this.url;
      frame.loading = 'lazy';
      frame.allow = 'autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      Object.assign(frame.style, f ? f.style : { aspectRatio: '16/9' });
      // Under every player, a plain way out to the real site.
      const cap = document.createElement('div');
      cap.className = 'cm-embed-open';
      cap.dataset.open = this.url;
      cap.textContent = `Open on ${hostOf(this.url)} ↗`;
      wrap.append(frame, cap);
      return wrap;
    }
    // Everything else: a card that fills in the page's title, blurb and picture.
    wrap.classList.add('is-card');
    wrap.dataset.open = this.url;
    const pic = document.createElement('div');
    pic.className = 'cm-card-pic';
    const body = document.createElement('div');
    body.className = 'cm-card-body';
    const title = document.createElement('div');
    title.className = 'cm-card-title';
    title.textContent = hostOf(this.url);
    const desc = document.createElement('div');
    desc.className = 'cm-card-desc';
    const sub = document.createElement('div');
    sub.className = 'cm-card-url';
    sub.textContent = '\u{1F517} ' + hostOf(this.url);
    body.append(title, desc, sub);
    wrap.append(body, pic);
    if (this.preview) {
      wrap.classList.add('is-loading');
      this.preview(this.url).then((p) => {
        if (p.title) title.textContent = p.title;
        if (p.description) desc.textContent = p.description;
        if (p.site) sub.textContent = '\u{1F517} ' + p.site;
        if (p.image) {
          const img = document.createElement('img');
          img.src = p.image;
          img.alt = '';
          img.onerror = () => pic.remove();
          pic.append(img);
          wrap.classList.add('has-pic');
        }
      }).catch(() => { /* offline or blocked: the plain card still works */ })
        .finally(() => wrap.classList.remove('is-loading'));
    }
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
      // On the cursor line the media stays put and its source shows above it,
      // so arrowing past an image does not make the page jump.
      for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n);
        if (!line.text.trim()) continue;
        const show = (widget) => {
          marks.push(cursorLines.has(n)
            ? [line.to, line.to, Decoration.widget({ widget, side: 1 })]
            : [line.from, line.to, Decoration.replace({ widget })]);
          consumed.push([line.from, line.to]);
        };
        const forced = line.text.match(EMBED_LINE_RE);
        const bare = line.text.match(URL_LINE_RE);
        if (forced || bare) {
          show(new EmbedWidget((forced || bare)[1], !!forced, ctx.preview));
          continue;
        }
        const md = line.text.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
        const wiki = line.text.trim().match(/^!\[\[([^\]]+)\]\]$/);
        if (md || wiki) show(new ImageWidget(md ? md[2] : wiki[1], md ? md[1] : '', ctx.asset));
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
            // [text](url): show only the text, as a link you can click.
            if (node.name === 'Link' && live(node.from)) {
              const kids = [];
              for (let c = node.node.firstChild; c; c = c.nextSibling) kids.push(c);
              const marksIn = kids.filter((c) => c.name === 'LinkMark');
              const url = kids.find((c) => c.name === 'URL');
              if (url && marksIn.length >= 2 && marksIn[1].from > marksIn[0].to) {
                const href = state.doc.sliceString(url.from, url.to);
                marks.push([marksIn[0].to, marksIn[1].from,
                  Decoration.mark({ class: 'cm-weblink', attributes: { 'data-href': href, title: href } })]);
              }
              return;
            }
            if (node.name === 'URL' && live(node.from)) {
              const parent = node.node.parent && node.node.parent.name;
              if (parent === 'Link') { marks.push([node.from, node.to, hidden]); return; }
              if (parent !== 'Image') {
                // A bare link in the middle of a sentence.
                const href = state.doc.sliceString(node.from, node.to);
                marks.push([node.from, node.to,
                  Decoration.mark({ class: 'cm-weblink', attributes: { 'data-href': href, title: href } })]);
              }
              return;
            }
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

// --- title echo --------------------------------------------------------------
// Many notes start with "# Title", which the big page title already shows.
// Hide that first heading (and the blank line after it) unless the cursor is
// on it, so the page does not say its own name twice.

function titleEcho(state, title) {
  const want = String(title || '').trim().toLowerCase();
  if (!want) return null;
  let n = 1;
  while (n <= state.doc.lines && n <= 3 && !state.doc.line(n).text.trim()) n++;
  if (n > state.doc.lines || n > 3) return null;
  const line = state.doc.line(n);
  const m = line.text.match(/^#\s+(.+?)\s*#*\s*$/);
  if (!m || m[1].trim().toLowerCase() !== want) return null;
  let to = line.to;
  if (n < state.doc.lines && !state.doc.line(n + 1).text.trim()) to = state.doc.line(n + 1).to;
  return { from: 0, to, heading: line };
}

function hideTitleEcho(title) {
  const build = (state) => {
    const echo = titleEcho(state, title);
    if (!echo) return Decoration.none;
    const head = state.selection.main.head;
    if (head >= echo.heading.from && head <= echo.heading.to) return Decoration.none;
    return Decoration.set([Decoration.replace({ block: true }).range(echo.from, echo.to)]);
  };
  return StateField.define({
    create: build,
    update: (v, tr) => (tr.docChanged || tr.selection ? build(tr.state) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
}

// --- "you can write here" cues ----------------------------------------------
// A blank page gives no hint that it takes typing. The empty line under the
// cursor says what to do, and the end of the page always offers one more line.

class HintWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-line-hint';
    el.textContent = 'Type here, or press / for headings, lists, pictures\u2026';
    return el;
  }
}

class MoreWidget extends WidgetType {
  eq() { return true; }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-keep-writing';
    el.textContent = '\u270F\uFE0F  Click to keep writing';
    el.onmousedown = (e) => { e.preventDefault(); newLineAtEnd(view); };
    return el;
  }
  ignoreEvent() { return true; }
}

function newLineAtEnd(view) {
  const { doc } = view.state;
  const last = doc.line(doc.lines);
  const insert = last.text.trim() ? '\n' : '';
  view.dispatch({
    changes: { from: doc.length, insert },
    selection: { anchor: doc.length + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

const writingCues = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
  }
  build(view) {
    const { state } = view;
    const b = new RangeSetBuilder();
    const head = state.selection.main;
    const line = state.doc.lineAt(head.head);
    const last = state.doc.line(state.doc.lines);
    if (view.hasFocus && head.empty && !line.text.trim() && state.doc.length) {
      b.add(line.from, line.from, Decoration.widget({ widget: new HintWidget(), side: 1 }));
    }
    if (state.doc.length && !(view.hasFocus && line.number === last.number)) {
      b.add(last.to, last.to, Decoration.widget({ widget: new MoreWidget(), side: 2, block: false }));
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

// Short pages read big and friendly; the text eases to its normal size as the
// page fills up, so a long page still fits on screen.
function fillScale(doc) {
  const t = Math.min(1, Math.max(0, (doc.length - 150) / 2500));
  return (1.2 - 0.2 * t).toFixed(2);
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
  { label: 'Video, music or web link', hint: 'YouTube, Spotify, Vimeo, or any website', ask: 'Paste the link' },
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
    if (x.ask) {
      // Drop the "/query", then ask. A link alone on its line becomes the embed.
      view.dispatch({ changes: { from: slashPos, to: head, insert: '' } });
      close();
      Promise.resolve(opts.prompt ? opts.prompt(x.ask) : null).then((url) => {
        const clean = (url || '').trim();
        if (!clean) return view.focus();
        const at = view.state.selection.main.head;
        const line = view.state.doc.lineAt(at);
        const insert = (line.text.trim() ? '\n' : '') + clean + '\n';
        view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
        return view.focus();
      });
      return;
    }
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
  '&': {
    fontSize: 'calc(var(--editor-size) * var(--fill-scale, 1))',
    background: 'transparent', color: 'var(--text)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-text)', lineHeight: 'var(--editor-leading)',
    padding: '0 0 24px', overflowX: 'hidden',
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
    preview: opts.preview,
  };
  // The editor holds only the body. Frontmatter is edited in the properties
  // panel and carried along here untouched, so the cursor never falls into it.
  let prefix = opts.prefix || '';
  const save = debounce(() => opts.onChange(prefix + view.state.doc.toString()), 400);
  let slash = null;

  const startState = EditorState.create({ doc: opts.doc || '' });
  const echo = titleEcho(startState, opts.title);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc || '',
      selection: { anchor: echo ? Math.min(echo.to + 1, startState.doc.length) : 0 },
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
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
        syntaxHighlighting(highlight),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        placeholder('Start writing here…  Type / to add a heading, list, picture and more'),
        livePreview(ctx),
        hideTitleEcho(opts.title),
        writingCues,
        theme,
        Prec.high(keymap.of([
          { key: 'Mod-s', run: () => { save.flush(); return true; } },
        ])),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          parent.style.setProperty('--fill-scale', fillScale(u.state.doc));
          save();
          if (slash) return;
          // Open the block menu on "/" at the start of a line or after a space.
          u.changes.iterChanges((_fa, _ta, fb, tb, ins) => {
            if (ins.toString() !== '/') return;
            const before = u.state.doc.sliceString(Math.max(0, fb - 1), fb);
            if (before && !/\s/.test(before)) return;
            if (u.state.doc.lineAt(tb).text.trim().startsWith('```')) return;
            slash = slashMenu(view, { onClose: () => { slash = null; }, prompt: opts.prompt });
          });
        }),
        EditorView.domEventHandlers({
          paste(e, view) {
            const pasted = (e.clipboardData?.getData('text/plain') || '').trim();
            const sel = view.state.selection.main;
            if (!sel.empty && /^https?:\/\/\S+$/.test(pasted)) {
              e.preventDefault();
              const words = view.state.sliceDoc(sel.from, sel.to);
              view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${words}](${pasted})` } });
              return true;
            }
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
          mousedown(e, view) {
            // A click in the blank space under the text starts a new line there.
            if (!e.target.closest('.cm-content') && e.clientY > view.contentDOM.getBoundingClientRect().bottom - 40) {
              e.preventDefault();
              newLineAtEnd(view);
              return true;
            }
            const web = e.target.closest('.cm-weblink');
            if (web) { e.preventDefault(); opts.onExternal(web.dataset.href); return true; }
            if (e.ctrlKey || e.metaKey) {
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos !== null) {
                const line = view.state.doc.lineAt(pos);
                for (const m of line.text.matchAll(/https?:\/\/[^\s)\]>]+/g)) {
                  const from = line.from + m.index;
                  if (pos >= from && pos <= from + m[0].length) {
                    e.preventDefault();
                    opts.onExternal(m[0]);
                    return true;
                  }
                }
              }
            }
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

  parent.style.setProperty('--fill-scale', fillScale(view.state.doc));
  // The empty space below the text belongs to the host, not the editor, so it
  // needs its own listener to hand clicks over.
  parent.addEventListener('mousedown', (e) => {
    if (e.target !== parent) return;
    e.preventDefault();
    newLineAtEnd(view);
  });

  return {
    view,
    get value() { return prefix + view.state.doc.toString(); },
    flush: () => save.flush(),
    setDoc(doc, nextPrefix = prefix) {
      save.cancel();
      prefix = nextPrefix;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: 0 },
      });
    },
    setNote(note) { this.setDoc(note.body, note.raw.slice(0, note.raw.length - note.body.length)); },
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
      // Full vault path, not the basename: two folders can hold a file of the same name.
      const link = media ? `![[${saved.path}]]` : `[${saved.name}](${encodeURI(saved.path)})`;
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
