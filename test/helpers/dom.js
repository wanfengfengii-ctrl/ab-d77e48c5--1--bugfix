/**
 * 极简 DOM 桩：仅实现 public/app.js 启动与交互所需的 API，
 * 不追求完整 DOM 语义，只为在 Node 中驱动真实前端代码。
 */

class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.s.has(c) : force;
    this.on ? this.s.add(c) : this.s.delete(c);
    return on;
  }
  contains(c) { return this.s.has(c); }
}

function parseSelector(sel) {
  // 支持 '#id'、'.cls'、'[attr="v"]' 及其简单组合，选择器间空格表示后代
  return sel.trim().split(/\s+/).map((part) => {
    const m = { id: null, cls: [], attr: null, tag: null };
    const rest = part
      .replace(/#([\w-]+)/g, (_, id) => { m.id = id; return ''; })
      .replace(/\.([\w-]+)/g, (_, c) => { m.cls.push(c); return ''; })
      .replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, a, v) => {
        m.attr = [a, v ?? '', v !== undefined]; return '';
      });
    if (rest) m.tag = rest;
    return m;
  });
}

function matchEl(el, m) {
  if (m.id && el.id !== m.id) return false;
  if (m.tag && el.tagName.toLowerCase() !== m.tag.toLowerCase()) return false;
  if (m.cls.some((c) => !el.classList.contains(c))) return false;
  if (m.attr) {
    const [a, v, hasValue] = m.attr;
    if (a.startsWith('data-')) {
      const key = a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const actual = el.dataset[key];
      if (actual === undefined) return false;
      if (hasValue && String(actual) !== v) return false;
    } else {
      if (!(a in el.attrs)) return false;
      if (hasValue && el.attrs[a] !== v) return false;
    }
  }
  return true;
}

export class El {
  constructor(tagName, ns = null) {
    this.tagName = tagName;
    this.namespaceURI = ns;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this._listeners = {};
    this._html = '';
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.id = '';
  }

  set className(v) {
    this.classList = new ClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  get className() { return [...this.classList.s].join(' '); }

  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() { return this._html; }

  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k.startsWith('data-')) {
      this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    }
  }
  getAttribute(k) { return this.attrs[k] ?? null; }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  dispatch(type, ev = {}) {
    for (const fn of this._listeners[type] || []) fn(ev);
  }

  _walk() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c._walk()); }
    return out;
  }

  querySelector(sel) {
    const chain = parseSelector(sel);
    const all = this._walk();
    outer: for (const el of all) {
      let cur = el;
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!cur || !matchEl(cur, chain[i])) continue outer;
        cur = cur.parent;
      }
      return el;
    }
    return null;
  }

  closest(sel) {
    const m = parseSelector(sel)[0];
    let cur = this;
    while (cur) { if (matchEl(cur, m)) return cur; cur = cur.parent; }
    return null;
  }
}

export function installDom() {
  const registry = new Map();
  const ensure = (sel) => {
    if (!registry.has(sel)) {
      const tag = sel.startsWith('#lineage-svg') ? 'svg' : 'div';
      const el = new El(tag);
      el.id = sel.replace(/^#/, '').split(' ')[0];
      registry.set(sel, el);
    }
    return registry.get(sel);
  };

  const documentStub = {
    querySelector(sel) {
      if (registry.has(sel)) return registry.get(sel);
      // 后代选择器：在所有已注册根中搜索
      for (const root of registry.values()) {
        const hit = root.querySelector(sel);
        if (hit) return hit;
      }
      // 未知简单选择器：惰性创建，避免初始化报错
      return ensure(sel);
    },
    createElement(tag) { return new El(tag); },
    createElementNS(ns, tag) { return new El(tag, ns); },
  };

  const store = new Map();
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  globalThis.document = documentStub;
  globalThis.localStorage = localStorageStub;
  globalThis.window = globalThis;

  return {
    el: (sel) => documentStub.querySelector(sel),
    byId: (id) => documentStub.querySelector(`#${id}`),
    count: (container, tag) => container._walk().filter((e) => e.tagName === tag).length,
    localStorage: localStorageStub,
  };
}
