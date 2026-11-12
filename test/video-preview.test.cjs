// 预览与落定分离、右键菜单定位、Shift 平移、悬停虚线。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— 预览不再移动落定位置 ——
check(has('const previewing = React.useRef(false);'), '有"正在预览"标记');
check(has('previewing.current = true;'), '预览时置位');
check(
  !/previewFrame\.current = requestAnimationFrame\(\(\) => \{[\s\S]{0,400}setInfo\(/.test(src),
  '预览的 rAF 里不再写 info',
);
check(has('if (previewing.current) return;'), 'timeupdate 在预览时被忽略');
check(has('previewing.current = false;'), '落定或离开时清除预览态');
check(has('node.currentTime = Math.max(0, hoverBase.current);'), '离开轨道回到落定位置');

// —— 实心滑块只跟落定值 ——
check(has("h('div', { className: 'dshcv-trackhead', style: { left: headPercent + '%' } })"), '实心滑块用 headPercent');
check(has("className: 'dshcv-hoverhead'"), '悬停虚线单独一层');
check(has('.dshcv-hoverhead{position:absolute'), '虚线有样式');
check(has('border-left:1px dashed rgba(79,140,255,.85)'), '淡蓝虚线');
check(/hover !== null && !drag/.test(src), '拖动时不画悬停虚线');

// —— 右键菜单定位 ——
check(has('const rect = root ? root.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };'), '按面板矩形换算坐标');
check(has('const localX = event.clientX - rect.left;'), '菜单坐标是面板内坐标');
check(has("position:absolute;z-index:60"), '菜单为绝对定位');
check(has('padding:10px 12px 12px;position:relative}'), '视频面板是定位上下文');

// —— Shift+滚轮平移 ——
check(has('if (event.shiftKey) {'), '滚轮支持 Shift');
check(has('const step = (event.deltaY !== 0 ? Math.sign(event.deltaY) : 0) * span * 0.12;'), '平移步长随窗口宽度');
check(
  has('setView({ start: Math.max(0, Math.min(fullSpan - span, viewStart + step)), span });'),
  '平移不改变窗口宽度且夹在片长内',
);
const wheelStart = src.indexOf('wheelRef.current = (event) => {');
const wheelBody = src.slice(wheelStart, src.indexOf('};', wheelStart));
check(
  wheelBody.indexOf('if (event.altKey) {') >= 0 &&
    wheelBody.indexOf('if (event.altKey) {') < wheelBody.indexOf('if (event.shiftKey) {'),
  '滚轮处理里 Alt 优先于 Shift',
);
// —— 回车跳转仍然走 seekTo ——
check(has('seekTo(target);'), '回车调用 seekTo');
check(has('previewing.current = false;') && has('const target = applySeek(node, time);'), 'seekTo 先结束预览再定位');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
