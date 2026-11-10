// Mounts CanvasPanel with stubs and reports the first render-time exception.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

const noop = () => {};
const state = [];
class StubComponent { constructor(props) { this.props = props || {}; } setState(patch) { Object.assign(this.state || (this.state = {}), typeof patch === 'function' ? patch(this.state) : patch); } render() { return null; } }
const React = {
  Component: StubComponent,
  createElement: (type, props, ...children) => { const merged = Object.assign({}, props || {}); if (children.length) merged.children = children.length === 1 ? children[0] : children; return { type, props: merged, children }; },
  Fragment: 'Fragment',
  useState: (init) => {
    const value = typeof init === 'function' ? init() : init;
    return [value, noop];
  },
  useEffect: noop,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useLayoutEffect: noop,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useDeferredValue: (value) => value,
  cloneElement: (el, patch) => ({ ...el, props: { ...el.props, ...patch } }),
  Children: { toArray: () => [] },
};

const storage = new Map();
global.window = {
  addEventListener: noop,
  removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: noop,
  getSelection: () => null,
  innerWidth: 1440,
  innerHeight: 900,
  __ModuleLoader__: { load: (spec) => (registered = spec) },
};
let registered = null;
global.localStorage = window.localStorage;
global.document = {
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  activeElement: null,
  documentElement: { style: { setProperty: noop } },
  body: { appendChild: noop },
  createElement: () => ({ style: {}, appendChild: noop }),
};
global.location = { protocol: 'http:', origin: 'http://127.0.0.1:1296', href: 'http://127.0.0.1:1296/' };
global.navigator = { userAgent: 'node', pdfViewerEnabled: true };
global.requestAnimationFrame = window.requestAnimationFrame;
global.cancelAnimationFrame = noop;

new Function('window', 'document', 'location', 'navigator', 'localStorage', src)(
  global.window, global.document, global.location, global.navigator, global.localStorage,
);

const exported = registered.factory((name) => (name === 'react' ? React : {}));

const panels = [];
const ctx = {
  get: () => undefined,
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => panels.push({ name, result: fn() }),
    register: (meta, component) => ({ meta, component }),
  },
  on: noop,
  emit: noop,
};
exported.apply(ctx);
const main = panels.find((entry) => entry.name === 'main');
if (!main) {
  console.log('main slot 未注册');
  process.exit(1);
}
const Panel = main.result.component;
console.log('注册组件：', typeof Panel);

const props = {
  sessionId: 'test-session',
  renderFactorySlot: () => null,
  surface: 'main',
};

// Seed a persisted open document so the active viewer mounts as well.
storage.set(
  'dsh.canvas.v1.test-session',
  JSON.stringify({ docs: [{ id: 'd1', path: 'demo/notes.md', view: 'markdown' }], activeId: 'd1', marks: [], seq: 0 }),
);

let nodes = 0;
const deepRender = (element, depth) => {
  if (!element || typeof element !== 'object') return;
  nodes += 1;
  if (nodes > 4000 || depth > 60) return;
  if (typeof element.type === 'function') {
    try {
      const type = element.type;
      const inner =
        type.prototype && typeof type.prototype.render === 'function'
          ? new type(element.props || {}).render()
          : type(element.props || {});
      deepRender(inner, depth + 1);
      return;
    } catch (error) {
      console.log('组件 ' + (element.type.name || 'unknown') + ' 渲染抛错：', error && error.message);
      console.log((error && error.stack ? error.stack : '').split('\n').slice(0, 6).join('\n'));
      process.exitCode = 1;
      return;
    }
  }
  const children = element.children || [];
  for (const child of children) {
    if (Array.isArray(child)) child.forEach((inner) => deepRender(inner, depth + 1));
    else deepRender(child, depth + 1);
  }
};

try {
  const tree = Panel(props);
  console.log('CanvasPanel 渲染：OK');
  deepRender(tree, 0);
  if (!process.exitCode) console.log('深度渲染完成，节点数：', nodes);
} catch (error) {
  console.log('CanvasPanel 渲染抛错：', error && error.message);
  console.log((error && error.stack ? error.stack : '').split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}




