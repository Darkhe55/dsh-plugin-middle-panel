// 图片 Ctrl/Cmd + 滚轮缩放：真的把事件喂进生产代码，验证挂载、缩放、锚点与清理。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const attachImageZoom = (node, deps) => {');
const end = src.indexOf('function ImageDoc(props) {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function(src.slice(start, end) + '\nreturn attachImageZoom;')();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 假节点：记录监听器，可手动触发，并有可控的滚动量与盒子。 */
const makeNode = () => {
  const listeners = new Map();
  return {
    scrollLeft: 0,
    scrollTop: 0,
    listeners,
    rect: { left: 10, top: 20 },
    getBoundingClientRect() {
      return { left: this.rect.left, top: this.rect.top };
    },
    addEventListener(name, handler, options) {
      listeners.set(name, { handler, options });
    },
    removeEventListener(name, handler) {
      const entry = listeners.get(name);
      if (entry && entry.handler === handler) listeners.delete(name);
    },
    fire(event) {
      const entry = listeners.get('wheel');
      if (entry) entry.handler(Object.assign({ preventDefault() {} }, event));
    },
  };
};

const makeDeps = (state) => ({
  getZoom: () => state.zoom,
  setZoom: (value) => {
    state.zoom = value;
  },
  setPendingScroll: (value) => {
    state.pending = value;
  },
  requestFrame: (fn) => {
    state.frames.push(fn);
    return state.frames.length;
  },
  cancelFrame: (id) => {
    state.frames[id - 1] = null;
  },
});

const flush = (state) => {
  const queue = state.frames.slice();
  state.frames.length = 0;
  queue.forEach((fn) => {
    if (fn) fn();
  });
};

// 1) 挂载后立即有监听器（这就是之前失效的地方：容器在加载中还不存在）
{
  const node = makeNode();
  const state = { zoom: 1, pending: null, frames: [] };
  const cleanup = factory(node, makeDeps(state));
  check(node.listeners.has('wheel'), '节点出现时立刻挂上 wheel 监听');
  check(node.listeners.get('wheel').options.passive === false, '监听是 non-passive（可阻止浏览器缩放）');

  // 2) Ctrl + 滚轮上 → 放大 1.1 倍，且只在一帧里应用一次
  node.fire({ ctrlKey: true, metaKey: false, clientX: 110, clientY: 100, deltaY: -100 });
  node.fire({ ctrlKey: true, metaKey: false, clientX: 110, clientY: 100, deltaY: -100 });
  check(state.zoom === 1, '同一帧内不立即改变缩放');
  flush(state);
  check(Math.abs(state.zoom - 1.21) < 1e-9, '两次手势合并为 1.1² 一次应用', String(state.zoom));

  // 3) 锚点：光标下的内容点缩放后仍在同一位置
  const offsetX = 110 - 10;
  const offsetY = 100 - 20;
  const contentX = (0 + offsetX) / 1;
  check(Math.abs(state.pending.left - (contentX * state.zoom - offsetX)) < 1e-9, '按光标位置补偿滚动', 'pending=' + state.pending.left + ' zoom=' + state.zoom + ' expected=' + (contentX * state.zoom - offsetX));

  // 4) 普通滚轮不参与缩放
  const before = state.zoom;
  node.fire({ ctrlKey: false, metaKey: false, clientX: 110, clientY: 100, deltaY: -100 });
  flush(state);
  check(state.zoom === before, '不按 Ctrl 的滚轮不缩放');

  // 5) 上限 / 下限
  state.zoom = 3.9;
  node.fire({ ctrlKey: true, clientX: 10, clientY: 20, deltaY: -100 });
  flush(state);
  check(state.zoom === 4, '放大到 4 倍封顶', String(state.zoom));
  state.zoom = 0.2;
  node.fire({ ctrlKey: true, clientX: 10, clientY: 20, deltaY: 100 });
  flush(state);
  check(state.zoom === 0.25, '缩小到 0.25 倍封底', String(state.zoom));

  // 6) 卸载：监听器移除、待执行帧取消
  state.frames.length = 0;
  node.fire({ ctrlKey: true, clientX: 10, clientY: 20, deltaY: -100 });
  const pendingFrames = state.frames.length;
  cleanup();
  check(!node.listeners.has('wheel'), '清理时移除监听');
  check(state.pending === null, '清理时丢弃滚动补偿');
  check(pendingFrames > 0, '清理前确实有一个待执行帧');
  flush(state);
  check(!state.frames.some(Boolean), '清理后不再有待执行帧');
}

// 7) 重新挂载（切换图片）会装上新的监听，不会叠加
{
  const node = makeNode();
  const state = { zoom: 1, pending: null, frames: [] };
  const cleanup = factory(node, makeDeps(state));
  node.fire({ ctrlKey: true, clientX: 10, clientY: 20, deltaY: -100 });
  flush(state);
  const first = state.zoom;
  cleanup();
  const again = factory(node, makeDeps(state));
  check(node.listeners.has('wheel'), '重新挂载后仍有监听');
  check(Object.keys(Object.fromEntries(node.listeners)).length === 1, '不会叠加多个监听');
  again();
  check(!node.listeners.has('wheel'), '第二次清理同样彻底');
  check(first > 1, '首次缩放生效');
}

// 8) 100 轮挂载/卸载：监听器和待执行帧都回到零
{
  const node = makeNode();
  const state = { zoom: 1, pending: null, frames: [] };
  let maxListeners = 0;
  for (let round = 0; round < 100; round += 1) {
    const cleanup = factory(node, makeDeps(state));
    maxListeners = Math.max(maxListeners, node.listeners.size);
    node.fire({ ctrlKey: true, clientX: 10, clientY: 20, deltaY: -100 });
    cleanup();
  }
  check(node.listeners.size === 0, '100 轮之后没有残留监听', String(node.listeners.size));
  check(maxListeners === 1, '每轮只有一套监听器', String(maxListeners));
  flush(state);
  check(!state.frames.some(Boolean), '100 轮之后没有待执行帧');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
