// Entorno mínimo de navegador para ejecutar los módulos ES de la app en Node.
import "fake-indexeddb/auto";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.window = globalThis;
if (typeof globalThis.window.addEventListener !== "function") globalThis.window.addEventListener = () => {};
if (typeof globalThis.window.removeEventListener !== "function") globalThis.window.removeEventListener = () => {};
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
if (!globalThis.navigator) globalThis.navigator = {};

if (!globalThis.Event) {
  globalThis.Event = class Event {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}
if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class CustomEvent extends globalThis.Event {};
}
if (!globalThis.KeyboardEvent) {
  globalThis.KeyboardEvent = class KeyboardEvent extends (globalThis.Event || Object) {
    constructor(type, init = {}) {
      super(type, init);
      this.key = init.key || "";
      this.code = init.code || "";
      this.ctrlKey = Boolean(init.ctrlKey);
      this.metaKey = Boolean(init.metaKey);
      this.shiftKey = Boolean(init.shiftKey);
      this.altKey = Boolean(init.altKey);
    }
  };
}
if (!globalThis.MouseEvent) {
  globalThis.MouseEvent = class MouseEvent extends globalThis.Event {};
}

function splitSelectorOutsideBrackets(sel, sepChar) {
  const parts = [];
  let inBracket = false;
  let quote = "";
  let start = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel[i];
    if (quote) {
      if (ch === quote && sel[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      inBracket = true;
    } else if (ch === "]") {
      inBracket = false;
    } else if (!inBracket && ch === sepChar) {
      parts.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sel.slice(start));
  return parts;
}

function tokenizeComplexSelector(complexSel) {
  const tokens = [];
  let inBracket = false;
  let quote = "";
  let buf = "";

  const flushBuf = () => {
    const trimmed = buf.trim();
    if (trimmed) tokens.push(trimmed);
    buf = "";
  };

  for (let i = 0; i < complexSel.length; i += 1) {
    const ch = complexSel[i];
    if (quote) {
      buf += ch;
      if (ch === quote && complexSel[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "[") {
      inBracket = true;
      buf += ch;
    } else if (ch === "]") {
      inBracket = false;
      buf += ch;
    } else if (!inBracket && ch === ">") {
      flushBuf();
      if (tokens[tokens.length - 1] === " ") tokens.pop();
      tokens.push(">");
    } else if (!inBracket && /\s/.test(ch)) {
      flushBuf();
      const prev = tokens[tokens.length - 1];
      if (prev && prev !== ">" && prev !== " ") {
        tokens.push(" ");
      }
    } else {
      buf += ch;
    }
  }
  flushBuf();
  if (tokens[tokens.length - 1] === " ") tokens.pop();
  return tokens;
}

function matchesCompoundSelector(el, compound) {
  if (!el || !compound) return false;
  if (compound === "*") return true;
  const parts = compound.match(/(\.[^.#[\]]+|#[^.#[\]]+|\[[^\]]+\]|^[^.#[\]]+)/g) || [compound];
  for (const part of parts) {
    if (part.startsWith(".")) {
      if (!el.classList.contains(part.slice(1))) return false;
    } else if (part.startsWith("#")) {
      if (el.id !== part.slice(1)) return false;
    } else if (part.startsWith("[") && part.endsWith("]")) {
      const inner = part.slice(1, -1);
      const eqIdx = inner.indexOf("=");
      if (eqIdx === -1) {
        if (!el.attributes.has(inner.trim())) return false;
      } else {
        const attr = inner.slice(0, eqIdx).trim();
        const val = inner.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (el.getAttribute(attr) !== val) return false;
      }
    } else if (part !== "*") {
      if (el.tagName.toLowerCase() !== part.toLowerCase()) return false;
    }
  }
  return true;
}

function matchesTokenChain(el, tokens, idx) {
  if (!el || idx < 0) return false;
  if (!matchesCompoundSelector(el, tokens[idx])) return false;
  if (idx === 0) return true;
  const combinator = tokens[idx - 1];
  if (combinator === ">") {
    return matchesTokenChain(el.parentElement, tokens, idx - 2);
  }
  if (combinator === " ") {
    let anc = el.parentElement;
    while (anc) {
      if (matchesTokenChain(anc, tokens, idx - 2)) return true;
      anc = anc.parentElement;
    }
    return false;
  }
  return false;
}

class MockElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.classList = {
      _classes: new Set(),
      add: (...classes) => {
        for (const c of classes) {
          if (c) this.classList._classes.add(String(c));
        }
      },
      remove: (...classes) => {
        for (const c of classes) {
          if (c) this.classList._classes.delete(String(c));
        }
      },
      contains: (c) => this.classList._classes.has(c),
      toggle: (c, val) => {
        if (val === undefined) val = !this.classList.contains(c);
        if (val) this.classList.add(c); else this.classList.remove(c);
        return val;
      }
    };
    this.attributes = new Map();
    this.style = {
      setProperty: (k, v) => { this.style[k] = String(v); },
      removeProperty: (k) => { delete this.style[k]; },
      getPropertyValue: (k) => this.style[k] || ""
    };
    this.value = "";
    this._innerHTML = "";
    this._textContent = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._listeners = new Map();
  }
  get className() {
    return Array.from(this.classList._classes).join(" ");
  }
  set className(v) {
    this.classList._classes.clear();
    String(v || "").trim().split(/\s+/).filter(Boolean).forEach(c => this.classList._classes.add(c));
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    for (const ch of this.children) {
      if (ch && ch.parentElement === this) {
        ch.parentElement = null;
      }
    }
    this.children = [];
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); }
  appendChild(child) {
    if (child) child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) { children.forEach(c => this.appendChild(c)); }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) {
      this.children.splice(i, 1);
      if (child) child.parentElement = null;
    }
    return child;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
  }
  contains(child) { return this.children.includes(child); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    if (this._listeners.has(type)) {
      this._listeners.set(type, this._listeners.get(type).filter((f) => f !== fn));
    }
  }
  dispatchEvent(event) {
    if (!event) return true;
    let propagationStopped = false;
    let immediateStopped = false;
    const origStop = typeof event.stopPropagation === "function" ? event.stopPropagation.bind(event) : null;
    const origStopImm =
      typeof event.stopImmediatePropagation === "function" ? event.stopImmediatePropagation.bind(event) : null;

    try {
      Object.defineProperty(event, "target", { value: this, configurable: true });
    } catch (_) {}
    try {
      Object.defineProperty(event, "stopPropagation", {
        value: () => {
          propagationStopped = true;
          origStop?.();
        },
        configurable: true
      });
      Object.defineProperty(event, "stopImmediatePropagation", {
        value: () => {
          propagationStopped = true;
          immediateStopped = true;
          origStopImm?.();
        },
        configurable: true
      });
    } catch (_) {}

    let current = this;
    while (current) {
      try {
        Object.defineProperty(event, "currentTarget", { value: current, configurable: true });
      } catch (_) {}
      const list = current._listeners?.get(event.type || "");
      if (list && list.length > 0) {
        for (const fn of [...list]) {
          fn.call(current, event);
          if (immediateStopped) break;
        }
      }
      if (propagationStopped || !event.bubbles) {
        break;
      }
      current = current.parentElement || null;
    }
    return !event.defaultPrevented;
  }
  click() {
    this.dispatchEvent({ type: "click", bubbles: true, target: this, stopPropagation: () => {} });
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k.startsWith("data-")) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }
  removeAttribute(k) {
    this.attributes.delete(k);
    if (k.startsWith("data-")) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      delete this.dataset[camel];
    }
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  getAttribute(k) { return this.attributes.get(k) || null; }
  setRangeText(text, start, end) {
    const s = start !== undefined ? start : (this.selectionStart || 0);
    const e = end !== undefined ? end : (this.selectionEnd || 0);
    this.value = this.value.slice(0, s) + text + this.value.slice(e);
  }
  setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
  focus() {}
  matches(sel) {
    if (!sel || typeof sel !== "string") return false;
    const branches = splitSelectorOutsideBrackets(sel, ",");
    for (const branch of branches) {
      const trimmed = branch.trim();
      if (!trimmed) continue;
      const tokens = tokenizeComplexSelector(trimmed);
      if (tokens.length > 0 && matchesTokenChain(this, tokens, tokens.length - 1)) {
        return true;
      }
    }
    return false;
  }
  closest(sel) {
    let current = this;
    while (current) {
      if (typeof current.matches === "function" && current.matches(sel)) {
        return current;
      }
      current = current.parentElement || null;
    }
    return null;
  }
  querySelector(sel) {
    for (const ch of this.children) {
      if (ch instanceof MockElement) {
        if (ch.matches(sel)) return ch;
        const res = ch.querySelector(sel);
        if (res) return res;
      }
    }
    return null;
  }
  querySelectorAll(sel) {
    const list = [];
    for (const ch of this.children) {
      if (ch instanceof MockElement) {
        if (ch.matches(sel)) list.push(ch);
        list.push(...ch.querySelectorAll(sel));
      }
    }
    return list;
  }
}

const htmlElement = new MockElement("html");
const bodyElement = new MockElement("body");
htmlElement.appendChild(bodyElement);

function findElementById(node, id) {
  if (node.id === id) return node;
  for (const ch of node.children || []) {
    if (ch instanceof MockElement) {
      const found = findElementById(ch, id);
      if (found) return found;
    }
  }
  return null;
}

globalThis.document = {
  documentElement: htmlElement,
  body: bodyElement,
  createElement: (tag) => new MockElement(tag),
  getElementById: (id) => findElementById(htmlElement, id),
  querySelector: (sel) => htmlElement.querySelector(sel),
  querySelectorAll: (sel) => htmlElement.querySelectorAll(sel)
};

/** Generador pseudoaleatorio reproducible (mulberry32) para fuzzing determinista. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
