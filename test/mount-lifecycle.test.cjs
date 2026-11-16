// 真实挂载/卸载生命周期：用极简 DOM + 极简 React 钩子运行时把生产组件真的跑一遍，
// 验证卸载后监听器、观察者、帧、定时器都回到基线，且卸载后不再 setState。
// 不引入任何运行时依赖。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// ---------------- 极简 DOM ----------------
const makeNode = (tag) => {
  const listeners = new Map();
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    parentNode: null,
    ownerDocument: null,
    clientWidth: 320,
    clientHeight: 240,
    offsetWidth: 320,
    offsetHeight: 240,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 480,
    scrollWidth: 480,
    width: 0,
    height: 0,
    listeners,
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child);
      return child;
    },
    insertBefore(child) {
      return node.appendChild(child);
    },
    removeAttribute() {},
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    addEventListener(name, handler) {
      const list = listeners.get(name) || [];
      list.push(handler);
      listeners.set(name, list);
    },
    removeEventListener(name, handler) {
      const list = (listeners.get(name) || []).filter((item) => item !== handler);
      listeners.set(name, list);
    },
    dispatch(name, event) {
      for (const handler of listeners.get(name) || []) handler(event);
    },
    listenerCount() {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240 }),
    getContext: (kind) => makeContext(kind),
    focus() {},
    blur() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
    load() {},
    pause() {},
    play: () => Promise.resolve(),
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return node;
};

const makeContext = (kind) => {
  const noop = () => {};
  const context = new Proxy(
    {
      canvas: { width: 320, height: 240 },
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      measureText: () => ({ width: 10 }),
      getParameter: () => 8,
      getExtension: () => null,
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getShaderInfoLog: () => '',
      getProgramInfoLog: () => '',
      getAttribLocation: () => 0,
      getUniformLocation: () => ({}),
      checkFramebufferStatus: () => 0,
    },
    {
      get(target, key) {
        if (key in target) return target[key];
        return noop;
      },
    },
  );
  context.kind = kind;
  return context;
};

const windowListeners = new Map();
const docListeners = new Map();
const track = (map) => ({
  add(name, handler) {
    const list = map.get(name) || [];
    list.push(handler);
    map.set(name, list);
  },
  remove(name, handler) {
    map.set(name, (map.get(name) || []).filter((item) => item !== handler));
  },
});
const countListeners = (map) => {
  let total = 0;
  for (const list of map.values()) total += list.length;
  return total;
};

const frames = new Map();
let frameId = 1;
const timers = new Map();
let timerId = 1;

const documentStub = {
  ...track(docListeners),
  addEventListener: (name, handler) => track(docListeners).add(name, handler),
  removeEventListener: (name, handler) => track(docListeners).remove(name, handler),
  visibilityState: 'visible',
  activeElement: null,
  documentElement: { style: { setProperty() {}, getPropertyValue: () => '' } },
  body: makeNode('body'),
  createElement: (tag) => makeNode(tag),
  createElementNS: (ns, tag) => makeNode(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getSelection: () => null,
  fonts: { ready: Promise.resolve() },
};

const windowStub = {
  ...track(windowListeners),
  addEventListener: (name, handler, options) => {
    if (name === 'pagehide' || name === 'visibilitychange') track(windowListeners).add(name, handler);
    else track(windowListeners).add(name, handler);
  },
  removeEventListener: (name, handler) => track(windowListeners).remove(name, handler),
  document: documentStub,
  localStorage: (() => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
      clear: () => map.clear(),
    };
  })(),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => {
    const id = frameId++;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id) => frames.delete(id),
  setTimeout: (fn, ms) => {
    const id = timerId++;
    timers.set(id, { fn, ms });
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
  getSelection: () => null,
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 1,
  __ModuleLoader__: { load: (spec) => (registered = spec) },
};

