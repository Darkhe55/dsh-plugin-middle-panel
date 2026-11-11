// 视频标注必须能走完现有的发送流程：markToBlock → buildMarkdown → 发送。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// —— 1. 体积上限 ——
check(/const LIMITS = \{[^}]*video: 256/.test(src), '视频单独给到 256MB 上限');
check(/kind === 'video'\s*\n?\s*\? '视频 '/.test(src), '视频超限时给针对性提示');
check(/请先裁切，或用更低的码率重新导出/.test(src), '提示里给出可执行的建议');

// —— 2. markToBlock 输出 ——
const start = src.indexOf('    const formatTime = (value) => {');
const end = src.indexOf('    const exportMarks = () => {');
const stop = src.indexOf('    const sendOneMark = (mark) => {');
const blockEnd = stop > end && end < 0 ? stop : end;
if (start < 0 || blockEnd < 0) {
  console.log('FAIL 锚点缺失');
  process.exit(1);
}

const factory = new Function(
  'h',
  'mutate',
  'store',
  src.slice(start, blockEnd) + '\nreturn { formatTime, timeLabel, markWhere, markToBlock };',
);

const api = factory(() => null, () => {}, { marks: [] });

const clip = { n: 1, kind: 'video', path: 'demo/clip.mp4', start: 12.4, end: 18.7, note: '转场太慢' };
const text = api.markToBlock(clip);
check(text.startsWith('1. `demo/clip.mp4` — 00:12.4–00:18.7'), '块头是路径 + 时间码', text.split('\n')[0]);

const withQuote = api.markToBlock({ kind: 'video', n: 2, path: 'a.mp4', start: 0, end: 3.2, quote: '第 3 秒的画面' });
check(/^2\. `a\.mp4` — 00:00\.0–00:03\.2/.test(withQuote), '第二条编号连续', withQuote.split('\n')[0]);
check(withQuote.includes('> 第 3 秒的画面'), '引用行保留');

// 单点标注（start === end）
const point = api.markToBlock({ kind: 'video', n: 3, path: 'a.mp4', start: 5, end: 5 });
check(point.includes('00:05.0–00:05.0'), '单点标注两端相同', point.split('\n')[0]);

// 带区域
const region = api.markToBlock({ kind: 'video', n: 4, path: 'a.mp4', start: 2, end: 2, rect: [0.1, 0.2, 0.3, 0.4] });
check(region.includes('· 画面区域'), '区域标注注明', region.split('\n')[0]);

// —— 3. 与过期判断共存 ——
check(/const markStale = \(mark\) => \{/.test(src), '存在过期判断');
check(/Boolean\(mark\.mtimeMs && current && /.test(src), '视频标注没有 mtimeMs，不会被判过期');

// —— 4. 编号与清空走通用路径 ——
check(/const marks = store\.marks\.filter\(\(mark\) => !mark\.done\)/.test(src), '发送时过滤已处理（对视频同样生效）');
check(/const buildMarkdown = \(\) => \{/.test(src), 'buildMarkdown 统一生成正文');
check(/lines\.push\(markToBlock\(mark\)\)/.test(src), '每条标注都走 markToBlock');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
