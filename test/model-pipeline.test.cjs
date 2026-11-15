// 模型流水线：分片、可取消、结果有硬上限。真实执行生产代码，而不是正则匹配。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const MAX_PREVIEW_TRIANGLES = 800000;');
const end = src.indexOf('// ---------------- cad drawings: dxf entities in, svg out ----------------');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

const factory = new Function(
  'runSliced',
  'devlog',
  body +
    '\nreturn { buildModelPreview, decimateMeshSliced, meshBoundsSliced, watertightSliced, MAX_PREVIEW_TRIANGLES, WATERTIGHT_BUDGET };',
);

// 与生产一致的分片执行器（同样的 8ms 预算/让出语义），从源码里取，避免测试自说自话。
const runnerSrc = src.slice(
  src.indexOf('const SLICE_BUDGET_MS = 8;'),
  src.indexOf('// Symmetric counters for resources this plugin creates'),
);
const makeRunSliced = () =>
  new Function(
    'setTimeout',
    'performance',
    runnerSrc + '\nreturn runSliced;',
  )(setTimeout, { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 });

const api = factory(makeRunSliced(), () => {});

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 生成三角形网格：第 i 个三角形质心在 (i%R, floor(i/R), 0) 附近。 */
const makeMesh = (triangleCount) => {
  const positions = new Float32Array(triangleCount * 9);
  const side = Math.max(2, Math.round(Math.sqrt(triangleCount)));
  for (let i = 0; i < triangleCount; i += 1) {
    const x = i % side;
    const y = Math.floor(i / side);
    const base = i * 9;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = 0;
    positions[base + 3] = x + 1;
    positions[base + 4] = y;
    positions[base + 5] = 0;
    positions[base + 6] = x;
    positions[base + 7] = y + 1;
    positions[base + 8] = 0;
  }
  return positions;
};

const run = async () => {
  // 1) 分片：150 万三角形不得形成长同步任务
  {
    const positions = makeMesh(1500000);
    const started = Date.now();
    let slices = 0;
    const built = await api.buildModelPreview(positions, {
      yieldTo: (fn) => {
        slices += 1;
        setImmediate(fn);
      },
    });
    const elapsed = Date.now() - started;
    check(Boolean(built) && !built.cancelled, '大模型处理完成');
    check(slices > 5, '工作被拆成多片', 'slices=' + slices);
    check(elapsed < 20000, '整体耗时可接受', elapsed + 'ms');
    check(
      built.triangles <= api.MAX_PREVIEW_TRIANGLES,
      '抽稀输出不超过硬上限',
      built.triangles + ' / ' + api.MAX_PREVIEW_TRIANGLES,
    );
    console.log('  分片数 ' + slices + '，抽稀后 ' + built.triangles.toLocaleString() + ' 三角形，总耗时 ' + elapsed + 'ms');
  }

  // 2) 单片耗时预算：真实时钟下每两次让出之间的同步工作不应超过两帧
  {
    const positions = makeMesh(800000);
    const gaps = [];
    let last = Date.now();
    const built = await api.buildModelPreview(positions, {
      yieldTo: (fn) => {
        gaps.push(Date.now() - last);
        last = Date.now();
        setImmediate(fn);
      },
    });
    check(Boolean(built) && !built.cancelled, '计时用例的计算完成');
    check(gaps.length >= 2, '确实发生了多次让出', 'gaps=' + gaps.length);
    const worst = gaps.length ? Math.max(...gaps) : 0;
    const over16 = gaps.filter((value) => value > 16).length;
    console.log('  让出间隔：最多 ' + worst + 'ms，中位 ' + (gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0) + 'ms，超过 16ms 的 ' + over16 + '/' + gaps.length);
    check(worst <= 40, '同步块没有长时间独占主线程（含调度抖动）', worst + 'ms');
  }

  // 3) 取消：abort 后立即结束，且不产出可提交的结果
  {
    const positions = makeMesh(600000);
    const controller = new AbortController();
    let slices = 0;
    const pending = [];
    const task = api.buildModelPreview(positions, {
      signal: controller.signal,
      yieldTo: (fn) => {
        slices += 1;
        pending.push(fn);
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    check(slices >= 1, '取消前已经跑了若干分片', 'slices=' + slices);
    controller.abort();
    const startedAt = Date.now();
    while (pending.length) {
      pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await task;
    check(Boolean(result) && result.cancelled === true, 'abort 后流水线返回 cancelled', JSON.stringify(result && result.cancelled));
    check(Date.now() - startedAt < 2000, 'abort 后及时结束');
  }

  // 4) A/B 竞争：A 被 abort 后不得提交，B 正常提交
  {
    const meshA = makeMesh(400000);
    const meshB = makeMesh(2000);
    const controllerA = new AbortController();
    const queueA = [];
    const taskA = api.buildModelPreview(meshA, {
      signal: controllerA.signal,
      yieldTo: (fn) => queueA.push(fn),
    });
    await new Promise((resolve) => setImmediate(resolve));
    // B 开始并完成
    const builtB = await api.buildModelPreview(meshB, { yieldTo: (fn) => fn() });
    controllerA.abort();
    while (queueA.length) {
      queueA.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const resultA = await taskA;
    check(builtB && !builtB.cancelled, 'B 正常完成');
    check(resultA && resultA.cancelled === true, 'A 被取消，没有结果可提交');
    check(!resultA.positions, 'A 没有产出 positions');
    // 模拟提交：只有 B 的结果会写入
    let committed = null;
    for (const candidate of [resultA, builtB]) {
      if (candidate && !candidate.cancelled) committed = candidate;
    }
    check(committed === builtB, '只有 B 的结果被提交');
  }

  // 5) 抽稀硬上限：无论网格多大，输出不超过 MAX_PREVIEW_TRIANGLES
  {
    const positions = makeMesh(900000);
    const bounds = await api.meshBoundsSliced(positions, { yieldTo: (fn) => fn() });
    const reduced = await api.decimateMeshSliced(positions, 50000, bounds, { yieldTo: (fn) => fn() });
    check(reduced.triangles <= 50000, '抽稀遵守传入上限', String(reduced.triangles));
    check(reduced.positions.length === reduced.triangles * 9, '输出长度与三角形数一致');
  }

  // 6) 封闭性预算：超限时不建巨大 Map，返回 null + skipped
  {
    const positions = makeMesh(130000);
    const closed = await api.watertightSliced(positions, { yieldTo: (fn) => fn() });
    check(closed.watertight === null, '超过预算时 watertight 为 null', String(closed.watertight));
    check(closed.skipped === true, '标记为跳过分析');
    check(closed.reason === 'triangles', '记录了跳过原因', closed.reason);
    console.log('  封闭性预算：最多 ' + api.WATERTIGHT_BUDGET.maxTriangles + ' 三角形 / ' + api.WATERTIGHT_BUDGET.maxEdges + ' 条边');
  }

  // 7) 预算内仍然给出真实结论
  {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0]);
    const closed = await api.watertightSliced(positions, { yieldTo: (fn) => fn() });
    check(closed.skipped === false && typeof closed.watertight === 'boolean', '小网格能得出封闭性结论', JSON.stringify(closed));
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
