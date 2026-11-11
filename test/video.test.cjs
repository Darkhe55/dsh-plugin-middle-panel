// 视频标注：时间码、区间去重、定位按钮与查看器契约。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('    const formatTime = (value) => {');
const end = src.indexOf('    const markToBlock = (mark) => {');
if (start < 0 || end < 0) {
  console.log('FAIL 时间工具锚点缺失');
  process.exit(1);
}

const factory = new Function(
  'h',
  'mutate',
  src.slice(start, end) + '\nreturn { formatTime, timeLabel, markWhere, markPlace, seekVideoMark };',
);

const seeked = [];
const api = factory(
  (type, props, ...children) => ({ type, props, children }),
  (patch) => seeked.push(patch),
);

// —— 时间码 ——
check(api.formatTime(0) === '00:00.0', '00:00.0', api.formatTime(0));
check(api.formatTime(12.44) === '00:12.4', '12.44 → 00:12.4', api.formatTime(12.44));
check(api.formatTime(72.5) === '01:12.5', '72.5 → 01:12.5', api.formatTime(72.5));
check(api.formatTime(-3) === '00:00.0', '负数夹到 0', api.formatTime(-3));
check(api.formatTime('abc') === '00:00.0', '非法输入夹到 0', api.formatTime('abc'));
check(api.formatTime(9.96) === '00:10.0', '进位正确', api.formatTime(9.96));

// —— 区间文案 ——
check(
  api.timeLabel({ start: 12.4, end: 18.7 }) === '00:12.4–00:18.7',
  '区间文案 00:12.4–00:18.7',
  api.timeLabel({ start: 12.4, end: 18.7 }),
);

// —— 位置分支 ——
check(
  api.markWhere({ kind: 'video', start: 12.4, end: 18.7 }) === '00:12.4–00:18.7',
  'markWhere 走时间码',
  api.markWhere({ kind: 'video', start: 12.4, end: 18.7 }),
);
check(
  api.markWhere({ kind: 'video', start: 3, end: 3, rect: [0.1, 0.2, 0.3, 0.4] }) === '00:03.0–00:03.0 · 画面区域',
  '带画面区域时注明',
  api.markWhere({ kind: 'video', start: 3, end: 3, rect: [0.1, 0.2, 0.3, 0.4] }),
);
check(api.markWhere({ kind: 'text', lines: [3, 5] }) === '第 3-5 行', '其他类型不受影响');

// —— 定位按钮 ——
const place = api.markPlace({ kind: 'video', start: 5, end: 6 });
check(place && place.type === 'button', '时间码是可点的按钮');
check(place && place.props.className === 'dshcv-timecode', '按钮样式类正确');
place.props.onClick();
check(seeked.length === 1 && seeked[0].seek && seeked[0].seek.time === 5, '点击写入跳转请求', JSON.stringify(seeked[0]));
check(api.markPlace({ kind: 'text', lines: [1, 1] }) === '第 1 行', '非视频标注仍是纯文本');

// —— 同一处判定（重新标注只刷新引用） ——
const locatorStart = src.indexOf("if (left.kind === 'video') {");
check(locatorStart > 0, '存在视频的同一处判定');
check(/Math\.abs\(Number\(left\.start\) - Number\(right\.start\)\) <= 0\.2/.test(src), '起点 0.2 秒内视为同一处');
check(/Math\.abs\(Number\(left\.end\) - Number\(right\.end\)\) <= 0\.2/.test(src), '终点同样比较');

// —— 格式 ——
check(/return 'video';/.test(src), '扩展名映射到 video');
['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov'].forEach((ext) => {
  check(new RegExp("'" + ext + "'").test(src.slice(src.indexOf("return 'video';") - 260, src.indexOf("return 'video';"))), '支持 .' + ext);
});
['mkv', 'avi', 'wmv', 'flv', 'mpg'].forEach((ext) => {
  check(src.includes("'" + ext + "'"), '识别 .' + ext + '（给出转码提示）');
});

// —— 查看器契约 ——
check(/function VideoDoc\(props\)/.test(src), '存在 VideoDoc');
check(/const VIDEO_NATIVE = \['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov'\]/.test(src), '原生可播列表');
check(/浏览器无法直接播放 \./.test(src), '不可播格式给出明确提示');
check(/可播放 mp4 \/ webm \/ mov \/ m4v \/ ogv/.test(src), '提示里列出可播格式');
check(/const addClip = \(start, end, rect\) => \{/.test(src), '有创建区间标注的函数');
check(/addClip\(start, end\);/.test(src), '拖动进度条生成区间标注');
check(/if \(end - start < 0\.2\) \{/.test(src), '单击不拖只打点');
check(/kind: 'video', path: doc\.path, start: from, end: to/.test(src), '标注写入 kind/start/end');
check(/addClip\(info\.current, info\.current, \[/.test(src), '框选写入画面区域与时间点');
check(/node\.currentTime = \(frames \* 1\) \/ 30;|\(frames \* 1\) \/ 30/.test(src), '逐帧步进按 1/30 秒');
check(/const rates = \[1, 1\.5, 2, 0\.5\]/.test(src), '倍速循环');
check(/if \(!seek \|\| !sameFile\(seek\.path, doc\.path\)\) return;/.test(src), '跳转按文件区分');
check(/max-width:100%;max-height:100%;display:block;cursor:pointer/.test(src), '视频保持比例（letterbox）');
check(/\.dshcv-videostage\{[^}]*align-items:center/.test(src), '舞台居中');
check(/event\.key === ' '/.test(src), '空格播放/暂停');
check(/\.dshcv-trackband\{/.test(src), '选区有可视条带');

// —— 并排时只有聚焦的那个视频出声 ——
check(/focused: !splitState\(\)\.on \|\| \(store\.splitFocus === 'b'/.test(src), '窗格焦点传给视频');
check(/const focused = props\.focused !== false;/.test(src), '未传 focused 时视为聚焦');
check(/if \(focused\) return;\s*\n\s*const node = videoRef\.current;\s*\n\s*if \(node && !node\.paused\) node\.pause\(\);/.test(src), '失去焦点时自动暂停');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
