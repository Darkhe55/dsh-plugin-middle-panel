// Loads the client module with stubs to catch top-level evaluation errors.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

const noop = () => {};
class StubComponent { constructor(props) { this.props = props || {}; } setState(patch) { Object.assign(this.state || (this.state = {}), typeof patch === 'function' ? patch(this.state) : patch); } render() { return null; } }
const React = {
  Component: StubComponent,
  createElement: (type, props, ...children) => { const merged = Object.assign({}, props || {}); if (children.length) merged.children = children.length === 1 ? children[0] : children; return { type, props: merged, children }; },
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useEffect: noop,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useLayoutEffect: noop,
  useSyncExternalStore: (subscribe, get) => get(),
  useDeferredValue: (value) => value,
  cloneElement: (el, patch) => ({ ...el, props: { ...el.props, ...patch } }),
  Children: { toArray: () => [] },
};

const listeners = new Map();
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
  cancelAnimationFrame: (id) => clearTimeout(id),
  getSelection: () => null,
  innerWidth: 1440,
  innerHeight: 900,
  __ModuleLoader__: { load: (spec) => listeners.set(spec.id, spec) },
};
global.localStorage = window.localStorage;
global.document = {
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  activeElement: null,
  body: { appendChild: noop },
  createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
};
global.location = { protocol: 'http:', origin: 'http://127.0.0.1:1296', href: 'http://127.0.0.1:1296/' };
global.navigator = { userAgent: 'node', pdfViewerEnabled: true };
global.requestAnimationFrame = window.requestAnimationFrame;
global.cancelAnimationFrame = window.cancelAnimationFrame;

const script = new Function('window', 'document', 'location', 'navigator', 'localStorage', src);
try {
  script(global.window, global.document, global.location, global.navigator, global.localStorage);
  console.log('模块求值：OK');
} catch (error) {
  console.log('模块求值失败：', error && error.message);
  console.log(error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : '');
  process.exit(1);
}

const spec = listeners.get('dsh-plugin-middle-panel');
if (!spec) {
  console.log('未注册模块');
  process.exit(1);
}
try {
  const exported = spec.factory((name) => {
    if (name === 'react') return React;
    return {};
  });
  console.log('factory 执行：OK');
  console.log('导出键：', exported ? Object.keys(exported).join(', ') : '(空)');
  if (exported && typeof exported.apply === 'function') {
    console.log('apply 是函数：是');
  }
} catch (error) {
  console.log('factory 抛错：', error && error.message);
  console.log(error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : '');
  process.exit(1);
}


