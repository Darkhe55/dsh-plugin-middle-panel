const { readSource } = require('./_source.cjs');
// 行级宽度校正：PDF 声明的字宽若整体偏小，误差会沿行累积，所以按行实测墨迹并整行缩放。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('function PdfPage(props) {');
const end = src.indexOf('function PdfThumb(props) {');
const page = src.slice(start, end);

check(src.includes('const measureInkRight = (data, dataWidth, x0, x1, y0, y1) => {'), '有像素测量函数');
check(src.includes('const inkWidthCache = new WeakMap();'), '按文档缓存');
check(page.includes('const groups = new Map();'), '按行分组');
check(page.includes('groups.get(key).push(span);'), '同一行归到一起');
check(page.includes('const declaredSpan = last.left + last.width - first.left;'), '行声明宽度');
check(page.includes('const measured = (inkRight - first.left) / declaredSpan;'), '行实测与声明之比');
check(page.includes('if (measured > 1) factor = Math.min(1.25, measured);'), '只在偏小时放大并限幅');
check(page.includes('bucket.set(key, factor);'), '校正系数按行缓存');
check(page.includes('for (const span of group) span.width *= factor;'), '整行同倍率修正');
check(page.includes('const y0 = Math.max(0, Math.floor((first.top - first.fontHeight * 0.4) * ratio));'), '扫描带留出上行余量');
check(page.includes('const y1 = Math.min(pixels.height, Math.ceil((first.top + first.fontHeight * 1.4) * ratio));'), '扫描带留出下行余量');
check(page.includes('if (!pixels) pixels = bufferCtx.getImageData(0, 0, buffer.width, buffer.height);'), '整页像素只读一次');
check(page.includes('layoutWidth: scaleX ? width / scaleX : width,'), '布局宽度与缩放保持恒等');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
