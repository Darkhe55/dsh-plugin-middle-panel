// C3/C4: sending groups by file and skips the marks already ticked off.
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');
const start = src.indexOf('const buildMarkdown = () => {');
const end = src.indexOf('const insertIntoComposer = (text) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function(
  'store',
  'markToBlock',
  src.slice(start, end) + '\nreturn buildMarkdown;',
);
const markToBlock = (mark) => '   block#' + mark.n + ' ' + mark.path;

const build = (marks) => factory({ marks }, markToBlock)();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const marks = [
  { id: 'a', n: 1, path: 'x.md' },
  { id: 'b', n: 2, path: 'x.md' },
  { id: 'c', n: 3, path: 'y.png' },
];

// 1) 按文件分组
let text = build(marks);
const heads = text.match(/### `/g) || [];
check(heads.length === 2, '两个文件各有一个分组标题', String(heads.length));
check(text.indexOf('### `x.md`') < text.indexOf('block#1'), '分组标题在第一条之前');
check(text.indexOf('### `y.png`') < text.indexOf('block#3'), '第二个文件的标题在自己的条目之前');

// 2) 已处理的不发送
text = build([marks[0], { ...marks[1], done: true }, marks[2]]);
check(!text.includes('block#2'), '已处理的标注不出现');
check(text.includes('block#1') && text.includes('block#3'), '其余标注仍在');
check((text.match(/### `/g) || []).length === 2, '分组仍然正确');

// 3) 全部处理完：不发空消息
text = build(marks.map((mark) => ({ ...mark, done: true })));
check(text === '', '全部已处理时返回空串', JSON.stringify(text));

// 4) 同文件连续条目只出现一次标题
text = build(marks);
check((text.match(/### `x.md`/g) || []).length === 1, '同一文件只出现一个标题');

// 5) 顺序按编号
text = build([marks[2], marks[0], marks[1]]);
check(text.indexOf('block#1') < text.indexOf('block#2'), '条目不按数组顺序而是按编号排序');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
