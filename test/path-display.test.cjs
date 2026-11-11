// The rail shows paths, so two files with the same name stay distinguishable.
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');
const start = src.indexOf('const shortenPath = (path, max) => {');
const end = src.indexOf('// One file, one tab');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const shortenPath = new Function(src.slice(start, end) + '\nreturn shortenPath;')();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

check(shortenPath('a.md') === 'a.md', '短路径原样显示');
check(shortenPath('demo/notes.md') === 'demo/notes.md', '中等路径原样显示');

const long = 'apps/web/src/components/CanvasPanel/viewer.tsx';
const short = shortenPath(long);
check(short.length <= 30, '长路径被压到上限内', short + ' (' + short.length + ')');
check(short.startsWith('apps/'), '保留开头目录段', short);
check(short.endsWith('viewer.tsx'), '保留文件名', short);
check(short.includes('…'), '中间用省略号', short);

const deep = shortenPath('a/very/deeply/nested/folder/structure/with/long/segments/readme.md');
check(deep.endsWith('readme.md'), '极深路径仍保留文件名', deep);
check(deep.startsWith('a/'), '极深路径仍保留首段', deep);

const bare = 'a'.repeat(50) + '.md';
const bareShort = shortenPath(bare);
check(bareShort.length <= 30, '无目录的超长文件名也会截断', String(bareShort.length));

check(shortenPath('') === '', '空路径安全');
check(shortenPath(undefined) === '', 'undefined 安全');

// 自定义上限（分组标题用 40）
const wide = shortenPath(long, 60);
check(wide.length <= 60, '可指定更大的上限', String(wide.length));

// 标注行必须用路径而不是文件名
check(/title: mark\.path/.test(src), '标注行带完整路径的 tooltip');
check(/shortenPath\(mark\.path\)/.test(src), '标注行使用路径');
check(!/basename\(mark\.path\) \+ ' · ' \+ markWhere/.test(src), '不再只显示文件名');
check(/title: group\.path/.test(src), '分组标题带完整路径的 tooltip');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