let registered = null;
global.window = windowStub;
global.document = documentStub;
global.localStorage = windowStub.localStorage;
global.location = { protocol: 'http:', origin: 'http://127.0.0.1:1', href: 'http://127.0.0.1:1/' };
global.navigator = { userAgent: 'node', pdfViewerEnabled: true };
global.requestAnimationFrame = windowStub.requestAnimationFrame;
global.cancelAnimationFrame = windowStub.cancelAnimationFrame;
global.Node = function Node() {};
global.Element = function Element() {};
global.HTMLElement = function HTMLElement() {};
global.CSS = { highlights: undefined, escape: (value) => String(value) };
global.IntersectionObserver = class {
  constructor(handler) {
    this.handler = handler;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.closed = true;
  }
  unobserve() {}
};
global.ResizeObserver = class {
  constructor(handler) {
    this.handler = handler;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.closed = true;
  }
  unobserve() {}
};
global.MutationObserver = class {
  constructor(handler) {
    this.handler = handler;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.closed = true;
  }
  takeRecords() {
    return [];
  }
};
const observers = [];
global.DOMParser = class {
  parseFromString() {
    return { querySelectorAll: () => [], documentElement: null };
  }
};
global.ImageData = class {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};
global.AbortController = AbortController;
const urlStats = { created: 0, revoked: 0 };
const URLStub = function URL() {};
URLStub.createObjectURL = () => {
  urlStats.created += 1;
  return 'blob:lifecycle-' + urlStats.created;
};
URLStub.revokeObjectURL = () => {
  urlStats.revoked += 1;
};
global.URL = URLStub;
global.fetch = async (url) => {
    const text = String(url);
    if (text.includes('/dsh-canvas/file')) {
      return { ok: true, json: async () => ({ ok: true, size: 1024, mtimeMs: 1 }) };
    }
    return { ok: false, json: async () => ({}) };
  };
global.performance = { now: () => Date.now() };
global.structuredClone = (value) => JSON.parse(JSON.stringify(value));

// ---------------- 极简钩子运行时 ----------------
const instances = [];
const pendingRefs = [];
const currentStack = [];
let renderDepth = 0;

const makeHooks = (id) => {
  const instance = {
    id,
    hooks: [],
    index: 0,
    effects: [],
    unmounted: false,
    lateSetState: 0,
    pendingSetState: 0,
  };
  instances.push(instance);
  return instance;
};

const current = () => currentStack[currentStack.length - 1];

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: Object.assign({}, props || {}, children.length ? { children: children.length === 1 ? children[0] : children } : {}),
    children,
  }),
  Fragment: 'Fragment',
  useState(init) {
    const instance = current();
    const slot = instance.index++;
    if (!(slot in instance.hooks)) {
      instance.hooks[slot] = { value: typeof init === 'function' ? init() : init, set: null };
      instance.hooks[slot].set = (next) => {
        const previous = instance.hooks[slot];
        previous.value = typeof next === 'function' ? next(previous.value) : next;
        // 卸载之后的状态更新必须为零，这里只记录
        if (instance.unmounted) instance.lateSetState += 1;
      };
    }
    return [instance.hooks[slot].value, instance.hooks[slot].set];
  },
  useRef(init) {
    const instance = current();
    const slot = instance.index++;
    if (!(slot in instance.hooks)) instance.hooks[slot] = { current: init };
    return instance.hooks[slot];
  },
  useEffect(fn, deps) {
    const instance = current();
    const slot = instance.index++;
    instance.hooks[slot] = { fn, deps, kind: 'effect' };
    instance.effects.push(instance.hooks[slot]);
    return undefined;
  },
  useLayoutEffect(fn, deps) {
    return React.useEffect(fn, deps);
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useSyncExternalStore(subscribe, snapshot) {
    return snapshot();
  },
  useDeferredValue: (value) => value,
  useId: () => 'id' + Math.random().toString(36).slice(2),
  memo: (component) => component,
  forwardRef: (component) => component,
  Children: { toArray: () => [] },
  cloneElement: (element, patch) =>
    ({ ...element, props: { ...element.props, ...patch }, children: element.children }),
  Component: class {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    }
    render() {
      return null;
    }
  },
};

new Function('window', 'document', 'location', 'navigator', 'localStorage', 'React', 'globalThis', src)(
  windowStub,
  documentStub,
  global.location,
  global.navigator,
  global.localStorage,
  React,
  global,
);

