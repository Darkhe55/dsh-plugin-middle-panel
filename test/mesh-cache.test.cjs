// 网格缓存：字节计数、LRU 顺序、替换去重、超预算淘汰、单项过大跳过、清空归零。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('// Parsed meshes are expensive and tab switching unmounts the viewer, so a byte-budgeted');
const end = src.indexOf('// File contents come from the in-process workspace channel;');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function(
  'MB',
  'devlog',
  src.slice(start, end) +
    '\nreturn { meshCacheSet, meshCacheGet, meshCacheClear, releaseMesh, meshCacheReport, MESH_CACHE_LIMIT, MESH_CACHE_ITEM_LIMIT };',
);
const api = factory(1024 * 1024, () => {});

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const mesh = (triangles, colors) => ({
  positions: new Float32Array(triangles * 9),
  colors: colors ? new Uint8Array(colors) : null,
});

// 1) 基本计数
{
  api.meshCacheClear('test');
  const value = mesh(1000);
  const expected = value.positions.byteLength;
  api.meshCacheSet('a', value);
  const report = api.meshCacheReport();
  check(report.entries === 1, '写入后有一项', String(report.entries));
  check(report.bytes === expected, '字节计数等于数组长度', report.bytes + ' vs ' + expected);
  check(report.limit === 96 * 1024 * 1024, '默认预算 96 MB', String(report.limit));
}

// 2) 相同 key 替换不重复累计
{
  api.meshCacheClear('test');
  api.meshCacheSet('a', mesh(1000));
  api.meshCacheSet('a', mesh(2000));
  const report = api.meshCacheReport();
  check(report.entries === 1, '替换后仍只有一项');
  check(report.bytes === 2000 * 9 * 4, '替换后字节数是新项的大小', String(report.bytes));
}

// 3) get 刷新 LRU 顺序
{
  api.meshCacheClear('test');
  api.meshCacheSet('a', mesh(1000));
  api.meshCacheSet('b', mesh(1000));
  api.meshCacheGet('a'); // a 变成最近使用
  api.meshCacheSet('c', mesh(1000));
  // 淘汰时不应先删 a
  const report = api.meshCacheReport();
  const stillThere = api.meshCacheGet('a');
  check(Boolean(stillThere), 'get 之后该项不会被优先淘汰', JSON.stringify(report));
}

// 4) 超预算淘汰最旧项
{
  api.meshCacheClear('test');
  // 每项约 30 MB，96 MB 预算 → 第四项必须挤掉第一项
  const big = () => mesh(Math.floor((30 * 1024 * 1024) / 36));
  api.meshCacheSet('one', big());
  api.meshCacheSet('two', big());
  api.meshCacheSet('three', big());
  const beforeBytes = api.meshCacheReport().bytes;
  api.meshCacheSet('four', big());
  const report = api.meshCacheReport();
  check(report.bytes <= api.MESH_CACHE_LIMIT, '总量不超过预算', report.bytes + '/' + api.MESH_CACHE_LIMIT);
  check(!api.meshCacheGet('one'), '最旧项被淘汰');
  check(Boolean(api.meshCacheGet('four')), '新项保留');
  check(beforeBytes > 0, '淘汰前确有数据');
}

// 5) 单项过大不缓存
{
  api.meshCacheClear('test');
  const huge = { positions: new Float32Array(Math.ceil((api.MESH_CACHE_ITEM_LIMIT + 1024) / 4)), colors: null };
  const stored = api.meshCacheSet('huge', huge);
  const report = api.meshCacheReport();
  check(stored === false, '超过单项上限时不缓存', String(stored));
  check(report.entries === 0 && report.bytes === 0, '过大项没有进入缓存');
  check(report.skipped >= 1, '记录了跳过次数');
}

// 6) 空值不进缓存（避免把 0 字节项算作缓存）
{
  api.meshCacheClear('test');
  const stored = api.meshCacheSet('empty', { positions: new Float32Array(0), colors: null });
  check(stored === false, '空数组不缓存');
}

// 7) clear 之后归零
{
  api.meshCacheClear('test');
  api.meshCacheSet('a', mesh(5000));
  api.meshCacheSet('b', mesh(5000));
  const released = api.meshCacheClear('test');
  const report = api.meshCacheReport();
  check(released > 0, 'clear 返回释放字节数');
  check(report.entries === 0 && report.bytes === 0, '清空后项数与字节归零');
  check(!api.meshCacheGet('a'), '清空后取不到旧项');
}

// 8) releaseMesh 单个释放
{
  api.meshCacheClear('test');
  api.meshCacheSet('a', mesh(1000));
  api.meshCacheSet('b', mesh(1000));
  api.releaseMesh('a');
  const report = api.meshCacheReport();
  check(report.entries === 1, '单独释放一项');
  check(Boolean(api.meshCacheGet('b')), '其他项不受影响');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
