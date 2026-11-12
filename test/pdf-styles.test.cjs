const { readSource } = require('./_source.cjs');
// 每个 pdf 视图的 className 都必须有对应样式，尤其页面盒子必须是定位祖先——
// 缺 position:relative 时绝对定位的覆盖层会跑到外层，把工具栏整条盖住。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 1) 收集 JSX 里用到的 pdf 相关类名
const names = new Set();
const patterns = [/className: '([\w-]+)'/g, /className: "([\w-]+)"/g, /className: '([\w-]+) '/g, /'([\w-]+) dshcv-[\w-]+'/g];
for (const pattern of patterns) {
  let match;
  while ((match = pattern.exec(src))) {
    const name = match[1];
    if (/dshcv-pdf/.test(name)) names.add(name);
  }
}

check(names.size >= 8, '收集到多个 PDF 类名', String(names.size));

// 2) 每个类名都要有样式规则
for (const name of Array.from(names).sort()) {
  check(src.includes("'." + name + "{") || src.includes("'." + name + ":") || src.includes('.' + name + '{'), '样式存在：' + name);
}

// 3) 页面盒子必须是定位祖先，否则覆盖层会盖到工具栏上
const boxRule = src.slice(src.indexOf("'.dshcv-pdfpagebox{"), src.indexOf("'.dshcv-pdfpagebox{") + 260);
check(boxRule.includes('position:relative'), '页面盒子是定位祖先', boxRule.split('}')[0]);

// 4) 覆盖层都限制在页面内
for (const name of ['dshcv-pdftext', 'dshcv-pdflayer', 'dshcv-pdfhit', 'dshcv-pdftexthit', 'dshcv-pdfregion', 'dshcv-pdfmarquee']) {
  const idx = src.indexOf("'." + name + "{");
  check(idx > 0, '覆盖层有样式：' + name);
  const rule = src.slice(idx, idx + 260).split('}')[0];
  check(rule.includes('position:absolute'), name + ' 为绝对定位');
  check(
    !rule.includes('pointer-events:auto') || name === 'dshcv-pdflayer' || name === 'dshcv-pdftext',
    name + ' 不抢指针',
  );
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
