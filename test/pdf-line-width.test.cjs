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

check(!src.includes('measureInkRight'), '不再有像素测量');
check(!src.includes('inkWidthCache'), '不再有墨迹缓存');
check(page.includes('const declared = Math.max(0, Number(item.width) || 0) * viewport.scale;'), '宽度直接取声明值');
check(!page.includes('groups.get(key).push'), '不再按行归并');
check(page.includes('width: declared'), 'run 宽度即声明宽度');
check(!page.includes('inkRight'), '不再测量墨迹');
check(!src.includes('Math.min(1.25'), '不再限幅放大');
check(!page.includes('bucket.set(key, factor)'), '不再缓存校正系数');
check(!page.includes('span.width *= factor'), '不再整行修正');
check(!page.includes('pixels = bufferCtx.getImageData'), '不再扫描像素');
check(page.includes('const measure = document.createElement'), '仍有测量用 canvas');
check(src.includes('function PdfCanvasDoc'), '视图仍完整');
check(page.includes('layoutWidth: scaleX ? width / scaleX : width,'), '布局宽度与缩放保持恒等');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
