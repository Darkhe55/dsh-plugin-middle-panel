// 取消选择时，工具栏按钮必须同步失效：色带清空与父组件状态是一体的。
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
const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

check(page.includes('onClear,'), 'PdfPage 接收 onClear');
check(view.includes('onClear: () => setSelection(null),'), '父组件传入清空回调');
check(page.includes('if (onClear) onClear();'), '清空时通知父组件');

// 三处清空路径（无选区 / 不在本页 / 无矩形）都要触发
const clears = page.split('if (onClear) onClear();').length - 1;
check(clears >= 3, '三处清空路径都通知', String(clears));

// 每个通知都在 keepIfLost 为假的分支里
const segments = page.split('if (!keepIfLost) {');
check(segments.length - 1 >= 3, '通知受 keepIfLost 保护', String(segments.length - 1));
for (const segment of segments.slice(1)) {
  const body = segment.slice(0, 200);
  check(body.includes('setLive([]);'), '先清色带');
  check(body.includes('if (onClear) onClear();'), '再清父状态');
}

// 标注完成后也清
check(view.includes('setSelection(null);'), '标注后清空选区');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
