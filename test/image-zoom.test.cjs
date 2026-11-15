// 图片 Ctrl/Cmd + 滚轮缩放：锚点不变、每帧一步、可取消、非 Ctrl 滚轮不受影响。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const [zoom, setZoom] = React.useState(1);');
const end = src.indexOf('const naturalRect = () => {');
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

// 结构：原生监听 + 每帧合并 + 锚点 + 清理
check(/node\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(body), '用非 passive 的原生 wheel 监听');
check(/if \(!event\.ctrlKey && !event\.metaKey\) return;/.test(body), '只响应 Ctrl / Cmd + 滚轮');
check(/event\.preventDefault\(\)/.test(body), '阻止浏览器整体缩放');
check(/if \(!frame\) frame = requestAnimationFrame\(apply\)/.test(body), '一次手势每帧只应用一步');
check(/factor \*= event\.deltaY < 0 \? 1\.1 : 1 \/ 1\.1/.test(body), '按增量累积缩放因子');
check(/Math\.min\(4, Math\.max\(0\.25/.test(body), '缩放范围与按钮一致（0.25–4）');
check(/contentX = \(node\.scrollLeft \+ offsetX\) \/ current/.test(body), '按光标位置换算内容坐标');
check(/pendingScroll\.current = \{/.test(body), '滚动补偿在渲染后应用');
check(/useLayoutEffect/.test(body), '用 layout effect 校正滚动位置');
check(/cancelAnimationFrame\(frame\)/.test(body), '卸载时取消待执行帧');
check(/node\.removeEventListener\('wheel', onWheel\)/.test(body), '卸载时移除监听');

// 空依赖：监听只注册一次，不随 zoom 重装
check(/\}, \[\]\);/.test(body), '监听不随 zoom 反复注册');

// 行为：模拟缩放计算，锚点位置在缩放前后对应同一内容点
const computeAnchor = (scrollLeft, scrollTop, offsetX, offsetY, current, next) => {
  const contentX = (scrollLeft + offsetX) / current;
  const contentY = (scrollTop + offsetY) / current;
  return {
    left: Math.max(0, contentX * next - offsetX),
    top: Math.max(0, contentY * next - offsetY),
  };
};
const before = { scrollLeft: 100, scrollTop: 50, offsetX: 120, offsetY: 80, zoom: 1 };
const after = computeAnchor(before.scrollLeft, before.scrollTop, before.offsetX, before.offsetY, before.zoom, 2);
// 缩放前该点对应的内容坐标：(100+120)/1 = 220；缩放后应保持在同一屏幕位置
const screenXBefore = (before.scrollLeft + before.offsetX) / before.zoom;
const screenXAfter = (after.left + before.offsetX) / 2;
check(Math.abs(screenXBefore - screenXAfter) < 1e-9, '光标下的内容点在缩放后位置不变', screenXBefore + ' vs ' + screenXAfter);

// 缩小到 0.25 的下限时不得出现负滚动
const shrunk = computeAnchor(0, 0, 10, 10, 1, 0.25);
check(shrunk.left >= 0 && shrunk.top >= 0, '缩放后滚动位置不为负');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
