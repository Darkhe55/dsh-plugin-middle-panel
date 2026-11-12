// 可选区域的宽度必须等于页面文字宽度：scaleX 会同时缩小布局盒，
// 所以布局宽度要按缩放反算回来；宽度本身按行做像素级校正。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('function PdfPage(props) {');
const end = src.indexOf('function PdfThumb(props) {');
const page = src.slice(start, end);

check(page.includes('const declared = Math.max(0, Number(item.width) || 0) * viewport.scale;'), '声明宽度作为基准');
check(page.includes('span.layoutWidth = scaleX ? span.width / scaleX : span.width;'), '布局宽度按缩放反算');
check(page.includes("transformOrigin: '0 0',"), '缩放从左侧开始，左边界不动');
check(
  page.includes("transform: item.scaleX && item.scaleX !== 1 ? 'scaleX(' + item.scaleX + ')' : undefined,"),
  '仍按测量结果做横向缩放',
);
check(!page.includes("overflow: 'hidden',"), '不再裁剪（避免切掉最后一个字形）');
check(src.includes('const inkWidthCache = new WeakMap();'), '实测结果按文档缓存');
check(page.includes('if (measured > 1) factor = Math.min(1.25, measured);'), '偏小时整行放大');
check(page.includes("width: item.layoutWidth ? item.layoutWidth + 'px' : undefined,"), "span 使用反算宽度");

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
