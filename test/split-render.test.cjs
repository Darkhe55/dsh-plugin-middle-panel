// P1 render: with the split on, the panel must produce two slots and a divider,
// each slot holding its own viewer.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

const noop = () => {};
class StubComponent {
  constructor(props) { this.props = props || {}; }
  setState(patch) { Object.assign(this.state || (this.state = {}), typeof patch === 'function' ? patch(this.state) : patch); }
  render() { return null; }
}
const React = {
  Component: StubComponent,
  createElement: (type, props, ...children) => {
    const merged = Object.assign({}, props || {});
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    return { type, props: merged, children };
  },
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  // effect 真跑一次：会话桥在 effect 里绑定 sessionId 并恢复已存文档
  useEffect: (fn) => { try { fn(); } catch (error) {} },
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useLayoutEffect: (fn) => { try { fn(); } catch (error) {} },
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useDeferredValue: (value) => value,
  cloneElement: (el, patch) => ({ ...el, props: { ...el.props, ...patch } }),
  Children: { toArray: () => [] },
};

const storage = new Map();
let registered = null;
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
global.location = { protocol: 'http:', origin: 'http://127.0.0.1:1819', href: 'http://127.0.0.1:1819/' };
global.navigator = { userAgent: 'node', pdfViewerEnabled: true };
global.requestAnimationFrame = window.requestAnimationFrame;
global.cancelAnimationFrame = noop;

new Function('window', 'document', 'location', 'navigator', 'localStorage', src)(
  global.window, global.document, global.location, global.navigator, global.localStorage,
);

const exported = registered.factory((name) => (name === 'react' ? React : {}));
const panels = [];
exported.apply({
  get: () => undefined,
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => panels.push({ name, result: fn() }),
    register: (meta, component) => ({ meta, component }),
  },
  on: noop,
  emit: noop,
});

// 1) 先把状态写进存储
storage.set(
  'dsh.canvas.v1.split-session',
  JSON.stringify({
    docs: [
      { id: 'd1', path: 'demo/notes.md', view: 'markdown' },
      { id: 'd2', path: 'demo/readme.md', view: 'markdown' },
    ],
    activeId: 'd1',
    marks: [],
    seq: 0,
    split: { on: true, secondId: 'd2', ratio: 0.55, dir: 'row' },
    splitFocus: 'b',
  }),
);

const CLASSED = [];
const DOCS = [];
let visited = 0;

// 2) 遍历：函数组件要真正执行
function visit(node, depth) {
  if (!node || typeof node !== 'object' || depth > 60 || visited > 8000) return;
  if (Array.isArray(node)) {
    node.forEach((inner) => visit(inner, depth + 1));
    return;
  }
  visited += 1;
  // 组件自身的 props 也要看：doc 是传给查看器组件的
  if (node.props) {
    if (typeof node.props.className === 'string') CLASSED.push(node);
    if (node.props.doc && typeof node.props.doc === 'object' && node.props.doc.path) DOCS.push(node.props.doc.path);
  }
  if (typeof node.type === 'function') {
    try {
      const type = node.type;
      const inner =
        type.prototype && typeof type.prototype.render === 'function'
          ? new type(node.props || {}).render()
          : type(node.props || {});
      visit(inner, depth + 1);
    } catch (error) {
      /* 无 DOM 环境下子组件的局部失败不影响面板结构判断 */
    }
    return;
  }
  const children = node.children || [];
  for (const child of children) {
    if (Array.isArray(child)) child.forEach((inner) => visit(inner, depth + 1));
    else visit(child, depth + 1);
  }
}

// 3) 先挂会话桥（绑定 sessionId 并恢复文档），再渲染主面板
for (const entry of panels) {
  const component = entry.result && entry.result.component;
  if (typeof component !== 'function') continue;
  try {
    visit(component({ sessionId: 'split-session', inputActions: {}, renderFactorySlot: () => null }), 0);
  } catch (error) {
    /* ignore */
  }
}

const Panel = panels.find((entry) => entry.name === 'main').result.component;
try {
  visit(Panel({ sessionId: 'split-session', renderFactorySlot: () => null, surface: 'main' }), 0);
} catch (error) {
  console.log('FAIL 渲染抛错 → ' + (error && error.message));
  process.exit(1);
}

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const slotsWrap = CLASSED.find((node) => node.props.className === 'dshcv-slots');
check(Boolean(slotsWrap), '找到 slots 容器');
check(slotsWrap && slotsWrap.props['data-split'] === '1', '标记为已分栏');
check(slotsWrap && slotsWrap.props['data-dir'] === 'row', '方向为横排');

const slots = CLASSED.filter((node) => node.props.className === 'dshcv-slot');
check(slots.length === 2, '两个窗格', String(slots.length));
check(slots[0] && slots[0].props['data-active'] === '0', '焦点在 b 时 a 非激活', slots[0] && slots[0].props['data-active']);
check(slots[1] && slots[1].props['data-active'] === '1', 'b 为激活窗格', slots[1] && slots[1].props['data-active']);
check(
  slots[0] && String(slots[0].props.style.flex).includes('55'),
  '第一窗格按记忆比例占 55%',
  slots[0] && JSON.stringify(slots[0].props.style),
);

const dividers = CLASSED.filter((node) => node.props.className === 'dshcv-divider');
check(dividers.length === 1, '有一个分隔条', String(dividers.length));

check(DOCS.includes('demo/notes.md'), '左窗格拿到第一个文档', DOCS.join(','));
check(DOCS.includes('demo/readme.md'), '右窗格拿到第二个文档', DOCS.join(','));
check(new Set(DOCS).size === 2, '两个窗格渲染不同文档');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
