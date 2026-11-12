const { readSource } = require('./_source.cjs');
// 缩放稳定性：布局尺寸同步、位图双缓冲、滚轮按帧合并。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const pageStart = src.indexOf('function PdfPage(props) {');
const pageEnd = src.indexOf('function PdfThumb(props) {');
const page = src.slice(pageStart, pageEnd);
const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

// —— 1. 布局尺寸同步 ——
check(
  page.includes('const width = Math.max(0, (baseSize && baseSize.width ? baseSize.width : 612) * scale);'),
  '宽度由基准尺寸乘缩放直接得出',
);
check(
  page.includes('const height = Math.max(0, (baseSize && baseSize.height ? baseSize.height : 792) * scale);'),
  '高度同理',
);
check(
  page.includes("style: width ? { width: width + 'px', height: height + 'px' } : null,"),
  '盒子尺寸直接用于布局',
);
check(!page.includes('setSize('), '不再依赖渲染结果设置尺寸');
check(view.includes('setBaseSize({ width: firstBox.width, height: firstBox.height });'), '加载后先取第 1 页尺寸');
check(view.includes('setPageSizes(table);'), '后台补齐逐页尺寸');
check(view.includes('baseSize: pageSizes[pageNumber] || baseSize,'), '按页传入（缺省用第 1 页）');

// —— 2. 位图双缓冲 ——
check(page.includes("const buffer = document.createElement('canvas');"), '离屏缓冲画布');
check(page.includes('await page.render({ canvasContext: bufferCtx, viewport }).promise;'), '渲染到缓冲');
check(page.includes('canvas.width = buffer.width;'), '替换时才改尺寸');
check(page.includes('ctx.drawImage(buffer, 0, 0);'), '一次性合成');
check(page.includes('setRenderedAt(viewport.width);'), '记录清晰度状态');

// —— 3. 画布铺满盒子（拉伸过渡） ——
check(
  src.includes("'.dshcv-pdfpagebox canvas{position:absolute;inset:0;width:100%;height:100%;display:block}'"),
  '画布铺满盒子，位图滞后时被拉伸',
);
check(src.includes("'.dshcv-pdfpagebox[data-sharp=\"0\"] canvas{image-rendering:auto}'"), '有清晰度标记');
check(src.includes("'data-sharp':"), '页面标记清晰状态');
check(src.includes("'.dshcv-pdfpagebox{contain:paint}'"), '限制重绘范围');

// —— 4. 滚轮按帧合并 ——
check(view.includes('let pendingFactor = 1;'), '累积缩放系数');
check(view.includes('pendingFactor *= event.deltaY < 0 ? 1.1 : 1 / 1.1;'), '按方向累积');
check(view.includes('if (!frame) frame = window.requestAnimationFrame(applyZoom);'), '每帧只应用一次');
check(view.includes('const applyZoom = () => {'), '有单帧应用函数');
check(view.includes('if (!frame) {'), '手势开始才记录锚点');

// —— 5. 锚点仍逐帧钉住 ——
check(view.includes('if (Date.now() < until) window.requestAnimationFrame(tick);'), '短时间逐帧校正');

// —— 回归：功能未丢 ——
check(page.includes('readSelection'), '选区仍在');
check(page.includes('onRegion'), '框选仍在');
check(page.includes('dshcv-pdfhit'), '命中高亮仍在');
check(view.includes('const search = async () => {'), '搜索仍在');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
