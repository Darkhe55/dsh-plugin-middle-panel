// 搜索命中只标匹配片段，清空输入框立刻撤掉标记。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

// —— 命中范围 ——
check(view.includes('const itemWidth = Math.max(1, (Number(item.width) || 0) * viewport.scale);'), '取该段文字的宽度');
check(view.includes('const startRatio = at / characters;'), '按字符偏移算起点');
check(view.includes('const endRatio = (at + term.length) / characters;'), '按长度算终点');
check(view.includes('(transform[4] + itemWidth * startRatio) / viewport.width,'), '起点换算到页面比例');
check(view.includes('Math.max(itemWidth * (endRatio - startRatio), 2) / viewport.width,'), '只取匹配段的宽度');
check(view.includes('at = haystack.indexOf(needle, at + term.length);'), '同一段内的多次出现都收集');
check(view.includes('text: item.str.slice(at, at + term.length),'), '命中文案只存匹配片段');

// —— 清空即撤 ——
check(view.includes('if (!value.trim()) {'), '清空时进入清理分支');
check(view.includes('setHits([]);'), '清空命中');
check(view.includes('setHitIndex(0);'), '重置序号');

// —— 提到搜索正文仍要清空一次 ——
check(view.includes('if (!pdf || !term) {'), '搜索时无词也清空');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
