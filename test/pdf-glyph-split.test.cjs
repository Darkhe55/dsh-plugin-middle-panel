// 逐字符 span：每个字的框独立定位，宽度误差不会沿行累积。
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

check(page.includes('const chars = Array.from(span.str);'), '把 run 拆成字符');
check(page.includes('shares = chars.map((ch) => measure.measureText(ch).width);'), '逐字测量宽度份额');
check(page.includes('const left = span.left + span.width * (before / total);'), '每个字按累计份额定位');
check(page.includes('const width = span.width * (share / total);'), '每个字分配自己的宽度');
check(page.includes('const scaleX = share > 0 ? width / share : 1;'), '单字缩放使盒子等于分配宽度');
check(page.includes('setItems(glyphs);'), '渲染逐字结果');
check(!page.includes('setItems(spans);'), '不再整段渲染');
check(page.includes('for (const share of shares) total += share;'), '合计份额');

// 单字符时仍走单 span 分支
check(page.includes('if (!shares || !(total > 0)) {'), '退化为单段分支');
check(page.includes('glyphs.push({'), '两个分支都产出 glyph');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
