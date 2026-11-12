// 取消选择时，工具栏按钮必须同步失效；并且只有持有选区的页面可以清空。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('function PdfPage(props) {');
const end = src.indexOf('function PdfThumb(props) {');
const page = src.slice(start, end);
const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

check(page.includes('onClear,'), 'PdfPage 接收 onClear');
check(view.includes('onClear: (pageNumber) => setSelection('), '父组件只清自己的选区');
check(view.includes('now && now.page === pageNumber ? null : now'), '按页码判断所有权');
check(page.includes('if (onClear) onClear(pageNumber);'), '清理时带上页码');

const clears = page.split('if (onClear) onClear(pageNumber);').length - 1;
check(clears >= 3, '三处清空路径都通知', String(clears));

const segments = page.split('if (!keepIfLost) {');
check(segments.length - 1 >= 3, '通知受 keepIfLost 保护', String(segments.length - 1));
for (const segment of segments.slice(1)) {
  const body = segment.slice(0, 200);
  check(body.includes('setLive([]);'), '先清色带');
  check(body.includes('if (onClear) onClear(pageNumber);'), '再清父状态');
}

check(view.includes('setSelection(null);'), '标注后清空选区');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
