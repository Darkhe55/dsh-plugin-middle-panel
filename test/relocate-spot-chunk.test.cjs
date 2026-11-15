// 3D 标注重定位：分片执行、可取消、结果与旧同步算法一致。
//
// 直接从源码切片求值，注入依赖，测的是生产代码而不是复制品。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const relocationMetrics = {');
const end = src.indexOf('const addMark = (partial) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

const build = (store) => {
  const factory = new Function(
    'count',
    'store',
    'mutate',
    'persist',
    'devlog',
    'sameFile',
    'clock',
    'setTimeout',
    body + '\nreturn { relocateSpotMarks, relocationMetrics, relocationGenerationOf: () => relocationGeneration };',
  );
  return factory(
    () => 0,
    store,
    (patch) => Object.assign(store, patch),
    () => {},
    () => {},
    (left, right) => String(left) === String(right),
    () => Date.now(),
    () => {},
  );
};

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 生成 triangleCount 个三角形：第 i 个的质心在 (i, 0, 0)，边长 1。 */
const makeMesh = (triangleCount) => {
  const positions = new Float32Array(triangleCount * 9);
  for (let i = 0; i < triangleCount; i += 1) {
    const base = i * 9;
    const x = i;
    positions[base] = x - 0.5;
    positions[base + 1] = 0;
    positions[base + 2] = 0;
    positions[base + 3] = x + 0.5;
    positions[base + 4] = 0;
    positions[base + 5] = 0;
    positions[base + 6] = x;
    positions[base + 7] = 0.2;
    positions[base + 8] = 0;
  }
  return positions;
};

const spotMark = (triangle, x) => ({
  id: 'm' + triangle,
  n: triangle + 1,
  kind: 'spot',
  path: 'demo/model.glb',
  triangle,
  centroid: [x, 0.06, 0],
  note: '',
});

const centroidOf = (positions, triangle) => {
  const base = triangle * 9;
  return [
    (positions[base] + positions[base + 3] + positions[base + 6]) / 3,
    (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3,
    (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3,
  ];
};

/** 旧实现的同步版本，用来对照结果。 */
const reference = (store, path, positions, radius) => {
  const total = Math.floor(positions.length / 9);
  const tolerance = Math.max(1e-9, Number(radius || 1) * 0.01);
  const limit = tolerance * tolerance;
  return store.marks.map((mark) => {
    if (mark.path !== path || mark.kind !== 'spot') return mark;
    if (typeof mark.triangle !== 'number' || !Array.isArray(mark.centroid)) return mark;
    const center = mark.centroid;
    const distanceSquared = (triangle) => {
      const base = triangle * 9;
      const dx = (positions[base] + positions[base + 3] + positions[base + 6]) / 3 - center[0];
      const dy = (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3 - center[1];
      const dz = (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3 - center[2];
      return dx * dx + dy * dy + dz * dz;
    };
    if (mark.triangle >= 0 && mark.triangle < total && distanceSquared(mark.triangle) <= limit) {
      return mark.spotStale ? { ...mark, spotStale: false } : mark;
    }
    let best = -1;
    let bestDistance = Infinity;
    for (let triangle = 0; triangle < total; triangle += 1) {
      const value = distanceSquared(triangle);
      if (value < bestDistance) {
        bestDistance = value;
        best = triangle;
      }
    }
    if (best >= 0 && bestDistance <= limit * 4) {
      return { ...mark, triangle: best, spotStale: false, relocated: true };
    }
    return mark.spotStale ? mark : { ...mark, spotStale: true };
  });
};

const run = async () => {
  // 1) 结果与旧算法一致
  {
    const mesh = makeMesh(2000);
    const marks = [spotMark(10, centroidOf(mesh, 10)[0]), spotMark(1500, centroidOf(mesh, 1500)[0])];
    // 第二个标注记的三角形索引错了，但质心还贴着真正的那个面：必须靠扫描找回
    marks[1].triangle = 1999;
    const store = { marks: marks.map((mark) => ({ ...mark })) };
    const expected = reference(store, 'demo/model.glb', mesh, 1);
    const api = build(store);
    await api.relocateSpotMarks('demo/model.glb', mesh, 1, { yieldTo: (fn) => fn(), sliceTriangles: 300 });
    check(
      store.marks[0].triangle === expected[0].triangle && store.marks[1].triangle === expected[1].triangle,
      '重定位结果与旧同步算法一致',
      JSON.stringify([store.marks[0].triangle, store.marks[1].triangle]),
    );
    check(store.marks[1].relocated === true, '找到新位置时标记 relocated');
  }

  // 2) 150 万三角形：一次同步调用不得扫描完，必须分片
  {
    const mesh = makeMesh(1500000);
    const far = spotMark(0, -999999);
    far.centroid = [-999999, 0, 0];
    const store = { marks: [far] };
    let slices = 0;
    let maxSliceMs = 0;
    let lastAt = Date.now();
    const api = build(store);
    const startedAt = Date.now();
    const summary = await api.relocateSpotMarks('demo/model.glb', mesh, 1, {
      yieldTo: (fn) => {
        maxSliceMs = Math.max(maxSliceMs, Date.now() - lastAt);
        lastAt = Date.now();
        slices += 1;
        setImmediate(fn);
      },
    });
    const elapsed = Date.now() - startedAt;
    check(slices > 5, '150 万三角形被拆成多片执行', 'slices=' + slices);
    check(summary.scannedTriangles === 1500000, '扫描覆盖全部三角形', String(summary.scannedTriangles));
    check(maxSliceMs < 120, '单片没有长时间独占主线程（含调度开销）', maxSliceMs + 'ms');
    check(elapsed < 5000, '整体不会卡死', elapsed + 'ms');
    check(api.relocationMetrics.totalTriangles === 1500000, '诊断记录总三角形数');
  }

  // 3) 中断：新的重定位任务取消旧的，旧任务不得提交结果
  {
    const mesh = makeMesh(300000);
    const stale = spotMark(0, -999999);
    stale.centroid = [-999999, 0, 0];
    const store = { marks: [{ ...stale }] };
    const api = build(store);
    const pending = [];
    const first = api.relocateSpotMarks('demo/model.glb', mesh, 1, {
      yieldTo: (fn) => pending.push(fn),
      sliceTriangles: 10000,
    });
    // 让第一片跑完，然后排一个更近的标注任务
    await new Promise((resolve) => setImmediate(resolve));
    const before = store.marks[0].spotStale;
    store.marks = [spotMark(5, centroidOf(mesh, 5)[0])];
    const second = api.relocateSpotMarks('demo/model.glb', mesh, 1, { yieldTo: (fn) => fn(), sliceTriangles: 50000 });
    // 旧任务恢复执行时应当发现自己已过期
    while (pending.length) {
      const fn = pending.shift();
      fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const firstResult = await first;
    const secondResult = await second;
    check(firstResult && firstResult.cancelled === true, '旧任务被取消', JSON.stringify(firstResult));
    check(before === undefined, '取消的任务没有提交中间状态');
    check(secondResult.cancelled === false, '新任务正常完成');
    check(!store.marks[0].spotStale, '新任务的结果被采纳', String(store.marks[0].spotStale));
  }

  // 4) 没有标注时立即返回，不启动扫描
  {
    const mesh = makeMesh(100);
    const store = { marks: [] };
    const api = build(store);
    const summary = await api.relocateSpotMarks('demo/model.glb', mesh, 1, { yieldTo: (fn) => fn() });
    check(summary.scannedTriangles === 0, '无标注时不扫描');
  }

  // 5) AbortSignal：关闭模型时立刻取消，且不提交任何标注改动
  {
    const mesh = makeMesh(400000);
    const stale = spotMark(0, -999999);
    stale.centroid = [-999999, 0, 0];
    const store = { marks: [{ ...stale }] };
    const api = build(store);
    const controller = new AbortController();
    const pending = [];
    const task = api.relocateSpotMarks('demo/model.glb', mesh, 1, {
      signal: controller.signal,
      yieldTo: (fn) => pending.push(fn),
      sliceTriangles: 5000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const startedAt = Date.now();
    while (pending.length) {
      pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await task;
    check(result && result.cancelled === true, 'abort 后任务被取消', JSON.stringify(result));
    check(Date.now() - startedAt < 2000, 'abort 后 Promise 及时结束');
    check(store.marks[0].spotStale === undefined || store.marks[0].spotStale === false, '取消的任务没有写入标注');
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
