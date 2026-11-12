const { readSource } = require('./_source.cjs');
// 命中与跟随标注都要把目标滚到可视区中央，且能承受标注列表展开引起的布局变化。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

// —— 居中对齐 ——
check(view.includes('const scrollToPage = (pageNumber, rect) => {'), '滚到指定页与矩形');
check(view.includes('const pageRect = node.getBoundingClientRect();'), '用实际矩形计算');
check(
  view.includes('scroller.scrollTop = Math.max(0, box.absolute - (scroller.clientHeight - box.height) / 2);'),
  '把目标放到可视区中央',
);
check(view.includes('window.requestAnimationFrame(() => place());'), '下一帧再校正');
check(view.includes('window.setTimeout(() => place(), 140);'), '布局稳定后再校正（列表展开）');

// —— 命中跳转带上矩形 ——
check(view.includes('scrollToPage(hit.page, hit.rect || (hit.rects && hit.rects[0]));'), '命中跳转定位到具体矩形');
check(
  view.includes('if (found.length) scrollToPage(found[0].page, found[0].rect || (found[0].rects && found[0].rects[0]));'),
  '首次搜索同样居中',
);

// —— 跟随标注 ——
check(view.includes('// Following a mark: hovering its rail row brings the page to it'), '有跟随逻辑');
check(view.includes('scrollToPage(Number(hoverMark.page) || 1, hoverMark.rect);'), '按标注页码与矩形滚动');
check(view.includes('}, [hoverMark ? hoverMark.id : "", state.status]);'), '跟随随悬停变化触发');

// —— 缩略图仍可跳页 ——
check(view.includes('onPick: scrollToPage,'), '缩略图仍能跳页');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
