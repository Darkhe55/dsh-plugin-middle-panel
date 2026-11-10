// Exercises the relocation helpers by extracting them from the source and feeding
// them edited documents: the mark must follow its passage, not its old line number.
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

const start = src.indexOf('const similarChars = (left, right) => {');
const end = src.indexOf('const addMark = (partial) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

const store = { marks: [] };
const mutate = (patch) => Object.assign(store, patch);
const persist = () => {};
const devlog = () => {};
const sameFile = (left, right) => String(left) === String(right);

const factory = new Function(
  'store',
  'mutate',
  'persist',
  'devlog',
  'sameFile',
  body + '\nreturn { relocateMarks, relocateOne, similarChars };',
);
const { relocateMarks, relocateOne } = factory(store, mutate, persist, devlog, sameFile);

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const original = ['标题', '', '第一段：这句话会被标注。', '第二段：无关内容。', '第三段：另一句话。'].join('\n');
const needle = '第一段：这句话会被标注。';
const at = original.indexOf(needle);
const context = {
  before: original.slice(Math.max(0, at - 24), at),
  after: original.slice(at + needle.length, at + needle.length + 24),
};

const mark = {
  id: 'm1',
  n: 1,
  kind: 'text',
  path: 'demo/a.md',
  quote: needle,
  lines: [3, 3],
  mtimeMs: 1000,
  context,
};

// 1) 文件前面插了两行，行号变了，内容还在
const moved = '新增行一\n新增行二\n' + original;
store.marks = [Object.assign({}, mark)];
relocateMarks('demo/a.md', moved, 2000);
const afterMove = store.marks[0];
check(afterMove.lines[0] === 5 && afterMove.lines[1] === 5, '内容下移后行号跟着更新', JSON.stringify(afterMove.lines));
check(afterMove.relocated === true && afterMove.mtimeMs === 2000, '标注被标记为已重定位', JSON.stringify({ relocated: afterMove.relocated, mtimeMs: afterMove.mtimeMs }));

// 2) 同一句话出现两次：应选上下文最接近的一处
const duplicated = ['第一段：这句话会被标注。', '中间', '第一段：这句话会被标注。'].join('\n');
const pick = relocateOne(duplicated, mark);
check(pick && pick.index === duplicated.lastIndexOf(needle), '重复内容优先选上下文匹配处', pick ? String(pick.index) : 'none');

// 3) 内容被删掉：不重定位，保持原样等待人工确认
store.marks = [Object.assign({}, mark)];
relocateMarks('demo/a.md', '完全不同的内容\n换了一整篇', 3000);
check(store.marks[0].lines[0] === 3 && !store.marks[0].relocated, '找不到时保持原行号', JSON.stringify(store.marks[0].lines));

// 4) 版本未变：不重复处理
store.marks = [Object.assign({}, mark)];
relocateMarks('demo/a.md', original, 1000);
check(!store.marks[0].relocated, '版本一致时不动标注');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
