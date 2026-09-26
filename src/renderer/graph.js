// Graph view. Canvas 2D plus a small force simulation - a graph library would
// be 200kB to draw circles and lines we can draw ourselves.
//
// ponytail: repulsion is naive O(n^2), which is fine to roughly 1500 notes at
// 60fps. Swap in a Barnes-Hut quadtree if a vault ever outgrows that; the rest
// of the loop does not change.
import { h } from './dbview.js';

// Gentle, linear forces and real friction: the layout settles in about two
// seconds instead of orbiting. Centre pull is a plain fraction of the distance;
// scaling it by window size is what crushed everything into a clump before.
const REPULSION = 2600;
const SPRING = 0.04;
const SPRING_LEN = 90;
const CENTER = 0.012;
const DAMPING = 0.6;
const COOLING = 0.975;
const MAX_STEP = 18;

function hue(seed) {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
  return n % 360;
}

export class GraphView {
  constructor(host, app, opts = {}) {
    this.host = host;
    this.app = app;
    this.mode = opts.mode || 'global'; // 'global' | 'local'
    this.showTags = false;
    this.depth = 1;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.nodes = [];
    this.edges = [];
    this.hover = null;
    this.drag = null;
    this.alpha = 1;
    // Fit to the screen while settling, until the user pans or zooms.
    this.userMoved = false;
    this.render();
  }