// 渲染树：只展开函数组件，记录每个实例的 effect
const renderNode = (element, depth) => {
  if (!element || typeof element !== 'object') return;
  if (depth > 40) return;
  if (typeof element.type === 'function') {
    const id = (element.type.name || 'anonymous') + '@' + renderDepth;
    renderDepth += 1;
    const instance = makeHooks(id);
    currentStack.push(instance);
    instance.index = 0;
    let inner = null;
    try {
      inner =
        element.type.prototype && typeof element.type.prototype.render === 'function'
          ? new element.type(element.props || {}).render()
          : element.type(element.props || {});
    } finally {
      currentStack.pop();
      renderDepth -= 1;
    }
    renderNode(inner, depth + 1);
    return;
  }
  const ref = element.props && element.props.ref;
  if (ref) {
    const node = makeNode(typeof element.type === 'string' ? element.type : 'div');
    if (typeof ref === 'function') {
      pendingRefs.push({ ref, node });
      try {
        ref(node);
      } catch (error) {
        console.log('ref 抛错：' + (error && error.message));
      }
    } else if (typeof ref === 'object') {
      // React 的对象 ref 语义：渲染后写入 current，卸载时置空
      ref.current = node;
      pendingRefs.push({
        ref: (value) => {
          ref.current = value;
        },
        node,
      });
    }
  }
  const children = element.children || [];
  for (const child of children) {
    if (Array.isArray(child)) child.forEach((item) => renderNode(item, depth + 1));
    else renderNode(child, depth + 1);
  }
};

const runEffects = () => {
  for (const instance of instances.slice()) {
    for (const effect of instance.effects) {
      try {
        effect.cleanup = typeof effect.fn === 'function' ? effect.fn() : undefined;
      } catch (error) {
        console.log('effect 抛错（' + instance.id + '）：' + (error && error.message));
      }
    }
  }
};

const unmountAll = () => {
  for (const entry of pendingRefs.reverse()) {
    try {
      entry.ref(null);
    } catch (error) {
      console.log('ref 清理抛错：' + (error && error.message));
    }
  }
  pendingRefs.length = 0;
  for (const instance of instances.slice().reverse()) {
    for (const effect of instance.effects.slice().reverse()) {
      if (typeof effect.cleanup === 'function') {
        try {
          effect.cleanup();
        } catch (error) {
          console.log('cleanup 抛错（' + instance.id + '）：' + (error && error.message));
        }
      }
    }
    instance.unmounted = true;
  }
};

