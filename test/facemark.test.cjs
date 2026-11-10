// A 3D mark must carry enough to find the same face again.
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');
const start = src.indexOf('const markToBlock = (mark) => {');
const end = src.indexOf('const buildMarkdown');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function('markWhere', 'basename', src.slice(start, end) + '\nreturn markToBlock;');
const markToBlock = factory(
  (mark) => mark.label || mark.selector || 'x',
  (path) => String(path).split('/').pop(),
);

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const face = {
  n: 1,
  path: 'demo/sample.dae',
  kind: 'spot',
  label: '三角面 #0（共 2 面）',
  quote: '0.888, 0.601, 0.000',
  triangle: 0,
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
  normal: [0, 0, 1],
  area: 0.5,
  place: '中·中·前',
  triangles: 2,
  note: '这个面要加厚',
};
const block = markToBlock(face);
check(block.includes('三角面 #0'), '标题含面号');
check(block.includes('共 2 面'), '标题含该模型的面总数');
check(block.includes('顶点 (0.000, 0.000, 0.000) (1.000, 0.000, 0.000) (1.000, 1.000, 0.000)'), '三个顶点都在', block.split('\n').join(' | '));
check(block.includes('法线 (0.000, 0.000, 1.000)'), '法线在');
check(block.includes('面积 0.500'), '面积在');
check(block.includes('位于模型 中·中·前'), '粗位置在');
check(block.includes('意见：这个面要加厚'), '意见在');

const old = markToBlock({ n: 2, path: 'a.dae', kind: 'spot', label: '三角形 #7', quote: '1,2,3', triangle: 7 });
check(!old.includes('顶点'), '旧标注不会输出空的顶点行（向后兼容）');
check(old.includes('三角形 #7'), '旧标注仍可读');

const noFace = markToBlock({ n: 3, path: 'x.md', kind: 'text', quote: 'hello', note: '' });
check(!noFace.includes('顶点'), '非 3D 标注不受影响');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
