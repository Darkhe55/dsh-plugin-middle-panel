const { readSource } = require('./_source.cjs');
// 输入框内的方向键必须归输入框；定位失败要能看见原因。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— ownsKeyboard 的顺序 ——
const start = src.indexOf('    const ownsKeyboard = (event, root) => {');
const end = src.indexOf('\n    };', start);
const body = src.slice(start, end);
const editableAt = body.indexOf("target.closest('input,textarea,select,[contenteditable=\"true\"]')");
const hoverAt = body.indexOf("root.matches(':hover')");
check(editableAt > 0 && hoverAt > 0, '两个分支都存在');
check(editableAt < hoverAt, '输入框判断在悬停判断之前', 'editable=' + editableAt + ' hover=' + hoverAt);
check(
  body.slice(editableAt, editableAt + 120).includes('return false'),
  '输入框内直接返回 false（面板不接管）',
);

// —— 定位后的帧强制 ——
check(has('const nudgeFrame = (node) => {'), '有强制出帧的函数');
check(has('node.requestVideoFrameCallback(() => {'), '用帧回调判断是否真的出帧');
check(has('const started = current.play();'), '未出帧时脉冲播放一次');
check(has('started.then(stop).catch(() => {})'), '脉冲后立刻暂停');
check(has('nudgeFrame(node);'), '定位后调用');

// —— 诊断可见 ——
check(has('const flashLong = (text) => {'), '有长提示');
check(has('}, 4000);'), '诊断信息停留 4 秒');
check(has('flashLong('), '定位失败走长提示');
check(has('定位没生效：目标 '), '诊断包含目标时间');
check(has('readyState '), '诊断包含 readyState');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
