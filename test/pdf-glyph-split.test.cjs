// 逐字符 span + 累积宽度分配：每个字的框独立，切片之和恒等于整个 run 的宽度。
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

// 度量：显式 Helvetica 兼容族 + 累积表
check(src.includes('const MEASURE_FONT = "Arial, Helvetica, sans-serif";'), '测量字体为 Helvetica 兼容族');
check(src.includes('const advanceTable = (text, fontSize) => {'), '有累积宽度表');
check(page.includes('const table = chars.length > 1 ? advanceTable(span.str, span.fontHeight) : null;'), 'run 用累积表拆分');

// 逐字切片
check(page.includes('const from = shares[index] / total;'), '切片起点按宽度比例');
check(page.includes('const to = shares[index + 1] / total;'), '切片终点按宽度比例');
check(page.includes('const left = span.left + span.width * from;'), '每个字独立定位');
check(page.includes('const width = span.width * (to - from);'), '每个字分配自己的宽度');
check(page.includes('const natural = shares[index + 1] - shares[index];'), '单字自然宽度');
check(page.includes('const scaleX = natural > 0 ? width / natural : 1;'), '单字缩放到分配宽度');
check(page.includes('setItems(glyphs);'), '渲染逐字结果');
check(page.includes('if (!shares || !(total > 0)) {'), '退化为单段分支');

// 搜索也用同一套宽度映射
check(src.includes('piece.cumulative = cumulative;'), '搜索片段有累积宽度');
check(
  src.includes('const a = piece.cumTotal > 0 ? piece.cumulative[from] / total : from / Math.max(1, piece.length);'),
  '搜索起点按宽度映射',
);
check(
  src.includes('const b = piece.cumTotal > 0 ? piece.cumulative[tail] / total : tail / Math.max(1, piece.length);'),
  '搜索终点按宽度映射',
);

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
