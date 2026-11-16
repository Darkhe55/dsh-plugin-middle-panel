// 模型预算诊断：拒绝原因、估算三角形、统一限额来源，避免"为什么打不开"无处可查。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const MESH_LIMITS = {');
const end = src.indexOf('/** Chunked float storage');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const api = new Function(
  'MAX_PREVIEW_BYTES',
  'MAX_PREVIEW_TRIANGLES',
  'WATERTIGHT_BUDGET',
  src.slice(start, end) + '\nreturn { modelBudgetCheck, modelBudgetReport, recordModelBudget, estimateTriangles, formatBytes, MESH_LIMITS };',
)(192 * 1024 * 1024, 800000, { maxTriangles: 120000, maxVertices: 200000, maxEdges: 400000 });

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 1) 正常体积放行
{
  const result = api.modelBudgetCheck({ size: 10 * 1024 * 1024 }, 'a.glb');
  check(result.ok === true, '10 MB 模型放行');
  check(result.estimatedTriangles > 0, '给出三角形估算', String(result.estimatedTriangles));
  check(result.limit === api.MESH_LIMITS.bytes, '限额来自统一常量');
}

// 2) 超大文件拒绝，且消息里带数字与单位
{
  const result = api.modelBudgetCheck({ size: 300 * 1024 * 1024 }, 'big.glb');
  check(result.ok === false, '300 MB 被拒绝');
  check(result.reason === 'bytes', '拒绝原因是体积', result.reason);
  check(/MB/.test(result.message) && /三角形/.test(result.message), '消息里有体积与估算', result.message);
  check(result.message.includes('300 MB'), '消息包含实际体积', result.message.slice(0, 40));
}

// 3) 边界：正好等于上限放行，超 1 字节拒绝
{
  const exact = api.modelBudgetCheck({ size: api.MESH_LIMITS.bytes }, 'edge.glb');
  const over = api.modelBudgetCheck({ size: api.MESH_LIMITS.bytes + 1 }, 'edge.glb');
  check(exact.ok === true, '正好等于上限时放行');
  check(over.ok === false, '超出 1 字节即拒绝');
}

// 4) 没有大小信息（探测失败）时不误杀
{
  const result = api.modelBudgetCheck(null, 'unknown.glb');
  check(result.ok === true, '体积未知时放行，交给解析器判断');
  check(result.size === 0, '体积记为 0');
}

// 5) 估算随体积单调增长
{
  const small = api.estimateTriangles(1024);
  const large = api.estimateTriangles(1024 * 1024);
  check(large > small, '估算随体积增长', small + ' → ' + large);
  check(api.estimateTriangles(0) === 0, '零体积估算为 0');
}

// 6) 最近一次结果可被读取（成功与拒绝两条路径）
{
  api.recordModelBudget({ path: 'a.glb', refused: '', size: 1024, triangles: 100, decimated: false });
  const report = api.modelBudgetReport();
  check(report.last && report.last.triangles === 100, '成功路径的记录可读回');
  check(report.limits.triangles === 800000, '报告包含三角形上限', String(report.limits.triangles));
  check(
    report.limits.watertightForegroundTriangles === 120000 && report.limits.sliceHardCapMs === 16,
    '报告包含封闭性与分片预算',
  );
  api.recordModelBudget({ path: 'big.glb', refused: 'bytes', size: 999, limit: 1 });
  const refused = api.modelBudgetReport();
  check(refused.last.refused === 'bytes', '拒绝路径的记录可读回');
  check(typeof refused.last.at === 'number', '记录带时间戳');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
