const { readSource } = require('./_source.cjs');
// Verifies the line diff behind the "what changed" view.
const fs = require('fs');
const src = readSource();
const start = src.indexOf('const diffLines =');
const end = src.indexOf('function TextDoc(props)');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function(src.slice(start, end) + '\nreturn { diffLines };');
const { diffLines } = factory();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const base = ['# 标题', '', '第一行', '第二行', '第三行'].join('\n');

// 1) 单行替换
const edited = ['# 标题', '', '第一行', '第二行改过', '第三行'].join('\n');
const replaced = diffLines(base, edited, 3);
check(replaced.added === 1 && replaced.removed === 1, '单行替换记为一加一减', JSON.stringify({ added: replaced.added, removed: replaced.removed }));
check(
  replaced.rows.filter((row) => row.type === 'add').every((row) => row.text === '第二行改过'),
  '新增行内容正确',
);

// 2) 纯新增
const appended = base + '\n新加的一行';
const added = diffLines(base, appended, 3);
check(added.added === 1 && added.removed === 0, '追加一行只记新增', JSON.stringify({ added: added.added, removed: added.removed }));

// 3) 纯删除
const removedOne = ['# 标题', '', '第一行', '第三行'].join('\n');
const removed = diffLines(base, removedOne, 3);
check(removed.removed === 1 && added.removed >= 0, '删掉一行只记删除', JSON.stringify({ added: removed.added, removed: removed.removed }));

// 4) 完全相同
const same = diffLines(base, base, 3);
check(same.rows.length === 0 && same.added === 0 && same.removed === 0, '内容一致时没有差异行');

// 5) 两处远距离改动之间折叠成省略号
const long = Array.from({ length: 40 }, (_, index) => 'line ' + index);
const twoSpots = long.slice();
twoSpots[3] = 'line 3 changed';
twoSpots[35] = 'line 35 changed';
const banded = diffLines(long.join('\n'), twoSpots.join('\n'), 2);
check(banded.rows.some((row) => row.type === 'gap'), '远距离改动之间折叠', JSON.stringify(banded.rows.map((row) => row.type)));
check(banded.rows.length < long.length, '只保留改动附近的上下文', String(banded.rows.length));
const tailOnly = diffLines(long.join('\n'), long.map((line, i) => (i === 39 ? 'tail changed' : line)).join('\n'), 3);
check(tailOnly.rows.length <= 8, '尾部单点改动只显示末尾上下文', String(tailOnly.rows.length));

// 6) 大文件退化路径不抛错
const bigA = Array.from({ length: 800 }, (_, index) => 'a' + index);
const bigB = bigA.map((line, index) => (index % 2 ? line + 'x' : line));
let bigOk = true;
try {
  const big = diffLines(bigA.join('\n'), bigB.join('\n'), 3);
  bigOk = typeof big.added === 'number';
} catch {
  bigOk = false;
}
check(bigOk, '大输入不抛错');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}

