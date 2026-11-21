// The 设置 page only renders when helpTab flips to 'settings'. Two classes of defect are
// invisible to a source-level assertion and only show up here:
//   - a helper used there but declared inside another component throws at render time;
//   - a switch that never tells the store keeps painting the old value and looks stuck
//     until a neighbouring switch happens to re-render the panel for it.
// So this mounts the panel with the help overlay open on that page, walks the tree, and
// clicks every switch in it.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

const noop = () => {};
class StubComponent {
  constructor(props) {
    this.props = props || {};
  }
  setState(patch) {
    Object.assign(this.state || (this.state = {}), typeof patch === 'function' ? patch(this.state) : patch);
  }
  render() {
    return null;
  }
}

let forcedHelpOpen = false;
let forcedHelpTab = false;
let notifications = 0;
const React = {
  Component: StubComponent,
  createElement: (type, props, ...children) => {
    const merged = Object.assign({}, props || {});
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    return { type, props: merged, children };
  },
  Fragment: 'Fragment',
  useState: (init) => {
    const value = typeof init === 'function' ? init() : init;
    // helpOpen is the first literal-false state in CanvasPanel; helpTab starts as 'keys'.
    if (value === false && !forcedHelpOpen) {
      forcedHelpOpen = true;
      return [true, noop];
    }
    if (value === 'keys' && !forcedHelpTab) {
      forcedHelpTab = true;
      return ['settings', noop];
    }
    return [value, noop];
  },
  useEffect: noop,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useLayoutEffect: noop,
  // Register for real: a switch that forgets to notify() leaves this counter untouched.
  useSyncExternalStore: (subscribe, getSnapshot) => {
    const value = getSnapshot();
    if (typeof subscribe === 'function') subscribe(() => { notifications += 1; });
    return value;
  },
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
  getElementById: () => null,
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
  global.window,
  global.document,
  global.location,
  global.navigator,
  global.localStorage,
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

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const main = panels.find((entry) => entry.name === 'main');
check(Boolean(main && main.result && main.result.component), '注册了 main slot 组件');
if (!main) {
  console.log('失败 1 项');
  process.exit(1);
}

const Panel = main.result.component;

const walkTree = (element, depth, onNode) => {
  if (!element || typeof element !== 'object' || depth > 80) return;
  const props = element.props || {};
  if (typeof element.type === 'function') {
    const type = element.type;
    try {
      const inner =
        type.prototype && typeof type.prototype.render === 'function'
          ? new type(props).render()
          : type(props);
      walkTree(inner, depth + 1, onNode);
    } catch (error) {
      if (onNode) onNode(null, null, error);
    }
    return;
  }
  if (onNode) onNode(element, props);
  const children = element.children || [];
  for (const child of children) {
    if (Array.isArray(child)) child.forEach((inner) => walkTree(inner, depth + 1, onNode));
    else walkTree(child, depth + 1, onNode);
  }
};

const found = { dialogs: [], tablists: [], tabs: [], tabpanels: [] };
let settingsPanelNode = null;
let threw = '';

walkTree(
  Panel({ sessionId: 'test-session', renderFactorySlot: () => null, surface: 'main' }),
  0,
  (element, props, error) => {
    if (error) {
      if (!threw) threw = error && error.message;
      return;
    }
    if (props.role === 'dialog') found.dialogs.push(props['aria-label']);
    if (props.role === 'tablist') found.tablists.push(props['aria-label']);
    if (props.role === 'tab') {
      found.tabs.push({ id: props.id || '', selected: props['aria-selected'], controls: props['aria-controls'] || '' });
    }
    if (props.role === 'tabpanel') {
      found.tabpanels.push({ id: props.id, labelledby: props['aria-labelledby'], hidden: props.hidden });
      if (props.id === 'dshcv-help-panel-settings') settingsPanelNode = element;
    }
  },
);

check(threw === '', '设置页渲染不抛错', threw);
check(found.dialogs.includes('帮助：设置'), '对话框标题跟随当前页', JSON.stringify(found.dialogs));
check(found.tablists.includes('帮助内容'), '帮助页签容器是 tablist', JSON.stringify(found.tablists));

const helpTabs = found.tabs.filter((tab) => tab.controls.indexOf('dshcv-help-panel') === 0);
check(helpTabs.length === 2, '两个页签都带 aria-controls', String(helpTabs.length));
check(helpTabs.filter((tab) => tab.selected === 'true').length === 1, '恰有一个页签被选中', JSON.stringify(helpTabs));
check(
  Boolean(helpTabs.find((tab) => tab.id === 'dshcv-help-tab-settings' && tab.selected === 'true')),
  '当前选中的是设置页',
);

const keysPanel = found.tabpanels.find((panel) => panel.id === 'dshcv-help-panel-keys');
const settingsPanel = found.tabpanels.find((panel) => panel.id === 'dshcv-help-panel-settings');
check(Boolean(keysPanel && settingsPanel), '两个面板都渲染', JSON.stringify(found.tabpanels.map((panel) => panel.id)));
check(settingsPanel && settingsPanel.hidden === false, '设置面板可见');
check(keysPanel && keysPanel.hidden === true, '快捷键面板隐藏');
check(settingsPanel && settingsPanel.labelledby === 'dshcv-help-tab-settings', '面板由当前页签标注');

// Every switch in the settings page must work on its own: it has to touch exactly one
// preference and it has to ask for a re-render, otherwise it looks stuck and jumps when a
// neighbouring switch re-renders the panel.
const switches = [];
walkTree(settingsPanelNode, 0, (element, props) => {
  if (!props || typeof props.className !== 'string' || !props.className.includes('dshcv-toggle')) return;
  const label = typeof props.children === 'string' ? props.children : '';
  switches.push({ label, pressed: props['aria-pressed'], onClick: props.onClick });
});

check(switches.length === 6, '设置页的六个开关都渲染', String(switches.length));
for (const item of switches) {
  const before = new Map(storage);
  const notificationsBefore = notifications;
  let error = '';
  try {
    item.onClick();
  } catch (caught) {
    error = caught && caught.message ? caught.message : String(caught);
  }
  const changed = [...storage.keys()].filter((key) => before.get(key) !== storage.get(key));
  check(error === '', '「' + item.label + '」点击不抛错', error);
  check(changed.length === 1, '「' + item.label + '」只改自己的偏好', JSON.stringify(changed));
  check(notifications > notificationsBefore, '「' + item.label + '」请求重渲染', '没有调用 notify()');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
