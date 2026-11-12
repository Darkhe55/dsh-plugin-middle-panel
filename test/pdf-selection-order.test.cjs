const { readSource } = require('./_source.cjs');
// 选中文字按视觉顺序拼接：DOM 顺序不等于阅读顺序时，引用原文必须与看到的一致。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('const selectedTextInVisualOrder = (wrap, range) => {');
const end = src.indexOf('function PdfPage(props) {');
const helper = src.slice(start, end);
check(start > 0, '存在视觉顺序取词函数');
check(helper.includes('wrap.querySelectorAll(".dshcv-pdftext span")'), '逐个 span 取字');
check(helper.includes('range.comparePoint(node, offset) !== 0'), '按区间判定字符是否被选中');
check(helper.includes('node.nodeValue.slice(start, end)'), '取出被选中的子串');
check(helper.includes('Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left'), '先按行、再按列排序');
check(helper.includes('parts.map((part) => part.text).join("")'), '按视觉顺序拼接');
check(helper.includes('if (!parts.length) return String(range.toString() || "");'), '空结果回退到原生文本');

const readStart = src.indexOf('const readSelection = (keepIfLost) => {');
const readEnd = src.indexOf('const onDown = (event) => {', readStart);
const read = src.slice(readStart, readEnd > 0 ? readEnd : readStart + 2000);
check(read.includes('const range = active.getRangeAt(0);'), '只取一次 range');
check(read.includes('selectedTextInVisualOrder(wrap, range)'), '引用原文来自视觉顺序结果');
check(!read.includes('String(active.toString()'), '不再直接用 DOM 顺序文本');
check(read.includes('Array.from(range.getClientRects())'), '高亮矩形仍取区间片段');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