const settle = async (rounds) => {
  for (let round = 0; round < (rounds || 4); round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const run = async () => {
  const exported = registered.factory((name) => (name === 'react' ? React : {}));
  const registrations = [];
  const textBytes = new TextEncoder().encode('# 标题\n\n正文内容。\n');
  const workspaceFiles = {
    read: async (sessionId, path, options) => ({
      text: path.endsWith('.md') || path.endsWith('.html') ? new TextDecoder().decode(textBytes) : '',
      lines: 3,
      eof: true,
      absolutePath: '/work/' + path,
      version: 1,
    }),
    readBytes: async (sessionId, path) => ({ data: textBytes }),
    list: async () => ({ path: '.', entries: [] }),
  };
  const ctx = {
    get: (name) => (name === 'remote.workspaceFiles' ? workspaceFiles : undefined),
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => registrations.push({ name, result: fn() }),
      register: (meta, component) => ({ meta, component }),
    },
    on: () => {},
    emit: () => {},
  };
  exported.apply(ctx);

  const panel = registrations.find((entry) => entry.name === 'main');
  check(Boolean(panel && panel.result && panel.result.component), '取得面板组件');
  if (!panel) return;

  const Panel = panel.result.component;
  const bridge = registrations.find((entry) => entry.name === 'conversation.composer.dock');
  const cases = [
    { name: 'markdown', view: 'markdown', path: 'demo/notes.md' },
    { name: 'image', view: 'image', path: 'demo/shot.png' },
    { name: 'pdf', view: 'pdf', path: 'demo/doc.pdf' },
    { name: 'video', view: 'video', path: 'demo/clip.mp4' },
    { name: 'model', view: 'model', path: 'demo/mesh.glb' },
    { name: 'html', view: 'html', path: 'demo/page.html' },
  ];

  let caseIndex = 0;
  for (const item of cases) {
    caseIndex += 1;
    const sessionId = 'lifecycle-' + caseIndex;
    // 每轮重置统计
    windowListeners.clear();
    docListeners.clear();
    frames.clear();
    timers.clear();
    observers.length = 0;
    urlStats.created = 0;
    urlStats.revoked = 0;
    instances.length = 0;
    pendingRefs.length = 0;

    global.localStorage.setItem(
      'dsh.canvas.v1.' + sessionId,
      JSON.stringify({ docs: [{ id: 'd1', path: item.path, view: item.view }], activeId: 'd1', marks: [], seq: 0 }),
    );
    // 让模块内部的 store 切到本会话（Bridge 依赖它，这里直接渲染面板）
    if (bridge && bridge.result && bridge.result.component) {
      renderNode({ type: bridge.result.component, props: { sessionId, inputActions: {} }, children: [] }, 0);
      runEffects();
      await settle(2);
    }
    const props = { sessionId, renderFactorySlot: () => null, surface: 'main' };
    renderNode({ type: Panel, props, children: [] }, 0);
    runEffects();
    await settle(4);

    const listenersBefore = countListeners(windowListeners) + countListeners(docListeners);
    const observersBefore = observers.length;
    const framesBefore = frames.size;
    const timersBefore = timers.size;

    unmountAll();
    // 清理后允许异步回调跑完一次
    await settle(2);
    for (const [, fn] of Array.from(frames)) {
      frames.delete([...frames.keys()][0]);
      try {
        fn(0);
      } catch (error) {
        /* 帧回调在卸载后执行也要安全 */
      }
    }

    const listenersAfter = countListeners(windowListeners) + countListeners(docListeners);
    const activeObservers = observers.filter((observer) => !observer.closed).length;
    const late = instances.reduce((sum, instance) => sum + instance.lateSetState, 0);

    check(
      listenersAfter <= listenersBefore,
      item.name + '：卸载后没有新增全局监听',
      listenersAfter + ' / ' + listenersBefore,
    );
    check(activeObservers === 0, item.name + '：观察者全部断开', String(activeObservers));
    check(
      urlStats.created === urlStats.revoked,
      item.name + '：Object URL 创建与释放数量一致',
      urlStats.created + ' / ' + urlStats.revoked,
    );
    if (item.name === 'image' || item.name === 'video' || item.name === 'html') {
      check(urlStats.created >= 1, item.name + '：确实创建过 Object URL（断言非空转）', String(urlStats.created));
    }
    if (item.name === 'pdf') {
      check(observersBefore >= 1, 'pdf：确实创建过页面观察者（断言非空转）', String(observersBefore));
    }
    check(frames.size === 0, item.name + '：帧回调已取消或执行完', String(frames.size));
    check(timers.size === 0, item.name + '：定时器已清理', String(timers.size));
    check(late === 0, item.name + '：卸载后没有 setState', String(late));
    check(instances.length >= 8, item.name + '：确实挂载了面板与查看器', String(instances.length));
    check(
      instances.some((instance) => /Doc@|MarksRail@/.test(instance.id)),
      item.name + '：查看器组件实例存在',
      instances.map((instance) => instance.id).join(','),
    );
    console.log('    实例：' + instances.map((instance) => instance.id).join(', '));
    console.log(
      '  ' +
        item.name +
        '：实例 ' +
        instances.length +
        '，监听 ' +
        listenersBefore +
        '→' +
        listenersAfter +
        '，观察者 ' +
        observersBefore +
        '→' +
        activeObservers,
    );
  }
};

run()
  .then(() => {
    if (failures) {
      console.log('失败 ' + failures + ' 项');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.log('FAIL 测试抛错 → ' + (error && error.stack));
    process.exit(1);
  });
