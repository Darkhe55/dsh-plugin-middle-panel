const { readSource } = require('./_source.cjs');
// A1: a 3D mark must survive a re-export, and admit when it cannot.
// The relocation now runs in slices and resolves a promise, so every case awaits it.
const fs = require('fs');
const src = readSource();
const start = src.indexOf('const relocateSpotMarks = (path, positions, radius');
const end = src.indexOf('const addMark = (partial) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
// 从 relocationMetrics 开始切，保证被求值的片段自带状态与常量。
const sliceFrom = src.lastIndexOf('const relocationMetrics = {', start);
const body = src.slice(sliceFrom >= 0 ? sliceFrom : start, end);

const factory = new Function(
  'store',
  'sameFile',
  'mutate',
  'persist',
  'devlog',
  'clock',
  body + '\nreturn relocateSpotMarks;',
);

const run = async (marks, positions, radius = 10) => {
  const store = { marks };
  const state = { mutated: null, persisted: 0 };
  const relocate = factory(
    store,
    (a, b) => a === b,
    (partial) => {
      state.mutated = partial;
      store.marks = partial.marks;
    },
    () => {
      state.persisted += 1;
    },
    () => {},
    () => Date.now(),
  );
  await relocate('m.stl', positions, radius, { yieldTo: (fn) => fn() });
  return { marks: store.marks, mutated: state.mutated, persisted: state.persisted };
};

// 一个四边形：两个三角形，重心分别是 (0.667,0.333,0) 和 (0.333,0.667,0)
const square = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
const mark = (patch) => ({
  id: 'a',
  n: 1,
  path: 'm.stl',
  kind: 'spot',
  triangle: 0,
  centroid: [0.667, 0.333, 0],
  ...patch,
});

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const main = async () => {
  // 1) 索引还指向同一个面：不动
  let out = await run([mark({})], square);
  check(out.persisted === 0, '索引仍然正确时不写存储');

  // 2) 面序颠倒：索引 0 现在是另一个面，应重新定位到 1
  const flipped = new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0]);
  out = await run([mark({})], flipped);
  check(out.marks[0].triangle === 1, '面序变化后按重心找回原来的面', String(out.marks[0].triangle));
  check(out.marks[0].relocated === true, '重定位后标记 relocated');

  // 3) 模型被彻底换掉：找不到就近的面，应标记失效
  const far = new Float32Array([100, 100, 100, 101, 100, 100, 101, 101, 100]);
  out = await run([mark({})], far, 1);
  check(out.marks[0].spotStale === true, '找不到对应面时标记 spotStale');
  check(out.marks[0].triangle === 0, '失效时不篡改面号');

  // 4) 已经失效的标注再跑一次不应反复写存储
  out = await run([mark({ spotStale: true })], far, 1);
  check(out.persisted === 0, '已失效的标注不重复写入');

  // 5) 旧标注（没有 centroid）保持原样
  out = await run([{ id: 'b', n: 2, path: 'm.stl', kind: 'spot', triangle: 1 }], square);
  check(out.marks[0].triangle === 1 && out.persisted === 0, '没有重心信息的旧标注被跳过');

  // 6) 别的文件不参与
  out = await run([mark({ path: 'other.stl' })], square);
  check(out.persisted === 0, '别的文件的标注不参与重定位');

  // 7) 非 spot 类型不参与
  out = await run([mark({ kind: 'text' })], square);
  check(out.persisted === 0, '文本标注不参与 3D 重定位');

  // 8) 空模型不抛错
  out = await run([mark({})], new Float32Array(0));
  check(out.persisted === 0, '空网格安全返回');

  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
};

main().catch((error) => {
  console.log('FAIL 测试抛错 → ' + (error && error.stack));
  process.exit(1);
});
