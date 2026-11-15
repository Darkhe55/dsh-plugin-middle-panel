// 持久化调度：合并写入、跳过未变化、flush 只 stringify 一次、配额失败有界退避。
//
// 从源码切片求值并注入 localStorage 与依赖，测的是真实调度器。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const PERSIST_QUIET_MS = 350;');
const end = src.indexOf('// Bounded schema checks');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个可观测的 localStorage 替身。 */
const makeStorage = (options = {}) => {
  const map = new Map();
  const calls = { get: 0, set: 0, removed: 0 };
  const quotaAfter = options.quotaAfter === undefined ? Infinity : options.quotaAfter;
  return {
    calls,
    map,
    getItem(key) {
      calls.get += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      calls.set += 1;
      if (calls.set > quotaAfter) {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, String(value));
    },
    removeItem(key) {
      calls.removed += 1;
      map.delete(key);
    },
  };
};

const makeRunner = (storage, store, overrides = {}) => {
  const deps = {
    store,
    storageKey: () => 'dsh.canvas.v1.test',
    splitState: () => ({ on: false, secondId: null, ratio: 0.5, dir: 'row' }),
    errText: (error) => String((error && error.name) || error),
    devlog: () => {},
    localStorage: storage,
    window: undefined,
    document: undefined,
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    ...overrides,
  };
  const factory = new Function(
    'store',
    'storageKey',
    'splitState',
    'errText',
    'devlog',
    'localStorage',
    'window',
    'document',
    'performance',
    body + '\nreturn { persist, flushPersist, persistMetrics, writePersisted };',
  );
  const api = factory(
    deps.store,
    deps.storageKey,
    deps.splitState,
    deps.errText,
    deps.devlog,
    deps.localStorage,
    deps.window,
    deps.document,
    deps.performance,
  );
  return { ...api, storage };
};

const baseStore = () => ({
  sessionId: 'session-test',
  docs: [{ id: 'd1', path: 'demo/a.md', view: 'markdown' }],
  activeId: 'd1',
  marks: [],
  seq: 0,
  split: { on: false, secondId: null, ratio: 0.5, dir: 'row' },
  splitFocus: 'a',
});

const run = async () => {
  // 1) 一万次连续变更只形成少量写入
  {
    const storage = makeStorage();
    const store = baseStore();
    const api = makeRunner(storage, store);
    const startedAt = Date.now();
    for (let i = 0; i < 10000; i += 1) {
      store.marks = [{ id: 'm1', n: 1, kind: 'text', path: 'demo/a.md', quote: 'x'.repeat(i % 200) }];
      api.persist();
    }
    const mutateCost = Date.now() - startedAt;
    check(storage.calls.set === 0, '连续变更期间没有同步写入', 'writes=' + storage.calls.set);
    check(api.persistMetrics.pending === true, '写入被排入队列');
    await sleep(420);
    check(storage.calls.set === 1, '一万次变更合并为一次写入', 'writes=' + storage.calls.set);
    check(api.persistMetrics.coalesced === 10000, '记录了合并次数', String(api.persistMetrics.coalesced));
    check(mutateCost < 2000, '排期本身很轻', mutateCost + 'ms');
  }

  // 2) 状态没变化时不重复写入
  {
    const storage = makeStorage();
    const store = baseStore();
    const api = makeRunner(storage, store);
    api.persist();
    await sleep(420);
    const first = storage.calls.set;
    api.persist();
    await sleep(420);
    check(storage.calls.set === first, '相同状态不重复写入', 'writes=' + storage.calls.set);
    check(api.persistMetrics.skipped >= 1, '记录了被跳过的写入');
  }

  // 3) flush 立即落盘且只 stringify 一次
  {
    const storage = makeStorage();
    const store = baseStore();
    const api = makeRunner(storage, store);
    store.marks = [{ id: 'm1', n: 1, kind: 'text', path: 'demo/a.md', quote: 'hello' }];
    api.persist();
    const before = storage.calls.set;
    api.flushPersist();
    check(storage.calls.set === before + 1, 'flush 立即写入', 'writes=' + storage.calls.set);
    check(api.persistMetrics.stringifyDurationMs >= 0, '记录了 stringify 耗时');
    const payload = JSON.parse(storage.map.get('dsh.canvas.v1.test'));
    check(payload.marks.length === 1, '写出的是完整状态');
    check(!('flash' in payload) && !('storageIssue' in payload), '瞬态状态不进入持久化');
  }

  // 4) 写入期间再次变化不丢失：只安排一次后续写入
  {
    const storage = makeStorage();
    const store = baseStore();
    const api = makeRunner(storage, store);
    api.persist();
    api.flushPersist();
    store.marks = [{ id: 'm2', n: 2, kind: 'text', path: 'demo/a.md', quote: 'later' }];
    api.persist();
    await sleep(420);
    const payload = JSON.parse(storage.map.get('dsh.canvas.v1.test'));
    check(payload.marks[0].id === 'm2', 'flush 之后的新变化仍会落盘');
  }

  // 5) 配额错误：保留旧值、内存状态不丢、重试有上限
  {
    const storage = makeStorage({ quotaAfter: 0 });
    const store = baseStore();
    const api = makeRunner(storage, store);
    storage.map.set('dsh.canvas.v1.test', '{"docs":[],"marks":[{"id":"old"}],"seq":1}');
    store.marks = [{ id: 'new', n: 2, kind: 'text', path: 'demo/a.md', quote: 'x' }];
    api.persist();
    api.flushPersist();
    check(storage.map.get('dsh.canvas.v1.test').includes('"old"'), '配额失败时旧值没有被清空');
    check(store.marks[0].id === 'new', '内存状态保持不变');
    check(api.persistMetrics.lastError.includes('QuotaExceededError'), '记录了可诊断错误', api.persistMetrics.lastError);
    const retriesAfterFirst = api.persistMetrics.retryCount;
    await sleep(2500);
    check(api.persistMetrics.retryCount <= 4, '重试次数有上限', String(api.persistMetrics.retryCount));
    check(api.persistMetrics.retryCount >= retriesAfterFirst, '重试计数单调');
  }

  // 6) 没有会话时不写入（避免污染 none 键）
  {
    const storage = makeStorage();
    const store = baseStore();
    store.sessionId = undefined;
    const api = makeRunner(storage, store);
    api.persist();
    api.flushPersist();
    check(storage.calls.set === 0, '无会话时不写入');
  }

  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
};

run().catch((error) => {
  console.log('FAIL 测试抛错 → ' + (error && error.stack));
  process.exit(1);
});
