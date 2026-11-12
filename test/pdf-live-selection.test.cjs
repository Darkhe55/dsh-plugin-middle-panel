// 路线 B：浏览器负责选区语义，我们负责外观。
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

// 原生高亮关闭（含旧的 span 级规则）
check(src.includes("'.dshcv-pdftext ::selection{background:transparent;color:transparent}'"), '全局选区透明');
check(src.includes("'.dshcv-pdftext span::selection{background:transparent;color:transparent}'"), 'span 级选区也透明');
check(!src.includes('span::selection{background:rgba(79,140,255'), '没有残留的原生配色');

// 自绘色带
check(src.includes("'.dshcv-pdfsel{position:absolute;background:rgba(79,140,255,.24)"), '自绘选区样式');
check(page.includes('className: "dshcv-pdfsel",'), '页面渲染自绘选区');
check(page.includes('live.map((band, bandIndex) =>'), '按带子渲染');

// 驱动源仍是浏览器选区
check(page.includes('document.addEventListener("selectionchange", handler);'), '监听 selectionchange');
check(page.includes('const range = active.getRangeAt(0);'), '仍取原生区间');
check(page.includes('if (!range || !wrap.contains(range.commonAncestorContainer)) {'), '只认本页选区');
check(!page.includes('onMouseUp: readSelection'), '不再依赖 mouseup 一次性读取');

// 合并同行的相邻片段
check(page.includes('const merged = [];'), '合并相邻片段');
check(page.includes('rect.left <= last.right + 0.6'), '同一行且相接才合并');
check(page.includes('const bands = merged.map((item) => ['), '合并后转成百分比');

// 缩放后重算
check(page.includes('}, [width]);'), '尺寸变化时重算');

// 与标注共用同一套渲染（颜色家族一致）
check(src.includes("'..dshcv-pdftexthit{") || src.includes("'.dshcv-pdftexthit{position:absolute;background:rgba(79,140,255,.10)"), '标注色带仍在');
check(page.includes('if (!onSelect) return;'), '选区同时上报给标注按钮');
check(page.includes('selectedTextInVisualOrder(wrap, range)'), '引用原文仍按视觉顺序');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
