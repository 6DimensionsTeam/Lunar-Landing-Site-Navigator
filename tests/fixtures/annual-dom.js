// A small DOM fixture for this module's standard element/event operations. It
// models capture/bubble ordering and asynchronous attribute observations, the
// boundaries that matter when the calendar shares P1's existing selection root.
const observations = new Set();
export class AttributeObserver {
  constructor(callback) { this.callback = callback; this.pending = false; }
  observe(target, options) { this.target = target; this.options = options; observations.add(this); }
  disconnect() { observations.delete(this); }
}
function changed(target, name) {
  for (const observer of observations) {
    if (observer.target !== target || !observer.options.attributeFilter.includes(name) || observer.pending) continue;
    observer.pending = true;
    queueMicrotask(() => {
      observer.pending = false;
      if (observations.has(observer)) observer.callback([{ target, attributeName: name }]);
    });
  }
}
const dataKey = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument;
    this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map();
    this.handlers = new Map(); this.classes = new Set(); this.inert = false; this.disabled = false;
    this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] ?? ''; } };
    this.open = false;
    this._hidden = false; this._text = ''; this.tabIndex = -1;
    this.classList = {
      contains: name => this.classes.has(name),
      add: (...names) => { const before = this.className; names.forEach(name => this.classes.add(name)); if (before !== this.className) changed(this, 'class'); },
      remove: (...names) => { const before = this.className; names.forEach(name => this.classes.delete(name)); if (before !== this.className) changed(this, 'class'); },
      toggle: (name, on) => { const value = on ?? !this.classes.has(name); this.classList[value ? 'add' : 'remove'](name); return value; },
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); changed(this, 'class'); }
  get hidden() { return this._hidden; }
  set hidden(value) { const next = Boolean(value); if (next !== this._hidden) { this._hidden = next; changed(this, 'hidden'); } }
  get open() { return this.attributes.has('open'); }
  set open(value) { if (value) this.attributes.set('open', ''); else this.attributes.delete('open'); }
  get firstElementChild() { return this.children[0] ?? null; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = String(value); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  append(...children) {
    for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classes.has(name)) return false;
    for (const [, name, expected] of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
      const value = name.startsWith('data-') ? this.dataset[dataKey(name.slice(5))] : this.getAttribute(name);
      if (value == null || (expected !== undefined && value !== expected)) return false;
    }
    return true;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() {
    for (let node = this; node; node = node.parentElement) if (node.hidden || node.inert) return;
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView(options) { this.scrolled = true; (this.scrollCalls ??= []).push(options); }
  addEventListener(type, handler, options = {}) {
    const entries = this.handlers.get(type) ?? [];
    entries.push({ handler, capture: options === true || options.capture === true }); this.handlers.set(type, entries);
  }
  removeEventListener(type, handler) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter(entry => entry.handler !== handler)); }
  dispatch(type, props = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false, immediate: false, ...props,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    const path = []; for (let node = this; node; node = node.parentElement) path.push(node);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const entry of node.handlers.get(type) ?? []) {
        if (entry.capture === capture) entry.handler(event);
        if (event.immediate) break;
      }
    };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) return event; }
    for (const node of path) { invoke(node, false); if (event.stopped) break; }
    return event;
  }
  click() { this.focus(); return this.dispatch('click'); }
  press(key) {
    const event = this.dispatch('keydown', { key });
    // Native buttons activate on Enter even when propagation is stopped.
    if (key === 'Enter' && this.tagName === 'BUTTON' && !event.defaultPrevented) this.click();
    return event;
  }
}
export class Document {
  constructor(width = 1280) {
    this.body = new Element('body', this); this.activeElement = this.body;
    this.defaultView = { innerWidth: width, matchMedia: query => ({
      matches: this.defaultView.innerWidth <= Number(query.match(/max-width:\s*(\d+)px/)?.[1]),
    }) };
  }
  createElement(name) { return new Element(name, this); }
  createElementNS(namespace, name) { const element = new Element(name, this); element.namespaceURI = namespace; return element; }
}
export const flushAttributes = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
