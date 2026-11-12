// 中文选区也必须让标注按钮出现：取词失败不能中断选区上报。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('const readSelection = (keepIfLost) => {');
const end = src.indexOf('const toFraction = (event) => {', start);
const read = src.slice(start, end);

check(read.includes('let text = "";'), '文本默认空串');
check(read.includes('try {'), '取词有异常保护');
check(read.includes('} catch (error) {'), '异常被捕获');
check(read.includes('text = String(range.toString() || "").replace(/\\s+$/g, "");'), '中文回退到原生文本');
check(!read.includes('if (!text.trim()) return;'), '空文本不再阻止上报');
check(read.includes('onSelect('), '仍然上报选区');

// 视觉顺序函数本身也要有回退
const helperStart = src.indexOf('const selectedTextInVisualOrder = (wrap, range) => {');
const helperEnd = src.indexOf('function PdfPage(props) {');
const helper = src.slice(helperStart, helperEnd);
check(helper.includes('if (!parts.length) return String(range.toString() || "");'), '无片段时回退');
check(helper.includes('return joined.trim() ? joined : String(range.toString() || "");'), '片段为空时回退');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
