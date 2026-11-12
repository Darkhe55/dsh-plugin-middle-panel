// 组件用到的 props 必须真的被解构出来：hoverBands 漏解构曾让整个 PDF 视图被隔离。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const bodyOf = (name, nextName) => {
  const start = src.indexOf('function ' + name + '(props) {');
  const end = src.indexOf('function ' + nextName + '(props) {');
  if (start < 0 || end < 0) return '';
  return src.slice(start, end);
};

const page = bodyOf('PdfPage', 'PdfThumb');
check(page !== '', 'PdfPage 存在');

const propsHead = page.slice(0, page.indexOf('} = props;'));
const declared = propsHead
  .split('\n')
  .map((line) => line.trim().replace(/,$/, ''))
  .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line));

const expected = [
  'pdf',
  'pageNumber',
  'scale',
  'markMode',
  'onRegion',
  'onSelect',
  'onVisible',
  'registerEl',
  'pageHits',
  'activeHit',
  'pageMarks',
  'hoverBands',
  'hoverRect',
  'pdfjs',
];

for (const name of expected) {
  check(declared.includes(name), 'PdfPage 解构了 ' + name);
}

// 渲染里出现过的标识符必须都在解构列表里（漏一个就是运行时 ReferenceError）
const used = ['hoverBands', 'hoverRect', 'pageMarks', 'pageHits', 'activeHit', 'markMode'].filter((name) =>
  page.includes(name + ' &&') || page.includes(name + '.map(') || page.includes(name + ' ? '),
);
check(used.length >= 4, '检测到多个 props 使用点', used.join(','));
for (const name of used) {
  check(declared.includes(name), '使用点已解构：' + name);
}

check(page.includes('hoverBands && hoverBands.length'), '悬停带子仍有使用');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
