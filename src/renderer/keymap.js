// Keybindings. One place that owns "which keystroke runs which command", so the
// settings panel can rebind anything without hunting through handlers.
// Guarded so the module can be imported outside a browser (the tests do).
const MAC = typeof navigator !== 'undefined'
  && /mac/i.test(navigator.platform || navigator.userAgent || '');

export const DEFAULT_KEYS = {
  'palette.omni': 'Mod+K',
  'palette.files': 'Mod+O',
  'palette.commands': 'Mod+P',
  'note.new': 'Mod+N',
  'note.daily': 'Mod+Shift+D',
  'db.new': 'Mod+Shift+N',
  'view.search': 'Mod+Shift+F',
  'view.graph': 'Mod+G',
  'view.localGraph': 'Mod+Shift+G',
  'view.sidebar': 'Mod+B',
  'view.rail': 'Mod+Shift+B',
  'app.settings': 'Mod+,',
  'vault.pick': 'Mod+Shift+O',
  'editor.highlight': 'Mod+Shift+H',
  'editor.bold': 'Mod+Alt+B',
  'editor.italic': 'Mod+Alt+I',
  'tab.close': 'Mod+W',
  'tab.next': 'Ctrl+Tab',
  'tab.prev': 'Ctrl+Shift+Tab',
};

// Human-readable, platform-correct.
export function label(binding) {
  if (!binding) return '';
  return binding
    .replace('Mod', MAC ? '⌘' : 'Ctrl')
    .replace('Alt', MAC ? '⌥' : 'Alt')
    .replace('Shift', MAC ? '⇧' : 'Shift')
    .split('+')
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join(MAC ? '' : ' + ');
}

// Canonical form of a live keydown, so it can be compared to a binding string.
export function fromEvent(e) {
  const key = e.key;
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return null;
  const parts = [];
  if (MAC ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (!MAC && e.metaKey) parts.push('Meta');
  if (MAC && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

// `Ctrl+Tab` has to keep working on both platforms, so compare loosely on the
// control modifier when a binding asks for literal Ctrl.
function normalise(binding) {
  return binding.split('+').map((p) => (p.length === 1 ? p.toUpperCase() : p)).join('+');
}

export class Keymap {
  constructor(app) {
    this.app = app;
    this.keys = { ...DEFAULT_KEYS };
  }

  load(saved) {
    this.keys = { ...DEFAULT_KEYS, ...(saved || {}) };
    this.index();
  }

  index() {
    this.byBinding = new Map();
    for (const [cmd, binding] of Object.entries(this.keys)) {
      if (binding) this.byBinding.set(normalise(binding), cmd);
    }
  }

  set(cmd, binding) {
    if (binding) {
      // A binding belongs to one command; taking it frees the previous owner.
      const owner = this.byBinding.get(normalise(binding));
      if (owner && owner !== cmd) this.keys[owner] = '';
    }
    this.keys[cmd] = binding || '';
    this.index();
    return this.keys;
  }

  reset() {
    this.keys = { ...DEFAULT_KEYS };
    this.index();
    return this.keys;
  }

  // Returns the command id for a keydown, or null.
  lookup(e) {
    const combo = fromEvent(e);
    if (!combo) return null;
    return this.byBinding.get(normalise(combo))
      || this.byBinding.get(normalise(combo.replace('Mod', 'Ctrl')))
      || null;
  }
}
