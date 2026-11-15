// 资源计数：100 轮创建/销毁后必须回到基线；全局监听器只能安装一次。
const { readSource } = require('./_source.cjs');
const src = readSource();

const countersStart = src.indexOf('const counters = {');
const countersEnd = src.indexOf('// Coalesce DOM work to one pass per frame.');
if (countersStart < 0 || countersEnd < 0) {
  console.log('anchors missing');
  process.exit(1);
}

const makeCounters = () => {
  const frames = new Map();
  let nextFrame = 1;
  const listeners = new Map();
  const stamps = new Map();
  const factory = new Function(
    'URL',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'document',
    src.slice(countersStart, countersEnd) +
      '\nreturn { counters, count, createObjectUrl, revokeObjectUrl, makeObserver, requestFrameTracked, cancelFrameTracked };',
  );
  const api = factory(
    {
      createObjectURL: () => 'blob:' + stamps.size,
      revokeObjectURL: () => {},
    },
    (fn) => {
      const id = nextFrame++;
      frames.set(id, fn);
      return id;
    },
    (id) => frames.delete(id),
    { createElement: () => ({}) },
  );
  class FakeObserver {
    constructor(handler) {
      this.handler = handler;
      this.active = false;
      listeners.set(this, true);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
      listeners.delete(this);
    }
  }
  return { api, frames, listeners, FakeObserver };
};

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 1) 100 轮挂载/卸载：观察者、RAF、Object URL 全部回到 0
{
  const { api, frames, listeners, FakeObserver } = makeCounters();
  const baseline = JSON.stringify(api.counters);
  for (let round = 0; round < 100; round += 1) {
    const observer1 = api.makeObserver(FakeObserver, () => {});
    observer1.observe('node');
    const observer2 = api.makeObserver(FakeObserver, () => {});
    observer2.observe('node');
    const url1 = api.createObjectUrl({});
    const url2 = api.createObjectUrl({});
    const frame1 = api.requestFrameTracked(() => {});
    const frame2 = api.requestFrameTracked(() => {});
    // 卸载顺序与组件清理一致
    observer1.disconnect();
    observer2.disconnect();
    api.revokeObjectUrl(url1);
    api.revokeObjectUrl(url2);
    api.cancelFrameTracked(frame1);
    api.cancelFrameTracked(frame2);
  }
  check(api.counters.observers === 0, '观察者计数回到 0', String(api.counters.observers));
  check(api.counters.objectUrls === 0, 'Object URL 计数回到 0', String(api.counters.objectUrls));
  check(api.counters.rafs === 0, 'RAF 计数回到 0', String(api.counters.rafs));
  check(listeners.size === 0, '没有残留的观察者实例', String(listeners.size));
  check(frames.size === 0, '没有残留的待执行帧', String(frames.size));
  check(JSON.stringify(api.counters) === baseline, '全部计数与基线一致');
}

// 2) 帧执行后计数也会回落（不是只靠 cancel）
{
  const { api, frames } = makeCounters();
  api.requestFrameTracked(() => {});
  check(api.counters.rafs === 1, '排入一帧');
  for (const [, fn] of Array.from(frames)) fn(0);
  check(api.counters.rafs === 0, '帧执行后计数回落', String(api.counters.rafs));
}

// 3) 重复 disconnect 不会把计数减成负数
{
  const { api, FakeObserver } = makeCounters();
  const observer = api.makeObserver(FakeObserver, () => {});
  observer.disconnect();
  observer.disconnect();
  check(api.counters.observers === 0, '重复释放不会出现负数', String(api.counters.observers));
}

// 4) 全局监听器只在首次安装时注册一套
{
  const lifecycleStart = src.indexOf('const lifecycle = { installed: false');
  const lifecycleEnd = src.indexOf('installLifecycle();', lifecycleStart);
  if (lifecycleStart < 0 || lifecycleEnd < 0) {
    console.log('FAIL 找不到 lifecycle 代码');
    failures += 1;
  } else {
    const body = src.slice(lifecycleStart, lifecycleEnd + 'installLifecycle();'.length);
    const winListeners = new Map();
    const docListeners = new Map();
    const add = (map) => (name, handler) => {
      const list = map.get(name) || [];
      list.push(handler);
      map.set(name, list);
    };
    const remove = (map) => (name, handler) => {
      const list = (map.get(name) || []).filter((item) => item !== handler);
      map.set(name, list);
    };
    const win = {
      addEventListener: add(winListeners),
      removeEventListener: remove(winListeners),
    };
    const doc = {
      addEventListener: add(docListeners),
      removeEventListener: remove(docListeners),
      visibilityState: 'visible',
    };
    const factory = new Function(
      'window',
      'document',
      'flushPersist',
      'meshCacheClear',
      'devlog',
      body +
        '\nreturn { installLifecycle, uninstallLifecycle, lifecycle };',
    );
    const installed = factory(win, doc, () => {}, () => 0, () => {});
    // 再次安装：模拟热重载/二次注入
    installed.installLifecycle();
    installed.installLifecycle();
    check((winListeners.get('pagehide') || []).length === 1, 'pagehide 只有一套处理器', String((winListeners.get('pagehide') || []).length));
    check(
      (docListeners.get('visibilitychange') || []).length === 1,
      'visibilitychange 只有一套处理器',
      String((docListeners.get('visibilitychange') || []).length),
    );
    installed.uninstallLifecycle();
    check((winListeners.get('pagehide') || []).length === 0, '卸载后移除 pagehide', String((winListeners.get('pagehide') || []).length));
    check(
      (docListeners.get('visibilitychange') || []).length === 0,
      '卸载后移除 visibilitychange',
      String((docListeners.get('visibilitychange') || []).length),
    );
    installed.installLifecycle();
    check((winListeners.get('pagehide') || []).length === 1, '卸载后可以重新安装', String((winListeners.get('pagehide') || []).length));
  }
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
