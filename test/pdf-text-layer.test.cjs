const { readSource } = require('./_source.cjs');
// PDF 文字层：可选中、可复制，并能把选中文字变成标注。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

const start = src.indexOf('function PdfPage(props) {');
const end = src.indexOf('function PdfThumb(props) {');
const body = src.slice(start, end);

// —— 提取 ——
check(body.includes('await textContentOf(pdf, pageNumber)'), '读取页面文字（带缓存）');
check(body.includes('Util.transform(viewport.transform, item.transform)'), '按页面变换定位每段文字');
check(body.includes('Math.hypot(transform[2], transform[3])'), '字号由变换推出');
check(body.includes('setItems(glyphs)'), '结果进入页面状态');
check(body.includes('!item.str.trim()'), '跳过空片段');

// —— 渲染层 ——
check(body.includes("className: 'dshcv-pdftext'"), '有文字层容器');
check(body.includes("left: item.left + 'px'"), '按像素定位');
check(body.includes("fontSize: item.fontHeight + 'px'"), '字号对齐');
check(body.includes('item.str,'), '写入真实文本');

// —— 样式 ——
check(has("'.dshcv-pdftext{position:absolute;inset:0"), '文字层覆盖页面');
check(has('color:transparent'), '文字透明，视觉仍为位图');
check(src.includes("'.dshcv-pdfsel{position:absolute;background:rgba(79,140,255,.24)"), '选区由我们绘制');
check(has('user-select:text'), '允许选中');

// —— 选中 → 标注 ——
check(body.includes('const readSelection = (keepIfLost) => {'), '能读取选区');
check(body.includes('active.getRangeAt(0)'), '支持多行选区');
check(body.includes('const range = active.getRangeAt(0);'), '取一次选区区间');
check(body.includes('document.addEventListener("selectionchange", handler);'), '选区随选择变化记录');
check(src.includes('const markSelection = () => {'), '可把选区变成标注');
check(src.includes('text: true,'), '标注标记为文字来源');
check(src.includes('quote: selection.text,'), '引用原文');
check(src.includes("'标注选中文字'"), '工具栏有对应按钮');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
