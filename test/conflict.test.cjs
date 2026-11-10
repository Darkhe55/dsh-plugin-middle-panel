// Guards the rule that decides whether a save would clobber someone else's edit.
// It lives in the host half, so this test imports the real export rather than a copy.
let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const file = (mtimeMs, size) => ({ isFile: () => true, mtimeMs, size });

(async () => {
  const module = await import('../index.js');
  const { writeIsStale } = module;
  if (typeof writeIsStale !== 'function') {
    console.log('FAIL 未导出 writeIsStale');
    process.exit(1);
  }

  check(writeIsStale(file(2000, 100), 1000, 100, false) === true, 'mtime 变化判为冲突');
  check(writeIsStale(file(1000, 100), 1000, 100, false) === false, 'mtime 相同不判冲突');
  check(writeIsStale(file(1000, 120), 1000, 100, false) === true, '大小变化判为冲突');
  check(writeIsStale(file(1000, 120), 0, 100, false) === true, '只有大小可用时也能发现变化');
  check(writeIsStale(file(2000, 100), 0, 0, false) === false, '两者都缺失时不误报');
  check(writeIsStale(file(2000, 999), 1000, 100, true) === false, '强制覆盖跳过判定');
  check(writeIsStale(null, 1000, 100, false) === false, '文件不存在时允许新建');
  check(writeIsStale({ isFile: () => false, mtimeMs: 1, size: 1 }, 1000, 100, false) === false, '目录等非文件不拦');
  check(writeIsStale(file(1001, 100), 1000, 100, false) === false, '1ms 内的抖动容忍');

  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
})();