  destroy() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
  }

  async render() {
    this.canvas = h('canvas', { class: 'graph-canvas' });
    this.label = h('div', { class: 'graph-label' });
    this.host.replaceChildren(this.toolbar(), h('div', { class: 'graph-stage' }, [this.canvas, this.label]));
    this.ctx = this.canvas.getContext('2d');
    this.bind();
    await this.load();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentNode);
    this.loop();
  }

  toolbar() {
    const seg = (name, label) => h('button', {
      class: 'db-tab' + (this.mode === name ? ' is-active' : ''), text: label,
      onclick: () => { this.mode = name; this.reload(); },
    });
    return h('div', { class: 'db-toolbar' }, [
      h('div', { class: 'db-title' }, [
        h('span', { class: 'db-icon', text: '\u{1F578}\uFE0F' }),
        h('span', { class: 'db-name-static', text: 'Map of notes' }),
        h('span', { class: 'db-source graph-count' }),
      ]),
      h('div', { class: 'db-tabs' }, [seg('global', 'Everything'), seg('local', 'Around this page')]),
      h('div', { class: 'db-actions' }, [
        h('label', { class: 'graph-toggle' }, [
          h('input', {
            type: 'checkbox', checked: this.showTags,
            onchange: (e) => { this.showTags = e.target.checked; this.reload(); },
          }),
          h('span', { text: 'Show tags' }),
        ]),
        h('button', {
          class: 'btn', text: 'Fit to screen',
          onclick: () => { this.userMoved = false; this.recentre(); },
        }),
      ]),
    ]);
  }

  async reload() {
    await this.load();
    this.host.replaceChildren(this.toolbar(), this.host.lastChild);
    this.alpha = 1;
  }

  async load() {
    const g = await window.newEra.index.graph({ includeTags: this.showTags });
    let { nodes, edges } = g;

    if (this.mode === 'local') {
      const root = this.app.lastNotePath || null;
      if (root) {
        // Grow one ring at a time. Adding straight into `near` inside the
        // loop would let a node found this pass recruit its own neighbours,
        // so depth 1 would quietly behave like depth N.
        const near = new Set([root]);
        for (let d = 0; d < this.depth; d++) {
          const ring = [];
          for (const e of edges) {
            if (near.has(e.s) && !near.has(e.t)) ring.push(e.t);
            else if (near.has(e.t) && !near.has(e.s)) ring.push(e.s);
          }
          for (const id of ring) near.add(id);
        }
        nodes = nodes.filter((n) => near.has(n.id));
        edges = edges.filter((e) => near.has(e.s) && near.has(e.t));
      }
    }

    // Keep positions across reloads so the layout does not jump.
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const w = this.canvas.width / (window.devicePixelRatio || 1) || 800;
    const hgt = this.canvas.height / (window.devicePixelRatio || 1) || 600;
    this.nodes = nodes.map((n, i) => {
      const old = prev.get(n.id);
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        ...n,
        x: old ? old.x : w / 2 + Math.cos(angle) * (60 + nodes.length * 1.6),
        y: old ? old.y : hgt / 2 + Math.sin(angle) * (60 + nodes.length * 1.6),
        vx: 0,
        vy: 0,
        r: 7 + Math.min(12, Math.sqrt(n.degree) * 3),
      };
    });
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = edges.map((e) => ({ a: byId.get(e.s), b: byId.get(e.t) })).filter((e) => e.a && e.b);
    this.byId = byId;
    const count = this.host.querySelector('.graph-count');
    if (count) count.textContent = `${this.nodes.length} pages · ${this.edges.length} links`;
    this.alpha = 1;
    this.userMoved = false;
  }

  resize() {
    const box = this.canvas.parentNode.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, box.width * dpr);
    this.canvas.height = Math.max(1, box.height * dpr);
    this.canvas.style.width = box.width + 'px';
    this.canvas.style.height = box.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = box.width;
    this.hgt = box.height;
  }

  // --- interaction ---------------------------------------------------------

  toWorld(clientX, clientY) {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - box.left - this.ox) / this.scale,
      y: (clientY - box.top - this.oy) / this.scale,
    };
  }

  at(px, py) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.x - px;
      const dy = n.y - py;
      if (dx * dx + dy * dy < (n.r + 6) ** 2) return n;
    }
    return null;
  }

  bind() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      const p = this.toWorld(e.clientX, e.clientY);
      const n = this.at(p.x, p.y);
      this.drag = n ? { node: n, moved: false } : { pan: true, x: e.clientX, y: e.clientY, moved: false };
      if (n) n.pinned = true;
    });

    window.addEventListener('mousemove', (e) => {
      const p = this.toWorld(e.clientX, e.clientY);
      if (this.drag) {
        this.drag.moved = true;
        if (this.drag.pan) {
          this.userMoved = true;
          this.ox += e.clientX - this.drag.x;
          this.oy += e.clientY - this.drag.y;
          this.drag.x = e.clientX;
          this.drag.y = e.clientY;
        } else {
          this.drag.node.x = p.x;
          this.drag.node.y = p.y;
          this.alpha = Math.max(this.alpha, 0.35);
        }
        return;
      }
      if (!c.isConnected) return;
      const was = this.hover;
      this.hover = this.at(p.x, p.y);
      c.style.cursor = this.hover ? 'pointer' : 'grab';
      if (this.hover !== was) this.paintLabel(e.clientX, e.clientY);
      else if (this.hover) this.paintLabel(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
      if (this.drag && this.drag.node) this.drag.node.pinned = false;
      this.drag = null;
    });

    c.addEventListener('click', (e) => {
      const p = this.toWorld(e.clientX, e.clientY);
      const n = this.at(p.x, p.y);
      if (!n || n.ghost || n.tag) return;
      this.app.openNote(n.id);
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.userMoved = true;
      const box = c.getBoundingClientRect();
      const mx = e.clientX - box.left;
      const my = e.clientY - box.top;
      const next = Math.min(4, Math.max(0.2, this.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      this.ox = mx - (mx - this.ox) * (next / this.scale);
      this.oy = my - (my - this.oy) * (next / this.scale);
      this.scale = next;
    }, { passive: false });
  }

  paintLabel(cx, cy) {
    if (!this.hover) { this.label.style.display = 'none'; return; }
    this.label.style.display = 'block';
    this.label.textContent = this.hover.title + (this.hover.ghost ? '  (not created)' : '');
    const box = this.canvas.getBoundingClientRect();
    this.label.style.left = (cx - box.left + 14) + 'px';
    this.label.style.top = (cy - box.top + 14) + 'px';
  }

  recentre() {
    if (!this.nodes.length) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 90;
    this.scale = Math.min(1.8, Math.min(
      this.w / Math.max(1, maxX - minX + pad * 2),
      this.hgt / Math.max(1, maxY - minY + pad * 2)));
    this.ox = this.w / 2 - ((minX + maxX) / 2) * this.scale;
    this.oy = this.hgt / 2 - ((minY + maxY) / 2) * this.scale;
  }

  // --- simulation + paint --------------------------------------------------

  step() {
    const ns = this.nodes;
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = 4; }
        if (d2 > 260000) continue; // far enough to ignore
        const f = REPULSION / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    for (const e of this.edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - SPRING_LEN) * SPRING;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      e.a.vx += fx; e.a.vy += fy;
      e.b.vx -= fx; e.b.vy -= fy;
    }
    const cx = (this.w || 800) / 2;
    const cy = (this.hgt || 600) / 2;
    for (const n of ns) {
      n.vx = (n.vx + (cx - n.x) * CENTER) * DAMPING;
      n.vy = (n.vy + (cy - n.y) * CENTER) * DAMPING;
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.x += Math.max(-MAX_STEP, Math.min(MAX_STEP, n.vx * this.alpha));
      n.y += Math.max(-MAX_STEP, Math.min(MAX_STEP, n.vy * this.alpha));
    }
    this.alpha = Math.max(0.02, this.alpha * COOLING);
  }

  neighbours(node) {
    const set = new Set([node.id]);
    for (const e of this.edges) {
      if (e.a === node) set.add(e.b.id);
      else if (e.b === node) set.add(e.a.id);
    }
    return set;
  }

  paint() {
    const ctx = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#7c9cff';
    const faint = css.getPropertyValue('--text-faint').trim() || '#6a6a6a';
    const text = css.getPropertyValue('--text').trim() || '#dcdcdc';

    ctx.clearRect(0, 0, this.w, this.hgt);
    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    const near = this.hover ? this.neighbours(this.hover) : null;
    const activePath = this.app.lastNotePath || null;

    ctx.lineWidth = 1 / this.scale + 0.4;
    for (const e of this.edges) {
      const lit = near && (near.has(e.a.id) && near.has(e.b.id));
      ctx.strokeStyle = lit ? accent : faint;
      ctx.globalAlpha = near ? (lit ? 0.85 : 0.12) : 0.3;
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();
    }

    for (const n of this.nodes) {
      const lit = !near || near.has(n.id);
      ctx.globalAlpha = lit ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      if (n.ghost) {
        ctx.strokeStyle = faint;
        ctx.lineWidth = 1.4 / this.scale + 0.6;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = n.tag ? faint : `hsl(${hue(n.folder || n.title)} 62% 62%)`;
        ctx.fill();
      }
      if (n.id === activePath) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.5 / this.scale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels only when zoomed in enough to read them, or on hover.
    if (this.scale > 0.75 || this.hover) {
      ctx.font = `700 ${13 / this.scale}px ${css.getPropertyValue('--font-text') || 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = text;
      for (const n of this.nodes) {
        const lit = !near || near.has(n.id);
        if (!lit && this.scale <= 0.75) continue;
        ctx.globalAlpha = lit ? 0.9 : 0.15;
        const label = n.title.length > 24 ? n.title.slice(0, 23) + '…' : n.title;
        ctx.fillText(label, n.x, n.y + n.r + 16 / this.scale);
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  loop() {
    if (this.stopped || !this.canvas.isConnected) return;
    if (this.alpha > 0.03 || this.drag) {
      this.step();
      if (!this.userMoved && !this.drag) this.recentre();
    }
    this.paint();
    this.raf = requestAnimationFrame(() => this.loop());
  }
}
